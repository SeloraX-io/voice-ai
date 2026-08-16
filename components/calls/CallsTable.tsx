/**
 * The call history table.
 *
 * A server component: nothing here is interactive, so there is no reason to
 * ship it to the browser. Figures are estimates at paid-tier rates, and the
 * page says so once rather than repeating the caveat on every row.
 */

import { BDT_PER_USD, formatBdt, formatUsd } from "@/lib/call-logs/pricing";
import type { CallRecord } from "@/lib/call-logs/types";

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const ENDED_LABEL: Record<CallRecord["endedBy"], string> = {
  caller: "Hung up",
  agent: "Agent ended",
  error: "Error",
  shutdown: "Restart",
};

export function CallsTable({ calls }: { calls: CallRecord[] }) {
  const totalUsd = calls.reduce((sum, call) => sum + call.cost.totalUsd, 0);
  const totalMs = calls.reduce((sum, call) => sum + call.durationMs, 0);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-[var(--text)]">Calls</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          What each call cost, estimated at this model&rsquo;s paid-tier rates. A key on the free
          tier is billed nothing. Records are written when a call ends, and the most recent 500 are
          kept in <code className="font-mono text-xs">data/call-logs.json</code>. Google bills in US
          dollars; taka figures are converted at {BDT_PER_USD} BDT to the dollar.
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
            <Stat label="Estimated spend" value={formatBdt(totalUsd)} sub={formatUsd(totalUsd)} emphasis />
          </div>

          {/* The table scrolls inside its own container so the page never
              scrolls sideways on a narrow window. */}
          <div className="scroll-slim overflow-x-auto rounded-xl border border-[var(--border)]">
            <table className="w-full min-w-[46rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--surface-2)] text-left">
                  <Th>When</Th>
                  <Th>Duration</Th>
                  <Th numeric>Audio in</Th>
                  <Th numeric>Audio out</Th>
                  <Th numeric>Turns</Th>
                  <Th numeric>First audio</Th>
                  <Th>Ended</Th>
                  <Th numeric>Cost</Th>
                </tr>
              </thead>
              <tbody>
                {calls.map((call) => (
                  <tr key={call.id} className="border-b border-[var(--border)] last:border-0">
                    <Td>{formatWhen(call.startedAt)}</Td>
                    <Td numeric>{formatDuration(call.durationMs)}</Td>
                    <Td numeric>{call.usage.inputAudioTokens.toLocaleString()}</Td>
                    <Td numeric>{call.usage.outputAudioTokens.toLocaleString()}</Td>
                    <Td numeric>{call.turns}</Td>
                    <Td numeric>
                      {call.timeToFirstAudioMs === null
                        ? "—"
                        : `${Math.round(call.timeToFirstAudioMs)} ms`}
                    </Td>
                    <Td>
                      <span
                        className={
                          call.endedBy === "error"
                            ? "text-[var(--danger)]"
                            : "text-[var(--text-muted)]"
                        }
                      >
                        {ENDED_LABEL[call.endedBy]}
                      </span>
                      {/* Why the agent hung up is the one thing worth knowing
                          when reviewing a call it ended itself. */}
                      {call.endReason && (
                        <span className="block max-w-[16rem] truncate text-[11px] text-[var(--text-dim)]">
                          {call.endReason}
                        </span>
                      )}
                    </Td>
                    <Td numeric>
                      <span className="block font-semibold text-[var(--text)]">
                        {formatBdt(call.cost.totalUsd)}
                      </span>
                      <span className="block text-[11px] text-[var(--text-dim)]">
                        {formatUsd(call.cost.totalUsd)}
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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

function Th({ children, numeric }: { children: React.ReactNode; numeric?: boolean }) {
  return (
    <th
      scope="col"
      className={`px-4 py-2.5 text-xs font-semibold text-[var(--text-muted)] ${
        numeric ? "text-right" : ""
      }`}
    >
      {children}
    </th>
  );
}

function Td({ children, numeric }: { children: React.ReactNode; numeric?: boolean }) {
  return (
    <td
      className={`px-4 py-2.5 text-[var(--text-muted)] ${
        numeric ? "text-right font-mono tabular-nums" : ""
      }`}
    >
      {children}
    </td>
  );
}
