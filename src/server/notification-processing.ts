import { getBusinessPool } from "./database";
import { apiFailure, apiSuccess, withRequestCorrelation } from "./api-response";
import { apiFailureContract, classifyApiFailure, emitServerDiagnostic, requestId } from "./api-diagnostics";

const MAX_PROCESS_BATCH = 50;

export type ProcessingTrigger = "local_scheduler" | "vercel_cron";
export interface ProcessingResult {
  run_id: string;
  trigger: ProcessingTrigger;
  started_at: string;
  finished_at: string;
  recovered_jobs: number;
  verification_required_attempts: number;
  released_reservations: number;
  batch_limit: number;
  has_more: boolean;
  site_execution: "separate";
}
/** One bounded HP-OS recovery batch. It never calls a provider or Site worker. */
export async function runBoundedProcessing(trigger: ProcessingTrigger, runId = requestId()): Promise<ProcessingResult> {
  const client = await getBusinessPool().connect();
  try {
    await client.query("begin");
    const clock = await client.query<{ started_at: Date }>(`select clock_timestamp() as started_at`);
    const startedAt = clock.rows[0].started_at;
    const expired = await client.query<{ id: string; claim_id: string }>(
      `select j.id, j.claim_id
       from hpos.notification_jobs j
       join hpos.notification_claims c on c.id = j.claim_id and c.site_id = j.site_id
       where j.status = 'pending' and j.is_superseded = false
         and (c.closed_at is not null or c.lease_expires_at <= clock_timestamp())
       order by c.lease_expires_at, j.id
       limit $1
       for update of j skip locked`,
      [MAX_PROCESS_BATCH],
    );
    const jobIds = expired.rows.map((row) => row.id);
    const claimIds = [...new Set(expired.rows.map((row) => row.claim_id))];
    if (jobIds.length) {
      await client.query(
        `update hpos.notification_jobs set claim_id = null, lease_fence = lease_fence + 1,
           requires_verification = true,
           available_at = least(available_at, clock_timestamp()), updated_at = clock_timestamp()
         where id = any($1::uuid[])`,
        [jobIds],
      );
      await client.query(
        `update hpos.notification_claims c set closed_at = clock_timestamp()
         where c.id = any($1::uuid[]) and c.closed_at is null
           and not exists (select 1 from hpos.notification_jobs j where j.site_id = c.site_id and j.claim_id = c.id and j.status = 'pending')`,
        [claimIds],
      );
    }
    const verificationRequired = await client.query<{ id: string }>(
      `with candidates as (
         select attempt.id
         from hpos.payment_attempts attempt
         join hpos.orders order_row
           on order_row.id = attempt.order_id and order_row.site_id = attempt.site_id
         join hpos.reservations reservation
           on reservation.order_id = order_row.id and reservation.site_id = order_row.site_id
         where order_row.checkout_status = 'awaiting_payment_result'
           and order_row.payment_status in ('unpaid', 'failed', 'processing', 'unknown', 'conflicted')
           and order_row.checkout_expires_at <= clock_timestamp()
           and reservation.status = 'held'
           and attempt.status in ('creating', 'open')
           and attempt.provider_can_take_payment is distinct from false
         order by attempt.created_at, attempt.id
         limit $1
         for update of attempt skip locked
       )
       update hpos.payment_attempts attempt
       set status = 'requires_verification', version = version + 1, updated_at = clock_timestamp()
       from candidates
       where attempt.id = candidates.id
       returning attempt.id`,
      [MAX_PROCESS_BATCH],
    );
    const expiredReservations = await client.query<{ id: string; order_id: string; offering_id: string; site_id: string; quantity: number }>(
      `select reservation.id, reservation.order_id, reservation.offering_id,
              reservation.site_id, reservation.quantity
       from hpos.reservations reservation
       join hpos.orders order_row
         on order_row.id = reservation.order_id
        and order_row.site_id = reservation.site_id
       where reservation.status = 'held'
         and reservation.awaiting_provider_verification = false
         and reservation.expires_at <= clock_timestamp()
         and order_row.checkout_status = 'active'
         and order_row.payment_status in ('unpaid', 'failed')
       order by reservation.expires_at, reservation.id
       limit $1
       for update of reservation, order_row skip locked`,
      [MAX_PROCESS_BATCH],
    );
    const reservationIds = expiredReservations.rows.map((row) => row.id);
    const orderIds = expiredReservations.rows.map((row) => row.order_id);
    let releasedReservations = 0;
    if (reservationIds.length) {
      const offeringIds = [...new Set(expiredReservations.rows.map((row) => row.offering_id))];
      const releaseCapacity = await client.query(
        `with release_totals as (
           select offering_id, site_id, sum(quantity)::bigint as quantity
           from hpos.reservations
           where id = any($1::uuid[]) and status = 'held'
           group by offering_id, site_id
         )
         update hpos.ticket_offerings offering
         set reserved_quantity = offering.reserved_quantity - release_totals.quantity
         from release_totals
         where offering.id = release_totals.offering_id
           and offering.site_id = release_totals.site_id
           and offering.reserved_quantity >= release_totals.quantity
         returning offering.id`,
        [reservationIds],
      );
      if (releaseCapacity.rowCount !== offeringIds.length) throw new Error("Expired Reservation capacity counters did not match their holds.");
      const released = await client.query(
        `update hpos.reservations
         set status = 'released', updated_at = clock_timestamp()
         where id = any($1::uuid[]) and status = 'held'
         returning id`,
        [reservationIds],
      );
      if (released.rowCount !== reservationIds.length) throw new Error("An expired Reservation changed before it could be released.");
      await client.query(
        `update hpos.orders
         set checkout_status = 'expired', version = version + 1, updated_at = clock_timestamp()
         where id = any($1::uuid[]) and checkout_status = 'active' and payment_status in ('unpaid', 'failed')`,
        [orderIds],
      );
      releasedReservations = released.rowCount;
    }
    const more = await client.query(
      `select 1 from hpos.notification_jobs j join hpos.notification_claims c on c.id = j.claim_id and c.site_id = j.site_id
       where j.status = 'pending' and j.is_superseded = false
         and (c.closed_at is not null or c.lease_expires_at <= clock_timestamp()) limit 1`,
    );
    const moreReservations = await client.query(
      `select 1
       from hpos.reservations reservation
       join hpos.orders order_row on order_row.id = reservation.order_id and order_row.site_id = reservation.site_id
       where reservation.status = 'held'
         and reservation.awaiting_provider_verification = false
         and reservation.expires_at <= clock_timestamp()
         and order_row.checkout_status = 'active'
         and order_row.payment_status in ('unpaid', 'failed')
       limit 1`,
    );
    const moreVerification = await client.query(
      `select 1
       from hpos.payment_attempts attempt
       join hpos.orders order_row on order_row.id = attempt.order_id and order_row.site_id = attempt.site_id
       join hpos.reservations reservation on reservation.order_id = order_row.id and reservation.site_id = order_row.site_id
       where order_row.checkout_status = 'awaiting_payment_result'
         and order_row.payment_status in ('unpaid', 'failed', 'processing', 'unknown', 'conflicted')
         and order_row.checkout_expires_at <= clock_timestamp()
         and reservation.status = 'held'
         and attempt.status in ('creating', 'open')
         and attempt.provider_can_take_payment is distinct from false
       limit 1`,
    );
    const finishedAt = (await client.query<{ finished_at: Date }>(`select clock_timestamp() as finished_at`)).rows[0].finished_at;
    const result: ProcessingResult = {
      run_id: runId,
      trigger,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      recovered_jobs: jobIds.length,
      verification_required_attempts: verificationRequired.rowCount ?? 0,
      released_reservations: releasedReservations,
      batch_limit: MAX_PROCESS_BATCH,
      has_more: (more.rowCount ?? 0) > 0 || (moreReservations.rowCount ?? 0) > 0 || (moreVerification.rowCount ?? 0) > 0,
      site_execution: "separate",
    };
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function handleScheduledProcessing(request: Request): Promise<Response> {
  const correlationId = requestId();
  const invocationId = requestId();
  const expected = process.env.CRON_SECRET;
  const production = process.env.NODE_ENV === "production";
  const requestHost = new URL(request.url).hostname.toLowerCase();
  const loopbackHost = requestHost === "127.0.0.1" || requestHost === "::1" || requestHost === "localhost";
  if ((expected && request.headers.get("authorization") !== `Bearer ${expected}`) || (!expected && production) || (!production && !loopbackHost)) {
    const response = new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
    return withRequestCorrelation(response, correlationId);
  }
  try {
    const processing = await runBoundedProcessing(production ? "vercel_cron" : "local_scheduler", invocationId);
    const issuance = await (await import("./ticket-issuance-service")).processPendingTicketIssuance();
    return withRequestCorrelation(apiSuccess({
      ...processing,
      has_more: processing.has_more || issuance.has_more,
      ticket_issuance: issuance,
    }, 200, { requestId: correlationId }), correlationId);
  }
  catch (error) {
    const failureCategory = classifyApiFailure(error);
    const failure = apiFailureContract(failureCategory, 30);
    emitServerDiagnostic({
      requestId: correlationId,
      operation: "GET /api/cron/process",
      failureCategory,
      error,
      runId: invocationId,
    });
    return withRequestCorrelation(apiFailure(
      failure.status,
      failure.code,
      failureCategory === "temporary_dependency" ? "The bounded HP-OS processing cycle is temporarily unavailable." : "The bounded HP-OS processing cycle failed unexpectedly.",
      { retryAfter: failure.retryAfter, requestId: correlationId },
    ), correlationId);
  }
}
