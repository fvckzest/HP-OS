import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { apiFailure, apiSuccess } from "./api-response";
import { ApiOperationError, withApiIdempotency } from "./api-idempotency";
import type { IdempotentResult } from "./api-idempotency";
import { getBusinessPool } from "./database";
import { publicEventData } from "./events";
import { enqueueNotificationJob, supersedeUnsentNotificationJobs } from "./notifications";
import type { AuthenticatedSite } from "./site-auth";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_ISSUANCE_BATCH = 50;
const MAX_BODY_BYTES = 64 * 1024;

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

interface EventRow extends QueryResultRow {
  id: string;
  site_id: string;
  ticket_offering_id: string;
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
  version: number;
  created_at: Date;
  updated_at: Date;
  created_actor_type: "user" | "system";
  created_actor_reference: string;
  updated_actor_type: "user" | "system";
  updated_actor_reference: string;
  price_amount: string | null;
  currency: string | null;
  tax_amount: string | null;
  buyer_fees: Array<{ code: string; label: string; amount: number; currency: string }> | null;
  capacity: string | null;
  reserved_quantity: string;
  sales_opens_at: Date | null;
  sales_opens_offset_minutes: number | null;
  sales_closes_at: Date | null;
  sales_closes_offset_minutes: number | null;
}

interface IssuanceRow extends EventRow {
  order_id: string;
  event_id: string;
  buyer_id: string;
  quote_id: string;
  order_reference: string;
  buyer_name: string;
  delivery_email: string;
  checkout_identity: Record<string, unknown>;
  order_token: string | null;
  quantity: number;
  accepted_quote: Record<string, unknown>;
  checkout_status: "active" | "awaiting_payment_result" | "expired" | "ended";
  payment_status: "unpaid" | "processing" | "paid" | "failed" | "unknown" | "conflicted";
  issuance_status: "not_started" | "pending" | "issued" | "failed" | "blocked";
  delivery_status: "not_sent" | "pending" | "sent" | "delivered" | "failed";
  refund_status: "none" | "partial" | "full";
  checkout_expires_at: Date;
  order_created_at: Date;
  order_updated_at: Date;
  order_version: number;
  reservation_id: string;
  reservation_status: "held" | "consumed" | "released";
  reservation_expires_at: Date;
  awaiting_provider_verification: boolean;
}

interface TicketRow extends QueryResultRow {
  ticket_id: string;
  ticket_token: string;
  ordinal: number;
  issued_at: Date;
  qr_payload: string;
  attendee_name: string | null;
  admission_id: string | null;
  admitted_at: Date | null;
  version: number;
}

function hashToken(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function actor(value: unknown): { type: "user" | "system"; reference: string } | null {
  if (!object(value) || !hasOnlyKeys(value, ["type", "reference"])) return null;
  if ((value.type !== "user" && value.type !== "system") || typeof value.reference !== "string") return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value.reference)) return null;
  return { type: value.type, reference: value.reference.trim() };
}

function expectedVersion(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function recoveryEmail(value: unknown): { email: string; normalizedEmail: string } | null {
  if (typeof value !== "string") return null;
  const email = value.trim();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return { email, normalizedEmail: email.toLowerCase() };
}

function recoveryText(value: unknown, maximum = 500): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value);
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | Response> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return apiFailure(415, "unsupported_media_type", "Send recovery action fields as application/json.");
  }
  let text: string;
  try { text = await request.text(); }
  catch { return apiFailure(400, "invalid_request", "The recovery action body could not be read."); }
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return apiFailure(413, "request_too_large", "The request body exceeds 64 KiB.");
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return apiFailure(400, "invalid_request", "The recovery action body must contain readable JSON."); }
  if (!object(value)) return apiFailure(400, "invalid_request", "The recovery action body must be a JSON object.");
  return value;
}

function money(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return Number.isSafeInteger(Number(row.amount)) && typeof row.currency === "string"
    ? { amount: Number(row.amount), currency: row.currency }
    : null;
}

function eventNotificationDetails(event: Record<string, unknown>, eventId: string) {
  const venue = event.venue as { name?: unknown; address?: unknown } | undefined;
  if (typeof event.title !== "string" || typeof event.starts_at !== "string"
    || typeof event.ends_at !== "string" || typeof event.time_zone !== "string"
    || typeof venue?.name !== "string") {
    throw new Error("The paid Order Event is missing required notification details.");
  }
  return {
    event_id: eventId,
    event_reference: `event-${eventId.slice(0, 8)}`,
    title: event.title,
    starts_at: event.starts_at,
    ends_at: event.ends_at,
    time_zone: event.time_zone,
    venue: { name: venue.name, address: typeof venue.address === "string" ? venue.address : null },
  };
}

async function addIssuanceIssue(
  client: PoolClient,
  row: IssuanceRow,
  reportId: string | null,
  code: "reservation_already_released" | "event_canceled" | "order_token_missing" | "order_fully_refunded" | "ticket_issuance_failed",
  message: string,
): Promise<void> {
  if (!reportId) return;
  await client.query(
    `insert into hpos.payment_report_issues
       (id, site_id, order_id, attempt_id, report_id, code, message)
     values ($1, $2, $3, (select attempt_id from hpos.payment_attempt_reports where id = $4), $4, $5, $6)
     on conflict (report_id, code) do nothing`,
    [randomUUID(), row.site_id, row.order_id, reportId, code, message],
  );
}

async function latestPaidReport(client: PoolClient, siteId: string, orderId: string): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `select report.id
     from hpos.payment_attempt_reports report
     join hpos.payment_attempts attempt on attempt.id = report.attempt_id and attempt.site_id = report.site_id
     where report.site_id = $1 and attempt.order_id = $2 and report.outcome = 'paid' and report.conflict_code is null
     order by report.observed_at desc, report.created_at desc, report.id desc
     limit 1`,
    [siteId, orderId],
  );
  return result.rows[0]?.id ?? null;
}

async function recordIssuanceFailure(siteId: string, orderId: string): Promise<void> {
  const pool = getBusinessPool();
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local lock_timeout = '2s'");
    const row = await readIssuanceRow(client, siteId, orderId);
    if (!row || row.payment_status !== "paid" || !["pending", "failed"].includes(row.issuance_status)) {
      await client.query("commit");
      return;
    }
    const tickets = await client.query<{ count: number }>(
      `select count(*)::integer as count from hpos.tickets where site_id = $1 and order_id = $2`,
      [siteId, orderId],
    );
    if ((tickets.rows[0]?.count ?? 0) > 0) {
      await client.query("commit");
      return;
    }
    const reportId = await latestPaidReport(client, siteId, orderId);
    if (!reportId) {
      await client.query("commit");
      return;
    }
    await client.query(
      `insert into hpos.payment_report_issues
         (id, site_id, order_id, attempt_id, report_id, code, message)
       values ($1, $2, $3, (select attempt_id from hpos.payment_attempt_reports where id = $4), $4,
         'ticket_issuance_failed',
         'Confirmed payment is retained, but Ticket issuance did not complete. Retry the guarded recovery action after checking the Order.')
       on conflict (report_id, code) do update
         set status = 'open', resolved_at = null`,
      [randomUUID(), siteId, orderId, reportId],
    );
    await client.query("commit");
  } catch {
    await client.query("rollback").catch(() => undefined);
  } finally {
    client.release();
  }
}

async function readIssuanceRow(client: PoolClient, siteId: string, orderId: string): Promise<IssuanceRow | null> {
  const result = await client.query<IssuanceRow>(
    `select order_row.id as order_id, event_row.id, order_row.buyer_id, order_row.quote_id, order_row.site_id, order_row.event_id,
            order_row.offering_id as ticket_offering_id, order_row.order_reference,
            order_row.buyer_name, order_row.delivery_email, order_row.checkout_identity, order_row.order_token,
            order_row.accepted_quote, quote.quantity, order_row.checkout_status,
            order_row.payment_status, order_row.issuance_status, order_row.delivery_status,
            order_row.refund_status, order_row.checkout_expires_at,
            order_row.created_at as order_created_at, order_row.updated_at as order_updated_at,
            order_row.version as order_version,
            reservation.id as reservation_id, reservation.status as reservation_status,
            reservation.expires_at as reservation_expires_at, reservation.awaiting_provider_verification,
            event_row.title, event_row.description, event_row.venue_name, event_row.venue_address,
            event_row.starts_at, event_row.starts_at_offset_minutes, event_row.ends_at,
            event_row.ends_at_offset_minutes, event_row.time_zone, event_row.check_in_opens_at,
            event_row.check_in_opens_offset_minutes, event_row.visibility,
            event_row.publication_status, event_row.is_canceled, event_row.is_archived,
            event_row.sales_paused, event_row.version, event_row.created_at, event_row.updated_at,
            event_row.created_actor_type, event_row.created_actor_reference,
            event_row.updated_actor_type, event_row.updated_actor_reference,
            offering.price_amount, offering.currency, offering.tax_amount, offering.buyer_fees,
            offering.capacity, offering.reserved_quantity, offering.sales_opens_at,
            offering.sales_opens_offset_minutes, offering.sales_closes_at,
            offering.sales_closes_offset_minutes
     from hpos.orders order_row
     join hpos.public_quotes quote on quote.id = order_row.quote_id and quote.site_id = order_row.site_id
     join hpos.reservations reservation on reservation.order_id = order_row.id and reservation.site_id = order_row.site_id
     join hpos.events event_row on event_row.id = order_row.event_id and event_row.site_id = order_row.site_id
     join hpos.ticket_offerings offering
       on offering.id = order_row.offering_id and offering.event_id = order_row.event_id and offering.site_id = order_row.site_id
     where order_row.id = $1 and order_row.site_id = $2
     for update of order_row, reservation, event_row, offering`,
    [orderId, siteId],
  );
  return result.rows[0] ?? null;
}

/**
 * Issue a complete Order's Ticket set in its own transaction. Payment has
 * already committed, so any failure leaves the Order paid and retryable.
 */
export async function issuePaidOrder(siteId: string, orderId: string): Promise<{ issued: boolean; blocked: boolean }> {
  const pool = getBusinessPool();
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local lock_timeout = '2s'");
    const row = await readIssuanceRow(client, siteId, orderId);
    if (!row || row.payment_status !== "paid" || row.issuance_status === "issued" || row.issuance_status === "blocked") {
      await client.query("commit");
      return { issued: row?.issuance_status === "issued", blocked: row?.issuance_status === "blocked" };
    }
    if (row.issuance_status !== "pending" && row.issuance_status !== "failed") {
      await client.query("commit");
      return { issued: false, blocked: false };
    }

    const reportId = await latestPaidReport(client, siteId, orderId);
    let blockCode: "reservation_already_released" | "event_canceled" | "order_token_missing" | "order_fully_refunded" | null = null;
    let blockMessage = "";
    if (row.refund_status === "full") {
      blockCode = "order_fully_refunded";
      blockMessage = "The paid Order has been fully refunded; do not issue Tickets automatically.";
    } else if (row.reservation_status !== "held") {
      blockCode = "reservation_already_released";
      blockMessage = "Payment was confirmed after the Order Reservation had already been released; do not issue a Ticket automatically.";
    } else if (row.is_canceled) {
      blockCode = "event_canceled";
      blockMessage = "Payment was confirmed for a canceled Event; verify the provider record and refund through the provider dashboard.";
    } else if (!row.order_token) {
      blockCode = "order_token_missing";
      blockMessage = "The paid Order has no recoverable buyer access token, so issuance needs staff investigation.";
    }
    if (blockCode) {
      await client.query(
        `update hpos.orders
         set issuance_status = 'blocked', version = version + 1, updated_at = clock_timestamp()
         where id = $1 and site_id = $2`,
        [orderId, siteId],
      );
      await addIssuanceIssue(client, row, reportId, blockCode, blockMessage);
      await client.query("commit");
      return { issued: false, blocked: true };
    }

    const orderAccess = row.order_token as string;
    const tickets: Array<{ id: string; token: string; qr: string; ordinal: number }> = [];
    for (let ordinal = 1; ordinal <= row.quantity; ordinal += 1) {
      const ticket = {
        id: randomUUID(),
        token: randomBytes(32).toString("base64url"),
        qr: randomBytes(32).toString("base64url"),
        ordinal,
      };
      await client.query(
        `insert into hpos.tickets (
           id, site_id, order_id, event_id, offering_id, ordinal, attendee_name,
           ticket_token, ticket_token_hash, qr_payload, qr_token_hash
         ) values ($1, $2, $3, $4, $5, $6, null, $7, $8, $9, $10)`,
        [ticket.id, siteId, orderId, row.event_id, row.ticket_offering_id, ordinal,
          ticket.token, hashToken(ticket.token), ticket.qr, hashToken(ticket.qr)],
      );
      tickets.push(ticket);
    }

    await client.query(
      `update hpos.reservations
       set status = 'consumed', awaiting_provider_verification = false, updated_at = clock_timestamp()
       where id = $1 and site_id = $2 and status = 'held'`,
      [row.reservation_id, siteId],
    );
    await client.query(
      `update hpos.orders
       set issuance_status = 'issued', delivery_status = 'pending', checkout_status = 'ended',
           version = version + 1, updated_at = clock_timestamp()
       where id = $1 and site_id = $2 and payment_status = 'paid'`,
      [orderId, siteId],
    );

    const event = publicEventData(row);
    await enqueueNotificationJob(client, {
      siteId,
      kind: "tickets_ready",
      eventId: row.event_id,
      orderId,
      payload: {
        recipient_email: row.delivery_email,
        buyer_name: row.buyer_name,
        event: eventNotificationDetails(event, row.event_id),
        order: { order_id: orderId, order_reference: row.order_reference, order_token: orderAccess },
      },
    });
    await client.query(
      `update hpos.payment_report_issues
       set status = 'resolved', resolved_at = clock_timestamp()
       where site_id = $1 and order_id = $2 and code = 'ticket_issuance_failed' and status = 'open'`,
      [siteId, orderId],
    );
    await client.query("commit");
    return { issued: true, blocked: false };
  } catch {
    await client.query("rollback").catch(() => undefined);
    await pool.query(
      `update hpos.orders
       set issuance_status = 'failed', version = version + 1, updated_at = clock_timestamp()
       where id = $1 and site_id = $2 and payment_status = 'paid'
         and issuance_status in ('pending', 'failed')`,
      [orderId, siteId],
    ).catch(() => undefined);
    await recordIssuanceFailure(siteId, orderId);
    return { issued: false, blocked: false };
  } finally {
    client.release();
  }
}

export async function processPendingTicketIssuance(): Promise<{ checked: number; issued: number; blocked: number; has_more: boolean }> {
  const rows = await getBusinessPool().query<{ id: string; site_id: string }>(
    `select id, site_id
     from hpos.orders
     where payment_status = 'paid' and issuance_status in ('pending', 'failed')
     order by updated_at asc, id asc
     limit $1`,
    [MAX_ISSUANCE_BATCH],
  );
  let issued = 0;
  let blocked = 0;
  for (const row of rows.rows) {
    const result = await issuePaidOrder(row.site_id, row.id);
    if (result.issued) issued += 1;
    if (result.blocked) blocked += 1;
  }
  const remaining = await getBusinessPool().query(
    `select 1 from hpos.orders
     where payment_status = 'paid' and issuance_status in ('pending', 'failed')
     limit 1`,
  );
  return { checked: rows.rows.length, issued, blocked, has_more: (remaining.rowCount ?? 0) > 0 };
}

interface ReadOrderRow extends IssuanceRow {
  order_token_hash: string;
  tickets_delivery_job_status: "pending" | "failed" | "completed" | null;
  tickets_delivery_outcome: "delivered" | "failed" | null;
}

interface RecoveryJobRow {
  id: string;
  status: "pending" | "failed" | "completed";
  is_superseded: boolean;
  attempt_count: number;
  requires_verification: boolean;
  provider_message_reference: string | null;
  failure_class: "transient" | "permanent" | null;
  delivery_status: "delivered" | "failed" | null;
  created_at: Date;
}

function recoveryDeliveryState(job: RecoveryJobRow | null): "pending" | "sent" | "delivered" | "failed" | null {
  if (!job) return null;
  if (job.requires_verification || job.status === "pending") return "pending";
  if (job.delivery_status === "delivered") return "delivered";
  if (job.delivery_status === "failed" || job.status === "failed") return "failed";
  if (job.status === "completed") return "sent";
  return null;
}

function currentDeliveryStatus(row: ReadOrderRow): string {
  if (row.tickets_delivery_outcome === "delivered") return "delivered";
  if (row.tickets_delivery_outcome === "failed" || row.tickets_delivery_job_status === "failed") return "failed";
  if (row.tickets_delivery_job_status === "completed") return "sent";
  if (row.tickets_delivery_job_status === "pending") return "pending";
  return row.delivery_status;
}

async function readBuyerOrder(site: AuthenticatedSite, token: string): Promise<Response> {
  if (!TOKEN_PATTERN.test(token)) return apiFailure(404, "not_found", "The Order is not available to this Site.");
  const client = await getBusinessPool().connect();
  try {
    const orderResult = await client.query<ReadOrderRow>(
      `select order_row.id as order_id, event_row.id, order_row.site_id, order_row.event_id,
              order_row.offering_id as ticket_offering_id, order_row.order_reference,
              order_row.buyer_name, order_row.delivery_email, order_row.order_token,
              order_row.order_token_hash, order_row.accepted_quote, quote.quantity,
              order_row.checkout_status, order_row.payment_status, order_row.issuance_status,
              order_row.delivery_status, order_row.refund_status, order_row.checkout_expires_at,
              order_row.created_at as order_created_at, order_row.updated_at as order_updated_at,
              reservation.id as reservation_id, reservation.status as reservation_status,
              event_row.title, event_row.description, event_row.venue_name, event_row.venue_address,
              event_row.starts_at, event_row.starts_at_offset_minutes, event_row.ends_at,
              event_row.ends_at_offset_minutes, event_row.time_zone, event_row.check_in_opens_at,
              event_row.check_in_opens_offset_minutes, event_row.visibility,
              event_row.publication_status, event_row.is_canceled, event_row.is_archived,
              event_row.sales_paused, event_row.version, event_row.created_at, event_row.updated_at,
              event_row.created_actor_type, event_row.created_actor_reference,
              event_row.updated_actor_type, event_row.updated_actor_reference,
              offering.price_amount, offering.currency, offering.tax_amount, offering.buyer_fees,
              offering.capacity, offering.reserved_quantity, offering.sales_opens_at,
              offering.sales_opens_offset_minutes, offering.sales_closes_at,
              offering.sales_closes_offset_minutes,
              delivery.job_status as tickets_delivery_job_status,
              delivery.outcome as tickets_delivery_outcome
       from hpos.orders order_row
       join hpos.public_quotes quote on quote.id = order_row.quote_id and quote.site_id = order_row.site_id
       join hpos.reservations reservation on reservation.order_id = order_row.id and reservation.site_id = order_row.site_id
       join hpos.events event_row on event_row.id = order_row.event_id and event_row.site_id = order_row.site_id
       join hpos.ticket_offerings offering
         on offering.id = order_row.offering_id and offering.event_id = order_row.event_id and offering.site_id = order_row.site_id
       left join lateral (
         select job.status as job_status, delivery_event.outcome
         from hpos.notification_jobs job
         left join lateral (
           select outcome from hpos.notification_delivery_events
           where site_id = job.site_id and job_id = job.id
           order by observed_at desc, id desc limit 1
         ) delivery_event on true
         where job.site_id = order_row.site_id and job.order_id = order_row.id and job.kind = 'tickets_ready'
           and job.is_superseded = false
         order by job.created_at desc, job.id desc limit 1
       ) delivery on true
       where order_row.site_id = $1 and order_row.order_token_hash = $2`,
      [site.siteId, hashToken(token)],
    );
    const order = orderResult.rows[0];
    if (!order) return apiFailure(404, "not_found", "The Order is not available to this Site.");
    const event = publicEventData(order);
    const ticketsResult = order.issuance_status === "issued"
      ? await client.query<TicketRow>(
        `select ticket.id as ticket_id, ticket.ticket_token, ticket.ordinal, ticket.issued_at,
                ticket.qr_payload, ticket.attendee_name, ticket.version,
                admission.id as admission_id, admission.admitted_at
         from hpos.tickets ticket
         left join hpos.admissions admission
           on admission.site_id = ticket.site_id and admission.ticket_id = ticket.id
         where ticket.site_id = $1 and ticket.order_id = $2
         order by ticket.ordinal asc`,
        [site.siteId, order.order_id],
      )
      : { rows: [] as TicketRow[] };
    const tickets = ticketsResult.rows.map((ticket) => publicTicketData(ticket, event, order.refund_status));
    return noStore(apiSuccess({
      order_id: order.order_id,
      order_reference: order.order_reference,
      quantity: order.quantity,
      buyer_name: order.buyer_name,
      delivery_email: order.delivery_email,
      created_at: order.order_created_at.toISOString(),
      updated_at: order.order_updated_at.toISOString(),
      pricing: order.accepted_quote,
      checkout_expires_at: order.checkout_expires_at.toISOString(),
      checkout_status: order.checkout_status,
      payment_status: order.payment_status,
      issuance_status: order.issuance_status,
      delivery_status: currentDeliveryStatus(order),
      refund_status: order.refund_status,
      event,
      tickets,
    }));
  } finally {
    client.release();
  }
}

function publicTicketData(ticket: TicketRow, event: Record<string, unknown>, refundStatus: string) {
  const blockers: string[] = [];
  const now = Date.now();
  const opensAt = Date.parse(String(event.check_in_opens_at));
  const endsAt = Date.parse(String(event.ends_at));
  if (event.is_canceled) blockers.push("event_canceled");
  if (refundStatus === "full") blockers.push("ticket_refunded");
  if (ticket.admission_id !== null) blockers.push("already_admitted");
  if (Number.isFinite(opensAt) && now < opensAt) blockers.push("check_in_not_open");
  if (Number.isFinite(endsAt) && now > endsAt) blockers.push("check_in_closed");
  return {
    ticket_id: ticket.ticket_id,
    ticket_token: ticket.ticket_token,
    ordinal: ticket.ordinal,
    issued_at: ticket.issued_at.toISOString(),
    event,
    qr_payload: ticket.qr_payload,
    attendee_name: ticket.attendee_name,
    admission_status: ticket.admission_id === null ? "unused" : "admitted",
    admitted_at: ticket.admitted_at?.toISOString() ?? null,
    can_admit: blockers.length === 0,
    admission_blockers: blockers,
  };
}

export async function handleBuyerOrderGet(site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (path.length !== 3 || path[0] !== "public" || path[1] !== "orders") return null;
  return readBuyerOrder(site, path[2]);
}

export async function handleBuyerTicketGet(site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (path.length !== 3 || path[0] !== "public" || path[1] !== "tickets") return null;
  const token = path[2];
  if (!TOKEN_PATTERN.test(token)) return apiFailure(404, "not_found", "The Ticket is not available to this Site.");
  const result = await getBusinessPool().query<TicketRow & EventRow & { site_id: string; refund_status: string }>(
    `select ticket.id as ticket_id, event_row.id, ticket.site_id, ticket.ticket_token, ticket.ordinal, ticket.issued_at,
            ticket.qr_payload, ticket.attendee_name, ticket.version,
            admission.id as admission_id, admission.admitted_at,
            order_row.refund_status, event_row.is_canceled,
            event_row.title, event_row.description, event_row.venue_name, event_row.venue_address,
            event_row.starts_at, event_row.starts_at_offset_minutes, event_row.ends_at,
            event_row.ends_at_offset_minutes, event_row.time_zone, event_row.check_in_opens_at,
            event_row.check_in_opens_offset_minutes, event_row.visibility,
            event_row.publication_status, event_row.is_archived, event_row.sales_paused,
            event_row.version, event_row.created_at, event_row.updated_at,
            event_row.created_actor_type, event_row.created_actor_reference,
            event_row.updated_actor_type, event_row.updated_actor_reference,
            event_row.ticket_offering_id, offering.price_amount, offering.currency,
            offering.tax_amount, offering.buyer_fees, offering.capacity, offering.reserved_quantity,
            offering.sales_opens_at, offering.sales_opens_offset_minutes,
            offering.sales_closes_at, offering.sales_closes_offset_minutes
     from hpos.tickets ticket
     join hpos.orders order_row on order_row.id = ticket.order_id and order_row.site_id = ticket.site_id
     join hpos.events event_row on event_row.id = ticket.event_id and event_row.site_id = ticket.site_id
     join hpos.ticket_offerings offering
       on offering.id = ticket.offering_id and offering.event_id = ticket.event_id and offering.site_id = ticket.site_id
     left join hpos.admissions admission
       on admission.site_id = ticket.site_id and admission.ticket_id = ticket.id
     where ticket.site_id = $1 and ticket.ticket_token_hash = $2`,
    [site.siteId, hashToken(token)],
  );
  const ticket = result.rows[0];
  if (!ticket) return apiFailure(404, "not_found", "The Ticket is not available to this Site.");
  const event = publicEventData(ticket);
  return noStore(apiSuccess(publicTicketData(ticket, event, ticket.refund_status)));
}

interface AdminTicketRow extends TicketRow {
  event_id: string;
  order_id: string;
  order_reference: string;
  buyer_id: string;
  buyer_name: string;
  delivery_email: string;
  created_at: Date;
  updated_at: Date;
  refund_status: string;
  event_canceled: boolean;
}

function adminTicketData(ticket: AdminTicketRow, event: Record<string, unknown>) {
  const blockers: string[] = [];
  const now = Date.now();
  const opensAt = Date.parse(String(event.check_in_opens_at));
  const endsAt = Date.parse(String(event.ends_at));
  if (ticket.event_canceled) blockers.push("event_canceled");
  if (ticket.refund_status === "full") blockers.push("ticket_refunded");
  if (ticket.admission_id !== null) blockers.push("already_admitted");
  if (Number.isFinite(opensAt) && now < opensAt) blockers.push("check_in_not_open");
  if (Number.isFinite(endsAt) && now > endsAt) blockers.push("check_in_closed");
  return {
    ticket_id: ticket.ticket_id,
    event_id: ticket.event_id,
    order_id: ticket.order_id,
    order_reference: ticket.order_reference,
    ordinal: ticket.ordinal,
    version: ticket.version,
    issued_at: ticket.issued_at.toISOString(),
    created_at: ticket.created_at.toISOString(),
    updated_at: ticket.updated_at.toISOString(),
    buyer_id: ticket.buyer_id,
    buyer_name: ticket.buyer_name,
    delivery_email: ticket.delivery_email,
    approved_attendee: null,
    admission_status: ticket.admission_id === null ? "unused" : "admitted",
    admitted_at: ticket.admitted_at?.toISOString() ?? null,
    can_admit: blockers.length === 0,
    admission_blockers: blockers,
  };
}

async function readAdminOrder(site: AuthenticatedSite, orderId: string, existingClient?: PoolClient): Promise<Response> {
  if (!UUID_PATTERN.test(orderId)) return apiFailure(404, "not_found", "The Order is not available to this Site.");
  const pool = getBusinessPool();
  const client = existingClient ?? await pool.connect();
  try {
    const row = await readIssuanceRow(client, site.siteId, orderId);
    if (!row) return apiFailure(404, "not_found", "The Order is not available to this Site.");
    const event = publicEventData(row);
    const ticketsResult = await client.query<AdminTicketRow>(
      `select ticket.id as ticket_id, ticket.event_id, ticket.order_id, order_row.order_reference,
              ticket.ordinal, ticket.issued_at, ticket.version, ticket.created_at, ticket.updated_at,
              order_row.buyer_id, order_row.buyer_name, order_row.delivery_email,
              order_row.refund_status, event_row.is_canceled as event_canceled,
              admission.id as admission_id, admission.admitted_at
       from hpos.tickets ticket
       join hpos.orders order_row on order_row.id = ticket.order_id and order_row.site_id = ticket.site_id
       join hpos.events event_row on event_row.id = ticket.event_id and event_row.site_id = ticket.site_id
       left join hpos.admissions admission on admission.site_id = ticket.site_id and admission.ticket_id = ticket.id
       where ticket.site_id = $1 and ticket.order_id = $2
       order by ticket.ordinal asc`,
      [site.siteId, orderId],
    );
    const attemptsResult = await client.query<{
      id: string; connection_id: string; provider: string; environment: string;
      account_reference: string; location_reference: string | null; currency: string;
      total_amount: string | number; platform_fee_amount: string | number;
      provider_checkout_reference: string | null; provider_payment_reference: string | null;
      last_outcome: string | null; provider_can_take_payment: boolean | null;
      status: string; version: number; created_at: Date; updated_at: Date;
    }>(
      `select attempt.id, attempt.connection_id, attempt.provider, attempt.environment,
              attempt.account_reference, attempt.location_reference, attempt.currency,
              attempt.total_amount, attempt.platform_fee_amount,
              attempt.provider_checkout_reference, attempt.provider_payment_reference,
              attempt.last_outcome, attempt.provider_can_take_payment, attempt.status,
              attempt.version, attempt.created_at, attempt.updated_at
       from hpos.payment_attempts attempt
       where attempt.site_id = $1 and attempt.order_id = $2
       order by attempt.created_at asc, attempt.id asc`,
      [site.siteId, orderId],
    );
    const jobsResult = await client.query<{
      id: string; kind: string; status: "pending" | "failed" | "completed"; event_id: string | null; order_id: string | null;
      is_superseded: boolean; attempt_count: number; available_at: Date; created_at: Date; updated_at: Date;
      requires_verification: boolean; provider_message_reference: string | null;
      failure_class: "transient" | "permanent" | null;
      delivery_status: "delivered" | "failed" | null;
    }>(
      `select id, kind, status, event_id, order_id, is_superseded, attempt_count,
              available_at, created_at, updated_at, requires_verification, provider_message_reference, failure_class,
              (select d.outcome
               from hpos.notification_delivery_events d
               where d.site_id = notification_jobs.site_id and d.job_id = notification_jobs.id
               order by d.observed_at desc, d.id desc limit 1) as delivery_status
       from hpos.notification_jobs
       where site_id = $1 and order_id = $2
       order by created_at asc, id asc`,
      [site.siteId, orderId],
    );
    const issuesResult = await client.query<{
      id: string; code: string; status: "open" | "resolved"; message: string; created_at: Date; resolved_at: Date | null;
      resolution_id: string | null; actor_type: string | null; actor_reference: string | null;
      reason: string | null; verification_reference: string | null; previous_version: number | null; new_version: number | null;
    }>(
      `select issue.id, issue.code, issue.status, issue.message, issue.created_at, issue.resolved_at,
              resolution.id as resolution_id, resolution.actor_type, resolution.actor_reference,
              resolution.reason, resolution.verification_reference,
              resolution.previous_version, resolution.new_version
       from hpos.payment_report_issues issue
       left join hpos.payment_report_issue_resolutions resolution
         on resolution.issue_id = issue.id and resolution.site_id = issue.site_id
       where issue.site_id = $1 and issue.order_id = $2
       order by issue.created_at asc, issue.id asc`,
      [site.siteId, orderId],
    );
    const recoveryActionsResult = await client.query<{
      id: string; action: string; actor_type: string; actor_reference: string;
      previous_version: number; new_version: number; created_at: Date;
      reason: string | null; verification_reference: string | null;
    }>(
      `select id, action, actor_type, actor_reference, previous_version, new_version, created_at
              , reason, verification_reference
       from hpos.order_recovery_actions
       where site_id = $1 and order_id = $2
       order by created_at asc, id asc`,
      [site.siteId, orderId],
    );
    return noStore(apiSuccess({
      order_id: row.order_id,
      order_reference: row.order_reference,
      quantity: row.quantity,
      version: row.order_version,
      buyer_id: row.buyer_id,
      buyer_name: row.buyer_name,
      delivery_email: row.delivery_email,
      checkout_identity: row.checkout_identity,
      quote_id: row.quote_id,
      access_request_id: null,
      approved_attendee: null,
      created_at: row.order_created_at.toISOString(),
      updated_at: row.order_updated_at.toISOString(),
      pricing: row.accepted_quote,
      checkout_expires_at: row.checkout_expires_at.toISOString(),
      checkout_status: row.checkout_status,
      payment_status: row.payment_status,
      issuance_status: row.issuance_status,
      delivery_status: recoveryDeliveryState(jobsResult.rows
        .filter((job) => job.kind === "tickets_ready" && !job.is_superseded)
        .at(-1) ?? null) ?? row.delivery_status,
      refund_status: row.refund_status,
      event,
      reservation: {
        reservation_id: row.reservation_id,
        quantity: row.quantity,
        status: row.reservation_status,
        expires_at: row.reservation_expires_at.toISOString(),
        awaiting_provider_verification: row.awaiting_provider_verification,
      },
      payment_attempts: attemptsResult.rows.map((attempt) => ({
        attempt_id: attempt.id,
        connection_id: attempt.connection_id,
        provider: attempt.provider,
        environment: attempt.environment,
        account_reference: attempt.account_reference,
        location_reference: attempt.location_reference,
        currency: attempt.currency,
        total: { amount: safeNumber(attempt.total_amount.toString()), currency: attempt.currency },
        platform_fee_amount: safeNumber(attempt.platform_fee_amount.toString()),
        provider_checkout_reference: attempt.provider_checkout_reference,
        provider_payment_reference: attempt.provider_payment_reference,
        last_outcome: attempt.last_outcome,
        provider_can_take_payment: attempt.provider_can_take_payment,
        status: attempt.status,
        version: attempt.version,
        created_at: attempt.created_at.toISOString(),
        updated_at: attempt.updated_at.toISOString(),
      })),
      refunds: [],
      fee_records: [],
      notification_jobs: jobsResult.rows.map((job) => ({
        job_id: job.id,
        kind: job.kind,
        status: job.status,
        event_id: job.event_id,
        order_id: job.order_id,
        is_superseded: job.is_superseded,
        attempt_count: job.attempt_count,
        available_at: job.available_at.toISOString(),
        created_at: job.created_at.toISOString(),
        updated_at: job.updated_at.toISOString(),
        requires_verification: job.requires_verification,
        provider_message_reference: job.provider_message_reference,
        failure_class: job.failure_class,
        delivery_status: job.delivery_status,
      })),
      issues: issuesResult.rows.map((issue) => ({
        issue_id: issue.id,
        code: issue.code,
        status: issue.status,
        message: issue.message,
        created_at: issue.created_at.toISOString(),
        resolved_at: issue.resolved_at?.toISOString() ?? null,
        resolution: issue.resolution_id ? {
          resolution_id: issue.resolution_id,
          actor: { type: issue.actor_type, reference: issue.actor_reference },
          reason: issue.reason,
          verification_reference: issue.verification_reference,
          previous_version: issue.previous_version,
          new_version: issue.new_version,
        } : null,
      })),
      recovery_actions: recoveryActionsResult.rows.map((action) => ({
        action_id: action.id,
        action: action.action,
        actor: { type: action.actor_type, reference: action.actor_reference },
        previous_version: action.previous_version,
        new_version: action.new_version,
        created_at: action.created_at.toISOString(),
        reason: action.reason,
        verification_reference: action.verification_reference,
      })),
      tickets: ticketsResult.rows.map((ticket) => adminTicketData(ticket, event)),
    }));
  } finally {
    if (!existingClient) client.release();
  }
}

async function retryTicketIssuance(client: PoolClient, site: AuthenticatedSite, orderId: string, body: Record<string, unknown>): Promise<IdempotentResult> {
  if (!hasOnlyKeys(body, ["actor", "expected_version"])) {
    throw new ApiOperationError(422, "validation_failed", "Only actor and expected_version are accepted for this action.");
  }
  const parsedActor = actor(body.actor);
  if (!parsedActor) throw new ApiOperationError(422, "validation_failed", "Provide a valid Site-local actor reference.", [{ field: "actor", code: "invalid_actor", message: "Use {type, reference} with a non-secret reference." }]);
  const expected = expectedVersion(body.expected_version);
  if (!expected) throw new ApiOperationError(422, "validation_failed", "expected_version must be a positive integer.", [{ field: "expected_version", code: "required", message: "Use the current Order version." }]);
  if (!UUID_PATTERN.test(orderId)) throw new ApiOperationError(404, "not_found", "The Order is not available to this Site.");
  const row = await readIssuanceRow(client, site.siteId, orderId);
  if (!row) throw new ApiOperationError(404, "not_found", "The Order is not available to this Site.");
  if (row.order_version !== expected) throw new ApiOperationError(409, "version_conflict", "The Order changed after you loaded it. Reload it before retrying issuance.");
  if (row.payment_status !== "paid" || !["pending", "failed"].includes(row.issuance_status)) {
    throw new ApiOperationError(409, "invalid_state", "Ticket issuance can only be retried for a paid Order awaiting Tickets.");
  }
  if (row.refund_status === "full") throw new ApiOperationError(409, "invalid_state", "A fully refunded Order cannot be issued.");
  if (row.is_canceled) throw new ApiOperationError(409, "invalid_state", "A canceled Event cannot be issued.");
  if (row.reservation_status !== "held") throw new ApiOperationError(409, "invalid_state", "The Order Reservation is no longer held; investigate before issuing.");
  if (!row.order_token) throw new ApiOperationError(409, "invalid_state", "The paid Order has no recoverable buyer access token.");
  const existingTickets = await client.query<{ count: number }>(
    `select count(*)::integer as count from hpos.tickets where site_id = $1 and order_id = $2`,
    [site.siteId, orderId],
  );
  if ((existingTickets.rows[0]?.count ?? 0) > 0) throw new ApiOperationError(409, "invalid_state", "The Order already has Tickets; issuance retry cannot create duplicates.");
  const updated = await client.query<{ version: number }>(
    `update hpos.orders
     set issuance_status = 'pending', version = version + 1, updated_at = clock_timestamp()
     where id = $1 and site_id = $2 and version = $3 and payment_status = 'paid'
       and issuance_status in ('pending', 'failed')
     returning version`,
    [orderId, site.siteId, expected],
  );
  if (updated.rowCount !== 1) throw new ApiOperationError(409, "version_conflict", "The Order changed after you loaded it. Reload it before retrying issuance.");
  await client.query(
    `insert into hpos.order_recovery_actions
       (id, site_id, order_id, action, actor_type, actor_reference, previous_version, new_version)
     values ($1, $2, $3, 'retry_ticket_issuance', $4, $5, $6, $7)`,
    [randomUUID(), site.siteId, orderId, parsedActor.type, parsedActor.reference, expected, updated.rows[0].version],
  );
  const response = await readAdminOrder(site, orderId, client);
  const data = await response.json() as { data?: unknown; error?: { code?: string; message?: string } };
  if (response.status >= 400 || data.data === undefined) throw new ApiOperationError(503, "service_unavailable", "The retried Order could not be read after it was queued.");
  return { status: 202, data: data.data };
}

async function latestTicketEmailJob(client: PoolClient, siteId: string, orderId: string): Promise<RecoveryJobRow | null> {
  const current = await client.query<{ id: string }>(
    `select job.id
     from hpos.notification_jobs job
     where job.site_id = $1 and job.order_id = $2 and job.kind = 'tickets_ready'
       and job.is_superseded = false
     order by job.created_at desc, job.id desc
     limit 1 for update of job`,
    [siteId, orderId],
  );
  if (!current.rows[0]) return null;
  const result = await client.query<RecoveryJobRow>(
    `select job.id, job.status, job.is_superseded, job.attempt_count,
            job.requires_verification, job.provider_message_reference, job.failure_class, job.created_at,
            (select delivery.outcome
             from hpos.notification_delivery_events delivery
             where delivery.site_id = job.site_id and delivery.job_id = job.id
             order by delivery.observed_at desc, delivery.id desc limit 1) as delivery_status
     from hpos.notification_jobs job
     where job.site_id = $1 and job.id = $2`,
    [siteId, current.rows[0].id],
  );
  return result.rows[0] ?? null;
}

function ticketEmailPayload(row: IssuanceRow) {
  if (!row.order_token) throw new ApiOperationError(409, "invalid_state", "The Order has no current buyer access token.");
  const event = publicEventData(row);
  return {
    recipient_email: row.delivery_email,
    buyer_name: row.buyer_name,
    event: eventNotificationDetails(event, row.event_id),
    order: { order_id: row.order_id, order_reference: row.order_reference, order_token: row.order_token },
  };
}

function assertRecoveryActorAndVersion(body: Record<string, unknown>, allowed: string[]): { actor: { type: "user" | "system"; reference: string }; version: number } {
  if (!hasOnlyKeys(body, allowed)) throw new ApiOperationError(422, "validation_failed", "The recovery action contains an unsupported field.");
  const parsedActor = actor(body.actor);
  if (!parsedActor) throw new ApiOperationError(422, "validation_failed", "Provide a valid Site-local actor reference.", [{ field: "actor", code: "invalid_actor", message: "Use {type, reference} with a non-secret reference." }]);
  const version = expectedVersion(body.expected_version);
  if (!version) throw new ApiOperationError(422, "validation_failed", "expected_version must be a positive integer.", [{ field: "expected_version", code: "required", message: "Use the current Order version." }]);
  return { actor: parsedActor, version };
}

async function recordRecoveryAction(
  client: PoolClient,
  site: AuthenticatedSite,
  orderId: string,
  action: string,
  actorValue: { type: "user" | "system"; reference: string },
  previousVersion: number,
  newVersion: number,
  reason: string | null = null,
  verificationReference: string | null = null,
): Promise<void> {
  await client.query(
    `insert into hpos.order_recovery_actions
       (id, site_id, order_id, action, actor_type, actor_reference, previous_version, new_version, reason, verification_reference)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [randomUUID(), site.siteId, orderId, action, actorValue.type, actorValue.reference, previousVersion, newVersion, reason, verificationReference],
  );
}

async function readRecoveryResponse(client: PoolClient, site: AuthenticatedSite, orderId: string): Promise<IdempotentResult> {
  const response = await readAdminOrder(site, orderId, client);
  const data = await response.json() as { data?: unknown; error?: { code?: string; message?: string } };
  if (response.status >= 400 || data.data === undefined) throw new ApiOperationError(503, "service_unavailable", "The recovered Order could not be read after the action completed.");
  return { status: 202, data: data.data };
}

async function resendTicketEmail(client: PoolClient, site: AuthenticatedSite, orderId: string, body: Record<string, unknown>): Promise<IdempotentResult> {
  const parsed = assertRecoveryActorAndVersion(body, ["actor", "expected_version"]);
  if (!UUID_PATTERN.test(orderId)) throw new ApiOperationError(404, "not_found", "The Order is not available to this Site.");
  const row = await readIssuanceRow(client, site.siteId, orderId);
  if (!row) throw new ApiOperationError(404, "not_found", "The Order is not available to this Site.");
  if (row.order_version !== parsed.version) throw new ApiOperationError(409, "version_conflict", "The Order changed after you loaded it. Reload it before resending the Ticket email.");
  if (row.payment_status !== "paid" || row.issuance_status !== "issued") throw new ApiOperationError(409, "invalid_state", "A Ticket email can only be resent for a paid Order with issued Tickets.");
  if (row.refund_status === "full") throw new ApiOperationError(409, "invalid_state", "A fully refunded Order cannot receive a Ticket email resend.");
  const ticketCount = await client.query<{ count: number }>(
    `select count(*)::integer as count from hpos.tickets where site_id = $1 and order_id = $2`,
    [site.siteId, orderId],
  );
  if ((ticketCount.rows[0]?.count ?? 0) === 0) throw new ApiOperationError(409, "invalid_state", "The paid Order has no issued Tickets to resend.");
  const latest = await latestTicketEmailJob(client, site.siteId, orderId);
  if (!latest) throw new ApiOperationError(409, "invalid_state", "The Order has no Ticket email history to recover.");
  if (latest.requires_verification) throw new ApiOperationError(409, "delivery_verification_required", "The latest Ticket email outcome is unknown. Verify the provider or durable Site log before requesting another send.");
  const state = recoveryDeliveryState(latest);
  if (state === "pending") throw new ApiOperationError(409, "delivery_in_progress", "The latest Ticket email is still in progress.");
  if (state === "sent") throw new ApiOperationError(409, "delivery_verification_required", "The latest Ticket email was sent, but its delivery outcome is not known. Verify it before requesting another send.");
  if (state === "delivered") throw new ApiOperationError(409, "already_delivered", "The latest Ticket email has confirmed delivery.");
  if (state !== "failed") throw new ApiOperationError(409, "invalid_state", "The latest Ticket email is not in a resendable failure state.");

  const updated = await client.query<{ version: number }>(
    `update hpos.orders
     set delivery_status = 'pending', version = version + 1, updated_at = clock_timestamp()
     where id = $1 and site_id = $2 and version = $3 and payment_status = 'paid' and issuance_status = 'issued'
     returning version`,
    [orderId, site.siteId, parsed.version],
  );
  if (updated.rowCount !== 1) throw new ApiOperationError(409, "version_conflict", "The Order changed after you loaded it. Reload it before resending the Ticket email.");
  await enqueueNotificationJob(client, { siteId: site.siteId, kind: "tickets_ready", eventId: row.event_id, orderId, payload: ticketEmailPayload(row) });
  await recordRecoveryAction(client, site, orderId, "resend_ticket_email", parsed.actor, parsed.version, updated.rows[0].version);
  return readRecoveryResponse(client, site, orderId);
}

async function correctDeliveryEmail(client: PoolClient, site: AuthenticatedSite, orderId: string, body: Record<string, unknown>): Promise<IdempotentResult> {
  const parsed = assertRecoveryActorAndVersion(body, ["actor", "expected_version", "email", "reason", "verification_reference"]);
  const corrected = recoveryEmail(body.email);
  if (!corrected) throw new ApiOperationError(422, "validation_failed", "Provide a valid delivery email address.", [{ field: "email", code: "invalid_email", message: "Use a valid email address of at most 254 characters." }]);
  if (!recoveryText(body.reason, 500)) throw new ApiOperationError(422, "validation_failed", "reason is required for a verified delivery-email correction.", [{ field: "reason", code: "required", message: "Record why the address was corrected." }]);
  if (!recoveryText(body.verification_reference, 500)) throw new ApiOperationError(422, "validation_failed", "verification_reference is required for a verified delivery-email correction.", [{ field: "verification_reference", code: "required", message: "Record a non-secret verification reference." }]);
  if (!UUID_PATTERN.test(orderId)) throw new ApiOperationError(404, "not_found", "The Order is not available to this Site.");
  const row = await readIssuanceRow(client, site.siteId, orderId);
  if (!row) throw new ApiOperationError(404, "not_found", "The Order is not available to this Site.");
  if (row.order_version !== parsed.version) throw new ApiOperationError(409, "version_conflict", "The Order changed after you loaded it. Reload it before correcting the delivery email.");
  if (row.payment_status !== "paid" || row.issuance_status !== "issued") throw new ApiOperationError(409, "invalid_state", "Delivery email correction requires a paid Order with issued Tickets.");
  if (row.refund_status === "full") throw new ApiOperationError(409, "invalid_state", "A fully refunded Order cannot receive corrected Ticket access.");
  const latest = await latestTicketEmailJob(client, site.siteId, orderId);
  if (!latest) throw new ApiOperationError(409, "invalid_state", "The Order has no current Ticket email failure that can be safely corrected.");
  if (latest?.requires_verification) throw new ApiOperationError(409, "delivery_verification_required", "The latest Ticket email outcome is unknown. Verify it before replacing access links and sending to another address.");
  const latestState = recoveryDeliveryState(latest);
  if (latestState === "pending") throw new ApiOperationError(409, "delivery_in_progress", "The latest Ticket email is still in progress. Wait for its outcome before correcting the delivery email.");
  if (latestState === "sent") throw new ApiOperationError(409, "delivery_verification_required", "The latest Ticket email was sent, but its delivery outcome is not known. Verify it before replacing access links and sending to another address.");
  if (latestState !== "failed" && latestState !== "delivered") throw new ApiOperationError(409, "invalid_state", "The latest Ticket email is not in a safely correctable state.");
  const ticketRows = await client.query<{ id: string }>(
    `select id from hpos.tickets where site_id = $1 and order_id = $2 order by ordinal asc for update`,
    [site.siteId, orderId],
  );
  if (ticketRows.rowCount === 0) throw new ApiOperationError(409, "invalid_state", "The paid Order has no issued Tickets to correct.");
  const buyer = await client.query<{ id: string }>(
    `insert into hpos.buyers (site_id, normalized_email, name)
     values ($1, $2, $3)
     on conflict (site_id, normalized_email)
     do update set name = excluded.name, updated_at = clock_timestamp()
     returning id`,
    [site.siteId, corrected.normalizedEmail, row.buyer_name],
  );
  const orderToken = randomBytes(32).toString("base64url");
  const updated = await client.query<{ version: number }>(
    `update hpos.orders
     set buyer_id = $4, delivery_email = $5, order_token = $6,
         order_token_hash = $7, delivery_status = 'pending', version = version + 1,
         updated_at = clock_timestamp()
     where id = $1 and site_id = $2 and version = $3 and payment_status = 'paid' and issuance_status = 'issued'
     returning version`,
    [orderId, site.siteId, parsed.version, buyer.rows[0].id, corrected.email, orderToken, hashToken(orderToken)],
  );
  if (updated.rowCount !== 1) throw new ApiOperationError(409, "version_conflict", "The Order changed after you loaded it. Reload it before correcting the delivery email.");
  for (const ticket of ticketRows.rows) {
    const token = randomBytes(32).toString("base64url");
    await client.query(
      `update hpos.tickets
       set ticket_token = $3, ticket_token_hash = $4, version = version + 1, updated_at = clock_timestamp()
       where id = $1 and site_id = $2`,
      [ticket.id, site.siteId, token, hashToken(token)],
    );
  }
  await supersedeUnsentNotificationJobs(client, { siteId: site.siteId, orderId, kinds: ["tickets_ready"] });
  const correctedRow = { ...row, delivery_email: corrected.email, order_token: orderToken } as IssuanceRow;
  await enqueueNotificationJob(client, { siteId: site.siteId, kind: "tickets_ready", eventId: row.event_id, orderId, payload: ticketEmailPayload(correctedRow) });
  await recordRecoveryAction(client, site, orderId, "correct_delivery_email", parsed.actor, parsed.version, updated.rows[0].version, body.reason.trim(), body.verification_reference.trim());
  return readRecoveryResponse(client, site, orderId);
}

export async function handleAdminOrderGet(site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (path.length !== 3 || path[0] !== "admin" || path[1] !== "orders") return null;
  return readAdminOrder(site, path[2]);
}

export async function handleAdminOrderActionPost(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (path.length !== 5 || path[0] !== "admin" || path[1] !== "orders" || path[3] !== "actions") return null;
  if (!["retry_ticket_issuance", "resend_ticket_email", "correct_delivery_email"].includes(path[4])) return apiFailure(404, "not_found", "The requested Order action is unavailable.");
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  const action = path[4] === "retry_ticket_issuance" ? retryTicketIssuance
    : path[4] === "resend_ticket_email" ? resendTicketEmail : correctDeliveryEmail;
  return withApiIdempotency(request, site, body, (client) => action(client, site, path[2], body), undefined, body);
}

export async function handleAdminOrderPaymentStatusGet(site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (path.length !== 4 || path[0] !== "admin" || path[1] !== "orders"
    || path[3] !== "payment-status") return null;
  if (!UUID_PATTERN.test(path[2])) return apiFailure(404, "not_found", "The Order is not available to this Site.");
  const result = await getBusinessPool().query<{
    id: string;
    order_reference: string;
    payment_status: IssuanceRow["payment_status"];
    issuance_status: IssuanceRow["issuance_status"];
    delivery_status: IssuanceRow["delivery_status"];
    refund_status: IssuanceRow["refund_status"];
    version: number;
    ticket_count: number;
    updated_at: Date;
  }>(
    `select order_row.id, order_row.order_reference, order_row.payment_status,
            order_row.issuance_status, order_row.delivery_status, order_row.refund_status,
            order_row.version,
            (select count(*)::integer from hpos.tickets where site_id = order_row.site_id and order_id = order_row.id) as ticket_count,
            order_row.updated_at
     from hpos.orders order_row
     where order_row.site_id = $1 and order_row.id = $2`,
    [site.siteId, path[2]],
  );
  const order = result.rows[0];
  if (!order) return apiFailure(404, "not_found", "The Order is not available to this Site.");
  return noStore(apiSuccess({
    order_id: order.id,
    order_reference: order.order_reference,
    payment_status: order.payment_status,
    issuance_status: order.issuance_status,
    delivery_status: order.delivery_status,
    refund_status: order.refund_status,
    version: order.version,
    ticket_count: order.ticket_count,
    updated_at: order.updated_at.toISOString(),
  }));
}
