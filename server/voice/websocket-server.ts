/**
 * Voice gateway.
 *
 * Accepts a browser WebSocket, opens a matching Gemini Live session and pumps
 * audio between the two in both directions. One connection == one call == one
 * Gemini session; everything is torn down together.
 *
 * Because accepting a connection is what starts the spending, the API key is
 * checked in `verifyClient` — during the upgrade, before the socket exists.
 * See `upgrade-auth.ts`.
 */

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";

import { WebSocketServer, type RawData, type WebSocket } from "ws";

import { base64ToPcm16, pcm16Rms } from "../../lib/audio/pcm";
import { readCallChannel, type CallChannel } from "../../lib/call-logs/channel";
import { computeCost, ratesFor, usageFromReport } from "../../lib/call-logs/pricing";
import {
  EMPTY_USAGE,
  type CallEvent,
  type CallRecord,
  type CallUsage,
  type TranscriptLine,
} from "../../lib/call-logs/types";
import type { SummaryConfig } from "../../lib/agent-config/schema";
import { apiKeyStore } from "../config/api-key-store";
import { callLogStore } from "../config/call-log-store";
import {
  INPUT_SAMPLE_RATE,
  MAX_CLIENT_FRAME_BYTES,
  OUTPUT_SAMPLE_RATE,
  parseClientMessage,
  type ServerMessage,
  type VoiceErrorCode,
} from "../../types/voice";
import { END_CALL_TOOL_NAME } from "../../lib/agent-config/tool-declarations";
import { DEFAULT_CLIENT_ID, normaliseClientId } from "../../lib/clients/types";
import type { ResolvedAgentConfig } from "../../lib/agent-config/resolve";
import { configStore } from "../config/store";
import { GeminiVoiceSession, loadResolvedAgentConfig, type LiveFunctionCall } from "./gemini-session";
import { summariseCall } from "./summarizer";
import { executeHttpTool } from "./tool-runner";
import {
  apiKeyRequired,
  authorizeUpgrade,
  upgradeUrl,
  type UpgradeRequestLike,
} from "./upgrade-auth";
import { EnergyVad } from "./vad";

const HEARTBEAT_MS = 15000;
/** Upstream audio ceiling. 16 kHz PCM16 as base64 is ~43 KB/s; this is ~4x. */
const MAX_AUDIO_BYTES_PER_SECOND = 200_000;
/** Belt and braces: a malformed turn must never leave the agent permanently deaf. */
const GREETING_GUARD_MS = 30_000;
/**
 * How long to wait after the model stops generating before hanging up on its
 * own request.
 *
 * Audio streams out as it is generated, so when the turn completes the browser
 * still has a little queued. Closing at that instant clips the closing line;
 * this lets it drain. It is a fixed delay because the gateway cannot see how
 * much the client has buffered — too short truncates the goodbye, too long
 * leaves dead air, and two seconds is the compromise.
 */
const HANGUP_GRACE_MS = 2_000;

/**
 * Hard ceiling on one call, counted from the moment the socket is accepted.
 *
 * **This is a cost ceiling, not a product limit.** Every open connection holds
 * a live Gemini session that bills by the second, and every path that ends a
 * call normally — the caller hanging up, the agent hanging up, the media path
 * failing — depends on something outside this process still working. This
 * timer depends on nothing: it is the backstop for the failure mode nobody
 * predicted, where a session would otherwise run until Gemini's own limit with
 * no one on the line.
 *
 * Thirty minutes is far longer than any conversation this agent is built for
 * (support calls run single-digit minutes), so a real caller will never meet
 * it, while a wedged session costs tens of cents rather than tens of dollars.
 * Raise it if a legitimate call is ever cut off — do not remove it.
 */
const MAX_CALL_DURATION_MS = 30 * 60 * 1_000;

/**
 * Ceiling on `from`/`to` as carried in the connection query string.
 *
 * These arrive as untrusted network input — the softphone bridge sends real
 * numbers, but nothing stops another client from sending anything. This is
 * generous for a phone number while keeping a hostile value from bloating the
 * call record.
 */
const MAX_PHONE_FIELD_CHARS = 64;

/**
 * Where a plain HTTP GET gets a 200 instead of a "this is a WebSocket" refusal.
 *
 * Hosting platforms decide whether a container is alive by making an ordinary
 * request to it, so the gateway has to answer one. Without this the process
 * listens for upgrades only, every probe fails, and the deploy is rolled back
 * while the logs cheerfully report that the gateway started.
 */
export const HEALTH_PATH = "/health";

export interface VoiceGatewayOptions {
  port: number;
  path?: string;
  /** Injected so the entry point owns all console output. */
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

/**
 * The running gateway: one HTTP server that answers health checks and hands
 * upgrades on `path` to `ws`.
 *
 * Narrower than the `WebSocketServer` it wraps, because the entry point only
 * ever needs to know when the port opened, which calls are live, and how to
 * shut both layers down together.
 */
export interface VoiceGateway {
  /** The live calls, for shutdown and for the health payload. */
  readonly clients: Set<WebSocket>;
  /** Fires once the port is actually open — the point at which probes pass. */
  onListening(handler: () => void): void;
  onError(handler: (error: Error) => void): void;
  /** Closes the WebSocket layer and then the HTTP server underneath it. */
  close(done: () => void): void;
}

interface CallState {
  readonly id: string;
  gemini: GeminiVoiceSession | null;
  readonly vad: EnergyVad;
  audioSeq: number;
  assistantSpeaking: boolean;
  alive: boolean;
  /** Rolling byte budget for the current second. */
  windowStartedAt: number;
  windowBytes: number;
  closed: boolean;
  /** True from the greeting primer until that turn completes. */
  greetingActive: boolean;
  /** Mirrors the config so the audio path does not re-read it per frame. */
  allowGreetingInterrupt: boolean;
  greetingGuard: ReturnType<typeof setTimeout> | null;
  /** The `MAX_CALL_DURATION_MS` backstop. Armed on connect, cleared on close. */
  durationGuard: ReturnType<typeof setTimeout> | null;

  /* --- what this call cost, accumulated as Gemini reports it --- */
  readonly startedAt: number;
  usage: CallUsage;
  model: string;
  voice: string;
  turns: number;
  interruptions: number;
  /** Measured in the browser, so it only arrives if the client hangs up cleanly. */
  timeToFirstAudioMs: number | null;
  /** Set when a record has been written, so a double close cannot log twice. */
  logged: boolean;
  /** The model asked to hang up; the call ends when it stops speaking. */
  pendingHangup: boolean;
  /** Why the call ended — the model's own reason, or the duration guard's. */
  endReason: string | null;
  /** The conversation, coalesced from streamed fragments. */
  transcript: TranscriptLine[];
  /**
   * Forces the next fragment onto a new line.
   *
   * Fragments are merged by speaker, but a turn boundary is also a line break:
   * without this, an agent that speaks on two consecutive turns — which is
   * every turn when the caller's side is not transcribed — has its whole call
   * glued into a single unreadable paragraph.
   */
  breakTranscript: boolean;
  /** What happened during the call, for later debugging. */
  events: CallEvent[];
  /** Copied from the config so the record can be written after the call ends. */
  summaryConfig: SummaryConfig | null;
  /** Carried here so `closeCall` can report a failed write without a new parameter. */
  readonly log: NonNullable<VoiceGatewayOptions["log"]>;

  /**
   * Which surface opened this connection, and the numbers involved.
   *
   * Read once from the upgrade request's query string in `handleConnection`
   * and never written again — the preview player sends neither parameter, so
   * these default to a browser call with no numbers.
   *
   * `channel` is not only recorded: it also decides the tool set handed to
   * Gemini, because a phone call declares no HTTP tools.
   */
  readonly channel: CallChannel;
  readonly phone: { from: string | null; to: string | null } | null;
  /**
   * Whose agent answers this call. From the connection's `client` query
   * parameter; a missing or malformed value falls back to the default client,
   * so the preview, the telephony bridge and pre-client embeds all keep
   * working. An unknown-but-valid id simply reads as default config, the same
   * as an unconfigured client.
   */
  readonly clientId: string;
}

/**
 * Reads `channel`, `from` and `to` off the upgrade request.
 *
 * Parsed with `upgradeUrl`, the same helper the key check uses, so there is one
 * placeholder base for the query string rather than two. Untrusted network
 * input: `channel` falls back to `"browser"` through `readCallChannel`, and
 * `from`/`to` are bounded.
 *
 * Either number stands on its own. A withheld caller ID is common and must not
 * also throw away which of our numbers was dialled, which is why `phone` is
 * null only when neither parameter was sent.
 */
export function parseCallOrigin(request: UpgradeRequestLike): {
  channel: CallChannel;
  phone: CallState["phone"];
  clientId: string;
} {
  const url = upgradeUrl(request);
  const channel = readCallChannel(url.searchParams.get("channel"));

  const from = url.searchParams.get("from")?.slice(0, MAX_PHONE_FIELD_CHARS) ?? null;
  const to = url.searchParams.get("to")?.slice(0, MAX_PHONE_FIELD_CHARS) ?? null;
  const phone = from !== null || to !== null ? { from, to } : null;

  const clientId = normaliseClientId(url.searchParams.get("client")) ?? DEFAULT_CLIENT_ID;

  return { channel, phone, clientId };
}

/** Milliseconds since the call began, for placing a line or event in time. */
function sinceStart(state: CallState): number {
  return Date.now() - state.startedAt;
}

function note(state: CallState, kind: CallEvent["kind"], detail: string): void {
  state.events.push({ atMs: sinceStart(state), kind, detail });
}

/**
 * Appends a transcript fragment.
 *
 * Gemini streams transcripts a word or two at a time, so consecutive fragments
 * from the same speaker are merged into one line. Without this the stored
 * transcript would be hundreds of one-word entries and unreadable.
 */
function appendTranscript(state: CallState, speaker: TranscriptLine["speaker"], text: string): void {
  if (text === "") return;
  const last = state.transcript.at(-1);
  if (last && last.speaker === speaker && !state.breakTranscript) {
    last.text += text;
    return;
  }
  state.breakTranscript = false;
  state.transcript.push({ speaker, text, atMs: sinceStart(state) });
}

/**
 * Why a call ended, derived from the reason `closeCall` was given.
 *
 * Mapping here rather than at each call site keeps the reasons — all defined in
 * this file — in one place, and means a new one defaults to "error" rather than
 * silently being recorded as a clean hangup.
 */
function endedByFor(reason: string): CallRecord["endedBy"] {
  if (reason === "client disconnected" || reason === "client hangup") return "caller";
  if (reason === "agent ended call") return "agent";
  if (reason === "server shutting down") return "shutdown";
  return "error";
}

export function startVoiceGateway(options: VoiceGatewayOptions): VoiceGateway {
  const path = options.path ?? "/voice";
  const log = options.log ?? (() => undefined);

  // Owned here rather than left to `ws`, which would create a hidden one that
  // answers every plain request with 426 — including the platform's health
  // check. `wss` is attached to it below.
  const http = createServer((request, response) => {
    const pathname = (request.url ?? "/").split("?")[0];
    if (request.method === "GET" && (pathname === HEALTH_PATH || pathname === "/")) {
      const body = JSON.stringify({ status: "ok", calls: wss.clients.size, voicePath: path });
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      response.end(body);
      return;
    }
    response.writeHead(426, { "content-type": "text/plain" });
    response.end(`This port speaks WebSocket. Connect to ${path}.\n`);
  });

  const wss = new WebSocketServer({
    server: http,
    path,
    maxPayload: MAX_CLIENT_FRAME_BYTES,
    // Runs during the HTTP upgrade: `ws` answers a refusal with a plain HTTP
    // status and destroys the socket, so `connection` never fires and no Gemini
    // session — nothing billable at all — is ever opened for a client that
    // could not present a key.
    verifyClient: (info, done) => {
      void authorizeUpgrade(info.req, {
        requireKey: apiKeyRequired(),
        verify: (presented) => apiKeyStore.verify(presented),
      })
        .then((decision) => {
          if (decision.ok) {
            if (decision.key) log("upgrade authorised", { key: decision.key.name });
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
          // Fail closed: if the key cannot be checked, nobody gets a session.
          log("upgrade check failed", { error: (cause as Error).name });
          done(false, 500, "Internal Server Error");
        });
    },
  });

  wss.on("connection", (socket, request) => {
    void handleConnection(socket, request, log);
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      const state = callStates.get(socket);
      if (!state) continue;
      if (!state.alive) {
        socket.terminate();
        continue;
      }
      state.alive = false;
      socket.ping();
    }
  }, HEARTBEAT_MS);

  wss.on("close", () => clearInterval(heartbeat));

  // No host argument: bind every interface, because a container's health check
  // arrives from outside it and would never reach a loopback-only listener.
  http.listen(options.port);

  return {
    clients: wss.clients,
    onListening: (handler) => http.on("listening", handler),
    onError: (handler) => http.on("error", handler),
    close: (done) => {
      // The WebSocket layer first, so live calls are closed before the port
      // goes away; the HTTP server is what actually holds the port open, so
      // `wss.close` alone would leave the process running.
      wss.close(() => http.close(() => done()));
    },
  };
}

const callStates = new WeakMap<WebSocket, CallState>();

async function handleConnection(
  socket: WebSocket,
  request: IncomingMessage,
  log: NonNullable<VoiceGatewayOptions["log"]>,
): Promise<void> {
  const { channel, phone, clientId } = parseCallOrigin(request);
  const state: CallState = {
    id: randomUUID(),
    gemini: null,
    vad: new EnergyVad(),
    audioSeq: 0,
    assistantSpeaking: false,
    alive: true,
    windowStartedAt: Date.now(),
    windowBytes: 0,
    closed: false,
    greetingActive: false,
    allowGreetingInterrupt: true,
    greetingGuard: null,
    durationGuard: null,
    startedAt: Date.now(),
    usage: { ...EMPTY_USAGE },
    model: "",
    voice: "",
    turns: 0,
    interruptions: 0,
    timeToFirstAudioMs: null,
    logged: false,
    pendingHangup: false,
    endReason: null,
    transcript: [],
    breakTranscript: false,
    events: [],
    summaryConfig: null,
    log,
    channel,
    phone,
    clientId,
  };
  callStates.set(socket, state);

  // Armed here rather than after the Gemini session is up, so a connection that
  // wedges anywhere during setup is covered too. `unref` keeps a half-hour timer
  // from holding the process open across a restart; the shutdown path closes
  // live calls itself.
  state.durationGuard = setTimeout(() => {
    state.durationGuard = null;
    log("call hit the maximum duration", { id: state.id, ms: MAX_CALL_DURATION_MS });
    note(state, "error", "the call hit the maximum duration and was ended");
    // Only when the model has not already given its own reason.
    state.endReason ??= "the call hit the maximum duration";
    closeCall(socket, state, 1000, "maximum call duration");
  }, MAX_CALL_DURATION_MS);
  state.durationGuard.unref?.();

  const send = (message: ServerMessage) => {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify(message));
  };

  const fail = (code: VoiceErrorCode, message: string) => {
    send({ type: "error", message, code, fatal: true });
    closeCall(socket, state, 1011, "gateway error");
  };

  socket.on("pong", () => {
    state.alive = true;
  });

  // Registered before the config load and the Gemini connect (both `await`)
  // so a disconnect mid-setup is observed instead of silently falling through:
  // `handleClientFrame` already no-ops while `state.gemini` is null, and the
  // `state.closed` check right after `create()` handles a close landing here.
  socket.on("message", (raw: RawData, isBinary: boolean) => {
    if (isBinary) {
      send({ type: "error", message: "Binary frames are not supported.", code: "invalid_message", fatal: false });
      return;
    }
    handleClientFrame(raw.toString(), socket, state, send, log);
  });

  socket.on("close", () => {
    log("call disconnected", { id: state.id });
    closeCall(socket, state, 1000, "client disconnected");
  });

  socket.on("error", (error) => {
    log("socket error", { id: state.id, error: String(error) });
    closeCall(socket, state, 1011, "socket error");
  });

  log("call connected", {
    id: state.id,
    client: state.clientId,
    remote: request.socket.remoteAddress ?? "unknown",
  });

  const agent = await loadResolvedAgentConfig(
    (message) => log(message, { id: state.id }),
    state.clientId,
  );
  state.allowGreetingInterrupt = agent.welcome.allowInterrupt;
  state.summaryConfig = agent.summary;
  note(state, "connected", `${agent.models.liveModel} · ${agent.models.voice}`);

  const endGreeting = () => {
    if (!state.greetingActive) return;
    state.greetingActive = false;
    if (state.greetingGuard) {
      clearTimeout(state.greetingGuard);
      state.greetingGuard = null;
    }
  };

  try {
    state.gemini = await GeminiVoiceSession.create(
      {
        onAudio: (data) => {
          if (!state.assistantSpeaking) {
            state.assistantSpeaking = true;
            send({ type: "assistant_started_speaking" });
          }
          send({ type: "audio", data, seq: state.audioSeq++ });
        },
        // Gemini keeps sending the assistant's own transcript even when
        // `outputAudioTranscription` is omitted, so the switch is enforced here
        // as well. Relying on the request alone would leave the setting saying
        // one thing and the console showing another.
        onInputTranscript: (text) => {
          if (!agent.models.transcripts) return;
          appendTranscript(state, "user", text);
          send({ type: "transcript", speaker: "user", text, final: false });
        },
        onOutputTranscript: (text) => {
          if (!agent.models.transcripts) return;
          appendTranscript(state, "assistant", text);
          send({ type: "transcript", speaker: "assistant", text, final: false });
        },
        onInterrupted: () => {
          endGreeting();
          state.interruptions += 1;
          note(state, "interrupted", "caller spoke over the agent");
          state.assistantSpeaking = false;
          send({ type: "interrupted" });
        },
        onGenerationComplete: () => {
          if (state.assistantSpeaking) {
            state.assistantSpeaking = false;
            send({ type: "assistant_stopped_speaking" });
          }
        },
        onTurnComplete: () => {
          endGreeting();
          state.turns += 1;
          state.breakTranscript = true;
          if (state.pendingHangup && !state.closed) {
            setTimeout(() => closeCall(socket, state, 1000, "agent ended call"), HANGUP_GRACE_MS);
          }
          if (state.assistantSpeaking) {
            state.assistantSpeaking = false;
            send({ type: "assistant_stopped_speaking" });
          }
          send({ type: "turn_complete" });
        },
        onToolCall: (calls) => {
          void runToolCalls(calls, state, agent, socket, send, endGreeting);
        },
        onUsage: (report) => {
          state.usage = usageFromReport(report, state.usage);
          send({
            type: "usage_update",
            usage: state.usage,
            costUsd: computeCost(state.usage, ratesFor(state.model)).totalUsd,
          });
        },
        onError: (message) => {
          log("gemini error", { id: state.id, message });
          send({ type: "error", message: "The AI service reported an error.", code: "gemini_error", fatal: false });
        },
        onClose: (reason) => {
          log("gemini closed", { id: state.id, reason });
          if (state.closed) return;
          send({
            type: "error",
            message: "The AI session ended. Start a new call to continue.",
            code: "gemini_closed",
            fatal: true,
          });
          closeCall(socket, state, 1000, "gemini session closed");
        },
      },
      agent,
      // Decides the tool set: a phone call is offered `end_call` only.
      state.channel,
    );
  } catch (cause) {
    log("gemini connect failed", { id: state.id, error: String(cause) });
    // The upstream message can contain configuration detail — keep it server-side.
    fail("gemini_unavailable", "Could not reach the AI voice service. Check the server logs.");
    return;
  }

  if (state.closed) {
    state.gemini.close();
    return;
  }

  // Recorded on the call state so the log written at hangup names the model
  // that actually ran, not whatever the config says by then.
  state.model = agent.models.liveModel;
  state.voice = agent.models.voice;

  send({
    type: "session_started",
    sessionId: state.id,
    model: agent.models.liveModel,
    voice: agent.models.voice,
    geminiConnectMs: state.gemini.connectMs,
    inputSampleRate: INPUT_SAMPLE_RATE,
    outputSampleRate: OUTPUT_SAMPLE_RATE,
  });

  const gemini = state.gemini;
  if (
    gemini &&
    agent.welcome.enabled &&
    agent.welcome.message.trim() !== "" &&
    socket.readyState === socket.OPEN
  ) {
    state.greetingActive = true;
    state.greetingGuard = setTimeout(endGreeting, GREETING_GUARD_MS);
    note(state, "greeting", agent.welcome.message.trim().slice(0, 120));
    gemini.primeGreeting();
  }
}

function handleClientFrame(
  raw: string,
  socket: WebSocket,
  state: CallState,
  send: (message: ServerMessage) => void,
  log: NonNullable<VoiceGatewayOptions["log"]>,
): void {
  const message = parseClientMessage(raw);
  if (!message) {
    send({
      type: "error",
      message: "Malformed message ignored.",
      code: "invalid_message",
      fatal: false,
    });
    return;
  }

  const gemini = state.gemini;
  if (!gemini) return;

  switch (message.type) {
    case "audio": {
      if (!withinRateLimit(state, message.data.length)) {
        log("rate limit tripped", { id: state.id });
        send({
          type: "error",
          message: "Audio is arriving faster than expected; the call was stopped.",
          code: "rate_limited",
          fatal: true,
        });
        closeCall(socket, state, 1008, "rate limited");
        return;
      }

      // While an uninterruptible greeting plays, local VAD still drives the UI
      // meters but nothing goes upstream — so server-side VAD never sees a
      // barge-in and the greeting finishes.
      //
      // Caveat: `greetingActive` clears on `onTurnComplete`, which fires when
      // Gemini finishes *generating* the greeting, not when the browser
      // finishes *playing* it back. So this only protects the greeting while
      // it is being generated — a caller talking over the tail of played-back
      // audio still reaches the model. Closing that gap needs a client
      // playback-drained signal this gateway does not have.
      if (state.greetingActive && !state.allowGreetingInterrupt) {
        updateVad(message.data, state, send);
        return;
      }

      // Forward first so Gemini starts working; local VAD only drives UI.
      gemini.sendAudio(message.data);
      updateVad(message.data, state, send);
      return;
    }
    case "text":
      if (message.text.trim().length > 0) gemini.sendText(message.text);
      return;
    case "audio_stream_end":
      gemini.signalAudioStreamEnd();
      return;
    case "ping":
      send({ type: "pong", t: message.t });
      return;
    case "end":
      // Captured before closeCall, which is what writes the record.
      state.timeToFirstAudioMs = message.timeToFirstAudioMs ?? null;
      closeCall(socket, state, 1000, "client hangup");
      return;
  }
}

function updateVad(
  base64: string,
  state: CallState,
  send: (message: ServerMessage) => void,
): void {
  let rms: number;
  let durationMs: number;
  try {
    const pcm = base64ToPcm16(base64);
    if (pcm.length === 0) return;
    rms = pcm16Rms(pcm);
    durationMs = (pcm.length / INPUT_SAMPLE_RATE) * 1000;
  } catch {
    return;
  }

  const transition = state.vad.push(rms, durationMs);
  if (!transition) return;

  if (transition.type === "start") {
    send({ type: "user_started_speaking", msAgo: transition.msAgo });
  } else {
    send({ type: "user_stopped_speaking", msAgo: transition.msAgo });
  }
}

function withinRateLimit(state: CallState, bytes: number): boolean {
  const now = Date.now();
  if (now - state.windowStartedAt >= 1000) {
    state.windowStartedAt = now;
    state.windowBytes = 0;
  }
  state.windowBytes += bytes;
  return state.windowBytes <= MAX_AUDIO_BYTES_PER_SECOND;
}

/**
 * Writes what the call cost, once.
 *
 * Deliberately fire-and-forget: a failure to record history must never delay
 * or break hanging up, so the promise is caught and logged rather than awaited
 * by `closeCall`, which is synchronous and runs on the socket's close path.
 */
function recordCall(state: CallState, endedBy: CallRecord["endedBy"]): void {
  if (state.logged) return;
  state.logged = true;

  // A call that never reached Gemini has nothing to bill and no model to price.
  if (state.model === "") return;

  const endedAt = Date.now();
  const record: CallRecord = {
    id: state.id,
    startedAt: new Date(state.startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMs: endedAt - state.startedAt,
    model: state.model,
    voice: state.voice,
    usage: state.usage,
    cost: computeCost(state.usage, ratesFor(state.model)),
    turns: state.turns,
    interruptions: state.interruptions,
    timeToFirstAudioMs: state.timeToFirstAudioMs,
    endedBy,
    endReason: state.endReason,
    transcript: state.transcript,
    events: [...state.events, { atMs: endedAt - state.startedAt, kind: "ended" as const, detail: endedBy }],
    summary: null,
    channel: state.channel,
    phone: state.phone,
    clientId: state.clientId,
  };

  // Written first, then updated with the summary. The cost and transcript are
  // the parts that cannot be regenerated, so they are never held hostage to a
  // summarisation request that might be slow or fail.
  void callLogStore
    .append(record)
    .then(() => attachSummary(record, state))
    .catch((cause) => {
      state.log("could not record the call", { id: state.id, error: (cause as Error).name });
    });
}

/**
 * Writes the summary once the record is safely on disk.
 *
 * Runs after the call has already ended and after the record exists, so a slow
 * or failing summariser costs nothing but the summary itself.
 */
async function attachSummary(record: CallRecord, state: CallState): Promise<void> {
  const config = state.summaryConfig;
  const apiKey = process.env.GEMINI_API_KEY;

  if (!config?.enabled || !apiKey || record.transcript === undefined || record.transcript.length === 0) {
    return;
  }

  const summary = await summariseCall(record.transcript, {
    language: config.language,
    model: config.model,
    apiKey,
    endedBy: record.endedBy,
    endReason: record.endReason ?? null,
  });
  if (!summary) {
    state.log("could not summarise the call", { id: state.id });
    return;
  }

  try {
    await callLogStore.update(record.id, (current) => ({ ...current, summary }));
    state.log("summarised the call", { id: state.id, usd: summary.usd.toFixed(6) });
  } catch (cause) {
    state.log("could not save the summary", { id: state.id, error: (cause as Error).name });
  }
}

/**
 * Runs everything the model asked for, then answers it.
 *
 * Every call gets exactly one response, including failures — the model blocks
 * until it hears back, so a silently dropped call leaves the caller listening
 * to nothing while the agent waits forever.
 *
 * `end_call` is handled here rather than as a tool: it needs no request, and
 * the hang-up is deferred until the model has finished its closing line, which
 * is what `pendingHangup` marks.
 */
async function runToolCalls(
  calls: LiveFunctionCall[],
  state: CallState,
  agent: ResolvedAgentConfig,
  socket: WebSocket,
  send: (message: ServerMessage) => void,
  endGreeting: () => void,
): Promise<void> {
  const gemini = state.gemini;
  if (!gemini) return;

  const responses: Array<{ id?: string; name?: string; response: Record<string, unknown> }> = [];
  let secrets: Record<string, string> | null = null;

  for (const call of calls) {
    const name = call.name ?? "";
    const args = call.args ?? {};

    if (name === END_CALL_TOOL_NAME) {
      const reason = typeof args.reason === "string" ? args.reason : "the agent ended the call";
      state.log("agent ended the call", { id: state.id, reason });
      state.endReason = reason;
      state.pendingHangup = true;
      note(state, "agent_ending", reason);
      // The greeting gate must not outlive the call it was guarding.
      endGreeting();
      const endId = call.id ?? randomUUID();
      send({ type: "tool_call", id: endId, name, silent: false });
      send({ type: "tool_result", id: endId, ok: true, durationMs: 0 });
      send({ type: "agent_ending_call", reason });
      responses.push({ id: call.id, name, response: { ok: true } });
      continue;
    }

    const tool = agent.tools.http.find((entry) => entry.name === name);
    if (!tool) {
      const missingId = call.id ?? randomUUID();
      send({ type: "tool_call", id: missingId, name, silent: false });
      send({ type: "tool_result", id: missingId, ok: false, durationMs: 0 });
      note(state, "error", `model called ${name}, which is not configured`);
      responses.push({
        id: call.id,
        name,
        response: { error: `No tool named ${name} is configured.` },
      });
      continue;
    }

    // Read once per batch, and only when a tool actually needs them.
    secrets ??= await configStore.resolveSecrets(state.clientId);

    // A generated id when the model omits one, so the console can still pair
    // the result with the call it belongs to.
    const callId = call.id ?? randomUUID();
    const startedAt = Date.now();
    send({ type: "tool_call", id: callId, name, silent: tool.silent });
    note(state, "tool_call", tool.silent ? `${name} (silent)` : name);

    const result = await executeHttpTool(tool, args, secrets);

    const durationMs = Date.now() - startedAt;
    note(
      state,
      "tool_result",
      `${name} ${result.ok === true ? "ok" : "failed"} in ${durationMs} ms`,
    );
    send({ type: "tool_result", id: callId, ok: result.ok === true, durationMs });
    responses.push({ id: call.id, name, response: result });
  }

  if (responses.length > 0) gemini.sendToolResponse(responses);
}

function closeCall(socket: WebSocket, state: CallState, code: number, reason: string): void {
  if (state.closed) return;
  state.closed = true;

  recordCall(state, endedByFor(reason));

  if (state.greetingGuard) {
    clearTimeout(state.greetingGuard);
    state.greetingGuard = null;
  }

  if (state.durationGuard) {
    clearTimeout(state.durationGuard);
    state.durationGuard = null;
  }

  state.gemini?.close();
  state.gemini = null;
  state.vad.reset();
  callStates.delete(socket);

  if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
    socket.close(code, reason);
  }
}
