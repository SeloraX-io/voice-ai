/**
 * What one call cost, and what it spent to get there.
 *
 * Pure types, shared by the gateway that records a call and the browser that
 * displays it, so neither side can drift from the other's idea of a record.
 */

import type { CallChannel } from "./channel";

/** Token counts as Gemini reports them, split by direction and modality. */
export interface CallUsage {
  inputTextTokens: number;
  inputAudioTokens: number;
  outputTextTokens: number;
  outputAudioTokens: number;
  /**
   * How many usage reports arrived during the call.
   *
   * Kept because Gemini's live usage messages are treated as cumulative
   * session totals rather than per-message deltas. If that assumption is ever
   * wrong, a call with many reports and an implausibly small total is the
   * signal — without this count the mistake would be invisible.
   */
  reports: number;
}

export const EMPTY_USAGE: CallUsage = {
  inputTextTokens: 0,
  inputAudioTokens: 0,
  outputTextTokens: 0,
  outputAudioTokens: 0,
  reports: 0,
};

/** Cost in US dollars, split so an expensive call can be explained. */
export interface CallCost {
  inputUsd: number;
  outputUsd: number;
  totalUsd: number;
}

/** One line of the conversation, coalesced from the streamed fragments. */
export interface TranscriptLine {
  speaker: "user" | "assistant";
  text: string;
  /** Milliseconds from the start of the call, so a line can be placed in time. */
  atMs: number;
}

/**
 * Something worth knowing that happened during the call.
 *
 * Deliberately not every frame: audio chunks and speech edges are noise at this
 * level. These are the moments you would want when asking "what happened on
 * that call?" months later.
 */
export interface CallEvent {
  atMs: number;
  kind:
    | "connected"
    | "greeting"
    | "tool_call"
    | "tool_result"
    | "interrupted"
    | "agent_ending"
    | "error"
    | "ended";
  /** Human-readable detail: a tool name, an error, the reason for hanging up. */
  detail: string;
}

/** The after-the-fact summary, when one was generated. */
export interface CallSummary {
  text: string;
  /** BCP-47-ish tag the summary was asked for, e.g. "en" or "bn". */
  language: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Charged on top of the call itself, so it is recorded separately. */
  usd: number;
}

export interface CallRecord {
  id: string;
  /** ISO 8601. */
  startedAt: string;
  endedAt: string;
  durationMs: number;
  model: string;
  voice: string;
  usage: CallUsage;
  cost: CallCost;
  turns: number;
  interruptions: number;
  /** Milliseconds from the end of user speech to the first audio played. */
  timeToFirstAudioMs: number | null;
  /** Why the call ended, for spotting a pattern of failures. */
  endedBy: "caller" | "agent" | "error" | "shutdown";
  /** The reason the agent gave, when it was the one who hung up. */
  endReason?: string | null;
  /** Absent on records written before transcripts were kept. */
  transcript?: TranscriptLine[];
  events?: CallEvent[];
  /** Null when summarising is off, or when it failed. */
  summary?: CallSummary | null;
  /**
   * Which surface answered the call. Absent on every record written before
   * this field existed — read it through `readCallChannel`, never directly,
   * so an old or unrecognised value still reads as `"browser"`.
   */
  channel?: CallChannel;
  /** The numbers involved, when the call came in over the phone bridge. */
  phone?: { from: string; to: string } | null;
}

/**
 * One tool invocation, as the console shows it while a call is happening.
 *
 * Display-only: this is not part of a `CallRecord`, because the log is about
 * what a call cost, not a blow-by-blow of what it did.
 */
export interface ToolActivity {
  id: string;
  name: string;
  /** Silent tools are still shown here — the operator testing the agent should
   *  see everything it does, even what the caller is never told about. */
  silent: boolean;
  status: "running" | "ok" | "failed";
  durationMs: number | null;
}
