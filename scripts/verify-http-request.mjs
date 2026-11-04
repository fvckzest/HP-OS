import assert from "node:assert/strict";
import { isUuid, MAX_JSON_BODY_BYTES, parseSiteActor, readJsonObject } from "../src/server/http-request.ts";

const messages = {
  unsupportedMediaType: "Send JSON.",
  readError: "The body could not be read.",
  invalidJson: "The body is not valid JSON.",
  nonObject: "The body must be an object.",
};

function request(body, headers = { "content-type": "application/json" }) {
  return new Request("http://localhost/v1/test", {
    method: "POST",
    headers,
    body,
  });
}

async function errorCode(result, status, code) {
  assert(result instanceof Response);
  assert.equal(result.status, status);
  const body = await result.json();
  assert.equal(body.error.code, code);
}

const valid = await readJsonObject(request('{"ok":true}'), messages);
assert.deepEqual(valid, { ok: true });

await errorCode(await readJsonObject(request("{}", { "content-type": "text/plain" }), messages), 415, "unsupported_media_type");
await errorCode(await readJsonObject(request("{", undefined), messages), 400, "invalid_request");
await errorCode(await readJsonObject(request("[]"), messages), 400, "invalid_request");

const prefix = '{"padding":"';
const suffix = '"}';
const exactBody = prefix + "x".repeat(MAX_JSON_BODY_BYTES - prefix.length - suffix.length) + suffix;
assert.equal(Buffer.byteLength(exactBody, "utf8"), MAX_JSON_BODY_BYTES);
const exact = await readJsonObject(request(exactBody), messages);
assert(!(exact instanceof Response));
assert.equal(exact.padding.length, MAX_JSON_BODY_BYTES - prefix.length - suffix.length);

let cancelled = false;
const oversizedStream = new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode("x".repeat(MAX_JSON_BODY_BYTES + 1)));
  },
  cancel() {
    cancelled = true;
  },
});
const oversized = await readJsonObject(new Request("http://localhost/v1/test", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: oversizedStream,
  duplex: "half",
}), messages);
await errorCode(oversized, 413, "request_too_large");
assert.equal(cancelled, true);

const chunks = ["{\"chunked\":", "true}"];
const streamed = new ReadableStream({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    controller.close();
  },
});
const chunked = await readJsonObject(new Request("http://localhost/v1/test", {
  method: "POST",
  headers: { "content-type": "application/json; charset=utf-8" },
  body: streamed,
  duplex: "half",
}), messages);
assert.deepEqual(chunked, { chunked: true });

const actor = parseSiteActor({ type: "system", reference: " worker:local " });
assert.deepEqual(actor, { type: "system", reference: "worker:local" });
assert.equal(parseSiteActor({ type: "system", reference: " worker:local " }, { trimReference: false }), null);
assert.equal(parseSiteActor({ type: "system", reference: "not allowed" }), null);
assert.equal(isUuid("1f8d1f5d-b7a4-4aa5-b0e3-8bb7a5e3d9e2"), true);
assert.equal(isUuid("not-a-uuid"), false);

console.log("HTTP request parsing verification passed.");
