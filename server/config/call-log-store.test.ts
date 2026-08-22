import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { EMPTY_USAGE, type CallRecord, type CallSummary } from "../../lib/call-logs/types";
import { freshDb, startTestMongo, stopTestMongo, unreachableDb } from "../db/test-db";
import { createCallLogStore } from "./call-log-store";

before(startTestMongo);
after(stopTestMongo);

/**
 * Distinct startedAt per record. Ordering is defined by that field now, not by
 * insertion order, so records that share a timestamp have no defined order —
 * real calls never do.
 */
function record(id: string, minute = 0): CallRecord {
  return {
    id,
    startedAt: `2026-08-16T10:${String(minute).padStart(2, "0")}:00.000Z`,
    endedAt: `2026-08-16T10:${String(minute).padStart(2, "0")}:30.000Z`,
    durationMs: 30_000,
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
  const store = createCallLogStore(await freshDb());
  assert.deepEqual(await store.read(), []);
});

test("appends and reads back newest first", async () => {
  const store = createCallLogStore(await freshDb());
  await store.append(record("first", 0));
  await store.append(record("second", 1));

  const calls = await store.read();
  assert.deepEqual(
    calls.map((call) => call.id),
    ["second", "first"],
  );
});

test("a stored record round-trips field for field", async () => {
  const store = createCallLogStore(await freshDb());
  const original = record("only", 0);
  await store.append(original);

  const [saved] = await store.read();
  assert.deepEqual(saved, original);
});

test("update amends a record in place", async () => {
  const store = createCallLogStore(await freshDb());
  await store.append(record("call-1", 0));

  // CallSummary has six required fields; a partial object would not typecheck.
  const summary: CallSummary = {
    text: "They asked about opening hours.",
    language: "en",
    model: "gemini-3.1-flash",
    inputTokens: 400,
    outputTokens: 30,
    usd: 0.0001,
  };
  await store.update("call-1", (current) => ({ ...current, summary }));

  const [saved] = await store.read();
  assert.deepEqual(saved.summary, summary);
});

test("update leaves every other field alone", async () => {
  const store = createCallLogStore(await freshDb());
  await store.append(record("call-1", 0));
  await store.update("call-1", (current) => ({ ...current, turns: 99 }));

  const [saved] = await store.read();
  assert.equal(saved.turns, 99);
  assert.equal(saved.model, "gemini-3.1-flash-live-preview");
  assert.equal(saved.cost.totalUsd, 0.003);
});

test("updating a record that is not there is a no-op", async () => {
  const store = createCallLogStore(await freshDb());
  await store.append(record("call-1", 0));
  await store.update("missing", (current) => ({ ...current, turns: 99 }));

  const [saved] = await store.read();
  assert.equal(saved.turns, 2);
});

test("history is not capped", async () => {
  const store = createCallLogStore(await freshDb());
  for (let index = 0; index < 60; index += 1) {
    await store.append(record(`call-${index}`, index));
  }
  assert.equal((await store.read()).length, 60);
});

test("concurrent appends all survive", async () => {
  const store = createCallLogStore(await freshDb());
  await Promise.all([
    store.append(record("a", 0)),
    store.append(record("b", 1)),
    store.append(record("c", 2)),
  ]);

  const ids = (await store.read()).map((call) => call.id).sort();
  assert.deepEqual(ids, ["a", "b", "c"]);
});

test("an unreachable database throws rather than reading as empty", async () => {
  const store = createCallLogStore(unreachableDb(), () => {});
  await assert.rejects(() => store.read());
});

test("a client filter returns only that client's calls", async () => {
  const store = createCallLogStore(await freshDb());
  await store.append({ ...record("acme-call"), clientId: "acme" });
  await store.append({ ...record("globex-call", 1), clientId: "globex" });

  assert.deepEqual((await store.read("acme")).map((call) => call.id), ["acme-call"]);
  // No filter still reads everything.
  assert.equal((await store.read()).length, 2);
});

test("the default client owns records written before calls carried a client id", async () => {
  const store = createCallLogStore(await freshDb());
  await store.append(record("legacy-call")); // no clientId at all
  await store.append({ ...record("acme-call", 1), clientId: "acme" });
  await store.append({ ...record("default-call", 2), clientId: "singleton" });

  const ids = (await store.read("singleton")).map((call) => call.id).sort();
  assert.deepEqual(ids, ["default-call", "legacy-call"]);
});
