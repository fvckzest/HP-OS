import { getLocalApiOrigin } from "@/src/workbench/environment";
import { insertHistory, inspectLocalDatabase } from "@/src/workbench/database";
import { guardWorkbenchRequest, readBoundedText } from "@/src/workbench/http";
import { MAX_CAPTURE_BYTES, safeRequestHeaders, safeResponseHeaders, safeRoute, sanitizeJsonText, type SafeJson } from "@/src/workbench/redaction";
import type { CheckResult, OutcomeState, RequestExecution } from "@/src/workbench/types";

export const dynamic = "force-dynamic";
const MAX_REQUEST_BYTES = 128 * 1024;
const REQUEST_METHODS = new Set(["GET", "POST", "PATCH", "PUT", "DELETE"]);
const ALLOWED_HEADERS = new Set(["accept", "content-type", "if-match", "if-none-match", "idempotency-key"]);
const FORBIDDEN_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie", "host", "origin", "x-api-key", "api-key"]);

interface ManualRequestInput {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  expectedStatus?: number | null;
  attempt?: number;
}

async function readResponseSummary(response: Response): Promise<{ value: SafeJson | null; truncated: boolean; byteLength: number }> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    await response.body?.cancel().catch(() => undefined);
    return { value: { kind: "body_omitted", reason: "response was not JSON", contentType: contentType.slice(0, 100) || null } as SafeJson, truncated: true, byteLength: 0 };
  }

  if (!response.body) return { value: null, truncated: false, byteLength: 0 };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_CAPTURE_BYTES) {
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  if (truncated) return { value: { kind: "body_truncated", byteLengthAtLeast: total } as SafeJson, truncated: true, byteLength: total };
  const text = new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  const parsed = sanitizeJsonText(text);
  return { value: parsed.value as SafeJson | null, truncated: parsed.truncated, byteLength: parsed.bytes };
}

function parseManualRequest(value: unknown): { input: ManualRequestInput | null; error: string | null } {
  if (!value || typeof value !== "object") return { input: null, error: "Request must be a JSON object." };
  const candidate = value as Record<string, unknown>;
  const method = typeof candidate.method === "string" ? candidate.method.toUpperCase() : "";
  const path = typeof candidate.path === "string" ? candidate.path : "";
  const body = typeof candidate.body === "string" ? candidate.body : "";
  if (!REQUEST_METHODS.has(method)) return { input: null, error: "Choose GET, POST, PATCH, PUT, or DELETE." };
  if (!path.startsWith("/v1/") || path.startsWith("//") || path.includes("\\") || path.includes("#")) return { input: null, error: "Use a local HP-OS API path beginning with /v1/." };
  if (Buffer.byteLength(body, "utf8") > MAX_CAPTURE_BYTES) return { input: null, error: "Request bodies must be 64 KiB or smaller." };
  if (method === "GET" && body.trim()) return { input: null, error: "GET requests cannot include a body." };
  const expectedStatus = candidate.expectedStatus === null || candidate.expectedStatus === "" || candidate.expectedStatus === undefined
    ? null
    : Number(candidate.expectedStatus);
  if (expectedStatus !== null && (!Number.isInteger(expectedStatus) || expectedStatus < 100 || expectedStatus > 599)) return { input: null, error: "Expected status must be an HTTP status from 100 to 599." };
  const headers = candidate.headers === undefined ? {} : candidate.headers;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return { input: null, error: "Headers must be a JSON object." };
  for (const [name, headerValue] of Object.entries(headers as Record<string, unknown>)) {
    const lower = name.toLowerCase();
    if (FORBIDDEN_HEADERS.has(lower)) return { input: null, error: "Authentication and browser security headers are supplied by the local server, not request details." };
    if (!ALLOWED_HEADERS.has(lower)) return { input: null, error: `Header ${name} is not allowed in this foundation slice.` };
    if (typeof headerValue !== "string" || /[\r\n]/.test(headerValue)) return { input: null, error: `Header ${name} must have a single-line text value.` };
  }
  const attempt = candidate.attempt === undefined ? 1 : Number(candidate.attempt);
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 1000) return { input: null, error: "Attempt must be a positive integer." };
  return { input: { method, path, body, headers: headers as Record<string, string>, expectedStatus, attempt }, error: null };
}

export async function POST(request: Request) {
  const denied = guardWorkbenchRequest(request, true);
  if (denied) return denied;

  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return Response.json({ error: "Send request details as JSON." }, { status: 415 });
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(await readBoundedText(request, MAX_REQUEST_BYTES));
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === "request_too_large";
    return Response.json({ error: tooLarge ? "Request details exceed the workbench limit." : "Request details are not valid JSON." }, { status: 400 });
  }

  const { input, error } = parseManualRequest(parsedBody);
  if (error || !input) return Response.json({ error: error ?? "Request details are invalid." }, { status: 400 });

  const database = await inspectLocalDatabase();
  if (!database.ready) return Response.json({ error: database.message }, { status: 503 });
  const base = getLocalApiOrigin();
  if (!base) return Response.json({ error: "The configured API target is not the workbench loopback origin." }, { status: 503 });

  let target: URL;
  try {
    target = new URL(input.path, base);
  } catch {
    return Response.json({ error: "The API path is invalid." }, { status: 400 });
  }
  if (target.origin !== base.origin || !target.pathname.startsWith("/v1/")) {
    return Response.json({ error: "The API target must remain under the local /v1 path." }, { status: 400 });
  }

  const headers = new Headers(input.headers);
  if (input.body) headers.set("content-type", headers.get("content-type") ?? "application/json");
  if (process.env.HPOS_SITE_API_KEY) headers.set("authorization", `Bearer ${process.env.HPOS_SITE_API_KEY}`);

  const requestBodySummary = sanitizeJsonText(input.body);
  const requestBodyIncomplete = requestBodySummary.truncated;
  const safeRequestSnapshot = {
    method: input.method,
    route: safeRoute(target.pathname),
    headers: safeRequestHeaders(Object.fromEntries(headers.entries())),
    body: requestBodySummary.value,
    bodyBytes: Buffer.byteLength(input.body, "utf8"),
  } as unknown as SafeJson;
  const expectationSnapshot = input.expectedStatus === null ? null : ({ status: input.expectedStatus } as SafeJson);

  const startedAt = performance.now();
  let outcome: OutcomeState = "response_received";
  let statusCode: number | null = null;
  let responseSnapshot: SafeJson | null = null;
  let responseHeaders: Record<string, string> = {};
  let errorCode: string | null = null;
  let responseTruncated = false;

  let upstream: Response | null = null;
  try {
    upstream = await fetch(target, {
      method: input.method,
      headers,
      body: input.body || undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
  } catch {
    outcome = "outcome_unknown";
    errorCode = "network_error";
    responseSnapshot = { kind: "response_unavailable", reason: "No HTTP response was received; do not retry automatically." };
  }

  if (upstream) {
    statusCode = upstream.status;
    responseHeaders = safeResponseHeaders(upstream.headers);
    if (statusCode >= 300 && statusCode < 400) {
      await upstream.body?.cancel().catch(() => undefined);
      responseSnapshot = { kind: "redirect_blocked", reason: "The workbench does not follow redirects." };
    } else {
      try {
        const summary = await readResponseSummary(upstream);
        responseSnapshot = summary.value;
        responseTruncated = summary.truncated;
      } catch {
        responseSnapshot = { kind: "body_unavailable", reason: "HTTP status was received, but the response body could not be captured." };
        responseTruncated = true;
      }
    }
  }

  const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
  const result: CheckResult = outcome === "outcome_unknown"
    ? "unknown"
    : input.expectedStatus === null
      ? "not_checked"
      : statusCode === input.expectedStatus
        ? "passed"
        : "failed";
  const record = {
    source: "manual" as const,
    attempt: input.attempt ?? 1,
    method: input.method,
    route: safeRoute(target.pathname),
    request_snapshot: safeRequestSnapshot,
    expectation_snapshot: expectationSnapshot,
    result_state: result,
    outcome_state: outcome,
    status_code: statusCode,
    response_snapshot: responseSnapshot,
    error_code: errorCode,
    duration_ms: durationMs,
    capture_state: responseTruncated || requestBodyIncomplete ? "incomplete" as const : "stored" as const,
    environment: "local",
    dataset_label: "local-foundation-empty",
    revision: process.env.HPOS_REVISION ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown",
  };

  let historyId: string | null = null;
  let capture: "stored" | "incomplete" = responseTruncated || requestBodyIncomplete ? "incomplete" : "stored";
  try {
    historyId = await insertHistory(record);
  } catch {
    capture = "incomplete";
    // A diagnostic-store failure never repeats or changes the API operation.
    console.warn("Local workbench history capture is incomplete.");
  }

  const execution: RequestExecution = {
    id: historyId,
    method: input.method,
    route: safeRoute(target.pathname),
    outcome,
    statusCode,
    result,
    response: responseSnapshot,
    responseHeaders,
    redirectBlocked: statusCode !== null && statusCode >= 300 && statusCode < 400,
    capture,
    message: outcome === "outcome_unknown" ? "Outcome unknown. The workbench did not retry the request." : undefined,
  };

  return Response.json(execution, { headers: { "Cache-Control": "no-store" } });
}
