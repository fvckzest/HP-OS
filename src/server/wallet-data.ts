import { createHash } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { apiFailure, apiSuccess } from "./api-response";
import { getBusinessPool } from "./database";
import { publicEventData } from "./events";
import { enqueueNotificationJob } from "./notifications";
import type { AuthenticatedSite } from "./site-auth";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

interface WalletDataRow extends QueryResultRow {
  ticket_id: string;
  qr_payload: string;
  attendee_name: string | null;
  admission_id: string | null;
  refund_status: "none" | "partial" | "full";
  site_id: string;
  event_id: string;
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
  event_version: number;
  event_created_at: Date;
  event_updated_at: Date;
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

const WALLET_SELECT = `select ticket.id as ticket_id, ticket.qr_payload, ticket.attendee_name,
                   admission.id as admission_id, order_row.refund_status,
                   event_row.site_id, event_row.id as event_id, event_row.title, event_row.description,
                   event_row.venue_name, event_row.venue_address, event_row.starts_at,
                   event_row.starts_at_offset_minutes, event_row.ends_at,
                   event_row.ends_at_offset_minutes, event_row.time_zone,
                   event_row.check_in_opens_at, event_row.check_in_opens_offset_minutes,
                   event_row.visibility, event_row.publication_status, event_row.is_canceled,
                   event_row.is_archived, event_row.sales_paused,
                   event_row.version as event_version, event_row.created_at as event_created_at,
                   event_row.updated_at as event_updated_at,
                   event_row.created_actor_type, event_row.created_actor_reference,
                   event_row.updated_actor_type, event_row.updated_actor_reference,
                   offering.price_amount, offering.currency, offering.tax_amount,
                   offering.buyer_fees, offering.capacity, offering.reserved_quantity,
                   offering.sales_opens_at, offering.sales_opens_offset_minutes,
                   offering.sales_closes_at, offering.sales_closes_offset_minutes
            from hpos.tickets ticket
            join hpos.orders order_row
              on order_row.id = ticket.order_id and order_row.site_id = ticket.site_id
            join hpos.events event_row
              on event_row.id = ticket.event_id and event_row.site_id = ticket.site_id
            join hpos.ticket_offerings offering
              on offering.id = ticket.offering_id
             and offering.event_id = ticket.event_id
             and offering.site_id = ticket.site_id
            left join hpos.admissions admission
              on admission.site_id = ticket.site_id and admission.ticket_id = ticket.id`;

function walletQuery(path: string, siteId: string, value: string) {
  const where = path === "public"
    ? "ticket.ticket_token_hash = $2"
    : "ticket.id = $2";
  return {
    text: `${WALLET_SELECT} where ticket.site_id = $1 and ${where}`,
    values: [siteId, value],
  };
}

function walletBatchQuery(siteId: string, ticketIds: string[]) {
  return {
    text: `${WALLET_SELECT}
            where ticket.site_id = $1 and ticket.id = any($2::uuid[])
            order by ticket.id`,
    values: [siteId, ticketIds],
  };
}

function dataVersion(data: Omit<WalletData, "data_version">): string {
  // sales_status is computed from the current clock for public presentation.
  // It is intentionally excluded so an unchanged persisted Ticket/Event does
  // not receive a new Wallet version merely because time has passed.
  const stable = { ...data, event: { ...data.event } };
  delete stable.event.sales_status;
  return createHash("sha256")
    .update(JSON.stringify(stable), "utf8")
    .digest("base64url");
}

export interface WalletData {
  ticket_id: string;
  event: Record<string, unknown>;
  qr_payload: string;
  attendee_name: string | null;
  used: boolean;
  voided: boolean;
  data_version: string;
}

function walletData(row: WalletDataRow): WalletData {
  const event = publicEventData({
    id: row.event_id,
    site_id: row.site_id,
    ticket_offering_id: "",
    title: row.title,
    description: row.description,
    venue_name: row.venue_name,
    venue_address: row.venue_address,
    starts_at: row.starts_at,
    starts_at_offset_minutes: row.starts_at_offset_minutes,
    ends_at: row.ends_at,
    ends_at_offset_minutes: row.ends_at_offset_minutes,
    time_zone: row.time_zone,
    check_in_opens_at: row.check_in_opens_at,
    check_in_opens_offset_minutes: row.check_in_opens_offset_minutes,
    visibility: row.visibility,
    publication_status: row.publication_status,
    is_canceled: row.is_canceled,
    is_archived: row.is_archived,
    sales_paused: row.sales_paused,
    version: row.event_version,
    created_at: row.event_created_at,
    updated_at: row.event_updated_at,
    created_actor_type: row.created_actor_type,
    created_actor_reference: row.created_actor_reference,
    updated_actor_type: row.updated_actor_type,
    updated_actor_reference: row.updated_actor_reference,
    price_amount: row.price_amount,
    currency: row.currency,
    tax_amount: row.tax_amount,
    buyer_fees: row.buyer_fees,
    capacity: row.capacity,
    reserved_quantity: row.reserved_quantity,
    sales_opens_at: row.sales_opens_at,
    sales_opens_offset_minutes: row.sales_opens_offset_minutes,
    sales_closes_at: row.sales_closes_at,
    sales_closes_offset_minutes: row.sales_closes_offset_minutes,
  });
  const current = {
    ticket_id: row.ticket_id,
    event,
    qr_payload: row.qr_payload,
    attendee_name: row.attendee_name,
    used: row.admission_id !== null,
    voided: row.is_canceled || row.refund_status === "full",
  };
  return { ...current, data_version: dataVersion(current) };
}

/**
 * Queue current Wallet payload versions inside the caller's transaction.
 * The Site worker must retrieve the current payload before updating a pass;
 * the queued version identifies the state that caused this work.
 */
export async function enqueueWalletUpdateJobs(
  client: PoolClient,
  siteId: string,
  ticketIds: string[],
): Promise<void> {
  const uniqueTicketIds = [...new Set(ticketIds)].sort();
  if (uniqueTicketIds.length === 0) return;

  const query = walletBatchQuery(siteId, uniqueTicketIds);
  const result = await client.query<WalletDataRow>(query.text, query.values);
  const rowsByTicket = new Map(result.rows.map((row) => [row.ticket_id, row]));
  if (rowsByTicket.size !== uniqueTicketIds.length) {
    throw new Error("A Wallet update Ticket could not be read in its transaction.");
  }

  for (const ticketId of uniqueTicketIds) {
    const data = walletData(rowsByTicket.get(ticketId)!);
    await enqueueNotificationJob(client, {
      siteId,
      kind: "wallet_update",
      ticketId,
      payload: { ticket_id: data.ticket_id, data_version: data.data_version },
    });
  }
}

export async function enqueueWalletUpdateJobsForEvent(
  client: PoolClient,
  siteId: string,
  eventId: string,
): Promise<void> {
  const tickets = await client.query<{ id: string }>(
    `select id from hpos.tickets where site_id = $1 and event_id = $2 order by id`,
    [siteId, eventId],
  );
  await enqueueWalletUpdateJobs(client, siteId, tickets.rows.map((ticket) => ticket.id));
}

export async function enqueueWalletUpdateJobsForOrder(
  client: PoolClient,
  siteId: string,
  orderId: string,
): Promise<void> {
  const tickets = await client.query<{ id: string }>(
    `select id from hpos.tickets where site_id = $1 and order_id = $2 order by id`,
    [siteId, orderId],
  );
  await enqueueWalletUpdateJobs(client, siteId, tickets.rows.map((ticket) => ticket.id));
}

export async function handleWalletDataGet(site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (path.length !== 4 || path[0] === undefined || path[1] !== "tickets" || path[3] !== "apple-wallet-data") return null;

  const scope = path[0];
  const value = path[2];
  if ((scope !== "public" && scope !== "admin") || value === undefined) return null;
  if (scope === "public" && !TOKEN_PATTERN.test(value)) {
    return apiFailure(404, "not_found", "The Ticket is not available to this Site.");
  }
  if (scope === "admin" && !UUID_PATTERN.test(value)) {
    return apiFailure(404, "not_found", "The Ticket is not available to this Site.");
  }

  const query = walletQuery(scope, site.siteId, scope === "public"
    ? createHash("sha256").update(value, "utf8").digest("hex")
    : value);
  const result = await getBusinessPool().query<WalletDataRow>(query.text, query.values);
  const row = result.rows[0];
  if (!row) return apiFailure(404, "not_found", "The Ticket is not available to this Site.");
  return apiSuccess(walletData(row));
}
