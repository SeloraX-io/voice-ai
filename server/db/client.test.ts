import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { ensureIndexes } from "./client";
import { freshDb, startTestMongo, stopTestMongo } from "./test-db";

before(startTestMongo);
after(stopTestMongo);

test("ensureIndexes creates the call-log and api-key indexes", async () => {
  const getDb = await freshDb();
  const db = await getDb();

  const callLogIndexes = await db.collection("call_logs").indexes();
  assert.ok(callLogIndexes.some((index) => index.key.startedAt === -1));

  const apiKeyIndexes = await db.collection("api_keys").indexes();
  const hashIndex = apiKeyIndexes.find((index) => index.key.hash === 1);
  assert.ok(hashIndex);
  assert.equal(hashIndex.unique, true);
});

test("ensureIndexes is idempotent", async () => {
  const getDb = await freshDb();
  const db = await getDb();
  await ensureIndexes(db);
  await ensureIndexes(db);

  const indexes = await db.collection("api_keys").indexes();
  assert.equal(indexes.filter((index) => index.key.hash === 1).length, 1);
});

test("the unique hash index rejects a duplicate", async () => {
  const getDb = await freshDb();
  const db = await getDb();
  await db.collection("api_keys").insertOne({ _id: "a", hash: "same" } as never);

  await assert.rejects(
    () => db.collection("api_keys").insertOne({ _id: "b", hash: "same" } as never),
    /duplicate key/i,
  );
});
