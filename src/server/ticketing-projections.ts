import { createHash } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { apiFailure } from "./api-response";
import { getBusinessPool } from "./database";

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
export const MAX_ISSUANCE_BATCH = 50;
export const MAX_BODY_BYTES = 64 * 1024;

export function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export interface EventRow extends QueryResultRow {
  id: string;
  site_id: string;
  ticket_offering_id: string;
  title: string | null;
  description: string | null;
  event_type: string | null;
  logo_path: string | null;
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

export interface IssuanceRow extends EventRow {
  order_id: string;
  event_id: string;
  buyer_id: string;
  quote_id: string;
  order_reference: string;
  buyer_name: string;
  delivery_email: string;
  checkout_identity: Record<string, unknown>;
  access_request_id: string | null;
  approved_attendee_name: string | null;
  approved_attendee_email: string | null;
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

export interface TicketRow extends QueryResultRow {
  ticket_id: string;
  ticket_token: string;
  ordinal: number;
  issued_at: Date;
  qr_payload: string;
  attendee_name: string | null;
  approved_attendee_email: string | null;
  admission_id: string | null;
  admitted_at: Date | null;
  version: number;
}

export function hashToken(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function safeNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function actor(value: unknown): { type: "user" | "system"; reference: string } | null {
  if (!object(value) || !hasOnlyKeys(value, ["type", "reference"])) return null;
  if ((value.type !== "user" && value.type !== "system") || typeof value.reference !== "string") return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value.reference)) return null;
  return { type: value.type, reference: value.reference.trim() };
}

export function expectedVersion(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

export function recoveryEmail(value: unknown): { email: string; normalizedEmail: string } | null {
  if (typeof value !== "string") return null;
  const email = value.trim();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return { email, normalizedEmail: email.toLowerCase() };
}

export function recoveryText(value: unknown, maximum = 500): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown> | Response> {
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

export function eventNotificationDetails(event: Record<string, unknown>, eventId: string) {
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

export interface ReadOrderRow extends IssuanceRow {
  order_token_hash: string;
  tickets_delivery_job_status: "pending" | "failed" | "completed" | null;
  tickets_delivery_outcome: "delivered" | "failed" | null;
}

export interface RecoveryJobRow {
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

export function recoveryDeliveryState(job: RecoveryJobRow | null): "pending" | "sent" | "delivered" | "failed" | null {
  if (!job) return null;
  if (job.requires_verification || job.status === "pending") return "pending";
  if (job.delivery_status === "delivered") return "delivered";
  if (job.delivery_status === "failed" || job.status === "failed") return "failed";
  if (job.status === "completed") return "sent";
  return null;
}

export function currentDeliveryStatus(row: ReadOrderRow): string {
  if (row.tickets_delivery_outcome === "delivered") return "delivered";
  if (row.tickets_delivery_outcome === "failed" || row.tickets_delivery_job_status === "failed") return "failed";
  if (row.tickets_delivery_job_status === "completed") return "sent";
  if (row.tickets_delivery_job_status === "pending") return "pending";
  return row.delivery_status;
}

export function publicTicketData(ticket: TicketRow, event: Record<string, unknown>, refundStatus: string) {
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

export interface AdminTicketRow extends TicketRow {
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

export function adminTicketData(ticket: AdminTicketRow, event: Record<string, unknown>) {
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
    approved_attendee: ticket.approved_attendee_email && ticket.attendee_name
      ? { name: ticket.attendee_name, email: ticket.approved_attendee_email }
      : null,
    admission_status: ticket.admission_id === null ? "unused" : "admitted",
    admitted_at: ticket.admitted_at?.toISOString() ?? null,
    can_admit: blockers.length === 0,
    admission_blockers: blockers,
  };
}

export async function readIssuanceRow(client: PoolClient, siteId: string, orderId: string): Promise<IssuanceRow | null> {
  const orderEvent = await client.query<{ event_id: string }>(
    `select event_id from hpos.orders where id = $1 and site_id = $2`,
    [orderId, siteId],
  );
  const eventId = orderEvent.rows[0]?.event_id;
  if (!eventId) return null;
  await client.query(
    `select id from hpos.events where id = $1 and site_id = $2 for update`,
    [eventId, siteId],
  );

  const result = await client.query<IssuanceRow>(
    `select order_row.id as order_id, event_row.id, order_row.buyer_id, order_row.quote_id, order_row.site_id, order_row.event_id,
            order_row.offering_id as ticket_offering_id, order_row.order_reference,
            order_row.buyer_name, order_row.delivery_email, order_row.checkout_identity, order_row.order_token,
            order_row.access_request_id, order_row.approved_attendee_name, order_row.approved_attendee_email,
            order_row.accepted_quote, quote.quantity, order_row.checkout_status,
            order_row.payment_status, order_row.issuance_status, order_row.delivery_status,
            order_row.refund_status, order_row.checkout_expires_at,
            order_row.created_at as order_created_at, order_row.updated_at as order_updated_at,
            order_row.version as order_version,
            reservation.id as reservation_id, reservation.status as reservation_status,
            reservation.expires_at as reservation_expires_at, reservation.awaiting_provider_verification,
            event_row.title, event_row.description, event_row.event_type, event_row.logo_path, event_row.venue_name, event_row.venue_address,
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
