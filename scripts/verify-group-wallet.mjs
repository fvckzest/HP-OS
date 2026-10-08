import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.HPOS_VERIFY_GROUP_WALLET_PORT ?? 3286);
const origin = `http://127.0.0.1:${port}`;
const databaseUrl = process.env.HPOS_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const env = { ...process.env, NODE_ENV: "development", HPOS_DATABASE_URL: databaseUrl, NEXT_TELEMETRY_DISABLED: "1" };
const pool = new pg.Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 2_000 });
const organizationIds = [];
const siteIds = [];
const triggerFixtures = [];
let app;

const human = { type: "user", reference: "verify:issue-125-staff" };
const system = { type: "system", reference: "verify:issue-125-worker" };

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function listData(response) {
  const value = response.data?.data;
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of ["items", "jobs", "requests", "tickets"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertPortIsFree() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`Group and Wallet verification port ${port} is already in use.`)));
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
      output = (output + chunk).slice(-6_000);
      process.stdout.write(chunk);
    });
  }
  return { child, get output() { return output; } };
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

async function waitForReady(server) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) throw new Error(`The group and Wallet verification app stopped early.\n${server.output}`);
    try {
      const response = await fetch(`${origin}/v1/admin/payment-configuration`, { signal: AbortSignal.timeout(2_000) });
      if (response.status === 401) return;
      await response.body?.cancel().catch(() => undefined);
    } catch {}
    await delay(500);
  }
  throw new Error(`The group and Wallet verification app did not become ready within 90 seconds.\n${server.output}`);
}

function runOperator(args) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/operator.ts", ...args], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) throw new Error(`The local operator command failed: ${output}`);
  try { return JSON.parse(result.stdout); }
  catch { throw new Error("The local operator command did not return JSON."); }
}

async function dropTriggerFixture(fixture) {
  const errors = [];
  try {
    await pool.query(`drop trigger if exists ${fixture.triggerName} on hpos.notification_jobs`);
  } catch (error) {
    errors.push(error);
  }
  try {
    await pool.query(`drop function if exists ${fixture.functionName}()`);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 0) {
    const index = triggerFixtures.indexOf(fixture);
    if (index >= 0) triggerFixtures.splice(index, 1);
    return;
  }
  throw new AggregateError(errors, `Could not remove injected trigger fixture ${fixture.triggerName}.`);
}

async function dropTrackedTriggers() {
  const errors = [];
  for (const fixture of [...triggerFixtures]) {
    try {
      await dropTriggerFixture(fixture);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "One or more injected trigger fixtures could not be removed.");
}

function createSiteFixture(label) {
  const organization = runOperator(["organization", "create", "--name", `${label} ${randomUUID()}`, "--pilot-fee-rate-basis-points", "1000"]);
  organizationIds.push(organization.organization_id);
  const site = runOperator(["site", "create", "--organization", organization.organization_id, "--name", label]);
  siteIds.push(site.site_id);
  const connection = runOperator([
    "payment-connection", "create", "--organization", organization.organization_id,
    "--provider", "square", "--environment", "test",
    "--account-reference", "ref:verify-issue-125-seller",
    "--location-reference", "ref:verify-issue-125-location",
  ]);
  runOperator([
    "payment-connection", "eligibility-record", "--connection", connection.connection_id,
    "--account-status", "eligible", "--platform-fee-status", "ineligible",
    "--evidence-reference", "ref:verify-issue-125-local",
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

async function api(site, pathName, { method = "GET", idempotencyKey, body, key = site.apiKey, fetchImpl = fetch } = {}) {
  const headers = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const response = await fetchImpl(`${origin}${pathName}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try { data = await response.json(); } catch {}
  return { status: response.status, headers: response.headers, data };
}

async function createPublishedEvent(site, {
  title,
  visibility = "public",
  capacity = 16,
  price = 2500,
  tax = 300,
  buyerFees = [{ code: "service", label: "Buyer service fee", amount: 125, currency: "USD" }],
  salesClosesAt = null,
} = {}) {
  const now = Date.now();
  const startsAt = new Date(now - 60 * 60_000).toISOString();
  const endsAt = new Date(now + 4 * 60 * 60_000).toISOString();
  const draft = await api(site, "/v1/admin/events", {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: human },
  });
  assert(draft.status === 201, `Could not create ${title ?? "verification"} Event draft.`);
  const saved = await api(site, `/v1/admin/events/${draft.data.data.event_id}`, {
    method: "PATCH", idempotencyKey: randomUUID(), body: {
      actor: human,
      expected_version: draft.data.data.version,
      title: title ?? `Issue #125 ${randomUUID().slice(0, 8)}`,
      description: "Synthetic HTTP/PostgreSQL regression Event.",
      venue: { name: "Issue #125 local venue", address: null },
      starts_at: startsAt,
      ends_at: endsAt,
      time_zone: "UTC",
      check_in_opens_at: new Date(now - 2 * 60 * 60_000).toISOString(),
      visibility,
      ticket_offering: {
        price: { amount: price, currency: "USD" },
        tax_amount: tax,
        buyer_fees: buyerFees,
        capacity,
        sales_opens_at: new Date(now - 2 * 60 * 60_000).toISOString(),
        sales_closes_at: salesClosesAt ?? endsAt,
      },
    },
  });
  assert(saved.status === 200, `Could not configure ${title ?? "verification"} Event: ${JSON.stringify(saved.data)}`);
  const published = await api(site, `/v1/admin/events/${draft.data.data.event_id}/actions/publish`, {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: human, expected_version: saved.data.data.version },
  });
  assert(published.status === 200, `Could not publish ${title ?? "verification"} Event: ${JSON.stringify(published.data)}`);
  return published.data.data;
}

async function createOrder(site, event, quantity, email) {
  const quote = await api(site, `/v1/public/events/${event.event_id}/quotes`, {
    method: "POST", idempotencyKey: randomUUID(), body: { quantity },
  });
  return { quote, order: quote.status === 201 ? await api(site, "/v1/public/orders", {
    method: "POST", idempotencyKey: randomUUID(), body: {
      quote_id: quote.data.data.quote_id,
      buyer: { name: "Issue #125 Group Buyer", email },
    },
  }) : null };
}

async function createPaymentAttempt(site, order) {
  const orderData = order.data?.data ?? order;
  const attempt = await api(site, `/v1/admin/orders/${orderData.order_id}/payment-attempts`, {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: system },
  });
  assert(attempt.status === 201, `Could not create a payment attempt: ${JSON.stringify(attempt.data)}`);
  const checkoutReference = `issue-125-checkout-${randomUUID()}`;
  const registered = await api(site, `/v1/admin/payment-attempts/${attempt.data.data.attempt_id}/checkout-reference`, {
    method: "POST", idempotencyKey: randomUUID(), body: {
      actor: system,
      connection_id: site.connectionId,
      provider_checkout_reference: checkoutReference,
      provider_can_take_payment: true,
    },
  });
  assert(registered.status === 200, `Could not register the synthetic checkout: ${JSON.stringify(registered.data)}`);
  return { attempt: attempt.data.data, checkoutReference };
}

async function reportPaid(site, order, payment, { triggerFailure = false } = {}) {
  const orderData = order.data?.data ?? order;
  const observedAt = new Date().toISOString();
  const body = {
    connection_id: site.connectionId,
    source_reference: `issue-125-payment-${randomUUID()}`,
    provider_checkout_reference: payment.checkoutReference,
    provider_payment_reference: `issue-125-provider-payment-${randomUUID()}`,
    outcome: "paid",
    observed_at: observedAt,
    payment_started_at: observedAt,
    provider_can_take_payment: false,
    amount: orderData.pricing.total.amount,
    currency: orderData.pricing.total.currency,
  };
  let trigger;
  if (triggerFailure) {
    const suffix = randomUUID().replaceAll("-", "");
    trigger = { functionName: `hpos.issue125_reject_${suffix}`, triggerName: `issue125_reject_${suffix}` };
    triggerFixtures.push(trigger);
  }
  const idempotencyKey = randomUUID();
  let response;
  let primaryError;
  try {
    if (trigger) {
      await pool.query(`create function ${trigger.functionName}() returns trigger language plpgsql as $$
        begin
          if new.kind = 'tickets_ready' and new.order_id = '${orderData.order_id}'::uuid then
            raise exception 'issue #125 injected issuance interruption';
          end if;
          return new;
        end;
      $$`);
      await pool.query(`create trigger ${trigger.triggerName} before insert on hpos.notification_jobs for each row execute function ${trigger.functionName}()`);
    }
    response = await api(site, `/v1/admin/payment-attempts/${payment.attempt.attempt_id}/payment-reports`, {
      method: "POST", idempotencyKey, body,
    });
    assert(response.status === 201, `The paid synthetic report was not accepted: ${JSON.stringify(response.data)}`);
  } catch (error) {
    primaryError = error;
  }
  let teardownError;
  if (trigger) {
    try {
      await dropTriggerFixture(trigger);
    } catch (error) {
      teardownError = error;
    }
  }
  if (primaryError && teardownError) throw new AggregateError([primaryError, teardownError], "The payment report and injected trigger teardown both failed.");
  if (primaryError) throw primaryError;
  if (teardownError) throw teardownError;
  return { body, idempotencyKey, response };
}

async function currentWalletJobs(site, ticketId = null) {
  const query = ticketId
    ? `select * from hpos.notification_jobs where site_id = $1 and kind = 'wallet_update' and ticket_id = $2 order by created_at, id`
    : `select * from hpos.notification_jobs where site_id = $1 and kind = 'wallet_update' order by created_at, id`;
  const result = await pool.query(query, ticketId ? [site.siteId, ticketId] : [site.siteId]);
  return result.rows;
}

async function currentWalletJobsFromAdmin(site, ticketId) {
  const response = await api(site, "/v1/admin/notification-jobs?kind=wallet_update&limit=100");
  assert(response.status === 200, `The admin Wallet job list could not be read for Ticket ${ticketId}.`);
  return listData(response).filter((job) => job.kind === "wallet_update" && job.ticket_id === ticketId);
}

async function assertWalletJobState(site, ticketId, expectedCount, dataVersion, label) {
  const [sqlJobs, adminJobs] = await Promise.all([
    currentWalletJobs(site, ticketId),
    currentWalletJobsFromAdmin(site, ticketId),
  ]);
  const matching = adminJobs.filter((job) => job.payload?.data_version === dataVersion);
  const expectedCurrentVersionJobs = expectedCount === 0 ? matching.length === 0 : matching.length === 1;
  assert(sqlJobs.length === expectedCount && adminJobs.length === expectedCount && expectedCurrentVersionJobs,
    `${label} did not leave exactly ${expectedCount} Wallet job(s) for Ticket ${ticketId} with the current data_version.`);
}

function walletEventSnapshot(event) {
  const offering = event?.ticket_offering ?? {};
  return {
    event_id: event?.event_id,
    title: event?.title,
    description: event?.description ?? null,
    venue: {
      name: event?.venue?.name ?? null,
      address: event?.venue?.address ?? null,
    },
    starts_at: event?.starts_at ?? null,
    ends_at: event?.ends_at ?? null,
    time_zone: event?.time_zone ?? null,
    check_in_opens_at: event?.check_in_opens_at ?? null,
    visibility: event?.visibility ?? null,
    purchase_mode: event?.purchase_mode ?? null,
    sales_status: event?.sales_status ?? null,
    is_canceled: event?.is_canceled ?? false,
    is_archived: event?.is_archived ?? false,
    ticket_offering: {
      price: offering.price ?? null,
      max_quantity_per_order: offering.max_quantity_per_order ?? null,
    },
  };
}

function assertWalletEvent(wallet, ticket, expectedEvent, label) {
  const data = wallet.data?.data;
  const event = data?.event;
  const actualSnapshot = walletEventSnapshot(event);
  const expectedSnapshot = walletEventSnapshot(expectedEvent);
  assert(wallet.status === 200
    && data?.ticket_id === ticket.ticket_id
    && data?.qr_payload === ticket.qr_payload
    && JSON.stringify(actualSnapshot) === JSON.stringify(expectedSnapshot),
  `${label} did not retain the stable QR or current Event fields for Ticket ${ticket.ordinal}: actual=${JSON.stringify(actualSnapshot)} expected=${JSON.stringify(expectedSnapshot)}`);
}

async function verifyGroupOrder(site, otherSite) {
  const event = await createPublishedEvent(site, { title: "Issue #125 public group purchase", capacity: 16 });
  const expected = (quantity) => ({
    subtotal: 2500 * quantity,
    buyerFees: 125 * quantity,
    tax: 300 * quantity,
    total: 2925 * quantity,
    platformFee: 250 * quantity,
  });
  const orders = [];
  for (const quantity of [1, 2, 8]) {
    const result = await createOrder(site, event, quantity, `issue-125-${quantity}-${randomUUID().slice(0, 8)}@example.invalid`);
    assert(result.quote.status === 201 && result.order?.status === 201, `Quantity ${quantity} did not produce a quote and Order.`);
    const quote = result.quote.data.data;
    const order = result.order.data.data;
    const totals = expected(quantity);
    assert(quote.quantity === quantity && quote.subtotal.amount === totals.subtotal
      && quote.tax_total.amount === totals.tax && quote.buyer_fees[0]?.amount === totals.buyerFees
      && quote.total.amount === totals.total && quote.platform_fee.amount === totals.platformFee,
    `Quantity ${quantity} did not scale quote pricing correctly: ${JSON.stringify(quote)}`);
    assert(order.quantity === quantity && order.reservation?.quantity === quantity
      && order.reservation.status === "held" && order.pricing.total.amount === totals.total
      && order.pricing.tax_total.amount === totals.tax && order.pricing.buyer_fees[0]?.amount === totals.buyerFees,
    `Quantity ${quantity} did not preserve accepted pricing and Reservation terms.`);
    const admin = await api(site, `/v1/admin/orders/${order.order_id}`);
    const acceptedTerms = await pool.query("select accepted_quote from hpos.orders where id = $1", [order.order_id]);
    assert(admin.status === 200 && admin.data.data.pricing.quantity === quantity
      && admin.data.data.reservation.quantity === quantity,
    `Admin Order ${quantity} did not expose accepted quantity and Reservation terms.`);
    assert(acceptedTerms.rows[0]?.accepted_quote?.quantity === quantity
      && acceptedTerms.rows[0].accepted_quote.subtotal.amount === totals.subtotal
      && acceptedTerms.rows[0].accepted_quote.tax_total.amount === totals.tax
      && acceptedTerms.rows[0].accepted_quote.buyer_fees[0]?.amount === totals.buyerFees
      && acceptedTerms.rows[0].accepted_quote.total.amount === totals.total
      && acceptedTerms.rows[0].accepted_quote.platform_fee.amount === totals.platformFee,
    `Quantity ${quantity} did not persist the accepted quote terms.`);
    orders.push({ order, quote, admin });
  }

  for (const quantity of [0, 9, 1.5]) {
    const rejected = await api(site, `/v1/public/events/${event.event_id}/quotes`, {
      method: "POST", idempotencyKey: randomUUID(), body: { quantity },
    });
    assert(rejected.status === 422 && rejected.data?.error?.code === "validation_failed",
      `Out-of-range quantity ${quantity} was accepted.`);
  }

  const group = orders.find((item) => item.order.quantity === 8);
  const payment = await createPaymentAttempt(site, group.order);
  const paid = await reportPaid(site, group.order, payment, { triggerFailure: true });
  const interrupted = await pool.query(
    `select payment_status, issuance_status,
            (select count(*)::integer from hpos.tickets where order_id = orders.id) as tickets
     from hpos.orders where id = $1`,
    [group.order.order_id],
  );
  assert(interrupted.rows[0]?.payment_status === "paid" && interrupted.rows[0]?.issuance_status === "failed"
    && interrupted.rows[0]?.tickets === 0,
  "An interrupted group issuance lost payment state or exposed a partial Ticket set.");
  const failedAdmin = await api(site, `/v1/admin/orders/${group.order.order_id}`);
  assert(failedAdmin.status === 200 && failedAdmin.data.data.payment_status === "paid"
    && failedAdmin.data.data.issuance_status === "failed"
    && failedAdmin.data.data.tickets.length === 0
    && failedAdmin.data.data.issues.some((item) => item.code === "ticket_issuance_failed" && item.status === "open"),
  "An interrupted paid group Order did not retain durable issuance failure evidence.");

  const duplicateReports = await Promise.all([
    api(site, `/v1/admin/payment-attempts/${payment.attempt.attempt_id}/payment-reports`, { method: "POST", idempotencyKey: randomUUID(), body: paid.body }),
    api(site, `/v1/admin/payment-attempts/${payment.attempt.attempt_id}/payment-reports`, { method: "POST", idempotencyKey: randomUUID(), body: paid.body }),
    api(site, `/v1/admin/payment-attempts/${payment.attempt.attempt_id}/payment-reports`, { method: "POST", idempotencyKey: paid.idempotencyKey, body: paid.body }),
  ]);
  const recoveredRuns = await Promise.all([fetch(`${origin}/api/cron/process`), fetch(`${origin}/api/cron/process`)]);
  assert(duplicateReports.every((response) => response.status === 200 || response.status === 201), "A duplicate payment report did not replay safely.");
  assert(recoveredRuns.every((response) => response.status === 200), "Overlapping local recovery runs did not complete successfully.");
  const buyer = await api(site, `/v1/public/orders/${group.order.order_token}`);
  const tickets = buyer.data.data.tickets;
  assert(buyer.status === 200 && buyer.data.data.payment_status === "paid" && buyer.data.data.issuance_status === "issued"
    && tickets.length === 8 && tickets.every((ticket, index) => ticket.ordinal === index + 1),
  "A paid group Order did not issue its complete ordered Ticket set.");
  assert(new Set(tickets.map((ticket) => ticket.ticket_id)).size === 8
    && new Set(tickets.map((ticket) => ticket.ticket_token)).size === 8
    && new Set(tickets.map((ticket) => ticket.qr_payload)).size === 8
    && tickets.every((ticket) => ticket.ticket_token !== group.order.order_token && !ticket.qr_payload.includes("@")),
  "Group Tickets did not receive distinct page and QR identities.");
  const jobs = await pool.query(`select count(*)::integer as count from hpos.notification_jobs where site_id = $1 and order_id = $2 and kind = 'tickets_ready'`, [site.siteId, group.order.order_id]);
  assert(jobs.rows[0]?.count === 1, "Group issuance created more than one initial Order email job.");
  const duplicateState = await pool.query(
    `select (select count(*)::integer from hpos.tickets where order_id = orders.id) as tickets,
            (select count(*)::integer from hpos.notification_jobs where order_id = orders.id and kind = 'tickets_ready') as jobs
     from hpos.orders where id = $1`, [group.order.order_id],
  );
  assert(duplicateState.rows[0]?.tickets === 8 && duplicateState.rows[0]?.jobs === 1, "Duplicate payment reports created partial or duplicate fulfillment state.");

  const initialTicketJobs = await api(site, `/v1/admin/notification-jobs?order_id=${group.order.order_id}&kind=tickets_ready&limit=100`);
  const initialTicketJobRows = listData(initialTicketJobs).filter((job) => job.kind === "tickets_ready");
  assert(initialTicketJobs.status === 200 && initialTicketJobRows.length === 1,
    "The initial tickets_ready job count was not exactly one through the admin HTTP endpoint.");

  const initialWalletEvent = event;
  const initialWallet = new Map();
  const walletJobCounts = new Map();
  for (const ticket of tickets) {
    const publicWallet = await api(site, `/v1/public/tickets/${ticket.ticket_token}/apple-wallet-data`);
    const adminWallet = await api(site, `/v1/admin/tickets/${ticket.ticket_id}/apple-wallet-data`);
    assertWalletEvent(publicWallet, ticket, initialWalletEvent, "Initial Wallet data");
    assertWalletEvent(adminWallet, ticket, initialWalletEvent, "Initial admin Wallet data");
    assert(publicWallet.status === 200 && adminWallet.status === 200
      && publicWallet.data.data.data_version === adminWallet.data.data.data_version
      && publicWallet.data.data.used === false && publicWallet.data.data.voided === false
      && !JSON.stringify(publicWallet.data.data).includes(group.order.delivery_email),
    `Wallet data for Ticket ${ticket.ordinal} was incomplete or exposed buyer email.`);
    const foreignPublic = await api(otherSite, `/v1/public/tickets/${ticket.ticket_token}/apple-wallet-data`);
    const foreignAdmin = await api(otherSite, `/v1/admin/tickets/${ticket.ticket_id}/apple-wallet-data`);
    assert(foreignPublic.status === 404 && foreignAdmin.status === 404, "Wallet reads crossed the Site boundary.");
    initialWallet.set(ticket.ticket_id, publicWallet.data.data.data_version);
    const initialJobs = await currentWalletJobs(site, ticket.ticket_id);
    await assertWalletJobState(site, ticket.ticket_id, initialJobs.length, publicWallet.data.data.data_version, "Initial issuance");
    walletJobCounts.set(ticket.ticket_id, initialJobs.length);
    const page = await api(site, `/v1/public/tickets/${ticket.ticket_token}`);
    assert(page.status === 200 && page.data.data.ticket_id === ticket.ticket_id && page.data.data.ordinal === ticket.ordinal, "A group Ticket page was not independently readable.");
  }

  for (const ticket of tickets) {
    const admission = await api(site, `/v1/admin/events/${event.event_id}/admissions`, {
      method: "POST", idempotencyKey: randomUUID(), body: { actor: human, qr_token: ticket.qr_payload },
    });
    assert(admission.status === 201 && admission.data.data.ticket_id === ticket.ticket_id, `Ticket ${ticket.ordinal} could not be admitted independently.`);
    const repeat = await api(site, `/v1/admin/events/${event.event_id}/admissions`, {
      method: "POST", idempotencyKey: randomUUID(), body: { actor: human, qr_token: ticket.qr_payload },
    });
    assert(repeat.status === 409 && repeat.data?.error?.code === "already_admitted", `Ticket ${ticket.ordinal} accepted a second Admission.`);
    const wallet = await api(site, `/v1/public/tickets/${ticket.ticket_token}/apple-wallet-data`);
    const adminWallet = await api(site, `/v1/admin/tickets/${ticket.ticket_id}/apple-wallet-data`);
    assertWalletEvent(wallet, ticket, initialWalletEvent, "Admission Wallet data");
    assertWalletEvent(adminWallet, ticket, initialWalletEvent, "Admission admin Wallet data");
    assert(wallet.data.data.used === true && wallet.data.data.voided === false
      && adminWallet.data.data.data_version === wallet.data.data.data_version
      && wallet.data.data.data_version !== initialWallet.get(ticket.ticket_id),
    `Admission did not update Wallet state for Ticket ${ticket.ordinal}.`);
    const expectedJobCount = walletJobCounts.get(ticket.ticket_id) + 1;
    await assertWalletJobState(site, ticket.ticket_id, expectedJobCount, wallet.data.data.data_version, `Admission for Ticket ${ticket.ordinal}`);
    walletJobCounts.set(ticket.ticket_id, expectedJobCount);
  }

  const beforeEventEdit = await api(site, `/v1/admin/events/${event.event_id}`);
  const beforeEventEditVersions = new Map();
  for (const ticket of tickets) {
    const beforeWallet = await api(site, `/v1/admin/tickets/${ticket.ticket_id}/apple-wallet-data`);
    assertWalletEvent(beforeWallet, ticket, initialWalletEvent, "Pre-event-edit Wallet data");
    beforeEventEditVersions.set(ticket.ticket_id, beforeWallet.data.data.data_version);
  }
  const edited = await api(site, `/v1/admin/events/${event.event_id}`, {
    method: "PATCH", idempotencyKey: randomUUID(), body: {
      actor: human, expected_version: beforeEventEdit.data.data.version,
      venue: { name: "Issue #125 changed Wallet venue", address: "Local synthetic address" },
    },
  });
  assert(edited.status === 200 && edited.data.data.venue?.name === "Issue #125 changed Wallet venue"
    && edited.data.data.venue?.address === "Local synthetic address", "A pass-visible Event edit could not be applied.");
  const editedWalletEvent = edited.data.data;
  for (const ticket of tickets) {
    const wallet = await api(site, `/v1/admin/tickets/${ticket.ticket_id}/apple-wallet-data`);
    const publicWallet = await api(site, `/v1/public/tickets/${ticket.ticket_token}/apple-wallet-data`);
    assertWalletEvent(wallet, ticket, editedWalletEvent, "Event-change Wallet data");
    assertWalletEvent(publicWallet, ticket, editedWalletEvent, "Event-change public Wallet data");
    assert(wallet.status === 200 && publicWallet.status === 200
      && wallet.data.data.data_version === publicWallet.data.data.data_version
      && wallet.data.data.data_version !== beforeEventEditVersions.get(ticket.ticket_id),
    `Event change did not update current Event fields in Wallet data for Ticket ${ticket.ordinal}.`);
    const expectedJobCount = walletJobCounts.get(ticket.ticket_id) + 1;
    await assertWalletJobState(site, ticket.ticket_id, expectedJobCount, wallet.data.data.data_version, `Event change for Ticket ${ticket.ordinal}`);
    walletJobCounts.set(ticket.ticket_id, expectedJobCount);
  }

  const walletCountBeforePartial = (await currentWalletJobs(site)).length;
  const partialAmount = 1000;
  const partial = await api(site, `/v1/admin/orders/${group.order.order_id}/refund-reports`, {
    method: "POST", idempotencyKey: randomUUID(), body: {
      attempt_id: payment.attempt.attempt_id,
      connection_id: site.connectionId,
      provider_payment_reference: paid.body.provider_payment_reference,
      provider_refund_reference: `issue-125-partial-refund-${randomUUID()}`,
      source_reference: `issue-125-partial-source-${randomUUID()}`,
      outcome: "completed", amount: partialAmount, currency: "USD", observed_at: new Date().toISOString(),
    },
  });
  assert(partial.status === 201, `The partial refund report was not accepted: ${JSON.stringify(partial.data)}`);
  const partialOrder = await api(site, `/v1/admin/orders/${group.order.order_id}`);
  assert(partialOrder.data.data.refund_status === "partial" && (await currentWalletJobs(site)).length === walletCountBeforePartial, "A partial refund changed Wallet state or queued Wallet work.");
  for (const ticket of tickets) {
    const wallet = await api(site, `/v1/admin/tickets/${ticket.ticket_id}/apple-wallet-data`);
    const publicWallet = await api(site, `/v1/public/tickets/${ticket.ticket_token}/apple-wallet-data`);
    assertWalletEvent(wallet, ticket, editedWalletEvent, "Partial-refund Wallet data");
    assertWalletEvent(publicWallet, ticket, editedWalletEvent, "Partial-refund public Wallet data");
    assert(wallet.data.data.voided === false
      && publicWallet.data.data.voided === false
      && wallet.data.data.data_version === publicWallet.data.data.data_version,
    `A partial refund changed Wallet state for Ticket ${ticket.ordinal}.`);
    await assertWalletJobState(site, ticket.ticket_id, walletJobCounts.get(ticket.ticket_id), wallet.data.data.data_version, `Partial refund for Ticket ${ticket.ordinal}`);
  }

  const ticketEmailJobs = await api(site, `/v1/admin/notification-jobs?order_id=${group.order.order_id}&kind=tickets_ready&limit=100`);
  const ticketEmailJob = listData(ticketEmailJobs).find((job) => !job.is_superseded);
  const claim = await api(site, "/v1/admin/notification-jobs/claims", {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: system, limit: 10, kinds: ["tickets_ready"] },
  });
  const claimed = listData(claim).find((job) => job.job_id === ticketEmailJob.job_id);
  assert(claim.status === 200 && claimed, "The initial group email job could not be claimed for correction coverage.");
  const outcome = await api(site, `/v1/admin/notification-jobs/${ticketEmailJob.job_id}/outcome-reports`, {
    method: "POST", idempotencyKey: randomUUID(), body: {
      actor: system, claim_id: claim.data.data.claim_id, lease_fence: claimed.lease_fence,
      outcome: "completed", provider_message_reference: `issue-125-email-${randomUUID()}`,
      observed_at: new Date().toISOString(), error_code: null,
    },
  });
  assert(outcome.status === 200, "The synthetic email completion report was not accepted.");
  const dispatchReference = outcome.data.data.provider_message_reference;
  const delivery = await api(site, `/v1/admin/notification-jobs/${ticketEmailJob.job_id}/delivery-reports`, {
    method: "POST", idempotencyKey: randomUUID(), body: {
      actor: system, outcome: "failed", provider_message_reference: dispatchReference,
      provider_event_reference: `issue-125-email-event-${randomUUID()}`, observed_at: new Date().toISOString(),
    },
  });
  assert(delivery.status === 200, "The synthetic email failure report was not accepted.");
  const beforeCorrection = await api(site, `/v1/admin/orders/${group.order.order_id}`);
  const correction = await api(site, `/v1/admin/orders/${group.order.order_id}/actions/correct_delivery_email`, {
    method: "POST", idempotencyKey: randomUUID(), body: {
      actor: human, expected_version: beforeCorrection.data.data.version,
      email: `issue-125-corrected-${randomUUID().slice(0, 8)}@example.invalid`,
      reason: "Synthetic verifier correction evidence.", verification_reference: `issue-125-verification-${randomUUID()}`,
    },
  });
  assert(correction.status === 202 && (await currentWalletJobs(site)).length === walletCountBeforePartial + 0, "Email correction changed Wallet state or queued Wallet work.");

  // Email correction rotates buyer-facing Order/Ticket links. Read the current
  // Order token from the replacement job before checking the post-correction
  // Wallet state; the original ticket page tokens must no longer be used.
  const replacementJobs = await api(site, `/v1/admin/notification-jobs?order_id=${group.order.order_id}&kind=tickets_ready&limit=100`);
  const replacementJob = listData(replacementJobs).find((job) => !job.is_superseded);
  assert(replacementJob?.payload?.order?.order_token, "Email correction did not expose the replacement Order token.");
  const correctedOrder = await api(site, `/v1/public/orders/${replacementJob.payload.order.order_token}`);
  assert(correctedOrder.status === 200 && correctedOrder.data.data.tickets.length === tickets.length, "The corrected Order did not expose the complete Ticket set.");
  const correctedTickets = correctedOrder.data.data.tickets;
  assert(correctedTickets.every((ticket, index) => ticket.ticket_id === tickets[index].ticket_id), "Email correction changed Ticket identities.");
  for (const ticket of tickets) {
    const wallet = await api(site, `/v1/admin/tickets/${ticket.ticket_id}/apple-wallet-data`);
    const correctedTicket = correctedTickets.find((candidate) => candidate.ticket_id === ticket.ticket_id);
    const publicWallet = await api(site, `/v1/public/tickets/${correctedTicket.ticket_token}/apple-wallet-data`);
    assertWalletEvent(wallet, ticket, editedWalletEvent, "Email-correction Wallet data");
    assertWalletEvent(publicWallet, correctedTicket, editedWalletEvent, "Email-correction public Wallet data");
    assert(wallet.data.data.voided === false
      && publicWallet.data.data.voided === false
      && wallet.data.data.data_version === publicWallet.data.data.data_version,
    `Email correction changed Wallet state for Ticket ${ticket.ordinal}.`);
    await assertWalletJobState(site, ticket.ticket_id, walletJobCounts.get(ticket.ticket_id), wallet.data.data.data_version, `Email correction for Ticket ${ticket.ordinal}`);
  }

  const beforeFullRefundVersions = new Map();
  for (const ticket of correctedTickets) {
    const wallet = await api(site, `/v1/public/tickets/${ticket.ticket_token}/apple-wallet-data`);
    assertWalletEvent(wallet, ticket, editedWalletEvent, "Pre-full-refund Wallet data");
    beforeFullRefundVersions.set(ticket.ticket_id, wallet.data.data.data_version);
  }
  const full = await api(site, `/v1/admin/orders/${group.order.order_id}/refund-reports`, {
    method: "POST", idempotencyKey: randomUUID(), body: {
      attempt_id: payment.attempt.attempt_id,
      connection_id: site.connectionId,
      provider_payment_reference: paid.body.provider_payment_reference,
      provider_refund_reference: `issue-125-full-refund-${randomUUID()}`,
      source_reference: `issue-125-full-source-${randomUUID()}`,
      outcome: "completed", amount: group.order.pricing.total.amount - partialAmount, currency: "USD", observed_at: new Date().toISOString(),
    },
  });
  assert(full.status === 201, `The full refund report was not accepted: ${JSON.stringify(full.data)}`);
  const refundedOrder = await api(site, `/v1/admin/orders/${group.order.order_id}`);
  assert(refundedOrder.status === 200 && refundedOrder.data.data.refund_status === "full", "The full refund did not update Order state.");
  for (const ticket of correctedTickets) {
    const wallet = await api(site, `/v1/public/tickets/${ticket.ticket_token}/apple-wallet-data`);
    const adminWallet = await api(site, `/v1/admin/tickets/${ticket.ticket_id}/apple-wallet-data`);
    assertWalletEvent(wallet, ticket, editedWalletEvent, "Full-refund Wallet data");
    assertWalletEvent(adminWallet, ticket, editedWalletEvent, "Full-refund admin Wallet data");
    assert(wallet.data.data.voided === true
      && adminWallet.data.data.voided === true
      && wallet.data.data.data_version === adminWallet.data.data.data_version
      && wallet.data.data.data_version !== beforeFullRefundVersions.get(ticket.ticket_id),
    `Full refund did not update Wallet data for Ticket ${ticket.ordinal}.`);
    const expectedJobCount = walletJobCounts.get(ticket.ticket_id) + 1;
    await assertWalletJobState(site, ticket.ticket_id, expectedJobCount, wallet.data.data.data_version, `Full refund for Ticket ${ticket.ordinal}`);
    walletJobCounts.set(ticket.ticket_id, expectedJobCount);
  }

  return { event, group, tickets };
}

async function verifyCancellation(site) {
  const event = await createPublishedEvent(site, { title: "Issue #125 cancellation Wallet", capacity: 1 });
  const result = await createOrder(site, event, 1, `issue-125-cancel-${randomUUID().slice(0, 8)}@example.invalid`);
  assert(result.order.status === 201, "The cancellation fixture could not create an Order.");
  const payment = await createPaymentAttempt(site, result.order);
  const paid = await reportPaid(site, result.order, payment);
  const buyer = await api(site, `/v1/public/orders/${result.order.data.data.order_token}`);
  const ticket = buyer.data.data.tickets[0];
  const before = await currentWalletJobs(site, ticket.ticket_id);
  const current = await api(site, `/v1/admin/events/${event.event_id}`);
  assert(current.status === 200, "The cancellation fixture Event could not be reloaded before cancellation.");
  const beforeCancelWallet = await api(site, `/v1/public/tickets/${ticket.ticket_token}/apple-wallet-data`);
  const beforeCancelAdminWallet = await api(site, `/v1/admin/tickets/${ticket.ticket_id}/apple-wallet-data`);
  assertWalletEvent(beforeCancelWallet, ticket, current.data.data, "Pre-cancellation Wallet data");
  assertWalletEvent(beforeCancelAdminWallet, ticket, current.data.data, "Pre-cancellation admin Wallet data");
  assert(beforeCancelWallet.data.data.data_version === beforeCancelAdminWallet.data.data.data_version,
    "Public and admin Wallet versions differed before Event cancellation.");
  const canceled = await api(site, `/v1/admin/events/${event.event_id}/actions/cancel`, {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: human, expected_version: current.data.data.version },
  });
  assert(canceled.status === 200 && canceled.data.data.is_canceled === true, "The cancellation fixture did not cancel the Event.");
  const wallet = await api(site, `/v1/public/tickets/${ticket.ticket_token}/apple-wallet-data`);
  const adminWallet = await api(site, `/v1/admin/tickets/${ticket.ticket_id}/apple-wallet-data`);
  const jobs = await currentWalletJobs(site, ticket.ticket_id);
  assertWalletEvent(wallet, ticket, canceled.data.data, "Cancellation Wallet data");
  assertWalletEvent(adminWallet, ticket, canceled.data.data, "Cancellation admin Wallet data");
  assert(wallet.data.data.voided === true && jobs.length === before.length + 1
    && adminWallet.data.data.voided === true
    && wallet.data.data.data_version === adminWallet.data.data.data_version
    && wallet.data.data.data_version !== beforeCancelWallet.data.data.data_version
    && jobs.some((job) => job.payload?.data_version === wallet.data.data.data_version),
  "Event cancellation did not queue exactly one current voided Wallet update for the Ticket.");
  await assertWalletJobState(site, ticket.ticket_id, before.length + 1, wallet.data.data.data_version, "Event cancellation");
  const archived = await api(site, `/v1/admin/events/${event.event_id}/actions/archive`, {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: human, expected_version: canceled.data.data.version },
  });
  assert(archived.status === 200 && archived.data.data.is_archived === true, "The canceled Event could not be archived.");
  const archivedWallet = await api(site, `/v1/public/tickets/${ticket.ticket_token}/apple-wallet-data`);
  const archivedAdminWallet = await api(site, `/v1/admin/tickets/${ticket.ticket_id}/apple-wallet-data`);
  const archivedJobs = await currentWalletJobs(site, ticket.ticket_id);
  assertWalletEvent(archivedWallet, ticket, archived.data.data, "Archival Wallet data");
  assertWalletEvent(archivedAdminWallet, ticket, archived.data.data, "Archival admin Wallet data");
  assert(archivedWallet.data.data.voided === true
    && archivedAdminWallet.data.data.voided === true
    && archivedWallet.data.data.data_version === archivedAdminWallet.data.data.data_version
    && archivedWallet.data.data.data_version !== wallet.data.data.data_version
    && archivedJobs.length === before.length + 2
    && archivedJobs.some((job) => job.payload?.data_version === archivedWallet.data.data.data_version),
  "Event archival did not queue exactly one current Wallet update for the Ticket.");
  await assertWalletJobState(site, ticket.ticket_id, before.length + 2, archivedWallet.data.data.data_version, "Event archival");
  assert(paid.body.provider_payment_reference, "The cancellation fixture did not retain its synthetic payment reference.");
}

async function verifyCapacityRace(site) {
  const event = await createPublishedEvent(site, { title: "Issue #125 last capacity", capacity: 1 });
  const firstQuote = await api(site, `/v1/public/events/${event.event_id}/quotes`, { method: "POST", idempotencyKey: randomUUID(), body: { quantity: 1 } });
  const secondQuote = await api(site, `/v1/public/events/${event.event_id}/quotes`, { method: "POST", idempotencyKey: randomUUID(), body: { quantity: 1 } });
  assert(firstQuote.status === 201 && secondQuote.status === 201, "The capacity race could not create two pre-reservation quotes.");
  const responses = await Promise.all([
    api(site, "/v1/public/orders", { method: "POST", idempotencyKey: randomUUID(), body: { quote_id: firstQuote.data.data.quote_id, buyer: { name: "Issue #125 Race", email: `race-a-${randomUUID()}@example.invalid` } } }),
    api(site, "/v1/public/orders", { method: "POST", idempotencyKey: randomUUID(), body: { quote_id: secondQuote.data.data.quote_id, buyer: { name: "Issue #125 Race", email: `race-b-${randomUUID()}@example.invalid` } } }),
  ]);
  const accepted = responses.filter((response) => response.status === 201);
  const rejected = responses.filter((response) => response.status === 409);
  assert(accepted.length === 1 && rejected.length === 1 && ["sold_out", "insufficient_capacity"].includes(rejected[0].data?.error?.code), "Concurrent Orders oversold the last capacity or returned an unexpected result.");
  const current = await api(site, `/v1/admin/events/${event.event_id}`);
  const canceled = await api(site, `/v1/admin/events/${event.event_id}/actions/cancel`, { method: "POST", idempotencyKey: randomUUID(), body: { actor: human, expected_version: current.data.data.version } });
  assert(canceled.status === 200, "The winning unpaid capacity-race fixture could not be released by cancellation.");
}

async function verifyPrivateCheckout(site) {
  const event = await createPublishedEvent(site, { title: "Issue #125 private one Ticket", visibility: "private", capacity: 2 });
  const attendee = { name: "Issue #125 Approved Attendee", email: `attendee-${randomUUID().slice(0, 8)}@example.invalid` };
  const request = await api(site, `/v1/public/events/${event.event_id}/access-requests`, { method: "POST", idempotencyKey: randomUUID(), body: attendee });
  assert(request.status === 201, "The private Access Request could not be created.");
  const list = await api(site, `/v1/admin/events/${event.event_id}/access-requests?limit=100`);
  const row = listData(list).find((item) => item.name === attendee.name && item.email === attendee.email);
  assert(row, "The private Access Request was not visible to staff.");
  const approved = await api(site, `/v1/admin/access-requests/${row.request_id}/actions/approve`, { method: "POST", idempotencyKey: randomUUID(), body: { actor: human, expected_version: row.version } });
  assert(approved.status === 200, "The private Access Request could not be approved.");
  const jobs = await api(site, `/v1/admin/notification-jobs?event_id=${event.event_id}&kind=access_approved&limit=100`);
  const token = listData(jobs).find((job) => job.access_request_id === row.request_id)?.payload?.approval_token;
  assert(token, "The approval did not create an approval-link job.");
  const rejected = await api(site, `/v1/public/events/${event.event_id}/quotes`, { method: "POST", idempotencyKey: randomUUID(), body: { quantity: 2, access_request_token: token } });
  assert(rejected.status === 422 && rejected.data?.error?.code === "validation_failed", "Private checkout accepted more than one Ticket.");
  const quote = await api(site, `/v1/public/events/${event.event_id}/quotes`, { method: "POST", idempotencyKey: randomUUID(), body: { quantity: 1, access_request_token: token } });
  assert(quote.status === 201, "Private one-Ticket checkout could not create its quote.");
  const order = await api(site, "/v1/public/orders", { method: "POST", idempotencyKey: randomUUID(), body: { quote_id: quote.data.data.quote_id, access_request_token: token, buyer: { name: "Issue #125 Purchaser", email: `private-${randomUUID().slice(0, 8)}@example.invalid` } } });
  assert(order.status === 201 && order.data.data.quantity === 1 && order.data.data.reservation.quantity === 1, "Private checkout did not retain its one-Ticket limit.");
}

async function verifyClockOnlySales(site) {
  const salesClosesAt = new Date(Date.now() + 5_000).toISOString();
  const event = await createPublishedEvent(site, { title: "Issue #125 clock-only Wallet", capacity: 1, salesClosesAt });
  const result = await createOrder(site, event, 1, `issue-125-clock-${randomUUID().slice(0, 8)}@example.invalid`);
  const payment = await createPaymentAttempt(site, result.order);
  await reportPaid(site, result.order, payment);
  const buyer = await api(site, `/v1/public/orders/${result.order.data.data.order_token}`);
  const ticket = buyer.data.data.tickets[0];
  const before = await api(site, `/v1/public/tickets/${ticket.ticket_token}/apple-wallet-data`);
  const jobsBefore = (await currentWalletJobs(site, ticket.ticket_id)).length;
  await assertWalletJobState(site, ticket.ticket_id, jobsBefore, before.data.data.data_version, "Clock-only sales baseline");
  await delay(6_000);
  const after = await api(site, `/v1/public/tickets/${ticket.ticket_token}/apple-wallet-data`);
  const jobsAfter = (await currentWalletJobs(site, ticket.ticket_id)).length;
  assert(before.data.data.data_version === after.data.data.data_version && jobsBefore === jobsAfter, "Clock-only sales availability created Wallet update work or changed data_version.");
  await assertWalletJobState(site, ticket.ticket_id, jobsBefore, after.data.data.data_version, "Clock-only sales transition");
}

async function cleanupOrganizations() {
  if (!organizationIds.length) return;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const sites = await client.query("select id from hpos.sites where organization_id = any($1::uuid[])", [organizationIds]);
    for (const row of sites.rows) if (!siteIds.includes(row.id)) siteIds.push(row.id);
    await client.query("update hpos.access_requests set paid_order_id = null where site_id = any($1::uuid[])", [siteIds]);
    await client.query("update hpos.orders set access_request_id = null, private_approval_consumed = false, approved_attendee_name = null, approved_attendee_email = null where site_id = any($1::uuid[])", [siteIds]);
    await client.query("delete from hpos.site_payment_connection_assignments where organization_id = any($1::uuid[])", [organizationIds]);
    await client.query("delete from hpos.notification_delivery_events where site_id = any($1::uuid[])", [siteIds]);
    await client.query("delete from hpos.notification_dispatch_attempts where site_id = any($1::uuid[])", [siteIds]);
    await client.query("delete from hpos.notification_jobs where site_id = any($1::uuid[])", [siteIds]);
    await client.query("delete from hpos.notification_claims where site_id = any($1::uuid[])", [siteIds]);
    await client.query("delete from hpos.api_idempotency_records where site_id = any($1::uuid[])", [siteIds]);
    await client.query("update hpos.public_quotes set access_request_id = null, approval_token_id = null where site_id = any($1::uuid[])", [siteIds]);
    await client.query("delete from hpos.access_request_decisions where site_id = any($1::uuid[])", [siteIds]);
    await client.query("delete from hpos.access_request_approval_tokens where site_id = any($1::uuid[])", [siteIds]);
    await client.query("delete from hpos.access_requests where site_id = any($1::uuid[])", [siteIds]);
    await client.query("delete from hpos.order_recovery_tokens where site_id = any($1::uuid[])", [siteIds]);
    await client.query("delete from hpos.admissions where site_id = any($1::uuid[])", [siteIds]);
    await client.query("delete from hpos.payment_report_issue_resolutions where site_id = any($1::uuid[])", [siteIds]);
    await client.query("delete from hpos.payment_report_issues where site_id = any($1::uuid[])", [siteIds]);
    await client.query("delete from hpos.refund_report_issues where site_id = any($1::uuid[])", [siteIds]);
    await client.query("delete from hpos.refund_reports where site_id = any($1::uuid[])", [siteIds]);
    await client.query("delete from hpos.refunds where site_id = any($1::uuid[])", [siteIds]);
    await client.query("delete from hpos.fee_report_issues where site_id = any($1::uuid[])", [siteIds]);
    await client.query("delete from hpos.fee_confirmation_totals where site_id = any($1::uuid[])", [siteIds]);
    await client.query("delete from hpos.fee_confirmations where site_id = any($1::uuid[])", [siteIds]);
    await client.query("delete from hpos.fee_records where site_id = any($1::uuid[])", [siteIds]);
    await client.query("delete from hpos.payment_attempt_closure_reports where site_id = any($1::uuid[])", [siteIds]);
    await client.query("delete from hpos.payment_attempt_reports where site_id = any($1::uuid[])", [siteIds]);
    await client.query("delete from hpos.tickets where site_id = any($1::uuid[])", [siteIds]);
    await client.query("delete from hpos.order_recovery_actions where site_id = any($1::uuid[])", [siteIds]);
    await client.query("delete from hpos.reservations where site_id = any($1::uuid[])", [siteIds]);
    await client.query("delete from hpos.payment_attempts where site_id = any($1::uuid[])", [siteIds]);
    await client.query("delete from hpos.orders where site_id = any($1::uuid[])", [siteIds]);
    await client.query("delete from hpos.public_quotes where site_id = any($1::uuid[])", [siteIds]);
    await client.query("delete from hpos.ticket_offering_provider_mappings where site_id = any($1::uuid[])", [siteIds]);
    await client.query("delete from hpos.events where site_id = any($1::uuid[])", [siteIds]);
    await client.query("delete from hpos.buyers where site_id = any($1::uuid[])", [siteIds]);
    await client.query("delete from hpos.payment_connections where organization_id = any($1::uuid[])", [organizationIds]);
    await client.query("delete from hpos.sites where organization_id = any($1::uuid[])", [organizationIds]);
    await client.query("delete from hpos.organizations where id = any($1::uuid[])", [organizationIds]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  const remaining = await pool.query("select (select count(*) from hpos.organizations where id = any($1::uuid[])) + (select count(*) from hpos.sites where id = any($2::uuid[])) as count", [organizationIds, siteIds]);
  assert(Number(remaining.rows[0]?.count ?? 0) === 0, "Synthetic fixture cleanup left Organization or Site records behind.");
}

async function cleanup() {
  const errors = [];
  try {
    await dropTrackedTriggers();
  } catch (error) {
    errors.push(error);
  }
  try {
    await cleanupOrganizations();
  } catch (error) {
    errors.push(error);
  }
  try {
    await dropTrackedTriggers();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) throw new AggregateError(errors, "Issue #125 cleanup failed.");
}

async function main() {
  assert(Number.isInteger(port) && port >= 3000 && port <= 3999, "HPOS_VERIFY_GROUP_WALLET_PORT must be from 3000 to 3999.");
  assert(databaseUrl === "postgresql://postgres:postgres@127.0.0.1:54322/postgres", "Group and Wallet verification requires the dedicated local test database.");
  await assertPortIsFree();
  app = startApp();
  let runError;
  try {
    await waitForReady(app);
    const site = createSiteFixture("Issue #125 primary verification Site");
    const otherSite = createSiteFixture("Issue #125 isolation verification Site");
    await verifyGroupOrder(site, otherSite);
    await verifyCancellation(site);
    await verifyCapacityRace(site);
    await verifyPrivateCheckout(site);
    await verifyClockOnlySales(site);
  } catch (error) {
    runError = error;
  }
  const teardownErrors = [];
  try {
    await cleanup();
  } catch (error) {
    teardownErrors.push(error);
  }
  try {
    await stopApp(app);
  } catch (error) {
    teardownErrors.push(error);
  }
  try {
    await pool.end();
  } catch (error) {
    teardownErrors.push(error);
  }
  if (runError && teardownErrors.length > 0) throw new AggregateError([runError, ...teardownErrors], "Issue #125 verification and teardown failed.");
  if (runError) throw runError;
  if (teardownErrors.length === 1) throw teardownErrors[0];
  if (teardownErrors.length > 1) throw new AggregateError(teardownErrors, "Issue #125 teardown failed.");
  console.log("Issue #125 local regression verification passed: public quantities 1/2/8 and boundary rejection, scaled accepted pricing and Reservations, atomic interrupted and duplicate-safe group issuance, independent Ticket pages and one-time Admissions, last-capacity concurrency, private one-Ticket checkout, Site-isolated Wallet reads, stable QR and Event data, Admission/cancellation/archival/full-refund Wallet versions, and exclusion of partial-refund, email-correction, and clock-only Wallet work. Provider, email, Wallet signing/device, hosted, LMNL, and cutover behavior remain outside this evidence.");
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : "Group and Wallet verification failed.");
  process.exitCode = 1;
});
