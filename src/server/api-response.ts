import { randomUUID } from "node:crypto";

export function apiSuccess(data: unknown, status = 200, options: { nextCursor?: string | null } = {}): Response {
  return Response.json({
    data,
    ...(Object.hasOwn(options, "nextCursor") ? { pagination: { next_cursor: options.nextCursor ?? null } } : {}),
    request_id: randomUUID(),
  }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function apiFailure(
  status: number,
  code: string,
  message: string,
  options: { details?: Array<{ field: string; code: string; message: string }>; retryAfter?: number } = {},
): Response {
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (options.retryAfter !== undefined) headers.set("Retry-After", String(options.retryAfter));
  return Response.json({
    error: {
      code,
      message,
      details: options.details ?? [],
    },
    request_id: randomUUID(),
  }, { status, headers });
}
