/**
 * Writes the after-the-call summary.
 *
 * Runs once, after the call has already ended, so it can never delay a hang-up
 * or hold the socket open. It uses a cheap text model rather than the live one:
 * summarising is an ordinary request/response job and paying live-audio rates
 * for it would cost several times more.
 *
 * Never throws. A failed summary leaves the record without one, which is a
 * strictly better outcome than losing the record — the cost and transcript are
 * the parts that cannot be regenerated.
 */

import { GoogleGenAI } from "@google/genai";

import type { SummaryLanguage } from "../../lib/agent-config/schema";
import { summaryCostUsd } from "../../lib/call-logs/pricing";
import type { CallRecord, CallSummary, TranscriptLine } from "../../lib/call-logs/types";

/** Long transcripts are trimmed: the tail of a call is what a reviewer needs. */
const MAX_TRANSCRIPT_CHARS = 24_000;

const LANGUAGE_NAME: Record<SummaryLanguage, string> = {
  en: "English",
  bn: "Bangla (Bengali)",
};

function renderTranscript(lines: TranscriptLine[]): string {
  const rendered = lines
    .map((line) => `${line.speaker === "user" ? "Caller" : "Agent"}: ${line.text.trim()}`)
    .join("\n");

  if (rendered.length <= MAX_TRANSCRIPT_CHARS) return rendered;
  // Keep the end: how a call resolved matters more than how it opened.
  return `…(earlier turns omitted)\n${rendered.slice(-MAX_TRANSCRIPT_CHARS)}`;
}

const ENDING: Record<CallRecord["endedBy"], string> = {
  caller: "The caller hung up.",
  agent: "The agent ended the call.",
  error: "The call ended because of an error.",
  shutdown: "The call was cut off by a server restart.",
};

function prompt(
  lines: TranscriptLine[],
  language: SummaryLanguage,
  ending: string,
): string {
  return [
    `Summarise this customer support phone call in ${LANGUAGE_NAME[language]}.`,
    "",
    "Write it for someone reviewing the call later who was not on it. Cover:",
    "- why the caller rang",
    "- what the agent did, including anything it looked up or recorded",
    "- how it ended, and whether the caller's problem was actually resolved",
    "- anything that went wrong or would be worth following up",
    "",
    "Be concise and factual. Do not invent details that are not in the transcript.",
    "",
    // Without this the model reads a transcript that stops mid-flow and reports
    // the call as still ongoing, which is never true by the time this runs.
    `The call has already ended. ${ending}`,
    "If the caller's problem was left unresolved, say so plainly.",
    `Write only the summary itself, in ${LANGUAGE_NAME[language]}, with no preamble.`,
    "",
    "Transcript:",
    renderTranscript(lines),
  ].join("\n");
}

export async function summariseCall(
  lines: TranscriptLine[],
  options: {
    language: SummaryLanguage;
    model: string;
    apiKey: string;
    endedBy: CallRecord["endedBy"];
    endReason: string | null;
  },
): Promise<CallSummary | null> {
  // Nothing was said, so there is nothing to summarise — and an empty prompt
  // would still be billed.
  if (lines.length === 0) return null;

  try {
    const ai = new GoogleGenAI({ apiKey: options.apiKey });
    const response = await ai.models.generateContent({
      model: options.model,
      contents: prompt(
        lines,
        options.language,
        options.endReason
          ? `${ENDING[options.endedBy]} Reason given: ${options.endReason}.`
          : ENDING[options.endedBy],
      ),
    });

    const text = (response.text ?? "").trim();
    if (text === "") return null;

    const usage = response.usageMetadata;
    const inputTokens = usage?.promptTokenCount ?? 0;
    const outputTokens = usage?.candidatesTokenCount ?? 0;

    return {
      text,
      language: options.language,
      model: options.model,
      inputTokens,
      outputTokens,
      usd: summaryCostUsd(options.model, inputTokens, outputTokens),
    };
  } catch {
    return null;
  }
}
