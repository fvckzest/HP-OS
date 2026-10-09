import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { cleanupQueuedPhotoMedia, processPhotoJobs } from "../src/server/photos.ts";
import { FilesystemMediaStorage } from "../src/server/photo-media.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.HPOS_VERIFY_PHOTO_PORT ?? 3282);
const origin = `http://127.0.0.1:${port}`;
const databaseUrl = process.env.HPOS_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const mediaRoot = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "hpos-photo-http-media-"));
const env = {
  ...process.env,
  NODE_ENV: "development",
  HPOS_DATABASE_URL: databaseUrl,
  HPOS_MEDIA_ROOT: mediaRoot,
  NEXT_TELEMETRY_DISABLED: "1",
};
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 2_000 });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const MAX_PHOTO_BYTES = 50 * 1024 * 1024;
const organizationIds = [];
const siteIds = [];
let app;

function makeKey() {
  const id = randomUUID();
  const value = `hpos_site_${id}_${randomBytes(32).toString("base64url")}`;
  return { id, value, hash: createHash("sha256").update(value, "utf8").digest("hex") };
}

async function createFixture() {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const organizationId = (await client.query(
      "insert into hpos.organizations (name) values ($1) returning id",
      [`Issue 122 HTTP verification ${randomUUID()}`],
    )).rows[0].id;
    organizationIds.push(organizationId);
    const siteId = (await client.query(
      "insert into hpos.sites (organization_id, name) values ($1, $2) returning id",
      [organizationId, "Issue 122 HTTP verification Site"],
    )).rows[0].id;
    const foreignSiteId = (await client.query(
      "insert into hpos.sites (organization_id, name) values ($1, $2) returning id",
      [organizationId, "Issue 122 HTTP verification Foreign Site"],
    )).rows[0].id;
    siteIds.push(siteId, foreignSiteId);
    const key = makeKey();
    const foreignKey = makeKey();
    await client.query(
      "insert into hpos.site_api_keys (id, site_id, key_hash) values ($1, $2, $3), ($4, $5, $6)",
      [key.id, siteId, key.hash, foreignKey.id, foreignSiteId, foreignKey.hash],
    );
    const artworkId = `art_${randomBytes(16).toString("base64url")}`;
    const foreignArtworkId = `art_${randomBytes(16).toString("base64url")}`;
    const foreignPhotoId = `photo_${randomBytes(16).toString("base64url")}`;
    await client.query(
      `insert into hpos.artworks
       (id, artwork_id, site_id, displayed_artwork_id, title, created_actor_type, created_actor_reference, updated_actor_type, updated_actor_reference)
       values ($1, $2, $3, $4, $5, 'system', 'verify:photo-http', 'system', 'verify:photo-http')`,
      [randomUUID(), artworkId, siteId, `PH-${randomUUID().slice(0, 8)}`, "HTTP Photo verifier Artwork"],
    );
    await client.query(
      `insert into hpos.artworks
       (id, artwork_id, site_id, displayed_artwork_id, title, created_actor_type, created_actor_reference, updated_actor_type, updated_actor_reference)
       values ($1, $2, $3, $4, $5, 'system', 'verify:photo-http', 'system', 'verify:photo-http')`,
      [randomUUID(), foreignArtworkId, foreignSiteId, `PH-${randomUUID().slice(0, 8)}`, "Foreign HTTP Photo verifier Artwork"],
    );
    await client.query(
      `insert into hpos.photos (id, photo_id, site_id, artwork_id, position, status, ready_variants, version)
       values ($1, $2, $3, $4, 1, 'processing', '{}', 1)`,
      [randomUUID(), foreignPhotoId, foreignSiteId, foreignArtworkId],
    );
    await client.query("commit");
    return { siteId, apiKey: key.value, foreignSiteId, foreignApiKey: foreignKey.value, artworkId, foreignArtworkId, foreignPhotoId };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
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
    if (server.child.exitCode !== null) throw new Error(`The Photo HTTP verifier app stopped early.\n${server.output}`);
    try {
      const response = await fetch(`${origin}/v1/admin/payment-configuration`, { signal: AbortSignal.timeout(2_000) });
      if (response.status === 401) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`The Photo HTTP verifier app did not become ready.\n${server.output}`);
}

async function stopApp(server) {
  if (!server || server.child.exitCode !== null) return;
  await new Promise((resolve) => {
    server.child.once("exit", resolve);
    server.child.kill("SIGTERM");
    setTimeout(() => { if (server.child.exitCode === null) server.child.kill("SIGKILL"); }, 5_000).unref();
  });
}

function makeMultipartForm({ bytes = png, expectedVersion, actor = "verify:photo-http", metadataText, metadataFile = true, includeFile = true, includeMetadata = true, extraPart = false } = {}) {
  const form = new FormData();
  if (includeFile) form.append("file", new Blob([bytes], { type: "image/png" }), "source.png");
  const metadata = metadataText ?? JSON.stringify({ expected_version: expectedVersion, actor: { type: "system", reference: actor } });
  if (includeMetadata) {
    if (metadataFile) form.append("metadata", new Blob([metadata], { type: "application/json" }), "metadata.json");
    else form.append("metadata", metadata);
  }
  if (extraPart) form.append("unexpected", "extra multipart value");
  return form;
}

async function readResponse(response) {
  let data = null;
  try { data = await response.json(); } catch {}
  return { response, data };
}

async function multipart(site, artworkId, { key, ...options }) {
  return multipartTo(site, `/v1/admin/artworks/${artworkId}/photos`, { key, ...options });
}

async function multipartTo(site, pathname, { key, ...options }) {
  const form = makeMultipartForm(options);
  const response = await fetch(`${origin}${pathname}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${site.apiKey}`, "Idempotency-Key": key },
    body: form,
  });
  return readResponse(response);
}

async function multipartWithoutContentLength(site, artworkId, { key, ...options }) {
  const formRequest = new Request(`${origin}/v1/admin/artworks/${artworkId}/photos`, { method: "POST", body: makeMultipartForm(options) });
  assert.equal(formRequest.headers.has("content-length"), false);
  const response = await fetch(formRequest.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${site.apiKey}`,
      "Idempotency-Key": key,
      "Content-Type": formRequest.headers.get("content-type"),
    },
    body: formRequest.body,
    duplex: "half",
  });
  return readResponse(response);
}

async function api(site, pathname) {
  const response = await fetch(`${origin}${pathname}`, { headers: { Authorization: `Bearer ${site.apiKey}` } });
  let data = null;
  try { data = await response.json(); } catch {}
  return { response, data };
}

async function jsonApi(site, pathname, { method, key = randomUUID(), body }) {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${site.apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify(body),
  });
  return readResponse(response);
}

function tamperCursor(cursor) {
  assert.ok(typeof cursor === "string" && cursor.length > 1);
  const signatureStart = cursor.indexOf(".") + 1;
  assert.ok(signatureStart > 0 && signatureStart < cursor.length);
  const replacement = cursor[signatureStart] === "A" ? "B" : "A";
  return `${cursor.slice(0, signatureStart)}${replacement}${cursor.slice(signatureStart + 1)}`;
}

async function cleanupFixture() {
  if (!organizationIds.length) return;
  await pool.query("delete from hpos.organizations where id = any($1::uuid[])", [organizationIds]);
  const checks = [
    ["organizations", "select count(*)::int as count from hpos.organizations where id = any($1::uuid[])", organizationIds],
    ["Sites", "select count(*)::int as count from hpos.sites where id = any($1::uuid[])", siteIds],
    ["site API keys", "select count(*)::int as count from hpos.site_api_keys where site_id = any($1::uuid[])", siteIds],
    ["rate limit windows", "select count(*)::int as count from hpos.site_request_windows where site_id = any($1::uuid[])", siteIds],
    ["idempotency records", "select count(*)::int as count from hpos.api_idempotency_records where site_id = any($1::uuid[])", siteIds],
    ["Artworks", "select count(*)::int as count from hpos.artworks where site_id = any($1::uuid[])", siteIds],
    ["Photos", "select count(*)::int as count from hpos.photos where site_id = any($1::uuid[])", siteIds],
    ["Photo variants", "select count(*)::int as count from hpos.photo_variants where site_id = any($1::uuid[])", siteIds],
    ["Photo processing jobs", "select count(*)::int as count from hpos.photo_processing_jobs where site_id = any($1::uuid[])", siteIds],
    ["Photo upload staging", "select count(*)::int as count from hpos.photo_upload_staging where site_id = any($1::uuid[])", siteIds],
    ["Photo media cleanup", "select count(*)::int as count from hpos.photo_media_cleanup where site_id = any($1::uuid[])", siteIds],
  ];
  for (const [label, query, ids] of checks) {
    const result = await pool.query(query, [ids]);
    assert.equal(Number(result.rows[0]?.count ?? 0), 0, `Photo HTTP fixture cleanup left rows in ${label}.`);
  }
  console.log("Photo HTTP fixture cleanup passed: no fixture organizations, Sites, keys, rate windows, idempotency records, Artworks, Photos, variants, jobs, staging, or media-cleanup rows remain.");
}

async function main() {
  const missing = await fetch(`${origin}/v1/admin/artworks/${"art_" + "A".repeat(22)}/photos`);
  assert.equal(missing.status, 401);
  const fixture = await createFixture();

  const foreignRead = await api({ apiKey: fixture.foreignApiKey }, `/v1/admin/artworks/${fixture.artworkId}/photos`);
  assert.equal(foreignRead.response.status, 404, JSON.stringify(foreignRead.data));
  assert.equal(foreignRead.data?.error?.code, "not_found");
  const foreignUpload = await multipart({ apiKey: fixture.foreignApiKey }, fixture.artworkId, { key: randomUUID(), expectedVersion: 1 });
  assert.equal(foreignUpload.response.status, 404, JSON.stringify(foreignUpload.data));
  assert.equal(foreignUpload.data?.error?.code, "not_found");

  const missingFile = await multipart(fixture, fixture.artworkId, { key: randomUUID(), expectedVersion: 1, includeFile: false });
  assert.equal(missingFile.response.status, 422, JSON.stringify(missingFile.data));
  assert.equal(missingFile.data?.error?.details?.[0]?.code, "parts_required");
  const missingMetadata = await multipart(fixture, fixture.artworkId, { key: randomUUID(), expectedVersion: 1, includeMetadata: false });
  assert.equal(missingMetadata.response.status, 422, JSON.stringify(missingMetadata.data));
  assert.equal(missingMetadata.data?.error?.details?.[0]?.code, "parts_required");
  const extraPart = await multipart(fixture, fixture.artworkId, { key: randomUUID(), expectedVersion: 1, extraPart: true });
  assert.equal(extraPart.response.status, 422, JSON.stringify(extraPart.data));
  assert.equal(extraPart.data?.error?.details?.[0]?.code, "unexpected_part");

  const corruptBytes = Buffer.concat([png.subarray(0, 8), Buffer.from("corrupt image bytes")]);
  const corrupt = await multipart(fixture, fixture.artworkId, { key: randomUUID(), bytes: corruptBytes, expectedVersion: 1 });
  assert.equal(corrupt.response.status, 422, JSON.stringify(corrupt.data));
  assert.equal(corrupt.data?.error?.code, "image_invalid");
  const unsupported = await multipart(fixture, fixture.artworkId, { key: randomUUID(), bytes: Buffer.from("GIF89a-not-supported"), expectedVersion: 1 });
  assert.equal(unsupported.response.status, 415, JSON.stringify(unsupported.data));
  assert.equal(unsupported.data?.error?.code, "unsupported_media_type");
  const oversized = await multipart(fixture, fixture.artworkId, { key: randomUUID(), bytes: Buffer.alloc(MAX_PHOTO_BYTES + 1), expectedVersion: 1 });
  assert.equal(oversized.response.status, 413, JSON.stringify(oversized.data));
  assert.equal(oversized.data?.error?.code, "request_too_large");

  const key = randomUUID();
  const accepted = await multipart(fixture, fixture.artworkId, {
    key,
    expectedVersion: 1,
    metadataText: '{"expected_version":1,"actor":{"type":"system","reference":"verify:photo-http"}}',
  });
  assert.equal(accepted.response.status, 202, JSON.stringify(accepted.data));
  assert.equal(accepted.data?.data?.photo?.status, "processing");
  const photoId = accepted.data.data.photo.photo_id;
  const replay = await multipart(fixture, fixture.artworkId, {
    key,
    expectedVersion: 1,
    metadataText: '{ "actor": {"reference":"verify:photo-http", "type":"system"}, "expected_version": 1 }',
  });
  assert.equal(replay.response.status, 202);
  assert.equal(replay.data?.data?.photo?.photo_id, photoId);
  const invalidReplay = await multipart(fixture, fixture.artworkId, { key, bytes: Buffer.from("not-an-image"), expectedVersion: 1 });
  assert.equal(invalidReplay.response.status, 409, JSON.stringify(invalidReplay.data));
  assert.equal(invalidReplay.data?.error?.code, "idempotency_conflict");

  const second = await multipartWithoutContentLength(fixture, fixture.artworkId, { key: randomUUID(), expectedVersion: 2, metadataFile: false });
  assert.equal(second.response.status, 202, JSON.stringify(second.data));
  const secondPhotoId = second.data?.data?.photo?.photo_id;
  assert.match(secondPhotoId ?? "", /^photo_[A-Za-z0-9_-]{22}$/);
  const firstPage = await api(fixture, `/v1/admin/artworks/${fixture.artworkId}/photos?limit=1`);
  assert.equal(firstPage.response.status, 200, JSON.stringify(firstPage.data));
  assert.equal(firstPage.data?.data?.length, 1);
  assert.match(firstPage.data?.pagination?.next_cursor ?? "", /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const secondPage = await api(fixture, `/v1/admin/artworks/${fixture.artworkId}/photos?limit=1&cursor=${encodeURIComponent(firstPage.data.pagination.next_cursor)}`);
  assert.equal(secondPage.response.status, 200, JSON.stringify(secondPage.data));
  assert.equal(secondPage.data?.data?.length, 1);
  const invalidCursor = await api(fixture, `/v1/admin/artworks/${fixture.artworkId}/photos?cursor=bad.cursor`);
  assert.equal(invalidCursor.response.status, 422);
  assert.equal(invalidCursor.data?.error?.code, "invalid_cursor");
  assert.match(invalidCursor.data?.request_id ?? "", /^[0-9a-f-]{36}$/i);
  assert.match(invalidCursor.response.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/i);
  const tamperedCursor = await api(fixture, `/v1/admin/artworks/${fixture.artworkId}/photos?limit=1&cursor=${encodeURIComponent(tamperCursor(firstPage.data.pagination.next_cursor))}`);
  assert.equal(tamperedCursor.response.status, 422);
  assert.equal(tamperedCursor.data?.error?.code, "invalid_cursor");
  const wrongScopeCursor = await api(fixture, `/v1/admin/artworks/${fixture.artworkId}/photos?limit=2&cursor=${encodeURIComponent(firstPage.data.pagination.next_cursor)}`);
  assert.equal(wrongScopeCursor.response.status, 422);
  assert.equal(wrongScopeCursor.data?.error?.code, "invalid_cursor");
  const foreignCursor = await api({ apiKey: fixture.foreignApiKey }, `/v1/admin/artworks/${fixture.artworkId}/photos?limit=1&cursor=${encodeURIComponent(firstPage.data.pagination.next_cursor)}`);
  assert.equal(foreignCursor.response.status, 404);
  assert.equal(foreignCursor.data?.error?.code, "not_found");

  const cron = await fetch(`${origin}/api/cron/process`);
  const cronData = await cron.json();
  assert.equal(cron.status, 200, JSON.stringify(cronData));
  assert.equal(cronData?.data?.photo_processing?.completed, 2, JSON.stringify(cronData));
  assert.equal(cronData?.data?.photo_processing?.has_more, false);
  const ready = await api(fixture, `/v1/admin/artworks/${fixture.artworkId}/photos?limit=100`);
  assert.equal(ready.response.status, 200);
  assert(ready.data.data.every((photo) => photo.status === "ready" && photo.ready_variants.length === 2));
  const jobs = await pool.query(
    "select source_storage_key, source_deleted_at from hpos.photo_processing_jobs where site_id = $1 order by created_at",
    [fixture.siteId],
  );
  assert.equal(jobs.rowCount, 2);
  assert(jobs.rows.every((job) => job.source_deleted_at !== null));
  for (const job of jobs.rows) {
    await assert.rejects(() => import("node:fs/promises").then(({ access }) => access(path.join(mediaRoot, job.source_storage_key))));
  }

  const readyPhotos = ready.data.data;
  assert.equal(readyPhotos.length, 2);
  const firstReadyPhoto = readyPhotos.find((photo) => photo.photo_id === photoId);
  const secondReadyPhoto = readyPhotos.find((photo) => photo.photo_id === secondPhotoId);
  assert.ok(firstReadyPhoto && secondReadyPhoto, "The processed Photo list did not contain both uploaded Photos.");
  const currentArtworkVersion = second.data.data.artwork_version;
  const reorder = await jsonApi(fixture, `/v1/admin/artworks/${fixture.artworkId}/photo-order`, {
    method: "PUT",
    body: { photo_ids: [secondPhotoId, photoId], expected_version: currentArtworkVersion, actor: { type: "system", reference: "verify:photo-http-curation" } },
  });
  assert.equal(reorder.response.status, 200, JSON.stringify(reorder.data));
  assert.deepEqual(reorder.data?.data?.photos?.map((photo) => [photo.photo_id, photo.position]), [[secondPhotoId, 1], [photoId, 2]]);
  assert.equal(reorder.data?.data?.version, currentArtworkVersion + 1);

  const hero = await jsonApi(fixture, `/v1/admin/artworks/${fixture.artworkId}/hero`, {
    method: "PUT",
    body: { photo_id: secondPhotoId, expected_version: reorder.data.data.version, actor: { type: "system", reference: "verify:photo-http-curation" } },
  });
  assert.equal(hero.response.status, 200, JSON.stringify(hero.data));
  assert.equal(hero.data?.data?.hero_photo_id, secondPhotoId);
  assert.equal(hero.data?.data?.version, reorder.data.data.version + 1);

  const staleOrder = await jsonApi(fixture, `/v1/admin/artworks/${fixture.artworkId}/photo-order`, {
    method: "PUT",
    body: { photo_ids: [photoId, secondPhotoId], expected_version: reorder.data.data.version, actor: { type: "system", reference: "verify:photo-http-curation" } },
  });
  assert.equal(staleOrder.response.status, 409, JSON.stringify(staleOrder.data));
  assert.equal(staleOrder.data?.error?.code, "version_conflict");

  const invalidHero = await jsonApi(fixture, `/v1/admin/artworks/${fixture.artworkId}/hero`, {
    method: "PUT",
    body: { photo_id: "photo_invalid", expected_version: hero.data.data.version, actor: { type: "system", reference: "verify:photo-http-curation" } },
  });
  assert.equal(invalidHero.response.status, 422, JSON.stringify(invalidHero.data));
  assert.equal(invalidHero.data?.error?.details?.[0]?.field, "photo_id");
  const foreignHero = await jsonApi(fixture, `/v1/admin/artworks/${fixture.artworkId}/hero`, {
    method: "PUT",
    body: { photo_id: fixture.foreignPhotoId, expected_version: hero.data.data.version, actor: { type: "system", reference: "verify:photo-http-curation" } },
  });
  assert.equal(foreignHero.response.status, 404, JSON.stringify(foreignHero.data));
  assert.equal(foreignHero.data?.error?.code, "not_found");
  const foreignDelete = await jsonApi(fixture, `/v1/admin/artworks/${fixture.artworkId}/photos/${fixture.foreignPhotoId}`, {
    method: "DELETE",
    body: { expected_version: 1, expected_artwork_version: hero.data.data.version, actor: { type: "system", reference: "verify:photo-http-curation" } },
  });
  assert.equal(foreignDelete.response.status, 404, JSON.stringify(foreignDelete.data));
  assert.equal(foreignDelete.data?.error?.code, "not_found");

  const removedMedia = await pool.query(
    `select p.id, array(
       select source_storage_key from hpos.photo_processing_jobs where site_id = p.site_id and photo_id = p.id
       union all
       select storage_key from hpos.photo_variants where site_id = p.site_id and photo_id = p.id
     ) as storage_keys
       from hpos.photos p
      where p.site_id = $1 and p.artwork_id = $2 and p.photo_id = $3`,
    [fixture.siteId, fixture.artworkId, photoId],
  );
  assert.equal(removedMedia.rowCount, 1);
  const removedStorageKeys = removedMedia.rows[0].storage_keys;
  assert.equal(removedStorageKeys.length, 3, "The removed Photo fixture did not have its source and both delivery variants.");
  const remove = await jsonApi(fixture, `/v1/admin/artworks/${fixture.artworkId}/photos/${photoId}`, {
    method: "DELETE",
    body: { expected_version: firstReadyPhoto.version, expected_artwork_version: hero.data.data.version, actor: { type: "system", reference: "verify:photo-http-curation" } },
  });
  assert.equal(remove.response.status, 200, JSON.stringify(remove.data));
  assert.equal(remove.data?.data?.photos?.length, 1);
  assert.equal(remove.data?.data?.photos?.[0]?.photo_id, secondPhotoId);
  assert.equal(remove.data?.data?.photos?.[0]?.position, 1);
  assert.equal(remove.data?.data?.hero_photo_id, secondPhotoId);
  assert.equal(remove.data?.data?.version, hero.data.data.version + 1);
  const localStorage = new FilesystemMediaStorage(mediaRoot);
  const queuedCleanup = await pool.query(
    "select storage_key, status from hpos.photo_media_cleanup where site_id = $1 and storage_key = any($2::text[]) order by storage_key",
    [fixture.siteId, removedStorageKeys],
  );
  assert.equal(queuedCleanup.rowCount, removedStorageKeys.length, "Photo removal did not queue every source and variant key for durable cleanup.");
  assert(queuedCleanup.rows.every((row) => row.status === "pending"));
  let deletionCleanup;
  do {
    deletionCleanup = await cleanupQueuedPhotoMedia({ pool, limit: 3, siteId: fixture.siteId, dependencies: { storage: localStorage } });
  } while (deletionCleanup.has_more);
  assert.equal(deletionCleanup.failures, 0, JSON.stringify(deletionCleanup));
  const completedCleanup = await pool.query(
    "select count(*)::int as count from hpos.photo_media_cleanup where site_id = $1 and storage_key = any($2::text[]) and status = 'completed'",
    [fixture.siteId, removedStorageKeys],
  );
  assert.equal(Number(completedCleanup.rows[0]?.count ?? 0), removedStorageKeys.length);
  const { access } = await import("node:fs/promises");
  for (const storageKey of removedStorageKeys) {
    await assert.rejects(() => access(path.join(mediaRoot, storageKey)), (error) => error.code === "ENOENT");
  }

  const collectionId = `col_${randomBytes(16).toString("base64url")}`;
  await pool.query(
    `insert into hpos.collections
       (collection_id, site_id, name, position, created_actor_type, created_actor_reference,
        updated_actor_type, updated_actor_reference)
     values ($1, $2, 'Published Photo verifier', 1, 'system', 'verify:photo-http', 'system', 'verify:photo-http')`,
    [collectionId, fixture.siteId],
  );
  await pool.query(
    "insert into hpos.collection_artworks (collection_id, artwork_id, site_id, position) values ($1, $2, $3, 1)",
    [collectionId, fixture.artworkId, fixture.siteId],
  );
  await pool.query("update hpos.artworks set slug = 'photo-http-verifier' where site_id = $1 and artwork_id = $2", [fixture.siteId, fixture.artworkId]);
  const publish = await jsonApi(fixture, `/v1/admin/artworks/${fixture.artworkId}/actions/publish`, {
    method: "POST",
    body: { expected_version: remove.data.data.version, actor: { type: "system", reference: "verify:photo-http-publish" } },
  });
  assert.equal(publish.response.status, 200, JSON.stringify(publish.data));
  assert.equal(publish.data.data.publication_status, "published");

  const pendingOnPublished = await multipart(fixture, fixture.artworkId, {
    key: randomUUID(), expectedVersion: publish.data.data.version,
  });
  assert.equal(pendingOnPublished.response.status, 202, JSON.stringify(pendingOnPublished.data));
  assert.equal(pendingOnPublished.data.data.photo.status, "processing");
  const editWhileProcessing = await jsonApi(fixture, `/v1/admin/artworks/${fixture.artworkId}`, {
    method: "PATCH",
    body: {
      expected_version: pendingOnPublished.data.data.artwork_version,
      actor: { type: "system", reference: "verify:photo-http-edit" },
      title: "Published Photo verifier updated during processing",
    },
  });
  assert.equal(editWhileProcessing.response.status, 200, JSON.stringify(editWhileProcessing.data));
  assert.equal(editWhileProcessing.data.data.publication_status, "published");
  const publicDuringProcessing = await api(fixture, `/v1/public/artworks/${fixture.artworkId}`);
  assert.equal(publicDuringProcessing.response.status, 200, JSON.stringify(publicDuringProcessing.data));
  assert.equal(publicDuringProcessing.data.data.photos.length, 1, "The new incomplete Photo hid the existing ready public Photo.");
  assert.equal(publicDuringProcessing.data.data.photos[0].photo_id, secondPhotoId);
  const finishPublishedUpload = await processPhotoJobs({ pool, limit: 1, siteId: fixture.siteId, dependencies: { storage: localStorage } });
  assert.equal(finishPublishedUpload.completed, 1, JSON.stringify(finishPublishedUpload));

  const failedUpload = await multipart(fixture, fixture.artworkId, {
    key: randomUUID(),
    expectedVersion: editWhileProcessing.data.data.version,
  });
  assert.equal(failedUpload.response.status, 202, JSON.stringify(failedUpload.data));
  const failedPhotoId = failedUpload.data.data.photo.photo_id;
  const failedSource = await pool.query(
    `select job.source_storage_key
       from hpos.photo_processing_jobs job
       join hpos.photos photo on photo.id = job.photo_id and photo.site_id = job.site_id
      where photo.site_id = $1 and photo.artwork_id = $2 and photo.photo_id = $3`,
    [fixture.siteId, fixture.artworkId, failedPhotoId],
  );
  assert.equal(failedSource.rowCount, 1);
  await localStorage.remove(failedSource.rows[0].source_storage_key);
  const failedRun = await processPhotoJobs({ pool, limit: 1, siteId: fixture.siteId, dependencies: { storage: localStorage } });
  assert.equal(failedRun.failed, 1, JSON.stringify(failedRun));
  let photoList = await api(fixture, `/v1/admin/artworks/${fixture.artworkId}/photos?limit=100`);
  let failedPhoto = photoList.data.data.find((photo) => photo.photo_id === failedPhotoId);
  assert.equal(failedPhoto?.status, "failed");
  assert.equal(failedPhoto?.retryable, true);
  const retry = await multipartTo(fixture, `/v1/admin/artworks/${fixture.artworkId}/photos/${failedPhotoId}/actions/retry`, {
    key: randomUUID(),
    expectedVersion: failedPhoto.version,
  });
  assert.equal(retry.response.status, 202, JSON.stringify(retry.data));
  assert.equal(retry.data.data.photo.photo_id, failedPhotoId);
  const retryRun = await processPhotoJobs({ pool, limit: 1, siteId: fixture.siteId, dependencies: { storage: localStorage } });
  assert.equal(retryRun.completed, 1, JSON.stringify(retryRun));
  photoList = await api(fixture, `/v1/admin/artworks/${fixture.artworkId}/photos?limit=100`);
  const retriedPhoto = photoList.data.data.find((photo) => photo.photo_id === failedPhotoId);
  assert.equal(retriedPhoto?.status, "ready");

  const replacement = await multipartTo(fixture, `/v1/admin/artworks/${fixture.artworkId}/photos/${failedPhotoId}/replacement`, {
    key: randomUUID(),
    expectedVersion: retriedPhoto.version,
  });
  assert.equal(replacement.response.status, 202, JSON.stringify(replacement.data));
  assert.equal(replacement.data.data.photo.photo_id, failedPhotoId);
  assert.equal(replacement.data.data.photo.replacement.status, "processing");
  const replacementRun = await processPhotoJobs({ pool, limit: 1, siteId: fixture.siteId, dependencies: { storage: localStorage } });
  assert.equal(replacementRun.completed, 1, JSON.stringify(replacementRun));
  photoList = await api(fixture, `/v1/admin/artworks/${fixture.artworkId}/photos?limit=100`);
  const replacedPhoto = photoList.data.data.find((photo) => photo.photo_id === failedPhotoId);
  assert.equal(replacedPhoto?.status, "ready");
  assert.equal(replacedPhoto?.replacement, null);
  const attempts = await pool.query(
    `select photo.active_attempt, job.attempt_number, job.operation, job.actor_type, job.actor_reference
       from hpos.photos photo
       join hpos.photo_processing_jobs job on job.site_id = photo.site_id and job.photo_id = photo.id
      where photo.site_id = $1 and photo.artwork_id = $2 and photo.photo_id = $3`,
    [fixture.siteId, fixture.artworkId, failedPhotoId],
  );
  assert.equal(Number(attempts.rows[0]?.active_attempt), 3);
  assert.deepEqual(attempts.rows.map((row) => [Number(row.attempt_number), row.operation, row.actor_type, row.actor_reference]), [
    [1, "initial", "system", "verify:photo-http"],
    [2, "retry", "system", "verify:photo-http"],
    [3, "replacement", "system", "verify:photo-http"],
  ]);

  console.log(JSON.stringify({ ok: true, accepted_photo_id: photoId, replayed: true, idempotency_conflict: true, pages: 2, processed: 2, sources_deleted: 2, photo_ordered: true, hero_selected: true, stale_version_rejected: true, photo_removed: true, media_cleanup_queued: queuedCleanup.rowCount, retry_via_http: true, replacement_via_http: true, attempt_actor_audit: true, published_photo_processing_preserves_public_ready_photos: true }));
}

try {
  app = startApp();
  await waitForReady(app);
  await main();
} finally {
  await stopApp(app);
  try {
    await cleanupFixture();
  } finally {
    try {
      await pool.end();
    } finally {
      await rm(mediaRoot, { recursive: true, force: true });
    }
  }
}
