import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

// This verifier is deliberately local. It uses a real PostgreSQL database and
// the normal HTTP API, while the provider and Site worker are represented by
// non-secret synthetic reports. It never calls LMNL, Square, Resend, Wallet,
// or another external service.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.HPOS_VERIFY_RECOVERY_PORT ?? 3285);
const origin = `http://127.0.0.1:${port}`;
const databaseUrl = process.env.HPOS_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const cronSecret = randomUUID();
const env = {
  ...process.env,
  NODE_ENV: "development",
  HPOS_DATABASE_URL: databaseUrl,
  CRON_SECRET: cronSecret,
  NEXT_TELEMETRY_DISABLED: "1",
};
const pool = new pg.Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 2_000 });
const organizationIds = [];
const siteIds = [];
let app;
const RFC3339_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function hash(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function token() {
  return randomBytes(32).toString("base64url");
}

function safeResult(result) {
  const code = result?.data?.error?.code;
  return `${result?.status ?? "no response"}${code ? ` ${code}` : ""}`;
}

function isCanonicalLocalDatabase(value) {
  try {
    const url = new URL(value);
    return url.protocol === "postgresql:"
      && url.hostname === "127.0.0.1"
      && url.port === "54322"
      && url.username === "postgres"
      && url.pathname === "/postgres"
      && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function assertPortIsFree() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`Recovery verification port ${port} is already in use.`)));
    server.listen(port, "127.0.0.1", () => server.close((error) => error ? reject(error) : resolve()));
  });
}

function startApp() {
  const nextBin = path.join(root, "node_modules/next/dist/bin/next");
  const child = spawn(process.execPath, [nextBin, "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => { output = `${output}${chunk}`.slice(-5_000); });
  }
  return { child, get output() { return output; } };
}

async function waitForReady(server) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) throw new Error("The recovery verification app stopped before becoming ready.");
    try {
      const response = await fetch(`${origin}/v1/admin/payment-configuration`, { signal: AbortSignal.timeout(2_000) });
      if (response.status === 401) return;
      await response.body?.cancel().catch(() => undefined);
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("The recovery verification app did not become ready within 90 seconds.");
}

function stopApp(server) {
  return new Promise((resolve) => {
    if (!server || server.child.exitCode !== null) return resolve();
    server.child.once("exit", () => resolve());
    server.child.kill("SIGTERM");
    setTimeout(() => {
      if (server.child.exitCode === null) server.child.kill("SIGKILL");
    }, 5_000).unref();
  });
}

function runOperator(args) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/operator.ts", ...args], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error("The local operator command failed.");
  try { return JSON.parse(result.stdout); }
  catch { throw new Error("The local operator command did not return JSON."); }
}

function createSiteFixture() {
  const organization = runOperator(["organization", "create", "--name", `Issue 45 recovery ${randomUUID()}`, "--pilot-fee-rate-basis-points", "1000"]);
  organizationIds.push(organization.organization_id);
  const site = runOperator(["site", "create", "--organization", organization.organization_id, "--name", "Issue 45 recovery Site"]);
  siteIds.push(site.site_id);
  const connection = runOperator([
    "payment-connection", "create", "--organization", organization.organization_id,
    "--provider", "square", "--environment", "test",
    "--account-reference", `ref:verify-recovery-account-${randomUUID()}`,
    "--location-reference", `ref:verify-recovery-location-${randomUUID()}`,
  ]);
  runOperator([
    "payment-connection", "eligibility-record", "--connection", connection.connection_id,
    "--account-status", "eligible", "--platform-fee-status", "eligible",
    "--evidence-reference", `ref:verify-recovery-eligibility-${randomUUID()}`,
  ]);
  runOperator(["site", "assign-connection", "--site", site.site_id, "--connection", connection.connection_id]);
  const key = runOperator(["site-key", "issue", "--site", site.site_id]);
  return {
    organizationId: organization.organization_id,
    siteId: site.site_id,
    apiKey: key.site_api_key,
    connectionId: connection.connection_id,
  };
}

async function api(site, pathname, { method = "GET", idempotencyKey, body } = {}) {
  const headers = { Authorization: `Bearer ${site.apiKey}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const response = await fetch(origin + pathname, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let data = null;
  try { data = await response.json(); } catch {}
  return { status: response.status, data };
}

async function cron() {
  const response = await fetch(`${origin}/api/cron/process`, {
    headers: { Authorization: `Bearer ${cronSecret}` },
    signal: AbortSignal.timeout(30_000),
  });
  let data = null;
  try { data = await response.json(); } catch {}
  return { status: response.status, data };
}

function actor() {
  return { type: "system", reference: "verify:issue-45-recovery" };
}

function eventData(eventId, title) {
  return {
    event_id: eventId,
    event_reference: `event-${eventId.slice(0, 8)}`,
    title,
    starts_at: "2033-04-21T19:00:00Z",
    ends_at: "2033-04-21T22:00:00Z",
    time_zone: "UTC",
    venue: { name: "Local recovery venue", address: null },
  };
}

async function seedFixture(site) {
  const client = await pool.connect();
  const fixture = { events: {}, orders: {} };
  try {
    await client.query("begin");

    async function makeEvent(label) {
      const eventId = randomUUID();
      const offeringId = randomUUID();
      await client.query(
        `insert into hpos.events
           (id, site_id, ticket_offering_id, title, description, venue_name, venue_address,
            starts_at, starts_at_offset_minutes, ends_at, ends_at_offset_minutes, time_zone,
            check_in_opens_at, check_in_opens_offset_minutes, visibility, publication_status,
            created_actor_type, created_actor_reference, updated_actor_type, updated_actor_reference)
         values ($1, $2, $3, $4, 'Local recovery verification Event', 'Local recovery venue', null,
                 '2033-04-21T19:00:00Z', 0, '2033-04-21T22:00:00Z', 0, 'UTC',
                 '2033-04-21T18:30:00Z', 0, 'public', 'published', 'system', $5, 'system', $5)`,
        [eventId, site.siteId, offeringId, `Issue 45 ${label}`, actor().reference],
      );
      await client.query(
        `insert into hpos.ticket_offerings
           (id, event_id, site_id, price_amount, currency, capacity, reserved_quantity,
            sales_opens_at, sales_opens_offset_minutes, sales_closes_at, sales_closes_offset_minutes,
            sales_ever_configured, tax_amount, buyer_fees)
         values ($1, $2, $3, 1000, 'USD', 20, 0, clock_timestamp() - interval '1 day', 0,
                 clock_timestamp() + interval '1 day', 0, true, 0, '[]'::jsonb)`,
        [offeringId, eventId, site.siteId],
      );
      return { eventId, offeringId, label };
    }

    async function makeOrder(event, label, options = {}) {
      const orderId = randomUUID();
      const buyerId = randomUUID();
      const quoteId = randomUUID();
      const reservationId = randomUUID();
      const attemptId = randomUUID();
      const orderReference = `R45-${label.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12)}-${randomUUID().slice(0, 6).toUpperCase()}`;
      const email = `${label}-${randomUUID()}@example.test`;
      const orderToken = token();
      const paymentReference = `r45-payment-${label}-${randomUUID()}`;
      const checkoutReference = `r45-checkout-${label}-${randomUUID()}`;
      const quantity = 1;
      const acceptedQuote = {
        quote_id: quoteId,
        event_id: event.eventId,
        offering_id: event.offeringId,
        quantity,
        currency: "USD",
        unit_price: 1000,
        subtotal: 1000,
        buyer_fees: [],
        tax_total: 0,
        total: 1000,
        platform_fee: { basis_points: 1000, amount: 100 },
      };
      const paid = options.paymentStatus === "paid";
      const attemptStatus = options.attemptStatus ?? (paid ? "closed" : "open");
      const checkoutStatus = options.checkoutStatus ?? (paid ? "ended" : "active");
      const issuanceStatus = options.issuanceStatus ?? (paid ? "issued" : "not_started");
      const reservationStatus = options.reservationStatus ?? (paid ? "consumed" : "held");
      const deliveryStatus = options.deliveryStatus ?? (paid ? "failed" : "not_sent");
      await client.query(
        `insert into hpos.buyers (id, site_id, normalized_email, name)
         values ($1, $2, $3, $4)`,
        [buyerId, site.siteId, email.toLowerCase(), `Issue 45 ${label} Buyer`],
      );
      await client.query(
        `insert into hpos.public_quotes
           (id, site_id, event_id, offering_id, quantity, currency, unit_price, subtotal,
            buyer_fees, tax_total, total, platform_fee_basis_points, platform_fee_amount, expires_at)
         values ($1, $2, $3, $4, 1, 'USD', 1000, 1000, '[]'::jsonb, 0, 1000, 1000, 100, clock_timestamp() + interval '1 day')`,
        [quoteId, site.siteId, event.eventId, event.offeringId],
      );
      await client.query(
        `insert into hpos.orders
           (id, site_id, event_id, offering_id, buyer_id, quote_id, order_reference,
            buyer_name, delivery_email, checkout_identity, accepted_quote, checkout_status,
            payment_status, issuance_status, checkout_expires_at, order_token, order_token_hash,
            payment_connection_id, delivery_status, refund_status)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13,
                 $14, $15::timestamptz, $16, $17, $18, $19, 'none')`,
        [orderId, site.siteId, event.eventId, event.offeringId, buyerId, quoteId, orderReference,
          `Issue 45 ${label} Buyer`, email, JSON.stringify({ name: `Issue 45 ${label} Buyer`, email }),
          JSON.stringify(acceptedQuote), checkoutStatus, options.paymentStatus ?? "unpaid", issuanceStatus,
          options.expired ? new Date(Date.now() - 60_000).toISOString() : new Date(Date.now() + 86_400_000).toISOString(),
          orderToken, hash(orderToken), site.connectionId, deliveryStatus],
      );
      await client.query(
        `insert into hpos.reservations
           (id, site_id, event_id, offering_id, order_id, quantity, status, expires_at, awaiting_provider_verification)
         values ($1, $2, $3, $4, $5, 1, $6, $7::timestamptz, $8)`,
        [reservationId, site.siteId, event.eventId, event.offeringId, orderId, reservationStatus,
          options.expired ? new Date(Date.now() - 60_000).toISOString() : new Date(Date.now() + 86_400_000).toISOString(),
          Boolean(options.awaitingProviderVerification)],
      );
      if (reservationStatus !== "released") {
        await client.query(
          `update hpos.ticket_offerings set reserved_quantity = reserved_quantity + 1 where id = $1 and site_id = $2`,
          [event.offeringId, site.siteId],
        );
      }
      await client.query(
        `insert into hpos.payment_attempts
           (id, site_id, order_id, connection_id, provider, environment, account_reference,
            location_reference, account_eligibility_status, platform_fee_eligibility_status,
            currency, total_amount, platform_fee_amount, provider_checkout_reference,
            provider_payment_reference, last_outcome, provider_can_take_payment, status)
         select $1, $2, $3, c.id, c.provider, c.environment, c.account_reference, c.location_reference,
                c.account_eligibility_status, c.platform_fee_eligibility_status, 'USD', 1000, 100,
                $4, $5, $6, $7, $8
         from hpos.payment_connections c where c.id = $9`,
        [attemptId, site.siteId, orderId, checkoutReference, paid ? paymentReference : null,
          paid ? "paid" : (options.lastOutcome ?? null), paid ? false : true, attemptStatus, site.connectionId],
      );

      if (paid && issuanceStatus === "issued") {
        const ticketId = randomUUID();
        const ticketToken = token();
        const qrPayload = token();
        await client.query(
          `insert into hpos.tickets
             (id, site_id, order_id, event_id, offering_id, ordinal, attendee_name,
              ticket_token, ticket_token_hash, qr_payload, qr_token_hash)
           values ($1, $2, $3, $4, $5, 1, null, $6, $7, $8, $9)`,
          [ticketId, site.siteId, orderId, event.eventId, event.offeringId, ticketToken, hash(ticketToken), qrPayload, hash(qrPayload)],
        );
        fixture.orders[label].ticketId = ticketId;
      }

      if (paid && issuanceStatus === "issued") {
        const payload = {
          recipient_email: email,
          buyer_name: `Issue 45 ${label} Buyer`,
          event: eventData(event.eventId, `Issue 45 ${event.label}`),
          order: { order_id: orderId, order_reference: orderReference, order_token: orderToken },
        };
        await client.query(
          `insert into hpos.notification_jobs
             (id, site_id, kind, event_id, order_id, status, attempt_count, payload)
           values ($1, $2, 'tickets_ready', $3, $4, 'failed', 1, $5::jsonb)`,
          [randomUUID(), site.siteId, event.eventId, orderId, JSON.stringify(payload)],
        );
      }
      const value = { orderId, buyerId, quoteId, reservationId, attemptId, orderReference, email, orderToken, checkoutReference, paymentReference, connectionId: site.connectionId, eventId: event.eventId, offeringId: event.offeringId };
      fixture.orders[label] = { ...fixture.orders[label], ...value };
      return value;
    }

    fixture.events.normal = await makeEvent("normal recovery");
    fixture.events.canceled = await makeEvent("canceled late payment");
    fixture.events.refund = await makeEvent("refund totals");

    fixture.orders.recovery = {};
    await makeOrder(fixture.events.normal, "recovery", { paymentStatus: "paid", issuanceStatus: "issued", reservationStatus: "consumed" });
    fixture.orders.issuance = {};
    await makeOrder(fixture.events.normal, "issuance", { paymentStatus: "paid", issuanceStatus: "failed", reservationStatus: "held", deliveryStatus: "not_sent" });
    fixture.orders.expired = {};
    await makeOrder(fixture.events.normal, "expired", { expired: true, checkoutStatus: "active", paymentStatus: "unpaid", issuanceStatus: "not_started", reservationStatus: "held" });
    fixture.orders.verification = {};
    await makeOrder(fixture.events.normal, "verification", { expired: true, checkoutStatus: "awaiting_payment_result", paymentStatus: "unknown", issuanceStatus: "not_started", reservationStatus: "held", attemptStatus: "open", lastOutcome: "unknown", awaitingProviderVerification: true });
    fixture.orders.late = {};
    await makeOrder(fixture.events.canceled, "late", { checkoutStatus: "awaiting_payment_result", paymentStatus: "unpaid", issuanceStatus: "not_started", reservationStatus: "held", attemptStatus: "open" });
    fixture.orders.refund = {};
    await makeOrder(fixture.events.refund, "refund", { paymentStatus: "paid", issuanceStatus: "issued", reservationStatus: "consumed" });

    await client.query("commit");
    return fixture;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function findRecoveryJob(site, orderId) {
  const result = await pool.query(
    `select id, payload, claim_id, lease_fence from hpos.notification_jobs
     where site_id = $1 and kind = 'order_recovery' and payload @> jsonb_build_object('orders', jsonb_build_array(jsonb_build_object('order_id', $2::text)))
     order by created_at desc limit 1`,
    [site.siteId, orderId],
  );
  return result.rows[0] ?? null;
}

async function verifyUnattendedRecovery(site, fixture) {
  const recovery = fixture.orders.recovery;
  const matched = await api(site, "/v1/public/order-recovery", {
    method: "POST", idempotencyKey: randomUUID(), body: { email: recovery.email },
  });
  assert(matched.status === 202 && matched.data?.data?.accepted === true, `A matching lost-Order request was not acknowledged (${safeResult(matched)}).`);
  const unmatched = await api(site, "/v1/public/order-recovery", {
    method: "POST", idempotencyKey: randomUUID(), body: { email: `missing-${randomUUID()}@example.test` },
  });
  assert(unmatched.status === 202 && unmatched.data?.data?.accepted === true, `An unmatched lost-Order request was enumerable (${safeResult(unmatched)}).`);

  const job = await findRecoveryJob(site, recovery.orderId);
  assert(job?.id, "The matching recovery request did not create durable recovery work.");
  const claimBody = { limit: 1, kinds: ["order_recovery"], actor: actor() };
  const claim = await api(site, "/v1/admin/notification-jobs/claims", { method: "POST", idempotencyKey: randomUUID(), body: claimBody });
  const claimed = claim.data?.data?.jobs?.find((candidate) => candidate.job_id === job.id);
  assert(claim.status === 200 && claimed, `The local Site adapter could not claim recovery work (${safeResult(claim)}).`);

  // Deliberately do not report the provider result to model a Site/provider
  // response lost after the provider call. The active lease is recovered by
  // the bounded HP-OS worker and the next claim must require verification.
  const unknownBody = {
    claim_id: claim.data.data.claim_id,
    lease_fence: claimed.lease_fence,
    outcome: "unknown",
    provider_message_reference: null,
    observed_at: new Date().toISOString(),
    error_code: "adapter_timeout",
    actor: actor(),
  };
  await pool.query(`update hpos.notification_claims set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1`, [claim.data.data.claim_id]);
  const recoveredRun = await cron();
  assert(recoveredRun.status === 200 && recoveredRun.data?.data?.recovered_jobs >= 1, `The bounded worker did not recover an expired Site claim (${safeResult(recoveredRun)}).`);
  const stale = await api(site, `/v1/admin/notification-jobs/${job.id}/outcome-reports`, {
    method: "POST", idempotencyKey: randomUUID(), body: { ...unknownBody, observed_at: new Date().toISOString() },
  });
  assert(stale.status === 409 && stale.data?.error?.code === "claim_conflict", "A stale recovery worker could report after lease recovery.");

  const nextClaim = await api(site, "/v1/admin/notification-jobs/claims", { method: "POST", idempotencyKey: randomUUID(), body: claimBody });
  const nextJob = nextClaim.data?.data?.jobs?.find((candidate) => candidate.job_id === job.id);
  assert(nextClaim.status === 200 && nextJob?.requires_verification === true && nextJob.lease_fence >= 3, "Recovered recovery work did not require a fresh provider verification fence.");
  const messageReference = `synthetic-message-${randomUUID()}`;
  const completedBody = {
    claim_id: nextClaim.data.data.claim_id,
    lease_fence: nextJob.lease_fence,
    outcome: "completed",
    provider_message_reference: messageReference,
    observed_at: new Date().toISOString(),
    error_code: null,
    actor: actor(),
  };
  const completedKey = randomUUID();
  const completed = await api(site, `/v1/admin/notification-jobs/${job.id}/outcome-reports`, { method: "POST", idempotencyKey: completedKey, body: completedBody });
  const completedReplay = await api(site, `/v1/admin/notification-jobs/${job.id}/outcome-reports`, { method: "POST", idempotencyKey: completedKey, body: completedBody });
  assert(completed.status === 200 && completedReplay.status === 200 && completedReplay.data?.data?.status === "completed", "A verified recovery dispatch was not idempotent.");
  const delivered = await api(site, `/v1/admin/notification-jobs/${job.id}/delivery-reports`, {
    method: "POST", idempotencyKey: randomUUID(), body: {
      outcome: "delivered", provider_message_reference: messageReference,
      provider_event_reference: `synthetic-delivery-${randomUUID()}`, observed_at: new Date().toISOString(), actor: actor(),
    },
  });
  assert(delivered.status === 200 && delivered.data?.data?.delivery_status === "delivered", "The durable recovery delivery report was not retained.");

  // The claimed payload is intentionally stale when staff correct the address.
  // HP-OS revokes the temporary token and invalidates the old normal token;
  // the Site adapter must re-read this state before sending the old payload.
  const recoveryJobPayload = (await findRecoveryJob(site, recovery.orderId))?.payload;
  const temporaryToken = recoveryJobPayload?.orders?.[0]?.order_token;
  assert(typeof temporaryToken === "string", "The recovery job did not contain a temporary link for the stale-payload check.");
  const temporaryRead = await api(site, `/v1/public/orders/${temporaryToken}`);
  assert(temporaryRead.status === 200, `The live temporary recovery link could not be read (${safeResult(temporaryRead)}).`);
  const currentOrder = await api(site, `/v1/admin/orders/${recovery.orderId}`);
  const correction = await api(site, `/v1/admin/orders/${recovery.orderId}/actions/correct_delivery_email`, {
    method: "POST", idempotencyKey: randomUUID(), body: {
      actor: actor(), expected_version: currentOrder.data?.data?.version,
      email: `corrected-${randomUUID()}@example.test`, reason: "Synthetic recovery correction", verification_reference: "ref:verify-recovery-correction",
    },
  });
  assert(correction.status === 202, `Verified delivery-email correction could not fence stale recovery data (${safeResult(correction)}).`);
  const oldNormalRead = await api(site, `/v1/public/orders/${recovery.orderToken}`);
  const oldTemporaryRead = await api(site, `/v1/public/orders/${temporaryToken}`);
  assert(oldNormalRead.status === 404 && oldTemporaryRead.status === 404, "Old normal or temporary recovery access remained valid after correction.");
}

async function verifyWorkerOverlapAndUncertainCheckout(site, fixture) {
  const runs = await Promise.all([cron(), cron()]);
  assert(runs.every((result) => result.status === 200), "Overlapping local HP-OS worker runs did not complete through HTTP.");
  const expired = await pool.query(
    `select order_row.checkout_status, reservation.status, offering.reserved_quantity
     from hpos.orders order_row
     join hpos.reservations reservation on reservation.order_id = order_row.id and reservation.site_id = order_row.site_id
     join hpos.ticket_offerings offering on offering.id = reservation.offering_id and offering.site_id = reservation.site_id
     where order_row.id = $1`,
    [fixture.orders.expired.orderId],
  );
  assert(expired.rows[0]?.checkout_status === "expired" && expired.rows[0]?.status === "released", "Overlapping workers released an expired Reservation incorrectly or twice.");

  const verification = await pool.query(
    `select attempt.status, reservation.status as reservation_status, reservation.awaiting_provider_verification
     from hpos.payment_attempts attempt
     join hpos.reservations reservation on reservation.order_id = attempt.order_id and reservation.site_id = attempt.site_id
     where attempt.id = $1`,
    [fixture.orders.verification.attemptId],
  );
  const verificationState = verification.rows[0];
  assert(verificationState?.status === "requires_verification" && verificationState?.reservation_status === "held",
    `An uncertain payment Reservation was released instead of being held for verification (attempt=${verificationState?.status ?? "missing"}, reservation=${verificationState?.reservation_status ?? "missing"}, awaiting=${String(verificationState?.awaiting_provider_verification ?? "missing")}).`);
}

async function verifyIssuanceRetry(site, fixture) {
  const before = await api(site, `/v1/admin/orders/${fixture.orders.issuance.orderId}`);
  assert(before.status === 200 && before.data?.data?.issuance_status === "failed", "The failed issuance fixture was not visible to staff.");
  const retry = await api(site, `/v1/admin/orders/${fixture.orders.issuance.orderId}/actions/retry_ticket_issuance`, {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: actor(), expected_version: before.data.data.version },
  });
  assert(retry.status === 202, `Guarded Ticket issuance retry was not accepted (${safeResult(retry)}).`);
  const firstRun = await cron();
  assert(firstRun.status === 200, `The bounded worker could not finish Ticket issuance recovery (${safeResult(firstRun)}).`);
  const after = await api(site, `/v1/admin/orders/${fixture.orders.issuance.orderId}`);
  const state = await pool.query(
    `select order_row.payment_status, order_row.issuance_status,
            reservation.status as reservation_status,
            event_row.is_canceled,
            (order_row.order_token is not null) as has_order_token,
            (select count(*)::integer from hpos.tickets ticket
             where ticket.site_id = order_row.site_id and ticket.order_id = order_row.id) as ticket_count,
            (select count(*)::integer from hpos.notification_jobs job
             where job.site_id = order_row.site_id and job.order_id = order_row.id
               and job.kind = 'tickets_ready') as tickets_ready_jobs
     from hpos.orders order_row
     join hpos.reservations reservation
       on reservation.order_id = order_row.id and reservation.site_id = order_row.site_id
     join hpos.events event_row
       on event_row.id = order_row.event_id and event_row.site_id = order_row.site_id
     where order_row.site_id = $1 and order_row.id = $2`,
    [site.siteId, fixture.orders.issuance.orderId],
  );
  const issuanceState = state.rows[0];
  const ticketCount = Number(issuanceState?.ticket_count ?? -1);
  assert(after.status === 200 && after.data?.data?.issuance_status === "issued" && after.data?.data?.tickets?.length === 1,
    `Ticket issuance recovery did not produce exactly one Ticket (api=${safeResult(after)}, db=${issuanceState?.payment_status ?? "missing"}/${issuanceState?.issuance_status ?? "missing"}, reservation=${issuanceState?.reservation_status ?? "missing"}, canceled=${String(issuanceState?.is_canceled ?? "missing")}, token=${String(issuanceState?.has_order_token ?? "missing")}, tickets=${ticketCount}, delivery_jobs=${Number(issuanceState?.tickets_ready_jobs ?? -1)}).`);
  const secondRun = await cron();
  assert(secondRun.status === 200, "A second worker run could not replay the issuance frontier safely.");
  const count = await pool.query(`select count(*)::integer as count from hpos.tickets where site_id = $1 and order_id = $2`, [site.siteId, fixture.orders.issuance.orderId]);
  assert(count.rows[0]?.count === 1, "Repeated issuance recovery created duplicate Tickets.");
}

function paymentReport(order, outcome, sourceReference, observedAt, paymentReference = order.paymentReference) {
  return {
    connection_id: order.connectionId,
    source_reference: sourceReference,
    provider_checkout_reference: order.checkoutReference,
    provider_payment_reference: outcome === "paid" ? paymentReference : null,
    outcome,
    observed_at: observedAt,
    payment_started_at: observedAt,
    provider_can_take_payment: outcome === "paid" ? false : true,
    ...(outcome === "paid" ? { amount: 1000, currency: "USD" } : {}),
  };
}

async function verifyCancellationRefundsAndFees(site, fixture) {
  const late = fixture.orders.late;
  const canceled = await api(site, `/v1/admin/events/${fixture.events.canceled.eventId}/actions/cancel`, {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: actor(), expected_version: 1 },
  });
  assert(canceled.status === 200 && canceled.data?.data?.is_canceled === true, `The Event cancellation could not be recorded (${safeResult(canceled)}).`);
  const latePayment = await api(site, `/v1/admin/payment-attempts/${late.attemptId}/payment-reports`, {
    method: "POST", idempotencyKey: randomUUID(), body: paymentReport(late, "paid", `r45-late-payment-${randomUUID()}`, new Date().toISOString()),
  });
  assert(latePayment.status === 201, `A late payment report after cancellation was not retained (${safeResult(latePayment)}).`);
  const lateState = await api(site, `/v1/admin/orders/${late.orderId}`);
  assert(lateState.status === 200 && lateState.data?.data?.issuance_status === "blocked" && lateState.data?.data?.tickets?.length === 0, "A late payment on a canceled Event produced a usable Ticket.");
  const lateRefund = await api(site, `/v1/admin/orders/${late.orderId}/refund-reports`, {
    method: "POST", idempotencyKey: randomUUID(), body: {
      attempt_id: late.attemptId, connection_id: site.connectionId,
      provider_payment_reference: late.paymentReference,
      provider_refund_reference: `r45-late-refund-${randomUUID()}`, source_reference: `r45-late-refund-source-${randomUUID()}`,
      outcome: "completed", amount: 1000, currency: "USD", observed_at: new Date().toISOString(),
    },
  });
  assert(lateRefund.status === 201, `A late-payment refund observation was not retained (${safeResult(lateRefund)}).`);

  const refund = fixture.orders.refund;
  const fullRefundReference = `r45-refund-${randomUUID()}`;
  const fullRefund = await api(site, `/v1/admin/orders/${refund.orderId}/refund-reports`, {
    method: "POST", idempotencyKey: randomUUID(), body: {
      attempt_id: refund.attemptId, connection_id: site.connectionId,
      provider_payment_reference: refund.paymentReference,
      provider_refund_reference: fullRefundReference, source_reference: `r45-refund-source-${randomUUID()}`,
      outcome: "completed", amount: 1000, currency: "USD", observed_at: new Date().toISOString(),
    },
  });
  assert(fullRefund.status === 201 && fullRefund.data?.data?.refund?.outcome === "completed", `The full refund recovery observation failed (${safeResult(fullRefund)}).`);
  const refunded = await api(site, `/v1/admin/orders/${refund.orderId}`);
  assert(refunded.status === 200 && refunded.data?.data?.refund_status === "full", "A completed full refund did not change the Order refund state.");
  const capacity = await pool.query(`select reserved_quantity from hpos.ticket_offerings where id = $1`, [refund.offeringId]);
  assert(Number(capacity.rows[0]?.reserved_quantity ?? -1) === 0, "Full refund did not restore unadmitted Ticket capacity exactly once.");

  const feePath = `/v1/admin/orders/${refund.orderId}/fee-reports`;
  const confirmationPath = `/v1/admin/orders/${refund.orderId}/fee-confirmations`;
  const feeBody = (scopeType, scopeReference, category, amount) => ({
    actor: actor(), attempt_id: refund.attemptId, connection_id: site.connectionId,
    scope_type: scopeType, scope_reference: scopeReference, source_reference: `r45-fee-${category}-${scopeType}-${randomUUID()}`,
    source_revision: 1, category, direction: "charge", amount, currency: "USD", observed_at: new Date().toISOString(),
  });
  const feeReport = await api(site, feePath, { method: "POST", idempotencyKey: randomUUID(), body: feeBody("payment", refund.paymentReference, "processing", 40) });
  assert(feeReport.status === 201, `A provider fee observation failed (${safeResult(feeReport)}).`);
  const pendingTotals = await api(site, `/v1/admin/events/${fixture.events.refund.eventId}/totals`);
  assert(pendingTotals.status === 200 && pendingTotals.data?.data?.sales?.some((row) => row.processing_fees?.reporting_status === "pending"), "Missing fee confirmation was reported as settled.");
  for (const [scopeType, scopeReference] of [["payment", refund.paymentReference], ["refund", fullRefundReference]]) {
    for (const [category, amount] of [["processing", 0], ["platform", 0]]) {
      if (scopeType === "payment" && category === "processing") continue;
      const report = await api(site, feePath, { method: "POST", idempotencyKey: randomUUID(), body: feeBody(scopeType, scopeReference, category, amount) });
      assert(report.status === 201, `A ${scopeType} ${category} fee observation failed (${safeResult(report)}).`);
    }
  }
  for (const [scopeType, scopeReference, category, charged] of [
    ["payment", refund.paymentReference, "processing", 40],
    ["payment", refund.paymentReference, "platform", 0],
    ["refund", fullRefundReference, "processing", 0],
    ["refund", fullRefundReference, "platform", 0],
  ]) {
    const confirmation = await api(site, confirmationPath, {
      method: "POST", idempotencyKey: randomUUID(), body: {
        actor: actor(), attempt_id: refund.attemptId, connection_id: site.connectionId,
        scope_type: scopeType, scope_reference: scopeReference, category,
        totals: [{ currency: "USD", charged, returned: 0 }], observed_at: new Date().toISOString(),
      },
    });
    assert(confirmation.status === 200, `${scopeType} ${category} fee completeness confirmation failed (${safeResult(confirmation)}).`);
  }
  const settledTotals = await api(site, `/v1/admin/events/${fixture.events.refund.eventId}/totals`);
  assert(settledTotals.status === 200 && settledTotals.data?.data?.sales?.some((row) => row.processing_fees?.reporting_status === "complete"), "Confirmed fee completeness did not become visible in totals.");
}

async function verify() {
  assert(isCanonicalLocalDatabase(databaseUrl), "Refusing recovery verification unless HPOS_DATABASE_URL is the canonical local PostgreSQL URL.");
  await assertPortIsFree();
  app = startApp();
  await waitForReady(app);
  const site = createSiteFixture();
  const runStage = async (name, operation) => {
    try { return await operation(); }
    catch (error) { throw new Error(`${name}: ${error instanceof Error ? error.message : "failed"}`); }
  };
  const fixture = await runStage("fixture setup", () => seedFixture(site));
  const publicEvent = await api(site, `/v1/public/events/${fixture.events.normal.eventId}`);
  const eventData = publicEvent.data?.data;
  assert(publicEvent.status === 200
    && RFC3339_WITH_OFFSET.test(eventData?.starts_at ?? "")
    && RFC3339_WITH_OFFSET.test(eventData?.ends_at ?? "")
    && RFC3339_WITH_OFFSET.test(eventData?.check_in_opens_at ?? ""),
  `The public Event formatter did not return RFC3339 timestamps with offsets (${safeResult(publicEvent)}).`);
  await runStage("issuance retry", () => verifyIssuanceRetry(site, fixture));
  await runStage("unattended recovery", () => verifyUnattendedRecovery(site, fixture));
  await runStage("overlapping worker recovery", () => verifyWorkerOverlapAndUncertainCheckout(site, fixture));
  await runStage("cancellation, refunds, fees, and totals", () => verifyCancellationRefundsAndFees(site, fixture));
}

async function cleanup() {
  if (!organizationIds.length) return;
  const ids = siteIds;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const tables = [
      "hpos.admissions", "hpos.notification_delivery_events", "hpos.notification_dispatch_attempts",
      "hpos.notification_jobs", "hpos.notification_claims", "hpos.order_recovery_actions",
      "hpos.payment_report_issue_resolutions", "hpos.payment_report_issues", "hpos.refund_report_issues",
      "hpos.fee_report_issues", "hpos.fee_confirmation_totals", "hpos.fee_confirmations", "hpos.fee_records",
      "hpos.payment_attempt_closure_reports", "hpos.payment_attempt_reports", "hpos.refund_reports", "hpos.refunds",
      "hpos.tickets", "hpos.payment_attempts", "hpos.reservations", "hpos.orders", "hpos.public_quotes",
      "hpos.access_request_decisions", "hpos.access_request_approval_tokens", "hpos.access_requests", "hpos.buyers",
      "hpos.ticket_offering_provider_mappings", "hpos.events",
    ];
    for (const table of tables) {
      await client.query(`delete from ${table} where site_id = any($1::uuid[])`, [ids]).catch(async (error) => {
        if (error?.code === "42P01") return;
        throw error;
      });
    }
    await client.query("delete from hpos.site_payment_connection_assignments where organization_id = any($1::uuid[])", [organizationIds]);
    await client.query("delete from hpos.payment_connections where organization_id = any($1::uuid[])", [organizationIds]);
    await client.query("delete from hpos.sites where organization_id = any($1::uuid[])", [organizationIds]);
    await client.query("delete from hpos.organizations where id = any($1::uuid[])", [organizationIds]);
    const remaining = await client.query(
      "select count(*)::integer as count from hpos.organizations where id = any($1::uuid[])",
      [organizationIds],
    );
    assert(remaining.rows[0]?.count === 0, "Synthetic recovery Organizations remained after cleanup.");
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

let verificationError = null;
let cleanupError = null;
try {
  await verify();
} catch (error) {
  verificationError = error;
} finally {
  await stopApp(app);
  try { await cleanup(); }
  catch (error) { cleanupError = error; }
  await pool.end();
}
if (verificationError) console.error(verificationError instanceof Error ? verificationError.message : "Recovery verification failed.");
if (cleanupError) console.error(`Synthetic-fixture cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : "unknown cleanup failure"}`);
if (verificationError || cleanupError) process.exitCode = 1;
else {
  console.log("Issue #45 local recovery verification passed: overlapping bounded HP-OS workers, lost/uncertain Site reports, stale claims and payload fencing, issuance recovery, cancellation/late payment, refunds, fee completeness, and totals.");
  console.log("External LMNL, hosted, provider, mailbox, Wallet/device, and cutover proof remains deferred by docs/release-and-cutover.md.");
}
