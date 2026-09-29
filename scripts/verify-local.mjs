import { spawn, spawnSync } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const supabaseHome = path.join(root, ".local-supabase-home");
const port = Number(process.env.HPOS_VERIFY_PORT ?? 3210);
const origin = `http://127.0.0.1:${port}`;
const databaseUrl = process.env.HPOS_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const revision = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).stdout?.trim() || "unknown";
const env = { ...process.env, NODE_ENV: "development", HPOS_LOCAL_WORKBENCH: "1", HPOS_DATABASE_URL: databaseUrl, HPOS_WORKBENCH_ORIGIN: origin, HPOS_API_BASE_URL: origin, HPOS_REVISION: revision, SUPABASE_HOME: supabaseHome, SUPABASE_TELEMETRY_DISABLED: "1" };

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

async function assertDatabaseApiIsNotExposed() {
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: 54321 });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error("Supabase's generated Data API responded on port 54321; local config must keep it disabled."));
    });
    socket.once("error", (error) => {
      if (error.code === "ECONNREFUSED") resolve();
      else reject(new Error("Could not verify that the generated Data API is disabled."));
    });
    setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out while checking that the generated Data API is disabled."));
    }, 2_000).unref();
  });
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
    const response = await fetch(`${origin}/api/workbench/requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ method: "POST", path: "/v1/__workbench_persistence_probe", headers: { Accept: "application/json", "Idempotency-Key": "workbench-secret-idempotency-key" }, body: JSON.stringify({ access_token: "workbench-secret-token", buyer: { email: "private@example.invalid", name: "Private Person" }, safe: { error: { code: "not_found" } } }), expectedStatus: 404 }),
    });
    assert(response.status === 200, "The workbench HTTP request runner did not return an execution result.");
    const execution = await response.json();
    assert(execution.statusCode === 404 && execution.result === "passed" && execution.capture === "stored", "The local probe did not produce its expected recorded 404 response.");
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

    const wrongHost = await fetch(`${origin}/api/workbench/status`, { headers: { Host: "evil.example:3210" } });
    assert(wrongHost.status === 403, "A non-local Host header was not refused.");
  } finally {
    await stopApp(second);
  }

  console.log("Local boundary verification passed: real test PostgreSQL, generated Data API disabled, and diagnostic history persisted across an app restart.");
  console.log("The verification probe exercised an absent /v1 path and did not create a business record.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Local verification failed.");
  process.exitCode = 1;
});
