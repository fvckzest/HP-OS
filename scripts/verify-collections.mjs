import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.HPOS_VERIFY_COLLECTIONS_PORT ?? 3281);
const origin = `http://127.0.0.1:${port}`;
const databaseUrl = process.env.HPOS_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const env = { ...process.env, NODE_ENV: "development", HPOS_DATABASE_URL: databaseUrl, NEXT_TELEMETRY_DISABLED: "1" };
const pool = new pg.Pool({ connectionString: databaseUrl, max: 3, connectionTimeoutMillis: 2_000 });
const organizationIds = [];
const siteIds = [];
let app;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function tamperCursor(cursor) {
  assert(typeof cursor === "string" && cursor.length > 1, "The API returned an unusable cursor for tampering.");
  const replacement = cursor[0] === "A" ? "B" : "A";
  return `${replacement}${cursor.slice(1)}`;
}

function assertConsecutive(rows, label) {
  assert(rows.every((row, index) => row.position === index + 1), `${label} positions were not consecutive and one-based.`);
}

function assertSerializedConflict(result, label) {
  assert(result.response.status === 409 && result.data?.error?.code === "version_conflict", `${label} did not report the expected stale-version conflict: ${JSON.stringify(result.data)}`);
}

async function retryInProgress(result, retry, label) {
  for (let attempt = 0; result.response.status === 409 && result.data?.error?.code === "request_in_progress" && attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    result = await retry();
  }
  assert(!(result.response.status === 409 && result.data?.error?.code === "request_in_progress"), `${label} did not settle after retrying with the same Idempotency-Key.`);
  return result;
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
      [`Issue 121 Collection verification ${randomUUID()}`],
    )).rows[0].id;
    organizationIds.push(organizationId);
    const siteOneId = (await client.query(
      "insert into hpos.sites (organization_id, name) values ($1, $2) returning id",
      [organizationId, "Issue 121 Collection Site One"],
    )).rows[0].id;
    const siteTwoId = (await client.query(
      "insert into hpos.sites (organization_id, name) values ($1, $2) returning id",
      [organizationId, "Issue 121 Collection Site Two"],
    )).rows[0].id;
    siteIds.push(siteOneId, siteTwoId);
    const firstKey = makeKey();
    const secondKey = makeKey();
    await client.query(
      "insert into hpos.site_api_keys (id, site_id, key_hash) values ($1, $2, $3), ($4, $5, $6)",
      [firstKey.id, siteOneId, firstKey.hash, secondKey.id, siteTwoId, secondKey.hash],
    );
    await client.query("commit");
    return {
      first: { siteId: siteOneId, apiKey: firstKey.value },
      second: { siteId: siteTwoId, apiKey: secondKey.value },
    };
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
    ["sites", "select count(*)::int as count from hpos.sites where id = any($1::uuid[])", siteIds],
    ["site API keys", "select count(*)::int as count from hpos.site_api_keys where site_id = any($1::uuid[])", siteIds],
    ["rate limit windows", "select count(*)::int as count from hpos.site_request_windows where site_id = any($1::uuid[])", siteIds],
    ["idempotency records", "select count(*)::int as count from hpos.api_idempotency_records where site_id = any($1::uuid[])", siteIds],
    ["Artworks", "select count(*)::int as count from hpos.artworks where site_id = any($1::uuid[])", siteIds],
    ["Collections", "select count(*)::int as count from hpos.collections where site_id = any($1::uuid[])", siteIds],
    ["Collection memberships", "select count(*)::int as count from hpos.collection_artworks where site_id = any($1::uuid[])", siteIds],
  ];
  for (const [label, query, ids] of checks) {
    const result = await pool.query(query, [ids]);
    const count = Number(result.rows[0]?.count ?? 0);
    if (count !== 0) throw new Error(`Collection fixture cleanup left ${count} ${label}.`);
  }
  console.log("Collection fixture cleanup passed: no fixture organizations, Sites, keys, rate windows, idempotency records, Artworks, Collections, or memberships remain.");
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
    if (server.child.exitCode !== null) throw new Error(`The Collection verification app stopped early.\n${server.output}`);
    try {
      const response = await fetch(`${origin}/v1/admin/payment-configuration`, { signal: AbortSignal.timeout(2_000) });
      if (response.status === 401) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`The Collection verification app did not become ready.\n${server.output}`);
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

async function createArtwork(site, suffix) {
  const result = await api(site, "/v1/admin/artworks", {
    method: "POST",
    idempotencyKey: randomUUID(),
    body: {
      actor: { type: "user", reference: "test:issue-121" },
      title: `Collection Artwork ${suffix}`,
      displayed_artwork_id: `COL-121-${suffix}`,
    },
  });
  assert(result.response.status === 201, `Artwork ${suffix} could not be created: ${JSON.stringify(result.data)}`);
  return result.data.data;
}

async function createCollection(site, name) {
  const body = { actor: { type: "user", reference: "test:issue-121" }, name };
  const key = randomUUID();
  const result = await api(site, "/v1/admin/collections", { method: "POST", idempotencyKey: key, body });
  assert(result.response.status === 201, `Collection ${name} could not be created: ${JSON.stringify(result.data)}`);
  const replay = await api(site, "/v1/admin/collections", { method: "POST", idempotencyKey: key, body });
  assert(replay.response.status === 201 && replay.data.data.collection_id === result.data.data.collection_id, "Collection creation was not idempotent.");
  if (name === "First Collection") {
    const conflict = await api(site, "/v1/admin/collections", {
      method: "POST", idempotencyKey: key,
      body: { ...body, name: "Different Collection" },
    });
    assert(conflict.response.status === 409 && conflict.data.error.code === "idempotency_conflict", "A reused Collection Idempotency-Key with a different body was accepted.");
  }
  return result.data.data;
}

async function assertPortFree() {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`Verification port ${port} is already in use.`)));
    server.listen(port, "127.0.0.1", () => server.close((error) => error ? reject(error) : resolve()));
  });
}

async function verifyCollections(fixtures) {
  const actor = { type: "user", reference: "test:issue-121" };
  const artworkOne = await createArtwork(fixtures.first, "A");
  const artworkTwo = await createArtwork(fixtures.first, "B");
  const collectionOne = await createCollection(fixtures.first, "First Collection");
  const collectionTwo = await createCollection(fixtures.first, "Second Collection");
  const collectionThree = await createCollection(fixtures.first, "Third Collection");

  const ownRead = await api(fixtures.first, `/v1/admin/collections/${collectionOne.collection_id}`);
  assert(ownRead.response.status === 200 && ownRead.data.data.name === "First Collection" && ownRead.data.data.position === 1, "The owning Site could not read its Collection.");
  const ownEditKey = randomUUID();
  const ownEditBody = { actor, expected_version: collectionOne.version, name: "Edited First Collection", description: "Edited by issue 121 verification." };
  const ownEdit = await api(fixtures.first, `/v1/admin/collections/${collectionOne.collection_id}`, {
    method: "PATCH", idempotencyKey: ownEditKey, body: ownEditBody,
  });
  assert(ownEdit.response.status === 200 && ownEdit.data.data.name === "Edited First Collection" && ownEdit.data.data.description === "Edited by issue 121 verification.", "The owning Site could not edit Collection name and description.");
  const ownEditReplay = await api(fixtures.first, `/v1/admin/collections/${collectionOne.collection_id}`, {
    method: "PATCH", idempotencyKey: ownEditKey, body: ownEditBody,
  });
  assert(ownEditReplay.response.status === 200 && ownEditReplay.data.data.name === ownEdit.data.data.name && ownEditReplay.data.data.version === ownEdit.data.data.version, "Collection PATCH replay did not return its saved result.");
  const ownEditConflict = await api(fixtures.first, `/v1/admin/collections/${collectionOne.collection_id}`, {
    method: "PATCH", idempotencyKey: ownEditKey,
    body: { ...ownEditBody, name: "Different Collection Name" },
  });
  assert(ownEditConflict.response.status === 409 && ownEditConflict.data.error.code === "idempotency_conflict", "A reused Collection PATCH Idempotency-Key with a different body was accepted.");

  const listed = await api(fixtures.first, "/v1/admin/collections?limit=1");
  assert(listed.response.status === 200 && listed.data.data.length === 1 && listed.data.pagination.next_cursor, "Collection list did not return a signed next cursor.");
  const secondPage = await api(fixtures.first, `/v1/admin/collections?limit=1&cursor=${encodeURIComponent(listed.data.pagination.next_cursor)}`);
  assert(secondPage.response.status === 200 && secondPage.data.data.length === 1, "The signed Collection cursor did not retrieve the next page.");
  const invalidCursor = await api(fixtures.first, "/v1/admin/collections?cursor=bad.cursor");
  assert(invalidCursor.response.status === 422 && invalidCursor.data.error.code === "invalid_cursor", "An invalid Collection cursor was accepted.");
  const otherSiteCursor = await api(fixtures.second, `/v1/admin/collections?limit=1&cursor=${encodeURIComponent(listed.data.pagination.next_cursor)}`);
  assert(otherSiteCursor.response.status === 422 && otherSiteCursor.data.error.code === "invalid_cursor", "A cursor signed for one Site was accepted by another Site.");

  const moved = await api(fixtures.first, `/v1/admin/collections/${collectionThree.collection_id}`, {
    method: "PATCH", idempotencyKey: randomUUID(), body: { actor, expected_version: 1, position: 1 },
  });
  assert(moved.response.status === 200 && moved.data.data.position === 1 && moved.data.data.version === 2, "Collection position move did not advance the moved Collection version.");
  const orderAfterMove = await api(fixtures.first, "/v1/admin/collections");
  assert(orderAfterMove.data.data.map((row) => row.collection_id).join() === [collectionThree.collection_id, collectionOne.collection_id, collectionTwo.collection_id].join(), "Collection positions were not compact after a move.");
  const staleMove = await api(fixtures.first, `/v1/admin/collections/${collectionOne.collection_id}`, {
    method: "PATCH", idempotencyKey: randomUUID(), body: { actor, expected_version: 1, name: "Stale" },
  });
  assert(staleMove.response.status === 409 && staleMove.data.error.code === "version_conflict", "A stale Collection edit was accepted.");

  const inactiveMembership = await api(fixtures.first, `/v1/admin/collections/${collectionTwo.collection_id}/artworks/${artworkOne.artwork_id}`, {
    method: "PUT", idempotencyKey: randomUUID(),
    body: { actor, expected_version: 2, expected_artwork_version: artworkOne.version },
  });
  assert(inactiveMembership.response.status === 200 && inactiveMembership.data.data.collection.collection_id === collectionTwo.collection_id && inactiveMembership.data.data.artwork.artwork_id === artworkOne.artwork_id, "The inactive Collection membership could not be created.");
  let artworkOneVersion = inactiveMembership.data.data.artwork.version;
  const inactive = await api(fixtures.first, `/v1/admin/collections/${collectionTwo.collection_id}`, {
    method: "PATCH", idempotencyKey: randomUUID(), body: { actor, expected_version: inactiveMembership.data.data.collection.version, is_active: false },
  });
  assert(inactive.response.status === 200 && inactive.data.data.is_active === false, "Collection deactivation failed.");
  const inactiveMembers = await api(fixtures.first, `/v1/admin/collections/${collectionTwo.collection_id}/artworks`);
  assert(inactiveMembers.response.status === 200 && inactiveMembers.data.data.length === 1 && inactiveMembers.data.data[0].artwork.artwork_id === artworkOne.artwork_id, "Deactivating a Collection did not preserve its Artwork membership.");

  let version = moved.data.data.version;
  const addOneKey = randomUUID();
  const addOne = await api(fixtures.first, `/v1/admin/collections/${collectionThree.collection_id}/artworks/${artworkOne.artwork_id}`, {
    method: "PUT", idempotencyKey: addOneKey, body: { actor, expected_version: version, expected_artwork_version: artworkOneVersion },
  });
  assert(addOne.response.status === 200 && Object.keys(addOne.data.data).sort().join() === "artwork,collection" && addOne.data.data.collection.collection_id === collectionThree.collection_id && addOne.data.data.artwork.artwork_id === artworkOne.artwork_id, "Adding an Artwork to a Collection returned the wrong result shape.");
  version = addOne.data.data.collection.version;
  artworkOneVersion = addOne.data.data.artwork.version;
  const addOneReplay = await api(fixtures.first, `/v1/admin/collections/${collectionThree.collection_id}/artworks/${artworkOne.artwork_id}`, {
    method: "PUT", idempotencyKey: addOneKey, body: { actor, expected_version: moved.data.data.version, expected_artwork_version: inactiveMembership.data.data.artwork.version },
  });
  assert(addOneReplay.response.status === 200 && addOneReplay.data.data.collection.version === version && addOneReplay.data.data.artwork.version === artworkOneVersion, "A repeated membership request did not replay its saved result.");
  const addOneConflict = await api(fixtures.first, `/v1/admin/collections/${collectionThree.collection_id}/artworks/${artworkOne.artwork_id}`, {
    method: "PUT", idempotencyKey: addOneKey, body: { actor: { ...actor, reference: "test:issue-121-conflict" }, expected_version: moved.data.data.version, expected_artwork_version: inactiveMembership.data.data.artwork.version },
  });
  assert(addOneConflict.response.status === 409 && addOneConflict.data.error.code === "idempotency_conflict", "A reused membership Idempotency-Key with a different body was accepted.");
  const repeat = await api(fixtures.first, `/v1/admin/collections/${collectionThree.collection_id}/artworks/${artworkOne.artwork_id}`, {
    method: "PUT", idempotencyKey: randomUUID(), body: { actor, expected_version: version, expected_artwork_version: artworkOneVersion },
  });
  assert(repeat.response.status === 200 && repeat.data.data.collection.version === version && repeat.data.data.artwork.version === artworkOneVersion && !Object.hasOwn(repeat.data.data, "membership"), "A repeated membership add changed versions or returned the wrong shape.");
  const addTwo = await api(fixtures.first, `/v1/admin/collections/${collectionThree.collection_id}/artworks/${artworkTwo.artwork_id}`, {
    method: "PUT", idempotencyKey: randomUUID(), body: { actor, expected_version: version, expected_artwork_version: artworkTwo.version },
  });
  assert(addTwo.response.status === 200 && addTwo.data.data.collection.version === version + 1 && addTwo.data.data.artwork.artwork_id === artworkTwo.artwork_id, "A second Artwork was not appended independently.");
  const staleMembership = await api(fixtures.first, `/v1/admin/collections/${collectionThree.collection_id}/artworks/${artworkOne.artwork_id}`, {
    method: "PUT", idempotencyKey: randomUUID(), body: { actor, expected_version: version, expected_artwork_version: artworkOneVersion },
  });
  assert(staleMembership.response.status === 409 && staleMembership.data.error.code === "version_conflict", "A stale membership mutation was accepted.");

  const members = await api(fixtures.first, `/v1/admin/collections/${collectionThree.collection_id}/artworks?limit=1`);
  assert(members.response.status === 200 && members.data.data.length === 1 && members.data.data[0].artwork.artwork_id === artworkOne.artwork_id && members.data.pagination.next_cursor, "Memberships were not listed in order with a signed next cursor.");
  const membersSecondPage = await api(fixtures.first, `/v1/admin/collections/${collectionThree.collection_id}/artworks?limit=1&cursor=${encodeURIComponent(members.data.pagination.next_cursor)}`);
  assert(membersSecondPage.response.status === 200 && membersSecondPage.data.data.length === 1 && membersSecondPage.data.data[0].artwork.artwork_id === artworkTwo.artwork_id && !membersSecondPage.data.pagination.next_cursor, "The signed membership cursor did not retrieve the final page.");
  const tamperedMembershipCursor = await api(fixtures.first, `/v1/admin/collections/${collectionThree.collection_id}/artworks?limit=1&cursor=${encodeURIComponent(tamperCursor(members.data.pagination.next_cursor))}`);
  assert(tamperedMembershipCursor.response.status === 422 && tamperedMembershipCursor.data.error.code === "invalid_cursor", "A tampered membership cursor was accepted.");
  const foreignMembershipCursor = await api(fixtures.second, `/v1/admin/collections/${collectionThree.collection_id}/artworks?limit=1&cursor=${encodeURIComponent(members.data.pagination.next_cursor)}`);
  assert(foreignMembershipCursor.response.status === 422 && foreignMembershipCursor.data.error.code === "invalid_cursor", "A membership cursor signed for one Site was accepted by another Site.");
  const reorderKey = randomUUID();
  const reorderBody = { actor, expected_version: addTwo.data.data.collection.version, artwork_ids: [artworkTwo.artwork_id, artworkOne.artwork_id] };
  const reordered = await api(fixtures.first, `/v1/admin/collections/${collectionThree.collection_id}/artwork-order`, {
    method: "PUT", idempotencyKey: reorderKey, body: reorderBody,
  });
  assert(reordered.response.status === 200 && Object.keys(reordered.data.data).sort().join() === "collection_id,description,is_active,name,position,version" && reordered.data.data.collection_id === collectionThree.collection_id, "Artwork order replacement returned the wrong result shape.");
  const reorderReplay = await api(fixtures.first, `/v1/admin/collections/${collectionThree.collection_id}/artwork-order`, {
    method: "PUT", idempotencyKey: reorderKey, body: reorderBody,
  });
  assert(reorderReplay.response.status === 200 && reorderReplay.data.data.version === reordered.data.data.version, "Artwork-order replay did not return its saved result.");
  const reorderConflict = await api(fixtures.first, `/v1/admin/collections/${collectionThree.collection_id}/artwork-order`, {
    method: "PUT", idempotencyKey: reorderKey,
    body: { ...reorderBody, actor: { ...actor, reference: "test:issue-121-order-conflict" } },
  });
  assert(reorderConflict.response.status === 409 && reorderConflict.data.error.code === "idempotency_conflict", "A reused Artwork-order Idempotency-Key with a different body was accepted.");
  const reorderedMembers = await api(fixtures.first, `/v1/admin/collections/${collectionThree.collection_id}/artworks`);
  assert(reorderedMembers.response.status === 200 && reorderedMembers.data.data[0].artwork.artwork_id === artworkTwo.artwork_id, "Artwork order replacement failed.");
  const removeKey = randomUUID();
  const removeBody = { actor, expected_version: reordered.data.data.version, expected_artwork_version: addTwo.data.data.artwork.version };
  const removed = await api(fixtures.first, `/v1/admin/collections/${collectionThree.collection_id}/artworks/${artworkTwo.artwork_id}`, {
    method: "DELETE", idempotencyKey: removeKey, body: removeBody,
  });
  assert(removed.response.status === 200 && Object.keys(removed.data.data).sort().join() === "artwork,collection" && removed.data.data.collection.collection_id === collectionThree.collection_id && removed.data.data.artwork.artwork_id === artworkTwo.artwork_id, "Membership removal returned the wrong result shape.");
  const removeReplay = await api(fixtures.first, `/v1/admin/collections/${collectionThree.collection_id}/artworks/${artworkTwo.artwork_id}`, {
    method: "DELETE", idempotencyKey: removeKey, body: removeBody,
  });
  assert(removeReplay.response.status === 200 && removeReplay.data.data.collection.version === removed.data.data.collection.version && removeReplay.data.data.artwork.version === removed.data.data.artwork.version, "Membership DELETE replay did not return its saved result.");
  const removeConflict = await api(fixtures.first, `/v1/admin/collections/${collectionThree.collection_id}/artworks/${artworkTwo.artwork_id}`, {
    method: "DELETE", idempotencyKey: removeKey,
    body: { ...removeBody, actor: { ...actor, reference: "test:issue-121-delete-conflict" } },
  });
  assert(removeConflict.response.status === 409 && removeConflict.data.error.code === "idempotency_conflict", "A reused membership DELETE Idempotency-Key with a different body was accepted.");
  const compacted = await api(fixtures.first, `/v1/admin/collections/${collectionThree.collection_id}/artworks`);
  assert(compacted.response.status === 200 && compacted.data.data.length === 1 && compacted.data.data[0].position === 1, "Membership removal did not compact positions.");

  const collectionOneBeforeConcurrentMoves = await api(fixtures.first, `/v1/admin/collections/${collectionOne.collection_id}`);
  assert(collectionOneBeforeConcurrentMoves.response.status === 200 && collectionOneBeforeConcurrentMoves.data.data.position === 2, "The Collection ordering fixture was not at the expected position before the concurrent move test.");
  const concurrentMoveBody = { actor, expected_version: collectionOneBeforeConcurrentMoves.data.data.version };
  const concurrentMoveRequests = [1, 3].map((position) => {
    const idempotencyKey = randomUUID();
    const retry = () => api(fixtures.first, `/v1/admin/collections/${collectionOne.collection_id}`, {
      method: "PATCH", idempotencyKey, body: { ...concurrentMoveBody, position },
    });
    return { retry };
  });
  const concurrentMoveResults = await Promise.all(concurrentMoveRequests.map(({ retry }) => retry()));
  for (const [index, request] of concurrentMoveRequests.entries()) {
    concurrentMoveResults[index] = await retryInProgress(concurrentMoveResults[index], request.retry, "Concurrent Collection move");
  }
  assert(concurrentMoveResults.filter((result) => result.response.status === 200).length === 1, `Concurrent Collection moves did not serialize to one winner: ${JSON.stringify(concurrentMoveResults.map((result) => result.data))}`);
  assertSerializedConflict(concurrentMoveResults.find((result) => result.response.status !== 200), "Concurrent Collection move");
  const collectionsAfterConcurrentMove = await api(fixtures.first, "/v1/admin/collections");
  assert(collectionsAfterConcurrentMove.response.status === 200 && collectionsAfterConcurrentMove.data.data.length === 3, "The Collection list could not be read after concurrent moves.");
  assertConsecutive(collectionsAfterConcurrentMove.data.data, "Concurrent Collection move");

  const artworkThree = await createArtwork(fixtures.first, "C");
  const collectionThreeBeforeConcurrentMembership = await api(fixtures.first, `/v1/admin/collections/${collectionThree.collection_id}`);
  assert(
    collectionThreeBeforeConcurrentMembership.response.status === 200
      && collectionThreeBeforeConcurrentMembership.data.data.version >= removed.data.data.collection.version
      && collectionThreeBeforeConcurrentMembership.data.data.version <= removed.data.data.collection.version + 1,
    `The Collection move did not preserve the membership fixture's current version: ${JSON.stringify({ before: removed.data.data.collection, after: collectionThreeBeforeConcurrentMembership.data?.data })}`,
  );
  const concurrentMembershipBody = {
    actor,
    expected_version: collectionThreeBeforeConcurrentMembership.data.data.version,
    expected_artwork_version: artworkThree.version,
  };
  const concurrentMembershipRequests = Array.from({ length: 2 }, () => {
    const idempotencyKey = randomUUID();
    const retry = () => api(fixtures.first, `/v1/admin/collections/${collectionThree.collection_id}/artworks/${artworkThree.artwork_id}`, {
      method: "PUT", idempotencyKey, body: concurrentMembershipBody,
    });
    return { retry };
  });
  const concurrentMembershipResults = await Promise.all(concurrentMembershipRequests.map(({ retry }) => retry()));
  for (const [index, request] of concurrentMembershipRequests.entries()) {
    concurrentMembershipResults[index] = await retryInProgress(concurrentMembershipResults[index], request.retry, "Concurrent membership add");
  }
  assert(concurrentMembershipResults.filter((result) => result.response.status === 200).length === 1, `Concurrent membership adds did not serialize to one winner: ${JSON.stringify(concurrentMembershipResults.map((result) => result.data))}`);
  assertSerializedConflict(concurrentMembershipResults.find((result) => result.response.status !== 200), "Concurrent membership add");
  const membershipsAfterConcurrentAdd = await api(fixtures.first, `/v1/admin/collections/${collectionThree.collection_id}/artworks`);
  assert(membershipsAfterConcurrentAdd.response.status === 200 && membershipsAfterConcurrentAdd.data.data.length === 2 && membershipsAfterConcurrentAdd.data.data.map((row) => row.artwork.artwork_id).includes(artworkThree.artwork_id), "The concurrent membership add produced the wrong membership set.");
  assertConsecutive(membershipsAfterConcurrentAdd.data.data, "Concurrent membership add");

  const foreign = await api(fixtures.second, `/v1/admin/collections/${collectionThree.collection_id}`);
  assert(foreign.response.status === 404 && foreign.data.error.code === "not_found", "A different Site could read the Collection.");
  const foreignMembers = await api(fixtures.second, `/v1/admin/collections/${collectionThree.collection_id}/artworks`);
  assert(foreignMembers.response.status === 404 && foreignMembers.data.error.code === "not_found", "A different Site could list the Collection's memberships.");
  const foreignPut = await api(fixtures.second, `/v1/admin/collections/${collectionThree.collection_id}/artworks/${artworkOne.artwork_id}`, {
    method: "PUT", idempotencyKey: randomUUID(), body: { actor, expected_version: 1, expected_artwork_version: 1 },
  });
  assert(foreignPut.response.status === 404 && foreignPut.data.error.code === "not_found", "A different Site could mutate a foreign Collection membership.");
  const foreignDelete = await api(fixtures.second, `/v1/admin/collections/${collectionThree.collection_id}/artworks/${artworkOne.artwork_id}`, {
    method: "DELETE", idempotencyKey: randomUUID(), body: { actor, expected_version: 1, expected_artwork_version: 1 },
  });
  assert(foreignDelete.response.status === 404 && foreignDelete.data.error.code === "not_found", "A different Site could remove a foreign Collection membership.");
}

try {
  await assertPortFree();
  const fixtures = await createFixture();
  app = startApp();
  await waitForReady(app);
  await verifyCollections(fixtures);
  console.log("Collection verification passed: Site isolation, idempotency, guarded ordering, retained inactive records, membership lifecycle, and signed pagination.");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await stopApp(app);
  await cleanup().catch((error) => { console.error(`Collection fixture cleanup failed: ${error.message}`); process.exitCode = 1; });
  await pool.end();
}
