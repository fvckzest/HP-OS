import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { ApiOperationError, withApiIdempotency } from "./api-idempotency";
import { apiFailure, apiSuccess } from "./api-response";
import { getBusinessPool } from "./database";
import type { AuthenticatedSite } from "./site-auth";
import {
  ABANDONED_UPLOAD_TTL_MS,
  defaultMediaStorage,
  MAX_MULTIPART_OVERHEAD_BYTES,
  MAX_PHOTO_BYTES,
  mediaSha256,
  PHOTO_VARIANTS,
  type MediaStorage,
  PhotoMediaError,
  type PhotoEncoder,
  sourceStorageKey,
  SharpPhotoEncoder,
  stagingStorageKey,
  validatePhotoSource,
  variantStorageKey,
  type PhotoVariant,
} from "./photo-media";

export const PHOTO_ID_PATTERN = /^photo_[A-Za-z0-9_-]{22}$/;
export const MAX_PHOTO_PROCESSING_BATCH = 3;
const PROCESSING_LEASE_MS = 15 * 60 * 1000;
const MAX_ORPHAN_OBJECTS_PER_PREFIX = 200;
const PHOTO_VARIANT_RETIRE_GRACE_MS = 24 * 60 * 60 * 1000;
const ACTOR_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export interface Actor {
  type: "user" | "system";
  reference: string;
}

export interface PhotoRow extends QueryResultRow {
  id: string;
  photo_id: string;
  site_id: string;
  artwork_id: string;
  position: number;
  is_hero: boolean;
  status: "processing" | "ready" | "failed";
  ready_variants: PhotoVariant[];
  failure_code: "delivery_variants_failed" | null;
  active_attempt: number;
  replacement_attempt: number | null;
  replacement_status: "processing" | "failed" | null;
  replacement_ready_variants: PhotoVariant[];
  replacement_failure_code: "delivery_variants_failed" | null;
  version: number;
}

export interface PhotoReplacement {
  status: "processing" | "failed";
  ready_variants: PhotoVariant[];
  failure_code: "delivery_variants_failed" | null;
  retryable: boolean;
}

export interface AdminPhoto {
  photo_id: string;
  position: number;
  status: PhotoRow["status"];
  ready_variants: PhotoVariant[];
  failure_code: PhotoRow["failure_code"];
  retryable: boolean;
  replacement: PhotoReplacement | null;
  version: number;
}

export interface PhotoDependencies {
  storage?: MediaStorage;
  encoder?: PhotoEncoder;
  now?: () => Date;
  id?: () => string;
  photoId?: () => string;
}

export interface InitialPhotoUpload {
  site: Pick<AuthenticatedSite, "siteId">;
  artworkId: string;
  expectedArtworkVersion: number;
  source: Buffer;
  actor: Actor;
  dependencies?: PhotoDependencies;
}

export interface AcceptedPhoto {
  photo: AdminPhoto;
  artwork_version: number;
}

export interface ProcessingRun {
  claimed: number;
  completed: number;
  failed: number;
  source_cleanup_failures: number;
  has_more: boolean;
}

interface ArtworkVersionRow extends QueryResultRow {
  version: number;
}

interface JobRow extends QueryResultRow {
  id: string;
  site_id: string;
  artwork_id: string;
  photo_id: string;
  attempt_number: number;
  operation: "initial" | "retry" | "replacement";
  source_storage_key: string;
  status: "pending" | "processing" | "completed" | "failed";
  attempts: number;
  lease_fence: number;
  last_error: string | null;
}

interface StagingRow extends QueryResultRow {
  id: string;
  site_id: string;
  storage_key: string;
}

interface PhotoMediaCleanupRow extends QueryResultRow {
  id: string;
  site_id: string;
  photo_id: string | null;
  attempt_number: number | null;
  variant: PhotoVariant | null;
  storage_key: string;
  status: "pending" | "processing" | "completed";
  available_at: Date;
  lease_fence: number;
  attempts: number;
  last_error: string | null;
}

class PhotoLeaseLostError extends Error {
  constructor() {
    super("The Photo processing lease is no longer current.");
    this.name = "PhotoLeaseLostError";
  }
}

function safeNow(dependencies?: PhotoDependencies): Date {
  return dependencies?.now?.() ?? new Date();
}

function storageFor(dependencies?: PhotoDependencies): MediaStorage {
  return dependencies?.storage ?? defaultMediaStorage();
}

function encoderFor(dependencies?: PhotoDependencies): PhotoEncoder {
  return dependencies?.encoder ?? new SharpPhotoEncoder();
}

async function createDurableStagingRow(
  id: string,
  siteId: string,
  storageKey: string,
  byteSize: number,
  expiresAt: Date,
): Promise<void> {
  // This uses a committed connection before the object write. If the caller's
  // idempotency transaction later rolls back, cleanup still has an authoritative
  // row and does not need to discover the object by scanning storage.
  await getBusinessPool().query(
    `insert into hpos.photo_upload_staging (id, site_id, storage_key, byte_size, expires_at)
     values ($1, $2, $3, $4, $5)`,
    [id, siteId, storageKey, byteSize, expiresAt],
  );
}

interface PhotoMediaCleanupKey {
  storageKey: string;
  photoId?: string | null;
  attemptNumber?: number | null;
  variant?: PhotoVariant | null;
  availableAt?: Date;
}

async function queuePhotoMediaCleanup(
  client: PoolClient,
  siteId: string,
  keys: PhotoMediaCleanupKey[],
  now: Date,
): Promise<void> {
  for (const key of keys) {
    await client.query(
      `insert into hpos.photo_media_cleanup
       (id, site_id, photo_id, attempt_number, variant, storage_key, available_at, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       on conflict (storage_key) do update
         set available_at = excluded.available_at,
             status = 'pending',
             lease_expires_at = null,
             lease_fence = photo_media_cleanup.lease_fence
               + case when photo_media_cleanup.status = 'processing' then 1 else 0 end,
             last_error = null,
             updated_at = excluded.updated_at
       where photo_media_cleanup.status <> 'completed'
         and excluded.available_at < photo_media_cleanup.available_at`,
      [randomUUID(), siteId, key.photoId ?? null, key.attemptNumber ?? null, key.variant ?? null,
        key.storageKey, key.availableAt ?? now, now],
    );
  }
}

async function photoMediaKeysForPhoto(client: PoolClient, siteId: string, photoId: string): Promise<PhotoMediaCleanupKey[]> {
  const result = await client.query<{ storage_key: string; attempt_number: number | null; variant: PhotoVariant | null }>(
    `select source_storage_key as storage_key, null::integer as attempt_number, null::text as variant
       from hpos.photo_processing_jobs where site_id = $1 and photo_id = $2
     union all
     select storage_key, attempt_number, variant::text as variant
       from hpos.photo_variants where site_id = $1 and photo_id = $2`,
    [siteId, photoId],
  );
  return result.rows.map((row) => ({
    storageKey: row.storage_key,
    photoId,
    attemptNumber: row.attempt_number,
    variant: row.variant,
  }));
}

function opaquePhotoId(dependencies?: PhotoDependencies): string {
  return dependencies?.photoId?.() ?? `photo_${randomBytes(16).toString("base64url")}`;
}

function privateId(dependencies?: PhotoDependencies): string {
  return dependencies?.id?.() ?? randomUUID();
}

function fail(status: number, code: string, message: string, details: Array<{ field: string; code: string; message: string }> = []): never {
  throw new ApiOperationError(status, code, message, details);
}

function checkActor(actor: Actor): void {
  if ((actor.type !== "user" && actor.type !== "system") || !ACTOR_REFERENCE_PATTERN.test(actor.reference)) {
    fail(422, "validation_failed", "Include a user or system actor with a non-secret Site-local reference.", [
      { field: "actor", code: "invalid_actor", message: "Use a valid actor type and reference." },
    ]);
  }
}

function photoData(row: PhotoRow): AdminPhoto {
  return {
    photo_id: row.photo_id,
    position: row.position,
    status: row.status,
    ready_variants: [...(row.ready_variants ?? [])],
    failure_code: row.failure_code,
    retryable: row.failure_code === "delivery_variants_failed",
    replacement: row.replacement_status ? {
      status: row.replacement_status,
      ready_variants: [...(row.replacement_ready_variants ?? [])],
      failure_code: row.replacement_failure_code,
      retryable: row.replacement_failure_code === "delivery_variants_failed",
    } : null,
    version: row.version,
  };
}

function normalizePhotoRow(row: PhotoRow): PhotoRow {
  return {
    ...row,
    ready_variants: Array.isArray(row.ready_variants) ? row.ready_variants : [],
    replacement_ready_variants: Array.isArray(row.replacement_ready_variants) ? row.replacement_ready_variants : [],
  };
}

async function readPhotoRow(client: PoolClient, siteId: string, artworkId: string, photoId: string, lock = false): Promise<PhotoRow | null> {
  const result = await client.query<PhotoRow>(
    `select id, photo_id, site_id, artwork_id, position, is_hero, status, ready_variants, failure_code,
            active_attempt, replacement_attempt, replacement_status, replacement_ready_variants,
            replacement_failure_code, version
       from hpos.photos
      where site_id = $1 and artwork_id = $2 and photo_id = $3${lock ? " for update" : ""}`,
    [siteId, artworkId, photoId],
  );
  return result.rows[0] ? normalizePhotoRow(result.rows[0]) : null;
}

export async function listPhotos(client: PoolClient, site: Pick<AuthenticatedSite, "siteId">, artworkId: string): Promise<AdminPhoto[]> {
  const result = await client.query<PhotoRow>(
    `select id, photo_id, site_id, artwork_id, position, is_hero, status, ready_variants, failure_code,
            active_attempt, replacement_attempt, replacement_status, replacement_ready_variants,
            replacement_failure_code, version
       from hpos.photos
      where site_id = $1 and artwork_id = $2
      order by position asc, photo_id asc`,
    [site.siteId, artworkId],
  );
  return result.rows.map((row) => photoData(normalizePhotoRow(row)));
}

/**
 * Validate all image bytes before this function is called. It then performs
 * the Artwork version check, appends one Photo, stores the source, and queues
 * one durable processing job in the caller's existing transaction.
 */
export async function acceptInitialPhotoUpload(client: PoolClient, input: InitialPhotoUpload): Promise<AcceptedPhoto> {
  checkActor(input.actor);
  const dependencies = input.dependencies;
  const storage = storageFor(dependencies);
  const now = safeNow(dependencies);
  const artwork = await client.query<ArtworkVersionRow>(
    `select version from hpos.artworks where site_id = $1 and artwork_id = $2 for update`,
    [input.site.siteId, input.artworkId],
  );
  const currentArtwork = artwork.rows[0];
  if (!currentArtwork) fail(404, "not_found", "The Artwork is not available to this Site.");
  if (currentArtwork.version !== input.expectedArtworkVersion) {
    fail(409, "version_conflict", "The Artwork changed after you loaded it. Reload it before uploading a Photo.");
  }

  const position = await client.query<{ next_position: number }>(
    `select coalesce(max(position), 0) + 1 as next_position
       from hpos.photos
      where site_id = $1 and artwork_id = $2`,
    [input.site.siteId, input.artworkId],
  );
  const privatePhotoId = privateId(dependencies);
  const photoId = opaquePhotoId(dependencies);
  const attemptNumber = 1;
  const sourceKey = sourceStorageKey(input.site.siteId, input.artworkId, privatePhotoId, attemptNumber);
  const uploadId = privateId(dependencies);
  let sourceStored = false;
  try {
    await createDurableStagingRow(uploadId, input.site.siteId, sourceKey, input.source.byteLength, new Date(now.getTime() + ABANDONED_UPLOAD_TTL_MS));
    await storage.put(sourceKey, input.source);
    sourceStored = true;
    await client.query(
      `insert into hpos.photos (id, photo_id, site_id, artwork_id, position, status, ready_variants, version, created_at, updated_at)
       values ($1, $2, $3, $4, $5, 'processing', '{}', 1, $6, $6)`,
      [privatePhotoId, photoId, input.site.siteId, input.artworkId, position.rows[0]?.next_position ?? 1, now],
    );
    await client.query(
      `update hpos.artworks
          set version = version + 1,
              updated_at = $3,
              updated_actor_type = $4,
              updated_actor_reference = $5
        where site_id = $1 and artwork_id = $2`,
      [input.site.siteId, input.artworkId, now, input.actor.type, input.actor.reference],
    );
    await client.query(
      `insert into hpos.photo_processing_jobs
        (id, site_id, artwork_id, photo_id, attempt_number, operation, source_storage_key, status, available_at,
         created_at, updated_at, actor_type, actor_reference)
       values ($1, $2, $3, $4, 1, 'initial', $5, 'pending', $6, $6, $6, $7, $8)`,
      [privateId(dependencies), input.site.siteId, input.artworkId, privatePhotoId, sourceKey, now, input.actor.type, input.actor.reference],
    );
    // This row is finalized at acceptance. Incomplete multipart transfers can
    // use stagePhotoUpload before they have a complete source Buffer.
    await client.query(`update hpos.photo_upload_staging set finalized_at = $2 where id = $1`, [uploadId, now]);
  } catch (error) {
    if (sourceStored) await storage.remove(sourceKey).catch(() => undefined);
    throw error;
  }

  const created = await readPhotoRow(client, input.site.siteId, input.artworkId, photoId);
  if (!created) throw new Error("The accepted Photo could not be read before commit.");
  return { photo: photoData(created), artwork_version: currentArtwork.version + 1 };
}

export interface StagedUpload {
  upload_id: string;
  storage_key: string;
  expires_at: string;
}

/** Track a temporary multipart upload before the complete source is validated. */
export async function stagePhotoUpload(
  client: PoolClient,
  site: Pick<AuthenticatedSite, "siteId">,
  source: Buffer,
  dependencies?: PhotoDependencies,
): Promise<StagedUpload> {
  const id = privateId(dependencies);
  const now = safeNow(dependencies);
  const expires = new Date(now.getTime() + ABANDONED_UPLOAD_TTL_MS);
  const key = stagingStorageKey(site.siteId, id);
  await createDurableStagingRow(id, site.siteId, key, source.byteLength, expires);
  await storageFor(dependencies).put(key, source);
  await client.query(`update hpos.photo_upload_staging set finalized_at = $2 where id = $1`, [id, now]);
  return { upload_id: id, storage_key: key, expires_at: expires.toISOString() };
}

export async function validateAndAcceptInitialPhotoUpload(client: PoolClient, input: InitialPhotoUpload): Promise<AcceptedPhoto> {
  await validatePhotoSource(input.source, encoderFor(input.dependencies));
  return acceptInitialPhotoUpload(client, input);
}

interface PhotoAttemptUpload {
  site: Pick<AuthenticatedSite, "siteId">;
  artworkId: string;
  photoId: string;
  expectedPhotoVersion: number;
  source: Buffer;
  actor: Actor;
  operation: "retry" | "replacement";
  dependencies?: PhotoDependencies;
}

/**
 * Start a retry or replacement after the complete source has been validated.
 * Artwork is locked before Photo so this uses the same lock order as every
 * curation mutation and cannot deadlock with order, hero, or removal.
 */
export async function acceptPhotoAttempt(client: PoolClient, input: PhotoAttemptUpload): Promise<AcceptedPhoto> {
  checkActor(input.actor);
  const now = safeNow(input.dependencies);
  const storage = storageFor(input.dependencies);
  const artworkResult = await client.query<ArtworkVersionRow>(
    `select version from hpos.artworks where site_id = $1 and artwork_id = $2 for update`,
    [input.site.siteId, input.artworkId],
  );
  const artwork = artworkResult.rows[0];
  if (!artwork) fail(404, "not_found", "The Artwork is not available to this Site.");
  const photo = await readPhotoRow(client, input.site.siteId, input.artworkId, input.photoId, true);
  if (!photo) fail(404, "not_found", "The Photo is not available to this Site.");
  if (photo.version !== input.expectedPhotoVersion) {
    fail(409, "version_conflict", "The Photo changed after you loaded it. Reload it before uploading again.");
  }

  let operation = input.operation;
  if (input.operation === "replacement") {
    if (photo.status !== "ready" || photo.replacement_status !== null) {
      fail(409, "invalid_state", "A replacement can start only for a ready Photo without another replacement attempt.");
    }
  } else if (photo.status === "failed" && photo.replacement_status === null) {
    operation = "retry";
  } else if (photo.status === "ready" && photo.replacement_status === "failed") {
    operation = "replacement";
  } else {
    fail(409, "invalid_state", "Retry is available only for a failed initial Photo or a failed replacement.");
  }

  const attemptResult = await client.query<{ attempt_number: number | string }>(
    `select coalesce(max(attempt_number), 0) + 1 as attempt_number
       from hpos.photo_processing_jobs where site_id = $1 and photo_id = $2`,
    [input.site.siteId, photo.id],
  );
  const attemptNumber = Number(attemptResult.rows[0]?.attempt_number ?? 1);
  const sourceKey = sourceStorageKey(input.site.siteId, input.artworkId, photo.id, attemptNumber);
  const uploadId = privateId(input.dependencies);
  let sourceStored = false;
  try {
    await createDurableStagingRow(uploadId, input.site.siteId, sourceKey, input.source.byteLength, new Date(now.getTime() + ABANDONED_UPLOAD_TTL_MS));
    await storage.put(sourceKey, input.source);
    sourceStored = true;
    if (operation === "replacement") {
      await client.query(
        `update hpos.photos
            set replacement_attempt = $4, replacement_status = 'processing',
                replacement_ready_variants = '{}', replacement_failure_code = null,
                version = version + 1, updated_at = $5
          where id = $1 and site_id = $2 and version = $3`,
        [photo.id, input.site.siteId, input.expectedPhotoVersion, attemptNumber, now],
      );
    } else {
      await client.query(
        `update hpos.photos
            set status = 'processing', active_attempt = $4, ready_variants = '{}',
                failure_code = null, version = version + 1, updated_at = $5
          where id = $1 and site_id = $2 and version = $3`,
        [photo.id, input.site.siteId, input.expectedPhotoVersion, attemptNumber, now],
      );
    }
    await client.query(
      `insert into hpos.photo_processing_jobs
        (id, site_id, artwork_id, photo_id, attempt_number, operation, source_storage_key, status, available_at,
         created_at, updated_at, actor_type, actor_reference)
       values ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $8, $8, $9, $10)`,
      [privateId(input.dependencies), input.site.siteId, input.artworkId, photo.id, attemptNumber, operation, sourceKey, now, input.actor.type, input.actor.reference],
    );
    await client.query(`update hpos.photo_upload_staging set finalized_at = $2 where id = $1`, [uploadId, now]);
  } catch (error) {
    if (sourceStored) await storage.remove(sourceKey).catch(() => undefined);
    throw error;
  }
  const updated = await readPhotoRow(client, input.site.siteId, input.artworkId, input.photoId);
  if (!updated) throw new Error("The accepted Photo attempt could not be read before commit.");
  return { photo: photoData(updated), artwork_version: artwork.version };
}

interface ClaimedJob {
  job: JobRow;
  leaseExpiresAt: Date;
}

async function claimNextJob(pool: Pool, now: Date, siteId?: string): Promise<ClaimedJob | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await client.query<JobRow>(
      `select id, site_id, artwork_id, photo_id, attempt_number, operation, source_storage_key, status, attempts, lease_fence, last_error
         from hpos.photo_processing_jobs
        where ((status = 'pending' and available_at <= $1)
           or (status = 'processing' and lease_expires_at <= $1))
          and ($2::uuid is null or site_id = $2)
        order by created_at asc, id asc
        for update skip locked
        limit 1`,
      [now, siteId ?? null],
    );
    const job = result.rows[0];
    if (!job) {
      await client.query("commit");
      return null;
    }
    const leaseExpiresAt = new Date(now.getTime() + PROCESSING_LEASE_MS);
    const lease = await client.query<{ lease_fence: number | string }>(
      `update hpos.photo_processing_jobs
          set status = 'processing', attempts = attempts + 1, lease_fence = lease_fence + 1,
              lease_expires_at = $2, updated_at = $2
        where id = $1
        returning lease_fence`,
      [job.id, leaseExpiresAt],
    );
    if (lease.rowCount !== 1) throw new Error("The Photo processing lease could not be claimed.");
    await client.query("commit");
    return {
      job: {
        ...job,
        status: "processing",
        attempts: job.attempts + 1,
        lease_fence: Number(lease.rows[0].lease_fence),
      },
      leaseExpiresAt,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function markSourceDeleted(pool: Pool, job: JobRow, now: Date, errorMessage: string | null): Promise<boolean> {
  if (errorMessage === null) {
    const result = await pool.query(
      `update hpos.photo_processing_jobs
          set source_deleted_at = $2, source_delete_error = null, updated_at = $2
        where id = $1 and lease_fence = $3 and status in ('completed', 'failed')`,
      [job.id, now, job.lease_fence],
    );
    return result.rowCount === 1;
  }
  const result = await pool.query(
    `update hpos.photo_processing_jobs
        set source_delete_error = $2, updated_at = $3
      where id = $1 and lease_fence = $4 and status in ('completed', 'failed')`,
    [job.id, errorMessage, now, job.lease_fence],
  );
  return result.rowCount === 1;
}

async function cleanupSource(pool: Pool, job: JobRow, storage: MediaStorage, now: Date): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const current = await client.query<{ lease_fence: number | string; source_deleted_at: Date | null }>(
      `select lease_fence, source_deleted_at
         from hpos.photo_processing_jobs
        where id = $1 and lease_fence = $2 and status in ('completed', 'failed')
        for update`,
      [job.id, job.lease_fence],
    );
    if (current.rowCount !== 1) {
      await client.query("rollback");
      return false;
    }
    if (current.rows[0].source_deleted_at !== null) {
      await client.query("commit");
      return true;
    }
    await storage.remove(job.source_storage_key);
    const marked = await client.query(
      `update hpos.photo_processing_jobs
          set source_deleted_at = $2, source_delete_error = null, updated_at = $2
        where id = $1 and lease_fence = $3 and status in ('completed', 'failed')`,
      [job.id, now, job.lease_fence],
    );
    if (marked.rowCount !== 1) throw new PhotoLeaseLostError();
    await client.query(`delete from hpos.photo_upload_staging where storage_key = $1`, [job.source_storage_key]);
    await client.query("commit");
    return true;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    const message = error instanceof Error ? error.message.slice(0, 500) : "source cleanup failed";
    await markSourceDeleted(pool, job, now, message).catch(() => false);
    return false;
  } finally {
    client.release();
  }
}

/**
 * Remove source or staging objects left by a transaction that stored bytes and
 * then rolled back before it could commit a database reference. The object
 * timestamp supplies the same 24-hour safety window as staging rows.
 */
async function cleanupUnreferencedPhotoObjects(
  pool: Pool,
  storage: MediaStorage,
  now: Date,
): Promise<{ removed: number; failures: number }> {
  const cutoff = now.getTime() - ABANDONED_UPLOAD_TTL_MS;
  let removed = 0;
  let failures = 0;
  for (const prefix of ["sites", "staging"]) {
    const cursorRow = await pool.query<{ cursor: string | null }>(
      `select cursor from hpos.photo_storage_cleanup_cursors where prefix = $1`,
      [prefix],
    );
    const cursor = cursorRow.rows[0]?.cursor ?? null;
    let page: { objects: Array<{ key: string; modifiedAt: Date }>; cursor: string | null };
    try {
      page = await storage.list(prefix, MAX_ORPHAN_OBJECTS_PER_PREFIX, cursor);
    } catch {
      failures += 1;
      continue;
    }
    const keys = page.objects.map((object) => object.key);
    const references = keys.length === 0
      ? { rows: [] as Array<{ storage_key: string; is_referenced: boolean }> }
      : await pool.query<{ storage_key: string; is_referenced: boolean }>(
        `select candidate.storage_key,
                exists(select 1 from hpos.photo_processing_jobs job where job.source_storage_key = candidate.storage_key)
                or exists(select 1 from hpos.photo_upload_staging staging
                           where staging.storage_key = candidate.storage_key
                             and staging.finalized_at is null and staging.expires_at > $2)
                or exists(select 1 from hpos.photo_variants variant where variant.storage_key = candidate.storage_key)
                  as is_referenced
           from unnest($1::text[]) as candidate(storage_key)`,
        [keys, now],
      );
    const referenced = new Set(references.rows.filter((row) => row.is_referenced).map((row) => row.storage_key));
    for (const object of page.objects) {
      if (referenced.has(object.key) || object.modifiedAt.getTime() > cutoff) continue;
      try {
        await storage.remove(object.key);
        removed += 1;
      } catch {
        failures += 1;
      }
    }
    await pool.query(
      `insert into hpos.photo_storage_cleanup_cursors (prefix, cursor, updated_at)
       values ($1, $2, $3)
       on conflict (prefix) do update set cursor = excluded.cursor, updated_at = excluded.updated_at`,
      [prefix, page.cursor, now],
    );
  }
  return { removed, failures };
}

/** Delete worker outputs only while holding the same job lease row lock. */
async function removeVariantKeysIfCurrent(pool: Pool, job: JobRow, storage: MediaStorage, keys: string[]): Promise<boolean> {
  if (keys.length === 0) return true;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const current = await client.query(
      `select 1 from hpos.photo_processing_jobs
        where id = $1 and status = 'processing' and lease_fence = $2
        for update`,
      [job.id, job.lease_fence],
    );
    if (current.rowCount !== 1) {
      await client.query("rollback");
      return false;
    }
    await Promise.all(keys.map((key) => storage.remove(key)));
    await client.query("commit");
    return true;
  } catch {
    await client.query("rollback").catch(() => undefined);
    return false;
  } finally {
    client.release();
  }
}

async function renewPhotoLease(pool: Pool, job: JobRow, now: Date): Promise<boolean> {
  const result = await pool.query(
    `update hpos.photo_processing_jobs
        set lease_expires_at = $2, updated_at = $1
      where id = $3 and status = 'processing' and lease_fence = $4`,
    [now, new Date(now.getTime() + PROCESSING_LEASE_MS), job.id, job.lease_fence],
  );
  return result.rowCount === 1;
}

function startPhotoLeaseHeartbeat(pool: Pool, job: JobRow): { stop: () => Promise<void>; lost: () => boolean } {
  let leaseLost = false;
  let inFlight: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (inFlight || leaseLost) return;
    inFlight = renewPhotoLease(pool, job, new Date())
      .then((current) => { if (!current) leaseLost = true; })
      .catch(() => { leaseLost = true; })
      .finally(() => { inFlight = null; });
  }, Math.max(1_000, Math.floor(PROCESSING_LEASE_MS / 3)));
  timer.unref?.();
  return {
    lost: () => leaseLost,
    stop: async () => {
      clearInterval(timer);
      if (inFlight) await inFlight;
    },
  };
}

async function completeJob(
  pool: Pool,
  job: JobRow,
  source: Buffer,
  dependencies: PhotoDependencies,
): Promise<{ completed: boolean; sourceCleanupSucceeded: boolean; leaseLost: boolean }> {
  const storage = storageFor(dependencies);
  const encoder = encoderFor(dependencies);
  const now = safeNow(dependencies);
  const encoded: Array<{ variant: PhotoVariant; bytes: Buffer; width: number; height: number }> = [];
  const writtenKeys: string[] = [];
  const failureCode = (error: unknown) => error instanceof PhotoMediaError ? error.code : "delivery_variants_failed";

  const finishFailure = async (error: unknown): Promise<{ completed: boolean; sourceCleanupSucceeded: boolean; leaseLost: boolean }> => {
    await removeVariantKeysIfCurrent(pool, job, storage, writtenKeys);
    const client = await pool.connect();
    try {
      await client.query("begin");
      await queuePhotoMediaCleanup(client, job.site_id, writtenKeys.map((storageKey) => ({
        storageKey,
        photoId: job.photo_id,
        attemptNumber: job.attempt_number,
      })), now);
      const state = job.operation === "replacement"
        ? await client.query(
          `update hpos.photos
              set replacement_status = 'failed', replacement_ready_variants = '{}',
                  replacement_failure_code = 'delivery_variants_failed', version = version + 1, updated_at = $5
            where id = $1 and site_id = $2 and replacement_attempt = $6
              and exists (
                select 1 from hpos.photo_processing_jobs
                 where id = $3 and status = 'processing' and lease_fence = $4
              )`,
          [job.photo_id, job.site_id, job.id, job.lease_fence, now, job.attempt_number],
        )
        : await client.query(
          `update hpos.photos
              set status = 'failed', ready_variants = '{}', failure_code = 'delivery_variants_failed', version = version + 1, updated_at = $5
            where id = $1 and site_id = $2
              and exists (
                select 1 from hpos.photo_processing_jobs
                 where id = $3 and status = 'processing' and lease_fence = $4
              )`,
          [job.photo_id, job.site_id, job.id, job.lease_fence, now],
        );
      if (state.rowCount !== 1) throw new PhotoLeaseLostError();
      await client.query(
        `delete from hpos.photo_variants
          where photo_id = $1 and site_id = $2 and attempt_number = $3
            and exists (
              select 1 from hpos.photo_processing_jobs
               where id = $4 and status = 'processing' and lease_fence = $5
            )`,
        [job.photo_id, job.site_id, job.attempt_number, job.id, job.lease_fence],
      );
      const failedJob = await client.query(
        `update hpos.photo_processing_jobs
            set status = 'failed', lease_expires_at = null, last_error = $2, updated_at = $3
          where id = $1 and status = 'processing' and lease_fence = $4`,
        [job.id, failureCode(error), now, job.lease_fence],
      );
      if (failedJob.rowCount !== 1) throw new PhotoLeaseLostError();
      await client.query("commit");
    } catch (dbError) {
      await client.query("rollback").catch(() => undefined);
      if (dbError instanceof PhotoLeaseLostError) {
        return { completed: false, sourceCleanupSucceeded: false, leaseLost: true };
      }
      throw dbError;
    } finally {
      client.release();
    }
    return { completed: false, sourceCleanupSucceeded: await cleanupSource(pool, job, storage, now), leaseLost: false };
  };

  try {
    for (const variant of Object.keys(PHOTO_VARIANTS) as PhotoVariant[]) {
      if (!await renewPhotoLease(pool, job, safeNow(dependencies))) throw new PhotoLeaseLostError();
      const output = await encoder.encode(source, variant);
      if (!await renewPhotoLease(pool, job, safeNow(dependencies))) throw new PhotoLeaseLostError();
      const key = variantStorageKey(job.site_id, job.artwork_id, job.photo_id, job.attempt_number, variant, job.lease_fence);
      await storage.put(key, output.bytes);
      if (!await renewPhotoLease(pool, job, safeNow(dependencies))) throw new PhotoLeaseLostError();
      writtenKeys.push(key);
      encoded.push({ variant, bytes: output.bytes, width: output.width, height: output.height });
    }
  } catch (error) {
    return finishFailure(error);
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const values: unknown[] = [];
    const rows = encoded.map((item) => {
      const offset = values.length;
      values.push(job.photo_id, job.site_id, job.attempt_number, item.variant,
        variantStorageKey(job.site_id, job.artwork_id, job.photo_id, job.attempt_number, item.variant, job.lease_fence),
        item.width, item.height, item.bytes.byteLength, mediaSha256(item.bytes), now);
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10})`;
    }).join(", ");
    await client.query(
      `insert into hpos.photo_variants
         (photo_id, site_id, attempt_number, variant, storage_key, width, height, byte_size, sha256, created_at)
       values ${rows}
       on conflict (photo_id, attempt_number, variant) do update set storage_key = excluded.storage_key,
         width = excluded.width, height = excluded.height, byte_size = excluded.byte_size,
         sha256 = excluded.sha256, created_at = excluded.created_at`,
      values,
    );

    if (job.operation === "replacement") {
      const active = await client.query<{ active_attempt: number }>(
        `select active_attempt from hpos.photos
          where id = $1 and site_id = $2 and replacement_attempt = $3 and replacement_status = 'processing'
            and exists (
              select 1 from hpos.photo_processing_jobs
               where id = $4 and status = 'processing' and lease_fence = $5
            )
          for update`,
        [job.photo_id, job.site_id, job.attempt_number, job.id, job.lease_fence],
      );
      if (active.rowCount !== 1) throw new PhotoLeaseLostError();
      const retired = await client.query<{ storage_key: string; attempt_number: number; variant: PhotoVariant }>(
        `select storage_key, attempt_number, variant::text as variant
           from hpos.photo_variants where photo_id = $1 and site_id = $2 and attempt_number = $3`,
        [job.photo_id, job.site_id, active.rows[0].active_attempt],
      );
      await queuePhotoMediaCleanup(client, job.site_id, retired.rows.map((row) => ({
        storageKey: row.storage_key,
        photoId: job.photo_id,
        attemptNumber: row.attempt_number,
        variant: row.variant,
        availableAt: new Date(now.getTime() + PHOTO_VARIANT_RETIRE_GRACE_MS),
      })), now);
    }
    const photo = job.operation === "replacement"
      ? await client.query(
        `update hpos.photos
            set status = 'ready', active_attempt = $6, ready_variants = array['grid_400', 'artwork_1600']::text[],
                failure_code = null, replacement_attempt = null, replacement_status = null,
                replacement_ready_variants = '{}', replacement_failure_code = null,
                version = version + 1, updated_at = $5
          where id = $1 and site_id = $2 and replacement_attempt = $6 and replacement_status = 'processing'
            and exists (
              select 1 from hpos.photo_processing_jobs
               where id = $3 and status = 'processing' and lease_fence = $4
            )`,
        [job.photo_id, job.site_id, job.id, job.lease_fence, now, job.attempt_number],
      )
      : await client.query(
        `update hpos.photos
            set status = 'ready', active_attempt = $6, ready_variants = array['grid_400', 'artwork_1600']::text[],
                failure_code = null, version = version + 1, updated_at = $5
          where id = $1 and site_id = $2
            and exists (
              select 1 from hpos.photo_processing_jobs
               where id = $3 and status = 'processing' and lease_fence = $4
            )`,
        [job.photo_id, job.site_id, job.id, job.lease_fence, now, job.attempt_number],
      );
    if (photo.rowCount !== 1) throw new PhotoLeaseLostError();
    const completedJob = await client.query(
      `update hpos.photo_processing_jobs
          set status = 'completed', lease_expires_at = null, last_error = null, updated_at = $2
        where id = $1 and status = 'processing' and lease_fence = $3`,
      [job.id, now, job.lease_fence],
    );
    if (completedJob.rowCount !== 1) throw new PhotoLeaseLostError();
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    await removeVariantKeysIfCurrent(pool, job, storage, writtenKeys);
    if (error instanceof PhotoLeaseLostError) {
      return { completed: false, sourceCleanupSucceeded: false, leaseLost: true };
    }
    throw error;
  } finally {
    client.release();
  }
  return { completed: true, sourceCleanupSucceeded: await cleanupSource(pool, job, storage, now), leaseLost: false };
}

export async function processPhotoJobs(options: {
  pool?: Pool;
  limit?: number;
  siteId?: string;
  dependencies?: PhotoDependencies;
} = {}): Promise<ProcessingRun> {
  const pool = options.pool ?? getBusinessPool();
  const dependencies = options.dependencies ?? {};
  const limit = Math.min(Math.max(options.limit ?? MAX_PHOTO_PROCESSING_BATCH, 1), MAX_PHOTO_PROCESSING_BATCH);
  const run: ProcessingRun = { claimed: 0, completed: 0, failed: 0, source_cleanup_failures: 0, has_more: false };
  for (let index = 0; index < limit; index += 1) {
    const now = safeNow(dependencies);
    const claimed = await claimNextJob(pool, now, options.siteId);
    if (!claimed) break;
    run.claimed += 1;
    const heartbeat = startPhotoLeaseHeartbeat(pool, claimed.job);
    let source: Buffer;
    let outcome: Awaited<ReturnType<typeof completeJob>>;
    try {
      try {
        source = await storageFor(dependencies).get(claimed.job.source_storage_key);
      } catch {
        source = Buffer.alloc(0);
      }
      outcome = await completeJob(pool, claimed.job, source, dependencies);
    } finally {
      await heartbeat.stop();
    }
    // Completion/failure remains lease-fenced. This check makes the heartbeat
    // state explicit for a source read or encoder that outlives its lease.
    if (heartbeat.lost() && !outcome.leaseLost) continue;
    if (outcome.leaseLost) continue;
    if (outcome.completed) run.completed += 1;
    else run.failed += 1;
    if (!outcome.sourceCleanupSucceeded) run.source_cleanup_failures += 1;
  }
  const mediaCleanup = await cleanupQueuedPhotoMedia({ pool, limit, siteId: options.siteId, dependencies });
  const more = await pool.query<{ has_more: boolean }>(
    `select exists(
             select 1 from hpos.photo_processing_jobs
             where ((status = 'pending' and available_at <= $1)
                or (status = 'processing' and lease_expires_at <= $1))
               and ($2::uuid is null or site_id = $2)
           ) as has_more`,
    [safeNow(dependencies), options.siteId ?? null],
  );
  run.has_more = Boolean(more.rows[0]?.has_more) || mediaCleanup.has_more || mediaCleanup.failures > 0;
  return run;
}

/** Delete incomplete multipart staging rows after their 24-hour deadline. */
export async function cleanupAbandonedPhotoUploads(options: {
  pool?: Pool;
  dependencies?: PhotoDependencies;
} = {}): Promise<{ removed: number; failures: number }> {
  const pool = options.pool ?? getBusinessPool();
  const now = safeNow(options.dependencies);
  const storage = storageFor(options.dependencies);
  let removed = 0;
  let failures = 0;
  for (let index = 0; index < MAX_PHOTO_PROCESSING_BATCH; index += 1) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await client.query<StagingRow>(
        `select id, site_id, storage_key
           from hpos.photo_upload_staging
          where finalized_at is null and expires_at <= $1
          order by expires_at asc, id asc
          for update skip locked
          limit 1`,
        [now],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query("commit");
        break;
      }
      await storage.remove(row.storage_key);
      await client.query(`delete from hpos.photo_upload_staging where id = $1 and site_id = $2`, [row.id, row.site_id]);
      await client.query("commit");
      removed += 1;
    } catch {
      await client.query("rollback").catch(() => undefined);
      failures += 1;
      break;
    } finally {
      client.release();
    }
  }
  const orphaned = await cleanupUnreferencedPhotoObjects(pool, storage, now);
  return { removed: removed + orphaned.removed, failures: failures + orphaned.failures };
}

/** Retry deletion for accepted sources whose worker transaction already ended. */
export async function cleanupCompletedPhotoSources(options: {
  pool?: Pool;
  dependencies?: PhotoDependencies;
} = {}): Promise<{ removed: number; failures: number }> {
  const pool = options.pool ?? getBusinessPool();
  const now = safeNow(options.dependencies);
  const result = await pool.query<JobRow>(
    `select id, site_id, artwork_id, photo_id, attempt_number, operation, source_storage_key, status, attempts, lease_fence, last_error
       from hpos.photo_processing_jobs
      where status in ('completed', 'failed') and source_deleted_at is null
      order by updated_at asc, id asc
      limit $1`,
    [MAX_PHOTO_PROCESSING_BATCH],
  );
  if (result.rowCount === 0) return { removed: 0, failures: 0 };
  const storage = storageFor(options.dependencies);
  let removed = 0;
  let failures = 0;
  for (const job of result.rows) {
    if (await cleanupSource(pool, job, storage, now)) removed += 1;
    else failures += 1;
  }
  return { removed, failures };
}

async function claimPhotoMediaCleanup(pool: Pool, now: Date, siteId?: string): Promise<PhotoMediaCleanupRow | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await client.query<PhotoMediaCleanupRow>(
        `select id, site_id, photo_id, attempt_number, variant::text as variant, storage_key, status,
              available_at, lease_fence, attempts, last_error
         from hpos.photo_media_cleanup
        where ((status = 'pending' and available_at <= $1)
           or (status = 'processing' and lease_expires_at <= $1))
          and ($2::uuid is null or site_id = $2)
        order by available_at asc, created_at asc, id asc
        for update skip locked
        limit 1`,
      [now, siteId ?? null],
    );
    const row = result.rows[0];
    if (!row) {
      await client.query("commit");
      return null;
    }
    const leaseExpiresAt = new Date(now.getTime() + PROCESSING_LEASE_MS);
    const leased = await client.query<{ lease_fence: number | string }>(
      `update hpos.photo_media_cleanup
          set status = 'processing', attempts = attempts + 1, lease_fence = lease_fence + 1,
              lease_expires_at = $2, updated_at = $2
        where id = $1
        returning lease_fence`,
      [row.id, leaseExpiresAt],
    );
    if (leased.rowCount !== 1) throw new Error("The Photo media cleanup lease could not be claimed.");
    await client.query("commit");
    return { ...row, status: "processing", attempts: row.attempts + 1, lease_fence: Number(leased.rows[0].lease_fence) };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function cleanupQueuedPhotoMedia(options: {
  pool?: Pool;
  limit?: number;
  siteId?: string;
  dependencies?: PhotoDependencies;
} = {}): Promise<{ removed: number; failures: number; has_more: boolean }> {
  const pool = options.pool ?? getBusinessPool();
  const dependencies = options.dependencies ?? {};
  const limit = Math.min(Math.max(options.limit ?? MAX_PHOTO_PROCESSING_BATCH, 1), MAX_PHOTO_PROCESSING_BATCH);
  const available = await pool.query<{ has_work: boolean }>(
    `select exists(
             select 1 from hpos.photo_media_cleanup
              where ((status = 'pending' and available_at <= $1)
                 or (status = 'processing' and lease_expires_at <= $1))
                and ($2::uuid is null or site_id = $2)
           ) as has_work`,
    [safeNow(dependencies), options.siteId ?? null],
  );
  if (!available.rows[0]?.has_work) return { removed: 0, failures: 0, has_more: false };
  const storage = storageFor(dependencies);
  let removed = 0;
  let failures = 0;
  for (let index = 0; index < limit; index += 1) {
    const now = safeNow(dependencies);
    const row = await claimPhotoMediaCleanup(pool, now, options.siteId);
    if (!row) break;
    try {
      await storage.remove(row.storage_key);
      const client = await pool.connect();
      try {
        await client.query("begin");
        const completed = await client.query(
          `update hpos.photo_media_cleanup
              set status = 'completed', lease_expires_at = null, last_error = null, updated_at = $2
            where id = $1 and status = 'processing' and lease_fence = $3`,
          [row.id, now, row.lease_fence],
        );
        if (completed.rowCount !== 1) throw new PhotoLeaseLostError();
        if (row.photo_id !== null && row.attempt_number !== null && row.variant !== null) {
          await client.query(
            `delete from hpos.photo_variants
              where photo_id = $1 and site_id = $2 and attempt_number = $3 and variant = $4
                and not exists (
                  select 1 from hpos.photos
                   where id = $1 and site_id = $2 and active_attempt = $3
                )`,
            [row.photo_id, row.site_id, row.attempt_number, row.variant],
          );
        }
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      removed += 1;
    } catch (error) {
      failures += 1;
      const message = error instanceof Error ? error.message.slice(0, 500) : "media cleanup failed";
      await pool.query(
        `update hpos.photo_media_cleanup
            set status = 'pending', lease_expires_at = null,
                available_at = $2, last_error = $3, updated_at = $2
          where id = $1 and status = 'processing' and lease_fence = $4`,
        [row.id, new Date(now.getTime() + Math.min(60 * 60 * 1000, 1_000 * 2 ** Math.min(row.attempts, 8))), message, row.lease_fence],
      );
    }
  }
  const more = await pool.query<{ has_more: boolean }>(
    `select exists(
             select 1 from hpos.photo_media_cleanup
             where ((status = 'pending' and available_at <= $1)
                or (status = 'processing' and lease_expires_at <= $1))
               and ($2::uuid is null or site_id = $2)
           ) as has_more`,
    [safeNow(dependencies), options.siteId ?? null],
  );
  return { removed, failures, has_more: Boolean(more.rows[0]?.has_more) };
}

export async function photoCleanupHasMore(options: { pool?: Pool; now?: Date } = {}): Promise<boolean> {
  const pool = options.pool ?? getBusinessPool();
  const now = options.now ?? new Date();
  const result = await pool.query<{ has_more: boolean }>(
    `select exists(
             select 1 from hpos.photo_upload_staging
              where finalized_at is null and expires_at <= $1
           ) or exists(
             select 1 from hpos.photo_processing_jobs
              where status in ('completed', 'failed') and source_deleted_at is null
           ) or exists(
             select 1 from hpos.photo_media_cleanup
              where (status = 'pending' and available_at <= $1)
                 or (status = 'processing' and lease_expires_at <= $1)
           ) or exists(
             select 1 from hpos.photo_storage_cleanup_cursors
              where cursor is not null
           ) as has_more`,
    [now],
  );
  return Boolean(result.rows[0]?.has_more);
}

export function photoUploadFingerprint(source: Buffer, metadata: unknown): Record<string, unknown> {
  return { metadata, bytes_sha256: mediaSha256(source), byte_size: source.byteLength };
}

export function photoMediaErrorResponse(error: unknown): { status: number; code: string; message: string } | null {
  if (!(error instanceof PhotoMediaError)) return null;
  return { status: error.status, code: error.code, message: error.message };
}

function fieldError(field: string, code: string, message: string): Response {
  return apiFailure(422, "validation_failed", message, {
    details: [{ field, code, message }],
  });
}

function photoListLimit(value: string | null): number | Response {
  if (value === null) return 50;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) {
    return fieldError("limit", "out_of_range", "limit must be an integer from 1 to 100.");
  }
  return Number(value);
}

function photoCursorFor(site: AuthenticatedSite, scope: string, position: number, photoId: string): string {
  const payload = Buffer.from(JSON.stringify({
    mode: "admin_photos",
    siteId: site.siteId,
    scope,
    issuedAt: new Date().toISOString(),
    position,
    id: photoId,
  }), "utf8").toString("base64url");
  return `${payload}.${createHmac("sha256", site.cursorSigningKey).update(payload).digest("base64url")}`;
}

function parsePhotoCursor(value: string | null, site: AuthenticatedSite, scope: string): { position: number; photoId: string } | null | Response {
  if (value === null) return null;
  try {
    const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(value);
    if (!match || value.length > 2048) throw new Error();
    const [, payload, signature] = match;
    const expected = createHmac("sha256", site.cursorSigningKey).update(payload).digest();
    const supplied = Buffer.from(signature, "base64url");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error();
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    if (decoded.mode !== "admin_photos" || decoded.siteId !== site.siteId || decoded.scope !== scope
      || typeof decoded.issuedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(decoded.issuedAt)
      || !Number.isSafeInteger(decoded.position) || Number(decoded.position) < 1
      || typeof decoded.id !== "string" || !PHOTO_ID_PATTERN.test(decoded.id)) throw new Error();
    const issuedAt = Date.parse(decoded.issuedAt);
    if (!Number.isFinite(issuedAt) || issuedAt < Date.now() - 60 * 60 * 1000 || issuedAt > Date.now() + 60_000) throw new Error();
    return { position: Number(decoded.position), photoId: decoded.id };
  } catch {
    return apiFailure(422, "invalid_cursor", "The cursor is invalid for this Photo list.");
  }
}

async function listPhotoPage(client: PoolClient, request: Request, site: AuthenticatedSite, artworkId: string): Promise<Response> {
  const url = new URL(request.url);
  for (const name of url.searchParams.keys()) {
    if (name !== "limit" && name !== "cursor") return fieldError(name, "unknown_filter", "Remove the unsupported Photo list parameter.");
  }
  const limit = photoListLimit(url.searchParams.get("limit"));
  if (limit instanceof Response) return limit;
  const scope = JSON.stringify({ artwork_id: artworkId, limit });
  const cursor = parsePhotoCursor(url.searchParams.get("cursor"), site, scope);
  if (cursor instanceof Response) return cursor;
  const values: unknown[] = [site.siteId, artworkId];
  let after = "";
  if (cursor) {
    values.push(cursor.position, cursor.photoId);
    after = ` and (position > $3 or (position = $3 and photo_id > $4))`;
  }
  values.push(limit + 1);
  const result = await client.query<PhotoRow>(
    `select id, photo_id, site_id, artwork_id, position, is_hero, status, ready_variants, failure_code,
            active_attempt, replacement_attempt, replacement_status, replacement_ready_variants,
            replacement_failure_code, version
       from hpos.photos
      where site_id = $1 and artwork_id = $2${after}
      order by position asc, photo_id asc
      limit $${values.length}`,
    values,
  );
  const rows = result.rows.slice(0, limit).map((row) => normalizePhotoRow(row));
  const last = rows.at(-1);
  const nextCursor = result.rows.length > limit && last ? photoCursorFor(site, scope, last.position, last.photo_id) : null;
  return apiSuccess(rows.map(photoData), 200, { nextCursor });
}

function actorFrom(value: unknown): Actor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !["type", "reference"].includes(key))) return null;
  if ((row.type !== "user" && row.type !== "system") || typeof row.reference !== "string") return null;
  const reference = row.reference.trim();
  return ACTOR_REFERENCE_PATTERN.test(reference) ? { type: row.type, reference } : null;
}

function mapPhotoDatabaseError(error: unknown): Response | null {
  if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "55P03") {
    return apiFailure(409, "request_in_progress", "The Photo operation is still processing; retry with the same key after a short delay.", { retryAfter: 1 });
  }
  return null;
}

/** Read only enough of a cloned body to enforce the multipart byte ceiling. */
async function measureRequestBody(request: Request, maximum: number): Promise<number | null> {
  try {
    const clone = request.clone();
    if (!clone.body) return 0;
    const reader = clone.body.getReader();
    let total = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) return total;
        total += chunk.value.byteLength;
        if (total > maximum) {
          await reader.cancel();
          return total;
        }
      }
    } finally {
      reader.releaseLock();
    }
  } catch {
    return null;
  }
}

async function readMultipartPhoto(request: Request): Promise<{ source: Buffer; metadataRaw: string; fingerprint: Record<string, unknown> } | Response> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "multipart/form-data") return apiFailure(415, "unsupported_media_type", "Upload a Photo as multipart/form-data.");
  const contentLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isSafeInteger(contentLength) && contentLength > MAX_PHOTO_BYTES + MAX_MULTIPART_OVERHEAD_BYTES) {
    return apiFailure(413, "request_too_large", "The multipart request exceeds the 50 MiB image plus 64 KiB envelope limit.");
  }
  const measuredLength = await measureRequestBody(request, MAX_PHOTO_BYTES + MAX_MULTIPART_OVERHEAD_BYTES);
  if (measuredLength === null && !Number.isSafeInteger(contentLength)) {
    return apiFailure(400, "invalid_request", "The multipart body length could not be verified.");
  }
  if (measuredLength !== null && measuredLength > MAX_PHOTO_BYTES + MAX_MULTIPART_OVERHEAD_BYTES) {
    return apiFailure(413, "request_too_large", "The multipart request exceeds the 50 MiB image plus 64 KiB envelope limit.");
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return apiFailure(400, "invalid_request", "The multipart body could not be read completely.");
  }
  let file: File | null = null;
  let metadataText: string | null = null;
  let fileCount = 0;
  let metadataCount = 0;
  for (const [name, value] of form.entries()) {
    if (name === "file" && value instanceof File) {
      fileCount += 1;
      file = value;
    } else if (name === "metadata" && (typeof value === "string" || value instanceof File)) {
      metadataCount += 1;
      metadataText = typeof value === "string" ? value : await value.text();
    } else {
      return fieldError(name, "unexpected_part", "Provide exactly one binary file part and one JSON metadata part.");
    }
  }
  if (fileCount !== 1 || metadataCount !== 1 || !file || metadataText === null) {
    return fieldError("multipart", "parts_required", "Provide exactly one file part and one metadata part.");
  }
  if (file.size > MAX_PHOTO_BYTES) return apiFailure(413, "request_too_large", "The image exceeds the 50 MiB limit.");
  let source: Buffer;
  try { source = Buffer.from(await file.arrayBuffer()); }
  catch { return apiFailure(400, "invalid_request", "The image upload did not complete."); }
  const bodyLength = measuredLength ?? (Number.isSafeInteger(contentLength) ? contentLength : null);
  if (bodyLength !== null && bodyLength - source.byteLength > MAX_MULTIPART_OVERHEAD_BYTES) {
    return apiFailure(413, "request_too_large", "The multipart envelope exceeds the 64 KiB limit.");
  }
  // Canonicalize valid JSON so insignificant whitespace/key-order changes
  // replay the same operation. Malformed JSON keeps its raw text so a changed
  // malformed replay still reaches idempotency_conflict before validation.
  let metadataFingerprint: unknown = { metadata_raw: metadataText };
  try { metadataFingerprint = JSON.parse(metadataText); } catch { /* retain raw malformed text */ }
  const fingerprint = photoUploadFingerprint(source, { metadata: metadataFingerprint });
  return { source, metadataRaw: metadataText, fingerprint };
}

function parsePhotoUploadMetadata(metadataRaw: string): { expected_version: number; actor: Actor } {
  let value: unknown;
  try { value = JSON.parse(metadataRaw); }
  catch { throw new ApiOperationError(422, "validation_failed", "The metadata part must contain readable JSON.", [{ field: "metadata", code: "invalid_json", message: "The metadata part must contain readable JSON." }]); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiOperationError(422, "validation_failed", "The metadata part must contain a JSON object.", [{ field: "metadata", code: "invalid_object", message: "The metadata part must contain a JSON object." }]);
  }
  const object = value as Record<string, unknown>;
  const unknown = Object.keys(object).find((key) => !["expected_version", "actor"].includes(key));
  if (unknown) throw new ApiOperationError(422, "validation_failed", "Remove the unsupported metadata field.", [{ field: `metadata.${unknown}`, code: "unknown_field", message: "Remove the unsupported metadata field." }]);
  if (!Number.isSafeInteger(object.expected_version) || Number(object.expected_version) < 1) {
    throw new ApiOperationError(422, "validation_failed", "Provide the current Photo or Artwork version.", [{ field: "metadata.expected_version", code: "invalid_version", message: "Provide the current Photo or Artwork version." }]);
  }
  const actor = actorFrom(object.actor);
  if (!actor) throw new ApiOperationError(422, "validation_failed", "Include a valid user or system actor.", [{ field: "metadata.actor", code: "invalid_actor", message: "Include a valid user or system actor." }]);
  return { expected_version: Number(object.expected_version), actor };
}

export async function handlePhotoGet(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (path.length !== 4 || path[0] !== "admin" || path[1] !== "artworks" || path[3] !== "photos") return null;
  if (!/^art_[A-Za-z0-9_-]{22}$/.test(path[2])) return apiFailure(404, "not_found", "The Artwork is not available to this Site.");
  const client = await getBusinessPool().connect();
  try {
    await client.query("begin transaction isolation level repeatable read read only");
    const artwork = await client.query(`select 1 from hpos.artworks where site_id = $1 and artwork_id = $2`, [site.siteId, path[2]]);
    if (artwork.rowCount === 0) {
      await client.query("rollback");
      return apiFailure(404, "not_found", "The Artwork is not available to this Site.");
    }
    const response = await listPhotoPage(client, request, site, path[2]);
    await client.query("commit");
    return response;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function readPhotoJsonBody(request: Request): Promise<Record<string, unknown> | Response> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return apiFailure(415, "unsupported_media_type", "Send the Photo operation as application/json.");
  }
  let text: string;
  try { text = await request.text(); }
  catch { return apiFailure(400, "invalid_request", "The request body could not be read as JSON."); }
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) return apiFailure(413, "request_too_large", "The request body exceeds 64 KiB.");
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return apiFailure(400, "invalid_request", "The request body must contain readable JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return apiFailure(400, "invalid_request", "The request body must be a JSON object.");
  return value as Record<string, unknown>;
}

function numericPhotoVersion(value: unknown, field: string): number | Response {
  if (!Number.isSafeInteger(value) || Number(value) < 1) return fieldError(field, "invalid_version", "Provide the current Photo version.");
  return Number(value);
}

async function readAdminArtworkProjection(client: PoolClient, siteId: string, artworkId: string): Promise<Record<string, unknown> | null> {
  const artwork = await client.query<Record<string, unknown>>(
    `select artwork_id, slug, displayed_artwork_id, title, description, medium, dimensions,
            to_char(created_on, 'YYYY-MM-DD') as created_on, cardano_chain, cardano_policy_id,
            cardano_asset_id, original_status, publication_status, version
       from hpos.artworks where site_id = $1 and artwork_id = $2`,
    [siteId, artworkId],
  );
  const row = artwork.rows[0];
  if (!row) return null;
  const photos = await client.query<PhotoRow>(
    `select id, photo_id, site_id, artwork_id, position, is_hero, status, ready_variants, failure_code,
            active_attempt, replacement_attempt, replacement_status, replacement_ready_variants,
            replacement_failure_code, version
       from hpos.photos where site_id = $1 and artwork_id = $2 order by position asc, photo_id asc`,
    [siteId, artworkId],
  );
  const collections = await client.query<{ collection_id: string }>(
    `select collection_id from hpos.collection_artworks where site_id = $1 and artwork_id = $2 order by position asc`,
    [siteId, artworkId],
  );
  const hero = photos.rows.find((photo) => photo.is_hero && photo.status === "ready");
  return {
    artwork_id: row.artwork_id,
    slug: row.slug,
    displayed_artwork_id: row.displayed_artwork_id,
    title: row.title,
    description: row.description,
    medium: row.medium,
    dimensions: row.dimensions,
    created_on: row.created_on,
    cardano_chain: row.cardano_chain,
    cardano_policy_id: row.cardano_policy_id,
    cardano_asset_id: row.cardano_asset_id,
    original_status: row.original_status,
    publication_status: row.publication_status,
    collection_ids: collections.rows.map((item) => item.collection_id),
    photos: photos.rows.map((item) => photoData(normalizePhotoRow(item))),
    hero_photo_id: hero?.photo_id ?? null,
    version: row.version,
  };
}

export async function handlePhotoPost(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  const initial = path.length === 4 && path[0] === "admin" && path[1] === "artworks" && path[3] === "photos";
  const replacement = path.length === 6 && path[0] === "admin" && path[1] === "artworks" && path[3] === "photos" && path[5] === "replacement";
  const retry = path.length === 7 && path[0] === "admin" && path[1] === "artworks" && path[3] === "photos" && path[5] === "actions" && path[6] === "retry";
  if (!initial && !replacement && !retry) return null;
  if (!/^art_[A-Za-z0-9_-]{22}$/.test(path[2]) || ((!initial) && !PHOTO_ID_PATTERN.test(path[4]))) {
    return apiFailure(404, "not_found", "The requested Photo is not available to this Site.");
  }
  const parsed = await readMultipartPhoto(request);
  if (parsed instanceof Response) return parsed;
  return withApiIdempotency(
    request,
    site,
    parsed.fingerprint,
    async (client) => {
      const metadata = parsePhotoUploadMetadata(parsed.metadataRaw);
      try {
        await validatePhotoSource(parsed.source);
      } catch (error) {
        const mediaError = photoMediaErrorResponse(error);
        if (mediaError) throw new ApiOperationError(mediaError.status, mediaError.code, mediaError.message);
        throw error;
      }
      const data = initial
        ? await acceptInitialPhotoUpload(client, {
          site,
          artworkId: path[2],
          expectedArtworkVersion: metadata.expected_version,
          source: parsed.source,
          actor: metadata.actor,
        })
        : await acceptPhotoAttempt(client, {
          site,
          artworkId: path[2],
          photoId: path[4],
          expectedPhotoVersion: metadata.expected_version,
          source: parsed.source,
          actor: metadata.actor,
          operation: replacement ? "replacement" : "retry",
        });
      return { data, status: 202 };
    },
    mapPhotoDatabaseError,
  );
}

async function mutatePhotoOrder(request: Request, site: AuthenticatedSite, artworkId: string): Promise<Response> {
  const body = await readPhotoJsonBody(request);
  if (body instanceof Response) return body;
  if (Object.keys(body).some((key) => !["photo_ids", "expected_version", "actor"].includes(key))) {
    return fieldError(Object.keys(body).find((key) => !["photo_ids", "expected_version", "actor"].includes(key)) ?? "body", "unknown_field", "Remove the unsupported Photo order field.");
  }
  if (!Array.isArray(body.photo_ids) || body.photo_ids.some((value) => typeof value !== "string" || !PHOTO_ID_PATTERN.test(value))) {
    return fieldError("photo_ids", "invalid_list", "Provide every current Photo ID exactly once.");
  }
  const photoIds = body.photo_ids as string[];
  if (new Set(photoIds).size !== photoIds.length) return fieldError("photo_ids", "duplicate", "photo_ids must contain each Photo exactly once.");
  const expected = numericPhotoVersion(body.expected_version, "expected_version");
  if (expected instanceof Response) return expected;
  const actor = actorFrom(body.actor);
  if (!actor) return fieldError("actor", "invalid_actor", "Include a valid user or system actor.");
  return withApiIdempotency(request, site, body, async (client) => {
    const artwork = await client.query<ArtworkVersionRow>(
      `select version from hpos.artworks where site_id = $1 and artwork_id = $2 for update`,
      [site.siteId, artworkId],
    );
    if (!artwork.rows[0]) fail(404, "not_found", "The Artwork is not available to this Site.");
    if (artwork.rows[0].version !== expected) fail(409, "version_conflict", "The Artwork changed; reread it and retry.");
    const current = await client.query<{ photo_id: string; position: number }>(
      `select photo_id, position from hpos.photos where site_id = $1 and artwork_id = $2 order by position asc for update`,
      [site.siteId, artworkId],
    );
    const currentIds = current.rows.map((row) => row.photo_id);
    if (currentIds.length !== photoIds.length || currentIds.some((id) => !photoIds.includes(id))) {
      fail(422, "validation_failed", "photo_ids must contain every current Photo exactly once.", [
        { field: "photo_ids", code: "complete_list_required", message: "Include every current Photo exactly once." },
      ]);
    }
    const changed = currentIds.some((id, index) => id !== photoIds[index]);
    if (changed) {
      await client.query(`update hpos.photos set position = position + 1000000 where site_id = $1 and artwork_id = $2`, [site.siteId, artworkId]);
      for (const [index, photoId] of photoIds.entries()) {
        await client.query(`update hpos.photos set position = $3 where site_id = $1 and artwork_id = $2 and photo_id = $4`, [site.siteId, artworkId, index + 1, photoId]);
      }
      await client.query(
        `update hpos.artworks set version = version + 1, updated_at = clock_timestamp(), updated_actor_type = $3, updated_actor_reference = $4
          where site_id = $1 and artwork_id = $2`,
        [site.siteId, artworkId, actor.type, actor.reference],
      );
    }
    const data = await readAdminArtworkProjection(client, site.siteId, artworkId);
    if (!data) throw new Error("The reordered Artwork could not be read before commit.");
    return { status: 200, data };
  }, mapPhotoDatabaseError);
}

async function selectPhotoHero(request: Request, site: AuthenticatedSite, artworkId: string): Promise<Response> {
  const body = await readPhotoJsonBody(request);
  if (body instanceof Response) return body;
  if (Object.keys(body).some((key) => !["photo_id", "expected_version", "actor"].includes(key))) {
    return fieldError(Object.keys(body).find((key) => !["photo_id", "expected_version", "actor"].includes(key)) ?? "body", "unknown_field", "Remove the unsupported hero field.");
  }
  if (typeof body.photo_id !== "string" || !PHOTO_ID_PATTERN.test(body.photo_id)) return fieldError("photo_id", "invalid_id", "Provide a valid Photo ID.");
  const expected = numericPhotoVersion(body.expected_version, "expected_version");
  if (expected instanceof Response) return expected;
  const actor = actorFrom(body.actor);
  if (!actor) return fieldError("actor", "invalid_actor", "Include a valid user or system actor.");
  return withApiIdempotency(request, site, body, async (client) => {
    const artwork = await client.query<ArtworkVersionRow>(
      `select version from hpos.artworks where site_id = $1 and artwork_id = $2 for update`,
      [site.siteId, artworkId],
    );
    if (!artwork.rows[0]) fail(404, "not_found", "The Artwork is not available to this Site.");
    if (artwork.rows[0].version !== expected) fail(409, "version_conflict", "The Artwork changed; reread it and retry.");
    const selectedPhotoId = body.photo_id as string;
    const photo = await readPhotoRow(client, site.siteId, artworkId, selectedPhotoId, true);
    if (!photo) fail(404, "not_found", "The Photo is not available to this Site.");
    if (photo.status !== "ready") fail(422, "validation_failed", "Only a ready Photo can be selected as hero.", [
      { field: "photo_id", code: "not_ready", message: "Select a Photo with both delivery variants ready." },
    ]);
    if (!photo.is_hero) {
      await client.query(`update hpos.photos set is_hero = false where site_id = $1 and artwork_id = $2`, [site.siteId, artworkId]);
      await client.query(`update hpos.photos set is_hero = true where site_id = $1 and artwork_id = $2 and photo_id = $3`, [site.siteId, artworkId, body.photo_id]);
      await client.query(
        `update hpos.artworks set version = version + 1, updated_at = clock_timestamp(), updated_actor_type = $3, updated_actor_reference = $4
          where site_id = $1 and artwork_id = $2`,
        [site.siteId, artworkId, actor.type, actor.reference],
      );
    }
    const data = await readAdminArtworkProjection(client, site.siteId, artworkId);
    if (!data) throw new Error("The Artwork hero selection could not be read before commit.");
    return { status: 200, data };
  }, mapPhotoDatabaseError);
}

async function removePhoto(request: Request, site: AuthenticatedSite, artworkId: string, photoId: string): Promise<Response> {
  const body = await readPhotoJsonBody(request);
  if (body instanceof Response) return body;
  if (Object.keys(body).some((key) => !["expected_version", "expected_artwork_version", "actor", "replacement_hero_photo_id"].includes(key))) {
    return fieldError(Object.keys(body).find((key) => !["expected_version", "expected_artwork_version", "actor", "replacement_hero_photo_id"].includes(key)) ?? "body", "unknown_field", "Remove the unsupported Photo removal field.");
  }
  const expected = numericPhotoVersion(body.expected_version, "expected_version");
  if (expected instanceof Response) return expected;
  const expectedArtwork = numericPhotoVersion(body.expected_artwork_version, "expected_artwork_version");
  if (expectedArtwork instanceof Response) return expectedArtwork;
  const actor = actorFrom(body.actor);
  if (!actor) return fieldError("actor", "invalid_actor", "Include a valid user or system actor.");
  const replacementId = body.replacement_hero_photo_id;
  if (replacementId !== undefined && (typeof replacementId !== "string" || !PHOTO_ID_PATTERN.test(replacementId))) return fieldError("replacement_hero_photo_id", "invalid_id", "Provide a valid replacement hero Photo ID.");
  return withApiIdempotency(request, site, body, async (client) => {
    const artworkResult = await client.query<ArtworkVersionRow & { publication_status: "draft" | "published" | "archived" }>(
      `select version, publication_status from hpos.artworks where site_id = $1 and artwork_id = $2 for update`,
      [site.siteId, artworkId],
    );
    const artwork = artworkResult.rows[0];
    if (!artwork) fail(404, "not_found", "The Artwork is not available to this Site.");
    if (artwork.version !== expectedArtwork) fail(409, "version_conflict", "The Artwork changed; reread it and retry.");
    const photos = await client.query<PhotoRow>(
      `select id, photo_id, site_id, artwork_id, position, is_hero, status, ready_variants, failure_code,
              active_attempt, replacement_attempt, replacement_status, replacement_ready_variants,
              replacement_failure_code, version
         from hpos.photos where site_id = $1 and artwork_id = $2 order by position asc for update`,
      [site.siteId, artworkId],
    );
    const target = photos.rows.find((row) => row.photo_id === photoId);
    if (!target) fail(404, "not_found", "The Photo is not available to this Site.");
    if (target.version !== expected) fail(409, "version_conflict", "The Photo changed; reread it and retry.");
    const readyAfter = photos.rows.filter((row) => row.photo_id !== photoId && row.status === "ready");
    if (artwork.publication_status === "published" && readyAfter.length === 0) {
      fail(409, "publication_incomplete", "The published Artwork must keep at least one ready Photo and hero.");
    }
    const removalMediaKeys = await photoMediaKeysForPhoto(client, site.siteId, target.id);
    await queuePhotoMediaCleanup(client, site.siteId, removalMediaKeys, new Date());
    if (target.is_hero) {
      if (!replacementId) fail(409, "publication_incomplete", "Select a replacement ready hero Photo before removing the current hero.");
      const replacement = photos.rows.find((row) => row.photo_id === replacementId);
      if (!replacement) fail(404, "not_found", "The replacement hero Photo is not available to this Site.");
      if (replacement.photo_id === target.photo_id || replacement.status !== "ready") {
        fail(422, "validation_failed", "replacement_hero_photo_id must name a different ready Photo on this Artwork.", [
          { field: "replacement_hero_photo_id", code: "not_ready", message: "Choose another ready Photo on this Artwork." },
        ]);
      }
      await client.query(`update hpos.photos set is_hero = false where id = $1`, [target.id]);
      await client.query(`update hpos.photos set is_hero = true where id = $1`, [replacement.id]);
    } else if (replacementId !== undefined) {
      fail(422, "validation_failed", "replacement_hero_photo_id is valid only when removing the current hero.", [
        { field: "replacement_hero_photo_id", code: "not_current_hero", message: "Omit the replacement hero for a non-hero Photo." },
      ]);
    }
    await client.query(`delete from hpos.photos where id = $1`, [target.id]);
    await client.query(`update hpos.photos set position = position + 1000000 where site_id = $1 and artwork_id = $2`, [site.siteId, artworkId]);
    for (const [index, row] of photos.rows.filter((row) => row.id !== target.id).entries()) {
      await client.query(`update hpos.photos set position = $3 where id = $1 and site_id = $2`, [row.id, site.siteId, index + 1]);
    }
    await client.query(
      `update hpos.artworks set version = version + 1, updated_at = clock_timestamp(), updated_actor_type = $3, updated_actor_reference = $4
        where site_id = $1 and artwork_id = $2`,
      [site.siteId, artworkId, actor.type, actor.reference],
    );
    const data = await readAdminArtworkProjection(client, site.siteId, artworkId);
    if (!data) throw new Error("The Artwork after Photo removal could not be read before commit.");
    return { status: 200, data };
  }, mapPhotoDatabaseError);
}

export async function handlePhotoPut(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (path.length === 4 && path[0] === "admin" && path[1] === "artworks" && path[3] === "photo-order") {
    if (!/^art_[A-Za-z0-9_-]{22}$/.test(path[2])) return apiFailure(404, "not_found", "The Artwork is not available to this Site.");
    return mutatePhotoOrder(request, site, path[2]);
  }
  if (path.length === 4 && path[0] === "admin" && path[1] === "artworks" && path[3] === "hero") {
    if (!/^art_[A-Za-z0-9_-]{22}$/.test(path[2])) return apiFailure(404, "not_found", "The Artwork is not available to this Site.");
    return selectPhotoHero(request, site, path[2]);
  }
  return null;
}

export async function handlePhotoDelete(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (path.length !== 5 || path[0] !== "admin" || path[1] !== "artworks" || path[3] !== "photos" || !PHOTO_ID_PATTERN.test(path[4])) return null;
  if (!/^art_[A-Za-z0-9_-]{22}$/.test(path[2])) return apiFailure(404, "not_found", "The Artwork is not available to this Site.");
  return removePhoto(request, site, path[2], path[4]);
}
