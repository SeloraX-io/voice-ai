# MongoDB Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** replace every JSON file under `data/` with MongoDB collections, leaving the five store interfaces in `server/config/` byte-identical so no consumer changes.

**Architecture:** a single memoised connection module (`server/db/client.ts`) hands each store a `DbAccessor` (`() => Promise<Db>`) in place of a `dataDir` string. Each store keeps its exported interface and swaps its body from temp-file-and-rename to collection operations. Whole-file rewrites become single-document updates, which deletes every `createQueue()` in the codebase and closes the lost-update hazard documented in `server/config/api-key-store.ts:22-41`.

**Tech Stack:** TypeScript, Node 24, `mongodb` 7.5.0 (driver), `mongodb-memory-server` 11.2.0 (dev), `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-17-mongodb-persistence-design.md`

## Global Constraints

- **Do not run `git commit` or `git add` at any point.** The user commits manually. Every task ends with a verification step, not a commit. This overrides the usual commit-frequently guidance.
- **Store interfaces do not change.** `ConfigStore`, `CallLogStore`, `ApiKeyStore`, `SeloraxStore`, `TelephonyStore` keep their exact method signatures. No file under `app/` is edited.
- **Read-failure contract:** missing document → defaults; validation failure → defaults **and leave the document untouched**; connection or query error → **throw**. Achieved by simply not catching driver errors.
- **One documented exception:** `ConfigStore.resolveSecrets()` still returns `{}` on any failure. Reason (from `server/config/store.ts:180-183`): unauthenticated tools beat a dropped call, because the request then fails with the endpoint's own 401.
- **Log error `name`/`code` only, never `message`.** A driver error can quote the failing query, and these queries carry secret material. This preserves the existing discipline.
- **Env vars:** `MONGODB_URI` (already in `.env`), `MONGODB_DB` (new, defaults to `voice-ai`). The existing URI has no database name after `.mongodb.net`, which is why `MONGODB_DB` exists.
- **Mongo starts empty.** No migration code, ever. Existing `data/*.json` is abandoned.
- Run `npx tsc --noEmit` after each task. Run tests with `node --import tsx --test <file>`.

---

## File Structure

**Created:**
- `server/db/client.ts` — connection memoisation, `DbAccessor` type, index creation, `closeDb()`
- `server/db/client.test.ts` — connection and index behavior
- `server/db/test-db.ts` — shared `mongodb-memory-server` harness for store tests

**Modified (body replaced, exports unchanged):**
- `server/config/selorax-store.ts` + `.test.ts`
- `server/config/telephony-store.ts` + `.test.ts`
- `server/config/store.ts` + `.test.ts`
- `server/config/call-log-store.ts` + `.test.ts`
- `server/config/api-key-store.ts` + `.test.ts`
- `server/voice/gemini-session.ts:85` — store construction
- `server/index.ts` — `closeDb()` in shutdown
- `.env.example`, `.gitignore`, `package.json`

**Deleted:**
- `data/` directory

Tasks 2–6 are one store each: independently testable, independently reviewable, and each leaves the app in a working state because each store's singleton is defined in the same file it converts.

---

### Task 1: Connection module and test harness

**Files:**
- Create: `server/db/client.ts`
- Create: `server/db/test-db.ts`
- Create: `server/db/client.test.ts`
- Modify: `package.json` (dependencies)
- Modify: `.env.example`

**Interfaces:**
- Consumes: nothing.
- Produces: `type DbAccessor = () => Promise<Db>`; `getDb(): Promise<Db>`; `closeDb(): Promise<void>`; `ensureIndexes(db: Db): Promise<void>`. From `test-db.ts`: `startTestMongo(): Promise<void>`, `stopTestMongo(): Promise<void>`, `freshDb(): Promise<DbAccessor>`. Every later task uses `DbAccessor` and `freshDb`.

- [ ] **Step 1: Install dependencies**

```bash
npm install mongodb@^7.5.0
npm install --save-dev mongodb-memory-server@^11.2.0
```

Note: `mongodb-memory-server` downloads a ~80MB `mongod` binary on first use and caches it in `~/.cache/mongodb-binaries`. The first test run after install is slow; later runs are not.

- [ ] **Step 2: Write the connection module**

Create `server/db/client.ts`:

```ts
/**
 * The MongoDB connection both processes share.
 *
 * Next and the voice gateway are separate processes that never import each
 * other. They used to meet at a directory of JSON files; they now meet here.
 *
 * The connection PROMISE is memoised, not the resolved client, so concurrent
 * first callers share one connect instead of racing to open several pools. It
 * is cached on `globalThis` because Next re-evaluates modules on every dev
 * hot-reload, and a module-level variable would open a fresh pool per edit
 * until Atlas started refusing connections.
 */

import { MongoClient, type Db } from "mongodb";

/** How every store gets at the database. Injected so tests need no Atlas. */
export type DbAccessor = () => Promise<Db>;

const CACHE_KEY = Symbol.for("voice-ai.mongo");

interface Cache {
  promise: Promise<{ client: MongoClient; db: Db }> | null;
}

function cache(): Cache {
  const global = globalThis as unknown as Record<symbol, Cache | undefined>;
  global[CACHE_KEY] ??= { promise: null };
  return global[CACHE_KEY] as Cache;
}

/**
 * Creates the indexes the stores rely on. Idempotent — Mongo ignores a
 * createIndex for an index that already exists with the same spec.
 */
export async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all([
    // Call history is always read newest-first.
    db.collection("call_logs").createIndex({ startedAt: -1 }),
    // `verify()` is an exact-match lookup on the hash, on every upgrade.
    db.collection("api_keys").createIndex({ hash: 1 }, { unique: true }),
  ]);
}

async function connect(): Promise<{ client: MongoClient; db: Db }> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      "MONGODB_URI is not set. Copy .env.example to .env and add your connection string.",
    );
  }
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB ?? "voice-ai");
  await ensureIndexes(db);
  return { client, db };
}

/**
 * The shared database handle.
 *
 * A failed connect clears the memo before rethrowing, so one unreachable
 * moment does not poison the process forever — the next caller retries.
 */
export function getDb(): Promise<Db> {
  const entry = cache();
  entry.promise ??= connect().catch((cause: unknown) => {
    entry.promise = null;
    throw cause;
  });
  return entry.promise.then(({ db }) => db);
}

/** Drains the pool on shutdown. Safe to call when nothing ever connected. */
export async function closeDb(): Promise<void> {
  const entry = cache();
  const pending = entry.promise;
  entry.promise = null;
  if (!pending) return;
  try {
    const { client } = await pending;
    await client.close();
  } catch {
    // The connection never succeeded; there is no pool to drain.
  }
}
```

- [ ] **Step 3: Write the test harness**

Create `server/db/test-db.ts`:

```ts
/**
 * A real mongod for tests, in-process and thrown away afterwards.
 *
 * One server per test FILE (node:test gives each file its own process), and a
 * freshly named database per call to `freshDb`, so tests stay independent
 * without paying server startup each time.
 */

import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";

import { ensureIndexes, type DbAccessor } from "./client";

let server: MongoMemoryServer | null = null;
let client: MongoClient | null = null;
let counter = 0;

export async function startTestMongo(): Promise<void> {
  server = await MongoMemoryServer.create();
  client = new MongoClient(server.getUri());
  await client.connect();
}

export async function stopTestMongo(): Promise<void> {
  await client?.close();
  await server?.stop();
  client = null;
  server = null;
}

/** A store-ready accessor onto a database no other test is using. */
export async function freshDb(): Promise<DbAccessor> {
  if (!client) throw new Error("startTestMongo() was not called");
  const db: Db = client.db(`test_${++counter}`);
  await ensureIndexes(db);
  return async () => db;
}

/** An accessor that always fails, for testing the unreachable-database path. */
export function unreachableDb(): DbAccessor {
  return async () => {
    throw new Error("connection refused");
  };
}
```

- [ ] **Step 4: Write the failing test**

Create `server/db/client.test.ts`:

```ts
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --import tsx --test server/db/client.test.ts`
Expected: PASS, 3 tests. The first run pauses for a minute or two while the mongod binary downloads.

This task has no red phase, and that is deliberate: it builds the harness the other six tasks test *through*, so there is no behavior to drive out first. Tasks 2–6 are all strict red-green. If these three tests do not pass, the fault is in `client.ts` or `test-db.ts` — fix it before starting Task 2, because every later task depends on this harness working.

- [ ] **Step 6: Document the new env vars**

Add to `.env.example`, immediately after the `GEMINI_API_KEY` block and before the `# --- Optional ---` divider:

```
# --- Database (required) ------------------------------------------------

# MongoDB connection string. All persistent state lives here: the agent
# configuration and its secret values, call history and transcripts, SIP and
# Selorax credentials, and the gateway's API keys.
#
# Both processes read it — Next and the voice gateway — which is what lets them
# run on different hosts. SERVER-ONLY, and the single most sensitive value in
# the project.
MONGODB_URI=

# Which database inside that cluster. An Atlas SRV string usually carries no
# database name, so this is separate.
MONGODB_DB=voice-ai
```

- [ ] **Step 7: Set MONGODB_DB in the local .env**

Append `MONGODB_DB="voice-ai"` to `.env` if it is not already present. Do not modify or reformat the existing `MONGODB_URI` line.

- [ ] **Step 8: Verify**

Run: `npx tsc --noEmit`
Expected: no errors.

---

### Task 2: Selorax store on Mongo

The simplest singleton store. It establishes the pattern Tasks 3 and 4 reuse.

**Files:**
- Modify: `server/config/selorax-store.ts` (replace body, keep exports)
- Modify: `server/config/selorax-store.test.ts` (rewrite)

**Interfaces:**
- Consumes: `DbAccessor`, `getDb` from `server/db/client`; `freshDb`, `unreachableDb`, `startTestMongo`, `stopTestMongo` from `server/db/test-db`.
- Produces: `createSeloraxStore(getDb: DbAccessor, log?: StoreLogger): SeloraxStore`. `SeloraxStore` keeps `read(): Promise<SeloraxConfig>` and `write(config): Promise<SeloraxConfig>`. The exported `seloraxStore` singleton keeps its name and type, so `app/api/selorax/route.ts`, `app/api/telephony/line/route.ts`, `app/api/telephony/report/route.ts`, `app/(console)/settings/selorax/page.tsx` and `app/(console)/telephony/page.tsx` are untouched.

- [ ] **Step 1: Write the failing test**

Replace the entire contents of `server/config/selorax-store.test.ts`:

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { EMPTY_SELORAX_CONFIG } from "../../lib/selorax/config";
import { freshDb, startTestMongo, stopTestMongo, unreachableDb } from "../db/test-db";
import { createSeloraxStore } from "./selorax-store";

before(startTestMongo);
after(stopTestMongo);

const CONFIG = {
  baseUrl: "https://api.selorax.io",
  authToken: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE3ODk1MDAwMDB9.sig",
  storeId: "42",
};

test("an unwritten store reads as empty config", async () => {
  const store = createSeloraxStore(await freshDb());
  assert.deepEqual(await store.read(), EMPTY_SELORAX_CONFIG);
});

test("writes and reads back", async () => {
  const store = createSeloraxStore(await freshDb());
  await store.write(CONFIG);
  assert.deepEqual(await store.read(), CONFIG);
});

test("a second write replaces the first", async () => {
  const store = createSeloraxStore(await freshDb());
  await store.write(CONFIG);
  await store.write({ ...CONFIG, storeId: "99" });
  assert.equal((await store.read()).storeId, "99");
});

test("a document that fails validation reads as empty rather than throwing", async () => {
  const getDb = await freshDb();
  const db = await getDb();
  // baseUrl present but authToken and storeId missing: not the all-empty case,
  // so the validator reports errors rather than returning EMPTY.
  await db
    .collection("selorax_config")
    .insertOne({ _id: "singleton", value: { baseUrl: "https://x.test" } } as never);

  const messages: string[] = [];
  const store = createSeloraxStore(getDb, (message) => messages.push(message));

  assert.deepEqual(await store.read(), EMPTY_SELORAX_CONFIG);
  assert.equal(messages.length, 1);
});

test("a bad document is left in place, not overwritten", async () => {
  const getDb = await freshDb();
  const db = await getDb();
  await db
    .collection("selorax_config")
    .insertOne({ _id: "singleton", value: { baseUrl: "https://x.test" } } as never);

  const store = createSeloraxStore(getDb, () => {});
  await store.read();

  const doc = await db.collection("selorax_config").findOne({ _id: "singleton" as never });
  assert.equal((doc as unknown as { value: { baseUrl: string } }).value.baseUrl, "https://x.test");
});

test("never logs the contents of a bad document", async () => {
  const getDb = await freshDb();
  const db = await getDb();
  await db
    .collection("selorax_config")
    .insertOne({ _id: "singleton", value: { baseUrl: "secret-token" } } as never);

  const messages: string[] = [];
  const store = createSeloraxStore(getDb, (message) => messages.push(message));
  await store.read();

  assert.ok(!messages.join(" ").includes("secret-token"));
});

test("an unreachable database throws rather than reading as empty", async () => {
  const store = createSeloraxStore(unreachableDb(), () => {});
  await assert.rejects(() => store.read());
});

test("concurrent writes leave one coherent result, not a mix", async () => {
  const store = createSeloraxStore(await freshDb());
  await Promise.all([
    store.write({ ...CONFIG, storeId: "1" }),
    store.write({ ...CONFIG, storeId: "2" }),
    store.write({ ...CONFIG, storeId: "3" }),
  ]);

  const saved = await store.read();
  assert.ok(["1", "2", "3"].includes(saved.storeId));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test server/config/selorax-store.test.ts`
Expected: FAIL — `createSeloraxStore` still takes a directory string, so `read()` returns `EMPTY_SELORAX_CONFIG` for every case and the unreachable test does not reject.

- [ ] **Step 3: Replace the store**

Replace the entire contents of `server/config/selorax-store.ts`:

```ts
/**
 * Persistence for the bridge's Selorax connection configuration.
 *
 * One document, `_id: "singleton"`, in `selorax_config`. A write is a single
 * upsert, so there is nothing to serialise in-process — which matters, because
 * an in-process queue never protected against the other process anyway.
 *
 * A missing document is the first-run path and reads as unconfigured. A
 * document that fails validation also reads as unconfigured and is left where
 * it is, so bad data stays recoverable. A database that cannot be reached
 * THROWS: treating "unreachable" as "unconfigured" would let the settings page
 * render blank fields and the next save wipe a real configuration.
 *
 * This document holds an auth token. Only an error's name is ever logged — a
 * driver error can quote the query that failed, and the query carries the token.
 */

import type { Db } from "mongodb";

import {
  EMPTY_SELORAX_CONFIG,
  validateSeloraxConfig,
  type SeloraxConfig,
} from "../../lib/selorax/config";
import { getDb, type DbAccessor } from "../db/client";

export type StoreLogger = (message: string) => void;

export interface SeloraxStore {
  read(): Promise<SeloraxConfig>;
  write(config: SeloraxConfig): Promise<SeloraxConfig>;
}

const COLLECTION = "selorax_config";
const SINGLETON = "singleton";

interface SeloraxDoc {
  _id: string;
  value: SeloraxConfig;
}

export function createSeloraxStore(
  getDatabase: DbAccessor,
  log: StoreLogger = () => {},
): SeloraxStore {
  async function collection() {
    const db: Db = await getDatabase();
    return db.collection<SeloraxDoc>(COLLECTION);
  }

  return {
    async read(): Promise<SeloraxConfig> {
      // Not wrapped in try/catch on purpose: a connection or query failure must
      // reach the caller, not masquerade as "not configured".
      const doc = await (await collection()).findOne({ _id: SINGLETON });
      if (!doc) return EMPTY_SELORAX_CONFIG;

      const result = validateSeloraxConfig(doc.value);
      if (!result.ok) {
        log("the stored Selorax config failed validation; treating it as unconfigured");
        return EMPTY_SELORAX_CONFIG;
      }
      return result.value;
    },

    async write(config: SeloraxConfig): Promise<SeloraxConfig> {
      await (await collection()).replaceOne(
        { _id: SINGLETON },
        { value: config },
        { upsert: true },
      );
      return config;
    },
  };
}

export const seloraxStore = createSeloraxStore(getDb, (message) =>
  console.warn(`[selorax] ${message}`),
);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test server/config/selorax-store.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Verify types**

Run: `npx tsc --noEmit`
Expected: no errors.

---

### Task 3: Telephony store on Mongo

Identical shape to Task 2 with a different type and collection. The code is repeated in full rather than referenced, because tasks may be read out of order.

**Files:**
- Modify: `server/config/telephony-store.ts`
- Modify: `server/config/telephony-store.test.ts`

**Interfaces:**
- Consumes: `DbAccessor`, `getDb`, `freshDb`, `unreachableDb`.
- Produces: `createTelephonyStore(getDb: DbAccessor, log?: StoreLogger): TelephonyStore` with `read(): Promise<SipCredentials>` and `write(credentials): Promise<SipCredentials>`. The `telephonyStore` singleton keeps its name, so `app/api/telephony/route.ts` and `app/(console)/telephony/page.tsx` are untouched.

- [ ] **Step 1: Write the failing test**

Replace the entire contents of `server/config/telephony-store.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test server/config/telephony-store.test.ts`
Expected: FAIL — the store still takes a directory string.

- [ ] **Step 3: Replace the store**

Replace the entire contents of `server/config/telephony-store.ts`:

```ts
/**
 * Persistence for the bridge's SIP credentials.
 *
 * One document, `_id: "singleton"`, in `telephony_credentials`. A write is a
 * single upsert, so nothing needs serialising in-process.
 *
 * A missing document is the first-run path and reads as unconfigured. A
 * document that fails validation also reads as unconfigured and is left where
 * it is. A database that cannot be reached THROWS, so an outage can never look
 * like "no credentials" and get saved over.
 *
 * This document holds a SIP password. Only an error's name is ever logged — a
 * driver error can quote the query that failed, and the query carries it.
 */

import type { Db } from "mongodb";

import {
  EMPTY_CREDENTIALS,
  validateSipCredentials,
  type SipCredentials,
} from "../../lib/telephony/credentials";
import { getDb, type DbAccessor } from "../db/client";

export type StoreLogger = (message: string) => void;

export interface TelephonyStore {
  read(): Promise<SipCredentials>;
  write(credentials: SipCredentials): Promise<SipCredentials>;
}

const COLLECTION = "telephony_credentials";
const SINGLETON = "singleton";

interface TelephonyDoc {
  _id: string;
  value: SipCredentials;
}

export function createTelephonyStore(
  getDatabase: DbAccessor,
  log: StoreLogger = () => {},
): TelephonyStore {
  async function collection() {
    const db: Db = await getDatabase();
    return db.collection<TelephonyDoc>(COLLECTION);
  }

  return {
    async read(): Promise<SipCredentials> {
      // Not wrapped in try/catch on purpose — see the note at the top.
      const doc = await (await collection()).findOne({ _id: SINGLETON });
      if (!doc) return EMPTY_CREDENTIALS;

      const result = validateSipCredentials(doc.value);
      if (!result.ok) {
        log("the stored SIP credentials failed validation; treating them as unconfigured");
        return EMPTY_CREDENTIALS;
      }
      return result.value;
    },

    async write(credentials: SipCredentials): Promise<SipCredentials> {
      await (await collection()).replaceOne(
        { _id: SINGLETON },
        { value: credentials },
        { upsert: true },
      );
      return credentials;
    },
  };
}

export const telephonyStore = createTelephonyStore(getDb, (message) =>
  console.warn(`[telephony] ${message}`),
);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test server/config/telephony-store.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Verify types**

Run: `npx tsc --noEmit`
Expected: no errors.

---

### Task 4: Agent config and secrets on Mongo

Two collections in one store. The secrets change shape: one document per secret instead of one object holding all of them, which turns `setSecret` and `deleteSecret` into single atomic operations and removes the read-modify-write cycle that `createQueue()` existed to protect.

**Files:**
- Modify: `server/config/store.ts`
- Modify: `server/config/store.test.ts`
- Modify: `server/voice/gemini-session.ts:85`

**Interfaces:**
- Consumes: `DbAccessor`, `getDb`, `freshDb`, `unreachableDb`.
- Produces: `createConfigStore(getDb: DbAccessor, log?: StoreLogger): ConfigStore`. `ConfigStore` keeps all six methods unchanged: `read()`, `write(config)`, `listSecretKeys()`, `resolveSecrets()`, `setSecret(key, value)`, `deleteSecret(key)`. The `configStore` singleton keeps its name, so `app/(console)/layout.tsx`, `app/api/agent-config/route.ts`, `app/api/agent-config/secrets/route.ts` and `app/api/upload/route.ts` are untouched.

- [ ] **Step 1: Write the failing test**

Replace the entire contents of `server/config/store.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test server/config/store.test.ts`
Expected: FAIL — the store still takes a directory string.

- [ ] **Step 3: Replace the store**

Replace the entire contents of `server/config/store.ts`:

```ts
/**
 * Persistence for the agent configuration.
 *
 * Two processes read this: the Next route handlers and the voice gateway. They
 * meet at the database, so neither needs to know the other exists.
 *
 * The config is one document, `_id: "singleton"`, in `agent_config`. Secrets
 * are a document EACH in `agent_secrets`, keyed by name. That split is what
 * removes the write queue this file used to carry: setting one secret no longer
 * reads every secret, mutates the set, and writes it back, so two callers
 * cannot lose each other's change. The old queue only ever serialised one
 * process anyway.
 *
 * Secret values are never returned by `read()`, and nothing outside this module
 * reads them.
 */

import type { Db } from "mongodb";

import { DEFAULT_AGENT_CONFIG } from "../../lib/agent-config/defaults";
import {
  AGENT_CONFIG_VERSION,
  LIMITS,
  SECRET_KEY_RE,
  validateAgentConfig,
  type AgentConfig,
} from "../../lib/agent-config/schema";
import { getDb, type DbAccessor } from "../db/client";

export type StoreLogger = (message: string) => void;

export interface ConfigStore {
  /** The saved config, or the seed defaults if none is stored. */
  read(): Promise<AgentConfig>;
  /** Persists a config, stamping `updatedAt`. Returns what was written. */
  write(config: AgentConfig): Promise<AgentConfig>;
  listSecretKeys(): Promise<string[]>;
  /**
   * Secret VALUES, for resolving `{{NAME}}` references when the gateway calls a
   * tool on the agent's behalf.
   *
   * The only reader is the tool runner in the gateway process. Nothing in
   * `app/` may call this: the contract everywhere else is that values never
   * leave the server, and an API route that returned them would break it.
   */
  resolveSecrets(): Promise<Record<string, string>>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}

const CONFIG_COLLECTION = "agent_config";
const SECRETS_COLLECTION = "agent_secrets";
const SINGLETON = "singleton";

interface ConfigDoc {
  _id: string;
  value: AgentConfig;
}

interface SecretDoc {
  /** The secret's name, e.g. STRIPE_KEY. */
  _id: string;
  value: string;
}

export function createConfigStore(
  getDatabase: DbAccessor,
  log: StoreLogger = () => {},
): ConfigStore {
  async function configs() {
    const db: Db = await getDatabase();
    return db.collection<ConfigDoc>(CONFIG_COLLECTION);
  }

  async function secrets() {
    const db: Db = await getDatabase();
    return db.collection<SecretDoc>(SECRETS_COLLECTION);
  }

  return {
    async read(): Promise<AgentConfig> {
      // Deliberately uncaught: a connection or query failure must reach the
      // caller. If it read as "defaults" instead, an outage would render the
      // editor with seed values and the next save would overwrite real work.
      const doc = await (await configs()).findOne({ _id: SINGLETON });

      // No document is the first-run path, not a failure. structuredClone
      // rather than a shallow copy, so nested objects (models, welcome,
      // variables) are not shared across every fallback read in this process.
      if (!doc) return structuredClone(DEFAULT_AGENT_CONFIG);

      const record = doc.value as Partial<AgentConfig> | null;
      if (typeof record !== "object" || record === null) {
        log("the stored agent config is not an object, using defaults");
        return structuredClone(DEFAULT_AGENT_CONFIG);
      }
      if (record.version !== AGENT_CONFIG_VERSION) {
        // Left in the database untouched so the user's data stays recoverable.
        log(
          `the stored agent config has unsupported version ${String(record.version)}, using defaults`,
        );
        return structuredClone(DEFAULT_AGENT_CONFIG);
      }

      const result = validateAgentConfig(record);
      if (!result.ok) {
        // Left in the database untouched so the user's data stays recoverable.
        const summary = result.errors.map((error) => error.path || "(root)").join(", ");
        log(`the stored agent config failed validation (${summary}), using defaults`);
        return structuredClone(DEFAULT_AGENT_CONFIG);
      }

      // validateAgentConfig stamps updatedAt with "now"; the stored value is
      // the truth about when this config was last saved.
      return {
        ...result.config,
        updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : result.config.updatedAt,
      };
    },

    async write(config: AgentConfig): Promise<AgentConfig> {
      const saved: AgentConfig = {
        ...config,
        version: AGENT_CONFIG_VERSION,
        secretKeys: [],
        updatedAt: new Date().toISOString(),
      };
      await (await configs()).replaceOne(
        { _id: SINGLETON },
        { value: saved },
        { upsert: true },
      );
      return saved;
    },

    async resolveSecrets(): Promise<Record<string, string>> {
      try {
        const docs = await (await secrets()).find({}).toArray();
        return Object.fromEntries(docs.map((doc) => [doc._id, doc.value]));
      } catch (cause) {
        // The one place that still swallows a failure, and it is deliberate.
        // Leaving tools unauthenticated is better than taking a live call down:
        // the request then fails with the endpoint's own 401, which is a
        // legible outcome. Only the error's NAME is logged — a driver error can
        // quote the query, and this query is about secret material.
        log(`the secrets could not be read (${(cause as Error).name})`);
        return {};
      }
    },

    async listSecretKeys(): Promise<string[]> {
      const docs = await (await secrets())
        .find({}, { projection: { _id: 1 } })
        .toArray();
      return docs.map((doc) => doc._id).sort();
    },

    async setSecret(key: string, value: string): Promise<void> {
      if (!SECRET_KEY_RE.test(key) || key.length > LIMITS.secretKeyMax) {
        throw new Error("Secret key must be UPPER_SNAKE_CASE.");
      }
      if (value.length > LIMITS.secretValueMax) {
        throw new Error(`Secret value must be at most ${LIMITS.secretValueMax} characters.`);
      }
      // One document, one upsert. No read-modify-write, so no queue.
      await (await secrets()).updateOne({ _id: key }, { $set: { value } }, { upsert: true });
    },

    async deleteSecret(key: string): Promise<void> {
      await (await secrets()).deleteOne({ _id: key });
    },
  };
}

/**
 * The instance every caller in this process should use.
 *
 * The gateway builds its own store with its own logger; this one serves the
 * Next process, where a silent fallback previously meant a rejected config
 * produced no output anywhere and the editor showed seed defaults with no clue
 * that saved work had been refused.
 */
export const configStore = createConfigStore(getDb, (message) =>
  console.warn(`[agent-config] ${message}`),
);
```

- [ ] **Step 4: Update the gateway's own store construction**

In `server/voice/gemini-session.ts`, the `loadResolvedAgentConfig` function builds its own store. Change the construction line from:

```ts
    const store = createConfigStore(path.join(process.cwd(), "data"), log);
```

to:

```ts
    const store = createConfigStore(getDb, log);
```

Update its imports: add `import { getDb } from "../db/client";` alongside the existing `createConfigStore` import, and **remove the now-unused `import path from "node:path";`** if nothing else in the file uses it (check with `grep -n "path\." server/voice/gemini-session.ts` first — remove the import only if there are no remaining uses).

The surrounding `try`/`catch` in that function stays exactly as it is. It is now load-bearing in a new way: `store.read()` can genuinely throw when Mongo is unreachable, and this catch is what lets a call still connect on default config rather than failing outright.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --import tsx --test server/config/store.test.ts`
Expected: PASS, 19 tests.

- [ ] **Step 6: Verify types**

Run: `npx tsc --noEmit`
Expected: no errors.

---

### Task 5: Call log store on Mongo

Appends become inserts, so the 500-record cap loses its reason to exist and is removed.

**Files:**
- Modify: `server/config/call-log-store.ts`
- Modify: `server/config/call-log-store.test.ts`

**Interfaces:**
- Consumes: `DbAccessor`, `getDb`, `freshDb`, `unreachableDb`.
- Produces: `createCallLogStore(getDb: DbAccessor, log?: StoreLogger): CallLogStore` with `read(): Promise<CallRecord[]>`, `append(record): Promise<void>`, `update(id, patch): Promise<void>`. **`MAX_RECORDS` is no longer exported** — it is the only removed export in this plan, and nothing outside the store's own test ever imported it (verify with `grep -rn "MAX_RECORDS" --include="*.ts" --include="*.tsx" . | grep -v node_modules`). The `callLogStore` singleton keeps its name, so `app/(console)/calls/page.tsx`, `app/(console)/calls/[id]/page.tsx`, `app/api/calls/route.ts` and `server/voice/websocket-server.ts` are untouched.

- [ ] **Step 1: Write the failing test**

Replace the entire contents of `server/config/call-log-store.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test server/config/call-log-store.test.ts`
Expected: FAIL — the store still takes a directory string, and `MAX_RECORDS` is no longer imported by the test but is still exported by the store.

- [ ] **Step 3: Replace the store**

Replace the entire contents of `server/config/call-log-store.ts`:

```ts
/**
 * Persistence for finished call records.
 *
 * Written by the voice gateway when a call ends and read by the Next process to
 * display them, so — like the agent configuration — the database is the meeting
 * point and neither process needs to know the other exists.
 *
 * One document per call, `_id` being the record's own id. An append is a single
 * insert rather than a rewrite of the whole history, which is why there is no
 * write queue here any more and why there is no longer a cap on how many
 * records are kept: the old 500-record limit existed only so one JSON file
 * could not grow without bound.
 */

import type { Db } from "mongodb";

import type { CallRecord } from "../../lib/call-logs/types";
import { getDb, type DbAccessor } from "../db/client";

export type StoreLogger = (message: string) => void;

export interface CallLogStore {
  /** Newest first. */
  read(): Promise<CallRecord[]>;
  append(record: CallRecord): Promise<void>;
  /**
   * Amends a record in place, for detail that arrives after the call — the
   * summary is written once the transcript has been through a text model.
   * A record that is not there is a no-op.
   */
  update(id: string, patch: (record: CallRecord) => CallRecord): Promise<void>;
}

const COLLECTION = "call_logs";

/** The record as stored: its own id doubles as the document key. */
type CallLogDoc = CallRecord & { _id: string };

export function createCallLogStore(
  getDatabase: DbAccessor,
  log: StoreLogger = () => {},
): CallLogStore {
  async function collection() {
    const db: Db = await getDatabase();
    return db.collection<CallLogDoc>(COLLECTION);
  }

  return {
    async read(): Promise<CallRecord[]> {
      // Sorted on startedAt rather than insertion order, backed by the index
      // created in server/db/client.ts. The _id tie-break only decides records
      // that started in the same millisecond, and exists so the order is at
      // least stable when that happens.
      const docs = await (await collection())
        .find({})
        .sort({ startedAt: -1, _id: -1 })
        .toArray();
      return docs.map(({ _id, ...record }) => record as CallRecord);
    },

    async append(record: CallRecord): Promise<void> {
      await (await collection()).insertOne({ ...record, _id: record.id } as CallLogDoc);
    },

    async update(id: string, patch: (record: CallRecord) => CallRecord): Promise<void> {
      const calls = await collection();
      const doc = await calls.findOne({ _id: id });
      if (!doc) {
        // Worth a line now. Under the old file store a record could fall off
        // the 500-record cap and legitimately vanish before its summary
        // arrived; with no cap, a missing record means something unexpected.
        log(`there is no call record ${id} to update`);
        return;
      }

      const { _id, ...current } = doc;
      const next = patch(current as CallRecord);
      // No `_id` in the replacement: mongodb v7 types it `WithoutId<TSchema>`,
      // and the filter's `_id` is what identifies the document anyway.
      await calls.replaceOne({ _id: id }, next);
    },
  };
}

/** The instance the Next process should use. */
export const callLogStore = createCallLogStore(getDb, (message) =>
  console.warn(`[call-logs] ${message}`),
);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test server/config/call-log-store.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Confirm nothing else imported MAX_RECORDS**

Run: `grep -rn "MAX_RECORDS" --include="*.ts" --include="*.tsx" . | grep -v node_modules`
Expected: no output.

- [ ] **Step 6: Verify types**

Run: `npx tsc --noEmit`
Expected: no errors.

---

### Task 6: API key store on Mongo

The most substantive change. Two files collapse into one collection, which removes the lost-update hazard the current header comment documents at length.

**Files:**
- Modify: `server/config/api-key-store.ts`
- Modify: `server/config/api-key-store.test.ts`

**Interfaces:**
- Consumes: `DbAccessor`, `getDb`, `freshDb`, `unreachableDb`.
- Produces: `createApiKeyStore(getDb: DbAccessor, log?: StoreLogger): ApiKeyStore` with `list(): Promise<ApiKeySummary[]>`, `mint(name): Promise<MintedApiKey>`, `verify(presented): Promise<ApiKeySummary | null>`, `revoke(id): Promise<boolean>`. All four signatures unchanged, so `app/api/api-keys/route.ts`, `app/(console)/settings/keys/page.tsx` and `server/voice/websocket-server.ts:253` are untouched.

- [ ] **Step 1: Write the failing test**

Replace the entire contents of `server/config/api-key-store.test.ts`:

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { FINGERPRINT_CHARS, MAX_KEYS, MAX_NAME_CHARS } from "../../lib/api-keys/types";
import { freshDb, startTestMongo, stopTestMongo, unreachableDb } from "../db/test-db";
import { createApiKeyStore } from "./api-key-store";

before(startTestMongo);
after(stopTestMongo);

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Waits for the fire-and-forget lastUsedAt write kicked off by verify(). */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

test("a fresh store lists nothing", async () => {
  const store = createApiKeyStore(await freshDb());
  assert.deepEqual(await store.list(), []);
});

test("mint returns the plaintext key once, and a summary", async () => {
  const store = createApiKeyStore(await freshDb());
  const minted = await store.mint("gateway");

  assert.equal(typeof minted.key, "string");
  assert.equal(minted.key.length, 43);
  assert.equal(minted.record.name, "gateway");
  assert.equal(minted.record.lastUsedAt, null);
  assert.equal(minted.record.fingerprint.length, FINGERPRINT_CHARS);
});

test("the plaintext key is never stored", async () => {
  const getDb = await freshDb();
  const store = createApiKeyStore(getDb);
  const minted = await store.mint("gateway");

  const db = await getDb();
  const docs = await db.collection("api_keys").find({}).toArray();
  assert.equal(JSON.stringify(docs).includes(minted.key), false);
  assert.equal((docs[0] as { hash: string }).hash, sha256Hex(minted.key));
});

test("list is newest first", async () => {
  const store = createApiKeyStore(await freshDb());
  await store.mint("older");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await store.mint("newer");

  assert.deepEqual(
    (await store.list()).map((key) => key.name),
    ["newer", "older"],
  );
});

test("mint rejects a blank name", async () => {
  const store = createApiKeyStore(await freshDb());
  await assert.rejects(() => store.mint("   "), /name/i);
});

test("mint rejects an over-long name", async () => {
  const store = createApiKeyStore(await freshDb());
  await assert.rejects(() => store.mint("x".repeat(MAX_NAME_CHARS + 1)), /at most/);
});

test("mint refuses past the key cap", async () => {
  const store = createApiKeyStore(await freshDb());
  for (let index = 0; index < MAX_KEYS; index += 1) await store.mint(`key-${index}`);
  await assert.rejects(() => store.mint("one too many"), /Revoke one first/);
});

test("verify accepts a minted key", async () => {
  const store = createApiKeyStore(await freshDb());
  const minted = await store.mint("gateway");

  const verified = await store.verify(minted.key);
  assert.equal(verified?.id, minted.record.id);
});

test("verify rejects an unknown, blank or malformed key", async () => {
  const store = createApiKeyStore(await freshDb());
  await store.mint("gateway");

  assert.equal(await store.verify("not-a-key"), null);
  assert.equal(await store.verify(""), null);
  assert.equal(await store.verify("   "), null);
  assert.equal(await store.verify("x".repeat(300)), null);
});

test("verify stamps lastUsedAt", async () => {
  const store = createApiKeyStore(await freshDb());
  const minted = await store.mint("gateway");

  const verified = await store.verify(minted.key);
  assert.ok(verified?.lastUsedAt);
  await settle();

  const [listed] = await store.list();
  assert.equal(listed.lastUsedAt, verified?.lastUsedAt);
});

test("revoke removes a key and returns true", async () => {
  const store = createApiKeyStore(await freshDb());
  const minted = await store.mint("gateway");

  assert.equal(await store.revoke(minted.record.id), true);
  assert.deepEqual(await store.list(), []);
});

test("revoking something that is not there returns false", async () => {
  const store = createApiKeyStore(await freshDb());
  assert.equal(await store.revoke("no-such-id"), false);
});

test("a revoked key stops verifying", async () => {
  const store = createApiKeyStore(await freshDb());
  const minted = await store.mint("gateway");
  await store.revoke(minted.record.id);

  assert.equal(await store.verify(minted.key), null);
});

test("concurrent mints across two store instances all survive", async () => {
  // The case server/config/api-key-store.ts used to document as BROKEN: two
  // processes each rewriting the whole key file would lose each other's mints.
  const getDb = await freshDb();
  const gateway = createApiKeyStore(getDb);
  const console_ = createApiKeyStore(getDb);

  await Promise.all([
    gateway.mint("a"),
    console_.mint("b"),
    gateway.mint("c"),
    console_.mint("d"),
  ]);

  assert.equal((await gateway.list()).length, 4);
});

test("a usage stamp landing after a revoke does not resurrect the key", async () => {
  const getDb = await freshDb();
  const gateway = createApiKeyStore(getDb);
  const console_ = createApiKeyStore(getDb);
  const minted = await gateway.mint("gateway");

  await gateway.verify(minted.key);
  await console_.revoke(minted.record.id);
  await settle();

  assert.deepEqual(await console_.list(), []);
});

test("an unreachable database throws from verify, so the gateway fails closed", async () => {
  const store = createApiKeyStore(unreachableDb(), () => {});
  await assert.rejects(() => store.verify("anything-at-all"));
});

test("an unreachable database throws from list", async () => {
  const store = createApiKeyStore(unreachableDb(), () => {});
  await assert.rejects(() => store.list());
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test server/config/api-key-store.test.ts`
Expected: FAIL — the store still takes a directory string.

- [ ] **Step 3: Replace the store**

Replace the entire contents of `server/config/api-key-store.ts`:

```ts
/**
 * Persistence for the gateway's API keys.
 *
 * The gateway opens a billed Gemini session for whoever connects to it, so a
 * key is what separates "a client of this service" from "anyone who can reach
 * port 4000". Keys are minted in the console and presented by the client on the
 * WebSocket upgrade.
 *
 * Only a SHA-256 hash is stored. `mint` hands the plaintext back exactly once
 * and nothing — not this store, not the database, not the listing — can produce
 * it again; a lost key is re-minted, never recovered. That is why `list()`
 * returns a short fingerprint instead: enough to tell two keys apart in the UI,
 * useless as a credential.
 *
 * This used to be TWO files, and the split was load-bearing: Next mints and
 * revokes while the gateway stamps usage, and with whole-file rewrites a stamp
 * could undo a revoke — silently putting a revoked key back. One document per
 * key removes the problem at the root rather than working around it. A stamp is
 * `$set` on one document and a revoke is `deleteOne` on another; the stamp
 * simply matches nothing once the key is gone, so the two cannot fight. The
 * multi-writer hazard that comment warned about is gone with it.
 *
 * A database that cannot be reached makes `verify` THROW, which the gateway's
 * `verifyClient` catches and turns into a refusal. That is the right way round:
 * while keys cannot be checked, nobody gets a billed session.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { Db } from "mongodb";

import {
  FINGERPRINT_CHARS,
  MAX_KEYS,
  MAX_NAME_CHARS,
  type ApiKeySummary,
  type MintedApiKey,
} from "../../lib/api-keys/types";
import { getDb, type DbAccessor } from "../db/client";

export type StoreLogger = (message: string) => void;

/**
 * Longest string worth hashing on an upgrade. A minted key is 43 characters
 * (32 random bytes as base64url); anything far longer is not a typo.
 */
const MAX_PRESENTED_CHARS = 256;

const COLLECTION = "api_keys";

/** What is written. The hash never leaves this module. */
interface ApiKeyDoc {
  _id: string;
  name: string;
  /** SHA-256 of the plaintext key, hex encoded. Uniquely indexed. */
  hash: string;
  createdAt: string;
  /** ISO time this key was last accepted, or null if never. */
  lastUsedAt: string | null;
}

export interface ApiKeyStore {
  /** Newest first. */
  list(): Promise<ApiKeySummary[]>;
  /** Creates a key and returns its plaintext once. Throws on a bad name. */
  mint(name: string): Promise<MintedApiKey>;
  /**
   * Checks a presented key, stamping `lastUsedAt` on a match.
   * Returns null for anything unknown, revoked, blank or malformed.
   */
  verify(presented: string): Promise<ApiKeySummary | null>;
  /** Removes a key. Returns false if there was nothing with that id. */
  revoke(id: string): Promise<boolean>;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function summarise(doc: ApiKeyDoc, lastUsedAt: string | null): ApiKeySummary {
  return {
    id: doc._id,
    name: doc.name,
    createdAt: doc.createdAt,
    lastUsedAt,
    fingerprint: doc.hash.slice(0, FINGERPRINT_CHARS),
  };
}

export function createApiKeyStore(
  getDatabase: DbAccessor,
  log: StoreLogger = () => {},
): ApiKeyStore {
  async function collection() {
    const db: Db = await getDatabase();
    return db.collection<ApiKeyDoc>(COLLECTION);
  }

  return {
    async list(): Promise<ApiKeySummary[]> {
      const docs = await (await collection()).find({}).sort({ createdAt: -1 }).toArray();
      return docs.map((doc) => summarise(doc, doc.lastUsedAt));
    },

    async mint(name: string): Promise<MintedApiKey> {
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
      };
      await keys.insertOne(doc);

      return { key, record: summarise(doc, null) };
    },

    async verify(presented: string): Promise<ApiKeySummary | null> {
      const candidate = typeof presented === "string" ? presented.trim() : "";
      if (candidate === "" || candidate.length > MAX_PRESENTED_CHARS) return null;

      // An indexed exact-match lookup, where the old file store compared every
      // record in constant time. That loop guarded a comparison against the
      // presented PLAINTEXT; what is matched here is its SHA-256 digest, and an
      // attacker cannot steer the lookup without inverting SHA-256. Nothing
      // usable leaks from how long the index takes.
      const digest = sha256Hex(candidate);
      const matched = await (await collection()).findOne({ hash: digest });
      if (!matched) return null;

      // Belt and braces: confirm in constant time that the index handed back
      // the record we asked for, so a hand-edited document cannot widen a match.
      const stored = Buffer.from(matched.hash, "hex");
      const expected = Buffer.from(digest, "hex");
      if (stored.length !== expected.length || !timingSafeEqual(stored, expected)) return null;

      // `lastUsedAt` is telemetry, not part of the decision, so the write is
      // fired and forgotten. Awaiting it would let a database problem turn every
      // correct key into a refused connection and take the phone bridge down.
      const lastUsedAt = new Date().toISOString();
      void (await collection())
        .updateOne({ _id: matched._id }, { $set: { lastUsedAt } })
        .catch((cause: unknown) => {
          log(`could not record when a key was last used (${(cause as Error).name})`);
        });

      return summarise(matched, lastUsedAt);
    },

    async revoke(id: string): Promise<boolean> {
      const result = await (await collection()).deleteOne({ _id: id });
      return result.deletedCount === 1;
    },
  };
}

/**
 * The instance both processes use: Next mints and revokes, the gateway
 * verifies. The database is the meeting point, as with every other store here,
 * so neither process needs to know the other exists.
 */
export const apiKeyStore = createApiKeyStore(getDb, (message) =>
  console.warn(`[api-keys] ${message}`),
);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test server/config/api-key-store.test.ts`
Expected: PASS, 17 tests. Note the "concurrent mints across two store instances all survive" test — it asserts the behavior the old file-backed store documented as broken.

- [ ] **Step 5: Verify types**

Run: `npx tsc --noEmit`
Expected: no errors.

---

### Task 7: Wire up shutdown, delete `data/`, verify the whole app

**Files:**
- Modify: `server/index.ts`
- Modify: `.gitignore`
- Delete: `data/`

**Interfaces:**
- Consumes: `closeDb()` from `server/db/client`.
- Produces: nothing new.

- [ ] **Step 1: Drain the pool on shutdown**

In `server/index.ts`, add to the existing imports:

```ts
import { closeDb } from "./db/client";
```

Then change the `shutdown` function so the pool is drained before exit. Replace:

```ts
  for (const client of server.clients) client.close(1001, "server shutting down");
  server.close(() => process.exit(0));
```

with:

```ts
  for (const client of server.clients) client.close(1001, "server shutting down");
  server.close(() => {
    // Drain the connection pool before leaving, so a SIGTERM closes sockets
    // cleanly rather than dropping them. Failure here must not block exit.
    void closeDb()
      .catch(() => undefined)
      .then(() => process.exit(0));
  });
```

The existing `setTimeout(() => process.exit(0), 3000).unref()` below it stays exactly as it is — it is now also the failsafe for a slow pool drain.

- [ ] **Step 2: Verify the gateway still starts and stops cleanly**

Run: `npm run gateway`
Expected: it logs `listening on ws://localhost:4000/voice`. Press Ctrl-C; expected: it logs `SIGINT received, closing 0 call(s)` and exits without hanging.

If it fails to connect to Mongo, that is the thing to fix before continuing — check `MONGODB_URI` and `MONGODB_DB` in `.env`, and that the Atlas cluster allows this IP.

- [ ] **Step 3: Remove the data directory**

```bash
rm -rf data
```

This is deliberate and was decided in the spec: Mongo starts empty, the agent config reverts to seed defaults, and call history starts from zero. Nothing reads these files any more.

- [ ] **Step 4: Remove the gitignore entry**

Delete these four lines from the end of `.gitignore` (currently lines 44-47):

```
# Local runtime state: the saved agent configuration, its secret values, and
# call history — which holds transcripts of what real callers said. None of it
# belongs in git.
/data/
```

Leave the `.env*` entry at line 34 alone — it now matters more than ever, because `MONGODB_URI` is in `.env`.

- [ ] **Step 5: Confirm no filesystem persistence remains**

Run: `grep -rn "node:fs\|writeAtomic\|createQueue\|mkdtemp\|process.cwd()" server/config/`
Expected: no output.

Run: `grep -rn "data/" --include="*.ts" --include="*.tsx" . | grep -v node_modules | grep -v docs/`
Expected: no output.

- [ ] **Step 6: Run the whole test suite**

Run: `npm test`
Expected: PASS. Every previously passing test still passes, plus the new store tests. Five `mongod` instances start across the run, so it is a few seconds slower than before.

- [ ] **Step 7: Typecheck, lint, and build**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run lint`
Expected: no errors.

Run: `npm run build`
Expected: a successful production build.

- [ ] **Step 8: Smoke-test the running app**

Run: `npm run dev`

Then check, in order:

1. Open `http://localhost:3000/agent/conversation`. Expected: the editor renders **seed defaults** — this is correct and expected, since Mongo started empty and no migration was run.
2. Change the agent name, save, and reload the page. Expected: the change persists.
3. Open `http://localhost:3000/settings/keys`, mint a key, reload. Expected: the key is listed with its fingerprint and no `lastUsedAt`.
4. Revoke that key and reload. Expected: it is gone.
5. Open `http://localhost:3000/settings/selorax`, save a configuration, reload. Expected: it persists, and the auth token is not echoed back into the page source.
6. Open `http://localhost:3000/calls`. Expected: an empty list, no error.

- [ ] **Step 9: Confirm the collections exist**

In the Atlas UI (or `mongosh`), open the `voice-ai` database. Expected: `agent_config`, `api_keys` and `selorax_config` exist with the documents just written. `agent_secrets`, `call_logs` and `telephony_credentials` appear once something is written to them — Mongo creates a collection on first insert, so their absence at this point is normal, not a fault.

- [ ] **Step 10: Report, do not commit**

Summarise what changed and leave every file uncommitted. The user commits manually.

---

## Self-Review

**Spec coverage** — every section maps to a task:

| Spec section | Task |
|---|---|
| §4 approach: keep interfaces, swap internals | 2, 3, 4, 5, 6 |
| §5 collections and indexes | 1 (indexes), 2–6 (documents) |
| §5 `startedAt` ordering with tie-break | 5 |
| §5.1 `createQueue()` deleted from all five | 2, 3, 4, 5, 6 |
| §5.1 two-file API-key split collapses | 6 |
| §5.1 `verify()` indexed lookup | 6 |
| §5.1 `MAX_RECORDS` removed | 5 |
| §6 connection lifecycle, `globalThis` cache, env vars | 1 |
| §6 `closeDb()` in gateway shutdown | 7 |
| §7 missing → defaults, unreachable → throw | 2, 3, 4, 5, 6 (a test each) |
| §7 validation failure leaves the document in place | 2, 4 |
| §7 `resolveSecrets()` exception | 4 |
| §8 secrets in Atlas, log names not messages | 2, 3, 4 |
| §9 `mongodb-memory-server` harness | 1 |
| §10 removals: `data/`, gitignore, fs imports | 7 |

**Type consistency** — `DbAccessor` is defined once in Task 1 and consumed with that exact name in Tasks 2–6. `freshDb()` returns `Promise<DbAccessor>` (async, because it creates indexes) and is awaited at every call site. `unreachableDb()` is sync and is not awaited. Store factory parameters are named `getDatabase` internally to avoid shadowing the imported `getDb` singleton accessor.

**Known deviations from current behavior**, all intentional and all covered by the spec:
- `MAX_RECORDS` is no longer exported (Task 5). The only importer was its own test.
- Call ordering is by `startedAt`, not insertion order (Task 5). Test records therefore use distinct timestamps.
- `listSecretKeys()` and `apiKeyStore.list()` now throw when the database is unreachable, where a corrupt file used to read as empty.
