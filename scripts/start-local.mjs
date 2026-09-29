import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const supabaseHome = path.join(root, ".local-supabase-home");
const localDatabaseUrl = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const port = Number(process.env.HPOS_WORKBENCH_PORT ?? 3000);

function fail(message) {
  console.error(`HP-OS local startup stopped: ${message}`);
  process.exit(1);
}

function validLocalDatabaseUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "postgresql:" && url.hostname === "127.0.0.1" && url.port === "54322" && url.username === "postgres" && url.pathname === "/postgres" && !url.search && !url.hash;
  } catch {
    return false;
  }
}

if (process.env.NODE_ENV === "production") fail("The workbench is disabled in production mode.");
if (!Number.isInteger(port) || port < 3000 || port > 3999) fail("HPOS_WORKBENCH_PORT must be an unused port from 3000 to 3999.");
const origin = `http://127.0.0.1:${port}`;
const databaseUrl = process.env.HPOS_DATABASE_URL ?? localDatabaseUrl;
if (!validLocalDatabaseUrl(databaseUrl)) fail("HPOS_DATABASE_URL must point to the dedicated loopback test database at 127.0.0.1:54322/postgres.");
if (process.env.HPOS_WORKBENCH_ORIGIN && process.env.HPOS_WORKBENCH_ORIGIN !== origin) fail(`HPOS_WORKBENCH_ORIGIN must match ${origin}.`);
if (process.env.HPOS_API_BASE_URL && process.env.HPOS_API_BASE_URL !== origin) fail(`HPOS_API_BASE_URL must match ${origin}; remote and alternate targets are refused.`);

const docker = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
if (docker.status !== 0) fail("Start Docker Desktop or another Docker-compatible runtime, then run `pnpm local` again.");

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} stopped with ${signal ?? `exit code ${code}`}`));
    });
  });
}

const revision = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).stdout?.trim() || "unknown";
const localEnv = {
  ...process.env,
  NODE_ENV: "development",
  HPOS_LOCAL_WORKBENCH: "1",
  HPOS_DATABASE_URL: databaseUrl,
  HPOS_WORKBENCH_ORIGIN: origin,
  HPOS_API_BASE_URL: origin,
  HPOS_REVISION: revision,
  SUPABASE_HOME: supabaseHome,
  SUPABASE_TELEMETRY_DISABLED: "1",
};

try {
  console.log("Starting the private local PostgreSQL service and applying pending HP-OS migrations…");
  await run("pnpm", ["exec", "supabase", "start"], localEnv);
  await run("node", ["scripts/check-local-database.mjs"], localEnv);
} catch (error) {
  fail(error instanceof Error ? error.message : "The local database could not be prepared.");
}

console.log(`HP-OS local workbench: ${origin}/workbench`);
console.log("The PostgreSQL volume is persistent. Stop this app with Ctrl-C; `pnpm exec supabase stop` stops services without resetting the database.");
try {
  await run("pnpm", ["exec", "next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], localEnv);
} catch (error) {
  fail(error instanceof Error ? error.message : "The HP-OS app could not start.");
}
