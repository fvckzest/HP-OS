import { createHmac, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { apiFailure, apiSuccess } from "./api-response";
import { ApiOperationError } from "./api-idempotency";
import { getBusinessPool } from "./database";
import type { AuthenticatedSite } from "./site-auth";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUS_FILTERS = {
  payment_status: new Set(["unpaid", "processing", "paid", "failed", "unknown", "conflicted"]),
  issuance_status: new Set(["not_started", "pending", "issued", "failed", "blocked"]),
  delivery_status: new Set(["not_sent", "pending", "sent", "delivered", "failed"]),
  refund_status: new Set(["none", "partial", "full"]),
};
const TICKET_ADMISSION_STATUSES = new Set(["unused", "admitted"]);
type Category = "processing" | "platform";

interface CursorValue {
  at: string;
  id: string;
}

interface TicketRow extends QueryResultRow {
  ticket_id: string;
  event_id: string;
  order_id: string;
  order_reference: string;
  ordinal: number;
  issued_at: Date;
  created_at: Date;
  updated_at: Date;
  version: number;
  buyer_id: string;
  buyer_name: string;
  delivery_email: string;
  refund_status: "none" | "partial" | "full";
  event_canceled: boolean;
  starts_at: Date | null;
  ends_at: Date | null;
  check_in_opens_at: Date | null;
  admission_id: string | null;
  admitted_at: Date | null;
  checked_at: Date;
  created_cursor_time: string;
}

interface OrderRow extends QueryResultRow {
  order_id: string;
  event_id: string;
  order_reference: string;
  buyer_name: string;
  delivery_email: string;
  checkout_status: string;
  payment_status: string;
  issuance_status: string;
  delivery_status: string;
  refund_status: string;
  created_at: Date;
  updated_at: Date;
  version: number;
  created_cursor_time: string;
}

interface CurrentFeeRow extends QueryResultRow {
  category: "processing" | "platform";
  direction: "charge" | "return";
  amount: string | number;
  currency: string;
  id: string;
  created_at: Date;
  observed_at: Date;
  attempt_id: string;
  connection_id: string;
  scope_type: "payment" | "refund";
  scope_reference: string;
}

interface ScopeRow extends QueryResultRow {
  attempt_id: string;
  connection_id: string;
  scope_type: "payment" | "refund";
  scope_reference: string;
  payment_currency: string | null;
  refund_currency: string | null;
  conflict_categories: Category[];
}

function scopeKey(scope: Pick<ScopeRow, "attempt_id" | "connection_id" | "scope_type" | "scope_reference">): string {
  return `${scope.attempt_id}|${scope.connection_id}|${scope.scope_type}|${scope.scope_reference}`;
}

function fieldError(field: string, code: string, message: string): Response {
  return apiFailure(422, "validation_failed", message, { details: [{ field, code, message }] });
}

function listLimit(value: string | null): number | Response {
  if (value === null) return 50;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) return fieldError("limit", "out_of_range", "limit must be an integer from 1 to 100.");
  return Number(value);
}

function cursorFor(site: AuthenticatedSite, mode: string, scope: string, at: string, id: string): string {
  const payload = Buffer.from(JSON.stringify({ mode, siteId: site.siteId, scope, issuedAt: new Date().toISOString(), at, id }), "utf8").toString("base64url");
  return `${payload}.${createHmac("sha256", site.cursorSigningKey).update(payload).digest("base64url")}`;
}

function parseCursor(value: string | null, site: AuthenticatedSite, mode: string, scope: string): CursorValue | Response | null {
  if (value === null) return null;
  try {
    const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(value);
    if (!match || value.length > 2048) throw new Error();
    const expected = createHmac("sha256", site.cursorSigningKey).update(match[1]).digest();
    const actual = Buffer.from(match[2], "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    const decoded = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")) as Record<string, unknown>;
    if (decoded.mode !== mode || decoded.siteId !== site.siteId || decoded.scope !== scope
      || typeof decoded.at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(decoded.at)
      || typeof decoded.id !== "string" || !UUID_PATTERN.test(decoded.id)
      || typeof decoded.issuedAt !== "string" || !Number.isFinite(Date.parse(decoded.issuedAt))) throw new Error();
    const issued = Date.parse(decoded.issuedAt);
    if (issued < Date.now() - 60 * 60 * 1000 || issued > Date.now() + 60_000) throw new Error();
    return { at: decoded.at, id: decoded.id };
  } catch {
    return apiFailure(422, "invalid_cursor", "The cursor is invalid for this list.");
  }
}

function safeNumber(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("A totals value is outside the safe integer range.");
  return parsed;
}

function addSafe(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new ApiOperationError(503, "service_unavailable", "A totals amount exceeds the supported safe integer range.");
  return result;
}

function observationComesBefore(
  left: { observed_at: Date; created_at: Date; id: string },
  right: { observed_at: Date; created_at: Date; id: string },
): boolean {
  const observed = left.observed_at.getTime() - right.observed_at.getTime();
  if (observed !== 0) return observed < 0;
  const created = left.created_at.getTime() - right.created_at.getTime();
  if (created !== 0) return created < 0;
  return left.id < right.id;
}

function admissionBlockers(row: Pick<TicketRow, "event_canceled" | "refund_status" | "admission_id" | "check_in_opens_at" | "starts_at" | "ends_at">, now: Date): string[] {
  const blockers: string[] = [];
  const opens = row.check_in_opens_at ?? row.starts_at;
  if (row.event_canceled) blockers.push("event_canceled");
  if (row.refund_status === "full") blockers.push("ticket_refunded");
  if (row.admission_id !== null) blockers.push("already_admitted");
  if (!opens || now < opens) blockers.push("check_in_not_open");
  if (!row.ends_at || now > row.ends_at) blockers.push("check_in_closed");
  return blockers;
}

function ticketData(row: TicketRow) {
  const blockers = admissionBlockers(row, row.checked_at);
  return {
    ticket_id: row.ticket_id,
    event_id: row.event_id,
    order_id: row.order_id,
    order_reference: row.order_reference,
    ordinal: row.ordinal,
    version: row.version,
    issued_at: row.issued_at.toISOString(),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    buyer_id: row.buyer_id,
    buyer_name: row.buyer_name,
    delivery_email: row.delivery_email,
    approved_attendee: null,
    admission_status: row.admission_id === null ? "unused" : "admitted",
    admitted_at: row.admitted_at?.toISOString() ?? null,
    can_admit: blockers.length === 0,
    admission_blockers: blockers,
  };
}

async function eventExists(client: Pool | PoolClient, siteId: string, eventId: string): Promise<boolean> {
  const result = await client.query("select 1 from hpos.events where site_id = $1 and id = $2", [siteId, eventId]);
  return result.rowCount === 1;
}

async function readTicketRows(client: Pool | PoolClient, siteId: string, eventId: string, orderIds?: string[]): Promise<TicketRow[]> {
  const values: unknown[] = [siteId, eventId];
  const orderCondition = orderIds ? "and ticket.order_id = any($3::uuid[])" : "";
  if (orderIds) values.push(orderIds);
  const result = await client.query<TicketRow>(
    `select ticket.id as ticket_id, ticket.event_id, ticket.order_id, order_row.order_reference,
            ticket.ordinal, ticket.issued_at, ticket.created_at, ticket.updated_at, ticket.version,
            order_row.buyer_id, order_row.buyer_name, order_row.delivery_email,
            order_row.refund_status, event_row.is_canceled as event_canceled,
            event_row.starts_at, event_row.ends_at, event_row.check_in_opens_at,
            admission.id as admission_id, admission.admitted_at,
            clock_timestamp() as checked_at,
            to_char(ticket.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_cursor_time
     from hpos.tickets ticket
     join hpos.orders order_row on order_row.id = ticket.order_id and order_row.site_id = ticket.site_id
     join hpos.events event_row on event_row.id = ticket.event_id and event_row.site_id = ticket.site_id
     left join hpos.admissions admission on admission.site_id = ticket.site_id and admission.ticket_id = ticket.id
     where ticket.site_id = $1 and ticket.event_id = $2 ${orderCondition}
     order by ticket.created_at desc, ticket.id asc`, values,
  );
  return result.rows;
}

async function listOrders(request: Request, site: AuthenticatedSite, eventId: string): Promise<Response> {
  const url = new URL(request.url);
  const allowed = new Set(["limit", "cursor", "payment_status", "issuance_status", "delivery_status", "refund_status", "email", "order_reference"]);
  for (const name of url.searchParams.keys()) if (!allowed.has(name)) return fieldError(name, "unknown_filter", "Remove the unsupported Order list parameter.");
  const limit = listLimit(url.searchParams.get("limit"));
  if (limit instanceof Response) return limit;
  const filters = {
    payment_status: url.searchParams.get("payment_status"),
    issuance_status: url.searchParams.get("issuance_status"),
    delivery_status: url.searchParams.get("delivery_status"),
    refund_status: url.searchParams.get("refund_status"),
    email: url.searchParams.get("email")?.trim().toLowerCase() ?? null,
    order_reference: url.searchParams.get("order_reference")?.trim().toUpperCase() ?? null,
  };
  for (const [field, values] of Object.entries(STATUS_FILTERS)) {
    const value = filters[field as keyof typeof filters];
    if (value !== null && !(values as Set<string>).has(value)) return fieldError(field, "unsupported_value", `${field} has an unsupported value.`);
  }
  if (filters.email !== null && (filters.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(filters.email))) return fieldError("email", "invalid_email", "Provide a valid email filter.");
  if (filters.order_reference !== null && !/^[A-Z0-9-]{8,24}$/.test(filters.order_reference)) return fieldError("order_reference", "invalid_format", "Provide a valid Order reference.");
  const scope = JSON.stringify({ eventId, limit, ...filters });
  const cursor = parseCursor(url.searchParams.get("cursor"), site, "admin-orders", scope);
  if (cursor instanceof Response) return cursor;
  const values: unknown[] = [site.siteId, eventId];
  const where = ["order_row.site_id = $1", "order_row.event_id = $2"];
  const add = (sql: string, value: unknown) => { values.push(value); where.push(sql.replace("?", `$${values.length}`)); };
  for (const field of ["payment_status", "issuance_status", "delivery_status", "refund_status"] as const) if (filters[field] !== null) add(`order_row.${field} = ?`, filters[field]);
  if (filters.email !== null) add("lower(btrim(order_row.delivery_email)) = ?", filters.email);
  if (filters.order_reference !== null) add("upper(order_row.order_reference) = ?", filters.order_reference);
  if (cursor) {
    values.push(cursor.at, cursor.id);
    where.push(`(order_row.created_at < $${values.length - 1}::timestamptz or (order_row.created_at = $${values.length - 1}::timestamptz and order_row.id > $${values.length}::uuid))`);
  }
  values.push(limit + 1);
  const result = await getBusinessPool().query<OrderRow>(
    `select order_row.id as order_id, order_row.event_id, order_row.order_reference,
            order_row.buyer_name, order_row.delivery_email, order_row.checkout_status,
            order_row.payment_status, order_row.issuance_status, order_row.delivery_status,
            order_row.refund_status, order_row.created_at, order_row.updated_at, order_row.version,
            to_char(order_row.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_cursor_time
     from hpos.orders order_row where ${where.join(" and ")}
     order by order_row.created_at desc, order_row.id asc limit $${values.length}`, values,
  );
  const rows = result.rows.slice(0, limit);
  const tickets = await readTicketRows(getBusinessPool(), site.siteId, eventId, rows.map((row) => row.order_id));
  const byOrder = new Map<string, Record<string, unknown>[]>();
  for (const row of tickets) byOrder.set(row.order_id, [...(byOrder.get(row.order_id) ?? []), ticketData(row)]);
  const data = rows.map((row) => ({
    order_id: row.order_id, order_reference: row.order_reference, buyer_name: row.buyer_name,
    delivery_email: row.delivery_email, checkout_status: row.checkout_status,
    payment_status: row.payment_status, issuance_status: row.issuance_status,
    delivery_status: row.delivery_status, refund_status: row.refund_status,
    tickets: byOrder.get(row.order_id) ?? [],
  }));
  const last = rows.at(-1);
  return apiSuccess(data, 200, { nextCursor: result.rows.length > limit && last ? cursorFor(site, "admin-orders", scope, last.created_cursor_time, last.order_id) : null });
}

async function listTickets(request: Request, site: AuthenticatedSite, eventId: string): Promise<Response> {
  const url = new URL(request.url);
  const allowed = new Set(["limit", "cursor", "admission_status", "can_admit", "email"]);
  for (const name of url.searchParams.keys()) if (!allowed.has(name)) return fieldError(name, "unknown_filter", "Remove the unsupported Ticket list parameter.");
  const limit = listLimit(url.searchParams.get("limit"));
  if (limit instanceof Response) return limit;
  const admissionStatus = url.searchParams.get("admission_status");
  if (admissionStatus !== null && !TICKET_ADMISSION_STATUSES.has(admissionStatus)) return fieldError("admission_status", "unsupported_value", "admission_status must be unused or admitted.");
  const canAdmit = url.searchParams.get("can_admit");
  if (canAdmit !== null && canAdmit !== "true" && canAdmit !== "false") return fieldError("can_admit", "invalid_boolean", "can_admit must be true or false.");
  const email = url.searchParams.get("email")?.trim().toLowerCase() ?? null;
  if (email !== null && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return fieldError("email", "invalid_email", "Provide a valid email filter.");
  const scope = JSON.stringify({ eventId, limit, admission_status: admissionStatus, can_admit: canAdmit, email });
  const cursor = parseCursor(url.searchParams.get("cursor"), site, "admin-tickets", scope);
  if (cursor instanceof Response) return cursor;
  const values: unknown[] = [site.siteId, eventId];
  const where = ["ticket.site_id = $1", "ticket.event_id = $2"];
  if (admissionStatus === "unused") where.push("admission.id is null");
  if (admissionStatus === "admitted") where.push("admission.id is not null");
  if (email !== null) { values.push(email); where.push(`lower(btrim(order_row.delivery_email)) = $${values.length}`); }
  const blockers = "(event_row.is_canceled or order_row.refund_status = 'full' or admission.id is not null or event_row.ends_at is null or clock_timestamp() > event_row.ends_at or coalesce(event_row.check_in_opens_at, event_row.starts_at) is null or clock_timestamp() < coalesce(event_row.check_in_opens_at, event_row.starts_at))";
  if (canAdmit === "true") where.push(`not ${blockers}`);
  if (canAdmit === "false") where.push(blockers);
  if (cursor) {
    values.push(cursor.at, cursor.id);
    where.push(`(ticket.created_at < $${values.length - 1}::timestamptz or (ticket.created_at = $${values.length - 1}::timestamptz and ticket.id > $${values.length}::uuid))`);
  }
  values.push(limit + 1);
  const result = await getBusinessPool().query<TicketRow>(
    `select ticket.id as ticket_id, ticket.event_id, ticket.order_id, order_row.order_reference,
            ticket.ordinal, ticket.issued_at, ticket.created_at, ticket.updated_at, ticket.version,
            order_row.buyer_id, order_row.buyer_name, order_row.delivery_email,
            order_row.refund_status, event_row.is_canceled as event_canceled,
            event_row.starts_at, event_row.ends_at, event_row.check_in_opens_at,
            admission.id as admission_id, admission.admitted_at, clock_timestamp() as checked_at,
            to_char(ticket.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_cursor_time
     from hpos.tickets ticket
     join hpos.orders order_row on order_row.id = ticket.order_id and order_row.site_id = ticket.site_id
     join hpos.events event_row on event_row.id = ticket.event_id and event_row.site_id = ticket.site_id
     left join hpos.admissions admission on admission.site_id = ticket.site_id and admission.ticket_id = ticket.id
     where ${where.join(" and ")} order by ticket.created_at desc, ticket.id asc limit $${values.length}`, values,
  );
  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1);
  return apiSuccess(rows.map(ticketData), 200, { nextCursor: result.rows.length > limit && last ? cursorFor(site, "admin-tickets", scope, last.created_cursor_time, last.ticket_id) : null });
}

function money(amount: number, currency: string) { return { amount, currency }; }

async function readTotals(site: AuthenticatedSite, eventId: string): Promise<Response> {
  const client = await getBusinessPool().connect();
  try {
    await client.query("begin transaction isolation level repeatable read read only");
    if (!(await eventExists(client, site.siteId, eventId))) {
      await client.query("rollback");
      return apiFailure(404, "not_found", "The Event is not available to this Site.");
    }
    const asOfResult = await client.query<{ as_of: Date }>("select clock_timestamp() as as_of");
    const offering = await client.query<{ currency: string | null }>(
      `select offering.currency from hpos.events event_row
       join hpos.ticket_offerings offering on offering.id = event_row.ticket_offering_id and offering.site_id = event_row.site_id
       where event_row.site_id = $1 and event_row.id = $2`, [site.siteId, eventId]);
    const currencies = new Set<string>();
    if (offering.rows[0]?.currency) currencies.add(offering.rows[0].currency);
    const payments = await client.query<{ currency: string; amount: string | number }>(
      `select attempt.currency, attempt.total_amount as amount
       from hpos.orders order_row join hpos.payment_attempts attempt on attempt.order_id = order_row.id and attempt.site_id = order_row.site_id
       where order_row.site_id = $1 and order_row.event_id = $2 and order_row.payment_status = 'paid' and attempt.last_outcome = 'paid'`, [site.siteId, eventId]);
    const gross = new Map<string, number>();
    for (const row of payments.rows) {
      currencies.add(row.currency);
      gross.set(row.currency, addSafe(gross.get(row.currency) ?? 0, safeNumber(row.amount)));
    }
    const refunds = await client.query<{ currency: string; amount: string | number }>(
      `select refund.currency, refund.amount
       from hpos.orders order_row join hpos.refunds refund on refund.order_id = order_row.id and refund.site_id = order_row.site_id
       join hpos.payment_attempts attempt on attempt.id = refund.attempt_id and attempt.site_id = refund.site_id
       where order_row.site_id = $1 and order_row.event_id = $2 and order_row.payment_status = 'paid'
         and attempt.last_outcome = 'paid' and refund.outcome = 'completed'`, [site.siteId, eventId]);
    const refunded = new Map<string, number>();
    for (const row of refunds.rows) {
      currencies.add(row.currency);
      refunded.set(row.currency, addSafe(refunded.get(row.currency) ?? 0, safeNumber(row.amount)));
    }
    const scopes = await client.query<ScopeRow>(
      `with relevant_scopes as (
         select attempt.id as attempt_id, attempt.connection_id, 'payment'::text as scope_type,
                attempt.provider_payment_reference as scope_reference, attempt.currency as payment_currency,
                null::text as refund_currency
         from hpos.payment_attempts attempt
         join hpos.orders order_row on order_row.id = attempt.order_id and order_row.site_id = attempt.site_id
         where attempt.site_id = $1 and order_row.event_id = $2
           and order_row.payment_status = 'paid' and attempt.last_outcome = 'paid'
         union all
         select refund.attempt_id, refund.connection_id, 'refund'::text, refund.provider_refund_reference,
                attempt.currency, refund.currency
         from hpos.refunds refund
         join hpos.orders order_row on order_row.id = refund.order_id and order_row.site_id = refund.site_id
         join hpos.payment_attempts attempt
           on attempt.id = refund.attempt_id and attempt.site_id = refund.site_id
         where refund.site_id = $1 and order_row.event_id = $2 and order_row.payment_status = 'paid'
           and attempt.last_outcome = 'paid' and refund.outcome = 'completed'
       )
       select relevant_scopes.*,
              coalesce(array_agg(distinct conflict.category) filter (where conflict.category is not null), '{}'::text[]) as conflict_categories
       from relevant_scopes
       left join hpos.fee_records conflict
         on conflict.site_id = $1
        and conflict.attempt_id = relevant_scopes.attempt_id
        and conflict.connection_id = relevant_scopes.connection_id
        and conflict.scope_type = relevant_scopes.scope_type
        and conflict.scope_reference = relevant_scopes.scope_reference
        and conflict.conflict_code is not null
       group by relevant_scopes.attempt_id, relevant_scopes.connection_id, relevant_scopes.scope_type,
                relevant_scopes.scope_reference, relevant_scopes.payment_currency, relevant_scopes.refund_currency`,
      [site.siteId, eventId]);
    const conflictKeys = new Set(scopes.rows.flatMap((scope) =>
      scope.conflict_categories.map((category) => `${scopeKey(scope)}|${category}`)));
    const currentScopeKeys = new Set(scopes.rows.map(scopeKey));
    const feeRows = await client.query<CurrentFeeRow>(
      `select distinct on (fee.connection_id, fee.source_reference, fee.category, fee.direction)
              fee.id, fee.category, fee.direction, fee.amount, fee.currency, fee.created_at, fee.observed_at,
              fee.attempt_id, fee.connection_id, fee.scope_type, fee.scope_reference
       from hpos.fee_records fee join hpos.orders order_row on order_row.id = fee.order_id and order_row.site_id = fee.site_id
       where fee.site_id = $1 and order_row.event_id = $2 and fee.conflict_code is null
       order by fee.connection_id, fee.source_reference, fee.category, fee.direction, fee.source_revision desc, fee.created_at desc, fee.id desc`,
      [site.siteId, eventId]);
    const feeAmounts = new Map<string, { charged: number; returned: number }>();
    for (const row of feeRows.rows) {
      if (!currentScopeKeys.has(scopeKey(row)) || conflictKeys.has(`${scopeKey(row)}|${row.category}`)) continue;
      currencies.add(row.currency);
      const key = `${row.category}|${row.currency}`;
      const current = feeAmounts.get(key) ?? { charged: 0, returned: 0 };
      if (row.direction === "charge") current.charged = addSafe(current.charged, safeNumber(row.amount));
      else current.returned = addSafe(current.returned, safeNumber(row.amount));
      feeAmounts.set(key, current);
    }
    const confirmationCurrencies = await client.query<{
      currency: string;
      attempt_id: string;
      connection_id: string;
      scope_type: "payment" | "refund";
      scope_reference: string;
      category: Category;
    }>(
      `with latest_confirmations as (
         select distinct on (confirmation.attempt_id, confirmation.connection_id, confirmation.scope_type,
                             confirmation.scope_reference, confirmation.category)
                confirmation.id, confirmation.attempt_id, confirmation.connection_id,
                confirmation.scope_type, confirmation.scope_reference, confirmation.category
         from hpos.fee_confirmations confirmation
         where confirmation.site_id = $1
         order by confirmation.attempt_id, confirmation.connection_id, confirmation.scope_type,
                  confirmation.scope_reference, confirmation.category,
                  confirmation.observed_at desc, confirmation.created_at desc, confirmation.id desc
       )
       select distinct totals.currency, latest.attempt_id, latest.connection_id,
              latest.scope_type, latest.scope_reference, latest.category
       from hpos.fee_confirmation_totals totals
       join latest_confirmations latest on latest.id = totals.confirmation_id
       join hpos.fee_confirmations confirmation on confirmation.id = latest.id and confirmation.site_id = totals.site_id
       join hpos.orders order_row on order_row.id = confirmation.order_id and order_row.site_id = confirmation.site_id
       where totals.site_id = $1 and order_row.event_id = $2`, [site.siteId, eventId]);
    for (const row of confirmationCurrencies.rows) {
      if (currentScopeKeys.has(scopeKey(row)) && !conflictKeys.has(`${scopeKey(row)}|${row.category}`)) currencies.add(row.currency);
    }
    const confirmations = await client.query<{ id: string; attempt_id: string; connection_id: string; scope_type: "payment" | "refund"; scope_reference: string; category: "processing" | "platform"; observed_at: Date; created_at: Date }>(
      `select distinct on (attempt_id, connection_id, scope_type, scope_reference, category)
              id, attempt_id, connection_id, scope_type, scope_reference, category, observed_at, created_at
       from hpos.fee_confirmations where site_id = $1
       order by attempt_id, connection_id, scope_type, scope_reference, category, observed_at desc, created_at desc, id desc`, [site.siteId]);
    const latestConfirmations = new Map(confirmations.rows.map((row) => [`${row.attempt_id}|${row.connection_id}|${row.scope_type}|${row.scope_reference}|${row.category}`, row]));
    const feeComplete = new Map<Category, boolean>();
    for (const category of ["processing", "platform"] as const) {
      let complete = true;
      for (const scope of scopes.rows) {
        const key = `${scopeKey(scope)}|${category}`;
        const confirmation = latestConfirmations.get(key);
        const changed = await client.query<{ latest_fee_observed_at: Date; latest_fee_created_at: Date; latest_fee_id: string }>(
          `select fee.observed_at as latest_fee_observed_at, fee.created_at as latest_fee_created_at, fee.id as latest_fee_id
           from hpos.fee_records fee
           where fee.site_id = $1 and fee.attempt_id = $2 and fee.connection_id = $3
             and fee.scope_type = $4 and fee.scope_reference = $5 and fee.category = $6
             and fee.conflict_code is null
             and not exists (
               select 1 from hpos.fee_records newer
               where newer.site_id = fee.site_id and newer.attempt_id = fee.attempt_id
                 and newer.connection_id = fee.connection_id and newer.scope_type = fee.scope_type
                 and newer.scope_reference = fee.scope_reference and newer.category = fee.category
                 and newer.source_reference = fee.source_reference and newer.direction = fee.direction
                 and newer.conflict_code is null and newer.source_revision > fee.source_revision
             )
           order by fee.observed_at desc, fee.created_at desc, fee.id desc
           limit 1`,
          [site.siteId, scope.attempt_id, scope.connection_id, scope.scope_type, scope.scope_reference, category]);
        const latestFee = changed.rows[0];
        if (!confirmation || conflictKeys.has(key)
          || (latestFee && observationComesBefore(confirmation, {
            observed_at: latestFee.latest_fee_observed_at,
            created_at: latestFee.latest_fee_created_at,
            id: latestFee.latest_fee_id,
          }))) { complete = false; break; }
      }
      feeComplete.set(category, complete);
    }
    const ticketCounts = await client.query<{ issued: number; valid: number; admitted: number }>(
      `select count(ticket.id)::integer as issued,
              count(ticket.id) filter (where not event_row.is_canceled and order_row.refund_status <> 'full')::integer as valid,
              count(admission.id)::integer as admitted
       from hpos.tickets ticket
       join hpos.orders order_row on order_row.id = ticket.order_id and order_row.site_id = ticket.site_id
       join hpos.events event_row on event_row.id = ticket.event_id and event_row.site_id = ticket.site_id
       left join hpos.admissions admission on admission.ticket_id = ticket.id and admission.site_id = ticket.site_id
       where ticket.site_id = $1 and ticket.event_id = $2`, [site.siteId, eventId]);
    await client.query("commit");
    const sales = [...currencies].sort().map((currency) => {
      const grossAmount = gross.get(currency) ?? 0;
      const refundAmount = refunded.get(currency) ?? 0;
      const fees = (category: "processing" | "platform") => {
        if (!feeComplete.get(category)) return { reporting_status: "pending", charged: null, returned: null, net: null };
        const values = feeAmounts.get(`${category}|${currency}`) ?? { charged: 0, returned: 0 };
        return { reporting_status: "complete", charged: money(values.charged, currency), returned: money(values.returned, currency), net: money(values.charged - values.returned, currency) };
      };
      return {
        currency,
        gross_paid_sales: money(grossAmount, currency),
        refunded_amount: money(refundAmount, currency),
        net_sales: money(grossAmount - refundAmount, currency),
        processing_fees: fees("processing"),
        platform_fees: fees("platform"),
      };
    });
    return apiSuccess({
      event_id: eventId,
      as_of: asOfResult.rows[0].as_of.toISOString(),
      sales,
      tickets: ticketCounts.rows[0] ?? { issued: 0, valid: 0, admitted: 0 },
    });
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function handleAdminReportingGet(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (path.length !== 4 || path[0] !== "admin" || path[1] !== "events" || !["orders", "tickets", "totals"].includes(path[3])) return null;
  const eventId = path[2];
  if (!UUID_PATTERN.test(eventId)) return apiFailure(404, "not_found", "The Event is not available to this Site.");
  if (path[3] === "totals") return readTotals(site, eventId);
  const exists = await eventExists(getBusinessPool(), site.siteId, eventId);
  if (!exists) return apiFailure(404, "not_found", "The Event is not available to this Site.");
  return path[3] === "orders" ? listOrders(request, site, eventId) : listTickets(request, site, eventId);
}
