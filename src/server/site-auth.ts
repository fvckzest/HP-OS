import { createHash, timingSafeEqual } from "node:crypto";
import { getBusinessPool } from "./database";
import { apiFailure } from "./api-response";

const SITE_KEY_PATTERN = /^hpos_site_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_([A-Za-z0-9_-]{43})$/i;

export function hashSiteApiKey(key: string): Buffer {
  return createHash("sha256").update(key, "utf8").digest();
}

export interface AuthenticatedSite {
  siteId: string;
}

export type SiteAuthentication =
  | { site: AuthenticatedSite; error: null }
  | { site: null; error: Response };

export async function authenticateSiteRequest(request: Request): Promise<SiteAuthentication> {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  const key = match?.[1]?.trim() ?? "";
  const parsedKey = SITE_KEY_PATTERN.exec(key);
  if (!parsedKey) return { site: null, error: apiFailure(401, "unauthorized", "A valid Site API key is required.") };

  try {
    const result = await getBusinessPool().query<{ site_id: string; key_hash: string; revoked_at: Date | null }>(
      `select site_id, key_hash, revoked_at from hpos.site_api_keys where id = $1`,
      [parsedKey[1]],
    );
    const storedHash = result.rows[0]?.key_hash;
    const calculatedHash = hashSiteApiKey(key);
    const storedBytes = storedHash && /^[0-9a-f]{64}$/.test(storedHash) ? Buffer.from(storedHash, "hex") : Buffer.alloc(32);
    const matchesHash = timingSafeEqual(storedBytes, calculatedHash);
    const row = result.rows[0];
    if (!row || !matchesHash || row.revoked_at) {
      return { site: null, error: apiFailure(401, "unauthorized", "A valid Site API key is required.") };
    }

    const limit = await consumeSiteRequest(row.site_id);
    if (!limit.allowed) {
      return {
        site: null,
        error: apiFailure(429, "rate_limited", "The Site request budget has been reached. Retry after the supplied delay.", { retryAfter: limit.retryAfter }),
      };
    }
    return { site: { siteId: row.site_id }, error: null };
  } catch {
    return { site: null, error: apiFailure(503, "service_unavailable", "Site authentication is temporarily unavailable.", { retryAfter: 1 }) };
  }
}

async function consumeSiteRequest(siteId: string): Promise<{ allowed: boolean; retryAfter: number }> {
  const result = await getBusinessPool().query<{ request_count: number; window_start: Date; request_limit_per_minute: number; retry_after: number }>(
    `with current_window as (
       select date_trunc('minute', clock_timestamp()) as starts_at
     ), counted as (
       insert into hpos.site_request_windows (site_id, window_start, request_count)
       select $1, current_window.starts_at, 1 from current_window
       on conflict (site_id, window_start)
       do update set request_count = hpos.site_request_windows.request_count + 1
       returning request_count, window_start
     ), cleanup as (
       delete from hpos.site_request_windows old
       using current_window
       where old.site_id = $1 and old.window_start < current_window.starts_at - interval '2 minutes'
       returning old.site_id
     )
     select counted.request_count, counted.window_start, sites.request_limit_per_minute,
            greatest(1, ceil(extract(epoch from (counted.window_start + interval '1 minute' - clock_timestamp())))::integer) as retry_after
     from counted join hpos.sites on sites.id = $1`,
    [siteId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("The authenticated Site no longer exists.");
  return { allowed: row.request_count <= row.request_limit_per_minute, retryAfter: row.retry_after };
}
