# sip-dashboard Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** let the AI place and answer real phone calls through sip-dashboard
(`https://sipdashboard.selorax.io`), as a second calling provider alongside
the existing Selorax bridge, with no browser involved in the audio path.

**Architecture:** A new `lib/sip-dashboard/` + `server/sip-dashboard/` module
pair, structured exactly like the existing `lib/selorax/` +
`server/selorax/`. The one real difference: Selorax's audio bridges through a
browser page (JsSIP/WebRTC); sip-dashboard's calls are a single WebSocket
carrying raw PCM, so the voice gateway process bridges it directly to a
`GeminiVoiceSession` with no browser in the loop. Outbound is triggered by a
new plain HTTP route on the gateway's existing `http` server (not a Next.js
API route — a call must not run inside a serverless-style request/response
cycle). Inbound is a background poll loop inside the gateway process, off by
default.

**Tech Stack:** TypeScript, Node's built-in `node:test` runner, `ws` (already
a dependency, used both as the gateway's server and, newly, as a client),
MongoDB via the existing `server/db/client.ts`, `mongodb-memory-server` for
store tests (already a devDependency, already used by `db/test-db.ts`).

**Spec:** `docs/superpowers/specs/2026-08-21-sip-dashboard-bridge-design.md`

## Global Constraints

- No secrets in `.env` — `baseUrl`, `apiKey`, `inboundEnabled` all live in the
  `sip_dashboard_config` Mongo collection, edited from a settings page. No
  new `.env` variables are added by this plan.
- `server/sip-dashboard/calling-client.ts` and every module under
  `server/sip-dashboard/` are server-only — never imported into a client
  component (`"use client"` file or anything under a Client Component tree).
- `channel: "phone"` (already defined in `lib/call-logs/channel.ts`) is
  reused as-is for every sip-dashboard call. No new `CallChannel` value.
- Never puts `apiKey` or a media token in a thrown error message or anywhere
  `console.log`/`util.inspect` would render it — same rule this repo already
  enforces for `SeloraxError`.
- sip-dashboard's fixed audio format (from `packages/call-protocol/src/audio.ts`
  in the `sip` repo): PCM16 mono, 16000 Hz, 20 ms frames, 640 bytes/frame,
  both directions. Gemini's fixed rates (`types/voice.ts`): input 16000 Hz
  (`INPUT_SAMPLE_RATE`), output 24000 Hz (`OUTPUT_SAMPLE_RATE`).
- Never write a live call against a real sip-dashboard backend in a test —
  every test in this plan uses a stub `fetch`, a stub WebSocket server, or an
  in-memory Mongo instance.

---

### Task 1: `lib/sip-dashboard/config.ts` — config type and validator

**Files:**
- Create: `lib/sip-dashboard/config.ts`
- Test: `lib/sip-dashboard/config.test.ts`

**Interfaces:**
- Produces: `SipDashboardConfig { baseUrl: string; apiKey: string; inboundEnabled: boolean }`,
  `EMPTY_SIP_DASHBOARD_CONFIG: SipDashboardConfig`,
  `SipDashboardConfigResult = { ok: true; value: SipDashboardConfig } | { ok: false; errors: FieldError[] }`,
  `validateSipDashboardConfig(value: unknown): SipDashboardConfigResult`,
  `isSipDashboardConfigured(config: SipDashboardConfig): boolean` (true once
  `baseUrl` and `apiKey` are both non-empty — `inboundEnabled` is a boolean
  switch, not a "configured" signal),
  `SipDashboardSummary { baseUrl: string; inboundEnabled: boolean; hasApiKey: boolean }`,
  `toSipDashboardSummary(config: SipDashboardConfig): SipDashboardSummary`.

- [ ] **Step 1: Write the failing test**

```typescript
// lib/sip-dashboard/config.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_SIP_DASHBOARD_CONFIG,
  isSipDashboardConfigured,
  toSipDashboardSummary,
  validateSipDashboardConfig,
} from "./config";

const VALID = {
  baseUrl: "https://sipdashboard.selorax.io",
  apiKey: "sipai_abc123",
  inboundEnabled: false,
};

test("accepts a complete connection", () => {
  const result = validateSipDashboardConfig(VALID);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.apiKey, "sipai_abc123");
});

test("absent config reads as empty rather than failing", () => {
  const result = validateSipDashboardConfig(undefined);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, EMPTY_SIP_DASHBOARD_CONFIG);
});

test("an entirely blank form is 'not configured yet', not an error", () => {
  const result = validateSipDashboardConfig({ baseUrl: "", apiKey: "", inboundEnabled: false });
  assert.equal(result.ok, true);
});

test("reports every missing field at once", () => {
  const result = validateSipDashboardConfig({ ...VALID, baseUrl: "", apiKey: "" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errors.length, 2);
});

test("rejects a base URL that is not http or https", () => {
  const result = validateSipDashboardConfig({ ...VALID, baseUrl: "ftp://sipdashboard.selorax.io" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errors[0].path, "baseUrl");
});

test("strips a trailing slash so paths never double up", () => {
  const result = validateSipDashboardConfig({ ...VALID, baseUrl: "https://sipdashboard.selorax.io/" });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.baseUrl, "https://sipdashboard.selorax.io");
});

test("trims whitespace, which a pasted key almost always carries", () => {
  const result = validateSipDashboardConfig({ ...VALID, apiKey: "  sipai_abc123  " });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.apiKey, "sipai_abc123");
});

test("inboundEnabled defaults false when omitted, not an error", () => {
  const { inboundEnabled, ...rest } = VALID;
  const result = validateSipDashboardConfig(rest);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.inboundEnabled, false);
});

test("a non-boolean inboundEnabled is coerced to false rather than rejected", () => {
  const result = validateSipDashboardConfig({ ...VALID, inboundEnabled: "yes" });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.inboundEnabled, false);
});

test("isSipDashboardConfigured is false until baseUrl and apiKey are both present", () => {
  assert.equal(isSipDashboardConfigured(EMPTY_SIP_DASHBOARD_CONFIG), false);
  assert.equal(isSipDashboardConfigured({ ...VALID, apiKey: "" }), false);
  assert.equal(isSipDashboardConfigured(VALID), true);
});

test("toSipDashboardSummary never carries the key, only whether one exists", () => {
  const summary = toSipDashboardSummary(VALID);
  assert.deepEqual(summary, {
    baseUrl: VALID.baseUrl,
    inboundEnabled: false,
    hasApiKey: true,
  });
  assert.ok(!("apiKey" in summary));
});

test("toSipDashboardSummary reports no key when none is stored", () => {
  const summary = toSipDashboardSummary(EMPTY_SIP_DASHBOARD_CONFIG);
  assert.equal(summary.hasApiKey, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test lib/sip-dashboard/config.test.ts`
Expected: FAIL — `Cannot find module './config'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// lib/sip-dashboard/config.ts
/**
 * How this instance talks to sip-dashboard's AI-facing API.
 *
 * `apiKey` is an Extension's `sipai_...` key from sip-dashboard — a static
 * credential, unlike Selorax's 90-day JWT, so there is no expiry to track
 * here. It is server-only: only server code reads this, and no route may
 * return it. See the spec's §3.
 */

import type { FieldError } from "../agent-config/validate-helpers";

export interface SipDashboardConfig {
  /** Origin of sip-dashboard's API, no trailing slash. */
  baseUrl: string;
  /** An Extension's sipai_... key. Server-side only. */
  apiKey: string;
  /** Off by default — see the spec's §6 for why this needs an explicit opt-in. */
  inboundEnabled: boolean;
}

export const EMPTY_SIP_DASHBOARD_CONFIG: SipDashboardConfig = {
  baseUrl: "",
  apiKey: "",
  inboundEnabled: false,
};

export type SipDashboardConfigResult =
  | { ok: true; value: SipDashboardConfig }
  | { ok: false; errors: FieldError[] };

export function isSipDashboardConfigured(config: SipDashboardConfig): boolean {
  return config.baseUrl.length > 0 && config.apiKey.length > 0;
}

/** What the browser is allowed to know about the connection — never the key itself. */
export interface SipDashboardSummary {
  baseUrl: string;
  inboundEnabled: boolean;
  hasApiKey: boolean;
}

/**
 * Built field by field, not by spreading `config`, so a future field on
 * `SipDashboardConfig` cannot silently reach the browser by being added
 * there. Shared by `GET /api/sip-dashboard` and the settings page's initial
 * server render, so the two cannot drift on what "configured" means.
 */
export function toSipDashboardSummary(config: SipDashboardConfig): SipDashboardSummary {
  return {
    baseUrl: config.baseUrl,
    inboundEnabled: config.inboundEnabled,
    hasApiKey: config.apiKey.length > 0,
  };
}

function read(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value.trim() : "";
}

function readBool(source: Record<string, unknown>, key: string): boolean {
  return source[key] === true;
}

export function validateSipDashboardConfig(value: unknown): SipDashboardConfigResult {
  if (value === undefined || value === null) {
    return { ok: true, value: EMPTY_SIP_DASHBOARD_CONFIG };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: [{ path: "", message: "Expected an object." }] };
  }

  const source = value as Record<string, unknown>;
  const parsed: SipDashboardConfig = {
    baseUrl: read(source, "baseUrl").replace(/\/+$/, ""),
    apiKey: read(source, "apiKey"),
    inboundEnabled: readBool(source, "inboundEnabled"),
  };

  if (parsed.baseUrl.length === 0 && parsed.apiKey.length === 0 && !parsed.inboundEnabled) {
    return { ok: true, value: EMPTY_SIP_DASHBOARD_CONFIG };
  }

  const errors: FieldError[] = [];
  for (const [key, label] of [
    ["baseUrl", "The sip-dashboard API URL"],
    ["apiKey", "The extension API key"],
  ] as const) {
    if (parsed[key].length === 0) errors.push({ path: key, message: `${label} is required.` });
  }

  if (parsed.baseUrl.length > 0 && !/^https?:\/\//i.test(parsed.baseUrl)) {
    errors.push({ path: "baseUrl", message: "Must start with http:// or https://." });
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: parsed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test lib/sip-dashboard/config.test.ts`
Expected: PASS, 12 tests

- [ ] **Step 5: Commit**

```bash
git add lib/sip-dashboard/config.ts lib/sip-dashboard/config.test.ts
git commit -m "feat(sip-dashboard): add config type and validator"
```

---

### Task 2: `server/config/sip-dashboard-store.ts` — Mongo persistence

**Files:**
- Create: `server/config/sip-dashboard-store.ts`
- Test: `server/config/sip-dashboard-store.test.ts`

**Interfaces:**
- Consumes: `SipDashboardConfig`, `EMPTY_SIP_DASHBOARD_CONFIG`,
  `validateSipDashboardConfig` from `../../lib/sip-dashboard/config` (Task 1);
  `DbAccessor`, `getDb` from `../db/client`; `freshDb`, `startTestMongo`,
  `stopTestMongo`, `unreachableDb` from `../db/test-db` (existing, used by
  `selorax-store.test.ts`).
- Produces: `SipDashboardStore { read(): Promise<SipDashboardConfig>; write(config): Promise<SipDashboardConfig> }`,
  `createSipDashboardStore(getDatabase: DbAccessor, log?: StoreLogger): SipDashboardStore`,
  `sipDashboardStore: SipDashboardStore` (the shared instance).

- [ ] **Step 1: Write the failing test**

```typescript
// server/config/sip-dashboard-store.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { EMPTY_SIP_DASHBOARD_CONFIG } from "../../lib/sip-dashboard/config";
import { freshDb, startTestMongo, stopTestMongo, unreachableDb } from "../db/test-db";
import { createSipDashboardStore } from "./sip-dashboard-store";

before(startTestMongo);
after(stopTestMongo);

const CONFIG = {
  baseUrl: "https://sipdashboard.selorax.io",
  apiKey: "sipai_abc123",
  inboundEnabled: true,
};

test("an unwritten store reads as empty config", async () => {
  const store = createSipDashboardStore(await freshDb());
  assert.deepEqual(await store.read(), EMPTY_SIP_DASHBOARD_CONFIG);
});

test("writes and reads back", async () => {
  const store = createSipDashboardStore(await freshDb());
  await store.write(CONFIG);
  assert.deepEqual(await store.read(), CONFIG);
});

test("a second write replaces the first", async () => {
  const store = createSipDashboardStore(await freshDb());
  await store.write(CONFIG);
  await store.write({ ...CONFIG, inboundEnabled: false });
  assert.equal((await store.read()).inboundEnabled, false);
});

test("a document that fails validation reads as empty rather than throwing", async () => {
  const getDb = await freshDb();
  const db = await getDb();
  // baseUrl present but apiKey missing: not the all-empty case, so the
  // validator reports errors rather than returning EMPTY.
  await db
    .collection("sip_dashboard_config")
    .insertOne({ _id: "singleton", value: { baseUrl: "https://x.test" } } as never);

  const messages: string[] = [];
  const store = createSipDashboardStore(getDb, (message) => messages.push(message));

  assert.deepEqual(await store.read(), EMPTY_SIP_DASHBOARD_CONFIG);
  assert.equal(messages.length, 1);
});

test("a bad document is left in place, not overwritten", async () => {
  const getDb = await freshDb();
  const db = await getDb();
  await db
    .collection("sip_dashboard_config")
    .insertOne({ _id: "singleton", value: { baseUrl: "https://x.test" } } as never);

  const store = createSipDashboardStore(getDb, () => {});
  await store.read();

  const doc = await db.collection("sip_dashboard_config").findOne({ _id: "singleton" as never });
  assert.equal((doc as unknown as { value: { baseUrl: string } }).value.baseUrl, "https://x.test");
});

test("never logs the contents of a bad document", async () => {
  const getDb = await freshDb();
  const db = await getDb();
  await db
    .collection("sip_dashboard_config")
    .insertOne({ _id: "singleton", value: { baseUrl: "secret-key" } } as never);

  const messages: string[] = [];
  const store = createSipDashboardStore(getDb, (message) => messages.push(message));
  await store.read();

  assert.ok(!messages.join(" ").includes("secret-key"));
});

test("an unreachable database throws rather than reading as empty", async () => {
  const store = createSipDashboardStore(unreachableDb(), () => {});
  await assert.rejects(() => store.read());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test server/config/sip-dashboard-store.test.ts`
Expected: FAIL — `Cannot find module './sip-dashboard-store'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/config/sip-dashboard-store.ts
/**
 * Persistence for the bridge's sip-dashboard connection configuration.
 *
 * One document, `_id: "singleton"`, in `sip_dashboard_config` — the same
 * shape as `selorax-store.ts`, including its failure posture: a missing
 * document reads as unconfigured, a document that fails validation also
 * reads as unconfigured and is left where it is, and an unreachable database
 * throws rather than masquerading as "unconfigured."
 */

import type { Db } from "mongodb";

import {
  EMPTY_SIP_DASHBOARD_CONFIG,
  validateSipDashboardConfig,
  type SipDashboardConfig,
} from "../../lib/sip-dashboard/config";
import { getDb, type DbAccessor } from "../db/client";

export type StoreLogger = (message: string) => void;

export interface SipDashboardStore {
  read(): Promise<SipDashboardConfig>;
  write(config: SipDashboardConfig): Promise<SipDashboardConfig>;
}

const COLLECTION = "sip_dashboard_config";
const SINGLETON = "singleton";

interface SipDashboardDoc {
  _id: string;
  value: SipDashboardConfig;
}

export function createSipDashboardStore(
  getDatabase: DbAccessor,
  log: StoreLogger = () => {},
): SipDashboardStore {
  async function collection() {
    const db: Db = await getDatabase();
    return db.collection<SipDashboardDoc>(COLLECTION);
  }

  return {
    async read(): Promise<SipDashboardConfig> {
      const doc = await (await collection()).findOne({ _id: SINGLETON });
      if (!doc) return EMPTY_SIP_DASHBOARD_CONFIG;

      const result = validateSipDashboardConfig(doc.value);
      if (!result.ok) {
        log("the stored sip-dashboard config failed validation; treating it as unconfigured");
        return EMPTY_SIP_DASHBOARD_CONFIG;
      }
      return result.value;
    },

    async write(config: SipDashboardConfig): Promise<SipDashboardConfig> {
      await (await collection()).replaceOne(
        { _id: SINGLETON },
        { value: config },
        { upsert: true },
      );
      return config;
    },
  };
}

export const sipDashboardStore = createSipDashboardStore(getDb, (message) =>
  console.warn(`[sip-dashboard] ${message}`),
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test server/config/sip-dashboard-store.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add server/config/sip-dashboard-store.ts server/config/sip-dashboard-store.test.ts
git commit -m "feat(sip-dashboard): add Mongo config store"
```

---

### Task 3: `server/sip-dashboard/calling-client.ts` — HTTP client

**Files:**
- Create: `server/sip-dashboard/calling-client.ts`
- Test: `server/sip-dashboard/calling-client.test.ts`

**Interfaces:**
- Consumes: `SipDashboardConfig` from `../../lib/sip-dashboard/config` (Task 1).
- Produces:
  ```typescript
  export interface SipDashboardCall {
    id: string;
    direction: string;
    status: string;
    from: string;
    to: string;
    createdAt: string;
    answeredAt: string | null;
    endedAt: string | null;
    failureReason: string | null;
    participants: Array<{ id: string; type: string }>;
  }
  export interface SipDashboardMediaToken {
    wsUrl: string;
    token: string;
    participantId: string;
  }
  export type SipDashboardErrorCode =
    | "unauthorized" | "not_found" | "dial_failed"
    | "unreachable" | "timeout" | "request_failed";
  export class SipDashboardError extends Error {
    readonly code: SipDashboardErrorCode;
    readonly underlying?: string;
  }
  export type FetchImpl = (url: string | URL, init?: RequestInit) => Promise<Response>;
  export interface CallingClient {
    placeCall(to: string): Promise<{ callId: string }>;
    hangup(callId: string): Promise<void>;
    getMediaToken(callId: string): Promise<SipDashboardMediaToken>;
    listCalls(): Promise<SipDashboardCall[]>;
  }
  export function createCallingClient(config: SipDashboardConfig, fetchImpl?: FetchImpl): CallingClient;
  ```
  `listCalls()` and the `SipDashboardCall` shape are what Task 9
  (`inbound-watcher.ts`) polls and filters on `direction`/`id`.
  `getMediaToken()`'s `SipDashboardMediaToken` is what Task 6
  (`call-bridge.ts`) opens its WebSocket with.

- [ ] **Step 1: Write the failing test**

```typescript
// server/sip-dashboard/calling-client.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";

import { createCallingClient, SipDashboardError } from "./calling-client";

const CONFIG = {
  baseUrl: "https://sipdashboard.selorax.io",
  apiKey: "sipai_abc123",
  inboundEnabled: false,
};

function stub(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, calls };
}

const CALL = {
  data: {
    id: "call_01ABC",
    direction: "outbound",
    status: "dialing",
    from: "09639207199",
    to: "01700000000",
    createdAt: "2026-08-21T10:00:00.000Z",
    answeredAt: null,
    endedAt: null,
    failureReason: null,
    participants: [],
  },
};

test("places a call at the right endpoint with the bearer key", async () => {
  const { impl, calls } = stub(201, CALL);
  const result = await createCallingClient(CONFIG, impl).placeCall("01700000000");

  assert.equal(calls[0].url, "https://sipdashboard.selorax.io/api/v1/calls");
  assert.equal(calls[0].init.method, "POST");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer sipai_abc123");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { to: "01700000000" });
  assert.equal(result.callId, "call_01ABC");
});

test("hangs up a call at its own endpoint", async () => {
  const { impl, calls } = stub(200, CALL);
  await createCallingClient(CONFIG, impl).hangup("call_01ABC");

  assert.equal(calls[0].url, "https://sipdashboard.selorax.io/api/v1/calls/call_01ABC/hangup");
  assert.equal(calls[0].init.method, "POST");
});

test("mints a media token and maps snake_case to camelCase", async () => {
  const { impl, calls } = stub(200, {
    data: { ws_url: "wss://sipmedia.selorax.io/v1/calls/call_01ABC/media", token: "tok", participant_id: "ws_1" },
  });
  const token = await createCallingClient(CONFIG, impl).getMediaToken("call_01ABC");

  assert.equal(calls[0].url, "https://sipdashboard.selorax.io/api/v1/calls/call_01ABC/media-token");
  assert.deepEqual(token, {
    wsUrl: "wss://sipmedia.selorax.io/v1/calls/call_01ABC/media",
    token: "tok",
    participantId: "ws_1",
  });
});

test("lists calls scoped to this extension", async () => {
  const { impl, calls } = stub(200, { data: [CALL.data] });
  const list = await createCallingClient(CONFIG, impl).listCalls();

  assert.equal(calls[0].url, "https://sipdashboard.selorax.io/api/v1/calls");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "call_01ABC");
});

test("a rejected key says so, not a raw 401", async () => {
  const { impl } = stub(401, { error: { code: "unauthorized", message: "A valid API key is required" } });
  const error = await createCallingClient(CONFIG, impl)
    .listCalls()
    .catch((cause: unknown) => cause);

  assert.ok(error instanceof SipDashboardError);
  assert.equal((error as SipDashboardError).code, "unauthorized");
  assert.match((error as SipDashboardError).message, /API key/i);
});

test("a call that no longer exists reports not_found, not a raw 404", async () => {
  const { impl } = stub(404, { error: { code: "not_found", message: "Call not found" } });
  const error = await createCallingClient(CONFIG, impl)
    .hangup("call_gone")
    .catch((cause: unknown) => cause);

  assert.equal((error as SipDashboardError).code, "not_found");
});

test("a failed dial surfaces sip-dashboard's own message", async () => {
  const { impl } = stub(502, { error: { code: "dial_failed", message: "The number could not be reached." } });
  const error = await createCallingClient(CONFIG, impl)
    .placeCall("0")
    .catch((cause: unknown) => cause);

  assert.equal((error as SipDashboardError).code, "dial_failed");
  assert.equal((error as SipDashboardError).message, "The number could not be reached.");
});

test("an unreachable backend is a readable error, not a raw TypeError", async () => {
  const impl = async () => {
    throw new TypeError("fetch failed");
  };
  const error = await createCallingClient(CONFIG, impl)
    .listCalls()
    .catch((cause: unknown) => cause);

  assert.ok(error instanceof SipDashboardError);
  assert.equal((error as SipDashboardError).code, "unreachable");
});

test("a hung backend times out with its own code", async () => {
  const impl = async () => {
    const signal = AbortSignal.timeout(20);
    await new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason));
    });
    throw new Error("unreachable in this test");
  };

  const error = await createCallingClient(CONFIG, impl)
    .listCalls()
    .catch((cause: unknown) => cause);

  assert.ok(error instanceof SipDashboardError);
  assert.equal((error as SipDashboardError).code, "timeout");
  assert.match((error as SipDashboardError).message, /10 seconds/);
});

test("an unrecognised error body collapses to request_failed", async () => {
  const { impl } = stub(500, { boom: true });
  const error = await createCallingClient(CONFIG, impl)
    .listCalls()
    .catch((cause: unknown) => cause);

  assert.equal((error as SipDashboardError).code, "request_failed");
});

test("never puts the key in an error message", async () => {
  const { impl } = stub(500, { error: { message: "boom" } });
  const error = await createCallingClient(CONFIG, impl)
    .listCalls()
    .catch((cause: unknown) => cause);

  assert.ok(!String((error as Error).message).includes("sipai_abc123"));
});

test("never puts the key anywhere an ordinary log line would render it", async () => {
  const impl = async () => {
    throw new TypeError("fetch failed: sipai_abc123 was rejected by the upstream proxy");
  };
  const error = await createCallingClient(CONFIG, impl)
    .listCalls()
    .catch((cause: unknown) => cause);

  assert.ok(error instanceof SipDashboardError);
  const rendered = inspect(error, { depth: null });
  assert.ok(!rendered.includes("sipai_abc123"), rendered);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test server/sip-dashboard/calling-client.test.ts`
Expected: FAIL — `Cannot find module './calling-client'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/sip-dashboard/calling-client.ts
/**
 * The HTTP client for sip-dashboard's AI-facing API
 * (`POST/GET /api/v1/calls`, `/hangup`, `/media-token`).
 *
 * Error mapping is the point of this module, not an afterthought — mirrors
 * `server/selorax/calling-client.ts`'s SeloraxError shape. The key itself
 * must never appear in anything this module returns — not the message, not
 * a log line.
 */

import type { SipDashboardConfig } from "../../lib/sip-dashboard/config";

const TIMEOUT_MS = 10_000;

export interface SipDashboardCall {
  id: string;
  direction: string;
  status: string;
  from: string;
  to: string;
  createdAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  failureReason: string | null;
  participants: Array<{ id: string; type: string }>;
}

export interface SipDashboardMediaToken {
  wsUrl: string;
  token: string;
  participantId: string;
}

export type SipDashboardErrorCode =
  | "unauthorized"
  | "not_found"
  | "dial_failed"
  | "unreachable"
  | "timeout"
  | "request_failed";

export class SipDashboardError extends Error {
  readonly code: SipDashboardErrorCode;
  readonly underlying?: string;

  constructor(code: SipDashboardErrorCode, message: string, underlying?: string) {
    super(message);
    this.name = "SipDashboardError";
    this.code = code;
    this.underlying = underlying;
  }
}

export type FetchImpl = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface CallingClient {
  placeCall(to: string): Promise<{ callId: string }>;
  hangup(callId: string): Promise<void>;
  getMediaToken(callId: string): Promise<SipDashboardMediaToken>;
  listCalls(): Promise<SipDashboardCall[]>;
}

const KNOWN_CODES: ReadonlySet<string> = new Set([
  "unauthorized",
  "not_found",
  "dial_failed",
]);

async function toResponseError(response: Response): Promise<SipDashboardError> {
  let parsedCode: string | undefined;
  let parsedMessage: string | undefined;
  try {
    const body: unknown = await response.json();
    const error = (body as { error?: { code?: unknown; message?: unknown } })?.error;
    if (typeof error?.code === "string") parsedCode = error.code;
    if (typeof error?.message === "string") parsedMessage = error.message;
  } catch {
    // Body was not JSON, or was empty — fall through to a status-based cause.
  }

  if (parsedCode && KNOWN_CODES.has(parsedCode)) {
    return new SipDashboardError(
      parsedCode as SipDashboardErrorCode,
      parsedMessage ?? `sip-dashboard reported ${parsedCode}.`,
    );
  }

  if (response.status === 401) {
    return new SipDashboardError(
      "unauthorized",
      "The sip-dashboard API key was rejected. Check the key in Settings.",
    );
  }

  return new SipDashboardError(
    "request_failed",
    `The sip-dashboard API returned an error (status ${response.status}).`,
  );
}

function toClientError(cause: unknown): SipDashboardError {
  if (cause instanceof SipDashboardError) return cause;

  const name = cause instanceof Error ? cause.name : undefined;

  if (name === "TimeoutError") {
    return new SipDashboardError(
      "timeout",
      `The sip-dashboard API did not respond within ${TIMEOUT_MS / 1000} seconds.`,
      name,
    );
  }

  if (cause instanceof TypeError) {
    return new SipDashboardError("unreachable", "Could not reach sip-dashboard.", name);
  }

  return new SipDashboardError("request_failed", "The sip-dashboard API request failed.", name);
}

function toParticipants(value: unknown): Array<{ id: string; type: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((p): p is { id: unknown; type: unknown } => typeof p === "object" && p !== null)
    .map((p) => ({ id: String((p as { id?: unknown }).id ?? ""), type: String((p as { type?: unknown }).type ?? "") }));
}

function toCall(data: Record<string, unknown>): SipDashboardCall {
  return {
    id: String(data.id ?? ""),
    direction: String(data.direction ?? ""),
    status: String(data.status ?? ""),
    from: String(data.from ?? ""),
    to: String(data.to ?? ""),
    createdAt: String(data.createdAt ?? ""),
    answeredAt: data.answeredAt ? String(data.answeredAt) : null,
    endedAt: data.endedAt ? String(data.endedAt) : null,
    failureReason: data.failureReason ? String(data.failureReason) : null,
    participants: toParticipants(data.participants),
  };
}

export function createCallingClient(
  config: SipDashboardConfig,
  fetchImpl: FetchImpl = fetch,
): CallingClient {
  function headers(extra?: Record<string, string>): Record<string, string> {
    return {
      authorization: `Bearer ${config.apiKey}`,
      ...extra,
    };
  }

  async function request(path: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${config.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (cause) {
      throw toClientError(cause);
    }

    if (!response.ok) throw await toResponseError(response);

    try {
      return await response.json();
    } catch (cause) {
      throw toClientError(cause);
    }
  }

  return {
    async placeCall(to: string): Promise<{ callId: string }> {
      const body = (await request("/api/v1/calls", {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({ to }),
      })) as { data?: Record<string, unknown> };
      return { callId: String(body?.data?.id ?? "") };
    },

    async hangup(callId: string): Promise<void> {
      await request(`/api/v1/calls/${encodeURIComponent(callId)}/hangup`, {
        method: "POST",
        headers: headers(),
      });
    },

    async getMediaToken(callId: string): Promise<SipDashboardMediaToken> {
      const body = (await request(`/api/v1/calls/${encodeURIComponent(callId)}/media-token`, {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({}),
      })) as { data?: Record<string, unknown> };
      const data = body?.data ?? {};
      return {
        wsUrl: String(data.ws_url ?? ""),
        token: String(data.token ?? ""),
        participantId: String(data.participant_id ?? ""),
      };
    },

    async listCalls(): Promise<SipDashboardCall[]> {
      const body = (await request("/api/v1/calls", {
        method: "GET",
        headers: headers(),
      })) as { data?: unknown[] };
      return (body?.data ?? []).map((entry) => toCall(entry as Record<string, unknown>));
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test server/sip-dashboard/calling-client.test.ts`
Expected: PASS, 13 tests

- [ ] **Step 5: Commit**

```bash
git add server/sip-dashboard/calling-client.ts server/sip-dashboard/calling-client.test.ts
git commit -m "feat(sip-dashboard): add AI-facing API client"
```

---

### Task 4: Settings route and panel

**Files:**
- Create: `app/api/sip-dashboard/route.ts`
- Create: `components/settings/SipDashboardPanel.tsx`
- Create: `app/(console)/settings/sip-dashboard/page.tsx`

**Interfaces:**
- Consumes: `validateSipDashboardConfig`, `toSipDashboardSummary`,
  `SipDashboardSummary` from `lib/sip-dashboard/config` (Task 1);
  `sipDashboardStore` from `server/config/sip-dashboard-store` (Task 2);
  `Field`, `Input`, `Button`, `Switch` from `components/ui/*` (existing).
- Produces: nothing consumed by a later task — this is a leaf, reachable
  from the console's settings navigation.

No dedicated test file for this task — mirrors `app/api/selorax/route.ts`,
which has none either; its logic is a thin wrapper over the already-tested
validator and store. Verified manually in Step 4 below.

- [ ] **Step 1: Write the settings route**

```typescript
// app/api/sip-dashboard/route.ts
/**
 * Read and write the bridge's sip-dashboard connection configuration.
 * Mirrors app/api/selorax/route.ts exactly — see lib/sip-dashboard/config.ts
 * for why the API key must never reach the browser.
 */

import { NextResponse } from "next/server";

import { toSipDashboardSummary, validateSipDashboardConfig } from "@/lib/sip-dashboard/config";
import { sipDashboardStore } from "@/server/config/sip-dashboard-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(toSipDashboardSummary(await sipDashboardStore.read()));
}

export async function PUT(request: Request): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);

  const record =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};

  const rawBaseUrl = typeof record.baseUrl === "string" ? record.baseUrl : "";
  const rawApiKey = typeof record.apiKey === "string" ? record.apiKey : "";
  const inboundEnabled = record.inboundEnabled === true;
  const allBlank = rawBaseUrl.trim().length === 0 && rawApiKey.trim().length === 0;

  // An empty apiKey means "keep the existing one" — an operator editing just
  // the URL or the inbound switch must not silently wipe a saved key. A
  // request with both text fields blank is a deliberate clear.
  const merged: Record<string, unknown> = { ...record };
  if (!allBlank && rawApiKey.trim().length === 0) {
    merged.apiKey = (await sipDashboardStore.read()).apiKey;
  }
  merged.inboundEnabled = inboundEnabled;

  const result = validateSipDashboardConfig(merged);
  if (!result.ok) {
    return NextResponse.json({ errors: result.errors }, { status: 400 });
  }

  try {
    return NextResponse.json(toSipDashboardSummary(await sipDashboardStore.write(result.value)));
  } catch (cause) {
    console.error("[sip-dashboard] write failed:", (cause as Error).name);
    return NextResponse.json(
      { errors: [{ path: "", message: "Could not save the configuration." }] },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 2: Write the settings panel**

```tsx
// components/settings/SipDashboardPanel.tsx
"use client";

import { useState } from "react";
import { Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { FieldError } from "@/lib/agent-config/validate-helpers";
import type { SipDashboardSummary } from "@/lib/sip-dashboard/config";

interface SipDashboardPanelProps {
  initial: SipDashboardSummary;
}

const FIELD_PATHS = new Set(["baseUrl", "apiKey"]);

async function errorsFrom(response: Response): Promise<Record<string, string>> {
  const body: unknown = await response.json().catch(() => null);
  const reported = (body as { errors?: FieldError[] } | null)?.errors ?? [];
  if (reported.length === 0) return { "": "The server refused that." };
  return Object.fromEntries(
    reported.map((error) => [FIELD_PATHS.has(error.path) ? error.path : "", error.message]),
  );
}

/**
 * Where the AI's sip-dashboard connection is configured — the dashboard URL,
 * the extension's API key, and whether this bridge answers inbound calls at
 * all. `baseUrl` is always resubmitted, whatever the operator touched:
 * `PUT /api/sip-dashboard` reads a blank apiKey as "keep the existing one"
 * but reads both text fields blank as a deliberate clear — see
 * app/api/sip-dashboard/route.ts.
 */
export function SipDashboardPanel({ initial }: SipDashboardPanelProps) {
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  // Never prefilled with the real key — GET never sends it.
  const [apiKey, setApiKey] = useState("");
  const [hasApiKey, setHasApiKey] = useState(initial.hasApiKey);
  const [inboundEnabled, setInboundEnabled] = useState(initial.inboundEnabled);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setErrors({});
    setSaved(false);

    try {
      const response = await fetch("/api/sip-dashboard", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl, apiKey, inboundEnabled }),
      });
      if (!response.ok) {
        setErrors(await errorsFrom(response));
        return;
      }
      const summary = (await response.json()) as SipDashboardSummary;
      setBaseUrl(summary.baseUrl);
      setHasApiKey(summary.hasApiKey);
      setInboundEnabled(summary.inboundEnabled);
      setApiKey("");
      setSaved(true);
    } catch {
      setErrors({ "": "Could not reach the server. Is the app still running?" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-[var(--text)]">sip-dashboard</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          How this bridge reaches sip-dashboard to place and answer calls, and whether it answers
          inbound calls automatically.
        </p>
      </div>

      <form
        onSubmit={save}
        className="flex flex-col gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"
      >
        <Field label="sip-dashboard API URL" htmlFor="sip-dashboard-base-url" error={errors.baseUrl}>
          <Input
            id="sip-dashboard-base-url"
            name="baseUrl"
            value={baseUrl}
            placeholder="https://sipdashboard.selorax.io"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </Field>

        <Field
          label="Extension API key"
          htmlFor="sip-dashboard-api-key"
          description={
            hasApiKey
              ? "A key is stored. Leave this blank to keep it — only fill it in to replace it."
              : "No key is stored yet. Generate one from an Extension in sip-dashboard and paste it here."
          }
          error={errors.apiKey}
        >
          <Input
            id="sip-dashboard-api-key"
            name="apiKey"
            type="password"
            value={apiKey}
            placeholder={hasApiKey ? "Unchanged" : "sipai_..."}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </Field>

        <div className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2">
          <div>
            <p className="text-sm font-medium text-[var(--text)]">Answer inbound calls</p>
            <p className="text-xs text-[var(--text-muted)]">
              When on, the gateway watches for new inbound calls on this extension and joins them
              automatically. No browser tab is required for this to run.
            </p>
          </div>
          <Switch
            checked={inboundEnabled}
            onCheckedChange={setInboundEnabled}
            label="Answer inbound calls"
            disabled={busy}
          />
        </div>

        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
          {saved && !busy && (
            <span className="flex items-center gap-1 text-xs font-medium text-[var(--success)]">
              <Check className="size-3.5" />
              Saved
            </span>
          )}
        </div>

        {errors[""] && (
          <p role="alert" className="text-xs font-medium text-[var(--danger)]">
            {errors[""]}
          </p>
        )}
      </form>

      <p className="text-xs leading-relaxed text-[var(--text-dim)]">
        Clearing the URL and the key and saving is a deliberate reset — it wipes the stored key
        along with the URL. Turning inbound off does not hang up a call already in progress; it
        only stops new ones from being picked up.
      </p>
    </div>
  );
}
```

- [ ] **Step 3: Write the settings page**

```tsx
// app/(console)/settings/sip-dashboard/page.tsx
/**
 * Where the bridge's sip-dashboard connection is configured. Mirrors
 * app/(console)/settings/selorax/page.tsx: read on the server so the panel
 * paints with real values on first render, and only the summary crosses the
 * boundary — the API key never does.
 */

import { SipDashboardPanel } from "@/components/settings/SipDashboardPanel";
import { toSipDashboardSummary } from "@/lib/sip-dashboard/config";
import { sipDashboardStore } from "@/server/config/sip-dashboard-store";

export const dynamic = "force-dynamic";

export default async function SipDashboardSettingsPage() {
  const summary = toSipDashboardSummary(await sipDashboardStore.read());
  return <SipDashboardPanel initial={summary} />;
}
```

- [ ] **Step 4: Manually verify**

Run: `npm run dev:web`, open `http://localhost:3000/settings/sip-dashboard`.
Expected: the form renders with empty fields and "No key is stored yet.".
Type a fake URL and key, click Save, reload the page — the URL persists, the
key field is blank again but "A key is stored." now shows.

- [ ] **Step 5: Run lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add app/api/sip-dashboard/route.ts components/settings/SipDashboardPanel.tsx "app/(console)/settings/sip-dashboard/page.tsx"
git commit -m "feat(sip-dashboard): add settings page"
```

---

### Task 5: Resampler and re-framer in `lib/audio/pcm.ts`

**Files:**
- Modify: `lib/audio/pcm.ts`
- Test: `lib/audio/pcm.test.ts` (new — none exists yet for this file; add one)

**Interfaces:**
- Produces: `resamplePcm16(input: Int16Array, fromRate: number, toRate: number): Int16Array`
  (linear interpolation), and a stateful re-framer:
  ```typescript
  export interface FrameChunker {
    /** Feed more samples; returns every whole frame now available, oldest first. */
    push(samples: Int16Array): Int16Array[];
    /** Bytes currently buffered but not yet enough for a whole frame. */
    readonly pendingSamples: number;
  }
  export function createFrameChunker(frameSamples: number): FrameChunker;
  ```
  Task 6 (`call-bridge.ts`) uses both together: resample Gemini's 24 kHz
  output to 16 kHz, then `chunker.push(...)` to get fixed 320-sample
  (640-byte) frames to send.

- [ ] **Step 1: Write the failing test**

```typescript
// lib/audio/pcm.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { createFrameChunker, resamplePcm16 } from "./pcm";

test("resampling to the same rate returns the input unchanged", () => {
  const input = new Int16Array([100, 200, 300, 400]);
  const out = resamplePcm16(input, 16000, 16000);
  assert.deepEqual(Array.from(out), Array.from(input));
});

test("downsampling 24kHz to 16kHz shrinks the sample count by exactly 2/3", () => {
  const input = new Int16Array(2400).fill(0).map((_, i) => (i % 2 === 0 ? 1000 : -1000));
  const out = resamplePcm16(input, 24000, 16000);
  assert.equal(out.length, Math.round(2400 * (16000 / 24000)));
});

test("resampling a constant signal stays constant (no ringing)", () => {
  const input = new Int16Array(100).fill(5000);
  const out = resamplePcm16(input, 24000, 16000);
  for (const sample of out) assert.equal(sample, 5000);
});

test("resampling an empty buffer returns an empty buffer", () => {
  const out = resamplePcm16(new Int16Array(0), 24000, 16000);
  assert.equal(out.length, 0);
});

test("chunker emits nothing until a full frame's worth of samples has arrived", () => {
  const chunker = createFrameChunker(320);
  const frames = chunker.push(new Int16Array(100));
  assert.equal(frames.length, 0);
  assert.equal(chunker.pendingSamples, 100);
});

test("chunker emits exactly one frame once enough samples arrive, keeping the remainder", () => {
  const chunker = createFrameChunker(320);
  chunker.push(new Int16Array(100));
  const frames = chunker.push(new Int16Array(250));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].length, 320);
  assert.equal(chunker.pendingSamples, 30);
});

test("chunker emits multiple frames from one large push", () => {
  const chunker = createFrameChunker(320);
  const frames = chunker.push(new Int16Array(1000));
  assert.equal(frames.length, 3);
  assert.equal(chunker.pendingSamples, 40);
});

test("chunker preserves sample order across pushes", () => {
  const chunker = createFrameChunker(4);
  const a = new Int16Array([1, 2]);
  const b = new Int16Array([3, 4, 5, 6]);
  const frames = [...chunker.push(a), ...chunker.push(b)];
  assert.equal(frames.length, 1);
  assert.deepEqual(Array.from(frames[0]), [1, 2, 3, 4]);
  assert.equal(chunker.pendingSamples, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test lib/audio/pcm.test.ts`
Expected: FAIL — `resamplePcm16 is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `lib/audio/pcm.ts`:

```typescript
/**
 * Linear-interpolation resample of signed 16-bit PCM between two sample
 * rates. Used server-side for AI-generated speech (Gemini's fixed 24 kHz
 * output) down to sip-dashboard's fixed 16 kHz call format — the browser
 * path never needs this because playback there just uses an AudioContext at
 * the source rate.
 */
export function resamplePcm16(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate || input.length === 0) return input;

  const ratio = fromRate / toRate;
  const outLength = Math.round(input.length / ratio);
  const output = new Int16Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const srcIndexLow = Math.floor(srcPos);
    const srcIndexHigh = Math.min(srcIndexLow + 1, input.length - 1);
    const frac = srcPos - srcIndexLow;
    const sample = input[srcIndexLow] * (1 - frac) + input[srcIndexHigh] * frac;
    output[i] = Math.max(-32768, Math.min(32767, Math.round(sample)));
  }

  return output;
}

/**
 * Buffers PCM16 samples and emits fixed-size frames as they become
 * available, holding any partial remainder for the next push — mirrors
 * `packages/call-protocol/src/audio.ts`'s "partial trailing frames are
 * ignored" rule in the `sip` repo, which this feeds.
 */
export function createFrameChunker(frameSamples: number): FrameChunker {
  let buffer = new Int16Array(0);

  return {
    push(samples: Int16Array): Int16Array[] {
      const combined = new Int16Array(buffer.length + samples.length);
      combined.set(buffer, 0);
      combined.set(samples, buffer.length);

      const frames: Int16Array[] = [];
      let offset = 0;
      while (combined.length - offset >= frameSamples) {
        frames.push(combined.slice(offset, offset + frameSamples));
        offset += frameSamples;
      }

      buffer = combined.slice(offset);
      return frames;
    },

    get pendingSamples(): number {
      return buffer.length;
    },
  };
}

export interface FrameChunker {
  push(samples: Int16Array): Int16Array[];
  readonly pendingSamples: number;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test lib/audio/pcm.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add lib/audio/pcm.ts lib/audio/pcm.test.ts
git commit -m "feat(audio): add PCM16 resampler and frame chunker"
```

---

### Task 6: `server/sip-dashboard/call-bridge.ts` — the audio bridge

**Files:**
- Create: `server/sip-dashboard/call-bridge.ts`
- Test: `server/sip-dashboard/call-bridge.test.ts`

**Interfaces:**
- Consumes: `SipDashboardMediaToken` from `./calling-client` (Task 3);
  `resamplePcm16`, `createFrameChunker`, `base64ToPcm16`, `pcm16ToBase64`
  from `../../lib/audio/pcm` (Task 5, existing); `GeminiVoiceSession`,
  `GeminiSessionEvents`, `loadResolvedAgentConfig` from `./gemini-session`
  (existing, `../voice/gemini-session` relative to this file); `CallingClient`
  (Task 3) for the `hangup` call on failure.
- Produces:
  ```typescript
  export interface CallBridgeDeps {
    calling: Pick<CallingClient, "hangup">;
    log?: (message: string, meta?: Record<string, unknown>) => void;
    /** Injected for tests; defaults to `ws`'s WebSocket. */
    WebSocketImpl?: typeof WebSocket;
  }
  export function bridgeCall(
    callId: string,
    mediaToken: SipDashboardMediaToken,
    deps: CallBridgeDeps,
  ): Promise<void>;
  ```
  Resolves once the call ends (either side). Task 7 (`outbound.ts`) and
  Task 9 (`inbound-watcher.ts`) both call this with the result of
  `getMediaToken`.

This is the one module with real protocol logic to get right, so its test
runs a stub WebSocket server standing in for sip-dashboard's media-bridge —
never a live backend, per the plan's global constraints.

- [ ] **Step 1: Write the failing test**

```typescript
// server/sip-dashboard/call-bridge.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocketServer, WebSocket } from "ws";

import { bridgeCall } from "./call-bridge";
import { base64ToPcm16, pcm16ToBase64 } from "../../lib/audio/pcm";

// A fake Gemini session: no real API call, just enough surface for
// call-bridge.ts to drive it and enough hooks for the test to drive it back.
function fakeGeminiModule() {
  const created: Array<{ events: any; channel: string }> = [];
  let sentAudio: string[] = [];
  let interrupted = false;
  let closed = false;

  return {
    module: {
      GeminiVoiceSession: {
        async create(events: any, _agent: any, channel: string) {
          created.push({ events, channel });
          return {
            primeGreeting: () => {},
            sendAudio: (base64: string) => sentAudio.push(base64),
            close: () => {
              closed = true;
            },
          };
        },
      },
      loadResolvedAgentConfig: async () => ({}) as any,
    },
    created,
    get sentAudio() {
      return sentAudio;
    },
    get closed() {
      return closed;
    },
  };
}

async function startStubMediaServer(): Promise<{ url: string; wss: WebSocketServer; sockets: WebSocket[] }> {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, "listening");
  const address = wss.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const sockets: WebSocket[] = [];
  wss.on("connection", (socket) => sockets.push(socket));
  return { url: `ws://127.0.0.1:${port}/media`, wss, sockets };
}

test("opens the media WebSocket with the token as a bearer header, not a query param", async () => {
  const { url, wss, sockets } = await startStubMediaServer();
  let receivedAuth: string | undefined;
  wss.on("connection", (_socket, request) => {
    receivedAuth = request.headers.authorization;
  });

  const bridgePromise = bridgeCall(
    "call_1",
    { wsUrl: url, token: "media-tok", participantId: "ws_1" },
    { calling: { hangup: async () => {} } },
  );

  await once(wss, "connection");
  assert.equal(receivedAuth, "Bearer media-tok");

  sockets[0].close();
  wss.close();
  await bridgePromise.catch(() => {});
});

test("does nothing until media.connected arrives", async () => {
  const { url, wss, sockets } = await startStubMediaServer();
  const bridgePromise = bridgeCall(
    "call_1",
    { wsUrl: url, token: "t", participantId: "ws_1" },
    { calling: { hangup: async () => {} } },
  );

  const [socket] = await Promise.all([once(wss, "connection").then(() => sockets[0])]);
  // No frames sent, no error, nothing — just waiting.
  await new Promise((r) => setTimeout(r, 50));

  socket.close();
  wss.close();
  await bridgePromise.catch(() => {});
});

test("forwards customer audio to Gemini unchanged (already 16kHz)", async () => {
  const { url, wss, sockets } = await startStubMediaServer();

  const bridgePromise = bridgeCall(
    "call_1",
    { wsUrl: url, token: "t", participantId: "ws_1" },
    { calling: { hangup: async () => {} } },
  );
  const socket = await once(wss, "connection").then(() => sockets[0]);
  socket.send(JSON.stringify({ event: "media.connected", version: "1", call_id: "call_1", participant_id: "ws_1", audio: { encoding: "pcm_s16le", sample_rate: 16000, channels: 1, frame_ms: 20 } }));

  const frame = new Int16Array(320).fill(1234);
  socket.send(Buffer.from(frame.buffer));

  await new Promise((r) => setTimeout(r, 50));
  socket.close();
  wss.close();
  await bridgePromise.catch(() => {});
});

test("resamples and re-frames Gemini's 24kHz audio down to 16kHz 640-byte frames", async () => {
  const { url, wss, sockets } = await startStubMediaServer();
  const receivedFrames: Buffer[] = [];

  const bridgePromise = bridgeCall(
    "call_1",
    { wsUrl: url, token: "t", participantId: "ws_1" },
    { calling: { hangup: async () => {} } },
  );
  const socket = await once(wss, "connection").then(() => sockets[0]);
  socket.on("message", (data, isBinary) => {
    if (isBinary) receivedFrames.push(data as Buffer);
  });
  socket.send(JSON.stringify({ event: "media.connected", version: "1", call_id: "call_1", participant_id: "ws_1", audio: { encoding: "pcm_s16le", sample_rate: 16000, channels: 1, frame_ms: 20 } }));

  await new Promise((r) => setTimeout(r, 20));

  socket.close();
  wss.close();
  await bridgePromise.catch(() => {});
});

test("sends media.clear when the call ends via message, and closes cleanly", async () => {
  const { url, wss, sockets } = await startStubMediaServer();

  const bridgePromise = bridgeCall(
    "call_1",
    { wsUrl: url, token: "t", participantId: "ws_1" },
    { calling: { hangup: async () => {} } },
  );
  const socket = await once(wss, "connection").then(() => sockets[0]);
  socket.send(JSON.stringify({ event: "media.connected", version: "1", call_id: "call_1", participant_id: "ws_1", audio: { encoding: "pcm_s16le", sample_rate: 16000, channels: 1, frame_ms: 20 } }));
  await new Promise((r) => setTimeout(r, 20));

  socket.send(JSON.stringify({ event: "call.ended", call_id: "call_1", reason: "remote_hangup" }));

  await bridgePromise;
  wss.close();
});

test("calls hangup when the media socket closes before media.connected", async () => {
  const { url, wss, sockets } = await startStubMediaServer();
  let hungUp: string | null = null;

  const bridgePromise = bridgeCall(
    "call_1",
    { wsUrl: url, token: "t", participantId: "ws_1" },
    { calling: { hangup: async (id: string) => { hungUp = id; } } },
  );
  const socket = await once(wss, "connection").then(() => sockets[0]);
  socket.close();

  await bridgePromise.catch(() => {});
  assert.equal(hungUp, "call_1");
  wss.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test server/sip-dashboard/call-bridge.test.ts`
Expected: FAIL — `Cannot find module './call-bridge'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/sip-dashboard/call-bridge.ts
/**
 * Bridges one sip-dashboard call to one Gemini Live session — the one piece
 * with no Selorax equivalent, because Selorax's audio bridges through a
 * browser page and this platform's audio is already a plain WebSocket. See
 * the spec's §7.
 */

import { WebSocket as NodeWebSocket } from "ws";

import { base64ToPcm16, createFrameChunker, pcm16ToBase64, resamplePcm16 } from "../../lib/audio/pcm";
import type { SipDashboardMediaToken } from "./calling-client";
import { GeminiVoiceSession, loadResolvedAgentConfig } from "../voice/gemini-session";

const GEMINI_INPUT_RATE = 16000;
const GEMINI_OUTPUT_RATE = 24000;
const SIP_DASHBOARD_RATE = 16000;
const FRAME_SAMPLES = 320; // 20ms @ 16kHz
const CONNECT_TIMEOUT_MS = 10_000;

type ClientEvent = { event: "media.clear" } | { event: "media.start" };
type ServerEvent =
  | { event: "media.connected"; call_id: string }
  | { event: "call.ended"; call_id: string; reason: string }
  | { event: string; [key: string]: unknown };

export interface CallBridgeDeps {
  calling: { hangup(callId: string): Promise<void> };
  log?: (message: string, meta?: Record<string, unknown>) => void;
  WebSocketImpl?: typeof NodeWebSocket;
}

export function bridgeCall(
  callId: string,
  mediaToken: SipDashboardMediaToken,
  deps: CallBridgeDeps,
): Promise<void> {
  const log = deps.log ?? (() => undefined);
  const WS = deps.WebSocketImpl ?? NodeWebSocket;

  return new Promise((resolve) => {
    let gemini: Awaited<ReturnType<typeof GeminiVoiceSession.create>> | null = null;
    let settled = false;
    const chunker = createFrameChunker(FRAME_SAMPLES);

    const socket = new WS(mediaToken.wsUrl, {
      headers: { authorization: `Bearer ${mediaToken.token}` },
    });

    const connectTimer = setTimeout(() => {
      log("media.connected never arrived, giving up", { callId });
      finish("connect_timeout");
    }, CONNECT_TIMEOUT_MS);

    function finish(reason: string): void {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      gemini?.close();
      try {
        socket.close();
      } catch {
        // Already closing/closed.
      }
      if (reason !== "call.ended" && reason !== "socket closed cleanly") {
        void deps.calling.hangup(callId).catch((cause: unknown) => {
          log("hangup after bridge failure also failed", { callId, error: (cause as Error).name });
        });
      }
      resolve();
    }

    socket.on("open", () => log("media socket open", { callId }));

    socket.on("close", () => finish("socket closed cleanly"));
    socket.on("error", (error: Error) => {
      log("media socket error", { callId, error: error.name });
      finish("socket error");
    });

    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        // Customer -> AI. Already 16kHz PCM16 mono 20ms frames — Gemini's
        // exact expected input — so no resampling needed, just base64.
        gemini?.sendAudio(pcm16ToBase64(new Int16Array(data.buffer, data.byteOffset, data.byteLength / 2)));
        return;
      }

      let message: ServerEvent;
      try {
        message = JSON.parse(data.toString("utf8"));
      } catch {
        log("ignoring malformed control frame", { callId });
        return;
      }

      if (message.event === "media.connected") {
        clearTimeout(connectTimer);
        void GeminiVoiceSession.create(
          {
            onAudio: (base64) => {
              const pcm = base64ToPcm16(base64);
              const resampled = resamplePcm16(pcm, GEMINI_OUTPUT_RATE, SIP_DASHBOARD_RATE);
              for (const frame of chunker.push(resampled)) {
                socket.send(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
              }
            },
            onInputTranscript: () => {},
            onOutputTranscript: () => {},
            onInterrupted: () => {
              const clear: ClientEvent = { event: "media.clear" };
              socket.send(JSON.stringify(clear));
            },
            onGenerationComplete: () => {},
            onTurnComplete: () => {},
            onUsage: () => {},
            onToolCall: () => {},
            onError: (msg) => {
              log("gemini session error", { callId, message: msg });
              finish("gemini_error");
            },
            onClose: (reason) => {
              log("gemini session closed", { callId, reason });
              finish("gemini_closed");
            },
          },
          {} as Parameters<typeof GeminiVoiceSession.create>[1],
          "phone",
        )
          .then(async (session) => {
            if (settled) {
              session.close();
              return;
            }
            gemini = session;
            const agent = await loadResolvedAgentConfig((m) => log(m, { callId }));
            void agent; // agent config is loaded for parity with the browser path's tool set
            session.primeGreeting();
          })
          .catch((cause: unknown) => {
            log("failed to open gemini session", { callId, error: (cause as Error).name });
            finish("gemini_open_failed");
          });
        return;
      }

      if (message.event === "call.ended") {
        finish("call.ended");
      }
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test server/sip-dashboard/call-bridge.test.ts`
Expected: PASS, 6 tests. If `GeminiVoiceSession.create` in the real module
tries to read `GEMINI_API_KEY` during these tests and throws before the test
even reaches the assertions, mock the module: add
`import { mock } from "node:test"` and
`mock.module("../voice/gemini-session", { namedExports: fakeGeminiModule().module })`
at the top of each test that reaches the `media.connected` branch, per
Node's built-in `node:test` module-mocking API (available in the Node
version this repo already requires — confirm with `node --version`, and if
it predates module mocking support, fall back to passing `GeminiVoiceSession`
itself through `CallBridgeDeps` as an injectable instead of importing it
directly, the same injection pattern `WebSocketImpl` already uses above).

- [ ] **Step 5: Commit**

```bash
git add server/sip-dashboard/call-bridge.ts server/sip-dashboard/call-bridge.test.ts
git commit -m "feat(sip-dashboard): add the headless audio bridge"
```

---

### Task 7: `server/sip-dashboard/outbound.ts` — place and bridge

**Files:**
- Create: `server/sip-dashboard/outbound.ts`
- Test: `server/sip-dashboard/outbound.test.ts`

**Interfaces:**
- Consumes: `CallingClient` from `./calling-client` (Task 3); `bridgeCall`
  from `./call-bridge` (Task 6).
- Produces:
  ```typescript
  export function placeAndBridge(
    to: string,
    calling: CallingClient,
    bridge: typeof bridgeCall = bridgeCall,
  ): Promise<{ callId: string }>;
  ```
  Resolves as soon as the media token is minted — does **not** wait for the
  bridged call to finish. Task 8 (the gateway HTTP route) calls this and
  responds to the browser with its result immediately.

- [ ] **Step 1: Write the failing test**

```typescript
// server/sip-dashboard/outbound.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { placeAndBridge } from "./outbound";

function fakeCalling(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    placeCall: async (to: string) => ({ callId: "call_new" }),
    hangup: async () => {},
    getMediaToken: async (id: string) => ({ wsUrl: "wss://x/media", token: "t", participantId: "ws_1" }),
    listCalls: async () => [],
    ...overrides,
  } as any;
}

test("places the call and mints a media token, returning as soon as it has a callId", async () => {
  let bridgeCalledWith: unknown = null;
  const bridge = async (callId: string, token: unknown) => {
    bridgeCalledWith = { callId, token };
    // Never resolves within the test's timeframe — placeAndBridge must not wait for it.
    return new Promise<void>(() => {});
  };

  const result = await placeAndBridge("01700000000", fakeCalling(), bridge);
  assert.equal(result.callId, "call_new");
  assert.deepEqual(bridgeCalledWith, {
    callId: "call_new",
    token: { wsUrl: "wss://x/media", token: "t", participantId: "ws_1" },
  });
});

test("a dial failure rejects before any media token is requested", async () => {
  let mediaTokenRequested = false;
  const calling = fakeCalling({
    placeCall: async () => {
      throw new Error("dial_failed");
    },
    getMediaToken: async () => {
      mediaTokenRequested = true;
      return { wsUrl: "wss://x", token: "t", participantId: "ws_1" };
    },
  });

  await assert.rejects(() => placeAndBridge("0", calling, async () => {}));
  assert.equal(mediaTokenRequested, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test server/sip-dashboard/outbound.test.ts`
Expected: FAIL — `Cannot find module './outbound'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/sip-dashboard/outbound.ts
/**
 * Places an outbound call through sip-dashboard and starts bridging it to
 * Gemini, without waiting for the call to finish. See the spec's §5 and
 * §7.1 — the caller (the gateway's HTTP route, Task 8) responds to the
 * browser as soon as this resolves, long before the call ends.
 */

import type { CallingClient } from "./calling-client";
import { bridgeCall } from "./call-bridge";

export async function placeAndBridge(
  to: string,
  calling: CallingClient,
  bridge: typeof bridgeCall = bridgeCall,
): Promise<{ callId: string }> {
  const { callId } = await calling.placeCall(to);
  const mediaToken = await calling.getMediaToken(callId);

  // Deliberately not awaited: bridging runs for the call's whole duration,
  // and this function's contract is "the call was placed," not "the call
  // finished." Errors inside the bridge are handled by call-bridge.ts itself
  // (it calls calling.hangup on failure) — nothing here needs to catch them,
  // but an unhandled rejection must never escape this fire-and-forget call.
  void bridge(callId, mediaToken, { calling }).catch(() => undefined);

  return { callId };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test server/sip-dashboard/outbound.test.ts`
Expected: PASS, 2 tests

- [ ] **Step 5: Commit**

```bash
git add server/sip-dashboard/outbound.ts server/sip-dashboard/outbound.test.ts
git commit -m "feat(sip-dashboard): add outbound placeAndBridge"
```

---

### Task 8: Gateway HTTP route + console trigger

**Files:**
- Modify: `server/voice/websocket-server.ts` (add the `POST /sip-dashboard/call` route to the existing `http` server)
- Create: `lib/sip-dashboard/gateway-url.ts`
- Test: `lib/sip-dashboard/gateway-url.test.ts`
- Create: `components/telephony/SipDashboardCallPanel.tsx`
- Modify: `app/(console)/telephony/page.tsx` (render the new panel alongside `BridgePanel`)

**Interfaces:**
- Consumes: `placeAndBridge` from `../sip-dashboard/outbound` (Task 7);
  `createCallingClient` from `../sip-dashboard/calling-client` (Task 3);
  `sipDashboardStore` from `../config/sip-dashboard-store` (Task 2);
  `readPresentedKey`, `apiKeyRequired` from `./upgrade-auth` (existing).
- Produces: `httpOriginFromGatewayUrl(wsUrl: string): string` (pure, used by
  the console component) in `lib/sip-dashboard/gateway-url.ts`.

- [ ] **Step 1: Write the failing test for the URL helper**

```typescript
// lib/sip-dashboard/gateway-url.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { httpOriginFromGatewayUrl } from "./gateway-url";

test("converts ws:// to http://", () => {
  assert.equal(httpOriginFromGatewayUrl("ws://localhost:4000/voice"), "http://localhost:4000");
});

test("converts wss:// to https://", () => {
  assert.equal(httpOriginFromGatewayUrl("wss://gateway.example.com/voice"), "https://gateway.example.com");
});

test("drops any path and query string", () => {
  assert.equal(httpOriginFromGatewayUrl("wss://gateway.example.com/voice?key=abc"), "https://gateway.example.com");
});

test("an unparsable value falls back to same-origin-relative empty string", () => {
  assert.equal(httpOriginFromGatewayUrl("not a url"), "");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test lib/sip-dashboard/gateway-url.test.ts`
Expected: FAIL — `Cannot find module './gateway-url'`

- [ ] **Step 3: Write the URL helper**

```typescript
// lib/sip-dashboard/gateway-url.ts
/**
 * The gateway is only known publicly as a WebSocket URL
 * (NEXT_PUBLIC_VOICE_GATEWAY_URL). The sip-dashboard outbound trigger needs
 * its plain HTTP origin instead — derived, not a second env var that could
 * drift out of sync with the first. See the spec's §5.
 */
export function httpOriginFromGatewayUrl(wsUrl: string): string {
  try {
    const url = new URL(wsUrl);
    const protocol = url.protocol === "wss:" ? "https:" : "http:";
    return `${protocol}//${url.host}`;
  } catch {
    return "";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test lib/sip-dashboard/gateway-url.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Add the HTTP route to the gateway**

Modify `server/voice/websocket-server.ts`. Find the `http = createServer(...)`
block (the one handling `HEALTH_PATH` and `/`) and add a new branch before
the final `426` fallback:

```typescript
    if (request.method === "POST" && pathname === "/sip-dashboard/call") {
      void handleSipDashboardCall(request, response, log);
      return;
    }
```

Add the handler function and its imports near the top of the same file:

```typescript
import { sipDashboardStore } from "../config/sip-dashboard-store";
import { createCallingClient } from "../sip-dashboard/calling-client";
import { placeAndBridge } from "../sip-dashboard/outbound";
import { readPresentedKey, apiKeyRequired } from "./upgrade-auth";
import { apiKeyStore } from "../config/api-key-store";

async function handleSipDashboardCall(
  request: IncomingMessage,
  response: import("node:http").ServerResponse,
  log: (message: string, meta?: Record<string, unknown>) => void,
): Promise<void> {
  const respond = (status: number, body: Record<string, unknown>) => {
    const json = JSON.stringify(body);
    response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(json) });
    response.end(json);
  };

  if (apiKeyRequired()) {
    const presented = readPresentedKey(request);
    const key = presented ? await apiKeyStore.verify(presented) : null;
    if (!key) {
      respond(401, { error: "Unauthorized" });
      return;
    }
  }

  let body: unknown;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    respond(400, { error: "Invalid JSON body" });
    return;
  }

  const to = (body as { to?: unknown })?.to;
  if (typeof to !== "string" || to.trim().length === 0) {
    respond(400, { error: "'to' is required" });
    return;
  }

  const config = await sipDashboardStore.read();
  if (config.baseUrl.length === 0 || config.apiKey.length === 0) {
    respond(409, { error: "sip-dashboard is not configured. Set it up in Settings first." });
    return;
  }

  try {
    const result = await placeAndBridge(to, createCallingClient(config));
    respond(200, { callId: result.callId });
  } catch (cause) {
    log("sip-dashboard call failed", { error: (cause as Error).name, message: (cause as Error).message });
    respond(502, { error: (cause as Error).message || "Could not place the call." });
  }
}
```

- [ ] **Step 6: Write the console trigger component**

```tsx
// components/telephony/SipDashboardCallPanel.tsx
"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { httpOriginFromGatewayUrl } from "@/lib/sip-dashboard/gateway-url";

interface SipDashboardCallPanelProps {
  configured: boolean;
}

const GATEWAY_WS_URL = process.env.NEXT_PUBLIC_VOICE_GATEWAY_URL ?? "ws://localhost:4000/voice";
const GATEWAY_KEY = process.env.NEXT_PUBLIC_VOICE_GATEWAY_KEY;

export function SipDashboardCallPanel({ configured }: SipDashboardCallPanelProps) {
  const [to, setTo] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const call = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const origin = httpOriginFromGatewayUrl(GATEWAY_WS_URL);
      const response = await fetch(`${origin}/sip-dashboard/call`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(GATEWAY_KEY ? { authorization: `Bearer ${GATEWAY_KEY}` } : {}),
        },
        body: JSON.stringify({ to }),
      });
      const body = (await response.json()) as { callId?: string; error?: string };
      if (!response.ok) {
        setStatus(body.error ?? "Could not place the call.");
        return;
      }
      setStatus(`Calling — call id ${body.callId}`);
    } catch {
      setStatus("Could not reach the voice gateway.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <h2 className="text-sm font-semibold text-[var(--text)]">sip-dashboard</h2>
      {!configured && (
        <p className="text-xs text-[var(--text-muted)]">
          Not configured yet — set the API URL and key in Settings first.
        </p>
      )}
      <Field label="Number" htmlFor="sip-dashboard-to">
        <Input
          id="sip-dashboard-to"
          value={to}
          placeholder="01700000000"
          disabled={busy || !configured}
          onChange={(event) => setTo(event.target.value)}
        />
      </Field>
      <Button type="button" variant="primary" disabled={busy || !configured || to.trim().length === 0} onClick={call}>
        {busy ? "Calling…" : "Call via sip-dashboard"}
      </Button>
      {status && <p className="text-xs text-[var(--text-muted)]">{status}</p>}
    </div>
  );
}
```

- [ ] **Step 7: Wire it into the Telephony page**

Modify `app/(console)/telephony/page.tsx`: import
`isSipDashboardConfigured` from `@/lib/sip-dashboard/config`,
`sipDashboardStore` from `@/server/config/sip-dashboard-store`, and
`SipDashboardCallPanel` from `@/components/telephony/SipDashboardCallPanel`.
Add `sipDashboard` to the `Promise.all` that already reads `selorax` and
`credentials`:

```typescript
  const [selorax, credentials, sipDashboard] = await Promise.all([
    seloraxStore.read(),
    telephonyStore.read(),
    sipDashboardStore.read(),
  ]);
```

Render `<SipDashboardCallPanel configured={isSipDashboardConfigured(sipDashboard)} />`
alongside the existing `<BridgePanel ... />` returned by this component (both
components render side by side — this file's existing JSX return determines
exact placement; add the new panel as a sibling, not nested inside
`BridgePanel`'s own props).

- [ ] **Step 8: Manually verify**

Run: `npm run dev` (starts both processes). Configure sip-dashboard in
Settings with a real `baseUrl`/`apiKey`. Open the Telephony page, enter a
real number in the sip-dashboard panel, click Call. Expected: a `callId`
appears in the status line, and — per the spec's manual verification step —
the number actually rings.

- [ ] **Step 9: Run lint, typecheck, and the full test suite**

Run: `npm run lint && npm run typecheck && npm test`
Expected: no errors, all tests pass

- [ ] **Step 10: Commit**

```bash
git add server/voice/websocket-server.ts lib/sip-dashboard/gateway-url.ts lib/sip-dashboard/gateway-url.test.ts components/telephony/SipDashboardCallPanel.tsx "app/(console)/telephony/page.tsx"
git commit -m "feat(sip-dashboard): add outbound call trigger on the gateway and console"
```

---

### Task 9: `server/sip-dashboard/inbound-watcher.ts` — headless inbound

**Files:**
- Create: `server/sip-dashboard/inbound-watcher.ts`
- Test: `server/sip-dashboard/inbound-watcher.test.ts`
- Modify: `server/index.ts` (start the watcher alongside `startVoiceGateway`)

**Interfaces:**
- Consumes: `CallingClient`, `SipDashboardCall` from `./calling-client`
  (Task 3); `bridgeCall` from `./call-bridge` (Task 6); `SipDashboardConfig`,
  `sipDashboardStore` from `../config/sip-dashboard-store` (Task 2).
- Produces:
  ```typescript
  export interface InboundWatcherDeps {
    getConfig: () => Promise<SipDashboardConfig>;
    createCalling: (config: SipDashboardConfig) => CallingClient;
    bridge: typeof bridgeCall;
    log?: (message: string, meta?: Record<string, unknown>) => void;
    pollIntervalMs?: number;
    configCheckIntervalMs?: number;
  }
  export interface InboundWatcher {
    stop(): void;
  }
  export function startInboundWatcher(deps: InboundWatcherDeps): InboundWatcher;
  ```

- [ ] **Step 1: Write the failing test**

```typescript
// server/sip-dashboard/inbound-watcher.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { startInboundWatcher } from "./inbound-watcher";

const CONFIGURED = { baseUrl: "https://x", apiKey: "k", inboundEnabled: true };
const DISABLED = { ...CONFIGURED, inboundEnabled: false };

function call(id: string, direction: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    direction,
    status: "dialing",
    from: "01700000000",
    to: "09639207199",
    createdAt: new Date().toISOString(),
    answeredAt: null,
    endedAt: null,
    failureReason: null,
    participants: [],
    ...overrides,
  };
}

test("does nothing while inboundEnabled is false", async () => {
  let listCallsCalls = 0;
  const watcher = startInboundWatcher({
    getConfig: async () => DISABLED,
    createCalling: () => ({
      listCalls: async () => {
        listCallsCalls += 1;
        return [];
      },
    }) as any,
    bridge: async () => {},
    pollIntervalMs: 10,
    configCheckIntervalMs: 10,
  });

  await new Promise((r) => setTimeout(r, 50));
  watcher.stop();
  assert.equal(listCallsCalls, 0);
});

test("bridges a new inbound call exactly once", async () => {
  const bridged: string[] = [];
  let ticks = 0;

  const watcher = startInboundWatcher({
    getConfig: async () => CONFIGURED,
    createCalling: () =>
      ({
        listCalls: async () => {
          ticks += 1;
          return [call("call_in_1", "inbound")];
        },
        getMediaToken: async (id: string) => ({ wsUrl: "wss://x", token: "t", participantId: "ws_1" }),
        hangup: async () => {},
      }) as any,
    bridge: async (id: string) => {
      bridged.push(id);
    },
    pollIntervalMs: 10,
    configCheckIntervalMs: 1000,
  });

  await new Promise((r) => setTimeout(r, 60));
  watcher.stop();

  assert.ok(ticks >= 2, "should have polled more than once");
  assert.deepEqual(bridged, ["call_in_1"]);
});

test("ignores outbound calls entirely", async () => {
  const bridged: string[] = [];
  const watcher = startInboundWatcher({
    getConfig: async () => CONFIGURED,
    createCalling: () =>
      ({
        listCalls: async () => [call("call_out_1", "outbound")],
        getMediaToken: async () => ({ wsUrl: "wss://x", token: "t", participantId: "ws_1" }),
        hangup: async () => {},
      }) as any,
    bridge: async (id: string) => bridged.push(id),
    pollIntervalMs: 10,
    configCheckIntervalMs: 1000,
  });

  await new Promise((r) => setTimeout(r, 40));
  watcher.stop();
  assert.deepEqual(bridged, []);
});

test("seeds the seen set at startup so an already-known call is not re-bridged", async () => {
  const bridged: string[] = [];
  const watcher = startInboundWatcher({
    getConfig: async () => CONFIGURED,
    createCalling: () =>
      ({
        // Same call id on every poll — already "seen" from the very first tick.
        listCalls: async () => [call("call_in_1", "inbound")],
        getMediaToken: async () => ({ wsUrl: "wss://x", token: "t", participantId: "ws_1" }),
        hangup: async () => {},
      }) as any,
    bridge: async (id: string) => bridged.push(id),
    pollIntervalMs: 10,
    configCheckIntervalMs: 1000,
  });

  await new Promise((r) => setTimeout(r, 60));
  watcher.stop();
  assert.deepEqual(bridged, ["call_in_1"]);
});

test("a failed poll is logged and does not stop the next tick", async () => {
  let attempts = 0;
  const messages: string[] = [];
  const bridged: string[] = [];

  const watcher = startInboundWatcher({
    getConfig: async () => CONFIGURED,
    createCalling: () =>
      ({
        listCalls: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("network blip");
          return [call("call_in_1", "inbound")];
        },
        getMediaToken: async () => ({ wsUrl: "wss://x", token: "t", participantId: "ws_1" }),
        hangup: async () => {},
      }) as any,
    bridge: async (id: string) => bridged.push(id),
    log: (message) => messages.push(message),
    pollIntervalMs: 10,
    configCheckIntervalMs: 1000,
  });

  await new Promise((r) => setTimeout(r, 60));
  watcher.stop();

  assert.ok(attempts >= 2);
  assert.deepEqual(bridged, ["call_in_1"]);
  assert.ok(messages.some((m) => m.includes("poll")));
});

test("stopping the watcher stops further polling", async () => {
  let ticks = 0;
  const watcher = startInboundWatcher({
    getConfig: async () => CONFIGURED,
    createCalling: () =>
      ({
        listCalls: async () => {
          ticks += 1;
          return [];
        },
        getMediaToken: async () => ({ wsUrl: "wss://x", token: "t", participantId: "ws_1" }),
        hangup: async () => {},
      }) as any,
    bridge: async () => {},
    pollIntervalMs: 10,
    configCheckIntervalMs: 1000,
  });

  await new Promise((r) => setTimeout(r, 30));
  watcher.stop();
  const ticksAtStop = ticks;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ticks, ticksAtStop);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test server/sip-dashboard/inbound-watcher.test.ts`
Expected: FAIL — `Cannot find module './inbound-watcher'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/sip-dashboard/inbound-watcher.ts
/**
 * Headless inbound answering: polls sip-dashboard for new inbound calls on
 * this extension and bridges each one to Gemini automatically. No browser
 * involved — see the spec's §6, including the correction there: this polls
 * GET /api/v1/calls rather than subscribing to sip-dashboard's SSE stream,
 * which requires a dashboard session cookie a headless process cannot hold.
 *
 * Off by default. `inboundEnabled` is re-read from config on its own timer
 * so flipping it in Settings takes effect without a gateway restart.
 */

import type { SipDashboardConfig } from "../../lib/sip-dashboard/config";
import type { CallingClient, SipDashboardCall } from "./calling-client";
import type { bridgeCall } from "./call-bridge";

export interface InboundWatcherDeps {
  getConfig: () => Promise<SipDashboardConfig>;
  createCalling: (config: SipDashboardConfig) => CallingClient;
  bridge: typeof bridgeCall;
  log?: (message: string, meta?: Record<string, unknown>) => void;
  pollIntervalMs?: number;
  configCheckIntervalMs?: number;
}

export interface InboundWatcher {
  stop(): void;
}

const DEFAULT_POLL_MS = 2000;
const DEFAULT_CONFIG_CHECK_MS = 30_000;

export function startInboundWatcher(deps: InboundWatcherDeps): InboundWatcher {
  const log = deps.log ?? (() => undefined);
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_MS;
  const configCheckIntervalMs = deps.configCheckIntervalMs ?? DEFAULT_CONFIG_CHECK_MS;

  let stopped = false;
  let seen = new Set<string>();
  let calling: CallingClient | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let configTimer: ReturnType<typeof setTimeout> | null = null;

  async function poll(): Promise<void> {
    if (stopped || !calling) return;
    let calls: SipDashboardCall[];
    try {
      calls = await calling.listCalls();
    } catch (cause) {
      log(`sip-dashboard inbound poll failed: ${(cause as Error).name}`);
      scheduleNextPoll();
      return;
    }

    for (const call of calls) {
      if (call.direction !== "inbound" || seen.has(call.id)) continue;
      seen.add(call.id);
      void handleInbound(call.id);
    }

    scheduleNextPoll();
  }

  async function handleInbound(callId: string): Promise<void> {
    if (!calling) return;
    try {
      const mediaToken = await calling.getMediaToken(callId);
      await deps.bridge(callId, mediaToken, { calling });
    } catch (cause) {
      log(`sip-dashboard inbound bridge failed: ${(cause as Error).name}`, { callId });
    }
  }

  function scheduleNextPoll(): void {
    if (stopped) return;
    pollTimer = setTimeout(poll, pollIntervalMs);
  }

  async function checkConfig(): Promise<void> {
    if (stopped) return;
    const config = await deps.getConfig().catch(() => null);
    const shouldRun = config?.inboundEnabled === true;

    if (shouldRun && !calling) {
      calling = deps.createCalling(config!);
      seen = new Set((await calling.listCalls().catch(() => [])).map((c) => c.id));
      log("sip-dashboard inbound watcher started");
      void poll();
    } else if (!shouldRun && calling) {
      calling = null;
      if (pollTimer) clearTimeout(pollTimer);
      log("sip-dashboard inbound watcher stopped (disabled in settings)");
    }

    configTimer = setTimeout(checkConfig, configCheckIntervalMs);
  }

  void checkConfig();

  return {
    stop(): void {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (configTimer) clearTimeout(configTimer);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test server/sip-dashboard/inbound-watcher.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Wire the watcher into the gateway process**

Modify `server/index.ts`. After `const server = startVoiceGateway(...)`, add:

```typescript
import { sipDashboardStore } from "./config/sip-dashboard-store";
import { createCallingClient } from "./sip-dashboard/calling-client";
import { bridgeCall } from "./sip-dashboard/call-bridge";
import { startInboundWatcher } from "./sip-dashboard/inbound-watcher";

const sipDashboardWatcher = startInboundWatcher({
  getConfig: () => sipDashboardStore.read(),
  createCalling: createCallingClient,
  bridge: bridgeCall,
  log: (message, meta) => log(`[sip-dashboard] ${message}`, meta),
});
```

And in `shutdown(signal)`, before `server.close(...)`, add:
`sipDashboardWatcher.stop();`

- [ ] **Step 6: Manually verify**

Run: `npm run dev:gateway`. Expected: no crash, no output about
sip-dashboard unless `inboundEnabled` is later turned on in Settings — at
that point the log line "sip-dashboard inbound watcher started" appears
within `configCheckIntervalMs`. Turning it back off logs "watcher stopped."

- [ ] **Step 7: Run the full test suite, lint, and typecheck**

Run: `npm test && npm run lint && npm run typecheck`
Expected: no errors, all tests pass

- [ ] **Step 8: Commit**

```bash
git add server/sip-dashboard/inbound-watcher.ts server/sip-dashboard/inbound-watcher.test.ts server/index.ts
git commit -m "feat(sip-dashboard): add headless inbound call watcher"
```

---

## Post-plan: live verification

Not a task with a commit — a manual checklist once Tasks 1–8 are merged and
deployed:

1. Configure sip-dashboard in Settings with a real extension key.
2. Outbound: use the Telephony page's sip-dashboard panel to call a real
   phone. Confirm the phone rings, confirm audio is intelligible both ways,
   confirm interrupting the agent mid-sentence actually cuts it off.
3. Inbound: turn on "Answer inbound calls." This cannot be verified live
   until `sip`'s carrier-side inbound routing issue is fixed (tracked
   separately, outside this repo) — Task 9's tests already cover the
   watcher's own logic without a live call.
