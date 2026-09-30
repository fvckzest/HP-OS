import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { getBusinessPool } from "./database";
import { apiFailure, apiSuccess } from "./api-response";
import type { AuthenticatedSite } from "./site-auth";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface IdempotentResult {
  data: unknown;
  status: number;
}

export class ApiOperationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Array<{ field: string; code: string; message: string }> = [],
  ) {
    super(message);
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (object(value)) {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}

function fingerprint(request: Request, body: unknown): string {
  const route = request.method.toUpperCase() + "\n" + new URL(request.url).pathname;
  return createHash("sha256").update(route + "\n" + canonicalJson(body), "utf8").digest("hex");
}

function legacyPostFingerprint(request: Request, body: unknown): string {
  const route = new URL(request.url).pathname;
  return createHash("sha256").update(route + "\n" + canonicalJson(body), "utf8").digest("hex");
}

function isPgCode(error: unknown, code: string): boolean {
  return object(error) && error.code === code;
}

function errorData(error: ApiOperationError) {
  return { code: error.code, message: error.message, details: error.details };
}

function responseFor(status: number, data: unknown): Response {
  if (status < 400) return apiSuccess(data, status);
  if (!object(data) || typeof data.code !== "string" || typeof data.message !== "string") {
    return apiFailure(503, "service_unavailable", "The saved operation result is unavailable.", { retryAfter: 1 });
  }
  const details = Array.isArray(data.details) ? data.details as Array<{ field: string; code: string; message: string }> : [];
  return apiFailure(status, data.code, data.message, { details });
}

export async function withApiIdempotency(
  request: Request,
  site: AuthenticatedSite,
  body: unknown,
  action: (client: PoolClient) => Promise<IdempotentResult>,
  mapUnexpectedError?: (error: unknown) => Response | null,
  legacyPostBody?: unknown,
): Promise<Response> {
  const key = request.headers.get("idempotency-key") ?? "";
  if (!UUID_PATTERN.test(key)) {
    return apiFailure(422, "validation_failed", "Idempotency-Key must be a UUID.", {
      details: [{ field: "headers.Idempotency-Key", code: "invalid_uuid", message: "Provide a UUID for this operation." }],
    });
  }

  const client = await getBusinessPool().connect();
  const requestFingerprint = fingerprint(request, body);
  const compatibleLegacyFingerprint = legacyPostBody === undefined
    ? null
    : legacyPostFingerprint(request, legacyPostBody);
  try {
    await client.query("begin");
    await client.query("set local lock_timeout = '1s'");
    const inserted = await client.query(
      `insert into hpos.api_idempotency_records (site_id, idempotency_key, request_fingerprint)
       values ($1, $2, $3) on conflict (site_id, idempotency_key) do nothing returning idempotency_key`,
      [site.siteId, key, requestFingerprint],
    );
    if (inserted.rowCount === 0) {
      const saved = await client.query<{
        request_fingerprint: string;
        response_status: number | null;
        response_data: unknown;
        completed_at: Date | null;
      }>(
        `select request_fingerprint, response_status, response_data, completed_at
         from hpos.api_idempotency_records
         where site_id = $1 and idempotency_key = $2 for update`,
        [site.siteId, key],
      );
      const record = saved.rows[0];
      if (!record || (record.request_fingerprint !== requestFingerprint && record.request_fingerprint !== compatibleLegacyFingerprint)) {
        throw new ApiOperationError(409, "idempotency_conflict", "This Idempotency-Key was already used for a different operation.");
      }
      if (!record.completed_at || record.response_status === null || record.response_data === null) {
        throw new ApiOperationError(409, "request_in_progress", "The original operation is still processing; retry with the same key after a short delay.");
      }
      if (record.completed_at.getTime() < Date.now() - 7 * 24 * 60 * 60 * 1000) {
        throw new ApiOperationError(409, "idempotency_expired", "The replay window for this Idempotency-Key has expired; inspect the current record before taking another action.");
      }
      await client.query("commit");
      return responseFor(record.response_status, record.response_data);
    }

    await client.query("savepoint idempotent_operation");
    let result: IdempotentResult;
    try {
      result = await action(client);
    } catch (error) {
      let domainError = error instanceof ApiOperationError && error.status >= 400 && error.status < 500 ? error : null;
      if (!domainError && mapUnexpectedError) {
        const mapped = mapUnexpectedError(error);
        if (mapped && mapped.status >= 400 && mapped.status < 500) {
          try {
            const payload = await mapped.json() as { error?: { code?: unknown; message?: unknown; details?: unknown } };
            if (typeof payload.error?.code === "string" && typeof payload.error.message === "string") {
              const details = Array.isArray(payload.error.details)
                ? payload.error.details as Array<{ field: string; code: string; message: string }>
                : [];
              domainError = new ApiOperationError(mapped.status, payload.error.code, payload.error.message, details);
            }
          } catch { /* Keep an unreadable mapped failure transient. */ }
        }
      }
      if (!domainError) throw error;
      await client.query("rollback to savepoint idempotent_operation");
      await client.query(
        `update hpos.api_idempotency_records
         set response_status = $3, response_data = $4::jsonb, completed_at = clock_timestamp()
         where site_id = $1 and idempotency_key = $2`,
        [site.siteId, key, domainError.status, JSON.stringify(errorData(domainError))],
      );
      await client.query("commit");
      return responseFor(domainError.status, errorData(domainError));
    }
    await client.query(
      `update hpos.api_idempotency_records
       set response_status = $3, response_data = $4::jsonb, completed_at = clock_timestamp()
       where site_id = $1 and idempotency_key = $2`,
      [site.siteId, key, result.status, JSON.stringify(result.data)],
    );
    await client.query("commit");
    return apiSuccess(result.data, result.status);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    if (error instanceof ApiOperationError) {
      return apiFailure(error.status, error.code, error.message, {
        details: error.details,
        retryAfter: error.code === "request_in_progress" || error.status === 503 ? 1 : undefined,
      });
    }
    if (isPgCode(error, "55P03")) {
      return apiFailure(409, "request_in_progress", "The original operation is still processing; retry with the same key after a short delay.", { retryAfter: 1 });
    }
    if (mapUnexpectedError) {
      const mapped = mapUnexpectedError(error);
      if (mapped) return mapped;
    }
    return apiFailure(503, "service_unavailable", "The requested API operation is temporarily unavailable.", { retryAfter: 1 });
  } finally {
    client.release();
  }
}
