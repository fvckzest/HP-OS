import { apiFailure, apiSuccess } from "./api-response";
import { getBusinessPool } from "./database";
import { publicEventData } from "./events";
import type { AuthenticatedSite } from "./site-auth";
import {
  ReadOrderRow, TicketRow, EventRow, TOKEN_PATTERN, currentDeliveryStatus, hashToken, noStore, publicTicketData, safeNumber,
} from "./ticketing-projections";

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
       where order_row.site_id = $1
         and (order_row.order_token_hash = $2 or exists (
           select 1 from hpos.order_recovery_tokens recovery
           where recovery.site_id = order_row.site_id and recovery.order_id = order_row.id
             and recovery.token_hash = $2 and recovery.revoked_at is null
             and recovery.expires_at > clock_timestamp()
         ))`,
      [site.siteId, hashToken(token)],
    );
    const order = orderResult.rows[0];
    if (!order) return apiFailure(404, "not_found", "The Order is not available to this Site.");
    const event = publicEventData(order);
    const ticketsResult = order.issuance_status === "issued"
      ? await client.query<TicketRow>(
        `select ticket.id as ticket_id, ticket.ticket_token, ticket.ordinal, ticket.issued_at,
                ticket.qr_payload, ticket.attendee_name, ticket.approved_attendee_email, ticket.version,
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
    const refundsResult = await client.query<{
      outcome: string; amount: string | number; currency: string; observed_at: Date; created_at: Date; updated_at: Date;
    }>(
      `select outcome, amount, currency, observed_at, created_at, updated_at
       from hpos.refunds
       where site_id = $1 and order_id = $2
       order by created_at asc, id asc`,
      [site.siteId, order.order_id],
    );
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
      refunds: refundsResult.rows.map((refund) => ({
        outcome: refund.outcome,
        amount: safeNumber(refund.amount.toString()),
        currency: refund.currency,
        observed_at: refund.observed_at.toISOString(),
        created_at: refund.created_at.toISOString(),
        updated_at: refund.updated_at.toISOString(),
      })),
      event,
      tickets,
    }));
  } finally {
    client.release();
  }
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
            ticket.qr_payload, ticket.attendee_name, ticket.approved_attendee_email, ticket.version,
            admission.id as admission_id, admission.admitted_at,
            order_row.refund_status, event_row.is_canceled,
            event_row.title, event_row.description, event_row.event_type, event_row.logo_path, event_row.venue_name, event_row.venue_address,
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
