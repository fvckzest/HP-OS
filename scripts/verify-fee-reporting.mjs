import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.HPOS_VERIFY_FEES_PORT ?? 3295);
const origin = `http://127.0.0.1:${port}`;
const databaseUrl = process.env.HPOS_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const env = { ...process.env, NODE_ENV: "development", HPOS_DATABASE_URL: databaseUrl, NEXT_TELEMETRY_DISABLED: "1" };
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 2_000 });
const fixture = { organizationId: randomUUID(), siteId: randomUUID(), connectionId: randomUUID(), eventId: randomUUID(), offeringId: randomUUID(), buyerId: randomUUID(), quoteId: randomUUID(), orderId: randomUUID(), reservationId: randomUUID(), attemptId: randomUUID(), refundId: randomUUID(), ticketId: randomUUID(), admissionId: randomUUID() };
const siteKeyId = randomUUID();
const apiKey = `hpos_site_${siteKeyId}_${randomBytes(32).toString("base64url")}`;
const orderToken = randomBytes(24).toString("base64url");
const ticketToken = randomBytes(24).toString("base64url");
const qrPayload = randomBytes(24).toString("base64url");
const paymentReference = `issue43-fee-payment-${randomUUID()}`;
const firstRefundReference = `issue43-fee-refund-${randomUUID()}`;
let app;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertPortIsFree() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`Verification port ${port} is already in use.`)));
    server.listen(port, "127.0.0.1", () => server.close((error) => error ? reject(error) : resolve()));
  });
}

function startApp() {
  const child = spawn("next", ["dev", "--hostname", "127.0.0.1", "--port", String(port)], {
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
    if (server.child.exitCode !== null) throw new Error(`The fee verification app stopped early.\n${server.output}`);
    try {
      const response = await fetch(`${origin}/v1/admin/payment-configuration`, { signal: AbortSignal.timeout(2_000) });
      if (response.status === 401) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`The fee verification app did not become ready within 90 seconds.\n${server.output}`);
}

function stopApp(server) {
  return new Promise((resolve) => {
    if (!server || server.child.exitCode !== null) return resolve();
    server.child.once("exit", () => resolve());
    server.child.kill("SIGTERM");
    setTimeout(() => { if (server.child.exitCode === null) server.child.kill("SIGKILL"); }, 5_000).unref();
  });
}

async function createFixture() {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set constraints all deferred");
    await client.query(
      `insert into hpos.organizations (id, name, fee_terms_status, platform_fee_basis_points)
       values ($1, $2, 'configured', 0)`, [fixture.organizationId, `Issue 43 fee verification ${fixture.organizationId}`]);
    await client.query(
      `insert into hpos.sites (id, organization_id, name) values ($1, $2, 'Issue 43 fee verification Site')`,
      [fixture.siteId, fixture.organizationId]);
    await client.query(
      `insert into hpos.payment_connections (
         id, organization_id, provider, environment, account_reference, location_reference,
         account_eligibility_status, platform_fee_eligibility_status, eligibility_validated_at, eligibility_evidence_reference
       ) values ($1, $2, 'square', 'test', 'ref:issue43-fee-account', 'ref:issue43-fee-location',
         'eligible', 'eligible', clock_timestamp(), 'ref:issue43-fee-verification')`,
      [fixture.connectionId, fixture.organizationId]);
    await client.query(
      `insert into hpos.site_payment_connection_assignments (site_id, organization_id, connection_id)
       values ($1, $2, $3)`, [fixture.siteId, fixture.organizationId, fixture.connectionId]);
    await client.query(
      `insert into hpos.site_api_keys (id, site_id, key_hash) values ($1, $2, $3)`,
      [siteKeyId, fixture.siteId, sha256(apiKey)]);
    await client.query(
      `insert into hpos.events (
         id, site_id, ticket_offering_id, title, publication_status, created_actor_type,
         created_actor_reference, updated_actor_type, updated_actor_reference
       ) values ($1, $2, $3, 'Issue 43 fee verification Event', 'published', 'system', 'verify:issue43', 'system', 'verify:issue43')`,
      [fixture.eventId, fixture.siteId, fixture.offeringId]);
    await client.query(
      `insert into hpos.ticket_offerings (
         id, event_id, site_id, price_amount, currency, capacity, tax_amount, buyer_fees
       ) values ($1, $2, $3, 2500, 'USD', 1, 0, '[]'::jsonb)`,
      [fixture.offeringId, fixture.eventId, fixture.siteId]);
    await client.query(
      `insert into hpos.buyers (id, site_id, normalized_email, name)
       values ($1, $2, 'issue43-fees@example.test', 'Issue 43 Fee Buyer')`,
      [fixture.buyerId, fixture.siteId]);
    await client.query(
      `insert into hpos.public_quotes (
         id, site_id, event_id, offering_id, currency, unit_price, subtotal, buyer_fees,
         tax_total, total, platform_fee_basis_points, platform_fee_amount, expires_at
       ) values ($1, $2, $3, $4, 'USD', 2500, 2500, '[]'::jsonb, 0, 2500, 0, 0, clock_timestamp() + interval '1 day')`,
      [fixture.quoteId, fixture.siteId, fixture.eventId, fixture.offeringId]);
    await client.query(
      `insert into hpos.orders (
         id, site_id, event_id, offering_id, buyer_id, quote_id, payment_connection_id,
         order_reference, buyer_name, delivery_email, checkout_identity, accepted_quote,
         checkout_status, payment_status, issuance_status, checkout_expires_at,
         order_token, order_token_hash, delivery_status, refund_status
       ) values ($1, $2, $3, $4, $5, $6, $7, 'ISSUE43-FEE-1', 'Issue 43 Fee Buyer',
         'issue43-fees@example.test', '{}'::jsonb,
         '{"currency":"USD","total":{"amount":2500,"currency":"USD"},"platform_fee":{"amount":0,"currency":"USD"}}'::jsonb,
         'ended', 'paid', 'issued', clock_timestamp() + interval '1 day', $8, $9, 'sent', 'partial')`,
      [fixture.orderId, fixture.siteId, fixture.eventId, fixture.offeringId, fixture.buyerId, fixture.quoteId,
        fixture.connectionId, orderToken, sha256(orderToken)]);
    await client.query(
      `insert into hpos.payment_attempts (
         id, site_id, order_id, connection_id, provider, environment, account_reference,
         location_reference, account_eligibility_status, platform_fee_eligibility_status,
         currency, total_amount, platform_fee_amount, provider_checkout_reference,
         provider_payment_reference, last_outcome, provider_can_take_payment, status
       ) values ($1, $2, $3, $4, 'square', 'test', 'ref:issue43-fee-account', 'ref:issue43-fee-location',
         'eligible', 'eligible', 'USD', 2500, 0, 'issue43-fee-checkout', '${paymentReference}',
         'paid', false, 'closed')`,
      [fixture.attemptId, fixture.siteId, fixture.orderId, fixture.connectionId]);
    await client.query(
      `insert into hpos.reservations (
         id, site_id, event_id, offering_id, order_id, quantity, status, expires_at
       ) values ($1, $2, $3, $4, $5, 1, 'consumed', clock_timestamp() + interval '1 day')`,
      [fixture.reservationId, fixture.siteId, fixture.eventId, fixture.offeringId, fixture.orderId]);
    await client.query(
      `insert into hpos.refunds (
         id, site_id, order_id, attempt_id, connection_id, provider, environment,
         account_reference, provider_payment_reference, provider_refund_reference,
         outcome, amount, currency, observed_at
       ) values ($1, $2, $3, $4, $5, 'square', 'test', 'ref:issue43-fee-account',
         '${paymentReference}', '${firstRefundReference}', 'completed', 1000, 'USD', '2030-01-02T13:00:00Z')`,
      [fixture.refundId, fixture.siteId, fixture.orderId, fixture.attemptId, fixture.connectionId]);
    const ticketTokenHash = sha256(ticketToken);
    const qrHash = sha256(qrPayload);
    await client.query(
      `insert into hpos.tickets (
         id, site_id, order_id, event_id, offering_id, ordinal, attendee_name,
         ticket_token, ticket_token_hash, qr_payload, qr_token_hash
       ) values ($1, $2, $3, $4, $5, 1, 'Issue 43 Attendee', $6, $7, $8, $9)`,
      [fixture.ticketId, fixture.siteId, fixture.orderId, fixture.eventId, fixture.offeringId,
        ticketToken, ticketTokenHash, qrPayload, qrHash]);
    await client.query(
      `insert into hpos.admissions (id, site_id, event_id, ticket_id, actor_type, actor_reference)
       values ($1, $2, $3, $4, 'system', 'verify:issue43')`,
      [fixture.admissionId, fixture.siteId, fixture.eventId, fixture.ticketId]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function api(pathname, { method = "GET", body, idempotencyKey } = {}) {
  const headers = { Authorization: `Bearer ${apiKey}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const response = await fetch(origin + pathname, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let data = null;
  try { data = await response.json(); } catch {}
  return { status: response.status, data };
}

function feeReport(scopeType, scopeReference, sourceReference, sourceRevision, amount, currency, observedAt) {
  return {
    actor: { type: "system", reference: "verify:issue43-fees" },
    attempt_id: fixture.attemptId,
    connection_id: fixture.connectionId,
    scope_type: scopeType,
    scope_reference: scopeReference,
    source_reference: sourceReference,
    source_revision: sourceRevision,
    category: "processing",
    direction: "charge",
    amount,
    currency,
    observed_at: observedAt,
  };
}

function confirmation(scopeType, scopeReference, category, totals, observedAt) {
  return {
    actor: { type: "system", reference: "verify:issue43-fees" },
    attempt_id: fixture.attemptId,
    connection_id: fixture.connectionId,
    scope_type: scopeType,
    scope_reference: scopeReference,
    category,
    totals,
    observed_at: observedAt,
  };
}

function refundReport(providerRefundReference, sourceReference, amount, observedAt) {
  return {
    attempt_id: fixture.attemptId,
    connection_id: fixture.connectionId,
    provider_payment_reference: paymentReference,
    provider_refund_reference: providerRefundReference,
    source_reference: sourceReference,
    outcome: "completed",
    amount,
    currency: "USD",
    observed_at: observedAt,
  };
}

async function verify() {
  const paymentPath = `/v1/admin/orders/${fixture.orderId}/fee-reports`;
  const confirmationPath = `/v1/admin/orders/${fixture.orderId}/fee-confirmations`;
  const totalsPath = `/v1/admin/events/${fixture.eventId}/totals`;
  const paymentScope = paymentReference;
  const refundScope = firstRefundReference;

  const firstPaymentFee = await api(paymentPath, {
    method: "POST", idempotencyKey: randomUUID(),
    body: feeReport("payment", paymentScope, "issue43-fee-source", 1, 50, "USD", "2030-01-02T12:00:00Z"),
  });
  assert(firstPaymentFee.status === 201, `A paid payment fee report failed: ${JSON.stringify(firstPaymentFee.data)}`);
  const newerPaymentFee = await api(paymentPath, {
    method: "POST", idempotencyKey: randomUUID(),
    body: feeReport("payment", paymentScope, "issue43-fee-source", 2, 75, "USD", "2030-01-02T10:00:00Z"),
  });
  assert(newerPaymentFee.status === 201, `A newer payment fee revision failed: ${JSON.stringify(newerPaymentFee.data)}`);
  const refundFee = await api(paymentPath, {
    method: "POST", idempotencyKey: randomUUID(),
    body: feeReport("refund", refundScope, "issue43-refund-source", 1, 0, "USD", "2030-01-02T13:00:00Z"),
  });
  assert(refundFee.status === 201, `A completed refund fee report failed: ${JSON.stringify(refundFee.data)}`);

  const currentRevisionConfirmation = await api(confirmationPath, {
    method: "POST", idempotencyKey: randomUUID(),
    body: confirmation("payment", paymentScope, "processing", [{ currency: "USD", charged: 75, returned: 0 }], "2030-01-02T11:00:00Z"),
  });
  assert(currentRevisionConfirmation.status === 200, `A confirmation for the highest source revision failed: ${JSON.stringify(currentRevisionConfirmation.data)}`);
  const refundProcessingConfirmation = await api(confirmationPath, {
    method: "POST", idempotencyKey: randomUUID(),
    body: confirmation("refund", refundScope, "processing", [{ currency: "USD", charged: 0, returned: 0 }], "2030-01-02T14:00:00Z"),
  });
  assert(refundProcessingConfirmation.status === 200, `The completed refund confirmation failed: ${JSON.stringify(refundProcessingConfirmation.data)}`);
  const currentRevisionTotals = await api(totalsPath);
  const currentRevisionSales = new Map(currentRevisionTotals.data?.data?.sales?.map((row) => [row.currency, row]) ?? []);
  assert(currentRevisionTotals.status === 200 && currentRevisionSales.get("USD")?.gross_paid_sales.amount === 2500
    && currentRevisionSales.get("USD")?.refunded_amount.amount === 1000
    && currentRevisionSales.get("USD")?.net_sales.amount === 1500
    && currentRevisionSales.get("USD")?.processing_fees.reporting_status === "complete",
    `A higher source revision was incorrectly ignored because its provider observation was earlier than the superseded revision: ${JSON.stringify(currentRevisionTotals.data)}`);
  assert(currentRevisionTotals.data.data.tickets.issued === 1 && currentRevisionTotals.data.data.tickets.valid === 1
    && currentRevisionTotals.data.data.tickets.admitted === 1,
  `Issued, valid, and admitted Ticket totals did not preserve their overlap: ${JSON.stringify(currentRevisionTotals.data)}`);

  const latestPaymentFee = await api(paymentPath, {
    method: "POST", idempotencyKey: randomUUID(),
    body: feeReport("payment", paymentScope, "issue43-fee-source", 3, 80, "USD", "2030-01-02T13:00:00Z"),
  });
  assert(latestPaymentFee.status === 201, `A later payment fee revision failed: ${JSON.stringify(latestPaymentFee.data)}`);
  const stalePaymentConfirmation = await api(confirmationPath, {
    method: "POST", idempotencyKey: randomUUID(),
    body: confirmation("payment", paymentScope, "processing", [{ currency: "USD", charged: 80, returned: 0 }], "2030-01-02T11:00:00Z"),
  });
  assert(stalePaymentConfirmation.status === 200, `A stale confirmation was not retained: ${JSON.stringify(stalePaymentConfirmation.data)}`);
  const pendingTotals = await api(totalsPath);
  assert(pendingTotals.status === 200 && pendingTotals.data.data.sales.find((row) => row.currency === "USD")?.processing_fees.reporting_status === "pending",
    "A stale confirmation submitted after a newer fee revision incorrectly closed processing fees.");

  const jpyPaymentFee = await api(paymentPath, {
    method: "POST", idempotencyKey: randomUUID(),
    body: feeReport("payment", paymentScope, "issue43-jpy-source", 1, 10, "JPY", "2030-01-02T13:00:00Z"),
  });
  assert(jpyPaymentFee.status === 201, `A second-currency payment fee report failed: ${JSON.stringify(jpyPaymentFee.data)}`);
  const currentPaymentConfirmation = await api(confirmationPath, {
    method: "POST", idempotencyKey: randomUUID(),
    body: confirmation("payment", paymentScope, "processing", [
      { currency: "USD", charged: 80, returned: 0 },
      { currency: "JPY", charged: 10, returned: 0 },
    ], "2030-01-02T14:00:00Z"),
  });
  assert(currentPaymentConfirmation.status === 200, `The current payment confirmation failed: ${JSON.stringify(currentPaymentConfirmation.data)}`);

  const missingPaymentCurrency = await api(confirmationPath, {
    method: "POST", idempotencyKey: randomUUID(),
    body: confirmation("payment", paymentScope, "platform", [{ currency: "EUR", charged: 0, returned: 0 }], "2030-01-02T14:00:00Z"),
  });
  assert(missingPaymentCurrency.status === 409, "A zero payment confirmation without the USD transaction currency was accepted.");
  const paymentZero = await api(confirmationPath, {
    method: "POST", idempotencyKey: randomUUID(),
    body: confirmation("payment", paymentScope, "platform", [{ currency: "USD", charged: 0, returned: 0 }], "2030-01-02T14:00:00Z"),
  });
  assert(paymentZero.status === 200, `A zero payment confirmation with USD failed: ${JSON.stringify(paymentZero.data)}`);
  const missingRefundCurrency = await api(confirmationPath, {
    method: "POST", idempotencyKey: randomUUID(),
    body: confirmation("refund", refundScope, "platform", [{ currency: "EUR", charged: 0, returned: 0 }], "2030-01-02T14:00:00Z"),
  });
  assert(missingRefundCurrency.status === 409, "A zero refund confirmation without the USD transaction currency was accepted.");
  const refundZero = await api(confirmationPath, {
    method: "POST", idempotencyKey: randomUUID(),
    body: confirmation("refund", refundScope, "platform", [{ currency: "USD", charged: 0, returned: 0 }], "2030-01-02T14:00:00Z"),
  });
  assert(refundZero.status === 200, `A zero refund confirmation with USD failed: ${JSON.stringify(refundZero.data)}`);

  const secondRefundReference = `issue43-fee-refund-2-${randomUUID()}`;
  const secondRefundSource = `issue43-refund-report-2-${randomUUID()}`;
  const fullRefund = await api(`/v1/admin/orders/${fixture.orderId}/refund-reports`, {
    method: "POST", idempotencyKey: randomUUID(),
    body: refundReport(secondRefundReference, secondRefundSource, 1500, "2030-01-02T16:00:00Z"),
  });
  assert(fullRefund.status === 201 && fullRefund.data.data.refund.outcome === "completed",
    `The cumulative full refund report failed: ${JSON.stringify(fullRefund.data)}`);
  const secondRefundScope = secondRefundReference;
  const secondRefundFee = await api(paymentPath, {
    method: "POST", idempotencyKey: randomUUID(),
    body: feeReport("refund", secondRefundScope, "issue43-refund-source-2", 1, 0, "USD", "2030-01-02T17:00:00Z"),
  });
  assert(secondRefundFee.status === 201, `A full-refund fee report failed: ${JSON.stringify(secondRefundFee.data)}`);
  for (const category of ["processing", "platform"]) {
    const secondRefundConfirmation = await api(confirmationPath, {
      method: "POST", idempotencyKey: randomUUID(),
      body: confirmation("refund", secondRefundScope, category, [{ currency: "USD", charged: 0, returned: 0 }], "2030-01-02T18:00:00Z"),
    });
    assert(secondRefundConfirmation.status === 200, `The full-refund ${category} confirmation failed: ${JSON.stringify(secondRefundConfirmation.data)}`);
  }

  const totals = await api(totalsPath);
  const sales = new Map(totals.data?.data?.sales?.map((row) => [row.currency, row]) ?? []);
  assert(totals.status === 200 && sales.get("USD")?.processing_fees.reporting_status === "complete"
    && sales.get("USD")?.processing_fees.charged?.amount === 80
    && sales.get("USD")?.gross_paid_sales.amount === 2500
    && sales.get("USD")?.refunded_amount.amount === 2500
    && sales.get("USD")?.net_sales.amount === 0
    && sales.get("USD")?.platform_fees.reporting_status === "complete"
    && sales.get("JPY")?.processing_fees.reporting_status === "complete"
    && sales.get("JPY")?.processing_fees.charged?.amount === 10
    && sales.get("JPY")?.platform_fees.reporting_status === "complete",
  `Fee totals did not reflect current payment and completed refund confirmations: ${JSON.stringify(totals.data)}`);
  assert(totals.data.data.tickets.issued === 1 && totals.data.data.tickets.valid === 0 && totals.data.data.tickets.admitted === 1,
    `Issued, valid, and admitted Ticket totals did not reflect the cumulative full refund: ${JSON.stringify(totals.data)}`);

  const conflictingJpyFee = await api(paymentPath, {
    method: "POST", idempotencyKey: randomUUID(),
    body: feeReport("payment", paymentScope, "issue43-jpy-source", 1, 11, "JPY", "2030-01-02T19:00:00Z"),
  });
  assert(conflictingJpyFee.status === 409, `A contradictory later fee report was not rejected: ${JSON.stringify(conflictingJpyFee.data)}`);
  const conflictedTotals = await api(totalsPath);
  const conflictedSales = new Map(conflictedTotals.data?.data?.sales?.map((row) => [row.currency, row]) ?? []);
  assert(conflictedTotals.status === 200 && !conflictedSales.has("JPY")
    && conflictedSales.get("USD")?.processing_fees.reporting_status === "pending"
    && conflictedSales.get("USD")?.platform_fees.reporting_status === "complete"
    && conflictedSales.get("USD")?.platform_fees.charged?.amount === 0,
  `A conflicted payment scope retained fee totals or its fee-only currency: ${JSON.stringify(conflictedTotals.data)}`);
}

async function cleanup() {
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const table of [
      "fee_confirmation_totals", "fee_confirmations", "fee_report_issues", "fee_records",
      "admissions", "tickets", "refund_report_issues", "refund_reports", "refunds",
      "payment_report_issues", "payment_attempt_reports", "payment_attempt_closure_reports", "payment_attempts",
      "reservations", "orders", "public_quotes", "buyers", "ticket_offerings", "events",
      "notification_delivery_events", "notification_dispatch_attempts", "notification_jobs", "notification_claims",
      "api_idempotency_records", "site_request_windows",
      "site_api_keys", "site_payment_connection_assignments",
    ]) {
      await client.query(`delete from hpos.${table} where site_id = $1`, [fixture.siteId]);
    }
    await client.query("delete from hpos.payment_connections where id = $1", [fixture.connectionId]);
    await client.query("delete from hpos.sites where id = $1", [fixture.siteId]);
    await client.query("delete from hpos.organizations where id = $1", [fixture.organizationId]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  let error = null;
  try {
    assert(databaseUrl === "postgresql://postgres:postgres@127.0.0.1:54322/postgres", "Fee verification requires the dedicated local PostgreSQL database.");
    await assertPortIsFree();
    await createFixture();
    app = startApp();
    await waitForReady(app);
    await verify();
    console.log("Issue 43 fee-reporting verification passed: PostgreSQL row locking, transaction currencies for explicit zero confirmations, stale confirmation ordering, completed refund scopes, and overlapping Ticket totals.");
  } catch (caught) {
    error = caught;
    console.error(caught instanceof Error ? caught.message : "Fee verification failed.");
  } finally {
    try {
      await stopApp(app);
    } catch (caught) {
      error ??= caught;
      console.error(caught instanceof Error ? `Fee verification app cleanup failed: ${caught.message}` : "Fee verification app cleanup failed.");
    }
    try {
      await cleanup();
    } catch (caught) {
      error ??= caught;
      console.error(caught instanceof Error ? `Fee verification fixture cleanup failed: ${caught.message}` : "Fee verification fixture cleanup failed.");
    }
    try {
      await pool.end();
    } catch (caught) {
      error ??= caught;
      console.error(caught instanceof Error ? `Fee verification database shutdown failed: ${caught.message}` : "Fee verification database shutdown failed.");
    }
  }
  if (error) process.exitCode = 1;
}

main();
