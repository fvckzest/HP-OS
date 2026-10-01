import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { apiFailure, apiSuccess } from "./api-response";
import { ApiOperationError, withApiIdempotency } from "./api-idempotency";
import type { IdempotentResult } from "./api-idempotency";
import { getBusinessPool } from "./database";
import type { AuthenticatedSite } from "./site-auth";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_BODY_BYTES = 64 * 1024;

type PaymentOutcome = "not_started" | "processing" | "paid" | "failed" | "canceled" | "unknown";
type ClosureOutcome = "not_started" | "failed" | "canceled";
type Actor = { type: "user" | "system"; reference: string };

interface ConnectionRow extends QueryResultRow {
  id: string;
  organization_id: string;
  provider: "square" | "stripe";
  environment: "test" | "live";
  account_reference: string;
  location_reference: string | null;
  account_eligibility_status: "pending_validation" | "eligible" | "ineligible";
  platform_fee_eligibility_status: "pending_validation" | "eligible" | "ineligible";
  eligibility_validated_at: Date | null;
  eligibility_evidence_reference: string | null;
}

export interface AttemptRow extends QueryResultRow {
  id: string;
  site_id: string;
  order_id: string;
  connection_id: string;
  provider: "square" | "stripe";
  environment: "test" | "live";
  account_reference: string;
  location_reference: string | null;
  currency: string;
  account_eligibility_status: "eligible";
  platform_fee_eligibility_status: "eligible" | "ineligible";
  total_amount: string;
  platform_fee_amount: string;
  provider_mapping: Record<string, unknown> | null;
  provider_checkout_reference: string | null;
  provider_payment_reference: string | null;
  last_outcome: PaymentOutcome | null;
  provider_can_take_payment: boolean | null;
  status: "creating" | "open" | "closed" | "requires_verification";
  version: number;
  created_at: Date;
  updated_at: Date;
  checkout_status: "active" | "awaiting_payment_result" | "expired" | "ended";
  checkout_expires_at: Date;
  payment_status: "unpaid" | "processing" | "paid" | "failed" | "unknown" | "conflicted";
  reservation_status: "held" | "consumed" | "released";
}

interface PaymentAttemptListRow extends AttemptRow {
  event_id: string;
  checkout_expired: boolean;
  requires_verification: boolean;
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function reject(status: number, code: string, message: string, details: Array<{ field: string; code: string; message: string }> = []): never {
  throw new ApiOperationError(status, code, message, details);
}

function fieldError(field: string, code: string, message: string): Response {
  return apiFailure(422, "validation_failed", message, { details: [{ field, code, message }] });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | Response> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return apiFailure(415, "unsupported_media_type", "Send payment-attempt fields as application/json.");
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

function parseActor(value: unknown): Actor | Response {
  if (!object(value) || !hasOnlyKeys(value, ["type", "reference"])
    || (value.type !== "user" && value.type !== "system")
    || typeof value.reference !== "string" || !value.reference.trim() || value.reference.trim().length > 200) {
    return fieldError("actor", "invalid_actor", "Provide an actor type and a non-secret Site-local reference.");
  }
  return { type: value.type, reference: value.reference.trim() };
}

function money(amount: string | number, currency: string) {
  return { amount: Number(amount), currency };
}

export function paymentAttemptData(row: AttemptRow) {
  return {
    attempt_id: row.id,
    order_id: row.order_id,
    connection: {
      connection_id: row.connection_id,
      provider: row.provider,
      environment: row.environment,
      account_reference: row.account_reference,
      location_reference: row.location_reference,
      account_eligibility_status: row.account_eligibility_status,
      platform_fee_eligibility_status: row.platform_fee_eligibility_status,
    },
    total: money(row.total_amount, row.currency),
    platform_fee: money(row.platform_fee_amount, row.currency),
    provider_mapping: row.provider_mapping,
    provider_checkout_reference: row.provider_checkout_reference,
    provider_payment_reference: row.provider_payment_reference,
    last_outcome: row.last_outcome,
    provider_can_take_payment: row.provider_can_take_payment,
    status: row.status,
    version: row.version,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function paymentAttemptListData(row: PaymentAttemptListRow) {
  return {
    ...paymentAttemptData(row),
    event_id: row.event_id,
    checkout_status: row.checkout_status,
    checkout_expires_at: row.checkout_expires_at.toISOString(),
    payment_status: row.payment_status,
    reservation_status: row.reservation_status,
    requires_verification: row.requires_verification,
  };
}

function listLimit(value: string | null): number | Response {
  if (value === null) return 50;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) {
    return fieldError("limit", "out_of_range", "limit must be an integer from 1 to 100.");
  }
  return Number(value);
}

function listCursor(site: AuthenticatedSite, filters: object, limit: number, row: { created_at: Date; id: string }): string {
  const payload = Buffer.from(JSON.stringify({
    route: "admin-payment-attempts",
    siteId: site.siteId,
    filters,
    limit,
    issuedAt: new Date().toISOString(),
    createdAt: row.created_at.toISOString(),
    id: row.id,
  }), "utf8").toString("base64url");
  const signature = createHmac("sha256", site.cursorSigningKey).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function parseListCursor(value: string | null, site: AuthenticatedSite, filters: object, limit: number): { createdAt: string; id: string } | Response | null {
  if (value === null) return null;
  try {
    const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(value);
    if (!match || value.length > 2048) throw new Error();
    const expected = createHmac("sha256", site.cursorSigningKey).update(match[1]).digest();
    const supplied = Buffer.from(match[2], "base64url");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error();
    const decoded = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")) as Record<string, unknown>;
    if (decoded.route !== "admin-payment-attempts" || decoded.siteId !== site.siteId
      || decoded.limit !== limit || JSON.stringify(decoded.filters) !== JSON.stringify(filters)
      || typeof decoded.issuedAt !== "string" || typeof decoded.createdAt !== "string"
      || typeof decoded.id !== "string" || !UUID_PATTERN.test(decoded.id)
      || !Number.isFinite(Date.parse(decoded.issuedAt)) || !Number.isFinite(Date.parse(decoded.createdAt))) throw new Error();
    const issuedAt = Date.parse(decoded.issuedAt);
    if (issuedAt < Date.now() - 60 * 60 * 1000 || issuedAt > Date.now() + 60_000) throw new Error();
    return { createdAt: decoded.createdAt, id: decoded.id };
  } catch {
    return apiFailure(422, "invalid_cursor", "The payment-attempt cursor does not match this Site, endpoint, filter, or page size.");
  }
}

async function listPaymentAttempts(request: Request, site: AuthenticatedSite): Promise<Response> {
  const url = new URL(request.url);
  const allowed = new Set(["limit", "cursor", "requires_verification", "event_id"]);
  for (const name of url.searchParams.keys()) {
    if (!allowed.has(name)) return fieldError(name, "unknown_filter", "Remove the unsupported payment-attempt list parameter.");
  }
  const limit = listLimit(url.searchParams.get("limit"));
  if (limit instanceof Response) return limit;
  const requiresText = url.searchParams.get("requires_verification");
  if (requiresText !== null && requiresText !== "true" && requiresText !== "false") {
    return fieldError("requires_verification", "invalid_boolean", "requires_verification must be true or false.");
  }
  const eventId = url.searchParams.get("event_id");
  if (eventId !== null && !UUID_PATTERN.test(eventId)) return fieldError("event_id", "invalid_uuid", "event_id must be a UUID.");
  const filters = { requires_verification: requiresText, event_id: eventId };
  const cursor = parseListCursor(url.searchParams.get("cursor"), site, filters, limit);
  if (cursor instanceof Response) return cursor;
  const requiresVerification = `(
    attempt.status = 'requires_verification'
    or (
      order_row.checkout_expires_at <= clock_timestamp()
      and attempt.status in ('creating', 'open')
      and attempt.provider_can_take_payment is distinct from false
    )
  )`;
  const result = await getBusinessPool().query<PaymentAttemptListRow>(
    `select attempt.*, order_row.event_id,
            order_row.checkout_status, order_row.checkout_expires_at,
            order_row.payment_status, reservation.status as reservation_status,
            ${requiresVerification} as requires_verification,
            order_row.checkout_expires_at <= clock_timestamp() as checkout_expired
     from hpos.payment_attempts attempt
     join hpos.orders order_row on order_row.id = attempt.order_id and order_row.site_id = attempt.site_id
     join hpos.reservations reservation on reservation.order_id = order_row.id and reservation.site_id = order_row.site_id
     where attempt.site_id = $1
       and ($2::boolean is null or ${requiresVerification} = $2)
       and ($3::uuid is null or order_row.event_id = $3)
       and ($4::timestamptz is null or (attempt.created_at, attempt.id) < ($4::timestamptz, $5::uuid))
     order by attempt.created_at desc, attempt.id desc
     limit $6`,
    [site.siteId, requiresText === null ? null : requiresText === "true", eventId,
      cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
  );
  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1);
  const nextCursor = result.rows.length > limit && last ? listCursor(site, filters, limit, last) : null;
  return apiSuccess(rows.map(paymentAttemptListData), 200, { nextCursor });
}

function mapPaymentAttemptDatabaseError(error: unknown): Response | null {
  if (!object(error)) return null;
  if (error.code === "23505") {
    if (error.constraint === "payment_attempts_provider_checkout_reference_idx") {
      return apiFailure(409, "provider_reference_conflict", "This provider checkout reference is already attached to another payment attempt.");
    }
    if (error.constraint === "payment_attempt_closure_reports_source_key") {
      return apiFailure(409, "payment_report_conflict", "This provider closure reference is already attached to another report.");
    }
    return apiFailure(409, "payment_attempt_in_progress", "This Order already has a payment-capable or unresolved attempt.");
  }
  if (error.code === "23503") return apiFailure(404, "not_found", "The Order or payment attempt is not available to this Site.");
  if (error.code === "23514") return apiFailure(422, "validation_failed", "The payment-attempt request violates a configured field constraint.");
  return null;
}

function isCheckoutReferenceUniqueViolation(error: unknown): boolean {
  return object(error) && error.code === "23505"
    && error.constraint === "payment_attempts_provider_checkout_reference_idx";
}

function rejectCheckoutReferenceConflict(sameSite: boolean): never {
  if (!sameSite) reject(404, "not_found", "The provider checkout reference is not available to this Site.");
  reject(409, "provider_reference_conflict", "This provider checkout reference is already attached to another payment attempt.");
}

async function createAttempt(client: PoolClient, site: AuthenticatedSite, orderId: string): Promise<IdempotentResult> {
  const orderResult = await client.query<{
    id: string;
    payment_connection_id: string | null;
    accepted_quote: Record<string, unknown>;
    checkout_status: AttemptRow["checkout_status"];
    checkout_expired: boolean;
    payment_status: AttemptRow["payment_status"];
  }>(
    `select id, payment_connection_id, accepted_quote, checkout_status,
            checkout_expires_at <= clock_timestamp() as checkout_expired, payment_status
     from hpos.orders
     where id = $1 and site_id = $2
     for update`,
    [orderId, site.siteId],
  );
  const order = orderResult.rows[0];
  if (!order) reject(404, "not_found", "The Order is not available to this Site.");
  if (order.payment_status === "paid") reject(409, "order_already_paid", "A paid Order cannot start another payment attempt.");
  if (order.checkout_status === "expired" || order.checkout_expired) {
    reject(409, "checkout_expired", "This checkout expired. Start a new checkout if capacity remains.");
  }
  if (order.checkout_status === "ended") reject(409, "checkout_ended", "This checkout has ended and cannot start another payment attempt.");
  if (order.checkout_status === "awaiting_payment_result") {
    reject(409, "payment_attempt_in_progress", "An existing provider checkout must be verified or closed before another attempt can start.");
  }
  if (!order.payment_connection_id) {
    reject(503, "payment_configuration_unavailable", "The Order has no verified payment connection.");
  }

  const reservationResult = await client.query<{ id: string; status: AttemptRow["reservation_status"] }>(
    `select id, status from hpos.reservations where order_id = $1 and site_id = $2 for update`,
    [order.id, site.siteId],
  );
  const reservation = reservationResult.rows[0];
  if (!reservation || reservation.status !== "held") reject(409, "checkout_ended", "The Order no longer holds Ticket capacity.");

  const connectionResult = await client.query<ConnectionRow>(
    `select connection.id, connection.organization_id, connection.provider, connection.environment,
            connection.account_reference, connection.location_reference,
            connection.account_eligibility_status, connection.platform_fee_eligibility_status,
            connection.eligibility_validated_at, connection.eligibility_evidence_reference
     from hpos.payment_connections connection
     join hpos.sites site on site.organization_id = connection.organization_id
     where site.id = $1 and connection.id = $2
       and exists (
         select 1 from hpos.site_payment_connection_assignments assignment
         where assignment.site_id = site.id
           and assignment.connection_id = connection.id
       )
     for update of connection`,
    [site.siteId, order.payment_connection_id],
  );
  const connection = connectionResult.rows[0];
  if (!connection
    || connection.account_eligibility_status !== "eligible"
    || (connection.platform_fee_eligibility_status !== "eligible"
      && !(connection.provider === "square" && connection.environment === "test"
        && connection.platform_fee_eligibility_status === "ineligible"))
    || (connection.provider === "square" && !connection.location_reference)) {
    reject(503, "payment_configuration_unavailable", "The Order's provider connection is missing or no longer eligible for checkout.");
  }

  const total = object(order.accepted_quote.total) ? order.accepted_quote.total : null;
  const platformFee = object(order.accepted_quote.platform_fee) ? order.accepted_quote.platform_fee : null;
  if (!total || !platformFee || total.currency !== platformFee.currency
    || !Number.isSafeInteger(total.amount) || Number(total.amount) < 1
    || !Number.isSafeInteger(platformFee.amount) || Number(platformFee.amount) < 0) {
    reject(503, "payment_configuration_unavailable", "The Order does not contain a valid frozen total and platform fee.");
  }

  const attemptId = randomUUID();
  const inserted = await client.query<AttemptRow>(
    `insert into hpos.payment_attempts (
       id, site_id, order_id, connection_id, provider, environment, account_reference,
       location_reference, account_eligibility_status, platform_fee_eligibility_status,
       currency, total_amount, platform_fee_amount, provider_mapping,
       status, provider_can_take_payment
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, null, 'creating', null)
     returning *`,
    [attemptId, site.siteId, order.id, connection.id, connection.provider, connection.environment,
      connection.account_reference, connection.location_reference, connection.account_eligibility_status,
      connection.platform_fee_eligibility_status, total.currency, total.amount, platformFee.amount],
  );
  const held = await client.query(
    `update hpos.reservations
     set awaiting_provider_verification = true, updated_at = clock_timestamp()
     where id = $1 and site_id = $2 and status = 'held'
     returning id`,
    [reservation.id, site.siteId],
  );
  if (held.rowCount !== 1) reject(409, "checkout_ended", "The Order no longer holds Ticket capacity.");

  const updatedOrder = await client.query(
    `update hpos.orders
     set checkout_status = 'awaiting_payment_result', version = version + 1, updated_at = clock_timestamp()
     where id = $1 and site_id = $2 and checkout_status = 'active'
     returning id`,
    [order.id, site.siteId],
  );
  if (updatedOrder.rowCount !== 1) reject(409, "payment_attempt_in_progress", "The Order changed while the payment attempt was being created.");

  return { status: 201, data: paymentAttemptData(inserted.rows[0]) };
}

async function lockAttempt(client: PoolClient, siteId: string, attemptId: string): Promise<AttemptRow> {
  const result = await client.query<AttemptRow>(
    `select attempt.*, order_row.checkout_status, order_row.checkout_expires_at,
            order_row.payment_status, reservation.status as reservation_status
     from hpos.payment_attempts attempt
     join hpos.orders order_row on order_row.id = attempt.order_id and order_row.site_id = attempt.site_id
     join hpos.reservations reservation on reservation.order_id = order_row.id and reservation.site_id = order_row.site_id
     where attempt.id = $1 and attempt.site_id = $2
     for update of attempt, order_row, reservation`,
    [attemptId, siteId],
  );
  const row = result.rows[0];
  if (!row) reject(404, "not_found", "The payment attempt is not available to this Site.");
  return row;
}

function validateAttemptConnection(attempt: AttemptRow, connectionId: unknown): void {
  if (typeof connectionId !== "string" || !UUID_PATTERN.test(connectionId)) {
    reject(422, "validation_failed", "connection_id must identify the connection frozen on this Order.", [
      { field: "connection_id", code: "invalid_uuid", message: "Provide the Order's recorded connection ID." },
    ]);
  }
  if (attempt.connection_id !== connectionId) reject(409, "payment_connection_conflict", "The payment attempt must use the connection frozen on its Order.");
}

async function registerCheckoutReference(
  client: PoolClient,
  site: AuthenticatedSite,
  attemptId: string,
  body: Record<string, unknown>,
): Promise<IdempotentResult> {
  if (!hasOnlyKeys(body, ["actor", "connection_id", "provider_checkout_reference", "provider_can_take_payment"])) {
    reject(422, "validation_failed", "A checkout-reference report contains an unsupported field.");
  }
  const actor = parseActor(body.actor);
  if (actor instanceof Response) {
    const payload = await actor.json() as { error?: { details?: Array<{ field: string; code: string; message: string }> } };
    reject(422, "validation_failed", "Provide a valid actor reference.", payload.error?.details ?? []);
  }
  const attempt = await lockAttempt(client, site.siteId, attemptId);
  validateAttemptConnection(attempt, body.connection_id);
  if (attempt.checkout_status === "ended") {
    reject(409, "checkout_ended", "This checkout ended before its provider reference could be registered.");
  }
  if (attempt.checkout_status === "expired") {
    reject(409, "checkout_expired", "This checkout expired before its provider reference could be registered.");
  }
  if (attempt.checkout_status !== "awaiting_payment_result") {
    reject(409, "invalid_state", "The Order is not awaiting provider checkout setup.");
  }
  const checkoutDeadline = await client.query<{ expired: boolean }>(
    `select checkout_expires_at <= clock_timestamp() as expired
     from hpos.orders where id = $1 and site_id = $2`,
    [attempt.order_id, site.siteId],
  );
  if (checkoutDeadline.rows[0]?.expired) {
    reject(409, "checkout_expired", "This checkout expired before its provider reference could be registered.");
  }
  if (typeof body.provider_checkout_reference !== "string"
    || !body.provider_checkout_reference.trim() || body.provider_checkout_reference.trim().length > 500) {
    reject(422, "validation_failed", "Provide the provider checkout reference returned by the Site-owned provider call.", [
      { field: "provider_checkout_reference", code: "invalid_reference", message: "Use a non-empty provider reference of at most 500 characters." },
    ]);
  }
  if (body.provider_can_take_payment !== true) {
    reject(422, "validation_failed", "A checkout reference is recorded only when the provider checkout can take payment.", [
      { field: "provider_can_take_payment", code: "must_be_true", message: "Confirm the checkout can take payment before registering its reference." },
    ]);
  }
  const checkoutReference = body.provider_checkout_reference.trim();
  const existingReference = await client.query<{ same_site: boolean; same_attempt: boolean }>(
    `select attempt.site_id = $3::uuid as same_site,
            attempt.id = $4::uuid as same_attempt
     from hpos.payment_attempts attempt
     where attempt.connection_id = $1 and attempt.provider_checkout_reference = $2
     limit 1`,
    [attempt.connection_id, checkoutReference, site.siteId, attemptId],
  );
  const existingOwner = existingReference.rows[0];
  if (existingOwner && !existingOwner.same_attempt) rejectCheckoutReferenceConflict(existingOwner.same_site);
  if (attempt.provider_checkout_reference && attempt.provider_checkout_reference !== checkoutReference) {
    reject(409, "provider_reference_conflict", "The payment attempt already has a different provider checkout reference.");
  }
  if (attempt.status === "closed") reject(409, "invalid_state", "A closed payment attempt cannot be reopened.");
  if (attempt.payment_status === "paid" || attempt.payment_status === "processing") {
    reject(409, "payment_attempt_in_progress", "The payment result must be verified before changing checkout references.");
  }

  await client.query("savepoint checkout_reference_registration");
  try {
    const updated = await client.query<AttemptRow>(
      `update hpos.payment_attempts
       set provider_checkout_reference = $3, provider_can_take_payment = true,
           status = 'open', version = version + 1, updated_at = clock_timestamp()
       where id = $1 and site_id = $2
       returning *`,
      [attemptId, site.siteId, checkoutReference],
    );
    await client.query("release savepoint checkout_reference_registration");
    return { status: 200, data: paymentAttemptData(updated.rows[0]) };
  } catch (error) {
    await client.query("rollback to savepoint checkout_reference_registration");
    if (isCheckoutReferenceUniqueViolation(error)) {
      await client.query("release savepoint checkout_reference_registration");
      const concurrentOwner = await client.query<{ same_site: boolean }>(
        `select site_id = $3::uuid as same_site
         from hpos.payment_attempts
         where connection_id = $1 and provider_checkout_reference = $2
         limit 1`,
        [attempt.connection_id, checkoutReference, site.siteId],
      );
      const sameSite = concurrentOwner.rows[0]?.same_site;
      if (sameSite !== undefined) rejectCheckoutReferenceConflict(sameSite);
    }
    throw error;
  }
}

async function releaseReservation(client: PoolClient, attempt: AttemptRow): Promise<void> {
  if (attempt.reservation_status !== "held") return;
  const released = await client.query<{ offering_id: string; quantity: number }>(
    `update hpos.reservations
     set status = 'released', awaiting_provider_verification = false, updated_at = clock_timestamp()
     where order_id = $1 and site_id = $2 and status = 'held'
     returning offering_id, quantity`,
    [attempt.order_id, attempt.site_id],
  );
  const reservation = released.rows[0];
  if (!reservation) return;
  const capacity = await client.query(
    `update hpos.ticket_offerings
     set reserved_quantity = reserved_quantity - $3
     where id = $1 and site_id = $2 and reserved_quantity >= $3
     returning id`,
    [reservation.offering_id, attempt.site_id, reservation.quantity],
  );
  if (capacity.rowCount !== 1) reject(503, "service_unavailable", "The closed checkout could not release its Reservation safely.");
}

async function closeAttempt(
  client: PoolClient,
  siteId: string,
  attempt: AttemptRow,
  outcome: ClosureOutcome,
  releaseCapacity: boolean,
  nextCheckoutStatus: "active" | "expired" | "ended",
): Promise<AttemptRow> {
  if (attempt.payment_status === "paid" || attempt.payment_status === "processing"
    || attempt.payment_status === "unknown" || attempt.payment_status === "conflicted") {
    reject(409, "payment_outcome_unresolved", "Provider closure cannot override a paid, processing, or uncertain payment outcome.");
  }
  if (attempt.last_outcome === "paid" || attempt.last_outcome === "processing" || attempt.last_outcome === "unknown") {
    reject(409, "payment_outcome_unresolved", "Provider closure cannot override a paid, processing, or uncertain payment outcome.");
  }
  if (attempt.status === "closed") return attempt;

  const closed = await client.query<AttemptRow>(
    `update hpos.payment_attempts
     set status = 'closed', provider_can_take_payment = false, last_outcome = $3,
         version = version + 1, updated_at = clock_timestamp()
     where id = $1 and site_id = $2
     returning *`,
    [attempt.id, siteId, outcome],
  );
  if (releaseCapacity) await releaseReservation(client, attempt);
  await client.query(
    `update hpos.orders
     set checkout_status = $3,
         payment_status = case when $4 in ('failed', 'canceled') then 'failed' else payment_status end,
         version = version + 1, updated_at = clock_timestamp()
     where id = $1 and site_id = $2 and payment_status in ('unpaid', 'failed')`,
    [attempt.order_id, siteId, nextCheckoutStatus, outcome],
  );
  await client.query(
    `update hpos.reservations
     set awaiting_provider_verification = false, updated_at = clock_timestamp()
     where order_id = $1 and site_id = $2 and status = 'held'`,
    [attempt.order_id, siteId],
  );
  return closed.rows[0];
}

async function reportSetupFailure(
  client: PoolClient,
  site: AuthenticatedSite,
  attemptId: string,
  body: Record<string, unknown>,
): Promise<IdempotentResult> {
  if (!hasOnlyKeys(body, ["actor", "reason", "provider_checkout_closed", "payment_outcome"])) {
    reject(422, "validation_failed", "A setup-failure report contains an unsupported field.");
  }
  const actor = parseActor(body.actor);
  if (actor instanceof Response) {
    const payload = await actor.json() as { error?: { details?: Array<{ field: string; code: string; message: string }> } };
    reject(422, "validation_failed", "Provide a valid actor reference.", payload.error?.details ?? []);
  }
  if (body.reason !== "provider_unavailable" && body.reason !== "quote_mismatch") {
    reject(422, "validation_failed", "reason must be provider_unavailable or quote_mismatch.", [
      { field: "reason", code: "invalid_reason", message: "Choose provider_unavailable or quote_mismatch." },
    ]);
  }
  if (body.provider_checkout_closed !== true) {
    reject(422, "validation_failed", "The Site must confirm the provider checkout is closed before releasing capacity.", [
      { field: "provider_checkout_closed", code: "must_be_true", message: "Confirm provider closure before reporting setup failure." },
    ]);
  }
  if (body.payment_outcome !== "not_started" && body.payment_outcome !== "failed" && body.payment_outcome !== "canceled") {
    reject(422, "validation_failed", "A setup-failure report requires a verified not_started, failed, or canceled outcome.", [
      { field: "payment_outcome", code: "invalid_outcome", message: "Uncertain or processing payments cannot release capacity." },
    ]);
  }
  const attempt = await lockAttempt(client, site.siteId, attemptId);
  if (attempt.provider_checkout_reference === null && body.payment_outcome !== "not_started") {
    reject(409, "provider_reference_missing", "A payment outcome requires a recorded provider checkout reference.");
  }
  const deadline = await client.query<{ expired: boolean }>(
    `select checkout_expires_at <= clock_timestamp() as expired
     from hpos.orders where id = $1 and site_id = $2`,
    [attempt.order_id, site.siteId],
  );
  const expired = deadline.rows[0]?.expired || attempt.checkout_status === "expired" || attempt.checkout_status === "ended";
  const updated = await closeAttempt(client, site.siteId, attempt, body.payment_outcome, true, expired ? "expired" : "ended");
  return { status: 200, data: paymentAttemptData(updated) };
}

async function reportClosure(
  client: PoolClient,
  site: AuthenticatedSite,
  attemptId: string,
  body: Record<string, unknown>,
): Promise<IdempotentResult> {
  if (!hasOnlyKeys(body, ["actor", "connection_id", "source_reference", "provider_checkout_reference", "observed_at", "provider_checkout_closed", "payment_outcome"])) {
    reject(422, "validation_failed", "A closure report contains an unsupported field.");
  }
  const actor = parseActor(body.actor);
  if (actor instanceof Response) {
    const payload = await actor.json() as { error?: { details?: Array<{ field: string; code: string; message: string }> } };
    reject(422, "validation_failed", "Provide a valid actor reference.", payload.error?.details ?? []);
  }
  if (typeof body.source_reference !== "string" || !body.source_reference.trim() || body.source_reference.trim().length > 500) {
    reject(422, "validation_failed", "source_reference must be a stable non-secret provider observation reference.");
  }
  if (typeof body.provider_checkout_reference !== "string" || !body.provider_checkout_reference.trim() || body.provider_checkout_reference.trim().length > 500) {
    reject(422, "validation_failed", "Provide the provider checkout reference that was verified closed.");
  }
  if (typeof body.observed_at !== "string" || !RFC3339_PATTERN.test(body.observed_at) || !Number.isFinite(Date.parse(body.observed_at))) {
    reject(422, "validation_failed", "observed_at must be an RFC 3339 timestamp with an explicit offset.");
  }
  if (body.provider_checkout_closed !== true) {
    reject(422, "validation_failed", "The provider must confirm checkout closure before this report is accepted.");
  }
  if (body.payment_outcome !== "not_started" && body.payment_outcome !== "failed" && body.payment_outcome !== "canceled") {
    reject(422, "validation_failed", "A closure report requires a verified not_started, failed, or canceled outcome.");
  }

  const attempt = await lockAttempt(client, site.siteId, attemptId);
  validateAttemptConnection(attempt, body.connection_id);
  const checkoutReference = body.provider_checkout_reference.trim();
  if (attempt.provider_checkout_reference && attempt.provider_checkout_reference !== checkoutReference) {
    reject(409, "provider_reference_conflict", "The closure report does not match the provider checkout reference recorded on the attempt.");
  }
  if (!attempt.provider_checkout_reference && attempt.status !== "creating") {
    reject(409, "provider_reference_missing", "The closure report does not match an unresolved setup attempt.");
  }

  const prior = await client.query<{
    attempt_id: string;
    provider_checkout_reference: string;
    payment_outcome: ClosureOutcome;
  }>(
    `select attempt_id, provider_checkout_reference, payment_outcome
     from hpos.payment_attempt_closure_reports
     where site_id = $1 and connection_id = $2 and source_reference = $3
     for update`,
    [site.siteId, attempt.connection_id, body.source_reference.trim()],
  );
  if (prior.rows.length > 0) {
    const report = prior.rows[0];
    if (report.attempt_id !== attempt.id || report.provider_checkout_reference !== checkoutReference
      || report.payment_outcome !== body.payment_outcome) {
      reject(409, "payment_report_conflict", "This provider observation reference was already used for a different closure report.");
    }
    return { status: 200, data: paymentAttemptData(attempt) };
  }

  await client.query(
    `insert into hpos.payment_attempt_closure_reports (
       id, site_id, attempt_id, connection_id, source_reference,
       provider_checkout_reference, observed_at, payment_outcome
     ) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [randomUUID(), site.siteId, attempt.id, attempt.connection_id, body.source_reference.trim(),
      checkoutReference, new Date(body.observed_at), body.payment_outcome],
  );

  const clock = await client.query<{ expired: boolean }>(
    `select $1::timestamptz <= clock_timestamp() as expired`,
    [attempt.checkout_expires_at],
  );
  const expired = clock.rows[0].expired || attempt.checkout_status === "expired" || attempt.checkout_status === "ended";
  if (!attempt.provider_checkout_reference) {
    await client.query(
      `update hpos.payment_attempts
       set provider_checkout_reference = $3, version = version + 1, updated_at = clock_timestamp()
       where id = $1 and site_id = $2`,
      [attempt.id, site.siteId, checkoutReference],
    );
  }
  const updated = await closeAttempt(client, site.siteId, attempt, body.payment_outcome, expired,
    expired ? attempt.checkout_status === "ended" ? "ended" : "expired" : "active");
  if (!attempt.provider_checkout_reference) {
    const reloaded = await client.query<AttemptRow>(
      `select * from hpos.payment_attempts where id = $1 and site_id = $2`,
      [attempt.id, site.siteId],
    );
    return { status: 200, data: paymentAttemptData(reloaded.rows[0]) };
  }
  return { status: 200, data: paymentAttemptData(updated) };
}

export async function handlePaymentAttemptPost(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (request.method !== "POST") return null;

  if (path.length === 4 && path[0] === "admin" && path[1] === "orders" && path[3] === "payment-attempts") {
    const orderId = path[2];
    if (!UUID_PATTERN.test(orderId)) return apiFailure(404, "not_found", "The Order is not available to this Site.");
    const body = await readJsonBody(request);
    if (body instanceof Response) return body;
    if (!hasOnlyKeys(body, ["actor"])) return fieldError("body", "unknown_field", "Payment-attempt creation accepts only actor.");
    const actor = parseActor(body.actor);
    if (actor instanceof Response) return actor;
    return withApiIdempotency(request, site, body,
      (client) => createAttempt(client, site, orderId), mapPaymentAttemptDatabaseError);
  }

  if (path.length !== 4 || path[0] !== "admin" || path[1] !== "payment-attempts" || !UUID_PATTERN.test(path[2])) return null;
  const attemptId = path[2];
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;

  if (path[3] === "checkout-reference") {
    return withApiIdempotency(request, site, body,
      (client) => registerCheckoutReference(client, site, attemptId, body), mapPaymentAttemptDatabaseError);
  }
  if (path[3] === "setup-failure") {
    return withApiIdempotency(request, site, body,
      (client) => reportSetupFailure(client, site, attemptId, body), mapPaymentAttemptDatabaseError);
  }
  if (path[3] === "closure-reports") {
    return withApiIdempotency(request, site, body,
      (client) => reportClosure(client, site, attemptId, body), mapPaymentAttemptDatabaseError);
  }
  return null;
}

export async function handlePaymentAttemptGet(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (request.method !== "GET") return null;
  if (path.length === 2 && path[0] === "admin" && path[1] === "payment-attempts") {
    return listPaymentAttempts(request, site);
  }
  if (path.length !== 3 || path[0] !== "admin" || path[1] !== "payment-attempts"
    || !UUID_PATTERN.test(path[2])) return null;
  const result = await getBusinessPool().query<AttemptRow>(
    `select attempt.*, order_row.checkout_status, order_row.checkout_expires_at,
            order_row.payment_status, reservation.status as reservation_status
     from hpos.payment_attempts attempt
     join hpos.orders order_row on order_row.id = attempt.order_id and order_row.site_id = attempt.site_id
     join hpos.reservations reservation on reservation.order_id = order_row.id and reservation.site_id = order_row.site_id
     where attempt.id = $1 and attempt.site_id = $2`,
    [path[2], site.siteId],
  );
  const attempt = result.rows[0];
  if (!attempt) return apiFailure(404, "not_found", "The payment attempt is not available to this Site.");
  return Response.json({ data: paymentAttemptData(attempt), request_id: randomUUID() }, {
    headers: { "Cache-Control": "no-store" },
  });
}
