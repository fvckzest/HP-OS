import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import sharp from "sharp";
import { getBusinessPool } from "../src/server/database.ts";
import {
  acceptPhotoAttempt,
  cleanupQueuedPhotoMedia,
  handlePhotoDelete,
  handlePhotoPut,
  listPhotos,
  processPhotoJobs,
  validateAndAcceptInitialPhotoUpload,
} from "../src/server/photos.ts";
import { FilesystemMediaStorage, SharpPhotoEncoder } from "../src/server/photo-media.ts";

const databaseUrl = process.env.HPOS_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 2_000 });
const storageRoot = await mkdtemp(path.join(os.tmpdir(), "hpos-photo-curation-"));
const storage = new FilesystemMediaStorage(storageRoot);
const encoder = new SharpPhotoEncoder();
const organizationId = randomUUID();
const siteId = randomUUID();
const artworkIds = [];
const source = await sharp({ create: { width: 32, height: 20, channels: 3, background: { r: 20, g: 100, b: 180 } } }).png().toBuffer();
const dependencies = { storage, encoder, id: randomUUID, photoId: () => `photo_${randomBytes(16).toString("base64url")}` };

async function createArtwork(title) {
  const artworkId = `art_${randomBytes(16).toString("base64url")}`;
  artworkIds.push(artworkId);
  await pool.query(
    `insert into hpos.artworks
     (id, artwork_id, site_id, displayed_artwork_id, title, created_actor_type, created_actor_reference, updated_actor_type, updated_actor_reference)
     values ($1, $2, $3, $4, $5, 'system', 'verify:curation', 'system', 'verify:curation')`,
    [randomUUID(), artworkId, siteId, `PC-${randomUUID().slice(0, 8)}`, title],
  );
  return artworkId;
}

async function acceptInitial(artworkId, deps = dependencies) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await validateAndAcceptInitialPhotoUpload(client, {
      site: { siteId }, artworkId, expectedArtworkVersion: 1, source,
      actor: { type: "system", reference: "verify:curation" }, dependencies: deps,
    });
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally { client.release(); }
}

async function uploadAttempt(artworkId, photoId, expectedPhotoVersion, operation, deps = dependencies) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await acceptPhotoAttempt(client, {
      site: { siteId }, artworkId, photoId, expectedPhotoVersion, source,
      actor: { type: "system", reference: "verify:curation" }, operation, dependencies: deps,
    });
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally { client.release(); }
}

async function httpJson(handler, url, method, body, key) {
  const response = await handler(
    new Request(`http://local.test${url}`, {
      method,
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(body),
    }),
    { siteId, cursorSigningKey: Buffer.alloc(32) },
    url.split("/").filter(Boolean).slice(1),
  );
  return { response, payload: await response.json() };
}

async function cleanup() {
  await pool.query("delete from hpos.organizations where id = $1", [organizationId]);
  const checks = [
    ["organizations", "select count(*)::int as count from hpos.organizations where id = $1", [organizationId]],
    ["Sites", "select count(*)::int as count from hpos.sites where id = $1", [siteId]],
    ["Artworks", "select count(*)::int as count from hpos.artworks where site_id = $1 and artwork_id = any($2::text[])", [siteId, artworkIds]],
    ["Photos", "select count(*)::int as count from hpos.photos where site_id = $1", [siteId]],
    ["variants", "select count(*)::int as count from hpos.photo_variants where site_id = $1", [siteId]],
    ["jobs", "select count(*)::int as count from hpos.photo_processing_jobs where site_id = $1", [siteId]],
    ["media cleanup", "select count(*)::int as count from hpos.photo_media_cleanup where site_id = $1", [siteId]],
  ];
  for (const [label, sql, values] of checks) {
    const result = await pool.query(sql, values);
    assert.equal(Number(result.rows[0]?.count ?? 0), 0, `Photo curation cleanup left rows in ${label}.`);
  }
  console.log("Photo curation fixture cleanup passed: no fixture records remain.");
}

async function main() {
  const artwork = await pool.query("insert into hpos.organizations (id, name) values ($1, $2) returning id", [organizationId, "Photo curation verifier organization"]);
  assert.equal(artwork.rowCount, 1);
  await pool.query("insert into hpos.sites (id, organization_id, name) values ($1, $2, $3)", [siteId, organizationId, "Photo curation verifier Site"]);

  const initialArtwork = await createArtwork("Initial retry Artwork");
  const failingEncoder = {
    inspect: (bytes) => encoder.inspect(bytes),
    encode: async (bytes, variant) => {
      if (variant === "artwork_1600") throw new Error("deterministic failure");
      return encoder.encode(bytes, variant);
    },
  };
  const failed = await acceptInitial(initialArtwork, { ...dependencies, encoder: failingEncoder });
  const failedRun = await processPhotoJobs({ pool, dependencies: { ...dependencies, encoder: failingEncoder } });
  assert.equal(failedRun.failed, 1);
  const failedState = (await pool.query("select status, version from hpos.photos where site_id = $1 and photo_id = $2", [siteId, failed.photo.photo_id])).rows[0];
  assert.deepEqual(failedState, { status: "failed", version: 2 });
  const retried = await uploadAttempt(initialArtwork, failed.photo.photo_id, 2, "retry");
  assert.equal(retried.photo.status, "processing");
  const retryRun = await processPhotoJobs({ pool, dependencies });
  assert.equal(retryRun.completed, 1);
  const retriedState = (await pool.query("select status, active_attempt, replacement_status from hpos.photos where site_id = $1 and photo_id = $2", [siteId, failed.photo.photo_id])).rows[0];
  assert.deepEqual(retriedState, { status: "ready", active_attempt: 2, replacement_status: null });

  const replacementArtwork = await createArtwork("Replacement Artwork");
  const accepted = await acceptInitial(replacementArtwork);
  await processPhotoJobs({ pool, dependencies });
  const before = (await pool.query("select version, active_attempt, ready_variants from hpos.photos where site_id = $1 and photo_id = $2", [siteId, accepted.photo.photo_id])).rows[0];
  const replacement = await uploadAttempt(replacementArtwork, accepted.photo.photo_id, Number(before.version), "replacement");
  assert.equal(replacement.photo.replacement?.status, "processing");
  const failedReplacementRun = await processPhotoJobs({ pool, dependencies: { ...dependencies, encoder: failingEncoder } });
  assert.equal(failedReplacementRun.failed, 1);
  const failedReplacement = (await pool.query("select status, active_attempt, ready_variants, replacement_status, replacement_failure_code, version from hpos.photos where site_id = $1 and photo_id = $2", [siteId, accepted.photo.photo_id])).rows[0];
  assert.equal(failedReplacement.status, "ready");
  assert.equal(Number(failedReplacement.active_attempt), 1);
  assert.deepEqual(failedReplacement.ready_variants, ["grid_400", "artwork_1600"]);
  assert.equal(failedReplacement.replacement_status, "failed");
  assert.equal(failedReplacement.replacement_failure_code, "delivery_variants_failed");
  const retryReplacement = await uploadAttempt(replacementArtwork, accepted.photo.photo_id, Number(failedReplacement.version), "retry");
  assert.equal(retryReplacement.photo.replacement?.status, "processing");
  await processPhotoJobs({ pool, dependencies });
  const successReplacement = (await pool.query("select status, active_attempt, ready_variants, replacement_status, version from hpos.photos where site_id = $1 and photo_id = $2", [siteId, accepted.photo.photo_id])).rows[0];
  assert.deepEqual(successReplacement, { status: "ready", active_attempt: 3, ready_variants: ["grid_400", "artwork_1600"], replacement_status: null, version: Number(failedReplacement.version) + 2 });
  const variants = await pool.query("select distinct attempt_number from hpos.photo_variants where site_id = $1 and photo_id = (select id from hpos.photos where site_id = $1 and photo_id = $2)", [siteId, accepted.photo.photo_id]);
  assert.deepEqual(variants.rows.map((row) => Number(row.attempt_number)).sort(), [1, 3]);
  const privatePhoto = await pool.query("select id from hpos.photos where site_id = $1 and photo_id = $2", [siteId, accepted.photo.photo_id]);
  const privatePhotoId = privatePhoto.rows[0].id;
  const retiredVariantRows = await pool.query(
    "select storage_key, available_at from hpos.photo_media_cleanup where site_id = $1 and photo_id = $2 and attempt_number = 1 order by variant",
    [siteId, privatePhotoId],
  );
  assert.equal(retiredVariantRows.rowCount, 2);
  assert(retiredVariantRows.rows.every((row) => new Date(row.available_at).getTime() > Date.now()), "Replacement variants should wait through the grace period while the Photo remains active.");
  const listed = await pool.connect();
  try {
    const photos = await listPhotos(listed, { siteId }, replacementArtwork);
    assert.equal(photos[0].status, "ready");
    assert.equal(photos[0].replacement, null);
  } finally { listed.release(); }
  const removeReplacedPhoto = await httpJson(handlePhotoDelete, `/v1/admin/artworks/${replacementArtwork}/photos/${accepted.photo.photo_id}`, "DELETE", {
    expected_version: Number(successReplacement.version), expected_artwork_version: 2,
    actor: { type: "system", reference: "verify:curation" },
  }, randomUUID());
  assert.equal(removeReplacedPhoto.response.status, 200);
  const promotedCleanup = await pool.query(
    "select storage_key, available_at, status from hpos.photo_media_cleanup where site_id = $1 and photo_id = $2 and attempt_number = 1 order by variant",
    [siteId, privatePhotoId],
  );
  assert.equal(promotedCleanup.rowCount, 2);
  assert(promotedCleanup.rows.every((row) => row.status === "pending" && new Date(row.available_at).getTime() <= Date.now()), "Deleting a Photo must promote retired media to immediate cleanup.");
  let replacementCleanup;
  do {
    replacementCleanup = await cleanupQueuedPhotoMedia({ pool, limit: 3, siteId, dependencies });
  } while (replacementCleanup.has_more);
  assert.equal(replacementCleanup.failures, 0);
  for (const row of retiredVariantRows.rows) {
    await assert.rejects(() => storage.get(row.storage_key), (error) => error.code === "ENOENT");
  }
  const remainingReplacementMedia = await pool.query("select count(*)::int as count from hpos.photo_variants where site_id = $1 and photo_id = $2", [siteId, privatePhotoId]);
  assert.equal(Number(remainingReplacementMedia.rows[0]?.count ?? 0), 0);

  const curationArtwork = await createArtwork("Curation guard Artwork");
  const first = await acceptInitial(curationArtwork);
  await processPhotoJobs({ pool, dependencies });
  const secondClient = await pool.connect();
  let second;
  try {
    await secondClient.query("begin");
    second = await validateAndAcceptInitialPhotoUpload(secondClient, {
      site: { siteId }, artworkId: curationArtwork, expectedArtworkVersion: 2, source,
      actor: { type: "system", reference: "verify:curation" }, dependencies,
    });
    await secondClient.query("commit");
  } catch (error) {
    await secondClient.query("rollback");
    throw error;
  } finally { secondClient.release(); }
  await processPhotoJobs({ pool, dependencies });
  let hero = await httpJson(handlePhotoPut, `/v1/admin/artworks/${curationArtwork}/hero`, "PUT", {
    photo_id: second.photo.photo_id, expected_version: 3, actor: { type: "system", reference: "verify:curation" },
  }, randomUUID());
  assert.equal(hero.response.status, 200);
  assert.equal(hero.payload.data.hero_photo_id, second.photo.photo_id);
  const reordered = await httpJson(handlePhotoPut, `/v1/admin/artworks/${curationArtwork}/photo-order`, "PUT", {
    photo_ids: [second.photo.photo_id, first.photo.photo_id], expected_version: 4, actor: { type: "system", reference: "verify:curation" },
  }, randomUUID());
  assert.equal(reordered.response.status, 200);
  assert.equal(reordered.payload.data.photos[0].photo_id, second.photo.photo_id);
  const removed = await httpJson(handlePhotoDelete, `/v1/admin/artworks/${curationArtwork}/photos/${first.photo.photo_id}`, "DELETE", {
    expected_version: first.photo.version + 1, expected_artwork_version: 5, actor: { type: "system", reference: "verify:curation" },
  }, randomUUID());
  assert.equal(removed.response.status, 200);
  const mediaCleanup = await cleanupQueuedPhotoMedia({ pool, siteId, dependencies });
  assert(mediaCleanup.removed >= 3, `Expected removed Photo media cleanup, got ${mediaCleanup.removed}.`);
  assert.equal(mediaCleanup.failures, 0);
  const removedCleanupRows = await pool.query("select count(*)::int as count from hpos.photo_media_cleanup where site_id = $1 and status = 'completed'", [siteId]);
  assert(Number(removedCleanupRows.rows[0]?.count ?? 0) >= 3);
  await pool.query("update hpos.artworks set publication_status = 'published' where site_id = $1 and artwork_id = $2", [siteId, curationArtwork]);
  const lastPhoto = (await pool.query("select version from hpos.photos where site_id = $1 and photo_id = $2", [siteId, second.photo.photo_id])).rows[0];
  const blocked = await httpJson(handlePhotoDelete, `/v1/admin/artworks/${curationArtwork}/photos/${second.photo.photo_id}`, "DELETE", {
    expected_version: Number(lastPhoto.version), expected_artwork_version: 6, actor: { type: "system", reference: "verify:curation" },
  }, randomUUID());
  assert.equal(blocked.response.status, 409);
  assert.equal(blocked.payload.error.code, "publication_incomplete");
  console.log(JSON.stringify({ ok: true, retry_attempt: 2, replacement_failed_preserved_attempt: 1, replacement_active_attempt: 3, old_variants_preserved: true }));
}

try {
  await main();
} finally {
  try { await cleanup(); } finally {
    try { await getBusinessPool().end(); }
    finally { await pool.end(); await rm(storageRoot, { recursive: true, force: true }); }
  }
}
