import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { apiFailure, apiSuccess } from "./api-response";
import { ApiOperationError, withApiIdempotency } from "./api-idempotency";
import { getBusinessPool } from "./database";
import { readAdminArtwork, readAdminArtworks, handlePublicPortfolioGet } from "./portfolio-projection";
import type { AuthenticatedSite } from "./site-auth";

const ARTWORK_ID_PATTERN = /^art_[A-Za-z0-9_-]{22}$/;
const COLLECTION_ID_PATTERN = /^col_[A-Za-z0-9_-]{22}$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ACTOR_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const MAX_BODY_BYTES = 64 * 1024;

interface Actor {
  type: "user" | "system";
  reference: string;
}

interface Dimensions {
  width: number;
  height: number;
  unit: "mm" | "cm" | "in";
}

interface ArtworkInput {
  actor: Actor;
  title?: string;
  displayed_artwork_id?: string;
  slug?: string | null;
  description?: string | null;
  medium?: string | null;
  dimensions?: Dimensions | null;
  created_on?: string | null;
  cardano_chain?: string | null;
  cardano_policy_id?: string | null;
  cardano_asset_id?: string | null;
  original_status?: "available" | "sold";
}

interface ArtworkRow extends QueryResultRow {
  artwork_id: string;
  site_id: string;
  slug: string | null;
  displayed_artwork_id: string;
  title: string;
  description: string | null;
  medium: string | null;
  dimensions: Dimensions | null;
  created_on: string | null;
  cardano_chain: string | null;
  cardano_policy_id: string | null;
  cardano_asset_id: string | null;
  original_status: "available" | "sold";
  publication_status: "draft" | "published" | "archived";
  version: number;
  created_at: Date;
  updated_at: Date;
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function fieldError(field: string, code: string, message: string): Response {
  return apiFailure(422, "validation_failed", message, {
    details: [{ field, code, message }],
  });
}

function operationError(status: number, code: string, message: string, details: Array<{ field: string; code: string; message: string }> = []): never {
  throw new ApiOperationError(status, code, message, details);
}

function validPlainText(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === "string"
    && value.length <= maximum
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    && (allowEmpty || value.trim().length > 0);
}

function actorFrom(value: unknown): Actor | null {
  if (!object(value) || !hasOnlyKeys(value, ["type", "reference"])) return null;
  if ((value.type !== "user" && value.type !== "system") || typeof value.reference !== "string") return null;
  const reference = value.reference.trim();
  return ACTOR_REFERENCE_PATTERN.test(reference) ? { type: value.type, reference } : null;
}

function parseText(value: unknown, field: string, maximum: number, allowEmpty = false): string | null | Response {
  if (value === null) return null;
  if (!validPlainText(value, maximum, allowEmpty)) return fieldError(field, "invalid_text", "Provide plain text within the documented length.");
  return value.trim();
}

function parseDate(value: unknown, field: string): string | null | Response {
  if (value === null) return null;
  if (typeof value !== "string") return fieldError(field, "invalid_date", "Provide a calendar date in YYYY-MM-DD format.");
  const match = DATE_PATTERN.exec(value);
  if (!match) return fieldError(field, "invalid_date", "Provide a calendar date in YYYY-MM-DD format.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return fieldError(field, "invalid_date", "Provide a valid calendar date.");
  }
  return value;
}

function parseDimensions(value: unknown, field: string): Dimensions | null | Response {
  if (value === null) return null;
  if (!object(value) || !hasOnlyKeys(value, ["width", "height", "unit"])) return fieldError(field, "invalid_object", "Use width, height, and unit for dimensions.");
  if (typeof value.width !== "number" || !Number.isFinite(value.width) || value.width <= 0
    || typeof value.height !== "number" || !Number.isFinite(value.height) || value.height <= 0
    || !["mm", "cm", "in"].includes(String(value.unit))) {
    return fieldError(field, "invalid_dimensions", "Width and height must be positive numbers and unit must be mm, cm, or in.");
  }
  return { width: value.width, height: value.height, unit: value.unit as Dimensions["unit"] };
}

function parseArtworkFields(value: Record<string, unknown>, options: { create: boolean }): ArtworkInput | Response {
  const allowed = options.create
    ? ["actor", "title", "displayed_artwork_id", "slug", "description", "medium", "dimensions", "created_on", "cardano_chain", "cardano_policy_id", "cardano_asset_id"]
    : ["actor", "expected_version", "title", "displayed_artwork_id", "slug", "description", "medium", "dimensions", "created_on", "cardano_chain", "cardano_policy_id", "cardano_asset_id", "original_status"];
  if (!hasOnlyKeys(value, allowed)) {
    const unknown = Object.keys(value).find((key) => !allowed.includes(key)) ?? "unknown";
    return fieldError(unknown, "unknown_field", "Remove the unsupported field.");
  }
  const actor = actorFrom(value.actor);
  if (!actor) return fieldError("actor", "invalid_actor", "Include a user or system actor with a non-secret Site-local reference.");
  if (options.create && !Object.hasOwn(value, "title")) return fieldError("title", "required", "Provide an Artwork title.");
  if (options.create && !Object.hasOwn(value, "displayed_artwork_id")) return fieldError("displayed_artwork_id", "required", "Provide the displayed Artwork identifier.");
  const input: ArtworkInput = { actor };
  if (Object.hasOwn(value, "title")) {
    const title = parseText(value.title, "title", 200);
    if (title instanceof Response || title === null) return fieldError("title", "invalid_text", "Provide a non-empty Artwork title.");
    input.title = title;
  }
  if (Object.hasOwn(value, "displayed_artwork_id")) {
    const displayed = parseText(value.displayed_artwork_id, "displayed_artwork_id", 200);
    if (displayed instanceof Response || displayed === null) return fieldError("displayed_artwork_id", "invalid_text", "Provide a non-empty displayed Artwork identifier.");
    input.displayed_artwork_id = displayed;
  }
  if (Object.hasOwn(value, "slug")) {
    const slug = parseText(value.slug, "slug", 120);
    if (slug instanceof Response) return slug;
    if (slug !== null && !SLUG_PATTERN.test(slug)) return fieldError("slug", "invalid_slug", "Use lowercase ASCII letters and digits separated by single hyphens.");
    input.slug = slug;
  }
  for (const [field, maximum, allowEmpty] of [["description", 20000, true], ["medium", 200, false], ["cardano_chain", MAX_BODY_BYTES, false], ["cardano_policy_id", MAX_BODY_BYTES, false], ["cardano_asset_id", MAX_BODY_BYTES, false]] as const) {
    if (!Object.hasOwn(value, field)) continue;
    const parsed = parseText(value[field], field, maximum, allowEmpty);
    if (parsed instanceof Response) return parsed;
    input[field] = parsed;
  }
  if (Object.hasOwn(value, "dimensions")) {
    const dimensions = parseDimensions(value.dimensions, "dimensions");
    if (dimensions instanceof Response) return dimensions;
    input.dimensions = dimensions;
  }
  if (Object.hasOwn(value, "created_on")) {
    const createdOn = parseDate(value.created_on, "created_on");
    if (createdOn instanceof Response) return createdOn;
    input.created_on = createdOn;
  }
  if (Object.hasOwn(value, "original_status")) {
    if (value.original_status !== "available" && value.original_status !== "sold") return fieldError("original_status", "invalid_enum", "Use available or sold.");
    input.original_status = value.original_status;
  }
  return input;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | Response> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return apiFailure(415, "unsupported_media_type", "Send Artwork fields as application/json.");
  }
  let text: string;
  try { text = await request.text(); }
  catch { return apiFailure(400, "invalid_request", "The request body could not be read as JSON."); }
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return apiFailure(413, "request_too_large", "The request body exceeds 64 KiB.");
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return apiFailure(400, "invalid_request", "The request body must contain readable JSON."); }
  if (!object(value)) return apiFailure(400, "invalid_request", "The request body must be a JSON object.");
  return value;
}

function numericVersion(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function completePhotoVariants(value: unknown): boolean {
  return Array.isArray(value)
    && value.includes("grid_400")
    && value.includes("artwork_1600");
}

/**
 * Check the current publication boundary in the same transaction as the
 * lifecycle write. The Photo worker may change Photo state independently, so
 * this query deliberately reads the latest rows while the Artwork is locked.
 */
export async function validateArtworkPublication(client: PoolClient, siteId: string, artworkId: string): Promise<void> {
  const artwork = await client.query<{
    title: string;
    slug: string | null;
  }>(
    `select title, slug
       from hpos.artworks
      where site_id = $1 and artwork_id = $2
      for update`,
    [siteId, artworkId],
  );
  const row = artwork.rows[0];
  if (!row) operationError(404, "not_found", "The Artwork is not available to this Site.");
  const details: Array<{ field: string; code: string; message: string }> = [];
  if (!row.title || row.title.trim().length === 0) details.push({ field: "title", code: "required", message: "Provide an Artwork title before publication." });
  if (!row.slug || !SLUG_PATTERN.test(row.slug)) details.push({ field: "slug", code: "required", message: "Provide a valid unique slug before publication." });

  const activeCollections = await client.query(
    `select 1
       from hpos.collection_artworks ca
       join hpos.collections c
         on c.collection_id = ca.collection_id and c.site_id = ca.site_id
      where ca.site_id = $1 and ca.artwork_id = $2 and c.is_active = true
      limit 1`,
    [siteId, artworkId],
  );
  if (activeCollections.rowCount !== 1) {
    details.push({ field: "collection_ids", code: "active_collection_required", message: "Add the Artwork to at least one active Collection before publication." });
  }

  const photos = await client.query<{
    photo_id: string;
    is_hero: boolean;
    status: string;
    ready_variants: unknown;
    active_attempt: number | null;
    active_variant_count: number;
  }>(
    `select p.photo_id, p.is_hero, p.status, p.ready_variants, p.active_attempt,
            (select count(*)::int from hpos.photo_variants active_variant
              where active_variant.site_id = p.site_id
                and active_variant.photo_id = p.id
                and active_variant.attempt_number = p.active_attempt
                and active_variant.variant in ('grid_400', 'artwork_1600')) as active_variant_count
       from hpos.photos p
      where p.site_id = $1 and p.artwork_id = $2
      order by p.position asc, p.photo_id asc`,
    [siteId, artworkId],
  );
  if (photos.rowCount === 0) {
    details.push({ field: "photos", code: "required", message: "Add at least one Photo before publication." });
  } else if (photos.rows.some((photo) => photo.status !== "ready"
    || photo.active_attempt === null
    || photo.active_variant_count !== 2
    || !completePhotoVariants(photo.ready_variants))) {
    details.push({ field: "photos", code: "delivery_not_ready", message: "Every Photo must have both delivery variants ready." });
  }
  const heroes = photos.rows.filter((photo) => photo.is_hero);
  const hero = heroes.find((photo) => photo.status === "ready"
    && photo.active_attempt !== null
    && photo.active_variant_count === 2
    && completePhotoVariants(photo.ready_variants));
  if (heroes.length !== 1 || !hero) {
    details.push({ field: "hero_photo_id", code: "hero_required", message: "Select exactly one ready hero Photo." });
  }
  if (details.length > 0) {
    operationError(409, "publication_incomplete", "The Artwork does not meet the publication requirements.", details);
  }
}

async function readArtwork(client: PoolClient, siteId: string, artworkId: string): Promise<Record<string, unknown> | null> {
  return readAdminArtwork(client, siteId, artworkId);
}

async function createArtwork(client: PoolClient, site: AuthenticatedSite, input: ArtworkInput): Promise<{ status: number; data: unknown }> {
  const databaseId = randomUUID();
  const artworkId = `art_${randomBytes(16).toString("base64url")}`;
  await client.query(
    `insert into hpos.artworks (
       id, artwork_id, site_id, slug, displayed_artwork_id, title, description, medium, dimensions, created_on,
       cardano_chain, cardano_policy_id, cardano_asset_id, created_actor_type, created_actor_reference,
       updated_actor_type, updated_actor_reference
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::date, $11, $12, $13, $14, $15, $14, $15)`,
    [databaseId, artworkId, site.siteId, input.slug ?? null, input.displayed_artwork_id, input.title, input.description ?? null,
      input.medium ?? null, input.dimensions ? JSON.stringify(input.dimensions) : null, input.created_on ?? null,
      input.cardano_chain ?? null, input.cardano_policy_id ?? null, input.cardano_asset_id ?? null,
      input.actor.type, input.actor.reference],
  );
  const artwork = await readArtwork(client, site.siteId, artworkId);
  if (!artwork) throw new Error("Created Artwork was not readable in its transaction.");
  return { status: 201, data: artwork };
}

async function patchArtwork(client: PoolClient, site: AuthenticatedSite, artworkId: string, body: Record<string, unknown>, input: ArtworkInput): Promise<{ status: number; data: unknown }> {
  const expected = numericVersion(body.expected_version);
  if (!expected) operationError(422, "validation_failed", "Provide expected_version.", [{ field: "expected_version", code: "required", message: "Use the Artwork version you loaded." }]);
  if (Object.keys(input).length === 1) operationError(422, "validation_failed", "Provide at least one Artwork field to edit.", [{ field: "body", code: "no_changes", message: "Supply an editable Artwork field." }]);
  const selected = await client.query<ArtworkRow>(
    `select artwork_id, site_id, slug, displayed_artwork_id, title, description, medium, dimensions,
            to_char(created_on, 'YYYY-MM-DD') as created_on, cardano_chain, cardano_policy_id, cardano_asset_id,
            original_status, publication_status, version, created_at, updated_at
       from hpos.artworks where site_id = $1 and artwork_id = $2 for update`,
    [site.siteId, artworkId],
  );
  const current = selected.rows[0];
  if (!current) operationError(404, "not_found", "The Artwork is not available to this Site.");
  if (current.version !== expected) operationError(409, "version_conflict", "The Artwork changed after you loaded it. Reload it before editing.");
  if (current.publication_status !== "draft" && Object.hasOwn(input, "slug") && input.slug === null) {
    operationError(422, "validation_failed", "Keep a valid slug on an Artwork that has been published.", [
      { field: "slug", code: "required", message: "A published or archived Artwork must retain a valid slug." },
    ]);
  }
  const sets: string[] = [];
  const args: unknown[] = [site.siteId, artworkId];
  const add = (column: string, value: unknown, cast = "") => {
    args.push(value);
    sets.push(`${column} = $${args.length}${cast}`);
  };
  if (Object.hasOwn(input, "title")) add("title", input.title);
  if (Object.hasOwn(input, "displayed_artwork_id")) add("displayed_artwork_id", input.displayed_artwork_id);
  if (Object.hasOwn(input, "slug")) add("slug", input.slug);
  if (Object.hasOwn(input, "description")) add("description", input.description);
  if (Object.hasOwn(input, "medium")) add("medium", input.medium);
  if (Object.hasOwn(input, "dimensions")) add("dimensions", input.dimensions === null ? null : JSON.stringify(input.dimensions), "::jsonb");
  if (Object.hasOwn(input, "created_on")) add("created_on", input.created_on, "::date");
  if (Object.hasOwn(input, "cardano_chain")) add("cardano_chain", input.cardano_chain);
  if (Object.hasOwn(input, "cardano_policy_id")) add("cardano_policy_id", input.cardano_policy_id);
  if (Object.hasOwn(input, "cardano_asset_id")) add("cardano_asset_id", input.cardano_asset_id);
  if (Object.hasOwn(input, "original_status")) add("original_status", input.original_status);
  args.push(input.actor.type, input.actor.reference);
  const typeIndex = args.length - 1;
  sets.push(`version = version + 1`, `updated_at = clock_timestamp()`, `updated_actor_type = $${typeIndex}`, `updated_actor_reference = $${typeIndex + 1}`);
  await client.query(`update hpos.artworks set ${sets.join(", ")} where site_id = $1 and artwork_id = $2`, args);
  const artwork = await readArtwork(client, site.siteId, artworkId);
  if (!artwork) throw new Error("Updated Artwork was not readable in its transaction.");
  return { status: 200, data: artwork };
}

function mapArtworkDatabaseError(error: unknown): Response | null {
  if (!object(error)) return null;
  if (error.code === "23505") {
    if (error.constraint === "artworks_site_slug_idx") return apiFailure(409, "slug_conflict", "The Artwork slug is already assigned within this Site.");
    if (error.constraint === "artworks_site_displayed_id_idx") {
      return apiFailure(422, "validation_failed", "The displayed Artwork identifier is already assigned within this Site.", {
        details: [{ field: "displayed_artwork_id", code: "already_exists", message: "Use a different displayed Artwork identifier." }],
      });
    }
    return apiFailure(422, "validation_failed", "The Artwork conflicts with an existing record.");
  }
  if (error.code === "23514" || error.code === "22007") return apiFailure(422, "validation_failed", "The Artwork update violates a documented field rule.");
  if (error.code === "23503") return apiFailure(404, "not_found", "The Artwork is not available to this Site.");
  return null;
}

function parseCursor(value: string | null, site: AuthenticatedSite, scope: string): { at: string; id: string } | null | Response {
  if (value === null) return null;
  try {
    const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(value);
    if (value.length > 2048 || !match) throw new Error();
    const [, payload, signature] = match;
    const expected = createHmac("sha256", site.cursorSigningKey).update(payload).digest();
    const supplied = Buffer.from(signature, "base64url");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error();
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (!object(decoded) || decoded.mode !== "admin_artworks" || decoded.siteId !== site.siteId || decoded.scope !== scope
      || typeof decoded.at !== "string" || !ARTWORK_ID_PATTERN.test(String(decoded.id ?? ""))
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(decoded.at)
      || typeof decoded.issuedAt !== "string") throw new Error();
    const issuedAt = Date.parse(decoded.issuedAt);
    if (!Number.isFinite(issuedAt) || issuedAt < Date.now() - 60 * 60 * 1000 || issuedAt > Date.now() + 60_000) throw new Error();
    return { at: decoded.at, id: String(decoded.id) };
  } catch { return apiFailure(422, "invalid_cursor", "The cursor is invalid for this Artwork list."); }
}

function cursorFor(site: AuthenticatedSite, scope: string, at: string, id: string): string {
  const payload = Buffer.from(JSON.stringify({ mode: "admin_artworks", siteId: site.siteId, scope, issuedAt: new Date().toISOString(), at, id }), "utf8").toString("base64url");
  const signature = createHmac("sha256", site.cursorSigningKey).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function listLimit(value: string | null): number | Response {
  if (value === null) return 50;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) return fieldError("limit", "out_of_range", "limit must be an integer from 1 to 100.");
  return Number(value);
}

async function listArtworks(request: Request, site: AuthenticatedSite): Promise<Response> {
  const url = new URL(request.url);
  const allowed = new Set(["limit", "cursor", "publication_status", "original_status", "collection_id"]);
  for (const name of url.searchParams.keys()) if (!allowed.has(name)) return fieldError(name, "unknown_filter", "Remove the unsupported Artwork list parameter.");
  const limit = listLimit(url.searchParams.get("limit"));
  if (limit instanceof Response) return limit;
  const publicationStatus = url.searchParams.get("publication_status");
  if (publicationStatus !== null && !["draft", "published", "archived"].includes(publicationStatus)) return fieldError("publication_status", "unsupported_value", "publication_status has an unsupported value.");
  const originalStatus = url.searchParams.get("original_status");
  if (originalStatus !== null && !["available", "sold"].includes(originalStatus)) return fieldError("original_status", "unsupported_value", "original_status has an unsupported value.");
  const collectionId = url.searchParams.get("collection_id");
  if (collectionId !== null && !COLLECTION_ID_PATTERN.test(collectionId)) return apiFailure(404, "not_found", "The Collection is not available to this Site.");
  const scope = JSON.stringify({ limit, publication_status: publicationStatus, original_status: originalStatus, collection_id: collectionId });
  const cursor = parseCursor(url.searchParams.get("cursor"), site, scope);
  if (cursor instanceof Response) return cursor;
  const where = ["a.site_id = $1"];
  const values: unknown[] = [site.siteId];
  const add = (clause: string, value: unknown) => { values.push(value); where.push(clause.replace("?", `$${values.length}`)); };
  if (publicationStatus !== null) add("a.publication_status = ?", publicationStatus);
  if (originalStatus !== null) add("a.original_status = ?", originalStatus);
  if (collectionId !== null) {
    values.push(collectionId);
    where.push(`exists (
      select 1
        from hpos.collection_artworks ca
       where ca.site_id = a.site_id
         and ca.collection_id = $${values.length}
         and ca.artwork_id = a.artwork_id
    )`);
  }
  if (cursor) {
    values.push(cursor.at, cursor.id);
    where.push(`(a.updated_at < $${values.length - 1}::timestamptz or (a.updated_at = $${values.length - 1}::timestamptz and a.artwork_id > $${values.length}::text))`);
  }
  values.push(limit + 1);
  const client = await getBusinessPool().connect();
  try {
    await client.query("begin transaction isolation level repeatable read read only");
    if (collectionId !== null) {
      const collection = await client.query<{ collection_id: string }>(
        "select collection_id from hpos.collections where site_id = $1 and collection_id = $2",
        [site.siteId, collectionId],
      );
      if (collection.rowCount !== 1) {
        await client.query("rollback");
        return apiFailure(404, "not_found", "The Collection is not available to this Site.");
      }
    }
    const result = await client.query<ArtworkRow>(
      `select artwork_id, site_id, slug, displayed_artwork_id, title, description, medium, dimensions,
              to_char(created_on, 'YYYY-MM-DD') as created_on, cardano_chain, cardano_policy_id, cardano_asset_id,
              original_status, publication_status, version, created_at, updated_at,
              to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_cursor_time
         from hpos.artworks a where ${where.join(" and ")}
         order by a.updated_at desc, a.artwork_id asc limit $${values.length}`,
      values,
    );
    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    const nextCursor = result.rows.length > limit && last ? cursorFor(site, scope, (last as ArtworkRow & { updated_cursor_time: string }).updated_cursor_time, last.artwork_id) : null;
    const projections = await readAdminArtworks(client, site.siteId, rows.map((row) => row.artwork_id));
    await client.query("commit");
    return apiSuccess(rows.flatMap((row) => {
      const artwork = projections.get(row.artwork_id);
      return artwork ? [artwork] : [];
    }), 200, { nextCursor });
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function handleArtworkGet(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  const publicResponse = await handlePublicPortfolioGet(request, site, path);
  if (publicResponse) return publicResponse;
  if (path.length === 2 && path[0] === "admin" && path[1] === "artworks") return listArtworks(request, site);
  if (path.length === 3 && path[0] === "admin" && path[1] === "artworks") {
    if (!ARTWORK_ID_PATTERN.test(path[2])) return apiFailure(404, "not_found", "The Artwork is not available to this Site.");
    const client = await getBusinessPool().connect();
    try {
      await client.query("begin transaction isolation level repeatable read read only");
      const artwork = await readArtwork(client, site.siteId, path[2]);
      await client.query("commit");
      return artwork ? apiSuccess(artwork) : apiFailure(404, "not_found", "The Artwork is not available to this Site.");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
  return null;
}

export async function handleArtworkPost(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (path.length !== 2 || path[0] !== "admin" || path[1] !== "artworks") return null;
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  const input = parseArtworkFields(body, { create: true });
  if (input instanceof Response) return input;
  return withApiIdempotency(request, site, body, (client) => createArtwork(client, site, input), mapArtworkDatabaseError);
}

export async function handleArtworkPatch(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (path.length !== 3 || path[0] !== "admin" || path[1] !== "artworks") return null;
  if (!ARTWORK_ID_PATTERN.test(path[2])) return apiFailure(404, "not_found", "The Artwork is not available to this Site.");
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  if (!Object.hasOwn(body, "expected_version")) return fieldError("expected_version", "required", "Provide the Artwork version you loaded.");
  const expected = numericVersion(body.expected_version);
  if (!expected) return fieldError("expected_version", "required", "Provide the Artwork version you loaded.");
  const input = parseArtworkFields(body, { create: false });
  if (input instanceof Response) return input;
  return withApiIdempotency(request, site, body, (client) => patchArtwork(client, site, path[2], body, input), mapArtworkDatabaseError);
}

async function writeArtworkAction(
  client: PoolClient,
  site: AuthenticatedSite,
  artworkId: string,
  action: string,
  body: Record<string, unknown>,
): Promise<{ status: number; data: unknown }> {
  const siteLock = await client.query("select id from hpos.sites where id = $1 for update", [site.siteId]);
  if (siteLock.rowCount !== 1) operationError(404, "not_found", "The Artwork is not available to this Site.");
  const current = await client.query<{
    publication_status: "draft" | "published" | "archived";
    version: number;
  }>(
    `select publication_status, version
       from hpos.artworks
      where site_id = $1 and artwork_id = $2
      for update`,
    [site.siteId, artworkId],
  );
  const row = current.rows[0];
  if (!row) operationError(404, "not_found", "The Artwork is not available to this Site.");
  const expected = numericVersion(body.expected_version);
  if (!expected) operationError(422, "validation_failed", "Provide expected_version.", [{ field: "expected_version", code: "required", message: "Use the Artwork version you loaded." }]);
  if (row.version !== expected) operationError(409, "version_conflict", "The Artwork changed; reread it before taking this action.");
  const actor = actorFrom(body.actor);
  if (!actor) operationError(422, "validation_failed", "Include a user or system actor for audit attribution.", [{ field: "actor", code: "invalid_actor", message: "Use a non-secret Site-local reference." }]);
  if (action === "publish") {
    if (row.publication_status !== "draft" && row.publication_status !== "archived") {
      operationError(409, "invalid_state", "Only a draft or archived Artwork can be published.");
    }
    await validateArtworkPublication(client, site.siteId, artworkId);
  } else if (action === "archive") {
    if (row.publication_status !== "published") operationError(409, "invalid_state", "Only a published Artwork can be archived.");
  } else {
    operationError(404, "not_found", "The Artwork action is unavailable.");
  }
  await client.query(
    `update hpos.artworks
        set publication_status = $3, version = version + 1, updated_at = clock_timestamp(),
            updated_actor_type = $4, updated_actor_reference = $5
      where site_id = $1 and artwork_id = $2`,
    [site.siteId, artworkId, action === "publish" ? "published" : "archived", actor.type, actor.reference],
  );
  const artwork = await readAdminArtwork(client, site.siteId, artworkId);
  if (!artwork) throw new Error("The Artwork lifecycle result could not be read before commit.");
  return { status: 200, data: artwork };
}

export async function handleArtworkActionPost(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (path.length !== 5 || path[0] !== "admin" || path[1] !== "artworks" || path[3] !== "actions") return null;
  if (!ARTWORK_ID_PATTERN.test(path[2])) return apiFailure(404, "not_found", "The Artwork is not available to this Site.");
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  if (!hasOnlyKeys(body, ["actor", "expected_version"])) return fieldError("body", "unknown_field", "Only actor and expected_version are accepted for this action.");
  if (!Object.hasOwn(body, "actor")) return fieldError("actor", "required", "Include a user or system actor for audit attribution.");
  return withApiIdempotency(request, site, body, (client) => writeArtworkAction(client, site, path[2], path[4], body), mapArtworkDatabaseError);
}
