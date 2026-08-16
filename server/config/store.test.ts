import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DEFAULT_AGENT_CONFIG } from "../../lib/agent-config/defaults";
import { createConfigStore } from "./store";

async function freshDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "agent-config-"));
}

test("returns the defaults when no config file exists", async () => {
  const store = createConfigStore(await freshDir());
  const config = await store.read();
  assert.equal(config.instructions, DEFAULT_AGENT_CONFIG.instructions);
  assert.equal(config.agentName, DEFAULT_AGENT_CONFIG.agentName);
});

test("round-trips a written config", async () => {
  const store = createConfigStore(await freshDir());
  await store.write({ ...DEFAULT_AGENT_CONFIG, agentName: "sales-bot" });
  const config = await store.read();
  assert.equal(config.agentName, "sales-bot");
});

test("stamps updatedAt on write", async () => {
  const store = createConfigStore(await freshDir());
  const before = new Date().toISOString();
  const saved = await store.write({ ...DEFAULT_AGENT_CONFIG, updatedAt: "stale" });
  assert.ok(saved.updatedAt >= before);
});

test("falls back to the defaults when the file is corrupt", async () => {
  const dir = await freshDir();
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "agent-config.json"), "{ not json", "utf8");

  const warnings: string[] = [];
  const store = createConfigStore(dir, (message) => warnings.push(message));
  const config = await store.read();

  assert.equal(config.agentName, DEFAULT_AGENT_CONFIG.agentName);
  assert.equal(warnings.length, 1);
});

test("leaves a corrupt file on disk so it stays recoverable", async () => {
  const dir = await freshDir();
  await writeFile(path.join(dir, "agent-config.json"), "{ not json", "utf8");
  const store = createConfigStore(dir, () => {});
  await store.read();
  assert.equal(await readFile(path.join(dir, "agent-config.json"), "utf8"), "{ not json");
});

test("falls back to the defaults on an unknown version", async () => {
  const dir = await freshDir();
  const future = JSON.stringify({ ...DEFAULT_AGENT_CONFIG, version: 99 });
  await writeFile(path.join(dir, "agent-config.json"), future, "utf8");

  const warnings: string[] = [];
  const store = createConfigStore(dir, (message) => warnings.push(message));
  const config = await store.read();

  assert.equal(config.version, 1);
  assert.equal(warnings.length, 1);
});

test("falls back to the defaults when welcome is missing its message", async () => {
  const dir = await freshDir();
  const malformed = JSON.stringify({ ...DEFAULT_AGENT_CONFIG, welcome: { enabled: true } });
  await writeFile(path.join(dir, "agent-config.json"), malformed, "utf8");

  const warnings: string[] = [];
  const store = createConfigStore(dir, (message) => warnings.push(message));
  const config = await store.read();

  assert.equal(config.agentName, DEFAULT_AGENT_CONFIG.agentName);
  assert.equal(config.welcome.enabled, DEFAULT_AGENT_CONFIG.welcome.enabled);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /failed validation/);
});

test("falls back to the defaults rather than throwing when variables is null", async () => {
  const dir = await freshDir();
  const malformed = JSON.stringify({ ...DEFAULT_AGENT_CONFIG, variables: null });
  await writeFile(path.join(dir, "agent-config.json"), malformed, "utf8");

  const warnings: string[] = [];
  const store = createConfigStore(dir, (message) => warnings.push(message));
  const config = await store.read();

  assert.deepEqual(config.variables, DEFAULT_AGENT_CONFIG.variables);
  assert.equal(warnings.length, 1);
});

test("a valid stored config round-trips its own updatedAt rather than being restamped", async () => {
  const dir = await freshDir();
  const store = createConfigStore(dir);
  const saved = await store.write({ ...DEFAULT_AGENT_CONFIG, agentName: "sales-bot" });

  const config = await store.read();
  assert.equal(config.updatedAt, saved.updatedAt);
  assert.equal(config.agentName, "sales-bot");
});

test("lists no secret keys before any are set", async () => {
  const store = createConfigStore(await freshDir());
  assert.deepEqual(await store.listSecretKeys(), []);
});

test("stores, lists and deletes a secret", async () => {
  const store = createConfigStore(await freshDir());
  await store.setSecret("CRM_API_KEY", "abc123");
  await store.setSecret("OTHER_KEY", "xyz");
  assert.deepEqual((await store.listSecretKeys()).sort(), ["CRM_API_KEY", "OTHER_KEY"]);

  await store.deleteSecret("OTHER_KEY");
  assert.deepEqual(await store.listSecretKeys(), ["CRM_API_KEY"]);
});

test("replaces an existing secret rather than duplicating it", async () => {
  const store = createConfigStore(await freshDir());
  await store.setSecret("CRM_API_KEY", "first");
  await store.setSecret("CRM_API_KEY", "second");
  assert.deepEqual(await store.listSecretKeys(), ["CRM_API_KEY"]);
});

test("rejects a secret key that is not upper snake case", async () => {
  const store = createConfigStore(await freshDir());
  await assert.rejects(() => store.setSecret("lower-case", "x"), /key/i);
});

test("writes the secrets file with owner-only permissions", async () => {
  const dir = await freshDir();
  const store = createConfigStore(dir);
  await store.setSecret("CRM_API_KEY", "abc");
  const { stat } = await import("node:fs/promises");
  const mode = (await stat(path.join(dir, "agent-secrets.json"))).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("never leaks a secret value through the config read path", async () => {
  const dir = await freshDir();
  const store = createConfigStore(dir);
  await store.setSecret("CRM_API_KEY", "super-secret-value");
  const serialised = JSON.stringify(await store.read());
  assert.ok(!serialised.includes("super-secret-value"));
});

test("does not lose a secret when writes overlap", async () => {
  const store = createConfigStore(await freshDir());
  await Promise.all([
    store.setSecret("FIRST_KEY", "1"),
    store.setSecret("SECOND_KEY", "2"),
    store.setSecret("THIRD_KEY", "3"),
  ]);
  assert.deepEqual(await store.listSecretKeys(), ["FIRST_KEY", "SECOND_KEY", "THIRD_KEY"]);
});

test("returns a fresh object graph on every fallback read", async () => {
  const store = createConfigStore(await freshDir());
  const first = await store.read();
  const second = await store.read();
  assert.notEqual(first.models, second.models);
  assert.notEqual(first.models.vad, second.models.vad);
  assert.notEqual(first.variables, second.variables);
  assert.deepEqual(first, second);
});
