# Multi-Client Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** let the console run one agent per client/store (~20 today, growing), with a "＋ Add store" flow, a store switcher, and live calls / embed widgets routed to the right client's agent.

**Architecture:** a new `clients` collection is the roster. `agent_config`/`agent_secrets` change from a fixed `"singleton"` key to a `clientId` key; the Default client's id literally *is* `"singleton"`, so the existing config becomes Default with no data migration. `api_keys` gain an optional `clientId`; whichever key a gateway connection presents decides which client's config loads for that call. Console routes for agent editing move under `/clients/[clientId]/...`; Calls/Telephony/Settings stay where they are.

**Tech Stack:** Next.js 16 (App Router, async route params), MongoDB via the existing `server/config/*` stores, `node:test` + `mongodb-memory-server` for store tests, plain `ws` gateway in `server/voice/`.

**Spec:** `docs/superpowers/specs/2026-08-21-multi-client-agents-design.md`

## Global Constraints

- Per-client scope is limited to: agent config (prompt/voice/tools/secrets), the embed widget, and call-log filtering. Telephony, the API-keys page, and Selorax settings stay global.
- Routing mechanism is the API key: whichever key a gateway connection presents decides the client whose config loads.
- The Default client's id is the literal string `"singleton"` — no data migration script exists or is written.
- Client switching is URL-scoped (`/clients/[clientId]/...`), not cookie/session state.
- No delete-client, no authentication/access-control changes, no per-client telephony — all explicitly out of scope (spec §11).

---

## File Structure

New files:
- `lib/clients/types.ts` — `ClientSummary`, `DEFAULT_CLIENT_ID`, name limits.
- `server/config/client-store.ts` + `.test.ts` — the roster.
- `app/api/clients/route.ts` — `GET` (list, lazy-seeds Default), `POST` (create).
- `app/api/clients/[clientId]/route.ts` — `PATCH` (rename).
- `app/api/clients/[clientId]/agent-config/route.ts` — replaces `app/api/agent-config/route.ts`.
- `app/api/clients/[clientId]/agent-config/secrets/route.ts` — replaces `app/api/agent-config/secrets/route.ts`.
- `app/(console)/clients/page.tsx` + `components/clients/ClientsList.tsx` — the picker + "＋ Add store" form.
- `app/(console)/clients/[clientId]/layout.tsx` — loads that client's config, wraps `AgentConfigProvider`.
- `app/(console)/clients/[clientId]/{agent/conversation,agent/actions,agent/advanced,models-voice,embed}/page.tsx` — moved from their current un-scoped locations.
- `components/shell/ClientSwitcher.tsx` — sidebar dropdown + "＋ Add store".

Modified files (existing responsibility, new `clientId` dimension):
- `lib/api-keys/types.ts`, `server/config/api-key-store.ts` — `clientId` on keys.
- `server/config/store.ts` — `clientId`-parameterized agent config/secrets.
- `server/db/client.ts` — new index for `agent_secrets.clientId`.
- `lib/call-logs/types.ts`, `server/config/call-log-store.ts` — `clientId`/`clientName` on records, filtered reads.
- `server/voice/upgrade-auth.ts`, `server/voice/websocket-server.ts`, `server/voice/gemini-session.ts` — resolve and thread `clientId` through a call.
- `lib/agent-config/routes.ts`, `components/agent-config/AgentConfigProvider.tsx` — client-scoped hrefs and save endpoint.
- `components/shell/Sidebar.tsx`, `components/shell/ConsoleChrome.tsx`, `app/(console)/layout.tsx` — chrome stops owning config; nested layout does.
- `lib/embed/snippet.ts`, `lib/embed/config.ts`, `public/embed.js`, `app/embed/widget/page.tsx`, `hooks/useVoiceSession.ts`, `lib/websocket/voice-client.ts` — a widget carries its client's key end to end.
- `app/api/calls/route.ts`, `app/(console)/calls/page.tsx` — client filter.
- `app/(console)/settings/keys/page.tsx`, `components/settings/ApiKeysPanel.tsx` — client column.

Removed files:
- `app/api/agent-config/route.ts`, `app/api/agent-config/secrets/route.ts` (replaced by the `/api/clients/[clientId]/...` versions).
- `app/(console)/agent/`, `app/(console)/models-voice/`, `app/(console)/embed/` (moved under `/clients/[clientId]/`).

---

### Task 1: API keys gain a `clientId`

**Files:**
- Modify: `lib/api-keys/types.ts`
- Modify: `server/config/api-key-store.ts`
- Test: `server/config/api-key-store.test.ts`

**Interfaces:**
- Produces: `ApiKeySummary.clientId: string | null`; `apiKeyStore.mint(name: string, clientId?: string): Promise<MintedApiKey>`.

- [ ] **Step 1: Write the failing tests**

Read `server/config/api-key-store.test.ts` first to match its existing fixture style (it already uses `freshDb`/`startTestMongo` from `server/db/test-db.ts`, the same helper `store.test.ts` uses). Add:

```ts
test("mint stamps the clientId it was given", async () => {
  const store = createApiKeyStore(await freshDb());
  const minted = await store.mint("Riverside Cafe widget", "client-1");
  assert.equal(minted.record.clientId, "client-1");
});

test("mint with no clientId stores null", async () => {
  const store = createApiKeyStore(await freshDb());
  const minted = await store.mint("Softphone bridge");
  assert.equal(minted.record.clientId, null);
});

test("verify carries the clientId through", async () => {
  const store = createApiKeyStore(await freshDb());
  const minted = await store.mint("Riverside Cafe widget", "client-1");
  const verified = await store.verify(minted.key);
  assert.equal(verified?.clientId, "client-1");
});

test("list carries clientId through for every key", async () => {
  const store = createApiKeyStore(await freshDb());
  await store.mint("Scoped", "client-1");
  await store.mint("Unscoped");
  const [scoped, unscoped] = (await store.list()).sort((a, b) => a.name.localeCompare(b.name));
  assert.equal(scoped.clientId, "client-1");
  assert.equal(unscoped.clientId, null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test server/config/api-key-store.test.ts`
Expected: FAIL — `minted.record.clientId` is `undefined`, not `"client-1"` (the field doesn't exist yet).

- [ ] **Step 3: Implement**

In `lib/api-keys/types.ts`, add the field to `ApiKeySummary`:

```ts
export interface ApiKeySummary {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  fingerprint: string;
  /** The client this key belongs to, or null for a key minted before clients existed. */
  clientId: string | null;
}
```

In `server/config/api-key-store.ts`:

```ts
interface ApiKeyDoc {
  _id: string;
  name: string;
  hash: string;
  createdAt: string;
  lastUsedAt: string | null;
  clientId: string | null;
}
```

```ts
function summarise(doc: ApiKeyDoc, lastUsedAt: string | null): ApiKeySummary {
  return {
    id: doc._id,
    name: doc.name,
    createdAt: doc.createdAt,
    lastUsedAt,
    fingerprint: doc.hash.slice(0, FINGERPRINT_CHARS),
    clientId: doc.clientId ?? null,
  };
}
```

Update the `ApiKeyStore` interface's `mint` signature and its implementation:

```ts
export interface ApiKeyStore {
  list(): Promise<ApiKeySummary[]>;
  mint(name: string, clientId?: string): Promise<MintedApiKey>;
  verify(presented: string): Promise<ApiKeySummary | null>;
  revoke(id: string): Promise<boolean>;
}
```

```ts
async mint(name: string, clientId?: string): Promise<MintedApiKey> {
  const clean = name.trim();
  if (clean === "") throw new Error("Give the key a name.");
  if (clean.length > MAX_NAME_CHARS) {
    throw new Error(`The name must be at most ${MAX_NAME_CHARS} characters.`);
  }

  const keys = await collection();
  if ((await keys.countDocuments()) >= MAX_KEYS) {
    throw new Error(`There are already ${MAX_KEYS} keys. Revoke one first.`);
  }

  const key = randomBytes(32).toString("base64url");
  const doc: ApiKeyDoc = {
    _id: randomUUID(),
    name: clean,
    hash: sha256Hex(key),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    clientId: clientId ?? null,
  };
  await keys.insertOne(doc);

  return { key, record: summarise(doc, null) };
},
```

Existing docs in the database have no `clientId` field at all — `doc.clientId ?? null` in `summarise()` already treats `undefined` the same as `null`, so no backfill is needed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test server/config/api-key-store.test.ts`
Expected: PASS, including every pre-existing test in the file (none of their assertions touch `clientId`, and `summarise` still returns every field they check).

- [ ] **Step 5: Commit**

```bash
git add lib/api-keys/types.ts server/config/api-key-store.ts server/config/api-key-store.test.ts
git commit -m "feat: give API keys an optional clientId"
```

---

### Task 2: The `clients` collection — the roster

**Files:**
- Create: `lib/clients/types.ts`
- Create: `server/config/client-store.ts`
- Test: `server/config/client-store.test.ts`

**Interfaces:**
- Consumes: `apiKeyStore.mint(name, clientId?)` from Task 1 (imported directly — `client-store.ts` composes on top of `api-key-store.ts`'s exported singleton for production use, but takes the store as a constructor argument for tests, matching the codebase's `create*Store(getDatabase, log)` factory pattern).
- Produces: `ClientSummary { id, name, apiKeyId, createdAt, updatedAt }`; `DEFAULT_CLIENT_ID = "singleton"`; `clientStore.list()`, `.get(id)`, `.create(name)`, `.rename(id, name)`.

- [ ] **Step 1: Write `lib/clients/types.ts`**

```ts
/**
 * What a client/store looks like once it has left the store.
 *
 * Kept in lib/ rather than beside server/config/client-store.ts because the
 * gateway, the console pages, and the API routes all need this shape and none
 * of them should reach into the store's own document type to get it.
 */

/**
 * The Default client's id.
 *
 * Deliberately the same string the agent config and secrets collections have
 * always used for their one document (`_id: "singleton"`). That equality is
 * what lets the existing config become the Default client with no data to
 * move: the document is already sitting under this exact key.
 */
export const DEFAULT_CLIENT_ID = "singleton";

export const DEFAULT_CLIENT_NAME = "Default";

/** Ceiling on a client's name, which is free text typed in the console. */
export const MAX_CLIENT_NAME_CHARS = 80;

export interface ClientSummary {
  id: string;
  name: string;
  /** The id of this client's dedicated gateway key, or null if none was minted. */
  apiKeyId: string | null;
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// server/config/client-store.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CLIENT_ID, DEFAULT_CLIENT_NAME, MAX_CLIENT_NAME_CHARS } from "../../lib/clients/types";
import { createApiKeyStore } from "./api-key-store";
import { createClientStore } from "./client-store";
import { freshDb, startTestMongo, stopTestMongo } from "../db/test-db";

before(startTestMongo);
after(stopTestMongo);

async function stores() {
  const getDb = await freshDb();
  return { clients: createClientStore(getDb, createApiKeyStore(getDb)), apiKeys: createApiKeyStore(getDb) };
}

test("an empty roster lazily seeds the Default client on first list", async () => {
  const { clients } = await stores();
  const list = await clients.list();
  assert.deepEqual(
    list.map((c) => ({ id: c.id, name: c.name })),
    [{ id: DEFAULT_CLIENT_ID, name: DEFAULT_CLIENT_NAME }],
  );
});

test("seeding Default is idempotent across repeated lists", async () => {
  const { clients } = await stores();
  await clients.list();
  const second = await clients.list();
  assert.equal(second.length, 1);
});

test("create adds a client and mints it a dedicated key", async () => {
  const { clients, apiKeys } = await stores();
  const { client, apiKey } = await clients.create("Riverside Cafe");

  assert.equal(client.name, "Riverside Cafe");
  assert.ok(client.apiKeyId);
  assert.equal(typeof apiKey, "string");

  const verified = await apiKeys.verify(apiKey);
  assert.equal(verified?.clientId, client.id);
  assert.equal(verified?.id, client.apiKeyId);
});

test("create rejects a blank name", async () => {
  const { clients } = await stores();
  await assert.rejects(() => clients.create("   "), /name/i);
});

test("create rejects an over-long name", async () => {
  const { clients } = await stores();
  await assert.rejects(() => clients.create("x".repeat(MAX_CLIENT_NAME_CHARS + 1)), /characters/i);
});

test("list returns every created client plus Default, name ascending", async () => {
  const { clients } = await stores();
  await clients.create("Zebra Store");
  await clients.create("Alpha Store");
  const names = (await clients.list()).map((c) => c.name);
  assert.deepEqual(names, ["Alpha Store", DEFAULT_CLIENT_NAME, "Zebra Store"]);
});

test("get returns a known client and null for an unknown id", async () => {
  const { clients } = await stores();
  const { client } = await clients.create("Riverside Cafe");
  assert.equal((await clients.get(client.id))?.name, "Riverside Cafe");
  assert.equal(await clients.get("no-such-client"), null);
});

test("rename updates the name and updatedAt, and returns null for an unknown id", async () => {
  const { clients } = await stores();
  const { client } = await clients.create("Riverside Cafe");
  const renamed = await clients.rename(client.id, "Riverside Coffee Co.");
  assert.equal(renamed?.name, "Riverside Coffee Co.");
  assert.notEqual(renamed?.updatedAt, client.updatedAt);
  assert.equal(await clients.rename("no-such-client", "x"), null);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test server/config/client-store.test.ts`
Expected: FAIL — `./client-store` does not exist yet.

- [ ] **Step 4: Implement `server/config/client-store.ts`**

```ts
/**
 * Persistence for the client/store roster.
 *
 * One document per client in `clients`. The Default client (§ DEFAULT_CLIENT_ID
 * in lib/clients/types.ts) is not written by any migration — it is lazily
 * inserted the first time `list()` finds the collection empty, because the
 * agent config and secrets it "owns" already exist under that same id.
 */

import { randomUUID } from "node:crypto";

import type { Db, MongoServerError } from "mongodb";

import { DEFAULT_CLIENT_ID, DEFAULT_CLIENT_NAME, MAX_CLIENT_NAME_CHARS, type ClientSummary } from "../../lib/clients/types";
import { getDb, type DbAccessor } from "../db/client";
import { apiKeyStore, type ApiKeyStore } from "./api-key-store";

export type StoreLogger = (message: string) => void;

export interface ClientStore {
  /** Name ascending. Seeds the Default client on first call if the roster is empty. */
  list(): Promise<ClientSummary[]>;
  get(id: string): Promise<ClientSummary | null>;
  /** Validates `name`, inserts the client, and mints it a dedicated gateway key. */
  create(name: string): Promise<{ client: ClientSummary; apiKey: string }>;
  /** Returns null if `id` names no client. */
  rename(id: string, name: string): Promise<ClientSummary | null>;
}

const COLLECTION = "clients";
/** Mongo's duplicate-key error code, for the seed race in list(). */
const DUPLICATE_KEY = 11000;

interface ClientDoc {
  _id: string;
  name: string;
  apiKeyId: string | null;
  createdAt: string;
  updatedAt: string;
}

function toSummary(doc: ClientDoc): ClientSummary {
  return { id: doc._id, name: doc.name, apiKeyId: doc.apiKeyId, createdAt: doc.createdAt, updatedAt: doc.updatedAt };
}

function validateName(name: string): string {
  const clean = name.trim();
  if (clean === "") throw new Error("Give the store a name.");
  if (clean.length > MAX_CLIENT_NAME_CHARS) {
    throw new Error(`At most ${MAX_CLIENT_NAME_CHARS} characters.`);
  }
  return clean;
}

export function createClientStore(
  getDatabase: DbAccessor,
  keys: ApiKeyStore = apiKeyStore,
  log: StoreLogger = () => {},
): ClientStore {
  async function collection() {
    const db: Db = await getDatabase();
    return db.collection<ClientDoc>(COLLECTION);
  }

  return {
    async list(): Promise<ClientSummary[]> {
      const clients = await collection();
      if ((await clients.countDocuments()) === 0) {
        const now = new Date().toISOString();
        try {
          await clients.insertOne({
            _id: DEFAULT_CLIENT_ID,
            name: DEFAULT_CLIENT_NAME,
            apiKeyId: null,
            createdAt: now,
            updatedAt: now,
          });
        } catch (cause) {
          // Two concurrent first-reads can both see an empty collection; the
          // loser's insert fails on the unique _id, which is fine — the
          // winner's document is what both callers will now read below.
          if ((cause as MongoServerError).code !== DUPLICATE_KEY) throw cause;
        }
      }
      const docs = await clients.find({}).sort({ name: 1 }).toArray();
      return docs.map(toSummary);
    },

    async get(id: string): Promise<ClientSummary | null> {
      const doc = await (await collection()).findOne({ _id: id });
      return doc ? toSummary(doc) : null;
    },

    async create(name: string): Promise<{ client: ClientSummary; apiKey: string }> {
      const clean = validateName(name);

      // The id is generated up front, rather than left to Mongo, so the key
      // can be minted with the right clientId before the client document
      // exists. A key minted for a client id that never gets written is
      // harmless — it simply is not routable until this insertOne succeeds,
      // which happens right after.
      const id = randomUUID();
      const minted = await keys.mint(clean, id);
      const now = new Date().toISOString();
      const doc: ClientDoc = { _id: id, name: clean, apiKeyId: minted.record.id, createdAt: now, updatedAt: now };
      await (await collection()).insertOne(doc);

      return { client: toSummary(doc), apiKey: minted.key };
    },

    async rename(id: string, name: string): Promise<ClientSummary | null> {
      const clean = validateName(name);
      const updatedAt = new Date().toISOString();
      const result = await (await collection()).findOneAndUpdate(
        { _id: id },
        { $set: { name: clean, updatedAt } },
        { returnDocument: "after" },
      );
      return result ? toSummary(result) : null;
    },
  };
}

export const clientStore = createClientStore(getDb, apiKeyStore, (message) =>
  console.warn(`[clients] ${message}`),
);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test server/config/client-store.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/clients/types.ts server/config/client-store.ts server/config/client-store.test.ts
git commit -m "feat: add the client/store roster"
```

---

### Task 3: Agent config and secrets, keyed by client

**Files:**
- Modify: `server/config/store.ts`
- Modify: `server/config/store.test.ts`
- Modify: `server/db/client.ts:36-44` (`ensureIndexes`)

**Interfaces:**
- Produces: `ConfigStore.read(clientId)`, `.write(clientId, config)`, `.listSecretKeys(clientId)`, `.resolveSecrets(clientId)`, `.setSecret(clientId, key, value)`, `.deleteSecret(clientId, key)`.

- [ ] **Step 1: Update the failing tests**

Rewrite every test in `server/config/store.test.ts` to pass a `clientId`. The shape of each test stays the same; only the calls change. Example of the pattern to apply throughout the file (apply it to every `store.read()` / `store.write(...)` / `store.setSecret(...)` / etc. call already in the file):

```ts
const CLIENT = "client-1";

test("an unwritten store reads the seed defaults", async () => {
  const store = createConfigStore(await freshDb());
  assert.deepEqual(await store.read(CLIENT), DEFAULT_AGENT_CONFIG);
});

test("writes and reads back", async () => {
  const store = createConfigStore(await freshDb());
  const saved = await store.write(CLIENT, { ...DEFAULT_AGENT_CONFIG, agentName: "ada" });
  assert.equal(saved.agentName, "ada");
  assert.equal((await store.read(CLIENT)).agentName, "ada");
});
```

The `_id` literal in the two tests that reach into the raw collection changes from `"singleton"` to the `CLIENT` constant:

```ts
test("write never persists secretKeys", async () => {
  const getDb = await freshDb();
  const store = createConfigStore(getDb);
  await store.write(CLIENT, { ...DEFAULT_AGENT_CONFIG, secretKeys: ["LEAKED"] });

  const db = await getDb();
  const doc = await db.collection("agent_config").findOne({ _id: CLIENT as never });
  assert.deepEqual((doc as unknown as { value: { secretKeys: string[] } }).value.secretKeys, []);
});
```

Add new cases for the cross-client isolation this task exists to guarantee:

```ts
test("two clients' configs do not see each other", async () => {
  const store = createConfigStore(await freshDb());
  await store.write("client-a", { ...DEFAULT_AGENT_CONFIG, agentName: "cafe-a" });
  await store.write("client-b", { ...DEFAULT_AGENT_CONFIG, agentName: "cafe-b" });
  assert.equal((await store.read("client-a")).agentName, "cafe-a");
  assert.equal((await store.read("client-b")).agentName, "cafe-b");
});

test("two clients can each set a secret of the same name without colliding", async () => {
  const store = createConfigStore(await freshDb());
  await store.setSecret("client-a", "STRIPE_KEY", "sk_a");
  await store.setSecret("client-b", "STRIPE_KEY", "sk_b");
  assert.deepEqual(await store.resolveSecrets("client-a"), { STRIPE_KEY: "sk_a" });
  assert.deepEqual(await store.resolveSecrets("client-b"), { STRIPE_KEY: "sk_b" });
});

test("deleteSecret only touches the named client", async () => {
  const store = createConfigStore(await freshDb());
  await store.setSecret("client-a", "STRIPE_KEY", "sk_a");
  await store.setSecret("client-b", "STRIPE_KEY", "sk_b");
  await store.deleteSecret("client-a", "STRIPE_KEY");
  assert.deepEqual(await store.resolveSecrets("client-a"), {});
  assert.deepEqual(await store.resolveSecrets("client-b"), { STRIPE_KEY: "sk_b" });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test server/config/store.test.ts`
Expected: FAIL — `store.read()` etc. don't accept a `clientId` argument yet (TypeScript will refuse to compile the test file; that counts as the expected failure here).

- [ ] **Step 3: Implement**

In `server/config/store.ts`, change the interface:

```ts
export interface ConfigStore {
  read(clientId: string): Promise<AgentConfig>;
  write(clientId: string, config: AgentConfig): Promise<AgentConfig>;
  listSecretKeys(clientId: string): Promise<string[]>;
  resolveSecrets(clientId: string): Promise<Record<string, string>>;
  setSecret(clientId: string, key: string, value: string): Promise<void>;
  deleteSecret(clientId: string, key: string): Promise<void>;
}
```

Replace the fixed `SINGLETON` constant's use in the config collection with the `clientId` parameter — `agent_config`'s `_id` becomes the clientId directly:

```ts
interface ConfigDoc {
  _id: string; // clientId
  value: AgentConfig;
}

interface SecretDoc {
  _id: string; // `${clientId}:${name}`
  clientId: string;
  name: string;
  value: string;
}

function secretId(clientId: string, name: string): string {
  return `${clientId}:${name}`;
}
```

```ts
return {
  async read(clientId: string): Promise<AgentConfig> {
    const doc = await (await configs()).findOne({ _id: clientId });
    if (!doc) return structuredClone(DEFAULT_AGENT_CONFIG);

    const record = doc.value as Partial<AgentConfig> | null;
    if (typeof record !== "object" || record === null) {
      log("the stored agent config is not an object, using defaults");
      return structuredClone(DEFAULT_AGENT_CONFIG);
    }
    if (record.version !== AGENT_CONFIG_VERSION) {
      log(`the stored agent config has unsupported version ${String(record.version)}, using defaults`);
      return structuredClone(DEFAULT_AGENT_CONFIG);
    }

    const result = validateAgentConfig(record);
    if (!result.ok) {
      const summary = result.errors.map((error) => error.path || "(root)").join(", ");
      log(`the stored agent config failed validation (${summary}), using defaults`);
      return structuredClone(DEFAULT_AGENT_CONFIG);
    }

    return {
      ...result.config,
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : result.config.updatedAt,
    };
  },

  async write(clientId: string, config: AgentConfig): Promise<AgentConfig> {
    const saved: AgentConfig = {
      ...config,
      version: AGENT_CONFIG_VERSION,
      secretKeys: [],
      updatedAt: new Date().toISOString(),
    };
    await (await configs()).replaceOne({ _id: clientId }, { value: saved }, { upsert: true });
    return saved;
  },

  async resolveSecrets(clientId: string): Promise<Record<string, string>> {
    try {
      const docs = await (await secrets()).find({ clientId }).toArray();
      return Object.fromEntries(docs.map((doc) => [doc.name, doc.value]));
    } catch (cause) {
      log(`the secrets could not be read (${(cause as Error).name})`);
      return {};
    }
  },

  async listSecretKeys(clientId: string): Promise<string[]> {
    const docs = await (await secrets())
      .find({ clientId }, { projection: { name: 1 } })
      .toArray();
    return docs.map((doc) => doc.name).sort();
  },

  async setSecret(clientId: string, key: string, value: string): Promise<void> {
    if (!SECRET_KEY_RE.test(key) || key.length > LIMITS.secretKeyMax) {
      throw new Error("Secret key must be UPPER_SNAKE_CASE.");
    }
    if (value.length > LIMITS.secretValueMax) {
      throw new Error(`Secret value must be at most ${LIMITS.secretValueMax} characters.`);
    }
    await (await secrets()).updateOne(
      { _id: secretId(clientId, key) },
      { $set: { clientId, name: key, value } },
      { upsert: true },
    );
  },

  async deleteSecret(clientId: string, key: string): Promise<void> {
    await (await secrets()).deleteOne({ _id: secretId(clientId, key) });
  },
};
```

In `server/db/client.ts`, add an index for the new per-client secret lookups, alongside the two already created in `ensureIndexes` (`server/db/client.ts:36-44`):

```ts
export async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection("call_logs").createIndex({ startedAt: -1, _id: -1 }),
    db.collection("api_keys").createIndex({ hash: 1 }, { unique: true }),
    db.collection("agent_secrets").createIndex({ clientId: 1 }),
  ]);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test server/config/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/config/store.ts server/config/store.test.ts server/db/client.ts
git commit -m "feat: key agent config and secrets by client"
```

---

### Task 4: Call logs gain `clientId`/`clientName`, and a client filter

**Files:**
- Modify: `lib/call-logs/types.ts`
- Modify: `server/config/call-log-store.ts`
- Test: `server/config/call-log-store.test.ts`

**Interfaces:**
- Produces: `CallRecord.clientId?: string`, `CallRecord.clientName?: string`; `callLogStore.read(filter?: { clientId?: string })`.

- [ ] **Step 1: Add the fields to `CallRecord`**

In `lib/call-logs/types.ts`, immediately after the existing `phone` field on `CallRecord` (the field documented at `lib/call-logs/types.ts:113-119`):

```ts
  /**
   * Which client this call belongs to, and that client's name at the time of
   * the call. Absent on every record written before clients existed — read it
   * as "predates this feature," not as an error. `clientName` is a snapshot,
   * not a live join, so renaming a client later does not rewrite its history.
   */
  clientId?: string;
  clientName?: string;
```

- [ ] **Step 2: Write the failing tests**

Read `server/config/call-log-store.test.ts` first to match its existing record-building helper, then add:

```ts
test("read with no filter returns every record", async () => {
  const store = createCallLogStore(await freshDb());
  await store.append(callRecord({ id: "1", clientId: "client-a" }));
  await store.append(callRecord({ id: "2", clientId: "client-b" }));
  const all = await store.read();
  assert.equal(all.length, 2);
});

test("read filtered by clientId returns only that client's calls", async () => {
  const store = createCallLogStore(await freshDb());
  await store.append(callRecord({ id: "1", clientId: "client-a" }));
  await store.append(callRecord({ id: "2", clientId: "client-b" }));
  await store.append(callRecord({ id: "3", clientId: "client-a" }));

  const filtered = await store.read({ clientId: "client-a" });
  assert.deepEqual(filtered.map((r) => r.id).sort(), ["1", "3"]);
});

test("a record with no clientId never matches a specific-client filter", async () => {
  const store = createCallLogStore(await freshDb());
  await store.append(callRecord({ id: "legacy" })); // no clientId at all
  assert.deepEqual(await store.read({ clientId: "client-a" }), []);
  assert.equal((await store.read()).length, 1);
});
```

(`callRecord(overrides)` is whatever minimal-`CallRecord`-builder helper the existing test file already uses — extend its parameter type to accept `clientId`/`clientName` overrides if it does not already spread arbitrary overrides.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test server/config/call-log-store.test.ts`
Expected: FAIL — `store.read({...})` doesn't compile; `read` currently takes no arguments.

- [ ] **Step 4: Implement**

In `server/config/call-log-store.ts`:

```ts
export interface CallLogStore {
  /** Newest first. Pass `clientId` to see only that client's calls. */
  read(filter?: { clientId?: string }): Promise<CallRecord[]>;
  append(record: CallRecord): Promise<void>;
  update(id: string, patch: (record: CallRecord) => CallRecord): Promise<void>;
}
```

```ts
async read(filter: { clientId?: string } = {}): Promise<CallRecord[]> {
  const query = filter.clientId ? { clientId: filter.clientId } : {};
  const docs = await (await collection())
    .find(query)
    .sort({ startedAt: -1, _id: -1 })
    .toArray();
  return docs.map(toRecord);
},
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test server/config/call-log-store.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/call-logs/types.ts server/config/call-log-store.ts server/config/call-log-store.test.ts
git commit -m "feat: stamp call records with their client and filter reads by it"
```

---

### Task 5: `/api/clients` — list and create

**Files:**
- Create: `app/api/clients/route.ts`
- Test: `app/api/clients/route.test.ts` (if the codebase has no existing route-handler test convention, follow the shape of the store tests instead: call `GET`/`POST` from `route.ts` directly, the way Next route handlers are plain async functions — no HTTP server needed).

**Interfaces:**
- Consumes: `clientStore.list()`, `.create(name)` from Task 2.
- Produces: `GET /api/clients` → `{ clients: ClientSummary[] }`; `POST /api/clients` `{ name }` → `{ client: ClientSummary, apiKey: string, clients: ClientSummary[] }`.

- [ ] **Step 1: Write the failing test**

```ts
// app/api/clients/route.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { createClientStore } from "@/server/config/client-store";
import { createApiKeyStore } from "@/server/config/api-key-store";
import { freshDb, startTestMongo, stopTestMongo } from "@/server/db/test-db";

// Route handlers import the shared `clientStore` singleton directly, so these
// tests exercise `createClientStore`'s same logic through the module under
// test rather than re-importing route.ts against a live singleton — matching
// how server/config/*.test.ts already tests store logic in isolation. The
// route handler itself is a thin JSON wrapper verified by Task-6-style manual
// checks (`curl localhost:3000/api/clients`) once the dev server is running,
// consistent with this repo not standing up an HTTP layer in its test suite.

before(startTestMongo);
after(stopTestMongo);

test("list seeds and returns Default when nothing was created yet", async () => {
  const getDb = await freshDb();
  const clients = createClientStore(getDb, createApiKeyStore(getDb));
  const list = await clients.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "Default");
});
```

This test only re-confirms Task 2's behavior through the same seam the route will use — the meaningful new work in this task is the route handler itself, which is thin enough (JSON in, store call, JSON out) that its correctness is judged by matching the existing `/api/agent-config/route.ts` and `/api/api-keys/route.ts` shape exactly, not by a fresh test file. Skip creating a redundant test file; delete the block above and instead confirm the route by running the dev server after Step 2 (see Step 3 below).

- [ ] **Step 2: Implement `app/api/clients/route.ts`**

```ts
/**
 * List and create clients/stores.
 *
 * Mirrors the shape of app/api/api-keys/route.ts: GET lists, POST validates a
 * name and creates. Creating a client also mints its dedicated gateway key —
 * see server/config/client-store.ts's `create`.
 *
 * Runs on the Node runtime because the store touches the database driver.
 */

import { MongoError } from "mongodb";
import { NextResponse } from "next/server";

import { MAX_CLIENT_NAME_CHARS } from "@/lib/clients/types";
import { clientStore } from "@/server/config/client-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function badRequest(path: string, message: string): NextResponse {
  return NextResponse.json({ errors: [{ path, message }] }, { status: 400 });
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ clients: await clientStore.list() });
}

export async function POST(request: Request): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null) {
    return badRequest("", "Expected a JSON object.");
  }

  const { name } = body as { name?: unknown };
  if (typeof name !== "string" || name.trim() === "") {
    return badRequest("name", "Give the store a name.");
  }
  if (name.trim().length > MAX_CLIENT_NAME_CHARS) {
    return badRequest("name", `At most ${MAX_CLIENT_NAME_CHARS} characters.`);
  }

  try {
    const { client, apiKey } = await clientStore.create(name);
    return NextResponse.json({ client, apiKey, clients: await clientStore.list() });
  } catch (cause) {
    console.error("[clients] create failed:", (cause as Error).name);
    if (cause instanceof MongoError) {
      return NextResponse.json(
        { errors: [{ path: "", message: "Could not create the store. Try again shortly." }] },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { errors: [{ path: "", message: (cause as Error).message || "Could not create the store." }] },
      { status: 400 },
    );
  }
}
```

- [ ] **Step 3: Verify manually**

Run: `npm run dev`, then in another terminal:

```bash
curl -s localhost:3000/api/clients | jq
curl -s -X POST localhost:3000/api/clients -H 'content-type: application/json' -d '{"name":"Riverside Cafe"}' | jq
curl -s localhost:3000/api/clients | jq
```

Expected: first call returns `{"clients":[{"id":"singleton","name":"Default",...}]}`; the POST returns a `client`, a plaintext `apiKey`, and an updated `clients` array with two entries; the final GET shows both, name-ascending.

- [ ] **Step 4: Commit**

```bash
git add app/api/clients/route.ts
git commit -m "feat: add GET/POST /api/clients"
```

---

### Task 6: `/api/clients/[clientId]` — rename

**Files:**
- Create: `app/api/clients/[clientId]/route.ts`

**Interfaces:**
- Consumes: `clientStore.rename(id, name)` from Task 2.
- Produces: `PATCH /api/clients/[clientId]` `{ name }` → `{ client: ClientSummary }`, 404 if unknown.

- [ ] **Step 1: Implement**

```ts
/**
 * Rename a client/store. Nothing else about a client is editable through this
 * route — see the design spec §11 for why delete and key-reassignment are not
 * built here.
 */

import { NextResponse } from "next/server";

import { MAX_CLIENT_NAME_CHARS } from "@/lib/clients/types";
import { clientStore } from "@/server/config/client-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function badRequest(path: string, message: string): NextResponse {
  return NextResponse.json({ errors: [{ path, message }] }, { status: 400 });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ clientId: string }> },
): Promise<NextResponse> {
  const { clientId } = await params;
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null) {
    return badRequest("", "Expected a JSON object.");
  }

  const { name } = body as { name?: unknown };
  if (typeof name !== "string" || name.trim() === "") {
    return badRequest("name", "Give the store a name.");
  }
  if (name.trim().length > MAX_CLIENT_NAME_CHARS) {
    return badRequest("name", `At most ${MAX_CLIENT_NAME_CHARS} characters.`);
  }

  try {
    const client = await clientStore.rename(clientId, name);
    if (!client) {
      return NextResponse.json({ errors: [{ path: "", message: "That store no longer exists." }] }, { status: 404 });
    }
    return NextResponse.json({ client });
  } catch (cause) {
    console.error("[clients] rename failed:", (cause as Error).name);
    return NextResponse.json({ errors: [{ path: "", message: "Could not rename the store." }] }, { status: 500 });
  }
}
```

- [ ] **Step 2: Verify manually**

```bash
curl -s -X PATCH localhost:3000/api/clients/singleton -H 'content-type: application/json' -d '{"name":"Default (renamed)"}' | jq
curl -s -X PATCH localhost:3000/api/clients/no-such-id -H 'content-type: application/json' -d '{"name":"x"}' | jq
```

Expected: first returns the renamed client; second returns 404 with an error message.

- [ ] **Step 3: Commit**

```bash
git add "app/api/clients/[clientId]/route.ts"
git commit -m "feat: add PATCH /api/clients/[clientId] for renaming"
```

---

### Task 7: Gateway routing — a call loads its client's config

**Files:**
- Modify: `server/voice/upgrade-auth.ts`
- Test: `server/voice/upgrade-auth.test.ts`
- Modify: `server/voice/gemini-session.ts:81-95`
- Modify: `server/voice/websocket-server.ts` (verifyClient at `:296-318`, `CallState` interface at `:133-197`, `handleConnection` at `:359-451`, `runToolCalls`'s secrets read at `:836`, `recordCall` at `:702-729`)

**Interfaces:**
- Produces: `resolveClientId(key: ApiKeySummary | null): string` (pure, in `upgrade-auth.ts`); `loadResolvedAgentConfig(clientId: string, log?: StoreLogger): Promise<ResolvedAgentConfig>`.

- [ ] **Step 1: Write the failing test for the pure routing function**

In `server/voice/upgrade-auth.test.ts`, add:

```ts
import { DEFAULT_CLIENT_ID } from "../../lib/clients/types";
import { apiKeyRequired, authorizeUpgrade, readPresentedKey, resolveClientId } from "./upgrade-auth";

/* --- which client a connection belongs to ----------------------------- */

test("no key (enforcement off) resolves to the Default client", () => {
  assert.equal(resolveClientId(null), DEFAULT_CLIENT_ID);
});

test("a key with no clientId (minted before clients existed) resolves to Default", () => {
  assert.equal(resolveClientId({ ...KEY, clientId: null }), DEFAULT_CLIENT_ID);
});

test("a key with a clientId resolves to that client", () => {
  assert.equal(resolveClientId({ ...KEY, clientId: "client-1" }), "client-1");
});
```

`KEY` is the existing fixture at the top of `upgrade-auth.test.ts` — give it a `clientId: null` field so it type-checks against the now-required `ApiKeySummary.clientId` from Task 1.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test server/voice/upgrade-auth.test.ts`
Expected: FAIL — `resolveClientId` is not exported.

- [ ] **Step 3: Implement `resolveClientId` and thread it through the gateway**

In `server/voice/upgrade-auth.ts`, add near the bottom, after `authorizeUpgrade`:

```ts
import { DEFAULT_CLIENT_ID } from "../../lib/clients/types";

/**
 * Which client's agent a connection should use.
 *
 * A missing key (enforcement off) and a key minted before clients existed
 * both read the same way: the Default client, which is also where the
 * console's own un-migrated config already lives.
 */
export function resolveClientId(key: ApiKeySummary | null): string {
  return key?.clientId ?? DEFAULT_CLIENT_ID;
}
```

In `server/voice/gemini-session.ts`, change `loadResolvedAgentConfig` (`:81-95`) to take a `clientId`:

```ts
export async function loadResolvedAgentConfig(
  clientId: string,
  log: StoreLogger = () => {},
): Promise<ResolvedAgentConfig> {
  try {
    const store = createConfigStore(getDb, log);
    return resolveAgentConfig(await store.read(clientId));
  } catch (cause) {
    log(`loadResolvedAgentConfig failed, using defaults: ${(cause as Error).name}`);
    return resolveAgentConfig(structuredClone(DEFAULT_AGENT_CONFIG));
  }
}
```

In `server/voice/websocket-server.ts`:

1. `verifyClient` (`:296-318`) currently discards `decision.key` once it has decided to accept. `ws` hands the *same* `IncomingMessage` object to both `verifyClient`'s `info.req` and the `connection` event's `request` — so stash the resolved client id on it there and read it back in `handleConnection`:

```ts
verifyClient: (info, done) => {
  void authorizeUpgrade(info.req, {
    requireKey: apiKeyRequired(),
    verify: (presented) => apiKeyStore.verify(presented),
  })
    .then((decision) => {
      if (decision.ok) {
        if (decision.key) log("upgrade authorised", { key: decision.key.name });
        (info.req as IncomingMessage & { resolvedClientId?: string }).resolvedClientId =
          resolveClientId(decision.key);
        done(true);
        return;
      }
      log("upgrade rejected", {
        reason: decision.reason,
        remote: info.req.socket.remoteAddress ?? "unknown",
      });
      done(false, decision.status, decision.message);
    })
    .catch((cause) => {
      log("upgrade check failed", { error: (cause as Error).name });
      done(false, 500, "Internal Server Error");
    });
},
```

Add `resolveClientId` to the existing import from `./upgrade-auth` (`:46-50`), and import `clientStore` from `../config/client-store` and `DEFAULT_CLIENT_ID` from `../../lib/clients/types` near the top with the other imports.

2. `CallState` (`:133-197`) gains two fields, next to the existing `channel`/`phone` block at the end of the interface (`:185-196`):

```ts
  /** Which client this call belongs to — see resolveClientId in upgrade-auth.ts. */
  readonly clientId: string;
  /** Snapshot of the client's name at connect time, or null if it could not be read. */
  clientName: string | null;
```

3. `handleConnection` (`:359-451`) resolves the id off the request and fetches the config and the client's name for it in parallel:

```ts
async function handleConnection(
  socket: WebSocket,
  request: IncomingMessage,
  log: NonNullable<VoiceGatewayOptions["log"]>,
): Promise<void> {
  const { channel, phone } = parseCallOrigin(request);
  const clientId =
    (request as IncomingMessage & { resolvedClientId?: string }).resolvedClientId ?? DEFAULT_CLIENT_ID;
  const state: CallState = {
    id: randomUUID(),
    // ...unchanged fields...
    channel,
    phone,
    clientId,
    clientName: null,
  };
  callStates.set(socket, state);

  // ...unchanged duration-guard / socket-listener setup...

  log("call connected", { id: state.id, remote: request.socket.remoteAddress ?? "unknown" });

  const [agent, client] = await Promise.all([
    loadResolvedAgentConfig(clientId, (message) => log(message, { id: state.id })),
    clientStore.get(clientId).catch(() => null),
  ]);
  state.clientName = client?.name ?? null;
  state.allowGreetingInterrupt = agent.welcome.allowInterrupt;
  state.summaryConfig = agent.summary;
  note(state, "connected", `${agent.models.liveModel} · ${agent.models.voice}`);
  // ...rest of the function is unchanged...
```

4. `runToolCalls`'s secrets read (`:836`) becomes client-scoped:

```ts
secrets ??= await configStore.resolveSecrets(state.clientId);
```

5. `recordCall` (`:702-729`) stamps the two new fields onto the `CallRecord`:

```ts
const record: CallRecord = {
  id: state.id,
  // ...unchanged fields...
  channel: state.channel,
  phone: state.phone,
  clientId: state.clientId,
  clientName: state.clientName ?? undefined,
};
```

(`clientName` on `CallRecord` is `string | undefined`, per Task 4; `state.clientName` is `string | null` — the `?? undefined` at the call site is the one place that difference needs bridging.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test server/voice/upgrade-auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the gateway manually**

This subsystem has no existing integration-test harness (`websocket-server.test.ts` only covers the pure `parseCallOrigin` helper today — see the file's current contents), so verify the wiring by hand, matching that level of coverage:

```bash
VOICE_GATEWAY_REQUIRE_KEY=1 npm run dev:gateway   # or however the gateway is started in this repo
```

Mint two keys for two different clients via the `/api/clients` POST from Task 5, save one client's agent name to something distinctive via the console once Task 8-11 land, then connect the console's preview with each key in turn (`?key=<client's key>` on the gateway URL) and confirm the greeting/log line names the right client's model — `note(state, "connected", ...)` already logs `agent.models.liveModel`, and the new `clientName` shows on the call record once Task 14's Calls page filter is in place.

- [ ] **Step 6: Commit**

```bash
git add server/voice/upgrade-auth.ts server/voice/upgrade-auth.test.ts server/voice/gemini-session.ts server/voice/websocket-server.ts
git commit -m "feat: route a call to its client's agent config by the key it presented"
```

---

### Task 8: Per-client agent-config API routes

**Files:**
- Create: `app/api/clients/[clientId]/agent-config/route.ts`
- Create: `app/api/clients/[clientId]/agent-config/secrets/route.ts`
- Delete: `app/api/agent-config/route.ts`
- Delete: `app/api/agent-config/secrets/route.ts`

**Interfaces:**
- Consumes: `configStore.read(clientId)`/`.write(clientId, config)`/`.listSecretKeys(clientId)`/`.setSecret(clientId, key, value)`/`.deleteSecret(clientId, key)` from Task 3.
- Produces: same JSON shapes as the routes they replace, scoped by the `clientId` path segment.

- [ ] **Step 1: Implement `app/api/clients/[clientId]/agent-config/route.ts`**

This is `app/api/agent-config/route.ts` with every `configStore` call taking `clientId`:

```ts
import { NextResponse } from "next/server";

import { validateAgentConfig } from "@/lib/agent-config/schema";
import { configStore } from "@/server/config/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ clientId: string }> },
): Promise<NextResponse> {
  const { clientId } = await params;
  const [config, secretKeys] = await Promise.all([
    configStore.read(clientId),
    configStore.listSecretKeys(clientId),
  ]);
  return NextResponse.json({ ...config, secretKeys });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ clientId: string }> },
): Promise<NextResponse> {
  const { clientId } = await params;
  const body: unknown = await request.json().catch(() => null);

  const result = validateAgentConfig(body);
  if (!result.ok) {
    return NextResponse.json({ errors: result.errors }, { status: 400 });
  }

  try {
    const saved = await configStore.write(clientId, result.config);
    const secretKeys = await configStore.listSecretKeys(clientId);
    return NextResponse.json({ ...saved, secretKeys });
  } catch (cause) {
    console.error("[agent-config] write failed:", (cause as Error).name);
    return NextResponse.json(
      { errors: [{ path: "", message: "Could not save the configuration." }] },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 2: Implement `app/api/clients/[clientId]/agent-config/secrets/route.ts`**

Same transform applied to `app/api/agent-config/secrets/route.ts`:

```ts
import { NextResponse } from "next/server";

import { LIMITS, SECRET_KEY_RE } from "@/lib/agent-config/schema";
import { configStore } from "@/server/config/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function badRequest(path: string, message: string): NextResponse {
  return NextResponse.json({ errors: [{ path, message }] }, { status: 400 });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ clientId: string }> },
): Promise<NextResponse> {
  const { clientId } = await params;
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null) {
    return badRequest("", "Expected a JSON object.");
  }

  const { key, value } = body as { key?: unknown; value?: unknown };
  if (typeof key !== "string" || !SECRET_KEY_RE.test(key) || key.length > LIMITS.secretKeyMax) {
    return badRequest("key", "Use UPPER_SNAKE_CASE letters, digits and underscores.");
  }
  if (typeof value !== "string" || value === "") {
    return badRequest("value", "Required.");
  }
  if (value.length > LIMITS.secretValueMax) {
    return badRequest("value", `At most ${LIMITS.secretValueMax} characters.`);
  }

  try {
    await configStore.setSecret(clientId, key, value);
  } catch (cause) {
    console.error("[agent-config] secret write failed:", cause);
    return NextResponse.json({ errors: [{ path: "", message: "Could not save the secret." }] }, { status: 500 });
  }

  return NextResponse.json({ secretKeys: await configStore.listSecretKeys(clientId) });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ clientId: string }> },
): Promise<NextResponse> {
  const { clientId } = await params;
  const key = new URL(request.url).searchParams.get("key");
  if (key === null || !SECRET_KEY_RE.test(key)) {
    return badRequest("key", "Not a valid secret key.");
  }

  try {
    await configStore.deleteSecret(clientId, key);
  } catch (cause) {
    console.error("[agent-config] secret delete failed:", cause);
    return NextResponse.json({ errors: [{ path: "", message: "Could not delete the secret." }] }, { status: 500 });
  }

  return NextResponse.json({ secretKeys: await configStore.listSecretKeys(clientId) });
}
```

- [ ] **Step 3: Delete the global routes**

```bash
git rm app/api/agent-config/route.ts app/api/agent-config/secrets/route.ts
```

- [ ] **Step 4: Verify manually**

```bash
curl -s localhost:3000/api/clients/singleton/agent-config | jq '.agentName, .instructions | length'
```

Expected: the same `agentName`/instructions the console showed before this task — Default's config, unchanged, now served from the new path.

- [ ] **Step 5: Commit**

```bash
git add "app/api/clients/[clientId]/agent-config"
git commit -m "feat: move agent-config API routes under /api/clients/[clientId]"
```

---

### Task 9: `lib/agent-config/routes.ts` becomes client-scoped

**Files:**
- Modify: `lib/agent-config/routes.ts`
- Modify: `lib/agent-config/routes.test.ts`

**Interfaces:**
- Produces: `agentRoutes(clientId: string): readonly NavRoute[]` (replaces the exported constant `AGENT_ROUTES`); `configRoutePaths(clientId: string): readonly string[]` (replaces `CONFIG_ROUTES`); `routeForPath(clientId: string, path: string): string | null` (adds the `clientId` parameter it didn't need before).

- [ ] **Step 1: Update the failing tests**

Read the existing `lib/agent-config/routes.test.ts` and change every call site the same way this example does — `AGENT_ROUTES` → `agentRoutes("client-1")`, `routeForPath("models.voice")` → `routeForPath("client-1", "models.voice")`, and assert the hrefs now carry the client id:

```ts
test("routes are scoped under the given client", () => {
  const routes = agentRoutes("client-1");
  assert.deepEqual(
    routes.map((r) => r.href),
    [
      "/clients/client-1/agent/conversation",
      "/clients/client-1/agent/actions",
      "/clients/client-1/agent/advanced",
      "/clients/client-1/models-voice",
      "/clients/client-1/embed",
      "/upload",
      "/calls",
      "/telephony",
      "/settings/keys",
      "/settings/selorax",
    ],
  );
});

test("routeForPath includes the client id in the returned href", () => {
  assert.equal(routeForPath("client-1", "models.voice"), "/clients/client-1/models-voice");
  assert.equal(routeForPath("client-1", "agentName"), "/clients/client-1/agent/advanced");
  assert.equal(routeForPath("client-1", ""), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test lib/agent-config/routes.test.ts` (or the project's configured runner for `lib/` tests — check `package.json`'s `test` script if this differs from the `node --test` calls used above)
Expected: FAIL — signatures don't match yet.

- [ ] **Step 3: Implement**

```ts
/**
 * The console's navigation map, and where a validation error belongs.
 *
 * Kept free of React so it can be unit tested and imported from anywhere.
 * Every href here is scoped to one client — Embed moved in from being a
 * top-level page, since the widget it configures now belongs to a client too.
 * Calls/Telephony/Settings stay top level: see the design spec §6.
 */

export type AgentRoute =
  | "agent/conversation"
  | "agent/actions"
  | "agent/advanced"
  | "models-voice";

export interface NavRoute {
  href: string;
  label: string;
  group: "agent" | null;
}

function clientRoutes(clientId: string): readonly NavRoute[] {
  return [
    { href: `/clients/${clientId}/agent/conversation`, label: "Conversation", group: "agent" },
    { href: `/clients/${clientId}/agent/actions`, label: "Actions", group: "agent" },
    { href: `/clients/${clientId}/agent/advanced`, label: "Advanced", group: "agent" },
    { href: `/clients/${clientId}/models-voice`, label: "Models & Voice", group: null },
    { href: `/clients/${clientId}/embed`, label: "Embed", group: null },
  ] as const;
}

const GLOBAL_ROUTES: readonly NavRoute[] = [
  { href: "/upload", label: "Upload Audio", group: null },
  { href: "/calls", label: "Calls", group: null },
  { href: "/telephony", label: "Telephony", group: null },
  { href: "/settings/keys", label: "API Keys", group: null },
  { href: "/settings/selorax", label: "Selorax", group: null },
] as const;

/** The full nav for a client's screens, in display order. */
export function agentRoutes(clientId: string): readonly NavRoute[] {
  return [...clientRoutes(clientId), ...GLOBAL_ROUTES];
}

/** Routes that edit the agent configuration, so the save bar belongs on them. */
export function configRoutePaths(clientId: string): readonly string[] {
  return [
    `/clients/${clientId}/agent/conversation`,
    `/clients/${clientId}/agent/actions`,
    `/clients/${clientId}/agent/advanced`,
    `/clients/${clientId}/models-voice`,
  ];
}

/**
 * Where a server validation error should send the user. Returns null for a
 * form-level error (empty path), which must not trigger navigation.
 */
export function routeForPath(clientId: string, path: string): string | null {
  if (path === "") return null;
  if (path.startsWith("models")) return `/clients/${clientId}/models-voice`;
  if (path.startsWith("agentName") || path.startsWith("variables")) return `/clients/${clientId}/agent/advanced`;
  if (path.startsWith("tools")) return `/clients/${clientId}/agent/actions`;
  return `/clients/${clientId}/agent/conversation`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test lib/agent-config/routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/agent-config/routes.ts lib/agent-config/routes.test.ts
git commit -m "feat: scope console nav routes to a client"
```

---

### Task 10: `AgentConfigProvider` becomes client-scoped

**Files:**
- Modify: `components/agent-config/AgentConfigProvider.tsx`

**Interfaces:**
- Consumes: `routeForPath(clientId, path)` from Task 9.
- Produces: `AgentConfigProvider({ clientId, initialConfig, children })` — one new required prop; `useAgentConfig()`'s return shape is unchanged, so no consuming Tab component needs editing.

- [ ] **Step 1: Implement**

Two changes to `components/agent-config/AgentConfigProvider.tsx`: the component takes a `clientId` prop, and both places that build a URL or a route use it.

```tsx
export function AgentConfigProvider({
  clientId,
  initialConfig,
  children,
}: {
  clientId: string;
  initialConfig: AgentConfig;
  children: React.ReactNode;
}) {
```

The `save()` callback's fetch (`AgentConfigProvider.tsx:114`) and its error-routing (`:131`):

```ts
  const save = useCallback(async (): Promise<AgentConfig | null> => {
    setSaveState("saving");
    setErrors(new Map());
    setFormError(null);

    let response: Response;
    try {
      response = await fetch(`/api/clients/${clientId}/agent-config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(config),
      });
    } catch {
      setSaveState("idle");
      setFormError("Could not reach the server. Check that it is running and try again.");
      return null;
    }

    if (!response.ok) {
      const body: { errors?: FieldError[] } = await response.json().catch(() => ({}));
      const list = body.errors ?? [{ path: "", message: "Could not save the configuration." }];
      setErrors(new Map(list.map((error) => [error.path, error.message])));
      setFormError(list.find((error) => error.path === "")?.message ?? "Some fields need fixing.");
      const firstField = list.find((error) => error.path !== "");
      const route = firstField ? routeForPath(clientId, firstField.path) : null;
      if (route) router.push(route);
      setSaveState("idle");
      return null;
    }

    // ...unchanged from here...
  }, [config, router, clientId]);
```

And the `useCallback` dependency array gains `clientId` (shown above).

- [ ] **Step 2: Verify by typechecking**

Run: `npx tsc --noEmit`
Expected: errors surface at every call site that still constructs `<AgentConfigProvider initialConfig={...}>` without a `clientId` — that's expected right now; Task 11 fixes the one production call site (`app/(console)/layout.tsx`, moving to the new nested layout). Confirm the error is *only* there and not inside `AgentConfigProvider.tsx` itself.

- [ ] **Step 3: Commit**

```bash
git add components/agent-config/AgentConfigProvider.tsx
git commit -m "feat: scope AgentConfigProvider's save endpoint and error routing to a client"
```

---

### Task 11: Console routes move under `/clients/[clientId]`

**Files:**
- Modify: `app/(console)/layout.tsx`
- Create: `app/(console)/clients/[clientId]/layout.tsx`
- Move: `app/(console)/agent/conversation/page.tsx` → `app/(console)/clients/[clientId]/agent/conversation/page.tsx`
- Move: `app/(console)/agent/actions/page.tsx` → `app/(console)/clients/[clientId]/agent/actions/page.tsx`
- Move: `app/(console)/agent/advanced/page.tsx` → `app/(console)/clients/[clientId]/agent/advanced/page.tsx`
- Move: `app/(console)/models-voice/page.tsx` → `app/(console)/clients/[clientId]/models-voice/page.tsx`
- Move: `app/(console)/embed/page.tsx` → `app/(console)/clients/[clientId]/embed/page.tsx` (content unchanged in this task; Task 13 makes it client-aware)
- Modify: `components/shell/ConsoleChrome.tsx`

**Interfaces:**
- Consumes: `AgentConfigProvider({ clientId, initialConfig, children })` from Task 10; `configRoutePaths(clientId)` from Task 9; `clientStore.get(id)` from Task 2.

- [ ] **Step 1: Shrink the outer layout**

`app/(console)/layout.tsx` stops loading a config — not every route under it (`/clients`, `/calls`, `/telephony`, `/settings/*`) has one in scope:

```tsx
import { ConsoleChrome } from "@/components/shell/ConsoleChrome";

export const dynamic = "force-dynamic";

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return <ConsoleChrome>{children}</ConsoleChrome>;
}
```

- [ ] **Step 2: Add the client-scoped nested layout**

```tsx
// app/(console)/clients/[clientId]/layout.tsx
/**
 * Owns one client's editable state for every screen nested under it.
 *
 * Moved down from the console-wide layout it used to be
 * (app/(console)/layout.tsx before this change) so routes with no client in
 * scope — /clients, /calls, /telephony, /settings/* — do not need one.
 */

import { notFound } from "next/navigation";

import { AgentConfigProvider } from "@/components/agent-config/AgentConfigProvider";
import { clientStore } from "@/server/config/client-store";
import { configStore } from "@/server/config/store";

export const dynamic = "force-dynamic";

export default async function ClientLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  const client = await clientStore.get(clientId);
  if (!client) notFound();

  const [config, secretKeys] = await Promise.all([
    configStore.read(clientId),
    configStore.listSecretKeys(clientId),
  ]);

  return (
    <AgentConfigProvider clientId={clientId} initialConfig={{ ...config, secretKeys }}>
      {children}
    </AgentConfigProvider>
  );
}
```

- [ ] **Step 3: Move the five pages**

```bash
mkdir -p "app/(console)/clients/[clientId]/agent/conversation" \
         "app/(console)/clients/[clientId]/agent/actions" \
         "app/(console)/clients/[clientId]/agent/advanced" \
         "app/(console)/clients/[clientId]/models-voice" \
         "app/(console)/clients/[clientId]/embed"

git mv "app/(console)/agent/conversation/page.tsx" "app/(console)/clients/[clientId]/agent/conversation/page.tsx"
git mv "app/(console)/agent/actions/page.tsx" "app/(console)/clients/[clientId]/agent/actions/page.tsx"
git mv "app/(console)/agent/advanced/page.tsx" "app/(console)/clients/[clientId]/agent/advanced/page.tsx"
git mv "app/(console)/models-voice/page.tsx" "app/(console)/clients/[clientId]/models-voice/page.tsx"
git mv "app/(console)/embed/page.tsx" "app/(console)/clients/[clientId]/embed/page.tsx"
```

None of these five files' *contents* change in this task — each already reads `useAgentConfig()` from context, which the new nested layout still provides, just from one level deeper in the tree. (`embed/page.tsx`'s content changes in Task 13.)

- [ ] **Step 4: Update `ConsoleChrome`**

`components/shell/ConsoleChrome.tsx` used `CONFIG_ROUTES.includes(pathname)` (`:19`) to decide whether the save bar shows. That constant is gone (Task 9 replaced it with `configRoutePaths(clientId)`), and `ConsoleChrome` now needs to know the current client id — pull it from the URL with `useParams`, the same mechanism the sidebar will use in Task 12:

```tsx
"use client";

import { useParams, usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { useAgentConfig } from "@/components/agent-config/AgentConfigProvider";
import { SaveBar } from "@/components/agent-config/SaveBar";
import { PreviewPanel } from "@/components/preview/PreviewPanel";
import { Sidebar } from "@/components/shell/Sidebar";
import { useVoiceSession } from "@/hooks/useVoiceSession";
import { configRoutePaths } from "@/lib/agent-config/routes";

export function ConsoleChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { clientId } = useParams<{ clientId?: string }>();
  const showSaveBar = clientId ? configRoutePaths(clientId).includes(pathname) : false;

  const { config, dirty, save } = useAgentConfig();
  // ...unchanged from here — voice, startCall, saveAndStartCall, timers...
```

Note: `useAgentConfig()` is only valid where `AgentConfigProvider` is an ancestor — i.e. under `/clients/[clientId]/...` — but `ConsoleChrome` now also wraps `/clients`, `/calls`, `/telephony`, and `/settings/*`, which have no provider above them after Step 1. Move the `useAgentConfig()`/`useVoiceSession()`-driven preview panel behind the same `clientId` check used for the save bar, so it simply does not render (and does not call the now-absent context) outside a client-scoped route:

```tsx
  if (!clientId) {
    return (
      <div className="flex min-h-dvh flex-col md:flex-row">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <main className="flex-1 px-6 py-8">
            <div className="mx-auto w-full max-w-3xl">{children}</div>
          </main>
        </div>
      </div>
    );
  }

  // ...existing body (useAgentConfig, useVoiceSession, save bar, preview panel)...
```

This means the two hooks that depend on `AgentConfigProvider` (`useAgentConfig`, and the `useVoiceSession` instance that the preview panel drives) must move below this early return, not above it — restructure the component so the `clientId`-less branch returns before those hooks run. Since React hooks cannot follow a conditional `return` and still be called unconditionally further down in the same component, split `ConsoleChrome` into a thin outer component that does the `clientId` check and an inner `ClientConsoleChrome` that holds today's body (hooks and all), rendered only when `clientId` is present:

```tsx
export function ConsoleChrome({ children }: { children: React.ReactNode }) {
  const { clientId } = useParams<{ clientId?: string }>();
  if (!clientId) {
    return (
      <div className="flex min-h-dvh flex-col md:flex-row">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <main className="flex-1 px-6 py-8">
            <div className="mx-auto w-full max-w-3xl">{children}</div>
          </main>
        </div>
      </div>
    );
  }
  return <ClientConsoleChrome clientId={clientId}>{children}</ClientConsoleChrome>;
}

function ClientConsoleChrome({ clientId, children }: { clientId: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const showSaveBar = configRoutePaths(clientId).includes(pathname);
  const { config, dirty, save } = useAgentConfig();
  const voice = useVoiceSession();
  // ...rest of today's ConsoleChrome body, unchanged, ending in the existing two-pane return...
}
```

- [ ] **Step 5: Verify manually**

```bash
npm run dev
```

Visit `http://localhost:3000/clients/singleton/agent/conversation` — expect the existing Conversation editor, unchanged in appearance, now at this URL. Visit `http://localhost:3000/clients/no-such-id/agent/conversation` — expect Next's 404 page (from the nested layout's `notFound()`). Visit `http://localhost:3000/calls` — expect it to render with the sidebar and no save bar, and no console error about a missing `AgentConfigProvider`.

- [ ] **Step 6: Commit**

```bash
git add "app/(console)/layout.tsx" "app/(console)/clients" components/shell/ConsoleChrome.tsx
git commit -m "feat: move agent-editing console routes under /clients/[clientId]"
```

---

### Task 12: The `/clients` picker and the sidebar switcher

**Files:**
- Create: `app/(console)/clients/page.tsx`
- Create: `components/clients/ClientsList.tsx`
- Create: `components/shell/ClientSwitcher.tsx`
- Modify: `components/shell/Sidebar.tsx`

**Interfaces:**
- Consumes: `agentRoutes(clientId)` from Task 9; `GET /api/clients`, `POST /api/clients` from Task 5.

- [ ] **Step 1: The `/clients` page**

```tsx
// app/(console)/clients/page.tsx
import { ClientsList } from "@/components/clients/ClientsList";
import { clientStore } from "@/server/config/client-store";

export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  const clients = await clientStore.list();
  return <ClientsList initialClients={clients} />;
}
```

- [ ] **Step 2: The picker + "＋ Add store" form**

```tsx
// components/clients/ClientsList.tsx
"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Store } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { ClientSummary } from "@/lib/clients/types";

export function ClientsList({ initialClients }: { initialClients: ClientSummary[] }) {
  const router = useRouter();
  const [clients, setClients] = useState<ClientSummary[]>(initialClients);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addStore = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/clients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.errors?.[0]?.message ?? "Could not create the store.");
        return;
      }
      setClients(body.clients);
      setName("");
      router.push(`/clients/${body.client.id}/agent/conversation`);
    } catch {
      setError("Could not reach the server. Is the app still running?");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <header className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight text-[var(--text)]">Stores</h1>
        <p className="mt-1.5 text-sm text-[var(--text-muted)]">
          Each store runs its own agent — its own prompt, voice, tools and embed widget.
        </p>
      </header>

      <form onSubmit={addStore} className="mb-6 flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <Field label="＋ Add store" htmlFor="store-name" error={error ?? undefined}>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="store-name"
              value={name}
              placeholder="Riverside Cafe"
              autoComplete="off"
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
            <Button type="submit" variant="primary" disabled={busy || name.trim() === ""}>
              <Plus />
              {busy ? "Creating…" : "Add store"}
            </Button>
          </div>
        </Field>
      </form>

      <div className="flex flex-col gap-2">
        {clients.map((client) => (
          <Link
            key={client.id}
            href={`/clients/${client.id}/agent/conversation`}
            className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 transition-colors hover:bg-[var(--surface-2)]"
          >
            <Store className="size-4 text-[var(--text-muted)]" />
            <span className="text-sm font-medium text-[var(--text)]">{client.name}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: The sidebar switcher**

```tsx
// components/shell/ClientSwitcher.tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronsUpDown, Plus } from "lucide-react";

import type { ClientSummary } from "@/lib/clients/types";

export function ClientSwitcher({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [clients, setClients] = useState<ClientSummary[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/clients")
      .then((response) => response.json())
      .then((body: { clients: ClientSummary[] }) => {
        if (!cancelled) setClients(body.clients);
      })
      .catch(() => {
        if (!cancelled) setClients([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const current = clients?.find((client) => client.id === clientId);

  return (
    <div className="relative px-1 pb-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-left text-sm font-medium text-[var(--text)]"
      >
        <span className="truncate">{current?.name ?? "Loading…"}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-[var(--text-dim)]" />
      </button>

      {open && (
        <div className="absolute left-1 right-1 top-full z-50 mt-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1 shadow-lg">
          {(clients ?? []).map((client) => (
            <Link
              key={client.id}
              href={`/clients/${client.id}/agent/conversation`}
              onClick={() => setOpen(false)}
              className="block truncate rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] hover:bg-[var(--surface-2)]"
              aria-current={client.id === clientId ? "true" : undefined}
            >
              {client.name}
            </Link>
          ))}
          <Link
            href="/clients"
            onClick={() => setOpen(false)}
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-[var(--accent)] hover:bg-[var(--surface-2)]"
          >
            <Plus className="size-3.5" />＋ Add store
          </Link>
        </div>
      )}
    </div>
  );
}
```

(`router` is unused above — drop the `useRouter` import and call if the linter flags it; the switcher navigates entirely through `Link`, which was the simpler choice once written out.)

- [ ] **Step 4: Wire the switcher into `Sidebar`**

Replace the fixed `AGENT_ROUTES` usage in `components/shell/Sidebar.tsx` (`:9,18-19,89`) with the client-scoped `agentRoutes(clientId)`, and render `ClientSwitcher` above the Agent group when a `clientId` is present:

```tsx
"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useState } from "react";
import { AudioLines, Menu, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ClientSwitcher } from "@/components/shell/ClientSwitcher";
import { agentRoutes } from "@/lib/agent-config/routes";
import { cn } from "@/lib/utils";
import { useNavGuard } from "@/components/shell/DirtyNavGuard";

export function Sidebar() {
  const pathname = usePathname();
  const { clientId } = useParams<{ clientId?: string }>();
  const [open, setOpen] = useState(false);
  const mayNavigate = useNavGuard();

  const routes = clientId ? agentRoutes(clientId) : [];
  const agentItems = routes.filter((route) => route.group === "agent");
  const topLevelItems = routes.filter((route) => route.group === null);

  const item = (href: string, label: string) => (
    // ...unchanged...
  );

  return (
    <>
      {/* ...unchanged mobile bar and overlay... */}

      <nav /* ...unchanged wrapper... */>
        <div className="mb-4 flex items-center gap-2.5 px-1">
          {/* ...unchanged brand block... */}
        </div>

        {clientId && <ClientSwitcher clientId={clientId} />}

        {clientId ? (
          <>
            <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--text-dim)]">
              Agent
            </p>
            {agentItems.map((route) => item(route.href, route.label))}
          </>
        ) : (
          <>
            <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--text-dim)]">
              Agent
            </p>
            <Link
              href="/clients"
              className="block rounded-lg px-3 py-2 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
            >
              Select a store →
            </Link>
          </>
        )}

        <div className="pt-2">{topLevelItems.map((route) => item(route.href, route.label))}</div>
      </nav>
    </>
  );
}
```

`topLevelItems` is `[]` when there is no `clientId`, so the global links (Calls, Telephony, Settings) briefly disappear on routes with no client selected. Add a second, always-present block for them, sourced independently of `routes` — pull the same five entries `agentRoutes` appends after `clientRoutes` (Task 9) into their own small always-available list, e.g. export `GLOBAL_ROUTES` from `lib/agent-config/routes.ts` alongside `agentRoutes`, and render it unconditionally in the sidebar regardless of whether a client is selected.

- [ ] **Step 5: Verify manually**

```bash
npm run dev
```

Visit `/clients` — see Default listed, add a store, confirm it navigates straight into that store's Conversation screen. Visit any `/clients/[id]/...` screen — confirm the switcher shows the right name and lists every other client, and that "＋ Add store" is reachable from the dropdown. Visit `/calls` — confirm the sidebar shows "Select a store →" instead of the three Agent sub-links, while Calls/Telephony/Settings still show.

- [ ] **Step 6: Commit**

```bash
git add "app/(console)/clients/page.tsx" components/clients components/shell/ClientSwitcher.tsx components/shell/Sidebar.tsx lib/agent-config/routes.ts
git commit -m "feat: add the store picker and sidebar client switcher"
```

---

### Task 13: The embed widget carries its client's key

**Files:**
- Modify: `lib/embed/snippet.ts`
- Modify: `lib/embed/snippet.test.ts`
- Modify: `lib/embed/config.ts`
- Modify: `lib/embed/config.test.ts`
- Modify: `public/embed.js`
- Modify: `app/embed/widget/page.tsx`
- Modify: `lib/websocket/voice-client.ts:178-192`
- Modify: `hooks/useVoiceSession.ts:77,436`
- Modify: `app/(console)/clients/[clientId]/embed/page.tsx` (moved in Task 11; this task gives it real content)

**Interfaces:**
- Produces: `consoleSnippet(origin, key)`, `scriptTagSnippet(origin, key)`; `parseEmbedKey(search: string): string | null`; `resolveGatewayUrl(overrideKey?: string): string`; `useVoiceSession(options?: { gatewayKeyOverride?: string })`.

- [ ] **Step 1: Write the failing snippet tests**

Read `lib/embed/snippet.test.ts` first to match its style, then add cases alongside the existing `consoleSnippet`/`scriptTagSnippet` tests:

```ts
test("consoleSnippet embeds the client's key as data-key", () => {
  const script = consoleSnippet("https://voice.example.com", "riverside-key");
  assert.match(script, /data-key='riverside-key'/);
});

test("scriptTagSnippet embeds the client's key as data-key", () => {
  const tag = scriptTagSnippet("https://voice.example.com", "riverside-key");
  assert.match(tag, /data-key="riverside-key"/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test lib/embed/snippet.test.ts`
Expected: FAIL — the functions don't take a second argument yet.

- [ ] **Step 3: Implement the snippet changes**

`consoleSnippet` today builds a bare `<script>`-injecting one-liner with no attributes at all (`lib/embed/snippet.ts:76-78`); give it a `data-key` the same way `scriptTagSnippet` will:

```ts
/** The one-liner to paste into a browser console, tagged with this client's key. */
export function consoleSnippet(origin: string, key: string): string {
  return `(function(){var s=document.createElement('script');s.src='${origin}/embed.js';s.async=true;s.setAttribute('data-key','${key}');document.body.appendChild(s);})()`;
}

/** The same loader as a tag, for embedding in a page's HTML properly. */
export function scriptTagSnippet(origin: string, key: string): string {
  return `<script src="${origin}/embed.js" data-key="${key}" async></script>`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test lib/embed/snippet.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `parseEmbedKey` to `lib/embed/config.ts`, with a test**

In `lib/embed/config.test.ts`:

```ts
test("parseEmbedKey reads the key query param", () => {
  assert.equal(parseEmbedKey("?key=abc123"), "abc123");
});

test("parseEmbedKey returns null when there is no key", () => {
  assert.equal(parseEmbedKey(""), null);
  assert.equal(parseEmbedKey("?prompt=hi"), null);
});
```

Run: `node --test lib/embed/config.test.ts` — FAIL (not exported yet). Implement in `lib/embed/config.ts`:

```ts
/** The gateway key this widget should present, if the loader passed one. */
export function parseEmbedKey(search: string): string | null {
  const value = new URLSearchParams(search).get("key")?.trim();
  return value ? value : null;
}
```

Run again — PASS.

- [ ] **Step 6: `public/embed.js` forwards `data-key`**

Alongside the existing `data-prompt`/`data-button-text`/`data-title` handling (`public/embed.js:75-80`):

```js
var key = configuredText("data-key");
if (prompt) params.set("prompt", prompt);
if (buttonText) params.set("buttonText", buttonText);
if (title) params.set("title", title);
if (key) params.set("key", key);
```

- [ ] **Step 7: `resolveGatewayUrl` accepts an override**

In `lib/websocket/voice-client.ts` (`:178-192`), an explicit key wins over the build-time env var — a widget carrying its own key is a client's widget; the console's own preview passes nothing and keeps using `NEXT_PUBLIC_VOICE_GATEWAY_KEY` exactly as today:

```ts
export function resolveGatewayUrl(overrideKey?: string): string {
  const configured = process.env.NEXT_PUBLIC_VOICE_GATEWAY_URL;
  const base =
    configured ||
    (typeof window === "undefined"
      ? "ws://localhost:4000/voice"
      : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.hostname}:4000/voice`);

  const key = overrideKey || process.env.NEXT_PUBLIC_VOICE_GATEWAY_KEY;
  if (!key) return base;

  const url = new URL(base);
  url.searchParams.set("key", key);
  return url.toString();
}
```

`hooks/useSoftphoneBridge.ts` calls `resolveGatewayUrl()` with no arguments in two places — both keep compiling and behaving exactly as before, since `overrideKey` is optional and falls through to the existing env-var branch.

- [ ] **Step 8: `useVoiceSession` accepts a key override**

In `hooks/useVoiceSession.ts`, change the signature (`:77`) and the one call site that builds the client (`:436`):

```ts
export function useVoiceSession(options?: { gatewayKeyOverride?: string }): VoiceSessionController {
  const gatewayKeyOverride = options?.gatewayKeyOverride;
  // ...unchanged state declarations...
```

```ts
      const client = new VoiceClient(resolveGatewayUrl(gatewayKeyOverride), {
```

(`gatewayKeyOverride` needs to be reachable from wherever the `start` callback closes over it — if `start` is defined inside the hook body as it appears to be from the surrounding code at `:420-449`, the value is already in scope with no further change.)

- [ ] **Step 9: The widget page reads and forwards the key**

In `app/embed/widget/page.tsx`, alongside the existing `parseEmbedTextConfig` read (`:51-53`):

```tsx
  const [text] = useState(() =>
    typeof window === "undefined" ? DEFAULT_EMBED_TEXT : parseEmbedTextConfig(window.location.search),
  );
  const [gatewayKeyOverride] = useState(() =>
    typeof window === "undefined" ? undefined : (parseEmbedKey(window.location.search) ?? undefined),
  );
  const voice = useVoiceSession({ gatewayKeyOverride });
```

(Move the `const voice = useVoiceSession();` line, currently above `text` at `:48`, down below `gatewayKeyOverride` so the option is ready when the hook is called.) Add `parseEmbedKey` to the existing `lib/embed/config` import at the top of the file.

- [ ] **Step 10: Give the per-client Embed page real content**

`app/(console)/clients/[clientId]/embed/page.tsx` (moved unchanged in Task 11) becomes a server component that resolves the client's key and passes it to the existing `EmbedSnippet` component:

```tsx
import { notFound } from "next/navigation";

import { EmbedSnippet } from "@/components/embed/EmbedSnippet";
import {
  EMBED_ORIGIN_VAR,
  consoleSnippet,
  isSecureContextOrigin,
  normaliseOrigin,
  scriptTagSnippet,
} from "@/lib/embed/snippet";
import { apiKeyStore } from "@/server/config/api-key-store";
import { clientStore } from "@/server/config/client-store";

export const dynamic = "force-dynamic";

export default async function EmbedPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const client = await clientStore.get(clientId);
  if (!client) notFound();

  const result = normaliseOrigin(process.env.NEXT_PUBLIC_EMBED_ORIGIN);

  // A client created before this feature, or one whose key was revoked by
  // hand in Settings → API Keys, has no key to embed — surfaced explicitly
  // rather than emitting a snippet that will 401 on every visitor.
  const keys = await apiKeyStore.list();
  const key = keys.find((entry) => entry.id === client.apiKeyId) ?? null;

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <header className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight text-[var(--text)]">Embed — {client.name}</h1>
        <p className="mt-1.5 text-sm text-[var(--text-muted)]">
          Put {client.name}&apos;s voice agent on their website as a floating call button.
        </p>
      </header>

      {!result.ok ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-5">
          <p className="text-sm font-medium text-[var(--text)]">{result.reason}</p>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-[var(--surface-3)] p-3 text-[13px] text-[var(--text)]">
            <code>{`${EMBED_ORIGIN_VAR}=https://voice.example.com`}</code>
          </pre>
        </div>
      ) : !key ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-5">
          <p className="text-sm font-medium text-[var(--text)]">
            {client.name} has no active gateway key, so a snippet cannot be generated.
          </p>
          <p className="mt-2 text-sm text-[var(--text-muted)]">
            Its key was likely revoked from Settings → API Keys. Mint a new one there and note its id
            against this client, or recreate the store, to get a working snippet again.
          </p>
        </div>
      ) : (
        <>
          <EmbedSnippet
            consoleSnippet={consoleSnippet(result.origin, key.fingerprint)}
            scriptTag={scriptTagSnippet(result.origin, key.fingerprint)}
            origin={result.origin}
          />
          {!isSecureContextOrigin(result.origin) && (
            <div className="mt-6 rounded-xl border border-amber-300 bg-amber-50 p-4">
              <p className="text-sm font-medium text-amber-900">
                This origin is plain HTTP, so the microphone will not work.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
```

`ApiKeySummary` never carries a plaintext key (Task 1 kept that contract), so this page cannot show the real key value the way the current one-time mint banner in `ApiKeysPanel` does — and it should not try to. `apiKeyStore` needs a way to hand back the plaintext for an *existing* key here, which it deliberately cannot (see `server/config/api-key-store.ts`'s header comment: "a lost key is re-minted, never recovered"). Replace `key.fingerprint` above with the actual plaintext captured at creation time instead: extend `ClientSummary` (Task 2) with nothing new, but have `clientStore.create()`'s caller — the `POST /api/clients` handler from Task 5 — be the only place the plaintext is ever shown, exactly like `ApiKeysPanel` does for a freshly minted key today. Update `components/clients/ClientsList.tsx` (Task 12, Step 2) to show that one-time key banner immediately after creating a store, with the same "copy it now" messaging `ApiKeysPanel` uses, **instead of** trying to display a key on this Embed page. This Embed page then shows the snippet only when a key exists, but represents the key with a placeholder the operator must paste in by hand once, the same limitation `ApiKeysPanel`'s revoke/remint flow already lives with — state this plainly in the page copy:

```tsx
      ) : (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-5">
          <p className="text-sm font-medium text-[var(--text)]">
            {client.name}&apos;s key was shown once, when the store was created.
          </p>
          <p className="mt-2 text-sm text-[var(--text-muted)]">
            If it was not copied then, mint a new one from Settings → API Keys (name it after{" "}
            {client.name}) and paste it into the snippet below in place of{" "}
            <code className="font-mono">YOUR_KEY</code>.
          </p>
          <EmbedSnippet
            consoleSnippet={consoleSnippet(result.origin, "YOUR_KEY")}
            scriptTag={scriptTagSnippet(result.origin, "YOUR_KEY")}
            origin={result.origin}
          />
        </div>
      )}
```

Drop the `key.fingerprint` attempt above in favor of this — the fingerprint is not a usable credential (that is the entire point of a fingerprint; see `lib/api-keys/types.ts:9`) and would only produce a snippet that fails at connect time. Remove the now-unused `apiKeyStore`/`key` lookup from the component accordingly, keeping only the `client.apiKeyId` existence check for the "no key" branch.

- [ ] **Step 11: Run everything touched in this task**

Run: `node --test lib/embed/snippet.test.ts lib/embed/config.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 12: Verify manually**

```bash
npm run dev
```

Create a store, copy its one-time key from the `/clients` creation banner, visit its Embed page, paste the key into the shown snippet in place of `YOUR_KEY`, and load a static HTML file containing that snippet in a browser — confirm the widget appears and a call connects, and that the resulting call record (once Task 14 lands) shows this client's name.

- [ ] **Step 13: Commit**

```bash
git add lib/embed lib/websocket/voice-client.ts hooks/useVoiceSession.ts public/embed.js app/embed/widget/page.tsx "app/(console)/clients/[clientId]/embed/page.tsx" components/clients/ClientsList.tsx
git commit -m "feat: give each client's embed widget its own gateway key"
```

---

### Task 14: Calls page — client filter

**Files:**
- Modify: `app/api/calls/route.ts`
- Modify: `app/(console)/calls/page.tsx`
- Modify: `components/calls/CallsTable.tsx` (read it first — this task adds a filter control above whatever it currently renders, without changing its row rendering, which already receives `CallRecord[]` and can display `clientName` in an added column with no interface change to the component's existing props)

**Interfaces:**
- Consumes: `callLogStore.read(filter?)` from Task 4; `clientStore.list()` from Task 2.

- [ ] **Step 1: `GET /api/calls` accepts a client filter**

```ts
import { NextResponse } from "next/server";

import { callLogStore } from "@/server/config/call-log-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const clientId = new URL(request.url).searchParams.get("client") ?? undefined;
  return NextResponse.json({ calls: await callLogStore.read({ clientId }) });
}
```

- [ ] **Step 2: The Calls page reads the filter server-side and offers a client dropdown**

```tsx
// app/(console)/calls/page.tsx
import { CallsTable } from "@/components/calls/CallsTable";
import { callLogStore } from "@/server/config/call-log-store";
import { clientStore } from "@/server/config/client-store";

export const dynamic = "force-dynamic";

export default async function CallsPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string }>;
}) {
  const { client } = await searchParams;
  const [calls, clients] = await Promise.all([
    callLogStore.read(client ? { clientId: client } : undefined),
    clientStore.list(),
  ]);
  return <CallsTable calls={calls} clients={clients} selectedClientId={client ?? null} />;
}
```

- [ ] **Step 3: `CallsTable` gains the filter control**

Read the current `components/calls/CallsTable.tsx` in full before editing — its existing prop is `{ calls: CallRecord[] }`, rendered as some table/list. Add two new props, `clients: ClientSummary[]` and `selectedClientId: string | null`, and a `<select>` above the existing table that navigates via `router.push` on change:

```tsx
"use client";
import { useRouter } from "next/navigation";
// ...existing imports, plus:
import type { ClientSummary } from "@/lib/clients/types";

export function CallsTable({
  calls,
  clients,
  selectedClientId,
}: {
  calls: CallRecord[];
  clients: ClientSummary[];
  selectedClientId: string | null;
}) {
  const router = useRouter();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <label htmlFor="calls-client-filter" className="text-sm text-[var(--text-muted)]">
          Client
        </label>
        <select
          id="calls-client-filter"
          value={selectedClientId ?? ""}
          onChange={(event) => {
            const value = event.target.value;
            router.push(value ? `/calls?client=${encodeURIComponent(value)}` : "/calls");
          }}
          className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-sm text-[var(--text)]"
        >
          <option value="">All clients</option>
          {clients.map((client) => (
            <option key={client.id} value={client.id}>
              {client.name}
            </option>
          ))}
        </select>
      </div>

      {/* ...existing table, unchanged, except each row may now show
          call.clientName ?? "—" in an added column... */}
    </div>
  );
}
```

Fold the existing table markup back in under this new filter row exactly as it was — this task adds the filter and, optionally, a client-name column to each row (`call.clientName ?? "—"`), and changes nothing else about how a row renders.

- [ ] **Step 4: Verify manually**

```bash
npm run dev
```

Visit `/calls` — see every call, each with a client name or "—" for pre-existing records. Pick a client from the dropdown — confirm the URL becomes `/calls?client=<id>` and only that client's calls show. Pick "All clients" — confirm it returns to `/calls`.

- [ ] **Step 5: Commit**

```bash
git add app/api/calls/route.ts "app/(console)/calls/page.tsx" components/calls/CallsTable.tsx
git commit -m "feat: filter the Calls page by client"
```

---

### Task 15: API Keys settings page shows each key's client

**Files:**
- Modify: `app/(console)/settings/keys/page.tsx`
- Modify: `components/settings/ApiKeysPanel.tsx`

**Interfaces:**
- Consumes: `clientStore.list()` from Task 2; `ApiKeySummary.clientId` from Task 1.

- [ ] **Step 1: The page joins keys against clients**

```tsx
// app/(console)/settings/keys/page.tsx
import { ApiKeysPanel } from "@/components/settings/ApiKeysPanel";
import { apiKeyStore } from "@/server/config/api-key-store";
import { clientStore } from "@/server/config/client-store";

export const dynamic = "force-dynamic";

export default async function ApiKeysPage() {
  const [keys, clients] = await Promise.all([apiKeyStore.list(), clientStore.list()]);
  return <ApiKeysPanel initialKeys={keys} clients={clients} />;
}
```

- [ ] **Step 2: The panel resolves and shows the client name per row**

In `components/settings/ApiKeysPanel.tsx`, add a `clients: ClientSummary[]` prop and a lookup, and add a column to the existing table between "Key" and "Created" (`:196-204` for the header, `:207-239` for each row):

```tsx
interface ApiKeysPanelProps {
  initialKeys: ApiKeySummary[];
  clients: ClientSummary[];
}

export function ApiKeysPanel({ initialKeys, clients }: ApiKeysPanelProps) {
  const [keys, setKeys] = useState<ApiKeySummary[]>(initialKeys);
  // ...unchanged state...

  const clientName = (id: string | null) => clients.find((client) => client.id === id)?.name ?? "—";

  // ...unchanged mint/revoke/copy handlers...

  return (
    // ...unchanged header and mint form...
      <table className="w-full min-w-[36rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] bg-[var(--surface-2)]">
            <Th>Name</Th>
            <Th>Client</Th>
            <Th>Key</Th>
            <Th>Created</Th>
            <Th>Last used</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => (
            <tr key={key.id} /* ...unchanged row wrapper... */>
              <Td><span className="font-medium text-[var(--text)]">{key.name}</span></Td>
              <Td>{clientName(key.clientId)}</Td>
              <Td>{/* ...unchanged fingerprint... */}</Td>
              <Td>{formatDate(key.createdAt)}</Td>
              <Td>{formatDate(key.lastUsedAt)}</Td>
              <Td>{/* ...unchanged revoke button... */}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    // ...unchanged empty state and footer notes...
  );
}
```

Add `import type { ClientSummary } from "@/lib/clients/types";` at the top.

- [ ] **Step 3: Verify manually**

Visit `/settings/keys` — confirm every key row shows its client's name (or "—" for a key with no `clientId`, including every key minted before this feature).

- [ ] **Step 4: Commit**

```bash
git add "app/(console)/settings/keys/page.tsx" components/settings/ApiKeysPanel.tsx
git commit -m "feat: show each API key's client in Settings"
```

---

## Self-Review Notes

**Spec coverage:** §3 (data model) → Tasks 1–4. §4 (no-migration Default) → Task 2. §5 (gateway wiring) → Task 7. §6 (routes/nav) → Tasks 9–12. §7 (embed) → Task 13. §8 (calls filtering) → Task 14. §9 (API surface) → Tasks 5, 6, 8. §11 out-of-scope items (delete, auth, per-client telephony, extra key-management UI) are not addressed by any task, as intended.

**Type consistency checked:** `ClientSummary` (Task 2) is the one shape passed to `ClientsList`, `ClientSwitcher`, `CallsTable`, and `ApiKeysPanel` (Tasks 12, 14, 15) — no task invents a second client shape. `configStore`'s five methods all gain `clientId` as their first parameter consistently from Task 3 onward. `routeForPath`/`agentRoutes`/`configRoutePaths` (Task 9) are the only functions any later task calls for hrefs — `AGENT_ROUTES`/`CONFIG_ROUTES` as constants are fully retired, not left dangling.

**One known follow-up surfaced during Task 13:** the Embed page cannot show a client's real key after the fact (keys are hash-only at rest, matching the existing API-key store's contract) — Task 13 resolves this by moving the one-time key display to the store-creation flow in Task 12, the same pattern `ApiKeysPanel` already uses for freshly minted keys, and has the Embed page ask the operator to paste it in. This is a real UX rough edge worth a future "mint an additional key for this client" affordance, deliberately left out per spec §11.
