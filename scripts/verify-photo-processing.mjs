import assert from "node:assert/strict";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import sharp from "sharp";
import { getBusinessPool } from "../src/server/database.ts";
import {
  cleanupAbandonedPhotoUploads,
  listPhotos,
  processPhotoJobs,
  validateAndAcceptInitialPhotoUpload,
} from "../src/server/photos.ts";
import {
  FilesystemMediaStorage,
  mediaSha256,
  SharpPhotoEncoder,
  validatePhotoSource,
} from "../src/server/photo-media.ts";

const databaseUrl = process.env.HPOS_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const fixtureWidth = 640;
const fixtureHeight = 480;
const fixturePixels = Buffer.alloc(fixtureWidth * fixtureHeight * 4);
for (let y = 0; y < fixtureHeight; y += 1) {
  for (let x = 0; x < fixtureWidth; x += 1) {
    const offset = (y * fixtureWidth + x) * 4;
    fixturePixels[offset] = (x * 17 + y * 3) % 256;
    fixturePixels[offset + 1] = (x * 5 + y * 19 + (x ^ y)) % 256;
    fixturePixels[offset + 2] = (x * 11 + y * 7 + ((x * y) % 31)) % 256;
    fixturePixels[offset + 3] = 255;
  }
}
const source = await sharp(fixturePixels, { raw: { width: fixtureWidth, height: fixtureHeight, channels: 4 } }).png().toBuffer();
const encoder = new SharpPhotoEncoder();
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 2_000 });
const storageRoot = await mkdtemp(path.join(os.tmpdir(), "hpos-photo-verifier-"));
const storage = new FilesystemMediaStorage(storageRoot);
const organizationId = randomUUID();
const siteId = randomUUID();
const artworkId = `art_${randomBytes(16).toString("base64url")}`;
const artworkIds = [artworkId];

async function cleanupFixture() {
  await pool.query("delete from hpos.organizations where id = $1", [organizationId]);
  const checks = [
    ["organizations", "select count(*)::int as count from hpos.organizations where id = $1", [organizationId]],
    ["Sites", "select count(*)::int as count from hpos.sites where id = $1", [siteId]],
    ["Artworks", "select count(*)::int as count from hpos.artworks where site_id = $1 and artwork_id = any($2::text[])", [siteId, artworkIds]],
    ["Photos", "select count(*)::int as count from hpos.photos where site_id = $1 and artwork_id = any($2::text[])", [siteId, artworkIds]],
    ["Photo variants", "select count(*)::int as count from hpos.photo_variants where site_id = $1", [siteId]],
    ["Photo processing jobs", "select count(*)::int as count from hpos.photo_processing_jobs where site_id = $1", [siteId]],
    ["Photo upload staging", "select count(*)::int as count from hpos.photo_upload_staging where site_id = $1", [siteId]],
    ["Photo media cleanup", "select count(*)::int as count from hpos.photo_media_cleanup where site_id = $1", [siteId]],
  ];
  for (const [label, query, values] of checks) {
    const result = await pool.query(query, values);
    assert.equal(Number(result.rows[0]?.count ?? 0), 0, `Photo processing fixture cleanup left rows in ${label}.`);
  }
  console.log("Photo processing fixture cleanup passed: no fixture organizations, Sites, Artworks, Photos, variants, jobs, or staging rows remain.");
}

function assertLocalDatabase(value) {
  const url = new URL(value);
  assert.equal(url.protocol, "postgresql:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "54322");
  assert.equal(url.username, "postgres");
  assert.equal(url.pathname, "/postgres");
}

async function main() {
  assertLocalDatabase(databaseUrl);
  const decoded = await validatePhotoSource(png, encoder);
  assert.deepEqual({ format: decoded.format, width: decoded.width, height: decoded.height }, { format: "png", width: 1, height: 1 });
  for (const [variant, settings] of Object.entries({ grid_400: 400, artwork_1600: 1_600 })) {
    const encoded = await encoder.encode(source, variant);
    const actual = await sharp(encoded.bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const expected = await sharp(source)
      .removeAlpha()
      .resize({ width: settings, height: settings, fit: "inside", withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.deepEqual({ width: actual.info.width, height: actual.info.height }, { width: expected.info.width, height: expected.info.height });
    let absoluteError = 0;
    for (let index = 0; index < actual.data.length; index += 1) absoluteError += Math.abs(actual.data[index] - expected.data[index]);
    const meanAbsoluteError = absoluteError / actual.data.length;
    assert(meanAbsoluteError <= 18, `${variant} RGB mean absolute error ${meanAbsoluteError} exceeded 18`);
  }
  await assert.rejects(() => validatePhotoSource(Buffer.from("GIF89a-not-supported"), encoder), (error) => error.code === "unsupported_media_type" && error.status === 415);
  await assert.rejects(() => validatePhotoSource(Buffer.from("not-an-image"), encoder), (error) => error.code === "unsupported_media_type" && error.status === 415);
  await assert.rejects(() => validatePhotoSource(Buffer.alloc(50 * 1024 * 1024 + 1), encoder), (error) => error.code === "request_too_large" && error.status === 413);

  await pool.query("begin");
  try {
    await pool.query("insert into hpos.organizations (id, name) values ($1, $2)", [organizationId, "Photo verifier organization"]);
    await pool.query("insert into hpos.sites (id, organization_id, name) values ($1, $2, $3)", [siteId, organizationId, "Photo verifier Site"]);
    await pool.query(
      `insert into hpos.artworks
       (id, artwork_id, site_id, displayed_artwork_id, title, created_actor_type, created_actor_reference, updated_actor_type, updated_actor_reference)
       values ($1, $2, $3, $4, $5, 'system', 'verify:photo', 'system', 'verify:photo')`,
      [randomUUID(), artworkId, siteId, `PV-${randomUUID().slice(0, 8)}`, "Photo verifier Artwork"],
    );
    await pool.query("commit");
  } catch (error) {
    await pool.query("rollback");
    throw error;
  }

  const dependencies = { storage, encoder, id: randomUUID, photoId: () => `photo_${randomBytes(16).toString("base64url")}` };
  const client = await pool.connect();
  let accepted;
  try {
    await client.query("begin");
    accepted = await validateAndAcceptInitialPhotoUpload(client, {
      site: { siteId },
      artworkId,
      expectedArtworkVersion: 1,
      source,
      actor: { type: "system", reference: "verify:photo" },
      dependencies,
    });
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  assert.equal(accepted.photo.status, "processing");
  assert.deepEqual(accepted.photo.ready_variants, []);
  assert.equal(accepted.artwork_version, 2);

  const firstRun = await processPhotoJobs({ pool, limit: 1, dependencies });
  assert.deepEqual(firstRun, { claimed: 1, completed: 1, failed: 0, source_cleanup_failures: 0, has_more: false });
  const readClient = await pool.connect();
  try {
    const photos = await listPhotos(readClient, { siteId }, artworkId);
    assert.equal(photos[0]?.status, "ready");
    assert.deepEqual(photos[0]?.ready_variants, ["grid_400", "artwork_1600"]);
    const variants = await pool.query("select variant, width, height, byte_size, sha256 from hpos.photo_variants where site_id = $1", [siteId]);
    assert.equal(variants.rowCount, 2);
    for (const variant of variants.rows) {
      assert(variant.width >= 1 && variant.height >= 1);
      const stored = await pool.query(
        `select variant.storage_key
           from hpos.photo_variants variant
           join hpos.photos photo on photo.id = variant.photo_id and photo.site_id = variant.site_id
          where variant.site_id = $1 and photo.artwork_id = $2 and photo.photo_id = $3
            and variant.attempt_number = $4 and variant.variant = $5`,
        [siteId, artworkId, accepted.photo.photo_id, 1, variant.variant],
      );
      assert.equal(stored.rowCount, 1);
      assert.equal(variant.sha256, mediaSha256(await storage.get(stored.rows[0].storage_key)));
    }
    const job = await pool.query("select source_storage_key, source_deleted_at, lease_fence, actor_type, actor_reference from hpos.photo_processing_jobs where site_id = $1", [siteId]);
    assert.equal(job.rows[0].source_deleted_at !== null, true);
    assert.equal(Number(job.rows[0].lease_fence), 1);
    assert.deepEqual([job.rows[0].actor_type, job.rows[0].actor_reference], ["system", "verify:photo"]);
    await assert.rejects(() => storage.get(job.rows[0].source_storage_key), (error) => error.code === "ENOENT");
  } finally {
    readClient.release();
  }

  const failedArtworkId = `art_${randomBytes(16).toString("base64url")}`;
  await pool.query(
    `insert into hpos.artworks
     (id, artwork_id, site_id, displayed_artwork_id, title, created_actor_type, created_actor_reference, updated_actor_type, updated_actor_reference)
     values ($1, $2, $3, $4, $5, 'system', 'verify:photo', 'system', 'verify:photo')`,
    [randomUUID(), failedArtworkId, siteId, `PV-${randomUUID().slice(0, 8)}`, "Failed Photo verifier Artwork"],
  );
  artworkIds.push(failedArtworkId);
  const failureEncoder = {
    inspect: (source) => encoder.inspect(source),
    encode: async (_source, variant) => {
      if (variant === "artwork_1600") throw new Error("deterministic encoder failure");
      return encoder.encode(source, variant);
    },
  };
  const failedDependencies = { storage, encoder: failureEncoder, id: randomUUID, photoId: () => `photo_${randomBytes(16).toString("base64url")}` };
  const failureClient = await pool.connect();
  let failedAccepted;
  try {
    await failureClient.query("begin");
    failedAccepted = await validateAndAcceptInitialPhotoUpload(failureClient, {
      site: { siteId }, artworkId: failedArtworkId, expectedArtworkVersion: 1, source,
      actor: { type: "system", reference: "verify:photo" }, dependencies: failedDependencies,
    });
    await failureClient.query("commit");
  } catch (error) {
    await failureClient.query("rollback");
    throw error;
  } finally {
    failureClient.release();
  }
  const failedRun = await processPhotoJobs({ pool, limit: 1, dependencies: failedDependencies });
  assert.equal(failedRun.failed, 1);
  assert.equal(failedRun.source_cleanup_failures, 0);
  const failedPhoto = (await pool.query("select status, failure_code from hpos.photos where site_id = $1 and artwork_id = $2", [siteId, failedArtworkId])).rows[0];
  assert.deepEqual(failedPhoto, { status: "failed", failure_code: "delivery_variants_failed" });
  const failedJob = (await pool.query(
    "select source_storage_key, source_deleted_at from hpos.photo_processing_jobs where site_id = $1 and artwork_id = $2",
    [siteId, failedArtworkId],
  )).rows[0];
  assert.ok(failedJob?.source_deleted_at, "The failed Photo processing job did not record source deletion.");
  await assert.rejects(() => storage.get(failedJob.source_storage_key), (error) => error.code === "ENOENT");

  const abandonedId = randomUUID();
  const abandonedKey = `staging/${siteId}/${abandonedId}/source`;
  await storage.put(abandonedKey, source);
  await pool.query(
    `insert into hpos.photo_upload_staging (id, site_id, storage_key, byte_size, expires_at)
     values ($1, $2, $3, $4, clock_timestamp() - interval '1 second')`,
    [abandonedId, siteId, abandonedKey, source.byteLength],
  );
  const orphanKey = `sites/${siteId}/orphan/${randomUUID()}/source`;
  await storage.put(orphanKey, source);
  const expiredAt = new Date(Date.now() - (24 * 60 * 60 * 1000 + 1_000));
  await utimes(path.join(storageRoot, orphanKey), expiredAt, expiredAt);
  const cleanup = await cleanupAbandonedPhotoUploads({ pool, dependencies: { storage, now: () => new Date() } });
  assert.equal(cleanup.removed, 2);
  await assert.rejects(() => storage.get(abandonedKey), (error) => error.code === "ENOENT");
  await assert.rejects(() => storage.get(orphanKey), (error) => error.code === "ENOENT");

  console.log(JSON.stringify({ ok: true, accepted_photo_id: accepted.photo.photo_id, variants: 2, quality: { encoder: "webp", quality: 82, effort: 4, smart_subsample: true, rgb_mae_max: 18 }, failed_photo_status: failedPhoto.status, abandoned_uploads_removed: cleanup.removed }));
}

try {
  await main();
} finally {
  try {
    await cleanupFixture();
  } finally {
    try {
      try { await getBusinessPool().end(); }
      finally { await pool.end(); }
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  }
}
