/**
 * Everything recorded about one call.
 *
 * Ordered by what a person debugging actually reaches for: the summary first
 * because it answers "what happened" in a sentence, then the timeline of what
 * the agent did, then the conversation itself, and the cost breakdown last —
 * that one is a lookup, not a read.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { readCallChannel } from "@/lib/call-logs/channel";
import { formatBdt, formatUsd } from "@/lib/call-logs/pricing";
import type { CallEvent, CallRecord } from "@/lib/call-logs/types";

const ENDED_LABEL: Record<CallRecord["endedBy"], string> = {
  caller: "The caller hung up",
  agent: "The agent ended the call",
  error: "Ended by an error",
  shutdown: "Ended by a server restart",
};

const EVENT_LABEL: Record<CallEvent["kind"], string> = {
  connected: "Connected",
  greeting: "Greeting",
  tool_call: "Tool called",
  tool_result: "Tool returned",
  interrupted: "Interrupted",
  agent_ending: "Agent ended the call",
  error: "Error",
  ended: "Call ended",
};

function stamp(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * "from X to Y" for a phone call, with either half allowed to be missing.
 *
 * A withheld caller ID is ordinary, and it does not stop the dialled number
 * being worth showing — so each side is rendered on its own merits, and only a
 * call with neither number says nothing at all.
 */
function numbers(phone: CallRecord["phone"]): string {
  if (!phone) return "";
  const parts = [phone.from ? `from ${phone.from}` : "", phone.to ? `to ${phone.to}` : ""].filter(
    (part) => part !== "",
  );
  return parts.length === 0 ? "" : ` · ${parts.join(" ")}`;
}

export function CallDetail({ call }: { call: CallRecord }) {
  const transcript = call.transcript ?? [];
  const events = call.events ?? [];
  // The summary is billed on top of the call, so the two are shown separately
  // and then added, rather than presenting one blended number.
  const totalUsd = call.cost.totalUsd + (call.summary?.usd ?? 0);
  const channel = readCallChannel(call.channel);

  return (
    <div className="flex flex-col gap-7">
      <div>
        <Link
          href="/calls"
          className="inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
        >
          <ArrowLeft className="size-4" />
          All calls
        </Link>

        <h1 className="mt-3 flex items-center gap-2 text-lg font-semibold tracking-tight text-[var(--text)]">
          {new Date(call.startedAt).toLocaleString()}
          <span
            className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none ${
              channel === "phone"
                ? "border-[var(--accent)] text-[var(--accent)]"
                : "border-[var(--border)] text-[var(--text-dim)]"
            }`}
          >
            {channel === "phone" ? "Phone" : "Preview"}
          </span>
        </h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          {stamp(call.durationMs)} · {call.turns} turn{call.turns === 1 ? "" : "s"} ·{" "}
          {ENDED_LABEL[call.endedBy]}
          {call.endReason ? ` — “${call.endReason}”` : ""}
          {numbers(call.phone)}
        </p>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-[var(--text)]">Summary</h2>
        {call.summary ? (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--text)]">
              {call.summary.text}
            </p>
            <p className="mt-3 text-[11px] text-[var(--text-dim)]">
              Written by {call.summary.model} in{" "}
              {call.summary.language === "bn" ? "Bangla" : "English"} ·{" "}
              {formatBdt(call.summary.usd)} ({formatUsd(call.summary.usd)})
            </p>
          </div>
        ) : (
          <p className="rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)] px-4 py-3 text-xs text-[var(--text-muted)]">
            No summary for this call. Either summarising was switched off, there was nothing said,
            or the summariser failed — older calls predate the feature entirely.
          </p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-[var(--text)]">What happened</h2>
        {events.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)] px-4 py-3 text-xs text-[var(--text-muted)]">
            No events recorded — this call predates event logging.
          </p>
        ) : (
          <ol className="flex flex-col gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
            {events.map((event, index) => (
              <li key={`${event.atMs}-${index}`} className="flex gap-3 text-xs">
                <span className="shrink-0 font-mono tabular-nums text-[var(--text-dim)]">
                  {stamp(event.atMs)}
                </span>
                <span
                  className={
                    event.kind === "error"
                      ? "shrink-0 font-medium text-[var(--danger)]"
                      : "shrink-0 font-medium text-[var(--text)]"
                  }
                >
                  {EVENT_LABEL[event.kind]}
                </span>
                {event.detail && (
                  <span className="min-w-0 text-[var(--text-muted)]">{event.detail}</span>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-[var(--text)]">Transcript</h2>
        {transcript.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)] px-4 py-3 text-xs text-[var(--text-muted)]">
            No transcript. Either transcripts were switched off for this call, or it predates them
            being recorded.
          </p>
        ) : (
          <div className="flex flex-col gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
            {transcript.map((line, index) => (
              <div key={`${line.atMs}-${index}`} className="flex gap-3">
                <span className="w-10 shrink-0 pt-0.5 font-mono text-[11px] tabular-nums text-[var(--text-dim)]">
                  {stamp(line.atMs)}
                </span>
                <span
                  className={`w-14 shrink-0 pt-0.5 text-[11px] font-semibold uppercase tracking-wide ${
                    line.speaker === "user" ? "text-[var(--accent)]" : "text-[var(--accent-2)]"
                  }`}
                >
                  {line.speaker === "user" ? "Caller" : "Agent"}
                </span>
                <span className="min-w-0 text-sm leading-relaxed text-[var(--text)]">
                  {line.text.trim()}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-[var(--text)]">Cost and usage</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Facts
            title="Tokens"
            rows={[
              ["Audio in", call.usage.inputAudioTokens.toLocaleString()],
              ["Text in", call.usage.inputTextTokens.toLocaleString()],
              ["Audio out", call.usage.outputAudioTokens.toLocaleString()],
              ["Text out", call.usage.outputTextTokens.toLocaleString()],
              ["Usage reports", String(call.usage.reports)],
            ]}
          />
          <Facts
            title="Cost"
            rows={[
              ["Call input", formatUsd(call.cost.inputUsd)],
              ["Call output", formatUsd(call.cost.outputUsd)],
              ["Summary", call.summary ? formatUsd(call.summary.usd) : "—"],
              ["Total", `${formatBdt(totalUsd)} (${formatUsd(totalUsd)})`],
            ]}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Facts
            title="Session"
            rows={[
              ["Model", call.model],
              ["Voice", call.voice],
              ["Interruptions", String(call.interruptions)],
              [
                "First audio",
                call.timeToFirstAudioMs === null
                  ? "—"
                  : `${Math.round(call.timeToFirstAudioMs)} ms`,
              ],
            ]}
          />
        </div>
      </section>
    </div>
  );
}

function Facts({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--text-dim)]">
        {title}
      </p>
      <dl className="flex flex-col gap-1.5">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-4 text-xs">
            <dt className="text-[var(--text-muted)]">{label}</dt>
            <dd className="truncate font-mono tabular-nums text-[var(--text)]">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
