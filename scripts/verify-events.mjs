import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.HPOS_VERIFY_EVENTS_PORT ?? 3276);
const origin = "http://127.0.0.1:" + port;
const databaseUrl = process.env.HPOS_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const env = { ...process.env, NODE_ENV: "development", HPOS_DATABASE_URL: databaseUrl, NEXT_TELEMETRY_DISABLED: "1" };
const pool = new pg.Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 2_000 });
const organizationIds = [];
const siteIds = [];
let app;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertPortIsFree() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error("Event verification port " + port + " is already in use.")));
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
    stream.on("data", (chunk) => {
      output = (output + chunk).slice(-5_000);
      process.stdout.write(chunk);
    });
  }
  return { child, get output() { return output; } };
}

async function waitForReady(server) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) throw new Error("The event verification app stopped early.\n" + server.output);
    try {
      const response = await fetch(origin + "/v1/admin/payment-configuration", { signal: AbortSignal.timeout(2_000) });
      if (response.status === 401) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("The event verification app did not become ready within 90 seconds.\n" + server.output);
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
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  if (result.status !== 0) throw new Error("The local operator command failed: " + output);
  try { return JSON.parse(result.stdout); }
  catch { throw new Error("The local operator command did not return JSON."); }
}

function createSiteFixture(withPilotFee = true) {
  const feeOptions = withPilotFee ? ["--pilot-fee-rate-basis-points", "1000"] : [];
  const organization = runOperator(["organization", "create", "--name", "Issue 28 verification " + randomUUID(), ...feeOptions]);
  organizationIds.push(organization.organization_id);
  const site = runOperator(["site", "create", "--organization", organization.organization_id, "--name", "Issue 26 verification Site"]);
  siteIds.push(site.site_id);
  const connection = runOperator([
    "payment-connection", "create", "--organization", organization.organization_id,
    "--provider", "square", "--environment", "test",
    "--account-reference", "ref:verify-events-square-seller",
    "--location-reference", "ref:verify-events-square-location",
  ]);
  runOperator([
    "payment-connection", "eligibility-record", "--connection", connection.connection_id,
    "--account-status", "eligible", "--platform-fee-status", "ineligible",
    "--evidence-reference", "ref:verify-events-square-sandbox",
  ]);
  runOperator(["site", "assign-connection", "--site", site.site_id, "--connection", connection.connection_id]);
  const key = runOperator(["site-key", "issue", "--site", site.site_id]);
  return { organizationId: organization.organization_id, siteId: site.site_id, apiKey: key.site_api_key, connectionId: connection.connection_id };
}

function createSharedConnectionSiteFixture(source) {
  const site = runOperator(["site", "create", "--organization", source.organizationId, "--name", "Issue 80 shared-connection Site"]);
  siteIds.push(site.site_id);
  runOperator(["site", "assign-connection", "--site", site.site_id, "--connection", source.connectionId]);
  const key = runOperator(["site-key", "issue", "--site", site.site_id]);
  return { organizationId: source.organizationId, siteId: site.site_id, apiKey: key.site_api_key, connectionId: source.connectionId };
}

async function api(site, pathName, { method = "GET", idempotencyKey, body, fetchImpl = fetch } = {}) {
  const headers = { Authorization: "Bearer " + site.apiKey };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const response = await fetchImpl(origin + pathName, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try { data = await response.json(); } catch {}
  return { status: response.status, headers: response.headers, data };
}

function signedEventCursor(site, payload) {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const keyHash = createHash("sha256").update(site.apiKey, "utf8").digest();
  const signature = createHmac("sha256", keyHash).update(encodedPayload).digest("base64url");
  return `${encodedPayload}.${signature}`;
}

async function verifyDraftCreationAndReplay(site) {
  const key = randomUUID();
  const input = { actor: { type: "user", reference: "test:issue-26" } };
  const first = await api(site, "/v1/admin/events", { method: "POST", idempotencyKey: key, body: input });
  assert(first.status === 201, "Creating an incomplete draft should return 201; received " + first.status + ".");
  assert(first.data?.data?.event_id, "The draft response did not include its Event ID.");
  assert(first.data.data.publication_status === "draft", "A new Event was not an incomplete draft.");
  const retry = await api(site, "/v1/admin/events", { method: "POST", idempotencyKey: key, body: input });
  assert(retry.status === 201 && retry.data?.data?.event_id === first.data.data.event_id, "Retrying draft creation with the same key created a different result.");
  return first.data.data;
}

async function verifyPreconfiguredDraftCannotClearSales(site) {
  const created = await api(site, "/v1/admin/events", {
    method: "POST",
    idempotencyKey: randomUUID(),
    body: {
      actor: { type: "user", reference: "test:issue-26" },
      title: "Configured Draft",
      description: "A draft with a complete sales configuration.",
      venue: { name: "LMNL Space" },
      starts_at: "2033-04-21T19:00:00-07:00",
      ends_at: "2033-04-21T22:00:00-07:00",
      time_zone: "America/Los_Angeles",
      visibility: "public",
      ticket_offering: {
        price: { amount: 2500, currency: "USD" },
        capacity: 20,
        tax_amount: 0,
        buyer_fees: [],
        sales_opens_at: "2033-04-01T09:00:00-07:00",
        sales_closes_at: "2033-04-21T21:00:00-07:00",
      },
    },
  });
  assert(created.status === 201, "A fully configured draft could not be created.");
  const cleared = await api(site, "/v1/admin/events/" + created.data.data.event_id, {
    method: "PATCH",
    idempotencyKey: randomUUID(),
    body: {
      actor: { type: "user", reference: "test:issue-26" },
      expected_version: 1,
      ticket_offering: { sales_closes_at: null },
    },
  });
  assert(cleared.status === 409 && cleared.data.error.code === "sales_configuration_locked", "A complete sales configuration was cleared after draft creation.");
}

async function createPublishedEvent(site, { title, startsAt, endsAt, checkInOpensAt, timeZone = "America/Los_Angeles", ticketOffering }) {
  const created = await api(site, "/v1/admin/events", {
    method: "POST",
    idempotencyKey: randomUUID(),
    body: { actor: { type: "user", reference: "test:issue-26" } },
  });
  assert(created.status === 201, "A second Event draft could not be created.");
  const eventId = created.data.data.event_id;
  const saved = await api(site, "/v1/admin/events/" + eventId, {
    method: "PATCH",
    idempotencyKey: randomUUID(),
    body: {
      actor: { type: "user", reference: "test:issue-26" },
      expected_version: 1,
      title,
      description: "A local verification Event.",
      venue: { name: "LMNL Space" },
      starts_at: startsAt,
      ends_at: endsAt,
      ...(checkInOpensAt ? { check_in_opens_at: checkInOpensAt } : {}),
      time_zone: timeZone,
      visibility: "public",
      ...(ticketOffering ? {
        ticket_offering: {
          tax_amount: 0,
          buyer_fees: [],
          sales_opens_at: new Date(Date.now() - 60_000).toISOString(),
          sales_closes_at: endsAt,
          ...ticketOffering,
        },
      } : {}),
    },
  });
  assert(saved.status === 200, "A complete Event could not be saved: " + JSON.stringify(saved.data));
  const published = await api(site, "/v1/admin/events/" + eventId + "/actions/publish", {
    method: "POST",
    idempotencyKey: randomUUID(),
    body: { actor: { type: "user", reference: "test:issue-26" }, expected_version: saved.data.data.version },
  });
  assert(published.status === 200 && published.data.data.publication_status === "published", "A complete Event could not be published.");
  return published.data.data;
}

async function createPendingPaymentAttempt(site, event, reference) {
  const quote = await api(site, `/v1/public/events/${event.event_id}/quotes`, {
    method: "POST", idempotencyKey: randomUUID(), body: { quantity: 1 },
  });
  assert(quote.status === 201, `The Issue #80 ${reference} Order could not get a quote: ` + JSON.stringify(quote.data));
  const order = await api(site, "/v1/public/orders", {
    method: "POST", idempotencyKey: randomUUID(),
    body: { quote_id: quote.data.data.quote_id, buyer: { name: "Reference Test Buyer", email: `${randomUUID()}@example.test` } },
  });
  assert(order.status === 201, `The Issue #80 ${reference} Order could not be created: ` + JSON.stringify(order.data));
  const attempt = await api(site, `/v1/admin/orders/${order.data.data.order_id}/payment-attempts`, {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: { type: "system", reference: "test:issue-80" } },
  });
  assert(attempt.status === 201, `The Issue #80 ${reference} payment attempt could not be created: ` + JSON.stringify(attempt.data));
  return attempt.data.data;
}

async function createPaidOrderForEventChange(site, event, label) {
  const quote = await api(site, `/v1/public/events/${event.event_id}/quotes`, {
    method: "POST", idempotencyKey: randomUUID(), body: { quantity: 1 },
  });
  assert(quote.status === 201, `The Issue #40 ${label} buyer could not get a quote: ` + JSON.stringify(quote.data));
  const email = `${label}-${randomUUID()}@example.test`;
  const created = await api(site, "/v1/public/orders", {
    method: "POST", idempotencyKey: randomUUID(),
    body: { quote_id: quote.data.data.quote_id, buyer: { name: `Issue 40 ${label}`, email } },
  });
  assert(created.status === 201, `The Issue #40 ${label} Order could not be created: ` + JSON.stringify(created.data));
  const order = created.data.data;
  const attempt = await api(site, `/v1/admin/orders/${order.order_id}/payment-attempts`, {
    method: "POST", idempotencyKey: randomUUID(),
    body: { actor: { type: "system", reference: "test:issue-40" } },
  });
  assert(attempt.status === 201, `The Issue #40 ${label} payment attempt could not be created: ` + JSON.stringify(attempt.data));
  const checkoutReference = `square-issue40-${randomUUID()}`;
  const registered = await api(site, `/v1/admin/payment-attempts/${attempt.data.data.attempt_id}/checkout-reference`, {
    method: "POST", idempotencyKey: randomUUID(),
    body: {
      actor: { type: "system", reference: "test:issue-40" },
      connection_id: site.connectionId,
      provider_checkout_reference: checkoutReference,
      provider_can_take_payment: true,
    },
  });
  assert(registered.status === 200, `The Issue #40 ${label} checkout reference could not be saved: ` + JSON.stringify(registered.data));
  const observedAt = new Date().toISOString();
  const paid = await api(site, `/v1/admin/payment-attempts/${attempt.data.data.attempt_id}/payment-reports`, {
    method: "POST", idempotencyKey: randomUUID(),
    body: {
      connection_id: site.connectionId,
      source_reference: `square-event-change-${label}-${randomUUID()}`,
      provider_checkout_reference: checkoutReference,
      provider_payment_reference: `square-payment-event-change-${randomUUID()}`,
      outcome: "paid",
      observed_at: observedAt,
      payment_started_at: observedAt,
      provider_can_take_payment: false,
      amount: 2500,
      currency: "USD",
    },
  });
  assert(paid.status === 201 && paid.data.data.attempt.last_outcome === "paid",
    `The Issue #40 ${label} payment could not be confirmed through the Site report boundary: ` + JSON.stringify(paid.data));
  const buyerPage = await api(site, `/v1/public/orders/${order.order_token}`);
  assert(buyerPage.status === 200 && buyerPage.data.data.tickets.length === 1,
    `The Issue #40 ${label} paid Order did not receive its Ticket: ` + JSON.stringify(buyerPage.data));
  return {
    orderId: order.order_id,
    orderReference: order.order_reference,
    orderToken: order.order_token,
    ticketToken: buyerPage.data.data.tickets[0].ticket_token,
    email,
  };
}

async function verifyPublicSingleTicketCheckout(site) {
  const now = Date.now();
  const event = await createPublishedEvent(site, {
    title: "Single Ticket Checkout Verification",
    startsAt: new Date(now + 60 * 60_000).toISOString(),
    endsAt: new Date(now + 2 * 60 * 60_000).toISOString(),
    timeZone: "UTC",
    ticketOffering: {
      price: { amount: 2505, currency: "USD" },
      capacity: 1,
      tax_amount: 200,
      buyer_fees: [{ code: "service", label: "Service fee", amount: 100, currency: "USD" }],
    },
  });
  const quoteBody = { quantity: 1 };
  const quoteKey = randomUUID();
  const quotePath = "/v1/public/events/" + event.event_id + "/quotes";
  const simultaneousQuotes = await Promise.all([0, 1].map(() => api(site, quotePath, { method: "POST", idempotencyKey: quoteKey, body: quoteBody })));
  const quote = simultaneousQuotes[0];
  assert(simultaneousQuotes.every((response) => response.status === 201 && response.data.data?.quote_id === quote.data.data?.quote_id),
    "Concurrent same-key quote requests did not share one completed result.");
  assert(quote.status === 201, "A complete single-Ticket quote failed: " + JSON.stringify(quote.data));
  assert(quote.data.data.subtotal.amount === 2505 && quote.data.data.tax_total.amount === 200
    && quote.data.data.buyer_fees[0]?.amount === 100
    && quote.data.data.total.amount === 2805, "The quote did not include the configured ticket amount, buyer fee, and tax.");
  assert(quote.data.data.platform_fee.amount === 251 && quote.data.data.platform_fee_basis_points === 1000,
    "The Organization's 10% pre-tax platform fee was not rounded to the nearest minor unit.");
  const emptyFeesEvent = await createPublishedEvent(site, {
    title: "Explicitly Empty Buyer Fees Verification",
    startsAt: new Date(now + 60 * 60_000).toISOString(),
    endsAt: new Date(now + 2 * 60 * 60_000).toISOString(),
    timeZone: "UTC",
    ticketOffering: { price: { amount: 1000, currency: "USD" }, capacity: 1, buyer_fees: [] },
  });
  const emptyFeesQuote = await api(site, "/v1/public/events/" + emptyFeesEvent.event_id + "/quotes", {
    method: "POST", idempotencyKey: randomUUID(), body: quoteBody,
  });
  assert(emptyFeesQuote.status === 201 && Array.isArray(emptyFeesQuote.data.data.buyer_fees)
    && emptyFeesQuote.data.data.buyer_fees.length === 0,
    "An explicitly empty buyer-fee configuration did not produce an empty quote fee list.");
  const quoteRetry = await api(site, quotePath, { method: "POST", idempotencyKey: quoteKey, body: quoteBody });
  assert(quoteRetry.status === 201 && quoteRetry.data.data.quote_id === quote.data.data.quote_id,
    "Retrying quote creation with the same key created a second quote.");
  const quoteCount = await pool.query("select count(*)::integer as count from hpos.public_quotes where event_id = $1", [event.event_id]);
  assert(quoteCount.rows[0].count === 1, "A quote request reserved capacity or a same-key retry created a second quote.");

  const orderBody = { quote_id: quote.data.data.quote_id, buyer: { name: "Ada Lovelace", email: "Ada@example.test" } };
  const orderKey = randomUUID();
  const simultaneousOrders = await Promise.all([0, 1].map(() => api(site, "/v1/public/orders", { method: "POST", idempotencyKey: orderKey, body: orderBody })));
  const order = simultaneousOrders[0];
  assert(simultaneousOrders.every((response) => response.status === 201 && response.data.data?.order_id === order.data.data?.order_id),
    "Concurrent same-key Order requests did not share one completed result.");
  assert(order.status === 201, "Creating an unpaid Order and Reservation failed: " + JSON.stringify(order.data));
  assert(order.data.data.payment_status === "unpaid" && order.data.data.issuance_status === "not_started"
    && order.data.data.tickets.length === 0 && order.data.data.reservation.status === "held",
    "The new Order was not unpaid with one held Reservation and zero Tickets.");
  assert(order.data.data.pricing.total.amount === 2805 && order.data.data.pricing.buyer_fees[0]?.amount === 100
    && order.data.data.pricing.platform_fee.amount === 251,
    "The Order did not retain its accepted pricing and Organization platform-fee snapshot.");
  const orderRetry = await api(site, "/v1/public/orders", { method: "POST", idempotencyKey: orderKey, body: orderBody });
  assert(orderRetry.status === 201 && orderRetry.data.data.order_id === order.data.data.order_id
    && orderRetry.data.data.order_token === order.data.data.order_token,
    "Retrying Order creation after a lost response did not return the original Order and access token.");
  const reusedQuote = await api(site, "/v1/public/orders", { method: "POST", idempotencyKey: randomUUID(), body: orderBody });
  assert(reusedQuote.status === 409 && reusedQuote.data.error.code === "quote_already_used",
    "A quote created a second Order when submitted with a different idempotency key.");
  const conflictingRetry = await api(site, "/v1/public/orders", {
    method: "POST", idempotencyKey: orderKey,
    body: { ...orderBody, buyer: { name: "Different Buyer", email: "other@example.test" } },
  });
  assert(conflictingRetry.status === 409 && conflictingRetry.data.error.code === "idempotency_conflict",
    "Reusing an Order idempotency key with different buyer details was accepted.");
  const ordersBeforeExpiredReplay = await pool.query("select count(*)::integer as count from hpos.orders where quote_id = $1", [quote.data.data.quote_id]);
  await pool.query(
    `update hpos.api_idempotency_records
     set completed_at = clock_timestamp() - interval '8 days'
     where site_id = $1 and idempotency_key = $2`,
    [site.siteId, orderKey],
  );
  const expiredOrderReplay = await api(site, "/v1/public/orders", { method: "POST", idempotencyKey: orderKey, body: orderBody });
  assert(expiredOrderReplay.status === 409 && expiredOrderReplay.data.error.code === "idempotency_expired",
    "An expired Order replay key was allowed to return a stale result or execute again.");
  const ordersAfterExpiredReplay = await pool.query("select count(*)::integer as count from hpos.orders where quote_id = $1", [quote.data.data.quote_id]);
  assert(ordersAfterExpiredReplay.rows[0].count === ordersBeforeExpiredReplay.rows[0].count,
    "An expired Order replay key created a duplicate Order.");
  const repeatBuyerEvent = await createPublishedEvent(site, {
    title: "Buyer Identity Snapshot Verification",
    startsAt: new Date(now + 60 * 60_000).toISOString(),
    endsAt: new Date(now + 2 * 60 * 60_000).toISOString(),
    timeZone: "UTC",
    ticketOffering: { price: { amount: 1000, currency: "USD" }, capacity: 2 },
  });
  const repeatBuyerQuote = await api(site, "/v1/public/events/" + repeatBuyerEvent.event_id + "/quotes", {
    method: "POST", idempotencyKey: randomUUID(), body: quoteBody,
  });
  const repeatBuyerOrder = await api(site, "/v1/public/orders", {
    method: "POST", idempotencyKey: randomUUID(),
    body: { quote_id: repeatBuyerQuote.data.data.quote_id, buyer: { name: "Updated Buyer Name", email: "ADA@example.test" } },
  });
  assert(repeatBuyerOrder.status === 201, "A repeat Buyer checkout on the same Site failed.");
  const sameSiteBuyer = await pool.query(
    `select original.buyer_id as original_buyer_id, repeat.buyer_id as repeat_buyer_id,
            original.buyer_name, original.delivery_email, original.checkout_identity,
            buyer.name as current_buyer_name
     from hpos.orders original
     join hpos.orders repeat on repeat.id = $2
     join hpos.buyers buyer on buyer.id = original.buyer_id
     where original.id = $1`,
    [order.data.data.order_id, repeatBuyerOrder.data.data.order_id],
  );
  assert(sameSiteBuyer.rows[0]?.original_buyer_id === sameSiteBuyer.rows[0]?.repeat_buyer_id
    && sameSiteBuyer.rows[0]?.buyer_name === "Ada Lovelace"
    && sameSiteBuyer.rows[0]?.delivery_email === "Ada@example.test"
    && sameSiteBuyer.rows[0]?.checkout_identity?.name === "Ada Lovelace"
    && sameSiteBuyer.rows[0]?.current_buyer_name === "Updated Buyer Name",
    "A repeat purchase changed the original Order identity or failed to reuse its Site Buyer.");
  const isolatedBuyerSite = createSiteFixture();
  const isolatedBuyerEvent = await createPublishedEvent(isolatedBuyerSite, {
    title: "Site Buyer Isolation Verification",
    startsAt: new Date(now + 60 * 60_000).toISOString(),
    endsAt: new Date(now + 2 * 60 * 60_000).toISOString(),
    timeZone: "UTC",
    ticketOffering: { price: { amount: 1000, currency: "USD" }, capacity: 2 },
  });
  const isolatedBuyerQuote = await api(isolatedBuyerSite, "/v1/public/events/" + isolatedBuyerEvent.event_id + "/quotes", {
    method: "POST", idempotencyKey: randomUUID(), body: quoteBody,
  });
  const isolatedBuyerOrder = await api(isolatedBuyerSite, "/v1/public/orders", {
    method: "POST", idempotencyKey: randomUUID(),
    body: { quote_id: isolatedBuyerQuote.data.data.quote_id, buyer: { name: "Ada Lovelace", email: "ada@example.test" } },
  });
  assert(isolatedBuyerOrder.status === 201, "A cross-Site same-email fixture could not create its own Order.");
  const crossSiteBuyer = await pool.query(
    `select first_order.buyer_id as first_buyer_id, second_order.buyer_id as second_buyer_id
     from hpos.orders first_order cross join hpos.orders second_order
     where first_order.id = $1 and second_order.id = $2`,
    [order.data.data.order_id, isolatedBuyerOrder.data.data.order_id],
  );
  assert(crossSiteBuyer.rows[0]?.first_buyer_id !== crossSiteBuyer.rows[0]?.second_buyer_id,
    "Two Sites shared a Buyer record because their email addresses matched.");
  const hold = await pool.query(
    `select offering.reserved_quantity, reservation.status, reservation.quantity
     from hpos.ticket_offerings offering
     join hpos.reservations reservation on reservation.offering_id = offering.id
     where offering.event_id = $1`,
    [event.event_id],
  );
  assert(hold.rows[0]?.reserved_quantity === "1" && hold.rows[0]?.status === "held" && hold.rows[0]?.quantity === 1,
    "The Order did not reserve exactly one unit of capacity.");

  const changed = await createPublishedEvent(site, {
    title: "Changed Quote Verification",
    startsAt: new Date(now + 60 * 60_000).toISOString(),
    endsAt: new Date(now + 2 * 60 * 60_000).toISOString(),
    timeZone: "UTC",
    ticketOffering: { price: { amount: 1000, currency: "USD" }, capacity: 2 },
  });
  const changedQuote = await api(site, "/v1/public/events/" + changed.event_id + "/quotes", {
    method: "POST", idempotencyKey: randomUUID(), body: quoteBody,
  });
  assert(changedQuote.status === 201, "The price-change fixture could not obtain its initial quote.");
  const updatedPrice = await api(site, "/v1/admin/events/" + changed.event_id, {
    method: "PATCH", idempotencyKey: randomUUID(),
    body: {
      actor: { type: "user", reference: "test:issue-28" },
      expected_version: changed.version,
      ticket_offering: { price: { amount: 1200, currency: "USD" } },
    },
  });
  assert(updatedPrice.status === 200, "The Event price could not be changed after the quote was issued.");
  const changedOrder = await api(site, "/v1/public/orders", {
    method: "POST", idempotencyKey: randomUUID(),
    body: { quote_id: changedQuote.data.data.quote_id, buyer: { name: "Ada Lovelace", email: "ada2@example.test" } },
  });
  assert(changedOrder.status === 409 && changedOrder.data.error.code === "quote_changed",
    "Order creation accepted a quote after the Event price changed.");

  const expiredQuote = await api(site, "/v1/public/events/" + changed.event_id + "/quotes", {
    method: "POST", idempotencyKey: randomUUID(), body: quoteBody,
  });
  await pool.query(
    `update hpos.public_quotes
     set created_at = clock_timestamp() - interval '11 minutes',
         expires_at = clock_timestamp() - interval '1 second'
     where id = $1`,
    [expiredQuote.data.data.quote_id],
  );
  const expiredOrder = await api(site, "/v1/public/orders", {
    method: "POST", idempotencyKey: randomUUID(),
    body: { quote_id: expiredQuote.data.data.quote_id, buyer: { name: "Ada Lovelace", email: "ada3@example.test" } },
  });
  assert(expiredOrder.status === 409 && expiredOrder.data.error.code === "quote_expired",
    "An expired quote created an Order.");

  const expiredKey = randomUUID();
  const expiredKeyFingerprint = createHash("sha256")
    .update(`POST\n${quotePath}\n${JSON.stringify(quoteBody)}`, "utf8").digest("hex");
  await pool.query(
    `insert into hpos.api_idempotency_records (
       site_id, idempotency_key, request_fingerprint, response_status, response_data, completed_at
     ) values ($1, $2, $3, 201, '{}'::jsonb, clock_timestamp() - interval '8 days')`,
    [site.siteId, expiredKey, expiredKeyFingerprint],
  );
  const quotesBeforeExpiredRetry = await pool.query("select count(*)::integer as count from hpos.public_quotes where event_id = $1", [event.event_id]);
  const expiredReplay = await api(site, quotePath, { method: "POST", idempotencyKey: expiredKey, body: quoteBody });
  assert(expiredReplay.status === 409 && expiredReplay.data.error.code === "idempotency_expired",
    "An expired replay key was allowed to execute quote creation again.");
  const quotesAfterExpiredRetry = await pool.query("select count(*)::integer as count from hpos.public_quotes where event_id = $1", [event.event_id]);
  assert(quotesAfterExpiredRetry.rows[0].count === quotesBeforeExpiredRetry.rows[0].count,
    "An expired replay key created another quote.");

  const capacityEvent = await createPublishedEvent(site, {
    title: "Concurrent Last Ticket Verification",
    startsAt: new Date(now + 60 * 60_000).toISOString(),
    endsAt: new Date(now + 2 * 60 * 60_000).toISOString(),
    timeZone: "UTC",
    ticketOffering: { price: { amount: 1000, currency: "USD" }, capacity: 1 },
  });
  const quoteResponses = await Promise.all([0, 1].map(() => api(site, "/v1/public/events/" + capacityEvent.event_id + "/quotes", {
    method: "POST", idempotencyKey: randomUUID(), body: quoteBody,
  })));
  assert(quoteResponses.every((response) => response.status === 201), "A non-reserving quote held or hid the final Ticket.");
  const concurrentOrders = await Promise.all(quoteResponses.map((response, index) => api(site, "/v1/public/orders", {
    method: "POST", idempotencyKey: randomUUID(),
    body: { quote_id: response.data.data.quote_id, buyer: { name: "Buyer " + index, email: `buyer${index}@example.test` } },
  })));
  assert(concurrentOrders.filter((response) => response.status === 201).length === 1
    && concurrentOrders.filter((response) => response.status === 409 && response.data.error.code === "sold_out").length === 1,
    "Concurrent Orders both acquired the last Ticket or both failed.");
  const capacityState = await pool.query("select reserved_quantity from hpos.ticket_offerings where event_id = $1", [capacityEvent.event_id]);
  assert(capacityState.rows[0]?.reserved_quantity === "1", "Concurrent Order attempts oversold the final Ticket.");

  const incompletePricingEvent = await createPublishedEvent(site, {
    title: "Incomplete Pricing Verification",
    startsAt: new Date(now + 60 * 60_000).toISOString(),
    endsAt: new Date(now + 2 * 60 * 60_000).toISOString(),
    timeZone: "UTC",
    ticketOffering: { price: { amount: 1000, currency: "USD" }, capacity: 2, tax_amount: null },
  });
  assert(incompletePricingEvent.sales_status === "not_configured", "Unknown tax did not keep Event sales unconfigured.");
  const incompleteQuote = await api(site, "/v1/public/events/" + incompletePricingEvent.event_id + "/quotes", {
    method: "POST", idempotencyKey: randomUUID(), body: quoteBody,
  });
  assert(incompleteQuote.status === 409 && incompleteQuote.data.error.code === "sales_not_configured",
    "Checkout accepted an Event whose tax inputs were unknown.");

  const unconfiguredOrganizationSite = createSiteFixture(false);
  const unconfiguredFeeEvent = await createPublishedEvent(unconfiguredOrganizationSite, {
    title: "Unconfigured Organization Fee Verification",
    startsAt: new Date(now + 60 * 60_000).toISOString(),
    endsAt: new Date(now + 2 * 60 * 60_000).toISOString(),
    timeZone: "UTC",
    ticketOffering: { price: { amount: 1000, currency: "USD" }, capacity: 2 },
  });
  const unavailableFeeQuote = await api(unconfiguredOrganizationSite, "/v1/public/events/" + unconfiguredFeeEvent.event_id + "/quotes", {
    method: "POST", idempotencyKey: randomUUID(), body: quoteBody,
  });
  assert(unavailableFeeQuote.status === 503 && unavailableFeeQuote.data.error.code === "payment_configuration_unavailable",
    "Checkout treated an unconfigured Organization platform fee as zero.");

  await pool.query(
    `update hpos.reservations set expires_at = clock_timestamp() - interval '1 second' where order_id = $1`,
    [order.data.data.order_id],
  );
  await pool.query(
    `update hpos.orders set checkout_expires_at = clock_timestamp() - interval '1 second' where id = $1`,
    [order.data.data.order_id],
  );
  const processing = await api(site, "/api/cron/process");
  const reservationAfterProcessing = await pool.query(
    `select reservation.status, reservation.awaiting_provider_verification,
            reservation.expires_at <= clock_timestamp() as expired,
            order_row.checkout_status, order_row.payment_status, offering.reserved_quantity
     from hpos.reservations reservation
     join hpos.orders order_row on order_row.id = reservation.order_id and order_row.site_id = reservation.site_id
     join hpos.ticket_offerings offering on offering.id = reservation.offering_id and offering.site_id = reservation.site_id
     where reservation.order_id = $1`,
    [order.data.data.order_id],
  );
  assert(processing.status === 200 && processing.data.data.released_reservations >= 1,
    "The bounded processing cycle did not release an expired prepayment Reservation: "
      + JSON.stringify({ response: processing.data, reservation: reservationAfterProcessing.rows[0] }));
  const expiredHold = await pool.query(
    `select offering.reserved_quantity, reservation.status, order_row.checkout_status
     from hpos.ticket_offerings offering
     join hpos.reservations reservation on reservation.offering_id = offering.id
     join hpos.orders order_row on order_row.id = reservation.order_id
     where order_row.id = $1`,
    [order.data.data.order_id],
  );
  assert(expiredHold.rows[0]?.reserved_quantity === "0" && expiredHold.rows[0]?.status === "released"
    && expiredHold.rows[0]?.checkout_status === "expired",
    "Expired prepayment cleanup did not release capacity and expire the Order atomically.");
}

async function verifyPublicPaymentAttemptLifecycle(site) {
  const event = await createPublishedEvent(site, {
    title: "Issue 29 Payment Attempt Verification",
    startsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    endsAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
    timeZone: "UTC",
    ticketOffering: { price: { amount: 2500, currency: "USD" }, capacity: 2, tax_amount: 0, buyer_fees: [] },
  });
  const quote = await api(site, `/v1/public/events/${event.event_id}/quotes`, {
    method: "POST", idempotencyKey: randomUUID(), body: { quantity: 1 },
  });
  assert(quote.status === 201, "The payment-attempt fixture could not obtain an Order quote.");
  const order = await api(site, "/v1/public/orders", {
    method: "POST", idempotencyKey: randomUUID(),
    body: { quote_id: quote.data.data.quote_id, buyer: { name: "Attempt Buyer", email: "attempt@example.test" } },
  });
  assert(order.status === 201, "The payment-attempt fixture could not create an Order.");

  const actor = { type: "system", reference: "test:issue-29" };
  const firstKey = randomUUID();
  const firstAttempt = await api(site, `/v1/admin/orders/${order.data.data.order_id}/payment-attempts`, {
    method: "POST", idempotencyKey: firstKey, body: { actor },
  });
  assert(firstAttempt.status === 201, "A verified test connection could not create a payment attempt: " + JSON.stringify(firstAttempt.data));
  assert(firstAttempt.data.data.total.amount === 2500 && firstAttempt.data.data.platform_fee.amount === 250,
    "The payment attempt did not freeze the accepted Order total and platform fee.");
  assert(firstAttempt.data.data.connection.connection_id === site.connectionId
    && firstAttempt.data.data.connection.account_eligibility_status === "eligible"
    && firstAttempt.data.data.connection.platform_fee_eligibility_status === "ineligible",
    "The payment attempt did not freeze its verified Sandbox connection state.");
  const replay = await api(site, `/v1/admin/orders/${order.data.data.order_id}/payment-attempts`, {
    method: "POST", idempotencyKey: firstKey, body: { actor },
  });
  assert(replay.status === 201 && replay.data.data.attempt_id === firstAttempt.data.data.attempt_id,
    "Replaying an attempt-creation key created another provider attempt.");

  const attemptId = firstAttempt.data.data.attempt_id;
  const unresolved = await api(site, `/v1/admin/payment-attempts/${attemptId}`);
  assert(unresolved.status === 200 && unresolved.data.data.status === "creating"
    && unresolved.headers.get("cache-control") === "no-store",
    "The Site could not safely inspect its unresolved payment attempt.");
  const outsider = createSiteFixture();
  const hidden = await api(outsider, `/v1/admin/payment-attempts/${attemptId}`);
  assert(hidden.status === 404, "Another Site could read a payment attempt.");

  const concurrent = await api(site, `/v1/admin/orders/${order.data.data.order_id}/payment-attempts`, {
    method: "POST", idempotencyKey: randomUUID(), body: { actor },
  });
  assert(concurrent.status === 409 && concurrent.data.error.code === "payment_attempt_in_progress",
    "HP-OS created concurrent payment-capable attempts for one Order.");

  const referenceBody = {
    actor,
    connection_id: site.connectionId,
    provider_checkout_reference: "square-test-link-29-1",
    provider_can_take_payment: true,
  };
  const registered = await api(site, `/v1/admin/payment-attempts/${attemptId}/checkout-reference`, {
    method: "POST", idempotencyKey: randomUUID(), body: referenceBody,
  });
  assert(registered.status === 200 && registered.data.data.status === "open"
    && registered.data.data.provider_can_take_payment === true,
    "HP-OS did not register the provider checkout before opening the attempt.");

  const closureBody = {
    actor,
    connection_id: site.connectionId,
    source_reference: "ref:verify-square-checkout-closed-29-1",
    provider_checkout_reference: "square-test-link-29-1",
    observed_at: new Date().toISOString(),
    provider_checkout_closed: true,
    payment_outcome: "canceled",
  };
  const closure = await api(site, `/v1/admin/payment-attempts/${attemptId}/closure-reports`, {
    method: "POST", idempotencyKey: randomUUID(), body: closureBody,
  });
  assert(closure.status === 200 && closure.data.data.status === "closed",
    "A verified provider closure did not close the original attempt.");
  const closureReplay = await api(site, `/v1/admin/payment-attempts/${attemptId}/closure-reports`, {
    method: "POST", idempotencyKey: randomUUID(), body: closureBody,
  });
  assert(closureReplay.status === 200 && closureReplay.data.data.status === "closed",
    "A repeated verified provider observation created another closure effect.");
  const conflictingClosure = await api(site, `/v1/admin/payment-attempts/${attemptId}/closure-reports`, {
    method: "POST", idempotencyKey: randomUUID(),
    body: { ...closureBody, payment_outcome: "failed" },
  });
  assert(conflictingClosure.status === 409 && conflictingClosure.data.error.code === "payment_report_conflict",
    "A provider closure source reference was accepted with contradictory evidence.");
  const capacityAfterClosure = await pool.query(
    `select offering.reserved_quantity, reservation.status, reservation.awaiting_provider_verification,
            order_row.checkout_status
     from hpos.ticket_offerings offering
     join hpos.reservations reservation on reservation.offering_id = offering.id
     join hpos.orders order_row on order_row.id = reservation.order_id
     where order_row.id = $1`,
    [order.data.data.order_id],
  );
  assert(capacityAfterClosure.rows[0]?.reserved_quantity === "1"
    && capacityAfterClosure.rows[0]?.status === "held"
    && capacityAfterClosure.rows[0]?.awaiting_provider_verification === false
    && capacityAfterClosure.rows[0]?.checkout_status === "active",
    "A closed provider checkout released capacity before its original Order deadline.");

  const replacement = await api(site, `/v1/admin/orders/${order.data.data.order_id}/payment-attempts`, {
    method: "POST", idempotencyKey: randomUUID(), body: { actor },
  });
  assert(replacement.status === 201 && replacement.data.data.attempt_id !== attemptId,
    "A confirmed closed checkout did not permit one replacement attempt within the Order window.");
  const uncertainFailure = await api(site, `/v1/admin/payment-attempts/${replacement.data.data.attempt_id}/setup-failure`, {
    method: "POST", idempotencyKey: randomUUID(), body: {
      actor, reason: "provider_unavailable", provider_checkout_closed: false, payment_outcome: "not_started",
    },
  });
  assert(uncertainFailure.status === 422, "An unverified provider closure was accepted as a safe setup failure.");

  const safeFailure = await api(site, `/v1/admin/payment-attempts/${replacement.data.data.attempt_id}/setup-failure`, {
    method: "POST", idempotencyKey: randomUUID(), body: {
      actor, reason: "provider_unavailable", provider_checkout_closed: true, payment_outcome: "not_started",
    },
  });
  assert(safeFailure.status === 200 && safeFailure.data.data.status === "closed",
    "A confirmed provider setup failure did not close its attempt.");
  const released = await pool.query(
    `select offering.reserved_quantity, reservation.status, reservation.awaiting_provider_verification,
            order_row.checkout_status
     from hpos.ticket_offerings offering
     join hpos.reservations reservation on reservation.offering_id = offering.id
     join hpos.orders order_row on order_row.id = reservation.order_id
     where order_row.id = $1`,
    [order.data.data.order_id],
  );
  assert(released.rows[0]?.reserved_quantity === "0" && released.rows[0]?.status === "released"
    && released.rows[0]?.awaiting_provider_verification === false
    && released.rows[0]?.checkout_status === "ended",
    "HP-OS did not release capacity after a confirmed pre-provider setup failure.");

  const lateEvent = await createPublishedEvent(site, {
    title: "Issue 29 Late Provider Setup Verification",
    startsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    endsAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
    timeZone: "UTC",
    ticketOffering: { price: { amount: 2500, currency: "USD" }, capacity: 1, tax_amount: 0, buyer_fees: [] },
  });
  const lateQuote = await api(site, `/v1/public/events/${lateEvent.event_id}/quotes`, {
    method: "POST", idempotencyKey: randomUUID(), body: { quantity: 1 },
  });
  const lateOrder = await api(site, "/v1/public/orders", {
    method: "POST", idempotencyKey: randomUUID(),
    body: { quote_id: lateQuote.data.data.quote_id, buyer: { name: "Late Buyer", email: "late@example.test" } },
  });
  const lateAttempt = await api(site, `/v1/admin/orders/${lateOrder.data.data.order_id}/payment-attempts`, {
    method: "POST", idempotencyKey: randomUUID(), body: { actor },
  });
  await pool.query(
    `update hpos.orders set checkout_expires_at = clock_timestamp() - interval '1 second' where id = $1`,
    [lateOrder.data.data.order_id],
  );
  const lateDeadlineResult = await pool.query(
    `select checkout_expires_at from hpos.orders where id = $1`,
    [lateOrder.data.data.order_id],
  );
  const lateDeadline = lateDeadlineResult.rows[0]?.checkout_expires_at?.toISOString();
  const lateFrontier = await api(site, `/v1/admin/payment-attempts?requires_verification=true&event_id=${lateEvent.event_id}`);
  assert(lateFrontier.status === 200 && lateFrontier.data.data.some((row) => row.attempt_id === lateAttempt.data.data.attempt_id
    && row.requires_verification === true && row.connection.connection_id === site.connectionId
    && row.checkout_expires_at === lateDeadline),
    "The Site verification frontier did not expose the overdue interrupted attempt with its deadline and frozen connection.");
  const lateProcessing = await api(site, "/api/cron/process");
  assert(lateProcessing.status === 200 && lateProcessing.data.data.verification_required_attempts >= 1,
    "The bounded processor did not promote the overdue interrupted payment attempt for verification.");
  const lateRegistration = await api(site, `/v1/admin/payment-attempts/${lateAttempt.data.data.attempt_id}/checkout-reference`, {
    method: "POST", idempotencyKey: randomUUID(), body: {
      ...referenceBody,
      provider_checkout_reference: "square-test-link-29-late",
    },
  });
  assert(lateRegistration.status === 409 && lateRegistration.data.error.code === "checkout_expired",
    "HP-OS registered provider checkout after its accepted Order deadline.");
  const lateClosure = await api(site, `/v1/admin/payment-attempts/${lateAttempt.data.data.attempt_id}/setup-failure`, {
    method: "POST", idempotencyKey: randomUUID(), body: {
      actor,
      reason: "provider_unavailable",
      provider_checkout_closed: true,
      payment_outcome: "not_started",
    },
  });
  assert(lateClosure.status === 200 && lateClosure.data.data.status === "closed",
    "The Site could not report verified setup failure for a late interrupted checkout.");
  const lateCapacity = await pool.query(
    `select offering.reserved_quantity, reservation.status, order_row.checkout_status
     from hpos.ticket_offerings offering
     join hpos.reservations reservation on reservation.offering_id = offering.id
     join hpos.orders order_row on order_row.id = reservation.order_id
     where order_row.id = $1`,
    [lateOrder.data.data.order_id],
  );
  assert(lateCapacity.rows[0]?.reserved_quantity === "0" && lateCapacity.rows[0]?.status === "released"
    && lateCapacity.rows[0]?.checkout_status === "expired",
    "A late provider checkout kept capacity after the Site verified it was closed.");

  const batchEvent = await createPublishedEvent(site, {
    title: "Issue 34 Bounded Verification Promotion",
    startsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    endsAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
    timeZone: "UTC",
    ticketOffering: { price: { amount: 2500, currency: "USD" }, capacity: 51, tax_amount: 0, buyer_fees: [] },
  });
  const batchAttempts = [];
  for (let index = 0; index < 51; index += 1) {
    batchAttempts.push(await createPendingPaymentAttempt(site, batchEvent, `verification-batch-${index}`));
  }
  await pool.query(
    `update hpos.orders order_row
     set checkout_expires_at = clock_timestamp() - interval '1 second'
     where order_row.id in (
       select attempt.order_id from hpos.payment_attempts attempt where attempt.id = any($1::uuid[])
     )`,
    [batchAttempts.map((attempt) => attempt.attempt_id)],
  );
  // Keep this fixture at the front of the bounded queue. The local database
  // can contain older, intentionally retained verification rows, and the
  // scheduler is correctly global across Sites.
  await pool.query(
    `update hpos.payment_attempts
     set created_at = to_timestamp(0), updated_at = clock_timestamp()
     where id = any($1::uuid[])`,
    [batchAttempts.map((attempt) => attempt.attempt_id)],
  );
  const firstVerificationBatch = await api(site, "/api/cron/process");
  assert(firstVerificationBatch.status === 200
    && firstVerificationBatch.data.data.verification_required_attempts === 50
    && firstVerificationBatch.data.data.has_more === true,
    "The bounded scheduler did not promote exactly 50 overdue payment attempts or expose the remaining verification work.");
  const secondVerificationBatch = await api(site, "/api/cron/process");
  assert(secondVerificationBatch.status === 200
    && secondVerificationBatch.data.data.verification_required_attempts === 1,
    "The next bounded scheduler run did not promote the one remaining overdue payment attempt.");
  const promotedBatch = await pool.query(
    `select count(*)::integer as count
     from hpos.payment_attempts
     where id = any($1::uuid[]) and status = 'requires_verification'`,
    [batchAttempts.map((attempt) => attempt.attempt_id)],
  );
  assert(promotedBatch.rows[0]?.count === 51,
    "Bounded verification promotion did not leave every overdue attempt in the durable verification frontier.");
}

async function verifySharedCheckoutReferenceIsolation(site) {
  const other = createSharedConnectionSiteFixture(site);
  const now = Date.now();
  const eventOptions = (title) => ({
    title,
    startsAt: new Date(now + 60 * 60_000).toISOString(),
    endsAt: new Date(now + 2 * 60 * 60_000).toISOString(),
    timeZone: "UTC",
    ticketOffering: { price: { amount: 2500, currency: "USD" }, capacity: 2, tax_amount: 0, buyer_fees: [] },
  });
  const firstEvent = await createPublishedEvent(site, eventOptions("Issue 80 Shared Checkout Reference Site One"));
  const secondEvent = await createPublishedEvent(other, eventOptions("Issue 80 Shared Checkout Reference Site Two"));
  const [firstAttempt, secondAttempt] = await Promise.all([
    createPendingPaymentAttempt(site, firstEvent, "first-site"),
    createPendingPaymentAttempt(other, secondEvent, "second-site"),
  ]);
  const providerCheckoutReference = `shared-connection-checkout-${randomUUID()}`;
  const referenceBody = {
    actor: { type: "system", reference: "test:issue-80" },
    connection_id: site.connectionId,
    provider_checkout_reference: providerCheckoutReference,
    provider_can_take_payment: true,
  };
  const registrations = await Promise.all([
    api(site, `/v1/admin/payment-attempts/${firstAttempt.attempt_id}/checkout-reference`, {
      method: "POST", idempotencyKey: randomUUID(), body: referenceBody,
    }),
    api(other, `/v1/admin/payment-attempts/${secondAttempt.attempt_id}/checkout-reference`, {
      method: "POST", idempotencyKey: randomUUID(), body: referenceBody,
    }),
  ]);
  const winnerIndex = registrations.findIndex((result) => result.status === 200);
  const loserIndex = winnerIndex === 0 ? 1 : 0;
  assert(winnerIndex !== -1 && registrations.filter((result) => result.status === 200).length === 1,
    "Concurrent Sites both registered the same checkout reference, or neither registration succeeded.");
  assert(registrations[loserIndex].status === 404 && registrations[loserIndex].data?.error?.code === "not_found",
    "A concurrent cross-Site checkout-reference conflict did not return 404 not_found.");

  const sites = [site, other];
  const attempts = [firstAttempt, secondAttempt];
  const events = [firstEvent, secondEvent];
  const winningSite = sites[winnerIndex];
  const losingSite = sites[loserIndex];
  const winningAttempt = attempts[winnerIndex];
  const losingAttempt = attempts[loserIndex];
  const foreignFailure = JSON.stringify(registrations[loserIndex].data);
  assert(!foreignFailure.includes(winningSite.siteId) && !foreignFailure.includes(winningAttempt.attempt_id),
    "The cross-Site checkout-reference failure exposed foreign Site or attempt identity.");

  const sequentialConflict = await api(losingSite, `/v1/admin/payment-attempts/${losingAttempt.attempt_id}/checkout-reference`, {
    method: "POST", idempotencyKey: randomUUID(), body: referenceBody,
  });
  assert(sequentialConflict.status === 404 && sequentialConflict.data?.error?.code === "not_found",
    "A sequential cross-Site checkout-reference conflict did not return 404 not_found.");

  const storedReference = await pool.query(
    `select count(*)::integer as count
     from hpos.payment_attempts
     where connection_id = $1 and provider_checkout_reference = $2`,
    [site.connectionId, providerCheckoutReference],
  );
  assert(storedReference.rows[0]?.count === 1, "The shared-connection checkout-reference constraint did not preserve one owner.");

  const sameSiteAttempt = await createPendingPaymentAttempt(winningSite, events[winnerIndex], "same-site");
  const sameSiteConflict = await api(winningSite, `/v1/admin/payment-attempts/${sameSiteAttempt.attempt_id}/checkout-reference`, {
    method: "POST", idempotencyKey: randomUUID(), body: referenceBody,
  });
  assert(sameSiteConflict.status === 409 && sameSiteConflict.data?.error?.code === "provider_reference_conflict",
    "Same-Site checkout-reference reuse did not retain 409 provider_reference_conflict.");
}

async function verifyPaymentReportsAndTicketIssuance(site) {
  const now = Date.now();
  const event = await createPublishedEvent(site, {
    title: "Issue 30 Verified Payment and Ticket Recovery",
    startsAt: new Date(now - 60 * 60_000).toISOString(),
    endsAt: new Date(now + 60 * 60_000).toISOString(),
    checkInOpensAt: new Date(now - 30 * 60_000).toISOString(),
    timeZone: "UTC",
    ticketOffering: { price: { amount: 2500, currency: "USD" }, capacity: 3, tax_amount: 0, buyer_fees: [] },
  });
  const quote = await api(site, `/v1/public/events/${event.event_id}/quotes`, {
    method: "POST", idempotencyKey: randomUUID(), body: { quantity: 1 },
  });
  assert(quote.status === 201, "The Issue #30 fixture could not create a quote.");
  const order = await api(site, "/v1/public/orders", {
    method: "POST", idempotencyKey: randomUUID(),
    body: { quote_id: quote.data.data.quote_id, buyer: { name: "Ticket Buyer", email: "ticket@example.test" } },
  });
  assert(order.status === 201, "The Issue #30 fixture could not create an Order.");
  const attempt = await api(site, `/v1/admin/orders/${order.data.data.order_id}/payment-attempts`, {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: { type: "system", reference: "test:issue-30" } },
  });
  assert(attempt.status === 201, "The Issue #30 fixture could not create a payment attempt.");
  const attemptId = attempt.data.data.attempt_id;
  const checkoutReference = "square-test-link-30-" + randomUUID();
  const registered = await api(site, `/v1/admin/payment-attempts/${attemptId}/checkout-reference`, {
    method: "POST", idempotencyKey: randomUUID(), body: {
      actor: { type: "system", reference: "test:issue-30" },
      connection_id: site.connectionId,
      provider_checkout_reference: checkoutReference,
      provider_can_take_payment: true,
    },
  });
  assert(registered.status === 200, "The Issue #30 fixture could not register the provider checkout: " + JSON.stringify(registered.data));

  const orderId = order.data.data.order_id;
  async function forcePaidIssuanceFailure(targetOrderId, targetAttemptId, targetCheckoutReference, label) {
    const functionName = `hpos.test_issue36_reject_job_${randomUUID().replaceAll("-", "")}`;
    const triggerName = `issue36_reject_job_${randomUUID().replaceAll("-", "")}`;
    await pool.query(`create function ${functionName}() returns trigger language plpgsql as $$
      begin
        if new.kind = 'tickets_ready' and new.order_id = '${targetOrderId}'::uuid then
          raise exception 'injected interruption after confirmed payment';
        end if;
        return new;
      end;
    $$`);
    await pool.query(`create trigger ${triggerName} before insert on hpos.notification_jobs
      for each row execute function ${functionName}()`);
    const paidObservedAt = new Date().toISOString();
    const paidBody = {
      connection_id: site.connectionId,
      source_reference: `square-event-${label}-${randomUUID()}`,
      provider_checkout_reference: targetCheckoutReference,
      provider_payment_reference: `square-payment-${label}-${randomUUID()}`,
      outcome: "paid",
      observed_at: paidObservedAt,
      payment_started_at: paidObservedAt,
      provider_can_take_payment: false,
      amount: 2500,
      currency: "USD",
    };
    let paid;
    try {
      paid = await api(site, `/v1/admin/payment-attempts/${targetAttemptId}/payment-reports`, {
        method: "POST", idempotencyKey: randomUUID(), body: paidBody,
      });
    } finally {
      await pool.query(`drop trigger ${triggerName} on hpos.notification_jobs`);
      await pool.query(`drop function ${functionName}()`);
    }
    assert(paid.status === 201 && paid.data.data.attempt.last_outcome === "paid",
      "HP-OS did not persist the provider-confirmed payment before attempting issuance.");
    const interrupted = await pool.query(
      `select payment_status, issuance_status, version,
              (select count(*)::integer from hpos.tickets where order_id = orders.id) as tickets
       from hpos.orders where id = $1`,
      [targetOrderId],
    );
    const row = interrupted.rows[0];
    assert(row?.payment_status === "paid" && row?.issuance_status === "failed" && row?.tickets === 0,
      "An interrupted issuance erased payment or left a partial Ticket set.");
    const admin = await api(site, `/v1/admin/orders/${targetOrderId}`);
    assert(admin.status === 200 && admin.data.data.payment_status === "paid"
      && admin.data.data.issuance_status === "failed" && admin.data.data.version === row.version
      && admin.data.data.tickets.length === 0
      && admin.data.data.issues.some((issue) => issue.code === "ticket_issuance_failed" && issue.status === "open"),
      "The failed paid Order did not retain paid/awaiting state and open durable Ticket-issuance evidence.");
    return { version: row.version, admin, paidBody, paidObservedAt };
  }

  const automaticFailure = await forcePaidIssuanceFailure(orderId, attemptId, checkoutReference, "automatic");
  const paidBody = automaticFailure.paidBody;
  const paidObservedAt = automaticFailure.paidObservedAt;
  const interruptedVersion = automaticFailure.version;
  assert(!JSON.stringify(automaticFailure.admin.data).includes(order.data.data.order_token),
    "The staff Order recovery view exposed the buyer's raw Order token.");

  const recoveredRuns = await Promise.all([api(site, "/api/cron/process"), api(site, "/api/cron/process")]);
  assert(recoveredRuns.every((run) => run.status === 200)
    && recoveredRuns.some((run) => run.data.data.ticket_issuance?.issued >= 1),
    "Overlapping bounded scheduler runs did not recover the paid Order directly from failed issuance.");
  const automaticState = await pool.query(
    `select payment_status, issuance_status,
            (select count(*)::integer from hpos.tickets where order_id = orders.id) as tickets
     from hpos.orders where id = $1`,
    [orderId],
  );
  assert(automaticState.rows[0]?.payment_status === "paid" && automaticState.rows[0]?.issuance_status === "issued"
    && automaticState.rows[0]?.tickets === 1,
    "Automatic recovery did not leave the original paid Order issued with exactly one Ticket.");
  const automaticJobCount = await pool.query(
    `select count(*)::integer as count from hpos.notification_jobs where order_id = $1 and kind = 'tickets_ready'`,
    [orderId],
  );
  assert(automaticJobCount.rows[0]?.count === 1, "Automatic recovery created a duplicate initial Ticket email job.");
  const automaticAdmin = await api(site, `/v1/admin/orders/${orderId}`);
  assert(automaticAdmin.status === 200 && automaticAdmin.data.data.tickets.length === 1
    && automaticAdmin.data.data.issues.some((issue) => issue.code === "ticket_issuance_failed" && issue.status === "resolved")
    && automaticAdmin.data.data.recovery_actions.length === 0,
    "Automatic recovery did not retain resolved failure evidence without a staff action.");
  const automaticOrderRead = await api(site, `/v1/public/orders/${order.data.data.order_token}`);
  assert(automaticOrderRead.status === 200 && automaticOrderRead.data.data.payment_status === "paid"
    && automaticOrderRead.data.data.issuance_status === "issued" && automaticOrderRead.data.data.tickets.length === 1,
    "The automatic recovery Order did not expose its eventual Ticket access.");

  const guardedQuote = await api(site, `/v1/public/events/${event.event_id}/quotes`, {
    method: "POST", idempotencyKey: randomUUID(), body: { quantity: 1 },
  });
  assert(guardedQuote.status === 201, "The guarded Issue #36 fixture could not create a quote.");
  const guardedOrder = await api(site, "/v1/public/orders", {
    method: "POST", idempotencyKey: randomUUID(),
    body: { quote_id: guardedQuote.data.data.quote_id, buyer: { name: "Guarded Ticket Buyer", email: "guarded-ticket@example.test" } },
  });
  assert(guardedOrder.status === 201, "The guarded Issue #36 fixture could not create an Order.");
  const guardedAttempt = await api(site, `/v1/admin/orders/${guardedOrder.data.data.order_id}/payment-attempts`, {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: { type: "system", reference: "test:issue-36" } },
  });
  assert(guardedAttempt.status === 201, "The guarded Issue #36 fixture could not create a payment attempt.");
  const guardedCheckoutReference = "square-test-link-36-" + randomUUID();
  const guardedRegistered = await api(site, `/v1/admin/payment-attempts/${guardedAttempt.data.data.attempt_id}/checkout-reference`, {
    method: "POST", idempotencyKey: randomUUID(), body: {
      actor: { type: "system", reference: "test:issue-36" },
      connection_id: site.connectionId,
      provider_checkout_reference: guardedCheckoutReference,
      provider_can_take_payment: true,
    },
  });
  assert(guardedRegistered.status === 200, "The guarded Issue #36 fixture could not register the provider checkout: " + JSON.stringify(guardedRegistered.data));
  const guardedOrderId = guardedOrder.data.data.order_id;
  const guardedFailure = await forcePaidIssuanceFailure(
    guardedOrderId, guardedAttempt.data.data.attempt_id, guardedCheckoutReference, "guarded",
  );
  const guardedVersion = guardedFailure.version;
  await pool.query(`update hpos.orders set refund_status = 'full' where site_id = $1 and id = $2`, [site.siteId, guardedOrderId]);
  const refundedRetry = await api(site, `/v1/admin/orders/${guardedOrderId}/actions/retry_ticket_issuance`, {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: { type: "user", reference: "test:issue-36" }, expected_version: guardedVersion },
  });
  assert(refundedRetry.status === 409 && refundedRetry.data?.error?.code === "invalid_state",
    "A fully refunded paid Order accepted a Ticket-issuance retry.");
  await pool.query(`update hpos.orders set refund_status = 'none' where site_id = $1 and id = $2`, [site.siteId, guardedOrderId]);

  await pool.query(`update hpos.events set is_canceled = true, canceled_at = clock_timestamp() where site_id = $1 and id = (select event_id from hpos.orders where id = $2)`, [site.siteId, guardedOrderId]);
  const canceledRetry = await api(site, `/v1/admin/orders/${guardedOrderId}/actions/retry_ticket_issuance`, {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: { type: "user", reference: "test:issue-36" }, expected_version: guardedVersion },
  });
  assert(canceledRetry.status === 409 && canceledRetry.data?.error?.code === "invalid_state",
    "A canceled Event accepted a Ticket-issuance retry.");
  await pool.query(`update hpos.events set is_canceled = false, canceled_at = null where site_id = $1 and id = (select event_id from hpos.orders where id = $2)`, [site.siteId, guardedOrderId]);

  const guardedRetry = await api(site, `/v1/admin/orders/${guardedOrderId}/actions/retry_ticket_issuance`, {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: { type: "user", reference: "test:issue-36" }, expected_version: guardedVersion },
  });
  assert(guardedRetry.status === 202 && guardedRetry.data.data.issuance_status === "pending"
    && guardedRetry.data.data.version === guardedVersion + 1,
    "The guarded retry did not queue the failed paid Order with a new version.");
  const staleRetry = await api(site, `/v1/admin/orders/${guardedOrderId}/actions/retry_ticket_issuance`, {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: { type: "user", reference: "test:issue-36" }, expected_version: guardedVersion },
  });
  assert(staleRetry.status === 409 && staleRetry.data?.error?.code === "version_conflict",
    "A stale guarded retry did not return version_conflict.");

  const guardedRuns = await Promise.all([api(site, "/api/cron/process"), api(site, "/api/cron/process")]);
  assert(guardedRuns.every((run) => run.status === 200)
    && guardedRuns.some((run) => run.data.data.ticket_issuance?.issued >= 1),
    "Overlapping bounded scheduler runs did not finish the guarded Ticket-issuance retry.");
  const guardedState = await pool.query(
    `select payment_status, issuance_status,
            (select count(*)::integer from hpos.tickets where order_id = orders.id) as tickets
     from hpos.orders where id = $1`,
    [guardedOrderId],
  );
  assert(guardedState.rows[0]?.payment_status === "paid" && guardedState.rows[0]?.issuance_status === "issued"
    && guardedState.rows[0]?.tickets === 1,
    "Guarded recovery did not leave the paid Order issued with exactly one Ticket.");
  const guardedJobCount = await pool.query(
    `select count(*)::integer as count from hpos.notification_jobs where order_id = $1 and kind = 'tickets_ready'`,
    [guardedOrderId],
  );
  assert(guardedJobCount.rows[0]?.count === 1, "Guarded recovery created a duplicate initial Ticket email job.");
  const guardedAdmin = await api(site, `/v1/admin/orders/${guardedOrderId}`);
  assert(guardedAdmin.status === 200 && guardedAdmin.data.data.tickets.length === 1
    && guardedAdmin.data.data.issues.some((issue) => issue.code === "ticket_issuance_failed" && issue.status === "resolved")
    && guardedAdmin.data.data.recovery_actions.length === 1,
    "Guarded recovery did not retain resolved failure evidence and one action audit record.");
  const guardedOrderRead = await api(site, `/v1/public/orders/${guardedOrder.data.data.order_token}`);
  assert(guardedOrderRead.status === 200 && guardedOrderRead.data.data.payment_status === "paid"
    && guardedOrderRead.data.data.issuance_status === "issued" && guardedOrderRead.data.data.tickets.length === 1,
    "The guarded recovery Order did not expose its eventual Ticket access.");

  const orderRead = await api(site, `/v1/public/orders/${order.data.data.order_token}`);
  assert(orderRead.status === 200 && orderRead.headers.get("cache-control") === "no-store"
    && orderRead.data.data.payment_status === "paid" && orderRead.data.data.issuance_status === "issued"
    && orderRead.data.data.delivery_status === "pending" && orderRead.data.data.tickets.length === 1,
    "The Order read did not expose separate payment, issuance, delivery, and Ticket state.");
  const adminPaymentStatus = await api(site, `/v1/admin/orders/${orderId}/payment-status`);
  assert(adminPaymentStatus.status === 200 && adminPaymentStatus.headers.get("cache-control") === "no-store"
    && adminPaymentStatus.data.data.payment_status === "paid"
    && adminPaymentStatus.data.data.issuance_status === "issued"
    && adminPaymentStatus.data.data.ticket_count === 1
    && !Object.hasOwn(adminPaymentStatus.data.data, "order_token"),
    "The Site could not retrieve a minimal, token-free Order payment status for the checkout-return page.");
  const ticket = orderRead.data.data.tickets[0];
  assert(ticket.ticket_token !== order.data.data.order_token && ticket.ticket_token !== ticket.qr_payload
    && ticket.qr_payload.length >= 32,
    "Order, Ticket page, and admission QR access did not use distinct tokens.");
  assert(!JSON.stringify(orderRead.data).includes(order.data.data.order_token),
    "The buyer Order response exposed the raw Order token again.");
  const ticketRead = await api(site, `/v1/public/tickets/${ticket.ticket_token}`);
  assert(ticketRead.status === 200 && ticketRead.headers.get("cache-control") === "no-store"
    && ticketRead.data.data.ticket_id === ticket.ticket_id && ticketRead.data.data.qr_payload === ticket.qr_payload,
    "The Ticket page did not return its stable Ticket and QR access data.");

  const lookupByReference = await api(site, `/v1/admin/events/${event.event_id}/ticket-lookup`, {
    method: "POST", body: { order_reference: order.data.data.order_reference },
  });
  assert(lookupByReference.status === 200 && lookupByReference.headers.get("cache-control") === "no-store"
    && lookupByReference.data.data.length === 1
    && lookupByReference.data.data[0].tickets[0].ticket_id === ticket.ticket_id
    && lookupByReference.data.data[0].tickets[0].admission_status === "unused"
    && lookupByReference.data.data[0].tickets[0].can_admit === true,
    "Manual lookup did not return the matching unused Ticket with current eligibility.");
  const lookupByEmail = await api(site, `/v1/admin/events/${event.event_id}/ticket-lookup`, {
    method: "POST", body: { email: " TICKET@example.test " },
  });
  assert(lookupByEmail.status === 200 && lookupByEmail.data.data.length === 1
    && lookupByEmail.data.data[0].order_reference === order.data.data.order_reference,
    "Manual lookup did not find the Order by its current delivery email.");
  assert(!/ticket_token|order_token|qr_payload|qr_token/i.test(JSON.stringify(lookupByReference.data)),
    "Manual lookup exposed a buyer access token or admission QR token.");
  const ambiguousLookup = await api(site, `/v1/admin/events/${event.event_id}/ticket-lookup`, {
    method: "POST", body: { order_reference: order.data.data.order_reference, email: "ticket@example.test" },
  });
  assert(ambiguousLookup.status === 422, "Manual lookup accepted both lookup methods in one request.");

  const invalidToken = await api(site, `/v1/admin/events/${event.event_id}/admissions`, {
    method: "POST", idempotencyKey: randomUUID(),
    body: { actor: { type: "user", reference: "test:issue-32" }, qr_token: "A".repeat(32) },
  });
  assert(invalidToken.status === 404 && invalidToken.data.error.code === "not_found",
    "An unknown QR token was not rejected as Site-safe not-found.");

  const otherEvent = await createPublishedEvent(site, {
    title: "Issue 32 Wrong Event Scope",
    startsAt: new Date(now - 60 * 60_000).toISOString(),
    endsAt: new Date(now + 60 * 60_000).toISOString(),
    checkInOpensAt: new Date(now - 30 * 60_000).toISOString(),
    timeZone: "UTC",
  });
  const wrongEvent = await api(site, `/v1/admin/events/${otherEvent.event_id}/admissions`, {
    method: "POST", idempotencyKey: randomUUID(),
    body: { actor: { type: "user", reference: "test:issue-32" }, qr_token: ticket.qr_payload },
  });
  assert(wrongEvent.status === 409 && wrongEvent.data.error.code === "ticket_event_mismatch",
    "A Ticket from another Event on the same Site was not rejected as an Event mismatch.");

  await pool.query("update hpos.events set check_in_opens_at = clock_timestamp() + interval '10 minutes', check_in_opens_offset_minutes = 0 where id = $1", [event.event_id]);
  const tooEarlyKey = randomUUID();
  const tooEarlyBody = { actor: { type: "user", reference: "test:issue-32" }, qr_token: ticket.qr_payload };
  const tooEarly = await api(site, `/v1/admin/events/${event.event_id}/admissions`, {
    method: "POST", idempotencyKey: tooEarlyKey, body: tooEarlyBody,
  });
  const tooEarlyReplay = await api(site, `/v1/admin/events/${event.event_id}/admissions`, {
    method: "POST", idempotencyKey: tooEarlyKey, body: tooEarlyBody,
  });
  assert(tooEarly.status === 409 && tooEarly.data.error.code === "check_in_not_open"
    && tooEarlyReplay.status === 409 && tooEarlyReplay.data.error.code === "check_in_not_open",
    "An early Admission was not rejected or replayed consistently.");

  await pool.query("update hpos.events set check_in_opens_at = clock_timestamp() - interval '30 minutes', check_in_opens_offset_minutes = 0, is_canceled = true, canceled_at = clock_timestamp() where id = $1", [event.event_id]);
  await pool.query("update hpos.orders set refund_status = 'full' where id = $1", [orderId]);
  const canceled = await api(site, `/v1/admin/events/${event.event_id}/admissions`, {
    method: "POST", idempotencyKey: randomUUID(), body: tooEarlyBody,
  });
  await pool.query("update hpos.events set is_canceled = false, canceled_at = null where id = $1", [event.event_id]);
  const refunded = await api(site, `/v1/admin/events/${event.event_id}/admissions`, {
    method: "POST", idempotencyKey: randomUUID(), body: tooEarlyBody,
  });
  await pool.query("update hpos.orders set refund_status = 'none' where id = $1", [orderId]);
  assert(canceled.status === 409 && canceled.data.error.code === "event_canceled"
    && refunded.status === 409 && refunded.data.error.code === "ticket_refunded",
    "Canceled and fully refunded Tickets did not follow Admission rejection precedence.");

  await pool.query("update hpos.events set ends_at = clock_timestamp() - interval '1 second', ends_at_offset_minutes = 0 where id = $1", [event.event_id]);
  const tooLate = await api(site, `/v1/admin/events/${event.event_id}/admissions`, {
    method: "POST", idempotencyKey: randomUUID(), body: tooEarlyBody,
  });
  await pool.query("update hpos.events set ends_at = clock_timestamp() + interval '1 hour', ends_at_offset_minutes = 0 where id = $1", [event.event_id]);
  assert(tooLate.status === 409 && tooLate.data.error.code === "check_in_closed",
    "A late Admission was not rejected.");

  const admissionKeys = [randomUUID(), randomUUID()];
  const concurrent = await Promise.all(admissionKeys.map((idempotencyKey) => api(site, `/v1/admin/events/${event.event_id}/admissions`, {
    method: "POST", idempotencyKey, body: tooEarlyBody,
  })));
  const createdAdmission = concurrent.find((response) => response.status === 201);
  const rejectedAdmission = concurrent.find((response) => response.status === 409);
  assert(createdAdmission?.data?.data?.admission_id && rejectedAdmission?.data?.error?.code === "already_admitted",
    "Two concurrent device submissions did not produce one Admission and one already-admitted result.");
  const winnerKey = admissionKeys[concurrent.indexOf(createdAdmission)];
  let clientLostAdmissionResponse = false;
  try {
    await api(site, `/v1/admin/events/${event.event_id}/admissions`, {
      method: "POST", idempotencyKey: winnerKey, body: tooEarlyBody,
      fetchImpl: async (...args) => {
        const response = await fetch(...args);
        await response.arrayBuffer();
        throw new TypeError("simulated client connection loss after the server committed the Admission");
      },
    });
  } catch (error) {
    clientLostAdmissionResponse = error instanceof TypeError;
  }
  assert(clientLostAdmissionResponse,
    "The verifier did not simulate a client losing the Admission response after the server committed it.");
  const ambiguousTimeoutReplay = await api(site, `/v1/admin/events/${event.event_id}/admissions`, {
    method: "POST", idempotencyKey: winnerKey, body: tooEarlyBody,
  });
  assert(ambiguousTimeoutReplay.status === 201
    && ambiguousTimeoutReplay.data.data.admission_id === createdAdmission.data.data.admission_id
    && ambiguousTimeoutReplay.data.data.admitted_at === createdAdmission.data.data.admitted_at,
    "Retrying the Admission after the simulated lost response did not replay the original entry.");
  const newQrScan = await api(site, `/v1/admin/events/${event.event_id}/admissions`, {
    method: "POST", idempotencyKey: randomUUID(), body: tooEarlyBody,
  });
  const manualAdmission = await api(site, `/v1/admin/events/${event.event_id}/admissions`, {
    method: "POST", idempotencyKey: randomUUID(),
    body: { actor: { type: "user", reference: "test:issue-32" }, ticket_id: ticket.ticket_id },
  });
  assert(newQrScan.status === 409 && newQrScan.data.error.code === "already_admitted"
    && manualAdmission.status === 409 && manualAdmission.data.error.code === "already_admitted",
    "A new QR scan or manual confirmation did not report the one-time Admission as already used.");
  const admittedTicketRead = await api(site, `/v1/public/tickets/${ticket.ticket_token}`);
  assert(admittedTicketRead.status === 200 && admittedTicketRead.data.data.admission_status === "admitted"
    && admittedTicketRead.data.data.can_admit === false
    && admittedTicketRead.data.data.admission_blockers.includes("already_admitted"),
    "The Ticket page did not report the recorded Admission status.");
  const afterAdmissionLookup = await api(site, `/v1/admin/events/${event.event_id}/ticket-lookup`, {
    method: "POST", body: { order_reference: order.data.data.order_reference },
  });
  assert(afterAdmissionLookup.data.data[0].tickets[0].admission_status === "admitted"
    && afterAdmissionLookup.data.data[0].tickets[0].can_admit === false,
    "Manual lookup did not report the Ticket's recorded Admission.");

  const otherSite = createSiteFixture();
  const crossSiteTicket = await api(otherSite, `/v1/public/tickets/${ticket.ticket_token}`);
  assert(crossSiteTicket.status === 404, "Another Site could read this Ticket.");
  const crossSiteAdmission = await api(otherSite, `/v1/admin/events/${event.event_id}/admissions`, {
    method: "POST", idempotencyKey: randomUUID(),
    body: { actor: { type: "user", reference: "test:issue-32" }, qr_token: ticket.qr_payload },
  });
  assert(crossSiteAdmission.status === 404 && crossSiteAdmission.data.error.code === "not_found",
    "Another Site could resolve or admit a Ticket using its QR token.");

  const replay = await api(site, `/v1/admin/payment-attempts/${attemptId}/payment-reports`, {
    method: "POST", idempotencyKey: randomUUID(), body: paidBody,
  });
  assert(replay.status === 200 && replay.data.data.applied === true,
    "Replaying the same provider source created another payment or issuance effect.");
  const staleReport = await api(site, `/v1/admin/payment-attempts/${attemptId}/payment-reports`, {
    method: "POST", idempotencyKey: randomUUID(), body: {
      ...paidBody,
      source_reference: "square-stale-event-30-" + randomUUID(),
      provider_payment_reference: null,
      outcome: "failed",
      observed_at: new Date(Date.parse(paidObservedAt) - 60_000).toISOString(),
      payment_started_at: null,
      amount: undefined,
      currency: undefined,
    },
  });
  assert(staleReport.status === 201 && staleReport.data.data.applied === false,
    "An older failure report regressed an already confirmed paid Order.");

  const conflictBody = { ...paidBody, source_reference: "square-mismatch-30-" + randomUUID(), amount: 2400 };
  const conflict = await api(site, `/v1/admin/payment-attempts/${attemptId}/payment-reports`, {
    method: "POST", idempotencyKey: randomUUID(), body: conflictBody,
  });
  assert(conflict.status === 409 && conflict.data.error.code === "payment_report_conflict",
    "A provider amount mismatch was not retained as a payment conflict.");
  const retainedConflict = await pool.query(
    `select count(*)::integer as reports,
            (select count(*)::integer from hpos.payment_report_issues
             where order_id = $1 and code = 'payment_report_conflict') as issues
     from hpos.payment_attempt_reports where attempt_id = $2 and conflict_code = 'payment_report_conflict'`,
    [orderId, attemptId],
  );
  assert(retainedConflict.rows[0]?.reports === 1 && retainedConflict.rows[0]?.issues === 1,
    "The contradictory payment evidence and linked investigation issue were not retained.");
  const afterConflict = await pool.query(
    `select payment_status, issuance_status,
            (select count(*)::integer from hpos.tickets where order_id = orders.id) as tickets
     from hpos.orders where id = $1`,
    [orderId],
  );
  assert(afterConflict.rows[0]?.payment_status === "paid" && afterConflict.rows[0]?.issuance_status === "issued"
    && afterConflict.rows[0]?.tickets === 1,
    "A later conflicting report rewrote a completed paid and issued Order.");

  const repeatedQuote = await api(site, `/v1/public/events/${event.event_id}/quotes`, {
    method: "POST", idempotencyKey: randomUUID(), body: { quantity: 1 },
  });
  assert(repeatedQuote.status === 201, "A second Issue #30 checkout fixture could not create a quote.");
  const repeatedOrder = await api(site, "/v1/public/orders", {
    method: "POST", idempotencyKey: randomUUID(),
    body: { quote_id: repeatedQuote.data.data.quote_id, buyer: { name: "Second Buyer", email: "second@example.test" } },
  });
  assert(repeatedOrder.status === 201, "A second Issue #30 checkout fixture could not create an Order.");
  const repeatedAttempt = await api(site, `/v1/admin/orders/${repeatedOrder.data.data.order_id}/payment-attempts`, {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: { type: "system", reference: "test:issue-30" } },
  });
  assert(repeatedAttempt.status === 201, "A second Issue #30 checkout fixture could not create a payment attempt.");
  const repeatedAttemptId = repeatedAttempt.data.data.attempt_id;
  const repeatedCheckoutReference = "square-test-link-30-" + randomUUID();
  const repeatedRegistration = await api(site, `/v1/admin/payment-attempts/${repeatedAttemptId}/checkout-reference`, {
    method: "POST", idempotencyKey: randomUUID(), body: {
      actor: { type: "system", reference: "test:issue-30" },
      connection_id: site.connectionId,
      provider_checkout_reference: repeatedCheckoutReference,
      provider_can_take_payment: true,
    },
  });
  assert(repeatedRegistration.status === 200, "The second Issue #30 checkout reference could not be registered.");

  const crossAttemptSource = await api(site, `/v1/admin/payment-attempts/${repeatedAttemptId}/payment-reports`, {
    method: "POST", idempotencyKey: randomUUID(), body: {
      ...paidBody,
      provider_checkout_reference: repeatedCheckoutReference,
    },
  });
  assert(crossAttemptSource.status === 409 && crossAttemptSource.data.error.code === "payment_report_conflict",
    "Reusing a provider event on another attempt was not retained as a conflict.");

  const duplicateProviderPayment = await api(site, `/v1/admin/payment-attempts/${repeatedAttemptId}/payment-reports`, {
    method: "POST", idempotencyKey: randomUUID(), body: {
      ...paidBody,
      source_reference: "square-second-attempt-30-" + randomUUID(),
      provider_checkout_reference: repeatedCheckoutReference,
    },
  });
  assert(duplicateProviderPayment.status === 409 && duplicateProviderPayment.data.error.code === "payment_report_conflict",
    "A provider payment already accepted for one attempt was accepted again on another attempt.");
  const duplicatePaymentState = await pool.query(
    `select payment_status, issuance_status,
            (select count(*)::integer from hpos.tickets where order_id = orders.id) as tickets
     from hpos.orders where id = $1`,
    [repeatedOrder.data.data.order_id],
  );
  assert(duplicatePaymentState.rows[0]?.payment_status === "conflicted"
    && duplicatePaymentState.rows[0]?.issuance_status === "not_started"
    && duplicatePaymentState.rows[0]?.tickets === 0,
    "A duplicate provider payment identity issued another usable Ticket.");
}

async function verifyBuyerOrderRecovery(site, order) {
  const path = "/v1/public/order-recovery";
  const matching = await api(site, path, {
    method: "POST", idempotencyKey: randomUUID(), body: { email: order.deliveryEmail },
  });
  assert(matching.status === 202 && matching.data.data?.accepted === true
    && Object.keys(matching.data.data).length === 1,
  "A matching recovery request did not return only the generic accepted acknowledgment.");
  assert(matching.headers.get("cache-control") === "no-store", "A recovery acknowledgment was cacheable.");

  const firstJobs = await api(site, "/v1/admin/notification-jobs?kind=order_recovery");
  const firstJob = firstJobs.data.data.find((job) => job.kind === "order_recovery"
    && job.payload?.recipient_email?.toLowerCase() === order.deliveryEmail.toLowerCase());
  const recoveryToken = firstJob?.payload?.orders?.find((item) => item.order_id === order.orderId)?.order_token;
  assert(firstJobs.status === 200 && firstJob && typeof recoveryToken === "string",
    "A matching recovery request did not queue a durable current-address notification.");
  assert(!JSON.stringify(matching.data).includes(recoveryToken)
    && !JSON.stringify(matching.data).includes(order.orderReference),
  "The recovery acknowledgment exposed an Order or access token.");

  const unmatched = await api(site, path, {
    method: "POST", idempotencyKey: randomUUID(), body: { email: "no-matching-order@example.test" },
  });
  assert(unmatched.status === matching.status
    && JSON.stringify(unmatched.data.data) === JSON.stringify(matching.data.data),
  "An unmatched email received a different recovery acknowledgment.");
  const jobsAfterUnmatched = await api(site, "/v1/admin/notification-jobs?kind=order_recovery");
  assert(!jobsAfterUnmatched.data.data.some((job) => job.kind === "order_recovery"
    && job.payload?.recipient_email?.toLowerCase() === "no-matching-order@example.test"),
  "An unmatched email created a recovery notification.");

  const sameMinute = await api(site, path, {
    method: "POST", idempotencyKey: randomUUID(), body: { email: order.deliveryEmail.toUpperCase() },
  });
  assert(sameMinute.status === matching.status
    && JSON.stringify(sameMinute.data.data) === JSON.stringify(matching.data.data),
  "A same-minute recovery request did not receive the generic acknowledgment.");

  let recoveryJobs = firstJobs.data.data.filter((job) => job.kind === "order_recovery"
    && job.payload?.recipient_email?.toLowerCase() === order.deliveryEmail.toLowerCase());
  assert(recoveryJobs.length === 1, "The Site/email minute limit did not coalesce recovery jobs.");
  for (let sendNumber = 2; sendNumber <= 5; sendNumber += 1) {
    await pool.query(
      `update hpos.notification_jobs
       set created_at = clock_timestamp() - interval '61 seconds'
       where site_id = $1 and kind = 'order_recovery'
         and lower(btrim(payload ->> 'recipient_email')) = lower(btrim($2))`,
      [site.siteId, order.deliveryEmail],
    );
    const allowed = await api(site, path, {
      method: "POST", idempotencyKey: randomUUID(), body: { email: order.deliveryEmail },
    });
    assert(allowed.status === matching.status
      && JSON.stringify(allowed.data.data) === JSON.stringify(matching.data.data),
    `Recovery send ${sendNumber} did not return the generic acknowledgment.`);
  }
  await pool.query(
    `update hpos.notification_jobs
     set created_at = clock_timestamp() - interval '61 seconds'
     where site_id = $1 and kind = 'order_recovery'
       and lower(btrim(payload ->> 'recipient_email')) = lower(btrim($2))`,
    [site.siteId, order.deliveryEmail],
  );
  const hourlySuppression = await api(site, path, {
    method: "POST", idempotencyKey: randomUUID(), body: { email: order.deliveryEmail },
  });
  assert(hourlySuppression.status === matching.status
    && JSON.stringify(hourlySuppression.data.data) === JSON.stringify(matching.data.data),
  "The hourly recovery limit returned a different acknowledgment.");
  const jobsAfterLimit = await api(site, "/v1/admin/notification-jobs?kind=order_recovery");
  recoveryJobs = jobsAfterLimit.data.data.filter((job) => job.kind === "order_recovery"
    && job.payload?.recipient_email?.toLowerCase() === order.deliveryEmail.toLowerCase());
  assert(recoveryJobs.length === 5, "The hourly recovery limit did not stop after five jobs.");

  const temporaryRead = await api(site, "/v1/public/orders/" + encodeURIComponent(recoveryToken));
  const refreshedRead = await api(site, "/v1/public/orders/" + encodeURIComponent(recoveryToken));
  assert(temporaryRead.status === 200 && refreshedRead.status === 200
    && temporaryRead.data.data.order_reference === order.orderReference
    && !Object.hasOwn(temporaryRead.data.data, "order_token"),
  "A temporary recovery token did not support a repeat Order-page read without revealing the permanent Order token.");
  const normalRead = await api(site, "/v1/public/orders/" + encodeURIComponent(order.normalOrderToken));
  assert(normalRead.status === 200 && normalRead.data.data.order_reference === order.orderReference,
    "Recovery invalidated the normal Order access token.");

  const expiredToken = randomUUID() + randomUUID();
  await pool.query(
    `insert into hpos.order_recovery_tokens (id, site_id, order_id, token_hash, created_at, expires_at)
     values ($1, $2, $3, $4, clock_timestamp() - interval '31 minutes', clock_timestamp() - interval '1 minute')`,
    [randomUUID(), site.siteId, order.orderId, createHash("sha256").update(expiredToken, "utf8").digest("hex")],
  );
  const expiredRead = await api(site, "/v1/public/orders/" + encodeURIComponent(expiredToken));
  assert(expiredRead.status === 404, "An expired recovery token still opened an Order.");
  const otherSite = createSiteFixture();
  const wrongSiteRead = await api(otherSite, "/v1/public/orders/" + encodeURIComponent(recoveryToken));
  assert(wrongSiteRead.status === 404, "A recovery token opened an Order from another Site.");

  return { recoveryToken };
}

async function verifyProviderRefundReports(site) {
  const now = Date.now();
  const refundIdentity = randomUUID();
  const event = await createPublishedEvent(site, {
    title: "Issue 42 Provider Refund Reporting",
    startsAt: new Date(now - 60 * 60_000).toISOString(),
    endsAt: new Date(now + 60 * 60_000).toISOString(),
    checkInOpensAt: new Date(now - 30 * 60_000).toISOString(),
    timeZone: "UTC",
    ticketOffering: { price: { amount: 2500, currency: "USD" }, capacity: 3, tax_amount: 0, buyer_fees: [] },
  });

  async function createOrder(label, reportPayment = true) {
    const quote = await api(site, `/v1/public/events/${event.event_id}/quotes`, {
      method: "POST", idempotencyKey: randomUUID(), body: { quantity: 1 },
    });
    assert(quote.status === 201, `The Issue #42 ${label} fixture could not create a quote.`);
    const order = await api(site, "/v1/public/orders", {
      method: "POST", idempotencyKey: randomUUID(),
      body: { quote_id: quote.data.data.quote_id, buyer: {
        name: `Issue 42 ${label}`,
        email: `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@example.test`,
      } },
    });
    assert(order.status === 201, `The Issue #42 ${label} fixture could not create an Order.`);
    const attempt = await api(site, `/v1/admin/orders/${order.data.data.order_id}/payment-attempts`, {
      method: "POST", idempotencyKey: randomUUID(),
      body: { actor: { type: "system", reference: "test:issue-42" } },
    });
    assert(attempt.status === 201, `The Issue #42 ${label} fixture could not create a payment attempt.`);
    const attemptId = attempt.data.data.attempt_id;
    const checkoutReference = `square-issue-42-${label}-${randomUUID()}`;
    const registered = await api(site, `/v1/admin/payment-attempts/${attemptId}/checkout-reference`, {
      method: "POST", idempotencyKey: randomUUID(), body: {
        actor: { type: "system", reference: "test:issue-42" },
        connection_id: site.connectionId,
        provider_checkout_reference: checkoutReference,
        provider_can_take_payment: true,
      },
    });
    assert(registered.status === 200, `The Issue #42 ${label} fixture could not register its checkout reference.`);
    let paidBody = null;
    if (reportPayment) {
      const observedAt = new Date().toISOString();
      paidBody = {
        connection_id: site.connectionId,
        source_reference: `square-payment-issue-42-${label}-${randomUUID()}`,
        provider_checkout_reference: checkoutReference,
        provider_payment_reference: `square-payment-issue-42-${label}-${randomUUID()}`,
        outcome: "paid",
        observed_at: observedAt,
        payment_started_at: observedAt,
        provider_can_take_payment: false,
        amount: 2500,
        currency: "USD",
      };
      const paid = await api(site, `/v1/admin/payment-attempts/${attemptId}/payment-reports`, {
        method: "POST", idempotencyKey: randomUUID(), body: paidBody,
      });
      assert(paid.status === 201 && paid.data.data.attempt.last_outcome === "paid",
        `The Issue #42 ${label} fixture could not record the verified payment.`);
    }
    return { order: order.data.data, attemptId, checkoutReference, paidBody };
  }

  async function reportRefund(order, attemptId, fields) {
    return api(site, `/v1/admin/orders/${order.order_id}/refund-reports`, {
      method: "POST", idempotencyKey: randomUUID(), body: {
        attempt_id: attemptId,
        connection_id: site.connectionId,
        provider_payment_reference: order.provider_payment_reference,
        ...fields,
      },
    });
  }

  const unadmitted = await createOrder("Unadmitted Refund Buyer");
  const paymentReference = unadmitted.paidBody.provider_payment_reference;
  const processingAt = new Date().toISOString();
  const processingBody = {
    attempt_id: unadmitted.attemptId,
    connection_id: site.connectionId,
    provider_payment_reference: paymentReference,
    provider_refund_reference: `square-refund-issue-42-${refundIdentity}-partial-a`,
    source_reference: "square-refund-event-issue-42-processing",
    outcome: "processing",
    amount: 1000,
    currency: "USD",
    observed_at: processingAt,
  };
  const processing = await api(site, `/v1/admin/orders/${unadmitted.order.order_id}/refund-reports`, {
    method: "POST", idempotencyKey: randomUUID(), body: processingBody,
  });
  assert(processing.status === 201 && processing.data.data.applied === true
    && processing.data.data.refund.outcome === "processing",
  "A processing refund was not retained without being treated as completed.");
  const processingBuyer = await api(site, `/v1/public/orders/${unadmitted.order.order_token}`);
  assert(processingBuyer.status === 200 && processingBuyer.data.data.refund_status === "none"
    && processingBuyer.data.data.refunds[0]?.outcome === "processing",
  "The buyer page did not distinguish a processing refund from a completed refund.");
  const duplicate = await api(site, `/v1/admin/orders/${unadmitted.order.order_id}/refund-reports`, {
    method: "POST", idempotencyKey: randomUUID(), body: processingBody,
  });
  assert(duplicate.status === 200 && duplicate.data.data.report.report_id === processing.data.data.report.report_id,
    "An exact duplicate provider refund report created a second evidence row.");

  const unknown = await reportRefund(unadmitted.order, unadmitted.attemptId, {
    provider_payment_reference: paymentReference,
    provider_refund_reference: `square-refund-issue-42-${refundIdentity}-unknown`,
    source_reference: "square-refund-event-issue-42-unknown",
    outcome: "unknown", amount: 500, currency: "USD",
    observed_at: new Date(Date.now() + 1000).toISOString(),
  });
  assert(unknown.status === 201 && unknown.data.data.applied === true
    && unknown.data.data.refund.outcome === "unknown",
  "An unknown refund outcome was not retained without changing the completed-refund total.");

  const partialCompletion = await reportRefund(unadmitted.order, unadmitted.attemptId, {
    provider_payment_reference: paymentReference,
    provider_refund_reference: `square-refund-issue-42-${refundIdentity}-partial-a`,
    source_reference: "square-refund-event-issue-42-partial-a-completed",
    outcome: "completed", amount: 1000, currency: "USD",
    observed_at: new Date(Date.now() + 2000).toISOString(),
  });
  assert(partialCompletion.status === 201 && partialCompletion.data.data.refund.outcome === "completed",
    "A processing refund did not transition to a later completed provider observation.");
  const afterPartialBuyer = await api(site, `/v1/public/orders/${unadmitted.order.order_token}`);
  const afterPartialAdmin = await api(site, `/v1/admin/orders/${unadmitted.order.order_id}`);
  assert(afterPartialBuyer.status === 200 && afterPartialBuyer.data.data.refund_status === "partial"
    && afterPartialBuyer.data.data.refunds.some((refund) => refund.outcome === "completed")
    && afterPartialAdmin.status === 200 && afterPartialAdmin.data.data.refund_reports.length === 3,
  "The partial refund status or safe buyer and staff refund histories were not exposed.");

  const fullCompletion = await reportRefund(unadmitted.order, unadmitted.attemptId, {
    provider_payment_reference: paymentReference,
    provider_refund_reference: `square-refund-issue-42-${refundIdentity}-partial-b`,
    source_reference: "square-refund-event-issue-42-partial-b-completed",
    outcome: "completed", amount: 1500, currency: "USD",
    observed_at: new Date(Date.now() + 3000).toISOString(),
  });
  assert(fullCompletion.status === 201 && fullCompletion.data.data.refund.outcome === "completed",
    "A second completed refund did not return its report result: " + JSON.stringify(fullCompletion));
  const firstCapacity = await pool.query(
    `select offering.reserved_quantity,
            (select count(*)::integer from hpos.tickets ticket
             where ticket.order_id = $2 and ticket.refund_capacity_released_at is not null) as released_tickets
     from hpos.orders order_row
     join hpos.ticket_offerings offering on offering.id = order_row.offering_id and offering.site_id = order_row.site_id
     where order_row.site_id = $1 and order_row.id = $2`,
    [site.siteId, unadmitted.order.order_id],
  );
  const refundedBuyer = await api(site, `/v1/public/orders/${unadmitted.order.order_token}`);
  const refundedAdmin = await api(site, `/v1/admin/orders/${unadmitted.order.order_id}`);
  assert(fullCompletion.status === 201 && refundedBuyer.status === 200
    && refundedBuyer.data.data.refund_status === "full"
    && Number(firstCapacity.rows[0]?.reserved_quantity) === 0 && firstCapacity.rows[0]?.released_tickets === 1
    && refundedAdmin.status === 200 && refundedAdmin.data.data.refunds.length === 3,
  "Cumulative completed refunds did not block the Order and return capacity for its unadmitted Ticket once.");

  const overRefund = await reportRefund(unadmitted.order, unadmitted.attemptId, {
    provider_payment_reference: paymentReference,
    provider_refund_reference: `square-refund-issue-42-${refundIdentity}-over-refund`,
    source_reference: "square-refund-event-issue-42-over-refund",
    outcome: "completed", amount: 1, currency: "USD",
    observed_at: new Date(Date.now() + 4000).toISOString(),
  });
  const overRefundEvidence = await pool.query(
    `select count(*)::integer as reports,
            (select count(*)::integer from hpos.refund_report_issues
             where order_id = $1 and code = 'refund_report_conflict' and status = 'open') as issues
     from hpos.refund_reports where order_id = $1 and conflict_code = 'refund_report_conflict'`,
    [unadmitted.order.order_id],
  );
  assert(overRefund.status === 409 && overRefund.data.error.code === "refund_report_conflict"
    && overRefundEvidence.rows[0]?.reports === 1 && overRefundEvidence.rows[0]?.issues === 1,
  "An over-refund was not rejected and retained as a staff-visible conflict.");

  const admitted = await createOrder("Admitted Refund Buyer");
  const admittedRead = await api(site, `/v1/public/orders/${admitted.order.order_token}`);
  const admittedTicket = admittedRead.data.data.tickets[0];
  const admission = await api(site, `/v1/admin/events/${event.event_id}/admissions`, {
    method: "POST", idempotencyKey: randomUUID(),
    body: { actor: { type: "user", reference: "test:issue-42" }, qr_token: admittedTicket.qr_payload },
  });
  assert(admittedRead.status === 200 && admittedTicket && admission.status === 201,
    "The Issue #42 admitted-Ticket fixture could not establish an Admission.");
  const admittedRefund = await reportRefund(admitted.order, admitted.attemptId, {
    provider_payment_reference: admitted.paidBody.provider_payment_reference,
    provider_refund_reference: `square-refund-issue-42-${refundIdentity}-admitted-full`,
    source_reference: "square-refund-event-issue-42-admitted-full",
    outcome: "completed", amount: 2500, currency: "USD",
    observed_at: new Date(Date.now() + 5000).toISOString(),
  });
  const admittedCapacity = await pool.query(
    `select offering.reserved_quantity,
            (select count(*)::integer from hpos.admissions admission where admission.ticket_id = $2) as admissions,
            ticket.refund_capacity_released_at
     from hpos.tickets ticket
     join hpos.ticket_offerings offering on offering.id = ticket.offering_id and offering.site_id = ticket.site_id
     where ticket.site_id = $1 and ticket.order_id = $3`,
    [site.siteId, admittedTicket.ticket_id, admitted.order.order_id],
  );
  assert(admittedRefund.status === 201 && Number(admittedCapacity.rows[0]?.reserved_quantity) === 1
    && admittedCapacity.rows[0]?.admissions === 1 && admittedCapacity.rows[0]?.refund_capacity_released_at === null,
  "A full refund removed an admitted Ticket's committed Admission or returned its capacity.");

  const lateCharge = await createOrder("Canceled Event Late Charge", false);
  const canceled = await api(site, `/v1/admin/events/${event.event_id}/actions/cancel`, {
    method: "POST", idempotencyKey: randomUUID(),
    body: { actor: { type: "user", reference: "test:issue-42" }, expected_version: event.version },
  });
  assert(canceled.status === 200 && canceled.data.data.is_canceled,
    "The Issue #42 fixture could not cancel its Event before the late provider charge.");
  const lateObservedAt = new Date().toISOString();
  const latePayment = await api(site, `/v1/admin/payment-attempts/${lateCharge.attemptId}/payment-reports`, {
    method: "POST", idempotencyKey: randomUUID(), body: {
      connection_id: site.connectionId,
      source_reference: `square-payment-issue-42-late-${randomUUID()}`,
      provider_checkout_reference: lateCharge.checkoutReference,
      provider_payment_reference: `square-payment-issue-42-late-${randomUUID()}`,
      outcome: "paid", observed_at: lateObservedAt, payment_started_at: lateObservedAt,
      provider_can_take_payment: false, amount: 2500, currency: "USD",
    },
  });
  const lateBuyer = await api(site, `/v1/public/orders/${lateCharge.order.order_token}`);
  const lateAdmin = await api(site, `/v1/admin/orders/${lateCharge.order.order_id}`);
  const admittedAfterCancel = await api(site, `/v1/public/orders/${admitted.order.order_token}`);
  assert(latePayment.status === 201 && lateBuyer.status === 200
    && lateBuyer.data.data.payment_status === "paid" && lateBuyer.data.data.refund_status === "none"
    && lateBuyer.data.data.event.is_canceled === true
    && lateAdmin.status === 200 && lateAdmin.data.data.refund_status === "none"
    && lateAdmin.data.data.event.is_canceled === true
    && admittedAfterCancel.status === 200 && admittedAfterCancel.data.data.refund_status === "full"
    && admittedAfterCancel.data.data.event.is_canceled === true,
  "Late payment, Event cancellation, and completed refund outcomes were merged instead of retained separately.");
}

async function verifyProviderRefundHardening(site) {
  const now = Date.now();
  const refundEvent = await createPublishedEvent(site, {
    title: "Issue 42 Refund Hardening",
    startsAt: new Date(now - 60 * 60_000).toISOString(),
    endsAt: new Date(now + 60 * 60_000).toISOString(),
    checkInOpensAt: new Date(now - 30 * 60_000).toISOString(),
    timeZone: "UTC",
    ticketOffering: { price: { amount: 2500, currency: "USD" }, capacity: 4, tax_amount: 0, buyer_fees: [] },
  });

  async function createOrder(event, label) {
    const quote = await api(site, `/v1/public/events/${event.event_id}/quotes`, {
      method: "POST", idempotencyKey: randomUUID(), body: { quantity: 1 },
    });
    assert(quote.status === 201, `The Issue #42 hardening ${label} fixture could not create a quote.`);
    const created = await api(site, "/v1/public/orders", {
      method: "POST", idempotencyKey: randomUUID(),
      body: { quote_id: quote.data.data.quote_id, buyer: {
        name: `Issue 42 hardening ${label}`,
        email: `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID()}@example.test`,
      } },
    });
    assert(created.status === 201, `The Issue #42 hardening ${label} fixture could not create an Order.`);
    const order = created.data.data;
    const attempt = await api(site, `/v1/admin/orders/${order.order_id}/payment-attempts`, {
      method: "POST", idempotencyKey: randomUUID(),
      body: { actor: { type: "system", reference: "test:issue-42-hardening" } },
    });
    assert(attempt.status === 201, `The Issue #42 hardening ${label} fixture could not create a payment attempt.`);
    const checkoutReference = `square-issue-42-hardening-checkout-${randomUUID()}`;
    const registered = await api(site, `/v1/admin/payment-attempts/${attempt.data.data.attempt_id}/checkout-reference`, {
      method: "POST", idempotencyKey: randomUUID(), body: {
        actor: { type: "system", reference: "test:issue-42-hardening" },
        connection_id: site.connectionId,
        provider_checkout_reference: checkoutReference,
        provider_can_take_payment: true,
      },
    });
    assert(registered.status === 200, `The Issue #42 hardening ${label} fixture could not register checkout.`);
    return { order, attemptId: attempt.data.data.attempt_id, checkoutReference };
  }

  async function recordPaid(fixture, providerPaymentReference) {
    const observedAt = new Date().toISOString();
    const paid = await api(site, `/v1/admin/payment-attempts/${fixture.attemptId}/payment-reports`, {
      method: "POST", idempotencyKey: randomUUID(), body: {
        connection_id: site.connectionId,
        source_reference: `square-issue-42-hardening-payment-${randomUUID()}`,
        provider_checkout_reference: fixture.checkoutReference,
        provider_payment_reference: providerPaymentReference,
        outcome: "paid", observed_at: observedAt, payment_started_at: observedAt,
        provider_can_take_payment: false, amount: 2500, currency: "USD",
      },
    });
    assert(paid.status === 201 && paid.data.data.attempt.last_outcome === "paid",
      "The Issue #42 hardening fixture could not record a verified payment.");
  }

  async function refund(fixture, providerPaymentReference, fields, idempotencyKey = randomUUID()) {
    return api(site, `/v1/admin/orders/${fixture.order.order_id}/refund-reports`, {
      method: "POST", idempotencyKey, body: {
        attempt_id: fixture.attemptId,
        connection_id: site.connectionId,
        provider_payment_reference: providerPaymentReference,
        ...fields,
      },
    });
  }

  const pending = await createOrder(refundEvent, "Pending Payment Refund");
  const pendingPayment = `square-payment-issue-42-hardening-pending-${randomUUID()}`;
  const pendingBody = {
    provider_refund_reference: `square-refund-issue-42-hardening-pending-${randomUUID()}`,
    source_reference: `square-refund-event-issue-42-hardening-pending-${randomUUID()}`,
    outcome: "completed", amount: 2500, currency: "USD", observed_at: new Date().toISOString(),
  };
  const invalidCurrency = await refund(pending, pendingPayment, {
    ...pendingBody,
    source_reference: `${pendingBody.source_reference}-invalid-currency`,
    currency: "EUR",
  });
  assert(invalidCurrency.status === 409 && invalidCurrency.data.error.code === "refund_report_conflict",
    "A refund with an invalid currency was treated as payment-pending evidence.");
  const pendingKey = randomUUID();
  const notConfirmed = await refund(pending, pendingPayment, pendingBody, pendingKey);
  const pendingEvidence = await pool.query(
    `select (select count(*)::integer from hpos.refund_reports where site_id = $1 and source_reference = $2) as reports,
            (select count(*)::integer from hpos.api_idempotency_records where site_id = $1 and idempotency_key = $3) as idempotency_records`,
    [site.siteId, pendingBody.source_reference, pendingKey],
  );
  assert(notConfirmed.status === 503 && notConfirmed.data.error.code === "payment_not_confirmed"
    && notConfirmed.headers.get("Retry-After") === "1"
    && pendingEvidence.rows[0]?.reports === 0 && pendingEvidence.rows[0]?.idempotency_records === 0,
  "An unconfirmed payment refund did not return a retryable response without retaining a report or idempotency result.");
  await recordPaid(pending, pendingPayment);
  const eventuallyAccepted = await refund(pending, pendingPayment, pendingBody, pendingKey);
  assert(eventuallyAccepted.status === 201 && eventuallyAccepted.data.data.refund.outcome === "completed",
    "The same refund source and Idempotency-Key did not apply after payment confirmation.");

  const preissuanceEvent = await createPublishedEvent(site, {
    title: "Issue 42 Refund Before Issuance",
    startsAt: new Date(now - 60 * 60_000).toISOString(),
    endsAt: new Date(now + 60 * 60_000).toISOString(),
    checkInOpensAt: new Date(now - 30 * 60_000).toISOString(),
    timeZone: "UTC",
    ticketOffering: { price: { amount: 2500, currency: "USD" }, capacity: 1, tax_amount: 0, buyer_fees: [] },
  });
  const preissuance = await createOrder(preissuanceEvent, "Full Refund Before Issuance");
  const preissuancePayment = `square-payment-issue-42-hardening-preissuance-${randomUUID()}`;
  // Seed the same committed state that a verified payment report has already
  // written, while leaving issuance pending so the refund path owns the hold.
  await pool.query(
    `update hpos.payment_attempts
     set provider_payment_reference = $3, last_outcome = 'paid', provider_can_take_payment = false,
         status = 'closed', version = version + 1, updated_at = clock_timestamp()
     where id = $1 and site_id = $2`,
    [preissuance.attemptId, site.siteId, preissuancePayment],
  );
  await pool.query(
    `update hpos.orders
     set payment_status = 'paid', checkout_status = 'ended', issuance_status = 'pending',
         version = version + 1, updated_at = clock_timestamp()
     where id = $1 and site_id = $2`,
    [preissuance.order.order_id, site.siteId],
  );
  const beforeRelease = await pool.query(
    `select offering.reserved_quantity, reservation.status as reservation_status
     from hpos.orders order_row
     join hpos.reservations reservation on reservation.order_id = order_row.id and reservation.site_id = order_row.site_id
     join hpos.ticket_offerings offering on offering.id = order_row.offering_id and offering.site_id = order_row.site_id
     where order_row.id = $1 and order_row.site_id = $2`,
    [preissuance.order.order_id, site.siteId],
  );
  const preissuanceRefund = await refund(preissuance, preissuancePayment, {
    provider_refund_reference: `square-refund-issue-42-hardening-preissuance-${randomUUID()}`,
    source_reference: `square-refund-event-issue-42-hardening-preissuance-${randomUUID()}`,
    outcome: "completed", amount: 2500, currency: "USD", observed_at: new Date().toISOString(),
  });
  const afterRelease = await pool.query(
    `select offering.reserved_quantity, reservation.status as reservation_status,
            order_row.refund_status, order_row.issuance_status,
            (select count(*)::integer from hpos.tickets ticket where ticket.order_id = order_row.id) as tickets
     from hpos.orders order_row
     join hpos.reservations reservation on reservation.order_id = order_row.id and reservation.site_id = order_row.site_id
     join hpos.ticket_offerings offering on offering.id = order_row.offering_id and offering.site_id = order_row.site_id
     where order_row.id = $1 and order_row.site_id = $2`,
    [preissuance.order.order_id, site.siteId],
  );
  assert(preissuanceRefund.status === 201 && beforeRelease.rows[0]?.reservation_status === "held"
    && Number(beforeRelease.rows[0]?.reserved_quantity) === 1
    && afterRelease.rows[0]?.reservation_status === "released"
    && Number(afterRelease.rows[0]?.reserved_quantity) === 0
    && afterRelease.rows[0]?.refund_status === "full"
    && afterRelease.rows[0]?.issuance_status === "pending"
    && afterRelease.rows[0]?.tickets === 0,
  "A full refund before issuance did not release the held Reservation and its capacity while retaining the no-Ticket history.");
  const preissuanceAdmin = await api(site, `/v1/admin/orders/${preissuance.order.order_id}`);
  const blockedRetry = await api(site, `/v1/admin/orders/${preissuance.order.order_id}/actions/retry_ticket_issuance`, {
    method: "POST", idempotencyKey: randomUUID(),
    body: { actor: { type: "user", reference: "test:issue-42-hardening" }, expected_version: preissuanceAdmin.data.data.version },
  });
  assert(blockedRetry.status === 409 && blockedRetry.data.error.code === "invalid_state",
    "A fully refunded pre-issuance Order accepted a Ticket-issuance retry.");

  const eventA = await createPublishedEvent(site, {
    title: "Issue 42 Cross Event Source A",
    startsAt: new Date(now - 60 * 60_000).toISOString(),
    endsAt: new Date(now + 60 * 60_000).toISOString(),
    timeZone: "UTC", ticketOffering: { price: { amount: 2500, currency: "USD" }, capacity: 1, tax_amount: 0, buyer_fees: [] },
  });
  const eventB = await createPublishedEvent(site, {
    title: "Issue 42 Cross Event Source B",
    startsAt: new Date(now - 60 * 60_000).toISOString(),
    endsAt: new Date(now + 60 * 60_000).toISOString(),
    timeZone: "UTC", ticketOffering: { price: { amount: 2500, currency: "USD" }, capacity: 1, tax_amount: 0, buyer_fees: [] },
  });
  const orderA = await createOrder(eventA, "Cross Event Source A");
  const orderB = await createOrder(eventB, "Cross Event Source B");
  const paymentA = `square-payment-issue-42-hardening-a-${randomUUID()}`;
  const paymentB = `square-payment-issue-42-hardening-b-${randomUUID()}`;
  await recordPaid(orderA, paymentA);
  await recordPaid(orderB, paymentB);
  const sharedSource = `square-refund-event-issue-42-hardening-shared-${randomUUID()}`;
  const [firstSource, secondSource] = await Promise.all([
    refund(orderA, paymentA, {
      provider_refund_reference: `square-refund-issue-42-hardening-a-${randomUUID()}`,
      source_reference: sharedSource, outcome: "completed", amount: 2500, currency: "USD", observed_at: new Date().toISOString(),
    }),
    refund(orderB, paymentB, {
      provider_refund_reference: `square-refund-issue-42-hardening-b-${randomUUID()}`,
      source_reference: sharedSource, outcome: "completed", amount: 2500, currency: "USD", observed_at: new Date().toISOString(),
    }),
  ]);
  const sourceStatuses = [firstSource.status, secondSource.status].sort((a, b) => a - b);
  assert(sourceStatuses[0] === 201 && sourceStatuses[1] === 409,
    "Concurrent refund reports reused one provider source reference across Events.");
}

async function verifyEmailDeliveryRecovery(site) {
  const now = Date.now();
  const event = await createPublishedEvent(site, {
    title: "Issue 37 Email Delivery Recovery",
    startsAt: new Date(now - 60 * 60_000).toISOString(),
    endsAt: new Date(now + 60 * 60_000).toISOString(),
    checkInOpensAt: new Date(now - 30 * 60_000).toISOString(),
    timeZone: "UTC",
    ticketOffering: { price: { amount: 2700, currency: "USD" }, capacity: 3, tax_amount: 0, buyer_fees: [] },
  });
  const quote = await api(site, "/v1/public/events/" + event.event_id + "/quotes", {
    method: "POST", idempotencyKey: randomUUID(), body: { quantity: 1 },
  });
  assert(quote.status === 201, "The Issue #37 fixture could not create a quote.");
  const order = await api(site, "/v1/public/orders", {
    method: "POST", idempotencyKey: randomUUID(),
    body: { quote_id: quote.data.data.quote_id, buyer: { name: "Delivery Recovery Buyer", email: "delivery-recovery@example.test" } },
  });
  assert(order.status === 201, "The Issue #37 fixture could not create an Order.");
  const attempt = await api(site, "/v1/admin/orders/" + order.data.data.order_id + "/payment-attempts", {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: { type: "system", reference: "test:issue-37" } },
  });
  assert(attempt.status === 201, "The Issue #37 fixture could not create a payment attempt.");
  const checkoutReference = "square-test-link-37-" + randomUUID();
  const registered = await api(site, "/v1/admin/payment-attempts/" + attempt.data.data.attempt_id + "/checkout-reference", {
    method: "POST", idempotencyKey: randomUUID(), body: {
      actor: { type: "system", reference: "test:issue-37" }, connection_id: site.connectionId,
      provider_checkout_reference: checkoutReference, provider_can_take_payment: true,
    },
  });
  assert(registered.status === 200, "The Issue #37 fixture could not register a checkout reference.");
  const observedAt = new Date().toISOString();
  const paid = await api(site, "/v1/admin/payment-attempts/" + attempt.data.data.attempt_id + "/payment-reports", {
    method: "POST", idempotencyKey: randomUUID(), body: {
      connection_id: site.connectionId, source_reference: "square-event-37-" + randomUUID(),
      provider_checkout_reference: checkoutReference, provider_payment_reference: "square-payment-37-" + randomUUID(),
      outcome: "paid", observed_at: observedAt, payment_started_at: observedAt,
      provider_can_take_payment: false, amount: 2700, currency: "USD",
    },
  });
  assert(paid.status === 201, "The Issue #37 fixture could not report a verified payment.");
  const orderId = order.data.data.order_id;
  const initialRead = await api(site, "/v1/public/orders/" + order.data.data.order_token);
  assert(initialRead.status === 200 && initialRead.data.data.tickets.length === 1, "The Issue #37 fixture did not issue one Ticket.");
  const originalTicket = initialRead.data.data.tickets[0];
  const recovery = await verifyBuyerOrderRecovery(site, {
    orderId,
    orderReference: order.data.data.order_reference,
    deliveryEmail: "delivery-recovery@example.test",
    normalOrderToken: order.data.data.order_token,
  });
  const staleRecoveryJobId = randomUUID();
  const staleRecoveryClaimId = randomUUID();
  await pool.query(
    `insert into hpos.notification_jobs (id, site_id, kind, available_at, payload)
     values ($1, $2, 'order_recovery', clock_timestamp(), $3::jsonb)`,
    [staleRecoveryJobId, site.siteId, JSON.stringify({
      recipient_email: "delivery-recovery@example.test",
      orders: [{ order_id: orderId, order_reference: order.data.data.order_reference, order_token: recovery.recoveryToken, expires_at: new Date(Date.now() + 30 * 60_000).toISOString() }],
    })],
  );
  await pool.query(
    `insert into hpos.notification_claims (id, site_id, lease_expires_at, created_actor_type, created_actor_reference)
     values ($1, $2, clock_timestamp() + interval '10 minutes', 'system', 'test:issue-39')`,
    [staleRecoveryClaimId, site.siteId],
  );
  await pool.query(
    `update hpos.notification_jobs
     set claim_id = $3, lease_fence = lease_fence + 1, attempt_count = attempt_count + 1
     where site_id = $1 and id = $2`,
    [site.siteId, staleRecoveryJobId, staleRecoveryClaimId],
  );
  const attendeeName = "Approved attendee " + randomUUID();
  await pool.query(
    `update hpos.tickets set attendee_name = $3 where site_id = $1 and id = $2`,
    [site.siteId, originalTicket.ticket_id, attendeeName],
  );
  const admission = await api(site, "/v1/admin/events/" + event.event_id + "/admissions", {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: { type: "user", reference: "test:issue-37" }, qr_token: originalTicket.qr_payload },
  });
  assert(admission.status === 201, "The Issue #37 fixture could not establish admission history.");
  const jobs = await api(site, "/v1/admin/notification-jobs?order_id=" + orderId + "&kind=tickets_ready");
  const initialJob = jobs.data.data.find((job) => job.kind === "tickets_ready");
  assert(jobs.status === 200 && initialJob, "The Issue #37 fixture did not create its initial Ticket-email job.");

  const claim = await api(site, "/v1/admin/notification-jobs/claims", {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: { type: "system", reference: "test:issue-37" }, limit: 100, kinds: ["tickets_ready"] },
  });
  const target = claim.data.data.jobs.find((job) => job.job_id === initialJob.job_id);
  assert(claim.status === 200 && target, "The Issue #37 initial Ticket-email job could not be claimed.");
  await pool.query(`update hpos.notification_claims set lease_expires_at = clock_timestamp() - interval '1 second' where site_id = $1 and id = $2`, [site.siteId, claim.data.data.claim_id]);
  const staleOutcome = await api(site, "/v1/admin/notification-jobs/" + target.job_id + "/outcome-reports", {
    method: "POST", idempotencyKey: randomUUID(), body: {
      actor: { type: "system", reference: "test:issue-37" }, claim_id: claim.data.data.claim_id,
      lease_fence: target.lease_fence, outcome: "completed", provider_message_reference: "provider-37-stale-" + target.job_id,
      observed_at: new Date().toISOString(), error_code: null,
    },
  });
  assert(staleOutcome.status === 409 && staleOutcome.data.error.code === "claim_conflict", "An expired Ticket-email claim accepted a stale dispatch outcome.");
  const recovered = await api(site, "/api/cron/process");
  assert(recovered.status === 200 && recovered.data.data.recovered_jobs >= 1, "The bounded scheduler did not recover the expired Ticket-email claim.");
  const retryClaim = await api(site, "/v1/admin/notification-jobs/claims", {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: { type: "system", reference: "test:issue-37" }, limit: 100, kinds: ["tickets_ready"] },
  });
  const recoveredTarget = retryClaim.data.data.jobs.find((job) => job.job_id === initialJob.job_id);
  assert(retryClaim.status === 200 && recoveredTarget, "The recovered Ticket-email job could not be claimed for transient retry proof.");
  for (const job of retryClaim.data.data.jobs) {
    if (job.job_id === initialJob.job_id) {
      const transient = await api(site, "/v1/admin/notification-jobs/" + job.job_id + "/outcome-reports", {
        method: "POST", idempotencyKey: randomUUID(), body: {
          actor: { type: "system", reference: "test:issue-37" }, claim_id: retryClaim.data.data.claim_id,
          lease_fence: job.lease_fence, outcome: "failed", provider_message_reference: null,
          observed_at: new Date().toISOString(), error_code: "temporary_provider_failure", failure_class: "transient",
        },
      });
      assert(transient.status === 200 && transient.data.data.status === "pending" && transient.data.data.failure_class === "transient", "A transient dispatch failure did not remain pending for automatic retry.");
      await pool.query(`update hpos.notification_jobs set available_at = clock_timestamp() where site_id = $1 and id = $2`, [site.siteId, job.job_id]);
    } else {
      const outcome = await api(site, "/v1/admin/notification-jobs/" + job.job_id + "/outcome-reports", {
        method: "POST", idempotencyKey: randomUUID(), body: {
          actor: { type: "system", reference: "test:issue-37" }, claim_id: retryClaim.data.data.claim_id,
          lease_fence: job.lease_fence, outcome: "completed", provider_message_reference: "provider-37-" + job.job_id,
          observed_at: new Date().toISOString(), error_code: null,
        },
      });
      assert(outcome.status === 200, "A recovered unrelated Issue #37 dispatch could not be completed.");
    }
  }
  const retryAfterTransient = await api(site, "/v1/admin/notification-jobs/claims", {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: { type: "system", reference: "test:issue-37" }, limit: 100, kinds: ["tickets_ready"] },
  });
  const retriedTarget = retryAfterTransient.data.data.jobs.find((job) => job.job_id === initialJob.job_id);
  assert(retryAfterTransient.status === 200 && retriedTarget, "A transient failure was not eligible for its scheduled retry.");
  for (const job of retryAfterTransient.data.data.jobs) {
    const outcome = await api(site, "/v1/admin/notification-jobs/" + job.job_id + "/outcome-reports", {
      method: "POST", idempotencyKey: randomUUID(), body: {
        actor: { type: "system", reference: "test:issue-37" }, claim_id: retryAfterTransient.data.data.claim_id,
        lease_fence: job.lease_fence, outcome: "completed", provider_message_reference: "provider-37-" + job.job_id,
        observed_at: new Date().toISOString(), error_code: null,
      },
    });
    assert(outcome.status === 200 && (job.job_id !== initialJob.job_id || outcome.data.data.status === "completed"), "A scheduled Ticket-email retry could not be completed.");
  }
  const permanentJobId = randomUUID();
  await pool.query(
    `insert into hpos.notification_jobs (id, site_id, kind, available_at, payload)
     values ($1, $2, 'order_recovery', clock_timestamp(), $3::jsonb)`,
    [permanentJobId, site.siteId, JSON.stringify({ recipient_email: "permanent-failure-37@example.test", orders: [{ order_id: orderId, order_reference: order.data.data.order_reference, order_token: order.data.data.order_token, expires_at: new Date(Date.now() + 3600000).toISOString() }] })],
  );
  const permanentClaim = await api(site, "/v1/admin/notification-jobs/claims", {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: { type: "system", reference: "test:issue-37" }, limit: 100, kinds: ["order_recovery"] },
  });
  const permanentTarget = permanentClaim.data.data.jobs.find((job) => job.job_id === permanentJobId);
  assert(permanentClaim.status === 200 && permanentTarget, "The permanent-failure fixture could not be claimed.");
  for (const job of permanentClaim.data.data.jobs) {
    const outcome = await api(site, "/v1/admin/notification-jobs/" + job.job_id + "/outcome-reports", {
      method: "POST", idempotencyKey: randomUUID(), body: {
        actor: { type: "system", reference: "test:issue-37" }, claim_id: permanentClaim.data.data.claim_id,
        lease_fence: job.lease_fence, outcome: "failed", provider_message_reference: null,
        observed_at: new Date().toISOString(), error_code: "invalid_recipient", failure_class: job.job_id === permanentJobId ? "permanent" : "transient",
      },
    });
    assert(outcome.status === 200, "A classified Issue #37 dispatch failure could not be recorded.");
  }
  await pool.query(`update hpos.notification_jobs set available_at = clock_timestamp() where site_id = $1 and id = $2`, [site.siteId, permanentJobId]);
  const permanentRetryClaim = await api(site, "/v1/admin/notification-jobs/claims", {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: { type: "system", reference: "test:issue-37" }, limit: 100, kinds: ["order_recovery"] },
  });
  assert(permanentRetryClaim.status === 200 && !permanentRetryClaim.data.data.jobs.some((job) => job.job_id === permanentJobId), "A permanent dispatch failure was scheduled for automatic retry.");
  const sentOrder = await api(site, "/v1/admin/orders/" + orderId);
  const sentCorrection = await api(site, "/v1/admin/orders/" + orderId + "/actions/correct_delivery_email", {
    method: "POST", idempotencyKey: randomUUID(), body: {
      actor: { type: "user", reference: "test:issue-37" }, expected_version: sentOrder.data.data.version,
      email: "sent-without-delivery-37@example.test", reason: "Buyer verified the corrected address with staff.", verification_reference: "test-verification-sent-37-" + randomUUID(),
    },
  });
  assert(sentCorrection.status === 409 && sentCorrection.data.error.code === "delivery_verification_required", "Delivery-email correction was allowed after a send without a delivery report.");
  const failedDelivery = await api(site, "/v1/admin/notification-jobs/" + initialJob.job_id + "/delivery-reports", {
    method: "POST", idempotencyKey: randomUUID(), body: {
      actor: { type: "system", reference: "test:issue-37" }, outcome: "failed",
      provider_message_reference: "provider-37-" + initialJob.job_id,
      provider_event_reference: "provider-event-failed-37-" + randomUUID(), observed_at: new Date().toISOString(),
    },
  });
  assert(failedDelivery.status === 200, "The Issue #37 delivery failure could not be recorded.");
  const failedOrder = await api(site, "/v1/admin/orders/" + orderId);
  assert(failedOrder.status === 200 && failedOrder.data.data.delivery_status === "failed", "The failed delivery was not visible on the admin Order.");
  const raceResendKey = randomUUID();
  const [lateDelivery, raceResend] = await Promise.all([
    api(site, "/v1/admin/notification-jobs/" + initialJob.job_id + "/delivery-reports", {
      method: "POST", idempotencyKey: randomUUID(), body: {
        actor: { type: "system", reference: "test:issue-37" }, outcome: "delivered",
        provider_message_reference: "provider-37-" + initialJob.job_id,
        provider_event_reference: "provider-event-late-37-" + randomUUID(), observed_at: new Date(Date.now() + 1000).toISOString(),
      },
    }),
    api(site, "/v1/admin/orders/" + orderId + "/actions/resend_ticket_email", {
      method: "POST", idempotencyKey: raceResendKey,
      body: { actor: { type: "user", reference: "test:issue-37" }, expected_version: failedOrder.data.data.version },
    }),
  ]);
  assert(lateDelivery.status === 200, "The late Issue #37 delivery report could not be recorded.");
  let resent = raceResend;
  let resentKey = raceResendKey;
  if (raceResend.status !== 202) {
    assert(raceResend.status === 409 && raceResend.data.error.code === "already_delivered", "The resend race returned an unexpected state.");
    const afterLateDelivery = await api(site, "/v1/admin/orders/" + orderId);
    const restoreFailed = await api(site, "/v1/admin/notification-jobs/" + initialJob.job_id + "/delivery-reports", {
      method: "POST", idempotencyKey: randomUUID(), body: {
        actor: { type: "system", reference: "test:issue-37" }, outcome: "failed",
        provider_message_reference: "provider-37-" + initialJob.job_id,
        provider_event_reference: "provider-event-race-failed-37-" + randomUUID(), observed_at: new Date(Date.now() + 2000).toISOString(),
      },
    });
    assert(restoreFailed.status === 200, "The delivery race could not be restored to a confirmed failure for resend proof.");
    resentKey = randomUUID();
    resent = await api(site, "/v1/admin/orders/" + orderId + "/actions/resend_ticket_email", {
      method: "POST", idempotencyKey: resentKey, body: { actor: { type: "user", reference: "test:issue-37" }, expected_version: afterLateDelivery.data.data.version },
    });
  }
  assert(resent.status === 202 && resent.data.data.tickets.length === 1
    && resent.data.data.tickets[0].ticket_id === originalTicket.ticket_id
    && resent.data.data.notification_jobs.filter((job) => job.kind === "tickets_ready").length === 2,
  "Guarded resend did not preserve the Ticket or the original failed job.");
  const replayResend = await api(site, "/v1/admin/orders/" + orderId + "/actions/resend_ticket_email", {
    method: "POST", idempotencyKey: resentKey,
    body: { actor: { type: "user", reference: "test:issue-37" }, expected_version: failedOrder.data.data.version },
  });
  assert(replayResend.status === 202 && replayResend.data.data.notification_jobs.filter((job) => job.kind === "tickets_ready").length === 2, "Resend idempotency replay created another Ticket-email job.");

  const pendingCorrection = await api(site, "/v1/admin/orders/" + orderId + "/actions/correct_delivery_email", {
    method: "POST", idempotencyKey: randomUUID(), body: {
      actor: { type: "user", reference: "test:issue-37" }, expected_version: resent.data.data.version,
      email: "corrected-delivery@example.test", reason: "Buyer verified the corrected address with staff.", verification_reference: "test-verification-pending-37-" + randomUUID(),
    },
  });
  assert(pendingCorrection.status === 409 && pendingCorrection.data.error.code === "delivery_in_progress", "Delivery-email correction was allowed while a resend was still pending.");
  const resentJob = resent.data.data.notification_jobs.filter((job) => job.kind === "tickets_ready").at(-1);
  const resendClaim = await api(site, "/v1/admin/notification-jobs/claims", {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: { type: "system", reference: "test:issue-37" }, limit: 100, kinds: ["tickets_ready"] },
  });
  const resentClaimed = resendClaim.data.data.jobs.find((job) => job.job_id === resentJob?.job_id);
  assert(resendClaim.status === 200 && resentClaimed, "The resent Ticket-email job could not be claimed for the correction race check.");
  const resentOutcome = await api(site, "/v1/admin/notification-jobs/" + resentJob.job_id + "/outcome-reports", {
    method: "POST", idempotencyKey: randomUUID(), body: {
      actor: { type: "system", reference: "test:issue-37" }, claim_id: resendClaim.data.data.claim_id,
      lease_fence: resentClaimed.lease_fence, outcome: "completed", provider_message_reference: "provider-37-resend-" + resentJob.job_id,
      observed_at: new Date().toISOString(), error_code: null,
    },
  });
  assert(resentOutcome.status === 200, "The resent Ticket-email dispatch could not be completed for correction testing.");
  const resentFailure = await api(site, "/v1/admin/notification-jobs/" + resentJob.job_id + "/delivery-reports", {
    method: "POST", idempotencyKey: randomUUID(), body: {
      actor: { type: "system", reference: "test:issue-37" }, outcome: "failed",
      provider_message_reference: "provider-37-resend-" + resentJob.job_id,
      provider_event_reference: "provider-event-failed-resend-37-" + randomUUID(), observed_at: new Date().toISOString(),
    },
  });
  assert(resentFailure.status === 200, "The resent Ticket-email delivery failure could not be recorded for correction testing.");
  const resendFailedOrder = await api(site, "/v1/admin/orders/" + orderId);

  const correctedDeliveryEmail = "corrected-" + randomUUID() + "@example.test";
  const existingCorrectedBuyerId = randomUUID();
  await pool.query(
    `insert into hpos.buyers (id, site_id, normalized_email, name)
     values ($1, $2, $3, $4)`,
    [existingCorrectedBuyerId, site.siteId, correctedDeliveryEmail.toLowerCase(), "Existing corrected Buyer profile"],
  );
  const correctionKey = randomUUID();
  const correctionVerificationReference = "test-verification-37-" + randomUUID();
  const correction = await api(site, "/v1/admin/orders/" + orderId + "/actions/correct_delivery_email", {
    method: "POST", idempotencyKey: correctionKey, body: {
      actor: { type: "user", reference: "test:issue-37" }, expected_version: resendFailedOrder.data.data.version,
      email: correctedDeliveryEmail, reason: "Buyer verified the corrected address with staff.", verification_reference: correctionVerificationReference,
    },
  });
  assert(correction.status === 202 && correction.data.data.delivery_email === correctedDeliveryEmail
    && correction.data.data.checkout_identity.email === "delivery-recovery@example.test"
    && correction.data.data.tickets.length === 1
    && correction.data.data.tickets[0].ticket_id === originalTicket.ticket_id,
  "Verified delivery-email correction did not preserve checkout and Ticket identity.");
  const staleClaimedRecovery = await api(site, "/v1/public/orders/" + encodeURIComponent(recovery.recoveryToken));
  assert(staleClaimedRecovery.status === 404, "Delivery-email correction did not revoke temporary recovery access.");
  const staleRecoveryOutcome = await api(site, "/v1/admin/notification-jobs/" + staleRecoveryJobId + "/outcome-reports", {
    method: "POST", idempotencyKey: randomUUID(), body: {
      actor: { type: "system", reference: "test:issue-39" }, claim_id: staleRecoveryClaimId,
      lease_fence: 1, outcome: "failed", provider_message_reference: null,
      observed_at: new Date().toISOString(), error_code: "ORDER_RECOVERY_LINK_UNAVAILABLE", failure_class: "permanent",
    },
  });
  assert(staleClaimedRecovery.status === 404 && staleRecoveryOutcome.status === 200
    && staleRecoveryOutcome.data.data.status === "failed"
    && staleRecoveryOutcome.data.data.failure_class === "permanent",
  "A claimed recovery worker could not verify that the temporary link was revoked before it sent the email.");
  const recoveryJobsAfterCorrection = await api(site, "/v1/admin/notification-jobs?kind=order_recovery");
  const oldAddressRecoveryJobs = recoveryJobsAfterCorrection.data.data.filter((job) => job.kind === "order_recovery"
    && job.payload?.recipient_email?.toLowerCase() === "delivery-recovery@example.test");
  const claimedRecoveryRecord = oldAddressRecoveryJobs.find((job) => job.job_id === staleRecoveryJobId);
  const untouchedRecoveryRecords = oldAddressRecoveryJobs.filter((job) => job.job_id !== staleRecoveryJobId);
  assert(oldAddressRecoveryJobs.length === 6
    && untouchedRecoveryRecords.every((job) => job.is_superseded && job.payload.orders.length === 0)
    && claimedRecoveryRecord?.is_superseded === false && claimedRecoveryRecord.status === "failed",
  "Correction did not remove unsent old-address links or preserve and settle the claimed worker record.");
  const oldOrder = await api(site, "/v1/public/orders/" + order.data.data.order_token);
  assert(oldOrder.status === 404, "The old Order access token remained valid after delivery-email correction.");
  const oldEmailLookup = await api(site, "/v1/admin/events/" + event.event_id + "/ticket-lookup", {
    method: "POST", body: { email: "delivery-recovery@example.test" },
  });
  const correctedEmailLookup = await api(site, "/v1/admin/events/" + event.event_id + "/ticket-lookup", {
    method: "POST", body: { email: correctedDeliveryEmail },
  });
  assert(oldEmailLookup.status === 200 && oldEmailLookup.data.data.length === 0
    && correctedEmailLookup.status === 200 && correctedEmailLookup.data.data.length === 1
    && correctedEmailLookup.data.data[0].order_reference === order.data.data.order_reference,
  "Staff lookup did not move from the old delivery address to the corrected Site Buyer.");
  const correctedBuyer = await pool.query(
    `select orders.buyer_id, buyers.name, buyers.normalized_email
     from hpos.orders join hpos.buyers on buyers.id = orders.buyer_id and buyers.site_id = orders.site_id
     where orders.site_id = $1 and orders.id = $2`,
    [site.siteId, orderId],
  );
  assert(correctedBuyer.rows[0]?.buyer_id === existingCorrectedBuyerId
    && correctedBuyer.rows[0]?.name === "Existing corrected Buyer profile"
    && correctedBuyer.rows[0]?.normalized_email === correctedDeliveryEmail.toLowerCase(),
  "Correction did not associate the Order with the existing corrected Site Buyer without replacing that Buyer's profile name.");
  const correctionJobs = await api(site, "/v1/admin/notification-jobs?order_id=" + orderId + "&kind=tickets_ready");
  const currentJob = correctionJobs.data.data.find((job) => job.kind === "tickets_ready" && !job.is_superseded);
  assert(currentJob?.payload?.recipient_email === correctedDeliveryEmail && correctionJobs.data.data.length === 3,
    "Correction did not retain delivery history and queue current-address work.");
  const currentOrderToken = currentJob.payload.order.order_token;
  const currentOrder = await api(site, "/v1/public/orders/" + currentOrderToken);
  assert(currentOrder.status === 200 && currentOrder.data.data.delivery_email === correctedDeliveryEmail, "The corrected Order link did not open for the current address.");
  const ticketRow = await pool.query("select id, ticket_token, qr_payload, attendee_name, version, (select count(*)::integer from hpos.admissions where ticket_id = tickets.id) as admissions from hpos.tickets where site_id = $1 and order_id = $2", [site.siteId, orderId]);
  assert(ticketRow.rows[0]?.id === originalTicket.ticket_id && ticketRow.rows[0]?.qr_payload === originalTicket.qr_payload
    && ticketRow.rows[0]?.attendee_name === attendeeName && ticketRow.rows[0]?.ticket_token !== originalTicket.ticket_token
    && ticketRow.rows[0]?.version > 1 && ticketRow.rows[0]?.admissions === 1,
  "Delivery-email correction changed the approved-attendee identity, QR, or Ticket identity unexpectedly.");
  const oldTicket = await api(site, "/v1/public/tickets/" + originalTicket.ticket_token);
  assert(oldTicket.status === 404, "The old Ticket page token remained valid after correction.");
  const newTicket = await api(site, "/v1/public/tickets/" + ticketRow.rows[0].ticket_token);
  assert(newTicket.status === 200 && newTicket.data.data.ticket_id === originalTicket.ticket_id && newTicket.data.data.qr_payload === originalTicket.qr_payload
    && newTicket.data.data.admission_status === "admitted" && newTicket.data.data.can_admit === false,
  "The replacement Ticket page did not preserve the QR payload and Admission history.");
  const oldQrReplay = await api(site, "/v1/admin/events/" + event.event_id + "/admissions", {
    method: "POST", idempotencyKey: randomUUID(),
    body: { actor: { type: "user", reference: "test:issue-39" }, qr_token: originalTicket.qr_payload },
  });
  assert(oldQrReplay.status === 409 && oldQrReplay.data.error.code === "already_admitted",
    "The pre-correction QR presentation changed its prior Admission eligibility after correction.");
  const correctionReplay = await api(site, "/v1/admin/orders/" + orderId + "/actions/correct_delivery_email", {
    method: "POST", idempotencyKey: correctionKey, body: {
      actor: { type: "user", reference: "test:issue-37" }, expected_version: resendFailedOrder.data.data.version,
      email: correctedDeliveryEmail, reason: "Buyer verified the corrected address with staff.", verification_reference: correctionVerificationReference,
    },
  });
  assert(correctionReplay.status === 202 && correctionReplay.data.data.notification_jobs.filter((job) => job.kind === "tickets_ready").length === 3,
    "Delivery-email correction idempotency replay created another Ticket-email job.");
  const supersededOrder = await api(site, "/v1/admin/orders/" + orderId);
  await pool.query(`update hpos.notification_jobs set is_superseded = true where site_id = $1 and order_id = $2 and kind = 'tickets_ready'`, [site.siteId, orderId]);
  const supersededCorrection = await api(site, "/v1/admin/orders/" + orderId + "/actions/correct_delivery_email", {
    method: "POST", idempotencyKey: randomUUID(), body: {
      actor: { type: "user", reference: "test:issue-37" }, expected_version: supersededOrder.data.data.version,
      email: "superseded-correction-37@example.test", reason: "Buyer verified the corrected address with staff.", verification_reference: "test-verification-superseded-37-" + randomUUID(),
    },
  });
  assert(supersededCorrection.status === 409 && supersededCorrection.data.error.code === "invalid_state", "Delivery-email correction was allowed when the latest Ticket-email job was superseded.");
  await pool.query(`update hpos.notification_jobs set is_superseded = false where site_id = $1 and id = $2`, [site.siteId, currentJob.job_id]);

  const currentClaim = await api(site, "/v1/admin/notification-jobs/claims", {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: { type: "system", reference: "test:issue-37" }, limit: 100, kinds: ["tickets_ready"] },
  });
  const currentClaimed = currentClaim.data.data.jobs.find((job) => job.job_id === currentJob.job_id);
  assert(currentClaim.status === 200 && currentClaimed, "The corrected Ticket-email job could not be claimed for unknown-outcome verification.");
  const unknown = await api(site, "/v1/admin/notification-jobs/" + currentJob.job_id + "/outcome-reports", {
    method: "POST", idempotencyKey: randomUUID(), body: {
      actor: { type: "system", reference: "test:issue-37" }, claim_id: currentClaim.data.data.claim_id,
      lease_fence: currentClaimed.lease_fence, outcome: "unknown", provider_message_reference: null,
      observed_at: new Date().toISOString(), error_code: "provider_unavailable",
    },
  });
  assert(unknown.status === 200 && unknown.data.data.requires_verification === true, "Unknown Ticket-email dispatch was not fenced for verification.");
  const unresolved = await api(site, "/v1/admin/orders/" + orderId);
  const unknownCorrection = await api(site, "/v1/admin/orders/" + orderId + "/actions/correct_delivery_email", {
    method: "POST", idempotencyKey: randomUUID(), body: {
      actor: { type: "user", reference: "test:issue-37" }, expected_version: unresolved.data.data.version,
      email: "unknown-correction-37@example.test", reason: "Buyer verified the corrected address with staff.", verification_reference: "test-verification-unknown-37-" + randomUUID(),
    },
  });
  assert(unknownCorrection.status === 409 && unknownCorrection.data.error.code === "delivery_verification_required", "Delivery-email correction was allowed after an unknown dispatch.");
  const blindResend = await api(site, "/v1/admin/orders/" + orderId + "/actions/resend_ticket_email", {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: { type: "user", reference: "test:issue-37" }, expected_version: unresolved.data.data.version },
  });
  assert(blindResend.status === 409 && blindResend.data.error.code === "delivery_verification_required", "An unknown Ticket-email dispatch accepted a blind resend.");
  const finalJobs = await api(site, "/v1/admin/notification-jobs?order_id=" + orderId + "&kind=tickets_ready");
  const finalCurrentJob = finalJobs.data.data.find((job) => job.job_id === currentJob.job_id && !job.is_superseded);
  assert(finalJobs.data.data.length === 3 && finalCurrentJob?.requires_verification === true, "The unknown dispatch changed durable job count or verification state.");

  const deliveredEvent = await createPublishedEvent(site, {
    title: "Issue 37 Delivered Correction Guard",
    startsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    endsAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
    timeZone: "UTC",
    ticketOffering: { price: { amount: 2800, currency: "USD" }, capacity: 1, tax_amount: 0, buyer_fees: [] },
  });
  const deliveredQuote = await api(site, `/v1/public/events/${deliveredEvent.event_id}/quotes`, {
    method: "POST", idempotencyKey: randomUUID(), body: { quantity: 1 },
  });
  const deliveredOrder = await api(site, "/v1/public/orders", {
    method: "POST", idempotencyKey: randomUUID(),
    body: { quote_id: deliveredQuote.data.data.quote_id, buyer: { name: "Delivered Correction Buyer", email: "delivered-correction-37@example.test" } },
  });
  const deliveredAttempt = await api(site, "/v1/admin/orders/" + deliveredOrder.data.data.order_id + "/payment-attempts", {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: { type: "system", reference: "test:issue-37" } },
  });
  const deliveredCheckoutReference = "square-test-link-delivered-37-" + randomUUID();
  const deliveredCheckout = await api(site, "/v1/admin/payment-attempts/" + deliveredAttempt.data.data.attempt_id + "/checkout-reference", {
    method: "POST", idempotencyKey: randomUUID(), body: {
      actor: { type: "system", reference: "test:issue-37" }, connection_id: site.connectionId,
      provider_checkout_reference: deliveredCheckoutReference, provider_can_take_payment: true,
    },
  });
  const deliveredPayment = await api(site, "/v1/admin/payment-attempts/" + deliveredAttempt.data.data.attempt_id + "/payment-reports", {
    method: "POST", idempotencyKey: randomUUID(), body: {
      connection_id: site.connectionId, source_reference: "square-event-delivered-37-" + randomUUID(),
      provider_checkout_reference: deliveredCheckoutReference, provider_payment_reference: "square-payment-delivered-37-" + randomUUID(),
      outcome: "paid", observed_at: new Date().toISOString(), payment_started_at: new Date().toISOString(),
      provider_can_take_payment: false, amount: 2800, currency: "USD",
    },
  });
  assert(deliveredQuote.status === 201 && deliveredOrder.status === 201 && deliveredCheckout.status === 200 && deliveredPayment.status === 201,
    "The delivered-correction fixture could not create its paid Order.");
  const deliveredOrderId = deliveredOrder.data.data.order_id;
  const deliveredRead = await api(site, "/v1/public/orders/" + deliveredOrder.data.data.order_token);
  const deliveredTicket = deliveredRead.data.data.tickets[0];
  const deliveredJobs = await api(site, "/v1/admin/notification-jobs?order_id=" + deliveredOrderId + "&kind=tickets_ready");
  const deliveredJob = deliveredJobs.data.data.find((job) => job.kind === "tickets_ready" && !job.is_superseded);
  const deliveredClaim = await api(site, "/v1/admin/notification-jobs/claims", {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: { type: "system", reference: "test:issue-37" }, limit: 10, kinds: ["tickets_ready"] },
  });
  const deliveredClaimed = deliveredClaim.data.data.jobs.find((job) => job.job_id === deliveredJob?.job_id);
  const deliveredProviderReference = "provider-37-delivered-correction-" + deliveredJob?.job_id;
  const deliveredOutcome = deliveredJob && deliveredClaimed ? await api(site, "/v1/admin/notification-jobs/" + deliveredJob.job_id + "/outcome-reports", {
    method: "POST", idempotencyKey: randomUUID(), body: {
      actor: { type: "system", reference: "test:issue-37" }, claim_id: deliveredClaim.data.data.claim_id,
      lease_fence: deliveredClaimed.lease_fence, outcome: "completed", provider_message_reference: deliveredProviderReference,
      observed_at: new Date().toISOString(), error_code: null,
    },
  }) : { status: 0 };
  const deliveredReport = deliveredJob ? await api(site, "/v1/admin/notification-jobs/" + deliveredJob.job_id + "/delivery-reports", {
    method: "POST", idempotencyKey: randomUUID(), body: {
      actor: { type: "system", reference: "test:issue-37" }, outcome: "delivered",
      provider_message_reference: deliveredProviderReference,
      provider_event_reference: "provider-event-delivered-correction-37-" + randomUUID(), observed_at: new Date().toISOString(),
    },
  }) : { status: 0 };
  const deliveredAdminOrder = await api(site, "/v1/admin/orders/" + deliveredOrderId);
  const deliveredCorrectionKey = randomUUID();
  const deliveredCorrectionEmail = "delivered-corrected-37@example.test";
  const deliveredCorrectionBody = {
    actor: { type: "user", reference: "test:issue-37" }, expected_version: deliveredAdminOrder.data.data.version,
    email: deliveredCorrectionEmail, reason: "Buyer verified the delivered address with staff.", verification_reference: "test-verification-delivered-success-37-" + randomUUID(),
  };
  const deliveredCorrection = await api(site, "/v1/admin/orders/" + deliveredOrderId + "/actions/correct_delivery_email", {
    method: "POST", idempotencyKey: deliveredCorrectionKey, body: deliveredCorrectionBody,
  });
  assert(deliveredRead.status === 200 && deliveredTicket && deliveredJobs.status === 200 && deliveredJob && deliveredClaim.status === 200
    && deliveredClaimed && deliveredOutcome.status === 200 && deliveredReport.status === 200
    && deliveredAdminOrder.status === 200 && deliveredAdminOrder.data.data.delivery_status === "delivered"
    && deliveredCorrection.status === 202 && deliveredCorrection.data.data.delivery_email === deliveredCorrectionEmail
    && deliveredCorrection.data.data.tickets[0].ticket_id === deliveredTicket.ticket_id,
  "Delivery-email correction did not remain available after a confirmed delivery.");
  const deliveredCorrectionReplay = await api(site, "/v1/admin/orders/" + deliveredOrderId + "/actions/correct_delivery_email", {
    method: "POST", idempotencyKey: deliveredCorrectionKey, body: deliveredCorrectionBody,
  });
  assert(deliveredCorrectionReplay.status === 202
    && deliveredCorrectionReplay.data.data.notification_jobs.filter((job) => job.kind === "tickets_ready").length === 2,
  "Delivered delivery-email correction idempotency replay created duplicate work.");
}

async function verifyPaymentConflictResolution(site) {
  const now = Date.now();
  const event = await createPublishedEvent(site, {
    title: "Issue 35 Guarded Payment Conflict Resolution",
    startsAt: new Date(now + 60 * 60_000).toISOString(),
    endsAt: new Date(now + 2 * 60 * 60_000).toISOString(),
    timeZone: "UTC",
    ticketOffering: { price: { amount: 2500, currency: "USD" }, capacity: 1, tax_amount: 0, buyer_fees: [] },
  });
  const quote = await api(site, `/v1/public/events/${event.event_id}/quotes`, {
    method: "POST", idempotencyKey: randomUUID(), body: { quantity: 1 },
  });
  assert(quote.status === 201, "The Issue #35 fixture could not create a quote.");
  const order = await api(site, "/v1/public/orders", {
    method: "POST", idempotencyKey: randomUUID(),
    body: { quote_id: quote.data.data.quote_id, buyer: { name: "Conflict Buyer", email: "conflict@example.test" } },
  });
  assert(order.status === 201, "The Issue #35 fixture could not create an Order.");
  const attempt = await api(site, `/v1/admin/orders/${order.data.data.order_id}/payment-attempts`, {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: { type: "system", reference: "test:issue-35" } },
  });
  assert(attempt.status === 201, "The Issue #35 fixture could not create a payment attempt.");
  const attemptId = attempt.data.data.attempt_id;
  const checkoutReference = "square-test-link-35-" + randomUUID();
  const registered = await api(site, `/v1/admin/payment-attempts/${attemptId}/checkout-reference`, {
    method: "POST", idempotencyKey: randomUUID(), body: {
      actor: { type: "system", reference: "test:issue-35" },
      connection_id: site.connectionId,
      provider_checkout_reference: checkoutReference,
      provider_can_take_payment: true,
    },
  });
  assert(registered.status === 200, "The Issue #35 fixture could not register the provider checkout.");

  const conflictBody = {
    connection_id: site.connectionId,
    source_reference: "square-conflict-35-" + randomUUID(),
    provider_checkout_reference: checkoutReference,
    provider_payment_reference: "square-payment-conflict-35-" + randomUUID(),
    outcome: "paid",
    observed_at: new Date(now + 1_000).toISOString(),
    payment_started_at: new Date(now + 500).toISOString(),
    provider_can_take_payment: false,
    amount: 2600,
    currency: "USD",
  };
  const conflict = await api(site, `/v1/admin/payment-attempts/${attemptId}/payment-reports`, {
    method: "POST", idempotencyKey: randomUUID(), body: conflictBody,
  });
  assert(conflict.status === 409 && conflict.data.error.code === "payment_report_conflict",
    "A pre-issuance amount mismatch did not create a payment conflict.");
  const blocked = await api(site, `/v1/public/orders/${order.data.data.order_token}`);
  assert(blocked.status === 200 && blocked.data.data.payment_status === "conflicted"
    && blocked.data.data.tickets.length === 0,
    "A pre-issuance conflict did not block fulfillment.");

  const matchingWhileOpen = await api(site, `/v1/admin/payment-attempts/${attemptId}/payment-reports`, {
    method: "POST", idempotencyKey: randomUUID(), body: {
      ...conflictBody,
      source_reference: "square-matching-while-open-35-" + randomUUID(),
      provider_payment_reference: "square-payment-matching-while-open-35-" + randomUUID(),
      amount: 2500,
    },
  });
  assert(matchingWhileOpen.status === 409 && matchingWhileOpen.data.error.code === "payment_report_conflict",
    "A matching report was applied while the payment conflict was still open.");
  const blockedByOpenConflict = await api(site, `/v1/public/orders/${order.data.data.order_token}`);
  assert(blockedByOpenConflict.status === 200
    && blockedByOpenConflict.data.data.payment_status === "conflicted"
    && blockedByOpenConflict.data.data.issuance_status !== "issued"
    && blockedByOpenConflict.data.data.tickets.length === 0,
    "A matching report during an open conflict triggered payment or Ticket issuance.");

  const detail = await api(site, `/v1/admin/payment-attempts/${attemptId}`);
  assert(detail.status === 200 && detail.data.data.reports.some((report) => report.conflict_code === "payment_report_conflict")
    && detail.data.data.reports.some((report) => report.source_reference.startsWith("square-matching-while-open-35-") && report.applied === false)
    && detail.data.data.issues.some((issue) => issue.status === "open" && issue.code === "payment_report_conflict"),
    "Payment-attempt detail did not retain the conflicting report and open issue.");
  const resolutionBase = {
    actor: { type: "user", reference: "test:issue-35-operator" },
    reason: "Operator verified the provider payment against the recorded checkout.",
    verification_reference: "ref:issue-35-payment-verification-" + randomUUID(),
    report: {
      connection_id: site.connectionId,
      source_reference: "square-resolution-35-" + randomUUID(),
      provider_checkout_reference: checkoutReference,
      provider_payment_reference: "square-payment-resolution-35-" + randomUUID(),
      outcome: "paid",
      observed_at: new Date(now + 2_000).toISOString(),
      payment_started_at: new Date(now + 500).toISOString(),
      provider_can_take_payment: false,
      amount: 2500,
      currency: "USD",
    },
  };
  const stale = await api(site, `/v1/admin/payment-attempts/${attemptId}/actions/resolve`, {
    method: "POST", idempotencyKey: randomUUID(),
    body: { ...resolutionBase, expected_version: detail.data.data.version - 1 },
  });
  assert(stale.status === 409 && stale.data.error.code === "version_conflict",
    "A stale guarded resolution was accepted.");
  const invalid = await api(site, `/v1/admin/payment-attempts/${attemptId}/actions/resolve`, {
    method: "POST", idempotencyKey: randomUUID(),
    body: {
      ...resolutionBase,
      expected_version: detail.data.data.version,
      report: { ...resolutionBase.report, source_reference: "square-invalid-resolution-35-" + randomUUID(), amount: 2601 },
    },
  });
  assert(invalid.status === 409 && invalid.data.error.code === "payment_report_conflict",
    "An invalid guarded resolution bypassed the frozen amount check.");
  const afterInvalid = await api(site, `/v1/admin/payment-attempts/${attemptId}`);
  assert(afterInvalid.status === 200 && afterInvalid.data.data.version > detail.data.data.version,
    "A rejected resolution did not retain its conflicting observation for investigation.");

  const resolutionKey = randomUUID();
  const resolved = await api(site, `/v1/admin/payment-attempts/${attemptId}/actions/resolve`, {
    method: "POST", idempotencyKey: resolutionKey,
    body: { ...resolutionBase, expected_version: afterInvalid.data.data.version },
  });
  assert(resolved.status === 200 && resolved.data.data.applied === true
    && resolved.data.data.resolved_issue_ids.length >= 2,
    "A valid guarded resolution did not resolve all retained conflict issues.");
  const replay = await api(site, `/v1/admin/payment-attempts/${attemptId}/actions/resolve`, {
    method: "POST", idempotencyKey: resolutionKey,
    body: { ...resolutionBase, expected_version: afterInvalid.data.data.version },
  });
  assert(replay.status === 200 && replay.data.data.report_id === resolved.data.data.report_id,
    "Replaying the guarded resolution did not return its original result.");
  const audit = await pool.query(
    `select count(*)::integer as resolutions,
            count(*) filter (where issue.status = 'resolved')::integer as resolved_issues,
            count(*) filter (where resolution.actor_reference = 'test:issue-35-operator')::integer as actor_records
     from hpos.payment_report_issue_resolutions resolution
     join hpos.payment_report_issues issue on issue.id = resolution.issue_id
     where resolution.attempt_id = $1`,
    [attemptId],
  );
  assert(audit.rows[0]?.resolutions >= 2 && audit.rows[0]?.resolved_issues >= 2 && audit.rows[0]?.actor_records >= 2,
    "The guarded resolution audit did not retain issue status and staff evidence.");

  const resolvedReportFrontier = await api(site, "/v1/admin/payment-attempts?requires_report_work=true&limit=100");
  assert(resolvedReportFrontier.status === 200
    && !resolvedReportFrontier.data.data.some((item) => item.attempt_id === attemptId),
    "A valid paid resolution requeued its resolved historical conflict.");

  const delayed = await api(site, `/v1/admin/payment-attempts/${attemptId}/payment-reports`, {
    method: "POST", idempotencyKey: randomUUID(), body: {
      connection_id: site.connectionId,
      source_reference: "square-delayed-failed-35-" + randomUUID(),
      provider_checkout_reference: checkoutReference,
      provider_payment_reference: null,
      outcome: "failed",
      observed_at: new Date(now + 1_500).toISOString(),
      payment_started_at: null,
      provider_can_take_payment: false,
    },
  });
  assert(delayed.status === 201 && delayed.data.data.applied === false,
    "Delayed failed evidence regressed the resolved paid attempt.");
  const delayedReportFrontier = await api(site, "/v1/admin/payment-attempts?requires_report_work=true&limit=100");
  assert(delayedReportFrontier.status === 200
    && delayedReportFrontier.data.data.some((item) => item.attempt_id === attemptId && item.requires_report_work === true),
    "An unapplied delayed report was not discoverable through the report-work frontier.");
  const final = await api(site, `/v1/public/orders/${order.data.data.order_token}`);
  assert(final.status === 200 && final.data.data.payment_status === "paid"
    && final.data.data.issuance_status === "issued" && final.data.data.tickets.length === 1,
    "A resolved conflict did not preserve one paid Order and Ticket after delayed evidence.");
}

async function verifyReservationBackedSalesControls(site) {
  const now = Date.now();
  const event = await createPublishedEvent(site, {
    title: "Issue 27 Reservation-Backed Controls",
    startsAt: new Date(now + 60 * 60_000).toISOString(),
    endsAt: new Date(now + 2 * 60 * 60_000).toISOString(),
    timeZone: "UTC",
    ticketOffering: {
      price: { amount: 2505, currency: "USD" },
      capacity: 2,
      tax_amount: 200,
      buyer_fees: [{ code: "service", label: "Service fee", amount: 100, currency: "USD" }],
    },
  });
  assert(event.sales_status === "open", "The Reservation-backed control Event did not begin open.");

  async function createHeldOrder(name, email) {
    const quote = await api(site, "/v1/public/events/" + event.event_id + "/quotes", {
      method: "POST",
      idempotencyKey: randomUUID(),
      body: { quantity: 1 },
    });
    assert(quote.status === 201, "A Reservation-backed Event did not produce a quote.");
    const createdOrder = await api(site, "/v1/public/orders", {
      method: "POST",
      idempotencyKey: randomUUID(),
      body: {
        quote_id: quote.data.data.quote_id,
        buyer: { name, email },
      },
    });
    const pricing = createdOrder.data?.data?.pricing;
    assert(createdOrder.status === 201 && createdOrder.data.data.reservation.status === "held"
      && pricing?.unit_price?.amount === 2505
      && pricing?.tax_total?.amount === 200
      && pricing?.buyer_fees?.[0]?.amount === 100
      && pricing?.total?.amount === 2805
      && pricing?.platform_fee?.amount === 251
      && pricing?.platform_fee_basis_points === 1000,
      "The checkout did not create a held Reservation with the quoted purchase terms.");
    return createdOrder.data.data;
  }

  const firstOrder = await createHeldOrder("Issue 27 Buyer One", "issue27-one@example.test");
  const secondOrder = await createHeldOrder("Issue 27 Buyer Two", "issue27-two@example.test");
  const soldOut = await api(site, "/v1/public/events/" + event.event_id);
  const soldOutAdmin = await api(site, "/v1/admin/events/" + event.event_id);
  assert(soldOut.status === 200 && soldOut.data.data.sales_status === "sold_out"
    && soldOutAdmin.status === 200 && soldOutAdmin.data.data.ticket_offering.available_quantity === 0,
    "Two actual Reservations did not consume the Event's available capacity.");

  const belowReservations = await api(site, "/v1/admin/events/" + event.event_id, {
    method: "PATCH",
    idempotencyKey: randomUUID(),
    body: {
      actor: { type: "user", reference: "test:issue-27" },
      expected_version: event.version,
      ticket_offering: { capacity: 1 },
    },
  });
  assert(belowReservations.status === 422 && belowReservations.data.error.code === "validation_failed"
    && belowReservations.data.error.details?.[0]?.code === "below_committed_capacity",
    "The capacity floor did not count actual held Reservations.");

  const priceEdit = await api(site, "/v1/admin/events/" + event.event_id, {
    method: "PATCH",
    idempotencyKey: randomUUID(),
    body: {
      actor: { type: "user", reference: "test:issue-27" },
      expected_version: event.version,
      ticket_offering: { price: { amount: 3000, currency: "USD" } },
    },
  });
  assert(priceEdit.status === 200
    && priceEdit.data.data.ticket_offering.price.amount === 3000
    && priceEdit.data.data.ticket_offering.capacity === 2
    && priceEdit.data.data.ticket_offering.tax_amount === 200
    && priceEdit.data.data.ticket_offering.buyer_fees[0]?.amount === 100
    && priceEdit.data.data.ticket_offering.sales_opens_at === event.ticket_offering.sales_opens_at
    && priceEdit.data.data.ticket_offering.sales_closes_at === event.ticket_offering.sales_closes_at,
    "A partial price edit changed omitted Event or offering terms.");

  async function assertAcceptedPurchaseTerms(order) {
    const result = await pool.query(
      "select accepted_quote from hpos.orders where id = $1",
      [order.order_id],
    );
    const terms = result.rows[0]?.accepted_quote;
    assert(terms?.quantity === 1
      && terms?.unit_price?.amount === 2505 && terms?.unit_price?.currency === "USD"
      && terms?.subtotal?.amount === 2505 && terms?.subtotal?.currency === "USD"
      && terms?.buyer_fees?.length === 1
      && terms?.buyer_fees?.[0]?.code === "service"
      && terms?.buyer_fees?.[0]?.amount === 100
      && terms?.tax_total?.amount === 200 && terms?.tax_total?.currency === "USD"
      && terms?.total?.amount === 2805 && terms?.total?.currency === "USD"
      && terms?.platform_fee?.amount === 251 && terms?.platform_fee?.currency === "USD"
      && terms?.platform_fee_basis_points === 1000,
      "A later Event edit changed the stored accepted purchase terms for an existing Order.");
  }

  await assertAcceptedPurchaseTerms(firstOrder);
  await assertAcceptedPurchaseTerms(secondOrder);

  await pool.query(
    "update hpos.reservations set expires_at = clock_timestamp() - interval '1 second' where order_id = $1",
    [firstOrder.order_id],
  );
  await pool.query(
    "update hpos.orders set checkout_expires_at = clock_timestamp() - interval '1 second' where id = $1",
    [firstOrder.order_id],
  );
  const processing = await api(site, "/api/cron/process");
  assert(processing.status === 200 && processing.data.data.released_reservations >= 1,
    "The bounded processor did not release the actual expired Reservation.");
  const availableAgain = await api(site, "/v1/public/events/" + event.event_id);
  const availableAgainAdmin = await api(site, "/v1/admin/events/" + event.event_id);
  assert(availableAgain.status === 200 && availableAgain.data.data.sales_status === "open"
    && availableAgainAdmin.status === 200 && availableAgainAdmin.data.data.ticket_offering.available_quantity === 1,
    "Releasing an actual Reservation did not restore sales availability.");

  const capacityAtRemainingHold = await api(site, "/v1/admin/events/" + event.event_id, {
    method: "PATCH",
    idempotencyKey: randomUUID(),
    body: {
      actor: { type: "user", reference: "test:issue-27" },
      expected_version: priceEdit.data.data.version,
      ticket_offering: { capacity: 1 },
    },
  });
  assert(capacityAtRemainingHold.status === 200
    && capacityAtRemainingHold.data.data.ticket_offering.capacity === 1
    && capacityAtRemainingHold.data.data.ticket_offering.available_quantity === 0,
    "Capacity could not be reduced to the quantity held by the remaining Reservation.");

  const soldOutAgain = await api(site, "/v1/public/events/" + event.event_id);
  const soldOutAgainAdmin = await api(site, "/v1/admin/events/" + event.event_id);
  assert(soldOutAgain.status === 200 && soldOutAgain.data.data.sales_status === "sold_out"
    && soldOutAgainAdmin.status === 200 && soldOutAgainAdmin.data.data.ticket_offering.available_quantity === 0,
    "The remaining actual Reservation did not keep the reduced-capacity Event sold out.");
  await assertAcceptedPurchaseTerms(firstOrder);
  await assertAcceptedPurchaseTerms(secondOrder);
}

function isoUtc(offsetMs) {
  return new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function createSalesConfiguredEvent(site, { title, openOffsetMs, closeOffsetMs, startOffsetMs = 24 * 60 * 60 * 1000, endOffsetMs = 48 * 60 * 60 * 1000, capacity = 20 }) {
  const created = await api(site, "/v1/admin/events", {
    method: "POST",
    idempotencyKey: randomUUID(),
    body: { actor: { type: "user", reference: "test:issue-27" } },
  });
  assert(created.status === 201, "A sales verification draft could not be created.");
  const eventId = created.data.data.event_id;
  const saved = await api(site, "/v1/admin/events/" + eventId, {
    method: "PATCH",
    idempotencyKey: randomUUID(),
    body: {
      actor: { type: "user", reference: "test:issue-27" },
      expected_version: 1,
      title,
      description: "A local sales-control verification Event.",
      venue: { name: "LMNL Space" },
      starts_at: isoUtc(startOffsetMs),
      ends_at: isoUtc(endOffsetMs),
      time_zone: "UTC",
      visibility: "public",
      ticket_offering: {
        price: { amount: 2500, currency: "USD" },
        capacity,
        tax_amount: 0,
        buyer_fees: [],
        sales_opens_at: isoUtc(openOffsetMs),
        sales_closes_at: isoUtc(closeOffsetMs),
      },
    },
  });
  assert(saved.status === 200, "A configured sales Event could not be saved: " + JSON.stringify(saved.data));
  const published = await api(site, "/v1/admin/events/" + eventId + "/actions/publish", {
    method: "POST",
    idempotencyKey: randomUUID(),
    body: { actor: { type: "user", reference: "test:issue-27" }, expected_version: saved.data.data.version },
  });
  assert(published.status === 200, "A configured sales Event could not be published: " + JSON.stringify(published.data));
  return published.data.data;
}

async function verifySalesControlsAndCapacity(site) {
  const open = await createSalesConfiguredEvent(site, {
    title: "Issue 27 Open Sales",
    openOffsetMs: 0,
    closeOffsetMs: 60_000,
  });
  assert(open.sales_status === "open", "Sales within the scheduled window did not report open.");
  assert(open.check_in_opens_at === open.starts_at && open.check_in_uses_event_start, "The effective check-in opening did not default to Event start.");

  const scheduled = await createSalesConfiguredEvent(site, {
    title: "Issue 27 Scheduled Sales",
    openOffsetMs: 60_000,
    closeOffsetMs: 2 * 60 * 60 * 1000,
  });
  assert(scheduled.sales_status === "scheduled", "Sales before the opening time did not report scheduled.");
  const scheduledStop = await api(site, "/v1/admin/events/" + scheduled.event_id + "/actions/stop_sales", {
    method: "POST",
    idempotencyKey: randomUUID(),
    body: { actor: { type: "user", reference: "test:issue-27" }, expected_version: scheduled.version },
  });
  assert(scheduledStop.status === 200 && scheduledStop.data.data.sales_status === "scheduled" && scheduledStop.data.data.sales_paused,
    "Scheduled status did not take precedence over a manual stop.");

  const incompleteWindow = await createPublishedEvent(site, {
    title: "Issue 27 Incomplete Sales Configuration",
    startsAt: isoUtc(24 * 60 * 60 * 1000),
    endsAt: isoUtc(48 * 60 * 60 * 1000),
    timeZone: "UTC",
  });
  const scheduledButIncomplete = await api(site, "/v1/admin/events/" + incompleteWindow.event_id, {
    method: "PATCH",
    idempotencyKey: randomUUID(),
    body: {
      actor: { type: "user", reference: "test:issue-27" },
      expected_version: incompleteWindow.version,
      ticket_offering: {
        sales_opens_at: isoUtc(60_000),
        sales_closes_at: isoUtc(2 * 60 * 60 * 1000),
      },
    },
  });
  assert(scheduledButIncomplete.status === 200 && scheduledButIncomplete.data.data.sales_status === "not_configured",
    "Incomplete settings did not take precedence over a future sales opening.");

  const closedWindow = await createSalesConfiguredEvent(site, {
    title: "Issue 27 Closed Window",
    openOffsetMs: -2 * 60 * 60 * 1000,
    closeOffsetMs: -60_000,
  });
  assert(closedWindow.sales_status === "closed", "A reached sales-closing time did not report closed.");

  const ended = await createSalesConfiguredEvent(site, {
    title: "Issue 27 Ended Event",
    openOffsetMs: -3 * 60 * 60 * 1000,
    closeOffsetMs: -2 * 60 * 60 * 1000,
    startOffsetMs: -2 * 60 * 60 * 1000,
    endOffsetMs: -60_000,
  });
  assert(ended.sales_status === "closed", "An ended Event did not report closed.");
  await pool.query("update hpos.events set sales_paused=true where id=$1", [ended.event_id]);
  const endedWhilePaused = await api(site, "/v1/public/events/" + ended.event_id);
  assert(endedWhilePaused.data.data.sales_status === "closed", "Closed status did not take precedence over a manual stop.");

  // Issue #28 adds real Reservation records. Seed the current committed quantity to exercise #27's API capacity guard meanwhile.
  const seeded = await pool.query("update hpos.ticket_offerings set reserved_quantity=5 where event_id=$1 returning id", [open.event_id]);
  assert(seeded.rowCount === 1, "The local committed-capacity fixture was not found.");
  const belowFloor = await api(site, "/v1/admin/events/" + open.event_id, {
    method: "PATCH",
    idempotencyKey: randomUUID(),
    body: {
      actor: { type: "user", reference: "test:issue-27" },
      expected_version: open.version,
      ticket_offering: { capacity: 4 },
    },
  });
  assert(belowFloor.status === 422 && belowFloor.data.error.code === "validation_failed",
    "Reducing capacity below committed quantity was accepted.");
  assert(belowFloor.data.error.details?.[0]?.code === "below_committed_capacity",
    "The capacity-floor error did not identify the committed-capacity rule.");
  const unchanged = await api(site, "/v1/admin/events/" + open.event_id);
  assert(unchanged.data.data.ticket_offering.capacity === 20 && unchanged.data.data.ticket_offering.available_quantity === 15,
    "A rejected capacity edit changed capacity or available quantity.");

  const capacityEdit = await api(site, "/v1/admin/events/" + open.event_id, {
    method: "PATCH",
    idempotencyKey: randomUUID(),
    body: {
      actor: { type: "user", reference: "test:issue-27" },
      expected_version: open.version,
      ticket_offering: { capacity: 25 },
    },
  });
  assert(capacityEdit.status === 200 && capacityEdit.data.data.ticket_offering.available_quantity === 20,
    "An accepted capacity change did not update available quantity.");
  assert(capacityEdit.data.data.ticket_offering.price.amount === 2500,
    "Changing capacity cleared or changed the omitted price.");

  const stopKey = randomUUID();
  const stopped = await api(site, "/v1/admin/events/" + open.event_id + "/actions/stop_sales", {
    method: "POST",
    idempotencyKey: stopKey,
    body: { actor: { type: "user", reference: "test:issue-27" }, expected_version: capacityEdit.data.data.version },
  });
  assert(stopped.status === 200 && stopped.data.data.sales_paused && stopped.data.data.sales_status === "paused",
    "Stopping sales did not update the authoritative status.");
  const replayedStop = await api(site, "/v1/admin/events/" + open.event_id + "/actions/stop_sales", {
    method: "POST",
    idempotencyKey: stopKey,
    body: { actor: { type: "user", reference: "test:issue-27" }, expected_version: capacityEdit.data.data.version },
  });
  assert(replayedStop.status === 200 && replayedStop.data.data.version === stopped.data.data.version,
    "Retrying a stopped-sales action repeated its state change.");
  const repeatedStop = await api(site, "/v1/admin/events/" + open.event_id + "/actions/stop_sales", {
    method: "POST",
    idempotencyKey: randomUUID(),
    body: { actor: { type: "user", reference: "test:issue-27" }, expected_version: stopped.data.data.version },
  });
  assert(repeatedStop.status === 409 && repeatedStop.data.error.code === "invalid_state",
    "A new stop-sales action silently repeated an already active stop.");
  const staleResume = await api(site, "/v1/admin/events/" + open.event_id + "/actions/resume_sales", {
    method: "POST",
    idempotencyKey: randomUUID(),
    body: { actor: { type: "user", reference: "test:issue-27" }, expected_version: capacityEdit.data.data.version },
  });
  assert(staleResume.status === 409 && staleResume.data.error.code === "version_conflict",
    "Resume sales accepted a stale Event version.");
  const resumed = await api(site, "/v1/admin/events/" + open.event_id + "/actions/resume_sales", {
    method: "POST",
    idempotencyKey: randomUUID(),
    body: { actor: { type: "user", reference: "test:issue-27" }, expected_version: stopped.data.data.version },
  });
  assert(resumed.status === 200 && !resumed.data.data.sales_paused && resumed.data.data.sales_status === "open",
    "Resuming sales within the window did not restore open status.");

  await pool.query("update hpos.ticket_offerings set reserved_quantity=capacity where event_id=$1", [open.event_id]);
  const soldOut = await api(site, "/v1/public/events/" + open.event_id);
  assert(soldOut.data.data.sales_status === "sold_out", "No remaining committed capacity did not report sold out.");
  const stopAtCapacity = await api(site, "/v1/admin/events/" + open.event_id + "/actions/stop_sales", {
    method: "POST",
    idempotencyKey: randomUUID(),
    body: { actor: { type: "user", reference: "test:issue-27" }, expected_version: resumed.data.data.version },
  });
  assert(stopAtCapacity.status === 200 && stopAtCapacity.data.data.sales_status === "paused",
    "Manual pause did not take precedence over sold-out status.");
  const resumeSoldOut = await api(site, "/v1/admin/events/" + open.event_id + "/actions/resume_sales", {
    method: "POST",
    idempotencyKey: randomUUID(),
    body: { actor: { type: "user", reference: "test:issue-27" }, expected_version: stopAtCapacity.data.data.version },
  });
  assert(resumeSoldOut.status === 409 && resumeSoldOut.data.error.code === "invalid_state",
    "Sales resumed while no capacity was available.");
  await pool.query("update hpos.ticket_offerings set reserved_quantity=24 where event_id=$1", [open.event_id]);
  const resumeWithCapacity = await api(site, "/v1/admin/events/" + open.event_id + "/actions/resume_sales", {
    method: "POST",
    idempotencyKey: randomUUID(),
    body: { actor: { type: "user", reference: "test:issue-27" }, expected_version: stopAtCapacity.data.data.version },
  });
  assert(resumeWithCapacity.status === 200 && resumeWithCapacity.data.data.sales_status === "open",
    "Sales did not resume after capacity became available.");
  await pool.query("update hpos.events set is_canceled=true, canceled_at=clock_timestamp(), sales_paused=true where id=$1", [open.event_id]);
  const canceled = await api(site, "/v1/public/events/" + open.event_id);
  assert(canceled.data.data.sales_status === "canceled", "Canceled status did not take precedence over a manual stop.");
}

async function verifyEventLifecycleAndDiscovery(site) {
  const draft = await verifyDraftCreationAndReplay(site);
  const hiddenDraft = await api(site, "/v1/public/events/" + draft.event_id);
  assert(hiddenDraft.status === 404, "An incomplete draft was visible to public detail lookup.");
  const archiveDraft = await api(site, "/v1/admin/events/" + draft.event_id + "/actions/archive", {
    method: "POST",
    idempotencyKey: randomUUID(),
    body: { actor: { type: "user", reference: "test:issue-26" }, expected_version: 1 },
  });
  assert(archiveDraft.status === 409 && archiveDraft.data.error.code === "invalid_state", "An unpublished draft was archived.");

  const invalidPublishKey = randomUUID();
  const invalidPublishBody = { actor: { type: "user", reference: "test:issue-26" }, expected_version: 1 };
  const invalidPublish = await api(site, "/v1/admin/events/" + draft.event_id + "/actions/publish", {
    method: "POST", idempotencyKey: invalidPublishKey, body: invalidPublishBody,
  });
  const invalidPublishRetry = await api(site, "/v1/admin/events/" + draft.event_id + "/actions/publish", {
    method: "POST", idempotencyKey: invalidPublishKey, body: invalidPublishBody,
  });
  assert(invalidPublish.status === 422 && invalidPublishRetry.status === 422, "A definitive publish error was not replayed.");
  assert(invalidPublish.data.error.code === invalidPublishRetry.data.error.code, "A publish retry returned a different domain outcome.");

  const invalidEditKey = randomUUID();
  const invalidEditBody = {
    actor: { type: "user", reference: "test:issue-26" },
    expected_version: 1,
    starts_at: "2032-01-02T10:00:00-08:00",
    ends_at: "2032-01-01T10:00:00-08:00",
    time_zone: "America/Los_Angeles",
  };
  const invalidEdit = await api(site, "/v1/admin/events/" + draft.event_id, {
    method: "PATCH", idempotencyKey: invalidEditKey, body: invalidEditBody,
  });
  const invalidEditRetry = await api(site, "/v1/admin/events/" + draft.event_id, {
    method: "PATCH", idempotencyKey: invalidEditKey, body: invalidEditBody,
  });
  assert(invalidEdit.status === 422 && invalidEditRetry.status === 422, "A rejected Event edit was not replayed.");
  assert(invalidEdit.data.error.code === invalidEditRetry.data.error.code, "A repeated invalid Event edit returned a different domain outcome.");

  const saved = await api(site, "/v1/admin/events/" + draft.event_id, {
    method: "PATCH",
    idempotencyKey: randomUUID(),
    body: {
      actor: { type: "user", reference: "test:issue-26" },
      expected_version: 1,
      title: "Issue 26 Local Test",
      description: "A complete Event created in the local issue #26 walkthrough.",
      venue: { name: "LMNL Space", address: null },
      starts_at: "2032-01-01T19:00:00-08:00",
      ends_at: "2032-01-01T22:00:00-08:00",
      time_zone: "America/Los_Angeles",
      visibility: "public",
      ticket_offering: {
        price: { amount: 2500, currency: "USD" },
        capacity: 20,
        tax_amount: 0,
        buyer_fees: [],
        sales_opens_at: "2031-12-01T09:00:00-08:00",
        sales_closes_at: "2032-01-01T21:00:00-08:00",
      },
    },
  });
  assert(saved.status === 200 && saved.data.data.version === 2, "Saving complete Event details failed: " + JSON.stringify(saved.data));
  assert(saved.data.data.check_in_opens_at === saved.data.data.starts_at && saved.data.data.check_in_uses_event_start,
    "The effective check-in opening did not default to Event start.");
  const partial = await api(site, "/v1/admin/events/" + draft.event_id, {
    method: "PATCH",
    idempotencyKey: randomUUID(),
    body: {
      actor: { type: "user", reference: "test:issue-26" },
      expected_version: 2,
      ticket_offering: { capacity: 25 },
    },
  });
  assert(partial.status === 200 && partial.data.data.ticket_offering.capacity === 25, "A nested partial offering edit failed.");
  assert(partial.data.data.ticket_offering.price.amount === 2500, "A nested partial edit cleared an omitted price.");
  assert(partial.data.data.ticket_offering.sales_opens_at === saved.data.data.ticket_offering.sales_opens_at
    && partial.data.data.ticket_offering.sales_closes_at === saved.data.data.ticket_offering.sales_closes_at,
  "A capacity edit changed omitted sales-window terms.");

  const clearKey = randomUUID();
  const clearBody = {
    actor: { type: "user", reference: "test:issue-26" },
    expected_version: 3,
    ticket_offering: { capacity: null },
  };
  const clearConfiguredCapacity = await api(site, "/v1/admin/events/" + draft.event_id, {
    method: "PATCH", idempotencyKey: clearKey, body: clearBody,
  });
  const replayClearConfiguredCapacity = await api(site, "/v1/admin/events/" + draft.event_id, {
    method: "PATCH", idempotencyKey: clearKey, body: clearBody,
  });
  assert(clearConfiguredCapacity.status === 409 && replayClearConfiguredCapacity.status === 409, "Clearing complete sales settings did not return a replayable conflict.");
  assert(clearConfiguredCapacity.data.error.code === "sales_configuration_locked", "Clearing complete sales settings returned the wrong error.");

  const published = await api(site, "/v1/admin/events/" + draft.event_id + "/actions/publish", {
    method: "POST",
    idempotencyKey: randomUUID(),
    body: { actor: { type: "user", reference: "test:issue-26" }, expected_version: 3 },
  });
  assert(published.status === 200 && published.data.data.publication_status === "published", "A complete draft could not be published.");
  const lockedVisibility = await api(site, "/v1/admin/events/" + draft.event_id, {
    method: "PATCH",
    idempotencyKey: randomUUID(),
    body: { actor: { type: "user", reference: "test:issue-26" }, expected_version: 4, visibility: "private" },
  });
  assert(lockedVisibility.status === 409 && lockedVisibility.data.error.code === "visibility_locked", "Published visibility was editable.");

  const second = await createPublishedEvent(site, {
    title: "Issue 26 Cursor Test",
    startsAt: "2032-02-01T19:00:00-08:00",
    endsAt: "2032-02-01T22:00:00-08:00",
  });
  assert(second.sales_status === "not_configured", "A published Event without sales configuration did not report not_configured.");
  const firstPage = await api(site, "/v1/public/events?period=current&limit=1");
  assert(firstPage.status === 200 && firstPage.data.data.length === 1 && firstPage.data.pagination.next_cursor, "Current Event pagination did not return a deterministic cursor.");
  const secondPage = await api(site, "/v1/public/events?period=current&limit=1&cursor=" + encodeURIComponent(firstPage.data.pagination.next_cursor));
  assert(secondPage.status === 200 && secondPage.data.data.length === 1 && !secondPage.data.pagination.next_cursor, "The public Event cursor did not return the following page.");
  const invalidLimit = await api(site, "/v1/public/events?limit=0");
  assert(invalidLimit.status === 422 && invalidLimit.data.error.code === "validation_failed", "An invalid Event page size did not return 422 validation_failed.");
  const invalidPeriod = await api(site, "/v1/public/events?period=upcoming");
  assert(invalidPeriod.status === 422 && invalidPeriod.data.error.code === "validation_failed", "An invalid Event period did not return 422 validation_failed.");
  const invalidFilter = await api(site, "/v1/admin/events?publication_status=archived");
  assert(invalidFilter.status === 422 && invalidFilter.data.error.code === "validation_failed", "An invalid Event filter did not return 422 validation_failed.");
  const unknownFilter = await api(site, "/v1/admin/events?unknown_filter=value");
  assert(unknownFilter.status === 422 && unknownFilter.data.error.code === "validation_failed", "An unsupported Event list parameter did not return 422 validation_failed.");
  const emptyCursor = await api(site, "/v1/public/events?cursor=");
  assert(emptyCursor.status === 422 && emptyCursor.data.error.code === "invalid_cursor", "An explicitly empty Event cursor was treated as an omitted cursor.");
  const [encodedCursorPayload] = firstPage.data.pagination.next_cursor.split(".");
  const expiredCursorPayload = JSON.parse(Buffer.from(encodedCursorPayload, "base64url").toString("utf8"));
  expiredCursorPayload.issuedAt = new Date(Date.now() - 60 * 60 * 1000 - 1).toISOString();
  const expiredCursor = signedEventCursor(site, expiredCursorPayload);
  const expiredCursorResponse = await api(site, "/v1/public/events?period=current&limit=1&cursor=" + encodeURIComponent(expiredCursor));
  assert(expiredCursorResponse.status === 422 && expiredCursorResponse.data.error.code === "invalid_cursor", "An expired Event cursor was accepted.");
  const [cursorPayload, cursorSignature] = firstPage.data.pagination.next_cursor.split(".");
  const tamperedPayload = JSON.parse(Buffer.from(cursorPayload, "base64url").toString("utf8"));
  tamperedPayload.issuedAt = new Date(Date.now()).toISOString();
  const tamperedCursor = `${Buffer.from(JSON.stringify(tamperedPayload), "utf8").toString("base64url")}.${cursorSignature}`;
  const tamperedCursorResponse = await api(site, "/v1/public/events?period=current&limit=1&cursor=" + encodeURIComponent(tamperedCursor));
  assert(tamperedCursorResponse.status === 422 && tamperedCursorResponse.data.error.code === "invalid_cursor", "A modified Event cursor was accepted.");
  const wrongScope = await api(site, "/v1/public/events?period=current&limit=2&cursor=" + encodeURIComponent(firstPage.data.pagination.next_cursor));
  assert(wrongScope.status === 422 && wrongScope.data.error.code === "invalid_cursor", "A cursor was accepted with a different page size.");
  const publicDetail = await api(site, "/v1/public/events/" + draft.event_id);
  assert(publicDetail.status === 200 && publicDetail.data.data.title === "Issue 26 Local Test", "A published Event was missing from public detail lookup.");

  const past = await createPublishedEvent(site, {
    title: "Issue 26 Past Event",
    startsAt: "2020-01-01T19:00:00-08:00",
    endsAt: "2020-01-01T22:00:00-08:00",
  });
  assert(past.sales_status === "closed", "An ended Event did not take precedence over missing sales configuration.");
  const pastList = await api(site, "/v1/public/events?period=past");
  assert(pastList.status === 200 && pastList.data.data.some((event) => event.event_id === past.event_id), "The past Event list did not include an ended published Event.");
  const archived = await api(site, "/v1/admin/events/" + past.event_id + "/actions/archive", {
    method: "POST", idempotencyKey: randomUUID(),
    body: { actor: { type: "user", reference: "test:issue-26" }, expected_version: 3 },
  });
  assert(archived.status === 200 && archived.data.data.is_archived, "Archiving an ended Event failed.");
  const archivedDetail = await api(site, "/v1/public/events/" + past.event_id);
  assert(archivedDetail.status === 200 && archivedDetail.data.data.is_archived, "Published archived Event detail was not retained.");
  const archivedPastList = await api(site, "/v1/public/events?period=past");
  assert(archivedPastList.status === 200 && archivedPastList.data.data.some((event) => event.event_id === past.event_id),
    "Archiving an ended Event removed it from public past-event discovery.");

  const other = createSiteFixture();
  const crossSite = await api(other, "/v1/public/events/" + draft.event_id);
  assert(crossSite.status === 404, "A different Site could read this Event.");
  const otherSiteCursor = await api(other, "/v1/public/events?period=current&limit=1&cursor=" + encodeURIComponent(firstPage.data.pagination.next_cursor));
  assert(otherSiteCursor.status === 422 && otherSiteCursor.data.error.code === "invalid_cursor", "A Site accepted another Site's cursor.");
  assert(second.publication_status === "published", "The second cursor fixture was not published.");
}

async function verifyEventChangeNotifications(site) {
  const now = Date.now();
  const event = await createPublishedEvent(site, {
    title: "Issue 40 Arrival Change Verification",
    startsAt: new Date(now + 24 * 60 * 60_000).toISOString(),
    endsAt: new Date(now + 48 * 60 * 60_000).toISOString(),
    timeZone: "UTC",
    ticketOffering: { price: { amount: 2500, currency: "USD" }, capacity: 10 },
  });
  const buyers = [];
  for (const label of ["one", "two", "three"]) {
    buyers.push(await createPaidOrderForEventChange(site, event, label));
  }
  const unpaidQuote = await api(site, `/v1/public/events/${event.event_id}/quotes`, {
    method: "POST", idempotencyKey: randomUUID(), body: { quantity: 1 },
  });
  assert(unpaidQuote.status === 201, "The Issue #40 unpaid buyer could not get a quote.");
  const unpaidOrder = await api(site, "/v1/public/orders", {
    method: "POST", idempotencyKey: randomUUID(),
    body: { quote_id: unpaidQuote.data.data.quote_id, buyer: { name: "Unpaid Issue 40 Buyer", email: "unpaid-issue40@example.test" } },
  });
  assert(unpaidOrder.status === 201 && unpaidOrder.data.data.payment_status === "unpaid",
    "The Issue #40 unpaid buyer fixture was not left unpaid.");

  const tooEarlyEnd = new Date(now + 36 * 60 * 60_000).toISOString();
  const invalidWindow = await api(site, `/v1/admin/events/${event.event_id}`, {
    method: "PATCH", idempotencyKey: randomUUID(),
    body: {
      actor: { type: "user", reference: "test:issue-40" },
      expected_version: event.version,
      ends_at: tooEarlyEnd,
    },
  });
  assert(invalidWindow.status === 422 && invalidWindow.data.error.code === "validation_failed"
    && invalidWindow.data.error.details?.some((detail) => detail.code === "after_event_end"),
  "An Event edit that moved the end before the saved sales close was accepted.");
  const unchanged = await api(site, `/v1/admin/events/${event.event_id}`);
  assert(unchanged.status === 200 && unchanged.data.data.version === event.version
    && unchanged.data.data.ends_at === event.ends_at,
  "A rejected timing-window edit changed the Event.");

  const newStartsAt = new Date(now + 72 * 60 * 60_000).toISOString().replace(/\.000Z$/, "Z");
  const newEndsAt = new Date(now + 96 * 60 * 60_000).toISOString().replace(/\.000Z$/, "Z");
  const patchKey = randomUUID();
  const patchBody = {
    actor: { type: "user", reference: "test:issue-40" },
    expected_version: event.version,
    starts_at: newStartsAt,
    ends_at: newEndsAt,
    venue: { name: "Updated LMNL Space", address: "40 Arrival Way" },
  };
  const suffix = randomUUID().replaceAll("-", "");
  const sequenceName = `hpos.issue40_event_jobs_${suffix}`;
  const functionName = `hpos.issue40_fail_event_job_${suffix}`;
  const triggerName = `issue40_fail_event_job_${suffix}`;
  await pool.query(`create sequence ${sequenceName}`);
  await pool.query(`create function ${functionName}() returns trigger language plpgsql as $$
    begin
      if new.kind = 'event_changed' then
        if nextval('${sequenceName}') = 2 then
          raise exception 'injected Issue #40 fan-out interruption';
        end if;
      end if;
      return new;
    end;
  $$`);
  await pool.query(`create trigger ${triggerName} before insert on hpos.notification_jobs
    for each row execute function ${functionName}()`);
  let interrupted;
  try {
    interrupted = await api(site, `/v1/admin/events/${event.event_id}`, {
      method: "PATCH", idempotencyKey: patchKey, body: patchBody,
    });
  } finally {
    await pool.query(`drop trigger ${triggerName} on hpos.notification_jobs`);
    await pool.query(`drop function ${functionName}()`);
    await pool.query(`drop sequence ${sequenceName}`);
  }
  assert(interrupted.status === 500 && interrupted.data.error.code === "internal_error",
    "An injected Event notification fan-out failure did not use the unexpected-application error contract.");
  const rolledBack = await pool.query(
    `select version, starts_at, ends_at, venue_name, venue_address
     from hpos.events where site_id = $1 and id = $2`,
    [site.siteId, event.event_id],
  );
  const rolledBackJobs = await pool.query(
    `select count(*)::integer as count from hpos.notification_jobs
     where site_id = $1 and event_id = $2 and kind = 'event_changed'`,
    [site.siteId, event.event_id],
  );
  assert(rolledBack.rows[0]?.version === event.version
    && rolledBack.rows[0]?.starts_at.toISOString() === new Date(event.starts_at).toISOString()
    && rolledBack.rows[0]?.ends_at.toISOString() === new Date(event.ends_at).toISOString()
    && rolledBack.rows[0]?.venue_name === "LMNL Space"
    && rolledBack.rows[0]?.venue_address === null
    && rolledBackJobs.rows[0]?.count === 0,
  "The interrupted broad Event change left partial Event or buyer-notification state.");

  const changed = await api(site, `/v1/admin/events/${event.event_id}`, {
    method: "PATCH", idempotencyKey: patchKey, body: patchBody,
  });
  assert(changed.status === 200 && changed.data.data.starts_at === newStartsAt
    && changed.data.data.ends_at === newEndsAt
    && changed.data.data.venue.name === "Updated LMNL Space"
    && changed.data.data.venue.address === "40 Arrival Way"
    && changed.data.data.check_in_opens_at === newStartsAt
    && changed.data.data.check_in_uses_event_start,
  "A published Event change did not preserve the default check-in opening or update arrival details.");
  const jobs = await api(site, `/v1/admin/notification-jobs?event_id=${event.event_id}&kind=event_changed&limit=50`);
  assert(jobs.status === 200 && jobs.data.data.length === buyers.length,
    "The Event change did not create one notification for every paid Order and none for the unpaid Order.");
  const jobOrders = new Set(jobs.data.data.map((job) => job.order_id));
  assert(jobOrders.size === buyers.length && buyers.every((buyer) => jobOrders.has(buyer.orderId))
    && !jobOrders.has(unpaidOrder.data.data.order_id),
  "The Event change notifications did not match the paid recipient set.");
  for (const job of jobs.data.data) {
    const buyer = buyers.find((candidate) => candidate.orderId === job.order_id);
    assert(job.kind === "event_changed" && job.status === "pending" && !job.is_superseded
      && job.payload.recipient_email === buyer.email
      && job.payload.order.order_id === buyer.orderId
      && job.payload.event.starts_at === newStartsAt
      && job.payload.event.ends_at === newEndsAt
      && job.payload.event.venue.name === "Updated LMNL Space"
      && job.payload.event.venue.address === "40 Arrival Way"
      && job.payload.event.changed_fields.join(",") === "starts_at,ends_at,venue.name,venue.address"
      && !JSON.stringify(job.payload).includes(buyer.orderToken)
      && !JSON.stringify(job.payload).includes(buyer.ticketToken),
    "An Event change notification did not use the current, minimal, agreed payload.");
  }
  for (const buyer of buyers) {
    const orderPage = await api(site, `/v1/public/orders/${buyer.orderToken}`);
    const ticketPage = await api(site, `/v1/public/tickets/${buyer.ticketToken}`);
    assert(orderPage.status === 200 && orderPage.data.data.event.starts_at === newStartsAt
      && orderPage.data.data.event.venue.name === "Updated LMNL Space"
      && orderPage.data.data.event.venue.address === "40 Arrival Way"
      && ticketPage.status === 200 && ticketPage.data.data.event.starts_at === newStartsAt
      && ticketPage.data.data.event.venue.name === "Updated LMNL Space"
      && ticketPage.data.data.event.venue.address === "40 Arrival Way",
    "The current Order or Ticket page data did not reflect the latest Event arrival details.");
  }

  const revisedAddress = await api(site, `/v1/admin/events/${event.event_id}`, {
    method: "PATCH", idempotencyKey: randomUUID(),
    body: {
      actor: { type: "user", reference: "test:issue-40" },
      expected_version: changed.data.data.version,
      venue: { address: "41 Arrival Way" },
    },
  });
  assert(revisedAddress.status === 200, "A second published Event arrival change failed.");
  const afterSecondChange = await api(site, `/v1/admin/notification-jobs?event_id=${event.event_id}&kind=event_changed&limit=50`);
  const currentJobs = afterSecondChange.data.data.filter((job) => !job.is_superseded);
  const oldJobs = afterSecondChange.data.data.filter((job) => job.is_superseded);
  assert(currentJobs.length === buyers.length && oldJobs.length === buyers.length
    && currentJobs.every((job) => job.payload.event.venue.address === "41 Arrival Way")
    && oldJobs.every((job) => job.payload.event.venue.address === "40 Arrival Way"),
  "A newer Event change did not supersede stale unsent notifications while preserving their history.");

  const explicitOpen = new Date(now + 60 * 60_000).toISOString().replace(/\.000Z$/, "Z");
  const explicitEvent = await createPublishedEvent(site, {
    title: "Issue 40 Explicit Check-In Verification",
    startsAt: new Date(now + 24 * 60 * 60_000).toISOString(),
    endsAt: new Date(now + 48 * 60 * 60_000).toISOString(),
    checkInOpensAt: explicitOpen,
    timeZone: "UTC",
  });
  const changedExplicit = await api(site, `/v1/admin/events/${explicitEvent.event_id}`, {
    method: "PATCH", idempotencyKey: randomUUID(),
    body: {
      actor: { type: "user", reference: "test:issue-40" },
      expected_version: explicitEvent.version,
      starts_at: newStartsAt,
      ends_at: newEndsAt,
    },
  });
  assert(changedExplicit.status === 200 && changedExplicit.data.data.starts_at === newStartsAt
    && changedExplicit.data.data.check_in_opens_at === explicitOpen
    && !changedExplicit.data.data.check_in_uses_event_start,
  "Rescheduling an Event changed its explicitly configured check-in opening.");
}

async function verifyEventCancellation(site) {
  const now = Date.now();
  const event = await createPublishedEvent(site, {
    title: "Issue 41 Event Cancellation Verification",
    startsAt: new Date(now + 24 * 60 * 60_000).toISOString(),
    endsAt: new Date(now + 48 * 60 * 60_000).toISOString(),
    timeZone: "UTC",
    ticketOffering: { price: { amount: 2500, currency: "USD" }, capacity: 8, tax_amount: 0, buyer_fees: [] },
  });
  const paidBuyer = await createPaidOrderForEventChange(site, event, "issue41-paid");

  async function createProviderCheckout(label) {
    const quote = await api(site, `/v1/public/events/${event.event_id}/quotes`, {
      method: "POST", idempotencyKey: randomUUID(), body: { quantity: 1 },
    });
    assert(quote.status === 201, `The Issue #41 ${label} buyer could not get a quote.`);
    const order = await api(site, "/v1/public/orders", {
      method: "POST", idempotencyKey: randomUUID(),
      body: { quote_id: quote.data.data.quote_id, buyer: { name: `Issue 41 ${label}`, email: `${label}-${randomUUID()}@example.test` } },
    });
    assert(order.status === 201, `The Issue #41 ${label} Order could not be created.`);
    const attempt = await api(site, `/v1/admin/orders/${order.data.data.order_id}/payment-attempts`, {
      method: "POST", idempotencyKey: randomUUID(),
      body: { actor: { type: "system", reference: "test:issue-41" } },
    });
    assert(attempt.status === 201, `The Issue #41 ${label} payment attempt could not be created.`);
    const checkoutReference = `square-issue41-${label}-${randomUUID()}`;
    const registered = await api(site, `/v1/admin/payment-attempts/${attempt.data.data.attempt_id}/checkout-reference`, {
      method: "POST", idempotencyKey: randomUUID(), body: {
        actor: { type: "system", reference: "test:issue-41" },
        connection_id: site.connectionId,
        provider_checkout_reference: checkoutReference,
        provider_can_take_payment: true,
      },
    });
    assert(registered.status === 200, `The Issue #41 ${label} provider checkout could not be registered.`);
    return { order: order.data.data, attempt: attempt.data.data, checkoutReference };
  }

  const unpaidQuote = await api(site, `/v1/public/events/${event.event_id}/quotes`, {
    method: "POST", idempotencyKey: randomUUID(), body: { quantity: 1 },
  });
  const unpaid = await api(site, "/v1/public/orders", {
    method: "POST", idempotencyKey: randomUUID(),
    body: { quote_id: unpaidQuote.data.data.quote_id, buyer: { name: "Issue 41 Unpaid Buyer", email: "issue41-unpaid@example.test" } },
  });
  assert(unpaidQuote.status === 201 && unpaid.status === 201, "The Issue #41 unpaid Order fixture could not be created.");
  const verifiedCheckout = await createProviderCheckout("verify");
  const racingCheckout = await createProviderCheckout("race");

  const cancelKey = randomUUID();
  const cancelBody = { actor: { type: "user", reference: "test:issue-41-staff" }, expected_version: event.version };
  const cancelUrl = `/v1/admin/events/${event.event_id}/actions/cancel`;
  const suffix = randomUUID().replaceAll("-", "");
  const sequenceName = `hpos.issue41_event_jobs_${suffix}`;
  const functionName = `hpos.issue41_fail_event_job_${suffix}`;
  const triggerName = `issue41_fail_event_job_${suffix}`;
  await pool.query(`create sequence ${sequenceName}`);
  await pool.query(`create function ${functionName}() returns trigger language plpgsql as $$
    begin
      if new.kind = 'event_canceled' then
        raise exception 'injected Issue #41 cancellation fan-out interruption';
      end if;
      return new;
    end;
  $$`);
  await pool.query(`create trigger ${triggerName} before insert on hpos.notification_jobs
    for each row execute function ${functionName}()`);
  let interrupted;
  try {
    interrupted = await api(site, cancelUrl, { method: "POST", idempotencyKey: cancelKey, body: cancelBody });
  } finally {
    await pool.query(`drop trigger ${triggerName} on hpos.notification_jobs`);
    await pool.query(`drop function ${functionName}()`);
    await pool.query(`drop sequence ${sequenceName}`);
  }
  const afterInterruptedCancel = await pool.query(
    `select is_canceled, sales_paused, version from hpos.events where site_id = $1 and id = $2`,
    [site.siteId, event.event_id],
  );
  const interruptedJobs = await pool.query(
    `select count(*)::integer as count from hpos.notification_jobs
     where site_id = $1 and event_id = $2 and kind = 'event_canceled'`,
    [site.siteId, event.event_id],
  );
  assert(interrupted.status === 500 && interrupted.data.error.code === "internal_error"
    && afterInterruptedCancel.rows[0]?.is_canceled === false
    && afterInterruptedCancel.rows[0]?.sales_paused === false
    && afterInterruptedCancel.rows[0]?.version === event.version
    && interruptedJobs.rows[0]?.count === 0,
  "An interrupted cancellation notification fan-out left partial cancellation state or jobs.");

  const paymentObservedAt = new Date().toISOString();
  const racingPaymentBody = {
    connection_id: site.connectionId,
    source_reference: `square-issue41-payment-${randomUUID()}`,
    provider_checkout_reference: racingCheckout.checkoutReference,
    provider_payment_reference: `square-payment-issue41-${randomUUID()}`,
    outcome: "paid",
    observed_at: paymentObservedAt,
    payment_started_at: paymentObservedAt,
    provider_can_take_payment: false,
    amount: 2500,
    currency: "USD",
  };
  const [canceled, racingPayment] = await Promise.all([
    api(site, cancelUrl, { method: "POST", idempotencyKey: cancelKey, body: cancelBody }),
    api(site, `/v1/admin/payment-attempts/${racingCheckout.attempt.attempt_id}/payment-reports`, {
      method: "POST", idempotencyKey: randomUUID(), body: racingPaymentBody,
    }),
  ]);
  assert(canceled.status === 200 && canceled.data.data.is_canceled && canceled.data.data.sales_status === "canceled"
    && racingPayment.status === 201 && racingPayment.data.data.attempt.last_outcome === "paid",
  "Concurrent Event cancellation and verified payment did not serialize to committed outcomes: "
    + JSON.stringify({ canceled: canceled.data, racingPayment: racingPayment.data }));

  const endedUnpaid = await api(site, `/v1/public/orders/${unpaid.data.data.order_token}`);
  const unpaidReservation = await pool.query(
    `select reservation.status, reservation.awaiting_provider_verification,
            order_row.checkout_status, offering.reserved_quantity
     from hpos.reservations reservation
     join hpos.orders order_row on order_row.id = reservation.order_id and order_row.site_id = reservation.site_id
     join hpos.ticket_offerings offering on offering.id = reservation.offering_id and offering.site_id = reservation.site_id
     where reservation.site_id = $1 and reservation.order_id = $2`,
    [site.siteId, unpaid.data.data.order_id],
  );
  assert(endedUnpaid.status === 200 && endedUnpaid.data.data.checkout_status === "ended"
    && unpaidReservation.rows[0]?.status === "released"
    && unpaidReservation.rows[0]?.awaiting_provider_verification === false,
  "Cancellation did not end an unpaid checkout without a provider attempt and release its Reservation.");

  const verificationFrontier = await api(site, `/v1/admin/payment-attempts?requires_verification=true&event_id=${event.event_id}`);
  assert(verificationFrontier.status === 200
    && verificationFrontier.data.data.some((attempt) => attempt.attempt_id === verifiedCheckout.attempt.attempt_id),
  "Cancellation did not keep the provider-capable checkout in the Site verification frontier.");
  const heldReservation = await pool.query(
    `select attempt.status, reservation.status as reservation_status, reservation.awaiting_provider_verification,
            order_row.checkout_status
     from hpos.payment_attempts attempt
     join hpos.reservations reservation on reservation.order_id = attempt.order_id and reservation.site_id = attempt.site_id
     join hpos.orders order_row on order_row.id = attempt.order_id and order_row.site_id = attempt.site_id
     where attempt.id = $1 and attempt.site_id = $2`,
    [verifiedCheckout.attempt.attempt_id, site.siteId],
  );
  assert(heldReservation.rows[0]?.status === "requires_verification"
    && heldReservation.rows[0]?.reservation_status === "held"
    && heldReservation.rows[0]?.awaiting_provider_verification === true
    && heldReservation.rows[0]?.checkout_status === "awaiting_payment_result",
  "Cancellation released capacity while the Site still had to verify a provider-capable checkout.");

  const closedCheckout = await api(site, `/v1/admin/payment-attempts/${verifiedCheckout.attempt.attempt_id}/closure-reports`, {
    method: "POST", idempotencyKey: randomUUID(), body: {
      actor: { type: "system", reference: "test:issue-41" },
      connection_id: site.connectionId,
      source_reference: `square-issue41-closed-${randomUUID()}`,
      provider_checkout_reference: verifiedCheckout.checkoutReference,
      observed_at: new Date().toISOString(),
      provider_checkout_closed: true,
      payment_outcome: "canceled",
    },
  });
  const releasedReservation = await pool.query(
    `select attempt.status, reservation.status as reservation_status, reservation.awaiting_provider_verification,
            order_row.checkout_status
     from hpos.payment_attempts attempt
     join hpos.reservations reservation on reservation.order_id = attempt.order_id and reservation.site_id = attempt.site_id
     join hpos.orders order_row on order_row.id = attempt.order_id and order_row.site_id = attempt.site_id
     where attempt.id = $1 and attempt.site_id = $2`,
    [verifiedCheckout.attempt.attempt_id, site.siteId],
  );
  assert(closedCheckout.status === 200 && closedCheckout.data.data.status === "closed"
    && releasedReservation.rows[0]?.status === "closed"
    && releasedReservation.rows[0]?.reservation_status === "released"
    && releasedReservation.rows[0]?.awaiting_provider_verification === false
    && releasedReservation.rows[0]?.checkout_status === "ended",
  "Verified provider closure after cancellation did not close the attempt and safely release capacity.");

  const paidRaceOrder = await api(site, `/v1/public/orders/${racingCheckout.order.order_token}`);
  const raceAdminOrder = await api(site, `/v1/admin/orders/${racingCheckout.order.order_id}`);
  assert(paidRaceOrder.status === 200 && paidRaceOrder.data.data.payment_status === "paid"
    && paidRaceOrder.data.data.refund_status === "none"
    && paidRaceOrder.data.data.tickets.length <= 1
    && raceAdminOrder.status === 200,
  "The verified late charge was lost, misreported as refunded, or issued duplicate Tickets.");
  if (paidRaceOrder.data.data.tickets.length === 0) {
    assert(raceAdminOrder.data.data.issues.some((issue) => issue.code === "event_canceled" && issue.status === "open"),
      "A paid Order without Tickets after cancellation did not create an actionable staff issue.");
  } else {
    assert(paidRaceOrder.data.data.tickets.length === 1
      && paidRaceOrder.data.data.tickets[0].admission_blockers.includes("event_canceled"),
    "A Ticket issued just before cancellation remained eligible for Admission.");
  }

  const existingBuyerOrder = await api(site, `/v1/public/orders/${paidBuyer.orderToken}`);
  const existingBuyerTicket = await api(site, `/v1/public/tickets/${paidBuyer.ticketToken}`);
  const blockedAdmission = await api(site, `/v1/admin/events/${event.event_id}/admissions`, {
    method: "POST", idempotencyKey: randomUUID(),
    body: { actor: { type: "user", reference: "test:issue-41-door" }, qr_token: existingBuyerTicket.data.data.qr_payload },
  });
  assert(existingBuyerOrder.status === 200 && existingBuyerOrder.data.data.payment_status === "paid"
    && existingBuyerOrder.data.data.refund_status === "none"
    && existingBuyerOrder.data.data.tickets.length === 1
    && existingBuyerTicket.status === 200 && existingBuyerTicket.data.data.can_admit === false
    && existingBuyerTicket.data.data.admission_blockers.includes("event_canceled")
    && blockedAdmission.status === 409 && blockedAdmission.data.error.code === "event_canceled",
  "Cancellation did not block Admission while retaining paid Order and Ticket history separately from refund status.");

  const publicEvent = await api(site, `/v1/public/events/${event.event_id}`);
  const canceledQuote = await api(site, `/v1/public/events/${event.event_id}/quotes`, {
    method: "POST", idempotencyKey: randomUUID(), body: { quantity: 1 },
  });
  assert(publicEvent.status === 200 && publicEvent.data.data.is_canceled
    && publicEvent.data.data.sales_status === "canceled"
    && canceledQuote.status === 409,
  "The canceled Event page disappeared or new checkout remained possible.");

  const cancellationJobs = await api(site, `/v1/admin/notification-jobs?event_id=${event.event_id}&kind=event_canceled&limit=50`);
  const paidOrders = await pool.query(
    `select id, order_reference, delivery_email from hpos.orders
     where site_id = $1 and event_id = $2 and payment_status = 'paid'`,
    [site.siteId, event.event_id],
  );
  assert(cancellationJobs.status === 200 && cancellationJobs.data.data.length === paidOrders.rows.length,
    "Cancellation and late payment did not leave exactly one durable notice per paid Order.");
  for (const job of cancellationJobs.data.data) {
    const buyer = paidOrders.rows.find((order) => order.id === job.order_id);
    assert(buyer && job.kind === "event_canceled" && job.status === "pending"
      && job.payload.recipient_email === buyer.delivery_email
      && job.payload.order.order_id === buyer.id
      && job.payload.order.order_reference === buyer.order_reference
      && job.payload.event.event_id === event.event_id
      && job.payload.canceled_at
      && !JSON.stringify(job.payload).includes(paidBuyer.orderToken)
      && !JSON.stringify(job.payload).includes(paidBuyer.ticketToken),
    "A cancellation notification was not durable, recipient-correct, or free of buyer tokens.");
  }
  assert(!cancellationJobs.data.data.some((job) => job.order_id === unpaid.data.data.order_id),
    "An unpaid Order received a paid-buyer cancellation notification.");

  const archived = await api(site, cancelUrl.replace("/actions/cancel", "/actions/archive"), {
    method: "POST", idempotencyKey: randomUUID(),
    body: { actor: { type: "user", reference: "test:issue-41-staff" }, expected_version: canceled.data.data.version },
  });
  const archivedPublicEvent = await api(site, `/v1/public/events/${event.event_id}`);
  const retainedOrder = await api(site, `/v1/public/orders/${paidBuyer.orderToken}`);
  assert(archived.status === 200 && archived.data.data.is_archived
    && archivedPublicEvent.status === 200 && archivedPublicEvent.data.data.is_archived
    && retainedOrder.status === 200 && retainedOrder.data.data.tickets.length === 1,
  "Archiving a canceled Event removed its direct page or its paid Order and Ticket history.");
}

async function cleanup() {
  if (!organizationIds.length) return;
  await pool.query("begin");
  try {
    // Historical Site and payment-connection assignments are intentionally
    // restricted. Remove only assignments owned by this run before deleting
    // its graph; old verification and user data stays untouched.
    await pool.query(
      "delete from hpos.site_payment_connection_assignments where organization_id = any($1::uuid[])",
      [organizationIds],
    );
    await pool.query(
      "delete from hpos.admissions where site_id = any($1::uuid[])",
      [siteIds],
    );
    await pool.query(
      "delete from hpos.payment_report_issue_resolutions where site_id = any($1::uuid[])",
      [siteIds],
    );
    await pool.query(
      "delete from hpos.payment_report_issues where site_id = any($1::uuid[])",
      [siteIds],
    );
    await pool.query(
      "delete from hpos.refund_report_issues where site_id = any($1::uuid[])",
      [siteIds],
    );
    await pool.query(
      "delete from hpos.fee_report_issues where site_id = any($1::uuid[])",
      [siteIds],
    );
    await pool.query(
      "delete from hpos.fee_confirmation_totals where site_id = any($1::uuid[])",
      [siteIds],
    );
    await pool.query(
      "delete from hpos.fee_confirmations where site_id = any($1::uuid[])",
      [siteIds],
    );
    await pool.query(
      "delete from hpos.fee_records where site_id = any($1::uuid[])",
      [siteIds],
    );
    await pool.query(
      "delete from hpos.payment_attempt_closure_reports where site_id = any($1::uuid[])",
      [siteIds],
    );
    await pool.query(
      "delete from hpos.payment_attempt_reports where site_id = any($1::uuid[])",
      [siteIds],
    );
    await pool.query(
      "delete from hpos.refund_reports where site_id = any($1::uuid[])",
      [siteIds],
    );
    await pool.query(
      "delete from hpos.refunds where site_id = any($1::uuid[])",
      [siteIds],
    );
    await pool.query(
      "delete from hpos.tickets where site_id = any($1::uuid[])",
      [siteIds],
    );
    await pool.query(
      "delete from hpos.order_recovery_actions where site_id = any($1::uuid[])",
      [siteIds],
    );
    await pool.query(
      "delete from hpos.reservations where site_id = any($1::uuid[])",
      [siteIds],
    );
    await pool.query(
      "delete from hpos.payment_attempts where site_id = any($1::uuid[])",
      [siteIds],
    );
    await pool.query(
      "delete from hpos.orders where site_id = any($1::uuid[])",
      [siteIds],
    );
    await pool.query(
      "delete from hpos.ticket_offering_provider_mappings where site_id = any($1::uuid[])",
      [siteIds],
    );
    await pool.query(
      "delete from hpos.events where site_id = any($1::uuid[])",
      [siteIds],
    );
    await pool.query(
      "delete from hpos.payment_connections where organization_id = any($1::uuid[])",
      [organizationIds],
    );
    await pool.query(
      "delete from hpos.sites where organization_id = any($1::uuid[])",
      [organizationIds],
    );
    await pool.query(
      "delete from hpos.organizations where id = any($1::uuid[])",
      [organizationIds],
    );
    await pool.query("commit");
  } catch (error) {
    await pool.query("rollback").catch(() => undefined);
    throw error;
  }
}

async function main() {
  assert(Number.isInteger(port) && port >= 3000 && port <= 3999, "HPOS_VERIFY_EVENTS_PORT must be from 3000 to 3999.");
  assert(databaseUrl === "postgresql://postgres:postgres@127.0.0.1:54322/postgres", "The event verification requires the dedicated local test database.");
  await assertPortIsFree();
  app = startApp();
  try {
    await waitForReady(app);
    const site = createSiteFixture();
    await verifyPreconfiguredDraftCannotClearSales(site);
    await verifyEventLifecycleAndDiscovery(site);
    await verifyEventChangeNotifications(site);
    await verifyEventCancellation(site);
    await verifySalesControlsAndCapacity(site);
    await verifyPublicSingleTicketCheckout(site);
    await verifyPublicPaymentAttemptLifecycle(site);
    await verifySharedCheckoutReferenceIsolation(site);
    await verifyPaymentReportsAndTicketIssuance(site);
    await verifyProviderRefundReports(site);
    await verifyProviderRefundHardening(site);
    await verifyEmailDeliveryRecovery(site);
    await verifyPaymentConflictResolution(site);
    await verifyReservationBackedSalesControls(site);
  } finally {
    try {
      await cleanup();
    } finally {
      await stopApp(app);
      await pool.end();
    }
  }
  console.log("Local Event, checkout, Admission, and refund API verification passed: sales controls with actual Reservations, preserved purchase terms, capacity release, Organization pilot fees, explicit pricing, single-Ticket quotes, payment-attempt idempotency, shared-connection checkout-reference isolation under concurrent registration, verified payment reporting, interrupted issuance recovery, cumulative and duplicate-safe provider refund reporting, refund conflicts and capacity restoration, admission history retention, cancellation/refund separation, duplicate-safe Tickets and email work, guarded failed-delivery resend, verified delivery-email correction, non-enumerating Order recovery, Site/email recovery limits, reusable temporary access, correction revocation, strict unknown-outcome fencing, separate buyer tokens, manual lookup, Admission rejection precedence, same-key replay, concurrent scans, conflict retention and guarded resolution, provider closure safety, Reservation expiry, and concurrent last-capacity protection.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Event verification failed.");
  process.exitCode = 1;
});
