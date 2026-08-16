import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FINGERPRINT_CHARS } from "../../lib/api-keys/types";
import { createApiKeyStore } from "./api-key-store";

async function freshDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "api-keys-"));
}

/** The usage file, read straight off disk. */
async function usage(dir: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(path.join(dir, "api-keys-usage.json"), "utf8"));
  } catch {
    return {};
  }
}

/** Polls until `read` returns something, for the writes made behind an answer. */
async function eventually<T>(read: () => Promise<T | null>): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the expected write never landed");
}

test("an unwritten store lists no keys", async () => {
  const store = createApiKeyStore(await freshDir());
  assert.deepEqual(await store.list(), []);
});

test("a minted key verifies", async () => {
  const store = createApiKeyStore(await freshDir());
  const minted = await store.mint("Softphone bridge");

  const verified = await store.verify(minted.key);
  assert.notEqual(verified, null);
  assert.equal(verified?.id, minted.record.id);
  assert.equal(verified?.name, "Softphone bridge");
});

test("the plaintext key comes back only from mint", async () => {
  const dir = await freshDir();
  const store = createApiKeyStore(dir);
  const minted = await store.mint("Bridge");

  // Nothing else ever hands it back: not the listing, not the file.
  assert.ok(!JSON.stringify(await store.list()).includes(minted.key));
  assert.ok(!(await readFile(path.join(dir, "api-keys.json"), "utf8")).includes(minted.key));
});

test("list leaks neither the plaintext nor the full hash", async () => {
  const dir = await freshDir();
  const store = createApiKeyStore(dir);
  const minted = await store.mint("Bridge");

  const stored = JSON.parse(await readFile(path.join(dir, "api-keys.json"), "utf8")) as Array<{
    hash: string;
  }>;
  const hash = stored[0].hash;
  assert.equal(hash.length, 64);

  const listed = JSON.stringify(await store.list());
  assert.ok(!listed.includes(minted.key));
  assert.ok(!listed.includes(hash));

  // A short fingerprint is fine — it names a key without being one.
  const [summary] = await store.list();
  assert.equal(summary.fingerprint.length, FINGERPRINT_CHARS);
  assert.ok(hash.startsWith(summary.fingerprint));
});

test("a revoked key stops verifying", async () => {
  const store = createApiKeyStore(await freshDir());
  const minted = await store.mint("Doomed");

  assert.equal(await store.revoke(minted.record.id), true);
  assert.equal(await store.verify(minted.key), null);
  assert.deepEqual(await store.list(), []);
});

test("revoking an unknown id reports that nothing was removed", async () => {
  const store = createApiKeyStore(await freshDir());
  await store.mint("Kept");

  assert.equal(await store.revoke("not-an-id"), false);
  assert.equal((await store.list()).length, 1);
});

test("an unknown key does not verify", async () => {
  const store = createApiKeyStore(await freshDir());
  await store.mint("Real");

  assert.equal(await store.verify("definitely-not-the-key"), null);
});

test("an empty or absurdly long presentation is rejected without hashing it", async () => {
  const store = createApiKeyStore(await freshDir());
  await store.mint("Real");

  assert.equal(await store.verify(""), null);
  assert.equal(await store.verify("   "), null);
  assert.equal(await store.verify("x".repeat(10_000)), null);
});

test("a key of a different length is rejected rather than throwing", async () => {
  // timingSafeEqual throws on a length mismatch, so the comparison is made on
  // fixed-length digests. A truncated key must fail, not crash the upgrade.
  const store = createApiKeyStore(await freshDir());
  const minted = await store.mint("Real");

  assert.equal(await store.verify(minted.key.slice(0, 10)), null);
  assert.equal(await store.verify(`${minted.key}extra`), null);
});

test("a record with a malformed hash is ignored rather than throwing", async () => {
  const dir = await freshDir();
  await writeFile(
    path.join(dir, "api-keys.json"),
    JSON.stringify([
      { id: "1", name: "Hand edited", hash: "abc", createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null },
    ]),
    "utf8",
  );
  const store = createApiKeyStore(dir);

  assert.equal(await store.verify("anything"), null);
});

test("a corrupt file reads as no keys", async () => {
  const dir = await freshDir();
  await writeFile(path.join(dir, "api-keys.json"), "{ not json", "utf8");

  const messages: string[] = [];
  const store = createApiKeyStore(dir, (message) => messages.push(message));

  assert.deepEqual(await store.list(), []);
  assert.equal(await store.verify("anything"), null);
  assert.ok(messages.length > 0);
});

test("never logs the contents of a corrupt file", async () => {
  const dir = await freshDir();
  await writeFile(path.join(dir, "api-keys.json"), '[{"hash":"deadbeefcafe" ', "utf8");

  const messages: string[] = [];
  const store = createApiKeyStore(dir, (message) => messages.push(message));
  await store.list();
  await store.verify("anything");

  assert.ok(!messages.join(" ").includes("deadbeefcafe"));
});

test("concurrent mints all survive", async () => {
  // A read-modify-write per mint: without serialisation the last rename wins
  // and the other keys are silently lost, which is the bug the secrets store
  // had. Every one of these must still open a call afterwards.
  const store = createApiKeyStore(await freshDir());
  const minted = await Promise.all([
    store.mint("one"),
    store.mint("two"),
    store.mint("three"),
    store.mint("four"),
    store.mint("five"),
  ]);

  assert.equal((await store.list()).length, 5);
  for (const entry of minted) {
    assert.notEqual(await store.verify(entry.key), null);
  }
});

test("two keys minted together are different keys", async () => {
  const store = createApiKeyStore(await freshDir());
  const [a, b] = await Promise.all([store.mint("a"), store.mint("b")]);

  assert.notEqual(a.key, b.key);
  assert.notEqual(a.record.id, b.record.id);
  assert.equal(await store.verify(a.key).then((found) => found?.name), "a");
  assert.equal(await store.verify(b.key).then((found) => found?.name), "b");
});

test("verify reports and records when a key was last used", async () => {
  const store = createApiKeyStore(await freshDir());
  const minted = await store.mint("Bridge");
  assert.equal(minted.record.lastUsedAt, null);

  const verified = await store.verify(minted.key);
  assert.notEqual(verified?.lastUsedAt, null);

  // The stamp is written behind the answer, so the listing catches up shortly
  // after rather than at the same instant.
  const summary = await eventually(async () => {
    const [entry] = await store.list();
    return entry.lastUsedAt === null ? null : entry;
  });
  assert.ok(!Number.isNaN(Date.parse(summary.lastUsedAt ?? "")));
});

test("a verification succeeds even when the stamp cannot be written", async () => {
  // An unwritable data directory must cost the telemetry, never the answer:
  // a full disk would otherwise refuse every correct key and take the bridge
  // down with it.
  const dir = await freshDir();
  const messages: string[] = [];
  const store = createApiKeyStore(dir, (message) => messages.push(message));
  const minted = await store.mint("Bridge");

  await chmod(dir, 0o500);
  try {
    const verified = await store.verify(minted.key);
    assert.notEqual(verified, null);
    assert.equal(verified?.name, "Bridge");
    // And again, so a wedged write queue cannot take the second call down.
    assert.notEqual(await store.verify(minted.key), null);

    // Proof the write really did fail rather than the test passing by luck.
    await eventually(async () =>
      messages.some((message) => message.includes("last used")) ? true : null,
    );
  } finally {
    await chmod(dir, 0o700);
  }
});

test("a failed verification does not stamp anything", async () => {
  const store = createApiKeyStore(await freshDir());
  await store.mint("Bridge");
  await store.verify("wrong");
  await new Promise((resolve) => setTimeout(resolve, 50));

  const [summary] = await store.list();
  assert.equal(summary.lastUsedAt, null);
});

test("mint refuses a blank name", async () => {
  const store = createApiKeyStore(await freshDir());
  await assert.rejects(() => store.mint("   "));
  assert.deepEqual(await store.list(), []);
});

test("mint refuses an over-long name", async () => {
  const store = createApiKeyStore(await freshDir());
  await assert.rejects(() => store.mint("n".repeat(500)));
});

test("a stamp cannot bring back a key revoked by another process", async () => {
  // Two stores on one directory is what actually runs: Next mints and revokes,
  // the gateway verifies, and the in-process queue serialises neither against
  // the other. A "last used" write must never resurrect a revoked key.
  const dir = await freshDir();
  const gateway = createApiKeyStore(dir);
  const console_ = createApiKeyStore(dir);
  const minted = await console_.mint("Bridge");

  assert.notEqual(await gateway.verify(minted.key), null);
  assert.equal(await console_.revoke(minted.record.id), true);
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.deepEqual(await console_.list(), []);
  assert.equal(await gateway.verify(minted.key), null);
});

test("usage for a revoked key is forgotten rather than kept forever", async () => {
  const dir = await freshDir();
  const store = createApiKeyStore(dir);
  const first = await store.mint("first");
  const second = await store.mint("second");

  await store.verify(first.key);
  await eventually(async () => ((await usage(dir))[first.record.id] ? true : null));

  await store.revoke(first.record.id);
  await store.verify(second.key);

  const remaining = await eventually(async () => {
    const entries = await usage(dir);
    return entries[second.record.id] ? entries : null;
  });
  assert.deepEqual(Object.keys(remaining), [second.record.id]);
});

test("both files are owner-only", async () => {
  const dir = await freshDir();
  const store = createApiKeyStore(dir);
  const minted = await store.mint("Bridge");
  await store.verify(minted.key);
  await eventually(async () => ((await usage(dir))[minted.record.id] ? true : null));

  for (const name of ["api-keys.json", "api-keys-usage.json"]) {
    assert.equal((await stat(path.join(dir, name))).mode & 0o777, 0o600, name);
  }
});

test("newest keys are listed first", async () => {
  const store = createApiKeyStore(await freshDir());
  await store.mint("older");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await store.mint("newer");

  assert.deepEqual(
    (await store.list()).map((key) => key.name),
    ["newer", "older"],
  );
});
