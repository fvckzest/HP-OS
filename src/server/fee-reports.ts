import { createHash, randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { apiFailure } from "./api-response";
import { ApiOperationError, withApiIdempotency } from "./api-idempotency";
import type { IdempotentResult } from "./api-idempotency";
import { getBusinessPool } from "./database";
import type { AuthenticatedSite } from "./site-auth";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const CATEGORIES = new Set(["processing", "platform"]);
const DIRECTIONS = new Set(["charge", "return"]);
const SCOPES = new Set(["payment", "refund"]);

type ScopeType = "payment" | "refund";
type Category = "processing" | "platform";
type Direction = "charge" | "return";

interface Actor {
  type: "user" | "system";
  reference: string;
}

interface FeeInput {
  actor: Actor;
  attempt_id: string;
  connection_id: string;
  scope_type: ScopeType;
  scope_reference: string;
  source_reference: string;
  source_revision: number;
  category: Category;
  direction: Direction;
  amount: number;
  currency: string;
  observed_at: string;
}

interface ConfirmationInput {
  actor: Actor;
  attempt_id: string;
  connection_id: string;
  scope_type: ScopeType;
  scope_reference: string;
  category: Category;
  totals: Array<{ currency: string; charged: number; returned: number }>;
  observed_at: string;
}

interface FeeRecordRow extends QueryResultRow {
  id: string;
  site_id: string;
  order_id: string;
  attempt_id: string;
  connection_id: string;
  scope_type: ScopeType;
  scope_reference: string;
  source_reference: string;
  source_revision: string | number;
  category: Category;
  direction: Direction;
  amount: string | number;
  currency: string;
  observed_at: Date;
  actor_type: "user" | "system";
  actor_reference: string;
  report_fingerprint: string;
  conflict_code: string | null;
  created_at: Date;
}

interface ScopeRow extends QueryResultRow {
  order_id: string;
  attempt_id: string;
  connection_id: string;
  provider_payment_reference: string | null;
  payment_currency: string | null;
  payment_status: string;
  refund_id: string | null;
  refund_outcome: string | null;
  refund_amount: string | number | null;
  refund_currency: string | null;
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validReference(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 500
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && RFC3339_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

function actor(value: unknown): Actor | null {
  if (!object(value) || Object.keys(value).some((key) => !["type", "reference"].includes(key))) return null;
  if ((value.type !== "user" && value.type !== "system") || typeof value.reference !== "string") return null;
  const reference = value.reference.trim();
  if (reference.length < 1 || reference.length > 200 || /[\u0000-\u001f\u007f]/.test(reference)) return null;
  return { type: value.type, reference };
}

function fieldError(field: string, code: string, message: string): Response {
  return apiFailure(422, "validation_failed", message, { details: [{ field, code, message }] });
}

function parseAmount(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function parseFeeInput(body: Record<string, unknown>): FeeInput | Response {
  const fields = ["actor", "attempt_id", "connection_id", "scope_type", "scope_reference", "source_reference",
    "source_revision", "category", "direction", "amount", "currency", "observed_at"];
  const unknown = Object.keys(body).find((key) => !fields.includes(key));
  if (unknown) return fieldError(unknown, "unknown_field", "Remove the unsupported fee-report field.");
  const missing = fields.find((field) => !Object.hasOwn(body, field));
  if (missing) return fieldError(missing, "required", "Include every required fee-report field.");
  const parsedActor = actor(body.actor);
  if (!parsedActor) return fieldError("actor", "invalid_actor", "Provide a user or system actor with a non-secret reference.");
  if (typeof body.attempt_id !== "string" || !UUID_PATTERN.test(body.attempt_id)) return fieldError("attempt_id", "invalid_uuid", "attempt_id must be a UUID.");
  if (typeof body.connection_id !== "string" || !UUID_PATTERN.test(body.connection_id)) return fieldError("connection_id", "invalid_uuid", "connection_id must be a UUID.");
  if (typeof body.scope_type !== "string" || !SCOPES.has(body.scope_type)) return fieldError("scope_type", "unsupported_value", "scope_type must be payment or refund.");
  if (!validReference(body.scope_reference)) return fieldError("scope_reference", "invalid_reference", "scope_reference must be a provider reference.");
  if (!validReference(body.source_reference)) return fieldError("source_reference", "invalid_reference", "source_reference must be a provider fee-component reference.");
  if (!Number.isSafeInteger(body.source_revision) || Number(body.source_revision) < 1 || Number(body.source_revision) > Number.MAX_SAFE_INTEGER) return fieldError("source_revision", "out_of_range", "source_revision must be a positive safe integer.");
  if (typeof body.category !== "string" || !CATEGORIES.has(body.category)) return fieldError("category", "unsupported_value", "category must be processing or platform.");
  if (typeof body.direction !== "string" || !DIRECTIONS.has(body.direction)) return fieldError("direction", "unsupported_value", "direction must be charge or return.");
  const amount = parseAmount(body.amount);
  if (amount === null) return fieldError("amount", "out_of_range", "amount must be a nonnegative safe integer.");
  if (typeof body.currency !== "string" || !/^[A-Z]{3}$/.test(body.currency)) return fieldError("currency", "invalid_currency", "currency must be an uppercase three-letter code.");
  if (!validTimestamp(body.observed_at)) return fieldError("observed_at", "invalid_timestamp", "observed_at must be an RFC 3339 timestamp.");
  return {
    actor: parsedActor,
    attempt_id: body.attempt_id,
    connection_id: body.connection_id,
    scope_type: body.scope_type as ScopeType,
    scope_reference: body.scope_reference.trim(),
    source_reference: body.source_reference.trim(),
    source_revision: Number(body.source_revision),
    category: body.category as Category,
    direction: body.direction as Direction,
    amount,
    currency: body.currency,
    observed_at: body.observed_at,
  };
}

function parseConfirmationInput(body: Record<string, unknown>): ConfirmationInput | Response {
  const fields = ["actor", "attempt_id", "connection_id", "scope_type", "scope_reference", "category", "totals", "observed_at"];
  const unknown = Object.keys(body).find((key) => !fields.includes(key));
  if (unknown) return fieldError(unknown, "unknown_field", "Remove the unsupported fee-confirmation field.");
  const missing = fields.find((field) => !Object.hasOwn(body, field));
  if (missing) return fieldError(missing, "required", "Include every required fee-confirmation field.");
  const parsedActor = actor(body.actor);
  if (!parsedActor) return fieldError("actor", "invalid_actor", "Provide a user or system actor with a non-secret reference.");
  if (typeof body.attempt_id !== "string" || !UUID_PATTERN.test(body.attempt_id)) return fieldError("attempt_id", "invalid_uuid", "attempt_id must be a UUID.");
  if (typeof body.connection_id !== "string" || !UUID_PATTERN.test(body.connection_id)) return fieldError("connection_id", "invalid_uuid", "connection_id must be a UUID.");
  if (typeof body.scope_type !== "string" || !SCOPES.has(body.scope_type)) return fieldError("scope_type", "unsupported_value", "scope_type must be payment or refund.");
  if (!validReference(body.scope_reference)) return fieldError("scope_reference", "invalid_reference", "scope_reference must be a provider reference.");
  if (typeof body.category !== "string" || !CATEGORIES.has(body.category)) return fieldError("category", "unsupported_value", "category must be processing or platform.");
  if (!Array.isArray(body.totals) || body.totals.length < 1 || body.totals.length > 100) return fieldError("totals", "invalid_list", "totals must contain one to one hundred currency rows.");
  const totals: ConfirmationInput["totals"] = [];
  const currencies = new Set<string>();
  for (const [index, value] of body.totals.entries()) {
    const field = `totals[${index}]`;
    if (!object(value) || Object.keys(value).some((key) => !["currency", "charged", "returned"].includes(key))
      || typeof value.currency !== "string" || !/^[A-Z]{3}$/.test(value.currency)
      || currencies.has(value.currency)) return fieldError(field, "invalid_currency", "Each total needs a unique uppercase currency.");
    const charged = parseAmount(value.charged);
    const returned = parseAmount(value.returned);
    if (charged === null || returned === null) return fieldError(field, "out_of_range", "charged and returned must be nonnegative safe integers.");
    currencies.add(value.currency);
    totals.push({ currency: value.currency, charged, returned });
  }
  if (!validTimestamp(body.observed_at)) return fieldError("observed_at", "invalid_timestamp", "observed_at must be an RFC 3339 timestamp.");
  return {
    actor: parsedActor,
    attempt_id: body.attempt_id,
    connection_id: body.connection_id,
    scope_type: body.scope_type as ScopeType,
    scope_reference: body.scope_reference.trim(),
    category: body.category as Category,
    totals,
    observed_at: body.observed_at,
  };
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | Response> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return apiFailure(415, "unsupported_media_type", "Send fee fields as application/json.");
  let text: string;
  try { text = await request.text(); } catch { return apiFailure(400, "invalid_request", "The fee request body could not be read."); }
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) return apiFailure(413, "request_too_large", "The request body exceeds 64 KiB.");
  let value: unknown;
  try { value = JSON.parse(text); } catch { return apiFailure(400, "invalid_request", "The fee request body must contain readable JSON."); }
  if (!object(value)) return apiFailure(400, "invalid_request", "The fee request body must be a JSON object.");
  return value;
}

function fingerprint(input: FeeInput): string {
  return createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex");
}

function safeNumber(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("A fee amount is outside the safe integer range.");
  return parsed;
}

function feeRecordData(row: FeeRecordRow, current = false) {
  return {
    fee_record_id: row.id,
    order_id: row.order_id,
    attempt_id: row.attempt_id,
    connection_id: row.connection_id,
    scope_type: row.scope_type,
    scope_reference: row.scope_reference,
    source_reference: row.source_reference,
    source_revision: safeNumber(row.source_revision),
    category: row.category,
    direction: row.direction,
    amount: safeNumber(row.amount),
    currency: row.currency,
    observed_at: row.observed_at.toISOString(),
    actor: { type: row.actor_type, reference: row.actor_reference },
    applied: current,
    is_current: current,
    conflict_code: row.conflict_code,
    created_at: row.created_at.toISOString(),
  };
}

async function scopeRow(client: PoolClient, siteId: string, orderId: string, input: Pick<FeeInput, "attempt_id" | "connection_id" | "scope_type" | "scope_reference">): Promise<ScopeRow | null> {
  const result = input.scope_type === "payment"
    ? await client.query<ScopeRow>(
      `select order_row.id as order_id, attempt.id as attempt_id, attempt.connection_id,
              attempt.provider_payment_reference, attempt.currency as payment_currency,
              order_row.payment_status,
              null::uuid as refund_id, null::text as refund_outcome,
              null::bigint as refund_amount, null::text as refund_currency
       from hpos.orders order_row
       join hpos.payment_attempts attempt on attempt.order_id = order_row.id and attempt.site_id = order_row.site_id
       where order_row.site_id = $1 and order_row.id = $2
         and attempt.id = $3 and attempt.connection_id = $4
         and attempt.provider_payment_reference = $5
         and attempt.last_outcome = 'paid' and order_row.payment_status = 'paid'
       for update of order_row, attempt`,
      [siteId, orderId, input.attempt_id, input.connection_id, input.scope_reference],
    )
    : await client.query<ScopeRow>(
      `select order_row.id as order_id, attempt.id as attempt_id, attempt.connection_id,
              attempt.provider_payment_reference, attempt.currency as payment_currency,
              order_row.payment_status,
              refund.id as refund_id, refund.outcome as refund_outcome,
              refund.amount as refund_amount, refund.currency as refund_currency
       from hpos.orders order_row
       join hpos.payment_attempts attempt on attempt.order_id = order_row.id and attempt.site_id = order_row.site_id
       join hpos.refunds refund
         on refund.order_id = order_row.id and refund.site_id = order_row.site_id
        and refund.attempt_id = attempt.id and refund.connection_id = attempt.connection_id
        and refund.provider_refund_reference = $5
       where order_row.site_id = $1 and order_row.id = $2
         and attempt.id = $3 and attempt.connection_id = $4
         and refund.outcome = 'completed'
       for update of order_row, attempt, refund`,
      [siteId, orderId, input.attempt_id, input.connection_id, input.scope_reference],
    );
  return result.rows[0] ?? null;
}

type FeeIssueCode = "fee_report_conflict" | "planned_platform_fee_discrepancy";

async function issueForRecord(client: PoolClient, siteId: string, orderId: string, attemptId: string, feeRecordId: string | null, message: string, code: FeeIssueCode = "fee_report_conflict"): Promise<void> {
  await client.query(
    `insert into hpos.fee_report_issues (id, site_id, order_id, attempt_id, fee_record_id, code, message)
     select $1, $2, $3, $4, $5, $6, $7
     where not exists (
       select 1 from hpos.fee_report_issues
       where site_id = $2 and order_id = $3 and attempt_id = $4 and code = $6 and message = $7 and status = 'open'
     )`,
    [randomUUID(), siteId, orderId, attemptId, feeRecordId, code, message.slice(0, 1000)],
  );
}

async function feeReportAction(client: PoolClient, site: AuthenticatedSite, orderId: string, input: FeeInput): Promise<IdempotentResult> {
  if (!UUID_PATTERN.test(orderId)) throw new ApiOperationError(404, "not_found", "The Order is not available to this Site.");
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `${site.siteId}|${input.connection_id}|${input.source_reference}|${input.category}|${input.direction}`,
  ]);
  const scope = await scopeRow(client, site.siteId, orderId, input);
  if (!scope) throw new ApiOperationError(409, "fee_report_conflict", "The fee scope does not match a confirmed payment or completed refund on this Order.");
  const reportFingerprint = fingerprint(input);
  const existingExact = await client.query<FeeRecordRow>(
    `select * from hpos.fee_records where site_id = $1 and connection_id = $2
       and source_reference = $3 and category = $4 and direction = $5
       and source_revision = $6 and report_fingerprint = $7
     limit 1`,
    [site.siteId, input.connection_id, input.source_reference, input.category, input.direction, input.source_revision, reportFingerprint],
  );
  if (existingExact.rows[0]) {
    if (existingExact.rows[0].conflict_code !== null) {
      const message = "The provider fee source or revision contradicts an existing attributable fee observation.";
      return { status: 409, data: { code: "fee_report_conflict", message, details: [] } };
    }
    return { status: 200, data: { fee_record_id: existingExact.rows[0].id, applied: false, order_id: orderId } };
  }

  const history = await client.query<FeeRecordRow>(
    `select * from hpos.fee_records
     where site_id = $1 and connection_id = $2 and source_reference = $3
       and category = $4 and direction = $5
     order by source_revision desc, created_at desc, id desc`,
    [site.siteId, input.connection_id, input.source_reference, input.category, input.direction],
  );
  const sameRevision = history.rows.find((row) => safeNumber(row.source_revision) === input.source_revision && row.conflict_code === null);
  if (sameRevision && sameRevision.order_id === orderId && sameRevision.attempt_id === input.attempt_id
    && sameRevision.scope_type === input.scope_type && sameRevision.scope_reference === input.scope_reference
    && sameRevision.currency === input.currency && safeNumber(sameRevision.amount) === input.amount) {
    return { status: 200, data: { fee_record_id: sameRevision.id, applied: false, order_id: orderId } };
  }
  const conflict = history.rows.find((row) => row.order_id !== orderId
    || row.attempt_id !== input.attempt_id || row.scope_type !== input.scope_type
    || row.scope_reference !== input.scope_reference || row.currency !== input.currency
    || safeNumber(row.source_revision) === input.source_revision);
  const maxValidRevision = history.rows.filter((row) => row.conflict_code === null).reduce((max, row) => Math.max(max, safeNumber(row.source_revision)), 0);
  const conflictMessage = conflict
    ? "The provider fee source or revision contradicts an existing attributable fee observation."
    : null;
  const reportId = randomUUID();
  await client.query(
    `insert into hpos.fee_records (
       id, site_id, order_id, attempt_id, connection_id, scope_type, scope_reference,
       source_reference, source_revision, category, direction, amount, currency,
       observed_at, actor_type, actor_reference, report_fingerprint, conflict_code
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
    [reportId, site.siteId, orderId, input.attempt_id, input.connection_id, input.scope_type,
      input.scope_reference, input.source_reference, input.source_revision, input.category,
      input.direction, input.amount, input.currency, input.observed_at, input.actor.type,
      input.actor.reference, reportFingerprint, conflictMessage ? "fee_report_conflict" : null],
  );
  if (conflictMessage) {
    await issueForRecord(client, site.siteId, orderId, input.attempt_id, reportId, conflictMessage);
    return { status: 409, data: { code: "fee_report_conflict", message: conflictMessage, details: [] } };
  }
  return { status: 201, data: { fee_record_id: reportId, applied: input.source_revision > maxValidRevision, order_id: orderId } };
}

async function currentComponents(client: PoolClient, siteId: string, input: Pick<ConfirmationInput, "attempt_id" | "connection_id" | "scope_type" | "scope_reference" | "category">): Promise<FeeRecordRow[]> {
  const result = await client.query<FeeRecordRow>(
    `select distinct on (source_reference, direction) *
     from hpos.fee_records
     where site_id = $1 and attempt_id = $2 and connection_id = $3
       and scope_type = $4 and scope_reference = $5 and category = $6
       and conflict_code is null
     order by source_reference, direction, source_revision desc, created_at desc, id desc`,
    [siteId, input.attempt_id, input.connection_id, input.scope_type, input.scope_reference, input.category],
  );
  return result.rows;
}

async function allComponentsHaveNoConflict(client: PoolClient, siteId: string, input: Pick<ConfirmationInput, "attempt_id" | "connection_id" | "scope_type" | "scope_reference" | "category">): Promise<boolean> {
  const result = await client.query<{ conflict: boolean }>(
    `select exists (
       select 1 from hpos.fee_records
       where site_id = $1 and attempt_id = $2 and connection_id = $3
         and scope_type = $4 and scope_reference = $5 and category = $6
         and conflict_code is not null
     ) as conflict`,
    [siteId, input.attempt_id, input.connection_id, input.scope_type, input.scope_reference, input.category],
  );
  return !result.rows[0]?.conflict;
}

function componentTotals(rows: FeeRecordRow[]): Map<string, { charged: number; returned: number }> {
  const result = new Map<string, { charged: number; returned: number }>();
  for (const row of rows) {
    const current = result.get(row.currency) ?? { charged: 0, returned: 0 };
    const amount = safeNumber(row.amount);
    if (row.direction === "charge") {
      current.charged += amount;
      if (!Number.isSafeInteger(current.charged)) throw new ApiOperationError(409, "fee_report_conflict", "The fee components exceed the supported amount range.");
    } else {
      current.returned += amount;
      if (!Number.isSafeInteger(current.returned)) throw new ApiOperationError(409, "fee_report_conflict", "The fee components exceed the supported amount range.");
    }
    result.set(row.currency, current);
  }
  return result;
}

async function createPlannedFeeIssue(client: PoolClient, site: AuthenticatedSite, orderId: string, input: ConfirmationInput, totals: Array<{ currency: string; charged: number; returned: number }>, rows: FeeRecordRow[]): Promise<void> {
  if (input.category !== "platform" || input.scope_type !== "payment") return;
  const expected = await client.query<{ expected_amount: string | number; expected_currency: string }>(
    `select (order_row.accepted_quote -> 'platform_fee' ->> 'amount')::bigint as expected_amount,
            order_row.accepted_quote -> 'platform_fee' ->> 'currency' as expected_currency
     from hpos.orders order_row where order_row.site_id = $1 and order_row.id = $2`,
    [site.siteId, orderId],
  );
  const planned = expected.rows[0];
  if (!planned || planned.expected_amount === null || !planned.expected_currency) return;
  const actual = totals.find((row) => row.currency === planned.expected_currency)?.charged ?? 0;
  if (actual === Number(planned.expected_amount)) return;
  const currentRecord = rows.at(-1)?.id ?? null;
  await issueForRecord(client, site.siteId, orderId, input.attempt_id, currentRecord,
    `The confirmed platform fee differs from the planned checkout fee (${planned.expected_amount} ${planned.expected_currency} planned; ${actual} ${planned.expected_currency} confirmed).`,
    "planned_platform_fee_discrepancy");
}

async function feeConfirmationAction(client: PoolClient, site: AuthenticatedSite, orderId: string, input: ConfirmationInput): Promise<IdempotentResult> {
  if (!UUID_PATTERN.test(orderId)) throw new ApiOperationError(404, "not_found", "The Order is not available to this Site.");
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `${site.siteId}|${input.attempt_id}|${input.connection_id}|${input.scope_type}|${input.scope_reference}|${input.category}`,
  ]);
  const scope = await scopeRow(client, site.siteId, orderId, input);
  if (!scope) throw new ApiOperationError(409, "fee_report_conflict", "The fee scope does not match a confirmed payment or completed refund on this Order.");
  if (!(await allComponentsHaveNoConflict(client, site.siteId, input))) throw new ApiOperationError(409, "fee_report_conflict", "An attributable fee conflict must be resolved before confirming this category.");
  const rows = await currentComponents(client, site.siteId, input);
  const calculated = componentTotals(rows);
  const expected = new Map(input.totals.map((row) => [row.currency, { charged: row.charged, returned: row.returned }]));
  if (input.scope_type === "payment" && (!scope.payment_currency || !expected.has(scope.payment_currency))) {
    throw new ApiOperationError(409, "fee_report_conflict", "A payment confirmation must include its payment currency, including when the confirmed fee is zero.");
  }
  if (input.scope_type === "refund" && (!scope.refund_currency || !expected.has(scope.refund_currency))) {
    throw new ApiOperationError(409, "fee_report_conflict", "A refund confirmation must include its refund currency, including when the confirmed fee is zero.");
  }
  for (const [currency, value] of calculated) {
    const supplied = expected.get(currency);
    if (!supplied || supplied.charged !== value.charged || supplied.returned !== value.returned) {
      throw new ApiOperationError(409, "fee_report_conflict", "The confirmation totals do not match the current fee components.");
    }
  }
  for (const [currency, value] of expected) {
    const calculatedValue = calculated.get(currency) ?? { charged: 0, returned: 0 };
    if (calculatedValue.charged !== value.charged || calculatedValue.returned !== value.returned) {
      throw new ApiOperationError(409, "fee_report_conflict", "The confirmation totals do not match the current fee components.");
    }
  }
  const confirmationId = randomUUID();
  await client.query(
    `insert into hpos.fee_confirmations (
       id, site_id, order_id, attempt_id, connection_id, scope_type, scope_reference,
       category, actor_type, actor_reference, observed_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [confirmationId, site.siteId, orderId, input.attempt_id, input.connection_id,
      input.scope_type, input.scope_reference, input.category, input.actor.type,
      input.actor.reference, input.observed_at],
  );
  for (const total of input.totals) {
    await client.query(
      `insert into hpos.fee_confirmation_totals (id, site_id, confirmation_id, currency, charged, returned)
       values ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), site.siteId, confirmationId, total.currency, total.charged, total.returned],
    );
  }
  await createPlannedFeeIssue(client, site, orderId, input, input.totals, rows);
  return {
    status: 200,
    data: {
      order_id: orderId,
      scope_type: input.scope_type,
      scope_reference: input.scope_reference,
      category: input.category,
      reporting_status: "complete",
    },
  };
}

export async function readFeeRecords(client: PoolClient, siteId: string, orderId: string): Promise<Record<string, unknown>[]> {
  const result = await client.query<FeeRecordRow>(
    `select * from hpos.fee_records where site_id = $1 and order_id = $2 order by created_at asc, id asc`,
    [siteId, orderId],
  );
  const currentKeys = new Set((await client.query<{ source_reference: string; category: Category; direction: Direction; source_revision: number }>(
    `select source_reference, category, direction, max(source_revision) as source_revision
     from hpos.fee_records
     where site_id = $1 and order_id = $2 and conflict_code is null
     group by source_reference, category, direction`, [siteId, orderId],
  )).rows.map((row) => `${row.source_reference}|${row.category}|${row.direction}|${safeNumber(row.source_revision)}`));
  return result.rows.map((row) => feeRecordData(row, row.conflict_code === null
    && currentKeys.has(`${row.source_reference}|${row.category}|${row.direction}|${safeNumber(row.source_revision)}`)));
}

export async function handleFeeReportPost(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (path.length !== 4 || path[0] !== "admin" || path[1] !== "orders") return null;
  if (path[3] !== "fee-reports" && path[3] !== "fee-confirmations") return null;
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  const parsed = path[3] === "fee-reports" ? parseFeeInput(body) : parseConfirmationInput(body);
  if (parsed instanceof Response) return parsed;
  return withApiIdempotency(request, site, body,
    (client) => path[3] === "fee-reports"
      ? feeReportAction(client, site, path[2], parsed as FeeInput)
      : feeConfirmationAction(client, site, path[2], parsed as ConfirmationInput),
    undefined, body);
}
