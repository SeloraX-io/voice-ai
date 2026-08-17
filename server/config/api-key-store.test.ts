import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { FINGERPRINT_CHARS, MAX_KEYS, MAX_NAME_CHARS } from "../../lib/api-keys/types";
import { freshDb, startTestMongo, stopTestMongo, unreachableDb } from "../db/test-db";
import { createApiKeyStore } from "./api-key-store";

before(startTestMongo);
after(stopTestMongo);

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Waits for the fire-and-forget lastUsedAt write kicked off by verify(). */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

test("a fresh store lists nothing", async () => {
  const store = createApiKeyStore(await freshDb());
  assert.deepEqual(await store.list(), []);
});

test("mint returns the plaintext key once, and a summary", async () => {
  const store = createApiKeyStore(await freshDb());
  const minted = await store.mint("gateway");

  assert.equal(typeof minted.key, "string");
  assert.equal(minted.key.length, 43);
  assert.equal(minted.record.name, "gateway");
  assert.equal(minted.record.lastUsedAt, null);
  assert.equal(minted.record.fingerprint.length, FINGERPRINT_CHARS);
});

test("the plaintext key is never stored", async () => {
  const getDb = await freshDb();
  const store = createApiKeyStore(getDb);
  const minted = await store.mint("gateway");

  const db = await getDb();
  const docs = await db.collection("api_keys").find({}).toArray();
  assert.equal(JSON.stringify(docs).includes(minted.key), false);
  assert.equal((docs[0] as unknown as { hash: string }).hash, sha256Hex(minted.key));
});

test("list is newest first", async () => {
  const store = createApiKeyStore(await freshDb());
  await store.mint("older");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await store.mint("newer");

  assert.deepEqual(
    (await store.list()).map((key) => key.name),
    ["newer", "older"],
  );
});

test("mint rejects a blank name", async () => {
  const store = createApiKeyStore(await freshDb());
  await assert.rejects(() => store.mint("   "), /name/i);
});

test("mint rejects an over-long name", async () => {
  const store = createApiKeyStore(await freshDb());
  await assert.rejects(() => store.mint("x".repeat(MAX_NAME_CHARS + 1)), /at most/);
});

test("mint refuses past the key cap", async () => {
  const store = createApiKeyStore(await freshDb());
  for (let index = 0; index < MAX_KEYS; index += 1) await store.mint(`key-${index}`);
  await assert.rejects(() => store.mint("one too many"), /Revoke one first/);
});

test("verify accepts a minted key", async () => {
  const store = createApiKeyStore(await freshDb());
  const minted = await store.mint("gateway");

  const verified = await store.verify(minted.key);
  assert.equal(verified?.id, minted.record.id);
});

test("verify rejects an unknown, blank or malformed key", async () => {
  const store = createApiKeyStore(await freshDb());
  await store.mint("gateway");

  assert.equal(await store.verify("not-a-key"), null);
  assert.equal(await store.verify(""), null);
  assert.equal(await store.verify("   "), null);
  assert.equal(await store.verify("x".repeat(300)), null);
});

test("verify stamps lastUsedAt", async () => {
  const store = createApiKeyStore(await freshDb());
  const minted = await store.mint("gateway");

  const verified = await store.verify(minted.key);
  assert.ok(verified?.lastUsedAt);
  await settle();

  const [listed] = await store.list();
  assert.equal(listed.lastUsedAt, verified?.lastUsedAt);
});

test("revoke removes a key and returns true", async () => {
  const store = createApiKeyStore(await freshDb());
  const minted = await store.mint("gateway");

  assert.equal(await store.revoke(minted.record.id), true);
  assert.deepEqual(await store.list(), []);
});

test("revoking something that is not there returns false", async () => {
  const store = createApiKeyStore(await freshDb());
  assert.equal(await store.revoke("no-such-id"), false);
});

test("a revoked key stops verifying", async () => {
  const store = createApiKeyStore(await freshDb());
  const minted = await store.mint("gateway");
  await store.revoke(minted.record.id);

  assert.equal(await store.verify(minted.key), null);
});

test("concurrent mints across two store instances all survive", async () => {
  // The case server/config/api-key-store.ts used to document as BROKEN: two
  // processes each rewriting the whole key file would lose each other's mints.
  const getDb = await freshDb();
  const gateway = createApiKeyStore(getDb);
  const console_ = createApiKeyStore(getDb);

  await Promise.all([
    gateway.mint("a"),
    console_.mint("b"),
    gateway.mint("c"),
    console_.mint("d"),
  ]);

  assert.equal((await gateway.list()).length, 4);
});

test("a usage stamp landing after a revoke does not resurrect the key", async () => {
  const getDb = await freshDb();
  const gateway = createApiKeyStore(getDb);
  const console_ = createApiKeyStore(getDb);
  const minted = await gateway.mint("gateway");

  await gateway.verify(minted.key);
  await console_.revoke(minted.record.id);
  await settle();

  assert.deepEqual(await console_.list(), []);
});

test("an unreachable database throws from verify, so the gateway fails closed", async () => {
  const store = createApiKeyStore(unreachableDb(), () => {});
  await assert.rejects(() => store.verify("anything-at-all"));
});

test("an unreachable database throws from list", async () => {
  const store = createApiKeyStore(unreachableDb(), () => {});
  await assert.rejects(() => store.list());
});
