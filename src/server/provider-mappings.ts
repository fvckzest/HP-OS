import type { PoolClient } from "pg";
import { apiFailure } from "./api-response";
import { ApiOperationError, withApiIdempotency } from "./api-idempotency";
import type { IdempotentResult } from "./api-idempotency";
import { readAdminEvent } from "./events";
import type { AuthenticatedSite } from "./site-auth";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const RESOURCE_TYPES = new Set(["square_item_variation", "stripe_price"]);

interface MappingRow {
  connection_id: string;
  resource_type: string;
  resource_reference: string;
  verified_at: Date;
}

interface Actor {
  type: "user" | "system";
  reference: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function operationError(status: number, code: string, message: string, details: Array<{ field: string; code: string; message: string }> = []): never {
  throw new ApiOperationError(status, code, message, details);
}

function actorFrom(value: unknown): Actor | null {
  if (!object(value) || !hasOnlyKeys(value, ["type", "reference"])
    || (value.type !== "user" && value.type !== "system")
    || typeof value.reference !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value.reference.trim())) {
    return null;
  }
  return { type: value.type, reference: value.reference.trim() };
}

function numericVersion(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | Response> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return apiFailure(415, "unsupported_media_type", "Send provider-mapping fields as application/json.");
  }
  let text: string;
  try { text = await request.text(); }
  catch { return apiFailure(400, "invalid_request", "The provider-mapping body could not be read."); }
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) return apiFailure(413, "request_too_large", "The request body exceeds 64 KiB.");
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return apiFailure(400, "invalid_request", "The provider-mapping body must contain readable JSON."); }
  if (!object(value)) return apiFailure(400, "invalid_request", "The provider-mapping body must be a JSON object.");
  return value;
}

async function lockEvent(client: PoolClient, siteId: string, eventId: string) {
  const result = await client.query<{ id: string; ticket_offering_id: string; version: number }>(
    `select id, ticket_offering_id, version
     from hpos.events
     where site_id = $1 and id = $2
     for update`,
    [siteId, eventId],
  );
  const event = result.rows[0];
  if (!event) operationError(404, "not_found", "The Event is not available to this Site.");
  return event;
}

async function assertAssignedConnection(client: PoolClient, siteId: string, connectionId: string): Promise<"square" | "stripe"> {
  const result = await client.query<{ provider: "square" | "stripe" }>(
    `select connection.provider
     from hpos.site_payment_connection_assignments assignment
     join hpos.payment_connections connection
       on connection.id = assignment.connection_id
      and connection.organization_id = assignment.organization_id
     where assignment.site_id = $1 and assignment.connection_id = $2
     limit 1`,
    [siteId, connectionId],
  );
  if (!result.rows[0]) operationError(404, "not_found", "The payment connection is not available to this Site.");
  return result.rows[0].provider;
}

async function readCurrentMapping(client: PoolClient, siteId: string, offeringId: string, connectionId: string): Promise<MappingRow | null> {
  const result = await client.query<MappingRow>(
    `select connection_id, resource_type, resource_reference, verified_at
     from hpos.ticket_offering_provider_mappings
     where site_id = $1 and offering_id = $2 and connection_id = $3`,
    [siteId, offeringId, connectionId],
  );
  return result.rows[0] ?? null;
}

interface MappingGuard {
  actor: Actor;
  expectedVersion: number;
}

function parseMappingGuard(body: Record<string, unknown>, allowedKeys: string[], unsupportedMessage: string): MappingGuard {
  if (!hasOnlyKeys(body, allowedKeys)) {
    operationError(422, "validation_failed", unsupportedMessage);
  }
  const actor = actorFrom(body.actor);
  if (!actor) {
    operationError(422, "validation_failed", "Include a valid actor reference.", [{
      field: "actor",
      code: "invalid_actor",
      message: "Include a user or system actor with a non-secret Site-local reference.",
    }]);
  }
  const expectedVersion = numericVersion(body.expected_version);
  if (!expectedVersion) {
    operationError(422, "validation_failed", "Provide expected_version.", [{
      field: "expected_version",
      code: "required",
      message: "Use the Event version you loaded.",
    }]);
  }
  return { actor, expectedVersion };
}

async function lockMappingTarget(
  client: PoolClient,
  site: AuthenticatedSite,
  eventId: string,
  connectionId: string,
  expectedVersion: number,
): Promise<{ event: { id: string; ticket_offering_id: string; version: number }; provider: "square" | "stripe" }> {
  const event = await lockEvent(client, site.siteId, eventId);
  if (event.version !== expectedVersion) {
    operationError(409, "version_conflict", "The Event changed after you loaded it. Reload it before changing provider mappings.");
  }
  const provider = await assertAssignedConnection(client, site.siteId, connectionId);
  return { event, provider };
}

async function writeMapping(
  client: PoolClient,
  site: AuthenticatedSite,
  eventId: string,
  connectionId: string,
  body: Record<string, unknown>,
): Promise<IdempotentResult> {
  const { actor, expectedVersion } = parseMappingGuard(
    body,
    ["actor", "expected_version", "resource_type", "resource_reference", "verified_at"],
    "A provider mapping accepts actor, expected_version, resource_type, resource_reference, and verified_at only.",
  );
  if (typeof body.resource_type !== "string" || !RESOURCE_TYPES.has(body.resource_type.trim())
    || /[\u0000-\u001f\u007f]/.test(body.resource_type)) {
    operationError(422, "validation_failed", "resource_type must be a supported provider resource type.", [{ field: "resource_type", code: "invalid_reference", message: "Use square_item_variation or stripe_price." }]);
  }
  if (typeof body.resource_reference !== "string" || body.resource_reference.trim().length < 1 || body.resource_reference.trim().length > 500
    || /[\u0000-\u001f\u007f]/.test(body.resource_reference)) {
    operationError(422, "validation_failed", "resource_reference must be a non-secret provider reference from 1 to 500 characters.", [{ field: "resource_reference", code: "invalid_reference", message: "Use a non-secret provider reference from 1 to 500 characters." }]);
  }
  if (typeof body.verified_at !== "string" || !RFC3339_PATTERN.test(body.verified_at) || !Number.isFinite(Date.parse(body.verified_at))) {
    operationError(422, "validation_failed", "verified_at must be an RFC 3339 timestamp with an explicit offset.", [{ field: "verified_at", code: "invalid_timestamp", message: "Use an RFC 3339 timestamp with an explicit offset." }]);
  }

  const { event, provider } = await lockMappingTarget(client, site, eventId, connectionId, expectedVersion);
  const resourceType = body.resource_type.trim();
  const expectedResourceType = provider === "square" ? "square_item_variation" : "stripe_price";
  if (resourceType !== expectedResourceType) {
    operationError(422, "validation_failed", "resource_type must match the provider for this payment connection.", [{ field: "resource_type", code: "provider_mismatch", message: `Use ${expectedResourceType} for this connection.` }]);
  }
  await client.query(
    `insert into hpos.ticket_offering_provider_mappings (
       offering_id, event_id, site_id, connection_id, resource_type, resource_reference, verified_at
     ) values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (offering_id, connection_id) do update
       set resource_type = excluded.resource_type,
           resource_reference = excluded.resource_reference,
           verified_at = excluded.verified_at,
           updated_at = clock_timestamp()`,
    [event.ticket_offering_id, eventId, site.siteId, connectionId,
      resourceType, body.resource_reference.trim(), body.verified_at],
  );
  await client.query(
    `update hpos.events
     set version = version + 1, updated_at = clock_timestamp(),
         updated_actor_type = $3, updated_actor_reference = $4
     where site_id = $1 and id = $2`,
    [site.siteId, eventId, actor.type, actor.reference],
  );
  const mapping = await readCurrentMapping(client, site.siteId, event.ticket_offering_id, connectionId);
  const eventData = await readAdminEvent(client, site.siteId, eventId);
  if (!eventData || !mapping) throw new Error("The provider mapping could not be read after saving.");
  return { status: 200, data: eventData };
}

async function deleteMapping(
  client: PoolClient,
  site: AuthenticatedSite,
  eventId: string,
  connectionId: string,
  body: Record<string, unknown>,
): Promise<IdempotentResult> {
  const { actor, expectedVersion } = parseMappingGuard(
    body,
    ["actor", "expected_version"],
    "Removing a provider mapping accepts actor and expected_version only.",
  );
  const { event } = await lockMappingTarget(client, site, eventId, connectionId, expectedVersion);
  const removed = await client.query(
    `delete from hpos.ticket_offering_provider_mappings
     where site_id = $1 and offering_id = $2 and connection_id = $3`,
    [site.siteId, event.ticket_offering_id, connectionId],
  );
  if (removed.rowCount !== 1) operationError(404, "not_found", "The provider mapping is not available to this Site.");
  await client.query(
    `update hpos.events
     set version = version + 1, updated_at = clock_timestamp(),
         updated_actor_type = $3, updated_actor_reference = $4
     where site_id = $1 and id = $2`,
    [site.siteId, eventId, actor.type, actor.reference],
  );
  const eventData = await readAdminEvent(client, site.siteId, eventId);
  if (!eventData) throw new Error("The Event could not be read after removing its provider mapping.");
  return { status: 200, data: eventData };
}

function validIds(eventId: string, connectionId: string): boolean {
  return UUID_PATTERN.test(eventId) && UUID_PATTERN.test(connectionId);
}

function mapMappingDatabaseError(error: unknown): Response | null {
  if (object(error) && error.code === "23503") {
    return apiFailure(404, "not_found", "The Event or payment connection is not available to this Site.");
  }
  return null;
}

async function handleMappingMutation(
  request: Request,
  site: AuthenticatedSite,
  path: string[],
  method: "PUT" | "DELETE",
  action: (client: PoolClient, site: AuthenticatedSite, eventId: string, connectionId: string, body: Record<string, unknown>) => Promise<IdempotentResult>,
): Promise<Response | null> {
  if (request.method !== method || path.length !== 5 || path[0] !== "admin" || path[1] !== "events" || path[3] !== "provider-mappings") return null;
  const eventId = path[2];
  const connectionId = path[4];
  if (!validIds(eventId, connectionId)) return apiFailure(404, "not_found", "The Event or payment connection is not available to this Site.");
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  return withApiIdempotency(
    request,
    site,
    body,
    (client) => action(client, site, eventId, connectionId, body),
    mapMappingDatabaseError,
  );
}

export async function handleProviderMappingPut(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  return handleMappingMutation(request, site, path, "PUT", writeMapping);
}

export async function handleProviderMappingDelete(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  return handleMappingMutation(request, site, path, "DELETE", deleteMapping);
}
