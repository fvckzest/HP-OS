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
  const firstVerificationBatch = await api(site, "/api/cron/process");
  assert(firstVerificationBatch.status === 200
    && firstVerificationBatch.data.data.verification_required_attempts === 50
    && firstVerificationBatch.data.data.has_more === true,
    "The bounded scheduler did not promote exactly 50 overdue payment attempts or expose the remaining verification work.");
  const secondVerificationBatch = await api(site, "/api/cron/process");
  assert(secondVerificationBatch.status === 200
    && secondVerificationBatch.data.data.verification_required_attempts === 1
    && secondVerificationBatch.data.data.has_more === false,
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
    ticketOffering: { price: { amount: 2500, currency: "USD" }, capacity: 2, tax_amount: 0, buyer_fees: [] },
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

  const suffix = randomUUID().replaceAll("-", "");
  const functionName = `hpos.test_issue30_reject_job_${suffix}`;
  const triggerName = `issue30_reject_job_${suffix}`;
  const orderId = order.data.data.order_id;
  await pool.query(`create function ${functionName}() returns trigger language plpgsql as $$
    begin
      if new.kind = 'tickets_ready' and new.order_id = '${orderId}'::uuid then
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
    source_reference: "square-event-30-" + randomUUID(),
    provider_checkout_reference: checkoutReference,
    provider_payment_reference: "square-payment-30-" + randomUUID(),
    outcome: "paid",
    observed_at: paidObservedAt,
    payment_started_at: paidObservedAt,
    provider_can_take_payment: false,
    amount: 2500,
    currency: "USD",
  };
  let paid;
  try {
    paid = await api(site, `/v1/admin/payment-attempts/${attemptId}/payment-reports`, {
      method: "POST", idempotencyKey: randomUUID(), body: paidBody,
    });
  } finally {
    await pool.query(`drop trigger ${triggerName} on hpos.notification_jobs`);
    await pool.query(`drop function ${functionName}()`);
  }
  assert(paid.status === 201 && paid.data.data.attempt.last_outcome === "paid",
    "HP-OS did not persist the provider-confirmed payment before attempting issuance.");
  const interrupted = await pool.query(
    `select payment_status, issuance_status,
            (select count(*)::integer from hpos.tickets where order_id = orders.id) as tickets
     from hpos.orders where id = $1`,
    [orderId],
  );
  assert(interrupted.rows[0]?.payment_status === "paid" && interrupted.rows[0]?.issuance_status === "failed"
    && interrupted.rows[0]?.tickets === 0,
    "An interrupted issuance erased payment or left a partial Ticket set.");

  const recovered = await api(site, "/api/cron/process");
  assert(recovered.status === 200 && recovered.data.data.ticket_issuance?.issued >= 1,
    "The bounded scheduler did not recover the paid Order's failed issuance.");
  const deliveredJobCount = await pool.query(
    `select count(*)::integer as count from hpos.notification_jobs where order_id = $1 and kind = 'tickets_ready'`,
    [orderId],
  );
  assert(deliveredJobCount.rows[0]?.count === 1, "Issuance recovery did not create exactly one initial Ticket email job.");

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

  await pool.query("update hpos.events set check_in_opens_at = clock_timestamp() - interval '30 minutes', check_in_opens_offset_minutes = 0, is_canceled = true where id = $1", [event.event_id]);
  await pool.query("update hpos.orders set refund_status = 'full' where id = $1", [orderId]);
  const canceled = await api(site, `/v1/admin/events/${event.event_id}/admissions`, {
    method: "POST", idempotencyKey: randomUUID(), body: tooEarlyBody,
  });
  await pool.query("update hpos.events set is_canceled = false where id = $1", [event.event_id]);
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
            (select count(*)::integer from hpos.payment_report_issues where order_id = $1) as issues
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
  await pool.query("update hpos.events set is_canceled=true, sales_paused=true where id=$1", [open.event_id]);
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

  const other = createSiteFixture();
  const crossSite = await api(other, "/v1/public/events/" + draft.event_id);
  assert(crossSite.status === 404, "A different Site could read this Event.");
  const otherSiteCursor = await api(other, "/v1/public/events?period=current&limit=1&cursor=" + encodeURIComponent(firstPage.data.pagination.next_cursor));
  assert(otherSiteCursor.status === 422 && otherSiteCursor.data.error.code === "invalid_cursor", "A Site accepted another Site's cursor.");
  assert(second.publication_status === "published", "The second cursor fixture was not published.");
}

async function cleanup() {
  if (organizationIds.length) {
    await pool.query("delete from hpos.organizations where id = any($1::uuid[])", [organizationIds]).catch(() => undefined);
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
    await verifySalesControlsAndCapacity(site);
    await verifyPublicSingleTicketCheckout(site);
    await verifyPublicPaymentAttemptLifecycle(site);
    await verifySharedCheckoutReferenceIsolation(site);
    await verifyPaymentReportsAndTicketIssuance(site);
    await verifyPaymentConflictResolution(site);
    await verifyReservationBackedSalesControls(site);
  } finally {
    await cleanup();
    await stopApp(app);
    await pool.end();
  }
  console.log("Local Event, checkout, and Admission API verification passed: sales controls with actual Reservations, preserved purchase terms, capacity release, Organization pilot fees, explicit pricing, single-Ticket quotes, payment-attempt idempotency, shared-connection checkout-reference isolation under concurrent registration, verified payment reporting, interrupted issuance recovery, duplicate-safe Tickets and email work, separate buyer tokens, manual lookup, Admission rejection precedence, same-key replay, concurrent scans, conflict retention and guarded resolution, provider closure safety, Reservation expiry, and concurrent last-capacity protection.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Event verification failed.");
  process.exitCode = 1;
});
