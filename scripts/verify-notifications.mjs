import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.HPOS_VERIFY_NOTIFICATIONS_PORT ?? 3275);
const origin = `http://127.0.0.1:${port}`;
const databaseUrl = process.env.HPOS_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const cronSecret = randomUUID();
const actor = { type: "system", reference: "test:issue-25-worker" };
const env = {
  ...process.env,
  NODE_ENV: "development",
  HPOS_DATABASE_URL: databaseUrl,
  CRON_SECRET: cronSecret,
  NEXT_TELEMETRY_DISABLED: "1",
};
const pool = new pg.Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 2_000 });
const organizationIds = [];
const testJobIds = [];
let app;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function isLocalDatabase(value) {
  try {
    const url = new URL(value);
    return url.protocol === "postgresql:" && url.hostname === "127.0.0.1" && url.port === "54322" && url.username === "postgres" && url.pathname === "/postgres" && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function assertPortIsFree() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`Notification verification port ${port} is already in use.`)));
    server.listen(port, "127.0.0.1", () => server.close((error) => error ? reject(error) : resolve()));
  });
}

function startApp() {
  const nextBin = path.join(root, "node_modules/next/dist/bin/next");
  const child = spawn(process.execPath, [nextBin, "dev", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-5_000);
      process.stdout.write(chunk);
    });
  }
  return { child, get output() { return output; } };
}

async function waitForReady(server) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) throw new Error(`The notification verification app stopped early.\n${server.output}`);
    try {
      const response = await fetch(`${origin}/v1/admin/notification-jobs`, { signal: AbortSignal.timeout(2_000) });
      if (response.status === 401) return;
      await response.body?.cancel().catch(() => undefined);
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`The notification verification app did not become ready within 90 seconds.\n${server.output}`);
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
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/operator.ts", ...args], { cwd: root, env, encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) throw new Error(`The local operator command failed: ${output}`);
  try { return JSON.parse(result.stdout); }
  catch { throw new Error("The local operator command did not return JSON."); }
}

async function createSiteFixture(label) {
  const organization = runOperator(["organization", "create", "--name", `${label} ${randomUUID()}`]);
  organizationIds.push(organization.organization_id);
  const site = runOperator(["site", "create", "--organization", organization.organization_id, "--name", label]);
  const key = runOperator(["site-key", "issue", "--site", site.site_id]);
  return { siteId: site.site_id, apiKey: key.site_api_key };
}

async function api(site, pathName, { method = "GET", key = site.apiKey, idempotencyKey, body } = {}) {
  const headers = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const response = await fetch(`${origin}${pathName}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  let data = null;
  try { data = await response.json(); } catch {}
  return { status: response.status, data };
}

function eventSnapshot(eventId) {
  return {
    event_id: eventId,
    event_reference: `event-${eventId.slice(0, 8)}`,
    title: "Notification verification Event",
    starts_at: "2026-10-10T19:00:00-07:00",
    ends_at: "2026-10-10T21:00:00-07:00",
    time_zone: "America/Los_Angeles",
    venue: { name: "Local verification venue", address: null },
  };
}

async function seedClaim(siteId, expired) {
  const claimId = randomUUID();
  await pool.query(
    `insert into hpos.notification_claims (id, site_id, lease_expires_at, created_actor_type, created_actor_reference)
     values ($1, $2, case when $3 then clock_timestamp() - interval '1 second' else clock_timestamp() + interval '5 minutes' end, 'system', $4)`,
    [claimId, siteId, expired, actor.reference],
  );
  return claimId;
}

async function seedJob(siteId, kind, payload, references = {}, claimId = null) {
  const jobId = randomUUID();
  await pool.query(
    `insert into hpos.notification_jobs (
       id, site_id, kind, event_id, order_id, access_request_id, ticket_id,
       payload, claim_id, lease_fence
     ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
    [jobId, siteId, kind, references.eventId ?? null, references.orderId ?? null, references.accessRequestId ?? null, references.ticketId ?? null, JSON.stringify(payload), claimId, claimId ? 1 : 0],
  );
  testJobIds.push(jobId);
  return jobId;
}

function ticketPayload(eventId, orderId) {
  return {
    recipient_email: `buyer-${orderId.slice(0, 8)}@example.invalid`,
    buyer_name: "Local Test Buyer",
    event: eventSnapshot(eventId),
    order: { order_id: orderId, order_reference: `order-${orderId.slice(0, 8)}`, order_token: `order-token-${randomUUID()}` },
  };
}

async function cron() {
  const response = await fetch(`${origin}/api/cron/process`, {
    headers: { Authorization: `Bearer ${cronSecret}` },
    signal: AbortSignal.timeout(30_000),
  });
  let body = null;
  try { body = await response.json(); } catch {}
  return { status: response.status, data: body };
}

async function verifyNotificationApi(site, otherSite) {
  const eventId = randomUUID();
  const orderId = randomUUID();
  const ticketJobId = await seedJob(site.siteId, "tickets_ready", ticketPayload(eventId, orderId), { eventId, orderId });
  const noAuth = await api(site, "/v1/admin/notification-jobs", { key: null });
  assert(noAuth.status === 401, "Notification reads did not require a Site API key.");

  const list = await api(site, "/v1/admin/notification-jobs?kind=tickets_ready&limit=1");
  assert(list.status === 200 && Array.isArray(list.data?.data) && list.data.data.some((job) => job.job_id === ticketJobId), "The Site could not list its own notification jobs through the API.");
  assert(list.data?.pagination && typeof list.data.pagination.next_cursor !== "undefined", "The job list did not use the standard pagination wrapper.");
  const hiddenJob = await api(otherSite, `/v1/admin/notification-jobs/${ticketJobId}`);
  assert(hiddenJob.status === 404, "A different Site could read this notification job.");

  const claimBody = { limit: 1, kinds: ["tickets_ready"], actor };
  const claimKey = randomUUID();
  const claim = await api(site, "/v1/admin/notification-jobs/claims", { method: "POST", idempotencyKey: claimKey, body: claimBody });
  assert(claim.status === 200 && claim.data.data.jobs.length === 1, "The API did not claim the seeded job.");
  const claimedJob = claim.data.data.jobs[0];
  assert(claimedJob.job_id === ticketJobId && claimedJob.lease_fence === 1, "The claim did not return the initial lease fence.");
  const replayedClaim = await api(site, "/v1/admin/notification-jobs/claims", { method: "POST", idempotencyKey: claimKey, body: claimBody });
  assert(replayedClaim.status === 200 && replayedClaim.data.data.claim_id === claim.data.data.claim_id, "A same-key claim retry did not replay the original claim.");
  const overlappingClaim = await api(site, "/v1/admin/notification-jobs/claims", { method: "POST", idempotencyKey: randomUUID(), body: claimBody });
  assert(overlappingClaim.status === 200 && overlappingClaim.data.data.jobs.length === 0, "An overlapping Site worker claimed an already leased job.");

  const renew = await api(site, `/v1/admin/notification-jobs/claims/${claim.data.data.claim_id}/renew`, { method: "POST", idempotencyKey: randomUUID(), body: { actor } });
  assert(renew.status === 200 && new Date(renew.data.data.lease_expires_at) > new Date(claim.data.data.lease_expires_at), "The Site could not renew its active lease.");

  const originalClaimId = claim.data.data.claim_id;
  await pool.query(`update hpos.notification_claims set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1`, [originalClaimId]);
  const recovered = await cron();
  assert(recovered.status === 200 && recovered.data.data.recovered_jobs === 1, "Scheduled processing did not recover the expired job.");
  const staleOutcome = await api(site, `/v1/admin/notification-jobs/${ticketJobId}/outcome-reports`, {
    method: "POST",
    idempotencyKey: randomUUID(),
    body: { claim_id: originalClaimId, lease_fence: 1, outcome: "completed", provider_message_reference: "stale-message-reference", observed_at: new Date().toISOString(), error_code: null, actor },
  });
  assert(staleOutcome.status === 409 && staleOutcome.data?.error?.code === "claim_conflict", "A stale worker could report an outcome after its lease expired.");

  const nextClaim = await api(site, "/v1/admin/notification-jobs/claims", {
    method: "POST", idempotencyKey: randomUUID(), body: claimBody,
  });
  assert(nextClaim.status === 200 && nextClaim.data.data.jobs[0]?.requires_verification === true && nextClaim.data.data.jobs[0]?.lease_fence === 3, "An expired claim was not reissued with verification required and a new fence.");
  const nextJob = nextClaim.data.data.jobs[0];
  const messageReference = `test-message-${randomUUID()}`;
  const completedBody = {
    claim_id: nextClaim.data.data.claim_id,
    lease_fence: nextJob.lease_fence,
    outcome: "completed",
    provider_message_reference: messageReference,
    observed_at: new Date().toISOString(),
    error_code: null,
    actor,
  };
  const outcomeKey = randomUUID();
  const completed = await api(site, `/v1/admin/notification-jobs/${ticketJobId}/outcome-reports`, { method: "POST", idempotencyKey: outcomeKey, body: completedBody });
  assert(completed.status === 200 && completed.data.data.status === "completed", "The fresh worker could not report the verified send.");
  const replayedOutcome = await api(site, `/v1/admin/notification-jobs/${ticketJobId}/outcome-reports`, { method: "POST", idempotencyKey: outcomeKey, body: completedBody });
  assert(replayedOutcome.status === 200 && replayedOutcome.data.data.status === "completed", "A report retry did not reuse its original result.");

  const deliveryBody = {
    outcome: "delivered",
    provider_message_reference: messageReference,
    provider_event_reference: `test-delivery-${randomUUID()}`,
    observed_at: new Date().toISOString(),
    actor,
  };
  const delivery = await api(site, `/v1/admin/notification-jobs/${ticketJobId}/delivery-reports`, { method: "POST", idempotencyKey: randomUUID(), body: deliveryBody });
  assert(delivery.status === 200 && delivery.data.data.delivery_status === "delivered" && delivery.data.data.delivery_reports.length === 1, "The API did not accept and expose the provider delivery report.");

  const unknownTicketId = randomUUID();
  const unknownJobId = await seedJob(site.siteId, "wallet_update", { ticket_id: unknownTicketId, data_version: "v2" }, { ticketId: unknownTicketId });
  const unknownClaimBody = { limit: 1, kinds: ["wallet_update"], actor };
  const firstUnknownClaim = await api(site, "/v1/admin/notification-jobs/claims", { method: "POST", idempotencyKey: randomUUID(), body: unknownClaimBody });
  const firstUnknownJob = firstUnknownClaim.data.data.jobs[0];
  assert(firstUnknownClaim.status === 200 && firstUnknownJob.job_id === unknownJobId, "The Site could not claim the unknown-outcome fixture.");
  const unknown = await api(site, `/v1/admin/notification-jobs/${unknownJobId}/outcome-reports`, {
    method: "POST", idempotencyKey: randomUUID(),
    body: { claim_id: firstUnknownClaim.data.data.claim_id, lease_fence: firstUnknownJob.lease_fence, outcome: "unknown", provider_message_reference: null, observed_at: new Date().toISOString(), error_code: "provider_timeout", actor },
  });
  assert(unknown.status === 200 && unknown.data.data.requires_verification === true, "An unknown provider outcome did not require verification.");
  const verificationClaim = await api(site, "/v1/admin/notification-jobs/claims", { method: "POST", idempotencyKey: randomUUID(), body: unknownClaimBody });
  assert(verificationClaim.status === 200 && verificationClaim.data.data.jobs[0]?.requires_verification === true, "A re-claimed unknown dispatch did not tell the Site to verify before resending.");
  const verificationJob = verificationClaim.data.data.jobs[0];
  const unresolved = await api(site, `/v1/admin/notification-jobs/${unknownJobId}/outcome-reports`, {
    method: "POST", idempotencyKey: randomUUID(),
    body: { claim_id: verificationClaim.data.data.claim_id, lease_fence: verificationJob.lease_fence, outcome: "unknown", provider_message_reference: null, observed_at: new Date().toISOString(), error_code: "provider_lookup_inconclusive", actor },
  });
  assert(unresolved.status === 200 && unresolved.data.data.requires_verification === true, "An inconclusive Site verification cleared the resend safeguard.");
}

async function verifyLegacyIdempotencyReplay(site) {
  const body = { limit: 1, kinds: ["tickets_ready"], actor };
  const key = randomUUID();
  const route = "/v1/admin/notification-jobs/claims";
  const oldFingerprint = createHash("sha256").update(`${route}\n${canonicalJson(body)}`, "utf8").digest("hex");
  await pool.query(
    `insert into hpos.api_idempotency_records (
       site_id, idempotency_key, request_fingerprint, response_status,
       response_data, completed_at
     ) values ($1, $2, $3, 200, $4::jsonb, clock_timestamp())`,
    [site.siteId, key, oldFingerprint, JSON.stringify({ replay: "before-site-wide-namespace" })],
  );
  const response = await api(site, route, { method: "POST", idempotencyKey: key, body });
  assert(response.status === 200 && response.data.data.replay === "before-site-wide-namespace", "An in-flight notification idempotency key from before the Site-wide namespace migration did not replay.");
}

async function verifyConcurrentClaims(site) {
  const jobIds = [];
  for (let index = 0; index < 2; index += 1) {
    const eventId = randomUUID();
    const orderId = randomUUID();
    jobIds.push(await seedJob(site.siteId, "tickets_ready", ticketPayload(eventId, orderId), { eventId, orderId }));
  }
  const body = { limit: 1, kinds: ["tickets_ready"], actor };
  const claims = await Promise.all([
    api(site, "/v1/admin/notification-jobs/claims", { method: "POST", idempotencyKey: randomUUID(), body }),
    api(site, "/v1/admin/notification-jobs/claims", { method: "POST", idempotencyKey: randomUUID(), body }),
  ]);
  assert(claims.every((claim) => claim.status === 200 && claim.data.data.jobs.length === 1), "Concurrent workers did not claim distinct seeded jobs.");
  const claimedIds = claims.map((claim) => claim.data.data.jobs[0].job_id);
  assert(new Set(claimedIds).size === 2 && claimedIds.every((id) => jobIds.includes(id)), "Concurrent workers received duplicate or unexpected jobs.");
}

async function verifyBoundedAndOverlappingScheduler(site) {
  const batchClaimId = await seedClaim(site.siteId, true);
  const batchIds = [];
  for (let index = 0; index < 51; index += 1) {
    const ticketId = randomUUID();
    batchIds.push(await seedJob(site.siteId, "wallet_update", { ticket_id: ticketId, data_version: `batch-${index}` }, { ticketId }, batchClaimId));
  }
  const first = await cron();
  assert(first.status === 200 && first.data.data.recovered_jobs === 50 && first.data.data.has_more === true, "The scheduler did not enforce its 50-job recovery bound.");
  const second = await cron();
  assert(second.status === 200 && second.data.data.recovered_jobs === 1 && second.data.data.has_more === false, "The scheduler did not expose the remaining expired work for the next run.");
  const recoveredBatch = await pool.query(`select count(*)::integer as count from hpos.notification_jobs where id = any($1::uuid[]) and requires_verification = true and claim_id is null`, [batchIds]);
  assert(recoveredBatch.rows[0].count === 51, "The bounded scheduler lost or failed to mark expired jobs for verification.");

  const overlapClaimId = await seedClaim(site.siteId, true);
  const overlapIds = [];
  for (let index = 0; index < 4; index += 1) {
    const ticketId = randomUUID();
    overlapIds.push(await seedJob(site.siteId, "wallet_update", { ticket_id: ticketId, data_version: `overlap-${index}` }, { ticketId }, overlapClaimId));
  }
  const overlappingRuns = await Promise.all([cron(), cron()]);
  assert(overlappingRuns.every((run) => run.status === 200), "Overlapping scheduler requests did not complete successfully.");
  assert(overlappingRuns.reduce((sum, run) => sum + run.data.data.recovered_jobs, 0) === overlapIds.length, "Overlapping scheduler runs skipped or recovered the same job more than once.");
}

async function cleanup() {
  await stopApp(app);
  if (organizationIds.length) {
    await pool.query("delete from hpos.organizations where id = any($1::uuid[])", [organizationIds]).catch(() => undefined);
  }
  await pool.end();
}

async function main() {
  assert(Number.isInteger(port) && port >= 3000 && port <= 3999, "HPOS_VERIFY_NOTIFICATIONS_PORT must be from 3000 to 3999.");
  assert(isLocalDatabase(databaseUrl), "Notification verification requires the dedicated loopback PostgreSQL test database at 127.0.0.1:54322/postgres.");
  await assertPortIsFree();
  await pool.query("select 1");
  app = startApp();
  try {
    await waitForReady(app);
    const site = await createSiteFixture("Notification verification Site");
    const otherSite = await createSiteFixture("Notification isolation Site");
    await verifyLegacyIdempotencyReplay(site);
    await verifyNotificationApi(site, otherSite);
    await verifyConcurrentClaims(site);
    await verifyBoundedAndOverlappingScheduler(site);
    console.log("Notification API and scheduler verification passed against local PostgreSQL. Site reports were simulated; no provider was contacted.");
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Notification verification failed.");
  process.exitCode = 1;
});
