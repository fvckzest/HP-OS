import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { apiFailure, apiSuccess, withRequestCorrelation } from "../src/server/api-response.ts";
import { apiFailureContract, classifyApiFailure, emitServerDiagnostic, operationForV1, safeDatabaseErrorCode } from "../src/server/api-diagnostics.ts";

const requestId = "1f8d1f5d-b7a4-4aa5-b0e3-8bb7a5e3d9e2";

const success = await withRequestCorrelation(apiSuccess({ ok: true }), requestId);
assert.equal(success.headers.get("x-request-id"), requestId);
assert.equal((await success.json()).request_id, requestId);

const failure = await withRequestCorrelation(apiFailure(500, "internal_error", "The operation failed."), requestId);
assert.equal(failure.headers.get("x-request-id"), requestId);
const failureBody = await failure.json();
assert.equal(failureBody.request_id, requestId);
assert.equal(failureBody.error.code, "internal_error");

const temporaryDatabaseError = { code: "08006", message: "database connection failed" };
assert.equal(safeDatabaseErrorCode(temporaryDatabaseError), "08006");
assert.equal(classifyApiFailure(temporaryDatabaseError), "temporary_dependency");
assert.equal(classifyApiFailure(new Error("unexpected invariant")), "unexpected_application");
assert.deepEqual(apiFailureContract("unexpected_application", 1), {
  status: 500,
  code: "internal_error",
  message: "The requested API operation failed unexpectedly.",
});
assert.deepEqual(apiFailureContract("temporary_dependency", 30), {
  status: 503,
  code: "service_unavailable",
  message: "The requested API operation is temporarily unavailable.",
  retryAfter: 30,
});
assert.equal(operationForV1("GET", ["public", "orders", "a-very-long-secret-token-value-that-must-not-be-logged"]), "GET /v1/public/orders/:token");

const output = [];
const originalConsoleError = console.error;
console.error = (value) => output.push(String(value));
try {
  emitServerDiagnostic({
    requestId,
    operation: operationForV1("POST", ["admin", "notification-jobs", "a-very-long-secret-token-value-that-must-not-be-logged"]),
    failureCategory: "temporary_dependency",
    error: { name: "DatabaseError", code: "08006", message: "Bearer hpos_site_secret and approval_token must not appear" },
    runId: "9f7e5e39-6535-4b7b-9e65-83ee9fa0e4a8",
  });
} finally {
  console.error = originalConsoleError;
}
assert.equal(output.length, 1);
const diagnostic = JSON.parse(output[0]);
assert.deepEqual(diagnostic, {
  event: "hpos.server_failure",
  request_id: requestId,
  operation: "POST /v1/admin/notification-jobs/:token",
  failure_category: "temporary_dependency",
  database_error_code: "08006",
  error_type: "DatabaseError",
  run_id: "9f7e5e39-6535-4b7b-9e65-83ee9fa0e4a8",
});
assert(!output[0].includes("hpos_site_secret"));
assert(!output[0].includes("approval_token"));

function siteApiKey() {
  return `hpos_site_${randomUUID()}_${randomBytes(32).toString("base64url")}`;
}

async function waitForServer(baseUrl, child, getOutput) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Next.js exited before becoming ready:\n${getOutput()}`);
    try {
      const response = await fetch(`${baseUrl}/`);
      if (response.status >= 200 && response.status < 500) return;
    } catch {
      // The development server can take a moment to bind and compile the root route.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Next.js did not become ready:\n${getOutput()}`);
}

async function withNextServer(databaseUrl, callback) {
  const port = 3400 + Math.floor(Math.random() * 400);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      NODE_ENV: "development",
      HPOS_DATABASE_URL: databaseUrl,
      CRON_SECRET: "",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let outputText = "";
  child.stdout.on("data", (chunk) => { outputText += chunk.toString(); });
  child.stderr.on("data", (chunk) => { outputText += chunk.toString(); });
  const getOutput = () => outputText;
  try {
    await waitForServer(baseUrl, child, getOutput);
    return await callback(baseUrl, getOutput);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
}

async function fetchJson(baseUrl, pathname, init = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, init);
  const text = await response.text();
  return {
    response,
    body: text ? JSON.parse(text) : null,
  };
}

function assertCorrelated(result) {
  const headerId = result.response.headers.get("x-request-id");
  assert.match(headerId ?? "", /^[0-9a-f-]{36}$/i);
  assert.equal(result.body?.request_id, headerId);
  return headerId;
}

const transientDatabaseUrl = "postgresql://postgres:postgres@127.0.0.1:1/postgres";
const secretKey = siteApiKey();
await withNextServer(transientDatabaseUrl, async (baseUrl, getOutput) => {
  const unauthorized = await fetchJson(baseUrl, "/v1/admin/payment-configuration");
  assert.equal(unauthorized.response.status, 401);
  assert.equal(unauthorized.body.error.code, "unauthorized");
  assertCorrelated(unauthorized);

  const apiFailureResult = await fetchJson(baseUrl, "/v1/admin/payment-configuration", {
    headers: { authorization: `Bearer ${secretKey}` },
  });
  const apiRequestId = assertCorrelated(apiFailureResult);
  assert.equal(apiFailureResult.response.status, 503);
  assert.equal(apiFailureResult.body.error.code, "service_unavailable");
  assert.equal(apiFailureResult.response.headers.get("retry-after"), "1");
  assert.match(getOutput(), new RegExp(`"request_id":"${apiRequestId}"`));
  assert.match(getOutput(), /"operation":"GET \/v1\/admin\/payment-configuration"/);
  assert.match(getOutput(), /"failure_category":"temporary_dependency"/);
  assert(!getOutput().includes(secretKey));

  const scheduledFailure = await fetchJson(baseUrl, "/api/cron/process");
  const scheduledRequestId = assertCorrelated(scheduledFailure);
  assert.equal(scheduledFailure.response.status, 503);
  assert.equal(scheduledFailure.body.error.code, "service_unavailable");
  assert.equal(scheduledFailure.response.headers.get("retry-after"), "30");
  assert.match(getOutput(), new RegExp(`"request_id":"${scheduledRequestId}"`));
  assert.match(getOutput(), /"operation":"GET \/api\/cron\/process"/);
  assert.match(getOutput(), /"run_id":"[0-9a-f-]{36}"/);
});

await withNextServer("not-a-valid-postgres-url", async (baseUrl, getOutput) => {
  const apiFailureResult = await fetchJson(baseUrl, "/v1/admin/payment-configuration", {
    headers: { authorization: `Bearer ${siteApiKey()}` },
  });
  const apiRequestId = assertCorrelated(apiFailureResult);
  assert.equal(apiFailureResult.response.status, 500);
  assert.equal(apiFailureResult.body.error.code, "internal_error");
  assert.equal(apiFailureResult.response.headers.get("retry-after"), null);
  assert.match(getOutput(), new RegExp(`"request_id":"${apiRequestId}"`));
  assert.match(getOutput(), /"failure_category":"unexpected_application"/);

  const scheduledFailure = await fetchJson(baseUrl, "/api/cron/process");
  const scheduledRequestId = assertCorrelated(scheduledFailure);
  assert.equal(scheduledFailure.response.status, 500);
  assert.equal(scheduledFailure.body.error.code, "internal_error");
  assert.equal(scheduledFailure.response.headers.get("retry-after"), null);
  assert.match(getOutput(), new RegExp(`"request_id":"${scheduledRequestId}"`));
  assert.match(getOutput(), /"operation":"GET \/api\/cron\/process"/);
  assert.match(getOutput(), /"failure_category":"unexpected_application"/);
});

console.log("Diagnostics verification passed, including /v1 and scheduled route boundaries.");
