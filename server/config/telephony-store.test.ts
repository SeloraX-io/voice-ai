import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { EMPTY_CREDENTIALS } from "../../lib/telephony/credentials";
import { createTelephonyStore } from "./telephony-store";

async function freshDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "telephony-"));
}

const CREDS = {
  wsUrl: "wss://sip.example.com:8089/ws",
  sipUri: "sip:ext-8@sip.example.com",
  sipDomain: "sip.example.com",
  extension: "ext-8",
  password: "s3cret",
};

test("an unwritten store reads as empty credentials", async () => {
  const store = createTelephonyStore(await freshDir());
  assert.deepEqual(await store.read(), EMPTY_CREDENTIALS);
});

test("writes and reads back", async () => {
  const store = createTelephonyStore(await freshDir());
  await store.write(CREDS);
  assert.deepEqual(await store.read(), CREDS);
});

test("a corrupt file reads as empty rather than throwing", async () => {
  const dir = await freshDir();
  await writeFile(path.join(dir, "telephony.json"), "{ not json", "utf8");

  const messages: string[] = [];
  const store = createTelephonyStore(dir, (message) => messages.push(message));

  assert.deepEqual(await store.read(), EMPTY_CREDENTIALS);
  assert.equal(messages.length, 1);
});

test("never logs the contents of a corrupt file", async () => {
  const dir = await freshDir();
  await writeFile(path.join(dir, "telephony.json"), '{"password":"hunter2" ', "utf8");

  const messages: string[] = [];
  const store = createTelephonyStore(dir, (message) => messages.push(message));
  await store.read();

  assert.ok(!messages.join(" ").includes("hunter2"));
});

test("concurrent writes leave one coherent result, not a mix", async () => {
  const store = createTelephonyStore(await freshDir());
  await Promise.all([
    store.write({ ...CREDS, extension: "ext-1" }),
    store.write({ ...CREDS, extension: "ext-2" }),
    store.write({ ...CREDS, extension: "ext-3" }),
  ]);

  const saved = await store.read();
  assert.ok(["ext-1", "ext-2", "ext-3"].includes(saved.extension));
});

test("writes JSON that round-trips", async () => {
  const dir = await freshDir();
  const store = createTelephonyStore(dir);
  await store.write(CREDS);

  const parsed = JSON.parse(await readFile(path.join(dir, "telephony.json"), "utf8"));
  assert.equal(parsed.extension, "ext-8");
});
