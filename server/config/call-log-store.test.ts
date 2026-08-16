import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { EMPTY_USAGE, type CallRecord } from "../../lib/call-logs/types";
import { createCallLogStore, MAX_RECORDS } from "./call-log-store";

async function freshDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "call-logs-"));
}

function record(id: string): CallRecord {
  return {
    id,
    startedAt: "2026-08-16T10:00:00.000Z",
    endedAt: "2026-08-16T10:01:00.000Z",
    durationMs: 60_000,
    model: "gemini-3.1-flash-live-preview",
    voice: "Kore",
    usage: { ...EMPTY_USAGE, inputAudioTokens: 1000, reports: 1 },
    cost: { inputUsd: 0.003, outputUsd: 0, totalUsd: 0.003 },
    turns: 2,
    interruptions: 0,
    timeToFirstAudioMs: 800,
    endedBy: "caller",
  };
}

test("an unwritten history reads as empty", async () => {
  const store = createCallLogStore(await freshDir());
  assert.deepEqual(await store.read(), []);
});

test("appends and reads back newest first", async () => {
  const store = createCallLogStore(await freshDir());
  await store.append(record("first"));
  await store.append(record("second"));

  const all = await store.read();
  assert.deepEqual(
    all.map((entry) => entry.id),
    ["second", "first"],
  );
});

test("a corrupt history reads as empty rather than throwing", async () => {
  const dir = await freshDir();
  await writeFile(path.join(dir, "call-logs.json"), "{ not json", "utf8");

  const messages: string[] = [];
  const store = createCallLogStore(dir, (message) => messages.push(message));

  assert.deepEqual(await store.read(), []);
  assert.equal(messages.length, 1);
});

test("never logs the contents of a corrupt history", async () => {
  const dir = await freshDir();
  await writeFile(path.join(dir, "call-logs.json"), '[{"id":"secret-ish-value" ', "utf8");

  const messages: string[] = [];
  const store = createCallLogStore(dir, (message) => messages.push(message));
  await store.read();

  assert.ok(!messages.join(" ").includes("secret-ish-value"));
});

test("concurrent appends do not lose a record", async () => {
  const store = createCallLogStore(await freshDir());
  await Promise.all([store.append(record("a")), store.append(record("b")), store.append(record("c"))]);

  const ids = (await store.read()).map((entry) => entry.id).sort();
  assert.deepEqual(ids, ["a", "b", "c"]);
});

test("keeps only the most recent MAX_RECORDS, dropping the oldest", async () => {
  const dir = await freshDir();
  const store = createCallLogStore(dir);

  // Seed past the cap directly, so the test does not make 500 sequential writes.
  const seeded = Array.from({ length: MAX_RECORDS + 3 }, (_, i) => record(`old-${i}`));
  await writeFile(path.join(dir, "call-logs.json"), JSON.stringify(seeded), "utf8");

  await store.append(record("newest"));

  const all = await store.read();
  assert.equal(all.length, MAX_RECORDS);
  assert.equal(all[0].id, "newest");
  // The four oldest are gone: three over the cap, plus one displaced by the append.
  assert.ok(!all.some((entry) => entry.id === "old-0"));
  assert.ok(!all.some((entry) => entry.id === "old-3"));
});

test("writes valid JSON that round-trips", async () => {
  const dir = await freshDir();
  const store = createCallLogStore(dir);
  await store.append(record("only"));

  const raw = await readFile(path.join(dir, "call-logs.json"), "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].cost.totalUsd, 0.003);
});
