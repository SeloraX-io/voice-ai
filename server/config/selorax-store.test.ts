import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { EMPTY_SELORAX_CONFIG } from "../../lib/selorax/config";
import { createSeloraxStore } from "./selorax-store";

async function freshDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "selorax-"));
}

const CONFIG = {
  baseUrl: "https://api.selorax.io",
  authToken: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE3ODk1MDAwMDB9.sig",
  storeId: "42",
};

test("an unwritten store reads as empty config", async () => {
  const store = createSeloraxStore(await freshDir());
  assert.deepEqual(await store.read(), EMPTY_SELORAX_CONFIG);
});

test("writes and reads back", async () => {
  const store = createSeloraxStore(await freshDir());
  await store.write(CONFIG);
  assert.deepEqual(await store.read(), CONFIG);
});

test("a corrupt file reads as empty rather than throwing", async () => {
  const dir = await freshDir();
  await writeFile(path.join(dir, "selorax.json"), "{ not json", "utf8");

  const messages: string[] = [];
  const store = createSeloraxStore(dir, (message) => messages.push(message));

  assert.deepEqual(await store.read(), EMPTY_SELORAX_CONFIG);
  assert.equal(messages.length, 1);
});

test("never logs the contents of a corrupt file", async () => {
  const dir = await freshDir();
  await writeFile(path.join(dir, "selorax.json"), '{"authToken":"secret-token-value" ', "utf8");

  const messages: string[] = [];
  const store = createSeloraxStore(dir, (message) => messages.push(message));
  await store.read();

  assert.ok(!messages.join(" ").includes("secret-token-value"));
});

test("concurrent writes leave one coherent result, not a mix", async () => {
  const store = createSeloraxStore(await freshDir());
  await Promise.all([
    store.write({ ...CONFIG, storeId: "1" }),
    store.write({ ...CONFIG, storeId: "2" }),
    store.write({ ...CONFIG, storeId: "3" }),
  ]);

  const saved = await store.read();
  assert.ok(["1", "2", "3"].includes(saved.storeId));
});

test("writes JSON that round-trips", async () => {
  const dir = await freshDir();
  const store = createSeloraxStore(dir);
  await store.write(CONFIG);

  const parsed = JSON.parse(await readFile(path.join(dir, "selorax.json"), "utf8"));
  assert.equal(parsed.storeId, "42");
});
