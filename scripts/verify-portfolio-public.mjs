import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.HPOS_VERIFY_PORTFOLIO_PUBLIC_PORT ?? 3284);
const origin = `http://127.0.0.1:${port}`;
const databaseUrl = process.env.HPOS_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const mediaRoot = await mkdtemp(path.join(os.tmpdir(), "hpos-portfolio-public-media-"));
const env = {
  ...process.env,
  NODE_ENV: "development",
  HPOS_DATABASE_URL: databaseUrl,
  HPOS_MEDIA_ROOT: mediaRoot,
  NEXT_TELEMETRY_DISABLED: "1",
};
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 2_000 });
const organizationIds = [];
const siteIds = [];
let app;

const PUBLIC_ARTWORK_FIELDS = [
  "artwork_id", "slug", "displayed_artwork_id", "title", "description", "medium", "dimensions", "created_on",
  "cardano_chain", "cardano_policy_id", "cardano_asset_id", "original_status", "collections", "photos", "hero_photo_id",
];
const PUBLIC_PHOTO_FIELDS = ["photo_id", "position", "is_hero", "image_refs"];

function stableId(prefix, letter) {
  return `${prefix}_${letter.repeat(22)}`;
}

function makeKey() {
  const id = randomUUID();
  const value = `hpos_site_${id}_${randomBytes(32).toString("base64url")}`;
  return { id, value, hash: createHash("sha256").update(value, "utf8").digest("hex") };
}

function sha256Fixture() {
  return "a".repeat(64);
}

async function createFixture() {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const organizationId = (await client.query(
      "insert into hpos.organizations (name) values ($1) returning id",
      [`Issue 124 public portfolio verification ${randomUUID()}`],
    )).rows[0].id;
    organizationIds.push(organizationId);
    const siteOneId = (await client.query(
      "insert into hpos.sites (organization_id, name) values ($1, $2) returning id",
      [organizationId, "Issue 124 public portfolio Site One"],
    )).rows[0].id;
    const siteTwoId = (await client.query(
      "insert into hpos.sites (organization_id, name) values ($1, $2) returning id",
      [organizationId, "Issue 124 public portfolio Site Two"],
    )).rows[0].id;
    siteIds.push(siteOneId, siteTwoId);
    const firstKey = makeKey();
    const secondKey = makeKey();
    await client.query(
      "insert into hpos.site_api_keys (id, site_id, key_hash) values ($1, $2, $3), ($4, $5, $6)",
      [firstKey.id, siteOneId, firstKey.hash, secondKey.id, siteTwoId, secondKey.hash],
    );

    const activeCollectionId = stableId("col", "A");
    const inactiveCollectionId = stableId("col", "I");
    const foreignCollectionId = stableId("col", "F");
    await client.query(
      `insert into hpos.collections
       (collection_id, site_id, name, is_active, position, created_actor_type, created_actor_reference,
        updated_actor_type, updated_actor_reference)
       values ($1, $2, 'Public Collection', true, 1, 'system', 'verify:portfolio-public', 'system', 'verify:portfolio-public'),
              ($3, $2, 'Hidden Collection', false, 2, 'system', 'verify:portfolio-public', 'system', 'verify:portfolio-public'),
              ($4, $5, 'Foreign Collection', true, 1, 'system', 'verify:portfolio-public', 'system', 'verify:portfolio-public')`,
      [activeCollectionId, siteOneId, inactiveCollectionId, foreignCollectionId, siteTwoId],
    );

    const publicA = stableId("art", "A");
    const publicZ = stableId("art", "Z");
    const draft = stableId("art", "D");
    const archived = stableId("art", "R");
    const incomplete = stableId("art", "I");
    const foreign = stableId("art", "F");
    const artworks = [
      [publicA, siteOneId, "public-a", "Public A", "published"],
      [publicZ, siteOneId, "public-z", "Public Z", "published"],
      [draft, siteOneId, "draft-artwork", "Draft Artwork", "draft"],
      [archived, siteOneId, "archived-artwork", "Archived Artwork", "archived"],
      [incomplete, siteOneId, "incomplete-artwork", "Incomplete Artwork", "published"],
      [foreign, siteTwoId, "foreign-artwork", "Foreign Artwork", "published"],
    ];
    for (const [artworkId, siteId, slug, title, publicationStatus] of artworks) {
      await client.query(
        `insert into hpos.artworks
         (id, artwork_id, site_id, slug, displayed_artwork_id, title, description, medium, dimensions,
          created_on, cardano_chain, cardano_policy_id, cardano_asset_id, publication_status,
          created_actor_type, created_actor_reference, updated_actor_type, updated_actor_reference)
         values ($1, $2, $3, $4, $5, $6, 'Public verifier description', 'Oil on linen', $7,
                 '2026-10-09', 'mainnet', 'policy-public', 'asset-public', $8,
                 'system', 'verify:portfolio-public', 'system', 'verify:portfolio-public')`,
        [randomUUID(), artworkId, siteId, slug, `DISPLAY-${slug}`, title, JSON.stringify({ width: 40, height: 30, unit: "cm" }), publicationStatus],
      );
    }
    await client.query(
      `insert into hpos.collection_artworks (collection_id, artwork_id, site_id, position)
       values ($1, $2, $3, 2), ($1, $4, $3, 1), ($1, $5, $3, 3), ($1, $6, $3, 4), ($1, $7, $3, 5),
              ($8, $2, $3, 1), ($8, $4, $3, 2), ($9, $10, $11, 1)`,
      [activeCollectionId, publicA, siteOneId, publicZ, draft, incomplete, archived, inactiveCollectionId, foreignCollectionId, foreign, siteTwoId],
    );

    async function addPhoto(artworkId, { photoLetter, position = 1, hero = false, variantRows = ["grid_400", "artwork_1600"] }) {
      const privateId = randomUUID();
      const photoId = stableId("photo", photoLetter);
      await client.query(
        `insert into hpos.photos
         (id, photo_id, site_id, artwork_id, position, status, ready_variants, active_attempt, is_hero, version)
         values ($1, $2, $3, $4, $5, 'ready', array['grid_400', 'artwork_1600']::text[], 1, $6, 1)`,
        [privateId, photoId, siteOneId, artworkId, position, hero],
      );
      for (const variant of variantRows) {
        const storageKey = `sites/${siteOneId}/portfolio/${photoId}/${variant}.webp`;
        await client.query(
          `insert into hpos.photo_variants
           (photo_id, site_id, attempt_number, variant, storage_key, width, height, byte_size, sha256)
          values ($1, $2, 1, $3, $4, 100, 80, 128, $5)`,
          [privateId, siteOneId, variant, storageKey, sha256Fixture()],
        );
        const filePath = path.join(mediaRoot, storageKey);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, Buffer.from(`fixture-${photoId}-${variant}`));
      }
      return photoId;
    }
    const publicAHero = await addPhoto(publicA, { photoLetter: "A", hero: true });
    await addPhoto(publicA, { photoLetter: "B", position: 2 });
    await addPhoto(publicZ, { photoLetter: "Z", hero: true });
    const incompletePhoto = await addPhoto(incomplete, { photoLetter: "I", hero: true, variantRows: ["grid_400"] });
    await client.query("update hpos.artworks set version = 2 where site_id = $1 and artwork_id = any($2::text[])", [siteOneId, [publicA, publicZ, incomplete]]);
    await client.query("update hpos.artworks set version = 2 where site_id = $1 and artwork_id = $2", [siteTwoId, foreign]);
    await client.query("insert into hpos.photos (id, photo_id, site_id, artwork_id, position, status, ready_variants, active_attempt, is_hero, version) values ($1, $2, $3, $4, 1, 'ready', array['grid_400', 'artwork_1600']::text[], 1, true, 1)", [randomUUID(), stableId("photo", "F"), siteTwoId, foreign]);
    await client.query("commit");
    return {
      first: { siteId: siteOneId, apiKey: firstKey.value },
      second: { siteId: siteTwoId, apiKey: secondKey.value },
      ids: { activeCollectionId, inactiveCollectionId, publicA, publicZ, draft, archived, incomplete, foreign, publicAHero, incompletePhoto },
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function cleanupFixture() {
  if (!organizationIds.length) return;
  await pool.query("delete from hpos.organizations where id = any($1::uuid[])", [organizationIds]);
  const checks = [
    ["organizations", "select count(*)::int as count from hpos.organizations where id = any($1::uuid[])", organizationIds],
    ["Sites", "select count(*)::int as count from hpos.sites where id = any($1::uuid[])", siteIds],
    ["Site API keys", "select count(*)::int as count from hpos.site_api_keys where site_id = any($1::uuid[])", siteIds],
    ["rate limit windows", "select count(*)::int as count from hpos.site_request_windows where site_id = any($1::uuid[])", siteIds],
    ["Artworks", "select count(*)::int as count from hpos.artworks where site_id = any($1::uuid[])", siteIds],
    ["Collections", "select count(*)::int as count from hpos.collections where site_id = any($1::uuid[])", siteIds],
    ["Collection memberships", "select count(*)::int as count from hpos.collection_artworks where site_id = any($1::uuid[])", siteIds],
    ["Photos", "select count(*)::int as count from hpos.photos where site_id = any($1::uuid[])", siteIds],
    ["Photo variants", "select count(*)::int as count from hpos.photo_variants where site_id = any($1::uuid[])", siteIds],
    ["Photo jobs", "select count(*)::int as count from hpos.photo_processing_jobs where site_id = any($1::uuid[])", siteIds],
    ["Photo media cleanup", "select count(*)::int as count from hpos.photo_media_cleanup where site_id = any($1::uuid[])", siteIds],
    ["Photo upload staging", "select count(*)::int as count from hpos.photo_upload_staging where site_id = any($1::uuid[])", siteIds],
  ];
  for (const [label, sql, ids] of checks) {
    const result = await pool.query(sql, [ids]);
    assert(Number(result.rows[0]?.count ?? 0) === 0, `Public portfolio fixture cleanup left rows in ${label}.`);
  }
  console.log("Public portfolio fixture cleanup passed: no fixture organizations, Sites, keys, rate windows, portfolio rows, Photos, variants, or jobs remain.");
}

function startApp() {
  const nextBin = path.join(root, "node_modules/next/dist/bin/next");
  const child = spawn(process.execPath, [nextBin, "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => { output = (output + chunk).slice(-8_000); });
  }
  return { child, get output() { return output; } };
}

async function waitForReady(server) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) throw new Error(`The public portfolio verification app stopped early.\n${server.output}`);
    try {
      const response = await fetch(`${origin}/v1/admin/payment-configuration`, { signal: AbortSignal.timeout(2_000) });
      if (response.status === 401) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`The public portfolio verification app did not become ready.\n${server.output}`);
}

async function stopApp(server) {
  if (!server || server.child.exitCode !== null) return;
  await new Promise((resolve) => {
    server.child.once("exit", resolve);
    server.child.kill("SIGTERM");
    setTimeout(() => { if (server.child.exitCode === null) server.child.kill("SIGKILL"); }, 5_000).unref();
  });
}

async function api(site, pathName) {
  const response = await fetch(`${origin}${pathName}`, { headers: { Authorization: `Bearer ${site.apiKey}` } });
  let data = null;
  try { data = await response.json(); } catch {}
  return { response, data };
}

function tamperCursor(cursor) {
  assert(typeof cursor === "string" && cursor.includes("."), "The public list did not return a cursor to tamper.");
  const index = cursor.indexOf(".");
  const replacement = cursor[index + 1] === "A" ? "B" : "A";
  return `${cursor.slice(0, index + 1)}${replacement}${cursor.slice(index + 2)}`;
}

function assertPublicShape(value, label) {
  assert(value && Object.keys(value).sort().join() === [...PUBLIC_ARTWORK_FIELDS].sort().join(), `${label} exposed unexpected fields.`);
  for (const photo of value.photos) {
    assert(Object.keys(photo).sort().join() === [...PUBLIC_PHOTO_FIELDS].sort().join(), `${label} exposed unexpected Photo fields.`);
    assert(Object.keys(photo.image_refs).sort().join() === "artwork_1600,grid_400", `${label} did not expose both stable image refs.`);
    assert(photo.image_refs.grid_400 === `/v1/public/media/${photo.photo_id}/variants/grid_400`, `${label} returned an unstable grid image ref.`);
    assert(photo.image_refs.artwork_1600 === `/v1/public/media/${photo.photo_id}/variants/artwork_1600`, `${label} returned an unstable artwork image ref.`);
  }
  assert(!JSON.stringify(value).includes("version"), `${label} exposed a version.`);
  assert(!JSON.stringify(value).includes("failure_code"), `${label} exposed processing failure state.`);
}

async function verifyPublicPortfolio(fixtures) {
  const missingAuth = await fetch(`${origin}/v1/public/artworks`);
  assert(missingAuth.status === 401, "A missing Site key did not return 401 for public portfolio reads.");

  const listed = await api(fixtures.first, "/v1/public/artworks?limit=1");
  assert(listed.response.status === 200, `Public Artwork list failed: ${JSON.stringify(listed.data)}`);
  assert.deepEqual(listed.data?.data?.map((row) => row.artwork_id), [fixtures.ids.publicA]);
  assert(typeof listed.data?.pagination?.next_cursor === "string", "The public Artwork list did not return a signed cursor.");
  assertPublicShape(listed.data.data[0], "Public Artwork list");

  const next = await api(fixtures.first, `/v1/public/artworks?limit=1&cursor=${encodeURIComponent(listed.data.pagination.next_cursor)}`);
  assert(next.response.status === 200 && next.data?.data?.[0]?.artwork_id === fixtures.ids.publicZ, "The public Artwork cursor did not continue in artwork_id order.");
  assertPublicShape(next.data.data[0], "Public Artwork cursor page");

  const tampered = await api(fixtures.first, `/v1/public/artworks?limit=1&cursor=${encodeURIComponent(tamperCursor(listed.data.pagination.next_cursor))}`);
  assert(tampered.response.status === 422 && tampered.data?.error?.code === "invalid_cursor", "A tampered public cursor was accepted.");
  const filterMismatch = await api(fixtures.first, `/v1/public/artworks?limit=1&collection_id=${fixtures.ids.activeCollectionId}&cursor=${encodeURIComponent(listed.data.pagination.next_cursor)}`);
  assert(filterMismatch.response.status === 422 && filterMismatch.data?.error?.code === "invalid_cursor", "A public cursor was accepted with different filters.");

  const filtered = await api(fixtures.first, `/v1/public/artworks?collection_id=${fixtures.ids.activeCollectionId}`);
  assert(filtered.response.status === 200 && filtered.data.data.map((row) => row.artwork_id).join() === `${fixtures.ids.publicA},${fixtures.ids.publicZ}`, "The active Collection filter returned the wrong public Artworks.");
  for (const row of filtered.data.data) assertPublicShape(row, "Filtered Public Artwork");

  const child = await api(fixtures.first, `/v1/public/collections/${fixtures.ids.activeCollectionId}/artworks`);
  assert(child.response.status === 200 && child.data.data.map((row) => row.artwork_id).join() === `${fixtures.ids.publicZ},${fixtures.ids.publicA}`, "The Collection Artwork list did not use membership position order.");
  for (const row of child.data.data) assertPublicShape(row, "Collection Public Artwork");

  const collections = await api(fixtures.first, "/v1/public/collections");
  assert(collections.response.status === 200 && collections.data.data.length === 1 && collections.data.data[0].collection_id === fixtures.ids.activeCollectionId, "The public Collection list exposed an inactive Collection.");
  assert.deepEqual(Object.keys(collections.data.data[0]).sort(), ["collection_id", "name", "position"]);

  const collection = await api(fixtures.first, `/v1/public/collections/${fixtures.ids.activeCollectionId}`);
  assert(collection.response.status === 200 && collection.data.data.collection_id === fixtures.ids.activeCollectionId, "The active Collection detail was unavailable.");
  const inactiveCollection = await api(fixtures.first, `/v1/public/collections/${fixtures.ids.inactiveCollectionId}`);
  assert(inactiveCollection.response.status === 404 && inactiveCollection.data?.error?.code === "not_found", "An inactive Collection was publicly readable.");
  const inactiveChildren = await api(fixtures.first, `/v1/public/collections/${fixtures.ids.inactiveCollectionId}/artworks`);
  assert(inactiveChildren.response.status === 404 && inactiveChildren.data?.error?.code === "not_found", "An inactive Collection Artwork list was publicly readable.");

  const detail = await api(fixtures.first, `/v1/public/artworks/${fixtures.ids.publicA}`);
  assert(detail.response.status === 200 && detail.data.data.hero_photo_id === fixtures.ids.publicAHero, "The public Artwork detail did not derive the canonical hero Photo.");
  assert(detail.data.data.photos.length === 2, "The public Artwork detail did not include both complete Photos.");
  assert(detail.data.data.collections.length === 1 && detail.data.data.collections[0].collection_id === fixtures.ids.activeCollectionId, "The public Artwork detail exposed an inactive Collection membership.");
  assertPublicShape(detail.data.data, "Public Artwork detail");

  const media = await fetch(`${origin}/v1/public/media/${fixtures.ids.publicAHero}/variants/grid_400`, {
    headers: { Authorization: `Bearer ${fixtures.first.apiKey}` },
  });
  assert(media.status === 200, `The public media variant was unavailable: ${media.status}.`);
  assert(media.headers.get("content-type")?.startsWith("image/webp"), "The public media variant did not use image/webp content type.");
  assert(media.headers.get("cache-control") === "no-store", "The public media response did not disable caching.");
  assert((await media.text()) === `fixture-${fixtures.ids.publicAHero}-grid_400`, "The public media response did not return the active storage object.");
  const incompleteMedia = await fetch(`${origin}/v1/public/media/${fixtures.ids.incompletePhoto}/variants/grid_400`, {
    headers: { Authorization: `Bearer ${fixtures.first.apiKey}` },
  });
  assert(incompleteMedia.status === 404, "A Photo without both active variant rows was publicly delivered.");

  for (const id of [fixtures.ids.draft, fixtures.ids.archived, fixtures.ids.incomplete, fixtures.ids.foreign]) {
    const unavailable = await api(fixtures.first, `/v1/public/artworks/${id}`);
    assert(unavailable.response.status === 404 && unavailable.data?.error?.code === "not_found", `Unavailable Artwork ${id} was publicly readable.`);
  }
  const malformed = await api(fixtures.first, "/v1/public/artworks/not-an-artwork");
  assert(malformed.response.status === 404 && malformed.data?.error?.code === "not_found", "A malformed public Artwork ID did not fail closed.");
  const inactiveFilter = await api(fixtures.first, `/v1/public/artworks?collection_id=${fixtures.ids.inactiveCollectionId}`);
  assert(inactiveFilter.response.status === 404 && inactiveFilter.data?.error?.code === "not_found", "An inactive Collection filter did not fail closed.");

  console.log("Public portfolio verification passed: Site isolation, publication/archive visibility, active Collection filtering, canonical hero derivation, complete variant gating, privacy projection, membership ordering, and signed cursors.");
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
  await verifyPublicPortfolio(fixtures);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await stopApp(app);
  await cleanupFixture().catch((error) => { console.error(`Public portfolio fixture cleanup failed: ${error.message}`); process.exitCode = 1; });
  await pool.end();
  await rm(mediaRoot, { recursive: true, force: true });
}
