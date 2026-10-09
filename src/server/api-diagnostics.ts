import { randomUUID } from "node:crypto";

export type ApiFailureCategory = "temporary_dependency" | "unexpected_application";

const TRANSIENT_DATABASE_CODES = new Set([
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  "57P01",
  "57P02",
  "57P03",
  "53300",
  "55P03",
  "57014",
]);

const TRANSIENT_SYSTEM_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function errorProperty(error: unknown, key: string): unknown {
  return object(error) ? error[key] : undefined;
}

/** PostgreSQL SQLSTATE values are safe to retain because they contain no data. */
export function safeDatabaseErrorCode(error: unknown): string | null {
  const code = errorProperty(error, "code");
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

function safeSystemErrorCode(error: unknown): string | null {
  const code = errorProperty(error, "code");
  return typeof code === "string" && TRANSIENT_SYSTEM_CODES.has(code) ? code : null;
}

function hasTransientCode(error: unknown): boolean {
  const databaseCode = safeDatabaseErrorCode(error);
  if (databaseCode && TRANSIENT_DATABASE_CODES.has(databaseCode)) return true;
  if (safeSystemErrorCode(error)) return true;
  const cause = errorProperty(error, "cause");
  return cause !== error && cause !== undefined && hasTransientCode(cause);
}

/**
 * Only known dependency failures are retryable. Everything else is treated as
 * an application failure so a programming or invariant error is not disguised
 * as a temporary outage.
 */
export function classifyApiFailure(error: unknown): ApiFailureCategory {
  if (hasTransientCode(error)) return "temporary_dependency";
  const status = errorProperty(error, "status");
  return status === 503 ? "temporary_dependency" : "unexpected_application";
}

export function apiFailureContract(category: ApiFailureCategory, retryAfter: number): {
  status: 500 | 503;
  code: "internal_error" | "service_unavailable";
  message: string;
  retryAfter?: number;
} {
  if (category === "temporary_dependency") {
    return {
      status: 503,
      code: "service_unavailable",
      message: "The requested API operation is temporarily unavailable.",
      retryAfter,
    };
  }
  return {
    status: 500,
    code: "internal_error",
    message: "The requested API operation failed unexpectedly.",
  };
}

function safeErrorType(error: unknown): string | null {
  if (!object(error) || typeof error.name !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,80}$/.test(error.name)) return null;
  return error.name;
}

export function requestId(): string {
  return randomUUID();
}

export function operationForV1(method: string, path: string[]): string {
  const safePath = path.map((segment) => {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(segment)) return ":id";
    if (/^[A-Za-z0-9_-]{32,200}$/.test(segment)) return ":token";
    if (/^(?:art|col|photo)_[A-Za-z0-9_-]{22}$/.test(segment)) return ":resource_id";
    if (!/^[A-Za-z0-9._~-]{1,40}$/.test(segment)) return ":value";
    return segment;
  });
  return `${method.toUpperCase()} /v1${safePath.length ? `/${safePath.join("/")}` : ""}`;
}

export interface ServerDiagnostic {
  requestId: string;
  operation: string;
  failureCategory: ApiFailureCategory;
  error?: unknown;
  runId?: string;
}

/**
 * Emit one JSON log entry with an allow-listed shape. Never serialize the
 * original Error or a request body because either can contain credentials or
 * buyer access material.
 */
export function emitServerDiagnostic(input: ServerDiagnostic): void {
  const entry: Record<string, string> = {
    event: "hpos.server_failure",
    request_id: input.requestId,
    operation: input.operation,
    failure_category: input.failureCategory,
  };
  const databaseErrorCode = safeDatabaseErrorCode(input.error);
  if (databaseErrorCode) entry.database_error_code = databaseErrorCode;
  const errorType = safeErrorType(input.error);
  if (errorType) entry.error_type = errorType;
  if (input.runId) entry.run_id = input.runId;
  console.error(JSON.stringify(entry));
}
