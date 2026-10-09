import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.HPOS_VERIFY_ARTWORK_PORT ?? 3280);
const origin = `http://127.0.0.1:${port}`;
const databaseUrl = process.env.HPOS_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const env = { ...process.env, NODE_ENV: "development", HPOS_DATABASE_URL: databaseUrl, NEXT_TELEMETRY_DISABLED: "1" };
const pool = new pg.Pool({ connectionString: databaseUrl, max: 3, connectionTimeoutMillis: 2_000 });
const organizationIds = [];
const siteIds = [];
let app;

const ADMIN_ARTWORK_FIELDS = [
  "artwork_id", "slug", "displayed_artwork_id", "title", "description", "medium", "dimensions", "created_on",
  "cardano_chain", "cardano_policy_id", "cardano_asset_id", "original_status", "publication_status",
  "collection_ids", "photos", "hero_photo_id", "version",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeKey() {
  const id = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const value = `hpos_site_${id}_${secret}`;
  return { id, value, hash: createHash("sha256").update(value, "utf8").digest("hex") };
}

async function createFixture() {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const organizationId = (await client.query(
      "insert into hpos.organizations (name) values ($1) returning id",
      [`Issue 120 Artwork verification ${randomUUID()}`],
    )).rows[0].id;
    organizationIds.push(organizationId);
    const firstSiteId = (await client.query(
      "insert into hpos.sites (organization_id, name) values ($1, $2) returning id",
      [organizationId, "Issue 120 Artwork verification Site One"],
    )).rows[0].id;
    const secondSiteId = (await client.query(
      "insert into hpos.sites (organization_id, name) values ($1, $2) returning id",
      [organizationId, "Issue 120 Artwork verification Site Two"],
    )).rows[0].id;
    siteIds.push(firstSiteId, secondSiteId);
    const firstKey = makeKey();
    const secondKey = makeKey();
    await client.query(
      "insert into hpos.site_api_keys (id, site_id, key_hash) values ($1, $2, $3), ($4, $5, $6)",
      [firstKey.id, firstSiteId, firstKey.hash, secondKey.id, secondSiteId, secondKey.hash],
    );
    await client.query("commit");
    return { first: { siteId: firstSiteId, apiKey: firstKey.value }, second: { siteId: secondSiteId, apiKey: secondKey.value } };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function cleanup() {
  if (!organizationIds.length) return;
  await pool.query("delete from hpos.organizations where id = any($1::uuid[])", [organizationIds]);
  const checks = [
    ["organizations", "select count(*)::int as count from hpos.organizations where id = any($1::uuid[])", organizationIds],
    ["Sites", "select count(*)::int as count from hpos.sites where id = any($1::uuid[])", siteIds],
    ["Site API keys", "select count(*)::int as count from hpos.site_api_keys where site_id = any($1::uuid[])", siteIds],
    ["rate limit windows", "select count(*)::int as count from hpos.site_request_windows where site_id = any($1::uuid[])", siteIds],
    ["idempotency records", "select count(*)::int as count from hpos.api_idempotency_records where site_id = any($1::uuid[])", siteIds],
    ["Artworks", "select count(*)::int as count from hpos.artworks where site_id = any($1::uuid[])", siteIds],
    ["Collections", "select count(*)::int as count from hpos.collections where site_id = any($1::uuid[])", siteIds],
    ["Collection memberships", "select count(*)::int as count from hpos.collection_artworks where site_id = any($1::uuid[])", siteIds],
  ];
  for (const [label, query, ids] of checks) {
    const result = await pool.query(query, [ids]);
    const count = Number(result.rows[0]?.count ?? 0);
    if (count !== 0) throw new Error(`Artwork fixture cleanup left ${count} ${label}.`);
  }
  console.log("Artwork fixture cleanup passed: no fixture organizations, Sites, keys, rate windows, idempotency records, Artworks, Collections, or memberships remain.");
}

function assertAdminArtworkShape(value, label) {
  assert(value && Object.keys(value).sort().join() === [...ADMIN_ARTWORK_FIELDS].sort().join(), `${label} did not match the AdminArtwork field set.`);
  assert(!Object.hasOwn(value, "id") && !Object.hasOwn(value, "site_id"), `${label} exposed a private database or Site identifier.`);
}

async function insertCollection(site, { name, isActive, artworkId = null }) {
  const client = await pool.connect();
  const collectionId = `col_${randomBytes(16).toString("base64url")}`;
  try {
    await client.query("begin");
    await client.query(
      `insert into hpos.collections
       (collection_id, site_id, name, is_active, position, created_actor_type, created_actor_reference,
          updated_actor_type, updated_actor_reference)
       values ($1, $2, $3, $4,
               (select coalesce(max(position), 0) + 1 from hpos.collections where site_id = $2),
               'system', 'verify:issue-120', 'system', 'verify:issue-120')`,
      [collectionId, site.siteId, name, isActive],
    );
    if (artworkId) {
      await client.query(
        "insert into hpos.collection_artworks (collection_id, artwork_id, site_id, position) values ($1, $2, $3, 1)",
        [collectionId, artworkId, site.siteId],
      );
    }
    await client.query("commit");
    return collectionId;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function startApp() {
  const nextBin = path.join(root, "node_modules/next/dist/bin/next");
  const child = spawn(process.execPath, [nextBin, "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => { output = (output + chunk).slice(-5_000); });
  }
  return { child, get output() { return output; } };
}

async function waitForReady(server) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) throw new Error(`The Artwork verification app stopped early.\n${server.output}`);
    try {
      const response = await fetch(`${origin}/v1/admin/payment-configuration`, { signal: AbortSignal.timeout(2_000) });
      if (response.status === 401) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`The Artwork verification app did not become ready.\n${server.output}`);
}

async function stopApp(server) {
  if (!server || server.child.exitCode !== null) return;
  await new Promise((resolve) => {
    server.child.once("exit", resolve);
    server.child.kill("SIGTERM");
    setTimeout(() => { if (server.child.exitCode === null) server.child.kill("SIGKILL"); }, 5_000).unref();
  });
}

async function api(site, pathName, { method = "GET", idempotencyKey, body } = {}) {
  const headers = { Authorization: `Bearer ${site.apiKey}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const response = await fetch(`${origin}${pathName}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let data = null;
  try { data = await response.json(); } catch {}
  return { response, data };
}

async function assertDraftCrud(fixtures) {
  const missingAuth = await fetch(`${origin}/v1/admin/artworks`);
  assert(missingAuth.status === 401, "A missing Site key did not return 401.");

  const body = {
    actor: { type: "user", reference: "test:issue-120" },
    title: "Blue Study",
    displayed_artwork_id: "X-0120",
    slug: "blue-study",
    description: "A draft Artwork used by the local HTTP verifier.",
    medium: "Oil on linen",
    dimensions: { width: 40, height: 30, unit: "cm" },
    created_on: "2026-10-09",
    cardano_chain: "mainnet",
    cardano_policy_id: "policy-120",
    cardano_asset_id: "asset-120",
  };
  const key = randomUUID();
  const created = await api(fixtures.first, "/v1/admin/artworks", { method: "POST", idempotencyKey: key, body });
  assert(created.response.status === 201, `Artwork creation failed: ${JSON.stringify(created.data)}`);
  const artwork = created.data?.data;
  assert(typeof artwork?.artwork_id === "string" && /^art_[A-Za-z0-9_-]{22}$/.test(artwork.artwork_id), "The Artwork response did not include a stable opaque artwork_id.");
  assertAdminArtworkShape(artwork, "Created Artwork");
  assert(artwork.publication_status === "draft" && artwork.original_status === "available" && artwork.version === 1, "The new Artwork did not start as an available draft at version 1.");
  assert(Array.isArray(artwork.photos) && artwork.photos.length === 0 && Array.isArray(artwork.collection_ids), "The new Artwork did not include empty portfolio relationships.");

  const replay = await api(fixtures.first, "/v1/admin/artworks", { method: "POST", idempotencyKey: key, body });
  assert(replay.response.status === 201 && replay.data?.data?.artwork_id === artwork.artwork_id, "The same create key did not replay the original Artwork.");
  const conflict = await api(fixtures.first, "/v1/admin/artworks", { method: "POST", idempotencyKey: key, body: { ...body, title: "Different" } });
  assert(conflict.response.status === 409 && conflict.data?.error?.code === "idempotency_conflict", "A reused create key with a different body was accepted.");

  for (const [displayed, slug] of [["X-0120", "another-study"], ["X-0121", "blue-study"]]) {
    const duplicate = await api(fixtures.first, "/v1/admin/artworks", {
      method: "POST", idempotencyKey: randomUUID(), body: { actor: body.actor, title: "Duplicate", displayed_artwork_id: displayed, slug },
    });
    const expected = displayed === "X-0120" ? 422 : 409;
    assert(duplicate.response.status === expected, `Duplicate ${displayed === "X-0120" ? "displayed ID" : "slug"} did not return ${expected}.`);
  }

  const patchBody = { actor: body.actor, expected_version: 1, title: "Blue Study Updated", original_status: "sold", description: null };
  const patchKey = randomUUID();
  const patched = await api(fixtures.first, `/v1/admin/artworks/${artwork.artwork_id}`, { method: "PATCH", idempotencyKey: patchKey, body: patchBody });
  assert(patched.response.status === 200 && patched.data?.data?.version === 2 && patched.data.data.original_status === "sold" && patched.data.data.description === null, "Artwork patch did not advance the version or apply nullable fields.");
  assertAdminArtworkShape(patched.data.data, "Patched Artwork");
  const patchReplay = await api(fixtures.first, `/v1/admin/artworks/${artwork.artwork_id}`, { method: "PATCH", idempotencyKey: patchKey, body: patchBody });
  assert(patchReplay.response.status === 200 && patchReplay.data?.data?.version === 2 && patchReplay.data.data.title === "Blue Study Updated", "The same PATCH key did not replay the original Artwork result.");
  const patchConflict = await api(fixtures.first, `/v1/admin/artworks/${artwork.artwork_id}`, {
    method: "PATCH", idempotencyKey: patchKey, body: { ...patchBody, title: "Different" },
  });
  assert(patchConflict.response.status === 409 && patchConflict.data?.error?.code === "idempotency_conflict", "A reused PATCH key with a different body was accepted.");
  const stale = await api(fixtures.first, `/v1/admin/artworks/${artwork.artwork_id}`, { method: "PATCH", idempotencyKey: randomUUID(), body: { actor: body.actor, expected_version: 1, title: "Stale" } });
  assert(stale.response.status === 409 && stale.data?.error?.code === "version_conflict", "A stale Artwork edit was accepted.");

  const detail = await api(fixtures.first, `/v1/admin/artworks/${artwork.artwork_id}`);
  assert(detail.response.status === 200 && detail.data?.data?.title === "Blue Study Updated", "The Site could not read its Artwork detail.");
  assertAdminArtworkShape(detail.data.data, "Artwork detail");
  const foreign = await api(fixtures.second, `/v1/admin/artworks/${artwork.artwork_id}`);
  assert(foreign.response.status === 404 && foreign.data?.error?.code === "not_found", "A different Site could read the Artwork.");

  const second = await api(fixtures.first, "/v1/admin/artworks", { method: "POST", idempotencyKey: randomUUID(), body: { actor: body.actor, title: "Second Study", displayed_artwork_id: "X-0122" } });
  assert(second.response.status === 201, "The second Artwork could not be created for list verification.");
  assertAdminArtworkShape(second.data.data, "Second Artwork");
  const activeCollectionId = await insertCollection(fixtures.first, { name: "Issue 120 Active Filter", isActive: true, artworkId: artwork.artwork_id });
  const inactiveCollectionId = await insertCollection(fixtures.first, { name: "Issue 120 Inactive Filter", isActive: false, artworkId: artwork.artwork_id });
  const foreignCollectionId = await insertCollection(fixtures.second, { name: "Issue 120 Foreign Filter", isActive: true });
  const activeFiltered = await api(fixtures.first, `/v1/admin/artworks?collection_id=${encodeURIComponent(activeCollectionId)}`);
  assert(activeFiltered.response.status === 200 && activeFiltered.data?.data?.length === 1 && activeFiltered.data.data[0].artwork_id === artwork.artwork_id, "The own-site active Collection filter did not return its Artwork.");
  assertAdminArtworkShape(activeFiltered.data.data[0], "Active Collection filtered Artwork");
  const inactiveFiltered = await api(fixtures.first, `/v1/admin/artworks?collection_id=${encodeURIComponent(inactiveCollectionId)}`);
  assert(inactiveFiltered.response.status === 200 && inactiveFiltered.data?.data?.length === 1 && inactiveFiltered.data.data[0].artwork_id === artwork.artwork_id, "The admin filter rejected a valid inactive Collection membership.");
  const malformedCollection = await api(fixtures.first, "/v1/admin/artworks?collection_id=not-a-collection");
  assert(malformedCollection.response.status === 404 && malformedCollection.data?.error?.code === "not_found", "A malformed Collection filter was not rejected without disclosure.");
  const foreignCollection = await api(fixtures.first, `/v1/admin/artworks?collection_id=${encodeURIComponent(foreignCollectionId)}`);
  assert(foreignCollection.response.status === 404 && foreignCollection.data?.error?.code === "not_found", "A foreign-site Collection filter was not rejected without disclosure.");
  const missingCollection = `col_${randomBytes(16).toString("base64url")}`;
  const nonexistentCollection = await api(fixtures.first, `/v1/admin/artworks?collection_id=${missingCollection}`);
  assert(nonexistentCollection.response.status === 404 && nonexistentCollection.data?.error?.code === "not_found", "A nonexistent Collection filter was not rejected without disclosure.");
  const listed = await api(fixtures.first, "/v1/admin/artworks?limit=1");
  assert(listed.response.status === 200 && listed.data?.data?.length === 1 && listed.data?.pagination?.next_cursor, "Artwork list pagination did not return one row and a signed next cursor.");
  assertAdminArtworkShape(listed.data.data[0], "Artwork list row");
  const next = await api(fixtures.first, `/v1/admin/artworks?limit=1&cursor=${encodeURIComponent(listed.data.pagination.next_cursor)}`);
  assert(next.response.status === 200 && next.data?.data?.length === 1, "The signed Artwork cursor did not retrieve the next page.");
  assertAdminArtworkShape(next.data.data[0], "Artwork cursor page row");
  const foreignCursor = await api(fixtures.second, `/v1/admin/artworks?limit=1&cursor=${encodeURIComponent(listed.data.pagination.next_cursor)}`);
  assert(foreignCursor.response.status === 422 && foreignCursor.data?.error?.code === "invalid_cursor", "A cursor signed for one Site was accepted by another Site.");
  const invalidCursor = await api(fixtures.first, "/v1/admin/artworks?cursor=bad.cursor");
  assert(invalidCursor.response.status === 422 && invalidCursor.data?.error?.code === "invalid_cursor", "An invalid Artwork cursor was not rejected.");
}

async function assertPortFree() {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`Verification port ${port} is already in use.`)));
    server.listen(port, "127.0.0.1", () => server.close((error) => error ? reject(error) : resolve()));
  });
}

try {
  await assertPortFree();
  const fixtures = await createFixture();
  app = startApp();
  await waitForReady(app);
  await assertDraftCrud(fixtures);
  console.log("Artwork draft verification passed: Site isolation, create/replay, validation, guarded edit, and signed pagination.");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await stopApp(app);
  await cleanup().catch((error) => { console.error(`Artwork fixture cleanup failed: ${error.message}`); process.exitCode = 1; });
  await pool.end();
}
