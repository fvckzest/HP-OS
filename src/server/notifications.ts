import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { getBusinessPool } from "./database";
import { apiFailure, apiSuccess } from "./api-response";
import { ApiOperationError, withApiIdempotency } from "./api-idempotency";
import type { IdempotentResult } from "./api-idempotency";
import type { AuthenticatedSite } from "./site-auth";

export const NOTIFICATION_KINDS = [
  "access_approved",
  "tickets_ready",
  "order_recovery",
  "event_changed",
  "event_canceled",
  "wallet_update",
] as const;

const EVENT_ARRIVAL_FIELDS = new Set([
  "starts_at",
  "ends_at",
  "time_zone",
  "venue.name",
  "venue.address",
]);

export type NotificationKind = typeof NOTIFICATION_KINDS[number];
export type DispatchOutcome = "completed" | "failed" | "unknown";
export type DeliveryOutcome = "delivered" | "failed";
export type FailureClass = "transient" | "permanent";

export interface EventNotificationDetails {
  event_id: string;
  event_reference: string;
  title: string;
  starts_at: string;
  ends_at: string;
  time_zone: string;
  venue: { name: string; address: string | null };
  changed_fields: string[];
}

export type NotificationPayload =
  | { attendee: { name: string; email: string }; approval_token: string }
  | { recipient_email: string; buyer_name: string; event: Omit<EventNotificationDetails, "changed_fields">; order: { order_id: string; order_reference: string; order_token: string } }
  | { recipient_email: string; orders: Array<{ order_id: string; order_reference: string; order_token: string; expires_at: string }> }
  | { recipient_email: string; order: { order_id: string; order_reference: string }; event: EventNotificationDetails }
  | { recipient_email: string; order: { order_id: string; order_reference: string }; event: Omit<EventNotificationDetails, "changed_fields">; canceled_at: string }
  | { ticket_id: string; data_version: string };

export interface NewNotificationJob {
  siteId: string;
  kind: NotificationKind;
  eventId?: string | null;
  orderId?: string | null;
  accessRequestId?: string | null;
  /** SHA-256 digest of the raw approval token for access_approved jobs. */
  accessRequestTokenHash?: string | null;
  ticketId?: string | null;
  availableAt?: Date;
  payload: NotificationPayload;
}

export type EventNotificationBatch =
  | {
      siteId: string;
      eventId: string;
      kind: "event_changed";
      event: EventNotificationDetails;
    }
  | {
      siteId: string;
      eventId: string;
      kind: "event_canceled";
      event: Omit<EventNotificationDetails, "changed_fields">;
      canceledAt: string;
    };

const MAX_CLAIM_SIZE = 100;
const MAX_PROCESS_BATCH = 50;
const MAX_BODY_BYTES = 64 * 1024;
const RETRY_DELAYS_MINUTES = [1, 5, 15, 60, 360] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

interface Actor { type: "user" | "system"; reference: string }
interface NotificationJobRow extends QueryResultRow {
  id: string;
  site_id: string;
  kind: NotificationKind;
  status: "pending" | "failed" | "completed";
  event_id: string | null;
  order_id: string | null;
  access_request_id: string | null;
  access_request_token_hash: string | null;
  ticket_id: string | null;
  is_superseded: boolean;
  attempt_count: number;
  available_at: Date;
  created_at: Date;
  created_cursor_time?: string;
  updated_at: Date;
  requires_verification: boolean;
  provider_message_reference: string | null;
  failure_class: FailureClass | null;
  payload: NotificationPayload;
  claim_id: string | null;
  lease_expires_at: Date | null;
  lease_fence: number | string;
}

class NotificationError extends ApiOperationError {}

function reject(status: number, code: string, message: string, details: Array<{ field: string; code: string; message: string }> = []): never {
  throw new NotificationError(status, code, message, details);
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validText(value: unknown, maximum = 500): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}

function validEmail(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function approvalToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,200}$/.test(value);
}

function tokenHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && RFC3339_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

function validateEventDetails(value: unknown, includeChangedFields: boolean): value is EventNotificationDetails {
  if (!object(value)) return false;
  const allowed = ["event_id", "event_reference", "title", "starts_at", "ends_at", "time_zone", "venue", ...(includeChangedFields ? ["changed_fields"] : [])];
  if (!hasOnlyKeys(value, allowed) || !UUID_PATTERN.test(String(value.event_id ?? "")) || !validText(value.event_reference) || !validText(value.title, 200)) return false;
  if (!validTimestamp(value.starts_at) || !validTimestamp(value.ends_at) || !validText(value.time_zone, 100)) return false;
  if (!object(value.venue) || !hasOnlyKeys(value.venue, ["name", "address"]) || !validText(value.venue.name, 200)) return false;
  if (value.venue.address !== null && !validText(value.venue.address, 1000)) return false;
  if (includeChangedFields && (!Array.isArray(value.changed_fields) || value.changed_fields.length === 0
    || value.changed_fields.some((field) => typeof field !== "string" || !EVENT_ARRIVAL_FIELDS.has(field))
    || new Set(value.changed_fields).size !== value.changed_fields.length)) return false;
  return true;
}

export function validateNotificationPayload(kind: NotificationKind, value: unknown): value is NotificationPayload {
  if (!object(value)) return false;
  if (kind === "access_approved") {
    return hasOnlyKeys(value, ["attendee", "approval_token"])
      && object(value.attendee) && hasOnlyKeys(value.attendee, ["name", "email"])
      && validText(value.attendee.name, 200) && validEmail(value.attendee.email) && approvalToken(value.approval_token);
  }
  if (kind === "tickets_ready") {
    if (!hasOnlyKeys(value, ["recipient_email", "buyer_name", "event", "order"]) || !validEmail(value.recipient_email) || !validText(value.buyer_name, 200)) return false;
    if (!validateEventDetails(value.event, false) || !object(value.order) || !hasOnlyKeys(value.order, ["order_id", "order_reference", "order_token"])) return false;
    return UUID_PATTERN.test(String(value.order.order_id ?? "")) && validText(value.order.order_reference) && validText(value.order.order_token, 2000);
  }
  if (kind === "order_recovery") {
    if (!hasOnlyKeys(value, ["recipient_email", "orders"]) || !validEmail(value.recipient_email) || !Array.isArray(value.orders) || value.orders.length === 0) return false;
    return value.orders.every((order) => object(order) && hasOnlyKeys(order, ["order_id", "order_reference", "order_token", "expires_at"])
      && UUID_PATTERN.test(String(order.order_id ?? "")) && validText(order.order_reference)
      && validText(order.order_token, 2000) && validTimestamp(order.expires_at));
  }
  if (kind === "event_changed") {
    return hasOnlyKeys(value, ["recipient_email", "order", "event"]) && validEmail(value.recipient_email)
      && object(value.order) && hasOnlyKeys(value.order, ["order_id", "order_reference"])
      && UUID_PATTERN.test(String(value.order.order_id ?? "")) && validText(value.order.order_reference)
      && validateEventDetails(value.event, true);
  }
  if (kind === "event_canceled") {
    return hasOnlyKeys(value, ["recipient_email", "order", "event", "canceled_at"]) && validEmail(value.recipient_email)
      && object(value.order) && hasOnlyKeys(value.order, ["order_id", "order_reference"])
      && UUID_PATTERN.test(String(value.order.order_id ?? "")) && validText(value.order.order_reference)
      && validateEventDetails(value.event, false) && validTimestamp(value.canceled_at);
  }
  return hasOnlyKeys(value, ["ticket_id", "data_version"])
    && UUID_PATTERN.test(String(value.ticket_id ?? "")) && validText(value.data_version, 200);
}

function expectedRecordIds(kind: NotificationKind, input: NewNotificationJob) {
  const references = [input.eventId, input.orderId, input.accessRequestId, input.ticketId];
  if (references.some((reference) => reference != null && !UUID_PATTERN.test(reference))) return false;
  const required = {
    access_approved: Boolean(input.eventId && input.accessRequestId && !input.orderId && !input.ticketId),
    tickets_ready: Boolean(input.eventId && input.orderId && !input.accessRequestId && !input.ticketId),
    order_recovery: Boolean(!input.eventId && !input.orderId && !input.accessRequestId && !input.ticketId),
    event_changed: Boolean(input.eventId && input.orderId && !input.accessRequestId && !input.ticketId),
    event_canceled: Boolean(input.eventId && input.orderId && !input.accessRequestId && !input.ticketId),
    wallet_update: Boolean(input.ticketId && !input.eventId && !input.orderId && !input.accessRequestId),
  };
  if (!required[kind]) return false;
  const payload = input.payload as unknown;
  if (!object(payload)) return false;
  if (kind === "tickets_ready" || kind === "event_changed" || kind === "event_canceled") {
    return object(payload.event) && payload.event.event_id === input.eventId
      && object(payload.order) && payload.order.order_id === input.orderId;
  }
  if (kind === "wallet_update") return payload.ticket_id === input.ticketId;
  return true;
}

/**
 * Insert a durable notification job using the caller's transaction. Producers
 * must call this before committing the business change that requires delivery.
 */
export async function enqueueNotificationJob(client: PoolClient, input: NewNotificationJob): Promise<string> {
  if (!UUID_PATTERN.test(input.siteId) || !NOTIFICATION_KINDS.includes(input.kind)) throw new Error("Notification producer supplied an invalid Site ID or notification kind.");
  if (!expectedRecordIds(input.kind, input)) throw new Error("Notification producer supplied record references that do not match the job kind.");
  if (!validateNotificationPayload(input.kind, input.payload)) throw new Error("Notification producer supplied a payload that does not match the documented job kind.");
  const computedAccessTokenHash = input.kind === "access_approved"
    ? tokenHash((input.payload as { approval_token: string }).approval_token)
    : null;
  if (input.kind !== "access_approved" && input.accessRequestTokenHash != null) throw new Error("Only access approval jobs may carry an approval token digest.");
  if (computedAccessTokenHash !== null && input.accessRequestTokenHash != null && computedAccessTokenHash !== input.accessRequestTokenHash) throw new Error("Notification producer supplied an approval token digest that does not match its payload.");
  if (input.availableAt && !Number.isFinite(input.availableAt.getTime())) throw new Error("Notification producer supplied an invalid availability time.");
  if (Buffer.byteLength(JSON.stringify(input.payload), "utf8") > MAX_BODY_BYTES) throw new Error("Notification producer supplied a payload larger than 64 KiB.");
  const result = await client.query<{ id: string }>(
    `insert into hpos.notification_jobs (
       site_id, kind, event_id, order_id, access_request_id, access_request_token_hash, ticket_id,
       available_at, payload
     ) values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, clock_timestamp()), $9::jsonb)
     returning id`,
    [input.siteId, input.kind, input.eventId ?? null, input.orderId ?? null, input.accessRequestId ?? null, computedAccessTokenHash, input.ticketId ?? null, input.availableAt ?? null, JSON.stringify(input.payload)],
  );
  return result.rows[0].id;
}

/**
 * Insert all paid-Order Event notifications with one database statement.
 *
 * The caller owns the transaction. The source rows stay in PostgreSQL, so a
 * large Event does not become an application-sized recipient array and a
 * partial fan-out cannot commit independently of the Event mutation.
 */
export async function enqueueEventNotificationJobs(client: PoolClient, input: EventNotificationBatch): Promise<number> {
  if (!UUID_PATTERN.test(input.siteId) || !UUID_PATTERN.test(input.eventId)) {
    throw new Error("Event notification batch supplied an invalid Site or Event ID.");
  }
  if (input.event.event_id !== input.eventId) {
    throw new Error("Event notification batch supplied mismatched Event details.");
  }
  if (input.kind === "event_changed") {
    if (!validateEventDetails(input.event, true)) throw new Error("Event notification batch supplied invalid Event details.");
  } else {
    if (!validateEventDetails(input.event, false) || !validTimestamp(input.canceledAt)) {
      throw new Error("Event cancellation batch supplied invalid Event details.");
    }
  }

  const eventPayload = `jsonb_build_object(
    'event_id', $3::uuid,
    'event_reference', $4::text,
    'title', $5::text,
    'starts_at', $6::text,
    'ends_at', $7::text,
    'time_zone', $8::text,
    'venue', jsonb_build_object('name', $9::text, 'address', $10::text)${input.kind === "event_changed" ? ",\n    'changed_fields', $11::jsonb" : ""}
  )`;
  const payload = input.kind === "event_changed"
    ? `jsonb_build_object(
         'recipient_email', order_row.delivery_email,
         'order', jsonb_build_object('order_id', order_row.id, 'order_reference', order_row.order_reference),
         'event', ${eventPayload}
       )`
    : `jsonb_build_object(
         'recipient_email', order_row.delivery_email,
         'order', jsonb_build_object('order_id', order_row.id, 'order_reference', order_row.order_reference),
         'event', ${eventPayload},
         'canceled_at', $11::text
       )`;
  const result = await client.query(
    `insert into hpos.notification_jobs (
       site_id, kind, event_id, order_id, available_at, payload
     )
     select $1, $2, $3::uuid, order_row.id, clock_timestamp(), ${payload}
     from hpos.orders order_row
     where order_row.site_id = $1 and order_row.event_id = $3::uuid and order_row.payment_status = 'paid'
     order by order_row.created_at, order_row.id`,
    [
      input.siteId,
      input.kind,
      input.eventId,
      input.event.event_reference,
      input.event.title,
      input.event.starts_at,
      input.event.ends_at,
      input.event.time_zone,
      input.event.venue.name,
      input.event.venue.address,
      input.kind === "event_changed" ? JSON.stringify(input.event.changed_fields) : input.canceledAt,
    ],
  );
  return result.rowCount ?? 0;
}

/** Supersede only unsent work; unknown or completed provider effects stay visible. */
export async function supersedeUnsentNotificationJobs(client: PoolClient, input: { siteId: string; kinds: NotificationKind[]; orderId?: string; accessRequestId?: string; eventId?: string }): Promise<number> {
  if (!UUID_PATTERN.test(input.siteId) || input.kinds.length === 0
    || (!input.orderId && !input.accessRequestId && !input.eventId)) return 0;
  const result = await client.query(
    `update hpos.notification_jobs
       set is_superseded = true, updated_at = clock_timestamp()
     where site_id = $1 and kind = any($2::text[])
       and ($3::uuid is null or order_id = $3)
       and ($4::uuid is null or access_request_id = $4)
       and ($5::uuid is null or event_id = $5)
       and status = 'pending' and attempt_count = 0
       and requires_verification = false and provider_message_reference is null and claim_id is null
     returning id`,
    [input.siteId, input.kinds, input.orderId ?? null, input.accessRequestId ?? null, input.eventId ?? null],
  );
  return result.rowCount ?? 0;
}

function isPgCode(error: unknown, code: string): boolean {
  return object(error) && error.code === code;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (object(value)) return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}

function mapUnexpectedNotificationError(error: unknown): Response {
  if (isPgCode(error, "23505")) return apiFailure(409, "claim_conflict", "A notification reference conflicts with an existing job or provider report.");
  return apiFailure(503, "service_unavailable", "Notification processing is temporarily unavailable.", { retryAfter: 1 });
}

function actorFrom(value: unknown): Actor | null {
  if (!object(value) || !hasOnlyKeys(value, ["type", "reference"])) return null;
  if ((value.type !== "user" && value.type !== "system") || typeof value.reference !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value.reference)) return null;
  return { type: value.type, reference: value.reference.trim() };
}

function hasActor(value: Record<string, unknown>, requiredType: Actor["type"] = "system"): Actor {
  const actor = actorFrom(value.actor);
  if (actor?.type === requiredType) return actor;
  return reject(422, "validation_failed", `Include a ${requiredType} actor for audit attribution.`, [{ field: "actor", code: "invalid_actor", message: `Use {type: "${requiredType}", reference: Site-local ID}.` }]);
}

function validateFields(value: Record<string, unknown>, allowed: string[], required: string[]): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) reject(422, "validation_failed", `Field ${unknown} is not accepted for this operation.`, [{ field: unknown, code: "unknown_field", message: "Remove the unsupported field." }]);
  const missing = required.filter((key) => !(key in value));
  if (missing.length) reject(422, "validation_failed", "Required notification fields are missing.", missing.map((field) => ({ field, code: "required", message: "This field is required." })));
}

function requiredUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) reject(422, "validation_failed", `${field} must be a UUID.`, [{ field, code: "invalid_uuid", message: "Provide a UUID." }]);
  return value;
}

export async function handleNotificationGet(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (path.length === 2 && path[0] === "admin" && path[1] === "notification-jobs") return listJobs(request, site);
  if (path.length === 3 && path[0] === "admin" && path[1] === "notification-jobs") {
    const jobId = path[2];
    if (!UUID_PATTERN.test(jobId)) return apiFailure(404, "not_found", "The notification job is not available to this Site.");
    const job = await readJob(getBusinessPool(), site.siteId, jobId);
    return job ? apiSuccess(job) : apiFailure(404, "not_found", "The notification job is not available to this Site.");
  }
  return null;
}

export async function handleNotificationPost(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (path.length === 3 && path[0] === "admin" && path[1] === "notification-jobs" && path[2] === "claims") {
    const body = await readJsonBody(request);
    if (body instanceof Response) return body;
    if (!object(body)) return apiFailure(400, "invalid_request", "The request body must be a JSON object.");
    try {
      validateFields(body, ["limit", "kinds", "actor"], ["actor"]);
      const actor = hasActor(body);
      const limit = body.limit === undefined ? 50 : body.limit;
      if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > MAX_CLAIM_SIZE) reject(422, "validation_failed", "limit must be an integer from 1 to 100.", [{ field: "limit", code: "out_of_range", message: "Choose from 1 to 100 jobs." }]);
      let kinds: NotificationKind[] | null = null;
      if (body.kinds !== undefined) {
        if (!Array.isArray(body.kinds) || body.kinds.length === 0 || body.kinds.some((kind) => !NOTIFICATION_KINDS.includes(kind as NotificationKind)) || new Set(body.kinds).size !== body.kinds.length) {
          reject(422, "validation_failed", "kinds must be a nonempty list of unique notification kinds.", [{ field: "kinds", code: "invalid_enum", message: "Use one or more documented notification kinds." }]);
        }
        kinds = body.kinds as NotificationKind[];
      }
      const semanticBody = { limit: Number(limit), kinds, actor };
      return withApiIdempotency(request, site, semanticBody, (client) => claimJobs(client, site.siteId, Number(limit), kinds, actor), mapUnexpectedNotificationError, semanticBody);
    } catch (error) { return errorResponse(error); }
  }

  if (path.length === 5 && path[0] === "admin" && path[1] === "notification-jobs" && path[2] === "claims" && path[4] === "renew") {
    const claimId = path[3];
    if (!UUID_PATTERN.test(claimId)) return apiFailure(404, "not_found", "The notification claim is not active for this Site.");
    const body = await readJsonBody(request);
    if (body instanceof Response) return body;
    if (!object(body)) return apiFailure(400, "invalid_request", "The request body must be a JSON object.");
    try {
      validateFields(body, ["actor"], ["actor"]);
      const actor = hasActor(body);
      const semanticBody = { actor };
      return withApiIdempotency(request, site, semanticBody, (client) => renewClaim(client, site.siteId, claimId, actor), mapUnexpectedNotificationError, semanticBody);
    } catch (error) { return errorResponse(error); }
  }

  if (path.length === 4 && path[0] === "admin" && path[1] === "notification-jobs" && path[3] === "outcome-reports") {
    const jobId = path[2];
    if (!UUID_PATTERN.test(jobId)) return apiFailure(404, "not_found", "The notification job is not available to this Site.");
    const body = await readJsonBody(request);
    if (body instanceof Response) return body;
    if (!object(body)) return apiFailure(400, "invalid_request", "The request body must be a JSON object.");
    try {
      validateFields(body, ["claim_id", "lease_fence", "outcome", "provider_message_reference", "observed_at", "error_code", "failure_class", "actor"], ["claim_id", "lease_fence", "outcome", "provider_message_reference", "observed_at", "error_code", "actor"]);
      const actor = hasActor(body);
      const claimId = requiredUuid(body.claim_id, "claim_id");
      if (!Number.isSafeInteger(body.lease_fence) || Number(body.lease_fence) < 1) reject(422, "validation_failed", "lease_fence must be a positive integer from the current job claim.", [{ field: "lease_fence", code: "out_of_range", message: "Use the lease_fence returned with the claimed job." }]);
      if (!(body.outcome === "completed" || body.outcome === "failed" || body.outcome === "unknown")) reject(422, "validation_failed", "outcome must be completed, failed, or unknown.", [{ field: "outcome", code: "invalid_enum", message: "Use completed, failed, or unknown." }]);
      if (body.provider_message_reference !== null && (typeof body.provider_message_reference !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,499}$/.test(body.provider_message_reference))) reject(422, "validation_failed", "provider_message_reference must be a nonempty provider reference or null.", [{ field: "provider_message_reference", code: "invalid_reference", message: "Use a non-secret provider reference when available; otherwise send null." }]);
      if (!validTimestamp(body.observed_at)) reject(422, "validation_failed", "observed_at must be an RFC 3339 timestamp with a UTC offset.", [{ field: "observed_at", code: "invalid_timestamp", message: "Include Z or a numeric UTC offset." }]);
      if (body.error_code !== null && (typeof body.error_code !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(body.error_code))) reject(422, "validation_failed", "error_code must be a short provider or Site error code, or null.", [{ field: "error_code", code: "invalid_error_code", message: "Use an identifier up to 200 characters, or null." }]);
      if (body.outcome === "completed" && body.error_code !== null) reject(422, "validation_failed", "A completed dispatch cannot include an error_code.", [{ field: "error_code", code: "unexpected_value", message: "Send null when dispatch completed." }]);
      if (body.failure_class !== undefined && body.failure_class !== null && body.failure_class !== "transient" && body.failure_class !== "permanent") reject(422, "validation_failed", "failure_class must be transient, permanent, or null.", [{ field: "failure_class", code: "invalid_enum", message: "Use transient or permanent only for a failed dispatch." }]);
      if (body.failure_class !== undefined && body.failure_class !== null && body.outcome !== "failed") reject(422, "validation_failed", "failure_class is only valid for a failed dispatch.", [{ field: "failure_class", code: "unexpected_value", message: "Send null or omit the field for completed or unknown outcomes." }]);
      return withApiIdempotency(request, site, body, (client) => reportOutcome(client, site.siteId, jobId, claimId, body as unknown as OutcomeReportInput, actor), mapUnexpectedNotificationError, body);
    } catch (error) { return errorResponse(error); }
  }

  if (path.length === 4 && path[0] === "admin" && path[1] === "notification-jobs" && path[3] === "delivery-reports") {
    const jobId = path[2];
    if (!UUID_PATTERN.test(jobId)) return apiFailure(404, "not_found", "The notification job is not available to this Site.");
    const body = await readJsonBody(request);
    if (body instanceof Response) return body;
    if (!object(body)) return apiFailure(400, "invalid_request", "The request body must be a JSON object.");
    try {
      validateFields(body, ["outcome", "provider_message_reference", "provider_event_reference", "observed_at", "actor"], ["outcome", "provider_message_reference", "provider_event_reference", "observed_at", "actor"]);
      const actor = hasActor(body);
      if (!(body.outcome === "delivered" || body.outcome === "failed")) reject(422, "validation_failed", "outcome must be delivered or failed.", [{ field: "outcome", code: "invalid_enum", message: "Use delivered or failed." }]);
      if (!validText(body.provider_message_reference)) reject(422, "validation_failed", "provider_message_reference is required.", [{ field: "provider_message_reference", code: "required", message: "Use a provider message reference recorded for this job." }]);
      if (!validText(body.provider_event_reference)) reject(422, "validation_failed", "provider_event_reference is required.", [{ field: "provider_event_reference", code: "required", message: "Use the provider's stable delivery-event identity." }]);
      if (!validTimestamp(body.observed_at)) reject(422, "validation_failed", "observed_at must be an RFC 3339 timestamp with a UTC offset.", [{ field: "observed_at", code: "invalid_timestamp", message: "Include Z or a numeric UTC offset." }]);
      return withApiIdempotency(request, site, body, (client) => reportDelivery(client, site.siteId, jobId, body as unknown as DeliveryReportInput, actor), mapUnexpectedNotificationError, body);
    } catch (error) { return errorResponse(error); }
  }
  return null;
}

interface OutcomeReportInput { claim_id: string; lease_fence: number; outcome: DispatchOutcome; provider_message_reference: string | null; observed_at: string; error_code: string | null; failure_class?: FailureClass | null }
interface DeliveryReportInput { outcome: DeliveryOutcome; provider_message_reference: string; provider_event_reference: string; observed_at: string }

async function readJsonBody(request: Request): Promise<unknown | Response> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return apiFailure(415, "unsupported_media_type", "Send notification fields as application/json.");
  const reader = request.body?.getReader();
  if (!reader) return apiFailure(400, "invalid_request", "A JSON request body is required.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return apiFailure(413, "request_too_large", "The notification request exceeds the 64 KiB limit.");
      }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    try { return JSON.parse(bytes.toString("utf8")) as unknown; }
    catch { return apiFailure(400, "invalid_request", "The request body is not valid JSON."); }
  } catch {
    return apiFailure(400, "invalid_request", "The request body could not be read.");
  }
}

function errorResponse(error: unknown): Response {
  if (error instanceof NotificationError) return apiFailure(error.status, error.code, error.message, { details: error.details, retryAfter: error.status === 409 && error.code === "request_in_progress" ? 1 : undefined });
  return apiFailure(503, "service_unavailable", "Notification processing is temporarily unavailable.", { retryAfter: 1 });
}

async function listJobs(request: Request, site: AuthenticatedSite): Promise<Response> {
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const kind = url.searchParams.get("kind");
  const eventId = url.searchParams.get("event_id");
  const orderId = url.searchParams.get("order_id");
  const requiresText = url.searchParams.get("requires_verification");
  const limitText = url.searchParams.get("limit");
  const limit = limitText === null ? 50 : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return apiFailure(422, "validation_failed", "limit must be an integer from 1 to 100.", { details: [{ field: "limit", code: "out_of_range", message: "Choose from 1 to 100 jobs." }] });
  if (status !== null && !["pending", "failed", "completed"].includes(status)) return apiFailure(422, "validation_failed", "status is not a supported notification state.", { details: [{ field: "status", code: "invalid_enum", message: "Use pending, failed, or completed." }] });
  if (kind !== null && !NOTIFICATION_KINDS.includes(kind as NotificationKind)) return apiFailure(422, "validation_failed", "kind is not a supported notification kind.", { details: [{ field: "kind", code: "invalid_enum", message: "Use one documented notification kind." }] });
  if (eventId !== null && !UUID_PATTERN.test(eventId)) return apiFailure(422, "validation_failed", "event_id must be a UUID.", { details: [{ field: "event_id", code: "invalid_uuid", message: "Provide a UUID." }] });
  if (orderId !== null && !UUID_PATTERN.test(orderId)) return apiFailure(422, "validation_failed", "order_id must be a UUID.", { details: [{ field: "order_id", code: "invalid_uuid", message: "Provide a UUID." }] });
  if (requiresText !== null && requiresText !== "true" && requiresText !== "false") return apiFailure(422, "validation_failed", "requires_verification must be true or false.", { details: [{ field: "requires_verification", code: "invalid_boolean", message: "Use true or false." }] });
  const filters = { status, kind, eventId, orderId, requiresVerification: requiresText === null ? null : requiresText === "true" };
  let cursor: { createdAt: string; id: string } | null = null;
  const cursorText = url.searchParams.get("cursor");
  if (cursorText) {
    cursor = decodeCursor(cursorText, site.siteId, filters, limit);
    if (!cursor) return apiFailure(422, "invalid_cursor", "The notification cursor does not match this Site, endpoint, filter, or page size.");
  }
  try {
    const result = await getBusinessPool().query<NotificationJobRow>(
      `${JOB_SELECT}
       where j.site_id = $1
         and ($2::text is null or j.status = $2)
         and ($3::text is null or j.kind = $3)
         and ($4::uuid is null or j.event_id = $4)
         and ($5::uuid is null or j.order_id = $5)
         and ($6::boolean is null or j.requires_verification = $6)
         and ($7::timestamptz is null or (j.created_at, j.id) < ($7::timestamptz, $8::uuid))
       order by j.created_at desc, j.id desc limit $9`,
      [site.siteId, status, kind, eventId, orderId, filters.requiresVerification, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
    );
    const hasNext = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const next = hasNext && rows.length ? encodeCursor(site.siteId, filters, limit, rows[rows.length - 1]) : null;
    const rowsWithFreshApprovalState = await Promise.all(rows.map(async (row) => ({
      row,
      stale: !(await accessApprovalIsCurrent(getBusinessPool(), row)),
    })));
    return apiSuccess(rowsWithFreshApprovalState.map(({ row, stale }) => jobObject(row, stale)), 200, { nextCursor: next });
  } catch { return apiFailure(503, "service_unavailable", "Notification jobs are temporarily unavailable.", { retryAfter: 1 }); }
}

function encodeCursor(siteId: string, filters: object, limit: number, row: { created_at: Date; created_cursor_time?: string; id: string }): string {
  const payload = JSON.stringify({ siteId, route: "admin-notification-jobs", filters, limit, issuedAt: new Date().toISOString(), createdAt: row.created_cursor_time ?? row.created_at.toISOString(), id: row.id });
  return Buffer.from(payload).toString("base64url");
}

function decodeCursor(value: string, siteId: string, filters: object, limit: number): { createdAt: string; id: string } | null {
  if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (cursor.siteId !== siteId || cursor.route !== "admin-notification-jobs" || cursor.limit !== limit || canonicalJson(cursor.filters) !== canonicalJson(filters)) return null;
    if (!validTimestamp(cursor.issuedAt) || Date.parse(cursor.issuedAt) < Date.now() - 60 * 60 * 1000 || Date.parse(cursor.issuedAt) > Date.now() + 60_000) return null;
    if (!validTimestamp(cursor.createdAt) || typeof cursor.id !== "string" || !UUID_PATTERN.test(cursor.id)) return null;
    return { createdAt: cursor.createdAt, id: cursor.id };
  } catch { return null; }
}

const JOB_SELECT = `select j.id, j.site_id, j.kind, j.status, j.event_id, j.order_id, j.access_request_id, j.access_request_token_hash, j.ticket_id,
       j.is_superseded, j.attempt_count, j.available_at, j.created_at,
       to_char(j.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_cursor_time,
       j.updated_at,
       j.requires_verification, j.provider_message_reference, j.failure_class, j.payload, j.claim_id, j.lease_fence,
       c.lease_expires_at,
       (select coalesce(jsonb_agg(jsonb_build_object(
          'claim_id', recent.claim_id, 'lease_fence', recent.lease_fence,
          'attempt_number', recent.attempt_number, 'outcome', recent.outcome,
          'provider_message_reference', recent.provider_message_reference,
          'observed_at', recent.observed_at, 'error_code', recent.error_code,
          'failure_class', recent.failure_class
        ) order by recent.attempt_number desc, recent.id desc), '[]'::jsonb)
        from (select a.id, a.claim_id, a.lease_fence, a.attempt_number, a.outcome, a.provider_message_reference, a.observed_at, a.error_code, a.failure_class
              from hpos.notification_dispatch_attempts a where a.site_id = j.site_id and a.job_id = j.id
              order by a.attempt_number desc, a.id desc limit 50) recent) as dispatch_attempts,
       (select coalesce(jsonb_agg(jsonb_build_object(
          'provider_message_reference', recent.provider_message_reference,
          'provider_event_reference', recent.provider_event_reference,
          'outcome', recent.outcome, 'observed_at', recent.observed_at
        ) order by recent.observed_at desc, recent.id desc), '[]'::jsonb)
        from (select d.id, d.provider_message_reference, d.provider_event_reference, d.outcome, d.observed_at
              from hpos.notification_delivery_events d where d.site_id = j.site_id and d.job_id = j.id
              order by d.observed_at desc, d.id desc limit 50) recent) as delivery_reports,
       (select d.outcome from hpos.notification_delivery_events d
        where d.site_id = j.site_id and d.job_id = j.id
        order by d.observed_at desc, d.id desc limit 1) as delivery_status
     from hpos.notification_jobs j
     left join hpos.notification_claims c on c.id = j.claim_id and c.site_id = j.site_id`;

async function accessApprovalIsCurrent(client: Pool | PoolClient, row: Pick<NotificationJobRow, "kind" | "site_id" | "event_id" | "access_request_id" | "access_request_token_hash">): Promise<boolean> {
  if (row.kind !== "access_approved") return true;
  if (!row.event_id || !row.access_request_id || !row.access_request_token_hash) return false;
  const result = await client.query<{ current: boolean }>(
    `select exists (
       select 1
       from hpos.access_requests request_row
       join hpos.access_request_approval_tokens token
         on token.access_request_id = request_row.id and token.site_id = request_row.site_id
       join hpos.events event_row
         on event_row.id = request_row.event_id and event_row.site_id = request_row.site_id
       where request_row.site_id = $1 and request_row.id = $2 and request_row.event_id = $3
         and request_row.status = 'approved'
         and token.token_hash = $4 and token.revoked_at is null
         and event_row.publication_status = 'published'
         and event_row.visibility = 'private'
         and event_row.is_canceled = false and event_row.is_archived = false
     ) as current`,
    [row.site_id, row.access_request_id, row.event_id, row.access_request_token_hash],
  );
  return result.rows[0]?.current ?? false;
}

async function readJob(client: Pool | PoolClient, siteId: string, jobId: string): Promise<Record<string, unknown> | null> {
  const result = await client.query<NotificationJobRow & QueryResultRow>(`${JOB_SELECT} where j.site_id = $1 and j.id = $2`, [siteId, jobId]);
  const row = result.rows[0];
  if (!row) return null;
  const stale = !(await accessApprovalIsCurrent(client, row));
  return jobObject(row, stale);
}

function jobObject(row: NotificationJobRow & QueryResultRow, forceSuperseded = false): Record<string, unknown> {
  return {
    job_id: row.id,
    kind: row.kind,
    status: row.status,
    event_id: row.event_id,
    order_id: row.order_id,
    access_request_id: row.access_request_id,
    ticket_id: row.ticket_id,
    is_superseded: row.is_superseded || forceSuperseded,
    attempt_count: row.attempt_count,
    available_at: row.available_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    requires_verification: row.requires_verification,
    provider_message_reference: row.provider_message_reference,
    failure_class: row.failure_class,
    payload: row.payload,
    claim_id: row.claim_id,
    lease_expires_at: row.lease_expires_at,
    lease_fence: Number(row.lease_fence),
    dispatch_attempts: (row as NotificationJobRow & { dispatch_attempts?: unknown[] }).dispatch_attempts ?? [],
    delivery_status: (row as NotificationJobRow & { delivery_status?: string | null }).delivery_status ?? null,
    delivery_reports: (row as NotificationJobRow & { delivery_reports?: unknown[] }).delivery_reports ?? [],
  };
}

async function claimJobs(client: PoolClient, siteId: string, limit: number, kinds: NotificationKind[] | null, actor: Actor): Promise<IdempotentResult> {
  const candidates = await client.query<{ id: string; event_id: string | null; access_request_id: string | null }>(
    `select j.id, j.event_id, j.access_request_id
     from hpos.notification_jobs j
     left join hpos.notification_claims c on c.id = j.claim_id and c.site_id = j.site_id
     where j.site_id = $1 and j.status = 'pending' and j.is_superseded = false
       and j.available_at <= clock_timestamp()
       and (j.claim_id is null or c.id is null or c.closed_at is not null or c.lease_expires_at <= clock_timestamp())
       and ($2::text[] is null or j.kind = any($2::text[]))
     order by j.available_at, j.created_at, j.id
     limit $3`,
    [siteId, kinds, Math.max(limit * 2, limit)],
  );

  const picked: Array<{ id: string; expiredLease: boolean; verificationOnly: boolean }> = [];
  for (const candidate of candidates.rows) {
    if (picked.length >= limit) break;
    if (candidate.access_request_id) {
      // Decision actions use the same advisory lock before locking Event,
      // request, and job rows. This prevents a withdrawal from racing a
      // worker claim while keeping lock order deterministic.
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`access-request:${siteId}:${candidate.access_request_id}`]);
      if (candidate.event_id) {
        await client.query(
          `select e.id from hpos.events e join hpos.ticket_offerings o on o.id = e.ticket_offering_id and o.event_id = e.id and o.site_id = e.site_id
           where e.site_id = $1 and e.id = $2 for update of e, o`,
          [siteId, candidate.event_id],
        );
      }
      const requestCurrent = await client.query<{ status: string; event_id: string; token_hash: string | null; event_active: boolean }>(
        `select request_row.status, request_row.event_id, token.token_hash,
                (event_row.publication_status = 'published' and event_row.visibility = 'private'
                 and event_row.is_canceled = false and event_row.is_archived = false) as event_active
         from hpos.access_requests request_row
         left join hpos.access_request_approval_tokens token
           on token.site_id = request_row.site_id and token.access_request_id = request_row.id and token.revoked_at is null
         join hpos.events event_row on event_row.site_id = request_row.site_id and event_row.id = request_row.event_id
         where request_row.site_id = $1 and request_row.id = $2
         for update of request_row`,
        [siteId, candidate.access_request_id],
      );
      const job = await client.query<{ id: string; claim_id: string | null; lease_expires_at: Date | null; closed_at: Date | null; attempt_count: number; requires_verification: boolean; access_request_token_hash: string | null }>(
        `select j.id, j.claim_id, c.lease_expires_at, c.closed_at, j.attempt_count, j.requires_verification, j.access_request_token_hash
         from hpos.notification_jobs j
         left join hpos.notification_claims c on c.id = j.claim_id and c.site_id = j.site_id
         where j.site_id = $1 and j.id = $2 and j.status = 'pending' and j.is_superseded = false
           and j.available_at <= clock_timestamp()
           and (j.claim_id is null or c.id is null or c.closed_at is not null or c.lease_expires_at <= clock_timestamp())
         for update of j skip locked`,
        [siteId, candidate.id],
      );
      const current = requestCurrent.rows[0];
      const lockedJob = job.rows[0];
      if (!lockedJob) continue;
      const tokenMatches = Boolean(current && current.status === "approved" && current.event_active && current.event_id === candidate.event_id && current.token_hash && lockedJob.access_request_token_hash === current.token_hash);
      if (!tokenMatches) {
        // A job with no dispatch attempt is safe to discard. If a provider
        // outcome may already be unknown, retain the row for a verification-
        // only claim. The response marks it superseded so a worker cannot
        // resend the old token, while the active claim still accepts a
        // completed, failed, or unknown reconciliation report.
        if (lockedJob.attempt_count === 0 && !lockedJob.requires_verification && !lockedJob.claim_id) {
          await client.query(`update hpos.notification_jobs set is_superseded = true, claim_id = null, updated_at = clock_timestamp() where site_id = $1 and id = $2`, [siteId, candidate.id]);
          continue;
        }
        picked.push({
          id: lockedJob.id,
          expiredLease: Boolean(lockedJob.claim_id && (lockedJob.closed_at || (lockedJob.lease_expires_at && lockedJob.lease_expires_at <= new Date()))),
          verificationOnly: true,
        });
        continue;
      }
      picked.push({
        id: lockedJob.id,
        expiredLease: Boolean(lockedJob.claim_id && (lockedJob.closed_at || (lockedJob.lease_expires_at && lockedJob.lease_expires_at <= new Date()))),
        verificationOnly: false,
      });
      continue;
    }
    const job = await client.query<{ id: string; claim_id: string | null; lease_expires_at: Date | null; closed_at: Date | null }>(
      `select j.id, j.claim_id, c.lease_expires_at, c.closed_at
       from hpos.notification_jobs j
       left join hpos.notification_claims c on c.id = j.claim_id and c.site_id = j.site_id
       where j.site_id = $1 and j.id = $2 and j.status = 'pending' and j.is_superseded = false
         and j.available_at <= clock_timestamp()
         and (j.claim_id is null or c.id is null or c.closed_at is not null or c.lease_expires_at <= clock_timestamp())
       for update of j skip locked`,
      [siteId, candidate.id],
    );
    const row = job.rows[0];
    if (row) picked.push({
      id: row.id,
      expiredLease: Boolean(row.claim_id && (row.closed_at || (row.lease_expires_at && row.lease_expires_at <= new Date()))),
      verificationOnly: false,
    });
  }
  if (picked.length === 0) return { status: 200, data: { claim_id: null, lease_expires_at: null, jobs: [] } };

  const claimId = randomUUID();
  const claim = await client.query<{ lease_expires_at: Date }>(
    `insert into hpos.notification_claims (id, site_id, lease_expires_at, created_actor_type, created_actor_reference)
     values ($1, $2, clock_timestamp() + interval '5 minutes', $3, $4) returning lease_expires_at`,
    [claimId, siteId, actor.type, actor.reference],
  );
  for (const row of picked) {
    await client.query(
      `update hpos.notification_jobs set claim_id = $3,
         lease_fence = lease_fence + 1,
         requires_verification = requires_verification or $4 or $5,
         updated_at = clock_timestamp()
       where id = $1 and site_id = $2 and status = 'pending' and is_superseded = false`,
      [row.id, siteId, claimId, row.expiredLease, row.verificationOnly],
    );
  }
  const jobs = await client.query<NotificationJobRow & QueryResultRow>(`${JOB_SELECT} where j.site_id = $1 and j.claim_id = $2 order by j.available_at, j.created_at, j.id`, [siteId, claimId]);
  const verificationOnly = new Set(picked.filter((row) => row.verificationOnly).map((row) => row.id));
  return { status: 200, data: { claim_id: claimId, lease_expires_at: claim.rows[0].lease_expires_at, jobs: jobs.rows.map((row) => jobObject(row, verificationOnly.has(row.id))) } };
}

async function renewClaim(client: PoolClient, siteId: string, claimId: string, actor: Actor): Promise<IdempotentResult> {
  const current = await client.query<{ lease_expires_at: Date; closed_at: Date | null; is_active: boolean }>(
    `select lease_expires_at, closed_at, lease_expires_at > clock_timestamp() as is_active
     from hpos.notification_claims where id = $1 and site_id = $2 for update`,
    [claimId, siteId],
  );
  const claim = current.rows[0];
  if (!claim || claim.closed_at || !claim.is_active) reject(409, "claim_conflict", "The notification claim is expired or no longer active.");
  const jobs = await client.query(`select 1 from hpos.notification_jobs where site_id = $1 and claim_id = $2 and status = 'pending' limit 1`, [siteId, claimId]);
  if (jobs.rowCount === 0) reject(409, "claim_conflict", "The notification claim has no remaining active work.");
  const renewed = await client.query<{ lease_expires_at: Date }>(
    `update hpos.notification_claims set lease_expires_at = clock_timestamp() + interval '5 minutes', renewed_at = clock_timestamp(), renewed_actor_type = $3, renewed_actor_reference = $4
     where id = $1 and site_id = $2 returning lease_expires_at`,
    [claimId, siteId, actor.type, actor.reference],
  );
  return { status: 200, data: { claim_id: claimId, lease_expires_at: renewed.rows[0].lease_expires_at } };
}

async function reportOutcome(client: PoolClient, siteId: string, jobId: string, claimId: string, input: OutcomeReportInput, actor: Actor): Promise<IdempotentResult> {
  const jobResult = await client.query<NotificationJobRow & QueryResultRow>(
    `select j.id, j.site_id, j.kind, j.status, j.event_id, j.order_id, j.access_request_id, j.access_request_token_hash, j.ticket_id,
       j.is_superseded, j.attempt_count, j.available_at, j.created_at, j.updated_at,
       j.requires_verification, j.provider_message_reference, j.failure_class, j.payload, j.claim_id, j.lease_fence,
       c.lease_expires_at
     from hpos.notification_jobs j
     left join hpos.notification_claims c on c.id = j.claim_id and c.site_id = j.site_id
     where j.site_id = $1 and j.id = $2 for update of j`,
    [siteId, jobId],
  );
  const job = jobResult.rows[0];
  if (!job) reject(404, "not_found", "The notification job is not available to this Site.");
  const activeClaim = job.claim_id === claimId
    ? await client.query<{ is_active: boolean }>(`select closed_at is null and lease_expires_at > clock_timestamp() as is_active from hpos.notification_claims where id = $1 and site_id = $2 for update`, [claimId, siteId])
    : null;
  if (job.status !== "pending" || job.is_superseded || job.claim_id !== claimId || Number(job.lease_fence) !== input.lease_fence || !activeClaim?.rows[0]?.is_active) reject(409, "claim_conflict", "The notification outcome does not hold the current active lease fence.");

  const nextAttempt = job.attempt_count + 1;
  let nextStatus: "pending" | "failed" | "completed" = "pending";
  let retryDelayMinutes: number | null = null;
  let requiresVerification = false;
  const failureClass = input.outcome === "failed" ? input.failure_class ?? "transient" : null;
  if (input.outcome === "completed") nextStatus = "completed";
  if (input.outcome === "unknown") requiresVerification = true;
  if (input.outcome === "failed") {
    if (failureClass === "permanent") nextStatus = "failed";
    else {
      const retryDelay = RETRY_DELAYS_MINUTES[nextAttempt - 1];
      if (retryDelay === undefined) nextStatus = "failed";
      else retryDelayMinutes = retryDelay;
    }
  }
  await client.query(
    `insert into hpos.notification_dispatch_attempts
       (site_id, job_id, claim_id, lease_fence, attempt_number, outcome, provider_message_reference, observed_at, error_code, failure_class, actor_type, actor_reference)
     values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10, $11, $12)`,
    [siteId, jobId, claimId, input.lease_fence, nextAttempt, input.outcome, input.provider_message_reference, input.observed_at, input.error_code, failureClass, actor.type, actor.reference],
  );
  const updated = await client.query(
    `update hpos.notification_jobs set status = $3, attempt_count = $4,
       available_at = case when $3 = 'pending' and $5::integer is not null then clock_timestamp() + ($5::integer * interval '1 minute') else available_at end,
       requires_verification = $6,
       failure_class = $7,
       provider_message_reference = coalesce($8, provider_message_reference),
       claim_id = null, updated_at = clock_timestamp()
     where site_id = $1 and id = $2`,
    [siteId, jobId, nextStatus, nextAttempt, retryDelayMinutes, requiresVerification, failureClass, input.provider_message_reference],
  );
  await closeEmptyClaim(client, siteId, claimId);
  if (updated.rowCount !== 1) reject(404, "not_found", "The notification job is not available to this Site.");
  const latest = await readJob(client, siteId, jobId);
  return { status: 200, data: latest };
}

async function closeEmptyClaim(client: PoolClient, siteId: string, claimId: string): Promise<void> {
  await client.query(
    `update hpos.notification_claims c set closed_at = clock_timestamp()
     where c.id = $1 and c.site_id = $2 and c.closed_at is null
       and not exists (select 1 from hpos.notification_jobs j where j.site_id = c.site_id and j.claim_id = c.id and j.status = 'pending')`,
    [claimId, siteId],
  );
}

async function reportDelivery(client: PoolClient, siteId: string, jobId: string, input: DeliveryReportInput, actor: Actor): Promise<IdempotentResult> {
  const job = await client.query<{ id: string; kind: NotificationKind; status: string }>(
    `select id, kind, status from hpos.notification_jobs where site_id = $1 and id = $2 for update`,
    [siteId, jobId],
  );
  const row = job.rows[0];
  if (!row) reject(404, "not_found", "The notification job is not available to this Site.");
  if (row.kind === "wallet_update") reject(422, "validation_failed", "Wallet update jobs do not accept email delivery reports.");
  const existingEvent = await client.query<{ job_id: string; provider_message_reference: string; outcome: DeliveryOutcome; observed_at: Date }>(
    `select job_id, provider_message_reference, outcome, observed_at
     from hpos.notification_delivery_events where site_id = $1 and provider_event_reference = $2 for update`,
    [siteId, input.provider_event_reference],
  );
  if (existingEvent.rows[0]) {
    const existing = existingEvent.rows[0];
    if (existing.job_id !== jobId || existing.provider_message_reference !== input.provider_message_reference || existing.outcome !== input.outcome || existing.observed_at.toISOString() !== new Date(input.observed_at).toISOString()) {
      reject(409, "delivery_report_conflict", "This provider event reference already identifies a different delivery observation.");
    }
    const replay = await readJob(client, siteId, jobId);
    return { status: 200, data: replay };
  }

  const dispatch = await client.query(
    `select 1 from hpos.notification_dispatch_attempts
     where site_id = $1 and job_id = $2 and provider_message_reference = $3 and outcome = 'completed' limit 1`,
    [siteId, jobId, input.provider_message_reference],
  );
  if (dispatch.rowCount === 0) reject(409, "delivery_report_conflict", "The provider message reference is not a confirmed dispatch for this notification job.");
  const conflictingInstant = await client.query(
    `select 1 from hpos.notification_delivery_events
     where site_id = $1 and job_id = $2 and provider_message_reference = $3
       and observed_at = $4::timestamptz and outcome <> $5 limit 1`,
    [siteId, jobId, input.provider_message_reference, input.observed_at, input.outcome],
  );
  if (conflictingInstant.rowCount) reject(409, "delivery_report_conflict", "Different delivery outcomes cannot share the same provider observation time.");
  await client.query(
    `insert into hpos.notification_delivery_events
       (site_id, job_id, provider_message_reference, provider_event_reference, outcome, observed_at, actor_type, actor_reference)
     values ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8)`,
    [siteId, jobId, input.provider_message_reference, input.provider_event_reference, input.outcome, input.observed_at, actor.type, actor.reference],
  );
  const latest = await readJob(client, siteId, jobId);
  return { status: 200, data: latest };
}

export type ProcessingTrigger = "local_scheduler" | "vercel_cron";
export interface ProcessingResult {
  run_id: string;
  trigger: ProcessingTrigger;
  started_at: string;
  finished_at: string;
  recovered_jobs: number;
  verification_required_attempts: number;
  released_reservations: number;
  batch_limit: number;
  has_more: boolean;
  site_execution: "separate";
}

/** One bounded HP-OS recovery batch. It never calls a provider or Site worker. */
export async function runBoundedProcessing(trigger: ProcessingTrigger): Promise<ProcessingResult> {
  const client = await getBusinessPool().connect();
  const runId = randomUUID();
  try {
    await client.query("begin");
    const clock = await client.query<{ started_at: Date }>(`select clock_timestamp() as started_at`);
    const startedAt = clock.rows[0].started_at;
    const expired = await client.query<{ id: string; claim_id: string }>(
      `select j.id, j.claim_id
       from hpos.notification_jobs j
       join hpos.notification_claims c on c.id = j.claim_id and c.site_id = j.site_id
       where j.status = 'pending' and j.is_superseded = false
         and (c.closed_at is not null or c.lease_expires_at <= clock_timestamp())
       order by c.lease_expires_at, j.id
       limit $1
       for update of j skip locked`,
      [MAX_PROCESS_BATCH],
    );
    const jobIds = expired.rows.map((row) => row.id);
    const claimIds = [...new Set(expired.rows.map((row) => row.claim_id))];
    if (jobIds.length) {
      await client.query(
        `update hpos.notification_jobs set claim_id = null, lease_fence = lease_fence + 1,
           requires_verification = true,
           available_at = least(available_at, clock_timestamp()), updated_at = clock_timestamp()
         where id = any($1::uuid[])`,
        [jobIds],
      );
      await client.query(
        `update hpos.notification_claims c set closed_at = clock_timestamp()
         where c.id = any($1::uuid[]) and c.closed_at is null
           and not exists (select 1 from hpos.notification_jobs j where j.site_id = c.site_id and j.claim_id = c.id and j.status = 'pending')`,
        [claimIds],
      );
    }
    const verificationRequired = await client.query<{ id: string }>(
      `with candidates as (
         select attempt.id
         from hpos.payment_attempts attempt
         join hpos.orders order_row
           on order_row.id = attempt.order_id and order_row.site_id = attempt.site_id
         join hpos.reservations reservation
           on reservation.order_id = order_row.id and reservation.site_id = order_row.site_id
         where order_row.checkout_status = 'awaiting_payment_result'
           and order_row.payment_status in ('unpaid', 'failed', 'processing', 'unknown', 'conflicted')
           and order_row.checkout_expires_at <= clock_timestamp()
           and reservation.status = 'held'
           and attempt.status in ('creating', 'open')
           and attempt.provider_can_take_payment is distinct from false
         order by attempt.created_at, attempt.id
         limit $1
         for update of attempt skip locked
       )
       update hpos.payment_attempts attempt
       set status = 'requires_verification', version = version + 1, updated_at = clock_timestamp()
       from candidates
       where attempt.id = candidates.id
       returning attempt.id`,
      [MAX_PROCESS_BATCH],
    );
    const expiredReservations = await client.query<{ id: string; order_id: string; offering_id: string; site_id: string; quantity: number }>(
      `select reservation.id, reservation.order_id, reservation.offering_id,
              reservation.site_id, reservation.quantity
       from hpos.reservations reservation
       join hpos.orders order_row
         on order_row.id = reservation.order_id
        and order_row.site_id = reservation.site_id
       where reservation.status = 'held'
         and reservation.awaiting_provider_verification = false
         and reservation.expires_at <= clock_timestamp()
         and order_row.checkout_status = 'active'
         and order_row.payment_status in ('unpaid', 'failed')
       order by reservation.expires_at, reservation.id
       limit $1
       for update of reservation, order_row skip locked`,
      [MAX_PROCESS_BATCH],
    );
    const reservationIds = expiredReservations.rows.map((row) => row.id);
    const orderIds = expiredReservations.rows.map((row) => row.order_id);
    let releasedReservations = 0;
    if (reservationIds.length) {
      const offeringIds = [...new Set(expiredReservations.rows.map((row) => row.offering_id))];
      const releaseCapacity = await client.query(
        `with release_totals as (
           select offering_id, site_id, sum(quantity)::bigint as quantity
           from hpos.reservations
           where id = any($1::uuid[]) and status = 'held'
           group by offering_id, site_id
         )
         update hpos.ticket_offerings offering
         set reserved_quantity = offering.reserved_quantity - release_totals.quantity
         from release_totals
         where offering.id = release_totals.offering_id
           and offering.site_id = release_totals.site_id
           and offering.reserved_quantity >= release_totals.quantity
         returning offering.id`,
        [reservationIds],
      );
      if (releaseCapacity.rowCount !== offeringIds.length) throw new Error("Expired Reservation capacity counters did not match their holds.");
      const released = await client.query(
        `update hpos.reservations
         set status = 'released', updated_at = clock_timestamp()
         where id = any($1::uuid[]) and status = 'held'
         returning id`,
        [reservationIds],
      );
      if (released.rowCount !== reservationIds.length) throw new Error("An expired Reservation changed before it could be released.");
      await client.query(
        `update hpos.orders
         set checkout_status = 'expired', version = version + 1, updated_at = clock_timestamp()
         where id = any($1::uuid[]) and checkout_status = 'active' and payment_status in ('unpaid', 'failed')`,
        [orderIds],
      );
      releasedReservations = released.rowCount;
    }
    const more = await client.query(
      `select 1 from hpos.notification_jobs j join hpos.notification_claims c on c.id = j.claim_id and c.site_id = j.site_id
       where j.status = 'pending' and j.is_superseded = false
         and (c.closed_at is not null or c.lease_expires_at <= clock_timestamp()) limit 1`,
    );
    const moreReservations = await client.query(
      `select 1
       from hpos.reservations reservation
       join hpos.orders order_row on order_row.id = reservation.order_id and order_row.site_id = reservation.site_id
       where reservation.status = 'held'
         and reservation.awaiting_provider_verification = false
         and reservation.expires_at <= clock_timestamp()
         and order_row.checkout_status = 'active'
         and order_row.payment_status in ('unpaid', 'failed')
       limit 1`,
    );
    const moreVerification = await client.query(
      `select 1
       from hpos.payment_attempts attempt
       join hpos.orders order_row on order_row.id = attempt.order_id and order_row.site_id = attempt.site_id
       join hpos.reservations reservation on reservation.order_id = order_row.id and reservation.site_id = order_row.site_id
       where order_row.checkout_status = 'awaiting_payment_result'
         and order_row.payment_status in ('unpaid', 'failed', 'processing', 'unknown', 'conflicted')
         and order_row.checkout_expires_at <= clock_timestamp()
         and reservation.status = 'held'
         and attempt.status in ('creating', 'open')
         and attempt.provider_can_take_payment is distinct from false
       limit 1`,
    );
    const finishedAt = (await client.query<{ finished_at: Date }>(`select clock_timestamp() as finished_at`)).rows[0].finished_at;
    const result: ProcessingResult = {
      run_id: runId,
      trigger,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      recovered_jobs: jobIds.length,
      verification_required_attempts: verificationRequired.rowCount ?? 0,
      released_reservations: releasedReservations,
      batch_limit: MAX_PROCESS_BATCH,
      has_more: (more.rowCount ?? 0) > 0 || (moreReservations.rowCount ?? 0) > 0 || (moreVerification.rowCount ?? 0) > 0,
      site_execution: "separate",
    };
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function handleScheduledProcessing(request: Request): Promise<Response> {
  const expected = process.env.CRON_SECRET;
  const production = process.env.NODE_ENV === "production";
  const requestHost = new URL(request.url).hostname.toLowerCase();
  const loopbackHost = requestHost === "127.0.0.1" || requestHost === "::1" || requestHost === "localhost";
  if ((expected && request.headers.get("authorization") !== `Bearer ${expected}`) || (!expected && production) || (!production && !loopbackHost)) {
    return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const processing = await runBoundedProcessing(production ? "vercel_cron" : "local_scheduler");
    const issuance = await (await import("./ticket-issuance")).processPendingTicketIssuance();
    return apiSuccess({ ...processing, has_more: processing.has_more || issuance.has_more, ticket_issuance: issuance });
  }
  catch { return apiFailure(503, "service_unavailable", "The bounded HP-OS processing cycle failed.", { retryAfter: 30 }); }
}
