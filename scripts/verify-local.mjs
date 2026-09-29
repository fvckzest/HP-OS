import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const supabaseHome = path.join(root, ".local-supabase-home");
const port = Number(process.env.HPOS_VERIFY_PORT ?? 3210);
const origin = `http://127.0.0.1:${port}`;
const databaseUrl = process.env.HPOS_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const env = { ...process.env, NODE_ENV: "development", HPOS_DATABASE_URL: databaseUrl, SUPABASE_HOME: supabaseHome, SUPABASE_TELEMETRY_DISABLED: "1" };

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertPortIsFree() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`Verification port ${port} is already in use.`)));
    server.listen(port, "127.0.0.1", () => server.close((error) => error ? reject(error) : resolve()));
  });
}

function startApp() {
  const child = spawn("next", ["dev", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let recentOutput = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      recentOutput = `${recentOutput}${chunk}`.slice(-5_000);
      process.stdout.write(chunk);
    });
  }
  return { child, get recentOutput() { return recentOutput; } };
}

async function waitForReady(server, pool) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) throw new Error(`The verification app stopped early.\n${server.recentOutput}`);
    try {
      const database = await pool.query("select to_regclass('hpos.site_api_keys') is not null as schema_ready");
      if (!database.rows[0]?.schema_ready) throw new Error("The HP-OS operational schema is not ready.");
      const response = await fetch(`${origin}/v1/admin/payment-configuration`, { signal: AbortSignal.timeout(2_000) });
      if (response.status === 401) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`The application or local PostgreSQL database did not become ready within 90 seconds. Run \`pnpm local\` first.\n${server.recentOutput}`);
}

function stopApp(server) {
  return new Promise((resolve) => {
    if (server.child.exitCode !== null) return resolve();
    server.child.once("exit", () => resolve());
    server.child.kill("SIGTERM");
    setTimeout(() => {
      if (server.child.exitCode === null) server.child.kill("SIGKILL");
    }, 5_000).unref();
  });
}

async function assertDatabaseApiIsNotExposed() {
  try {
    const response = await fetch("http://127.0.0.1:54321/rest/v1/", { signal: AbortSignal.timeout(2_000) });
    if (response.status === 503) return;
    await response.body?.cancel().catch(() => undefined);
    throw new Error("The generated Supabase REST API answered at /rest/v1/; local config must keep the Data API disabled.");
  } catch (error) {
    const causeCode = error && typeof error === "object" && "cause" in error ? error.cause?.code : undefined;
    if (causeCode === "ECONNREFUSED") return;
    if (error instanceof Error && error.message.includes("generated Supabase REST API answered")) throw error;
    throw new Error("Could not verify that the generated Supabase Data API is disabled.");
  }
}

function makeVerificationKey() {
  const id = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const value = `hpos_site_${id}_${secret}`;
  return { id, value, hash: createHash("sha256").update(value, "utf8").digest("hex") };
}

async function createSiteAccessFixtures(pool) {
  const client = await pool.connect();
  const organizationIds = [];
  try {
    await client.query("begin");
    const firstOrganization = (await client.query(
      `insert into hpos.organizations (name) values ($1) returning id`,
      [`Verification ${randomUUID()}`],
    )).rows[0].id;
    const secondOrganization = (await client.query(
      `insert into hpos.organizations (name) values ($1) returning id`,
      [`Other verification ${randomUUID()}`],
    )).rows[0].id;
    organizationIds.push(firstOrganization, secondOrganization);

    const createSite = async (organizationId, name, requestLimit = 1200) => (await client.query(
      `insert into hpos.sites (organization_id, name, request_limit_per_minute) values ($1, $2, $3) returning id`,
      [organizationId, name, requestLimit],
    )).rows[0].id;
    const createConnection = async (organizationId, provider, suffix) => (await client.query(
      `insert into hpos.payment_connections (organization_id, provider, environment, account_reference, location_reference)
       values ($1, $2, 'test', $3, null) returning id`,
      [organizationId, provider, `ref:${suffix}-${randomUUID()}`],
    )).rows[0].id;
    const createKey = async (siteId) => {
      const key = makeVerificationKey();
      await client.query(`insert into hpos.site_api_keys (id, site_id, key_hash) values ($1, $2, $3)`, [key.id, siteId, key.hash]);
      return key;
    };

    const sites = {
      first: await createSite(firstOrganization, "Verification Site One"),
      second: await createSite(firstOrganization, "Verification Site Two"),
      separate: await createSite(firstOrganization, "Verification Site Separate"),
      unassigned: await createSite(firstOrganization, "Verification Site Unassigned"),
      otherOrganization: await createSite(secondOrganization, "Verification Other Organization"),
      limited: await createSite(firstOrganization, "Verification Site Limited", 1),
    };
    const connections = {
      shared: await createConnection(firstOrganization, "square", "verification-shared"),
      separate: await createConnection(firstOrganization, "stripe", "verification-separate"),
      otherOrganization: await createConnection(secondOrganization, "stripe", "verification-other"),
    };
    await client.query(
      `insert into hpos.site_payment_connection_assignments (site_id, organization_id, connection_id)
       values ($1, $3, $5), ($2, $3, $5), ($4, $3, $6), ($7, $8, $9)`,
      [sites.first, sites.second, firstOrganization, sites.separate, connections.shared, connections.separate, sites.otherOrganization, secondOrganization, connections.otherOrganization],
    );
    const keys = {
      first: await createKey(sites.first),
      firstSecond: await createKey(sites.first),
      second: await createKey(sites.second),
      separate: await createKey(sites.separate),
      unassigned: await createKey(sites.unassigned),
      otherOrganization: await createKey(sites.otherOrganization),
      limitedFirst: await createKey(sites.limited),
      limitedSecond: await createKey(sites.limited),
    };
    await client.query("commit");
    return { organizationIds, sites, connections, keys };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function cleanupSiteAccessFixtures(pool, organizationIds) {
  await pool.query(`delete from hpos.site_payment_connection_assignments where organization_id = any($1::uuid[])`, [organizationIds]);
  await pool.query(`delete from hpos.organizations where id = any($1::uuid[])`, [organizationIds]);
}

async function readSiteConfiguration(key, path = "/v1/admin/payment-configuration") {
  const response = await fetch(`${origin}${path}`, { headers: { Authorization: `Bearer ${key.value}` } });
  return { response, body: await response.json() };
}

async function verifySiteAccessIsolationAndLimits(pool) {
  const fixtures = await createSiteAccessFixtures(pool);
  try {
    const missingKey = await fetch(`${origin}/v1/admin/payment-configuration`);
    const missingBody = await missingKey.json();
    assert(missingKey.status === 401 && missingBody.error?.code === "unauthorized", "A missing Site key did not return a structured unauthorized response.");

    for (const [label, key, expectedConnection] of [
      ["first Site", fixtures.keys.first, fixtures.connections.shared],
      ["second Site sharing a connection", fixtures.keys.second, fixtures.connections.shared],
      ["Site with its own connection", fixtures.keys.separate, fixtures.connections.separate],
      ["Site in another Organization", fixtures.keys.otherOrganization, fixtures.connections.otherOrganization],
    ]) {
      const { response, body } = await readSiteConfiguration(key);
      assert(response.status === 200 && body.data?.active_connection?.connection_id === expectedConnection, `The ${label} did not read its assigned payment configuration.`);
      assert(response.headers.get("cache-control") === "no-store", `The ${label} payment configuration response was cacheable.`);
    }

    const unassigned = await readSiteConfiguration(fixtures.keys.unassigned);
    assert(unassigned.response.status === 200 && unassigned.body.data?.active_connection === null, "A Site without an active connection did not receive a null configuration.");

    const crossSite = await readSiteConfiguration(fixtures.keys.first, `/v1/admin/payment-connections/${fixtures.connections.separate}`);
    assert(crossSite.response.status === 404 && crossSite.body.error?.code === "not_found", "A Site could read another Site's connection in the same Organization.");
    const crossOrganization = await readSiteConfiguration(fixtures.keys.otherOrganization, `/v1/admin/payment-connections/${fixtures.connections.separate}`);
    assert(crossOrganization.response.status === 404 && crossOrganization.body.error?.code === "not_found", "A Site could read a connection from another Organization.");

    const firstLimited = await readSiteConfiguration(fixtures.keys.limitedFirst);
    const secondLimited = await readSiteConfiguration(fixtures.keys.limitedSecond);
    assert(firstLimited.response.status === 200, "The first Site key exceeded a fresh Site-wide request budget.");
    assert(secondLimited.response.status === 429 && secondLimited.body.error?.code === "rate_limited", "The request budget was not shared across two keys for the same Site.");
    assert(Number(secondLimited.response.headers.get("retry-after")) > 0, "The Site rate-limit response omitted Retry-After.");
  } finally {
    await cleanupSiteAccessFixtures(pool, fixtures.organizationIds).catch(() => undefined);
  }
}

function runOperator(args, expectedToSucceed = true) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/operator.ts", ...args], { cwd: root, env, encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (expectedToSucceed && result.status !== 0) throw new Error(`The local operator command failed: ${output}`);
  if (!expectedToSucceed && result.status === 0) throw new Error("An invalid operator command was accepted.");
  if (!expectedToSucceed) return output;
  try { return JSON.parse(result.stdout); }
  catch { throw new Error("The operator command did not return its documented JSON result."); }
}

async function verifyOperatorProvisioning(pool) {
  const organizationIds = [];
  try {
    const organization = runOperator(["organization", "create", "--name", `Verification ${randomUUID()}`]);
    organizationIds.push(organization.organization_id);
    assert(organization.fee_terms_status === "pending_validation", "Organization setup invented or omitted the fee-term validation state.");
    runOperator(["organization", "fee-terms-pending", "--organization", organization.organization_id]);
    const credentialRejected = runOperator(["payment-connection", "create", "--organization", organization.organization_id, "--provider", "square", "--environment", "test", "--account-reference", "sk_live_not_a_reference"], false);
    assert(credentialRejected.includes("non-secret reference alias"), "The operator accepted a provider credential instead of a reference alias.");

    const otherOrganization = runOperator(["organization", "create", "--name", `Other organization ${randomUUID()}`]);
    organizationIds.push(otherOrganization.organization_id);
    const site = runOperator(["site", "create", "--organization", organization.organization_id, "--name", "Operator verification Site"]);
    const connection = runOperator(["payment-connection", "create", "--organization", organization.organization_id, "--provider", "square", "--environment", "test", "--account-reference", `ref:test-account-${randomUUID()}`, "--location-reference", `ref:test-location-${randomUUID()}`]);
    const otherConnection = runOperator(["payment-connection", "create", "--organization", otherOrganization.organization_id, "--provider", "stripe", "--environment", "test", "--account-reference", `ref:test-account-${randomUUID()}`]);
    assert(connection.account_eligibility_status === "pending_validation", "Payment account eligibility was claimed without validation.");
    let databaseRejectedCredential = false;
    try {
      await pool.query(
        `insert into hpos.payment_connections (organization_id, provider, environment, account_reference) values ($1, 'square', 'test', $2)`,
        [organization.organization_id, `sk_live_${randomUUID()}`],
      );
    } catch (error) {
      databaseRejectedCredential = error && typeof error === "object" && "code" in error && error.code === "23514";
    }
    assert(databaseRejectedCredential, "The PostgreSQL constraint accepted a credential-shaped account reference.");
    runOperator(["site", "assign-connection", "--site", site.site_id, "--connection", connection.connection_id]);
    const invalidAssignment = runOperator(["site", "assign-connection", "--site", site.site_id, "--connection", otherConnection.connection_id], false);
    assert(invalidAssignment.includes("same organization"), "The operator did not explain why a cross-organization connection assignment was rejected.");
    let connectionHistoryProtected = false;
    try { await pool.query(`delete from hpos.payment_connections where id = $1`, [connection.connection_id]); }
    catch (error) { connectionHistoryProtected = error && typeof error === "object" && "code" in error && error.code === "23503"; }
    assert(connectionHistoryProtected, "PostgreSQL allowed deletion of a connection referenced by assignment history.");
    let siteHistoryProtected = false;
    try { await pool.query(`delete from hpos.sites where id = $1`, [site.site_id]); }
    catch (error) { siteHistoryProtected = error && typeof error === "object" && "code" in error && error.code === "23503"; }
    assert(siteHistoryProtected, "PostgreSQL allowed deletion of a Site referenced by assignment history.");

    const original = runOperator(["site-key", "issue", "--site", site.site_id]);
    assert(typeof original.site_api_key === "string" && original.site_api_key.length > 70, "The operator did not issue a high-entropy Site API key.");
    const originalRead = await fetch(`${origin}/v1/admin/payment-configuration`, { headers: { Authorization: `Bearer ${original.site_api_key}` } });
    assert(originalRead.status === 200, "An issued Site key could not read its payment configuration through HTTP.");
    const originalData = await originalRead.json();
    assert(originalData.data?.active_connection?.connection_id === connection.connection_id, "The Site API returned the wrong assigned payment connection.");

    const rotated = runOperator(["site-key", "rotate", "--site", site.site_id]);
    assert(rotated.site_api_key !== original.site_api_key, "Key rotation reused the previous secret.");
    const oldKey = await fetch(`${origin}/v1/admin/payment-configuration`, { headers: { Authorization: `Bearer ${original.site_api_key}` } });
    const replacementKey = await fetch(`${origin}/v1/admin/payment-configuration`, { headers: { Authorization: `Bearer ${rotated.site_api_key}` } });
    assert(oldKey.status === 401 && replacementKey.status === 200, "Rotation did not reject the previous key and accept the replacement through HTTP.");
    runOperator(["site-key", "revoke", "--site", site.site_id, "--key-id", rotated.key_id]);
    const revokedKey = await fetch(`${origin}/v1/admin/payment-configuration`, { headers: { Authorization: `Bearer ${rotated.site_api_key}` } });
    assert(revokedKey.status === 401, "A revoked Site key remained usable through HTTP.");
  } finally {
    if (organizationIds.length) {
      await pool.query(`delete from hpos.site_payment_connection_assignments where organization_id = any($1::uuid[])`, [organizationIds]).catch(() => undefined);
      await pool.query(`delete from hpos.organizations where id = any($1::uuid[])`, [organizationIds]).catch(() => undefined);
    }
  }
}

function assertStartupRefusesRemoteDatabase() {
  const result = spawnSync(process.execPath, ["scripts/start-local.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: { ...env, HPOS_DATABASE_URL: "postgresql://user:password@database.example:5432/postgres" },
  });
  assert(result.status !== 0 && `${result.stdout}${result.stderr}`.includes("dedicated loopback test database"), "Local startup did not refuse a remote database target.");
}

async function main() {
  assert(Number.isInteger(port) && port >= 3000 && port <= 3999, "HPOS_VERIFY_PORT must be from 3000 to 3999.");
  assert(databaseUrl === "postgresql://postgres:postgres@127.0.0.1:54322/postgres", "The local proof requires the dedicated default local test database URL.");
  await assertPortIsFree();
  await assertDatabaseApiIsNotExposed();
  assertStartupRefusesRemoteDatabase();

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 2_000 });
  const server = startApp();
  try {
    await waitForReady(server, pool);
    await verifyOperatorProvisioning(pool);
    await verifySiteAccessIsolationAndLimits(pool);
  } finally {
    await stopApp(server);
    await pool.end();
  }

  console.log("Local Site API verification passed: operational PostgreSQL schema, generated Data API disabled, credential-shaped references refused, Site and connection isolation, shared Site request limits, key authentication, rotation and revocation verified through HTTP.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Local verification failed.");
  process.exitCode = 1;
});
