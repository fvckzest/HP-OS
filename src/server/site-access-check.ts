import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getLocalApiOrigin } from "@/src/workbench/environment";
import { insertHistory } from "@/src/workbench/database";
import { safeRequestHeaders, safeRoute, sanitizeJsonText, type SafeJson } from "@/src/workbench/redaction";
import type { CheckResult } from "@/src/workbench/types";
import { getBusinessPool } from "./database";

interface FixtureKey { id: string; value: string }
interface Fixtures {
  organizationIds: string[];
  siteIds: { first: string; second: string; sameOrganizationSeparate: string; unassigned: string; otherOrganization: string };
  connectionIds: { shared: string; sameOrganizationSeparate: string; otherOrganization: string };
  keys: { first: FixtureKey; second: FixtureKey; otherOrganization: FixtureKey };
}

interface CheckStep {
  id: string;
  title: string;
  expected: string;
  statusCode: number | null;
  actual: string;
  result: "passed" | "failed";
  capture: "stored" | "incomplete";
}

function makeKey(): FixtureKey {
  const id = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  return { id, value: `hpos_site_${id}_${secret}` };
}

function keyHash(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

async function createFixtures(): Promise<Fixtures> {
  const client = await getBusinessPool().connect();
  const fixture: Fixtures = {
    organizationIds: [],
    siteIds: { first: "", second: "", sameOrganizationSeparate: "", unassigned: "", otherOrganization: "" },
    connectionIds: { shared: "", sameOrganizationSeparate: "", otherOrganization: "" },
    keys: { first: makeKey(), second: makeKey(), otherOrganization: makeKey() },
  };
  try {
    await client.query("begin");
    const firstOrganization = await client.query<{ id: string }>(
      `insert into hpos.organizations (name) values ($1) returning id`,
      [`Workbench access check ${randomUUID()}`],
    );
    const secondOrganization = await client.query<{ id: string }>(
      `insert into hpos.organizations (name) values ($1) returning id`,
      [`Workbench isolation check ${randomUUID()}`],
    );
    const organizationOne = firstOrganization.rows[0].id;
    const organizationTwo = secondOrganization.rows[0].id;
    fixture.organizationIds.push(organizationOne, organizationTwo);

    const siteA = await client.query<{ id: string }>(
      `insert into hpos.sites (organization_id, name) values ($1, 'Workbench Site A') returning id`, [organizationOne],
    );
    const siteB = await client.query<{ id: string }>(
      `insert into hpos.sites (organization_id, name) values ($1, 'Workbench Site B') returning id`, [organizationOne],
    );
    const siteUnassigned = await client.query<{ id: string }>(
      `insert into hpos.sites (organization_id, name) values ($1, 'Workbench Site without payment') returning id`, [organizationOne],
    );
    const siteSameOrganizationSeparate = await client.query<{ id: string }>(
      `insert into hpos.sites (organization_id, name) values ($1, 'Workbench Site with separate payment') returning id`, [organizationOne],
    );
    const siteOtherOrganization = await client.query<{ id: string }>(
      `insert into hpos.sites (organization_id, name) values ($1, 'Workbench Site C') returning id`, [organizationTwo],
    );
    fixture.siteIds = {
      first: siteA.rows[0].id,
      second: siteB.rows[0].id,
      sameOrganizationSeparate: siteSameOrganizationSeparate.rows[0].id,
      unassigned: siteUnassigned.rows[0].id,
      otherOrganization: siteOtherOrganization.rows[0].id,
    };

    const sharedConnection = await client.query<{ id: string }>(
      `insert into hpos.payment_connections (organization_id, provider, environment, account_reference, location_reference)
       values ($1, 'square', 'test', $2, $3) returning id`,
      [organizationOne, `test-account-${randomUUID()}`, `test-location-${randomUUID()}`],
    );
    const separateConnection = await client.query<{ id: string }>(
      `insert into hpos.payment_connections (organization_id, provider, environment, account_reference, location_reference)
       values ($1, 'stripe', 'test', $2, null) returning id`,
      [organizationOne, `same-org-account-${randomUUID()}`],
    );
    const otherOrganizationConnection = await client.query<{ id: string }>(
      `insert into hpos.payment_connections (organization_id, provider, environment, account_reference, location_reference)
       values ($1, 'stripe', 'test', $2, null) returning id`,
      [organizationTwo, `test-account-${randomUUID()}`],
    );
    fixture.connectionIds = {
      shared: sharedConnection.rows[0].id,
      sameOrganizationSeparate: separateConnection.rows[0].id,
      otherOrganization: otherOrganizationConnection.rows[0].id,
    };

    await client.query(
      `insert into hpos.site_payment_connection_assignments (site_id, organization_id, connection_id)
       values ($1, $3, $5), ($2, $3, $5), ($4, $3, $6), ($7, $8, $9)`,
      [fixture.siteIds.first, fixture.siteIds.second, organizationOne, fixture.siteIds.sameOrganizationSeparate, fixture.connectionIds.shared, fixture.connectionIds.sameOrganizationSeparate, fixture.siteIds.otherOrganization, organizationTwo, fixture.connectionIds.otherOrganization],
    );

    for (const [siteId, key] of [
      [fixture.siteIds.first, fixture.keys.first],
      [fixture.siteIds.first, fixture.keys.second],
      [fixture.siteIds.second, makeKey()],
      [fixture.siteIds.sameOrganizationSeparate, makeKey()],
      [fixture.siteIds.unassigned, makeKey()],
      [fixture.siteIds.otherOrganization, fixture.keys.otherOrganization],
    ] as Array<[string, FixtureKey]>) {
      await client.query(`insert into hpos.site_api_keys (id, site_id, key_hash) values ($1, $2, $3)`, [key.id, siteId, keyHash(key.value)]);
    }
    await client.query("commit");
    return fixture;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function rotateSiteKey(siteId: string): Promise<FixtureKey> {
  const client = await getBusinessPool().connect();
  const nextKey = makeKey();
  try {
    await client.query("begin");
    await client.query(`update hpos.site_api_keys set revoked_at = clock_timestamp() where site_id = $1 and revoked_at is null`, [siteId]);
    await client.query(`insert into hpos.site_api_keys (id, site_id, key_hash) values ($1, $2, $3)`, [nextKey.id, siteId, keyHash(nextKey.value)]);
    await client.query("commit");
    return nextKey;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function revokeSiteKey(siteId: string, keyId: string): Promise<void> {
  await getBusinessPool().query(
    `update hpos.site_api_keys set revoked_at = clock_timestamp() where site_id = $1 and id = $2 and revoked_at is null`,
    [siteId, keyId],
  );
}

async function recordStep(input: {
  id: string;
  title: string;
  expected: string;
  path: string;
  key: string | null;
  expectedStatus: number;
  accept?: (body: unknown, headers: Headers | null) => boolean;
  attempt: number;
}): Promise<CheckStep> {
  const base = getLocalApiOrigin();
  if (!base) throw new Error("The configured API target is not the loopback origin.");
  const target = new URL(input.path, base);
  const headers = new Headers({ accept: "application/json" });
  if (input.key) headers.set("authorization", `Bearer ${input.key}`);
  let response: Response | null = null;
  let body: unknown = null;
  let actual = "No HTTP response was received.";
  try {
    response = await fetch(target, { method: "GET", headers, redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(10_000) });
    body = await response.json().catch(() => null);
    actual = response.status === input.expectedStatus ? `HTTP ${response.status}` : `HTTP ${response.status}; expected HTTP ${input.expectedStatus}`;
  } catch {
    response = null;
  }

  const hasExpectedStatus = response?.status === input.expectedStatus;
  const validBody = !input.accept || input.accept(body, response?.headers ?? null);
  const result: CheckResult = hasExpectedStatus && validBody ? "passed" : "failed";
  if (hasExpectedStatus && !validBody) actual += "; response data did not match the expected Site-scoped configuration";

  const safeBody = body === null ? null : sanitizeJsonText(JSON.stringify(body)).value as SafeJson | null;
  const route = safeRoute(target.pathname);
  let capture: "stored" | "incomplete" = "stored";
  try {
    await insertHistory({
      source: "guided",
      attempt: input.attempt,
      method: "GET",
      route,
      request_snapshot: {
        method: "GET",
        route,
        headers: safeRequestHeaders(Object.fromEntries(headers.entries())),
        body: null,
        bodyBytes: 0,
      } as unknown as SafeJson,
      expectation_snapshot: { status: input.expectedStatus, assertion: input.expected } as unknown as SafeJson,
      result_state: result,
      outcome_state: response ? "response_received" : "outcome_unknown",
      status_code: response?.status ?? null,
      response_snapshot: safeBody,
      error_code: response ? null : "network_error",
      duration_ms: null,
      capture_state: "stored",
      environment: "local",
      dataset_label: "site-access-config-synthetic",
      revision: process.env.HPOS_REVISION ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown",
    });
  } catch {
    capture = "incomplete";
  }

  return {
    id: input.id,
    title: input.title,
    expected: input.expected,
    statusCode: response?.status ?? null,
    actual: capture === "incomplete" ? `${actual}; history capture incomplete` : actual,
    result: capture === "incomplete" ? "failed" : result,
    capture,
  };
}

function activeConnectionIs(body: unknown, connectionId: string): boolean {
  if (!body || typeof body !== "object" || !("data" in body)) return false;
  const data = (body as { data?: { active_connection?: { connection_id?: string } | null } }).data;
  const active = data?.active_connection;
  return typeof (body as { request_id?: unknown }).request_id === "string"
    && active?.connection_id === connectionId
    && Object.keys(active ?? {}).sort().join(",") === "account_reference,connection_id,environment,location_reference,provider";
}

function connectionIs(body: unknown, connectionId: string): boolean {
  if (!body || typeof body !== "object" || !("data" in body)) return false;
  const data = (body as { data?: Record<string, unknown> }).data;
  return typeof (body as { request_id?: unknown }).request_id === "string"
    && data?.connection_id === connectionId
    && Object.keys(data ?? {}).sort().join(",") === "account_reference,connection_id,environment,location_reference,provider";
}

function noActiveConnection(body: unknown): boolean {
  if (!body || typeof body !== "object" || !("data" in body)) return false;
  return typeof (body as { request_id?: unknown }).request_id === "string"
    && (body as { data?: { active_connection?: unknown } }).data?.active_connection === null;
}

function errorCodeIs(body: unknown, code: string): boolean {
  if (!body || typeof body !== "object" || !("error" in body)) return false;
  const error = (body as { error?: { code?: string; details?: unknown } }).error;
  return typeof (body as { request_id?: unknown }).request_id === "string"
    && error?.code === code
    && Array.isArray(error.details);
}

export async function runSiteAccessConfigurationCheck(): Promise<{ result: "passed" | "failed"; steps: CheckStep[]; message: string }> {
  const fixtures = await createFixtures();
  const steps: CheckStep[] = [];
  const firstPath = "/v1/admin/payment-configuration";
  const connectionPath = (connectionId: string) => `/v1/admin/payment-connections/${connectionId}`;
  let attempt = 0;
  const add = async (input: Omit<Parameters<typeof recordStep>[0], "attempt">) => {
    attempt += 1;
    const step = await recordStep({ ...input, attempt });
    steps.push(step);
    return step;
  };

  try {
    await add({ id: "missing-key", title: "Reject a missing key", expected: "HTTP 401 with unauthorized", path: firstPath, key: null, expectedStatus: 401, accept: (body) => errorCodeIs(body, "unauthorized") });
    await add({ id: "invalid-key", title: "Reject an invalid key", expected: "HTTP 401 with unauthorized", path: firstPath, key: "not-a-site-key", expectedStatus: 401, accept: (body) => errorCodeIs(body, "unauthorized") });
    await add({ id: "first-site-config", title: "Read the first Site's assigned connection", expected: "HTTP 200 with only the assigned non-secret connection fields", path: firstPath, key: fixtures.keys.first.value, expectedStatus: 200, accept: (body) => activeConnectionIs(body, fixtures.connectionIds.shared) });
    await add({ id: "shared-connection", title: "Read a connection explicitly shared with a second Site", expected: "HTTP 200 for the same organization and explicit assignment", path: firstPath, key: (await keyForSite(fixtures.siteIds.second)).value, expectedStatus: 200, accept: (body) => activeConnectionIs(body, fixtures.connectionIds.shared) });
    await add({ id: "same-organization-separate-config", title: "Read a separate connection assigned within the same organization", expected: "HTTP 200 with that Site's own connection", path: firstPath, key: (await keyForSite(fixtures.siteIds.sameOrganizationSeparate)).value, expectedStatus: 200, accept: (body) => activeConnectionIs(body, fixtures.connectionIds.sameOrganizationSeparate) });
    await add({ id: "other-organization-config", title: "Read another organization's Site configuration", expected: "HTTP 200 with only its assigned connection", path: firstPath, key: fixtures.keys.otherOrganization.value, expectedStatus: 200, accept: (body) => activeConnectionIs(body, fixtures.connectionIds.otherOrganization) });
    await add({ id: "unassigned-config", title: "Read configuration for a Site without an assignment", expected: "HTTP 200 with active_connection null", path: firstPath, key: (await keyForSite(fixtures.siteIds.unassigned)).value, expectedStatus: 200, accept: noActiveConnection });
    await add({ id: "assigned-connection-read", title: "Read the Site's assigned connection directly", expected: "HTTP 200 with non-secret connection metadata", path: connectionPath(fixtures.connectionIds.shared), key: fixtures.keys.first.value, expectedStatus: 200, accept: (body) => connectionIs(body, fixtures.connectionIds.shared) });
    await add({ id: "same-organization-connection-hidden", title: "Hide another Site's separately assigned connection", expected: "HTTP 404 with not_found", path: connectionPath(fixtures.connectionIds.sameOrganizationSeparate), key: fixtures.keys.first.value, expectedStatus: 404, accept: (body) => errorCodeIs(body, "not_found") });
    await add({ id: "other-organization-connection-hidden", title: "Hide another organization's connection", expected: "HTTP 404 with not_found", path: connectionPath(fixtures.connectionIds.otherOrganization), key: fixtures.keys.first.value, expectedStatus: 404, accept: (body) => errorCodeIs(body, "not_found") });

    const rotatedKey = await rotateSiteKey(fixtures.siteIds.first);
    await add({ id: "rotated-key-rejects-old", title: "Reject the old key after rotation", expected: "HTTP 401 with unauthorized", path: firstPath, key: fixtures.keys.first.value, expectedStatus: 401, accept: (body) => errorCodeIs(body, "unauthorized") });
    await add({ id: "rotated-key-works", title: "Accept the replacement key", expected: "HTTP 200 after rotation", path: firstPath, key: rotatedKey.value, expectedStatus: 200, accept: (body) => activeConnectionIs(body, fixtures.connectionIds.shared) });
    await revokeSiteKey(fixtures.siteIds.first, rotatedKey.id);
    await add({ id: "revoked-key-rejected", title: "Reject a revoked key", expected: "HTTP 401 with unauthorized", path: firstPath, key: rotatedKey.value, expectedStatus: 401, accept: (body) => errorCodeIs(body, "unauthorized") });

    const firstRateKey = makeKey();
    const secondRateKey = makeKey();
    const client = await getBusinessPool().connect();
    try {
      await client.query("begin");
      await client.query(`update hpos.sites set request_limit_per_minute = 2 where id = $1`, [fixtures.siteIds.first]);
      await client.query(`insert into hpos.site_api_keys (id, site_id, key_hash) values ($1, $2, $3), ($4, $2, $5)`, [firstRateKey.id, fixtures.siteIds.first, keyHash(firstRateKey.value), secondRateKey.id, keyHash(secondRateKey.value)]);
      await client.query(`delete from hpos.site_request_windows where site_id = $1`, [fixtures.siteIds.first]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    for (let index = 0; index < 2; index += 1) {
      await add({ id: `rate-limit-allowed-${index + 1}`, title: `Allow Site request ${index + 1} across active keys`, expected: "HTTP 200 within the shared two-request budget", path: firstPath, key: index % 2 === 0 ? firstRateKey.value : secondRateKey.value, expectedStatus: 200, accept: (body) => activeConnectionIs(body, fixtures.connectionIds.shared) });
    }
    await add({ id: "site-rate-limit", title: "Apply the Site-wide limit across active keys", expected: "HTTP 429 with rate_limited and a positive Retry-After value", path: firstPath, key: secondRateKey.value, expectedStatus: 429, accept: (body, headers) => errorCodeIs(body, "rate_limited") && Number(headers?.get("retry-after")) > 0 });
  } finally {
    await getBusinessPool().query(`delete from hpos.organizations where id = any($1::uuid[])`, [fixtures.organizationIds]).catch(() => undefined);
  }

  const passed = steps.every((step) => step.result === "passed" && step.capture === "stored");
  return {
    result: passed ? "passed" : "failed",
    steps,
    message: passed
      ? "Site key lifecycle, Site-scoped payment reads, shared-connection assignments, and Site-wide request limits passed through the HTTP API."
      : "One or more Site configuration checks failed. Inspect each recorded HTTP result and local database status before retrying.",
  };
}

async function keyForSite(siteId: string): Promise<FixtureKey> {
  const key = makeKey();
  await getBusinessPool().query(`insert into hpos.site_api_keys (id, site_id, key_hash) values ($1, $2, $3)`, [key.id, siteId, keyHash(key.value)]);
  return key;
}
