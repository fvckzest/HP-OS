import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { apiFailure, apiSuccess } from "./api-response";
import { withApiIdempotency } from "./api-idempotency";
import { ApiOperationError } from "./api-idempotency";
import type { IdempotentResult } from "./api-idempotency";
import { getBusinessPool } from "./database";
import { issuePaidOrder } from "./ticket-issuance";
import { paymentAttemptData } from "./payment-attempts";
import type { AttemptRow } from "./payment-attempts";
import type { AuthenticatedSite } from "./site-auth";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const OUTCOMES = new Set(["processing", "paid", "failed", "canceled", "unknown"]);

interface ReportInput {
  connection_id: string;
  source_reference: string;
  provider_checkout_reference: string;
  provider_payment_reference: string | null;
  outcome: "processing" | "paid" | "failed" | "canceled" | "unknown";
  observed_at: string;
  payment_started_at: string | null;
  provider_can_take_payment: boolean | null;
  amount?: number;
  currency?: string;
}

interface LockedAttempt extends AttemptRow {
  issuance_status: "not_started" | "pending" | "issued" | "failed" | "blocked";
  checkout_expired: boolean;
}

interface PaymentReportRow {
  id: string;
  attempt_id: string;
  connection_id: string;
  source_reference: string;
  provider_checkout_reference: string;
  provider_payment_reference: string | null;
  outcome: ReportInput["outcome"];
  observed_at: Date;
  payment_started_at: Date | null;
  provider_can_take_payment: boolean | null;
  amount: string | null;
  currency: string | null;
  applied: boolean;
  conflict_code: string | null;
  created_at: Date;
}

interface PaymentIssueRow {
  issue_id: string;
  order_id: string;
  attempt_id: string;
  report_id: string;
  code: string;
  status: "open" | "resolved";
  message: string;
  created_at: Date;
  resolved_at: Date | null;
  resolution_id: string | null;
  actor_type: "user" | "system" | null;
  actor_reference: string | null;
  reason: string | null;
  verification_reference: string | null;
  previous_version: number | null;
  new_version: number | null;
  resolution_created_at: Date | null;
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && RFC3339_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

function validReference(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 500
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function parseInput(value: Record<string, unknown>): ReportInput | Response {
  const allowed = ["connection_id", "source_reference", "provider_checkout_reference", "provider_payment_reference",
    "outcome", "observed_at", "payment_started_at", "provider_can_take_payment", "amount", "currency"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    return apiFailure(422, "validation_failed", "A payment report contains an unsupported field.");
  }
  const required = ["connection_id", "source_reference", "provider_checkout_reference", "provider_payment_reference",
    "outcome", "observed_at", "payment_started_at", "provider_can_take_payment"];
  if (required.some((key) => !Object.hasOwn(value, key))) {
    return apiFailure(422, "validation_failed", "A payment report must include every required field, using null for unknown values.");
  }
  if (typeof value.connection_id !== "string" || !UUID_PATTERN.test(value.connection_id)) {
    return apiFailure(422, "validation_failed", "connection_id must be a UUID.");
  }
  if (!validReference(value.source_reference) || !validReference(value.provider_checkout_reference)) {
    return apiFailure(422, "validation_failed", "Provide stable source and provider checkout references of at most 500 characters.");
  }
  if (value.provider_payment_reference !== null && !validReference(value.provider_payment_reference)) {
    return apiFailure(422, "validation_failed", "provider_payment_reference must be a provider reference or null.");
  }
  if (typeof value.outcome !== "string" || !OUTCOMES.has(value.outcome)) {
    return apiFailure(422, "validation_failed", "outcome must be processing, paid, failed, canceled, or unknown.");
  }
  if (!validTimestamp(value.observed_at) || (value.payment_started_at !== null && !validTimestamp(value.payment_started_at))) {
    return apiFailure(422, "validation_failed", "Payment report timestamps must be RFC 3339 values with an explicit offset, or null where allowed.");
  }
  if (value.provider_can_take_payment !== null && typeof value.provider_can_take_payment !== "boolean") {
    return apiFailure(422, "validation_failed", "provider_can_take_payment must be true, false, or null.");
  }
  const hasAmount = Object.hasOwn(value, "amount");
  const hasCurrency = Object.hasOwn(value, "currency");
  if (hasAmount !== hasCurrency) return apiFailure(422, "validation_failed", "amount and currency must be provided together.");
  if (hasAmount && (!Number.isSafeInteger(value.amount) || Number(value.amount) < 0
    || typeof value.currency !== "string" || !/^[A-Z]{3}$/.test(value.currency))) {
    return apiFailure(422, "validation_failed", "amount must be a nonnegative safe integer and currency an uppercase three-letter code.");
  }
  if (value.outcome === "paid" && (!hasAmount || Number(value.amount) < 1 || value.provider_payment_reference === null)) {
    return apiFailure(422, "validation_failed", "A paid report requires a provider payment reference and positive amount and currency.");
  }
  return {
    connection_id: value.connection_id,
    source_reference: value.source_reference.trim(),
    provider_checkout_reference: value.provider_checkout_reference.trim(),
    provider_payment_reference: value.provider_payment_reference === null ? null : value.provider_payment_reference.trim(),
    outcome: value.outcome as ReportInput["outcome"],
    observed_at: value.observed_at,
    payment_started_at: value.payment_started_at as string | null,
    provider_can_take_payment: value.provider_can_take_payment as boolean | null,
    ...(hasAmount ? { amount: value.amount as number, currency: value.currency as string } : {}),
  };
}

interface ResolutionInput {
  actor: { type: "user" | "system"; reference: string };
  expected_version: number;
  reason: string;
  verification_reference: string;
  report: ReportInput;
}

function parseResolutionInput(value: Record<string, unknown>): ResolutionInput | Response {
  const allowed = ["actor", "expected_version", "reason", "verification_reference", "report"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    return apiFailure(422, "validation_failed", "A payment resolution contains an unsupported field.");
  }
  if (!object(value.actor) || Object.keys(value.actor).some((key) => !["type", "reference"].includes(key))
    || (value.actor.type !== "user" && value.actor.type !== "system")
    || !validReference(value.actor.reference) || value.actor.reference.length > 200) {
    return apiFailure(422, "validation_failed", "Provide a non-secret Site-local actor reference.", {
      details: [{ field: "actor", code: "invalid_actor", message: "actor must contain type and reference." }],
    });
  }
  if (!Number.isSafeInteger(value.expected_version) || Number(value.expected_version) < 1) {
    return apiFailure(422, "validation_failed", "expected_version must be a positive integer.", {
      details: [{ field: "expected_version", code: "required", message: "Use the current payment-attempt version." }],
    });
  }
  if (!validReference(value.reason) || value.reason.length > 1000) {
    return apiFailure(422, "validation_failed", "reason must be a non-secret explanation of the staff decision.", {
      details: [{ field: "reason", code: "invalid_reason", message: "Provide a reason of at most 1000 characters." }],
    });
  }
  if (!validReference(value.verification_reference)) {
    return apiFailure(422, "validation_failed", "verification_reference must identify non-secret verification evidence.", {
      details: [{ field: "verification_reference", code: "invalid_reference", message: "Provide a non-secret evidence reference of at most 500 characters." }],
    });
  }
  if (!object(value.report)) {
    return apiFailure(422, "validation_failed", "report must contain a verified payment observation.", {
      details: [{ field: "report", code: "required", message: "Provide the corrected payment report." }],
    });
  }
  const report = parseInput(value.report);
  if (report instanceof Response) return report;
  return {
    actor: { type: value.actor.type, reference: value.actor.reference.trim() },
    expected_version: Number(value.expected_version),
    reason: value.reason.trim(),
    verification_reference: value.verification_reference.trim(),
    report,
  };
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | Response> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return apiFailure(415, "unsupported_media_type", "Send payment-resolution fields as application/json.");
  }
  let bodyText: string;
  try { bodyText = await request.text(); }
  catch { return apiFailure(400, "invalid_request", "The payment-resolution body could not be read."); }
  if (Buffer.byteLength(bodyText, "utf8") > 64 * 1024) return apiFailure(413, "request_too_large", "The request body exceeds 64 KiB.");
  let body: unknown;
  try { body = JSON.parse(bodyText); }
  catch { return apiFailure(400, "invalid_request", "The payment-resolution body must contain readable JSON."); }
  if (!object(body)) return apiFailure(400, "invalid_request", "The payment-resolution body must be a JSON object.");
  return body;
}

function fingerprint(input: ReportInput): string {
  return createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex");
}

function reportResult(reportId: string, applied: boolean, attempt: LockedAttempt, orderId: string): IdempotentResult {
  return { status: 201, data: { report_id: reportId, applied, attempt: paymentAttemptData(attempt), order_id: orderId } };
}

function paymentReportData(row: PaymentReportRow) {
  return {
    report_id: row.id,
    attempt_id: row.attempt_id,
    connection_id: row.connection_id,
    source_reference: row.source_reference,
    provider_checkout_reference: row.provider_checkout_reference,
    provider_payment_reference: row.provider_payment_reference,
    outcome: row.outcome,
    observed_at: row.observed_at.toISOString(),
    payment_started_at: row.payment_started_at?.toISOString() ?? null,
    provider_can_take_payment: row.provider_can_take_payment,
    amount: row.amount === null ? null : Number(row.amount),
    currency: row.currency,
    applied: row.applied,
    conflict_code: row.conflict_code,
    created_at: row.created_at.toISOString(),
  };
}

function paymentIssueData(row: PaymentIssueRow) {
  return {
    issue_id: row.issue_id,
    order_id: row.order_id,
    attempt_id: row.attempt_id,
    report_id: row.report_id,
    code: row.code,
    status: row.status,
    message: row.message,
    created_at: row.created_at.toISOString(),
    resolved_at: row.resolved_at?.toISOString() ?? null,
    resolution: row.resolution_id ? {
      resolution_id: row.resolution_id,
      actor: { type: row.actor_type, reference: row.actor_reference },
      reason: row.reason,
      verification_reference: row.verification_reference,
      previous_version: row.previous_version,
      new_version: row.new_version,
      created_at: row.resolution_created_at?.toISOString() ?? null,
    } : null,
  };
}

async function paymentInvestigationData(client: PoolClient, siteId: string, attempt: LockedAttempt) {
  const reports = await client.query<PaymentReportRow>(
    `select id, attempt_id, connection_id, source_reference, provider_checkout_reference,
            provider_payment_reference, outcome, observed_at, payment_started_at,
            provider_can_take_payment, amount, currency, applied, conflict_code, created_at
     from hpos.payment_attempt_reports
     where site_id = $1 and attempt_id = $2
     order by observed_at desc, created_at desc, id desc`,
    [siteId, attempt.id],
  );
  const issues = await client.query<PaymentIssueRow>(
    `select issue.id as issue_id, issue.order_id, issue.attempt_id, issue.report_id,
            issue.code, issue.status, issue.message, issue.created_at, issue.resolved_at,
            resolution.id as resolution_id, resolution.actor_type, resolution.actor_reference,
            resolution.reason, resolution.verification_reference, resolution.previous_version,
            resolution.new_version, resolution.created_at as resolution_created_at
     from hpos.payment_report_issues issue
     left join hpos.payment_report_issue_resolutions resolution
       on resolution.issue_id = issue.id and resolution.site_id = issue.site_id
     where issue.site_id = $1 and issue.attempt_id = $2
     order by issue.created_at desc, issue.id desc`,
    [siteId, attempt.id],
  );
  return {
    reports: reports.rows.map(paymentReportData),
    issues: issues.rows.map(paymentIssueData),
  };
}

async function lockAttempt(client: PoolClient, siteId: string, attemptId: string): Promise<LockedAttempt | null> {
  const result = await client.query<LockedAttempt>(
    `select attempt.*, order_row.checkout_status, order_row.checkout_expires_at,
            order_row.payment_status, order_row.issuance_status,
            reservation.status as reservation_status,
            order_row.checkout_expires_at <= clock_timestamp() as checkout_expired
     from hpos.payment_attempts attempt
     join hpos.orders order_row on order_row.id = attempt.order_id and order_row.site_id = attempt.site_id
     join hpos.reservations reservation on reservation.order_id = order_row.id and reservation.site_id = order_row.site_id
     where attempt.id = $1 and attempt.site_id = $2
     for update of attempt, order_row, reservation`,
    [attemptId, siteId],
  );
  return result.rows[0] ?? null;
}

async function addConflictIssue(client: PoolClient, attempt: LockedAttempt, reportId: string, message: string): Promise<void> {
  await client.query(
    `insert into hpos.payment_report_issues
       (id, site_id, order_id, attempt_id, report_id, code, message)
     values ($1, $2, $3, $4, $5, 'payment_report_conflict', $6)
     on conflict (report_id, code) do nothing`,
    [randomUUID(), attempt.site_id, attempt.order_id, attempt.id, reportId, message.slice(0, 1000)],
  );
}

async function retainReport(
  client: PoolClient,
  attempt: LockedAttempt,
  input: ReportInput,
  inputFingerprint: string,
  conflictMessage: string,
): Promise<IdempotentResult> {
  const reportId = randomUUID();
  await client.query(
    `insert into hpos.payment_attempt_reports (
       id, site_id, attempt_id, connection_id, source_reference, report_fingerprint,
       provider_checkout_reference, provider_payment_reference, outcome, observed_at,
       payment_started_at, provider_can_take_payment, amount, currency, evidence,
       applied, conflict_code
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, false, 'payment_report_conflict')`,
    [reportId, attempt.site_id, attempt.id, attempt.connection_id, input.source_reference, inputFingerprint,
      input.provider_checkout_reference, input.provider_payment_reference, input.outcome, input.observed_at,
      input.payment_started_at, input.provider_can_take_payment, input.amount ?? null, input.currency ?? null,
      JSON.stringify({ ...input, connection_id: input.connection_id })],
  );
  await addConflictIssue(client, attempt, reportId, conflictMessage);
  await client.query(
    `update hpos.orders
     set payment_status = case when issuance_status = 'issued' then payment_status else 'conflicted' end,
         version = version + 1, updated_at = clock_timestamp()
     where id = $1 and site_id = $2`,
    [attempt.order_id, attempt.site_id],
  );
  await client.query(
    `update hpos.payment_attempts
     set status = 'requires_verification', version = version + 1, updated_at = clock_timestamp()
     where id = $1 and site_id = $2`,
    [attempt.id, attempt.site_id],
  );
  const refreshed = await lockAttempt(client, attempt.site_id, attempt.id);
  return { status: 409, data: {
    code: "payment_report_conflict",
    message: conflictMessage,
    details: [],
    ...(refreshed ? { report_id: reportId, attempt: paymentAttemptData(refreshed), order_id: attempt.order_id } : {}),
  } };
}

async function releaseExpiredReservation(client: PoolClient, attempt: LockedAttempt): Promise<void> {
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
  if (capacity.rowCount !== 1) throw new Error("The expired payment Reservation could not be released safely.");
}

async function createPaymentReport(
  client: PoolClient,
  site: AuthenticatedSite,
  attemptId: string,
  input: ReportInput,
): Promise<IdempotentResult> {
  const attempt = await lockAttempt(client, site.siteId, attemptId);
  if (!attempt) throw new ApiOperationError(404, "not_found", "The payment attempt is not available to this Site.");

  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `${site.siteId}:${attempt.connection_id}:${input.source_reference}`,
  ]);
  const inputFingerprint = fingerprint(input);
  const existing = await client.query<{
    id: string;
    attempt_id: string;
    report_fingerprint: string;
    applied: boolean;
  }>(
    `select id, attempt_id, report_fingerprint, applied
     from hpos.payment_attempt_reports
     where site_id = $1 and connection_id = $2 and source_reference = $3
     order by (attempt_id = $4 and report_fingerprint = $5) desc,
              (attempt_id = $4) desc, created_at asc, id asc limit 1`,
    [site.siteId, attempt.connection_id, input.source_reference, attempt.id, inputFingerprint],
  );
  if (existing.rows[0]?.attempt_id === attempt.id && existing.rows[0]?.report_fingerprint === inputFingerprint) {
    return { status: 200, data: { report_id: existing.rows[0].id, applied: existing.rows[0].applied,
      attempt: paymentAttemptData(attempt), order_id: attempt.order_id } };
  }
  if (existing.rows[0]) {
    return retainReport(client, attempt, input, inputFingerprint,
      existing.rows[0].attempt_id === attempt.id
        ? "A provider source reference was reused with different payment evidence."
        : "A provider source reference is already associated with a different payment attempt.");
  }

  let conflict = input.connection_id !== attempt.connection_id
    ? "The report connection does not match the connection frozen on this Order."
    : !attempt.provider_checkout_reference || input.provider_checkout_reference !== attempt.provider_checkout_reference
      ? "The report checkout reference does not match the checkout recorded on this payment attempt."
      : attempt.provider_payment_reference !== null && input.provider_payment_reference !== null
        && input.provider_payment_reference !== attempt.provider_payment_reference
        ? "The report payment reference conflicts with the payment already recorded for this attempt."
        : input.amount !== undefined && (input.amount !== Number(attempt.total_amount) || input.currency !== attempt.currency)
          ? "The reported amount or currency does not match the total frozen on this Order."
          : null;

  if (!conflict && input.provider_payment_reference !== null) {
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `provider-payment:${attempt.connection_id}:${input.provider_payment_reference}`,
    ]);
    const paymentOwner = await client.query<{ id: string }>(
      `select id from hpos.payment_attempts
       where connection_id = $1 and provider_payment_reference = $2 and id <> $3
       limit 1`,
      [attempt.connection_id, input.provider_payment_reference, attempt.id],
    );
    if (paymentOwner.rows[0]) {
      conflict = "The provider payment reference is already recorded for a different payment attempt.";
    }
  }
  if (conflict) return retainReport(client, attempt, input, inputFingerprint, conflict);

  const reportId = randomUUID();
  await client.query(
    `insert into hpos.payment_attempt_reports (
       id, site_id, attempt_id, connection_id, source_reference, report_fingerprint,
       provider_checkout_reference, provider_payment_reference, outcome, observed_at,
       payment_started_at, provider_can_take_payment, amount, currency, evidence
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)`,
    [reportId, site.siteId, attempt.id, attempt.connection_id, input.source_reference, inputFingerprint,
      input.provider_checkout_reference, input.provider_payment_reference, input.outcome, input.observed_at,
      input.payment_started_at, input.provider_can_take_payment, input.amount ?? null, input.currency ?? null,
      JSON.stringify(input)],
  );

  const latest = await client.query<{ observed_at: Date }>(
    `select observed_at from hpos.payment_attempt_reports
     where site_id = $1 and attempt_id = $2 and applied and conflict_code is null
     order by observed_at desc, created_at desc, id desc limit 1`,
    [site.siteId, attempt.id],
  );
  const staleNonPaid = input.outcome !== "paid" && (
    attempt.payment_status === "paid"
    || (latest.rows[0] && latest.rows[0].observed_at.getTime() > Date.parse(input.observed_at))
  );
  if (staleNonPaid) {
    const refreshed = await lockAttempt(client, site.siteId, attempt.id);
    return reportResult(reportId, false, refreshed ?? attempt, attempt.order_id);
  }

  const nextAttemptStatus = input.outcome === "paid" ? "closed"
    : input.outcome === "failed" || input.outcome === "canceled"
      ? input.provider_can_take_payment === false ? "closed" : input.provider_can_take_payment === true ? "open" : "requires_verification"
      : input.outcome === "processing" && input.provider_can_take_payment === true ? "open" : "requires_verification";
  const paymentCanContinue = input.outcome !== "paid" && input.provider_can_take_payment === true;
  const nextProviderCanTakePayment = input.outcome === "paid" ? false : input.provider_can_take_payment;
  const updatedAttempt = await client.query<AttemptRow>(
    `update hpos.payment_attempts
     set provider_payment_reference = coalesce($3, provider_payment_reference),
         last_outcome = $4, provider_can_take_payment = $5, status = $6,
         version = version + 1, updated_at = clock_timestamp()
     where id = $1 and site_id = $2 returning *`,
    [attempt.id, site.siteId, input.provider_payment_reference, input.outcome, nextProviderCanTakePayment, nextAttemptStatus],
  );
  const nextPaymentStatus = input.outcome === "paid" ? "paid"
    : input.outcome === "processing" ? "processing"
      : input.outcome === "unknown" ? "unknown" : "failed";
  const nextCheckoutStatus = input.outcome === "paid" ? "ended"
    : input.outcome === "failed" || input.outcome === "canceled"
      ? input.provider_can_take_payment === false ? attempt.checkout_expired ? "expired" : "active" : "awaiting_payment_result"
      : "awaiting_payment_result";
  await client.query(
    `update hpos.orders
     set payment_status = $3, checkout_status = $4,
         issuance_status = case when $3 = 'paid' and issuance_status = 'not_started' then 'pending' else issuance_status end,
         version = version + 1, updated_at = clock_timestamp()
     where id = $1 and site_id = $2`,
    [attempt.order_id, site.siteId, nextPaymentStatus, nextCheckoutStatus],
  );
  await client.query(
    `update hpos.reservations
     set awaiting_provider_verification = $3, updated_at = clock_timestamp()
     where order_id = $1 and site_id = $2 and status = 'held'`,
    [attempt.order_id, site.siteId, input.outcome === "paid" ? false : paymentCanContinue || input.outcome === "processing" || input.outcome === "unknown" || input.provider_can_take_payment === null],
  );
  if ((input.outcome === "failed" || input.outcome === "canceled") && input.provider_can_take_payment === false && attempt.checkout_expired) {
    await releaseExpiredReservation(client, attempt);
  }
  await client.query(
    `update hpos.payment_attempt_reports
     set applied = true
     where id = $1 and site_id = $2`,
    [reportId, site.siteId],
  );
  const refreshed = await lockAttempt(client, site.siteId, attempt.id);
  return reportResult(reportId, true, refreshed ?? { ...attempt, ...updatedAttempt.rows[0] }, attempt.order_id);
}

async function resolvePaymentConflict(
  client: PoolClient,
  site: AuthenticatedSite,
  attemptId: string,
  input: ResolutionInput,
): Promise<IdempotentResult> {
  const attempt = await lockAttempt(client, site.siteId, attemptId);
  if (!attempt) throw new ApiOperationError(404, "not_found", "The payment attempt is not available to this Site.");
  if (attempt.version !== input.expected_version) {
    throw new ApiOperationError(409, "version_conflict", "The payment attempt changed after staff loaded it. Reload the investigation before resolving it.");
  }

  const openIssues = await client.query<{ id: string }>(
    `select id
     from hpos.payment_report_issues
     where site_id = $1 and attempt_id = $2 and code = 'payment_report_conflict' and status = 'open'
     order by created_at asc, id asc
     for update`,
    [site.siteId, attempt.id],
  );
  if (openIssues.rowCount === 0) {
    throw new ApiOperationError(409, "invalid_state", "This payment attempt has no open payment conflict to resolve.");
  }

  const reusedSource = await client.query<{ id: string }>(
    `select id
     from hpos.payment_attempt_reports
     where site_id = $1 and connection_id = $2 and source_reference = $3
     limit 1`,
    [site.siteId, attempt.connection_id, input.report.source_reference],
  );
  if (reusedSource.rowCount !== 0) {
    throw new ApiOperationError(409, "payment_report_conflict", "A guarded resolution must use a new provider source reference.");
  }

  const result = await createPaymentReport(client, site, attempt.id, input.report);
  if (result.status !== 201 || !object(result.data)) return result;
  const reportId = result.data.report_id;
  if (typeof reportId !== "string" || result.data.applied !== true) return result;

  const resolvedAt = new Date();
  const resolvedIssueIds: string[] = [];
  for (const issue of openIssues.rows) {
    const updated = await client.query<{ id: string }>(
      `update hpos.payment_report_issues
       set status = 'resolved', resolved_at = $3
       where id = $1 and site_id = $2 and status = 'open'
       returning id`,
      [issue.id, site.siteId, resolvedAt],
    );
    if (updated.rowCount !== 1) {
      throw new ApiOperationError(409, "request_in_progress", "The payment conflict changed while it was being resolved.");
    }
    await client.query(
      `insert into hpos.payment_report_issue_resolutions (
         id, site_id, issue_id, order_id, attempt_id, report_id,
         actor_type, actor_reference, reason, verification_reference,
         previous_version, new_version
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [randomUUID(), site.siteId, issue.id, attempt.order_id, attempt.id, reportId,
        input.actor.type, input.actor.reference, input.reason, input.verification_reference,
        input.expected_version, input.expected_version + 1],
    );
    resolvedIssueIds.push(issue.id);
  }

  return {
    status: 200,
    data: {
      report_id: reportId,
      applied: true,
      attempt: result.data.attempt,
      order_id: attempt.order_id,
      resolved_issue_ids: resolvedIssueIds,
    },
  };
}

async function maybeIssuePaidOrder(response: Response, site: AuthenticatedSite): Promise<void> {
  if (!response.ok) return;
  try {
    const payload = await response.clone().json() as {
      data?: { attempt?: { last_outcome?: string }; order_id?: string };
    };
    if (payload.data?.attempt?.last_outcome === "paid" && payload.data.order_id) {
      await issuePaidOrder(site.siteId, payload.data.order_id);
    }
  } catch { /* The durable scheduler will retry any paid Order still awaiting issuance. */ }
}

export async function handlePaymentReportPost(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (request.method !== "POST" || path.length !== 4 || path[0] !== "admin"
    || path[1] !== "payment-attempts" || path[3] !== "payment-reports") return null;
  if (!UUID_PATTERN.test(path[2])) return apiFailure(404, "not_found", "The payment attempt is not available to this Site.");
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return apiFailure(415, "unsupported_media_type", "Send payment-report fields as application/json.");
  }
  let bodyText: string;
  try { bodyText = await request.text(); }
  catch { return apiFailure(400, "invalid_request", "The payment-report body could not be read."); }
  if (Buffer.byteLength(bodyText, "utf8") > 64 * 1024) return apiFailure(413, "request_too_large", "The request body exceeds 64 KiB.");
  let body: unknown;
  try { body = JSON.parse(bodyText); }
  catch { return apiFailure(400, "invalid_request", "The payment-report body must contain readable JSON."); }
  if (!object(body)) return apiFailure(400, "invalid_request", "The payment-report body must be a JSON object.");
  const input = parseInput(body);
  if (input instanceof Response) return input;

  const response = await withApiIdempotency(request, site, body,
    (client) => createPaymentReport(client, site, path[2], input));
  await maybeIssuePaidOrder(response, site);
  return response;
}

export async function handlePaymentResolutionPost(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (request.method !== "POST" || path.length !== 5 || path[0] !== "admin"
    || path[1] !== "payment-attempts" || path[3] !== "actions" || path[4] !== "resolve") return null;
  if (!UUID_PATTERN.test(path[2])) return apiFailure(404, "not_found", "The payment attempt is not available to this Site.");
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  const input = parseResolutionInput(body);
  if (input instanceof Response) return input;

  const response = await withApiIdempotency(request, site, body,
    (client) => resolvePaymentConflict(client, site, path[2], input));
  await maybeIssuePaidOrder(response, site);
  return response;
}

export async function handlePaymentInvestigationGet(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (request.method !== "GET" || path.length !== 3 || path[0] !== "admin"
    || path[1] !== "payment-attempts" || !UUID_PATTERN.test(path[2])) return null;
  const client = await getBusinessPool().connect();
  try {
    const result = await client.query<LockedAttempt>(
      `select attempt.*, order_row.checkout_status, order_row.checkout_expires_at,
              order_row.payment_status, order_row.issuance_status,
              reservation.status as reservation_status,
              order_row.checkout_expires_at <= clock_timestamp() as checkout_expired
       from hpos.payment_attempts attempt
       join hpos.orders order_row on order_row.id = attempt.order_id and order_row.site_id = attempt.site_id
       join hpos.reservations reservation on reservation.order_id = order_row.id and reservation.site_id = order_row.site_id
       where attempt.id = $1 and attempt.site_id = $2`,
      [path[2], site.siteId],
    );
    const attempt = result.rows[0];
    if (!attempt) return apiFailure(404, "not_found", "The payment attempt is not available to this Site.");
    const investigation = await paymentInvestigationData(client, site.siteId, attempt);
    return apiSuccess({
      ...paymentAttemptData(attempt),
      checkout_status: attempt.checkout_status,
      checkout_expires_at: attempt.checkout_expires_at.toISOString(),
      payment_status: attempt.payment_status,
      issuance_status: attempt.issuance_status,
      reservation_status: attempt.reservation_status,
      requires_verification: attempt.status === "requires_verification"
        || (attempt.checkout_expired && attempt.status !== "closed" && attempt.provider_can_take_payment !== false),
      ...investigation,
    });
  } finally {
    client.release();
  }
}
