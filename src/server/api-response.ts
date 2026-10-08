import { randomUUID } from "node:crypto";

export interface ApiResponseOptions {
  nextCursor?: string | null;
  requestId?: string;
}

export function apiSuccess(data: unknown, status = 200, options: ApiResponseOptions = {}): Response {
  const requestId = options.requestId ?? randomUUID();
  return Response.json({
    data,
    ...(Object.hasOwn(options, "nextCursor") ? { pagination: { next_cursor: options.nextCursor ?? null } } : {}),
    request_id: requestId,
  }, {
    status,
    headers: { "Cache-Control": "no-store", "X-Request-Id": requestId },
  });
}

export function apiFailure(
  status: number,
  code: string,
  message: string,
  options: { details?: Array<{ field: string; code: string; message: string }>; retryAfter?: number; requestId?: string } = {},
): Response {
  const requestId = options.requestId ?? randomUUID();
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (options.retryAfter !== undefined) headers.set("Retry-After", String(options.retryAfter));
  headers.set("X-Request-Id", requestId);
  return Response.json({
    error: {
      code,
      message,
      details: options.details ?? [],
    },
    request_id: requestId,
  }, { status, headers });
}

/** Apply the route-bound correlation ID to a response produced by a handler. */
export async function withRequestCorrelation(response: Response, requestId: string): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set("X-Request-Id", requestId);
  const contentType = headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) {
    const body = await response.clone().json().catch(() => null) as unknown;
    if (body && typeof body === "object" && !Array.isArray(body)) {
      headers.delete("content-length");
      return Response.json({ ...body, request_id: requestId }, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
