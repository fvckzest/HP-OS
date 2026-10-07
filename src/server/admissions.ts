import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { apiFailure, apiSuccess } from "./api-response";
import { ApiOperationError, withApiIdempotency } from "./api-idempotency";
import type { IdempotentResult } from "./api-idempotency";
import { getBusinessPool } from "./database";
import type { AuthenticatedSite } from "./site-auth";
import { enqueueWalletUpdateJobs } from "./wallet-data";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const ACTOR_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Actor {
  type: "user" | "system";
  reference: string;
}

interface AdmissionTarget extends QueryResultRow {
  ticket_id: string;
  ticket_event_id: string;
  order_id: string;
  site_id: string;
  refund_status: "none" | "partial" | "full";
  is_canceled: boolean;
  starts_at: Date | null;
  ends_at: Date | null;
  check_in_opens_at: Date | null;
}

interface AdmissionRow extends QueryResultRow {
  id: string;
  admitted_at: Date;
}

interface LookupOrder extends QueryResultRow {
  order_id: string;
  order_reference: string;
  buyer_name: string;
  delivery_email: string;
  checkout_status: string;
  payment_status: string;
  issuance_status: string;
  delivery_status: string;
  created_cursor_time: string;
}

interface LookupTicket extends QueryResultRow {
  ticket_id: string;
  event_id: string;
  order_id: string;
  order_reference: string;
  ordinal: number;
  issued_at: Date;
  attendee_name: string | null;
  refund_status: "none" | "partial" | "full";
  is_canceled: boolean;
  starts_at: Date | null;
  ends_at: Date | null;
  check_in_opens_at: Date | null;
  admission_id: string | null;
  admitted_at: Date | null;
  version: number;
  checked_at: Date;
}

interface LookupCursor {
  at: string;
  id: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fieldError(field: string, code: string, message: string): Response {
  return apiFailure(422, "validation_failed", message, {
    details: [{ field, code, message }],
  });
}

function operationError(status: number, code: string, message: string): never {
  throw new ApiOperationError(status, code, message);
}

function validKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function actorFrom(value: unknown): Actor | null {
  if (!object(value) || !validKeys(value, ["type", "reference"])) return null;
  if ((value.type !== "user" && value.type !== "system") || typeof value.reference !== "string") return null;
  const reference = value.reference.trim();
  if (!ACTOR_REFERENCE_PATTERN.test(reference)) return null;
  return { type: value.type, reference };
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | Response> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return apiFailure(415, "unsupported_media_type", "Send the operation fields as application/json.");
  }
  let text: string;
  try { text = await request.text(); }
  catch { return apiFailure(400, "invalid_request", "The request body could not be read as JSON."); }
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) return apiFailure(413, "request_too_large", "The request body exceeds 64 KiB.");
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return apiFailure(400, "invalid_request", "The request body must contain readable JSON."); }
  if (!object(value)) return apiFailure(400, "invalid_request", "The request body must be a JSON object.");
  return value;
}

function mapAdmissionDatabaseError(error: unknown): Response | null {
  if (!object(error)) return null;
  if (error.code === "23505") return apiFailure(409, "already_admitted", "This Ticket already has its one Admission.");
  if (error.code === "23503") return apiFailure(404, "not_found", "The Ticket is not available to this Site.");
  if (error.code === "23514") return apiFailure(422, "validation_failed", "The Admission request violates a configured field constraint.");
  return null;
}

function admissionBlockers(
  row: Pick<LookupTicket, "is_canceled" | "refund_status" | "admission_id" | "check_in_opens_at" | "starts_at" | "ends_at">,
  now: Date,
): string[] {
  const blockers: string[] = [];
  const opensAt = row.check_in_opens_at ?? row.starts_at;
  if (row.is_canceled) blockers.push("event_canceled");
  if (row.refund_status === "full") blockers.push("ticket_refunded");
  if (row.admission_id !== null) blockers.push("already_admitted");
  if (!opensAt || now.getTime() < opensAt.getTime()) blockers.push("check_in_not_open");
  if (!row.ends_at || now.getTime() > row.ends_at.getTime()) blockers.push("check_in_closed");
  return blockers;
}

function cursorScope(eventId: string, limit: number, searchKind: "order_reference" | "email", searchValue: string): string {
  return JSON.stringify({ eventId, limit, searchKind, searchValue });
}

function parseLookupCursor(
  value: unknown,
  site: AuthenticatedSite,
  scope: string,
): LookupCursor | null | Response {
  if (value === undefined) return null;
  try {
    if (typeof value !== "string" || value.length > 2048) throw new Error();
    const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(value);
    if (!match) throw new Error();
    const [, payload, signature] = match;
    const expected = createHmac("sha256", site.cursorSigningKey).update(payload).digest();
    const supplied = Buffer.from(signature, "base64url");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error();
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (!object(decoded) || decoded.mode !== "ticket-lookup" || decoded.siteId !== site.siteId || decoded.scope !== scope
      || typeof decoded.at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(decoded.at)
      || !UUID_PATTERN.test(String(decoded.id ?? "")) || typeof decoded.issuedAt !== "string"
      || !Number.isFinite(Date.parse(decoded.at)) || !Number.isFinite(Date.parse(decoded.issuedAt))) throw new Error();
    const issuedAt = Date.parse(decoded.issuedAt);
    if (issuedAt < Date.now() - 60 * 60 * 1000 || issuedAt > Date.now() + 60_000) throw new Error();
    return { at: decoded.at, id: String(decoded.id) };
  } catch {
    return apiFailure(422, "invalid_cursor", "The cursor is invalid for this Ticket lookup.");
  }
}

function lookupCursorFor(site: AuthenticatedSite, scope: string, row: LookupOrder): string {
  const payload = Buffer.from(JSON.stringify({
    mode: "ticket-lookup",
    siteId: site.siteId,
    scope,
    issuedAt: new Date().toISOString(),
    at: row.created_cursor_time,
    id: row.order_id,
  }), "utf8").toString("base64url");
  const signature = createHmac("sha256", site.cursorSigningKey).update(payload).digest("base64url");
  return payload + "." + signature;
}

async function readAdmissionTarget(
  client: PoolClient,
  siteId: string,
  field: "qr_token_hash" | "ticket_id",
  value: string,
): Promise<AdmissionTarget | null> {
  const condition = field === "qr_token_hash" ? "ticket.qr_token_hash = $2" : "ticket.id = $2";
  const result = await client.query<AdmissionTarget>(
    [
      "select ticket.id as ticket_id, ticket.event_id as ticket_event_id, ticket.order_id, ticket.site_id,",
      "       order_row.refund_status, event_row.is_canceled, event_row.starts_at, event_row.ends_at,",
      "       event_row.check_in_opens_at",
      "from hpos.tickets ticket",
      "join hpos.orders order_row on order_row.id = ticket.order_id and order_row.site_id = ticket.site_id and order_row.event_id = ticket.event_id",
      "join hpos.events event_row on event_row.id = ticket.event_id and event_row.site_id = ticket.site_id",
      "where ticket.site_id = $1 and " + condition,
      "for share of event_row for update of order_row, ticket",
    ].join(" "),
    [siteId, value],
  );
  return result.rows[0] ?? null;
}

async function recordAdmission(
  client: PoolClient,
  siteId: string,
  eventId: string,
  actor: Actor,
  qrToken: string | null,
  ticketId: string | null,
): Promise<IdempotentResult> {
  const target = await readAdmissionTarget(
    client,
    siteId,
    qrToken === null ? "ticket_id" : "qr_token_hash",
    qrToken === null ? ticketId as string : createHash("sha256").update(qrToken, "utf8").digest("hex"),
  );
  if (!target) operationError(404, "not_found", "The Ticket is not available to this Site.");
  if (target.ticket_event_id !== eventId) {
    operationError(409, "ticket_event_mismatch", "The Ticket belongs to a different Event on this Site.");
  }

  const previous = await client.query<AdmissionRow>(
    "select id, admitted_at from hpos.admissions where site_id = $1 and ticket_id = $2",
    [siteId, target.ticket_id],
  );
  const nowResult = await client.query<{ now: Date }>("select clock_timestamp() as now");
  const blockers = admissionBlockers({
    is_canceled: target.is_canceled,
    refund_status: target.refund_status,
    admission_id: previous.rows[0]?.id ?? null,
    check_in_opens_at: target.check_in_opens_at,
    starts_at: target.starts_at,
    ends_at: target.ends_at,
  }, nowResult.rows[0].now);
  if (blockers.length > 0) {
    const code = blockers[0];
    const messages: Record<string, string> = {
      event_canceled: "The Event has been canceled and cannot admit Tickets.",
      ticket_refunded: "This Ticket was fully refunded and cannot be admitted.",
      already_admitted: "This Ticket already has its one Admission.",
      check_in_not_open: "Check-in has not opened for this Event.",
      check_in_closed: "Check-in has closed for this Event.",
    };
    operationError(409, code, messages[code] ?? "This Ticket is not eligible for Admission.");
  }

  const created = await client.query<AdmissionRow>(
    [
      "insert into hpos.admissions",
      "  (id, site_id, event_id, ticket_id, actor_type, actor_reference, admitted_at)",
      "values ($1, $2, $3, $4, $5, $6, clock_timestamp())",
      "returning id, admitted_at",
    ].join(" "),
    [randomUUID(), siteId, eventId, target.ticket_id, actor.type, actor.reference],
  );
  const admission = created.rows[0];
  await client.query(
    "update hpos.tickets set version = version + 1, updated_at = clock_timestamp() where site_id = $1 and id = $2",
    [siteId, target.ticket_id],
  );
  await client.query(
    "update hpos.orders set version = version + 1, updated_at = clock_timestamp() where site_id = $1 and id = $2",
    [siteId, target.order_id],
  );
  await enqueueWalletUpdateJobs(client, siteId, [target.ticket_id]);
  return {
    status: 201,
    data: {
      admission_id: admission.id,
      ticket_id: target.ticket_id,
      event_id: eventId,
      admitted_at: admission.admitted_at.toISOString(),
    },
  };
}

async function lookupTickets(siteId: string, eventId: string, orderIds: string[]): Promise<Map<string, Record<string, unknown>[]>> {
  const result = await getBusinessPool().query<LookupTicket>(
    [
      "select ticket.id as ticket_id, ticket.event_id, ticket.order_id, order_row.order_reference,",
      "       ticket.ordinal, ticket.issued_at, ticket.attendee_name, ticket.version,",
      "       order_row.refund_status, event_row.is_canceled, event_row.starts_at, event_row.ends_at,",
      "       event_row.check_in_opens_at, admission.id as admission_id, admission.admitted_at,",
      "       clock_timestamp() as checked_at",
      "from hpos.tickets ticket",
      "join hpos.orders order_row on order_row.id = ticket.order_id and order_row.site_id = ticket.site_id and order_row.event_id = ticket.event_id",
      "join hpos.events event_row on event_row.id = ticket.event_id and event_row.site_id = ticket.site_id",
      "left join hpos.admissions admission on admission.site_id = ticket.site_id and admission.ticket_id = ticket.id",
      "where ticket.site_id = $1 and ticket.event_id = $2 and ticket.order_id = any($3::uuid[])",
      "order by order_row.created_at desc, order_row.id asc, ticket.ordinal asc",
    ].join(" "),
    [siteId, eventId, orderIds],
  );
  const byOrder = new Map<string, Record<string, unknown>[]>();
  for (const row of result.rows) {
    const blockers = admissionBlockers(row, row.checked_at);
    const tickets = byOrder.get(row.order_id) ?? [];
    tickets.push({
      ticket_id: row.ticket_id,
      event_id: row.event_id,
      order_id: row.order_id,
      order_reference: row.order_reference,
      ordinal: row.ordinal,
      issued_at: row.issued_at.toISOString(),
      attendee_name: row.attendee_name,
      admission_status: row.admission_id === null ? "unused" : "admitted",
      admitted_at: row.admitted_at?.toISOString() ?? null,
      can_admit: blockers.length === 0,
      admission_blockers: blockers,
      version: row.version,
    });
    byOrder.set(row.order_id, tickets);
  }
  return byOrder;
}

async function handleTicketLookup(
  request: Request,
  site: AuthenticatedSite,
  eventId: string,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  if (!validKeys(body, ["order_reference", "email", "limit", "cursor"])) {
    const unknown = Object.keys(body).find((key) => !["order_reference", "email", "limit", "cursor"].includes(key)) ?? "unknown";
    return fieldError(unknown, "unknown_field", "Remove the unsupported lookup field.");
  }
  const hasReference = Object.hasOwn(body, "order_reference");
  const hasEmail = Object.hasOwn(body, "email");
  if (hasReference === hasEmail) return fieldError("order_reference", "one_required", "Provide exactly one of order_reference or email.");

  let searchKind: "order_reference" | "email";
  let searchValue: string;
  if (hasReference) {
    if (typeof body.order_reference !== "string") return fieldError("order_reference", "invalid_text", "Provide an Order reference.");
    searchValue = body.order_reference.trim().toUpperCase();
    if (!/^[A-Z0-9-]{8,24}$/.test(searchValue)) return fieldError("order_reference", "invalid_format", "Provide a valid Order reference.");
    searchKind = "order_reference";
  } else {
    if (typeof body.email !== "string") return fieldError("email", "invalid_email", "Provide a valid current delivery email.");
    searchValue = body.email.trim().toLowerCase();
    if (searchValue.length > 254 || !EMAIL_PATTERN.test(searchValue)) return fieldError("email", "invalid_email", "Provide a valid current delivery email.");
    searchKind = "email";
  }

  let limit = 50;
  if (Object.hasOwn(body, "limit")) {
    if (!Number.isSafeInteger(body.limit) || Number(body.limit) < 1 || Number(body.limit) > 100) {
      return fieldError("limit", "out_of_range", "limit must be an integer from 1 to 100.");
    }
    limit = Number(body.limit);
  }
  const scope = cursorScope(eventId, limit, searchKind, searchValue);
  const cursor = parseLookupCursor(body.cursor, site, scope);
  if (cursor instanceof Response) return cursor;

  const event = await getBusinessPool().query(
    "select 1 from hpos.events where site_id = $1 and id = $2",
    [site.siteId, eventId],
  );
  if (event.rowCount === 0) return apiFailure(404, "not_found", "The Event is not available to this Site.");

  const values: unknown[] = [site.siteId, eventId, searchValue];
  const where = [
    "order_row.site_id = $1",
    "order_row.event_id = $2",
    searchKind === "order_reference"
      ? "upper(order_row.order_reference) = $3"
      : "lower(btrim(order_row.delivery_email)) = $3",
  ];
  if (cursor) {
    values.push(cursor.at, cursor.id);
    where.push("(order_row.created_at < $4::timestamptz or (order_row.created_at = $4::timestamptz and order_row.id > $5::uuid))");
  }
  values.push(limit + 1);
  const ordersResult = await getBusinessPool().query<LookupOrder>(
    [
      "select order_row.id as order_id, order_row.order_reference, order_row.buyer_name,",
      "       order_row.delivery_email, order_row.checkout_status, order_row.payment_status,",
      "       order_row.issuance_status, order_row.delivery_status,",
      "       to_char(order_row.created_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as created_cursor_time",
      "from hpos.orders order_row",
      "where " + where.join(" and "),
      "order by order_row.created_at desc, order_row.id asc",
      "limit $" + values.length,
    ].join(" "),
    values,
  );
  const hasMore = ordersResult.rows.length > limit;
  const rows = ordersResult.rows.slice(0, limit);
  const ticketsByOrder = await lookupTickets(site.siteId, eventId, rows.map((row) => row.order_id));
  const orders = rows.map((row) => ({
    order_id: row.order_id,
    order_reference: row.order_reference,
    buyer_name: row.buyer_name,
    delivery_email: row.delivery_email,
    checkout_status: row.checkout_status,
    payment_status: row.payment_status,
    issuance_status: row.issuance_status,
    delivery_status: row.delivery_status,
    tickets: ticketsByOrder.get(row.order_id) ?? [],
  }));
  const last = rows.at(-1);
  const nextCursor = hasMore && last ? lookupCursorFor(site, scope, last) : null;
  return apiSuccess(orders, 200, { nextCursor });
}

export async function handleAdmissionPost(
  request: Request,
  site: AuthenticatedSite,
  path: string[],
): Promise<Response | null> {
  if (path.length !== 4 || path[0] !== "admin" || path[1] !== "events"
    || (path[3] !== "admissions" && path[3] !== "ticket-lookup")) return null;
  const eventId = path[2];
  if (!UUID_PATTERN.test(eventId)) return apiFailure(404, "not_found", "The Event is not available to this Site.");
  if (path[3] === "ticket-lookup") return handleTicketLookup(request, site, eventId);

  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  if (!validKeys(body, ["actor", "qr_token", "ticket_id"])) {
    const unknown = Object.keys(body).find((key) => !["actor", "qr_token", "ticket_id"].includes(key)) ?? "unknown";
    return fieldError(unknown, "unknown_field", "Remove the unsupported Admission field.");
  }
  const actor = actorFrom(body.actor);
  if (!actor) return fieldError("actor", "invalid_actor", "Include a user or system actor with a non-secret Site-local reference.");
  const hasQrToken = Object.hasOwn(body, "qr_token");
  const hasTicketId = Object.hasOwn(body, "ticket_id");
  if (hasQrToken === hasTicketId) return fieldError("qr_token", "one_required", "Provide exactly one of qr_token or ticket_id.");
  if (hasQrToken && (typeof body.qr_token !== "string" || !TOKEN_PATTERN.test(body.qr_token))) {
    return fieldError("qr_token", "invalid_token", "Provide the scanned admission QR token unchanged.");
  }
  if (hasTicketId && (typeof body.ticket_id !== "string" || !UUID_PATTERN.test(body.ticket_id))) {
    return fieldError("ticket_id", "invalid_uuid", "Provide a Ticket ID selected from this Event's manual lookup results.");
  }
  const qrToken = hasQrToken ? body.qr_token as string : null;
  const ticketId = hasTicketId ? body.ticket_id as string : null;
  return withApiIdempotency(
    request,
    site,
    body,
    (client) => recordAdmission(client, site.siteId, eventId, actor, qrToken, ticketId),
    mapAdmissionDatabaseError,
  );
}
