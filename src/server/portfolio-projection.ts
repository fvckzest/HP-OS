import { createHmac, timingSafeEqual } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { apiFailure, apiSuccess } from "./api-response";
import { getBusinessPool } from "./database";
import type { AuthenticatedSite } from "./site-auth";

const ARTWORK_ID_PATTERN = /^art_[A-Za-z0-9_-]{22}$/;
const COLLECTION_ID_PATTERN = /^col_[A-Za-z0-9_-]{22}$/;
const VARIANTS = ["grid_400", "artwork_1600"] as const;
const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

type PhotoVariant = (typeof VARIANTS)[number];
type PublicationStatus = "draft" | "published" | "archived";

interface ArtworkRow extends QueryResultRow {
  artwork_id: string;
  site_id: string;
  slug: string | null;
  displayed_artwork_id: string;
  title: string;
  description: string | null;
  medium: string | null;
  dimensions: unknown;
  created_on: string | null;
  cardano_chain: string | null;
  cardano_policy_id: string | null;
  cardano_asset_id: string | null;
  original_status: "available" | "sold";
  publication_status: PublicationStatus;
  version: number;
}

interface CollectionMembershipRow extends QueryResultRow {
  artwork_id: string;
  collection_id: string;
  name: string;
  position: number;
  is_active: boolean;
}

interface PhotoRow extends QueryResultRow {
  id: string;
  artwork_id: string;
  photo_id: string;
  position: number;
  is_hero: boolean;
  status: "processing" | "ready" | "failed";
  ready_variants: PhotoVariant[] | null;
  failure_code: "delivery_variants_failed" | null;
  active_attempt: number | null;
  active_variant_count: number;
  replacement_status: "processing" | "failed" | null;
  replacement_ready_variants: PhotoVariant[] | null;
  replacement_failure_code: "delivery_variants_failed" | null;
  version: number;
}

interface PublicArtworkOptions {
  collectionId?: string | null;
}

function publicActiveCollectionPredicate(artworkAlias: string): string {
  return `exists (
    select 1
      from hpos.collection_artworks eligible_membership
      join hpos.collections eligible_collection
        on eligible_collection.collection_id = eligible_membership.collection_id
       and eligible_collection.site_id = eligible_membership.site_id
     where eligible_membership.site_id = ${artworkAlias}.site_id
       and eligible_membership.artwork_id = ${artworkAlias}.artwork_id
       and eligible_collection.is_active = true
  )`;
}

function publicCompletePhotoPredicate(photoAlias: string): string {
  return `${photoAlias}.status = 'ready'
    and ${photoAlias}.ready_variants @> array['grid_400', 'artwork_1600']::text[]
    and ${photoAlias}.active_attempt is not null
    and (select count(*) from hpos.photo_variants eligible_photo_variant
           where eligible_photo_variant.site_id = ${photoAlias}.site_id
             and eligible_photo_variant.photo_id = ${photoAlias}.id
             and eligible_photo_variant.attempt_number = ${photoAlias}.active_attempt
             and eligible_photo_variant.variant in ('grid_400', 'artwork_1600')) = 2`;
}

function publicHeroPredicate(artworkAlias: string): string {
  return `exists (
    select 1
      from hpos.photos eligible_hero
     where eligible_hero.site_id = ${artworkAlias}.site_id
       and eligible_hero.artwork_id = ${artworkAlias}.artwork_id
       and eligible_hero.is_hero = true
       and ${publicCompletePhotoPredicate("eligible_hero")}
  )`;
}

function normalArray(value: PhotoVariant[] | null | undefined): PhotoVariant[] {
  return Array.isArray(value) ? value.filter((item): item is PhotoVariant => VARIANTS.includes(item)) : [];
}

function completeVariants(value: PhotoVariant[] | null | undefined): boolean {
  const variants = normalArray(value);
  return VARIANTS.every((variant) => variants.includes(variant));
}

function stableImageRef(photoId: string, variant: PhotoVariant): string {
  return `/v1/public/media/${photoId}/variants/${variant}`;
}

function adminPhotoData(row: PhotoRow): Record<string, unknown> {
  const readyVariants = normalArray(row.ready_variants);
  const replacementVariants = normalArray(row.replacement_ready_variants);
  return {
    photo_id: row.photo_id,
    position: row.position,
    status: row.status,
    ready_variants: readyVariants,
    failure_code: row.failure_code,
    retryable: row.status === "failed" || row.replacement_status === "failed",
    replacement: row.replacement_status === null
      ? null
      : {
        status: row.replacement_status,
        ready_variants: replacementVariants,
        failure_code: row.replacement_failure_code,
        retryable: row.replacement_status === "failed",
      },
    version: row.version,
  };
}

function publicPhotoData(row: PhotoRow): Record<string, unknown> {
  return {
    photo_id: row.photo_id,
    position: row.position,
    is_hero: row.is_hero,
    image_refs: {
      grid_400: stableImageRef(row.photo_id, "grid_400"),
      artwork_1600: stableImageRef(row.photo_id, "artwork_1600"),
    },
  };
}

function adminBaseData(row: ArtworkRow, collectionIds: string[], photoRows: PhotoRow[]): Record<string, unknown> {
  const hero = photoRows.find((photo) => photo.is_hero && photo.status === "ready");
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
    collection_ids: collectionIds,
    photos: photoRows.map(adminPhotoData),
    hero_photo_id: hero?.photo_id ?? null,
    version: row.version,
  };
}

function publicBaseData(
  row: ArtworkRow,
  collections: CollectionMembershipRow[],
  photos: PhotoRow[],
): Record<string, unknown> {
  const hero = photos.find((photo) => photo.is_hero
    && photo.status === "ready"
    && photo.active_attempt !== null
    && photo.active_variant_count === 2
    && completeVariants(photo.ready_variants));
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
    collections: collections
      .filter((collection) => collection.is_active)
      .map((collection) => ({
        collection_id: collection.collection_id,
        name: collection.name,
        position: collection.position,
      })),
    photos: photos
      .filter((photo) => photo.status === "ready"
        && photo.active_attempt !== null
        && photo.active_variant_count === 2
        && completeVariants(photo.ready_variants))
      .map((photo) => publicPhotoData(photo)),
    hero_photo_id: hero?.photo_id ?? null,
  };
}

async function readArtworkRows(client: PoolClient, siteId: string, artworkIds: string[]): Promise<ArtworkRow[]> {
  if (artworkIds.length === 0) return [];
  const result = await client.query<ArtworkRow>(
    `select a.artwork_id, a.site_id, a.slug, a.displayed_artwork_id, a.title,
            a.description, a.medium, a.dimensions,
            to_char(a.created_on, 'YYYY-MM-DD') as created_on,
            a.cardano_chain, a.cardano_policy_id, a.cardano_asset_id,
            a.original_status, a.publication_status, a.version
       from hpos.artworks a
      where a.site_id = $1 and a.artwork_id = any($2::text[])`,
    [siteId, artworkIds],
  );
  return result.rows;
}

async function readCollectionsForArtworks(client: PoolClient, siteId: string, artworkIds: string[]): Promise<CollectionMembershipRow[]> {
  if (artworkIds.length === 0) return [];
  const result = await client.query<CollectionMembershipRow>(
    `select ca.artwork_id, c.collection_id, c.name, ca.position, c.is_active
       from hpos.collection_artworks ca
       join hpos.collections c
         on c.collection_id = ca.collection_id and c.site_id = ca.site_id
      where ca.site_id = $1 and ca.artwork_id = any($2::text[])
      order by ca.artwork_id asc, c.position asc, c.collection_id asc`,
    [siteId, artworkIds],
  );
  return result.rows;
}

async function readPhotosForArtworks(client: PoolClient, siteId: string, artworkIds: string[]): Promise<PhotoRow[]> {
  if (artworkIds.length === 0) return [];
  const result = await client.query<PhotoRow>(
    `select p.id::text as id, p.artwork_id, p.photo_id, p.position, p.status,
            p.is_hero, p.ready_variants, p.failure_code, p.replacement_status,
            p.active_attempt,
            (select count(*)::int from hpos.photo_variants active_variant
              where active_variant.site_id = p.site_id
                and active_variant.photo_id = p.id
                and active_variant.attempt_number = p.active_attempt
                and active_variant.variant in ('grid_400', 'artwork_1600')) as active_variant_count,
            p.replacement_ready_variants, p.replacement_failure_code, p.version
       from hpos.photos p
      where p.site_id = $1 and p.artwork_id = any($2::text[])
      order by p.artwork_id asc, p.position asc, p.photo_id asc`,
    [siteId, artworkIds],
  );
  return result.rows;
}

function indexBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) {
    const current = result.get(key(row)) ?? [];
    current.push(row);
    result.set(key(row), current);
  }
  return result;
}

/**
 * Full admin projection used by Artwork detail, list, membership, and Photo
 * mutation responses. The caller owns the transaction, so write handlers can
 * read their result before commit without opening a second connection.
 */
export async function readAdminArtworks(client: PoolClient, siteId: string, artworkIds: string[]): Promise<Map<string, Record<string, unknown>>> {
  const uniqueIds = [...new Set(artworkIds)];
  const artworks = await readArtworkRows(client, siteId, uniqueIds);
  const collections = await readCollectionsForArtworks(client, siteId, uniqueIds);
  const photos = await readPhotosForArtworks(client, siteId, uniqueIds);
  const collectionsByArtwork = indexBy(collections, (row) => row.artwork_id);
  const photosByArtwork = indexBy(photos, (row) => row.artwork_id);
  return new Map(artworks.map((row) => [
    row.artwork_id,
    adminBaseData(
      row,
      (collectionsByArtwork.get(row.artwork_id) ?? []).map((collection) => collection.collection_id),
      photosByArtwork.get(row.artwork_id) ?? [],
    ),
  ]));
}

export async function readAdminArtwork(client: PoolClient, siteId: string, artworkId: string): Promise<Record<string, unknown> | null> {
  return (await readAdminArtworks(client, siteId, [artworkId])).get(artworkId) ?? null;
}

async function readEligibleArtworkRows(client: PoolClient, siteId: string, artworkIds?: string[], options: PublicArtworkOptions = {}): Promise<ArtworkRow[]> {
  const values: unknown[] = [siteId];
  const where = [
    "a.site_id = $1",
    "a.publication_status = 'published'",
    publicActiveCollectionPredicate("a"),
    publicHeroPredicate("a"),
  ];
  if (artworkIds && artworkIds.length > 0) {
    values.push([...new Set(artworkIds)]);
    where.push(`a.artwork_id = any($${values.length}::text[])`);
  }
  if (options.collectionId) {
    values.push(options.collectionId);
    where.push(`exists (
      select 1
        from hpos.collection_artworks requested_membership
       where requested_membership.site_id = a.site_id
         and requested_membership.collection_id = $${values.length}
         and requested_membership.artwork_id = a.artwork_id
    )`);
  }
  const result = await client.query<ArtworkRow>(
    `select a.artwork_id, a.site_id, a.slug, a.displayed_artwork_id, a.title,
            a.description, a.medium, a.dimensions,
            to_char(a.created_on, 'YYYY-MM-DD') as created_on,
            a.cardano_chain, a.cardano_policy_id, a.cardano_asset_id,
            a.original_status, a.publication_status, a.version
       from hpos.artworks a
      where ${where.join(" and ")}
      order by a.artwork_id asc`,
    values,
  );
  return result.rows;
}

async function readPublicProjectionRows(client: PoolClient, siteId: string, rows: ArtworkRow[]): Promise<Map<string, Record<string, unknown>>> {
  const ids = rows.map((row) => row.artwork_id);
  const collections = await readCollectionsForArtworks(client, siteId, ids);
  const photos = await readPhotosForArtworks(client, siteId, ids);
  const collectionsByArtwork = indexBy(collections, (row) => row.artwork_id);
  const photosByArtwork = indexBy(photos, (row) => row.artwork_id);
  return new Map(rows.map((row) => [
    row.artwork_id,
    publicBaseData(row, collectionsByArtwork.get(row.artwork_id) ?? [], photosByArtwork.get(row.artwork_id) ?? []),
  ]));
}

export async function readPublicArtwork(client: PoolClient, siteId: string, artworkId: string): Promise<Record<string, unknown> | null> {
  const rows = await readEligibleArtworkRows(client, siteId, [artworkId]);
  if (rows.length === 0) return null;
  return (await readPublicProjectionRows(client, siteId, rows)).get(artworkId) ?? null;
}

export async function readPublicArtworks(
  client: PoolClient,
  siteId: string,
  artworkIds?: string[],
  options: PublicArtworkOptions = {},
): Promise<Map<string, Record<string, unknown>>> {
  const rows = await readEligibleArtworkRows(client, siteId, artworkIds, options);
  return readPublicProjectionRows(client, siteId, rows);
}

function listLimit(value: string | null): number | Response {
  if (value === null) return 50;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) {
    return apiFailure(422, "validation_failed", "limit must be an integer from 1 to 100.", {
      details: [{ field: "limit", code: "out_of_range", message: "limit must be an integer from 1 to 100." }],
    });
  }
  return Number(value);
}

function cursorFor(site: AuthenticatedSite, mode: string, scope: string, position: number | null, id: string): string {
  const payload = Buffer.from(JSON.stringify({ mode, siteId: site.siteId, scope, issuedAt: new Date().toISOString(), position, id }), "utf8").toString("base64url");
  return `${payload}.${createHmac("sha256", site.cursorSigningKey).update(payload).digest("base64url")}`;
}

function parseCursor(value: string | null, site: AuthenticatedSite, mode: string, scope: string, idPattern: RegExp): { position: number | null; id: string } | null | Response {
  if (value === null) return null;
  try {
    const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(value);
    if (!match || value.length > 2048) throw new Error();
    const [, payload, signature] = match;
    const expected = createHmac("sha256", site.cursorSigningKey).update(payload).digest();
    const supplied = Buffer.from(signature, "base64url");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error();
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    if (decoded.mode !== mode || decoded.siteId !== site.siteId || decoded.scope !== scope
      || typeof decoded.issuedAt !== "string" || !RFC3339_PATTERN.test(decoded.issuedAt)
      || (decoded.position !== null && (!Number.isSafeInteger(decoded.position) || Number(decoded.position) < 1))
      || typeof decoded.id !== "string" || !idPattern.test(decoded.id)) throw new Error();
    const issuedAt = Date.parse(decoded.issuedAt);
    if (!Number.isFinite(issuedAt) || issuedAt < Date.now() - 60 * 60 * 1000 || issuedAt > Date.now() + 60_000) throw new Error();
    return { position: decoded.position === null ? null : Number(decoded.position), id: decoded.id };
  } catch {
    return apiFailure(422, "invalid_cursor", "The cursor is invalid for this public portfolio list.");
  }
}

async function withReadTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getBusinessPool().connect();
  try {
    await client.query("begin transaction isolation level repeatable read read only");
    const value = await work(client);
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function readPublicArtworkDetail(site: AuthenticatedSite, artworkId: string): Promise<Response> {
  if (!ARTWORK_ID_PATTERN.test(artworkId)) return apiFailure(404, "not_found", "The Artwork is not available to this Site.");
  const artwork = await withReadTransaction((client) => readPublicArtwork(client, site.siteId, artworkId));
  return artwork ? apiSuccess(artwork) : apiFailure(404, "not_found", "The Artwork is not available to this Site.");
}

async function listPublicArtworks(request: Request, site: AuthenticatedSite): Promise<Response> {
  const url = new URL(request.url);
  for (const name of url.searchParams.keys()) {
    if (!["limit", "cursor", "collection_id"].includes(name)) {
      return apiFailure(422, "validation_failed", "Remove the unsupported public Artwork list parameter.", {
        details: [{ field: name, code: "unknown_filter", message: "This filter is not supported." }],
      });
    }
  }
  const limit = listLimit(url.searchParams.get("limit"));
  if (limit instanceof Response) return limit;
  const collectionId = url.searchParams.get("collection_id");
  if (collectionId !== null && !COLLECTION_ID_PATTERN.test(collectionId)) return apiFailure(404, "not_found", "The Collection is not available to this Site.");
  const scope = JSON.stringify({ limit, collection_id: collectionId });
  const cursor = parseCursor(url.searchParams.get("cursor"), site, "public-artworks", scope, ARTWORK_ID_PATTERN);
  if (cursor instanceof Response) return cursor;
  const result = await withReadTransaction(async (client) => {
    if (collectionId !== null) {
      const collection = await client.query("select 1 from hpos.collections where site_id = $1 and collection_id = $2 and is_active = true", [site.siteId, collectionId]);
      if (collection.rowCount !== 1) return { error: apiFailure(404, "not_found", "The Collection is not available to this Site.") };
    }
    const values: unknown[] = [site.siteId];
    const where = [
      "a.site_id = $1",
      "a.publication_status = 'published'",
      publicActiveCollectionPredicate("a"),
      publicHeroPredicate("a"),
    ];
    if (collectionId !== null) {
      values.push(collectionId);
      where.push(`exists (select 1 from hpos.collection_artworks requested where requested.site_id = a.site_id and requested.collection_id = $${values.length} and requested.artwork_id = a.artwork_id)`);
    }
    if (cursor) {
      values.push(cursor.id);
      where.push(`a.artwork_id > $${values.length}`);
    }
    values.push(limit + 1);
    const rows = await client.query<ArtworkRow>(
      `select a.artwork_id, a.site_id, a.slug, a.displayed_artwork_id, a.title,
              a.description, a.medium, a.dimensions,
              to_char(a.created_on, 'YYYY-MM-DD') as created_on,
              a.cardano_chain, a.cardano_policy_id, a.cardano_asset_id,
              a.original_status, a.publication_status, a.version
         from hpos.artworks a
        where ${where.join(" and ")}
        order by a.artwork_id asc
        limit $${values.length}`,
      values,
    );
    const ordered = rows.rows;
    const data = await readPublicProjectionRows(client, site.siteId, ordered.slice(0, limit));
    const valuesInOrder = ordered.slice(0, limit).map((row) => data.get(row.artwork_id)).filter((row): row is Record<string, unknown> => Boolean(row));
    const last = ordered.at(Math.min(limit, ordered.length) - 1);
    return {
      data: valuesInOrder,
      nextCursor: rows.rows.length > limit && last ? cursorFor(site, "public-artworks", scope, null, last.artwork_id) : null,
    };
  });
  if ("error" in result && result.error) return result.error;
  return apiSuccess(result.data, 200, { nextCursor: result.nextCursor });
}

async function listPublicCollections(request: Request, site: AuthenticatedSite): Promise<Response> {
  const url = new URL(request.url);
  for (const name of url.searchParams.keys()) {
    if (!["limit", "cursor"].includes(name)) return apiFailure(422, "validation_failed", "Remove the unsupported public Collection list parameter.", {
      details: [{ field: name, code: "unknown_filter", message: "This filter is not supported." }],
    });
  }
  const limit = listLimit(url.searchParams.get("limit"));
  if (limit instanceof Response) return limit;
  const scope = JSON.stringify({ limit });
  const cursor = parseCursor(url.searchParams.get("cursor"), site, "public-collections", scope, COLLECTION_ID_PATTERN);
  if (cursor instanceof Response) return cursor;
  const result = await withReadTransaction(async (client) => {
    const values: unknown[] = [site.siteId];
    const where = ["site_id = $1", "is_active = true"];
    if (cursor) {
      values.push(cursor.position, cursor.id);
      where.push(`(position > $${values.length - 1} or (position = $${values.length - 1} and collection_id > $${values.length}))`);
    }
    values.push(limit + 1);
    const rows = await client.query<{ collection_id: string; name: string; position: number }>(
      `select collection_id, name, position from hpos.collections where ${where.join(" and ")}
       order by position asc, collection_id asc limit $${values.length}`,
      values,
    );
    const data = rows.rows.slice(0, limit).map((row) => ({ collection_id: row.collection_id, name: row.name, position: row.position }));
    const last = data.at(-1);
    return {
      data,
      nextCursor: rows.rows.length > limit && last ? cursorFor(site, "public-collections", scope, last.position, last.collection_id) : null,
    };
  });
  return apiSuccess(result.data, 200, { nextCursor: result.nextCursor });
}

async function readPublicCollection(site: AuthenticatedSite, collectionId: string): Promise<Response> {
  if (!COLLECTION_ID_PATTERN.test(collectionId)) return apiFailure(404, "not_found", "The Collection is not available to this Site.");
  const result = await getBusinessPool().query<{ collection_id: string; name: string; position: number }>(
    "select collection_id, name, position from hpos.collections where site_id = $1 and collection_id = $2 and is_active = true",
    [site.siteId, collectionId],
  );
  const row = result.rows[0];
  return row ? apiSuccess({ collection_id: row.collection_id, name: row.name, position: row.position }) : apiFailure(404, "not_found", "The Collection is not available to this Site.");
}

async function listPublicCollectionArtworks(request: Request, site: AuthenticatedSite, collectionId: string): Promise<Response> {
  if (!COLLECTION_ID_PATTERN.test(collectionId)) return apiFailure(404, "not_found", "The Collection is not available to this Site.");
  const url = new URL(request.url);
  for (const name of url.searchParams.keys()) {
    if (!["limit", "cursor"].includes(name)) return apiFailure(422, "validation_failed", "Remove the unsupported public Collection Artwork list parameter.", {
      details: [{ field: name, code: "unknown_filter", message: "This filter is not supported." }],
    });
  }
  const limit = listLimit(url.searchParams.get("limit"));
  if (limit instanceof Response) return limit;
  const scope = JSON.stringify({ collection_id: collectionId, limit });
  const cursor = parseCursor(url.searchParams.get("cursor"), site, "public-collection-artworks", scope, ARTWORK_ID_PATTERN);
  if (cursor instanceof Response) return cursor;
  const result = await withReadTransaction(async (client) => {
    const active = await client.query("select 1 from hpos.collections where site_id = $1 and collection_id = $2 and is_active = true", [site.siteId, collectionId]);
    if (active.rowCount !== 1) return { error: apiFailure(404, "not_found", "The Collection is not available to this Site.") };
    const values: unknown[] = [site.siteId, collectionId];
    const where = [
      "ca.site_id = $1",
      "ca.collection_id = $2",
      "a.publication_status = 'published'",
      publicHeroPredicate("a"),
    ];
    if (cursor) {
      values.push(cursor.position, cursor.id);
      where.push(`(ca.position > $${values.length - 1} or (ca.position = $${values.length - 1} and ca.artwork_id > $${values.length}))`);
    }
    values.push(limit + 1);
    const membershipRows = await client.query<{ artwork_id: string; position: number }>(
      `select ca.artwork_id, ca.position from hpos.collection_artworks ca
       join hpos.artworks a on a.site_id = ca.site_id and a.artwork_id = ca.artwork_id
       where ${where.join(" and ")}
       order by ca.position asc, ca.artwork_id asc limit $${values.length}`,
      values,
    );
    const projections = await readPublicProjectionRows(client, site.siteId, await readEligibleArtworkRows(client, site.siteId, membershipRows.rows.map((row) => row.artwork_id), { collectionId }));
    const data = membershipRows.rows.slice(0, limit).flatMap((membership) => {
      const artwork = projections.get(membership.artwork_id);
      return artwork ? [artwork] : [];
    });
    const last = membershipRows.rows.at(Math.min(limit, membershipRows.rows.length) - 1);
    return {
      data,
      nextCursor: membershipRows.rows.length > limit && last ? cursorFor(site, "public-collection-artworks", scope, last.position, last.artwork_id) : null,
    };
  });
  if ("error" in result && result.error) return result.error;
  return apiSuccess(result.data, 200, { nextCursor: result.nextCursor });
}

/**
 * Resolve a currently public delivery variant for the stable media route.
 * The caller reads the returned storage key through configured media storage
 * and does not expose the key itself in the HTTP response.
 */
export async function readPublicMediaVariant(
  client: PoolClient,
  siteId: string,
  photoId: string,
  variant: string,
): Promise<{ storageKey: string; byteSize: number } | null> {
  if (!/^photo_[A-Za-z0-9_-]{22}$/.test(photoId) || !VARIANTS.includes(variant as PhotoVariant)) return null;
  const result = await client.query<{ storage_key: string; byte_size: number }>(
    `select eligible_variant.storage_key, eligible_variant.byte_size
       from hpos.photos eligible_photo
       join hpos.artworks eligible_artwork
         on eligible_artwork.site_id = eligible_photo.site_id
        and eligible_artwork.artwork_id = eligible_photo.artwork_id
       join hpos.photo_variants eligible_variant
         on eligible_variant.site_id = eligible_photo.site_id
        and eligible_variant.photo_id = eligible_photo.id
        and eligible_variant.attempt_number = eligible_photo.active_attempt
        and eligible_variant.variant = $3
      where eligible_photo.site_id = $1
        and eligible_photo.photo_id = $2
        and ${publicActiveCollectionPredicate("eligible_artwork")}
        and ${publicHeroPredicate("eligible_artwork")}
        and ${publicCompletePhotoPredicate("eligible_photo")}`,
    [siteId, photoId, variant],
  );
  const row = result.rows[0];
  return row ? { storageKey: row.storage_key, byteSize: Number(row.byte_size) } : null;
}

/** Public portfolio GET dispatcher. Site authentication is performed by /v1. */
export async function handlePublicPortfolioGet(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (path.length === 2 && path[0] === "public" && path[1] === "artworks") return listPublicArtworks(request, site);
  if (path.length === 3 && path[0] === "public" && path[1] === "artworks") return readPublicArtworkDetail(site, path[2]);
  if (path.length === 2 && path[0] === "public" && path[1] === "collections") return listPublicCollections(request, site);
  if (path.length === 3 && path[0] === "public" && path[1] === "collections") return readPublicCollection(site, path[2]);
  if (path.length === 4 && path[0] === "public" && path[1] === "collections" && path[3] === "artworks") return listPublicCollectionArtworks(request, site, path[2]);
  return null;
}
