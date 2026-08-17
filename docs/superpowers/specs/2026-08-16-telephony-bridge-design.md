# Telephony Bridge — Design

**Goal:** let a Gemini Live agent answer real inbound phone calls on a Selorax
store's number, by streaming call audio between Asterisk (inside `selx-sip`)
and the existing voice gateway over one authenticated websocket per call.

**Status:** design, approved in direction. Not yet planned or implemented.

---

## 1. Scope

**In:**

- Inbound calls only. A call to an AI-enabled number is answered by the agent.
- One agent configuration per Selorax store.
- Conversation only — no HTTP or client tools during a phone call. The agent
  can still hang up (`end_call`), which is a call-control mechanism, not a
  business tool.
- API-key authentication on the voice gateway, which currently has none.
- A dashboard setting to hold that key and enable the AI for a number.

**Out, deliberately:**

- Outbound / campaign calls. The transport designed here carries them
  unchanged when we want them; only origination and slot wiring are missing.
- Tools on calls. The tool runner stays in the codebase and keeps working for
  the browser preview; phone calls simply declare no tools.
- Per-number agents. One agent per store; a number→agent map is additive
  later and changes no interface defined here.
- Replacing the existing IVR workflow engine. A number is either AI-answered
  or workflow-answered.

**Division of labour:** the `selx-sip` side (§5) is built by the Selorax team
against the contract in §4. Everything in §6 and §7 is built in these repos.
`selx-sip`'s source is not available here, which is precisely why the contract
is specified before anything is written.

---

## 2. What exists today

Established by reading the code, not assumed:

- `selx-sip` is **Asterisk + ARI**, Python/FastAPI, realtime PJSIP in Postgres
  (`SeloraX-Backend/docs/api/selx-sip-migration-analysis.md`). SeloraX-Backend
  is a *Partner* of it: `X-Api-Key` for provisioning, per-store
  `Bearer` + `X-User-Id` for tenant actions.
- Humans talk over **JsSIP + WebRTC**; `GET /api/calling/extension` hands the
  browser `{ws_url, sip_uri, sip_domain, extension, password, iceServers}`.
- Robots run **IVR workflows** — a node graph of `play`/`prompt`/`forward`
  with TTS `say` text and DTMF branches.
- **There is no bidirectional media path anywhere.** The workflow engine can
  speak and read digits; it cannot stream audio. This is the entire reason
  this document exists.
- The voice gateway (`server/index.ts`) accepts **any** connection. There is
  no authentication of any kind today.
- The gateway serves **one global agent**: `loadResolvedAgentConfig()` reads a
  single `data/agent-config.json`.

---

## 3. Architecture

```
PSTN caller
    │  SIP / RTP, G.711 8 kHz
    ▼
Asterisk ──────── ARI ────────► selx-sip (FastAPI)
    │                                │
    │  externalMedia                 │ decides: AI or workflow?
    │  slin16, RTP over loopback     │
    ▼                                ▼
 media relay  (new — selx-sip, Python asyncio)
    │
    │  WSS, one connection per call, Bearer auth
    ▼
voice gateway (Node, this repo)
    │
    ▼
Gemini Live
```

**Why the relay sits inside `selx-sip`.** Asterisk's `externalMedia` speaks
RTP/UDP or AudioSocket/TCP — never websockets. Terminating RTP on loopback
beside Asterisk and opening one *outbound* WSS per call means the only public
seam is authenticated, TLS-protected, and needs no inbound UDP range opened
in a firewall. It also keeps Asterisk's timing behaviour on `selx-sip`'s side
of the boundary, where it can be fixed without touching this repo.

**Why `slin16`.** Signed linear 16-bit at 16 kHz is byte-identical to Gemini's
input format, so caller→AI is a straight copy and Asterisk absorbs the
8 kHz→16 kHz transcode from the PSTN leg. Only one direction needs resampling
(Gemini emits 24 kHz), and it happens in the gateway, in TypeScript we own.

---

## 4. The contract

This section is normative. It is what `selx-sip` implements against.

### 4.1 Connection

The relay opens **one websocket per call**, outbound, to:

```
wss://<gateway-host>/telephony
Authorization: Bearer <api-key>
```

- TLS is required. The bearer token is the sole credential and identifies the
  tenant (§4.5).
- The gateway accepts or rejects during the HTTP upgrade. A rejection is a
  normal HTTP status — `401` for a bad or revoked key, `429` when the key is
  being brute-forced, `503` when the gateway is shutting down. No websocket is
  established, so the relay must handle a failed upgrade, not just a closed
  socket.
- No credential is sent per frame. The connection is stateful and TLS-bound;
  per-frame HMAC would cost a signature 50 times a second per call and buy
  nothing that TLS plus a connection-scoped bearer does not already give.
  (This departs from `selx-sip`'s webhook signing, which exists because
  webhooks are stateless posts to a third party — a different threat model.)

### 4.2 Frames

Audio is **binary** frames. Control is **UTF-8 JSON text** frames. A binary
frame is never JSON and a text frame is never audio; the gateway dispatches on
the websocket frame type alone.

Audio is carried raw, not base64 in JSON. At 50 frames/second/call, base64
costs ~33% bandwidth and a JSON parse per frame — acceptable for one browser
tab, wrong for concurrent phone calls.

**Every audio frame, both directions:**

| Field | Value |
|---|---|
| Encoding | signed linear PCM, 16-bit, little-endian |
| Sample rate | 16 000 Hz |
| Channels | 1 |
| Frame duration | 20 ms |
| Frame size | 320 samples = **640 bytes** |

A binary frame that is not exactly 640 bytes is a protocol error: the gateway
logs it, drops that frame, and keeps the call up. It does not attempt to
re-frame a stream that has lost alignment.

### 4.3 Relay → gateway

**`start`** — MUST be the first frame, sent before any audio. The gateway
holds the call until it arrives, and closes with `4400` if the first frame is
binary or if `start` does not arrive within 5 seconds.

```json
{
  "type": "start",
  "call_id": "call_9949889e8b7688e8a763a60a",
  "direction": "inbound",
  "from": "+8801700000000",
  "to": "+8809600000000",
  "extension": "ext-8",
  "variables": { "store_name": "Zenith" }
}
```

- `call_id` is `selx-sip`'s own call id, so a record here can be joined to a
  record there. Required.
- `direction` is `"inbound"` for now; the field exists so outbound needs no
  protocol change.
- `variables` is optional and feeds the agent's existing `{variable}`
  substitution. `from` and `to` are injected as variables automatically, so a
  prompt can say "the caller is calling from {from}" with no extra wiring.
- No agent id. The bearer key selects the agent (§4.5) — a field the client
  could set is a field the client could set *wrongly*, and tenant selection is
  not something to take on trust from the network.

**`dtmf`** — optional, if the caller presses a key.

```json
{ "type": "dtmf", "digit": "3" }
```

The gateway forwards it to the model as text. Sending these is optional; an
agent that never mentions keypads will ignore them.

**Binary** — caller audio, 640 bytes, paced at real time.

### 4.4 Gateway → relay

**Binary** — agent audio, 640 bytes. The gateway sends these as Gemini
produces them, which is *faster than real time*; pacing is the relay's job
(§8.1).

**`clear`** — the caller interrupted. The relay MUST immediately discard every
queued frame not yet handed to Asterisk.

```json
{ "type": "clear" }
```

**`hangup`** — the agent ended the call.

```json
{ "type": "hangup", "reason": "caller was abusive" }
```

The relay SHOULD let its queue drain first so the agent's closing sentence is
actually heard, then hang up the channel via ARI, capped at 3 seconds. `reason`
is for logging; never speak it to the caller.

**`error`** — something failed on the gateway side.

```json
{ "type": "error", "code": "model_unavailable", "fatal": true }
```

A `fatal` error is followed by a close. The relay should fall back (§9).

### 4.5 Keys and tenancy

One API key maps to exactly one Selorax store, and therefore to exactly one
agent configuration. The key *is* the tenant selector. Consequences:

- The gateway never trusts a store or agent identifier off the wire.
- Rotating a store's key cannot affect another store.
- A leaked key exposes one store's agent, not the fleet.

Keys are generated in the voice-ai console, shown once, and stored only as a
SHA-256 hash. Comparison is timing-safe. Revocation is immediate: revoked keys
fail the upgrade, and any call already running on a revoked key is left to
finish rather than cut off mid-sentence.

### 4.6 Close codes

| Code | Meaning | Sent by |
|---|---|---|
| `1000` | Call ended normally (caller hung up) | relay |
| `1001` | Gateway shutting down | gateway |
| `4400` | Protocol violation — no `start`, malformed `start` | gateway |
| `4401` | Key revoked mid-call | gateway |
| `4429` | Tenant is over its concurrent-call limit | gateway |
| `4500` | Model or gateway failure | gateway |

---

## 5. What `selx-sip` implements

Specified as behaviour, since the source is not available here.

**5.1 An inbound AI slot.** Alongside the existing per-tenant `inbound`
workflow slot, a tenant can configure an AI answerer:

```
PUT /v1/ai-agent   { enabled, gateway_url, api_key }
GET /v1/ai-agent
DELETE /v1/ai-agent
```

Tenant-authenticated like the other `/v1` endpoints. `api_key` is
write-only — `GET` returns a masked hint (last 4 characters), never the value.
This mirrors the existing workflow-slot model, so it should be a small
addition rather than a new concept.

**5.2 Routing.** When an inbound call arrives for a tenant whose AI slot is
enabled, route to the media bridge instead of the inbound workflow. If the AI
slot is disabled or the bridge cannot be established, fall through to the
existing inbound workflow — an AI outage must degrade to today's behaviour,
not to a dead line.

**5.3 The bridge.** Per call: answer the channel, create an `externalMedia`
channel with `format=slin16` on loopback, put both in a mixing bridge, and run
a relay task that pumps RTP↔WSS per §4. Requires **Asterisk 16.6+** for
`externalMedia`; confirm `slin16` is in the build.

**5.4 Pacing and barge-in** — §8.1 and §8.2. These are the hard parts and they
live here.

**5.5 Events.** Emit the existing webhook events (`answered`, `completed`,
`failed`) unchanged, so SeloraX-Backend's call bookkeeping keeps working with
no knowledge that a machine did the talking.

---

## 6. What changes in voice-ai

**6.1 Multi-tenant agents.** The single `data/agent-config.json` becomes
`data/agents/<agent-id>.json`, one file per agent, so two tenants saving at
once don't contend on one file. The existing config migrates to
`data/agents/default.json` on first read; nothing is lost and no store is
silently reset to seed defaults. Secrets become per-agent for the same
isolation reason.

The console grows an agent switcher and create/rename/delete. Every existing
tab (Conversation, Actions, Advanced, Models & Voice) is scoped to the
selected agent and otherwise unchanged.

This is the largest single piece of work here, and it is unavoidable: one
gateway serving many stores cannot serve one global agent.

**6.2 API keys.** `data/api-keys.json` — `{id, name, agentId, hash, createdAt,
lastUsedAt, revokedAt}`. A Settings screen mints, lists, and revokes them,
showing the plaintext exactly once. `lastUsedAt` is written best-effort and
never on the audio path.

**6.3 The telephony endpoint.** A second websocket path, `/telephony`,
alongside today's `/voice`. It shares the Gemini session machinery, the call
recorder, the summariser and the end-call policy; it differs only in
transport, authentication, and audio framing. The browser preview keeps
working exactly as it does now, unauthenticated on `/voice` in development.

**6.4 Resampling.** Gemini's 24 kHz output → 16 kHz, a clean 3:2 ratio. A
short FIR low-pass at ~7 kHz then decimate; naive sample-dropping aliases
audibly and telephone audio has no headroom to hide it.

**6.5 Call records.** `CallRecord` gains `agentId`, `channel`
(`"browser" | "phone"`), and for phone calls `callId`, `from`, `to`. The Calls
list gains a channel column and an agent filter.

**6.6 No tools on phone calls.** `toolDeclarations([], {canEndCall: true})` —
the agent can hang up on abuse, which was already built and tested, but
declares no HTTP or client tools.

---

## 7. What changes in Selorax

**7.1 Backend.** A new `store_ai_calling` row per store holding the voice-ai
key encrypted with the existing `utils/encryption.js` (same treatment as the
selx tenant token) plus an `enabled` flag. On save, push it to `selx-sip` via
§5.1. Endpoints follow the existing `routers/calling.js` conventions:
`GET/PUT /api/calling/ai-agent`, owner-only, rate-limited.

**7.2 Dashboard.** An "AI agent" card under Settings → Calling: paste the key,
toggle enabled, and see status. `settings/smartcomm/page.js` is the existing
pattern for a stored API key; `ExtensionsCard.js` is the pattern for the
status display.

**7.3 Keep the AI out of the human device claim.** `claimCallingDevice`
evicts whichever device last registered an extension. The AI answerer must not
participate in that bookkeeping, or the AI and a browser tab will evict each
other on every call.

---

## 8. Audio pipeline

### 8.1 Pacing

Gemini emits a sentence in a burst far faster than real time. RTP wants
exactly one 20 ms frame every 20 ms.

The relay holds a playout queue drained by a **monotonic ticker**, not by a
`sleep(20ms)` loop — sleeps drift, and drift at 50 Hz compounds into audible
pitch and sync error within a minute. When the queue is empty it emits a frame
of silence rather than stalling, because a gap in RTP is not silence to
Asterisk; it is a hole.

The queue is bounded (~2 s). If it overruns, drop the *oldest* audio and log
it: an agent 2 seconds behind is already broken, and dropping the newest would
make it permanently so.

Getting this wrong produces either chipmunk audio (no pacing) or an agent
running seconds behind the conversation (unbounded queue). Both are call-ending
defects, so this deserves a test with a synthetic burst source before it ever
meets a real call.

### 8.2 Barge-in

When the caller talks over the agent, Gemini signals that generated audio
should be discarded. The gateway already detects this — it counts
`interruptions` today. On detection it sends `clear`, and the relay drops
every queued frame in that instant.

Without this the agent keeps talking for as long as its queue is deep,
*after* being interrupted, which is the single most common way a voice agent
feels broken.

### 8.3 Latency budget

Roughly, one way: ~20 ms framing, ~20–60 ms network to the gateway, Gemini's
own response time, then the same back. Everything under our control should
stay well under 150 ms round trip excluding the model. The pacing queue is the
only place we can accidentally add seconds.

---

## 9. Failure modes

| Failure | Behaviour |
|---|---|
| Gateway unreachable at call time | `selx-sip` falls through to the inbound workflow. The caller hears the existing IVR, not silence. |
| Gateway dies mid-call | Relay sees the close, plays a short apology prompt, hangs up. The call record is written from `selx-sip`'s side; the gateway's own record is marked `endedBy: "error"`. |
| Gemini unavailable | Gateway sends `error` with `fatal: true`, closes `4500`; relay behaves as above. |
| Caller hangs up | Relay closes `1000`; gateway finalises the record and runs the summariser as it does today. |
| Key revoked mid-call | Call finishes; the *next* upgrade fails `401`. |
| Relay stops sending audio | Gateway's existing silence handling applies; no special case. |
| Both AI and workflow configured | AI wins; the workflow is the fallback path only. Documented so it is a decision, not a surprise. |

---

## 10. Testing without `selx-sip`

The gateway side must be buildable and verifiable before the relay exists.

A **loopback harness** — a small Node script standing in for the relay — that
connects to `/telephony` with a test key, sends `start`, streams a WAV file as
640-byte frames at 20 ms intervals, and writes what comes back to a second
WAV. That gives a real end-to-end check of authentication, framing,
resampling, barge-in and hangup with no telephony at all, and doubles as the
reference implementation the Selorax team can read while building §5.

Unit tests cover: upgrade rejection for missing, malformed, unknown and revoked
keys; a first frame that is binary; `start` timeout; a 639-byte frame; the
resampler against a known tone; and the agent-config store's migration from
the single-file layout.

---

## 11. Risks

- **Asterisk version and `slin16`.** Unverified — the source is not available
  here. If `externalMedia` or `slin16` is missing, the shape holds but format
  negotiation changes. Confirm before planning.
- **Pacing and barge-in** (§8.1, §8.2) are the only genuinely hard code in this
  design, and they live in the half we do not write. The loopback harness is
  the mitigation: it proves the gateway's half independently.
- **Multi-tenancy is bigger than it looks.** It touches the config store, the
  console shell, secrets, and call records. It is the critical path for
  everything else.
- **Concurrency and cost.** Each call is a live Gemini session billed per
  minute. A per-tenant concurrent-call cap (close code `4429`) is in the
  contract from the start, because discovering the need for one during an
  incident is expensive.

---

## 12. Milestones

Each produces something demonstrable.

1. **API keys + `/telephony` + loopback harness.** A WAV goes in, the agent's
   reply comes out. Proves auth, framing, resampling, barge-in, hangup.
2. **Multi-tenant agents.** Agent switcher in the console; the key selects the
   agent; call records carry it.
3. **Selorax settings.** Key stored encrypted, pushed to `selx-sip`, visible
   in the dashboard.
4. **First real call.** Requires §5 from the Selorax team.

1 and 2 are independent of `selx-sip` entirely and can start immediately.
