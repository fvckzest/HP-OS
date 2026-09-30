const origin = process.env.HPOS_LOCAL_WORKER_ORIGIN ?? "http://127.0.0.1:3000";
const intervalMs = Number(process.env.HPOS_LOCAL_WORKER_INTERVAL_MS ?? 60_000);

function fail(message) {
  console.error(`Local HP-OS scheduler stopped: ${message}`);
  process.exit(1);
}

let target;
try {
  target = new URL(origin);
} catch {
  fail("HPOS_LOCAL_WORKER_ORIGIN must be a loopback HTTP origin.");
}

if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || target.port && (!/^3\d{3}$/.test(target.port) || Number(target.port) > 3999) || target.pathname !== "/" || target.search || target.hash || target.username || target.password) {
  fail("HPOS_LOCAL_WORKER_ORIGIN must use http://127.0.0.1 and an optional port from 3000 to 3999.");
}
if (!Number.isInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 3_600_000) {
  fail("HPOS_LOCAL_WORKER_INTERVAL_MS must be from 1000 to 3600000.");
}

const endpoint = new URL("/api/cron/process", target);
const stopping = new AbortController();
process.once("SIGINT", () => stopping.abort());
process.once("SIGTERM", () => stopping.abort());

console.log(`Polling the local HP-OS processing endpoint at ${endpoint.origin} every ${intervalMs} ms. Stop with Ctrl-C.`);

while (!stopping.signal.aborted) {
  const startedAt = new Date();
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: process.env.CRON_SECRET ? { Authorization: `Bearer ${process.env.CRON_SECRET}` } : {},
      signal: AbortSignal.any([stopping.signal, AbortSignal.timeout(30_000)]),
      cache: "no-store",
    });
    const body = await response.text();
    if (!response.ok) {
      console.error(`${startedAt.toISOString()} HTTP ${response.status}: ${body.slice(0, 500)}`);
    } else {
      const result = JSON.parse(body).data;
      console.log(`${startedAt.toISOString()} recovered ${result.recovered_jobs} expired job(s) and released ${result.released_reservations} expired Reservation(s); more=${result.has_more}.`);
    }
  } catch (error) {
    if (stopping.signal.aborted) break;
    console.error(`${startedAt.toISOString()} ${error instanceof Error ? error.message : "The processing request failed."}`);
  }

  try {
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, intervalMs);
      stopping.signal.addEventListener("abort", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
    });
  } catch {
    break;
  }
}

console.log("Local HP-OS scheduler stopped.");
