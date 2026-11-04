import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { getBusinessPool } from "./database";
import { publicEventData } from "./events";
import { enqueueNotificationJob } from "./notifications";
import {
  IssuanceRow, MAX_ISSUANCE_BATCH, eventNotificationDetails, hashToken, readIssuanceRow,
} from "./ticketing-projections";

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
      if ((blockCode === "event_canceled" || blockCode === "order_fully_refunded") && row.reservation_status === "held") {
        const released = await client.query<{ quantity: number }>(
          `update hpos.reservations
           set status = 'released', awaiting_provider_verification = false, updated_at = clock_timestamp()
           where id = $1 and site_id = $2 and status = 'held'
           returning quantity`,
          [row.reservation_id, siteId],
        );
        const quantity = released.rows[0]?.quantity;
        if (quantity !== undefined) {
          const capacity = await client.query(
            `update hpos.ticket_offerings
             set reserved_quantity = reserved_quantity - $3
             where id = $1 and site_id = $2 and reserved_quantity >= $3
             returning id`,
            [row.ticket_offering_id, siteId, quantity],
          );
          if (capacity.rowCount !== 1) throw new Error("The blocked paid Order Reservation could not be released safely.");
        }
      }
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
           approved_attendee_email, ticket_token, ticket_token_hash, qr_payload, qr_token_hash
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [ticket.id, siteId, orderId, row.event_id, row.ticket_offering_id, ordinal,
          row.approved_attendee_name, row.approved_attendee_email,
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
