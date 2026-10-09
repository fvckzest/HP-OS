import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { apiFailure, apiSuccess } from "./api-response";
import { ApiOperationError, withApiIdempotency } from "./api-idempotency";
import { getBusinessPool } from "./database";
import { readAdminArtwork, readAdminArtworks } from "./portfolio-projection";
import type { AuthenticatedSite } from "./site-auth";

const COLLECTION_ID_PATTERN = /^col_[A-Za-z0-9_-]{22}$/;
const ARTWORK_ID_PATTERN = /^art_[A-Za-z0-9_-]{22}$/;
const ACTOR_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_BODY_BYTES = 64 * 1024;
const POSITION_OFFSET = 1_000_000_000;

interface Actor {
  type: "user" | "system";
  reference: string;
}

interface CollectionRow extends QueryResultRow {
  collection_id: string;
  site_id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  position: number;
  version: number;
  created_at: Date;
  updated_at: Date;
  created_actor_type: Actor["type"];
  created_actor_reference: string;
  updated_actor_type: Actor["type"];
  updated_actor_reference: string;
}

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
  publication_status: "draft" | "published" | "archived";
  version: number;
  collection_ids: string[] | null;
}

interface MembershipRow extends QueryResultRow {
  artwork_id: string;
  position: number;
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

function fail(status: number, code: string, message: string, details: Array<{ field: string; code: string; message: string }> = []): never {
  throw new ApiOperationError(status, code, message, details);
}

function actorFrom(value: unknown): Actor | null {
  if (!object(value) || !hasOnlyKeys(value, ["type", "reference"])) return null;
  if ((value.type !== "user" && value.type !== "system") || typeof value.reference !== "string") return null;
  const reference = value.reference.trim();
  return ACTOR_REFERENCE_PATTERN.test(reference) ? { type: value.type, reference } : null;
}

function validText(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === "string"
    && value.length <= maximum
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    && (allowEmpty || value.trim().length > 0);
}

function versionFrom(value: unknown, field: string): number | Response {
  if (!Number.isSafeInteger(value) || Number(value) < 1) return fieldError(field, "invalid_version", "Provide a positive integer version.");
  return Number(value);
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | Response> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return apiFailure(415, "unsupported_media_type", "Send Collection fields as application/json.");
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

function collectionData(row: CollectionRow): Record<string, unknown> {
  return {
    collection_id: row.collection_id,
    name: row.name,
    description: row.description,
    is_active: row.is_active,
    position: row.position,
    version: row.version,
  };
}

function parseLimit(value: string | null): number | Response {
  if (value === null) return 50;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) {
    return fieldError("limit", "out_of_range", "limit must be an integer from 1 to 100.");
  }
  return Number(value);
}

function cursorFor(site: AuthenticatedSite, mode: string, scope: string, position: number, id: string): string {
  const payload = Buffer.from(JSON.stringify({
    mode,
    siteId: site.siteId,
    scope,
    issuedAt: new Date().toISOString(),
    position,
    id,
  }), "utf8").toString("base64url");
  return `${payload}.${createHmac("sha256", site.cursorSigningKey).update(payload).digest("base64url")}`;
}

function parseCursor(value: string | null, site: AuthenticatedSite, mode: string, scope: string, idPattern = COLLECTION_ID_PATTERN): { position: number; id: string } | null | Response {
  if (value === null) return null;
  try {
    const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(value);
    if (!match || value.length > 2048) throw new Error();
    const [, payload, signature] = match;
    const expected = createHmac("sha256", site.cursorSigningKey).update(payload).digest();
    const supplied = Buffer.from(signature, "base64url");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error();
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (!object(decoded)
      || decoded.mode !== mode
      || decoded.siteId !== site.siteId
      || decoded.scope !== scope
      || typeof decoded.issuedAt !== "string"
      || !RFC3339_PATTERN.test(decoded.issuedAt)
      || !Number.isSafeInteger(decoded.position)
      || Number(decoded.position) < 1
      || typeof decoded.id !== "string"
      || !idPattern.test(decoded.id)) throw new Error();
    const issuedAt = Date.parse(decoded.issuedAt);
    if (!Number.isFinite(issuedAt) || issuedAt < Date.now() - 60 * 60 * 1000 || issuedAt > Date.now() + 60_000) throw new Error();
    return { position: Number(decoded.position), id: decoded.id };
  } catch {
    return apiFailure(422, "invalid_cursor", "The cursor is invalid for this Collection list.");
  }
}

function mapDatabaseError(error: unknown): Response | null {
  if (object(error) && error.code === "23503") return apiFailure(404, "not_found", "The requested resource is not available to this Site.");
  if (object(error) && error.code === "23514") return apiFailure(422, "validation_failed", "The Collection update violates a field rule.");
  if (object(error) && error.code === "23505") return apiFailure(409, "conflict", "The Collection order is already being changed; retry the operation.");
  return null;
}

async function lockSite(client: PoolClient, siteId: string): Promise<void> {
  const result = await client.query("select id from hpos.sites where id = $1 for update", [siteId]);
  if (result.rowCount !== 1) fail(404, "not_found", "The Collection is not available to this Site.");
}

async function readCollection(client: PoolClient, siteId: string, collectionId: string, forUpdate = false): Promise<CollectionRow> {
  const result = await client.query<CollectionRow>(
    `select collection_id, site_id, name, description, is_active, position, version,
            created_at, updated_at, created_actor_type, created_actor_reference,
            updated_actor_type, updated_actor_reference
       from hpos.collections
      where site_id = $1 and collection_id = $2
      ${forUpdate ? "for update" : ""}`,
    [siteId, collectionId],
  );
  const row = result.rows[0];
  if (!row) fail(404, "not_found", "The Collection is not available to this Site.");
  return row;
}

async function readArtwork(client: PoolClient, siteId: string, artworkId: string, forUpdate = false): Promise<ArtworkRow> {
  if (forUpdate) {
    const locked = await client.query(
      "select id from hpos.artworks where site_id = $1 and artwork_id = $2 for update",
      [siteId, artworkId],
    );
    if (locked.rowCount !== 1) fail(404, "not_found", "The Artwork is not available to this Site.");
  }
  const result = await client.query<ArtworkRow>(
    `select a.artwork_id, a.site_id, a.slug, a.displayed_artwork_id, a.title,
            a.description, a.medium, a.dimensions, a.created_on,
            a.cardano_chain, a.cardano_policy_id, a.cardano_asset_id,
            a.original_status, a.publication_status, a.version,
            coalesce((select array_agg(c.collection_id order by c.position)
                        from hpos.collection_artworks ca
                        join hpos.collections c on c.collection_id = ca.collection_id
                           and c.site_id = ca.site_id
                       where ca.site_id = a.site_id and ca.artwork_id = a.artwork_id), '{}') as collection_ids
       from hpos.artworks a
      where a.site_id = $1 and a.artwork_id = $2
      `,
    [siteId, artworkId],
  );
  const row = result.rows[0];
  if (!row) fail(404, "not_found", "The Artwork is not available to this Site.");
  return row;
}

async function membershipRows(client: PoolClient, siteId: string, collectionId: string): Promise<MembershipRow[]> {
  const result = await client.query<MembershipRow>(
    `select artwork_id, position
       from hpos.collection_artworks
      where site_id = $1 and collection_id = $2
      order by position asc, artwork_id asc`,
    [siteId, collectionId],
  );
  return result.rows;
}

async function membershipResponse(client: PoolClient, siteId: string, collectionId: string, rows: MembershipRow[]): Promise<Record<string, unknown>[]> {
  if (rows.length === 0) return [];
  const byId = await readAdminArtworks(client, siteId, rows.map((row) => row.artwork_id));
  return rows.flatMap((row) => {
    const artwork = byId.get(row.artwork_id);
    return artwork ? [{ position: row.position, artwork }] : [];
  });
}

async function listCollections(request: Request, site: AuthenticatedSite): Promise<Response> {
  const url = new URL(request.url);
  for (const name of url.searchParams.keys()) {
    if (name !== "limit" && name !== "cursor") return fieldError(name, "unknown_filter", "Remove the unsupported Collection list parameter.");
  }
  const limit = parseLimit(url.searchParams.get("limit"));
  if (limit instanceof Response) return limit;
  const scope = JSON.stringify({ limit });
  const cursor = parseCursor(url.searchParams.get("cursor"), site, "admin-collections", scope);
  if (cursor instanceof Response) return cursor;
  const values: unknown[] = [site.siteId];
  const conditions = ["site_id = $1"];
  if (cursor) {
    values.push(cursor.position, cursor.id);
    conditions.push(`(position > $${values.length - 1} or (position = $${values.length - 1} and collection_id > $${values.length}))`);
  }
  values.push(limit + 1);
  const result = await getBusinessPool().query<CollectionRow>(
    `select collection_id, site_id, name, description, is_active, position, version,
            created_at, updated_at, created_actor_type, created_actor_reference,
            updated_actor_type, updated_actor_reference
       from hpos.collections
      where ${conditions.join(" and ")}
      order by position asc, collection_id asc
      limit $${values.length}`,
    values,
  );
  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1);
  return apiSuccess(rows.map(collectionData), 200, {
    nextCursor: result.rows.length > limit && last ? cursorFor(site, "admin-collections", scope, last.position, last.collection_id) : null,
  });
}

async function listMemberships(request: Request, site: AuthenticatedSite, collectionId: string): Promise<Response> {
  if (!COLLECTION_ID_PATTERN.test(collectionId)) return apiFailure(404, "not_found", "The Collection is not available to this Site.");
  const url = new URL(request.url);
  for (const name of url.searchParams.keys()) {
    if (name !== "limit" && name !== "cursor") return fieldError(name, "unknown_filter", "Remove the unsupported Collection Artwork list parameter.");
  }
  const limit = parseLimit(url.searchParams.get("limit"));
  if (limit instanceof Response) return limit;
  const scope = JSON.stringify({ collection_id: collectionId, limit });
  const cursor = parseCursor(url.searchParams.get("cursor"), site, "admin-collection-artworks", scope, ARTWORK_ID_PATTERN);
  if (cursor instanceof Response) return cursor;
  const client = await getBusinessPool().connect();
  try {
    // Keep the Collection existence check, membership page, and Artwork
    // projections on one snapshot. This avoids returning a page assembled
    // from different connections while another write is in flight.
    await client.query("begin transaction isolation level repeatable read read only");
    const collectionCheck = await client.query<{ collection_id: string }>(
      "select collection_id from hpos.collections where site_id = $1 and collection_id = $2",
      [site.siteId, collectionId],
    );
    if (collectionCheck.rowCount !== 1) {
      await client.query("rollback");
      return apiFailure(404, "not_found", "The Collection is not available to this Site.");
    }
    const values: unknown[] = [site.siteId, collectionId];
    const conditions = ["ca.site_id = $1", "ca.collection_id = $2"];
    if (cursor) {
      values.push(cursor.position, cursor.id);
      conditions.push(`(ca.position > $${values.length - 1} or (ca.position = $${values.length - 1} and ca.artwork_id > $${values.length}))`);
    }
    values.push(limit + 1);
    const result = await client.query<MembershipRow>(
      `select ca.artwork_id, ca.position
         from hpos.collection_artworks ca
        where ${conditions.join(" and ")}
        order by ca.position asc, ca.artwork_id asc
        limit $${values.length}`,
      values,
    );
    const rows = result.rows.slice(0, limit);
    const data = await membershipResponse(client, site.siteId, collectionId, rows);
    await client.query("commit");
    const last = rows.at(-1);
    return apiSuccess(data, 200, {
      nextCursor: result.rows.length > limit && last ? cursorFor(site, "admin-collection-artworks", scope, last.position, last.artwork_id) : null,
    });
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function readCollectionDetail(site: AuthenticatedSite, collectionId: string): Promise<Response> {
  if (!COLLECTION_ID_PATTERN.test(collectionId)) return apiFailure(404, "not_found", "The Collection is not available to this Site.");
  const result = await getBusinessPool().query<CollectionRow>(
    `select collection_id, site_id, name, description, is_active, position, version,
            created_at, updated_at, created_actor_type, created_actor_reference,
            updated_actor_type, updated_actor_reference
       from hpos.collections where site_id = $1 and collection_id = $2`,
    [site.siteId, collectionId],
  );
  const row = result.rows[0];
  return row ? apiSuccess(collectionData(row)) : apiFailure(404, "not_found", "The Collection is not available to this Site.");
}

async function createCollection(request: Request, site: AuthenticatedSite): Promise<Response> {
  const raw = await readJsonBody(request);
  if (raw instanceof Response) return raw;
  if (!hasOnlyKeys(raw, ["name", "description", "actor"])) return fieldError(Object.keys(raw).find((key) => !["name", "description", "actor"].includes(key)) ?? "body", "unknown_field", "Remove the unsupported Collection field.");
  if (!validText(raw.name, 200)) return fieldError("name", "invalid_text", "Provide a Collection name within 200 characters.");
  const actor = actorFrom(raw.actor);
  if (!actor) return fieldError("actor", "invalid_actor", "Include a user or system actor with a Site-local reference.");
  let description: string | null = null;
  if (Object.hasOwn(raw, "description")) {
    if (raw.description !== null && !validText(raw.description, 20000, true)) return fieldError("description", "invalid_text", "Provide a Collection description within 20,000 characters or null.");
    description = raw.description === null ? null : String(raw.description).trim();
  }
  const name = String(raw.name).trim();
  return withApiIdempotency(request, site, raw, async (client) => {
    await lockSite(client, site.siteId);
    const collectionId = `col_${randomBytes(16).toString("base64url")}`;
    const positionResult = await client.query<{ position: number }>("select coalesce(max(position), 0) + 1 as position from hpos.collections where site_id = $1", [site.siteId]);
    const position = Number(positionResult.rows[0]?.position ?? 1);
    const result = await client.query<CollectionRow>(
      `insert into hpos.collections
         (collection_id, site_id, name, description, position, created_actor_type, created_actor_reference,
          updated_actor_type, updated_actor_reference)
       values ($1, $2, $3, $4, $5, $6, $7, $6, $7)
       returning collection_id, site_id, name, description, is_active, position, version,
                 created_at, updated_at, created_actor_type, created_actor_reference,
                 updated_actor_type, updated_actor_reference`,
      [collectionId, site.siteId, name, description, position, actor.type, actor.reference],
    );
    return { status: 201, data: collectionData(result.rows[0]) };
  }, mapDatabaseError);
}

async function patchCollection(request: Request, site: AuthenticatedSite, collectionId: string): Promise<Response> {
  if (!COLLECTION_ID_PATTERN.test(collectionId)) return apiFailure(404, "not_found", "The Collection is not available to this Site.");
  const raw = await readJsonBody(request);
  if (raw instanceof Response) return raw;
  const allowed = ["actor", "expected_version", "name", "description", "is_active", "position"];
  if (!hasOnlyKeys(raw, allowed)) return fieldError(Object.keys(raw).find((key) => !allowed.includes(key)) ?? "body", "unknown_field", "Remove the unsupported Collection field.");
  const actor = actorFrom(raw.actor);
  if (!actor) return fieldError("actor", "invalid_actor", "Include a user or system actor with a Site-local reference.");
  const expectedVersion = versionFrom(raw.expected_version, "expected_version");
  if (expectedVersion instanceof Response) return expectedVersion;
  let name: string | undefined;
  if (Object.hasOwn(raw, "name")) {
    if (!validText(raw.name, 200)) return fieldError("name", "invalid_text", "Provide a Collection name within 200 characters.");
    name = String(raw.name).trim();
  }
  let description: string | null | undefined;
  if (Object.hasOwn(raw, "description")) {
    if (raw.description !== null && !validText(raw.description, 20000, true)) return fieldError("description", "invalid_text", "Provide a Collection description within 20,000 characters or null.");
    description = raw.description === null ? null : String(raw.description).trim();
  }
  let isActive: boolean | undefined;
  if (Object.hasOwn(raw, "is_active")) {
    if (typeof raw.is_active !== "boolean") return fieldError("is_active", "invalid_boolean", "is_active must be true or false.");
    isActive = raw.is_active;
  }
  let destination: number | undefined;
  if (Object.hasOwn(raw, "position")) {
    const parsed = versionFrom(raw.position, "position");
    if (parsed instanceof Response) return parsed;
    destination = parsed;
  }
  return withApiIdempotency(request, site, raw, async (client) => {
    await lockSite(client, site.siteId);
    const current = await readCollection(client, site.siteId, collectionId, true);
    if (current.version !== expectedVersion) fail(409, "version_conflict", "The Collection has changed; reread it and retry.");
    const countResult = await client.query<{ count: string }>("select count(*)::text as count from hpos.collections where site_id = $1", [site.siteId]);
    const count = Number(countResult.rows[0]?.count ?? 0);
    if (destination !== undefined && destination > count) fail(422, "validation_failed", "position must be between 1 and the current Collection count.", [{ field: "position", code: "out_of_range", message: "position must be between 1 and the current Collection count." }]);
    const moved = destination !== undefined && destination !== current.position;
    const changed = moved
      || (name !== undefined && name !== current.name)
      || (description !== undefined && description !== current.description)
      || (isActive !== undefined && isActive !== current.is_active);
    if (!changed) return { status: 200, data: collectionData(current) };

    if (moved) {
      await client.query("update hpos.collections set position = position + $2 where site_id = $1", [site.siteId, POSITION_OFFSET]);
      const direction = destination! < current.position ? 1 : -1;
      await client.query(
        `update hpos.collections
            set position = case
              when collection_id = $2 then $3
              when (position - $4) between $5 and $6 then (position - $4) + $7
              else position - $4
            end,
                version = version + case
                  when collection_id = $2 or (position - $4) between $5 and $6 then 1 else 0 end,
                updated_at = case
                  when collection_id = $2 or (position - $4) between $5 and $6 then clock_timestamp() else updated_at end,
                updated_actor_type = case
                  when collection_id = $2 or (position - $4) between $5 and $6 then $8 else updated_actor_type end,
                updated_actor_reference = case
                  when collection_id = $2 or (position - $4) between $5 and $6 then $9 else updated_actor_reference end
          where site_id = $1`,
        [site.siteId, collectionId, destination, POSITION_OFFSET, Math.min(current.position, destination!), Math.max(current.position, destination!), direction, actor.type, actor.reference],
      );
    }
    const fields: string[] = [];
    const values: unknown[] = [site.siteId, collectionId];
    const add = (sql: string, value: unknown) => { values.push(value); fields.push(`${sql} = $${values.length}`); };
    if (name !== undefined) add("name", name);
    if (description !== undefined) add("description", description);
    if (isActive !== undefined) add("is_active", isActive);
    if (!moved) add("version", current.version + 1);
    if (moved && fields.length === 0) return { status: 200, data: collectionData(await readCollection(client, site.siteId, collectionId)) };
    if (moved) {
      add("version", current.version + 1);
    }
    fields.push("updated_at = clock_timestamp()", `updated_actor_type = $${values.length + 1}`, `updated_actor_reference = $${values.length + 2}`);
    values.push(actor.type, actor.reference);
    const result = await client.query<CollectionRow>(
      `update hpos.collections set ${fields.join(", ")} where site_id = $1 and collection_id = $2
       returning collection_id, site_id, name, description, is_active, position, version,
                 created_at, updated_at, created_actor_type, created_actor_reference,
                 updated_actor_type, updated_actor_reference`,
      values,
    );
    return { status: 200, data: collectionData(result.rows[0]) };
  }, mapDatabaseError);
}

async function putMembership(request: Request, site: AuthenticatedSite, collectionId: string, artworkId: string): Promise<Response> {
  if (!COLLECTION_ID_PATTERN.test(collectionId) || !ARTWORK_ID_PATTERN.test(artworkId)) return apiFailure(404, "not_found", "The requested resource is not available to this Site.");
  const raw = await readJsonBody(request);
  if (raw instanceof Response) return raw;
  if (!hasOnlyKeys(raw, ["actor", "expected_version", "expected_artwork_version"])) return fieldError(Object.keys(raw).find((key) => !["actor", "expected_version", "expected_artwork_version"].includes(key)) ?? "body", "unknown_field", "Remove the unsupported membership field.");
  const actor = actorFrom(raw.actor);
  if (!actor) return fieldError("actor", "invalid_actor", "Include a user or system actor with a Site-local reference.");
  const expectedVersion = versionFrom(raw.expected_version, "expected_version");
  if (expectedVersion instanceof Response) return expectedVersion;
  const expectedArtworkVersion = versionFrom(raw.expected_artwork_version, "expected_artwork_version");
  if (expectedArtworkVersion instanceof Response) return expectedArtworkVersion;
  return withApiIdempotency(request, site, raw, async (client) => {
    await lockSite(client, site.siteId);
    const collection = await readCollection(client, site.siteId, collectionId, true);
    const artwork = await readArtwork(client, site.siteId, artworkId, true);
    if (collection.version !== expectedVersion) fail(409, "version_conflict", "The Collection has changed; reread it and retry.");
    if (artwork.version !== expectedArtworkVersion) fail(409, "version_conflict", "The Artwork has changed; reread it and retry.");
    const existing = await client.query<MembershipRow>(
      "select artwork_id, position from hpos.collection_artworks where site_id = $1 and collection_id = $2 and artwork_id = $3 for update",
      [site.siteId, collectionId, artworkId],
    );
    if (existing.rows[0]) {
      const currentArtwork = await readAdminArtwork(client, site.siteId, artworkId);
      if (!currentArtwork) fail(404, "not_found", "The Artwork is not available to this Site.");
      return { status: 200, data: { collection: collectionData(collection), artwork: currentArtwork } };
    }
    const positionResult = await client.query<{ position: number }>("select coalesce(max(position), 0) + 1 as position from hpos.collection_artworks where site_id = $1 and collection_id = $2", [site.siteId, collectionId]);
    const position = Number(positionResult.rows[0]?.position ?? 1);
    await client.query("insert into hpos.collection_artworks (collection_id, artwork_id, site_id, position) values ($1, $2, $3, $4)", [collectionId, artworkId, site.siteId, position]);
    const collectionResult = await client.query<CollectionRow>(
      `update hpos.collections set version = version + 1, updated_at = clock_timestamp(), updated_actor_type = $3, updated_actor_reference = $4
       where site_id = $1 and collection_id = $2
       returning collection_id, site_id, name, description, is_active, position, version,
                 created_at, updated_at, created_actor_type, created_actor_reference,
                 updated_actor_type, updated_actor_reference`,
      [site.siteId, collectionId, actor.type, actor.reference],
    );
    await client.query(
      `update hpos.artworks set version = version + 1, updated_at = clock_timestamp(), updated_actor_type = $3, updated_actor_reference = $4
       where site_id = $1 and artwork_id = $2`,
      [site.siteId, artworkId, actor.type, actor.reference],
    );
    const updatedArtwork = await readAdminArtwork(client, site.siteId, artworkId);
    if (!updatedArtwork) fail(404, "not_found", "The Artwork is not available to this Site.");
    return { status: 200, data: { collection: collectionData(collectionResult.rows[0]), artwork: updatedArtwork } };
  }, mapDatabaseError);
}

async function deleteMembership(request: Request, site: AuthenticatedSite, collectionId: string, artworkId: string): Promise<Response> {
  if (!COLLECTION_ID_PATTERN.test(collectionId) || !ARTWORK_ID_PATTERN.test(artworkId)) return apiFailure(404, "not_found", "The requested resource is not available to this Site.");
  const raw = await readJsonBody(request);
  if (raw instanceof Response) return raw;
  if (!hasOnlyKeys(raw, ["actor", "expected_version", "expected_artwork_version"])) return fieldError(Object.keys(raw).find((key) => !["actor", "expected_version", "expected_artwork_version"].includes(key)) ?? "body", "unknown_field", "Remove the unsupported membership field.");
  const actor = actorFrom(raw.actor);
  if (!actor) return fieldError("actor", "invalid_actor", "Include a user or system actor with a Site-local reference.");
  const expectedVersion = versionFrom(raw.expected_version, "expected_version");
  if (expectedVersion instanceof Response) return expectedVersion;
  const expectedArtworkVersion = versionFrom(raw.expected_artwork_version, "expected_artwork_version");
  if (expectedArtworkVersion instanceof Response) return expectedArtworkVersion;
  return withApiIdempotency(request, site, raw, async (client) => {
    await lockSite(client, site.siteId);
    const collection = await readCollection(client, site.siteId, collectionId, true);
    const artwork = await readArtwork(client, site.siteId, artworkId, true);
    const membership = await client.query<MembershipRow>(
      "select artwork_id, position from hpos.collection_artworks where site_id = $1 and collection_id = $2 and artwork_id = $3 for update",
      [site.siteId, collectionId, artworkId],
    );
    if (!membership.rows[0]) fail(404, "not_found", "The Artwork is not a member of this Collection.");
    if (collection.version !== expectedVersion || artwork.version !== expectedArtworkVersion) fail(409, "version_conflict", "The Collection or Artwork has changed; reread both and retry.");
    await client.query("delete from hpos.collection_artworks where site_id = $1 and collection_id = $2 and artwork_id = $3", [site.siteId, collectionId, artworkId]);
    await client.query(
      `update hpos.collection_artworks set position = position - 1
        where site_id = $1 and collection_id = $2 and position > $3`,
      [site.siteId, collectionId, membership.rows[0].position],
    );
    const collectionResult = await client.query<CollectionRow>(
      `update hpos.collections set version = version + 1, updated_at = clock_timestamp(), updated_actor_type = $3, updated_actor_reference = $4
       where site_id = $1 and collection_id = $2
       returning collection_id, site_id, name, description, is_active, position, version,
                 created_at, updated_at, created_actor_type, created_actor_reference,
                 updated_actor_type, updated_actor_reference`,
      [site.siteId, collectionId, actor.type, actor.reference],
    );
    await client.query(
      `update hpos.artworks set version = version + 1, updated_at = clock_timestamp(), updated_actor_type = $3, updated_actor_reference = $4
       where site_id = $1 and artwork_id = $2`,
      [site.siteId, artworkId, actor.type, actor.reference],
    );
    const updatedArtwork = await readAdminArtwork(client, site.siteId, artworkId);
    if (!updatedArtwork) fail(404, "not_found", "The Artwork is not available to this Site.");
    return { status: 200, data: { collection: collectionData(collectionResult.rows[0]), artwork: updatedArtwork } };
  }, mapDatabaseError);
}

async function putArtworkOrder(request: Request, site: AuthenticatedSite, collectionId: string): Promise<Response> {
  if (!COLLECTION_ID_PATTERN.test(collectionId)) return apiFailure(404, "not_found", "The Collection is not available to this Site.");
  const raw = await readJsonBody(request);
  if (raw instanceof Response) return raw;
  if (!hasOnlyKeys(raw, ["artwork_ids", "expected_version", "actor"])) return fieldError(Object.keys(raw).find((key) => !["artwork_ids", "expected_version", "actor"].includes(key)) ?? "body", "unknown_field", "Remove the unsupported Artwork order field.");
  const actor = actorFrom(raw.actor);
  if (!actor) return fieldError("actor", "invalid_actor", "Include a user or system actor with a Site-local reference.");
  const expectedVersion = versionFrom(raw.expected_version, "expected_version");
  if (expectedVersion instanceof Response) return expectedVersion;
  if (!Array.isArray(raw.artwork_ids) || raw.artwork_ids.some((id) => typeof id !== "string" || !ARTWORK_ID_PATTERN.test(id))) return fieldError("artwork_ids", "invalid_array", "artwork_ids must contain valid Artwork identifiers.");
  const artworkIds = raw.artwork_ids as string[];
  if (new Set(artworkIds).size !== artworkIds.length) return fieldError("artwork_ids", "duplicate_id", "artwork_ids must contain each member exactly once.");
  return withApiIdempotency(request, site, raw, async (client) => {
    await lockSite(client, site.siteId);
    const collection = await readCollection(client, site.siteId, collectionId, true);
    if (collection.version !== expectedVersion) fail(409, "version_conflict", "The Collection has changed; reread it and retry.");
    const current = await membershipRows(client, site.siteId, collectionId);
    const expected = current.map((row) => row.artwork_id);
    if (expected.length !== artworkIds.length || expected.some((id) => !artworkIds.includes(id))) {
      fail(422, "validation_failed", "artwork_ids must contain every current member exactly once and no other IDs.", [{ field: "artwork_ids", code: "complete_list_required", message: "Provide every current member exactly once." }]);
    }
    const unchanged = expected.every((id, index) => id === artworkIds[index]);
    if (unchanged) return { status: 200, data: collectionData(collection) };
    await client.query("update hpos.collection_artworks set position = position + $3 where site_id = $1 and collection_id = $2", [site.siteId, collectionId, POSITION_OFFSET]);
    await client.query(
      `update hpos.collection_artworks ca
          set position = ordered.position
         from unnest($3::text[]) with ordinality as ordered(artwork_id, position)
        where ca.site_id = $1 and ca.collection_id = $2 and ca.artwork_id = ordered.artwork_id`,
      [site.siteId, collectionId, artworkIds],
    );
    const collectionResult = await client.query<CollectionRow>(
      `update hpos.collections set version = version + 1, updated_at = clock_timestamp(), updated_actor_type = $3, updated_actor_reference = $4
       where site_id = $1 and collection_id = $2
       returning collection_id, site_id, name, description, is_active, position, version,
                 created_at, updated_at, created_actor_type, created_actor_reference,
                 updated_actor_type, updated_actor_reference`,
      [site.siteId, collectionId, actor.type, actor.reference],
    );
    return { status: 200, data: collectionData(collectionResult.rows[0]) };
  }, mapDatabaseError);
}

export async function handleCollectionGet(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (path.length === 2 && path[0] === "admin" && path[1] === "collections") return listCollections(request, site);
  if (path.length === 3 && path[0] === "admin" && path[1] === "collections") return readCollectionDetail(site, path[2]);
  if (path.length === 4 && path[0] === "admin" && path[1] === "collections" && path[3] === "artworks") return listMemberships(request, site, path[2]);
  return null;
}

export async function handleCollectionPost(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (path.length === 2 && path[0] === "admin" && path[1] === "collections") return createCollection(request, site);
  return null;
}

export async function handleCollectionPatch(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (path.length === 3 && path[0] === "admin" && path[1] === "collections") return patchCollection(request, site, path[2]);
  return null;
}

export async function handleCollectionPut(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (path.length === 5 && path[0] === "admin" && path[1] === "collections" && path[3] === "artworks") return putMembership(request, site, path[2], path[4]);
  if (path.length === 4 && path[0] === "admin" && path[1] === "collections" && path[3] === "artwork-order") return putArtworkOrder(request, site, path[2]);
  return null;
}

export async function handleCollectionDelete(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (path.length === 5 && path[0] === "admin" && path[1] === "collections" && path[3] === "artworks") return deleteMembership(request, site, path[2], path[4]);
  return null;
}
