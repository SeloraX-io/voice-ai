# AI Answers in the Dashboard — Design

**Goal:** when a customer calls and the SeloraX dashboard rings, the voice AI
answers and talks to them — using the softphone the dashboard already has, and
a pasted API key, with no second SIP registration anywhere.

**Supersedes** `2026-08-16-ai-softphone-bridge-design.md` and
`2026-08-17-selorax-backed-bridge-design.md` as the way this ships. Both remain
accurate about *how the audio works*; they put the softphone in the wrong
place.

**Repos:** `SeloraX-dashboard` and `SeloraX-Backend` (both under
`/Volumes/work/selorax`), plus a small addition to `voice-ai`.

---

## 1. Why this replaces the earlier design

The earlier bridge stood up its own JsSIP registration on a dedicated
extension, in a separate app. That was chosen to avoid modifying
`contexts/CallContext.js` — 2541 lines carrying every call SeloraX places.
Protecting that file was reasonable; making it the default was a misjudgement,
and it bought a second SIP registration, a dedicated extension, device-claim
contention, and a whole layer proxying Selorax credentials that the dashboard
already holds.

The dashboard already registers, already rings on inbound calls, already has
TURN, already knows the caller's number, and already reports the call for
correlation. The AI does not need any of that rebuilt. It needs to supply the
audio instead of a microphone.

**What survives from the earlier work:** the voice gateway and its API-key
authentication (which is exactly the integration surface wanted here), the
audio pipeline (`AudioCapture`, `StreamingAudioPlayer` with `MediaStream`
output), the `VoiceClient`, and the bridge state machine. **What is dropped:**
the standalone bridge page, the dedicated extension, and the Selorax
line-proxying layer.

---

## 2. Architecture

```
customer ── PSTN ── Asterisk ──┐
                               │ SIP INVITE to the agent's own extension
                               ▼
              SeloraX dashboard tab (already registered)
                 │                              ▲
   remote track ─┘                              └─ MediaStream as "microphone"
                 │                              ▲
                 ▼   wss://voice-ai/voice?key=  │
                        voice gateway ──► Gemini Live
```

One SIP registration: the agent's, which already exists. One websocket per
call, opened by the dashboard, authenticated with a pasted key.

**The microphone is never opened in AI mode.** No `getUserMedia`, no permission
prompt, no recording indicator. The agent's machine carries the call without
listening to the room it is in.

---

## 3. Integration points

Three places in `contexts/CallContext.js`, all verified:

**3.1 `holdIncomingSession` (`:1509`)** — where a genuine external inbound call
arrives. It already extracts the caller's number from
`session.remote_identity.uri.user`, sets `callState: 'incoming'`, and holds the
session ringing. When AI answering is on, it calls the answer path immediately
instead of waiting for a human click.

**3.2 `answerHeldSession` (`:1493`)** — today:

```js
session.answer({
    mediaConstraints: AUDIO_CONSTRAINTS,   // opens the microphone
    pcConfig: pcConfigRef.current,         // already carries TURN
    rtcAnswerConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false },
    extraHeaders: …,
});
```

In AI mode it passes `mediaStream` instead of `mediaConstraints`. JsSIP then
returns the supplied stream and never calls `getUserMedia`
(`RTCSession.js:482`). `mediaConstraints` must be `{audio: true, video: false}`
if passed at all — **`audio: false` deletes the audio track from the supplied
stream** (`RTCSession.js:442-446`), which would send silence with no error
anywhere.

**3.3 `attachStream` (`:776`)** — already collects the caller's audio from
`pc.getReceivers()` into a `remoteStream`. That stream feeds the gateway.
Keep the existing `track` listener (`:809`) for late-arriving tracks; it exists
because of real "agent can't hear the customer" incidents.

Nothing else in the file changes. `pcConfig`, the device claim, transfers,
recording, DTMF, and `reportInboundAnswered` all keep working because the
session is the same session.

---

## 4. What the agent sees

AI mode does **not** hide the call. The panel shows it as a live call marked
*AI answering*, with the transcript streaming in, and two controls:

- **Take over** — swap the AI's track for the microphone via
  `RTCRtpSender.replaceTrack()`, which changes the audio source without
  renegotiating SIP. The call continues uninterrupted, the gateway session
  closes, and the human is simply on the line. This is the feature that makes
  AI answering safe to switch on: it is one click to escalate.
- **Hang up** — the existing control, unchanged.

The alternative — the panel staying idle while calls route past — is not
proposed. It gives the agent no way to intervene and no idea what the AI said
on their line.

---

## 5. SeloraX-Backend changes

Small, and following patterns already in the file.

**5.1 Schema.** A migration adding to `store_calling_config`, mirroring
`2026-06-20-ai-call-coaching.sql` for the flags and
`2026-07-22-selx-sip-provisioning.sql` for the secret:

```sql
ALTER TABLE store_calling_config
    ADD COLUMN voice_ai_enabled     TINYINT(1) NOT NULL DEFAULT 0,
    ADD COLUMN voice_ai_gateway_url VARCHAR(255) NULL,
    ADD COLUMN encrypted_voice_ai_key TEXT NULL;
```

Plus a per-user opt-in, so an agent chooses whether the AI answers *their*
line (§13):

```sql
ALTER TABLE store_admin_sip_extensions
    ADD COLUMN voice_ai_answer TINYINT(1) NOT NULL DEFAULT 0;
```

**5.2 Config.** `voice_ai_enabled` and `voice_ai_gateway_url` join
`CONFIG_SCHEMA` in `routers/calling.js:69` — the whitelist that becomes the
upsert column list. The key does **not**: it is write-only, set through its own
endpoint and never returned by the config GET.

**5.3 Endpoints**, alongside the existing calling routes, `[auth, admin]`:

- `PUT /api/calling/voice-ai/key` — `{key}`, encrypted with the existing
  `utils/encryption.js`, owner-only, rate-limited. Returns only a masked hint.
- `DELETE /api/calling/voice-ai/key` — clears it.
- `GET /api/calling/voice-ai/credentials` — returns `{gateway_url, key}`
  decrypted, to an authenticated admin whose store has it enabled.
  Rate-limited 5/min per user, exactly like `GET /api/calling/extension`, and
  for the same reason: the browser genuinely needs the plaintext, because it is
  the browser that opens the websocket.

That last endpoint hands a credential to a logged-in admin's browser. That is
the same trade `GET /api/calling/extension` already makes with the SIP
password, under the same authentication. It is worth stating rather than
burying: **anyone who can log into the dashboard as an admin of this store can
read the voice-AI key.** Scope the key accordingly — one per store, revocable
from voice-ai's own settings.

---

## 6. Dashboard changes

**6.1 The audio pipeline** ports from voice-ai as plain JS into
`lib/voice-ai/`: capture from a `MediaStream` into PCM16 at 16 kHz via an
`AudioWorklet`, and a scheduling player whose output is a
`MediaStreamAudioDestinationNode`. Both are framework-free and already reviewed;
the conversion is mechanical.

This does duplicate code across two repos, and that is a real cost. It is
accepted for now because a shared package is its own project, and because the
dashboard is the only consumer that matters. Revisit if a third consumer
appears.

**6.2 A `useVoiceAgent` hook** owning one call's AI session: open the gateway
websocket, start capture from the remote stream, feed `audio` frames to the
player, `clear()` on `interrupted`, close on hangup. The gateway's message set
is unchanged, so this is the same logic already written and reviewed for the
standalone bridge.

**6.3 `CallContext` gains an AI branch** at the three points in §3, and exposes
`aiActive` plus `takeOver()` for the panel.

**6.4 Settings** — an "AI answering" card under Settings → Calling: paste the
key, set the gateway URL, toggle the store switch, and a per-agent toggle for
"let the AI answer my calls". Follow `settings/smartcomm/page.js`, the existing
pasted-key pattern.

---

## 7. voice-ai changes

Almost none. The gateway already accepts `?key=` at the HTTP upgrade and
rejects before opening a billed session.

One addition: the gateway currently serves **one global agent config**. If
different stores need different agents, that is the multi-tenant work already
scoped in the first spec's §6.1. Until then every store shares one agent, which
is fine for a first deployment and must be said out loud rather than
discovered.

---

## 8. Failure modes

| Failure | Behaviour |
|---|---|
| Gateway unreachable when a call rings | **Do not auto-answer.** Fall through to the normal ringing UI so a human can take it. A silent answered call is worse than a ringing one. |
| Gateway dies mid-call | Close the session, swap to the microphone, and tell the agent their line is live. Never leave a caller talking to nothing. |
| Key rejected (401 at upgrade) | Do not answer; surface "the voice-AI key was rejected" in the panel, not a generic error. |
| Agent clicks Take over | `replaceTrack()` to the mic, close the gateway session. The SIP call is untouched. |
| Two tabs open for the same agent | The existing device-claim logic already permits only one registration; the AI adds no new contention. |
| AI enabled but no key configured | The toggle cannot be switched on. Validate at save time, not at ring time. |
| Caller hangs up | Existing teardown, plus closing the gateway socket. |

---

## 9. Security

- The voice-AI key reaches an authenticated admin's browser (§5.3). Same trade
  as the SIP password, same authentication, stated explicitly.
- It is stored encrypted at rest via `utils/encryption.js`, never returned by
  the config GET, and revocable from voice-ai's key settings.
- The gateway rejects an unauthenticated upgrade before opening a Gemini
  session, so a leaked key costs conversation minutes, not unbounded spend —
  and revoking it is immediate.
- Call recording, credit accounting and correlation are unchanged, because the
  SIP session is unchanged.

---

## 10. Testing

Testable and tested: the gateway message handling in `useVoiceAgent` as a pure
reducer over events, the settings validators, and the backend endpoints
(encrypt/decrypt round trip, key never present in the config GET response).

Verified by hand on a real call: the AI answers a genuine inbound call; audio
flows both ways; talking over the agent interrupts it; **Take over** puts the
human on the line without dropping the caller; and the call still appears in
Selorax's call log with the right agent.

---

## 11. Risks

- **`CallContext.js` is production-critical.** Every change is additive and
  behind an AI-mode branch; the human path must be byte-identical when the
  toggle is off. That is the review's first question, not its last.
- **Duplicated audio code** across two repos (§6.1).
- **One agent config for all stores** until multi-tenancy lands (§7).
- **A dashboard tab is the runtime.** Closing it ends the AI's ability to
  answer. For always-on use, that tab needs to live somewhere that stays open.

---

## 12. Milestones

1. **Backend + settings.** Schema, endpoints, the settings card. Nothing
   answers a call yet, but the key round-trips and is never leaked.
2. **The AI answers.** Audio pipeline ported, `useVoiceAgent`, the three
   `CallContext` hooks. → **A real customer call, answered by the AI.**
3. **Take over.** `replaceTrack()`, the panel controls, the transcript view.

2 is the milestone. 3 is what makes it safe to leave on.

---

## 13. Open decision

**Store-level or per-agent?** This design assumes both: a store switch plus a
per-agent opt-in, so an agent chooses whether the AI answers *their* line. That
matches "my dashboard rings, the AI answers". If instead the intent is a
dedicated always-on machine logged in as an AI user, the per-agent toggle is
the only one that matters and the store switch can go. Confirm before Milestone 1.
