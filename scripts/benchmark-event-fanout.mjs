import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const databaseUrl = process.env.HPOS_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const port = Number(process.env.HPOS_BENCHMARK_PORT ?? 3287);
const origin = `http://127.0.0.1:${port}`;
const paidOrderCount = 1_000;
const issuedTicketCount = 8_000;
const mutationBudgetMs = 5_000;
const parityRequestLimitPerMinute = 10_000;
const ids = {
  organizationId: randomUUID(),
  siteId: randomUUID(),
  eventId: randomUUID(),
  offeringId: randomUUID(),
  otherOrganizationId: randomUUID(),
  otherSiteId: randomUUID(),
  otherSiteSentinelJobId: randomUUID(),
};
const siteKeyId = randomUUID();
const apiKey = `hpos_site_${siteKeyId}_${randomBytes(32).toString("base64url")}`;
const apiKeyHash = createHash("sha256").update(apiKey, "utf8").digest("hex");
const pool = new pg.Pool({ connectionString: databaseUrl, max: 12, connectionTimeoutMillis: 2_000 });
const triggerNames = { functionName: `benchmark_fail_${randomUUID().replaceAll("-", "")}`, triggerName: `benchmark_fail_trigger_${randomUUID().replaceAll("-", "")}` };
let app;
const eventLockBlockers = new Set();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function nowMs() {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function assertPortIsFree() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`Benchmark port ${port} is already in use.`)));
    server.listen(port, "127.0.0.1", () => server.close((error) => error ? reject(error) : resolve()));
  });
}

function startApp() {
  const nextBin = path.join(root, "node_modules/next/dist/bin/next");
  const env = {
    ...process.env,
    NODE_ENV: "development",
    HPOS_DATABASE_URL: databaseUrl,
    NEXT_TELEMETRY_DISABLED: "1",
  };
  const child = spawn(process.execPath, [nextBin, "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-8_000);
      process.stdout.write(chunk);
    });
  }
  return { child, get output() { return output; } };
}

async function waitForReady(server) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) throw new Error(`The benchmark app stopped early.\n${server.output}`);
    try {
      const response = await fetch(`${origin}/v1/admin/notification-jobs`, { signal: AbortSignal.timeout(2_000) });
      if (response.status === 401) return;
      await response.body?.cancel().catch(() => undefined);
    } catch {}
    await sleep(500);
  }
  throw new Error(`The benchmark app did not become ready within 90 seconds.\n${server.output}`);
}

async function stopApp() {
  if (!app || app.child.exitCode !== null) return;
  await new Promise((resolve) => {
    app.child.once("exit", resolve);
    app.child.kill("SIGTERM");
    setTimeout(() => {
      if (app.child.exitCode === null) app.child.kill("SIGKILL");
    }, 5_000).unref();
  });
}

async function api(pathName, { method = "GET", body, idempotencyKey } = {}) {
  const headers = { Authorization: `Bearer ${apiKey}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const started = nowMs();
  const response = await fetch(`${origin}${pathName}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  let data = null;
  try { data = await response.json(); } catch {}
  return { status: response.status, data, durationMs: nowMs() - started };
}

async function seed() {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `insert into hpos.organizations (id, name, fee_terms_status, platform_fee_basis_points)
       values ($1, $2, 'configured', 1000)`,
      [ids.organizationId, `Issue 127 benchmark ${ids.organizationId.slice(0, 8)}`],
    );
    await client.query(
      `insert into hpos.sites (id, organization_id, name, request_limit_per_minute) values ($1, $2, 'Issue 127 benchmark Site', $3)`,
      [ids.siteId, ids.organizationId, parityRequestLimitPerMinute],
    );
    await client.query(
      `insert into hpos.site_api_keys (id, site_id, key_hash) values ($1, $2, $3)`,
      [siteKeyId, ids.siteId, apiKeyHash],
    );
    await client.query(
      `insert into hpos.organizations (id, name, fee_terms_status, platform_fee_basis_points)
       values ($1, $2, 'configured', 1000)`,
      [ids.otherOrganizationId, `Issue 127 benchmark sentinel ${ids.otherOrganizationId.slice(0, 8)}`],
    );
    await client.query(
      `insert into hpos.sites (id, organization_id, name) values ($1, $2, 'Issue 127 benchmark sentinel Site')`,
      [ids.otherSiteId, ids.otherOrganizationId],
    );
    await client.query(
      `insert into hpos.notification_jobs (id, site_id, kind, payload)
       values ($1, $2, 'order_recovery', '{}'::jsonb)`,
      [ids.otherSiteSentinelJobId, ids.otherSiteId],
    );
    const storedKey = await client.query(`select id, site_id, key_hash from hpos.site_api_keys where id = $1`, [siteKeyId]);
    assert(storedKey.rows[0]?.site_id === ids.siteId && storedKey.rows[0]?.key_hash === apiKeyHash, "The benchmark Site API key was not stored as expected.");
    assert(/^hpos_site_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/i.test(apiKey), "The benchmark Site API key did not match the Site authentication format.");
    await client.query(
      `insert into hpos.events (
         id, site_id, ticket_offering_id, title, description, venue_name, venue_address,
         starts_at, starts_at_offset_minutes, ends_at, ends_at_offset_minutes, time_zone,
         visibility, publication_status, created_actor_type, created_actor_reference,
         updated_actor_type, updated_actor_reference
       ) values (
         $1, $2, $3, 'Issue 127 benchmark Event', 'Synthetic load only', 'Benchmark venue', null,
         '2035-01-01T19:00:00-08:00', -480, '2035-01-01T21:00:00-08:00', -480, 'America/Los_Angeles',
         'public', 'published', 'system', 'benchmark:issue-127', 'system', 'benchmark:issue-127'
       )`,
      [ids.eventId, ids.siteId, ids.offeringId],
    );
    await client.query(
      `insert into hpos.ticket_offerings (
         id, event_id, site_id, price_amount, currency, capacity, tax_amount, buyer_fees,
         sales_opens_at, sales_opens_offset_minutes, sales_closes_at, sales_closes_offset_minutes,
         sales_ever_configured
       ) values (
         $1, $2, $3, 2500, 'USD', $4, 0, '[]'::jsonb,
         '2025-12-01T09:00:00-08:00', -480, '2035-01-01T20:30:00-08:00', -480, true
       )`,
      [ids.offeringId, ids.eventId, ids.siteId, issuedTicketCount],
    );
    await client.query(
      `insert into hpos.buyers (id, site_id, normalized_email, name)
       select gen_random_uuid(), $1, 'issue127-' || g::text || '@example.test', 'Benchmark Buyer ' || g::text
       from generate_series(1, $2::integer) as numbers(g)`,
      [ids.siteId, paidOrderCount],
    );
    await client.query(
      `insert into hpos.public_quotes (
         id, site_id, event_id, offering_id, quantity, currency, unit_price, subtotal,
         buyer_fees, tax_total, total, platform_fee_basis_points, platform_fee_amount,
         created_at, expires_at
       )
       select gen_random_uuid(), $1, $2, $3, 1, 'USD', 2500, 2500, '[]'::jsonb, 0, 2500, 1000, 250,
              clock_timestamp(), clock_timestamp() + interval '15 minutes'
       from generate_series(1, $4::integer)`,
      [ids.siteId, ids.eventId, ids.offeringId, paidOrderCount],
    );
    await client.query(
      `with buyers as (
         select id, row_number() over (order by id) as ordinal
         from hpos.buyers where site_id = $1
       ), quotes as (
         select id, row_number() over (order by created_at, id) as ordinal
         from hpos.public_quotes where site_id = $1 and event_id = $2
       )
       insert into hpos.orders (
         id, site_id, event_id, offering_id, buyer_id, quote_id, order_reference,
         buyer_name, delivery_email, checkout_identity, accepted_quote, checkout_status,
         payment_status, issuance_status, checkout_expires_at, order_token_hash,
         created_at, updated_at
       )
       select gen_random_uuid(), $1, $2, $3, buyers.id, quotes.id,
              'B-' || lpad(buyers.ordinal::text, 7, '0'), 'Benchmark Buyer ' || buyers.ordinal,
              'issue127-' || buyers.ordinal || '@example.test', '{}'::jsonb,
              jsonb_build_object('quantity', 1, 'currency', 'USD', 'unit_price', 2500),
              'ended', 'paid', 'issued', clock_timestamp(),
              md5($1::text || '-issue127-order-' || buyers.ordinal) || md5($1::text || '-issue127-order-token-' || buyers.ordinal),
              clock_timestamp() + buyers.ordinal * interval '1 microsecond', clock_timestamp()
       from buyers join quotes on quotes.ordinal = buyers.ordinal`,
      [ids.siteId, ids.eventId, ids.offeringId],
    );
    await client.query(
      `with ordered_orders as (
         select id, row_number() over (order by created_at, id) as ordinal
         from hpos.orders where site_id = $1 and event_id = $2
       )
       insert into hpos.tickets (
         id, site_id, order_id, event_id, offering_id, ordinal, attendee_name,
         ticket_token, ticket_token_hash, qr_payload, qr_token_hash
       )
       select gen_random_uuid(), $1, ordered_orders.id, $2, $3,
              ((numbers.g - 1) % 8 + 1)::smallint, null,
              lpad(numbers.g::text, 32, '0'),
              encode(digest(lpad(numbers.g::text, 32, '0'), 'sha256'), 'hex'),
              lpad((numbers.g + 10000)::text, 32, '0'),
              md5($1::text || '-issue127-qr-' || numbers.g) || md5($1::text || '-issue127-qr-hash-' || numbers.g)
       from generate_series(1, $4::integer) as numbers(g)
       join ordered_orders on ordered_orders.ordinal = ((numbers.g - 1) / 8 + 1)`,
      [ids.siteId, ids.eventId, ids.offeringId, issuedTicketCount],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function counts() {
  const result = await pool.query(
    `select
       count(*) filter (where kind = 'event_changed')::integer as event_changed,
       count(*) filter (where kind = 'event_canceled')::integer as event_canceled,
       count(*) filter (where kind = 'wallet_update')::integer as wallet_update,
       count(*)::integer as total
     from hpos.notification_jobs job
     where job.site_id = $1
       and (job.event_id = $2 or (job.kind = 'wallet_update' and exists (
         select 1 from hpos.tickets ticket
          where ticket.id = job.ticket_id and ticket.site_id = job.site_id and ticket.event_id = $2
       )))`,
    [ids.siteId, ids.eventId],
  );
  return result.rows[0];
}

async function currentEvent() {
  const result = await pool.query(
    `select version, is_canceled, is_archived from hpos.events where site_id = $1 and id = $2`,
    [ids.siteId, ids.eventId],
  );
  return result.rows[0];
}

async function otherSiteSentinel() {
  const result = await pool.query(
    `select id, site_id, kind, status, event_id, order_id, access_request_id, ticket_id,
            is_superseded, attempt_count, available_at, created_at, updated_at,
            requires_verification, provider_message_reference, claim_id, lease_fence, payload
       from hpos.notification_jobs
      where site_id = $1 and id = $2`,
    [ids.otherSiteId, ids.otherSiteSentinelJobId],
  );
  assert(result.rows.length === 1, "The benchmark Site-isolation sentinel row was not present exactly once.");
  return result.rows[0];
}

async function otherSiteJobIds() {
  const result = await pool.query(
    `select id
       from hpos.notification_jobs
      where site_id = $1
      order by id`,
    [ids.otherSiteId],
  );
  return result.rows.map((row) => row.id);
}

async function beginEventLock() {
  const client = await pool.connect();
  eventLockBlockers.add(client);
  try {
    await client.query("begin");
    await client.query("select id from hpos.events where site_id = $1 and id = $2 for update", [ids.siteId, ids.eventId]);
    return client;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "The benchmark Event lock could not be initialized or rolled back.");
    }
    eventLockBlockers.delete(client);
    client.release();
    throw error;
  }
}

async function commitEventLock(client) {
  let released = false;
  try {
    await client.query("commit");
    released = true;
  } catch (error) {
    try {
      await client.query("rollback");
      released = true;
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "The benchmark Event lock could not be committed or rolled back.");
    }
    throw error;
  } finally {
    if (released) {
      eventLockBlockers.delete(client);
      client.release();
    }
  }
}

async function walletJobVersions() {
  const result = await pool.query(
    `select payload->>'data_version' as data_version, count(*)::integer as count
       from hpos.notification_jobs job
      where job.site_id = $1 and job.kind = 'wallet_update' and exists (
        select 1 from hpos.tickets ticket
         where ticket.id = job.ticket_id and ticket.site_id = job.site_id and ticket.event_id = $2
      )
      group by payload->>'data_version'
      order by data_version`,
    [ids.siteId, ids.eventId],
  );
  const countsByVersionCardinality = {};
  for (const row of result.rows) {
    const cardinality = String(Number(row.count));
    countsByVersionCardinality[cardinality] = (countsByVersionCardinality[cardinality] ?? 0) + 1;
  }
  return {
    total_jobs: result.rows.reduce((total, row) => total + Number(row.count), 0),
    distinct_data_versions: result.rows.length,
    counts_by_version_cardinality: countsByVersionCardinality,
    sample_data_versions: result.rows.slice(0, 3).concat(result.rows.slice(-3)).map((row) => ({ data_version: row.data_version, count: Number(row.count) })),
  };
}

async function walletTicketJobCounts(expectedJobsPerTicket) {
  const result = await pool.query(
    `with ticket_counts as (
       select job.ticket_id, count(*)::integer as job_count
         from hpos.notification_jobs job
        where job.site_id = $1 and job.kind = 'wallet_update' and exists (
          select 1 from hpos.tickets ticket
           where ticket.id = job.ticket_id and ticket.site_id = job.site_id and ticket.event_id = $2
        )
        group by job.ticket_id
     )
     select count(*)::integer as distinct_ticket_ids,
            coalesce(min(job_count), 0)::integer as min_jobs_per_ticket,
            coalesce(max(job_count), 0)::integer as max_jobs_per_ticket,
            count(*) filter (where job_count = $3)::integer as exact_jobs_per_ticket
       from ticket_counts`,
    [ids.siteId, ids.eventId, expectedJobsPerTicket],
  );
  return result.rows[0];
}

async function assertWalletFanoutCardinality(label, expectedTotalJobs, expectedJobsPerTicket) {
  const versions = await walletJobVersions();
  assert(versions.total_jobs === expectedTotalJobs, `${label} Wallet fan-out job total was ${versions.total_jobs}; expected ${expectedTotalJobs}.`);
  assert(versions.distinct_data_versions === expectedTotalJobs, `${label} Wallet fan-out did not produce one unique data_version per job.`);
  assert(versions.counts_by_version_cardinality[String(1)] === expectedTotalJobs
    && Object.keys(versions.counts_by_version_cardinality).length === 1,
  `${label} Wallet fan-out data_version counts were not exactly one job per version.`);
  const ticketCounts = await walletTicketJobCounts(expectedJobsPerTicket);
  assert(Number(ticketCounts.distinct_ticket_ids) === issuedTicketCount,
    `${label} Wallet fan-out did not cover exactly one row per issued Ticket.`);
  assert(Number(ticketCounts.min_jobs_per_ticket) === expectedJobsPerTicket
    && Number(ticketCounts.max_jobs_per_ticket) === expectedJobsPerTicket
    && Number(ticketCounts.exact_jobs_per_ticket) === issuedTicketCount,
  `${label} Wallet fan-out did not produce exactly ${expectedJobsPerTicket} jobs per Ticket.`);
  return { versions, ticket_counts: ticketCounts };
}

async function assertEventOrderCardinality(label, kind) {
  const result = await pool.query(
    `with order_counts as (
       select order_id, count(*)::integer as job_count
         from hpos.notification_jobs
        where site_id = $1 and event_id = $2 and kind = $3
        group by order_id
     )
     select count(*)::integer as distinct_order_ids,
            coalesce(min(job_count), 0)::integer as min_jobs_per_order,
            coalesce(max(job_count), 0)::integer as max_jobs_per_order,
            count(*) filter (where job_count = 1)::integer as exactly_one_job_orders
       from order_counts`,
    [ids.siteId, ids.eventId, kind],
  );
  const orderCounts = result.rows[0];
  assert(Number(orderCounts.distinct_order_ids) === paidOrderCount
    && Number(orderCounts.min_jobs_per_order) === 1
    && Number(orderCounts.max_jobs_per_order) === 1
    && Number(orderCounts.exactly_one_job_orders) === paidOrderCount,
  `${label} did not produce exactly one ${kind} job per paid Order.`);
  return orderCounts;
}

async function assertWalletPublicParity() {
  const result = await pool.query(
    `select job.ticket_id, ticket.ticket_token, job.payload->>'data_version' as data_version
       from hpos.notification_jobs job
       join hpos.tickets ticket on ticket.id = job.ticket_id and ticket.site_id = job.site_id
      where job.site_id = $1 and job.kind = 'wallet_update' and ticket.event_id = $2
      order by job.created_at, job.id
      limit 1`,
    [ids.siteId, ids.eventId],
  );
  const queued = result.rows[0];
  assert(queued?.ticket_token, "The benchmark could not read a Wallet job Ticket token.");
  const response = await api(`/v1/public/tickets/${queued.ticket_token}/apple-wallet-data`);
  assert(response.status === 200, `The public Wallet API parity request failed: ${JSON.stringify(response.data)}`);
  const publicVersion = response.data?.data?.data_version;
  assert(publicVersion === queued.data_version, `The SQL Wallet data_version did not match the public Wallet API (${queued.data_version} vs ${publicVersion}).`);
  return { ticket_id: queued.ticket_id, data_version: queued.data_version, public_status: response.status };
}

async function assertWalletPublicParityForAllTickets() {
  const result = await pool.query(
    `select job.ticket_id, ticket.ticket_token, job.payload->>'data_version' as data_version
       from hpos.notification_jobs job
       join hpos.tickets ticket on ticket.id = job.ticket_id and ticket.site_id = job.site_id
      where job.site_id = $1 and job.kind = 'wallet_update' and ticket.event_id = $2
      order by ticket.id`,
    [ids.siteId, ids.eventId],
  );
  assert(result.rows.length === issuedTicketCount, `The Wallet parity set contained ${result.rows.length} rows; expected ${issuedTicketCount}.`);
  assert(new Set(result.rows.map((row) => row.ticket_id)).size === issuedTicketCount, "The Wallet parity set did not contain exactly one row per Ticket.");

  const started = nowMs();
  const failures = [];
  let nextIndex = 0;
  const concurrency = 10;
  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= result.rows.length) return;
      const row = result.rows[index];
      try {
        const response = await api(`/v1/public/tickets/${row.ticket_token}/apple-wallet-data`);
        const publicVersion = response.data?.data?.data_version;
        if (response.status !== 200 || publicVersion !== row.data_version) {
          failures.push({ ticket_id: row.ticket_id, status: response.status, queued_data_version: row.data_version, public_data_version: publicVersion });
        }
      } catch (error) {
        failures.push({ ticket_id: row.ticket_id, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  assert(failures.length === 0, `The public Wallet API parity check failed for ${failures.length} Tickets: ${JSON.stringify(failures.slice(0, 3))}`);
  return {
    ticket_count: result.rows.length,
    checked_ticket_count: result.rows.length,
    concurrency,
    duration_ms: Math.round(nowMs() - started),
  };
}

function assertMutationBudget(name, response) {
  assert(response.durationMs <= mutationBudgetMs, `${name} exceeded the ${mutationBudgetMs} ms mutation budget (${Math.round(response.durationMs)} ms).`);
}

async function installRollbackTrigger() {
  await pool.query(
    `create function hpos.${triggerNames.functionName}() returns trigger
     language plpgsql as $$ begin
       if NEW.site_id = '${ids.siteId}'::uuid and NEW.event_id = '${ids.eventId}'::uuid and NEW.kind = 'event_canceled' then
         raise exception 'Issue 127 synthetic notification fan-out failure';
       end if;
       return NEW;
     end $$`,
  );
  await pool.query(
    `create trigger ${triggerNames.triggerName}
     before insert on hpos.notification_jobs for each row
     execute function hpos.${triggerNames.functionName}()`,
  );
}

async function removeRollbackTrigger() {
  await pool.query(`drop trigger if exists ${triggerNames.triggerName} on hpos.notification_jobs`);
  await pool.query(`drop function if exists hpos.${triggerNames.functionName}()`);
}

async function run() {
  await assertPortIsFree();
  await seed();
  const beforeOtherSiteSentinel = await otherSiteSentinel();
  const beforeOtherSiteJobIds = await otherSiteJobIds();
  assert(beforeOtherSiteJobIds.length === 1 && beforeOtherSiteJobIds[0] === ids.otherSiteSentinelJobId, "The benchmark other Site did not start with exactly its controlled sentinel row.");
  app = startApp();
  await waitForReady(app);
  await api(`/v1/admin/events/${ids.eventId}`);

  const blocker = await beginEventLock();
  const lockedPatchKey = randomUUID();
  const lockedPatchStarted = nowMs();
  let lockedPatchPromise;
  let lockReleasedAt;
  try {
    lockedPatchPromise = api(`/v1/admin/events/${ids.eventId}`, {
      method: "PATCH",
      idempotencyKey: lockedPatchKey,
      body: {
        actor: { type: "system", reference: "benchmark:issue-127" },
        expected_version: 1,
        starts_at: "2035-01-01T20:00:00-08:00",
        venue: { name: "Updated benchmark venue" },
      },
    });
    await sleep(100);
  } finally {
    await commitEventLock(blocker);
    lockReleasedAt = nowMs();
  }
  const arrival = await lockedPatchPromise;
  assert(arrival.status === 200, `The arrival benchmark mutation failed: ${JSON.stringify(arrival.data)}`);
  assertMutationBudget("Arrival", arrival);
  const afterArrival = await counts();
  assert(Number(afterArrival.event_changed) === paidOrderCount, `Arrival fan-out did not create one job per paid Order: ${JSON.stringify(afterArrival)}`);
  assert(Number(afterArrival.wallet_update) === issuedTicketCount, `Arrival Wallet fan-out did not create one job per issued Ticket: ${JSON.stringify(afterArrival)}`);
  const arrivalWalletParity = await assertWalletPublicParity();
  const arrivalWalletCardinality = await assertWalletFanoutCardinality("Arrival", issuedTicketCount, 1);
  const arrivalWalletParityAll = await assertWalletPublicParityForAllTickets();
  const arrivalEventOrderCardinality = await assertEventOrderCardinality("Arrival", "event_changed");

  const replay = await api(`/v1/admin/events/${ids.eventId}`, {
    method: "PATCH",
    idempotencyKey: lockedPatchKey,
    body: {
      actor: { type: "system", reference: "benchmark:issue-127" },
      expected_version: 1,
      starts_at: "2035-01-01T20:00:00-08:00",
      venue: { name: "Updated benchmark venue" },
    },
  });
  assert(replay.status === 200, "Retrying the arrival mutation with the same key did not replay successfully.");
  const afterReplay = await counts();
  assert(JSON.stringify(afterReplay) === JSON.stringify(afterArrival), "Arrival retry created duplicate fan-out jobs.");

  await installRollbackTrigger();
  const rollback = await api(`/v1/admin/events/${ids.eventId}/actions/cancel`, {
    method: "POST",
    idempotencyKey: randomUUID(),
    body: { actor: { type: "system", reference: "benchmark:issue-127" }, expected_version: 2 },
  });
  await removeRollbackTrigger();
  assert(rollback.status >= 500, `The rollback injection unexpectedly succeeded: ${JSON.stringify(rollback.data)}`);
  const afterRollback = await counts();
  const rollbackEvent = await currentEvent();
  assert(JSON.stringify(afterRollback) === JSON.stringify(afterArrival), "Rollback left partial notification or Wallet jobs.");
  assert(rollbackEvent.is_canceled === false && Number(rollbackEvent.version) === 2, "Rollback left the Event mutation applied.");

  const mutationBlocker = await beginEventLock();
  const overlapMutationStarted = nowMs();
  let overlapMutationPromise;
  let overlapActivityStarted;
  let overlapActivityPromise;
  let overlapReleasedAt;
  try {
    overlapMutationPromise = api(`/v1/admin/events/${ids.eventId}`, {
      method: "PATCH",
      idempotencyKey: randomUUID(),
      body: {
        actor: { type: "system", reference: "benchmark:issue-127" },
        expected_version: 2,
        ticket_offering: { sales_closes_at: "2035-01-01T20:15:00-08:00" },
      },
    });
    await sleep(50);
    overlapActivityStarted = nowMs();
    overlapActivityPromise = Promise.all([
      api(`/v1/public/events/${ids.eventId}/quotes`, { method: "POST", idempotencyKey: randomUUID(), body: { quantity: 1 } }),
      api(`/v1/admin/notification-jobs/claims`, {
        method: "POST",
        idempotencyKey: randomUUID(),
        body: { limit: 100, kinds: ["event_changed", "wallet_update"], actor: { type: "system", reference: "benchmark:issue-127" } },
      }),
    ]);
    await sleep(150);
    overlapReleasedAt = nowMs();
  } finally {
    await commitEventLock(mutationBlocker);
  }
  const [overlapMutation, overlapActivity] = await Promise.all([overlapMutationPromise, overlapActivityPromise]);
  assert(overlapMutation.status === 200, `The overlapping Event mutation failed: ${JSON.stringify(overlapMutation.data)}`);
  assertMutationBudget("Overlapping Event mutation", overlapMutation);
  assert(overlapActivity[0].status === 201, `The overlapping quote request failed: ${JSON.stringify(overlapActivity[0].data)}`);
  assert(overlapActivity[1].status === 200, `The overlapping notification claim request failed: ${JSON.stringify(overlapActivity[1].data)}`);
  assert(overlapMutationStarted < overlapActivityStarted && overlapActivityStarted < overlapReleasedAt,
    "The quote and claim requests were not started while the Event mutation was blocked on its Event lock.");
  assert(overlapReleasedAt - overlapActivityStarted >= 100,
    "The Event lock was not held long enough to establish mutation and checkout/claim overlap.");
  const overlapWallDurationMs = nowMs() - overlapMutationStarted;
  const overlapEvent = await currentEvent();
  assert(Number(overlapEvent.version) === 3 && overlapEvent.is_canceled === false,
    "The overlapping Event mutation did not commit exactly one new Event version.");
  const cancellation = await api(`/v1/admin/events/${ids.eventId}/actions/cancel`, {
    method: "POST",
    idempotencyKey: randomUUID(),
    body: { actor: { type: "system", reference: "benchmark:issue-127" }, expected_version: 3 },
  });
  assert(cancellation.status === 200, `The cancellation benchmark mutation failed: ${JSON.stringify(cancellation.data)}`);
  assertMutationBudget("Cancellation", cancellation);
  const afterCancel = await counts();
  assert(Number(afterCancel.event_canceled) === paidOrderCount, "Cancellation fan-out did not create one job per paid Order.");
  assert(Number(afterCancel.wallet_update) === issuedTicketCount * 2, "Cancellation Wallet fan-out did not create one job per issued Ticket.");
  const cancellationEventOrderCardinality = await assertEventOrderCardinality("Cancellation", "event_canceled");

  const archive = await api(`/v1/admin/events/${ids.eventId}/actions/archive`, {
    method: "POST",
    idempotencyKey: randomUUID(),
    body: { actor: { type: "system", reference: "benchmark:issue-127" }, expected_version: 4 },
  });
  assert(archive.status === 200, `The archival benchmark mutation failed: ${JSON.stringify(archive.data)}`);
  assertMutationBudget("Archive", archive);
  const afterArchive = await counts();
  assert(Number(afterArchive.wallet_update) === issuedTicketCount * 3, "Archival Wallet fan-out did not create one job per issued Ticket.");
  assert(JSON.stringify(await otherSiteSentinel()) === JSON.stringify(beforeOtherSiteSentinel), "The benchmark changed the other Site's sentinel notification row.");
  assert(JSON.stringify(await otherSiteJobIds()) === JSON.stringify(beforeOtherSiteJobIds), "The benchmark changed the other Site's complete notification-job ID set.");
  const finalWalletCardinality = await assertWalletFanoutCardinality("All three Wallet fan-outs", issuedTicketCount * 3, 3);

  console.log(JSON.stringify({
    target: {
      paid_orders: paidOrderCount,
      issued_tickets: issuedTicketCount,
      mutation_budget_ms: mutationBudgetMs,
      wallet_parity_request_limit_per_minute: parityRequestLimitPerMinute,
      runtime_note: "No hosted maxDuration is configured in this repository; 5 seconds is the local transaction budget.",
    },
    arrival: {
      status: arrival.status,
      duration_ms: Math.round(arrival.durationMs),
      mutation_budget_passed: arrival.durationMs <= mutationBudgetMs,
      harness_event_lock_hold_ms: Math.round(lockReleasedAt - lockedPatchStarted),
      wallet_public_parity: arrivalWalletParity,
      wallet_public_parity_all: arrivalWalletParityAll,
      wallet_cardinality: arrivalWalletCardinality,
      event_order_cardinality: arrivalEventOrderCardinality,
    },
    retry: { status: replay.status, duration_ms: Math.round(replay.durationMs), counts_unchanged: true },
    rollback: { status: rollback.status, event_unchanged: true, counts_unchanged: true },
    overlap: {
      wall_duration_ms: Math.round(overlapWallDurationMs),
      event_mutation: {
        status: overlapMutation.status,
        duration_ms: Math.round(overlapMutation.durationMs),
        mutation_budget_passed: overlapMutation.durationMs <= mutationBudgetMs,
      },
      quote: { status: overlapActivity[0].status, duration_ms: Math.round(overlapActivity[0].durationMs) },
      claim: { status: overlapActivity[1].status, duration_ms: Math.round(overlapActivity[1].durationMs) },
      mutation_waited_for_overlap_ms: Math.round(overlapReleasedAt - overlapActivityStarted),
      mutation_and_activity_overlap_asserted: true,
    },
    cancellation: { status: cancellation.status, duration_ms: Math.round(cancellation.durationMs) },
    archival: { status: archive.status, duration_ms: Math.round(archive.durationMs) },
    jobs: afterArchive,
    cancellation_event_order_cardinality: cancellationEventOrderCardinality,
    wallet_cardinality: finalWalletCardinality,
    site_isolation: { sentinel_unchanged: true },
  }, null, 2));
}

async function cleanup() {
  const errors = [];
  for (const client of [...eventLockBlockers]) {
    try {
      await client.query("rollback");
    } catch (error) {
      errors.push({ step: "rollback outstanding benchmark Event lock", error });
    } finally {
      eventLockBlockers.delete(client);
      client.release();
    }
  }
  try {
    await removeRollbackTrigger();
  } catch (error) {
    errors.push({ step: "remove rollback trigger", error });
  }
  try {
    await stopApp();
  } catch (error) {
    errors.push({ step: "stop benchmark app", error });
  }
  let client;
  try {
    client = await pool.connect();
  } catch (error) {
    errors.push({ step: "connect for benchmark cleanup", error });
  }
  if (client) {
    try {
      await client.query("begin");
      for (const siteId of [ids.siteId, ids.otherSiteId]) {
        for (const table of [
          "hpos.notification_delivery_events",
          "hpos.notification_dispatch_attempts",
          "hpos.notification_jobs",
          "hpos.notification_claims",
          "hpos.api_idempotency_records",
          "hpos.payment_report_issues",
          "hpos.payment_attempt_reports",
          "hpos.payment_attempts",
          "hpos.admissions",
          "hpos.tickets",
          "hpos.reservations",
          "hpos.orders",
          "hpos.public_quotes",
          "hpos.buyers",
          "hpos.ticket_offering_provider_mappings",
          "hpos.ticket_offerings",
          "hpos.events",
          "hpos.site_api_keys",
          "hpos.site_request_windows",
          "hpos.site_payment_connection_assignments",
        ]) {
          await client.query(`delete from ${table} where site_id = $1`, [siteId]);
        }
      }
      await client.query("delete from hpos.sites where id = any($1::uuid[])", [[ids.siteId, ids.otherSiteId]]);
      await client.query("delete from hpos.organizations where id = any($1::uuid[])", [[ids.organizationId, ids.otherOrganizationId]]);
      await client.query("commit");
    } catch (error) {
      errors.push({ step: "delete benchmark dependency graph", error });
      try {
        await client.query("rollback");
      } catch (rollbackError) {
        errors.push({ step: "rollback benchmark cleanup", error: rollbackError });
      }
    } finally {
      client.release();
    }
  }
  try {
    await pool.end();
  } catch (error) {
    errors.push({ step: "close benchmark pool", error });
  }
  if (errors.length) {
    for (const failure of errors) console.error(`Benchmark cleanup failed during ${failure.step}:`, failure.error?.stack ?? failure.error);
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
}).finally(cleanup);
