import type { PoolClient } from "pg";
import {
  MAX_BODY_BYTES,
  NOTIFICATION_KINDS,
  UUID_PATTERN,
  expectedRecordIds,
  type EventNotificationBatch,
  type NewNotificationJob,
  type NotificationKind,
  tokenHash,
  validateEventDetails,
  validateNotificationPayload,
  validTimestamp,
} from "./notification-contract";

/**
 * Insert a durable notification job using the caller's transaction. Producers
 * must call this before committing the business change that requires delivery.
 */
export async function enqueueNotificationJob(client: PoolClient, input: NewNotificationJob): Promise<string> {
  if (!UUID_PATTERN.test(input.siteId) || !NOTIFICATION_KINDS.includes(input.kind)) throw new Error("Notification producer supplied an invalid Site ID or notification kind.");
  if (!expectedRecordIds(input.kind, input)) throw new Error("Notification producer supplied record references that do not match the job kind.");
  if (!validateNotificationPayload(input.kind, input.payload)) throw new Error("Notification producer supplied a payload that does not match the documented job kind.");
  const computedAccessTokenHash = input.kind === "access_approved"
    ? tokenHash((input.payload as { approval_token: string }).approval_token)
    : null;
  if (input.kind !== "access_approved" && input.accessRequestTokenHash != null) throw new Error("Only access approval jobs may carry an approval token digest.");
  if (computedAccessTokenHash !== null && input.accessRequestTokenHash != null && computedAccessTokenHash !== input.accessRequestTokenHash) throw new Error("Notification producer supplied an approval token digest that does not match its payload.");
  if (input.availableAt && !Number.isFinite(input.availableAt.getTime())) throw new Error("Notification producer supplied an invalid availability time.");
  if (Buffer.byteLength(JSON.stringify(input.payload), "utf8") > MAX_BODY_BYTES) throw new Error("Notification producer supplied a payload larger than 64 KiB.");
  const result = await client.query<{ id: string }>(
    `insert into hpos.notification_jobs (
       site_id, kind, event_id, order_id, access_request_id, access_request_token_hash, ticket_id,
       available_at, payload
     ) values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, clock_timestamp()), $9::jsonb)
     returning id`,
    [input.siteId, input.kind, input.eventId ?? null, input.orderId ?? null, input.accessRequestId ?? null, computedAccessTokenHash, input.ticketId ?? null, input.availableAt ?? null, JSON.stringify(input.payload)],
  );
  return result.rows[0].id;
}

/**
 * Insert all paid-Order Event notifications with one database statement.
 *
 * The caller owns the transaction. The source rows stay in PostgreSQL, so a
 * large Event does not become an application-sized recipient array and a
 * partial fan-out cannot commit independently of the Event mutation.
 */
export async function enqueueEventNotificationJobs(client: PoolClient, input: EventNotificationBatch): Promise<number> {
  if (!UUID_PATTERN.test(input.siteId) || !UUID_PATTERN.test(input.eventId)) {
    throw new Error("Event notification batch supplied an invalid Site or Event ID.");
  }
  if (input.event.event_id !== input.eventId) {
    throw new Error("Event notification batch supplied mismatched Event details.");
  }
  if (input.kind === "event_changed") {
    if (!validateEventDetails(input.event, true)) throw new Error("Event notification batch supplied invalid Event details.");
  } else {
    if (!validateEventDetails(input.event, false) || !validTimestamp(input.canceledAt)) {
      throw new Error("Event cancellation batch supplied invalid Event details.");
    }
  }

  const eventPayload = `jsonb_build_object(
    'event_id', $3::uuid,
    'event_reference', $4::text,
    'title', $5::text,
    'starts_at', $6::text,
    'ends_at', $7::text,
    'time_zone', $8::text,
    'venue', jsonb_build_object('name', $9::text, 'address', $10::text)${input.kind === "event_changed" ? ",\n    'changed_fields', $11::jsonb" : ""}
  )`;
  const payload = input.kind === "event_changed"
    ? `jsonb_build_object(
         'recipient_email', order_row.delivery_email,
         'order', jsonb_build_object('order_id', order_row.id, 'order_reference', order_row.order_reference),
         'event', ${eventPayload}
       )`
    : `jsonb_build_object(
         'recipient_email', order_row.delivery_email,
         'order', jsonb_build_object('order_id', order_row.id, 'order_reference', order_row.order_reference),
         'event', ${eventPayload},
         'canceled_at', $11::text
       )`;
  const result = await client.query(
    `insert into hpos.notification_jobs (
       site_id, kind, event_id, order_id, available_at, payload
     )
     select $1, $2, $3::uuid, order_row.id, clock_timestamp(), ${payload}
     from hpos.orders order_row
     where order_row.site_id = $1 and order_row.event_id = $3::uuid and order_row.payment_status = 'paid'
     order by order_row.created_at, order_row.id`,
    [
      input.siteId,
      input.kind,
      input.eventId,
      input.event.event_reference,
      input.event.title,
      input.event.starts_at,
      input.event.ends_at,
      input.event.time_zone,
      input.event.venue.name,
      input.event.venue.address,
      input.kind === "event_changed" ? JSON.stringify(input.event.changed_fields) : input.canceledAt,
    ],
  );
  return result.rowCount ?? 0;
}

/** Supersede only unsent work; unknown or completed provider effects stay visible. */
export async function supersedeUnsentNotificationJobs(client: PoolClient, input: { siteId: string; kinds: NotificationKind[]; orderId?: string; accessRequestId?: string; eventId?: string }): Promise<number> {
  if (!UUID_PATTERN.test(input.siteId) || input.kinds.length === 0
    || (!input.orderId && !input.accessRequestId && !input.eventId)) return 0;
  const result = await client.query(
    `update hpos.notification_jobs
       set is_superseded = true, updated_at = clock_timestamp()
     where site_id = $1 and kind = any($2::text[])
       and ($3::uuid is null or order_id = $3)
       and ($4::uuid is null or access_request_id = $4)
       and ($5::uuid is null or event_id = $5)
       and status = 'pending' and attempt_count = 0
       and requires_verification = false and provider_message_reference is null and claim_id is null
     returning id`,
    [input.siteId, input.kinds, input.orderId ?? null, input.accessRequestId ?? null, input.eventId ?? null],
  );
  return result.rowCount ?? 0;
}
