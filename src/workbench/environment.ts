export const DEFAULT_WORKBENCH_ORIGIN = "http://127.0.0.1:3000";
export const DEFAULT_DATABASE_URL =
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

export type WorkbenchEnvironment = Record<string, string | undefined>;

export function getWorkbenchOrigin(env: WorkbenchEnvironment = process.env): URL | null {
  const raw = env.HPOS_WORKBENCH_ORIGIN ?? DEFAULT_WORKBENCH_ORIGIN;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

export function isLocalDatabaseUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "postgresql:" && url.hostname === "127.0.0.1" && url.port === "54322" && url.username === "postgres" && url.pathname === "/postgres" && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function isWorkbenchEnabled(env: WorkbenchEnvironment = process.env): boolean {
  return env.HPOS_LOCAL_WORKBENCH === "1" && env.NODE_ENV !== "production" && getWorkbenchOrigin(env) !== null && isLocalDatabaseUrl(env.HPOS_DATABASE_URL ?? DEFAULT_DATABASE_URL);
}

export type WorkbenchAccessResult =
  | { allowed: true }
  | { allowed: false; status: 403 | 404; message: string };

export function checkWorkbenchRequest(request: Request, options: { mutation?: boolean } = {}, env: WorkbenchEnvironment = process.env): WorkbenchAccessResult {
  if (!isWorkbenchEnabled(env)) return { allowed: false, status: 404, message: "Workbench unavailable." };
  const expectedOrigin = getWorkbenchOrigin(env);
  if (!expectedOrigin || request.headers.get("host") !== expectedOrigin.host) return { allowed: false, status: 403, message: "Local access check failed." };
  if (options.mutation) {
    if (request.headers.get("origin") !== expectedOrigin.origin) return { allowed: false, status: 403, message: "Local origin check failed." };
    const fetchSite = request.headers.get("sec-fetch-site");
    if (fetchSite && fetchSite !== "same-origin") return { allowed: false, status: 403, message: "Local origin check failed." };
  }
  return { allowed: true };
}

export function getLocalApiOrigin(env: WorkbenchEnvironment = process.env): URL | null {
  const expectedOrigin = getWorkbenchOrigin(env);
  const raw = env.HPOS_API_BASE_URL ?? expectedOrigin?.origin;
  if (!raw || !expectedOrigin) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.host !== expectedOrigin.host || url.pathname !== "/" || url.username || url.password || url.search || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}
