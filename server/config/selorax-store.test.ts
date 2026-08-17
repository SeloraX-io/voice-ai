import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { EMPTY_SELORAX_CONFIG } from "../../lib/selorax/config";
import { freshDb, startTestMongo, stopTestMongo, unreachableDb } from "../db/test-db";
import { createSeloraxStore } from "./selorax-store";

before(startTestMongo);
after(stopTestMongo);

const CONFIG = {
  baseUrl: "https://api.selorax.io",
  authToken: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE3ODk1MDAwMDB9.sig",
  storeId: "42",
};

test("an unwritten store reads as empty config", async () => {
  const store = createSeloraxStore(await freshDb());
  assert.deepEqual(await store.read(), EMPTY_SELORAX_CONFIG);
});

test("writes and reads back", async () => {
  const store = createSeloraxStore(await freshDb());
  await store.write(CONFIG);
  assert.deepEqual(await store.read(), CONFIG);
});

test("a second write replaces the first", async () => {
  const store = createSeloraxStore(await freshDb());
  await store.write(CONFIG);
  await store.write({ ...CONFIG, storeId: "99" });
  assert.equal((await store.read()).storeId, "99");
});

test("a document that fails validation reads as empty rather than throwing", async () => {
  const getDb = await freshDb();
  const db = await getDb();
  // baseUrl present but authToken and storeId missing: not the all-empty case,
  // so the validator reports errors rather than returning EMPTY.
  await db
    .collection("selorax_config")
    .insertOne({ _id: "singleton", value: { baseUrl: "https://x.test" } } as never);

  const messages: string[] = [];
  const store = createSeloraxStore(getDb, (message) => messages.push(message));

  assert.deepEqual(await store.read(), EMPTY_SELORAX_CONFIG);
  assert.equal(messages.length, 1);
});

test("a bad document is left in place, not overwritten", async () => {
  const getDb = await freshDb();
  const db = await getDb();
  await db
    .collection("selorax_config")
    .insertOne({ _id: "singleton", value: { baseUrl: "https://x.test" } } as never);

  const store = createSeloraxStore(getDb, () => {});
  await store.read();

  const doc = await db.collection("selorax_config").findOne({ _id: "singleton" as never });
  assert.equal((doc as unknown as { value: { baseUrl: string } }).value.baseUrl, "https://x.test");
});

test("never logs the contents of a bad document", async () => {
  const getDb = await freshDb();
  const db = await getDb();
  await db
    .collection("selorax_config")
    .insertOne({ _id: "singleton", value: { baseUrl: "secret-token" } } as never);

  const messages: string[] = [];
  const store = createSeloraxStore(getDb, (message) => messages.push(message));
  await store.read();

  assert.ok(!messages.join(" ").includes("secret-token"));
});

test("an unreachable database throws rather than reading as empty", async () => {
  const store = createSeloraxStore(unreachableDb(), () => {});
  await assert.rejects(() => store.read());
});

test("concurrent writes leave one coherent result, not a mix", async () => {
  const store = createSeloraxStore(await freshDb());
  await Promise.all([
    store.write({ ...CONFIG, storeId: "1" }),
    store.write({ ...CONFIG, storeId: "2" }),
    store.write({ ...CONFIG, storeId: "3" }),
  ]);

  const saved = await store.read();
  assert.ok(["1", "2", "3"].includes(saved.storeId));
});
