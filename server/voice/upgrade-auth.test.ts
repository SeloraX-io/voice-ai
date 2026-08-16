import { test } from "node:test";
import assert from "node:assert/strict";

import type { ApiKeySummary } from "../../lib/api-keys/types";
import { apiKeyRequired, authorizeUpgrade, readPresentedKey } from "./upgrade-auth";

const KEY: ApiKeySummary = {
  id: "key-1",
  name: "Softphone bridge",
  createdAt: "2026-08-16T10:00:00.000Z",
  lastUsedAt: null,
  fingerprint: "abcd1234",
};

/** A store that only knows one key, and records what it was asked about. */
function fakeStore(valid: string) {
  const asked: string[] = [];
  return {
    asked,
    verify: async (presented: string) => {
      asked.push(presented);
      return presented === valid ? KEY : null;
    },
  };
}

const request = (url: string, headers: Record<string, string> = {}) => ({ url, headers });

/* --- where the key is read from -------------------------------------- */

test("reads a bearer token from the Authorization header", () => {
  assert.equal(readPresentedKey(request("/voice", { authorization: "Bearer sekrit" })), "sekrit");
  assert.equal(readPresentedKey(request("/voice", { authorization: "bearer sekrit" })), "sekrit");
});

test("reads the key from the query string, because a browser cannot set headers", () => {
  assert.equal(readPresentedKey(request("/voice?key=sekrit")), "sekrit");
  assert.equal(readPresentedKey(request("/voice?channel=phone&from=1&key=sekrit&to=2")), "sekrit");
});

test("the header wins when both are present", () => {
  const found = readPresentedKey(request("/voice?key=from-query", { authorization: "Bearer from-header" }));
  assert.equal(found, "from-header");
});

test("reports no key when there is none", () => {
  assert.equal(readPresentedKey(request("/voice")), null);
  assert.equal(readPresentedKey(request("/voice?key=")), null);
  assert.equal(readPresentedKey(request("/voice?key=%20%20")), null);
  assert.equal(readPresentedKey(request("/voice", { authorization: "Basic abc" })), null);
  assert.equal(readPresentedKey(request("/voice", { authorization: "Bearer" })), null);
});

test("survives a missing or nonsense url", () => {
  assert.equal(readPresentedKey({ url: undefined, headers: {} }), null);
  assert.equal(readPresentedKey(request("not a url at all")), null);
});

/* --- the enforcement switch ------------------------------------------ */

test("enforcement is off unless it is explicitly switched on", () => {
  assert.equal(apiKeyRequired({}), false);
  assert.equal(apiKeyRequired({ VOICE_GATEWAY_REQUIRE_KEY: "" }), false);
  assert.equal(apiKeyRequired({ VOICE_GATEWAY_REQUIRE_KEY: "0" }), false);
  assert.equal(apiKeyRequired({ VOICE_GATEWAY_REQUIRE_KEY: "no" }), false);
  assert.equal(apiKeyRequired({ VOICE_GATEWAY_REQUIRE_KEY: "1" }), true);
  assert.equal(apiKeyRequired({ VOICE_GATEWAY_REQUIRE_KEY: "true" }), true);
  assert.equal(apiKeyRequired({ VOICE_GATEWAY_REQUIRE_KEY: " TRUE " }), true);
});

/* --- the decision ---------------------------------------------------- */

test("accepts anything while enforcement is off, without touching the store", async () => {
  const store = fakeStore("good");
  const decision = await authorizeUpgrade(request("/voice"), { requireKey: false, verify: store.verify });

  assert.deepEqual(decision, { ok: true, key: null });
  assert.deepEqual(store.asked, []);
});

test("rejects an unauthenticated upgrade when enforcement is on", async () => {
  const store = fakeStore("good");
  const decision = await authorizeUpgrade(request("/voice"), { requireKey: true, verify: store.verify });

  assert.equal(decision.ok, false);
  assert.equal(decision.ok === false && decision.status, 401);
  // The store is never consulted: there was nothing to look up.
  assert.deepEqual(store.asked, []);
});

test("rejects a wrong key with the same answer as no key at all", async () => {
  const store = fakeStore("good");
  const missing = await authorizeUpgrade(request("/voice"), { requireKey: true, verify: store.verify });
  const wrong = await authorizeUpgrade(request("/voice?key=bad"), {
    requireKey: true,
    verify: store.verify,
  });

  assert.equal(missing.ok, false);
  assert.equal(wrong.ok, false);
  if (missing.ok || wrong.ok) return;

  assert.equal(wrong.status, 401);
  assert.equal(missing.status, wrong.status);
  assert.equal(missing.message, wrong.message);
});

test("accepts a valid key from the query string", async () => {
  const store = fakeStore("good");
  const decision = await authorizeUpgrade(request("/voice?channel=phone&key=good"), {
    requireKey: true,
    verify: store.verify,
  });

  assert.equal(decision.ok, true);
  assert.equal(decision.ok === true && decision.key?.id, "key-1");
});

test("accepts a valid key from the Authorization header", async () => {
  const store = fakeStore("good");
  const decision = await authorizeUpgrade(request("/voice", { authorization: "Bearer good" }), {
    requireKey: true,
    verify: store.verify,
  });

  assert.equal(decision.ok, true);
  assert.equal(decision.ok === true && decision.key?.name, "Softphone bridge");
});

test("a revoked key fails the next upgrade", async () => {
  // Revocation is the store forgetting the key; from here it is simply a key
  // that no longer verifies.
  let live = true;
  const decision = async () =>
    authorizeUpgrade(request("/voice?key=good"), {
      requireKey: true,
      verify: async (presented) => (live && presented === "good" ? KEY : null),
    });

  assert.equal((await decision()).ok, true);
  live = false;
  assert.equal((await decision()).ok, false);
});
