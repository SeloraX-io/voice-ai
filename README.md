# AI Voice Agent — real-time call-centre prototype

A streaming voice console built on the **Gemini Live API**. You speak, the agent
answers while you are still listening, and you can talk over it at any time.

There is no record → upload → STT → LLM → TTS → play cycle anywhere in the live
path. Microphone audio is streamed continuously over one persistent WebSocket,
and the agent's voice is scheduled onto the speakers the moment the first chunk
arrives.

---

## Quick start

```bash
npm install

cp .env.example .env.local     # then paste your key into GEMINI_API_KEY
npm run dev                    # starts BOTH the web app and the voice gateway
```

- Web app → <http://localhost:3000>
- Voice gateway → `ws://localhost:4000/voice`

Click **Start Conversation**, allow the microphone, and talk.

> The browser will only grant microphone access on `localhost` or over HTTPS.

### Configuring `GEMINI_API_KEY`

The key is read **only** in the server process — the Node voice gateway and the
`/api/upload` route handler. It is never bundled into client code.

Put it in `.env.local` (git-ignored):

```
GEMINI_API_KEY=your-key-here
```

`.env` also works — both files are loaded, with `.env.local` taking precedence.

**Never** rename it to `NEXT_PUBLIC_GEMINI_API_KEY`. Anything prefixed with
`NEXT_PUBLIC_` is inlined into the JavaScript bundle and becomes public. The
only public variable here is `NEXT_PUBLIC_VOICE_GATEWAY_URL`, which is an
endpoint address, not a credential.

### Scripts

| Script                | What it does                                        |
| --------------------- | --------------------------------------------------- |
| `npm run dev`         | Next.js **and** the voice gateway, side by side      |
| `npm run dev:web`     | Next.js only (port 3000)                             |
| `npm run dev:gateway` | Voice gateway only, with reload (port 4000)          |
| `npm run gateway`     | Voice gateway, no watcher — use this in production   |
| `npm run build`       | Production build of the Next.js app                  |
| `npm run lint`        | ESLint                                               |
| `npm run typecheck`   | `tsc --noEmit` across app, lib and server            |

---

## Architecture

Two processes. This split is deliberate: a voice call needs a socket that stays
open for minutes, which is not something a serverless function or a Next.js
route handler can promise.

```
Browser                                     Node voice gateway            Google
┌──────────────────────────────┐            ┌────────────────────┐        ┌──────────────┐
│ mic → AudioWorklet → PCM16   │  ws :4000  │ validate + VAD     │  wss   │ Gemini Live  │
│ 16 kHz, 30 ms chunks         │───────────▶│ forward audio      │───────▶│ bidiGenerate │
│                              │            │                    │        │  Content     │
│ AudioContext ← scheduler ←   │◀───────────│ forward audio,     │◀───────│              │
│ speakers      queue          │  ws :4000  │ transcripts, VAD   │        │              │
└──────────────────────────────┘            └────────────────────┘        └──────────────┘
        Next.js :3000                        server/index.ts               GEMINI_API_KEY
                                                                           lives only here
```

One browser connection == one call == one Gemini Live session. They are created
together and torn down together.

### Layout

```
app/
  page.tsx                          redirects to /agent/conversation
  layout.tsx                        fonts
  globals.css                       design tokens, keyframes
  (console)/                          sidebar shell, config state, preview panel
    agent/{conversation,actions,advanced}/  the three agent screens
    models-voice/                     model, voice, language, turn taking
    upload/                           the non-real-time Upload Audio path
  api/upload/route.ts               Upload Audio mode (batch, not real-time)
  api/agent-config/route.ts         GET/PUT the agent configuration
  api/agent-config/secrets/route.ts write-only secret values

components/
  ui/                               shadcn-style primitives (button, tabs,
                                     field, input, textarea, select, switch,
                                     checkbox, dropdown, modal)
  shell/                              Sidebar, ConsoleChrome, DirtyNavGuard
  preview/                            PreviewPanel, PreviewSession
  agent-config/
    AgentConfigProvider.tsx         config state, save/discard, error routing
    ConversationTab.tsx             prompt, welcome message, conversation type
    ModelsVoiceTab.tsx              model, voice, language, VAD sensitivity
    ActionsTab.tsx                  HTTP tools, client tools, webhooks (not called yet)
    HttpToolModal.tsx               add or edit an HTTP tool
    ClientToolModal.tsx             add or edit a client tool
    WebhookModal.tsx                add or edit a webhook
    ParameterRows.tsx               shared parameter editor
    HeaderRows.tsx                  shared header / query editor
    AdvancedTab.tsx                 custom variables, secrets
    VariableInsertMenu.tsx          `{variable}` insertion helper
    PromptPreview.tsx               resolved-prompt preview
  voice/
    VoiceOrb.tsx                    animated state orb, driven by real levels
    VoiceWaveform.tsx               canvas waveform, driven by real levels
    VoiceControls.tsx               start / mute / end
    Transcript.tsx                  live two-sided transcript
    ConnectionStatus.tsx            connection, latency, audio format
    CallStats.tsx                   collapsible latency panel
    AudioUploader.tsx               Upload Audio tab

hooks/
  useVoiceSession.ts                lifecycle, state machine, metrics

lib/
  audio/
    microphone.ts                   getUserMedia + worklet capture
    audio-player.ts                 gap-free streaming playback
    audio-worklet.ts                worklet + AudioContext helpers
    pcm.ts                          base64 / PCM16 / WAV (shared both sides)
  websocket/voice-client.ts         browser side of the protocol
  gemini/types.ts                   model ids, voice, status + metric types
  agent-config/
    schema.ts                       the config contract + validateAgentConfig
    tools.ts                        tool + webhook types and validation
    validate-helpers.ts             shared field readers for both validators
    defaults.ts                     seed configuration
    template.ts                     `{variable}` interpolation
    resolve.ts                      config + variables → resolved prompt
    routes.ts                       navigation map, error → screen routing
    preview-hints.ts                save-before-test and stale-settings rules
  utils.ts

server/
  index.ts                          gateway process entry
  config/store.ts                   atomic config + secret persistence
  voice/
    websocket-server.ts             connection lifecycle, validation, routing
    gemini-session.ts               one Gemini Live session per call
    vad.ts                          energy VAD (UI + barge-in hint only)

public/audio-worklet/recorder-processor.js    capture + resample, audio thread
types/voice.ts                                the wire protocol, shared
```

`types/voice.ts` is imported by both the browser and the gateway, so the
protocol cannot drift between them.

---

## Configuring the agent

Open the app and use the sidebar. **Agent** holds Conversation, Actions and
Advanced; **Models & Voice** and **Upload Audio** sit alongside it.

Configuration is saved to `data/agent-config.json` and read fresh at the start of
every call, so a change takes effect on the next call with no restart. A call
already in progress keeps the settings it started with — the preview panel says
so when you save mid-call.

**Test agent** in the sidebar opens a preview panel where you can talk to the
agent from any screen. A call keeps running while you navigate, and while the
panel is closed; ending it is always explicit. If you start a test with unsaved
edits, the panel asks whether to save first, because the call would otherwise
use the last saved settings.

Secret *values* are written to `data/agent-secrets.json` (gitignored, mode 0600)
and are never sent to the browser.

---

### Actions

**Actions** in the sidebar defines what the agent can do beyond talking:

- **HTTP tools** — an endpoint the agent calls mid-conversation. Headers can
  reference a secret as `{{SECRET_NAME}}`; the value is resolved on the server
  and never sent to the browser. Braces in the URL (`/orders/{order_id}`)
  become parameters the agent fills in.
- **Client tools** — functions that run in the caller's own browser.
- **Webhooks** — call events posted to an endpoint you control.

Definitions are saved with the rest of the configuration, in
`data/agent-config.json`. **The agent does not call them yet** — executing them
during a call is the next piece of work.

---

## How the audio streaming works

### Capture (browser → Gemini)

1. `getUserMedia` with echo cancellation, noise suppression and AGC. Echo
   cancellation is what makes barge-in usable on laptop speakers — it keeps the
   agent's own voice out of the captured stream.
2. An `AudioContext` is requested at exactly **16 kHz**. If the browser refuses,
   the worklet resamples from the device rate instead (verified pitch-accurate
   from 16 kHz, 44.1 kHz, 48 kHz and 96 kHz).
3. `recorder-processor.js` runs on the audio thread, converts float32 → signed
   16-bit PCM and posts a chunk every **30 ms** (480 samples, 960 bytes). Nothing
   larger is ever buffered. The chunk's `ArrayBuffer` is transferred, not copied.
4. Each chunk is base64-encoded and sent as one WebSocket frame — roughly 33
   frames per second on a socket that stays open for the whole call.
5. The gateway forwards it to Gemini as
   `sendRealtimeInput({ audio: { data, mimeType: "audio/pcm;rate=16000" } })`.

`ScriptProcessorNode` is not used anywhere.

### Playback (Gemini → speakers)

1. Gemini streams back raw PCM16 at **24 kHz**. The gateway forwards every chunk
   the instant it arrives — it never waits for the turn to finish.
2. `StreamingAudioPlayer` decodes each chunk into an `AudioBuffer` and schedules
   it on a single `AudioContext` timeline at `nextStartTime`, then advances that
   cursor by the buffer's exact duration. Consecutive chunks are therefore
   sample-accurate: no clicks, no gaps, no `HTMLAudioElement` per chunk.
3. The scheduler keeps only an **80 ms** lead. That is enough to ride out network
   jitter and small enough that an interruption never has more than 80 ms of
   audio already committed to the hardware.

### Interruption (barge-in)

Three things happen, in order of how fast they can happen:

1. **Optimistic duck** — the gateway's energy VAD sees speech onset and the
   browser immediately drops the agent's gain to 12%. If no interruption is
   confirmed within 700 ms, the gain ramps back up. This is reversible and
   costs nothing if the VAD was wrong.
2. **Authoritative stop** — Gemini's own server-side VAD detects the overlap,
   stops generating and sends `serverContent.interrupted`. The gateway relays
   `{"type":"interrupted"}`.
3. **Flush** — the browser stops every scheduled source node and resets the
   playback cursor, discarding everything queued.

Step 3 matters more than it looks: Gemini generates faster than real time, so by
the time you interrupt, several seconds of the agent's reply may already be
sitting in the queue. Without the flush, the agent would keep talking over you.

Measured in-repo: **~307 ms** from speech onset to the `interrupted` event.

### Voice activity detection

Turn-taking is Gemini's job — `automaticActivityDetection` with high start/end
sensitivity and a 400 ms silence window. The local `EnergyVad` in the gateway is
deliberately dumb (RMS threshold, 90 ms onset debounce, 420 ms hangover) and is
used for exactly two things: driving the UI's speaking indicators, and
triggering the optimistic duck above. No custom ML VAD.

---

## How latency is measured

Open the **Latency** panel at the bottom of the console.

The headline is **TTFA (time to first audio)**: from the acoustic end of your
speech to the first sample actually reaching the speakers.

Two details make that number honest rather than flattering:

- **The VAD debounce is subtracted.** The gateway's VAD only reports speech-end
  after a 420 ms hangover, so every `user_stopped_speaking` message carries an
  `msAgo` field and the client rewinds its timestamp by that amount. Without
  this, TTFA would silently include the detector's own delay.
- **The hardware buffer is included.** The first-playback callback fires at
  `scheduledStartTime + AudioContext.outputLatency`, not when the buffer was
  handed to the audio graph. That is the moment sound actually leaves the
  speaker.

Everything tracked:

| Metric                | Meaning                                            |
| --------------------- | -------------------------------------------------- |
| WebSocket connect     | Browser handshake with the gateway                 |
| Gemini Live connect   | Gateway → Gemini session setup (measured server-side) |
| Microphone + worklet  | `getUserMedia` + `AudioContext` + `addModule`      |
| Click → listening     | Full cold-start cost of joining a call             |
| First Gemini event    | Speech end → first message of any kind from the model |
| First audio chunk     | Speech end → first audio frame over the WebSocket  |
| **Time to first audio** | Speech end → first sample at the speaker          |
| Response duration     | How long the agent actually spoke                  |
| Interruption latency  | Barge-in speech onset → playback flushed           |
| WebSocket round trip  | Rolling ping/pong RTT, shown in the status strip   |

Observed locally (Gemini Live, home broadband): Gemini session setup ~1.0 s,
speech-end → first audio chunk ~130–300 ms after Gemini's own endpointing.

---

## The wire protocol

Fully typed in `types/voice.ts`; no `any`. Audio is always base64 PCM16 mono.

**Client → server**

```jsonc
{ "type": "audio", "data": "<base64 pcm16 @16k>" }
{ "type": "text",  "text": "..." }        // typed input, for testing without a mic
{ "type": "audio_stream_end" }            // mic muted/stopped
{ "type": "ping",  "t": 12345.6 }
{ "type": "end" }                         // hang up
```

**Server → client**

```jsonc
{ "type": "session_started", "sessionId": "...", "model": "...", "voice": "Kore",
  "geminiConnectMs": 1077, "inputSampleRate": 16000, "outputSampleRate": 24000 }
{ "type": "audio", "data": "<base64 pcm16 @24k>", "seq": 0 }
{ "type": "transcript", "speaker": "user" | "assistant", "text": "...", "final": false }
{ "type": "user_started_speaking",  "msAgo": 90 }
{ "type": "user_stopped_speaking",  "msAgo": 420 }
{ "type": "assistant_started_speaking" }
{ "type": "assistant_stopped_speaking" }
{ "type": "interrupted" }
{ "type": "turn_complete" }
{ "type": "pong", "t": 12345.6 }
{ "type": "error", "message": "...", "code": "gemini_error", "fatal": false }
```

Every client frame is parsed and validated by `parseClientMessage`: unknown
types, non-base64 payloads, oversized frames (>64 KB) and binary frames are all
rejected without touching the Gemini session. Audio is rate-limited to 200 KB/s
(about 4× the legitimate rate); exceeding it ends the call. Malformed frames
produce a non-fatal `error` and the call continues.

---

## Upload Audio mode

The second tab is a batch pipeline for testing prompts and voices without a
microphone. Accepts MP3, WAV, M4A, WebM and OGG up to 15 MB.

`POST /api/upload` → Gemini transcribes the recording and drafts a reply in one
structured-output call, then a second call synthesises the reply to speech. The
headerless `audio/L16` that comes back is wrapped in a RIFF/WAVE container so an
`<audio>` element can play it.

This mode is intentionally **not** streaming. It exists for testing; the Live tab
is the product.

---

## Deployment

Do not deploy the voice gateway as a serverless function. A call holds one
socket open for its entire duration, and serverless request/response models
either kill it or bill you for the wall-clock time.

The intended shape:

| Piece         | Where                                                   |
| ------------- | ------------------------------------------------------- |
| Next.js app   | Vercel, or anywhere that serves a Next build            |
| Voice gateway | Railway, Fly.io, Render, an AWS container, or a plain VM — anything that supports long-lived WebSockets |

Then set `NEXT_PUBLIC_VOICE_GATEWAY_URL=wss://your-gateway-host/voice` for the
web app and `GEMINI_API_KEY` on the gateway. Use `npm run gateway` (no watcher)
as the gateway's start command. Terminate TLS in front of it — browsers on an
HTTPS page cannot open a plain `ws://` socket.

Nothing is deployed by this repo.

---

## Error handling

Handled explicitly, each with a distinct user-facing message: microphone
permission denied, no microphone present, microphone in use by another app,
Web Audio unavailable, worklet failed to load, gateway unreachable or timing
out, gateway connection lost mid-call, Gemini unreachable, Gemini session error
or timeout, malformed frames in either direction, unsupported or oversized
uploads, and audio Gemini cannot interpret.

Fatal errors tear the session down cleanly and return the UI to idle with the
reason on screen; non-fatal ones surface a banner and the call continues. The UI
never white-screens.

Upstream error text is logged server-side and replaced with a generic message
before being sent to the browser, so Gemini configuration detail never leaks to
the client.

## Cleanup

Ending a call stops the worklet and disconnects it, stops every `MediaStreamTrack`,
closes both `AudioContext`s, cancels every scheduled audio source, clears all
timers and animation frames, closes the WebSocket, and closes the Gemini session
server-side. The same teardown runs from the component's unmount effect, so
navigating away mid-call does not leak the microphone. The gateway pings every
15 s and terminates sockets that stop responding.

---

## Limitations and Gemini API constraints

- **`gemini-3.1-flash-live-preview` is a preview model.** Model ids in this space
  turn over quickly — `gemini-2.0-flash-live-001` and `gemini-live-2.5-flash-preview`
  were both retired in December 2025. `lib/gemini/types.ts` is the single place to
  change it. `gemini-2.5-flash-native-audio-latest` is a drop-in alternative.
- **Audio formats are fixed by the API**: input must be 16 kHz PCM16 mono
  (`audio/pcm;rate=16000`), output is always 24 kHz PCM16. Both rates are
  constants in `types/voice.ts` rather than anything negotiable.
- **Gemini generates faster than real time.** `generationComplete` usually arrives
  while the browser still has seconds of audio queued, which is why the visual
  SPEAKING state is driven by the playback engine and not by the server event.
- **Sessions have a lifetime.** `contextWindowCompression: { slidingWindow: {} }`
  extends a call well past the raw context limit, but a session can still end
  server-side; the client surfaces this and returns to idle rather than hanging.
  `sessionResumption` is available in the SDK and is not wired up here.
- **Transcripts are streamed fragments, not revisions.** Gemini emits incremental
  text with no guaranteed alignment to the audio, so a transcript line can lag or
  lead what you hear. Fragments are concatenated per speaker per turn.
- **Interruption is not instantaneous by design.** Roughly 80 ms of audio is
  already in the hardware buffer when the flush lands, so the agent's voice fades
  rather than cutting dead. Lowering `SCHEDULE_LEAD_SECONDS` in
  `lib/audio/audio-player.ts` trades that against jitter tolerance.
- **The optimistic duck can fire on loud background noise**, briefly softening the
  agent. It self-reverts after 700 ms. Raising the VAD threshold in
  `server/voice/vad.ts` trades sensitivity for false positives.
- **Echo cancellation is doing real work.** Barge-in on speakers depends on the
  browser's AEC keeping the agent's voice out of the mic. Headphones are more
  reliable; a very loud speaker at close range can still self-trigger.
- **No authentication.** The gateway accepts any WebSocket connection on its port.
  Validation and rate limiting are in place, but origin checks, auth and
  per-tenant isolation are deliberately out of scope for a prototype.
- **Tool calling is not wired up.** The system instruction tells the agent to use
  tools when available; `sendToolResponse` exists in the SDK and no tools are
  registered. This is the natural next step for real order lookups.
- **Not verified in a browser.** The gateway, the Gemini Live integration and the
  full protocol were exercised end to end against the live API, and the capture
  worklet's resampler was unit-tested across four device sample rates. The
  microphone, playback scheduler and React wiring have not been run in a real
  browser — that needs a human at a machine with a microphone.
