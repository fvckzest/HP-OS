import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

// This verifier deliberately stays on the HP-OS HTTP boundary. It does not
// call LMNL, an email provider, a payment provider, Wallet, or a device.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.HPOS_VERIFY_PRIVATE_ACCESS_PORT ?? 3278);
const origin = `http://127.0.0.1:${port}`;
const canonicalDatabaseUrl = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const databaseUrl = process.env.HPOS_DATABASE_URL ?? canonicalDatabaseUrl;
const env = { ...process.env, NODE_ENV: "development", HPOS_DATABASE_URL: databaseUrl, NEXT_TELEMETRY_DISABLED: "1" };
const pool = new pg.Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 2_000 });
const organizationIds = [];
const siteIds = [];
let app;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function dataOf(response) {
  return response.data?.data;
}

function errorCode(response) {
  return response.data?.error?.code;
}

function responseSummary(response) {
  if (Array.isArray(response)) return response.map(responseSummary).join(", ");
  if (!response || typeof response !== "object") return "no response";
  return `status=${response.status ?? "unknown"} code=${errorCode(response) ?? "none"} request_id=${response.data?.request_id ?? "missing"}`;
}

function assertError(response, status, code, message) {
  assert(response.status === status && errorCode(response) === code,
    `${message} Received ${responseSummary(response)}.`);
}

function assertRfc3339(value, label) {
  assert(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value),
    `${label} was not returned as an RFC 3339 timestamp with an explicit offset.`);
}

function listData(response) {
  const value = dataOf(response);
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.items)) return value.items;
  if (value && Array.isArray(value.requests)) return value.requests;
  return [];
}

function assertPortIsFree() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`Private-access verification port ${port} is already in use.`)));
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
    });
  }
  return { child, get output() { return output; } };
}

async function waitForReady(server) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) throw new Error(`The private-access verification app stopped early.\n${redactedAppOutput(server.output)}`);
    try {
      const response = await fetch(`${origin}/v1/admin/payment-configuration`, { signal: AbortSignal.timeout(2_000) });
      if (response.status === 401) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`The private-access verification app did not become ready within 90 seconds.\n${redactedAppOutput(server.output)}`);
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
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) throw new Error(`The local operator command failed: ${output}`);
  try { return JSON.parse(result.stdout); }
  catch { throw new Error(`The local operator command did not return JSON: ${output}`); }
}

function createSiteFixture(label) {
  const organization = runOperator(["organization", "create", "--name", `Issue 46/47 ${label} ${randomUUID()}`, "--pilot-fee-rate-basis-points", "1000"]);
  organizationIds.push(organization.organization_id);
  const site = runOperator(["site", "create", "--organization", organization.organization_id, "--name", `Private access ${label}`]);
  siteIds.push(site.site_id);
  const connection = runOperator([
    "payment-connection", "create", "--organization", organization.organization_id,
    "--provider", "square", "--environment", "test",
    "--account-reference", `ref:private-access-${label}-${randomUUID()}`,
    "--location-reference", `ref:private-access-location-${label}-${randomUUID()}`,
  ]);
  runOperator([
    "payment-connection", "eligibility-record", "--connection", connection.connection_id,
    "--account-status", "eligible", "--platform-fee-status", "ineligible",
    "--evidence-reference", `ref:private-access-evidence-${label}`,
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

async function api(site, pathName, { method = "GET", idempotencyKey, body } = {}) {
  const headers = { Authorization: `Bearer ${site.apiKey}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const response = await fetch(origin + pathName, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let data = null;
  try { data = await response.json(); } catch {}
  return { status: response.status, headers: response.headers, data };
}

function actor(reference = "test:private-access") {
  return { type: "user", reference };
}

function systemActor(reference) {
  return { type: "system", reference };
}

function redactedAppOutput(output) {
  return String(output).replace(/(\/v1\/public\/access-requests\/)[A-Za-z0-9_-]{32,200}/g, "$1[redacted]");
}

async function createPublishedPrivateEvent(site, {
  title,
  capacity = 10,
  salesOpensAt = new Date(Date.now() - 60_000).toISOString(),
  salesClosesAt,
  configureSales = true,
} = {}) {
  const startsAt = new Date(Date.now() + 90 * 60_000).toISOString();
  const endsAt = new Date(Date.now() + 4 * 60 * 60_000).toISOString();
  const created = await api(site, "/v1/admin/events", {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: actor(), },
  });
  assert(created.status === 201, `The ${title} private Event draft could not be created (${responseSummary(created)}).`);
  const eventId = dataOf(created).event_id;
  const patchBody = {
    actor: actor(), expected_version: dataOf(created).version,
    title, description: "A private Event used by local HTTP verification.",
    venue: { name: "Local verification venue" }, starts_at: startsAt, ends_at: endsAt,
    time_zone: "UTC", visibility: "private",
    ...(configureSales ? {
      ticket_offering: {
        price: { amount: 2500, currency: "USD" }, capacity, tax_amount: 0, buyer_fees: [],
        sales_opens_at: salesOpensAt, sales_closes_at: salesClosesAt ?? endsAt,
      },
    } : {}),
  };
  const saved = await api(site, `/v1/admin/events/${eventId}`, {
    method: "PATCH", idempotencyKey: randomUUID(), body: patchBody,
  });
  assert(saved.status === 200, `The ${title} private Event could not be saved (${responseSummary(saved)}).`);
  const published = await api(site, `/v1/admin/events/${eventId}/actions/publish`, {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: actor(), expected_version: dataOf(saved).version },
  });
  assert(published.status === 200 && dataOf(published).publication_status === "published",
    `The ${title} private Event could not be published (${responseSummary(published)}).`);
  return dataOf(published);
}

async function listRequests(site, eventId) {
  return api(site, `/v1/admin/events/${eventId}/access-requests?limit=100`);
}

async function findRequest(site, eventId, predicate) {
  const response = await listRequests(site, eventId);
  assert(response.status === 200, `The Site could not list Access Requests (${responseSummary(response)}).`);
  const result = listData(response).find(predicate);
  assert(result, `The expected Access Request was not present in the admin list (rows=${listData(response).length}).`);
  return result;
}

async function submitRequest(site, eventId, name, email, idempotencyKey = randomUUID()) {
  return api(site, `/v1/public/events/${eventId}/access-requests`, {
    method: "POST", idempotencyKey, body: { name, email },
  });
}

async function decide(site, request, action, expectedVersion = request.version) {
  return api(site, `/v1/admin/access-requests/${request.request_id}/actions/${action}`, {
    method: "POST", idempotencyKey: randomUUID(),
    body: { actor: actor(`test:private-access:${action}`), expected_version: expectedVersion },
  });
}

async function currentApprovalJob(site, requestId, { includeSuperseded = false } = {}) {
  // The notification list intentionally exposes only the documented filters;
  // filter the request relation after the Site-scoped response is read.
  const response = await api(site, "/v1/admin/notification-jobs?kind=access_approved&limit=100");
  assert(response.status === 200, `The approval notification jobs could not be read (${responseSummary(response)}).`);
  const jobs = listData(response).filter((job) => job.access_request_id === requestId);
  const candidates = jobs.filter((job) => includeSuperseded || !job.is_superseded);
  return candidates.sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))[0] ?? null;
}

function approvalToken(job) {
  return job?.payload?.approval_token ?? job?.payload?.access_request_token ?? null;
}

async function approveAndReadToken(site, request) {
  const approved = await decide(site, request, "approve");
  assert(approved.status === 200 && dataOf(approved).status === "approved",
    `Approval failed (${responseSummary(approved)}).`);
  const job = await currentApprovalJob(site, request.request_id);
  assert(job && job.kind === "access_approved" && job.status === "pending" && !job.is_superseded,
    "Approval did not queue one current access_approved notification job.");
  assert(job.payload?.attendee?.name === request.name && job.payload?.attendee?.email === request.email,
    "The approval notification did not preserve the approved attendee identity.");
  assert(!Object.hasOwn(job.payload ?? {}, "buyer") && !Object.hasOwn(job.payload ?? {}, "order_token"),
    "The approval notification leaked purchaser or Order access data.");
  const token = approvalToken(job);
  assert(typeof token === "string" && token.length >= 32, "The approval notification did not contain an opaque checkout token.");
  return { approved: dataOf(approved), job, token };
}

async function privateQuote(site, eventId, token) {
  return api(site, `/v1/public/events/${eventId}/quotes`, {
    method: "POST", idempotencyKey: randomUUID(), body: { quantity: 1, access_request_token: token },
  });
}

async function privateOrder(site, eventId, token, buyer, idempotencyKey = randomUUID(), quoteId = null) {
  // Private checkout uses the normal quote and Order boundary. The approval
  // token is required for both calls and the buyer identity is kept separate
  // from the approved attendee identity.
  const quote = quoteId
    ? { status: 201, data: { data: { quote_id: quoteId } } }
    : await privateQuote(site, eventId, token);
  if (quote.status !== 201) return quote;
  return api(site, "/v1/public/orders", {
    method: "POST", idempotencyKey,
    body: { quote_id: dataOf(quote).quote_id, access_request_token: token, buyer },
  });
}

async function createPaymentAttempt(site, orderId) {
  const response = await api(site, `/v1/admin/orders/${orderId}/payment-attempts`, {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: actor("test:private-payment") },
  });
  assert(response.status === 201, `A private Order could not create its local payment attempt (${responseSummary(response)}).`);
  return dataOf(response);
}

async function payPrivateOrder(site, order, amount = 2500) {
  const attempt = await createPaymentAttempt(site, order.order_id);
  const checkout = await api(site, `/v1/admin/payment-attempts/${attempt.attempt_id}/checkout-reference`, {
    method: "POST", idempotencyKey: randomUUID(),
    body: {
      actor: actor("test:private-payment"), connection_id: site.connectionId,
      provider_checkout_reference: `local-private-checkout-${randomUUID()}`, provider_can_take_payment: true,
    },
  });
  assert(checkout.status === 200, `The private payment attempt could not open locally (${responseSummary(checkout)}).`);
  const reportBody = {
    connection_id: site.connectionId,
    source_reference: `ref:local-private-paid-${randomUUID()}`,
    provider_checkout_reference: dataOf(checkout).provider_checkout_reference,
    provider_payment_reference: `local-private-payment-${randomUUID()}`,
    outcome: "paid", observed_at: new Date().toISOString(), payment_started_at: new Date().toISOString(),
    provider_can_take_payment: false, amount, currency: "USD",
  };
  const reports = await Promise.all([
    api(site, `/v1/admin/payment-attempts/${attempt.attempt_id}/payment-reports`, { method: "POST", idempotencyKey: randomUUID(), body: reportBody }),
    api(site, `/v1/admin/payment-attempts/${attempt.attempt_id}/payment-reports`, { method: "POST", idempotencyKey: randomUUID(), body: reportBody }),
  ]);
  assert(reports.every((report) => report.status === 201 || report.status === 200),
    `Concurrent identical paid reports did not resolve safely (${responseSummary(reports)}).`);
  return { attemptId: attempt.attempt_id, checkout: dataOf(checkout), paymentBody: reportBody, reports };
}

async function refundPrivateOrder(site, order, payment) {
  const response = await api(site, `/v1/admin/orders/${order.order_id}/refund-reports`, {
    method: "POST", idempotencyKey: randomUUID(), body: {
      attempt_id: payment.attemptId,
      connection_id: site.connectionId,
      provider_payment_reference: payment.paymentBody.provider_payment_reference,
      provider_refund_reference: `local-private-refund-${randomUUID()}`,
      source_reference: `ref:local-private-refund-${randomUUID()}`,
      outcome: "completed", amount: payment.paymentBody.amount, currency: payment.paymentBody.currency,
      observed_at: new Date().toISOString(),
    },
  });
  assert(response.status === 201 || response.status === 200,
    `The paid private Order could not accept its local completed refund (${responseSummary(response)}).`);
  return response;
}

async function verifyConsumedMarkerSurvivesConflict(siteId, orderId) {
  // Payment-report conflict handling must not clear the durable private
  // approval marker before Ticket issuance. Keep this proof inside a
  // transaction so the synthetic conflicted state is rolled back immediately.
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(
      "select payment_status, private_approval_consumed from hpos.orders where id = $1 and site_id = $2",
      [orderId, siteId],
    );
    assert(before.rows[0]?.payment_status === "paid" && before.rows[0]?.private_approval_consumed === true,
      "The paid private Order did not retain its consumed approval marker before conflict verification.");
    const changed = await client.query(
      `update hpos.orders
       set payment_status = 'conflicted', version = version + 1, updated_at = clock_timestamp()
       where id = $1 and site_id = $2
       returning payment_status, private_approval_consumed`,
      [orderId, siteId],
    );
    assert(changed.rows[0]?.payment_status === "conflicted" && changed.rows[0]?.private_approval_consumed === true,
      "A conflicted private Order lost its durable consumed approval marker.");
    await client.query("rollback");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function adminTickets(site, eventId) {
  return api(site, `/v1/admin/events/${eventId}/tickets?limit=100`);
}

async function verifyPrivateRequestLifecycle(site, otherSite) {
  const earlyEvent = await createPublishedPrivateEvent(site, {
    title: "Private before sales verification",
    configureSales: true,
    salesOpensAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  });
  const publicEvents = await api(site, "/v1/public/events?period=current");
  const publicEvent = listData(publicEvents).find((event) => event.event_id === earlyEvent.event_id);
  assert(publicEvents.status === 200 && publicEvent?.purchase_mode === "access_request"
    && publicEvent.sales_status === "scheduled", "A published private Event was not publicly discoverable before sales opened.");

  const attendee = { name: "Same Attendee", email: "same-attendee@example.test" };
  const key = randomUUID();
  const sameKey = await Promise.all([
    submitRequest(site, earlyEvent.event_id, attendee.name, attendee.email, key),
    submitRequest(site, earlyEvent.event_id, attendee.name, attendee.email, key),
  ]);
  assert(sameKey.every((response) => response.status === 201 && dataOf(response)?.received === true),
    "Concurrent same-key Access Request submissions did not replay one acknowledgment.");
  const first = await findRequest(site, earlyEvent.event_id, (row) => row.email === attendee.email);
  const duplicate = await submitRequest(site, earlyEvent.event_id, attendee.name, attendee.email);
  assert(duplicate.status === 201 && dataOf(duplicate)?.received === true, "An intentional identical Access Request was rejected.");
  const duplicateRows = listData(await listRequests(site, earlyEvent.event_id)).filter((row) => row.email === attendee.email);
  assert(duplicateRows.length === 2 && new Set(duplicateRows.map((row) => row.request_id)).size === 2,
    "Identical attendee details were incorrectly deduplicated across idempotency keys.");

  const crossSiteSubmit = await submitRequest(otherSite, earlyEvent.event_id, "Wrong Site", "wrong-site@example.test");
  assertError(crossSiteSubmit, 404, "not_found", "A different Site could submit an Access Request to this Event.");
  const wrongSiteList = await listRequests(otherSite, earlyEvent.event_id);
  assertError(wrongSiteList, 404, "not_found", "A different Site could list Access Requests for this Event.");

  const corrected = await submitRequest(site, earlyEvent.event_id, "Needs Correction", "correction@example.test");
  assert(corrected.status === 201, "The pending correction fixture could not be submitted.");
  const pending = await findRequest(site, earlyEvent.event_id, (row) => row.email === "correction@example.test");
  const edit = await api(site, `/v1/admin/access-requests/${pending.request_id}`, {
    method: "PATCH", idempotencyKey: randomUUID(),
    body: { actor: actor("test:private-correction"), expected_version: pending.version, name: "Corrected Attendee", email: "corrected@example.test" },
  });
  assert(edit.status === 200 && dataOf(edit).status === "pending" && dataOf(edit).name === "Corrected Attendee"
    && dataOf(edit).version > pending.version, "A guarded pending attendee correction did not persist.");
  const history = await pool.query(
    `select action, from_status, to_status, name, email
     from hpos.access_request_decisions where site_id = $1 and access_request_id = $2 order by created_at asc`,
    [site.siteId, pending.request_id],
  );
  assert(history.rows.some((row) => row.action === "correct" && row.from_status === "pending" && row.to_status === "pending"
    && row.name === "Needs Correction" && row.email === "correction@example.test"),
    "Attendee correction did not retain the prior identity in decision history.");
  const staleCorrection = await api(site, `/v1/admin/access-requests/${pending.request_id}`, {
    method: "PATCH", idempotencyKey: randomUUID(),
    body: { actor: actor("test:private-correction-stale"), expected_version: pending.version, name: "Stale Correction" },
  });
  assertError(staleCorrection, 409, "version_conflict", "A stale Access Request correction was accepted after the guarded update.");

  const raceSubmission = await submitRequest(site, earlyEvent.event_id, "Racing Attendee", "racing@example.test");
  assert(raceSubmission.status === 201, "The guarded decision-race fixture could not be submitted.");
  const racing = await findRequest(site, earlyEvent.event_id, (row) => row.email === "racing@example.test");
  const racedDecisions = await Promise.all([
    decide(site, racing, "approve", racing.version),
    decide(site, racing, "reject", racing.version),
  ]);
  assert(racedDecisions.filter((response) => response.status === 200).length === 1
    && racedDecisions.filter((response) => response.status === 409 && errorCode(response) === "version_conflict").length === 1,
    "Concurrent Access Request decisions did not leave one winner and one stale-version rejection.");

  const approved = await approveAndReadToken(site, first);
  const lookupBeforeSales = await api(site, `/v1/public/access-requests/${approved.token}`);
  const lookupData = dataOf(lookupBeforeSales);
  assert(lookupBeforeSales.status === 200 && lookupData.event?.event_id === earlyEvent.event_id
    && lookupData.approved_attendee?.name === attendee.name
    && lookupData.approved_attendee?.email === attendee.email
    && lookupData.max_quantity_per_order === 1
    && lookupData.purchase_completed === false,
    "Approval lookup did not expose the vetted attendee and one-Ticket eligibility.");
  for (const [field, value] of Object.entries(lookupData.event ?? {})) {
    if (field.endsWith("_at") && value !== null) assertRfc3339(value, `Approval lookup event.${field}`);
  }
  assert(!JSON.stringify(dataOf(lookupBeforeSales)).includes("order_token")
    && !JSON.stringify(dataOf(lookupBeforeSales)).includes("buyer"),
    "Approval lookup exposed purchaser or Order credentials.");
  assertError(await api(otherSite, `/v1/public/access-requests/${approved.token}`), 404, "not_found",
    "A different Site could resolve an approval token.");
  assertError(await api(site, "/v1/public/access-requests/not-a-real-token"), 404, "not_found",
    "An invalid approval token did not fail closed.");
  const beforeSalesOrder = await privateOrder(site, earlyEvent.event_id, approved.token, { name: "Different Payer", email: "payer@example.test" });
  assertError(beforeSalesOrder, 409, "sales_not_open", "Private checkout was allowed before the Event sales window opened.");

  const rejectedSubmission = await submitRequest(site, earlyEvent.event_id, "Rejected Attendee", "rejected@example.test");
  assert(rejectedSubmission.status === 201, "The rejection fixture could not be submitted.");
  const rejected = await findRequest(site, earlyEvent.event_id, (row) => row.email === "rejected@example.test");
  const rejectedDecision = await decide(site, rejected, "reject");
  assert(rejectedDecision.status === 200 && dataOf(rejectedDecision).status === "rejected", "Rejection did not set rejected status.");
  assert(await currentApprovalJob(site, rejected.request_id) === null, "Rejection queued an approval email.");
  const rejectedUndo = await decide(site, dataOf(rejectedDecision), "undo_decision");
  assert(rejectedUndo.status === 200 && dataOf(rejectedUndo).status === "pending", "Undo did not return a rejected request to pending.");

  return { earlyEvent, first: dataOf(await findRequest(site, earlyEvent.event_id, (row) => row.request_id === first.request_id)), approved };
}

async function verifyApprovalReplacementAndStaleClaim(site, event) {
  const submission = await submitRequest(site, event.event_id, "Replaceable Attendee", "replace@example.test");
  assert(submission.status === 201, "The approval replacement fixture could not be submitted.");
  const request = await findRequest(site, event.event_id, (row) => row.email === "replace@example.test");
  const first = await approveAndReadToken(site, request);
  const oldLookup = await api(site, `/v1/public/access-requests/${first.token}`);
  assert(oldLookup.status === 200, "The initial approval token could not be looked up.");
  const staleQuote = await privateQuote(site, event.event_id, first.token);
  assert(staleQuote.status === 201, `The initial approval quote could not be created (${responseSummary(staleQuote)}).`);

  const claimed = await api(site, "/v1/admin/notification-jobs/claims", {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: systemActor("test:private-worker"), kinds: ["access_approved"], limit: 50 },
  });
  assert(claimed.status === 200, `The local notification claim failed (${responseSummary(claimed)}).`);
  const staleClaimedJob = dataOf(claimed).jobs?.find((job) => job.access_request_id === request.request_id);
  assert(staleClaimedJob, "The approved notification was not claimable for stale-payload verification.");
  const unknownDispatch = await api(site, `/v1/admin/notification-jobs/${staleClaimedJob.job_id}/outcome-reports`, {
    method: "POST", idempotencyKey: randomUUID(), body: {
      claim_id: dataOf(claimed).claim_id, lease_fence: staleClaimedJob.lease_fence,
      outcome: "unknown", provider_message_reference: null, observed_at: new Date().toISOString(),
      error_code: "provider_timeout", actor: systemActor("test:private-worker"),
    },
  });
  assert(unknownDispatch.status === 200 && dataOf(unknownDispatch).requires_verification === true,
    `The stale approval notification did not enter verification-only state (${responseSummary(unknownDispatch)}).`);

  const undone = await decide(site, first.approved, "undo_decision");
  assert(undone.status === 200 && dataOf(undone).status === "pending", "Undoing approval did not return it to pending.");
  const oldAfterUndo = await api(site, `/v1/public/access-requests/${first.token}`);
  assertError(oldAfterUndo, 404, "not_found", "Undoing approval did not invalidate its old token.");
  const renewed = await approveAndReadToken(site, dataOf(undone));
  assert(renewed.token !== first.token, "Reapproval reused the invalidated approval token.");
  const jobs = listData(await api(site, "/v1/admin/notification-jobs?kind=access_approved&limit=100")).filter((job) => job.access_request_id === request.request_id);
  assert(jobs.some((job) => approvalToken(job) === first.token
      && (job.is_superseded || job.claim_id === staleClaimedJob.claim_id || (job.requires_verification && job.claim_id === null)))
    && jobs.some((job) => !job.is_superseded && approvalToken(job) === renewed.token),
    "Approval replacement did not supersede or fence the old job and create a current job.");
  const oldClaimedRow = await pool.query(
    `select is_superseded, status, claim_id, access_request_token_hash
     from hpos.notification_jobs where id = $1 and site_id = $2`,
    [staleClaimedJob.job_id, site.siteId],
  );
  assert(oldClaimedRow.rows[0] && oldClaimedRow.rows[0].status === "pending"
    && oldClaimedRow.rows[0].access_request_token_hash !== createHash("sha256").update(renewed.token).digest("hex"),
    "A previously claimed approval payload was allowed to become the current token after reapproval.");
  const reconciliationClaim = await api(site, "/v1/admin/notification-jobs/claims", {
    method: "POST", idempotencyKey: randomUUID(), body: {
      actor: systemActor("test:private-worker-reconcile"), kinds: ["access_approved"], limit: 50,
    },
  });
  const reconciledJob = dataOf(reconciliationClaim).jobs?.find((job) => job.job_id === staleClaimedJob.job_id);
  assert(reconciliationClaim.status === 200 && reconciledJob?.requires_verification === true,
    `A stale unknown approval notification was not reclaimed for verification (${responseSummary(reconciliationClaim)}).`);
  const staleQuoteOrder = await api(site, "/v1/public/orders", {
    method: "POST", idempotencyKey: randomUUID(), body: {
      quote_id: dataOf(staleQuote).quote_id, access_request_token: renewed.token,
      buyer: { name: "Stale Quote Payer", email: "stale-quote-payer@example.test" },
    },
  });
  assertError(staleQuoteOrder, 404, "not_found", "A quote bound to the replaced approval token authorized checkout with the new token.");
  const staleCheckout = await privateOrder(site, event.event_id, first.token, { name: "Stale Payer", email: "stale-payer@example.test" });
  assertError(staleCheckout, 404, "not_found", "A stale claimed approval payload still authorized checkout.");
  return { request: dataOf(renewed.approved), token: renewed.token };
}

async function verifyCheckoutAndConsumption(site, event) {
  const submission = await submitRequest(site, event.event_id, "Approved Attendee", "approved@example.test");
  assert(submission.status === 201, "The private checkout fixture could not be submitted.");
  const request = await findRequest(site, event.event_id, (row) => row.email === "approved@example.test");
  const approval = await approveAndReadToken(site, request);

  const orderKey = randomUUID();
  const buyers = [{ name: "Payer One", email: "payer-one@example.test" }, { name: "Payer One", email: "payer-one@example.test" }];
  const quote = await privateQuote(site, event.event_id, approval.token);
  assert(quote.status === 201, `The private quote could not be created (${responseSummary(quote)}).`);
  const quoteId = dataOf(quote).quote_id;
  const concurrentOrders = await Promise.all(buyers.map((buyer) => privateOrder(site, event.event_id, approval.token, buyer, orderKey, quoteId)));
  assert(concurrentOrders.every((response) => response.status === 201),
    `Concurrent same-key private checkout did not replay one Order (${responseSummary(concurrentOrders)}).`);
  const order = dataOf(concurrentOrders[0]);
  assert(order.order_id && order.order_token, "Private Order creation did not return the buyer access token.");
  const secondOrder = await privateOrder(site, event.event_id, approval.token, { name: "Another Payer", email: "another-payer@example.test" });
  assertError(secondOrder, 409, "access_checkout_in_progress", "A second active private checkout was allowed for one approval.");
  const orderCount = await pool.query("select count(*)::integer as count from hpos.orders where site_id = $1 and access_request_id = $2", [site.siteId, request.request_id]);
  assert(orderCount.rows[0]?.count === 1, "Private approval checkout created more than one Order.");

  const payment = await payPrivateOrder(site, order);
  const lateReports = payment.reports;
  assert(lateReports.length === 2, "The concurrent paid-report test did not issue both HTTP requests.");
  const persisted = await pool.query(
    `select order_row.payment_status, order_row.access_request_id,
            order_row.approved_attendee_name, order_row.approved_attendee_email,
            order_row.private_approval_consumed,
            request_row.status as request_status, request_row.paid_order_id,
            count(distinct ticket.id)::integer as tickets,
            count(distinct case when request_row.paid_order_id is not null then request_row.id end)::integer as consumed_approvals
     from hpos.orders order_row
     join hpos.access_requests request_row on request_row.id = order_row.access_request_id and request_row.site_id = order_row.site_id
     left join hpos.tickets ticket on ticket.order_id = order_row.id and ticket.site_id = order_row.site_id
     where order_row.site_id = $1 and order_row.id = $2
    group by order_row.payment_status, order_row.access_request_id,
             order_row.approved_attendee_name, order_row.approved_attendee_email,
             order_row.private_approval_consumed, request_row.status, request_row.paid_order_id`,
    [site.siteId, order.order_id],
  );
  assert(persisted.rows[0]?.payment_status === "paid" && persisted.rows[0]?.request_status === "approved"
    && persisted.rows[0]?.paid_order_id === order.order_id && persisted.rows[0]?.tickets === 1
    && persisted.rows[0]?.consumed_approvals === 1 && persisted.rows[0]?.private_approval_consumed === true,
    "Concurrent private payment reports did not produce one paid Order, one consumed approval, and one Ticket.");
  await verifyConsumedMarkerSurvivesConflict(site.siteId, order.order_id);

  const adminTicketsResponse = await adminTickets(site, event.event_id);
  const ticketRows = listData(adminTicketsResponse).filter((ticket) => ticket.order_id === order.order_id);
  assert(adminTicketsResponse.status === 200 && ticketRows.length === 1
    && ticketRows[0].approved_attendee?.name === "Approved Attendee"
    && ticketRows[0].approved_attendee?.email === "approved@example.test",
    "The private Ticket/admin list did not retain the approved attendee separately from the payer.");
  const adminOrder = await api(site, `/v1/admin/orders/${order.order_id}`);
  assert(adminOrder.status === 200 && dataOf(adminOrder).access_request_id === request.request_id
    && dataOf(adminOrder).approved_attendee?.email === "approved@example.test",
    "The admin Order did not retain private approval identity.");
  const approvalAfterPay = await api(site, `/v1/public/access-requests/${approval.token}`);
  assert(approvalAfterPay.status === 200 && dataOf(approvalAfterPay).purchase_completed === true,
    "Approval lookup did not report the completed private purchase.");
  const secondAfterPay = await privateOrder(site, event.event_id, approval.token, { name: "Late Payer", email: "late-payer@example.test" });
  assertError(secondAfterPay, 409, "access_already_used", "A paid private approval could be reused.");

  // Make the synthetic Event available for the existing Admission API; this
  // is local database state, not visual or device verification.
  await pool.query(
    `update hpos.events set starts_at = clock_timestamp() - interval '5 minutes',
       starts_at_offset_minutes = 0,
       ends_at = clock_timestamp() + interval '2 hours', ends_at_offset_minutes = 0,
       check_in_opens_at = clock_timestamp() - interval '10 minutes', check_in_opens_offset_minutes = 0
     where id = $1 and site_id = $2`, [event.event_id, site.siteId],
  );
  const admitted = await api(site, `/v1/admin/events/${event.event_id}/admissions`, {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: actor("test:private-admission"), ticket_id: ticketRows[0].ticket_id },
  });
  assert(admitted.status === 201, `The private Ticket could not be admitted through HTTP (${responseSummary(admitted)}).`);
  const repeatedAdmission = await api(site, `/v1/admin/events/${event.event_id}/admissions`, {
    method: "POST", idempotencyKey: randomUUID(), body: { actor: actor("test:private-admission"), ticket_id: ticketRows[0].ticket_id },
  });
  assertError(repeatedAdmission, 409, "already_admitted", "The private Ticket could be admitted twice.");
  await refundPrivateOrder(site, order, payment);
  const refunded = await pool.query(
    `select order_row.refund_status, order_row.private_approval_consumed, request_row.paid_order_id
     from hpos.orders order_row
     join hpos.access_requests request_row on request_row.id = order_row.access_request_id and request_row.site_id = order_row.site_id
     where order_row.site_id = $1 and order_row.id = $2`, [site.siteId, order.order_id],
  );
  assert(refunded.rows[0]?.refund_status === "full" && refunded.rows[0]?.paid_order_id === order.order_id
    && refunded.rows[0]?.private_approval_consumed === true,
    "A completed refund did not preserve the consumed private approval and full refund state.");
  const secondAfterRefund = await privateOrder(site, event.event_id, approval.token, { name: "Refund Payer", email: "refund-payer@example.test" });
  assertError(secondAfterRefund, 409, "access_already_used", "A refunded private approval could be reused.");
  return { request, approval, order, payment, ticket: ticketRows[0] };
}

async function verifySoldOutAndWithdrawal(site, event) {
  const soldOutEvent = await createPublishedPrivateEvent(site, { title: "Private sold-out verification", capacity: 1 });
  const firstSubmission = await submitRequest(site, soldOutEvent.event_id, "Capacity Holder", "capacity-holder@example.test");
  assert(firstSubmission.status === 201, "The sold-out holder request could not be submitted.");
  const firstRequest = await findRequest(site, soldOutEvent.event_id, (row) => row.email === "capacity-holder@example.test");
  const firstApproval = await approveAndReadToken(site, firstRequest);
  const heldOrderResponse = await privateOrder(site, soldOutEvent.event_id, firstApproval.token, { name: "Capacity Payer", email: "capacity-payer@example.test" });
  assert(heldOrderResponse.status === 201, "The sold-out fixture could not hold its only Reservation.");
  const secondSubmission = await submitRequest(site, soldOutEvent.event_id, "Waiting Attendee", "waiting@example.test");
  assert(secondSubmission.status === 201, "Access Requests were incorrectly blocked while the Event was sold out.");
  const secondRequest = await findRequest(site, soldOutEvent.event_id, (row) => row.email === "waiting@example.test");
  const secondApproval = await approveAndReadToken(site, secondRequest);
  const soldOutCheckout = await privateOrder(site, soldOutEvent.event_id, secondApproval.token, { name: "Waiting Payer", email: "waiting-payer@example.test" });
  assertError(soldOutCheckout, 409, "sold_out", "Approved private checkout ignored sold-out capacity.");

  const retrySubmission = await submitRequest(site, event.event_id, "Retry Attendee", "retry-attendee@example.test");
  assert(retrySubmission.status === 201, "The closed-checkout retry fixture could not be submitted.");
  const retryRequest = await findRequest(site, event.event_id, (row) => row.email === "retry-attendee@example.test");
  const retryApproval = await approveAndReadToken(site, retryRequest);
  const retryOrderResponse = await privateOrder(site, event.event_id, retryApproval.token, { name: "Retry Payer", email: "retry-payer@example.test" });
  assert(retryOrderResponse.status === 201, "The private checkout retry fixture could not create an Order.");
  const retryOrder = dataOf(retryOrderResponse);
  const firstAttempt = await createPaymentAttempt(site, retryOrder.order_id);
  const retryCheckoutReference = `local-private-retry-${randomUUID()}`;
  const opened = await api(site, `/v1/admin/payment-attempts/${firstAttempt.attempt_id}/checkout-reference`, {
    method: "POST", idempotencyKey: randomUUID(), body: {
      actor: actor("test:private-retry"), connection_id: site.connectionId,
      provider_checkout_reference: retryCheckoutReference, provider_can_take_payment: true,
    },
  });
  assert(opened.status === 200, `The private retry checkout could not open (${responseSummary(opened)}).`);
  const closed = await api(site, `/v1/admin/payment-attempts/${firstAttempt.attempt_id}/closure-reports`, {
    method: "POST", idempotencyKey: randomUUID(), body: {
      actor: actor("test:private-retry"), connection_id: site.connectionId,
      source_reference: `ref:local-private-retry-closed-${randomUUID()}`,
      provider_checkout_reference: retryCheckoutReference, observed_at: new Date().toISOString(),
      provider_checkout_closed: true, payment_outcome: "canceled",
    },
  });
  assert(closed.status === 200 && dataOf(closed).status === "closed",
    `A verified closed private checkout did not close the attempt (${responseSummary(closed)}).`);
  const replacementAttempt = await createPaymentAttempt(site, retryOrder.order_id);
  assert(replacementAttempt.attempt_id !== firstAttempt.attempt_id,
    "A private Order could not safely retry after its prior provider checkout closed.");
  const setupClosed = await api(site, `/v1/admin/payment-attempts/${replacementAttempt.attempt_id}/setup-failure`, {
    method: "POST", idempotencyKey: randomUUID(), body: {
      actor: actor("test:private-retry"), reason: "provider_unavailable",
      provider_checkout_closed: true, payment_outcome: "not_started",
    },
  });
  assert(setupClosed.status === 200 && dataOf(setupClosed).status === "closed",
    `A safe private retry closure did not release its attempt (${responseSummary(setupClosed)}).`);

  const unresolvedSubmission = await submitRequest(site, event.event_id, "Late Attendee", "late-attendee@example.test");
  assert(unresolvedSubmission.status === 201, "The unresolved-payment withdrawal fixture could not be submitted.");
  const unresolved = await findRequest(site, event.event_id, (row) => row.email === "late-attendee@example.test");
  const approval = await approveAndReadToken(site, unresolved);
  const orderResponse = await privateOrder(site, event.event_id, approval.token, { name: "Late Payer", email: "late-payer-2@example.test" });
  assert(orderResponse.status === 201, "The unresolved-payment private Order could not be created.");
  const order = dataOf(orderResponse);
  const attempt = await createPaymentAttempt(site, order.order_id);
  const checkout = await api(site, `/v1/admin/payment-attempts/${attempt.attempt_id}/checkout-reference`, {
    method: "POST", idempotencyKey: randomUUID(), body: {
      actor: actor("test:private-withdrawal"), connection_id: site.connectionId,
      provider_checkout_reference: `local-private-unresolved-${randomUUID()}`, provider_can_take_payment: true,
    },
  });
  assert(checkout.status === 200, `The unresolved private checkout could not be opened (${responseSummary(checkout)}).`);
  const inProgressLookup = await api(site, `/v1/public/access-requests/${approval.token}`);
  assert(inProgressLookup.status === 200 && dataOf(inProgressLookup).checkout_in_progress === true
    && dataOf(inProgressLookup).purchase_completed === false,
    "An approved link did not report its unresolved checkout before withdrawal.");
  const undone = await decide(site, approval.approved, "undo_decision");
  assert(undone.status === 200 && dataOf(undone).status === "pending", "Withdrawal did not return unresolved approval to pending.");
  assertError(await api(site, `/v1/public/access-requests/${approval.token}`), 404, "not_found", "Withdrawal left its old approval token usable.");
  const held = await pool.query(
    `select reservation.status, reservation.awaiting_provider_verification, order_row.checkout_status
     from hpos.reservations reservation join hpos.orders order_row on order_row.id = reservation.order_id and order_row.site_id = reservation.site_id
     where reservation.site_id = $1 and order_row.id = $2`, [site.siteId, order.order_id],
  );
  assert(held.rows[0]?.status === "held" && held.rows[0]?.awaiting_provider_verification === true
    && held.rows[0]?.checkout_status === "awaiting_payment_result",
    "Withdrawal released an unresolved provider-capable Reservation.");
  const lateReport = await api(site, `/v1/admin/payment-attempts/${attempt.attempt_id}/payment-reports`, {
    method: "POST", idempotencyKey: randomUUID(), body: {
      connection_id: site.connectionId,
      source_reference: `ref:local-private-late-paid-${randomUUID()}`, provider_checkout_reference: dataOf(checkout).provider_checkout_reference,
      provider_payment_reference: `local-private-late-payment-${randomUUID()}`, outcome: "paid",
      observed_at: new Date().toISOString(), payment_started_at: new Date().toISOString(), provider_can_take_payment: false,
      amount: 2500, currency: "USD",
    },
  });
  assert(lateReport.status === 201 || lateReport.status === 200,
    `A late paid result was lost after approval withdrawal (${responseSummary(lateReport)}).`);
  const lateState = await pool.query(
    `select order_row.payment_status, order_row.private_approval_consumed,
            request_row.status, request_row.paid_order_id, count(ticket.id)::integer as ticket_count
     from hpos.orders order_row join hpos.access_requests request_row on request_row.id = order_row.access_request_id and request_row.site_id = order_row.site_id
     left join hpos.tickets ticket on ticket.order_id = order_row.id and ticket.site_id = order_row.site_id
     where order_row.site_id = $1 and order_row.id = $2
     group by order_row.payment_status, order_row.private_approval_consumed, request_row.status, request_row.paid_order_id`, [site.siteId, order.order_id],
  );
  assert(lateState.rows[0]?.payment_status === "paid" && lateState.rows[0]?.private_approval_consumed === true
    && lateState.rows[0]?.paid_order_id === order.order_id && lateState.rows[0]?.ticket_count === 1,
    "A late paid outcome after withdrawal did not preserve the one Order/Ticket purchase.");
}

async function cleanup() {
  if (!organizationIds.length) return;
  const ids = siteIds;
  await pool.query("begin");
  try {
    // The private migration intentionally has circular Order/Access Request
    // references. Break those references before removing the synthetic graph.
    await pool.query("update hpos.access_requests set paid_order_id = null where site_id = any($1::uuid[])", [ids]);
    await pool.query(
      "update hpos.orders set access_request_id = null, private_approval_consumed = false, approved_attendee_name = null, approved_attendee_email = null where site_id = any($1::uuid[])",
      [ids],
    );
    // Quotes point at Access Requests, so clear this edge before removing
    // either side of the private checkout graph.
    await pool.query("update hpos.public_quotes set access_request_id = null, approval_token_id = null where site_id = any($1::uuid[])", [ids]);
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
      await pool.query(`delete from ${table} where site_id = any($1::uuid[])`, [ids]).catch(async (error) => {
        if (error?.code === "42P01") return;
        throw error;
      });
    }
    await pool.query("delete from hpos.site_payment_connection_assignments where organization_id = any($1::uuid[])", [organizationIds]);
    await pool.query("delete from hpos.payment_connections where organization_id = any($1::uuid[])", [organizationIds]);
    await pool.query("delete from hpos.sites where organization_id = any($1::uuid[])", [organizationIds]);
    await pool.query("delete from hpos.organizations where id = any($1::uuid[])", [organizationIds]);
    await pool.query("commit");
  } catch (error) {
    await pool.query("rollback").catch(() => undefined);
    throw error;
  }
}

async function runStage(label, callback) {
  try {
    return await callback();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown failure";
    throw new Error(`Private-access verification stage '${label}' failed: ${message}`);
  }
}

function safeErrorMessage(error) {
  return redactedAppOutput(error instanceof Error ? error.message : "unknown failure");
}

async function main() {
  assert(Number.isInteger(port) && port >= 3000 && port <= 3999, "HPOS_VERIFY_PRIVATE_ACCESS_PORT must be from 3000 to 3999.");
  assert(databaseUrl === canonicalDatabaseUrl,
    "Private-access verification requires the dedicated local database at 127.0.0.1:54322/postgres; refusing another database URL.");
  await assertPortIsFree();
  app = startApp();
  let verificationError = null;
  let cleanupError = null;
  try {
    await waitForReady(app);
    const site = createSiteFixture("one");
    const otherSite = createSiteFixture("two");
    const privateEvent = await runStage("private Event fixture", () => createPublishedPrivateEvent(site, { title: "Private checkout verification", capacity: 10 }));
    await runStage("request lifecycle", () => verifyPrivateRequestLifecycle(site, otherSite));
    await runStage("approval replacement and stale claim", () => verifyApprovalReplacementAndStaleClaim(site, privateEvent));
    await runStage("checkout, payment, Ticket, admission, and refund", () => verifyCheckoutAndConsumption(site, privateEvent));
    await runStage("sold-out, safe retry, and withdrawal", () => verifySoldOutAndWithdrawal(site, privateEvent));
  } catch (error) {
    verificationError = error;
  } finally {
    try { await cleanup(); }
    catch (error) { cleanupError = error; }
    try { await stopApp(app); }
    finally { await pool.end(); }
  }
  if (cleanupError) console.error(`Synthetic-fixture cleanup failed: ${safeErrorMessage(cleanupError)}`);
  if (verificationError) throw verificationError;
  if (cleanupError) throw cleanupError;
  console.log("Local private Access Request and checkout verification passed: Site isolation, intentional duplicate versus replay, published discovery before sales, guarded approval/rejection/undo/correction history, notification replacement and stale-token fencing, separate payer and attendee, one active Order and one consumed approval under concurrent HTTP requests, sold-out handling, unresolved withdrawal holds with late paid recovery, Ticket attendee preservation, refund/admission reuse protection, and cleanup against the dedicated local PostgreSQL database. External provider, real email, LMNL, Wallet, device, hosted, and cutover proof remain deferred.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Private-access verification failed.");
  process.exitCode = 1;
});
