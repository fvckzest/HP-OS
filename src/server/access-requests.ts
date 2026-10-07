import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { apiFailure, apiSuccess } from "./api-response";
import { ApiOperationError, withApiIdempotency } from "./api-idempotency";
import type { IdempotentResult } from "./api-idempotency";
import { getBusinessPool } from "./database";
import { enqueueNotificationJob, supersedeUnsentNotificationJobs } from "./notifications";
import type { AuthenticatedSite } from "./site-auth";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,200}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BODY_BYTES = 64 * 1024;
const ACTOR_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

type AccessStatus = "pending" | "approved" | "rejected";
type DecisionAction = "approve" | "reject" | "undo_decision" | "correct";

interface Actor {
  type: "user" | "system";
  reference: string;
}

interface AccessRequestRow extends QueryResultRow {
  id: string;
  site_id: string;
  event_id: string;
  name: string;
  email: string;
  normalized_email: string;
  status: AccessStatus;
  version: number;
  decision_at: Date | null;
  paid_order_id: string | null;
  created_at: Date;
  updated_at: Date;
  created_cursor_time?: string;
}

interface EventAccessRow extends QueryResultRow {
  id: string;
  site_id: string;
  title: string | null;
  description: string | null;
  venue_name: string | null;
  venue_address: string | null;
  starts_at: Date | null;
  starts_at_offset_minutes: number | null;
  ends_at: Date | null;
  ends_at_offset_minutes: number | null;
  time_zone: string | null;
  check_in_opens_at: Date | null;
  check_in_opens_offset_minutes: number | null;
  visibility: "public" | "private" | null;
  publication_status: "draft" | "published";
  is_canceled: boolean;
  is_archived: boolean;
  sales_paused: boolean;
  price_amount: string | null;
  currency: string | null;
  tax_amount: string | null;
  buyer_fees: Array<{ code: string; label: string; amount: number; currency: string }> | null;
  capacity: string | null;
  reserved_quantity: string;
  sales_opens_at: Date | null;
  sales_closes_at: Date | null;
  ticket_offering_id: string;
}

class AccessRequestError extends ApiOperationError {}

function fail(status: number, code: string, message: string, details: Array<{ field: string; code: string; message: string }> = []): never {
  throw new AccessRequestError(status, code, message, details);
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function validText(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length <= maximum
    && value.trim().length > 0
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validEmail(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && EMAIL_PATTERN.test(value);
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function normalizedEmail(email: string): string {
  return email.trim().toLowerCase();
}

function iso(value: Date | null, offsetMinutes: number | null): string | null {
  if (!value) return null;
  const offset = Number(offsetMinutes ?? 0);
  const local = new Date(value.getTime() + offset * 60_000).toISOString().replace(/Z$/, "").replace(/\.000$/, "");
  const suffix = offset === 0
    ? "Z"
    : `${offset < 0 ? "-" : "+"}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}:${String(Math.abs(offset) % 60).padStart(2, "0")}`;
  return local + suffix;
}

function safeNumber(value: string | null): number | null {
  if (value === null) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function eventSalesStatus(row: EventAccessRow, now = Date.now()): string {
  if (row.is_canceled) return "canceled";
  if (row.ends_at && row.ends_at.getTime() <= now) return "closed";
  if (row.price_amount === null || row.tax_amount === null || row.buyer_fees === null || row.capacity === null || !row.sales_opens_at || !row.sales_closes_at) return "not_configured";
  if (row.sales_closes_at.getTime() <= now) return "closed";
  if (row.sales_opens_at.getTime() > now) return "scheduled";
  if (row.sales_paused) return "paused";
  if (Number(row.reserved_quantity) >= Number(row.capacity)) return "sold_out";
  return "open";
}

function publicEventData(row: EventAccessRow): Record<string, unknown> {
  const amount = safeNumber(row.price_amount);
  return {
    event_id: row.id,
    title: row.title,
    description: row.description,
    venue: { name: row.venue_name, address: row.venue_address },
    starts_at: iso(row.starts_at, row.starts_at_offset_minutes),
    ends_at: iso(row.ends_at, row.ends_at_offset_minutes),
    time_zone: row.time_zone,
    check_in_opens_at: iso(row.check_in_opens_at ?? row.starts_at, row.check_in_opens_at ? row.check_in_opens_offset_minutes : row.starts_at_offset_minutes),
    visibility: row.visibility,
    purchase_mode: row.visibility === "private" ? "access_request" : "public_checkout",
    sales_status: eventSalesStatus(row),
    is_canceled: row.is_canceled,
    is_archived: row.is_archived,
    ticket_offering: {
      price: amount === null || !row.currency ? null : { amount, currency: row.currency },
      max_quantity_per_order: 1,
    },
  };
}

function actorFrom(value: unknown): Actor | null {
  if (!object(value) || !hasOnlyKeys(value, ["type", "reference"])) return null;
  if ((value.type !== "user" && value.type !== "system") || typeof value.reference !== "string") return null;
  const reference = value.reference.trim();
  return ACTOR_REFERENCE_PATTERN.test(reference) ? { type: value.type, reference } : null;
}

function numericVersion(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function fieldError(field: string, code: string, message: string): Response {
  return apiFailure(422, "validation_failed", message, { details: [{ field, code, message }] });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | Response> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return apiFailure(415, "unsupported_media_type", "Send Access Request fields as application/json.");
  }
  let text: string;
  try { text = await request.text(); }
  catch { return apiFailure(400, "invalid_request", "The request body could not be read as JSON."); }
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return apiFailure(413, "request_too_large", "The request body exceeds 64 KiB.");
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return apiFailure(400, "invalid_request", "The request body must contain readable JSON."); }
  if (!object(value)) return apiFailure(400, "invalid_request", "The request body must be a JSON object.");
  return value;
}

function parseSubmission(value: Record<string, unknown>): { name: string; email: string; normalizedEmail: string } | Response {
  if (!hasOnlyKeys(value, ["name", "email"])) return fieldError(Object.keys(value).find((key) => !["name", "email"].includes(key)) ?? "body", "unknown_field", "Remove the unsupported field.");
  if (!validText(value.name, 200)) return fieldError("name", "invalid_text", "Provide the intended attendee name within 200 characters.");
  if (!validEmail(value.email)) return fieldError("email", "invalid_email", "Provide a valid attendee email address.");
  const name = value.name.trim();
  const email = value.email.trim();
  if (!name || name.length > 200) return fieldError("name", "invalid_text", "Provide the intended attendee name within 200 characters.");
  return { name, email, normalizedEmail: normalizedEmail(email) };
}

async function lockEvent(client: PoolClient, siteId: string, eventId: string): Promise<EventAccessRow> {
  const result = await client.query<EventAccessRow>(
    `select e.id, e.site_id, e.title, e.description, e.venue_name, e.venue_address,
            e.starts_at, e.starts_at_offset_minutes, e.ends_at, e.ends_at_offset_minutes,
            e.time_zone, e.check_in_opens_at, e.check_in_opens_offset_minutes,
            e.visibility, e.publication_status, e.is_canceled, e.is_archived, e.sales_paused,
            o.id as ticket_offering_id, o.price_amount, o.currency, o.tax_amount, o.buyer_fees,
            o.capacity, o.reserved_quantity, o.sales_opens_at, o.sales_closes_at
     from hpos.events e
     join hpos.ticket_offerings o on o.id = e.ticket_offering_id
       and o.event_id = e.id and o.site_id = e.site_id
     where e.site_id = $1 and e.id = $2
     for update of e, o`,
    [siteId, eventId],
  );
  const row = result.rows[0];
  if (!row) fail(404, "not_found", "The Event is not available to this Site.");
  return row;
}

function assertRequestSubmissionEvent(row: EventAccessRow): void {
  if (row.publication_status !== "published" || row.is_archived) fail(404, "not_found", "The Event is not available for Access Requests.");
  if (row.visibility !== "private") fail(409, "access_not_required", "This Event accepts public checkout instead of Access Requests.");
  if (row.is_canceled || (row.ends_at && row.ends_at.getTime() <= Date.now()) || (row.sales_closes_at && row.sales_closes_at.getTime() <= Date.now())) {
    fail(409, "sales_closed", "Access Requests for this Event are closed.");
  }
}

function assertApprovalEvent(row: EventAccessRow): void {
  if (row.publication_status !== "published" || row.is_archived) fail(404, "not_found", "The Event is not available to this Site.");
  if (row.visibility !== "private") fail(409, "access_not_required", "This Event accepts public checkout instead of Access Requests.");
  if (row.is_canceled || (row.ends_at && row.ends_at.getTime() <= Date.now()) || (row.sales_closes_at && row.sales_closes_at.getTime() <= Date.now())) {
    fail(409, "sales_closed", "Approval cannot be issued after Event sales close.");
  }
}

async function submitAccessRequest(client: PoolClient, site: AuthenticatedSite, eventId: string, input: { name: string; email: string; normalizedEmail: string }): Promise<IdempotentResult> {
  const event = await lockEvent(client, site.siteId, eventId);
  assertRequestSubmissionEvent(event);
  await client.query(
    `insert into hpos.access_requests (id, site_id, event_id, name, email, normalized_email)
     values ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), site.siteId, eventId, input.name, input.email, input.normalizedEmail],
  );
  return { status: 201, data: { received: true } };
}

function adminAccessRequestData(row: AccessRequestRow): Record<string, unknown> {
  return {
    request_id: row.id,
    event_id: row.event_id,
    name: row.name,
    email: row.email,
    status: row.status,
    version: row.version,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    decision_at: row.decision_at?.toISOString() ?? null,
    paid_order_id: row.paid_order_id,
  };
}

function cursorFor(site: AuthenticatedSite, scope: string, createdAt: Date | string, id: string): string {
  const timestamp = typeof createdAt === "string" ? createdAt : createdAt.toISOString();
  const payload = Buffer.from(JSON.stringify({ siteId: site.siteId, route: "admin-access-requests", scope, issuedAt: new Date().toISOString(), createdAt: timestamp, id }), "utf8").toString("base64url");
  return `${payload}.${createHmac("sha256", site.cursorSigningKey).update(payload).digest("base64url")}`;
}

function decodeCursor(value: string | null, site: AuthenticatedSite, scope: string): { createdAt: string; id: string } | Response | null {
  if (value === null) return null;
  try {
    const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(value);
    if (value.length > 2048 || !match) throw new Error();
    const expected = createHmac("sha256", site.cursorSigningKey).update(match[1]).digest();
    const supplied = Buffer.from(match[2], "base64url");
    if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) throw new Error();
    const decoded = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")) as Record<string, unknown>;
    if (decoded.siteId !== site.siteId || decoded.route !== "admin-access-requests" || decoded.scope !== scope
      || typeof decoded.createdAt !== "string" || typeof decoded.issuedAt !== "string" || typeof decoded.id !== "string"
      || !UUID_PATTERN.test(decoded.id) || !RFC3339_PATTERN.test(decoded.createdAt) || !RFC3339_PATTERN.test(decoded.issuedAt)) throw new Error();
    const issuedAt = Date.parse(decoded.issuedAt);
    if (!Number.isFinite(issuedAt) || issuedAt < Date.now() - 60 * 60 * 1000 || issuedAt > Date.now() + 60_000) throw new Error();
    return { createdAt: decoded.createdAt, id: decoded.id };
  } catch {
    return apiFailure(422, "invalid_cursor", "The cursor is invalid for this Access Request list.");
  }
}

async function listAccessRequests(request: Request, site: AuthenticatedSite, eventId: string): Promise<Response> {
  if (!UUID_PATTERN.test(eventId)) return apiFailure(404, "not_found", "The Event is not available to this Site.");
  const eventResult = await getBusinessPool().query<{ id: string }>(
    `select id from hpos.events where site_id = $1 and id = $2`,
    [site.siteId, eventId],
  );
  if (!eventResult.rows[0]) return apiFailure(404, "not_found", "The Event is not available to this Site.");
  const url = new URL(request.url);
  const allowed = new Set(["limit", "cursor", "status", "email"]);
  for (const key of url.searchParams.keys()) if (!allowed.has(key)) return fieldError(key, "unknown_filter", "Remove the unsupported Access Request list parameter.");
  const limitText = url.searchParams.get("limit");
  const limit = limitText === null ? 50 : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fieldError("limit", "out_of_range", "limit must be an integer from 1 to 100.");
  const status = url.searchParams.get("status");
  if (status !== null && !["pending", "approved", "rejected"].includes(status)) return fieldError("status", "unsupported_value", "status must be pending, approved, or rejected.");
  const email = url.searchParams.get("email");
  if (email !== null && (!validEmail(email) || email.trim().length > 254)) return fieldError("email", "invalid_email", "email must be a valid attendee email address.");
  const scope = JSON.stringify({ eventId, status, email: email === null ? null : normalizedEmail(email), limit });
  const cursor = decodeCursor(url.searchParams.get("cursor"), site, scope);
  if (cursor instanceof Response) return cursor;
  const values: unknown[] = [site.siteId, eventId, status, email === null ? null : normalizedEmail(email)];
  let where = `r.site_id = $1 and r.event_id = $2 and ($3::text is null or r.status = $3) and ($4::text is null or r.normalized_email = $4)`;
  if (cursor) {
    values.push(cursor.createdAt, cursor.id);
    where += ` and (r.created_at < $${values.length - 1}::timestamptz or (r.created_at = $${values.length - 1}::timestamptz and r.id > $${values.length}::uuid))`;
  }
  values.push(limit + 1);
  const result = await getBusinessPool().query<AccessRequestRow>(
    `select r.id, r.site_id, r.event_id, r.name, r.email, r.normalized_email, r.status,
            r.version, r.decision_at, r.paid_order_id, r.created_at, r.updated_at,
            to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_cursor_time
     from hpos.access_requests r where ${where}
     order by r.created_at desc, r.id asc limit $${values.length}`,
    values,
  );
  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1);
  const nextCursor = result.rows.length > limit && last ? cursorFor(site, scope, last.created_cursor_time ?? last.created_at, last.id) : null;
  return apiSuccess(rows.map(adminAccessRequestData), 200, { nextCursor });
}

async function readAdminAccessRequest(site: AuthenticatedSite, requestId: string): Promise<Response> {
  if (!UUID_PATTERN.test(requestId)) return apiFailure(404, "not_found", "The Access Request is not available to this Site.");
  const result = await getBusinessPool().query<AccessRequestRow>(
    `select id, site_id, event_id, name, email, normalized_email, status, version,
            decision_at, paid_order_id, created_at, updated_at
     from hpos.access_requests where site_id = $1 and id = $2`,
    [site.siteId, requestId],
  );
  return result.rows[0] ? apiSuccess(adminAccessRequestData(result.rows[0])) : apiFailure(404, "not_found", "The Access Request is not available to this Site.");
}

async function lockRequestMutation(client: PoolClient, site: AuthenticatedSite, requestId: string): Promise<{ request: AccessRequestRow; event: EventAccessRow }> {
  const initial = await client.query<{ event_id: string }>(
    `select event_id from hpos.access_requests where site_id = $1 and id = $2`,
    [site.siteId, requestId],
  );
  const eventId = initial.rows[0]?.event_id;
  if (!eventId) fail(404, "not_found", "The Access Request is not available to this Site.");
  await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`access-request:${site.siteId}:${requestId}`]);
  const event = await lockEvent(client, site.siteId, eventId);
  const result = await client.query<AccessRequestRow>(
    `select id, site_id, event_id, name, email, normalized_email, status, version,
            decision_at, paid_order_id, created_at, updated_at
     from hpos.access_requests where site_id = $1 and id = $2 for update`,
    [site.siteId, requestId],
  );
  const row = result.rows[0];
  if (!row) fail(404, "not_found", "The Access Request is not available to this Site.");
  return { request: row, event };
}

function requireActor(value: unknown): Actor {
  const actor = actorFrom(value);
  if (!actor) fail(422, "validation_failed", "Include an actor for audit attribution.", [{ field: "actor", code: "invalid_actor", message: "Use a user or system actor with a Site-local reference." }]);
  return actor;
}

async function linkedOrderHasUnresolvedPayment(client: PoolClient, siteId: string, requestId: string): Promise<boolean> {
  const result = await client.query<{ unresolved: boolean }>(
    `select exists (
       select 1 from hpos.orders o
       left join hpos.reservations reservation on reservation.site_id = o.site_id and reservation.order_id = o.id
       where o.site_id = $1 and o.access_request_id = $2
         and (o.payment_status in ('processing', 'unknown', 'conflicted')
           or o.checkout_status = 'awaiting_payment_result'
           or reservation.awaiting_provider_verification = true
           or exists (
             select 1 from hpos.payment_attempts attempt
             where attempt.site_id = o.site_id and attempt.order_id = o.id
               and (attempt.status in ('creating', 'open', 'requires_verification')
                 or attempt.provider_can_take_payment is distinct from false)
           )
         )
     ) as unresolved`,
    [siteId, requestId],
  );
  return result.rows[0]?.unresolved ?? false;
}

async function withdrawUnpaidCheckouts(client: PoolClient, siteId: string, requestId: string): Promise<void> {
  const orders = await client.query<{
    id: string;
    payment_status: string;
    checkout_status: string;
    reservation_id: string | null;
    reservation_status: "held" | "consumed" | "released" | null;
    reservation_quantity: number | null;
    reservation_awaiting: boolean | null;
    offering_id: string | null;
    unresolved: boolean;
  }>(
    `select o.id, o.payment_status, o.checkout_status,
            reservation.id as reservation_id, reservation.status as reservation_status,
            reservation.quantity as reservation_quantity,
            reservation.awaiting_provider_verification as reservation_awaiting,
            reservation.offering_id,
            (o.payment_status in ('processing', 'unknown', 'conflicted')
              or o.checkout_status = 'awaiting_payment_result'
              or reservation.awaiting_provider_verification = true
              or exists (
                select 1 from hpos.payment_attempts attempt
                where attempt.site_id = o.site_id and attempt.order_id = o.id
                  and (attempt.status in ('creating', 'open', 'requires_verification')
                    or attempt.provider_can_take_payment is distinct from false)
              )) as unresolved
     from hpos.orders o
     join hpos.reservations reservation on reservation.site_id = o.site_id and reservation.order_id = o.id
     where o.site_id = $1 and o.access_request_id = $2 and o.payment_status <> 'paid'
     order by o.created_at, o.id
     for update of o, reservation`,
    [siteId, requestId],
  );
  for (const order of orders.rows) {
    await client.query(
      `update hpos.orders
       set checkout_status = case when $3 then 'awaiting_payment_result' else 'ended' end,
           version = version + 1, updated_at = clock_timestamp()
       where site_id = $1 and id = $2
         and checkout_status <> case when $3 then 'awaiting_payment_result' else 'ended' end`,
      [siteId, order.id, order.unresolved],
    );
    if (!order.reservation_id || order.reservation_status !== "held") continue;
    if (order.unresolved) {
      await client.query(
        `update hpos.reservations set awaiting_provider_verification = true, updated_at = clock_timestamp()
         where site_id = $1 and id = $2 and status = 'held'`,
        [siteId, order.reservation_id],
      );
      continue;
    }
    if (order.reservation_awaiting) continue;
    await client.query(
      `update hpos.reservations set status = 'released', updated_at = clock_timestamp()
       where site_id = $1 and id = $2 and status = 'held' and awaiting_provider_verification = false`,
      [siteId, order.reservation_id],
    );
    if (order.offering_id && order.reservation_quantity) {
      await client.query(
        `update hpos.ticket_offerings set reserved_quantity = reserved_quantity - $3
         where site_id = $1 and id = $2 and reserved_quantity >= $3`,
        [siteId, order.offering_id, order.reservation_quantity],
      );
    }
  }
}

async function recordDecision(client: PoolClient, siteId: string, request: AccessRequestRow, action: DecisionAction, toStatus: AccessStatus, actor: Actor, approvalTokenId: string | null): Promise<void> {
  await client.query(
    `insert into hpos.access_request_decisions
       (id, site_id, access_request_id, action, from_status, to_status, name, email,
        approval_token_id, actor_type, actor_reference, previous_version, new_version)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [randomUUID(), siteId, request.id, action, request.status, toStatus, request.name, request.email,
      approvalTokenId, actor.type, actor.reference, request.version, request.version + 1],
  );
}

async function editAccessRequest(client: PoolClient, site: AuthenticatedSite, requestId: string, body: Record<string, unknown>): Promise<IdempotentResult> {
  if (!hasOnlyKeys(body, ["name", "email", "expected_version", "actor"])) fail(422, "validation_failed", "Remove unsupported Access Request fields.");
  const expected = numericVersion(body.expected_version);
  if (!expected) fail(422, "validation_failed", "Provide expected_version.", [{ field: "expected_version", code: "required", message: "Use the Access Request version you loaded." }]);
  const actor = requireActor(body.actor);
  if (!Object.hasOwn(body, "name") && !Object.hasOwn(body, "email")) fail(422, "validation_failed", "Provide name or email to correct the attendee.");
  let name: string | undefined;
  let email: string | undefined;
  if (Object.hasOwn(body, "name")) {
    if (!validText(body.name, 200)) fail(422, "validation_failed", "Provide a valid attendee name.", [{ field: "name", code: "invalid_text", message: "Use plain text up to 200 characters." }]);
    name = body.name.trim();
  }
  if (Object.hasOwn(body, "email")) {
    if (!validEmail(body.email)) fail(422, "validation_failed", "Provide a valid attendee email.", [{ field: "email", code: "invalid_email", message: "Use a valid email address up to 254 characters." }]);
    email = body.email.trim();
  }
  const locked = await lockRequestMutation(client, site, requestId);
  const current = locked.request;
  if (current.version !== expected) fail(409, "version_conflict", "The Access Request changed. Reload it before correcting it.");
  if (current.status !== "pending") fail(409, "invalid_state", "Only a pending Access Request can be corrected.");
  if (current.paid_order_id || await linkedOrderHasUnresolvedPayment(client, site.siteId, requestId)) fail(409, "invalid_state", "Attendee details cannot be corrected while payment is unresolved or already paid.");
  const nextName = name ?? current.name;
  const nextEmail = email ?? current.email;
  await client.query(
    `update hpos.access_requests
     set name = $3, email = $4, normalized_email = $5, version = version + 1, updated_at = clock_timestamp()
     where site_id = $1 and id = $2 and version = $6`,
    [site.siteId, requestId, nextName, nextEmail, normalizedEmail(nextEmail), expected],
  );
  await recordDecision(client, site.siteId, current, "correct", "pending", actor, null);
  const updated = await client.query<AccessRequestRow>(
    `select id, site_id, event_id, name, email, normalized_email, status, version,
            decision_at, paid_order_id, created_at, updated_at
     from hpos.access_requests where site_id = $1 and id = $2`,
    [site.siteId, requestId],
  );
  return { status: 200, data: adminAccessRequestData(updated.rows[0]) };
}

async function decideAccessRequest(client: PoolClient, site: AuthenticatedSite, requestId: string, action: string, body: Record<string, unknown>): Promise<IdempotentResult> {
  if (!["approve", "reject", "undo_decision"].includes(action)) fail(404, "not_found", "The requested Access Request action is unavailable.");
  if (!hasOnlyKeys(body, ["expected_version", "actor"])) fail(422, "validation_failed", "Remove unsupported Access Request action fields.");
  const expected = numericVersion(body.expected_version);
  if (!expected) fail(422, "validation_failed", "Provide expected_version.", [{ field: "expected_version", code: "required", message: "Use the Access Request version you loaded." }]);
  const actor = requireActor(body.actor);
  const locked = await lockRequestMutation(client, site, requestId);
  const current = locked.request;
  if (current.version !== expected) fail(409, "version_conflict", "The Access Request changed. Reload it before deciding.");

  if (action === "approve") {
    if (current.status !== "pending") fail(409, "invalid_state", "Only a pending Access Request can be approved.");
    if (current.paid_order_id) fail(409, "access_already_used", "This Access Request has already produced a paid Order.");
    assertApprovalEvent(locked.event);
    const token = randomBytes(32).toString("base64url");
    const tokenId = randomUUID();
    await client.query(
      `insert into hpos.access_request_approval_tokens (id, site_id, access_request_id, token_hash)
       values ($1, $2, $3, $4)`,
      [tokenId, site.siteId, requestId, tokenHash(token)],
    );
    await client.query(
      `update hpos.access_requests set status = 'approved', decision_at = clock_timestamp(), version = version + 1, updated_at = clock_timestamp()
       where site_id = $1 and id = $2 and version = $3`,
      [site.siteId, requestId, expected],
    );
    await recordDecision(client, site.siteId, current, "approve", "approved", actor, tokenId);
    await enqueueNotificationJob(client, {
      siteId: site.siteId,
      kind: "access_approved",
      eventId: current.event_id,
      accessRequestId: requestId,
      accessRequestTokenHash: tokenHash(token),
      payload: { attendee: { name: current.name, email: current.email }, approval_token: token },
    });
  } else if (action === "reject") {
    if (current.status !== "pending") fail(409, "invalid_state", "Only a pending Access Request can be rejected.");
    if (current.paid_order_id) fail(409, "access_already_used", "This Access Request has already produced a paid Order.");
    await client.query(
      `update hpos.access_requests set status = 'rejected', decision_at = clock_timestamp(), version = version + 1, updated_at = clock_timestamp()
       where site_id = $1 and id = $2 and version = $3`,
      [site.siteId, requestId, expected],
    );
    await recordDecision(client, site.siteId, current, "reject", "rejected", actor, null);
  } else {
    if (current.status !== "approved" && current.status !== "rejected") fail(409, "invalid_state", "Only an approved or rejected Access Request can be undone.");
    await supersedeUnsentNotificationJobs(client, { siteId: site.siteId, accessRequestId: requestId, kinds: ["access_approved"] });
    await client.query(
      `update hpos.access_request_approval_tokens set revoked_at = coalesce(revoked_at, clock_timestamp())
       where site_id = $1 and access_request_id = $2 and revoked_at is null`,
      [site.siteId, requestId],
    );
    if (current.status === "approved" && !current.paid_order_id) await withdrawUnpaidCheckouts(client, site.siteId, requestId);
    await client.query(
      `update hpos.access_requests set status = 'pending', decision_at = null, version = version + 1, updated_at = clock_timestamp()
       where site_id = $1 and id = $2 and version = $3`,
      [site.siteId, requestId, expected],
    );
    await recordDecision(client, site.siteId, current, "undo_decision", "pending", actor, null);
  }

  const updated = await client.query<AccessRequestRow>(
    `select id, site_id, event_id, name, email, normalized_email, status, version,
            decision_at, paid_order_id, created_at, updated_at
     from hpos.access_requests where site_id = $1 and id = $2`,
    [site.siteId, requestId],
  );
  return { status: 200, data: adminAccessRequestData(updated.rows[0]) };
}

async function lookupApproval(site: AuthenticatedSite, token: string): Promise<Response> {
  if (!TOKEN_PATTERN.test(token)) return apiFailure(404, "not_found", "The approval link is not available.");
  const result = await getBusinessPool().query<AccessRequestRow & EventAccessRow & { token_id: string; checkout_in_progress: boolean }>(
    `select r.id, r.site_id, r.event_id, r.name, r.email, r.normalized_email, r.status,
            r.version, r.decision_at, r.paid_order_id, r.created_at, r.updated_at,
            e.title, e.description, e.venue_name, e.venue_address,
            e.starts_at, e.starts_at_offset_minutes, e.ends_at, e.ends_at_offset_minutes,
            e.time_zone, e.check_in_opens_at, e.check_in_opens_offset_minutes,
            e.visibility, e.publication_status, e.is_canceled, e.is_archived, e.sales_paused,
            o.id as ticket_offering_id, o.price_amount, o.currency, o.tax_amount, o.buyer_fees,
            o.capacity, o.reserved_quantity, o.sales_opens_at, o.sales_closes_at,
            token.id as token_id,
            exists (
              select 1 from hpos.orders active_order
              where active_order.site_id = r.site_id and active_order.access_request_id = r.id
                and (active_order.checkout_status in ('active', 'awaiting_payment_result')
                  or active_order.payment_status in ('processing', 'unknown', 'conflicted')
                  or exists (
                    select 1 from hpos.payment_attempts active_attempt
                    where active_attempt.site_id = active_order.site_id and active_attempt.order_id = active_order.id
                      and (active_attempt.status in ('creating', 'open', 'requires_verification')
                        or active_attempt.provider_can_take_payment is distinct from false)
                  )
                  or exists (
                    select 1 from hpos.reservations active_reservation
                    where active_reservation.site_id = active_order.site_id and active_reservation.order_id = active_order.id
                      and active_reservation.status = 'held' and active_reservation.awaiting_provider_verification = true
                  ))
            ) as checkout_in_progress
     from hpos.access_request_approval_tokens token
     join hpos.access_requests r on r.id = token.access_request_id and r.site_id = token.site_id
     join hpos.events e on e.id = r.event_id and e.site_id = r.site_id
     join hpos.ticket_offerings o on o.id = e.ticket_offering_id and o.event_id = e.id and o.site_id = e.site_id
     where token.site_id = $1 and token.token_hash = $2 and token.revoked_at is null and r.status = 'approved'`,
    [site.siteId, tokenHash(token)],
  );
  const row = result.rows[0];
  if (!row) return apiFailure(404, "not_found", "The approval link is not available.");
  return apiSuccess({
    request_id: row.id,
    event: publicEventData({ ...row, id: row.event_id }),
    approved_attendee: { name: row.name, email: row.email },
    max_quantity_per_order: 1,
    purchase_completed: Boolean(row.paid_order_id),
    checkout_in_progress: Boolean(row.checkout_in_progress),
  });
}

function mapDatabaseError(error: unknown): Response | null {
  if (object(error) && error.code === "23503") return apiFailure(409, "invalid_state", "The Event, Access Request, or checkout record is no longer available.");
  if (object(error) && error.code === "23514") return apiFailure(422, "validation_failed", "The Access Request violates a configured field or state rule.");
  if (object(error) && error.code === "23505") return apiFailure(409, "request_conflict", "The Access Request changed while this operation was being applied.");
  return null;
}

export async function handleAccessRequestGet(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (path.length === 3 && path[0] === "public" && path[1] === "access-requests") return lookupApproval(site, path[2]);
  if (path.length === 4 && path[0] === "admin" && path[1] === "events" && path[3] === "access-requests") return listAccessRequests(request, site, path[2]);
  if (path.length === 3 && path[0] === "admin" && path[1] === "access-requests") return readAdminAccessRequest(site, path[2]);
  return null;
}

export async function handleAccessRequestPost(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (path.length === 4 && path[0] === "public" && path[1] === "events" && path[3] === "access-requests") {
    const eventId = path[2];
    if (!UUID_PATTERN.test(eventId)) return apiFailure(404, "not_found", "The Event is not available for Access Requests.");
    const body = await readJsonBody(request);
    if (body instanceof Response) return body;
    const input = parseSubmission(body);
    if (input instanceof Response) return input;
    return withApiIdempotency(request, site, { name: input.name, email: input.email }, (client) => submitAccessRequest(client, site, eventId, input), mapDatabaseError);
  }
  if (path.length === 5 && path[0] === "admin" && path[1] === "access-requests" && path[3] === "actions") {
    const requestId = path[2];
    const action = path[4];
    if (!UUID_PATTERN.test(requestId)) return apiFailure(404, "not_found", "The Access Request is not available to this Site.");
    const body = await readJsonBody(request);
    if (body instanceof Response) return body;
    return withApiIdempotency(request, site, body, (client) => decideAccessRequest(client, site, requestId, action, body), mapDatabaseError);
  }
  return null;
}

export async function handleAccessRequestPatch(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (path.length !== 3 || path[0] !== "admin" || path[1] !== "access-requests") return null;
  const requestId = path[2];
  if (!UUID_PATTERN.test(requestId)) return apiFailure(404, "not_found", "The Access Request is not available to this Site.");
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  return withApiIdempotency(request, site, body, (client) => editAccessRequest(client, site, requestId, body), mapDatabaseError);
}
