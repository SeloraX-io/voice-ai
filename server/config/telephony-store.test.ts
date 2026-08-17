import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { EMPTY_CREDENTIALS } from "../../lib/telephony/credentials";
import { freshDb, startTestMongo, stopTestMongo, unreachableDb } from "../db/test-db";
import { createTelephonyStore } from "./telephony-store";

before(startTestMongo);
after(stopTestMongo);

const CREDENTIALS = {
  wsUrl: "wss://pbx.test:8089/ws",
  sipUri: "sip:ext-8@pbx.test",
  sipDomain: "pbx.test",
  extension: "8",
  password: "hunter2",
};

test("an unwritten store reads as empty credentials", async () => {
  const store = createTelephonyStore(await freshDb());
  assert.deepEqual(await store.read(), EMPTY_CREDENTIALS);
});

test("writes and reads back", async () => {
  const store = createTelephonyStore(await freshDb());
  await store.write(CREDENTIALS);
  assert.deepEqual(await store.read(), CREDENTIALS);
});

test("a second write replaces the first", async () => {
  const store = createTelephonyStore(await freshDb());
  await store.write(CREDENTIALS);
  await store.write({ ...CREDENTIALS, extension: "9" });
  assert.equal((await store.read()).extension, "9");
});

test("a document that fails validation reads as empty rather than throwing", async () => {
  const getDb = await freshDb();
  const db = await getDb();
  await db
    .collection("telephony_credentials")
    .insertOne({ _id: "singleton", value: { wsUrl: "wss://pbx.test:8089/ws" } } as never);

  const messages: string[] = [];
  const store = createTelephonyStore(getDb, (message) => messages.push(message));

  assert.deepEqual(await store.read(), EMPTY_CREDENTIALS);
  assert.equal(messages.length, 1);
});

test("never logs the contents of a bad document", async () => {
  const getDb = await freshDb();
  const db = await getDb();
  await db
    .collection("telephony_credentials")
    .insertOne({ _id: "singleton", value: { wsUrl: "sip-password-here" } } as never);

  const messages: string[] = [];
  const store = createTelephonyStore(getDb, (message) => messages.push(message));
  await store.read();

  assert.ok(!messages.join(" ").includes("sip-password-here"));
});

test("an unreachable database throws rather than reading as empty", async () => {
  const store = createTelephonyStore(unreachableDb(), () => {});
  await assert.rejects(() => store.read());
});

test("concurrent writes leave one coherent result, not a mix", async () => {
  const store = createTelephonyStore(await freshDb());
  await Promise.all([
    store.write({ ...CREDENTIALS, extension: "1" }),
    store.write({ ...CREDENTIALS, extension: "2" }),
    store.write({ ...CREDENTIALS, extension: "3" }),
  ]);

  const saved = await store.read();
  assert.ok(["1", "2", "3"].includes(saved.extension));
});
