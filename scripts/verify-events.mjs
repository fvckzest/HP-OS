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

function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
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
  const key = runOperator(["site-key", "issue", "--site", site.site_id]);
  return { siteId: site.site_id, apiKey: key.site_api_key };
}

async function api(site, pathName, { method = "GET", idempotencyKey, body } = {}) {
  const headers = { Authorization: "Bearer " + site.apiKey };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const response = await fetch(origin + pathName, {
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

async function createPublishedEvent(site, { title, startsAt, endsAt, timeZone = "America/Los_Angeles", ticketOffering }) {
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
      time_zone: timeZone,
      visibility: "public",
      ...(ticketOffering ? { ticket_offering: { tax_amount: 0, buyer_fees: [], ...ticketOffering } } : {}),
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
  assert(Array.isArray(quote.data.data.buyer_fees) && quote.data.data.buyer_fees.length === 0,
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
  await pool.query("update hpos.public_quotes set expires_at = clock_timestamp() - interval '1 second' where id = $1", [expiredQuote.data.data.quote_id]);
  const expiredOrder = await api(site, "/v1/public/orders", {
    method: "POST", idempotencyKey: randomUUID(),
    body: { quote_id: expiredQuote.data.data.quote_id, buyer: { name: "Ada Lovelace", email: "ada3@example.test" } },
  });
  assert(expiredOrder.status === 409 && expiredOrder.data.error.code === "quote_expired",
    "An expired quote created an Order.");

  const expiredKey = randomUUID();
  const expiredKeyFingerprint = createHash("sha256")
    .update(`POST\n${quotePath}\n${canonicalJson(quoteBody)}`, "utf8").digest("hex");
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
  assert(processing.status === 200 && processing.data.data.released_reservations === 1,
    "The bounded processing cycle did not release an expired prepayment Reservation.");
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

async function verifySalesPauseAndResume(site) {
  const now = Date.now();
  const event = await createPublishedEvent(site, {
    title: "Sales Control Verification",
    startsAt: new Date(now + 60 * 60_000).toISOString(),
    endsAt: new Date(now + 2 * 60 * 60_000).toISOString(),
    timeZone: "UTC",
    ticketOffering: {
      price: { amount: 2500, currency: "USD" },
      capacity: 1,
      sales_opens_at: new Date(now - 60_000).toISOString(),
      sales_closes_at: new Date(now + 30 * 60_000).toISOString(),
    },
  });
  const eventPath = "/v1/admin/events/" + event.event_id;
  const stopKey = randomUUID();
  const stopBody = { actor: { type: "user", reference: "test:issue-27" }, expected_version: event.version };
  const stopped = await api(site, eventPath + "/actions/stop_sales", {
    method: "POST", idempotencyKey: stopKey, body: stopBody,
  });
  assert(stopped.status === 200 && stopped.data.data.sales_paused === true && stopped.data.data.sales_status === "paused", "Stopping sales did not pause new checkout while preserving the Event.");
  const stopRetry = await api(site, eventPath + "/actions/stop_sales", {
    method: "POST", idempotencyKey: stopKey, body: stopBody,
  });
  assert(stopRetry.status === 200 && stopRetry.data.data.version === stopped.data.data.version, "Retrying stop_sales repeated the action instead of replaying its result.");

  const resumed = await api(site, eventPath + "/actions/resume_sales", {
    method: "POST",
    idempotencyKey: randomUUID(),
    body: { actor: { type: "user", reference: "test:issue-27" }, expected_version: stopped.data.data.version },
  });
  assert(resumed.status === 200 && resumed.data.data.sales_paused === false && resumed.data.data.sales_status === "open", "Resuming an available Event did not restore its open sales state.");
  const soldOut = await api(site, eventPath, {
    method: "PATCH",
    idempotencyKey: randomUUID(),
    body: {
      actor: { type: "user", reference: "test:issue-27" },
      expected_version: resumed.data.data.version,
      ticket_offering: { capacity: 0 },
    },
  });
  assert(soldOut.status === 200 && soldOut.data.data.sales_status === "sold_out" && soldOut.data.data.ticket_offering.available_quantity === 0, "A zero-capacity Event was not reported as sold out with no available Tickets.");
  const capacityRestored = await api(site, eventPath, {
    method: "PATCH",
    idempotencyKey: randomUUID(),
    body: {
      actor: { type: "user", reference: "test:issue-27" },
      expected_version: soldOut.data.data.version,
      ticket_offering: { capacity: 1 },
    },
  });
  assert(capacityRestored.status === 200 && capacityRestored.data.data.sales_status === "open" && capacityRestored.data.data.ticket_offering.available_quantity === 1, "Increasing available capacity did not reopen sales based on HP-OS state.");
  const duplicateStop = await api(site, eventPath + "/actions/stop_sales", {
    method: "POST",
    idempotencyKey: randomUUID(),
    body: { actor: { type: "user", reference: "test:issue-27" }, expected_version: event.version },
  });
  assert(duplicateStop.status === 409 && duplicateStop.data.error.code === "version_conflict", "A stale sales action changed the Event after its version advanced.");
}

async function verifySalesWindowStatus(site) {
  const now = Date.now();
  const configuredOffering = (opensAt, closesAt) => ({
    price: { amount: 2500, currency: "USD" },
    capacity: 1,
    sales_opens_at: opensAt,
    sales_closes_at: closesAt,
  });
  const scheduled = await createPublishedEvent(site, {
    title: "Scheduled Sales Verification",
    startsAt: new Date(now + 3 * 60 * 60_000).toISOString(),
    endsAt: new Date(now + 4 * 60 * 60_000).toISOString(),
    timeZone: "UTC",
    ticketOffering: configuredOffering(new Date(now + 60_000).toISOString(), new Date(now + 2 * 60 * 60_000).toISOString()),
  });
  const scheduledRead = await api(site, "/v1/public/events/" + scheduled.event_id);
  assert(scheduledRead.status === 200 && scheduledRead.data.data.sales_status === "scheduled", "An Event before its configured opening time was not reported as scheduled.");

  const closed = await createPublishedEvent(site, {
    title: "Closed Sales Verification",
    startsAt: new Date(now + 3 * 60 * 60_000).toISOString(),
    endsAt: new Date(now + 4 * 60 * 60_000).toISOString(),
    timeZone: "UTC",
    ticketOffering: configuredOffering(new Date(now - 2 * 60_000).toISOString(), new Date(now - 60_000).toISOString()),
  });
  const closedRead = await api(site, "/v1/public/events/" + closed.event_id);
  assert(closedRead.status === 200 && closedRead.data.data.sales_status === "closed", "An Event after its configured sales closing time was not reported as closed.");
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
        sales_opens_at: "2031-12-01T09:00:00-08:00",
        sales_closes_at: "2032-01-01T21:00:00-08:00",
      },
    },
  });
  assert(saved.status === 200 && saved.data.data.version === 2, "Saving complete Event details failed: " + JSON.stringify(saved.data));
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
  for (const field of ["tax_amount", "buyer_fees"]) {
    const clearedPricing = await api(site, "/v1/admin/events/" + draft.event_id, {
      method: "PATCH", idempotencyKey: randomUUID(),
      body: {
        actor: { type: "user", reference: "test:issue-26" },
        expected_version: 3,
        ticket_offering: { [field]: null },
      },
    });
    assert(clearedPricing.status === 409 && clearedPricing.data.error.code === "sales_configuration_locked",
      "A previously configured " + field + " was cleared.");
  }

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
  const unconfiguredRead = await api(site, "/v1/public/events/" + second.event_id);
  assert(unconfiguredRead.status === 200 && unconfiguredRead.data.data.sales_status === "not_configured", "A published Event without sales settings did not report not_configured.");
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
    await verifySalesWindowStatus(site);
    await verifySalesPauseAndResume(site);
    await verifyPublicSingleTicketCheckout(site);
  } finally {
    await cleanup();
    await stopApp(app);
    await pool.end();
  }
  console.log("Local Event and checkout API verification passed: Event drafts, guarded sales controls, public discovery, explicit pricing configuration, idempotent quotes and Orders, immutable buyer snapshots, Reservation replay safety, expired quote/replay rejection, and concurrent last-capacity protection.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Event verification failed.");
  process.exitCode = 1;
});
