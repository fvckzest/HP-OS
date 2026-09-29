export const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_KEYS = 100;

const SENSITIVE_KEY = /(^|[_-])(token|secret|password|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|signature|qr[_-]?payload|email|name|address|phone|card|payment(?:[_-]?(?:details|method|reference))?)([_-]|$)/i;
const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|apikey|password|secret|private-key|access-token|refresh-token|idempotency-key)$/i;

export type SafeJson = null | boolean | number | string | SafeJson[] | { [key: string]: SafeJson };

function containsCaptureGap(value: SafeJson | null): boolean {
  if (typeof value === "string") return value.startsWith("[TRUNCATED:");
  if (Array.isArray(value)) return value.some(containsCaptureGap);
  if (value && typeof value === "object") {
    if ("_capture" in value) return true;
    return Object.values(value).some(containsCaptureGap);
  }
  return false;
}

export function sanitizeValue(value: unknown, depth = 0, parentKey?: string): SafeJson {
  if (depth > MAX_DEPTH) return "[TRUNCATED: maximum depth]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (["code", "field", "status", "state", "version", "request_id", "hpos_request_id", "job_id"].includes(parentKey ?? "") && /^[A-Za-z0-9_.:[\]-]{1,120}$/.test(value)) return value;
    return "[REDACTED: free-text value]";
  }
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, depth + 1, parentKey));
    if (value.length > MAX_ARRAY_ITEMS) kept.push(`[TRUNCATED: ${value.length - MAX_ARRAY_ITEMS} items]`);
    return kept;
  }
  if (typeof value === "object") {
    const allKeys = Object.keys(value as object);
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS);
    const result: Record<string, SafeJson> = {};
    for (const [key, nested] of entries) result[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitizeValue(nested, depth + 1, key.toLowerCase());
    if (allKeys.length > MAX_OBJECT_KEYS) result._capture = "[TRUNCATED: too many object fields]";
    return result;
  }
  return "[REDACTED: unsupported value]";
}

export function sanitizeJsonText(raw: string | null | undefined): { value: SafeJson | { _capture: string; bytes: number } | null; bytes: number; truncated: boolean } {
  if (!raw) return { value: null, bytes: 0, truncated: false };
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > MAX_CAPTURE_BYTES) return { value: { _capture: "body exceeds the 64 KiB capture limit", bytes }, bytes, truncated: true };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "string") return { value: "[REDACTED: free-text JSON value]", bytes, truncated: false };
    const value = sanitizeValue(parsed);
    return { value, bytes, truncated: containsCaptureGap(value) };
  } catch {
    return { value: { _capture: "body is not valid JSON; contents were omitted", bytes }, bytes, truncated: true };
  }
}

export function safeRoute(rawPath: string): string {
  const pathOnly = rawPath.split("?", 1)[0] ?? "/";
  const routeWords = new Set(["v1", "admin", "public", "events", "orders", "tickets", "admissions", "access-requests", "payment-attempts", "payment-reports", "refund-reports", "actions", "quotes", "checkouts", "checkout-reference", "setup-failure", "closure-reports", "resolve", "ticket-lookup", "totals", "apple-wallet-data", "status", "workbench"]);
  return pathOnly.split("/").map((segment) => {
    if (!segment) return segment;
    if (!routeWords.has(segment.toLowerCase())) return ":redacted";
    return segment;
  }).join("/");
}

export function safeRequestHeaders(headers: Record<string, string>): Record<string, string> {
  const allowed = new Set(["accept", "content-type", "if-match", "if-none-match"]);
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (SECRET_HEADER.test(lower)) result[name] = "[REDACTED]";
    else if (allowed.has(lower) && (lower === "accept" || lower === "content-type") && /^[A-Za-z0-9*.+\/;-]{1,120}$/.test(value)) result[name] = value;
    else if (allowed.has(lower)) result[name] = "[REDACTED]";
  }
  return result;
}

export function safeResponseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ["content-type", "retry-after", "x-request-id", "x-hpos-request-id"]) {
    const value = headers.get(name);
    if (!value) continue;
    const safeValue = name === "retry-after"
      ? /^[0-9]{1,6}$/.test(value) ? value : "[REDACTED]"
      : /^[A-Za-z0-9*.+\/;_-]{1,120}$/.test(value) ? value : "[REDACTED]";
    result[name] = safeValue;
  }
  return result;
}
