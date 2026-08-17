# Selorax-Backed Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the AI softphone bridge takes its SIP line, its TURN servers and its call correlation from SeloraX-Backend's existing calling API instead of hand-pasted credentials. **Inbound only.**

**Architecture:** voice-ai's Next server holds a Selorax admin token for a dedicated AI user and proxies three existing endpoints. The browser bridge fetches its line from voice-ai, never from Selorax, so the Selorax token never reaches the browser. Audio still flows browser ↔ Asterisk; nothing about the media path changes.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript, JsSIP, `node:test` via `tsx`.

**Spec:** `docs/superpowers/specs/2026-08-17-selorax-backed-bridge-design.md`

## Global Constraints

- **No SeloraX-Backend or SeloraX-dashboard changes.** Every endpoint used already exists. If a task appears to need a backend change, stop and report rather than making one.
- **Outbound is out of scope** (spec §6A). Do not implement placing calls.
- **The Selorax token must never reach the browser.** It is a Selorax admin credential. It lives in `data/`, is read only by server code, and no route response may contain it. This is the one invariant worth failing a task over.
- **This is not the Next.js you know.** Read the relevant guide in `node_modules/next/dist/docs/` before writing any route handler or page.
- **No new dependencies.** `fetch` is built in; do not add an HTTP client.
- **Never contact a real Selorax backend from tests.** Inject `fetch`; assert against a stub. A test that talks to a live store is a test that can place real calls.
- React 19: ref-as-prop, no `forwardRef`. The React Compiler rule `react-hooks/set-state-in-effect` forbids `setState` inside `useEffect`.
- Tests run with `npm test` and use **relative imports**, never the `@/` alias.
- Any new store writes atomically (temp file + `rename`) through an in-process queue, like `server/config/telephony-store.ts`. A missing file is first-run, not an error. Never log file contents.
- Light theme only; colours from `app/globals.css` custom properties.
- **Never read, delete or modify anything under `data/`** — it holds real credentials and real call records. Tests use temp directories.
- Run `npm run typecheck` and `npm run lint` before each commit. Run `npm run build` once at the end.

---

### Task 1: Selorax connection config

**Files:**
- Create: `lib/selorax/config.ts`
- Create: `lib/selorax/config.test.ts`
- Create: `server/config/selorax-store.ts`
- Create: `server/config/selorax-store.test.ts`

**Interfaces:**
- Consumes: `FieldError` from `lib/agent-config/validate-helpers.ts`.
- Produces: `SeloraxConfig`, `EMPTY_SELORAX_CONFIG`, `validateSeloraxConfig(value)`, `isSeloraxConfigured(config)`, `tokenExpiryMs(token)`; `createSeloraxStore(dir, log?)` and the `seloraxStore` singleton with `read()` / `write()`.

- [ ] **Step 1: Write the failing config test**

Create `lib/selorax/config.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_SELORAX_CONFIG,
  isSeloraxConfigured,
  tokenExpiryMs,
  validateSeloraxConfig,
} from "./config";

const VALID = {
  baseUrl: "https://api.selorax.io",
  authToken: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE3ODk1MDAwMDB9.sig",
  storeId: "42",
};

test("accepts a complete connection", () => {
  const result = validateSeloraxConfig(VALID);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.storeId, "42");
});

test("absent config reads as empty rather than failing", () => {
  const result = validateSeloraxConfig(undefined);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, EMPTY_SELORAX_CONFIG);
});

test("an entirely blank form is 'not configured yet', not an error", () => {
  const result = validateSeloraxConfig({ baseUrl: "", authToken: "", storeId: "" });
  assert.equal(result.ok, true);
});

test("reports every missing field at once", () => {
  const result = validateSeloraxConfig({ ...VALID, authToken: "", storeId: "" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errors.length, 2);
});

test("rejects a base URL that is not http or https", () => {
  const result = validateSeloraxConfig({ ...VALID, baseUrl: "ftp://api.selorax.io" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errors[0].path, "baseUrl");
});

test("strips a trailing slash so paths never double up", () => {
  const result = validateSeloraxConfig({ ...VALID, baseUrl: "https://api.selorax.io/" });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.baseUrl, "https://api.selorax.io");
});

test("trims whitespace, which a pasted token almost always carries", () => {
  const result = validateSeloraxConfig({ ...VALID, authToken: `  ${VALID.authToken}  ` });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.authToken, VALID.authToken);
});

test("isSeloraxConfigured is false until every field is present", () => {
  assert.equal(isSeloraxConfigured(EMPTY_SELORAX_CONFIG), false);
  assert.equal(isSeloraxConfigured({ ...VALID, authToken: "" }), false);
  assert.equal(isSeloraxConfigured(VALID), true);
});

test("reads the expiry out of a JWT so the operator can be warned before it lapses", () => {
  // Payload {"exp":1789500000}. Not verified — we do not hold the secret and
  // do not need to; this drives a warning, never a decision.
  assert.equal(tokenExpiryMs(VALID.authToken), 1789500000 * 1000);
});

test("an unreadable token has no expiry rather than throwing", () => {
  assert.equal(tokenExpiryMs("not-a-jwt"), null);
  assert.equal(tokenExpiryMs(""), null);
  assert.equal(tokenExpiryMs("a.b.c"), null);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `Cannot find module './config'`.

- [ ] **Step 3: Write the config module**

Create `lib/selorax/config.ts`:

```ts
/**
 * How this instance talks to SeloraX-Backend.
 *
 * `authToken` is a Selorax admin JWT for the dedicated AI user — the same
 * `x-auth-token` the dashboard keeps in a cookie. It is a powerful credential
 * and MUST NOT reach the browser: only server code reads this, and no route
 * may return it. See the spec's §3.
 */

import type { FieldError } from "../agent-config/validate-helpers";

export interface SeloraxConfig {
  /** Origin of the Selorax API, no trailing slash. */
  baseUrl: string;
  /** The AI user's x-auth-token. Server-side only. */
  authToken: string;
  /** Sent as x-store-id. A string because it travels as a header. */
  storeId: string;
}

export const EMPTY_SELORAX_CONFIG: SeloraxConfig = { baseUrl: "", authToken: "", storeId: "" };

export type SeloraxConfigResult =
  | { ok: true; value: SeloraxConfig }
  | { ok: false; errors: FieldError[] };

export function isSeloraxConfigured(config: SeloraxConfig): boolean {
  return Object.values(config).every((field) => field.length > 0);
}

/**
 * The device identity this bridge claims, derived rather than configured —
 * there is exactly one correct answer, so it should not be a field an operator
 * can get wrong. `GET /api/calling/extension` claims the device from this, and
 * a stable value keeps a restart from looking like a new device.
 */
export function deviceIdFor(storeId: string): string {
  return `ai-bridge-${storeId}`;
}

/**
 * The token's expiry, for warning the operator before it lapses. Decoded, not
 * verified — we do not hold the signing secret. Never let this drive a
 * decision: an unreadable token returns null and the request is what finds out.
 */
export function tokenExpiryMs(token: string): number | null {
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(segments[1], "base64url").toString("utf8"),
    );
    const exp = (payload as { exp?: unknown })?.exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function read(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value.trim() : "";
}

export function validateSeloraxConfig(value: unknown): SeloraxConfigResult {
  if (value === undefined || value === null) return { ok: true, value: EMPTY_SELORAX_CONFIG };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: [{ path: "", message: "Expected an object." }] };
  }

  const source = value as Record<string, unknown>;
  const parsed: SeloraxConfig = {
    baseUrl: read(source, "baseUrl").replace(/\/+$/, ""),
    authToken: read(source, "authToken"),
    storeId: read(source, "storeId"),
  };

  if (Object.values(parsed).every((field) => field.length === 0)) {
    return { ok: true, value: EMPTY_SELORAX_CONFIG };
  }

  const errors: FieldError[] = [];
  for (const [key, label] of [
    ["baseUrl", "The Selorax API URL"],
    ["authToken", "The auth token"],
    ["storeId", "The store id"],
  ] as const) {
    if (parsed[key].length === 0) errors.push({ path: key, message: `${label} is required.` });
  }

  if (parsed.baseUrl.length > 0 && !/^https?:\/\//i.test(parsed.baseUrl)) {
    errors.push({ path: "baseUrl", message: "Must start with http:// or https://." });
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: parsed };
}
```

- [ ] **Step 4: Run the config tests**

Run: `npm test 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Write the failing store test**

Create `server/config/selorax-store.test.ts`, mirroring `server/config/telephony-store.test.ts` exactly — it is the reference and the contracts are identical. Cover: an unwritten store reads as `EMPTY_SELORAX_CONFIG`; write and read back; a corrupt file reads as empty and logs once; **the log never contains the token** (seed the file with `'{"authToken":"secret-token-value" '` and assert the messages do not include it); concurrent writes leave one coherent result; the file round-trips as JSON.

- [ ] **Step 6: Run it to verify it fails, then write the store**

Create `server/config/selorax-store.ts` by following `server/config/telephony-store.ts` line for line: same `createQueue`, same temp-file-and-rename, same `mode: 0o600`, same validate-on-read so a hand-edited file degrades to unconfigured rather than crashing a route. Only the filename (`selorax.json`), the type and the validator differ.

- [ ] **Step 7: Verify and commit**

```bash
npm run typecheck && npm run lint && npm test 2>&1 | tail -5
git add lib/selorax server/config/selorax-store.ts server/config/selorax-store.test.ts
git commit -m "feat: hold the Selorax connection for the bridge"
```

---

### Task 2: The Selorax calling client

**Files:**
- Create: `server/selorax/calling-client.ts`
- Create: `server/selorax/calling-client.test.ts`

**Interfaces:**
- Consumes: `SeloraxConfig`, `deviceIdFor` from `lib/selorax/config.ts`.
- Produces: `createCallingClient(config, fetchImpl?)` with `getLine()`, `reportAnswered(callerPhone)`, `reportDeclined(callerPhone)`; the `SeloraxLine` type; `SeloraxError` with a `code`.

**Server-only.** This module reads the token. It must never be imported from a client component.

- [ ] **Step 1: Write the failing test**

Create `server/selorax/calling-client.test.ts`. `fetchImpl` is injected precisely so this never touches a network:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { createCallingClient, SeloraxError } from "./calling-client";

const CONFIG = {
  baseUrl: "https://api.selorax.io",
  authToken: "token-abc",
  storeId: "42",
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

const LINE = {
  data: {
    ws_url: "wss://sip.example.com/ws",
    sip_uri: "sip:ext-8@sip.example.com",
    sip_domain: "sip.example.com",
    extension: "ext-8",
    password: "s3cret",
    iceServers: [{ urls: "turn:turn.example.com", username: "u", credential: "c" }],
  },
  status: 200,
};

test("asks the right endpoint with the right identity headers", async () => {
  const { impl, calls } = stub(200, LINE);
  await createCallingClient(CONFIG, impl).getLine();

  assert.equal(calls[0].url, "https://api.selorax.io/api/calling/extension");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers["x-auth-token"], "token-abc");
  assert.equal(headers["x-store-id"], "42");
  // Stable, so a restart does not look like a new device and churn the claim.
  assert.equal(headers["x-device-id"], "ai-bridge-42");
});

test("returns the SIP line and the TURN servers", async () => {
  const { impl } = stub(200, LINE);
  const line = await createCallingClient(CONFIG, impl).getLine();

  assert.equal(line.extension, "ext-8");
  assert.equal(line.password, "s3cret");
  assert.equal(line.iceServers?.length, 1);
});

test("a line with no iceServers is usable, not an error", async () => {
  // TURN is best-effort in Selorax too: a failure there must not stop a call.
  const { impl } = stub(200, { data: { ...LINE.data, iceServers: undefined }, status: 200 });
  const line = await createCallingClient(CONFIG, impl).getLine();
  assert.deepEqual(line.iceServers, []);
});

test("an expired token says so, rather than 'Unauthorized'", async () => {
  const { impl } = stub(401, { message: "Access denied. No token provided", status: 401 });
  const error = await createCallingClient(CONFIG, impl)
    .getLine()
    .catch((cause: unknown) => cause);

  assert.ok(error instanceof SeloraxError);
  assert.equal((error as SeloraxError).code, "token_expired");
  assert.match((error as SeloraxError).message, /token/i);
});

test("a missing extension is reported as its own cause", async () => {
  const { impl } = stub(503, { message: "no active selx-sip extension", code: "extension_not_active", status: 503 });
  const error = await createCallingClient(CONFIG, impl)
    .getLine()
    .catch((cause: unknown) => cause);

  assert.equal((error as SeloraxError).code, "extension_not_active");
});

test("an unreachable backend is a readable error, not a raw TypeError", async () => {
  const impl = async () => {
    throw new TypeError("fetch failed");
  };
  const error = await createCallingClient(CONFIG, impl)
    .getLine()
    .catch((cause: unknown) => cause);

  assert.ok(error instanceof SeloraxError);
  assert.equal((error as SeloraxError).code, "unreachable");
});

test("never puts the token in an error message", async () => {
  const { impl } = stub(500, { message: "boom" });
  const error = await createCallingClient(CONFIG, impl)
    .getLine()
    .catch((cause: unknown) => cause);

  assert.ok(!String((error as Error).message).includes("token-abc"));
});

test("reports an answered inbound call with the caller's number", async () => {
  const { impl, calls } = stub(200, { data: {}, status: 200 });
  await createCallingClient(CONFIG, impl).reportAnswered("+8801700000000");

  assert.equal(calls[0].url, "https://api.selorax.io/api/calling/inbound-answered");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { caller_phone: "+8801700000000" });
});

test("reports a declined call on its own endpoint", async () => {
  const { impl, calls } = stub(200, { data: {}, status: 200 });
  await createCallingClient(CONFIG, impl).reportDeclined("+8801700000000");
  assert.equal(calls[0].url, "https://api.selorax.io/api/calling/inbound-declined");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `Cannot find module './calling-client'`.

- [ ] **Step 3: Write the client**

Create `server/selorax/calling-client.ts`. Requirements the tests pin down:

- Headers on every request: `x-auth-token`, `x-store-id`, `x-device-id` (from `deviceIdFor`), and `content-type` on POSTs.
- `getLine()` → `GET {baseUrl}/api/calling/extension`, unwrapping Selorax's `{data, status}` envelope into a flat `SeloraxLine`. `iceServers` defaults to `[]`.
- **Error mapping is the point of this module.** `401` → `code: "token_expired"` with a message naming the token; a body `code` of `extension_not_active` or `calling_disabled` passes through; a thrown `TypeError` → `"unreachable"`; anything else → `"request_failed"`. Never interpolate the token, the config, or the raw body into a message.
- A 10-second timeout via `AbortSignal.timeout`, so a hung backend cannot wedge a Go-online click.
- `reportAnswered` / `reportDeclined` → `POST` with `{caller_phone}`.

- [ ] **Step 4: Run the tests, then verify and commit**

```bash
npm test 2>&1 | tail -5 && npm run typecheck && npm run lint
git add server/selorax
git commit -m "feat: talk to the Selorax calling API as the AI user"
```

---

### Task 3: The proxy routes

**Files:**
- Create: `app/api/telephony/line/route.ts`
- Create: `app/api/telephony/report/route.ts`
- Create: `app/api/selorax/route.ts`
- Create: `lib/selorax/line.test.ts`

**Interfaces:**
- Produces: `GET /api/telephony/line` → `SeloraxLine`; `POST /api/telephony/report` → `{event: "answered"|"declined", callerPhone}`; `GET`/`PUT /api/selorax` for the config.

- [ ] **Step 1: Read the Next.js docs**

Read the route-handler guide under `node_modules/next/dist/docs/`. Follow `app/api/telephony/route.ts` for the local conventions (`runtime = "nodejs"`, `dynamic = "force-dynamic"`, the `{errors: FieldError[]}` failure shape).

- [ ] **Step 2: Write the failing redaction test**

The invariant worth its own test is that **no response can carry the token**. Create `lib/selorax/line.test.ts` around a small pure helper the line route uses:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { toLineResponse } from "./line";

const LINE = {
  wsUrl: "wss://sip.example.com/ws",
  sipUri: "sip:ext-8@sip.example.com",
  sipDomain: "sip.example.com",
  extension: "ext-8",
  password: "s3cret",
  iceServers: [{ urls: "turn:turn.example.com", username: "u", credential: "c" }],
};

test("passes through exactly the fields the browser needs", () => {
  const body = toLineResponse(LINE);
  assert.deepEqual(Object.keys(body).sort(), [
    "extension", "iceServers", "password", "sipDomain", "sipUri", "wsUrl",
  ]);
});

test("cannot leak a Selorax credential even if one is attached upstream", () => {
  // The response is built field by field rather than spread, so a field added
  // to SeloraxLine later cannot silently reach the browser.
  const contaminated = { ...LINE, authToken: "token-abc", storeId: "42" } as never;
  const body = toLineResponse(contaminated);
  const serialised = JSON.stringify(body);
  assert.ok(!serialised.includes("token-abc"));
  assert.ok(!("authToken" in body));
});

test("the SIP password IS included — digest auth happens in the browser", () => {
  // Stated as a test so nobody 'fixes' it later: without this the bridge
  // cannot register at all. See the spec's §3.
  assert.equal(toLineResponse(LINE).password, "s3cret");
});
```

- [ ] **Step 3: Run it to verify it fails, then implement**

Create `lib/selorax/line.ts` with `toLineResponse`, building the object **field by field, never by spreading**, so a future field on `SeloraxLine` cannot reach the browser by accident.

Then the three routes:

- `GET /api/telephony/line` — read config, `503` with a readable message when unconfigured, otherwise call `getLine()` and return `toLineResponse(...)`. Map `SeloraxError.code` to a status: `token_expired` → `401`, `extension_not_active` → `503`, `unreachable` → `502`.
- `POST /api/telephony/report` — `{event, callerPhone}`; call `reportAnswered`/`reportDeclined`. **Always respond `202`, even on failure**, and log the failure server-side: correlation bookkeeping must never fail a live call.
- `GET`/`PUT /api/selorax` — the config, mirroring `app/api/telephony/route.ts`. **`GET` must not return `authToken`.** Return `{baseUrl, storeId, hasToken: boolean, tokenExpiresAt: number | null}` instead, so the settings screen can show state and warn about expiry without ever shipping the credential. On `PUT`, an empty `authToken` means "keep the existing one" so re-saving the URL does not wipe the token.

- [ ] **Step 4: Verify and commit**

```bash
npm run typecheck && npm run lint && npm test 2>&1 | tail -5
git add app/api/telephony/line app/api/telephony/report app/api/selorax lib/selorax/line.ts lib/selorax/line.test.ts
git commit -m "feat: proxy the Selorax calling API without exposing its token"
```

---

### Task 4: The bridge uses the line, and finally has TURN

This is the milestone. It is also the fix for a real defect: the bridge sets no `pcConfig` today, so JsSIP falls back to one public STUN server — the STUN-only failure that loses audio behind symmetric NAT.

**Files:**
- Modify: `lib/telephony/sip-bridge.ts`
- Modify: `hooks/useSoftphoneBridge.ts`
- Modify: `components/telephony/BridgePanel.tsx`
- Modify: `app/(console)/telephony/page.tsx`

**Interfaces:**
- Consumes: `GET /api/telephony/line`.
- Produces: `SipBridge.goOnline(creds, options?)` where `options.iceServers` becomes the peer connection's `pcConfig`.

- [ ] **Step 1: Accept ICE servers in the SIP bridge**

`sip-bridge.ts:63` is `goOnline(creds: SipCredentials)`. Widen it to take the ICE servers and pass them as `pcConfig` on the `JsSIP.UA` options and on `answer()`, exactly as `SeloraX-dashboard/contexts/CallContext.js:594,608` does.

When the list is empty, keep today's behaviour rather than refusing to register — Selorax treats TURN as best-effort for the same reason (`routers/calling.js:321-330`), and a call over STUN is better than no call.

- [ ] **Step 2: Fetch the line on Go online**

In `useSoftphoneBridge.ts`, `goOnline` fetches `GET /api/telephony/line` and registers with what comes back, instead of using credentials passed in from the page.

Fetch **once per online session, not per call** — `GET /api/calling/extension` is rate-limited to 5/min per user, and it claims the device on every hit.

On failure, do not register: dispatch `registration_failed` with the message from the route. An agent that is "online" with no line is a phone that rings into nothing.

- [ ] **Step 3: Update the panel and page**

`BridgePanel` stops taking `initialCredentials` and instead shows connection state: whether Selorax is configured, and the token's expiry with a warning when it is close. The page reads `seloraxStore` rather than `telephonyStore`.

Keep the direct-credentials path available but secondary (spec §6.6) — it is the only way to develop without a backend. Derive the mode rather than adding a toggle: if the Selorax config is complete use it, otherwise fall back to stored SIP credentials, and **display which mode is active** so it is never a mystery.

- [ ] **Step 4: Verify**

```bash
npm run typecheck && npm run lint && npm test 2>&1 | tail -5 && npm run build 2>&1 | tail -20
```

Do not attempt a live call — you have no dev server and no phone. Report what a human must do.

- [ ] **Step 5: Commit**

```bash
git add lib/telephony/sip-bridge.ts hooks/useSoftphoneBridge.ts components/telephony app/\(console\)/telephony
git commit -m "feat: take the SIP line and TURN servers from Selorax"
```

---

### Task 5: Settings screen and inbound correlation

**Files:**
- Create: `app/(console)/settings/selorax/page.tsx`
- Create: `components/settings/SeloraxPanel.tsx`
- Modify: `lib/agent-config/routes.ts`
- Modify: `hooks/useSoftphoneBridge.ts`

- [ ] **Step 1: The settings screen**

A form for `baseUrl`, `authToken` and `storeId`, saving to `PUT /api/selorax`. The token field is `type="password"` and shows only whether one is stored, never its value. Show the decoded expiry and warn when it is within 14 days — a 90-day token that lapses silently is a support call.

Add the route to `AGENT_ROUTES` in `lib/agent-config/routes.ts` (`group: null`); the sidebar renders from it and holds no list of its own.

Include a short note that this must be a **dedicated Selorax user with a restricted role**, and why: the token is an admin credential, and the AI needs calling only.

- [ ] **Step 2: Report answered and declined calls**

In `useSoftphoneBridge.ts`, after answering an inbound call, `POST /api/telephony/report` with `{event: "answered", callerPhone}`. When the bridge rejects a call, report `declined`.

**Fire and forget.** Never await this before answering, and never let a failure end or block a call — selx-sip's inbound webhook cannot say which extension answered (`routers/calling.js:1162`), so this is how the call correlates, but a caller waiting on an HTTP round trip is a worse outcome than a call missing from a report.

Only for inbound. Outbound is out of scope, and Selorax already correlates calls it placed itself.

- [ ] **Step 3: Verify and commit**

```bash
npm run typecheck && npm run lint && npm test 2>&1 | tail -5 && npm run build 2>&1 | tail -20
git add app/\(console\)/settings/selorax components/settings/SeloraxPanel.tsx lib/agent-config/routes.ts hooks/useSoftphoneBridge.ts
git commit -m "feat: configure Selorax and correlate inbound AI calls"
```

---

## Done

Run `npm run build` once, confirm `/settings/selorax`, `/api/telephony/line`, `/api/telephony/report` and `/api/selorax` are all in the route list, then use `superpowers:finishing-a-development-branch`.

**Task 4 is the milestone** — it is where TURN becomes real, and it is the most likely fix for bad audio on a first live call. If it surfaces something unexpected, stop and report rather than pressing on to Task 5.

**A human must still:** create a dedicated Selorax admin user for the AI with a restricted role, give it an extension, log in as it once to obtain an `x-auth-token`, and paste that into `/settings/selorax`.
