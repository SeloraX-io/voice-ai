/**
 * Wire protocol shared by the browser client and the Node voice gateway.
 *
 * Both sides import these types, so the protocol can never drift. Audio always
 * travels as base64-encoded raw PCM (signed 16-bit, little-endian, mono).
 */

import type { CallUsage } from "../lib/call-logs/types";

export const INPUT_SAMPLE_RATE = 16000;
export const OUTPUT_SAMPLE_RATE = 24000;

/** Duration of a single microphone chunk. Small enough to keep latency low. */
export const MIC_CHUNK_MS = 30;

/** Guard rail: a single client frame should never exceed this (base64 chars). */
export const MAX_CLIENT_FRAME_BYTES = 64 * 1024;

export type Speaker = "user" | "assistant";

export type VoiceErrorCode =
  | "gemini_unavailable"
  | "gemini_error"
  | "gemini_closed"
  | "invalid_message"
  | "rate_limited"
  | "server_error";

/* -------------------------------------------------------------------------- */
/* Client -> Server                                                           */
/* -------------------------------------------------------------------------- */

export type ClientMessage =
  /** A microphone chunk: base64 PCM16 @ 16 kHz mono. */
  | { type: "audio"; data: string }
  /** Typed input, useful for testing the pipeline without a microphone. */
  | { type: "text"; text: string }
  /** Microphone was muted / stopped; lets Gemini finalise the current turn. */
  | { type: "audio_stream_end" }
  /** Round-trip probe used for the live latency read-out. */
  | { type: "ping"; t: number }
  /**
   * Graceful hang-up. Carries the one metric only the browser can measure —
   * when audio actually reached the speakers — so the call log can record it.
   */
  | { type: "end"; timeToFirstAudioMs?: number | null };

/* -------------------------------------------------------------------------- */
/* Server -> Client                                                           */
/* -------------------------------------------------------------------------- */

export interface SessionInfo {
  sessionId: string;
  model: string;
  voice: string;
  /** Milliseconds spent establishing the upstream Gemini Live session. */
  geminiConnectMs: number;
  inputSampleRate: number;
  outputSampleRate: number;
}

export type ServerMessage =
  | ({ type: "session_started" } & SessionInfo)
  /** Base64 PCM16 @ 24 kHz mono, forwarded the moment it arrives from Gemini. */
  | { type: "audio"; data: string; seq: number }
  | { type: "transcript"; speaker: Speaker; text: string; final: boolean }
  /**
   * `msAgo` is how long before the frame was sent the acoustic edge actually
   * occurred — the gateway's VAD debounces both edges, and latency metrics
   * subtract this so the debounce isn't charged to the model.
   */
  | { type: "user_started_speaking"; msAgo: number }
  | { type: "user_stopped_speaking"; msAgo: number }
  | { type: "assistant_started_speaking" }
  | { type: "assistant_stopped_speaking" }
  | { type: "interrupted" }
  | { type: "turn_complete" }
  | { type: "pong"; t: number }
  /**
   * Running token usage and its estimated cost, forwarded as Gemini reports it
   * so the console can show what a call is costing while it is still running.
   */
  | { type: "usage_update"; usage: CallUsage; costUsd: number }
  /**
   * A tool is running. Sent so the console can show it; `silent` tools are
   * still reported here because the operator testing the agent should see
   * everything it does, even what the caller is not told about.
   */
  | { type: "tool_call"; name: string; silent: boolean }
  /**
   * The model decided to hang up. The call does not end at this instant — the
   * closing line is still being spoken — so this is a notice, not the close.
   */
  | { type: "agent_ending_call"; reason: string }
  | { type: "error"; message: string; code: VoiceErrorCode; fatal: boolean };

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Parses and validates a frame received from the browser. Returns `null` for
 * anything malformed — the gateway never trusts client input.
 */
export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > MAX_CLIENT_FRAME_BYTES) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") return null;

  switch (parsed.type) {
    case "audio":
      if (typeof parsed.data !== "string" || parsed.data.length === 0) return null;
      if (!BASE64_RE.test(parsed.data)) return null;
      return { type: "audio", data: parsed.data };
    case "text":
      if (typeof parsed.text !== "string") return null;
      return { type: "text", text: parsed.text.slice(0, 4000) };
    case "audio_stream_end":
      return { type: "audio_stream_end" };
    case "ping":
      if (typeof parsed.t !== "number" || !Number.isFinite(parsed.t)) return null;
      return { type: "ping", t: parsed.t };
    case "end": {
      const ttfa = parsed.timeToFirstAudioMs;
      return {
        type: "end",
        timeToFirstAudioMs: typeof ttfa === "number" && Number.isFinite(ttfa) ? ttfa : null,
      };
    }
    default:
      return null;
  }
}

/** Parses a frame received from the gateway. Returns `null` if unrecognised. */
export function parseServerMessage(raw: string): ServerMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") return null;
  return parsed as ServerMessage;
}
