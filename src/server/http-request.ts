import { apiFailure } from "./api-response";

export const MAX_JSON_BODY_BYTES = 64 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTOR_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export interface SiteActor {
  type: "user" | "system";
  reference: string;
}

export interface JsonBodyMessages {
  unsupportedMediaType: string;
  readError: string;
  invalidJson: string;
  nonObject: string;
  tooLarge?: string;
  missingBody?: string;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function parseSiteActor(value: unknown, options: { trimReference?: boolean } = {}): SiteActor | null {
  if (!isObject(value) || !hasOnlyKeys(value, ["type", "reference"])) return null;
  if ((value.type !== "user" && value.type !== "system") || typeof value.reference !== "string") return null;
  const reference = options.trimReference === false ? value.reference : value.reference.trim();
  if (!ACTOR_REFERENCE_PATTERN.test(reference)) return null;
  return { type: value.type, reference };
}

export async function readJson(request: Request, messages: JsonBodyMessages): Promise<unknown | Response> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return apiFailure(415, "unsupported_media_type", messages.unsupportedMediaType);
  }

  const reader = request.body?.getReader();
  if (!reader) {
    if (messages.missingBody) return apiFailure(400, "invalid_request", messages.missingBody);
    return apiFailure(400, "invalid_request", messages.invalidJson);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_JSON_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return apiFailure(413, "request_too_large", messages.tooLarge ?? "The request body exceeds 64 KiB.");
      }
      chunks.push(value);
    }
  } catch {
    return apiFailure(400, "invalid_request", messages.readError);
  }

  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"));
  } catch {
    return apiFailure(400, "invalid_request", messages.invalidJson);
  }
  return value;
}

export async function readJsonObject(request: Request, messages: JsonBodyMessages): Promise<Record<string, unknown> | Response> {
  const value = await readJson(request, messages);
  if (value instanceof Response) return value;
  if (!isObject(value)) return apiFailure(400, "invalid_request", messages.nonObject);
  return value;
}
