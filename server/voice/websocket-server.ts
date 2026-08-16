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
import {
  INPUT_SAMPLE_RATE,
  MAX_CLIENT_FRAME_BYTES,
  OUTPUT_SAMPLE_RATE,
  parseClientMessage,
  type ServerMessage,
  type VoiceErrorCode,
} from "../../types/voice";
import { GeminiVoiceSession, loadResolvedAgentConfig } from "./gemini-session";
import { EnergyVad } from "./vad";

const HEARTBEAT_MS = 15000;
/** Upstream audio ceiling. 16 kHz PCM16 as base64 is ~43 KB/s; this is ~4x. */
const MAX_AUDIO_BYTES_PER_SECOND = 200_000;
/** Belt and braces: a malformed turn must never leave the agent permanently deaf. */
const GREETING_GUARD_MS = 30_000;

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
          if (state.assistantSpeaking) {
            state.assistantSpeaking = false;
            send({ type: "assistant_stopped_speaking" });
          }
          send({ type: "turn_complete" });
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
  if (gemini && agent.welcome.enabled && agent.welcome.message.trim() !== "") {
    state.greetingActive = true;
    state.greetingGuard = setTimeout(endGreeting, GREETING_GUARD_MS);
    gemini.primeGreeting();
  }

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

function closeCall(socket: WebSocket, state: CallState, code: number, reason: string): void {
  if (state.closed) return;
  state.closed = true;

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
