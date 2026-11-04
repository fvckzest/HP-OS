import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";

export const NOTIFICATION_KINDS = [
  "access_approved",
  "tickets_ready",
  "order_recovery",
  "event_changed",
  "event_canceled",
  "wallet_update",
] as const;

const EVENT_ARRIVAL_FIELDS = new Set([
  "starts_at",
  "ends_at",
  "time_zone",
  "venue.name",
  "venue.address",
]);

export type NotificationKind = typeof NOTIFICATION_KINDS[number];
export type DispatchOutcome = "completed" | "failed" | "unknown";
export type DeliveryOutcome = "delivered" | "failed";
export type FailureClass = "transient" | "permanent";

export interface EventNotificationDetails {
  event_id: string;
  event_reference: string;
  title: string;
  starts_at: string;
  ends_at: string;
  time_zone: string;
  venue: { name: string; address: string | null };
  changed_fields: string[];
}

export type NotificationPayload =
  | { attendee: { name: string; email: string }; approval_token: string }
  | { recipient_email: string; buyer_name: string; event: Omit<EventNotificationDetails, "changed_fields">; order: { order_id: string; order_reference: string; order_token: string } }
  | { recipient_email: string; orders: Array<{ order_id: string; order_reference: string; order_token: string; expires_at: string }> }
  | { recipient_email: string; order: { order_id: string; order_reference: string }; event: EventNotificationDetails }
  | { recipient_email: string; order: { order_id: string; order_reference: string }; event: Omit<EventNotificationDetails, "changed_fields">; canceled_at: string }
  | { ticket_id: string; data_version: string };

export interface NewNotificationJob {
  siteId: string;
  kind: NotificationKind;
  eventId?: string | null;
  orderId?: string | null;
  accessRequestId?: string | null;
  /** SHA-256 digest of the raw approval token for access_approved jobs. */
  accessRequestTokenHash?: string | null;
  ticketId?: string | null;
  availableAt?: Date;
  payload: NotificationPayload;
}

export type EventNotificationBatch =
  | {
      siteId: string;
      eventId: string;
      kind: "event_changed";
      event: EventNotificationDetails;
    }
  | {
      siteId: string;
      eventId: string;
      kind: "event_canceled";
      event: Omit<EventNotificationDetails, "changed_fields">;
      canceledAt: string;
    };

export const MAX_CLAIM_SIZE = 100;
export const MAX_BODY_BYTES = 64 * 1024;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export interface NotificationJobRow extends QueryResultRow {
  id: string;
  site_id: string;
  kind: NotificationKind;
  status: "pending" | "failed" | "completed";
  event_id: string | null;
  order_id: string | null;
  access_request_id: string | null;
  access_request_token_hash: string | null;
  ticket_id: string | null;
  is_superseded: boolean;
  attempt_count: number;
  available_at: Date;
  created_at: Date;
  created_cursor_time?: string;
  updated_at: Date;
  requires_verification: boolean;
  provider_message_reference: string | null;
  failure_class: FailureClass | null;
  payload: NotificationPayload;
  claim_id: string | null;
  lease_expires_at: Date | null;
  lease_fence: number | string;
}

export function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function validText(value: unknown, maximum = 500): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}

function validEmail(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function approvalToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,200}$/.test(value);
}

export function tokenHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && RFC3339_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

export function validateEventDetails(value: unknown, includeChangedFields: boolean): value is EventNotificationDetails {
  if (!object(value)) return false;
  const allowed = ["event_id", "event_reference", "title", "starts_at", "ends_at", "time_zone", "venue", ...(includeChangedFields ? ["changed_fields"] : [])];
  if (!hasOnlyKeys(value, allowed) || !UUID_PATTERN.test(String(value.event_id ?? "")) || !validText(value.event_reference) || !validText(value.title, 200)) return false;
  if (!validTimestamp(value.starts_at) || !validTimestamp(value.ends_at) || !validText(value.time_zone, 100)) return false;
  if (!object(value.venue) || !hasOnlyKeys(value.venue, ["name", "address"]) || !validText(value.venue.name, 200)) return false;
  if (value.venue.address !== null && !validText(value.venue.address, 1000)) return false;
  if (includeChangedFields && (!Array.isArray(value.changed_fields) || value.changed_fields.length === 0
    || value.changed_fields.some((field) => typeof field !== "string" || !EVENT_ARRIVAL_FIELDS.has(field))
    || new Set(value.changed_fields).size !== value.changed_fields.length)) return false;
  return true;
}

export function validateNotificationPayload(kind: NotificationKind, value: unknown): value is NotificationPayload {
  if (!object(value)) return false;
  if (kind === "access_approved") {
    return hasOnlyKeys(value, ["attendee", "approval_token"])
      && object(value.attendee) && hasOnlyKeys(value.attendee, ["name", "email"])
      && validText(value.attendee.name, 200) && validEmail(value.attendee.email) && approvalToken(value.approval_token);
  }
  if (kind === "tickets_ready") {
    if (!hasOnlyKeys(value, ["recipient_email", "buyer_name", "event", "order"]) || !validEmail(value.recipient_email) || !validText(value.buyer_name, 200)) return false;
    if (!validateEventDetails(value.event, false) || !object(value.order) || !hasOnlyKeys(value.order, ["order_id", "order_reference", "order_token"])) return false;
    return UUID_PATTERN.test(String(value.order.order_id ?? "")) && validText(value.order.order_reference) && validText(value.order.order_token, 2000);
  }
  if (kind === "order_recovery") {
    if (!hasOnlyKeys(value, ["recipient_email", "orders"]) || !validEmail(value.recipient_email) || !Array.isArray(value.orders) || value.orders.length === 0) return false;
    return value.orders.every((order) => object(order) && hasOnlyKeys(order, ["order_id", "order_reference", "order_token", "expires_at"])
      && UUID_PATTERN.test(String(order.order_id ?? "")) && validText(order.order_reference)
      && validText(order.order_token, 2000) && validTimestamp(order.expires_at));
  }
  if (kind === "event_changed") {
    return hasOnlyKeys(value, ["recipient_email", "order", "event"]) && validEmail(value.recipient_email)
      && object(value.order) && hasOnlyKeys(value.order, ["order_id", "order_reference"])
      && UUID_PATTERN.test(String(value.order.order_id ?? "")) && validText(value.order.order_reference)
      && validateEventDetails(value.event, true);
  }
  if (kind === "event_canceled") {
    return hasOnlyKeys(value, ["recipient_email", "order", "event", "canceled_at"]) && validEmail(value.recipient_email)
      && object(value.order) && hasOnlyKeys(value.order, ["order_id", "order_reference"])
      && UUID_PATTERN.test(String(value.order.order_id ?? "")) && validText(value.order.order_reference)
      && validateEventDetails(value.event, false) && validTimestamp(value.canceled_at);
  }
  return hasOnlyKeys(value, ["ticket_id", "data_version"])
    && UUID_PATTERN.test(String(value.ticket_id ?? "")) && validText(value.data_version, 200);
}

export function expectedRecordIds(kind: NotificationKind, input: NewNotificationJob): boolean {
  const references = [input.eventId, input.orderId, input.accessRequestId, input.ticketId];
  if (references.some((reference) => reference != null && !UUID_PATTERN.test(reference))) return false;
  const required = {
    access_approved: Boolean(input.eventId && input.accessRequestId && !input.orderId && !input.ticketId),
    tickets_ready: Boolean(input.eventId && input.orderId && !input.accessRequestId && !input.ticketId),
    order_recovery: Boolean(!input.eventId && !input.orderId && !input.accessRequestId && !input.ticketId),
    event_changed: Boolean(input.eventId && input.orderId && !input.accessRequestId && !input.ticketId),
    event_canceled: Boolean(input.eventId && input.orderId && !input.accessRequestId && !input.ticketId),
    wallet_update: Boolean(input.ticketId && !input.eventId && !input.orderId && !input.accessRequestId),
  };
  if (!required[kind]) return false;
  const payload = input.payload as unknown;
  if (!object(payload)) return false;
  if (kind === "tickets_ready" || kind === "event_changed" || kind === "event_canceled") {
    return object(payload.event) && payload.event.event_id === input.eventId
      && object(payload.order) && payload.order.order_id === input.orderId;
  }
  if (kind === "wallet_update") return payload.ticket_id === input.ticketId;
  return true;
}
