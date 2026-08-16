# AI Softphone Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer a real inbound phone call with the Gemini Live agent by putting it behind the existing WebRTC softphone, with no changes to `selx-sip`, SeloraX-Backend or SeloraX-dashboard.

**Architecture:** A page in this repo registers one SIP extension with JsSIP. On an inbound call it answers with a `MediaStream` fed by the existing `StreamingAudioPlayer` instead of a microphone, and pipes the caller's remote track through the existing recorder worklet into the existing voice gateway. Web Audio's scheduler handles pacing; the player's existing `clear()` handles barge-in.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript, JsSIP (new), Web Audio API, `node:test` via `tsx`.

**Spec:** `docs/superpowers/specs/2026-08-16-ai-softphone-bridge-design.md`

## Global Constraints

- **This is not the Next.js you know.** Before writing any page, layout or route handler, read the relevant guide in `node_modules/next/dist/docs/` (resolved from the repo root). APIs and conventions differ from training data.
- **No new dependencies except `jssip`**, added in Task 5 only. This repo has added none so far; every other task uses what is already installed.
- **React 19:** ref-as-prop, no `forwardRef`. The React Compiler ESLint rules are on — `react-hooks/set-state-in-effect` forbids `setState` inside `useEffect`; adjust state during render instead when a prop change must drive state.
- **Tests** run with `npm test` (`node --import tsx --test "lib/**/*.test.ts" "server/**/*.test.ts"`). Test files use **relative imports**, not the `@/` alias, matching every existing test.
- **Browser-only code is not unit-tested** in this repo (there are no tests under `lib/audio/`). Pure logic is extracted so it can be tested; `AudioContext`/`RTCPeerConnection`/JsSIP code is verified by running the app.
- **Light theme only.** Use the CSS custom properties defined in `app/globals.css` (`--text`, `--text-muted`, `--text-dim`, `--surface-2`, `--border`, `--accent`, `--danger`, `--warning`, `--success`). Never hardcode colours.
- **Any new store writes atomically** (temp file + `rename`) and serialises writes through an in-process queue, exactly like `server/config/call-log-store.ts`. A read of a missing file is the first-run path, not an error.
- **Absent fields default rather than fail** in any validator touching persisted data. There are ~500 existing call records and a live agent config; a new required field would silently invalidate them.
- **Never delete or reset `data/`.** It holds the operator's real configuration and call history.
- Run `npm run typecheck` and `npm run lint` before each commit. Do not run `npm run build` between tasks; run it once at the end.

---

### Task 1: Bridge state machine

The lifecycle logic, as a pure reducer with no browser objects in it. This is the one part of the bridge that can be tested properly, so it is written first and the imperative shell in Task 5 is built to obey it.

**Files:**
- Create: `lib/telephony/bridge-state.ts`
- Test: `lib/telephony/bridge-state.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `BridgeStatus`, `BridgeEvent`, `BridgeState`, `INITIAL_BRIDGE_STATE`, `bridgeReducer(state, event) => BridgeState`. Task 5 drives this from JsSIP and gateway callbacks.

- [ ] **Step 1: Write the failing test**

Create `lib/telephony/bridge-state.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { INITIAL_BRIDGE_STATE, bridgeReducer, type BridgeState } from "./bridge-state";

function reduce(events: Parameters<typeof bridgeReducer>[1][]): BridgeState {
  return events.reduce(bridgeReducer, INITIAL_BRIDGE_STATE);
}

test("starts offline", () => {
  assert.equal(INITIAL_BRIDGE_STATE.status, "offline");
});

test("registering moves through connecting to online", () => {
  assert.equal(reduce([{ type: "go_online" }]).status, "connecting");
  assert.equal(reduce([{ type: "go_online" }, { type: "registered" }]).status, "online");
});

test("a registration failure is reported with its message", () => {
  const state = reduce([
    { type: "go_online" },
    { type: "registration_failed", message: "401 Unauthorized" },
  ]);
  assert.equal(state.status, "failed");
  assert.equal(state.error, "401 Unauthorized");
});

test("an incoming call carries the caller's number", () => {
  const state = reduce([
    { type: "go_online" },
    { type: "registered" },
    { type: "incoming", from: "+8801700000000", to: "+8809600000000" },
  ]);
  assert.equal(state.status, "ringing");
  assert.equal(state.from, "+8801700000000");
  assert.equal(state.to, "+8809600000000");
});

test("the call becomes live only once the gateway is open", () => {
  const ringing = reduce([
    { type: "go_online" },
    { type: "registered" },
    { type: "incoming", from: null, to: null },
  ]);
  assert.equal(bridgeReducer(ringing, { type: "gateway_open" }).status, "in_call");
});

test("the agent asking to hang up records the reason without ending the call", () => {
  const inCall = reduce([
    { type: "go_online" },
    { type: "registered" },
    { type: "incoming", from: null, to: null },
    { type: "gateway_open" },
  ]);
  const ending = bridgeReducer(inCall, { type: "agent_ending", reason: "caller was abusive" });
  // Still in_call: the agent is mid-goodbye and the audio must finish playing.
  assert.equal(ending.status, "in_call");
  assert.equal(ending.endReason, "caller was abusive");
});

test("the gateway closing drains before the call is torn down", () => {
  const inCall = reduce([
    { type: "go_online" },
    { type: "registered" },
    { type: "incoming", from: null, to: null },
    { type: "gateway_open" },
  ]);
  assert.equal(bridgeReducer(inCall, { type: "gateway_closed" }).status, "ending");
});

test("returns to online after a call ends, ready for the next one", () => {
  const ending = reduce([
    { type: "go_online" },
    { type: "registered" },
    { type: "incoming", from: "+880", to: null },
    { type: "gateway_open" },
    { type: "gateway_closed" },
  ]);
  const done = bridgeReducer(ending, { type: "call_ended" });
  assert.equal(done.status, "online");
  // Per-call detail is cleared so the next call cannot inherit it.
  assert.equal(done.from, null);
  assert.equal(done.endReason, null);
});

test("a caller who hangs up mid-call returns straight to online", () => {
  const inCall = reduce([
    { type: "go_online" },
    { type: "registered" },
    { type: "incoming", from: null, to: null },
    { type: "gateway_open" },
  ]);
  assert.equal(bridgeReducer(inCall, { type: "call_ended" }).status, "online");
});

test("a caller who gives up while ringing returns to online", () => {
  const ringing = reduce([
    { type: "go_online" },
    { type: "registered" },
    { type: "incoming", from: null, to: null },
  ]);
  assert.equal(bridgeReducer(ringing, { type: "call_ended" }).status, "online");
});

test("going offline wins from any state", () => {
  const inCall = reduce([
    { type: "go_online" },
    { type: "registered" },
    { type: "incoming", from: null, to: null },
    { type: "gateway_open" },
  ]);
  assert.equal(bridgeReducer(inCall, { type: "go_offline" }).status, "offline");
});

test("an unknown event leaves the state untouched", () => {
  const online = reduce([{ type: "go_online" }, { type: "registered" }]);
  // @ts-expect-error deliberately invalid, to prove the reducer is total
  assert.equal(bridgeReducer(online, { type: "nonsense" }), online);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `Cannot find module './bridge-state'`.

- [ ] **Step 3: Write the implementation**

Create `lib/telephony/bridge-state.ts`:

```ts
/**
 * The bridge's lifecycle, as a pure reducer.
 *
 * Everything else in the bridge touches JsSIP, WebRTC or an AudioContext and
 * cannot be tested in this repo's Node test runner. This file deliberately
 * holds no browser object, so the part most likely to be wrong — the ordering
 * rules between SIP events and gateway events — is the part under test.
 */

export type BridgeStatus =
  | "offline"
  | "connecting"
  | "online"
  | "ringing"
  | "in_call"
  | "ending"
  | "failed";

export type BridgeEvent =
  | { type: "go_online" }
  | { type: "registered" }
  | { type: "registration_failed"; message: string }
  | { type: "incoming"; from: string | null; to: string | null }
  | { type: "gateway_open" }
  | { type: "agent_ending"; reason: string }
  | { type: "gateway_closed" }
  | { type: "call_ended" }
  | { type: "go_offline" };

export interface BridgeState {
  status: BridgeStatus;
  /** The caller's number, when the SIP headers carried one. */
  from: string | null;
  /** The number that was dialled. */
  to: string | null;
  /** Set when the agent decided to hang up, for the call record. */
  endReason: string | null;
  /** Set on a registration failure, shown to the operator. */
  error: string | null;
}

export const INITIAL_BRIDGE_STATE: BridgeState = {
  status: "offline",
  from: null,
  to: null,
  endReason: null,
  error: null,
};

/** Clears per-call detail so the next call cannot inherit the last one's. */
function idle(status: BridgeStatus): BridgeState {
  return { status, from: null, to: null, endReason: null, error: null };
}

export function bridgeReducer(state: BridgeState, event: BridgeEvent): BridgeState {
  switch (event.type) {
    // An operator hanging up the bridge wins from anywhere, including
    // mid-call — it is the stop button.
    case "go_offline":
      return idle("offline");

    case "go_online":
      return { ...idle("connecting") };

    case "registered":
      return state.status === "connecting" ? idle("online") : state;

    case "registration_failed":
      return { ...idle("failed"), error: event.message };

    case "incoming":
      // Only an idle, registered bridge takes a call. A second INVITE while
      // one is live is ignored here and rejected by the shell.
      if (state.status !== "online") return state;
      return { ...state, status: "ringing", from: event.from, to: event.to };

    case "gateway_open":
      return state.status === "ringing" ? { ...state, status: "in_call" } : state;

    // The agent asked to hang up, but its closing sentence is still being
    // generated and then played. The call ends on `gateway_closed`, not here.
    case "agent_ending":
      return state.status === "in_call" ? { ...state, endReason: event.reason } : state;

    // The gateway is done. Audio may still be queued in the player, so the
    // shell drains before terminating SIP — hence a distinct state.
    case "gateway_closed":
      return state.status === "in_call" ? { ...state, status: "ending" } : state;

    case "call_ended":
      if (state.status === "offline" || state.status === "failed") return state;
      return idle("online");

    default:
      return state;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test 2>&1 | tail -20`
Expected: PASS, all tests including the 133 that already existed.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint
git add lib/telephony/bridge-state.ts lib/telephony/bridge-state.test.ts
git commit -m "feat: add the softphone bridge state machine"
```

---

### Task 2: SIP credentials — validation, store, API route

**Files:**
- Create: `lib/telephony/credentials.ts`
- Create: `lib/telephony/credentials.test.ts`
- Create: `server/config/telephony-store.ts`
- Create: `server/config/telephony-store.test.ts`
- Create: `app/api/telephony/route.ts`

**Interfaces:**
- Consumes: `FieldError` from `lib/agent-config/validate-helpers.ts` (already exported there).
- Produces: `SipCredentials`, `validateSipCredentials(value)`, `EMPTY_CREDENTIALS`; `createTelephonyStore(dir, log?)` and the `telephonyStore` singleton with `read()` / `write(creds)`. Task 5's page reads these over `GET /api/telephony`.

- [ ] **Step 1: Write the failing validation test**

Create `lib/telephony/credentials.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { EMPTY_CREDENTIALS, validateSipCredentials } from "./credentials";

const VALID = {
  wsUrl: "wss://sip.example.com:8089/ws",
  sipUri: "sip:ext-8@sip.example.com",
  sipDomain: "sip.example.com",
  extension: "ext-8",
  password: "s3cret",
};

test("accepts a complete set of credentials", () => {
  const result = validateSipCredentials(VALID);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.extension, "ext-8");
});

test("absent credentials read as empty rather than failing", () => {
  const result = validateSipCredentials(undefined);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, EMPTY_CREDENTIALS);
});

test("rejects a websocket URL that is not ws or wss", () => {
  const result = validateSipCredentials({ ...VALID, wsUrl: "https://sip.example.com/ws" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errors[0].path, "wsUrl");
});

test("rejects a SIP URI without the sip: scheme", () => {
  const result = validateSipCredentials({ ...VALID, sipUri: "ext-8@sip.example.com" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errors[0].path, "sipUri");
});

test("reports every missing field at once, not just the first", () => {
  const result = validateSipCredentials({ wsUrl: "", sipUri: "", sipDomain: "", extension: "", password: "" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errors.length, 5);
});

test("trims surrounding whitespace, which a paste almost always carries", () => {
  const result = validateSipCredentials({ ...VALID, extension: "  ext-8  " });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.extension, "ext-8");
});

test("a partially filled form is rejected rather than half-saved", () => {
  const result = validateSipCredentials({ ...VALID, password: "" });
  assert.equal(result.ok, false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `Cannot find module './credentials'`.

- [ ] **Step 3: Write the validator**

Create `lib/telephony/credentials.ts`:

```ts
/**
 * The SIP line the bridge registers as.
 *
 * These are the same five values the SeloraX dashboard receives from
 * `GET /api/calling/extension` and hands to JsSIP. They are pasted in by an
 * operator for now — see the spec's "Credentials, for now".
 *
 * Absent credentials validate to the empty set rather than failing, because
 * `read()` validates on the way out: a first run with no file must not throw.
 */

import type { FieldError } from "../agent-config/validate-helpers";

export interface SipCredentials {
  /** The SIP-over-WebSocket endpoint, e.g. wss://host:8089/ws */
  wsUrl: string;
  /** The line's own address, e.g. sip:ext-8@host */
  sipUri: string;
  sipDomain: string;
  extension: string;
  /** SIP digest password. Needed in the browser; there is no way around it. */
  password: string;
}

export const EMPTY_CREDENTIALS: SipCredentials = {
  wsUrl: "",
  sipUri: "",
  sipDomain: "",
  extension: "",
  password: "",
};

export type CredentialsResult =
  | { ok: true; value: SipCredentials }
  | { ok: false; errors: FieldError[] };

function read(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value.trim() : "";
}

export function isConfigured(creds: SipCredentials): boolean {
  return Object.values(creds).every((value) => value.length > 0);
}

export function validateSipCredentials(value: unknown): CredentialsResult {
  if (value === undefined || value === null) return { ok: true, value: EMPTY_CREDENTIALS };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: [{ path: "", message: "Expected an object." }] };
  }

  const source = value as Record<string, unknown>;
  const parsed: SipCredentials = {
    wsUrl: read(source, "wsUrl"),
    sipUri: read(source, "sipUri"),
    sipDomain: read(source, "sipDomain"),
    extension: read(source, "extension"),
    password: read(source, "password"),
  };

  // An entirely empty object is "not configured yet", not a validation error —
  // that is the state the page starts in.
  if (Object.values(parsed).every((field) => field.length === 0)) {
    return { ok: true, value: EMPTY_CREDENTIALS };
  }

  // Every missing field is reported at once: an operator pasting five values
  // should not have to submit five times to find all the mistakes.
  const errors: FieldError[] = [];
  for (const [key, label] of [
    ["wsUrl", "The WebSocket URL"],
    ["sipUri", "The SIP URI"],
    ["sipDomain", "The SIP domain"],
    ["extension", "The extension"],
    ["password", "The password"],
  ] as const) {
    if (parsed[key].length === 0) errors.push({ path: key, message: `${label} is required.` });
  }

  if (parsed.wsUrl.length > 0 && !/^wss?:\/\//i.test(parsed.wsUrl)) {
    errors.push({ path: "wsUrl", message: "Must start with ws:// or wss://." });
  }
  if (parsed.sipUri.length > 0 && !/^sip:/i.test(parsed.sipUri)) {
    errors.push({ path: "sipUri", message: "Must start with sip:." });
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: parsed };
}
```

- [ ] **Step 4: Run the validation tests**

Run: `npm test 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Write the failing store test**

Create `server/config/telephony-store.test.ts`:

```ts
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
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `Cannot find module './telephony-store'`.

- [ ] **Step 7: Write the store**

Create `server/config/telephony-store.ts`, following `call-log-store.ts` exactly — same atomic write, same serialisation queue, same "a broken file reads as empty" contract:

```ts
/**
 * Persistence for the bridge's SIP credentials.
 *
 * Same shape as the other stores here: a JSON file under data/, written
 * temp-file-and-rename so a crash mid-write cannot truncate it, and reads that
 * never throw — a corrupt file degrades to "not configured", which the page can
 * show, rather than taking the route down.
 *
 * This file holds a SIP password in plaintext. data/ is git-ignored precisely
 * because of files like this one.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  EMPTY_CREDENTIALS,
  validateSipCredentials,
  type SipCredentials,
} from "../../lib/telephony/credentials";

export type StoreLogger = (message: string) => void;

export interface TelephonyStore {
  read(): Promise<SipCredentials>;
  write(credentials: SipCredentials): Promise<SipCredentials>;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function createQueue(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job, job);
    tail = run.catch(() => undefined);
    return run;
  };
}

export function createTelephonyStore(dataDir: string, log: StoreLogger = () => {}): TelephonyStore {
  const file = path.join(dataDir, "telephony.json");
  const enqueue = createQueue();

  return {
    async read(): Promise<SipCredentials> {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(file, "utf8"));
      } catch (error) {
        // Log the error's name only — the file contains a password.
        if (!isMissing(error)) log(`telephony.json is unreadable (${(error as Error).name})`);
        return EMPTY_CREDENTIALS;
      }
      const result = validateSipCredentials(parsed);
      if (!result.ok) {
        log("telephony.json failed validation; treating it as unconfigured");
        return EMPTY_CREDENTIALS;
      }
      return result.value;
    },

    async write(credentials: SipCredentials): Promise<SipCredentials> {
      return enqueue(async () => {
        await mkdir(dataDir, { recursive: true });
        const temp = `${file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temp, `${JSON.stringify(credentials, null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600,
          });
          await rename(temp, file);
        } catch (cause) {
          await unlink(temp).catch(() => undefined);
          throw cause;
        }
        return credentials;
      });
    },
  };
}

export const telephonyStore = createTelephonyStore(path.join(process.cwd(), "data"), (message) =>
  console.warn(`[telephony] ${message}`),
);
```

- [ ] **Step 8: Run the tests**

Run: `npm test 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 9: Add the API route**

First read `node_modules/next/dist/docs/` for the current route-handler guide. Then create `app/api/telephony/route.ts`, mirroring `app/api/agent-config/route.ts`:

```ts
/**
 * Read and write the bridge's SIP credentials.
 *
 * The password is returned to the browser, unlike the agent-config route which
 * withholds secret values. It has to be: SIP digest auth happens in the page,
 * so JsSIP needs the plaintext. This is the same thing the SeloraX dashboard
 * already does with the same credential.
 *
 * Runs on the Node runtime because the store touches the filesystem.
 */

import { NextResponse } from "next/server";

import { validateSipCredentials } from "@/lib/telephony/credentials";
import { telephonyStore } from "@/server/config/telephony-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(await telephonyStore.read());
}

export async function PUT(request: Request): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);

  const result = validateSipCredentials(body);
  if (!result.ok) {
    return NextResponse.json({ errors: result.errors }, { status: 400 });
  }

  try {
    return NextResponse.json(await telephonyStore.write(result.value));
  } catch (cause) {
    console.error("[telephony] write failed:", cause);
    return NextResponse.json(
      { errors: [{ path: "", message: "Could not save the credentials." }] },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 10: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint && npm test 2>&1 | tail -5
git add lib/telephony/credentials.ts lib/telephony/credentials.test.ts \
        server/config/telephony-store.ts server/config/telephony-store.test.ts \
        app/api/telephony/route.ts
git commit -m "feat: store and validate the bridge's SIP credentials"
```

---

### Task 3: Capture audio from any MediaStream

`MicrophoneCapture` already does everything needed — `createMediaStreamSource`, the recorder worklet, PCM16 at 16 kHz — but acquires its own stream via `getUserMedia`. Split the acquisition from the pipeline so the caller's remote WebRTC track can go through the same path.

**Files:**
- Create: `lib/audio/audio-capture.ts`
- Modify: `lib/audio/microphone.ts`

**Interfaces:**
- Consumes: `createAudioContext`, `loadRecorderWorklet`, `RECORDER_PROCESSOR_NAME`, `RecorderProcessorOptions` from `lib/audio/audio-worklet.ts`; `INPUT_SAMPLE_RATE`, `MIC_CHUNK_MS` from wherever `microphone.ts` currently imports them.
- Produces: `AudioCapture` with `start(stream: MediaStream): Promise<void>`, `addTrack(track: MediaStreamTrack): void`, `stop(): Promise<void>`, `setMuted(muted: boolean): void`, `isRunning`, `sampleRate`. `MicrophoneCapture` keeps its **exact current public API** so `hooks/useVoiceSession.ts` is untouched.

- [ ] **Step 1: Read the file you are changing**

Read `lib/audio/microphone.ts` in full. Note which members `hooks/useVoiceSession.ts:418` uses: the `{onChunk, onLevel, onError}` constructor, `start()`, `stop()`, `isMuted`, and mute toggling. All of these must keep working identically.

- [ ] **Step 2: Extract the pipeline into `AudioCapture`**

Create `lib/audio/audio-capture.ts` holding everything from `createAudioContext` onward, taking a `MediaStream` in `start()`. Key points:

```ts
/**
 * Turns any MediaStream into PCM16 chunks at 16 kHz.
 *
 * Split out of MicrophoneCapture so the same pipeline serves both a microphone
 * and the remote track of a phone call — the only difference between the two
 * is where the stream comes from.
 */
export class AudioCapture {
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private stream: MediaStream | null = null;
  private muted = false;
  private running = false;

  constructor(private readonly handlers: AudioCaptureHandlers) {}

  async start(stream: MediaStream): Promise<void> {
    if (this.running) return;
    this.stream = stream;
    this.context = createAudioContext(INPUT_SAMPLE_RATE);
    if (this.context.state === "suspended") await this.context.resume();
    await loadRecorderWorklet(this.context);
    // ...identical to the existing worklet wiring in microphone.ts...
    this.running = true;
  }

  /**
   * A renegotiated or late-arriving remote track — after a transfer or a hold
   * resume — is not in the snapshot taken at answer time. The dashboard hit
   * exactly this as an "agent can't hear the customer" bug
   * (SeloraX-dashboard/contexts/CallContext.js:809), so handle it here too.
   */
  addTrack(track: MediaStreamTrack): void {
    if (!this.stream || !this.context || !this.source) return;
    this.stream.addTrack(track);
    // Rebuild the source node: a MediaStreamAudioSourceNode is bound to the
    // track set it was created with and does not pick up additions.
    this.source.disconnect();
    this.source = this.context.createMediaStreamSource(this.stream);
    if (this.worklet) this.source.connect(this.worklet);
  }

  // stop(), setMuted(), isRunning, sampleRate — moved verbatim.
}
```

Do not change the worklet wiring, the `sink` gain node, the chunk handling or the RMS levelling. This is a move, not a rewrite.

- [ ] **Step 3: Reduce `MicrophoneCapture` to a wrapper**

Rewrite `lib/audio/microphone.ts` so it keeps `MicrophoneError`, the `getUserMedia` call and its error mapping, then delegates:

```ts
export class MicrophoneCapture {
  private readonly capture: AudioCapture;
  private stream: MediaStream | null = null;

  constructor(handlers: MicrophoneCaptureHandlers) {
    this.capture = new AudioCapture(handlers);
  }

  async start(): Promise<void> {
    if (this.capture.isRunning) return;
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new MicrophoneError("unsupported", "This browser does not support microphone capture. Try Chrome, Edge or Safari over HTTPS.");
      }
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      await this.capture.start(this.stream);
    } catch (cause) {
      await this.stop();
      throw cause instanceof MicrophoneError ? cause : toMicrophoneError(cause);
    }
  }

  // stop() must also stop the getUserMedia tracks, which AudioCapture does not
  // own — releasing the microphone is this class's responsibility alone.
}
```

The public surface — constructor shape, `start()`, `stop()`, `isMuted`, `isRunning`, `sampleRate`, mute control — must be byte-for-byte compatible. `hooks/useVoiceSession.ts` is not edited in this task.

- [ ] **Step 4: Verify the preview still works**

```bash
npm run typecheck && npm run lint && npm test 2>&1 | tail -5
```

Then start the app (`npm run dev`), open the agent preview, start a call, and confirm the waveform moves, the agent replies, and hanging up is clean. This is a browser-only path with no unit tests; running it is the verification.

- [ ] **Step 5: Commit**

```bash
git add lib/audio/audio-capture.ts lib/audio/microphone.ts
git commit -m "refactor: capture PCM from any MediaStream, not only a microphone"
```

---

### Task 4: Play the agent into a MediaStream

**Files:**
- Create: `lib/audio/playout.ts`
- Create: `lib/audio/playout.test.ts`
- Modify: `lib/audio/audio-player.ts`

**Interfaces:**
- Produces: `remainingPlayoutMs(nextStartTime, currentTime)` (pure); `StreamingAudioPlayer.start(output?: "speakers" | "stream")`, `player.outputStream: MediaStream | null`, `player.remainingPlayoutMs: number`. Task 5 hands `outputStream` to JsSIP and waits on `remainingPlayoutMs` before terminating.

- [ ] **Step 1: Write the failing test**

Create `lib/audio/playout.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { remainingPlayoutMs } from "./playout";

test("nothing scheduled means nothing left to play", () => {
  assert.equal(remainingPlayoutMs(5, 5), 0);
});

test("audio scheduled ahead reports the gap in milliseconds", () => {
  assert.equal(remainingPlayoutMs(5.5, 5), 500);
});

test("a schedule already in the past never reports negative time", () => {
  // Web Audio's currentTime runs on past a finished schedule; a naive
  // subtraction would return a negative wait and the caller would hang up early.
  assert.equal(remainingPlayoutMs(4, 5), 0);
});

test("rounds to whole milliseconds so it can drive a timer", () => {
  assert.equal(remainingPlayoutMs(5.0004, 5), 0);
  assert.equal(remainingPlayoutMs(5.0006, 5), 1);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `Cannot find module './playout'`.

- [ ] **Step 3: Write it**

Create `lib/audio/playout.ts`:

```ts
/**
 * How much audio is still scheduled to play.
 *
 * Split from the player so it can be tested without an AudioContext. The
 * bridge waits on this before hanging up: the gateway closes two seconds after
 * the model stops *generating*, but the player schedules ahead, so terminating
 * SIP on the socket close alone cuts the agent off mid-goodbye.
 */
export function remainingPlayoutMs(nextStartTime: number, currentTime: number): number {
  return Math.max(0, Math.round((nextStartTime - currentTime) * 1000));
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Add the stream output to the player**

Modify `lib/audio/audio-player.ts`. In `start()`, take an output mode and branch only on the final connection:

```ts
export type PlayerOutput = "speakers" | "stream";

async start(output: PlayerOutput = "speakers"): Promise<void> {
  // ...existing context/master/analyser setup, unchanged...

  if (output === "stream") {
    // A phone call takes the audio as a track, not through the speakers. The
    // node emits digital silence when idle, which WebRTC encodes happily —
    // there is no gap-in-the-stream failure mode here.
    this.streamDestination = context.createMediaStreamDestination();
    analyser.connect(this.streamDestination);
  } else {
    analyser.connect(context.destination);
  }

  // ...rest unchanged...
}

get outputStream(): MediaStream | null {
  return this.streamDestination?.stream ?? null;
}

get remainingPlayoutMs(): number {
  const context = this.context;
  if (!context) return 0;
  return remainingPlayoutMs(this.nextStartTime, context.currentTime);
}
```

Everything else — the scheduler, `clear()`, `getOutputLevel()`, the analyser — is untouched, so the preview and the phone call run the same code. `start()` keeps its zero-argument call site in `hooks/useVoiceSession.ts:392` working via the default.

- [ ] **Step 6: Verify and commit**

```bash
npm run typecheck && npm run lint && npm test 2>&1 | tail -5
```

Run the preview once more and confirm playback and the agent waveform still work.

```bash
git add lib/audio/playout.ts lib/audio/playout.test.ts lib/audio/audio-player.ts
git commit -m "feat: let the player output to a MediaStream and report drain time"
```

---

### Task 5: The SIP bridge and its page

The integration task. This is where the first real phone call happens.

**Files:**
- Modify: `package.json` (add `jssip`)
- Create: `lib/telephony/sip-bridge.ts`
- Create: `hooks/useSoftphoneBridge.ts`
- Create: `app/(console)/telephony/page.tsx`
- Create: `components/telephony/BridgePanel.tsx`
- Create: `components/telephony/CredentialsForm.tsx`
- Modify: `components/shell/Sidebar.tsx` to add a **Telephony** entry via its existing `item(href, label)` helper

**Interfaces:**
- Consumes: `bridgeReducer`/`BridgeState` (Task 1), `SipCredentials` (Task 2), `AudioCapture` (Task 3), `StreamingAudioPlayer` with `outputStream`/`remainingPlayoutMs` (Task 4), `VoiceClient` and `resolveGatewayUrl` from `lib/websocket/voice-client.ts` (unchanged).
- Produces: a working bridge. Nothing later depends on its internals.

- [ ] **Step 1: Add JsSIP**

```bash
npm install jssip@^3.10.1
```

Version-matched to what SeloraX-dashboard already runs against this same SIP server, so it is a known-good pairing rather than a guess. This is the only dependency this plan adds.

- [ ] **Step 2: Write the SIP wrapper**

Create `lib/telephony/sip-bridge.ts` — a thin, framework-free wrapper over JsSIP that emits the same event names `bridgeReducer` consumes:

```ts
/**
 * JsSIP, wrapped so the page never touches it directly.
 *
 * Deliberately small: registration, one inbound call at a time, answer with a
 * caller-supplied MediaStream, terminate. Everything about *when* to do these
 * things lives in bridge-state.ts, which is testable; this file is the hands.
 */
import JsSIP from "jssip";

export interface SipBridgeHandlers {
  onRegistered(): void;
  onRegistrationFailed(message: string): void;
  onIncoming(info: { from: string | null; to: string | null }): void;
  onAnswered(remoteStream: MediaStream): void;
  onRemoteTrack(track: MediaStreamTrack): void;
  onEnded(): void;
}

export class SipBridge {
  // ...ua, session fields...

  async goOnline(creds: SipCredentials): Promise<void> {
    const socket = new JsSIP.WebSocketInterface(creds.wsUrl);
    this.ua = new JsSIP.UA({
      sockets: [socket],
      uri: creds.sipUri,
      password: creds.password,
      realm: creds.sipDomain,
      register: true,
      session_timers: false,
    });
    // 'registered' → onRegistered; 'registrationFailed' → onRegistrationFailed
    // 'newRTCSession' with originator 'remote' → onIncoming
    this.ua.start();
  }

  /**
   * Answer with our own audio. `mediaStream` makes JsSIP skip getUserMedia
   * entirely (jssip/lib/RTCSession.js:482) — this one option is the whole
   * reason this design works without touching the SIP server.
   */
  answer(mediaStream: MediaStream): void {
    this.session?.answer({
      mediaStream,
      mediaConstraints: { audio: false, video: false },
      rtcAnswerConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false },
    });
  }

  // Collect the remote track from pc.getReceivers() on 'confirmed', and also
  // subscribe to pc 'track' for late arrivals — mirroring CallContext.js:776
  // and :809, which exist because of real "can't hear the customer" bugs.

  terminate(): void { /* session.terminate(), guarded against double-calls */ }
  async goOffline(): Promise<void> { /* terminate then ua.stop() */ }
}
```

Note `mediaConstraints: { audio: false, video: false }` alongside `mediaStream`: JsSIP strips tracks from the supplied stream when a constraint is `false` (`RTCSession.js:442`), so read that block before choosing the values, and confirm on the first call that the agent is actually audible.

- [ ] **Step 3: Wire the hook**

Create `hooks/useSoftphoneBridge.ts` holding a `useReducer(bridgeReducer, INITIAL_BRIDGE_STATE)` and refs for the `SipBridge`, `AudioCapture`, `StreamingAudioPlayer` and `VoiceClient`. The lifecycle, straight from the spec's table:

1. **Go online** → `dispatch({type:"go_online"})`, `sip.goOnline(creds)`.
2. **onIncoming** → `dispatch({type:"incoming", from, to})`; create the player, `await player.start("stream")`, then `sip.answer(player.outputStream!)`.
3. **onAnswered / onRemoteTrack** → `capture.start(remoteStream)` (or `capture.addTrack`), open the `VoiceClient`, `dispatch({type:"gateway_open"})`.
4. Gateway `audio` → `player.enqueue()`; `interrupted` → `player.clear()`; `transcript` → append for display; `agent_ending_call` → `dispatch({type:"agent_ending", reason})`.
5. Gateway close → `dispatch({type:"gateway_closed"})`, then wait `player.remainingPlayoutMs` (capped at 5000 ms) before `sip.terminate()`.
6. **onEnded** → close the client with `end`, stop capture and player, `dispatch({type:"call_ended"})`.

Because the React Compiler lint forbids `setState` in `useEffect`, drive all of this from event callbacks and refs, never from an effect that watches state.

- [ ] **Step 4: Build the page**

Read `node_modules/next/dist/docs/` for the current App Router page conventions first. Then:

- `app/(console)/telephony/page.tsx` — a server component that reads `telephonyStore` and renders the client panel, `export const dynamic = "force-dynamic"` like the other console pages.
- `components/telephony/CredentialsForm.tsx` — five fields, saving to `PUT /api/telephony`, showing per-field errors from the validator. The password field is `type="password"`.
- `components/telephony/BridgePanel.tsx` — a status line driven by `BridgeState.status`, a Go online / Go offline button, the caller's number while in a call, and the live transcript. Reuse the existing preview transcript and tool-activity components rather than writing new ones.

Add a **Telephony** item to the console sidebar next to Calls.

- [ ] **Step 5: The real test**

```bash
npm run typecheck && npm run lint && npm test 2>&1 | tail -5
npm run dev
```

Then, with a **dedicated** SIP extension provisioned for the AI (never one a human uses — see the spec's §4.1):

1. Paste the five credentials from the dashboard's `GET /api/calling/extension` response, save.
2. Click **Go online**; confirm the status reaches `online`.
3. Call the number from a phone.
4. Confirm: the agent greets you; you can hear it; it hears you; talking over it cuts it off mid-sentence; it answers a question; hanging up ends the call cleanly and the transcript is complete.
5. Ask it something abusive and confirm it hangs up — and that its closing sentence is **not** cut off, which is what `remainingPlayoutMs` exists for.

Record what actually happened, including anything that did not work.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json lib/telephony/sip-bridge.ts \
        hooks/useSoftphoneBridge.ts app/\(console\)/telephony components/telephony
git add -u
git commit -m "feat: answer real phone calls with the agent over the existing softphone"
```

---

### Task 6: Record phone calls alongside preview calls

**Files:**
- Modify: `lib/call-logs/types.ts`
- Modify: `server/voice/websocket-server.ts`
- Modify: `components/calls/CallsTable.tsx`
- Modify: `components/calls/CallDetail.tsx`
- Create: `lib/call-logs/channel.test.ts`

**Interfaces:**
- Produces: `CallRecord.channel: "browser" | "phone"` and `CallRecord.phone?: {from, to} | null`; `readCallChannel(value)` defaulting to `"browser"`.

- [ ] **Step 1: Write the failing test**

Create `lib/call-logs/channel.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { readCallChannel } from "./channel";

test("an absent channel defaults to browser, so old records stay valid", () => {
  // ~500 records were written before this field existed. None may be dropped.
  assert.equal(readCallChannel(undefined), "browser");
});

test("reads a known channel", () => {
  assert.equal(readCallChannel("phone"), "phone");
});

test("an unknown channel falls back rather than throwing", () => {
  assert.equal(readCallChannel("carrier-pigeon"), "browser");
});
```

- [ ] **Step 2: Run it to verify it fails, then implement**

Run: `npm test` → FAIL. Create `lib/call-logs/channel.ts` with `readCallChannel`, and add the two fields to `CallRecord` in `lib/call-logs/types.ts`, both optional so no existing record is invalidated.

- [ ] **Step 3: Stamp the record in the gateway**

In `server/voice/websocket-server.ts`, read `channel`, `from` and `to` from the upgrade request's query string, defaulting `channel` to `"browser"`, and carry them on `CallState` through to `recordCall`. The preview passes nothing and is unaffected.

Have the bridge's `VoiceClient` append `?channel=phone&from=…&to=…` to `resolveGatewayUrl()`.

- [ ] **Step 4: Show it**

Add a channel indicator to `CallsTable.tsx` (a small "Phone"/"Preview" tag near **When**, not a new column — the table was rebuilt to fit and must keep fitting) and the caller's number to `CallDetail.tsx`'s header.

- [ ] **Step 5: Verify and commit**

```bash
npm run typecheck && npm run lint && npm test 2>&1 | tail -5
```

Confirm an existing call still renders on `/calls` and `/calls/[id]`, then commit.

---

### Task 7: API keys on the gateway

Closes the standing hole — the gateway currently accepts any connection and will open a billed Gemini session for it — and makes it the general-purpose service surface the product wants.

**Files:**
- Create: `server/config/api-key-store.ts`
- Create: `server/config/api-key-store.test.ts`
- Modify: `server/voice/websocket-server.ts`
- Create: `app/api/api-keys/route.ts`
- Create: `app/(console)/settings/keys/page.tsx` and its client component
- Modify: `.env.example`

**Interfaces:**
- Produces: `createApiKeyStore(dir, log?)` with `mint(name)`, `list()`, `verify(presented)`, `revoke(id)`. `mint` returns the plaintext exactly once.

- [ ] **Step 1: Write the failing test**

Create `server/config/api-key-store.test.ts` covering:

- a minted key verifies, and its plaintext is returned only from `mint`
- `list()` never returns a plaintext key or a full hash
- a revoked key fails `verify`
- an unknown key fails `verify`
- a corrupt file reads as "no keys" and never logs its contents
- concurrent `mint` calls all survive (the same lost-write bug the secrets store had)
- comparison uses `crypto.timingSafeEqual` on equal-length buffers

- [ ] **Step 2: Implement the store**

SHA-256 hashes, `crypto.randomBytes(32).toString("base64url")` for the key, the same atomic-write-plus-queue pattern as every other store here.

- [ ] **Step 3: Enforce on the upgrade**

In `server/voice/websocket-server.ts`, check the key during the HTTP upgrade — **before** any Gemini session is opened, so an unauthenticated client cannot cost anything. Accept either an `Authorization: Bearer` header or a `key` query parameter, because browser `WebSocket` clients cannot set headers.

Gate the whole check behind `VOICE_GATEWAY_REQUIRE_KEY=1`, defaulting **off**, so `npm run dev` and the preview keep working and this task cannot break Task 5. Document the variable in `.env.example`.

- [ ] **Step 4: Minting UI**

A settings page listing keys with name, created date, last used and a revoke button, plus a mint form that shows the new key once with a copy button and an explicit "this is the only time you will see it".

- [ ] **Step 5: Verify and commit**

Run the suite, then check by hand: with `VOICE_GATEWAY_REQUIRE_KEY=1`, a connection with no key is rejected at the upgrade and the preview with a valid key still works.

---

## Done

After Task 7: `npm run build` once, confirm `/telephony`, `/calls`, `/calls/[id]` and the settings page are all in the route list, then use `superpowers:finishing-a-development-branch`.

The milestone that matters is **Task 5** — that is the first real phone call answered by the agent. Tasks 6 and 7 are independent of each other and of that call, so if Task 5 surfaces something unexpected, stop and report rather than pressing on.
