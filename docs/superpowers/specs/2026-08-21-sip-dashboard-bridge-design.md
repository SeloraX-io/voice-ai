# sip-dashboard Bridge — Design

**Goal:** let the AI place and answer real phone calls through **sip-dashboard**
(the LiveKit-based calling platform at `sipdashboard.selorax.io`), as a second,
independent calling provider alongside the existing Selorax bridge — with no
browser required for either direction.

**Builds on:** `2026-08-17-selorax-backed-bridge-design.md`, which is
implemented and shipped (inbound only). This is not a revision of that work —
it is a second provider with a different transport, added next to it. Nothing
about the Selorax bridge changes.

**Relationship to Selorax:** additive, not a replacement. Selorax stays exactly
as it is. An operator picks a provider per outbound call and can enable inbound
on one, both, or neither independently.

---

## 1. The constraint, stated once

Selorax's audio is SIP/WebRTC: JsSIP negotiates a `RTCPeerConnection` with
Asterisk, and that negotiation can only happen in a browser — JsSIP reads
`window` at module load. That is why the Selorax bridge is a browser page: the
browser isn't incidental there, it's the only place that leg of audio can
exist.

sip-dashboard has no SIP/WebRTC leg to bridge. Its AI-facing API
(`docs/README.md` in the `sip` repo, spec §7) is a single WebSocket per call
carrying raw PCM16 frames both directions, authenticated with a short-lived
bearer token minted per call. There is nothing in that path that requires a
browser, a `RTCPeerConnection`, or `window` — it is exactly the kind of socket
a Node process opens for itself every day.

So this bridge lives entirely in the voice gateway process. No new browser
page is required for it to function; the Telephony console page only adds a
trigger button and a settings form, neither of which sits in the call's audio
path.

---

## 2. Architecture

```
                         voice gateway process (server/index.ts)
                         ┌──────────────────────────────────────────────┐
existing, unchanged:     │  browser client ──ws:4000/voice──► websocket- │
                         │                                    server.ts  │
                         │                                       │       │
                         │                                       ▼       │
                         │                              GeminiVoiceSession│
                         └──────────────────────────────────────────────┘

new:                     ┌──────────────────────────────────────────────┐
                         │  outbound.ts ──placeCall()──┐                 │
                         │                              │                │
                         │  inbound-watcher.ts ◄─SSE─── sip-dashboard    │
                         │       │  (call.created, direction=inbound)    │
                         │       ▼                                      │
                         │  calling-client.ts ──media-token──► call-     │
                         │                                     bridge.ts │
                         │                                        │      │
                         │                                        ▼      │
                         │                              GeminiVoiceSession│
                         └──────────────────────────────────────────────┘
                                        │
                                        ▼
                    wss://sipmedia.selorax.io/v1/calls/{id}/media
                    (sip-dashboard's media-bridge — raw PCM16, both ways)
```

One sip-dashboard call = one `call-bridge.ts` instance = one
`GeminiVoiceSession`, same as one browser tab is one call today. The two paths
never share a session; they only share the `GeminiVoiceSession` class and the
agent config loader.

`channel: "phone"` (already defined in `lib/call-logs/channel.ts`, already
used by Selorax calls) is reused as-is — it governs tool availability
(`end_call`), not transport, so no new channel value is needed.

---

## 3. Config and credentials

```ts
// lib/sip-dashboard/config.ts
export interface SipDashboardConfig {
  baseUrl: string;        // e.g. https://sipdashboard.selorax.io, no trailing slash
  apiKey: string;         // an Extension's sipai_... key, server-only
  inboundEnabled: boolean; // off by default — see §6
}
```

Mirrors `lib/selorax/config.ts` field for field where the shape allows it:
`EMPTY_SIP_DASHBOARD_CONFIG`, `validateSipDashboardConfig`, and a
`toSipDashboardSummary` that reports `{ baseUrl, inboundEnabled, hasApiKey }`
— never the key itself, built field by field (not by spreading the config) so
a future field cannot silently reach the browser by being added, same
reasoning as `toSeloraxSummary`.

Unlike Selorax's `authToken`, `apiKey` does not expire (it's a static extension
key, not a 90-day JWT) — so there is no expiry-warning UI to build here. If the
key is ever revoked, calls fail with `unauthorized` and that failure is what
tells the operator, same as any other credential failure below.

**Storage:** one singleton document in a new `sip_dashboard_config` Mongo
collection, via `server/config/sip-dashboard-store.ts` — a direct copy of
`server/config/selorax-store.ts`'s read/write/validate-on-read shape,
including: a missing document reads as unconfigured, a document that fails
validation also reads as unconfigured and is left on disk, and a database
that cannot be reached throws rather than masquerading as "unconfigured."

**No new `.env` variables.** `MONGODB_URI` and `GEMINI_API_KEY` already cover
everything this needs to start. `baseUrl`, `apiKey`, and `inboundEnabled` are
all edited from the settings page and take effect without a redeploy, the same
rotation story the Selorax config was built for.

**Settings UI:** `components/settings/SipDashboardPanel.tsx` +
`app/(console)/settings/sip-dashboard/page.tsx`, mirroring the existing
Selorax settings screen — two text fields (Dashboard URL, Extension API key)
and one switch (Enable inbound answering). `app/api/sip-dashboard/route.ts`
(GET current summary / PUT to save) mirrors `app/api/selorax/route.ts`
exactly, including its "blank apiKey on PUT means keep the existing one, an
all-blank submission is a deliberate clear" rule.

---

## 4. The calling client

`server/sip-dashboard/calling-client.ts` — a server-only HTTP client for
sip-dashboard's AI-facing API, never imported into a client component (same
rule as `server/selorax/calling-client.ts`).

| Method | Calls | Purpose |
|---|---|---|
| `placeCall(to)` | `POST /api/v1/calls` | Outbound dial. Returns `{ callId }`. |
| `hangup(callId)` | `POST /api/v1/calls/{id}/hangup` | End a call this bridge started or joined. |
| `getMediaToken(callId)` | `POST /api/v1/calls/{id}/media-token` | Returns `{ wsUrl, token, participantId }`. |
| `listCalls()` | `GET /api/v1/calls` | Used once at inbound-watcher startup to seed "already seen" call ids, so a restart does not re-join calls it already bridged. |

Every request sends `Authorization: Bearer <apiKey>`. Errors map to a
`SipDashboardError` the same way `SeloraxError` does — a `code` an operator
can act on, never a raw status forwarded as-is:

| `code` | When | Message shown |
|---|---|---|
| `unauthorized` | 401 | "The sip-dashboard API key was rejected. Check the key in Settings." |
| `not_found` | 404 | "That call no longer exists on sip-dashboard." |
| `dial_failed` | 502/`dial_failed` body | Whatever `message` sip-dashboard returned — it's already operator-facing (see `lib/place-call.ts` in that repo). |
| `unreachable` | fetch `TypeError` | "Could not reach sip-dashboard." |
| `timeout` | `AbortSignal.timeout` fires | "sip-dashboard did not respond within 10 seconds." |
| `request_failed` | anything else non-OK | Generic fallback — this map is not a promise about every status sip-dashboard could ever return. |

No token or key ever appears in a thrown message or a log line — same rule as
`SeloraxError.underlying`, which logs only an error's `name`.

---

## 5. Outbound

**Correction, found while writing the implementation plan:** `call-bridge.ts`
must run in the voice gateway process — it holds a `GeminiVoiceSession` open
for the call's duration, and the README is explicit that this kind of
long-lived work must never run inside a Next.js Route Handler (the "do not
deploy the voice gateway as a serverless function" rule in this repo's own
README applies here too, self-hosted or not). But the Telephony page's Call
button is rendered by, and would naturally post to, the Next.js app — a
different process that does not share memory with the gateway. So the
trigger cannot be a normal Next.js API route calling into `call-bridge.ts`
in-process; it has to be a request to the gateway process itself.

The gateway's `http` server already exists for exactly one other route
(`GET /health` in `server/voice/websocket-server.ts`, on the same port the
browser's voice WebSocket upgrades on). This adds a second: `POST
/sip-dashboard/call` with body `{ "to": "..." }`, handled on that same `http`
server, guarded by the same key mechanism `authorizeUpgrade`/
`readPresentedKey` already enforce for the WebSocket upgrade when
`VOICE_GATEWAY_REQUIRE_KEY` is on. It calls `placeAndBridge(to)` (§7.1) and
returns `{ callId }` immediately — it does not wait for the call to end.

The console needs the gateway's plain HTTP origin to call this, which today
it only knows as a WebSocket URL (`NEXT_PUBLIC_VOICE_GATEWAY_URL`, e.g.
`wss://gateway.example.com/voice`). A small pure function derives one from
the other (swap `ws`→`http` / `wss`→`https`, drop the path) rather than
requiring a second public env var that could drift out of sync with the
first.

Selecting sip-dashboard on the Telephony page and clicking Call then does:

1. Browser → gateway: `POST {gatewayHttpOrigin}/sip-dashboard/call`
   `{ to }`.
2. Gateway: `placeCall(to)` → `callId`, `getMediaToken(callId)` →
   `{ wsUrl, token }`, hands both to `call-bridge.ts` (§7) as a
   fire-and-forget background task, responds `{ callId }` to the browser
   immediately.

No ringback-muting problem exists here the way it does for Selorax's deferred
outbound (§6A of the Selorax spec): sip-dashboard's media WebSocket only
becomes reachable once the platform has a room for the call, and the Gemini
session is only opened once `media.connected` arrives on that socket (§7,
step 2) — there is no window where ringback audio could reach the model,
because no audio flows at all until the bridge explicitly starts one.

---

## 6. Inbound

`server/sip-dashboard/inbound-watcher.ts`, started unconditionally from
`server/index.ts` next to `startVoiceGateway(...)` — but it only opens the SSE
connection when `SipDashboardConfig.inboundEnabled` is true. That flag is
re-read from Mongo on a fixed interval (30s) so toggling it in Settings takes
effect without restarting the gateway process, and so a fresh checkout with an
unconfigured or inbound-disabled provider does nothing on its own — mirroring
the existing "no setup, nothing billed" default posture this repo already
holds for the Gemini gateway itself.

**Correction, found while writing the implementation plan:** the design
originally called for subscribing to sip-dashboard's `GET /api/calls/stream`
(SSE) with the stored API key. That endpoint is gated by
`readSessionCookie()` — a dashboard login session — not by extension API
keys at all (`app/api/calls/stream/route.ts` in the `sip-dashboard` repo). A
headless process holding only an extension key gets a flat 401 from it; there
is no session to present. `GET /api/v1/calls` is the correct endpoint instead
— already extension-API-key-authenticated, already used for `listCalls()`
below — so inbound detection is **polling, not SSE**.

On enable: `listCalls()` once to seed a `Set<callId>` of calls already known.
Then, on a fixed interval (2s), call `listCalls()` again; for each returned
call with `direction: "inbound"` whose id is not in the seen set: add it to
the set, `getMediaToken(callId)`, hand off to `call-bridge.ts` — identical
handoff to the outbound path, because from that point on inbound and
outbound calls are indistinguishable to the bridge. `listCalls()` returns the
50 most recent calls for this extension, newest first, which safely bounds
one poll even if many calls have happened since the last tick.

**On disable:** stop the polling interval. Calls already bridged are left to
finish; disabling inbound stops new calls from being picked up, it does not
hang up calls in progress — same non-disruptive posture the Selorax spec
adopts for revoking a gateway key mid-call.

---

## 7. The audio bridge

**7.1 `placeAndBridge(to)`**, in `server/sip-dashboard/outbound.ts`: calls
`placeCall(to)` then `getMediaToken(callId)` then starts `call-bridge.ts`
(§7.2) for the result, without awaiting the bridge itself — the gateway's
`POST /sip-dashboard/call` handler (§5) awaits only up through the media
token and responds as soon as it has a `callId`. `inbound-watcher.ts` (§6)
calls `getMediaToken` + the bridge directly, skipping `placeCall` since the
call already exists.

**7.2 `call-bridge.ts`** is the one piece with no Selorax equivalent, because
Selorax's bridging is the browser's job today. Given `{ wsUrl, token }`:

1. Open a WebSocket to `wsUrl` with header `Authorization: Bearer <token>` —
   header, not query string, matching sip-dashboard's own stated reason
   (a token in a URL leaks into proxy and browser logs). This bridge has no
   browser logs to leak into, but there is no reason to be the one exception.
2. Wait for the `media.connected` JSON message. Only then:
   `GeminiVoiceSession.create(events, agentConfig, "phone")`, then
   `primeGreeting()`. Nothing is sent or opened before this message arrives —
   this is what keeps ringback and dead air out of the model (§5).
3. **Customer → AI.** sip-dashboard sends binary WS frames: PCM16 mono, 16 kHz,
   20 ms (640-byte) frames — `packages/call-protocol/src/audio.ts` in the
   `sip` repo. This is already Gemini's exact expected input
   (`audio/pcm;rate=16000`), so each frame is base64-encoded and handed
   straight to `session.sendAudio(base64)` with no resampling.
4. **AI → customer.** `GeminiSessionEvents.onAudio` delivers base64 PCM16 at
   24 kHz, Gemini's fixed output rate. sip-dashboard's protocol is fixed at
   16 kHz, 640-byte frames — two conversions the repo does not have today:
   - **Resample 24 kHz → 16 kHz.** A new pure function in `lib/audio/pcm.ts`
     (linear interpolation is sufficient for speech and is what the existing
     capture-side resampler already uses conceptually, per the README's "verified
     pitch-accurate" note — this is the same technique, opposite direction,
     server-side instead of in an AudioWorklet).
   - **Re-frame into fixed 640-byte chunks.** Gemini's chunk boundaries do not
     line up with the protocol's 20 ms frames. A small buffer accumulates
     resampled bytes and emits whole 640-byte frames as they become
     available, holding any partial remainder for the next chunk — mirroring
     `isWholeFrames`/`frameCount` from `packages/call-protocol/src/audio.ts`,
     which already encode "partial trailing frames are ignored" as the
     platform's own rule.
   Each finished frame is sent as one binary WS frame to sip-dashboard.
5. **Barge-in.** On `onInterrupted`, send `{"event":"media.clear"}` to
   sip-dashboard — the client-message the platform defines specifically to
   flush audio it has already been sent but not yet played into the live
   call (`packages/call-protocol/src/ws-messages.ts`). This is the same job
   the browser path's playback-queue flush does for a browser call; here the
   flush target is sip-dashboard's own buffer instead of a local
   `AudioContext`, because this bridge has no speakers of its own.
6. **Call end.** On sip-dashboard's `call.ended` message, or the WebSocket
   closing for any reason, close the Gemini session. On the Gemini session
   closing or erroring first, call `hangup(callId)` — a dead AI session must
   not leave the customer connected to silence, the same principle the
   Selorax design states for its own failure modes.

---

## 8. Failure modes

| Failure | Behaviour |
|---|---|
| sip-dashboard API key rejected (401) | Outbound: Call button shows "API key rejected — check Settings," no dial attempted. Inbound: the watcher logs it and keeps polling on schedule — a transient key issue should not need a gateway restart to recover from once fixed. |
| sip-dashboard unreachable | Outbound: shown as "Could not reach sip-dashboard." Inbound: a failed poll is logged and skipped; the next tick tries again, no crash. |
| Media WebSocket never reaches `media.connected` | Bridge times out after 10s, calls `hangup(callId)` (the call may already be ringing/answered on the PSTN side — hanging up is the safe default over leaving it connected to nothing), surfaces `error` to whatever triggered it. |
| Gemini session fails to open | Bridge calls `hangup(callId)` immediately — same reasoning as above, a customer must never be connected to a call with no agent on the other end. |
| Gemini session errors mid-call | Log it, `hangup(callId)`, close the media WebSocket. |
| media WebSocket drops mid-call | Close the Gemini session; do not attempt to reconnect the media socket — sip-dashboard's own call-ended semantics own that decision, and a stale reconnect could attach to a room that has already moved on. |
| Resampler receives a very short final chunk at call end | Buffered, not padded with silence and not dropped — held until either enough bytes exist to complete a frame or the call ends, at which point the remainder (guaranteed shorter than one frame) is discarded, matching the platform's own "partial trailing frames are ignored" rule. |
| Inbound event arrives for a call id already bridged (duplicate SSE delivery) | Ignored — the seen-set check in §6 is exactly this guard. |
| `inboundEnabled` flips off mid-call | The call in progress is left alone (§6); no new calls are picked up after. |

---

## 9. Testing

Same standard the Selorax work was held to:

- `lib/sip-dashboard/config.ts` — validator, `toSipDashboardSummary` never
  leaking `apiKey`, pure and fully unit-tested.
- `server/sip-dashboard/calling-client.ts` — header construction and the full
  error-code mapping table in §4, tested against a fake `fetch`, no network.
- The resampler and re-framer added to `lib/audio/pcm.ts` — pure functions,
  tested for: sample-rate accuracy (24k→16k ratio), correct 640-byte framing,
  and correct handling of a trailing partial frame at stream end.
- `server/sip-dashboard/call-bridge.ts` — tested against a stub WebSocket
  server standing in for sip-dashboard's media-bridge, asserting: frames sent
  in each direction, `media.clear` sent on `onInterrupted`, and `hangup`
  called on each failure mode in §8. Never a live sip-dashboard backend in
  tests, matching the Selorax spec's own "never a live backend" rule.
- `server/sip-dashboard/inbound-watcher.ts` — tested against a fake
  `listCalls()`: seen-set dedup across ticks, and the enable/disable
  transition.

**Verified by hand, once wired up:** a real outbound call from the Telephony
page, answered on a real phone, confirming both audio directions are
intelligible and barge-in actually interrupts the agent. Inbound is verified
the same way once `sip`'s carrier-side inbound routing issue (tracked
separately, outside this repo) is resolved — the watcher and bridge code can
be fully unit-tested before then, but an inbound call cannot reach this
system at all until that is fixed.

---

## 10. Risks

- **The resampler is new, untested-in-the-large code on the one path that has
  no existing analogue in this repo.** Mitigated by unit-testing it in
  isolation against known input/output sample pairs before it ever touches a
  real call, and by the fact that a bad resample is a quality problem (garbled
  audio), not a crash — the call still connects either way.
- **Inbound cannot be verified end-to-end today.** Both real numbers on
  `sip`'s platform currently receive zero inbound traffic from the carrier —
  a carrier-side issue, tracked and being escalated separately, unrelated to
  this bridge. The inbound watcher and bridge logic can and should still be
  built and unit-tested now; live verification waits on that fix.
- **Two independent "go do a phone call" paths (Selorax, sip-dashboard) is
  more surface than one.** Accepted deliberately per the "alongside" decision
  — Selorax stays untouched, so this risk is additive complexity, not
  regression risk to what already works.
- **`inboundEnabled` defaults off, but once on, the watcher is a persistent
  background process for the lifetime of the gateway.** A crash loop in the
  watcher must not take down call handling for browser or Selorax calls
  sharing the same process — the watcher's own errors are caught and retried
  internally (§6), never allowed to propagate to `server/index.ts`'s
  top-level handlers.

---

## 11. Milestones

1. **Config and client.** `lib/sip-dashboard/config.ts`,
   `server/config/sip-dashboard-store.ts`,
   `server/sip-dashboard/calling-client.ts`, settings route and panel.
   Testable without a browser or a live call.
2. **The resampler.** Additions to `lib/audio/pcm.ts`, unit-tested against
   known sample pairs before anything calls them from a real session.
3. **Outbound.** `call-bridge.ts`, `server/sip-dashboard/outbound.ts`, the
   Telephony page's provider selector. → **First real AI phone call placed
   through sip-dashboard, verified by hand.**
4. **Inbound.** `inbound-watcher.ts`, the `inboundEnabled` settings switch.
   Ships fully tested; live verification is blocked on the carrier-side fix
   in the `sip` repo and happens whenever that lands, not gating this
   milestone's completion in this repo.

1 gates 2 and 3. 3 gates 4 only in that `call-bridge.ts` is shared — 4 is
otherwise independent and can be built in parallel with 3 once 2 is done.
