"use client";

import { Check, Loader2, X } from "lucide-react";

import type { ToolActivity as ToolActivityEntry } from "@/lib/call-logs/types";
import { cn } from "@/lib/utils";

/**
 * What the agent is doing, above what it is saying.
 *
 * A tool call is invisible in a transcript — the agent goes quiet, then answers
 * with information it did not have before. This shows the step in between, so a
 * pause reads as "looking something up" rather than as the call having stalled.
 *
 * Newest first: during a call the thing that just happened is what you are
 * looking for, and it stays put at the top instead of the list growing away.
 */
export function ToolActivity({ entries }: { entries: ToolActivityEntry[] }) {
  if (entries.length === 0) return null;

  const running = entries.filter((entry) => entry.status === "running").length;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--text-dim)]">
          Actions
        </span>
        {running > 0 && (
          <span className="text-[11px] text-[var(--text-muted)]">
            {running} running
          </span>
        )}
      </div>

      <ul className="flex flex-col gap-1">
        {[...entries].reverse().map((entry) => (
          <li key={entry.id} className="flex items-center gap-2 text-xs">
            <StatusIcon status={entry.status} />

            <span className="truncate font-mono text-[var(--text)]">{entry.name}</span>

            {entry.silent && (
              // Worth flagging: the caller was told nothing about this one.
              <span className="shrink-0 rounded bg-[var(--surface-3)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-dim)]">
                silent
              </span>
            )}

            <span className="ml-auto shrink-0 font-mono tabular-nums text-[11px] text-[var(--text-dim)]">
              {entry.status === "running"
                ? "calling…"
                : entry.durationMs === null
                  ? ""
                  : `${entry.durationMs} ms`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatusIcon({ status }: { status: ToolActivityEntry["status"] }) {
  if (status === "running") {
    return (
      <Loader2
        aria-label="Calling"
        className="size-3.5 shrink-0 animate-spin text-[var(--text-muted)]"
      />
    );
  }
  const ok = status === "ok";
  const Icon = ok ? Check : X;
  return (
    <Icon
      aria-label={ok ? "Succeeded" : "Failed"}
      className={cn("size-3.5 shrink-0", ok ? "text-[var(--success)]" : "text-[var(--danger)]")}
    />
  );
}
