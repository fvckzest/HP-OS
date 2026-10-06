import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { apiFailure } from "./api-response";
import { withApiIdempotency } from "./api-idempotency";
import { ApiOperationError } from "./api-idempotency";
import type { IdempotentResult } from "./api-idempotency";
import { getBusinessPool } from "./database";
import type { AuthenticatedSite } from "./site-auth";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const OUTCOMES = new Set(["processing", "completed", "failed", "unknown"]);

interface RefundInput {
  attempt_id: string;
  connection_id: string;
  provider_payment_reference: string;
  provider_refund_reference: string;
  source_reference: string;
  outcome: "processing" | "completed" | "failed" | "unknown";
  amount: number;
  currency: string;
  observed_at: string;
}

interface LockedRefundOrder {
  order_id: string;
  site_id: string;
  event_id: string;
  offering_id: string;
  reservation_id: string;
  reservation_status: "held" | "consumed" | "released";
  reservation_offering_id: string;
  payment_status: string;
  refund_status: "none" | "partial" | "full";
  is_canceled: boolean;
  attempt_id: string;
  connection_id: string;
  provider: "square" | "stripe";
  environment: "test" | "live";
  account_reference: string;
  provider_payment_reference: string | null;
  last_outcome: string | null;
  total_amount: string | number;
  currency: string;
}

interface RefundRow {
  id: string;
  site_id: string;
  order_id: string;
  attempt_id: string;
  connection_id: string;
  provider: "square" | "stripe";
  environment: "test" | "live";
  account_reference: string;
  provider_payment_reference: string;
  provider_refund_reference: string;
  outcome: RefundInput["outcome"];
  amount: string | number;
  currency: string;
  observed_at: Date;
  created_at: Date;
  updated_at: Date;
}

interface RefundReportRow {
  id: string;
  attempt_id: string;
  connection_id: string;
  source_reference: string;
  provider_payment_reference: string;
  provider_refund_reference: string;
  outcome: RefundInput["outcome"];
  observed_at: Date;
  amount: string | number;
  currency: string;
  evidence: Record<string, unknown>;
  applied: boolean;
  stale: boolean;
  conflict_code: string | null;
  created_at: Date;
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

function parseInput(value: Record<string, unknown>): RefundInput | Response {
  const allowed = ["attempt_id", "connection_id", "provider_payment_reference", "provider_refund_reference",
    "source_reference", "outcome", "amount", "currency", "observed_at"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    return apiFailure(422, "validation_failed", "A refund report contains an unsupported field.");
  }
  if (allowed.some((key) => !Object.hasOwn(value, key))) {
    return apiFailure(422, "validation_failed", "A refund report must include every required field.");
  }
  if (typeof value.attempt_id !== "string" || !UUID_PATTERN.test(value.attempt_id)
    || typeof value.connection_id !== "string" || !UUID_PATTERN.test(value.connection_id)) {
    return apiFailure(422, "validation_failed", "attempt_id and connection_id must be UUIDs.");
  }
  const providerPaymentReference = value.provider_payment_reference;
  const providerRefundReference = value.provider_refund_reference;
  const sourceReference = value.source_reference;
  for (const field of ["provider_payment_reference", "provider_refund_reference", "source_reference"] as const) {
    if (!validReference(value[field])) {
      return apiFailure(422, "validation_failed", `${field} must be a stable provider reference of at most 500 characters.`);
    }
  }
  if (typeof value.outcome !== "string" || !OUTCOMES.has(value.outcome)) {
    return apiFailure(422, "validation_failed", "outcome must be processing, completed, failed, or unknown.");
  }
  if (!Number.isSafeInteger(value.amount) || Number(value.amount) < 1
    || typeof value.currency !== "string" || !/^[A-Z]{3}$/.test(value.currency)) {
    return apiFailure(422, "validation_failed", "amount must be a positive safe integer and currency an uppercase three-letter code.");
  }
  if (!validTimestamp(value.observed_at)) {
    return apiFailure(422, "validation_failed", "observed_at must be an RFC 3339 timestamp with an explicit offset.");
  }
  return {
    attempt_id: value.attempt_id,
    connection_id: value.connection_id,
    provider_payment_reference: (providerPaymentReference as string).trim(),
    provider_refund_reference: (providerRefundReference as string).trim(),
    source_reference: (sourceReference as string).trim(),
    outcome: value.outcome as RefundInput["outcome"],
    amount: Number(value.amount),
    currency: value.currency,
    observed_at: value.observed_at,
  };
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | Response> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return apiFailure(415, "unsupported_media_type", "Send refund-report fields as application/json.");
  }
  let bodyText: string;
  try { bodyText = await request.text(); }
  catch { return apiFailure(400, "invalid_request", "The refund-report body could not be read."); }
  if (Buffer.byteLength(bodyText, "utf8") > 64 * 1024) return apiFailure(413, "request_too_large", "The request body exceeds 64 KiB.");
  let body: unknown;
  try { body = JSON.parse(bodyText); }
  catch { return apiFailure(400, "invalid_request", "The refund-report body must contain readable JSON."); }
  if (!object(body)) return apiFailure(400, "invalid_request", "The refund-report body must be a JSON object.");
  return body;
}

function fingerprint(input: RefundInput): string {
  return createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex");
}

function safeNumber(value: string | number): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("A refund amount is outside JavaScript's safe integer range.");
  return number;
}

function refundData(row: RefundRow) {
  return {
    refund_id: row.id,
    attempt_id: row.attempt_id,
    connection_id: row.connection_id,
    provider_payment_reference: row.provider_payment_reference,
    provider_refund_reference: row.provider_refund_reference,
    outcome: row.outcome,
    amount: safeNumber(row.amount),
    currency: row.currency,
    observed_at: row.observed_at.toISOString(),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function reportData(row: RefundReportRow) {
  return {
    report_id: row.id,
    attempt_id: row.attempt_id,
    connection_id: row.connection_id,
    source_reference: row.source_reference,
    provider_payment_reference: row.provider_payment_reference,
    provider_refund_reference: row.provider_refund_reference,
    outcome: row.outcome,
    observed_at: row.observed_at.toISOString(),
    amount: safeNumber(row.amount),
    currency: row.currency,
    applied: row.applied,
    stale: row.stale,
    conflict_code: row.conflict_code,
    created_at: row.created_at.toISOString(),
  };
}

async function readCurrentRefund(
  client: PoolClient,
  order: LockedRefundOrder,
  providerRefundReference: string,
): Promise<RefundRow | null> {
  const result = await client.query<RefundRow>(
    `select * from hpos.refunds
     where provider = $1 and environment = $2 and account_reference = $3
       and provider_refund_reference = $4 and site_id = $5 and order_id = $6
     for update`,
    [order.provider, order.environment, order.account_reference, providerRefundReference, order.site_id, order.order_id],
  );
  return result.rows[0] ?? null;
}

async function refundById(client: PoolClient, siteId: string, refundId: string): Promise<RefundRow | null> {
  const result = await client.query<RefundRow>(
    "select * from hpos.refunds where site_id = $1 and id = $2",
    [siteId, refundId],
  );
  return result.rows[0] ?? null;
}

async function issueForReport(
  client: PoolClient,
  order: LockedRefundOrder,
  reportId: string,
  message: string,
): Promise<void> {
  await client.query(
    `insert into hpos.refund_report_issues (id, site_id, order_id, attempt_id, report_id, code, message)
     values ($1, $2, $3, $4, $5, 'refund_report_conflict', $6)
     on conflict (report_id, code) do nothing`,
    [randomUUID(), order.site_id, order.order_id, order.attempt_id, reportId, message.slice(0, 1000)],
  );
}

async function retainReport(
  client: PoolClient,
  order: LockedRefundOrder,
  input: RefundInput,
  reportFingerprint: string,
  message: string,
): Promise<IdempotentResult> {
  const reportId = randomUUID();
  const inserted = await client.query<RefundReportRow>(
    `insert into hpos.refund_reports (
       id, site_id, order_id, attempt_id, connection_id, source_reference, report_fingerprint,
       provider_payment_reference, provider_refund_reference, outcome, observed_at, amount, currency,
       evidence, applied, stale, conflict_code
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, false, false, 'refund_report_conflict')
     returning *`,
    [reportId, order.site_id, order.order_id, order.attempt_id, input.connection_id,
      input.source_reference, reportFingerprint, input.provider_payment_reference,
      input.provider_refund_reference, input.outcome, input.observed_at, input.amount,
      input.currency, JSON.stringify(input)],
  );
  await issueForReport(client, order, reportId, message);
  const current = await readCurrentRefund(client, order, input.provider_refund_reference);
  return {
    status: 409,
    data: {
      code: "refund_report_conflict",
      message,
      details: [],
      report: reportData(inserted.rows[0]),
      ...(current ? { refund: refundData(current) } : {}),
      order_id: order.order_id,
    },
  };
}

async function retainStaleReport(
  client: PoolClient,
  order: LockedRefundOrder,
  input: RefundInput,
  reportFingerprint: string,
): Promise<IdempotentResult> {
  const reportId = randomUUID();
  const inserted = await client.query<RefundReportRow>(
    `insert into hpos.refund_reports (
       id, site_id, order_id, attempt_id, connection_id, source_reference, report_fingerprint,
       provider_payment_reference, provider_refund_reference, outcome, observed_at, amount, currency,
       evidence, applied, stale
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, false, true)
     returning *`,
    [reportId, order.site_id, order.order_id, order.attempt_id, input.connection_id,
      input.source_reference, reportFingerprint, input.provider_payment_reference,
      input.provider_refund_reference, input.outcome, input.observed_at, input.amount,
      input.currency, JSON.stringify(input)],
  );
  const current = await readCurrentRefund(client, order, input.provider_refund_reference);
  return {
    status: 201,
    data: {
      report_id: reportId,
      applied: false,
      stale: true,
      refund: current ? refundData(current) : null,
      order_id: order.order_id,
      report: reportData(inserted.rows[0]),
    },
  };
}

async function lookupOrderForRefund(
  client: PoolClient,
  siteId: string,
  routeOrderId: string,
  input: RefundInput,
): Promise<LockedRefundOrder> {
  const attemptOwner = await client.query<{ order_id: string; event_id: string }>(
    `select order_row.id as order_id, order_row.event_id
     from hpos.payment_attempts attempt
     join hpos.orders order_row on order_row.id = attempt.order_id and order_row.site_id = attempt.site_id
     where attempt.id = $1 and attempt.site_id = $2`,
    [input.attempt_id, siteId],
  );
  const owner = attemptOwner.rows[0];
  if (!owner) throw new ApiOperationError(404, "not_found", "The Order is not available to this Site.");

  // Admission takes a shared Event lock before locking the Order and Ticket.
  // Taking this lock first serializes a full refund with an in-flight scan.
  const lockedEvent = await client.query(
    "select id from hpos.events where id = $1 and site_id = $2 for update",
    [owner.event_id, siteId],
  );
  if (!lockedEvent.rows[0]) throw new ApiOperationError(404, "not_found", "The Order is not available to this Site.");

  const result = await client.query<LockedRefundOrder>(
    `select order_row.id as order_id, order_row.site_id, order_row.event_id,
            order_row.offering_id, order_row.payment_status, order_row.refund_status,
            event_row.is_canceled, attempt.id as attempt_id, attempt.connection_id,
            attempt.provider, attempt.environment, attempt.account_reference,
            attempt.provider_payment_reference, attempt.last_outcome,
            attempt.total_amount, attempt.currency,
            reservation.id as reservation_id, reservation.status as reservation_status,
            reservation.offering_id as reservation_offering_id
     from hpos.payment_attempts attempt
     join hpos.orders order_row on order_row.id = attempt.order_id and order_row.site_id = attempt.site_id
     join hpos.events event_row on event_row.id = order_row.event_id and event_row.site_id = order_row.site_id
     join hpos.reservations reservation on reservation.order_id = order_row.id and reservation.site_id = order_row.site_id
     where attempt.id = $1 and attempt.site_id = $2
     for update of order_row, attempt, reservation`,
    [input.attempt_id, siteId],
  );
  const order = result.rows[0];
  if (!order) throw new ApiOperationError(404, "not_found", "The Order is not available to this Site.");
  if (order.order_id !== routeOrderId) {
    // Keep the misrouted observation against the attempt's actual Site-owned Order.
    return order;
  }
  return order;
}

async function addRefundReport(
  client: PoolClient,
  site: AuthenticatedSite,
  routeOrderId: string,
  input: RefundInput,
): Promise<IdempotentResult> {
  const connectionResult = await client.query<{ id: string }>(
    "select id from hpos.payment_connections where id = $1",
    [input.connection_id],
  );
  if (!connectionResult.rows[0]) {
    throw new ApiOperationError(404, "not_found", "The refund report connection is not available.");
  }
  const order = await lookupOrderForRefund(client, site.siteId, routeOrderId, input);

  // Refund reports lock in Event -> source-reference -> provider-refund order.
  // The source lock must precede every deduplication read so two Orders in the
  // same Site cannot both accept one provider event concurrently.
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `refund-source:${site.siteId}:${input.connection_id}:${input.source_reference}`,
  ]);
  const reportFingerprint = fingerprint(input);
  const conflict = (message: string) => retainReport(client, order, input, reportFingerprint, message);

  // A retained conflict must replay as a conflict, without attempting to
  // insert the same evidence a second time.
  const duplicate = await client.query<RefundReportRow>(
    `select * from hpos.refund_reports
     where site_id = $1 and attempt_id = $2 and connection_id = $3
       and source_reference = $4 and report_fingerprint = $5`,
    [site.siteId, order.attempt_id, input.connection_id, input.source_reference, reportFingerprint],
  );
  if (duplicate.rows[0]) {
    const previous = duplicate.rows[0];
    const refund = await client.query<RefundRow>(
      `select * from hpos.refunds
       where provider = $1 and environment = $2 and account_reference = $3
         and provider_refund_reference = $4 and site_id = $5 and order_id = $6`,
      [order.provider, order.environment, order.account_reference, input.provider_refund_reference, site.siteId, order.order_id],
    );
    if (order.order_id !== routeOrderId) {
      return {
        status: 409,
        data: {
          code: "refund_report_conflict",
          message: "The refund report Order path does not match the Order that owns the payment attempt.",
          details: [],
          report: reportData(previous),
          order_id: order.order_id,
        },
      };
    }
    if (previous.conflict_code) {
      return {
        status: 409,
        data: {
          code: "refund_report_conflict",
          message: "This provider observation is retained as conflicting refund evidence.",
          details: [],
          report: reportData(previous),
          ...(refund.rows[0] ? { refund: refundData(refund.rows[0]) } : {}),
          order_id: order.order_id,
        },
      };
    }
    return {
      status: 200,
      data: {
        report_id: previous.id,
        applied: previous.applied,
        stale: previous.stale,
        refund: refund.rows[0] ? refundData(refund.rows[0]) : null,
        order_id: order.order_id,
        report: reportData(previous),
      },
    };
  }

  if (order.order_id !== routeOrderId) {
    return conflict("The refund report Order path does not match the Order that owns the payment attempt.");
  }
  if (input.connection_id !== order.connection_id) {
    return conflict("The refund report must use the payment connection frozen on the original attempt.");
  }
  if (input.currency !== order.currency) {
    return conflict("The refund currency does not match the verified payment currency.");
  }
  if (order.provider_payment_reference !== null
    && input.provider_payment_reference !== order.provider_payment_reference) {
    return conflict("The refund report does not match a verified paid provider payment on this Order.");
  }

  const paymentPending = order.last_outcome === null
    || order.last_outcome === "processing"
    || order.last_outcome === "unknown"
    || order.payment_status === "unpaid"
    || order.payment_status === "processing"
    || order.payment_status === "unknown";
  if (order.last_outcome !== "paid" || order.payment_status !== "paid") {
    if (paymentPending) {
      // This exception rolls back the idempotency insert and all report work.
      // The same source and Idempotency-Key can therefore be retried after the
      // payment worker records a verified outcome.
      throw new ApiOperationError(
        503,
        "payment_not_confirmed",
        "The original payment is still being confirmed; retry this refund report after the payment outcome is verified.",
      );
    }
    return conflict("The refund report does not match a verified paid provider payment on this Order.");
  }
  if (input.provider_payment_reference !== order.provider_payment_reference) {
    return conflict("The refund report does not match a verified paid provider payment on this Order.");
  }

  const sameSource = await client.query<{ attempt_id: string; report_fingerprint: string }>(
    `select attempt_id, report_fingerprint from hpos.refund_reports
     where site_id = $1 and connection_id = $2 and source_reference = $3`,
    [site.siteId, input.connection_id, input.source_reference],
  );
  if (sameSource.rows.some((row) => row.attempt_id !== order.attempt_id || row.report_fingerprint !== reportFingerprint)) {
    return conflict("The provider source reference was already recorded with different refund evidence.");
  }

  const totalAmount = safeNumber(order.total_amount);
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `provider-refund:${order.provider}:${order.environment}:${order.account_reference}:${input.provider_refund_reference}`,
  ]);
  const existingResult = await client.query<RefundRow>(
    `select * from hpos.refunds
     where provider = $1 and environment = $2 and account_reference = $3
       and provider_refund_reference = $4
     for update`,
    [order.provider, order.environment, order.account_reference, input.provider_refund_reference],
  );
  const existing = existingResult.rows[0] ?? null;
  if (existing && (existing.site_id !== site.siteId || existing.order_id !== order.order_id
    || existing.attempt_id !== order.attempt_id || existing.connection_id !== order.connection_id
    || existing.provider_payment_reference !== input.provider_payment_reference)) {
    return conflict("This provider refund identity is already attached to a different payment attempt or connection.");
  }
  if (existing && (safeNumber(existing.amount) !== input.amount || existing.currency !== input.currency)) {
    return conflict("The provider refund identity was reported with a different amount or currency.");
  }

  if (existing) {
    const observedAt = Date.parse(input.observed_at);
    const priorObservedAt = existing.observed_at.getTime();
    const older = observedAt < priorObservedAt;
    const sameTime = observedAt === priorObservedAt;
    const priorTerminal = existing.outcome === "completed" || existing.outcome === "failed";
    const nextTerminal = input.outcome === "completed" || input.outcome === "failed";
    const terminalConflict = priorTerminal && nextTerminal && existing.outcome !== input.outcome;
    const completedRegression = existing.outcome === "completed" && input.outcome !== "completed";
    const failedRegression = existing.outcome === "failed" && input.outcome !== "failed";
    if (terminalConflict || ((!older && !sameTime) && (completedRegression || failedRegression))) {
      return conflict("A terminal provider refund outcome conflicts with the existing refund record.");
    }
    if (older || (sameTime && existing.outcome !== input.outcome)
      || completedRegression || failedRegression
      || (existing.outcome === "processing" && input.outcome === "unknown")) {
      return retainStaleReport(client, order, input, reportFingerprint);
    }
    if (sameTime && existing.outcome === input.outcome) {
      const saved = await client.query<RefundReportRow>(
        `insert into hpos.refund_reports (
           id, site_id, order_id, attempt_id, connection_id, source_reference, report_fingerprint,
           provider_payment_reference, provider_refund_reference, outcome, observed_at, amount, currency,
           evidence, applied
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, false)
         returning *`,
        [randomUUID(), site.siteId, order.order_id, order.attempt_id, input.connection_id,
          input.source_reference, reportFingerprint, input.provider_payment_reference,
          input.provider_refund_reference, input.outcome, input.observed_at, input.amount,
          input.currency, JSON.stringify(input)],
      );
      return {
        status: 201,
        data: {
          report_id: saved.rows[0].id,
          applied: false,
          stale: false,
          refund: refundData(existing),
          order_id: order.order_id,
          report: reportData(saved.rows[0]),
        },
      };
    }
  }

  if (input.outcome === "completed") {
    const completedTotal = await client.query<{ amount: string | number }>(
      `select coalesce(sum(amount), 0) as amount from hpos.refunds
       where site_id = $1 and order_id = $2 and outcome = 'completed' and id <> coalesce($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
      [site.siteId, order.order_id, existing?.id ?? null],
    );
    if (safeNumber(completedTotal.rows[0].amount) + input.amount > totalAmount) {
      return conflict("Completed refunds cannot exceed the verified payment amount.");
    }
  }

  const reportId = randomUUID();
  const savedReport = await client.query<RefundReportRow>(
    `insert into hpos.refund_reports (
       id, site_id, order_id, attempt_id, connection_id, source_reference, report_fingerprint,
       provider_payment_reference, provider_refund_reference, outcome, observed_at, amount, currency,
       evidence, applied
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, true)
     returning *`,
    [reportId, site.siteId, order.order_id, order.attempt_id, input.connection_id,
      input.source_reference, reportFingerprint, input.provider_payment_reference,
      input.provider_refund_reference, input.outcome, input.observed_at, input.amount,
      input.currency, JSON.stringify(input)],
  );
  let savedRefund: RefundRow;
  if (existing) {
    const updated = await client.query<RefundRow>(
      `update hpos.refunds
       set outcome = $2, observed_at = $3, updated_at = clock_timestamp()
       where id = $1 and site_id = $4
       returning *`,
      [existing.id, input.outcome, input.observed_at, site.siteId],
    );
    savedRefund = updated.rows[0];
  } else {
    const inserted = await client.query<RefundRow>(
      `insert into hpos.refunds (
         id, site_id, order_id, attempt_id, connection_id, provider, environment, account_reference,
         provider_payment_reference, provider_refund_reference, outcome, amount, currency, observed_at
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       returning *`,
      [randomUUID(), site.siteId, order.order_id, order.attempt_id, order.connection_id,
        order.provider, order.environment, order.account_reference, input.provider_payment_reference,
        input.provider_refund_reference, input.outcome, input.amount, input.currency, input.observed_at],
    );
    savedRefund = inserted.rows[0];
  }

  const totals = await client.query<{ amount: string | number }>(
    `select coalesce(sum(amount), 0) as amount from hpos.refunds
     where site_id = $1 and order_id = $2 and outcome = 'completed'`,
    [site.siteId, order.order_id],
  );
  const completedAmount = safeNumber(totals.rows[0].amount);
  const nextStatus = completedAmount === 0 ? "none" : completedAmount >= totalAmount ? "full" : "partial";
  await client.query(
    `update hpos.orders
     set refund_status = $3, version = version + 1, updated_at = clock_timestamp()
     where id = $1 and site_id = $2`,
    [order.order_id, site.siteId, nextStatus],
  );

  if (nextStatus === "full") {
    const releasedTickets = await client.query<{ offering_id: string }>(
      `update hpos.tickets ticket
       set refund_capacity_released_at = clock_timestamp(), version = version + 1, updated_at = clock_timestamp()
       where ticket.site_id = $1 and ticket.order_id = $2
         and ticket.refund_capacity_released_at is null
         and not exists (
           select 1 from hpos.admissions admission
           where admission.site_id = ticket.site_id and admission.ticket_id = ticket.id
         )
       returning ticket.offering_id`,
      [site.siteId, order.order_id],
    );
    if (releasedTickets.rowCount) {
      const byOffering = new Map<string, number>();
      for (const ticket of releasedTickets.rows) byOffering.set(ticket.offering_id, (byOffering.get(ticket.offering_id) ?? 0) + 1);
      for (const [offeringId, quantity] of byOffering) {
        const capacity = await client.query(
          `update hpos.ticket_offerings
           set reserved_quantity = reserved_quantity - $3
           where id = $1 and site_id = $2 and reserved_quantity >= $3
           returning id`,
          [offeringId, site.siteId, quantity],
        );
        if (capacity.rowCount !== 1) throw new Error("Refunded Ticket capacity could not be restored safely.");
      }
    }
    if (order.reservation_status === "held") {
      const releasedReservation = await client.query<{ quantity: number }>(
        `update hpos.reservations
         set status = 'released', awaiting_provider_verification = false, updated_at = clock_timestamp()
         where id = $1 and site_id = $2 and status = 'held'
         returning quantity`,
        [order.reservation_id, site.siteId],
      );
      const quantity = releasedReservation.rows[0]?.quantity;
      if (quantity !== undefined) {
        const capacity = await client.query(
          `update hpos.ticket_offerings
           set reserved_quantity = reserved_quantity - $3
           where id = $1 and site_id = $2 and reserved_quantity >= $3
           returning id`,
          [order.reservation_offering_id, site.siteId, quantity],
        );
        if (capacity.rowCount !== 1) throw new Error("Refunded Order Reservation capacity could not be restored safely.");
      }
    }
  }

  const current = await refundById(client, site.siteId, savedRefund.id);
  return {
    status: 201,
    data: {
      report_id: savedReport.rows[0].id,
      applied: true,
      stale: false,
      refund: refundData(current ?? savedRefund),
      order_id: order.order_id,
      report: reportData(savedReport.rows[0]),
    },
  };
}

export async function handleRefundReportPost(
  request: Request,
  site: AuthenticatedSite,
  path: string[],
): Promise<Response | null> {
  if (request.method !== "POST" || path.length !== 4 || path[0] !== "admin"
    || path[1] !== "orders" || path[3] !== "refund-reports") return null;
  if (!UUID_PATTERN.test(path[2])) return apiFailure(404, "not_found", "The Order is not available to this Site.");
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  const input = parseInput(body);
  if (input instanceof Response) return input;
  return withApiIdempotency(request, site, body,
    (client) => addRefundReport(client, site, path[2], input));
}
