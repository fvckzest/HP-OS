const DEFAULT_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

type LocalEnvironment = Record<string, string | undefined>;

export type LocalRequestAccess =
  | { allowed: true }
  | { allowed: false; status: 403 | 404; message: string };

function isDedicatedLocalDatabase(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "postgresql:" && url.hostname === "127.0.0.1" && url.port === "54322" && url.username === "postgres" && url.pathname === "/postgres" && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function getLoopbackOrigin(request: Request): string | null {
  const host = request.headers.get("host");
  if (!host) return null;
  try {
    const url = new URL(`http://${host}`);
    const port = Number(url.port);
    if (url.hostname !== "127.0.0.1" || url.username || url.password || !Number.isInteger(port) || port < 3000 || port > 3999 || url.pathname !== "/") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function checkLocalRequest(request: Request, options: { mutation?: boolean } = {}, env: LocalEnvironment = process.env): LocalRequestAccess {
  if (env.NODE_ENV === "production" || !isDedicatedLocalDatabase(env.HPOS_DATABASE_URL ?? DEFAULT_DATABASE_URL)) {
    return { allowed: false, status: 404, message: "Local processing controls are unavailable." };
  }
  const origin = getLoopbackOrigin(request);
  if (!origin) return { allowed: false, status: 403, message: "Local access check failed." };
  if (options.mutation) {
    if (request.headers.get("origin") !== origin) return { allowed: false, status: 403, message: "Local origin check failed." };
    const fetchSite = request.headers.get("sec-fetch-site");
    if (fetchSite && fetchSite !== "same-origin") return { allowed: false, status: 403, message: "Local origin check failed." };
  }
  return { allowed: true };
}
