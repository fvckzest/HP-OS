import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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

function createSiteFixture() {
  const organization = runOperator(["organization", "create", "--name", "Issue 26 verification " + randomUUID()]);
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

async function createPublishedEvent(site, { title, startsAt, endsAt }) {
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
      time_zone: "America/Los_Angeles",
      visibility: "public",
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
  const firstPage = await api(site, "/v1/public/events?period=current&limit=1");
  assert(firstPage.status === 200 && firstPage.data.data.length === 1 && firstPage.data.pagination.next_cursor, "Current Event pagination did not return a deterministic cursor.");
  const secondPage = await api(site, "/v1/public/events?period=current&limit=1&cursor=" + encodeURIComponent(firstPage.data.pagination.next_cursor));
  assert(secondPage.status === 200 && secondPage.data.data.length === 1 && !secondPage.data.pagination.next_cursor, "The public Event cursor did not return the following page.");
  const wrongScope = await api(site, "/v1/public/events?period=current&limit=2&cursor=" + encodeURIComponent(firstPage.data.pagination.next_cursor));
  assert(wrongScope.status === 400 && wrongScope.data.error.code === "invalid_cursor", "A cursor was accepted with a different page size.");
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
  assert(otherSiteCursor.status === 400 && otherSiteCursor.data.error.code === "invalid_cursor", "A Site accepted another Site's cursor.");
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
  } finally {
    await cleanup();
    await stopApp(app);
    await pool.end();
  }
  console.log("Local Event API verification passed: drafts, retries, partial edits, sales configuration locks, publish rules, current and past discovery, pagination, eligible archiving, and Site isolation.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Event verification failed.");
  process.exitCode = 1;
});
