import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_AGENT_CONFIG } from "../../lib/agent-config/defaults";
import { AGENT_CONFIG_VERSION, LIMITS } from "../../lib/agent-config/schema";
import { freshDb, startTestMongo, stopTestMongo, unreachableDb } from "../db/test-db";
import { createConfigStore } from "./store";

before(startTestMongo);
after(stopTestMongo);

test("an unwritten store reads the seed defaults", async () => {
  const store = createConfigStore(await freshDb());
  assert.deepEqual(await store.read(), DEFAULT_AGENT_CONFIG);
});

test("each fallback read gets its own object graph", async () => {
  const store = createConfigStore(await freshDb());
  const first = await store.read();
  const second = await store.read();
  assert.notEqual(first.models, second.models);
});

test("writes and reads back", async () => {
  const store = createConfigStore(await freshDb());
  const saved = await store.write({ ...DEFAULT_AGENT_CONFIG, agentName: "ada" });
  assert.equal(saved.agentName, "ada");
  assert.equal((await store.read()).agentName, "ada");
});

test("write stamps updatedAt and read preserves it", async () => {
  const store = createConfigStore(await freshDb());
  const saved = await store.write({ ...DEFAULT_AGENT_CONFIG, agentName: "ada" });
  assert.equal((await store.read()).updatedAt, saved.updatedAt);
});

test("write never persists secretKeys", async () => {
  const getDb = await freshDb();
  const store = createConfigStore(getDb);
  await store.write({ ...DEFAULT_AGENT_CONFIG, secretKeys: ["LEAKED"] });

  const db = await getDb();
  const doc = await db.collection("agent_config").findOne({ _id: "singleton" as never });
  assert.deepEqual((doc as unknown as { value: { secretKeys: string[] } }).value.secretKeys, []);
});

test("a config with an unsupported version reads as defaults", async () => {
  const getDb = await freshDb();
  const db = await getDb();
  await db.collection("agent_config").insertOne({
    _id: "singleton",
    value: { ...DEFAULT_AGENT_CONFIG, version: AGENT_CONFIG_VERSION + 1, agentName: "ada" },
  } as never);

  const messages: string[] = [];
  const store = createConfigStore(getDb, (message) => messages.push(message));

  assert.equal((await store.read()).agentName, DEFAULT_AGENT_CONFIG.agentName);
  assert.equal(messages.length, 1);
});

test("a config that fails validation reads as defaults and is left in place", async () => {
  const getDb = await freshDb();
  const db = await getDb();
  await db.collection("agent_config").insertOne({
    _id: "singleton",
    value: { version: AGENT_CONFIG_VERSION, instructions: 12345 },
  } as never);

  const messages: string[] = [];
  const store = createConfigStore(getDb, (message) => messages.push(message));
  assert.deepEqual(await store.read(), DEFAULT_AGENT_CONFIG);
  assert.equal(messages.length, 1);

  const doc = await db.collection("agent_config").findOne({ _id: "singleton" as never });
  assert.equal((doc as unknown as { value: { instructions: number } }).value.instructions, 12345);
});

test("an unreachable database throws from read rather than returning defaults", async () => {
  const store = createConfigStore(unreachableDb(), () => {});
  await assert.rejects(() => store.read());
});

test("secrets round-trip", async () => {
  const store = createConfigStore(await freshDb());
  await store.setSecret("STRIPE_KEY", "sk_live_1");
  assert.deepEqual(await store.resolveSecrets(), { STRIPE_KEY: "sk_live_1" });
});

test("setSecret overwrites an existing value", async () => {
  const store = createConfigStore(await freshDb());
  await store.setSecret("STRIPE_KEY", "one");
  await store.setSecret("STRIPE_KEY", "two");
  assert.deepEqual(await store.resolveSecrets(), { STRIPE_KEY: "two" });
});

test("listSecretKeys returns names sorted, never values", async () => {
  const store = createConfigStore(await freshDb());
  await store.setSecret("ZEBRA", "z");
  await store.setSecret("ALPHA", "a");
  assert.deepEqual(await store.listSecretKeys(), ["ALPHA", "ZEBRA"]);
});

test("deleteSecret removes one and leaves the rest", async () => {
  const store = createConfigStore(await freshDb());
  await store.setSecret("ALPHA", "a");
  await store.setSecret("BETA", "b");
  await store.deleteSecret("ALPHA");
  assert.deepEqual(await store.listSecretKeys(), ["BETA"]);
});

test("deleting a secret that is not there is a no-op", async () => {
  const store = createConfigStore(await freshDb());
  await store.setSecret("ALPHA", "a");
  await store.deleteSecret("MISSING");
  assert.deepEqual(await store.listSecretKeys(), ["ALPHA"]);
});

test("setSecret rejects a key that is not UPPER_SNAKE_CASE", async () => {
  const store = createConfigStore(await freshDb());
  await assert.rejects(() => store.setSecret("lower", "x"), /UPPER_SNAKE_CASE/);
  await assert.rejects(() => store.setSecret("9LEADING", "x"), /UPPER_SNAKE_CASE/);
});

test("setSecret rejects an over-long key", async () => {
  const store = createConfigStore(await freshDb());
  await assert.rejects(
    () => store.setSecret("A".repeat(LIMITS.secretKeyMax + 1), "x"),
    /UPPER_SNAKE_CASE/,
  );
});

test("setSecret rejects an over-long value", async () => {
  const store = createConfigStore(await freshDb());
  await assert.rejects(
    () => store.setSecret("BIG", "x".repeat(LIMITS.secretValueMax + 1)),
    /at most/,
  );
});

test("concurrent setSecret calls all survive", async () => {
  const store = createConfigStore(await freshDb());
  await Promise.all([
    store.setSecret("ONE", "1"),
    store.setSecret("TWO", "2"),
    store.setSecret("THREE", "3"),
  ]);
  assert.deepEqual(await store.listSecretKeys(), ["ONE", "THREE", "TWO"]);
});

test("resolveSecrets returns {} when the database is unreachable", async () => {
  const messages: string[] = [];
  const store = createConfigStore(unreachableDb(), (message) => messages.push(message));
  assert.deepEqual(await store.resolveSecrets(), {});
  assert.equal(messages.length, 1);
});

test("listSecretKeys throws when the database is unreachable", async () => {
  const store = createConfigStore(unreachableDb(), () => {});
  await assert.rejects(() => store.listSecretKeys());
});
