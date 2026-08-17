# AI Softphone Bridge — Design

**Goal:** let the Gemini Live agent hold a real phone conversation on a Selorax
number, by putting the agent where a human agent already sits — behind the
existing WebRTC softphone — with **no changes to `selx-sip`, SeloraX-Backend,
or the dashboard**.

**Supersedes:** `2026-08-16-telephony-bridge-design.md` as the *first* thing we
build. That document is not wrong; it describes the production media path
(Asterisk `externalMedia` → websocket) and stays on the roadmap. This one gets
a working AI phone call weeks earlier and proves the same gateway contract.

---

## 1. Why this changed

The earlier design assumed we had to build a media path because none existed.
That was true of `selx-sip`. It was not true of the browser.

Three facts, each verified in the code rather than assumed:

1. **The softphone's WebSocket carries SIP signalling only** — INVITE, 200 OK,
   BYE. Audio never touches it; it flows over WebRTC as encrypted RTP. So
   there is nothing to tap on that socket. This corrects the natural
   assumption that the existing socket already carries voice.

2. **JsSIP will take our audio instead of a microphone.**
   `SeloraX-dashboard/node_modules/jssip/lib/RTCSession.js:482` returns a
   caller-supplied `mediaStream` and never calls `getUserMedia`. Both of the
   dashboard's `answer()` sites (`contexts/CallContext.js:1294`, `:1493`) pass
   `mediaConstraints` today; passing a stream instead is the entire hook.

3. **The browser hands us the caller's audio as a live track.**
   `contexts/CallContext.js:776` already collects it from
   `pc.getReceivers()` and points it at a speaker element.

Swap the speakers for the gateway, swap the microphone for Gemini, and the
bridge is done.

**The two hard problems from the previous design disappear**, which is the
real reason to do this first rather than merely the cheap one:

- **Pacing.** `lib/audio/audio-player.ts:100` already schedules PCM on Web
  Audio's own clock via `nextStartTime`, and WebRTC consumes the resulting
  track in real time. No ticker, no jitter buffer, no drift correction.
- **Barge-in.** `StreamingAudioPlayer.clear()` (`audio-player.ts:131`) already
  flushes queued audio and is already wired to Gemini's interrupt signal.

Both were artefacts of hand-rolling a media path. Both are solved problems
inside a browser, and both are already solved *in this repo*.

---

## 2. Architecture

```
caller ── PSTN ── Asterisk ── WebRTC/SRTP ──┐
                                            │
                            ┌───────────────▼────────────────┐
                            │   bridge page (voice-ai)       │
                            │                                │
                            │  remote track → AudioCapture ──┼──► PCM16 16k
                            │  MediaStreamDest ← Player   ◄──┼──── PCM16 24k
                            └───────────────┬────────────────┘
                                            │ existing gateway protocol
                                            ▼
                              voice gateway ──► Gemini Live
```

The bridge is a page in **this** repo, not in the dashboard. `CallContext.js`
is 2541 lines carrying every human call Selorax places — device claim,
eviction, ICE recovery, transfers, autoplay fallbacks. Adding an AI mode to it
risks the human dialer to save duplicating perhaps 300 lines of registration.
Keeping the AI in the AI repo also means this milestone touches exactly one
codebase.

---

## 3. Scope

**In:**

- A bridge page that registers one SIP extension, answers inbound calls, and
  bridges audio to the existing gateway.
- Audio plumbing: capture from any `MediaStream`, play into a `MediaStream`.
- Phone calls appearing in the existing Calls list with transcript, summary
  and cost, as browser previews already do.
- API-key authentication on the gateway, which currently accepts anyone.

**Out:**

- Any change to `selx-sip`, SeloraX-Backend, or SeloraX-dashboard.
- Outbound / campaign calls. The bridge can place calls with the same code;
  nothing here forecloses it, but the MVP question is "can the AI hold a
  conversation", and inbound answers it with less wiring.
- Multi-tenant agents. One agent config, as today. The gateway change that
  makes agents selectable is in the superseded spec and is not needed to
  prove this.
- Tools during phone calls. `toolDeclarations([], {canEndCall: true})` — the
  agent can hang up, which is already built and tested, but calls no HTTP
  tools.
- Automatic credential provisioning (§4.2).

---

## 4. Operating model

### 4.1 A dedicated extension

The AI gets its **own** Selorax admin user and extension, created through the
existing dashboard flow (`settings/calling` → `ExtensionsCard`). This is not
optional bookkeeping: `claimCallingDevice` evicts whichever device registered
an extension last, so an AI sharing a human's extension means the two evict
each other on every call. A dedicated extension also makes call attribution
and cost per agent fall out for free.

Inbound calls reach it because Asterisk rings registered extensions — the same
reason a browser tab rings today. No routing change.

### 4.2 Credentials, for now

The bridge needs `{ws_url, sip_uri, sip_domain, extension, password}`. The
dashboard already receives exactly this object in plaintext from
`GET /api/calling/extension` (`routers/calling.js:335`), so for the MVP an
operator reads it from that response and pastes it into the bridge page once.

This is deliberately manual. Automating it means either an authenticated
cross-service call or a password-reveal UI, both of which are real work and
neither of which teaches us anything about whether the AI can hold a
conversation. Phase 2 automates it.

Credentials persist in `data/telephony.json` — already git-ignored, same
pattern as the agent config. The SIP password is stored as written and
returned to the bridge page, because SIP digest auth needs it; this matches
what the dashboard already does with the same secret.

### 4.3 Runtime

For a demo, an operator's browser tab. For anything continuous, headless
Chrome on a server (`--autoplay-policy=no-user-gesture-required`). Roughly one
tab per concurrent call — a renderer, a WebRTC stack, two AudioContexts. Fine
at 1–10 concurrent calls; the superseded spec's `externalMedia` path is what
replaces it when that stops paying.

---

## 5. Audio pipeline

### 5.1 Caller → agent

```
remote MediaStreamTrack
  → AudioContext(16000).createMediaStreamSource
  → recorder AudioWorklet          (exists)
  → Int16Array @16 kHz             (exists)
  → VoiceClient.sendAudio          (exists, unchanged)
```

Only the first step is new. `MicrophoneCapture` (`lib/audio/microphone.ts`)
already does everything from `createMediaStreamSource` onward; it just calls
`getUserMedia` itself. Splitting the source acquisition from the pipeline
turns it into `AudioCapture`, which takes any `MediaStream`.
`MicrophoneCapture` becomes a thin wrapper so the preview is untouched.

The browser resamples the 48 kHz WebRTC track into the 16 kHz context. No
resampling code is written.

**Echo cancellation does not apply and is not needed.** There is no acoustic
path — nothing is played to a speaker and re-heard by a microphone. A caller's
own voice reflected back by the network would be heard by the model, so this
is worth listening for on the first call, but it is a network property, not
something the bridge can cause.

### 5.2 Agent → caller

```
gateway "audio" event (PCM16 @24 kHz)
  → StreamingAudioPlayer            (exists)
  → MediaStreamAudioDestinationNode (new — instead of context.destination)
  → .stream
  → session.answer({ mediaStream })
```

`StreamingAudioPlayer.start()` gains an output mode. In `"stream"` mode it
connects the analyser to a `MediaStreamAudioDestinationNode` rather than
`context.destination`, and exposes `outputStream`. Everything else — the
scheduler, `clear()`, the analyser used for the waveform — is unchanged, so
the preview and the phone call share one code path and one set of bugs.

An idle destination node emits digital silence, which WebRTC encodes without
complaint. There is no "hole in the stream" failure mode that raw RTP has.

### 5.3 Interruption

The gateway already sends `interrupted` (`websocket-server.ts:304`) when
Gemini detects the caller talking over the agent. The bridge calls
`player.clear()`, exactly as the preview does. Queued audio stops reaching the
destination node within one scheduling quantum.

---

## 6. Call lifecycle

| Event | Bridge does |
|---|---|
| Operator clicks **Go online** | Register via JsSIP with the stored credentials |
| Inbound INVITE | Open the gateway websocket, start capture and player, `session.answer({mediaStream})` |
| Gateway `session_started` | Nothing — the agent's greeting plays itself |
| Gateway `audio` | `player.enqueue()` |
| Gateway `interrupted` | `player.clear()` |
| Remote track arrives | Feed it to `AudioCapture` (listen for late tracks too, per `CallContext.js:809`) |
| Gateway `agent_ending_call` | Note the reason; wait for the socket close |
| Gateway socket closes | Drain playout (capped at 5 s), then `session.terminate()` |
| Caller hangs up (`ended`/`failed`) | Close the gateway socket with `end`, stop capture and player |
| Operator clicks **Go offline** | Terminate any live call, unregister |

**Draining before hanging up matters.** The gateway closes 2 seconds after
Gemini finishes *generating* (`HANGUP_GRACE_MS`, `websocket-server.ts:317`),
but the player schedules ahead, so audio can still be queued when the socket
closes. Hanging up SIP immediately cuts the agent off mid-goodbye. The player
gains a `remainingPlayoutMs` getter so the bridge can wait it out.

---

## 7. Gateway changes

The wire protocol is **unchanged**. The bridge is a browser, so it reuses
`lib/websocket/voice-client.ts` as-is: JSON frames, base64 PCM, 16 kHz in,
24 kHz out. The binary-framing and per-call `start` metadata in the superseded
spec exist for a non-browser client and are not needed here.

Two additions:

**7.1 Call metadata.** The gateway accepts `channel`, `from` and `to` as query
parameters on the websocket URL and stamps them onto the record. `channel`
defaults to `"browser"`, so the preview is unaffected and old records stay
valid.

**7.2 API keys.** `data/api-keys.json` holds `{id, name, hash, createdAt,
lastUsedAt, revokedAt}`; keys are minted in a Settings screen, shown once, and
stored only as a SHA-256 hash compared in constant time. The gateway checks
`Authorization: Bearer` — or, because browser WebSocket clients cannot set
headers, a `key` query parameter — during the HTTP upgrade, before any Gemini
session is opened, so an unauthenticated client cannot cost anything.

Enforcement is opt-in via `VOICE_GATEWAY_REQUIRE_KEY=1`, defaulting off, so a
developer running `npm run dev` is not blocked and the milestone cannot break
the preview. Production sets it.

This is what makes the gateway the general-purpose service surface the product
wants — any client, not just this one, can hold a conversation over a
documented, authenticated socket.

---

## 8. Call records

`CallRecord` gains:

```ts
channel: "browser" | "phone";   // defaults to "browser" when absent
phone?: { from: string | null; to: string | null } | null;
```

Absent fields default rather than fail, matching how `validateAgentConfig`
already handles new fields — 500 existing records must not be invalidated by
a schema addition.

The Calls list gains a channel indicator and the detail page shows the numbers.
Transcript, summary, cost and event timeline all work already and need no
change, which is the point of reusing the gateway.

---

## 9. Failure modes

| Failure | Behaviour |
|---|---|
| Gateway unreachable when a call arrives | Do not answer. Asterisk falls through to its normal no-answer handling. Answering into silence is worse than not answering. |
| Gateway dies mid-call | Drain, terminate SIP, mark the record `endedBy: "error"`. |
| SIP registration lost | Surface it on the page and stop accepting calls; JsSIP retries on its own. |
| Caller hangs up mid-sentence | `ended` fires; close the socket, write the record. Normal path. |
| Tab closed mid-call | The call drops. Named as a real limitation of the browser runtime, not designed around. |
| Two bridges on one extension | Undefined at the Asterisk level. Prevented by operator discipline: one dedicated extension. |
| Autoplay policy blocks the AudioContext | In `"stream"` mode nothing is played to a speaker, so the policy does not apply. Documented because it is the obvious worry. |

---

## 10. Testing

The bridge itself is browser-only — JsSIP, `AudioContext`, `RTCPeerConnection`
— and the repo's test runner is `node:test` via `tsx` over `lib/**` and
`server/**`. So the split is deliberate:

- **Unit-testable, and tested:** credential validation and persistence, the
  API-key store (hashing, timing-safe comparison, revocation), gateway
  upgrade acceptance and rejection, call-record defaulting for `channel`, and
  the bridge's own state machine — written as a pure reducer over events
  (`registered`, `incoming`, `answered`, `gateway_closed`, `ended`) with no
  browser objects in it.
- **Verified by hand, once, on a real call:** audio actually flowing both
  ways, barge-in interrupting the agent, the goodbye not being cut off.

Keeping the state machine pure is what makes the difference between a bridge
with two testable seams and one with none.

---

## 11. Risks

- **New dependency: `jssip`.** This repo has added no dependency so far. A SIP
  stack is not something to write, and JsSIP is the one the dashboard already
  runs against this exact server, so it is the known-good choice. Flagged
  because it is a real departure from how this codebase has been built.
- **Browser as a telephony runtime.** Tab crashes, network changes and ICE
  failures are all real. Acceptable for an MVP whose purpose is to answer a
  question; not acceptable as the permanent architecture, which is why the
  superseded spec stays on the roadmap.
- **Added latency** of perhaps 50–150 ms from the extra Opus→PCM→Opus hops.
  Worth measuring on the first call; the agent already reports time-to-first-
  audio.
- **Registration conflicts** if the dedicated-extension rule is not followed.
- **Cost.** Every answered call is a live Gemini session. There is no
  concurrency cap in this milestone — with one bridge tab there is at most one
  call, which is its own cap. Revisit before running several.

---

## 12. Milestones

1. **Audio plumbing.** `AudioCapture` from any stream; player output to a
   `MediaStream`; `remainingPlayoutMs`. Preview keeps working unchanged.
2. **The bridge.** Credentials, SIP registration, answer with our stream, the
   page. → **A real inbound call answered by the AI.** This is the milestone
   the whole spec exists for.
3. **Records.** `channel`/`phone` on `CallRecord`, gateway query parameters,
   Calls list and detail.
4. **API keys.** Minting UI, hashed store, opt-in gateway enforcement.

1 is a prerequisite for 2. 3 and 4 are independent of each other and of the
first real call.
