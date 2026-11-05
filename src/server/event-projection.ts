/**
 * The persisted Event fields needed by the public Event projection.
 *
 * This input is shared by public Event reads, buyer Order/Ticket reads, and
 * Wallet data. Keeping it here prevents those consumers from depending on
 * the Event mutation module.
 */
export interface PublicEventProjectionRow {
  id: string;
  title: string | null;
  description: string | null;
  event_type: string | null;
  logo_path: string | null;
  performers: string[];
  artists: string[];
  vendors: string[];
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
  is_canceled: boolean;
  is_archived: boolean;
  sales_paused: boolean;
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

export type EventSalesState = Pick<PublicEventProjectionRow,
  | "is_canceled"
  | "ends_at"
  | "price_amount"
  | "tax_amount"
  | "buyer_fees"
  | "capacity"
  | "sales_opens_at"
  | "sales_closes_at"
  | "sales_paused"
  | "reserved_quantity"
>;

export type SalesStatus = "canceled" | "closed" | "not_configured" | "scheduled" | "paused" | "sold_out" | "open";

export function eventTimestamp(value: Date | null, offsetMinutes: number | null = 0): string | null {
  if (!value) return null;
  const offset = Number(offsetMinutes ?? 0);
  const local = new Date(value.getTime() + offset * 60_000).toISOString().replace(/\.000Z$/, "Z");
  const suffix = offset === 0
    ? "Z"
    : `${offset < 0 ? "-" : "+"}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}:${String(Math.abs(offset) % 60).padStart(2, "0")}`;
  return local.replace(/Z$/, suffix);
}

export function safeEventNumber(value: string | null): number | null {
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

export function publicEventData(row: PublicEventProjectionRow): Record<string, unknown> {
  const amount = safeEventNumber(row.price_amount);
  return {
    event_id: row.id,
    title: row.title,
    description: row.description,
    event_type: row.event_type,
    logo_path: row.logo_path,
    performers: row.performers,
    artists: row.artists,
    vendors: row.vendors,
    venue: { name: row.venue_name, address: row.venue_address },
    starts_at: eventTimestamp(row.starts_at, row.starts_at_offset_minutes),
    ends_at: eventTimestamp(row.ends_at, row.ends_at_offset_minutes),
    time_zone: row.time_zone,
    check_in_opens_at: eventTimestamp(
      row.check_in_opens_at ?? row.starts_at,
      row.check_in_opens_offset_minutes ?? row.starts_at_offset_minutes,
    ),
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
}

/** Event fields that are persisted in Wallet update data versions. */
export function walletEventProjection(row: PublicEventProjectionRow): Record<string, unknown> {
  const projection = publicEventData(row);
  delete projection.sales_status;
  delete projection.logo_path;
  delete projection.performers;
  delete projection.artists;
  delete projection.vendors;
  return projection;
}
