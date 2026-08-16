/**
 * Gemini-facing constants and types.
 *
 * Nothing secret lives here — the API key is read exclusively from the server
 * process environment (see `server/voice/gemini-session.ts`).
 */

/** Model used to transcribe + answer an uploaded recording (non real-time). */
export const UPLOAD_UNDERSTANDING_MODEL = "gemini-2.5-flash";

/** Model used to synthesise the spoken reply in Upload mode. */
export const UPLOAD_TTS_MODEL = "gemini-3.1-flash-tts-preview";

/** Voice-agent lifecycle, drives every visual state in the console. */
export type VoiceStatus =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "interrupted"
  | "error";

export interface TranscriptEntry {
  id: string;
  speaker: "user" | "assistant";
  text: string;
  /** Wall-clock ms when the entry was opened, for ordering + display. */
  at: number;
  final: boolean;
}

/**
 * Latency instrumentation. Every field is a duration in milliseconds, measured
 * on the client except `geminiConnectMs`, which the gateway reports.
 */
export interface CallMetrics {
  /** Browser WebSocket handshake. */
  wsConnectMs: number | null;
  /** Gateway -> Gemini Live session setup. */
  geminiConnectMs: number | null;
  /** getUserMedia + AudioContext + AudioWorklet boot. */
  micStartMs: number | null;
  /** Click -> "listening", the full cold-start cost. */
  sessionReadyMs: number | null;

  /** Timestamps for the turn currently in flight (performance.now based). */
  userSpeechStartedAt: number | null;
  userSpeechEndedAt: number | null;

  /** End of user speech -> first Gemini event of the response. */
  firstResponseMs: number | null;
  /** End of user speech -> first audio chunk arriving over the WebSocket. */
  firstAudioChunkMs: number | null;
  /** End of user speech -> first sample actually reaching the speakers. */
  timeToFirstAudioMs: number | null;
  /** Duration of the assistant's spoken response. */
  responseDurationMs: number | null;
  /** User speech onset -> playback cleared during a barge-in. */
  interruptionLatencyMs: number | null;

  /** Rolling WebSocket round-trip time from the ping/pong probe. */
  roundTripMs: number | null;

  turns: number;
  interruptions: number;
}

export const EMPTY_METRICS: CallMetrics = {
  wsConnectMs: null,
  geminiConnectMs: null,
  micStartMs: null,
  sessionReadyMs: null,
  userSpeechStartedAt: null,
  userSpeechEndedAt: null,
  firstResponseMs: null,
  firstAudioChunkMs: null,
  timeToFirstAudioMs: null,
  responseDurationMs: null,
  interruptionLatencyMs: null,
  roundTripMs: null,
  turns: 0,
  interruptions: 0,
};

/** Result of the non-real-time Upload Audio pipeline. */
export interface UploadAnalysis {
  transcript: string;
  reply: string;
  /** `data:audio/wav;base64,...` for the synthesised reply. */
  replyAudioUrl: string;
  timings: {
    understandingMs: number;
    synthesisMs: number;
    totalMs: number;
  };
}
