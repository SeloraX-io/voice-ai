/**
 * The call history table.
 *
 * A server component: nothing here is interactive beyond links, so there is no
 * reason to ship it to the browser.
 *
 * The columns are chosen for scanning, not completeness — when, how long, how
 * it ended, what it was about, what it cost. Token counts and latency live in
 * the detail view instead: nobody compares those across rows, and putting them
 * here crushed the one column people actually read.
 */

import Link from "next/link";

import { readCallChannel } from "@/lib/call-logs/channel";
import { BDT_PER_USD, formatBdt, formatUsd } from "@/lib/call-logs/pricing";
import type { CallRecord } from "@/lib/call-logs/types";

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

const ENDED: Record<CallRecord["endedBy"], { label: string; tone: string }> = {
  caller: { label: "Hung up", tone: "text-[var(--text-muted)]" },
  agent: { label: "Agent ended", tone: "text-[var(--warning)]" },
  error: { label: "Error", tone: "text-[var(--danger)]" },
  shutdown: { label: "Restart", tone: "text-[var(--text-dim)]" },
};

export function CallsTable({ calls }: { calls: CallRecord[] }) {
  // Summaries are billed on top of the calls, so a total that ignored them
  // would quietly under-report the spend.
  const totalUsd = calls.reduce(
    (sum, call) => sum + call.cost.totalUsd + (call.summary?.usd ?? 0),
    0,
  );
  const totalMs = calls.reduce((sum, call) => sum + call.durationMs, 0);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-[var(--text)]">Calls</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Every call, what it was about and what it cost. Select one to see its transcript and what
          the agent did.
        </p>
      </div>

      {calls.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)] px-4 py-6 text-center text-sm text-[var(--text-muted)]">
          No calls yet. Start one from <span className="text-[var(--text)]">Test agent</span> and it
          will appear here when it ends.
        </p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Calls" value={String(calls.length)} />
            <Stat label="Total time" value={formatDuration(totalMs)} />
            <Stat
              label="Estimated spend"
              value={formatBdt(totalUsd)}
              sub={formatUsd(totalUsd)}
              emphasis
            />
          </div>

          {/* Scrolls inside its own container so the page never scrolls sideways. */}
          <div className="scroll-slim overflow-x-auto rounded-xl border border-[var(--border)]">
            <table className="w-full min-w-[44rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--surface-2)]">
                  <Th>When</Th>
                  <Th numeric>Length</Th>
                  <Th numeric>Turns</Th>
                  <Th>Ended</Th>
                  <Th>Summary</Th>
                  <Th numeric>Cost</Th>
                </tr>
              </thead>
              <tbody>
                {calls.map((call) => {
                  const ended = ENDED[call.endedBy];
                  const callTotal = call.cost.totalUsd + (call.summary?.usd ?? 0);
                  const channel = readCallChannel(call.channel);

                  return (
                    <tr
                      key={call.id}
                      className="border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--surface-2)]"
                    >
                      <Td>
                        {/* A real link, so it can be middle-clicked or opened in
                            a new tab — a row with an onClick can do neither. */}
                        <Link
                          href={`/calls/${call.id}`}
                          className="block whitespace-nowrap underline-offset-2 hover:underline"
                        >
                          <span className="flex items-center gap-1.5">
                            <span className="font-medium text-[var(--text)]">
                              {formatDay(call.startedAt)}
                            </span>
                            <ChannelTag channel={channel} />
                          </span>
                          <span className="block text-xs text-[var(--text-dim)]">
                            {formatTime(call.startedAt)}
                          </span>
                        </Link>
                      </Td>

                      <Td numeric>{formatDuration(call.durationMs)}</Td>
                      <Td numeric>{call.turns}</Td>

                      <Td>
                        <span
                          className={`block whitespace-nowrap text-xs font-medium ${ended.tone}`}
                        >
                          {ended.label}
                        </span>
                        {call.endReason && (
                          <span className="mt-0.5 block max-w-[11rem] truncate text-[11px] text-[var(--text-dim)]">
                            {call.endReason}
                          </span>
                        )}
                      </Td>

                      {/* The widest column on purpose: it is the one people read. */}
                      <Td>
                        {call.summary ? (
                          <span className="line-clamp-2 max-w-[28rem] text-xs leading-relaxed text-[var(--text-muted)]">
                            {call.summary.text}
                          </span>
                        ) : (
                          <span className="text-xs text-[var(--text-dim)]">—</span>
                        )}
                      </Td>

                      <Td numeric>
                        <span className="block whitespace-nowrap font-semibold text-[var(--text)]">
                          {formatBdt(callTotal)}
                        </span>
                        <span className="block whitespace-nowrap text-[11px] text-[var(--text-dim)]">
                          {formatUsd(callTotal)}
                        </span>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="text-xs leading-relaxed text-[var(--text-dim)]">
            Estimated at this model&rsquo;s paid-tier rates — a key on the free tier is billed
            nothing. Google bills in US dollars; taka is converted at {BDT_PER_USD} to the dollar.
            The most recent 500 calls are kept in{" "}
            <code className="font-mono">data/call-logs.json</code>.
          </p>
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  emphasis,
}: {
  label: string;
  value: string;
  sub?: string;
  emphasis?: boolean;
}) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3">
      <p className="text-xs text-[var(--text-muted)]">{label}</p>
      <p
        className={`mt-1 font-mono tabular-nums ${
          emphasis ? "text-lg font-semibold text-[var(--text)]" : "text-base text-[var(--text)]"
        }`}
      >
        {value}
      </p>
      {sub && <p className="font-mono text-xs tabular-nums text-[var(--text-dim)]">{sub}</p>}
    </div>
  );
}

/**
 * A small tag by the date, not a column — the table is deliberately narrow
 * enough to fit without scrolling, and a call's channel is a detail, not
 * something worth scanning down its own column.
 */
function ChannelTag({ channel }: { channel: ReturnType<typeof readCallChannel> }) {
  const isPhone = channel === "phone";
  return (
    <span
      className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none ${
        isPhone
          ? "border-[var(--accent)] text-[var(--accent)]"
          : "border-[var(--border)] text-[var(--text-dim)]"
      }`}
    >
      {isPhone ? "Phone" : "Preview"}
    </span>
  );
}

function Th({ children, numeric }: { children: React.ReactNode; numeric?: boolean }) {
  return (
    <th
      scope="col"
      className={`whitespace-nowrap px-4 py-2.5 text-xs font-semibold text-[var(--text-muted)] ${
        numeric ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

function Td({ children, numeric }: { children: React.ReactNode; numeric?: boolean }) {
  return (
    <td
      className={`px-4 py-3 align-top text-[var(--text-muted)] ${
        numeric ? "text-right font-mono tabular-nums" : ""
      }`}
    >
      {children}
    </td>
  );
}
