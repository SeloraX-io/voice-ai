/**
 * Voice gateway.
 *
 * Accepts a browser WebSocket, opens a matching Gemini Live session and pumps
 * audio between the two in both directions. One connection == one call == one
 * Gemini session; everything is torn down together.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { WebSocketServer, type RawData, type WebSocket } from "ws";

import { base64ToPcm16, pcm16Rms } from "../../lib/audio/pcm";
import { computeCost, ratesFor, usageFromReport } from "../../lib/call-logs/pricing";
import { EMPTY_USAGE, type CallRecord, type CallUsage } from "../../lib/call-logs/types";
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
import type { ResolvedAgentConfig } from "../../lib/agent-config/resolve";
import { configStore } from "../config/store";
import { GeminiVoiceSession, loadResolvedAgentConfig, type LiveFunctionCall } from "./gemini-session";
import { executeHttpTool } from "./tool-runner";
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

export interface VoiceGatewayOptions {
  port: number;
  path?: string;
  /** Injected so the entry point owns all console output. */
  log?: (message: string, meta?: Record<string, unknown>) => void;
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
  /** The reason the model gave, recorded in the call log. */
  endReason: string | null;
  /** Carried here so `closeCall` can report a failed write without a new parameter. */
  readonly log: NonNullable<VoiceGatewayOptions["log"]>;
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

export function startVoiceGateway(options: VoiceGatewayOptions): WebSocketServer {
  const path = options.path ?? "/voice";
  const log = options.log ?? (() => undefined);

  const wss = new WebSocketServer({ port: options.port, path, maxPayload: MAX_CLIENT_FRAME_BYTES });

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

  return wss;
}

const callStates = new WeakMap<WebSocket, CallState>();

async function handleConnection(
  socket: WebSocket,
  request: IncomingMessage,
  log: NonNullable<VoiceGatewayOptions["log"]>,
): Promise<void> {
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
    log,
  };
  callStates.set(socket, state);

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

  log("call connected", { id: state.id, remote: request.socket.remoteAddress ?? "unknown" });

  const agent = await loadResolvedAgentConfig((message) => log(message, { id: state.id }));
  state.allowGreetingInterrupt = agent.welcome.allowInterrupt;

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
        onInputTranscript: (text) => send({ type: "transcript", speaker: "user", text, final: false }),
        onOutputTranscript: (text) =>
          send({ type: "transcript", speaker: "assistant", text, final: false }),
        onInterrupted: () => {
          endGreeting();
          state.interruptions += 1;
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
  };

  void callLogStore.append(record).catch((cause) => {
    state.log("could not record the call", { id: state.id, error: (cause as Error).name });
  });
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
      // The greeting gate must not outlive the call it was guarding.
      endGreeting();
      send({ type: "agent_ending_call", reason });
      responses.push({ id: call.id, name, response: { ok: true } });
      continue;
    }

    const tool = agent.tools.http.find((entry) => entry.name === name);
    if (!tool) {
      responses.push({
        id: call.id,
        name,
        response: { error: `No tool named ${name} is configured.` },
      });
      continue;
    }

    // Read once per batch, and only when a tool actually needs them.
    secrets ??= await configStore.resolveSecrets();

    send({ type: "tool_call", name, silent: tool.silent });
    const result = await executeHttpTool(tool, args, secrets);
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

  state.gemini?.close();
  state.gemini = null;
  state.vad.reset();
  callStates.delete(socket);

  if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
    socket.close(code, reason);
  }
}
