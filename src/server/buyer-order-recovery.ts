import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { apiFailure } from "./api-response";
import { withApiIdempotency } from "./api-idempotency";
import type { IdempotentResult } from "./api-idempotency";
import { enqueueNotificationJob } from "./notifications";
import type { AuthenticatedSite } from "./site-auth";

const MAX_BODY_BYTES = 64 * 1024;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function tokenHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function parseRecoveryBody(request: Request): Promise<{ email: string; normalizedEmail: string } | Response> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return noStore(apiFailure(415, "unsupported_media_type", "Send the recovery email as application/json."));
  }

  let bodyText: string;
  try { bodyText = await request.text(); }
  catch { return noStore(apiFailure(400, "invalid_request", "The recovery request body could not be read.")); }
  if (Buffer.byteLength(bodyText, "utf8") > MAX_BODY_BYTES) {
    return noStore(apiFailure(413, "request_too_large", "The request body exceeds 64 KiB."));
  }

  let body: unknown;
  try { body = JSON.parse(bodyText); }
  catch { return noStore(apiFailure(400, "invalid_request", "The recovery request body must contain readable JSON.")); }
  if (!isObjectRecord(body) || !hasOnlyKeys(body, ["email"]) || typeof body.email !== "string") {
    return noStore(apiFailure(422, "validation_failed", "Provide only the buyer email address for Order recovery."));
  }

  const email = body.email.trim();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    return noStore(apiFailure(422, "validation_failed", "Provide a valid buyer email address.", {
      details: [{ field: "email", code: "invalid_email", message: "Use a valid email address of at most 254 characters." }],
    }));
  }
  return { email, normalizedEmail: email.toLowerCase() };
}

async function queueRecoveryEmail(
  client: PoolClient,
  site: AuthenticatedSite,
  normalizedEmail: string,
): Promise<IdempotentResult> {
  await client.query(
    "select pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`order-recovery:${site.siteId}:${normalizedEmail}`],
  );

  const orders = await client.query<{
    id: string;
    order_reference: string;
    delivery_email: string;
  }>(
    `select id, order_reference, delivery_email
     from hpos.orders
     where site_id = $1 and lower(btrim(delivery_email)) = $2
     order by created_at asc, id asc
     for update`,
    [site.siteId, normalizedEmail],
  );
  if (orders.rowCount === 0) return { status: 202, data: { accepted: true } };

  const sends = await client.query<{ recent_hour_count: number; recent_minute_count: number }>(
    `select
       count(*) filter (where created_at >= clock_timestamp() - interval '1 hour')::integer as recent_hour_count,
       count(*) filter (where created_at >= clock_timestamp() - interval '1 minute')::integer as recent_minute_count
     from hpos.notification_jobs
     where site_id = $1 and kind = 'order_recovery'
       and created_at >= clock_timestamp() - interval '1 hour'
       and lower(btrim(payload ->> 'recipient_email')) = $2`,
    [site.siteId, normalizedEmail],
  );
  const recentHourCount = sends.rows[0]?.recent_hour_count ?? 0;
  const recentMinuteCount = sends.rows[0]?.recent_minute_count ?? 0;
  if (recentMinuteCount > 0 || recentHourCount >= 5) {
    return { status: 202, data: { accepted: true } };
  }

  const orderLinks: Array<{
    order_id: string;
    order_reference: string;
    order_token: string;
    expires_at: string;
  }> = [];
  for (const order of orders.rows) {
    const token = randomBytes(32).toString("base64url");
    const expiry = await client.query<{ expires_at: Date }>(
      `insert into hpos.order_recovery_tokens (id, site_id, order_id, token_hash, expires_at)
       values ($1, $2, $3, $4, clock_timestamp() + interval '30 minutes')
       returning expires_at`,
      [randomUUID(), site.siteId, order.id, tokenHash(token)],
    );
    orderLinks.push({
      order_id: order.id,
      order_reference: order.order_reference,
      order_token: token,
      expires_at: expiry.rows[0].expires_at.toISOString(),
    });
  }

  await enqueueNotificationJob(client, {
    siteId: site.siteId,
    kind: "order_recovery",
    payload: { recipient_email: orders.rows[0].delivery_email, orders: orderLinks },
  });
  return { status: 202, data: { accepted: true } };
}

export async function handleBuyerOrderRecoveryPost(
  request: Request,
  site: AuthenticatedSite,
  path: string[],
): Promise<Response | null> {
  if (path.length !== 2 || path[0] !== "public" || path[1] !== "order-recovery") return null;

  const body = await parseRecoveryBody(request);
  if (body instanceof Response) return body;

  const response = await withApiIdempotency(
    request,
    site,
    { email: body.email },
    (client) => queueRecoveryEmail(client, site, body.normalizedEmail),
  );
  return noStore(response);
}
