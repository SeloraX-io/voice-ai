/**
 * What Gemini charges, and what a call therefore cost.
 *
 * Rates are data rather than arithmetic buried in a component, because they
 * change: when Google reprices a model, this table is the only edit. Every
 * figure the app shows — the running total during a call and the logged total
 * afterwards — comes from `computeCost`, so the two can never disagree.
 *
 * Prices are US dollars per million tokens, taken from
 * https://ai.google.dev/gemini-api/docs/pricing on 2026-08-16, paid tier.
 * A key on the free tier is billed nothing; every figure here is an ESTIMATE
 * at paid-tier rates and the UI must say so.
 */

import { EMPTY_USAGE, type CallCost, type CallUsage } from "./types";

export interface ModelRates {
  inputTextPerMillion: number;
  inputAudioPerMillion: number;
  outputTextPerMillion: number;
  outputAudioPerMillion: number;
}

export const DEFAULT_RATES: Record<string, ModelRates> = {
  "gemini-3.1-flash-live-preview": {
    inputTextPerMillion: 0.75,
    inputAudioPerMillion: 3.0,
    outputTextPerMillion: 4.5,
    outputAudioPerMillion: 12.0,
  },
  "gemini-2.5-flash-native-audio-preview-12-2025": {
    inputTextPerMillion: 0.5,
    inputAudioPerMillion: 3.0,
    outputTextPerMillion: 2.0,
    outputAudioPerMillion: 12.0,
  },
};

/** The model the app ships with, and the fallback for anything unrecognised. */
const FALLBACK_MODEL = "gemini-3.1-flash-live-preview";

/**
 * Rates for a model.
 *
 * An unknown model falls back to the shipped live model rather than to zero:
 * a wrong estimate is visible and arguable, whereas a silent $0.00 reads as
 * "this call was free" and would hide the cost entirely.
 */
export function ratesFor(model: string): ModelRates {
  return DEFAULT_RATES[model] ?? DEFAULT_RATES[FALLBACK_MODEL];
}

export function computeCost(usage: CallUsage, rates: ModelRates): CallCost {
  const perMillion = (tokens: number, rate: number) => (tokens / 1_000_000) * rate;

  const inputUsd =
    perMillion(usage.inputTextTokens, rates.inputTextPerMillion) +
    perMillion(usage.inputAudioTokens, rates.inputAudioPerMillion);

  const outputUsd =
    perMillion(usage.outputTextTokens, rates.outputTextPerMillion) +
    perMillion(usage.outputAudioTokens, rates.outputAudioPerMillion);

  return { inputUsd, outputUsd, totalUsd: inputUsd + outputUsd };
}

/** The subset of Gemini's UsageMetadata this reads, kept structural so the
 *  gateway can pass the SDK object straight in without a cast. */
interface ModalityCount {
  modality?: string;
  tokenCount?: number;
}
export interface UsageReport {
  promptTokensDetails?: ModalityCount[];
  responseTokensDetails?: ModalityCount[];
}

function sumModality(details: ModalityCount[] | undefined, wanted: "TEXT" | "AUDIO"): number {
  if (!details) return 0;
  return details.reduce((total, entry) => {
    // The API documents an unspecified modality as meaning text.
    const modality = entry.modality === "MODALITY_UNSPECIFIED" ? "TEXT" : entry.modality;
    if (modality !== wanted) return total;
    return total + (entry.tokenCount ?? 0);
  }, 0);
}

/**
 * Folds one usage report into the running total for a call.
 *
 * Each report is treated as a CUMULATIVE session total that replaces the
 * previous figure, not a delta that adds to it — summing cumulative reports
 * would bill a long call several times over.
 *
 * What was actually observed, against gemini-3.1-flash-live-preview: exactly
 * one report per call, in calls of one and of three turns. Its prompt-token
 * count (5,579) far exceeds any single turn and matches the whole session's
 * context, which is what a running total looks like and not what a per-turn
 * delta looks like. A second report was never seen, so the multi-report path
 * is reasoned rather than exercised — `CallUsage.reports` exists to make that
 * visible if the assumption ever proves wrong.
 *
 * `Math.max` additionally means a late or duplicated frame can never reduce a
 * total, so the result does not depend on delivery order.
 */
export function usageFromReport(report: UsageReport, current: CallUsage = EMPTY_USAGE): CallUsage {
  return {
    inputTextTokens: Math.max(current.inputTextTokens, sumModality(report.promptTokensDetails, "TEXT")),
    inputAudioTokens: Math.max(
      current.inputAudioTokens,
      sumModality(report.promptTokensDetails, "AUDIO"),
    ),
    outputTextTokens: Math.max(
      current.outputTextTokens,
      sumModality(report.responseTokensDetails, "TEXT"),
    ),
    outputAudioTokens: Math.max(
      current.outputAudioTokens,
      sumModality(report.responseTokensDetails, "AUDIO"),
    ),
    reports: current.reports + 1,
  };
}

/** Formats a cost for display. Sub-cent calls still need to read as non-zero. */
export function formatUsd(amount: number): string {
  if (amount === 0) return "$0.00";
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

/**
 * Taka per US dollar.
 *
 * Google bills in dollars, so this is a display conversion applied at the last
 * moment — every stored figure stays in USD. Keeping it that way means a rate
 * change re-reads history correctly instead of leaving old records converted at
 * a rate nobody recorded. Edit this one number when the rate moves.
 */
export const BDT_PER_USD = 130;

export function usdToBdt(usd: number): number {
  return usd * BDT_PER_USD;
}

/** Formats a cost in taka. Short calls land under ৳1, so they keep more digits. */
export function formatBdt(usd: number): string {
  const taka = usdToBdt(usd);
  if (taka === 0) return "৳0.00";
  if (taka < 0.01) return `৳${taka.toFixed(4)}`;
  return `৳${taka.toFixed(2)}`;
}
