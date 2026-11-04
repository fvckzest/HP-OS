import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { apiFailure } from "./api-response";
import { ApiOperationError, withApiIdempotency } from "./api-idempotency";
import type { IdempotentResult } from "./api-idempotency";
import { publicEventData } from "./events";
import { enqueueNotificationJob, supersedeUnsentNotificationJobs } from "./notification-queue";
import type { AuthenticatedSite } from "./site-auth";
import { readAdminOrder } from "./admin-order";
import {
  IssuanceRow, RecoveryJobRow, UUID_PATTERN, actor, eventNotificationDetails, expectedVersion, hashToken, hasOnlyKeys,
  readIssuanceRow, readJsonBody, recoveryDeliveryState, recoveryEmail, recoveryText,
} from "./ticketing-projections";

async function retryTicketIssuance(client: PoolClient, site: AuthenticatedSite, orderId: string, body: Record<string, unknown>): Promise<IdempotentResult> {
  if (!hasOnlyKeys(body, ["actor", "expected_version"])) {
    throw new ApiOperationError(422, "validation_failed", "Only actor and expected_version are accepted for this action.");
  }
  const parsedActor = actor(body.actor);
  if (!parsedActor) throw new ApiOperationError(422, "validation_failed", "Provide a valid Site-local actor reference.", [{ field: "actor", code: "invalid_actor", message: "Use {type, reference} with a non-secret reference." }]);
  const expected = expectedVersion(body.expected_version);
  if (!expected) throw new ApiOperationError(422, "validation_failed", "expected_version must be a positive integer.", [{ field: "expected_version", code: "required", message: "Use the current Order version." }]);
  if (!UUID_PATTERN.test(orderId)) throw new ApiOperationError(404, "not_found", "The Order is not available to this Site.");
  const row = await readIssuanceRow(client, site.siteId, orderId);
  if (!row) throw new ApiOperationError(404, "not_found", "The Order is not available to this Site.");
  if (row.order_version !== expected) throw new ApiOperationError(409, "version_conflict", "The Order changed after you loaded it. Reload it before retrying issuance.");
  if (row.payment_status !== "paid" || !["pending", "failed"].includes(row.issuance_status)) {
    throw new ApiOperationError(409, "invalid_state", "Ticket issuance can only be retried for a paid Order awaiting Tickets.");
  }
  if (row.refund_status === "full") throw new ApiOperationError(409, "invalid_state", "A fully refunded Order cannot be issued.");
  if (row.is_canceled) throw new ApiOperationError(409, "invalid_state", "A canceled Event cannot be issued.");
  if (row.reservation_status !== "held") throw new ApiOperationError(409, "invalid_state", "The Order Reservation is no longer held; investigate before issuing.");
  if (!row.order_token) throw new ApiOperationError(409, "invalid_state", "The paid Order has no recoverable buyer access token.");
  const existingTickets = await client.query<{ count: number }>(
    `select count(*)::integer as count from hpos.tickets where site_id = $1 and order_id = $2`,
    [site.siteId, orderId],
  );
  if ((existingTickets.rows[0]?.count ?? 0) > 0) throw new ApiOperationError(409, "invalid_state", "The Order already has Tickets; issuance retry cannot create duplicates.");
  const updated = await client.query<{ version: number }>(
    `update hpos.orders
     set issuance_status = 'pending', version = version + 1, updated_at = clock_timestamp()
     where id = $1 and site_id = $2 and version = $3 and payment_status = 'paid'
       and issuance_status in ('pending', 'failed')
     returning version`,
    [orderId, site.siteId, expected],
  );
  if (updated.rowCount !== 1) throw new ApiOperationError(409, "version_conflict", "The Order changed after you loaded it. Reload it before retrying issuance.");
  await client.query(
    `insert into hpos.order_recovery_actions
       (id, site_id, order_id, action, actor_type, actor_reference, previous_version, new_version)
     values ($1, $2, $3, 'retry_ticket_issuance', $4, $5, $6, $7)`,
    [randomUUID(), site.siteId, orderId, parsedActor.type, parsedActor.reference, expected, updated.rows[0].version],
  );
  const response = await readAdminOrder(site, orderId, client);
  const data = await response.json() as { data?: unknown; error?: { code?: string; message?: string } };
  if (response.status >= 400 || data.data === undefined) throw new ApiOperationError(503, "service_unavailable", "The retried Order could not be read after it was queued.");
  return { status: 202, data: data.data };
}

async function latestTicketEmailJob(client: PoolClient, siteId: string, orderId: string): Promise<RecoveryJobRow | null> {
  const current = await client.query<{ id: string }>(
    `select job.id
     from hpos.notification_jobs job
     where job.site_id = $1 and job.order_id = $2 and job.kind = 'tickets_ready'
       and job.is_superseded = false
     order by job.created_at desc, job.id desc
     limit 1 for update of job`,
    [siteId, orderId],
  );
  if (!current.rows[0]) return null;
  const result = await client.query<RecoveryJobRow>(
    `select job.id, job.status, job.is_superseded, job.attempt_count,
            job.requires_verification, job.provider_message_reference, job.failure_class, job.created_at,
            (select delivery.outcome
             from hpos.notification_delivery_events delivery
             where delivery.site_id = job.site_id and delivery.job_id = job.id
             order by delivery.observed_at desc, delivery.id desc limit 1) as delivery_status
     from hpos.notification_jobs job
     where job.site_id = $1 and job.id = $2`,
    [siteId, current.rows[0].id],
  );
  return result.rows[0] ?? null;
}

function ticketEmailPayload(row: IssuanceRow) {
  if (!row.order_token) throw new ApiOperationError(409, "invalid_state", "The Order has no current buyer access token.");
  const event = publicEventData(row);
  return {
    recipient_email: row.delivery_email,
    buyer_name: row.buyer_name,
    event: eventNotificationDetails(event, row.event_id),
    order: { order_id: row.order_id, order_reference: row.order_reference, order_token: row.order_token },
  };
}

function assertRecoveryActorAndVersion(body: Record<string, unknown>, allowed: string[]): { actor: { type: "user" | "system"; reference: string }; version: number } {
  if (!hasOnlyKeys(body, allowed)) throw new ApiOperationError(422, "validation_failed", "The recovery action contains an unsupported field.");
  const parsedActor = actor(body.actor);
  if (!parsedActor) throw new ApiOperationError(422, "validation_failed", "Provide a valid Site-local actor reference.", [{ field: "actor", code: "invalid_actor", message: "Use {type, reference} with a non-secret reference." }]);
  const version = expectedVersion(body.expected_version);
  if (!version) throw new ApiOperationError(422, "validation_failed", "expected_version must be a positive integer.", [{ field: "expected_version", code: "required", message: "Use the current Order version." }]);
  return { actor: parsedActor, version };
}

async function recordRecoveryAction(
  client: PoolClient,
  site: AuthenticatedSite,
  orderId: string,
  action: string,
  actorValue: { type: "user" | "system"; reference: string },
  previousVersion: number,
  newVersion: number,
  reason: string | null = null,
  verificationReference: string | null = null,
): Promise<void> {
  await client.query(
    `insert into hpos.order_recovery_actions
       (id, site_id, order_id, action, actor_type, actor_reference, previous_version, new_version, reason, verification_reference)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [randomUUID(), site.siteId, orderId, action, actorValue.type, actorValue.reference, previousVersion, newVersion, reason, verificationReference],
  );
}

async function readRecoveryResponse(client: PoolClient, site: AuthenticatedSite, orderId: string): Promise<IdempotentResult> {
  const response = await readAdminOrder(site, orderId, client);
  const data = await response.json() as { data?: unknown; error?: { code?: string; message?: string } };
  if (response.status >= 400 || data.data === undefined) throw new ApiOperationError(503, "service_unavailable", "The recovered Order could not be read after the action completed.");
  return { status: 202, data: data.data };
}

async function resendTicketEmail(client: PoolClient, site: AuthenticatedSite, orderId: string, body: Record<string, unknown>): Promise<IdempotentResult> {
  const parsed = assertRecoveryActorAndVersion(body, ["actor", "expected_version"]);
  if (!UUID_PATTERN.test(orderId)) throw new ApiOperationError(404, "not_found", "The Order is not available to this Site.");
  const row = await readIssuanceRow(client, site.siteId, orderId);
  if (!row) throw new ApiOperationError(404, "not_found", "The Order is not available to this Site.");
  if (row.order_version !== parsed.version) throw new ApiOperationError(409, "version_conflict", "The Order changed after you loaded it. Reload it before resending the Ticket email.");
  if (row.payment_status !== "paid" || row.issuance_status !== "issued") throw new ApiOperationError(409, "invalid_state", "A Ticket email can only be resent for a paid Order with issued Tickets.");
  if (row.refund_status === "full") throw new ApiOperationError(409, "invalid_state", "A fully refunded Order cannot receive a Ticket email resend.");
  const ticketCount = await client.query<{ count: number }>(
    `select count(*)::integer as count from hpos.tickets where site_id = $1 and order_id = $2`,
    [site.siteId, orderId],
  );
  if ((ticketCount.rows[0]?.count ?? 0) === 0) throw new ApiOperationError(409, "invalid_state", "The paid Order has no issued Tickets to resend.");
  const latest = await latestTicketEmailJob(client, site.siteId, orderId);
  if (!latest) throw new ApiOperationError(409, "invalid_state", "The Order has no Ticket email history to recover.");
  if (latest.requires_verification) throw new ApiOperationError(409, "delivery_verification_required", "The latest Ticket email outcome is unknown. Verify the provider or durable Site log before requesting another send.");
  const state = recoveryDeliveryState(latest);
  if (state === "pending") throw new ApiOperationError(409, "delivery_in_progress", "The latest Ticket email is still in progress.");
  if (state === "sent") throw new ApiOperationError(409, "delivery_verification_required", "The latest Ticket email was sent, but its delivery outcome is not known. Verify it before requesting another send.");
  if (state === "delivered") throw new ApiOperationError(409, "already_delivered", "The latest Ticket email has confirmed delivery.");
  if (state !== "failed") throw new ApiOperationError(409, "invalid_state", "The latest Ticket email is not in a resendable failure state.");

  const updated = await client.query<{ version: number }>(
    `update hpos.orders
     set delivery_status = 'pending', version = version + 1, updated_at = clock_timestamp()
     where id = $1 and site_id = $2 and version = $3 and payment_status = 'paid' and issuance_status = 'issued'
     returning version`,
    [orderId, site.siteId, parsed.version],
  );
  if (updated.rowCount !== 1) throw new ApiOperationError(409, "version_conflict", "The Order changed after you loaded it. Reload it before resending the Ticket email.");
  await enqueueNotificationJob(client, { siteId: site.siteId, kind: "tickets_ready", eventId: row.event_id, orderId, payload: ticketEmailPayload(row) });
  await recordRecoveryAction(client, site, orderId, "resend_ticket_email", parsed.actor, parsed.version, updated.rows[0].version);
  return readRecoveryResponse(client, site, orderId);
}

async function correctDeliveryEmail(client: PoolClient, site: AuthenticatedSite, orderId: string, body: Record<string, unknown>): Promise<IdempotentResult> {
  const parsed = assertRecoveryActorAndVersion(body, ["actor", "expected_version", "email", "reason", "verification_reference"]);
  const corrected = recoveryEmail(body.email);
  if (!corrected) throw new ApiOperationError(422, "validation_failed", "Provide a valid delivery email address.", [{ field: "email", code: "invalid_email", message: "Use a valid email address of at most 254 characters." }]);
  if (!recoveryText(body.reason, 500)) throw new ApiOperationError(422, "validation_failed", "reason is required for a verified delivery-email correction.", [{ field: "reason", code: "required", message: "Record why the address was corrected." }]);
  if (!recoveryText(body.verification_reference, 500)) throw new ApiOperationError(422, "validation_failed", "verification_reference is required for a verified delivery-email correction.", [{ field: "verification_reference", code: "required", message: "Record a non-secret verification reference." }]);
  if (!UUID_PATTERN.test(orderId)) throw new ApiOperationError(404, "not_found", "The Order is not available to this Site.");
  const row = await readIssuanceRow(client, site.siteId, orderId);
  if (!row) throw new ApiOperationError(404, "not_found", "The Order is not available to this Site.");
  if (row.order_version !== parsed.version) throw new ApiOperationError(409, "version_conflict", "The Order changed after you loaded it. Reload it before correcting the delivery email.");
  if (row.payment_status !== "paid" || row.issuance_status !== "issued") throw new ApiOperationError(409, "invalid_state", "Delivery email correction requires a paid Order with issued Tickets.");
  if (row.refund_status === "full") throw new ApiOperationError(409, "invalid_state", "A fully refunded Order cannot receive corrected Ticket access.");
  const latest = await latestTicketEmailJob(client, site.siteId, orderId);
  if (!latest) throw new ApiOperationError(409, "invalid_state", "The Order has no current Ticket email failure that can be safely corrected.");
  if (latest?.requires_verification) throw new ApiOperationError(409, "delivery_verification_required", "The latest Ticket email outcome is unknown. Verify it before replacing access links and sending to another address.");
  const latestState = recoveryDeliveryState(latest);
  if (latestState === "pending") throw new ApiOperationError(409, "delivery_in_progress", "The latest Ticket email is still in progress. Wait for its outcome before correcting the delivery email.");
  if (latestState === "sent") throw new ApiOperationError(409, "delivery_verification_required", "The latest Ticket email was sent, but its delivery outcome is not known. Verify it before replacing access links and sending to another address.");
  if (latestState !== "failed" && latestState !== "delivered") throw new ApiOperationError(409, "invalid_state", "The latest Ticket email is not in a safely correctable state.");
  const ticketRows = await client.query<{ id: string }>(
    `select id from hpos.tickets where site_id = $1 and order_id = $2 order by ordinal asc for update`,
    [site.siteId, orderId],
  );
  if (ticketRows.rowCount === 0) throw new ApiOperationError(409, "invalid_state", "The paid Order has no issued Tickets to correct.");
  const buyer = await client.query<{ id: string }>(
    `insert into hpos.buyers (site_id, normalized_email, name)
     values ($1, $2, $3)
     on conflict (site_id, normalized_email)
     -- The existing Site Buyer profile owns its name; correcting one Order's
     -- delivery address must not rewrite that profile from checkout data.
     do update set updated_at = clock_timestamp()
     returning id`,
    [site.siteId, corrected.normalizedEmail, row.buyer_name],
  );
  const orderToken = randomBytes(32).toString("base64url");
  const updated = await client.query<{ version: number }>(
    `update hpos.orders
     set buyer_id = $4, delivery_email = $5, order_token = $6,
         order_token_hash = $7, delivery_status = 'pending', version = version + 1,
         updated_at = clock_timestamp()
     where id = $1 and site_id = $2 and version = $3 and payment_status = 'paid' and issuance_status = 'issued'
     returning version`,
    [orderId, site.siteId, parsed.version, buyer.rows[0].id, corrected.email, orderToken, hashToken(orderToken)],
  );
  if (updated.rowCount !== 1) throw new ApiOperationError(409, "version_conflict", "The Order changed after you loaded it. Reload it before correcting the delivery email.");
  await client.query(
    `update hpos.order_recovery_tokens
     set revoked_at = clock_timestamp()
     where site_id = $1 and order_id = $2 and revoked_at is null`,
    [site.siteId, orderId],
  );
  await client.query(
    `with unsent_recovery_jobs as (
       select job.id,
              coalesce(
                jsonb_agg(entry.order_data order by entry.ordinality)
                  filter (where entry.order_data ->> 'order_id' <> $2::text),
                '[]'::jsonb
              ) as remaining_orders
       from hpos.notification_jobs job
       cross join lateral jsonb_array_elements(
         case when jsonb_typeof(job.payload -> 'orders') = 'array'
           then job.payload -> 'orders' else '[]'::jsonb end
       ) with ordinality as entry(order_data, ordinality)
       where job.site_id = $1 and job.kind = 'order_recovery'
         and job.status = 'pending'
         and job.requires_verification = false and job.provider_message_reference is null
         and job.claim_id is null and job.is_superseded = false
       group by job.id
       having bool_or(entry.order_data ->> 'order_id' = $2::text)
     )
     update hpos.notification_jobs job
     set payload = jsonb_set(job.payload, '{orders}', unsent_recovery_jobs.remaining_orders),
         is_superseded = jsonb_array_length(unsent_recovery_jobs.remaining_orders) = 0,
         updated_at = clock_timestamp()
     from unsent_recovery_jobs
     where job.site_id = $1 and job.id = unsent_recovery_jobs.id`,
    [site.siteId, orderId],
  );
  for (const ticket of ticketRows.rows) {
    const token = randomBytes(32).toString("base64url");
    await client.query(
      `update hpos.tickets
       set ticket_token = $3, ticket_token_hash = $4, version = version + 1, updated_at = clock_timestamp()
       where id = $1 and site_id = $2`,
      [ticket.id, site.siteId, token, hashToken(token)],
    );
  }
  await supersedeUnsentNotificationJobs(client, { siteId: site.siteId, orderId, kinds: ["tickets_ready", "event_changed"] });
  const correctedRow = { ...row, delivery_email: corrected.email, order_token: orderToken } as IssuanceRow;
  await enqueueNotificationJob(client, { siteId: site.siteId, kind: "tickets_ready", eventId: row.event_id, orderId, payload: ticketEmailPayload(correctedRow) });
  await recordRecoveryAction(client, site, orderId, "correct_delivery_email", parsed.actor, parsed.version, updated.rows[0].version, body.reason.trim(), body.verification_reference.trim());
  return readRecoveryResponse(client, site, orderId);
}

export async function handleAdminOrderActionPost(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (path.length !== 5 || path[0] !== "admin" || path[1] !== "orders" || path[3] !== "actions") return null;
  if (!["retry_ticket_issuance", "resend_ticket_email", "correct_delivery_email"].includes(path[4])) return apiFailure(404, "not_found", "The requested Order action is unavailable.");
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  const action = path[4] === "retry_ticket_issuance" ? retryTicketIssuance
    : path[4] === "resend_ticket_email" ? resendTicketEmail : correctDeliveryEmail;
  return withApiIdempotency(request, site, body, (client) => action(client, site, path[2], body), undefined, body);
}
