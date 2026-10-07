import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { apiFailure, apiSuccess } from "./api-response";
import { ApiOperationError, withApiIdempotency } from "./api-idempotency";
import type { IdempotentResult } from "./api-idempotency";
import { getBusinessPool } from "./database";
import { enqueueNotificationJob, supersedeUnsentNotificationJobs } from "./notifications";
import type { EventNotificationDetails } from "./notifications";
import type { AuthenticatedSite } from "./site-auth";
import { enqueueWalletUpdateJobsForEvent } from "./wallet-data";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_BODY_BYTES = 64 * 1024;
const ACTOR_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

interface Actor {
  type: "user" | "system";
  reference: string;
}

interface ParsedTimestamp {
  iso: string;
  offsetMinutes: number;
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
  created_actor_type: Actor["type"];
  created_actor_reference: string;
  updated_actor_type: Actor["type"];
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
  sales_ever_configured?: boolean;
  created_cursor_time?: string;
  starts_cursor_time?: string;
}

interface ProviderMappingRow extends QueryResultRow {
  event_id: string;
  connection_id: string;
  resource_type: string;
  resource_reference: string;
  verified_at: Date;
}

export type SalesStatus = "canceled" | "closed" | "not_configured" | "scheduled" | "paused" | "sold_out" | "open";

export interface EventSalesState {
  is_canceled: boolean;
  ends_at: Date | null;
  price_amount: string | null;
  tax_amount: string | null;
  buyer_fees: EventRow["buyer_fees"];
  capacity: string | null;
  sales_opens_at: Date | null;
  sales_closes_at: Date | null;
  sales_paused: boolean;
  reserved_quantity: string;
}

interface EventInput {
  actor: Actor;
  title?: string | null;
  description?: string | null;
  venue?: { name?: string | null; address?: string | null };
  starts_at?: ParsedTimestamp | null;
  ends_at?: ParsedTimestamp | null;
  time_zone?: string | null;
  check_in_opens_at?: ParsedTimestamp | null;
  visibility?: "public" | "private" | null;
  ticket_offering?: {
    price?: { amount: number; currency: string } | null;
    capacity?: number | null;
    sales_opens_at?: ParsedTimestamp | null;
    sales_closes_at?: ParsedTimestamp | null;
    tax_amount?: number | null;
    buyer_fees?: Array<{ code: string; label: string; amount: number; currency: string }> | null;
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function fieldError(field: string, code: string, message: string): Response {
  return apiFailure(422, "validation_failed", message, {
    details: [{ field, code, message }],
  });
}

function validPlainText(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === "string"
    && value.length <= maximum
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    && (allowEmpty || value.trim().length > 0);
}

function actorFrom(value: unknown): Actor | null {
  if (!object(value) || !hasOnlyKeys(value, ["type", "reference"])) return null;
  if ((value.type !== "user" && value.type !== "system") || typeof value.reference !== "string") return null;
  const reference = value.reference.trim();
  if (!ACTOR_REFERENCE_PATTERN.test(reference)) return null;
  return { type: value.type, reference };
}

function offsetMinutes(value: string): number {
  if (value === "Z") return 0;
  const sign = value[0] === "-" ? -1 : 1;
  const hours = Number(value.slice(1, 3));
  const minutes = Number(value.slice(4, 6));
  return sign * (hours * 60 + minutes);
}

function parseTimestamp(value: unknown, field: string): ParsedTimestamp | Response {
  if (typeof value !== "string") return fieldError(field, "invalid_timestamp", "Provide an RFC 3339 timestamp with a UTC offset.");
  const match = RFC3339_PATTERN.exec(value);
  if (!match) return fieldError(field, "offset_required", "Include Z or a numeric UTC offset.");
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return fieldError(field, "invalid_timestamp", "Provide a valid calendar date and time.");
  }
  const localCalendar = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (localCalendar.getUTCFullYear() !== year || localCalendar.getUTCMonth() !== month - 1 || localCalendar.getUTCDate() !== day) {
    return fieldError(field, "invalid_timestamp", "Provide a valid calendar date and time.");
  }
  if (offsetText !== "Z") {
    const hours = Number(offsetText.slice(1, 3));
    const minutes = Number(offsetText.slice(4, 6));
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) {
      return fieldError(field, "invalid_timestamp", "The UTC offset must be within 14 hours.");
    }
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return fieldError(field, "invalid_timestamp", "Provide a valid RFC 3339 timestamp.");
  return { iso: new Date(epoch).toISOString(), offsetMinutes: offsetMinutes(offsetText) };
}

function zoneOffsetAt(instant: string, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(instant));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const localAsUtc = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      Number(values.second),
    );
    return Math.round((localAsUtc - Date.parse(instant)) / 60_000);
  } catch {
    return null;
  }
}

function validateTimestampZone(field: string, value: ParsedTimestamp | null | undefined, timeZone: string | null | undefined): Response | null {
  if (!value || !timeZone) return null;
  const expected = zoneOffsetAt(value.iso, timeZone);
  if (expected === null) return fieldError("time_zone", "invalid_time_zone", "Use a valid IANA time-zone name.");
  if (expected !== value.offsetMinutes) return fieldError(field, "offset_mismatch", "The timestamp offset must match time_zone at that instant.");
  return null;
}

function parseOptionalString(
  value: unknown,
  field: string,
  maximum: number,
  allowEmpty: boolean,
): string | null | Response {
  if (value === null) return null;
  if (!validPlainText(value, maximum, allowEmpty)) {
    return fieldError(field, "invalid_text", "Provide plain text within the documented length.");
  }
  const trimmed = value.trim();
  return trimmed || (allowEmpty ? "" : null);
}

function parseEventInput(value: Record<string, unknown>): EventInput | Response {
  const allowed = ["actor", "title", "description", "venue", "starts_at", "ends_at", "time_zone", "check_in_opens_at", "visibility", "ticket_offering"];
  if (!hasOnlyKeys(value, allowed)) {
    const unknown = Object.keys(value).find((key) => !allowed.includes(key)) ?? "unknown";
    return fieldError(unknown, "unknown_field", "Remove the unsupported field.");
  }
  const actor = actorFrom(value.actor);
  if (!actor) return fieldError("actor", "invalid_actor", "Include a user or system actor with a non-secret Site-local reference.");

  const input: EventInput = { actor };
  if (Object.hasOwn(value, "title")) {
    const title = parseOptionalString(value.title, "title", 200, false);
    if (title instanceof Response) return title;
    input.title = title;
  }
  if (Object.hasOwn(value, "description")) {
    const description = parseOptionalString(value.description, "description", 20000, true);
    if (description instanceof Response) return description;
    input.description = description;
  }
  if (Object.hasOwn(value, "venue")) {
    if (!object(value.venue) || !hasOnlyKeys(value.venue, ["name", "address"])) return fieldError("venue", "invalid_object", "Provide venue.name and optional venue.address.");
    input.venue = {};
    if (Object.hasOwn(value.venue, "name")) {
      const name = parseOptionalString(value.venue.name, "venue.name", 200, false);
      if (name instanceof Response) return name;
      input.venue.name = name;
    }
    if (Object.hasOwn(value.venue, "address")) {
      const address = parseOptionalString(value.venue.address, "venue.address", 1000, true);
      if (address instanceof Response) return address;
      input.venue.address = address;
    }
  }
  for (const field of ["starts_at", "ends_at", "check_in_opens_at"] as const) {
    if (!Object.hasOwn(value, field)) continue;
    if (value[field] === null) {
      input[field] = null;
      continue;
    }
    const timestamp = parseTimestamp(value[field], field);
    if (timestamp instanceof Response) return timestamp;
    input[field] = timestamp;
  }
  if (Object.hasOwn(value, "time_zone")) {
    if (value.time_zone === null) input.time_zone = null;
    else if (typeof value.time_zone !== "string" || value.time_zone.trim().length === 0 || value.time_zone.length > 100) {
      return fieldError("time_zone", "invalid_time_zone", "Use a valid IANA time-zone name.");
    } else {
      const normalizedTimeZone = value.time_zone.trim();
      try { new Intl.DateTimeFormat("en-US", { timeZone: normalizedTimeZone }); }
      catch { return fieldError("time_zone", "invalid_time_zone", "Use a valid IANA time-zone name."); }
      input.time_zone = normalizedTimeZone;
    }
  }
  if (Object.hasOwn(value, "visibility")) {
    if (value.visibility === null || value.visibility === "public" || value.visibility === "private") input.visibility = value.visibility;
    else return fieldError("visibility", "invalid_enum", "Use public or private visibility.");
  }
  if (Object.hasOwn(value, "ticket_offering")) {
    if (!object(value.ticket_offering) || !hasOnlyKeys(value.ticket_offering, ["price", "capacity", "sales_opens_at", "sales_closes_at", "tax_amount", "buyer_fees"])) {
      return fieldError("ticket_offering", "invalid_object", "Use only price, capacity, sales times, tax_amount, and buyer_fees.");
    }
    input.ticket_offering = {};
    if (Object.hasOwn(value.ticket_offering, "price")) {
      const price = value.ticket_offering.price;
      if (price === null) input.ticket_offering.price = null;
      else if (!object(price) || !hasOnlyKeys(price, ["amount", "currency"])
        || !Number.isSafeInteger(price.amount) || Number(price.amount) < 1
        || typeof price.currency !== "string" || !/^[A-Z]{3}$/.test(price.currency)) {
        return fieldError("ticket_offering.price", "invalid_money", "Use a positive safe-integer amount and a three-letter uppercase currency code.");
      } else {
        input.ticket_offering.price = { amount: Number(price.amount), currency: price.currency };
      }
    }
    if (Object.hasOwn(value.ticket_offering, "capacity")) {
      const capacity = value.ticket_offering.capacity;
      if (capacity !== null && (!Number.isSafeInteger(capacity) || Number(capacity) < 0)) {
        return fieldError("ticket_offering.capacity", "out_of_range", "Capacity must be a nonnegative safe integer or null.");
      }
      input.ticket_offering.capacity = capacity as number | null;
    }
    if (Object.hasOwn(value.ticket_offering, "tax_amount")) {
      const taxAmount = value.ticket_offering.tax_amount;
      if (taxAmount !== null && (!Number.isSafeInteger(taxAmount) || Number(taxAmount) < 0)) {
        return fieldError("ticket_offering.tax_amount", "out_of_range", "Tax must be a nonnegative safe integer amount or null. Use zero when no tax applies.");
      }
      input.ticket_offering.tax_amount = taxAmount as number | null;
    }
    if (Object.hasOwn(value.ticket_offering, "buyer_fees")) {
      const fees = value.ticket_offering.buyer_fees;
      if (fees === null) input.ticket_offering.buyer_fees = null;
      else if (!Array.isArray(fees) || fees.length > 10) {
        return fieldError("ticket_offering.buyer_fees", "invalid_list", "Provide up to ten fee entries or an empty list when no buyer fees apply.");
      } else {
        const parsedFees: Array<{ code: string; label: string; amount: number; currency: string }> = [];
        let totalFeeAmount = 0;
        for (const [index, fee] of fees.entries()) {
          const field = `ticket_offering.buyer_fees[${index}]`;
          if (!object(fee) || !hasOnlyKeys(fee, ["code", "label", "amount", "currency"])
            || typeof fee.code !== "string" || !/^[a-z][a-z0-9_]{0,49}$/.test(fee.code)
            || !validPlainText(fee.label, 100) || !Number.isSafeInteger(fee.amount) || Number(fee.amount) < 0
            || typeof fee.currency !== "string" || !/^[A-Z]{3}$/.test(fee.currency)) {
            return fieldError(field, "invalid_fee", "Each fee requires a lowercase code, label, nonnegative safe-integer amount, and uppercase currency.");
          }
          const amount = Number(fee.amount);
          totalFeeAmount += amount;
          if (!Number.isSafeInteger(totalFeeAmount)) return fieldError("ticket_offering.buyer_fees", "out_of_range", "The combined buyer fees exceed the safe amount range.");
          parsedFees.push({ code: fee.code, label: fee.label.trim(), amount, currency: fee.currency });
        }
        input.ticket_offering.buyer_fees = parsedFees;
      }
    }
    for (const field of ["sales_opens_at", "sales_closes_at"] as const) {
      if (!Object.hasOwn(value.ticket_offering, field)) continue;
      if (value.ticket_offering[field] === null) {
        input.ticket_offering[field] = null;
        continue;
      }
      const timestamp = parseTimestamp(value.ticket_offering[field], "ticket_offering." + field);
      if (timestamp instanceof Response) return timestamp;
      input.ticket_offering[field] = timestamp;
    }
  }

  const zone = input.time_zone;
  for (const field of ["starts_at", "ends_at", "check_in_opens_at"] as const) {
    const mismatch = validateTimestampZone(field, input[field], zone);
    if (mismatch) return mismatch;
  }
  for (const field of ["sales_opens_at", "sales_closes_at"] as const) {
    const mismatch = validateTimestampZone("ticket_offering." + field, input.ticket_offering?.[field], zone);
    if (mismatch) return mismatch;
  }
  return input;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | Response> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return apiFailure(415, "unsupported_media_type", "Send Event fields as application/json.");
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

function iso(value: Date | null, offsetMinutes: number | null = 0): string | null {
  if (!value) return null;
  const offset = Number(offsetMinutes ?? 0);
  const local = new Date(value.getTime() + offset * 60_000).toISOString().replace(/\.000Z$/, "Z");
  const suffix = offset === 0 ? "Z" : `${offset < 0 ? "-" : "+"}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}:${String(Math.abs(offset) % 60).padStart(2, "0")}`;
  return local.replace(/Z$/, suffix);
}

function safeNumber(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function salesStatus(row: EventSalesState, now = Date.now()): SalesStatus {
  if (row.is_canceled) return "canceled";
  if (row.ends_at && row.ends_at.getTime() <= now) return "closed";
  if (row.price_amount === null || row.tax_amount === null || row.buyer_fees === null || row.capacity === null || !row.sales_opens_at || !row.sales_closes_at) return "not_configured";
  if (row.sales_closes_at.getTime() <= now) return "closed";
  if (row.sales_opens_at.getTime() > now) return "scheduled";
  if (row.sales_paused) return "paused";
  if (Number(row.reserved_quantity) >= Number(row.capacity)) return "sold_out";
  return "open";
}

function eventData(row: EventRow, admin: boolean): Record<string, unknown> {
  const amount = safeNumber(row.price_amount);
  const capacity = safeNumber(row.capacity);
  const reserved = safeNumber(row.reserved_quantity) ?? 0;
  const data: Record<string, unknown> = {
    event_id: row.id,
    title: row.title,
    description: row.description,
    venue: { name: row.venue_name, address: row.venue_address },
    starts_at: iso(row.starts_at, row.starts_at_offset_minutes),
    ends_at: iso(row.ends_at, row.ends_at_offset_minutes),
    time_zone: row.time_zone,
    check_in_opens_at: iso(row.check_in_opens_at ?? row.starts_at, row.check_in_opens_offset_minutes ?? row.starts_at_offset_minutes),
    visibility: row.visibility,
    purchase_mode: row.visibility === "private" ? "access_request" : "public_checkout",
    sales_status: salesStatus(row),
    is_canceled: row.is_canceled,
    is_archived: row.is_archived,
    ticket_offering: {
      price: amount === null || !row.currency ? null : { amount, currency: row.currency },
      max_quantity_per_order: row.visibility === "private" ? 1 : 8,
    },
  };
  if (!admin) return data;
  data.version = row.version;
  data.publication_status = row.publication_status;
  data.created_at = row.created_at.toISOString();
  data.updated_at = row.updated_at.toISOString();
  data.sales_paused = row.sales_paused;
  data.check_in_uses_event_start = row.check_in_opens_at === null;
  Object.assign(data.ticket_offering as Record<string, unknown>, {
    offering_id: row.ticket_offering_id,
    capacity,
    reserved_quantity: reserved,
    available_quantity: capacity === null ? null : Math.max(0, capacity - reserved),
    sales_opens_at: iso(row.sales_opens_at, row.sales_opens_offset_minutes),
    sales_closes_at: iso(row.sales_closes_at, row.sales_closes_offset_minutes),
    tax_amount: safeNumber(row.tax_amount),
    buyer_fees: row.buyer_fees,
    provider_mappings: [],
  });
  return data;
}

/** Public Event details reused by buyer Order and Ticket reads. */
export function publicEventData(row: EventRow): Record<string, unknown> {
  return eventData(row, false);
}

function providerMappingData(mapping: ProviderMappingRow): Record<string, unknown> {
  return {
    connection_id: mapping.connection_id,
    resource_type: mapping.resource_type,
    resource_reference: mapping.resource_reference,
    verified_at: mapping.verified_at.toISOString(),
  };
}

function setProviderMappings(event: Record<string, unknown>, mappings: ProviderMappingRow[]): void {
  const offering = event.ticket_offering;
  if (offering && typeof offering === "object" && !Array.isArray(offering)) {
    (offering as Record<string, unknown>).provider_mappings = mappings.map(providerMappingData);
  }
}

async function readProviderMappings(client: PoolClient, siteId: string, eventId: string, offeringId: string): Promise<ProviderMappingRow[]> {
  const result = await client.query<ProviderMappingRow>(
    `select event_id, connection_id, resource_type, resource_reference, verified_at
     from hpos.ticket_offering_provider_mappings
     where site_id = $1 and event_id = $2 and offering_id = $3
     order by connection_id asc`,
    [siteId, eventId, offeringId],
  );
  return result.rows;
}

export async function readAdminEvent(client: PoolClient, siteId: string, eventId: string): Promise<Record<string, unknown> | null> {
  const result = await client.query<EventRow>(
    `select e.id, e.site_id, e.ticket_offering_id, e.title, e.description,
       e.venue_name, e.venue_address, e.starts_at, e.starts_at_offset_minutes,
       e.ends_at, e.ends_at_offset_minutes, e.time_zone, e.check_in_opens_at,
       e.check_in_opens_offset_minutes, e.visibility, e.publication_status, e.is_canceled,
       e.is_archived, e.sales_paused, e.version, e.created_at, e.updated_at,
       e.created_actor_type, e.created_actor_reference, e.updated_actor_type,
       e.updated_actor_reference, o.price_amount, o.currency, o.tax_amount, o.buyer_fees, o.capacity,
       o.reserved_quantity, o.sales_opens_at, o.sales_opens_offset_minutes,
       o.sales_closes_at, o.sales_closes_offset_minutes
     from hpos.events e
     join hpos.ticket_offerings o
       on o.id = e.ticket_offering_id and o.event_id = e.id and o.site_id = e.site_id
     where e.site_id = $1 and e.id = $2`,
    [siteId, eventId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const data = eventData(row, true);
  setProviderMappings(data, await readProviderMappings(client, siteId, eventId, row.ticket_offering_id));
  return data;
}

function changedArrivalFields(before: EventRow, after: EventRow): string[] {
  const changed: string[] = [];
  if (before.starts_at?.getTime() !== after.starts_at?.getTime()
    || before.starts_at_offset_minutes !== after.starts_at_offset_minutes) changed.push("starts_at");
  if (before.ends_at?.getTime() !== after.ends_at?.getTime()
    || before.ends_at_offset_minutes !== after.ends_at_offset_minutes) changed.push("ends_at");
  if (before.time_zone !== after.time_zone) changed.push("time_zone");
  if (before.venue_name !== after.venue_name) changed.push("venue.name");
  if (before.venue_address !== after.venue_address) changed.push("venue.address");
  return changed;
}

function walletEventProjection(row: EventRow): Record<string, unknown> {
  const projection = publicEventData(row);
  delete projection.sales_status;
  return projection;
}

function walletEventDataChanged(before: EventRow, after: EventRow): boolean {
  return JSON.stringify(walletEventProjection(before)) !== JSON.stringify(walletEventProjection(after));
}

function eventNotificationDetails(row: EventRow, changedFields: string[]): EventNotificationDetails {
  const startsAt = iso(row.starts_at, row.starts_at_offset_minutes);
  const endsAt = iso(row.ends_at, row.ends_at_offset_minutes);
  if (!row.title || !startsAt || !endsAt || !row.time_zone || !row.venue_name) {
    throw new Error("A published Event is missing required buyer notification details.");
  }
  return {
    event_id: row.id,
    event_reference: `event-${row.id.slice(0, 8)}`,
    title: row.title,
    starts_at: startsAt,
    ends_at: endsAt,
    time_zone: row.time_zone,
    venue: { name: row.venue_name, address: row.venue_address },
    changed_fields: changedFields,
  };
}

async function enqueueEventChangeNotifications(
  client: PoolClient,
  siteId: string,
  event: EventRow,
  changedFields: string[],
): Promise<void> {
  if (changedFields.length === 0) return;
  await supersedeUnsentNotificationJobs(client, { siteId, eventId: event.id, kinds: ["event_changed"] });
  const details = eventNotificationDetails(event, changedFields);
  const orders = await client.query<{ id: string; order_reference: string; delivery_email: string }>(
    `select id, order_reference, delivery_email
     from hpos.orders
     where site_id = $1 and event_id = $2 and payment_status = 'paid'
     order by created_at, id`,
    [siteId, event.id],
  );
  for (const order of orders.rows) {
    await enqueueNotificationJob(client, {
      siteId,
      kind: "event_changed",
      eventId: event.id,
      orderId: order.id,
      payload: {
        recipient_email: order.delivery_email,
        order: { order_id: order.id, order_reference: order.order_reference },
        event: details,
      },
    });
  }
}

async function terminateCanceledEventCheckouts(client: PoolClient, siteId: string, eventId: string): Promise<void> {
  // HP-OS can end unpaid checkout permission, but the Site must verify any
  // provider-capable or uncertain checkout before its Reservation is released.
  await client.query(
    `update hpos.payment_attempts attempt
     set status = 'requires_verification', version = attempt.version + 1, updated_at = clock_timestamp()
     from hpos.orders order_row
     where order_row.id = attempt.order_id and order_row.site_id = attempt.site_id
       and order_row.site_id = $1 and order_row.event_id = $2
       and order_row.payment_status <> 'paid'
       and attempt.status in ('creating', 'open', 'requires_verification')
       and (attempt.last_outcome is null
         or attempt.last_outcome in ('processing', 'unknown')
         or attempt.provider_can_take_payment is distinct from false)`,
    [siteId, eventId],
  );

  await client.query(
    `update hpos.orders order_row
     set checkout_status = case
           when order_row.payment_status in ('unpaid', 'failed')
             and not exists (
               select 1 from hpos.payment_attempts attempt
               where attempt.site_id = order_row.site_id and attempt.order_id = order_row.id
                 and attempt.status = 'requires_verification'
             ) then 'ended'
           else 'awaiting_payment_result'
         end,
         version = version + 1, updated_at = clock_timestamp()
     where order_row.site_id = $1 and order_row.event_id = $2
       and order_row.payment_status <> 'paid'`,
    [siteId, eventId],
  );

  const released = await client.query<{ offering_id: string; quantity: string }>(
    `with released as (
       update hpos.reservations reservation
       set status = 'released', awaiting_provider_verification = false, updated_at = clock_timestamp()
       from hpos.orders order_row
       where order_row.id = reservation.order_id and order_row.site_id = reservation.site_id
         and reservation.site_id = $1 and reservation.event_id = $2
         and reservation.status = 'held'
         and order_row.payment_status in ('unpaid', 'failed')
         and not exists (
           select 1 from hpos.payment_attempts attempt
           where attempt.site_id = order_row.site_id and attempt.order_id = order_row.id
             and attempt.status = 'requires_verification'
         )
       returning reservation.offering_id, reservation.quantity
     )
     select offering_id, sum(quantity)::bigint as quantity
     from released group by offering_id`,
    [siteId, eventId],
  );
  for (const reservation of released.rows) {
    const updated = await client.query(
      `update hpos.ticket_offerings
       set reserved_quantity = reserved_quantity - $3::bigint
       where id = $1 and site_id = $2 and reserved_quantity >= $3::bigint
       returning id`,
      [reservation.offering_id, siteId, reservation.quantity],
    );
    if (updated.rowCount !== 1) throw new Error("The canceled Event Reservation could not be released safely.");
  }

  await client.query(
    `update hpos.reservations reservation
     set awaiting_provider_verification = true, updated_at = clock_timestamp()
     from hpos.orders order_row
     where order_row.id = reservation.order_id and order_row.site_id = reservation.site_id
       and reservation.site_id = $1 and reservation.event_id = $2
       and reservation.status = 'held'
       and (order_row.payment_status not in ('unpaid', 'failed') or exists (
         select 1 from hpos.payment_attempts attempt
         where attempt.site_id = order_row.site_id and attempt.order_id = order_row.id
           and attempt.status = 'requires_verification'
       ))`,
    [siteId, eventId],
  );
}

async function enqueueEventCancellationNotifications(
  client: PoolClient,
  siteId: string,
  event: EventRow,
  canceledAt: Date,
): Promise<void> {
  await supersedeUnsentNotificationJobs(client, { siteId, eventId: event.id, kinds: ["event_changed", "access_approved"] });
  const fullDetails = eventNotificationDetails(event, []);
  const details = {
    event_id: fullDetails.event_id,
    event_reference: fullDetails.event_reference,
    title: fullDetails.title,
    starts_at: fullDetails.starts_at,
    ends_at: fullDetails.ends_at,
    time_zone: fullDetails.time_zone,
    venue: fullDetails.venue,
  };
  const orders = await client.query<{ id: string; order_reference: string; delivery_email: string }>(
    `select id, order_reference, delivery_email
     from hpos.orders
     where site_id = $1 and event_id = $2 and payment_status = 'paid'
     order by created_at, id`,
    [siteId, event.id],
  );
  for (const order of orders.rows) {
    await enqueueNotificationJob(client, {
      siteId,
      kind: "event_canceled",
      eventId: event.id,
      orderId: order.id,
      payload: {
        recipient_email: order.delivery_email,
        order: { order_id: order.id, order_reference: order.order_reference },
        event: details,
        canceled_at: canceledAt.toISOString(),
      },
    });
  }
}

async function createDraft(client: PoolClient, site: AuthenticatedSite, input: EventInput): Promise<{ status: number; data: unknown }> {
  const eventId = randomUUID();
  const offeringId = randomUUID();
  const offering = input.ticket_offering ?? {};
  const salesEverConfigured = offering.price?.amount !== undefined
    && offering.capacity !== undefined && offering.capacity !== null
    && offering.sales_opens_at !== undefined && offering.sales_opens_at !== null
    && offering.sales_closes_at !== undefined && offering.sales_closes_at !== null;
  await client.query(
    `insert into hpos.events (
       id, site_id, ticket_offering_id, title, description, venue_name,
       venue_address, starts_at, starts_at_offset_minutes, ends_at,
       ends_at_offset_minutes, time_zone, check_in_opens_at,
       check_in_opens_offset_minutes, visibility, created_actor_type,
       created_actor_reference, updated_actor_type, updated_actor_reference
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10::timestamptz,
       $11, $12, $13::timestamptz, $14, $15, $16, $17, $16, $17
     )`,
    [
      eventId, site.siteId, offeringId, input.title ?? null, input.description ?? null,
      input.venue?.name ?? null, input.venue?.address ?? null,
      input.starts_at?.iso ?? null, input.starts_at?.offsetMinutes ?? null,
      input.ends_at?.iso ?? null, input.ends_at?.offsetMinutes ?? null,
      input.time_zone ?? null, input.check_in_opens_at?.iso ?? null,
      input.check_in_opens_at?.offsetMinutes ?? null, input.visibility ?? null,
      input.actor.type, input.actor.reference,
    ],
  );
  await client.query(
    `insert into hpos.ticket_offerings (
       id, event_id, site_id, price_amount, currency, capacity, tax_amount, buyer_fees,
       sales_opens_at, sales_opens_offset_minutes, sales_closes_at,
       sales_closes_offset_minutes, sales_ever_configured
     ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz, $10, $11::timestamptz, $12, $13)`,
    [
      offeringId, eventId, site.siteId, offering.price?.amount ?? null,
      offering.price?.currency ?? null, offering.capacity ?? null,
      offering.tax_amount ?? null, offering.buyer_fees === undefined ? null : JSON.stringify(offering.buyer_fees),
      offering.sales_opens_at?.iso ?? null, offering.sales_opens_at?.offsetMinutes ?? null,
      offering.sales_closes_at?.iso ?? null, offering.sales_closes_at?.offsetMinutes ?? null,
      salesEverConfigured,
    ],
  );
  const event = await readAdminEvent(client, site.siteId, eventId);
  if (!event) throw new Error("Created Event was not readable in its transaction.");
  return { status: 201, data: event };
}

function operationError(status: number, code: string, message: string, details: Array<{ field: string; code: string; message: string }> = []): never {
  throw new ApiOperationError(status, code, message, details);
}

function mapEventDatabaseError(error: unknown): Response | null {
  if (object(error) && error.code === "23514") return apiFailure(422, "validation_failed", "The Event update violates a field or time-window rule.");
  if (object(error) && error.code === "23503") return apiFailure(409, "invalid_state", "The Event or Ticket offering is no longer available.");
  return null;
}

function parseCursor(value: string | null, site: AuthenticatedSite, mode: string, scope: string): { at: string; id: string } | null | Response {
  if (value === null) return null;
  try {
    const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(value);
    if (value.length > 2048 || !match) throw new Error();
    const [, payload, signature] = match;
    const expectedSignature = createHmac("sha256", site.cursorSigningKey).update(payload).digest();
    const suppliedSignature = Buffer.from(signature, "base64url");
    if (suppliedSignature.length !== expectedSignature.length || !timingSafeEqual(suppliedSignature, expectedSignature)) throw new Error();
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (!object(decoded) || decoded.mode !== mode || decoded.siteId !== site.siteId || decoded.scope !== scope || typeof decoded.at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(decoded.at) || !UUID_PATTERN.test(String(decoded.id ?? ""))) throw new Error();
    if (!Number.isFinite(Date.parse(decoded.at))) throw new Error();
    if (typeof decoded.issuedAt !== "string" || !RFC3339_PATTERN.test(decoded.issuedAt)) throw new Error();
    const issuedAt = Date.parse(decoded.issuedAt);
    const now = Date.now();
    if (!Number.isFinite(issuedAt) || issuedAt < now - 60 * 60 * 1000 || issuedAt > now + 60_000) throw new Error();
    return { at: decoded.at, id: String(decoded.id) };
  } catch { return apiFailure(422, "invalid_cursor", "The cursor is invalid for this Event list."); }
}

function cursorFor(site: AuthenticatedSite, mode: string, scope: string, timestamp: string, id: string): string {
  const payload = Buffer.from(JSON.stringify({ mode, siteId: site.siteId, scope, issuedAt: new Date().toISOString(), at: timestamp, id }), "utf8").toString("base64url");
  const signature = createHmac("sha256", site.cursorSigningKey).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function listLimit(value: string | null): number | Response {
  if (value === null) return 50;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) return fieldError("limit", "out_of_range", "limit must be an integer from 1 to 100.");
  return Number(value);
}

async function listEvents(request: Request, site: AuthenticatedSite, admin: boolean): Promise<Response> {
  const url = new URL(request.url);
  const allowedParameters = new Set(admin
    ? ["limit", "cursor", "publication_status", "visibility", "is_archived", "is_canceled"]
    : ["limit", "cursor", "period"]);
  for (const name of url.searchParams.keys()) {
    if (!allowedParameters.has(name)) return fieldError(name, "unknown_filter", "Remove the unsupported Event list parameter.");
  }
  const limit = listLimit(url.searchParams.get("limit"));
  if (limit instanceof Response) return limit;
  const period = url.searchParams.get("period") ?? "current";
  if (!admin && period !== "current" && period !== "past") return fieldError("period", "unsupported_value", "period must be current or past.");
  const mode = admin ? "admin" : period;
  const where = ["e.site_id = $1"];
  const values: unknown[] = [site.siteId];
  let scope: Record<string, unknown>;
  const add = (expression: string, value: unknown) => { values.push(value); where.push(expression.replace("?", `$${values.length}`)); };
  if (admin) {
    const filters: Array<[string, string[]]> = [["publication_status", ["draft", "published"]], ["visibility", ["public", "private"]]];
    for (const [name, allowed] of filters) {
      const value = url.searchParams.get(name);
      if (value !== null) {
        if (!allowed.includes(value)) return fieldError(name, "unsupported_value", `${name} has an unsupported value.`);
        add(`e.${name} = ?`, value);
      }
    }
    for (const name of ["is_archived", "is_canceled"] as const) {
      const value = url.searchParams.get(name);
      if (value !== null && value !== "true" && value !== "false") return fieldError(name, "invalid_boolean", `${name} must be true or false.`);
      if (value !== null || name === "is_archived") add(`e.${name} = ?`, value === "true");
    }
    scope = {
      limit,
      publication_status: url.searchParams.get("publication_status"),
      visibility: url.searchParams.get("visibility"),
      is_archived: url.searchParams.get("is_archived") ?? "false",
      is_canceled: url.searchParams.get("is_canceled"),
    };
  } else {
    add("e.publication_status = ?", "published");
    if (period === "current") where.push("e.is_archived = false", "e.ends_at > clock_timestamp()");
    else where.push("e.ends_at <= clock_timestamp()");
    scope = { limit, period };
  }
  const cursorScope = JSON.stringify(scope);
  const cursor = parseCursor(url.searchParams.get("cursor"), site, mode, cursorScope);
  if (cursor instanceof Response) return cursor;
  if (cursor) {
    values.push(cursor.at, cursor.id);
    const timeColumn = admin ? "e.created_at" : "e.starts_at";
    const timeOp = !admin && period === "current" ? ">" : "<";
    where.push(`(${timeColumn} ${timeOp} $${values.length - 1}::timestamptz or (${timeColumn} = $${values.length - 1}::timestamptz and e.id > $${values.length}::uuid))`);
  }
  values.push(limit + 1);
  const orderBy = admin ? "e.created_at desc, e.id asc" : period === "past" ? "e.starts_at desc, e.id asc" : "e.starts_at asc, e.id asc";
  const query = `select e.id, e.site_id, e.ticket_offering_id, e.title, e.description,
    e.venue_name, e.venue_address, e.starts_at, e.starts_at_offset_minutes,
    e.ends_at, e.ends_at_offset_minutes, e.time_zone, e.check_in_opens_at,
    e.check_in_opens_offset_minutes, e.visibility, e.publication_status,
    e.is_canceled, e.is_archived, e.sales_paused, e.version, e.created_at,
    e.updated_at, e.created_actor_type, e.created_actor_reference,
    e.updated_actor_type, e.updated_actor_reference, o.price_amount, o.currency, o.tax_amount, o.buyer_fees,
    o.capacity, o.reserved_quantity, o.sales_opens_at, o.sales_opens_offset_minutes,
    o.sales_closes_at, o.sales_closes_offset_minutes,
    to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_cursor_time,
    to_char(e.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as starts_cursor_time
    from hpos.events e join hpos.ticket_offerings o on o.id=e.ticket_offering_id
      and o.event_id=e.id and o.site_id=e.site_id
    where ${where.join(" and ")} order by ${orderBy} limit $${values.length}`;
  const result = await getBusinessPool().query<EventRow>(query, values);
  const rows = result.rows.slice(0, limit);
  const hasMore = result.rows.length > limit;
  const last = rows.at(-1);
  const nextCursor = hasMore && last
    ? cursorFor(site, mode, cursorScope, admin ? last.created_cursor_time! : last.starts_cursor_time!, last.id)
    : null;
  if (!admin) return apiSuccess(rows.map((row) => eventData(row, false)), 200, { nextCursor });
  const mappingsResult = rows.length === 0
    ? { rows: [] as ProviderMappingRow[] }
    : await getBusinessPool().query<ProviderMappingRow>(
      `select event_id, connection_id, resource_type, resource_reference, verified_at
       from hpos.ticket_offering_provider_mappings
       where site_id = $1 and event_id = any($2::uuid[])
       order by event_id asc, connection_id asc`,
      [site.siteId, rows.map((row) => row.id)],
    );
  const mappingsByEvent = new Map<string, ProviderMappingRow[]>();
  for (const mapping of mappingsResult.rows) {
    const current = mappingsByEvent.get(mapping.event_id) ?? [];
    current.push(mapping);
    mappingsByEvent.set(mapping.event_id, current);
  }
  const data = rows.map((row) => {
    const event = eventData(row, true);
    setProviderMappings(event, mappingsByEvent.get(row.id) ?? []);
    return event;
  });
  return apiSuccess(data, 200, { nextCursor });
}

async function readEvent(site: AuthenticatedSite, eventId: string, admin: boolean): Promise<Response> {
  if (!UUID_PATTERN.test(eventId)) return apiFailure(404, "not_found", "The Event is not available to this Site.");
  if (admin) {
    const client = await getBusinessPool().connect();
    try {
      const event = await readAdminEvent(client, site.siteId, eventId);
      return event ? apiSuccess(event) : apiFailure(404, "not_found", "The Event is not available to this Site.");
    } finally {
      client.release();
    }
  }
  const query = `select e.id, e.site_id, e.ticket_offering_id, e.title, e.description,
    e.venue_name, e.venue_address, e.starts_at, e.starts_at_offset_minutes,
    e.ends_at, e.ends_at_offset_minutes, e.time_zone, e.check_in_opens_at,
    e.check_in_opens_offset_minutes, e.visibility, e.publication_status,
    e.is_canceled, e.is_archived, e.sales_paused, e.version, e.created_at,
    e.updated_at, e.created_actor_type, e.created_actor_reference,
    e.updated_actor_type, e.updated_actor_reference, o.price_amount, o.currency, o.tax_amount, o.buyer_fees,
    o.capacity, o.reserved_quantity, o.sales_opens_at, o.sales_opens_offset_minutes,
    o.sales_closes_at, o.sales_closes_offset_minutes
    from hpos.events e join hpos.ticket_offerings o on o.id=e.ticket_offering_id
      and o.event_id=e.id and o.site_id=e.site_id
    where e.site_id=$1 and e.id=$2 ${admin ? "" : "and e.publication_status='published'"}`;
  const result = await getBusinessPool().query<EventRow>(query, [site.siteId, eventId]);
  return result.rows[0] ? apiSuccess(eventData(result.rows[0], false)) : apiFailure(404, "not_found", "The Event is not available to this Site.");
}

function validatePublish(row: EventRow): void {
  const missing = ([
    ["title", row.title], ["description", row.description], ["venue.name", row.venue_name],
    ["starts_at", row.starts_at], ["ends_at", row.ends_at], ["time_zone", row.time_zone], ["visibility", row.visibility],
  ] as Array<[string, unknown]>).filter(([, value]) => value === null || value === "").map(([field]) => ({ field, code: "required", message: "This field is required before publication." }));
  if (missing.length) operationError(422, "validation_failed", "Complete the required Event details before publishing.", missing);
  if (row.starts_at!.getTime() >= row.ends_at!.getTime()) operationError(422, "validation_failed", "The Event end must follow its start.", [{ field: "ends_at", code: "must_follow_start", message: "Choose an end after the start." }]);
  validateEventTimes(row);
  if (row.sales_opens_at && row.sales_closes_at && row.sales_closes_at <= row.sales_opens_at) operationError(422, "validation_failed", "The sales closing time must follow the opening time.", [{ field: "ticket_offering.sales_closes_at", code: "invalid_window", message: "Choose a closing time after sales open." }]);
  if (row.sales_closes_at && row.sales_closes_at > row.ends_at!) operationError(422, "validation_failed", "Sales must close no later than the Event end.", [{ field: "ticket_offering.sales_closes_at", code: "after_event_end", message: "Choose a closing time on or before ends_at." }]);
  if (row.buyer_fees && row.currency && row.buyer_fees.some((fee) => fee.currency !== row.currency)) {
    operationError(422, "validation_failed", "Buyer fees must use the Ticket currency.", [{ field: "ticket_offering.buyer_fees", code: "currency_mismatch", message: "Update each buyer fee to use the Ticket offering currency." }]);
  }
}

function validateEventTimes(row: EventRow): void {
  const stamps: Array<[string, Date | null, number | null]> = [
    ["starts_at", row.starts_at, row.starts_at_offset_minutes],
    ["ends_at", row.ends_at, row.ends_at_offset_minutes],
    ["check_in_opens_at", row.check_in_opens_at, row.check_in_opens_offset_minutes],
    ["ticket_offering.sales_opens_at", row.sales_opens_at, row.sales_opens_offset_minutes],
    ["ticket_offering.sales_closes_at", row.sales_closes_at, row.sales_closes_offset_minutes],
  ];
  for (const [field, time, offset] of stamps) {
    if (time && row.time_zone && offset !== null && zoneOffsetAt(time.toISOString(), row.time_zone) !== Number(offset)) {
      operationError(422, "validation_failed", "Timestamp offsets must match the Event time zone.", [{ field, code: "offset_mismatch", message: "The timestamp offset must match time_zone at that instant." }]);
    }
  }
  if (row.sales_closes_at && row.sales_closes_at > (row.ends_at ?? new Date(8640000000000000))) {
    operationError(422, "validation_failed", "Sales must close no later than the Event end.", [{ field: "ticket_offering.sales_closes_at", code: "after_event_end", message: "Choose a closing time on or before ends_at." }]);
  }
  if (row.sales_opens_at && row.sales_closes_at && row.sales_closes_at <= row.sales_opens_at) {
    operationError(422, "validation_failed", "The sales closing time must follow the opening time.", [{ field: "ticket_offering.sales_closes_at", code: "invalid_window", message: "Choose a closing time after sales open." }]);
  }
}

function numericVersion(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

async function writeEventPatch(client: PoolClient, site: AuthenticatedSite, eventId: string, body: Record<string, unknown>, input: EventInput): Promise<IdempotentResult> {
  const expected = numericVersion(body.expected_version);
  if (!expected) operationError(422, "validation_failed", "Provide expected_version.", [{ field: "expected_version", code: "required", message: "Use the Event version you loaded." }]);
  const selected = await client.query<EventRow>(`select e.id, e.site_id, e.ticket_offering_id, e.title, e.description,
    e.venue_name, e.venue_address, e.starts_at, e.starts_at_offset_minutes,
    e.ends_at, e.ends_at_offset_minutes, e.time_zone, e.check_in_opens_at,
    e.check_in_opens_offset_minutes, e.visibility, e.publication_status,
    e.is_canceled, e.is_archived, e.sales_paused, e.version, e.created_at,
    e.updated_at, e.created_actor_type, e.created_actor_reference,
    e.updated_actor_type, e.updated_actor_reference, o.price_amount, o.currency, o.tax_amount, o.buyer_fees,
    o.capacity, o.reserved_quantity, o.sales_opens_at, o.sales_opens_offset_minutes,
    o.sales_closes_at, o.sales_closes_offset_minutes, o.sales_ever_configured
    from hpos.events e join hpos.ticket_offerings o on o.id=e.ticket_offering_id
      and o.event_id=e.id and o.site_id=e.site_id where e.site_id=$1 and e.id=$2
      for update of e, o`, [site.siteId, eventId]);
  const current = selected.rows[0];
  if (!current) operationError(404, "not_found", "The Event is not available to this Site.");
  if (current.version !== expected) operationError(409, "version_conflict", "The Event changed after you loaded it. Reload it before editing.");
  if (current.publication_status === "published" && Object.hasOwn(input, "visibility") && input.visibility !== current.visibility) operationError(409, "visibility_locked", "Event visibility cannot change after publication.");
  const offer = input.ticket_offering;
  if (offer && Object.hasOwn(offer, "capacity")) {
    const committedQuantity = Number(current.reserved_quantity);
    if (committedQuantity > 0 && (offer.capacity === null || (typeof offer.capacity === "number" && offer.capacity < committedQuantity))) {
      operationError(422, "validation_failed", "Capacity cannot be lower than the quantity already committed.", [{
        field: "ticket_offering.capacity",
        code: "below_committed_capacity",
        message: "Choose a capacity that covers the current committed quantity.",
      }]);
    }
  }
  if (current.sales_ever_configured && offer) {
    const clearing = [
      Object.hasOwn(offer, "price") && offer.price === null ? "ticket_offering.price" : null,
      Object.hasOwn(offer, "capacity") && offer.capacity === null ? "ticket_offering.capacity" : null,
      Object.hasOwn(offer, "sales_opens_at") && offer.sales_opens_at === null ? "ticket_offering.sales_opens_at" : null,
      Object.hasOwn(offer, "sales_closes_at") && offer.sales_closes_at === null ? "ticket_offering.sales_closes_at" : null,
      Object.hasOwn(offer, "tax_amount") && offer.tax_amount === null && current.tax_amount !== null ? "ticket_offering.tax_amount" : null,
      Object.hasOwn(offer, "buyer_fees") && offer.buyer_fees === null && current.buyer_fees !== null ? "ticket_offering.buyer_fees" : null,
    ].filter((field): field is string => field !== null);
    if (clearing.length) operationError(409, "sales_configuration_locked", "A complete sales configuration cannot be cleared after it has been saved.", clearing.map((field) => ({ field, code: "cannot_clear", message: "Set a replacement value instead of clearing this field." })));
  }
  const eventSets: string[] = [];
  const eventArgs: unknown[] = [site.siteId, eventId];
  const addEvent = (column: string, value: unknown) => { eventArgs.push(value); eventSets.push(`${column}=$${eventArgs.length}`); };
  const addTime = (column: string, offsetColumn: string, value: ParsedTimestamp | null) => {
    eventArgs.push(value?.iso ?? null);
    const timeIndex = eventArgs.length;
    eventArgs.push(value?.offsetMinutes ?? null);
    eventSets.push(`${column}=$${timeIndex}::timestamptz`, `${offsetColumn}=$${timeIndex + 1}`);
  };
  if (Object.hasOwn(input, "title")) addEvent("title", input.title);
  if (Object.hasOwn(input, "description")) addEvent("description", input.description);
  if (input.venue && Object.hasOwn(input.venue, "name")) addEvent("venue_name", input.venue.name);
  if (input.venue && Object.hasOwn(input.venue, "address")) addEvent("venue_address", input.venue.address);
  if (Object.hasOwn(input, "starts_at")) addTime("starts_at", "starts_at_offset_minutes", input.starts_at ?? null);
  if (Object.hasOwn(input, "ends_at")) addTime("ends_at", "ends_at_offset_minutes", input.ends_at ?? null);
  if (Object.hasOwn(input, "check_in_opens_at")) addTime("check_in_opens_at", "check_in_opens_offset_minutes", input.check_in_opens_at ?? null);
  if (Object.hasOwn(input, "time_zone")) addEvent("time_zone", input.time_zone);
  if (Object.hasOwn(input, "visibility")) addEvent("visibility", input.visibility);
  if (eventSets.length) await client.query(`update hpos.events set ${eventSets.join(", ")} where site_id=$1 and id=$2`, eventArgs);
  if (offer) {
    const sets: string[] = [];
    const args: unknown[] = [current.ticket_offering_id, site.siteId];
    const add = (column: string, value: unknown) => { args.push(value); sets.push(`${column}=$${args.length}`); };
    if (Object.hasOwn(offer, "price")) { add("price_amount", offer.price?.amount ?? null); add("currency", offer.price?.currency ?? null); }
    if (Object.hasOwn(offer, "capacity")) add("capacity", offer.capacity);
    if (Object.hasOwn(offer, "sales_opens_at")) { add("sales_opens_at", offer.sales_opens_at?.iso ?? null); add("sales_opens_offset_minutes", offer.sales_opens_at?.offsetMinutes ?? null); }
    if (Object.hasOwn(offer, "sales_closes_at")) { add("sales_closes_at", offer.sales_closes_at?.iso ?? null); add("sales_closes_offset_minutes", offer.sales_closes_at?.offsetMinutes ?? null); }
    if (Object.hasOwn(offer, "tax_amount")) add("tax_amount", offer.tax_amount);
    if (Object.hasOwn(offer, "buyer_fees")) add("buyer_fees", offer.buyer_fees === null ? null : JSON.stringify(offer.buyer_fees));
    if (sets.length) await client.query(`update hpos.ticket_offerings set ${sets.join(", ")} where id=$1 and site_id=$2`, args);
  }
  const mergedResult = await client.query<EventRow>(`select e.id, e.site_id, e.ticket_offering_id, e.title, e.description,
    e.venue_name, e.venue_address, e.starts_at, e.starts_at_offset_minutes,
    e.ends_at, e.ends_at_offset_minutes, e.time_zone, e.check_in_opens_at,
    e.check_in_opens_offset_minutes, e.visibility, e.publication_status,
    e.is_canceled, e.is_archived, e.sales_paused, e.version, e.created_at,
    e.updated_at, e.created_actor_type, e.created_actor_reference,
    e.updated_actor_type, e.updated_actor_reference, o.price_amount, o.currency, o.tax_amount, o.buyer_fees,
    o.capacity, o.reserved_quantity, o.sales_opens_at, o.sales_opens_offset_minutes,
    o.sales_closes_at, o.sales_closes_offset_minutes
    from hpos.events e join hpos.ticket_offerings o on o.id=e.ticket_offering_id
      and o.event_id=e.id and o.site_id=e.site_id where e.site_id=$1 and e.id=$2`, [site.siteId, eventId]);
  const merged = mergedResult.rows[0];
  if (!merged) operationError(404, "not_found", "The Event is not available to this Site.");
  validateEventTimes(merged);
  if (merged.publication_status === "published") validatePublish(merged);
  const result = await client.query(`update hpos.events set version=version+1, updated_at=clock_timestamp(), updated_actor_type=$3, updated_actor_reference=$4 where site_id=$1 and id=$2`, [site.siteId, eventId, input.actor.type, input.actor.reference]);
  void result;
  await client.query(`update hpos.ticket_offerings set sales_ever_configured=(sales_ever_configured or (price_amount is not null and capacity is not null and sales_opens_at is not null and sales_closes_at is not null)) where event_id=$1`, [eventId]);
  if (merged.publication_status === "published") {
    const changedFields = changedArrivalFields(current, merged);
    await enqueueEventChangeNotifications(client, site.siteId, merged, changedFields);
    if (walletEventDataChanged(current, merged)) {
      await enqueueWalletUpdateJobsForEvent(client, site.siteId, eventId);
    }
  }
  const event = await readAdminEvent(client, site.siteId, eventId);
  if (!event) throw new Error("Updated Event could not be read.");
  return { status: 200, data: event };
}

async function writeEventAction(client: PoolClient, site: AuthenticatedSite, eventId: string, action: string, body: Record<string, unknown>): Promise<IdempotentResult> {
  const actor = actorFrom(body.actor);
  if (!actor) operationError(422, "validation_failed", "Include a user or system actor for audit attribution.", [{ field: "actor", code: "invalid_actor", message: "Use a non-secret Site-local reference." }]);
  const expected = numericVersion(body.expected_version);
  if (!expected) operationError(422, "validation_failed", "Provide expected_version.", [{ field: "expected_version", code: "required", message: "Use the Event version you loaded." }]);
  const selected = await client.query<EventRow>(`select e.id, e.site_id, e.ticket_offering_id, e.title, e.description,
    e.venue_name, e.venue_address, e.starts_at, e.starts_at_offset_minutes,
    e.ends_at, e.ends_at_offset_minutes, e.time_zone, e.check_in_opens_at,
    e.check_in_opens_offset_minutes, e.visibility, e.publication_status,
    e.is_canceled, e.is_archived, e.sales_paused, e.version, e.created_at,
    e.updated_at, e.created_actor_type, e.created_actor_reference,
    e.updated_actor_type, e.updated_actor_reference, o.price_amount, o.currency, o.tax_amount, o.buyer_fees,
    o.capacity, o.reserved_quantity, o.sales_opens_at, o.sales_opens_offset_minutes,
    o.sales_closes_at, o.sales_closes_offset_minutes
    from hpos.events e join hpos.ticket_offerings o on o.id=e.ticket_offering_id
      and o.event_id=e.id and o.site_id=e.site_id where e.site_id=$1 and e.id=$2
      ${action === "cancel" ? "for update of e" : "for update of e, o"}`, [site.siteId, eventId]);
  const current = selected.rows[0];
  if (!current) operationError(404, "not_found", "The Event is not available to this Site.");
  if (current.version !== expected) operationError(409, "version_conflict", "The Event changed after you loaded it. Reload it before taking this action.");
  const now = Date.now();
  let column: string | null = null;
  let value: unknown;
  if (action === "publish") {
    if (current.publication_status !== "draft") operationError(409, "invalid_state", "Only a draft Event can be published.");
    validatePublish(current); column = "publication_status"; value = "published";
  } else if (action === "cancel") {
    if (current.publication_status !== "published" || current.is_archived || current.is_canceled
      || !current.ends_at || current.ends_at.getTime() <= now) {
      operationError(409, "invalid_state", "Only a current, published Event can be canceled.");
    }
  } else if (action === "archive") {
    if (current.publication_status !== "published" || current.is_archived || (!current.is_canceled && (!current.ends_at || current.ends_at.getTime() > now))) operationError(409, "invalid_state", "Only an ended or canceled published Event can be archived.");
    column = "is_archived"; value = true;
  } else if (action === "stop_sales") {
    if (current.publication_status !== "published" || current.is_archived || current.is_canceled || !current.ends_at || current.ends_at.getTime() <= now || current.sales_paused) {
      operationError(409, "invalid_state", "Sales can be stopped once on a published Event that has not ended or been canceled.");
    }
    column = "sales_paused"; value = true;
  } else if (action === "resume_sales") {
    const configured = current.price_amount !== null
      && current.currency !== null
      && current.tax_amount !== null
      && current.buyer_fees !== null
      && current.capacity !== null
      && current.sales_opens_at !== null
      && current.sales_closes_at !== null;
    const withinSalesWindow = current.sales_opens_at !== null
      && current.sales_closes_at !== null
      && current.sales_opens_at.getTime() <= now
      && current.sales_closes_at.getTime() > now;
    const capacityAvailable = current.capacity !== null
      && Number(current.capacity) > Number(current.reserved_quantity);
    if (current.publication_status !== "published" || current.is_archived || current.is_canceled || !current.ends_at || current.ends_at.getTime() <= now
      || !current.sales_paused || !configured || !withinSalesWindow || !capacityAvailable) {
      operationError(409, "invalid_state", "Sales can resume only while the published Event has complete pricing, an open sales window, and available capacity.");
    }
    column = "sales_paused"; value = false;
  } else operationError(404, "not_found", "The Event action is unavailable.");
  if (action === "cancel") {
    const canceled = await client.query<{ canceled_at: Date }>(
      `update hpos.events
       set is_canceled = true, sales_paused = true, canceled_at = clock_timestamp(), version = version + 1,
           updated_at = clock_timestamp(), updated_actor_type = $3, updated_actor_reference = $4
       where site_id = $1 and id = $2
       returning canceled_at`,
      [site.siteId, eventId, actor.type, actor.reference],
    );
    const canceledAt = canceled.rows[0]?.canceled_at;
    if (!canceledAt) throw new Error("The canceled Event timestamp could not be read.");
    await terminateCanceledEventCheckouts(client, site.siteId, eventId);
    await enqueueWalletUpdateJobsForEvent(client, site.siteId, eventId);
    await enqueueEventCancellationNotifications(client, site.siteId, { ...current, is_canceled: true }, canceledAt);
  } else {
    if (column === null) throw new Error("The Event action has no state update.");
    await client.query(`update hpos.events set ${column}=$3, version=version+1, updated_at=clock_timestamp(), updated_actor_type=$4, updated_actor_reference=$5 where site_id=$1 and id=$2`, [site.siteId, eventId, value, actor.type, actor.reference]);
    if (action === "archive") {
      await enqueueWalletUpdateJobsForEvent(client, site.siteId, eventId);
    }
  }
  const event = await readAdminEvent(client, site.siteId, eventId);
  if (!event) throw new Error("Changed Event could not be read.");
  return { status: 200, data: event };
}

export async function handleEventGet(_request: Request, _site: AuthenticatedSite, _path: string[]): Promise<Response | null> {
  const request = _request;
  const site = _site;
  const path = _path;
  if (path.length === 2 && path[0] === "admin" && path[1] === "events") return listEvents(request, site, true);
  if (path.length === 3 && path[0] === "admin" && path[1] === "events") return readEvent(site, path[2], true);
  if (path.length === 2 && path[0] === "public" && path[1] === "events") return listEvents(request, site, false);
  if (path.length === 3 && path[0] === "public" && path[1] === "events") return readEvent(site, path[2], false);
  return null;
}

export async function handleEventPost(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (path.length !== 2 || path[0] !== "admin" || path[1] !== "events") return null;
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  const input = parseEventInput(body);
  if (input instanceof Response) return input;
  return withApiIdempotency(request, site, body, (client) => createDraft(client, site, input), mapEventDatabaseError);
}

export async function handleEventPatch(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (path.length !== 3 || path[0] !== "admin" || path[1] !== "events") return null;
  const eventId = path[2];
  if (!UUID_PATTERN.test(eventId)) return apiFailure(404, "not_found", "The Event is not available to this Site.");
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  if (!hasOnlyKeys(body, ["actor", "expected_version", "title", "description", "venue", "starts_at", "ends_at", "time_zone", "check_in_opens_at", "visibility", "ticket_offering"])) {
    const unknown = Object.keys(body).find((key) => !["actor", "expected_version", "title", "description", "venue", "starts_at", "ends_at", "time_zone", "check_in_opens_at", "visibility", "ticket_offering"].includes(key)) ?? "unknown";
    return fieldError(unknown, "unknown_field", "Remove the unsupported field.");
  }
  const expectedVersion = numericVersion(body.expected_version);
  if (!expectedVersion) return fieldError("expected_version", "required", "Provide the Event version you loaded.");
  const fields = { ...body };
  delete fields.expected_version;
  const input = parseEventInput(fields);
  if (input instanceof Response) return input;
  return withApiIdempotency(request, site, body, (client) => writeEventPatch(client, site, eventId, body, input), mapEventDatabaseError);
}

export async function handleEventActionPost(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (path.length !== 5 || path[0] !== "admin" || path[1] !== "events" || path[3] !== "actions") return null;
  if (!UUID_PATTERN.test(path[2])) return apiFailure(404, "not_found", "The Event is not available to this Site.");
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  if (!hasOnlyKeys(body, ["actor", "expected_version"])) return fieldError("body", "unknown_field", "Only actor and expected_version are accepted for this action.");
  if (!Object.hasOwn(body, "actor")) return fieldError("actor", "required", "Include a user or system actor for audit attribution.");
  return withApiIdempotency(request, site, body, (client) => writeEventAction(client, site, path[2], path[4], body), mapEventDatabaseError);
}
