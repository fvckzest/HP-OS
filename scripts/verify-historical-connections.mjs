import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.HPOS_VERIFY_HISTORICAL_PORT ?? 3284);
const origin = `http://127.0.0.1:${port}`;
const databaseUrl = process.env.HPOS_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const env = { ...process.env, NODE_ENV: "development", HPOS_DATABASE_URL: databaseUrl, NEXT_TELEMETRY_DISABLED: "1" };
const pool = new pg.Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 2_000 });
let server = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runOperator(args) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/operator.ts", ...args], {
    cwd: root, env, encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`The local operator command failed: ${(result.stdout ?? "") + (result.stderr ?? "")}`);
  return JSON.parse(result.stdout);
}

function startApp() {
  const child = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root, env, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => { output = `${output}${chunk}`.slice(-5_000); });
  }
  return { child, get output() { return output; } };
}

async function assertPortIsFree() {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (error) => {
      probe.close();
      const reason = error.code === "EADDRINUSE"
        ? `Port ${port} is already in use; set HPOS_VERIFY_HISTORICAL_PORT to a free local port.`
        : `The verification port ${port} could not be opened (${error.message}).`;
      reject(new Error(reason));
    });
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
}

async function waitForReady(server) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) throw new Error(`The verification app stopped early.\n${server.output}`);
    try {
      const response = await fetch(`${origin}/v1/admin/payment-configuration`, { signal: AbortSignal.timeout(2_000) });
      if (response.status === 401) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`The verification app did not become ready within 90 seconds.\n${server.output}`);
}

async function stopApp(server) {
  if (!server || server.child.exitCode !== null) return;
  await new Promise((resolve) => {
    server.child.once("exit", resolve);
    server.child.kill("SIGTERM");
    setTimeout(() => { if (server.child.exitCode === null) server.child.kill("SIGKILL"); }, 5_000).unref();
  });
}

async function api(site, pathname, { method = "GET", body, idempotencyKey = method === "GET" ? undefined : randomUUID() } = {}) {
  const headers = { Authorization: `Bearer ${site.apiKey}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const response = await fetch(`${origin}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try { data = await response.json(); } catch {}
  return { response, data };
}

function fixture() {
  const organization = runOperator(["organization", "create", "--name", `Issue 44 ${randomUUID()}`, "--pilot-fee-rate-basis-points", "1000"]);
  const site = runOperator(["site", "create", "--organization", organization.organization_id, "--name", "Issue 44 primary Site"]);
  const otherSite = runOperator(["site", "create", "--organization", organization.organization_id, "--name", "Issue 44 isolation Site"]);
  const original = runOperator(["payment-connection", "create", "--organization", organization.organization_id, "--provider", "square", "--environment", "test", "--account-reference", `ref:issue44-original-${randomUUID()}`, "--location-reference", "ref:issue44-original-location"]);
  const replacement = runOperator(["payment-connection", "create", "--organization", organization.organization_id, "--provider", "square", "--environment", "test", "--account-reference", `ref:issue44-replacement-${randomUUID()}`, "--location-reference", "ref:issue44-replacement-location"]);
  for (const connection of [original, replacement]) {
    runOperator(["payment-connection", "eligibility-record", "--connection", connection.connection_id, "--account-status", "eligible", "--platform-fee-status", "ineligible", "--evidence-reference", `ref:issue44-synthetic-${randomUUID()}`]);
  }
  runOperator(["site", "assign-connection", "--site", site.site_id, "--connection", original.connection_id]);
  runOperator(["site", "assign-connection", "--site", otherSite.site_id, "--connection", replacement.connection_id]);
  const key = runOperator(["site-key", "issue", "--site", site.site_id]);
  const otherKey = runOperator(["site-key", "issue", "--site", otherSite.site_id]);
  return {
    organizationId: organization.organization_id,
    site: { siteId: site.site_id, apiKey: key.site_api_key },
    otherSite: { siteId: otherSite.site_id, apiKey: otherKey.site_api_key },
    original: original.connection_id,
    replacement: replacement.connection_id,
  };
}

async function createEvent(site) {
  const actor = { type: "system", reference: "verify:issue-44" };
  const draft = await api(site, "/v1/admin/events", { method: "POST", body: { actor } });
  assert(draft.response.status === 201, "Could not create the Issue #44 Event draft.");
  const now = Date.now();
  const edit = await api(site, `/v1/admin/events/${draft.data.data.event_id}`, {
    method: "PATCH", body: {
      actor, expected_version: draft.data.data.version,
      title: "Issue 44 historical payment connection Event", description: "Synthetic recovery proof",
      venue: { name: "Synthetic venue" }, starts_at: new Date(now + 3_600_000).toISOString(),
      ends_at: new Date(now + 7_200_000).toISOString(), time_zone: "UTC", visibility: "public",
      ticket_offering: {
        price: { amount: 2500, currency: "USD" }, capacity: 4,
        sales_opens_at: new Date(now - 60_000).toISOString(), sales_closes_at: new Date(now + 7_000_000).toISOString(),
        tax_amount: 0, buyer_fees: [],
      },
    },
  });
  assert(edit.response.status === 200, `Could not configure the Issue #44 Event: ${JSON.stringify(edit.data)}`);
  const published = await api(site, `/v1/admin/events/${draft.data.data.event_id}/actions/publish`, {
    method: "POST", body: { actor, expected_version: edit.data.data.version },
  });
  assert(published.response.status === 200, "Could not publish the Issue #44 Event.");
  return published.data.data;
}

async function orderFor(site, eventId, email) {
  const quote = await api(site, `/v1/public/events/${eventId}/quotes`, { method: "POST", body: { quantity: 1 } });
  assert(quote.response.status === 201, `Could not quote the Issue #44 purchase: ${JSON.stringify(quote.data)}`);
  const order = await api(site, "/v1/public/orders", { method: "POST", body: { quote_id: quote.data.data.quote_id, buyer: { name: "Issue 44 Buyer", email } } });
  assert(order.response.status === 201, `Could not create the Issue #44 Order: ${JSON.stringify(order.data)}`);
  return order.data.data;
}

async function paidAttempt(site, order, connectionId, label) {
  const actor = { type: "system", reference: "verify:issue-44" };
  const created = await api(site, `/v1/admin/orders/${order.order_id}/payment-attempts`, { method: "POST", body: { actor } });
  assert(created.response.status === 201, `Could not create ${label} payment attempt: ${JSON.stringify(created.data)}`);
  const attempt = created.data.data;
  const checkoutReference = `issue44-checkout-${label}-${randomUUID()}`;
  const checkout = await api(site, `/v1/admin/payment-attempts/${attempt.attempt_id}/checkout-reference`, {
    method: "POST", body: { actor, connection_id: connectionId, provider_checkout_reference: checkoutReference, provider_can_take_payment: true },
  });
  assert(checkout.response.status === 200, `Could not register ${label} checkout reference: ${JSON.stringify(checkout.data)}`);
  const providerPaymentReference = `issue44-payment-${label}-${randomUUID()}`;
  const paid = await api(site, `/v1/admin/payment-attempts/${attempt.attempt_id}/payment-reports`, {
    method: "POST", body: {
      connection_id: connectionId, source_reference: `issue44-payment-event-${label}-${randomUUID()}`,
      provider_checkout_reference: checkoutReference, provider_payment_reference: providerPaymentReference,
      outcome: "paid", observed_at: new Date().toISOString(), payment_started_at: new Date().toISOString(),
      provider_can_take_payment: false, amount: 2500, currency: "USD",
    },
  });
  assert(paid.response.status === 201 && paid.data.data.attempt.connection.connection_id === connectionId, `Could not record ${label} payment: ${JSON.stringify(paid.data)}`);
  return { ...attempt, providerCheckoutReference: checkoutReference, providerPaymentReference };
}

async function main() {
  assert(databaseUrl === "postgresql://postgres:postgres@127.0.0.1:54322/postgres", "Historical connection verification requires the dedicated local test database.");
  await assertPortIsFree();
  server = startApp();
  try {
    await waitForReady(server);
    const fixtureData = fixture();
    const event = await createEvent(fixtureData.site);
    const actor = { type: "system", reference: "verify:issue-44" };
    const mapOriginal = await api(fixtureData.site, `/v1/admin/events/${event.event_id}/provider-mappings/${fixtureData.original}`, {
      method: "PUT", body: { actor, expected_version: event.version, resource_type: "square_item_variation", resource_reference: `issue44-item-original-${randomUUID()}`, verified_at: new Date().toISOString() },
    });
    assert(mapOriginal.response.status === 200, `Could not save the original provider mapping: ${JSON.stringify(mapOriginal.data)}`);
    const oldOrder = await orderFor(fixtureData.site, event.event_id, `issue44-old-${randomUUID()}@example.test`);
    const oldAttempt = await paidAttempt(fixtureData.site, oldOrder, fixtureData.original, "old");
    const oldMapping = (await api(fixtureData.site, `/v1/admin/events/${event.event_id}`)).data.data.ticket_offering.provider_mappings.find((mapping) => mapping.connection_id === fixtureData.original);
    assert(oldAttempt.connection?.connection_id === fixtureData.original, "The original attempt did not retain its connection snapshot.");

    runOperator(["site", "assign-connection", "--site", fixtureData.site.siteId, "--connection", fixtureData.replacement]);
    const historicalConnection = await api(fixtureData.site, `/v1/admin/payment-connections/${fixtureData.original}`);
    assert(historicalConnection.response.status === 200
      && historicalConnection.data.data.connection_id === fixtureData.original
      && historicalConnection.data.data.account_reference.includes("issue44-original"),
    "The Site could not read the assigned historical connection reference after replacement.");
    const replacementEvent = (await api(fixtureData.site, `/v1/admin/events/${event.event_id}`)).data.data;
    const mapReplacement = await api(fixtureData.site, `/v1/admin/events/${event.event_id}/provider-mappings/${fixtureData.replacement}`, {
      method: "PUT", body: { actor, expected_version: replacementEvent.version, resource_type: "square_item_variation", resource_reference: `issue44-item-replacement-${randomUUID()}`, verified_at: new Date().toISOString() },
    });
    assert(mapReplacement.response.status === 200, `Could not save the replacement provider mapping: ${JSON.stringify(mapReplacement.data)}`);
    const newOrder = await orderFor(fixtureData.site, event.event_id, `issue44-new-${randomUUID()}@example.test`);
    const newAttempt = await paidAttempt(fixtureData.site, newOrder, fixtureData.replacement, "new");
    assert(newAttempt.connection?.connection_id === fixtureData.replacement, "A new Order did not use the replacement connection.");

    const oldRead = await api(fixtureData.site, `/v1/admin/payment-attempts/${oldAttempt.attempt_id}`);
    assert(oldRead.response.status === 200 && oldRead.data.data.connection.connection_id === fixtureData.original
      && oldRead.data.data.provider_checkout_reference === oldAttempt.providerCheckoutReference
      && oldRead.data.data.provider_payment_reference === oldAttempt.providerPaymentReference,
    "The historical attempt did not retain its original connection and provider references.");
    const oldOrderRead = await api(fixtureData.site, `/v1/admin/orders/${oldOrder.order_id}`);
    assert(oldOrderRead.response.status === 200
      && oldOrderRead.data.data.payment_attempts[0]?.connection_id === fixtureData.original
      && oldOrderRead.data.data.payment_attempts[0]?.provider_mapping?.resource_reference === oldMapping.resource_reference,
    "The historical Order recovery view did not retain its original connection and mapping.");
    const oldOrderRow = await pool.query("select payment_connection_id, provider_mapping from hpos.orders where id = $1", [oldOrder.order_id]);
    assert(oldOrderRow.rows[0]?.payment_connection_id === fixtureData.original && oldOrderRow.rows[0]?.provider_mapping?.connection_id === fixtureData.original,
      "The historical Order did not retain its original connection and mapping snapshot.");
    assert(oldMapping && oldOrderRow.rows[0].provider_mapping.resource_reference === oldMapping.resource_reference,
      "The historical Order mapping did not match the mapping used before replacement.");
    const refund = await api(fixtureData.site, `/v1/admin/orders/${oldOrder.order_id}/refund-reports`, {
      method: "POST", body: {
        attempt_id: oldAttempt.attempt_id, connection_id: fixtureData.original,
        provider_payment_reference: oldAttempt.providerPaymentReference,
        provider_refund_reference: `issue44-refund-${randomUUID()}`, source_reference: `issue44-refund-event-${randomUUID()}`,
        outcome: "completed", amount: 2500, currency: "USD", observed_at: new Date().toISOString(),
      },
    });
    assert(refund.response.status === 201 && refund.data.data.applied === true, `Historical refund reporting failed: ${JSON.stringify(refund.data)}`);

    const foreignConnection = await api(fixtureData.otherSite, `/v1/admin/payment-connections/${fixtureData.original}`);
    const foreignAttempt = await api(fixtureData.otherSite, `/v1/admin/payment-attempts/${oldAttempt.attempt_id}`);
    assert(foreignConnection.response.status === 404 && foreignAttempt.response.status === 404, "A different Site could read historical connection or attempt data.");

    await stopApp(server);
    server = null;
    const restarted = startApp();
    try {
      await waitForReady(restarted);
      const afterRestart = await api(fixtureData.site, `/v1/admin/payment-attempts/${oldAttempt.attempt_id}`);
      assert(afterRestart.response.status === 200 && afterRestart.data.data.connection.connection_id === fixtureData.original,
        "The historical attempt was not visible with its original connection after an application restart.");
      const orderAfterRestart = await api(fixtureData.site, `/v1/admin/orders/${oldOrder.order_id}`);
      assert(orderAfterRestart.response.status === 200
        && orderAfterRestart.data.data.payment_attempts[0]?.provider_payment_reference === oldAttempt.providerPaymentReference,
      "The historical Order recovery view did not retain its provider reference after an application restart.");
    } finally {
      await stopApp(restarted);
    }
    console.log("Issue #44 local synthetic verification passed: replacement Orders used the new connection, historical mapping/payment/refund data stayed on the original connection, restart preserved recovery visibility, and cross-Site reads were rejected. Provider credentials, historical provider recovery, email, hosted, and cutover proof remain external.");
  } finally {
    await stopApp(server);
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Historical connection verification failed.");
  process.exitCode = 1;
});
