import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const supabaseHome = path.join(root, ".local-supabase-home");
const port = Number(process.env.HPOS_VERIFY_PORT ?? 3210);
const origin = `http://127.0.0.1:${port}`;
const databaseUrl = process.env.HPOS_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const revision = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).stdout?.trim() || "unknown";
const env = { ...process.env, NODE_ENV: "development", HPOS_LOCAL_WORKBENCH: "1", HPOS_DATABASE_URL: databaseUrl, HPOS_WORKBENCH_PORT: String(port), HPOS_WORKBENCH_ORIGIN: origin, HPOS_API_BASE_URL: origin, HPOS_REVISION: revision, SUPABASE_HOME: supabaseHome, SUPABASE_TELEMETRY_DISABLED: "1" };

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

async function waitForReady(server) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) throw new Error(`The verification app stopped early.\n${server.recentOutput}`);
    try {
      const response = await fetch(`${origin}/api/workbench/status`, { headers: { Origin: origin }, signal: AbortSignal.timeout(2_000) });
      if (response.status === 200) {
        const status = await response.json();
        assert(
          status.database?.ready === true,
          "The local PostgreSQL database is not ready. Run `pnpm local` first, then run `pnpm verify:local`.",
        );
        return status;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`The verification app did not become ready within 90 seconds.\n${server.recentOutput}`);
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

function fetchWithHostHeader(url, host) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers: { Host: host } }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once("error", reject);
    request.setTimeout(2_000, () => request.destroy(new Error("Host-check request timed out.")));
    request.end();
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

async function verifyCaptureFailureIsolation() {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 2_000 });
  try {
    // Remove a stale, narrowly scoped trigger if a previous verification was interrupted.
    await pool.query("drop trigger if exists local_workbench_capture_failure_probe on workbench.call_history");
    await pool.query("drop function if exists workbench.reject_capture_failure_probe()");
    await pool.query(`
      create function workbench.reject_capture_failure_probe() returns trigger
      language plpgsql as $capture$
      begin
        raise exception 'intentional local workbench capture failure probe';
      end;
      $capture$
    `);
    await pool.query(`
      create trigger local_workbench_capture_failure_probe
      before insert on workbench.call_history
      for each row
      when (new.request_snapshot #>> '{body,code}' = 'hpos_capture_failure_probe')
      execute function workbench.reject_capture_failure_probe()
    `);

    const response = await fetch(`${origin}/api/workbench/requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ method: "POST", path: "/v1/__workbench_capture_failure_probe", headers: { Accept: "application/json" }, body: JSON.stringify({ code: "hpos_capture_failure_probe" }), expectedStatus: 405 }),
    });
    assert(response.status === 200, "A diagnostic history write failure changed the local workbench response status.");
    const execution = await response.json();
    assert(execution.statusCode === 405 && execution.result === "passed", "The local HTTP operation did not preserve its observed result when history storage failed.");
    assert(execution.capture === "incomplete" && execution.id === null, "The workbench did not report the history capture failure.");
  } finally {
    await pool.query("drop trigger if exists local_workbench_capture_failure_probe on workbench.call_history").catch(() => undefined);
    await pool.query("drop function if exists workbench.reject_capture_failure_probe()").catch(() => undefined);
    await pool.end();
  }
}

async function verifySiteAccessConfiguration() {
  const response = await fetch(`${origin}/api/workbench/site-access-check`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
  });
  assert(response.status === 200, "The Site access guided workflow did not complete over the local workbench boundary.");
  const result = await response.json();
  assert(result.result === "passed", "Site key lifecycle, configuration isolation, shared connections, or request-limit verification failed.");
  assert(Array.isArray(result.steps) && result.steps.length >= 12, "The Site access workflow did not return its expected evidence steps.");
  assert(result.steps.every((step) => step.result === "passed" && step.capture === "stored"), "A Site access API check failed or its evidence was not recorded.");
  assert(result.steps.some((step) => step.id === "site-rate-limit" && step.statusCode === 429), "The Site-wide request limit was not exercised through HTTP.");
}

function runOperator(args, expectedToSucceed = true) {
  const result = spawnSync(process.execPath, ["scripts/operator.mjs", ...args], { cwd: root, env, encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (expectedToSucceed && result.status !== 0) throw new Error(`The local operator command failed: ${output}`);
  if (!expectedToSucceed && result.status === 0) throw new Error("An invalid operator assignment was accepted.");
  if (!expectedToSucceed) return output;
  try { return JSON.parse(result.stdout); }
  catch { throw new Error("The operator command did not return its documented JSON result."); }
}

async function verifyOperatorProvisioning() {
  const organizationIds = [];
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 2_000 });
  try {
    const organization = runOperator(["organization", "create", "--name", `Verification ${randomUUID()}`]);
    organizationIds.push(organization.organization_id);
    assert(organization.fee_terms_status === "pending_validation", "Organization setup invented or omitted the fee-term validation state.");
    runOperator(["organization", "fee-terms-pending", "--organization", organization.organization_id]);

    const otherOrganization = runOperator(["organization", "create", "--name", `Other organization ${randomUUID()}`]);
    organizationIds.push(otherOrganization.organization_id);
    const site = runOperator(["site", "create", "--organization", organization.organization_id, "--name", "Operator verification Site"]);
    const connection = runOperator(["payment-connection", "create", "--organization", organization.organization_id, "--provider", "square", "--environment", "test", "--account-reference", `test-account-${randomUUID()}`, "--location-reference", `test-location-${randomUUID()}`]);
    const otherConnection = runOperator(["payment-connection", "create", "--organization", otherOrganization.organization_id, "--provider", "stripe", "--environment", "test", "--account-reference", `test-account-${randomUUID()}`]);
    assert(connection.account_eligibility_status === "pending_validation", "Payment account eligibility was claimed without validation.");
    runOperator(["site", "assign-connection", "--site", site.site_id, "--connection", connection.connection_id]);
    const invalidAssignment = runOperator(["site", "assign-connection", "--site", site.site_id, "--connection", otherConnection.connection_id], false);
    assert(invalidAssignment.includes("same organization"), "The operator did not explain why a cross-organization connection assignment was rejected.");

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
    if (organizationIds.length) await pool.query(`delete from hpos.organizations where id = any($1::uuid[])`, [organizationIds]).catch(() => undefined);
    await pool.end();
  }
}

function assertStartupRefusesRemoteTargets() {
  const badDatabase = spawnSync(process.execPath, ["scripts/start-local.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: { ...env, HPOS_DATABASE_URL: "postgresql://user:password@database.example:5432/postgres" },
  });
  assert(badDatabase.status !== 0 && `${badDatabase.stdout}${badDatabase.stderr}`.includes("dedicated loopback test database"), "Local startup did not refuse a remote database target.");

  const badApi = spawnSync(process.execPath, ["scripts/start-local.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: { ...env, HPOS_API_BASE_URL: "https://api.example.com" },
  });
  assert(badApi.status !== 0 && `${badApi.stdout}${badApi.stderr}`.includes("remote and alternate targets are refused"), "Local startup did not refuse a remote API target.");
}

async function main() {
  assert(Number.isInteger(port) && port >= 3000 && port <= 3999, "HPOS_VERIFY_PORT must be from 3000 to 3999.");
  assert(databaseUrl === "postgresql://postgres:postgres@127.0.0.1:54322/postgres", "The local proof requires the dedicated default local test database URL.");
  await assertPortIsFree();
  await assertDatabaseApiIsNotExposed();
  assertStartupRefusesRemoteTargets();

  const first = startApp();
  let probeId = "";
  try {
    const status = await waitForReady(first);
    assert(status.generatedDatabaseApi?.state === "disabled", "Status did not confirm that the generated database API is disabled.");
    assert(status.hposBusinessApi?.state === "available", "Status did not report the implemented Site configuration API capability.");
    await verifyOperatorProvisioning();
    await verifySiteAccessConfiguration();
    const response = await fetch(`${origin}/api/workbench/requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ method: "POST", path: "/v1/__workbench_persistence_probe", headers: { Accept: "application/json", "Idempotency-Key": "workbench-secret-idempotency-key" }, body: JSON.stringify({ access_token: "workbench-secret-token", buyer: { email: "private@example.invalid", name: "Private Person" }, safe: { error: { code: "not_found" } } }), expectedStatus: 405 }),
    });
    assert(response.status === 200, "The workbench HTTP request runner did not return an execution result.");
    const execution = await response.json();
    assert(execution.statusCode === 405 && execution.result === "passed" && execution.capture === "incomplete", "The local probe did not produce its expected 405 response with an explicit omitted-body marker.");
    probeId = execution.id;
    assert(typeof probeId === "string" && probeId.length > 0, "The request result was not saved to PostgreSQL.");
    const savedResponse = await fetch(`${origin}/api/workbench/history`, { headers: { Origin: origin } });
    const savedHistory = await savedResponse.json();
    const probe = savedHistory.records.find((record) => record.id === probeId);
    assert(Boolean(probe), "The saved request could not be read through the workbench API.");
    const capturedJson = JSON.stringify(probe);
    for (const secret of ["workbench-secret-idempotency-key", "workbench-secret-token", "private@example.invalid", "Private Person"]) {
      assert(!capturedJson.includes(secret), `History exposed a protected value: ${secret}.`);
    }
    assert(JSON.stringify(probe.request_snapshot).includes("[REDACTED]"), "History did not mark protected request fields as redacted.");
    await verifyCaptureFailureIsolation();
  } finally {
    await stopApp(first);
  }

  const second = startApp();
  try {
    await waitForReady(second);
    const response = await fetch(`${origin}/api/workbench/history`, { headers: { Origin: origin } });
    assert(response.status === 200, "History could not be read after application restart.");
    const history = await response.json();
    assert(history.records.some((record) => record.id === probeId), "The saved request was not present after application restart.");

    const wrongOrigin = await fetch(`${origin}/api/workbench/history`, { method: "DELETE", headers: { Origin: "http://evil.example" } });
    assert(wrongOrigin.status === 403, "A cross-origin history mutation was not refused.");

    const wrongHostStatus = await fetchWithHostHeader(`${origin}/api/workbench/status`, "evil.example:3210");
    assert(wrongHostStatus === 403, "A non-local Host header was not refused.");
  } finally {
    await stopApp(second);
  }

  console.log("Local API verification passed: real test PostgreSQL, Site-key lifecycle, connection isolation, shared assignments, Site-wide request limits, generated Data API disabled, and history persisted across an app restart.");
  console.log("Synthetic Site and payment-configuration records were removed after the guided checks.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Local verification failed.");
  process.exitCode = 1;
});
