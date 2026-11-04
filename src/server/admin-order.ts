import type { PoolClient } from "pg";
import { apiFailure, apiSuccess } from "./api-response";
import { getBusinessPool } from "./database";
import { publicEventData } from "./event-projection";
import { readFeeRecords } from "./fee-reports";
import { isUuid } from "./http-request";
import type { AuthenticatedSite } from "./site-auth";
import {
  AdminTicketRow, IssuanceRow, adminTicketData, noStore, readIssuanceRow, recoveryDeliveryState, safeNumber,
} from "./ticketing-projections";

export async function readAdminOrder(site: AuthenticatedSite, orderId: string, existingClient?: PoolClient): Promise<Response> {
  if (!isUuid(orderId)) return apiFailure(404, "not_found", "The Order is not available to this Site.");
  const pool = getBusinessPool();
  const client = existingClient ?? await pool.connect();
  try {
    const row = await readIssuanceRow(client, site.siteId, orderId);
    if (!row) return apiFailure(404, "not_found", "The Order is not available to this Site.");
    const event = publicEventData(row);
    const ticketsResult = await client.query<AdminTicketRow>(
      `select ticket.id as ticket_id, ticket.event_id, ticket.order_id, order_row.order_reference,
              ticket.ordinal, ticket.issued_at, ticket.version, ticket.created_at, ticket.updated_at,
              ticket.attendee_name, ticket.approved_attendee_email,
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
      provider_mapping: Record<string, unknown> | null;
      provider_checkout_reference: string | null; provider_payment_reference: string | null;
      last_outcome: string | null; provider_can_take_payment: boolean | null;
      status: string; version: number; created_at: Date; updated_at: Date;
    }>(
      `select attempt.id, attempt.connection_id, attempt.provider, attempt.environment,
              attempt.account_reference, attempt.location_reference, attempt.currency,
              attempt.total_amount, attempt.platform_fee_amount,
              attempt.provider_mapping,
              attempt.provider_checkout_reference, attempt.provider_payment_reference,
              attempt.last_outcome, attempt.provider_can_take_payment, attempt.status,
              attempt.version, attempt.created_at, attempt.updated_at
       from hpos.payment_attempts attempt
       where attempt.site_id = $1 and attempt.order_id = $2
       order by attempt.created_at asc, attempt.id asc`,
      [site.siteId, orderId],
    );
    const refundsResult = await client.query<{
      id: string; attempt_id: string; connection_id: string; provider: string; environment: string;
      account_reference: string; provider_payment_reference: string; provider_refund_reference: string;
      outcome: string; amount: string | number; currency: string; observed_at: Date; created_at: Date; updated_at: Date;
    }>(
      `select id, attempt_id, connection_id, provider, environment, account_reference,
              provider_payment_reference, provider_refund_reference, outcome, amount, currency,
              observed_at, created_at, updated_at
       from hpos.refunds
       where site_id = $1 and order_id = $2
       order by created_at asc, id asc`,
      [site.siteId, orderId],
    );
    const refundReportsResult = await client.query<{
      id: string; attempt_id: string; connection_id: string; source_reference: string;
      provider_payment_reference: string; provider_refund_reference: string; outcome: string;
      observed_at: Date; amount: string | number; currency: string; evidence: Record<string, unknown>;
      applied: boolean; stale: boolean; conflict_code: string | null; created_at: Date;
    }>(
      `select id, attempt_id, connection_id, source_reference, provider_payment_reference,
              provider_refund_reference, outcome, observed_at, amount, currency, evidence,
              applied, stale, conflict_code, created_at
       from hpos.refund_reports
       where site_id = $1 and order_id = $2
       order by observed_at asc, created_at asc, id asc`,
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
      union all
       select issue.id, issue.code, issue.status, issue.message, issue.created_at, issue.resolved_at,
              null::uuid as resolution_id, null::text as actor_type, null::text as actor_reference,
              null::text as reason, null::text as verification_reference,
              null::integer as previous_version, null::integer as new_version
       from hpos.refund_report_issues issue
       where issue.site_id = $1 and issue.order_id = $2
       union all
       select issue.id, issue.code, issue.status, issue.message, issue.created_at, issue.resolved_at,
              null::uuid as resolution_id, null::text as actor_type, null::text as actor_reference,
              null::text as reason, null::text as verification_reference,
              null::integer as previous_version, null::integer as new_version
       from hpos.fee_report_issues issue
       where issue.site_id = $1 and issue.order_id = $2
       order by created_at asc, id asc`,
      [site.siteId, orderId],
    );
    const feeRecords = await readFeeRecords(client, site.siteId, orderId);
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
      access_request_id: row.access_request_id,
      approved_attendee: row.approved_attendee_name && row.approved_attendee_email
        ? { name: row.approved_attendee_name, email: row.approved_attendee_email }
        : null,
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
        provider_mapping: attempt.provider_mapping,
        provider_checkout_reference: attempt.provider_checkout_reference,
        provider_payment_reference: attempt.provider_payment_reference,
        last_outcome: attempt.last_outcome,
        provider_can_take_payment: attempt.provider_can_take_payment,
        status: attempt.status,
        version: attempt.version,
        created_at: attempt.created_at.toISOString(),
        updated_at: attempt.updated_at.toISOString(),
      })),
      refunds: refundsResult.rows.map((refund) => ({
        refund_id: refund.id,
        attempt_id: refund.attempt_id,
        connection_id: refund.connection_id,
        provider: refund.provider,
        environment: refund.environment,
        account_reference: refund.account_reference,
        provider_payment_reference: refund.provider_payment_reference,
        provider_refund_reference: refund.provider_refund_reference,
        outcome: refund.outcome,
        amount: safeNumber(refund.amount.toString()),
        currency: refund.currency,
        observed_at: refund.observed_at.toISOString(),
        created_at: refund.created_at.toISOString(),
        updated_at: refund.updated_at.toISOString(),
      })),
      refund_reports: refundReportsResult.rows.map((report) => ({
        report_id: report.id,
        attempt_id: report.attempt_id,
        connection_id: report.connection_id,
        source_reference: report.source_reference,
        provider_payment_reference: report.provider_payment_reference,
        provider_refund_reference: report.provider_refund_reference,
        outcome: report.outcome,
        observed_at: report.observed_at.toISOString(),
        amount: safeNumber(report.amount.toString()),
        currency: report.currency,
        evidence: report.evidence,
        applied: report.applied,
        stale: report.stale,
        conflict_code: report.conflict_code,
        created_at: report.created_at.toISOString(),
      })),
      fee_records: feeRecords,
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
export async function handleAdminOrderGet(site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (path.length !== 3 || path[0] !== "admin" || path[1] !== "orders") return null;
  return readAdminOrder(site, path[2]);
}

export async function handleAdminOrderPaymentStatusGet(site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (path.length !== 4 || path[0] !== "admin" || path[1] !== "orders"
    || path[3] !== "payment-status") return null;
  if (!isUuid(path[2])) return apiFailure(404, "not_found", "The Order is not available to this Site.");
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
