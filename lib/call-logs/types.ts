/**
 * What one call cost, and what it spent to get there.
 *
 * Pure types, shared by the gateway that records a call and the browser that
 * displays it, so neither side can drift from the other's idea of a record.
 */

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
}
