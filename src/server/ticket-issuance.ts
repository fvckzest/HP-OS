import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { apiFailure, apiSuccess } from "./api-response";
import { getBusinessPool } from "./database";
import { publicEventData } from "./events";
import { enqueueNotificationJob } from "./notifications";
import type { AuthenticatedSite } from "./site-auth";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_ISSUANCE_BATCH = 50;

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
  order_reference: string;
  buyer_name: string;
  delivery_email: string;
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
  reservation_id: string;
  reservation_status: "held" | "consumed" | "released";
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
  code: "reservation_already_released" | "event_canceled" | "order_token_missing",
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

async function readIssuanceRow(client: PoolClient, siteId: string, orderId: string): Promise<IssuanceRow | null> {
  const result = await client.query<IssuanceRow>(
    `select order_row.id as order_id, event_row.id, order_row.site_id, order_row.event_id,
            order_row.offering_id as ticket_offering_id, order_row.order_reference,
            order_row.buyer_name, order_row.delivery_email, order_row.order_token,
            order_row.accepted_quote, quote.quantity, order_row.checkout_status,
            order_row.payment_status, order_row.issuance_status, order_row.delivery_status,
            order_row.refund_status, order_row.checkout_expires_at,
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
    let blockCode: "reservation_already_released" | "event_canceled" | "order_token_missing" | null = null;
    let blockMessage = "";
    if (row.reservation_status !== "held") {
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
    return { issued: false, blocked: false };
  } finally {
    client.release();
  }
}

export async function processPendingTicketIssuance(): Promise<{ checked: number; issued: number; blocked: number }> {
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
  return { checked: rows.rows.length, issued, blocked };
}

interface ReadOrderRow extends IssuanceRow {
  order_token_hash: string;
  tickets_delivery_job_status: "pending" | "failed" | "completed" | null;
  tickets_delivery_outcome: "delivered" | "failed" | null;
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
    ticket_count: number;
    updated_at: Date;
  }>(
    `select order_row.id, order_row.order_reference, order_row.payment_status,
            order_row.issuance_status, order_row.delivery_status, order_row.refund_status,
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
    ticket_count: order.ticket_count,
    updated_at: order.updated_at.toISOString(),
  }));
}
