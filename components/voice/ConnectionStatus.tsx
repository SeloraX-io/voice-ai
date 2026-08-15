"use client";

import type { CallMetrics, VoiceStatus } from "@/lib/gemini/types";
import { cn, formatMs } from "@/lib/utils";
import type { SessionInfo } from "@/types/voice";

interface ConnectionStatusProps {
  status: VoiceStatus;
  session: SessionInfo | null;
  metrics: CallMetrics;
}

const CONNECTION_LABEL: Record<VoiceStatus, { label: string; tone: string }> = {
  idle: { label: "Disconnected", tone: "var(--text-dim)" },
  connecting: { label: "Connecting", tone: "var(--warning)" },
  listening: { label: "Connected", tone: "var(--success)" },
  thinking: { label: "Connected", tone: "var(--success)" },
  speaking: { label: "Connected", tone: "var(--success)" },
  interrupted: { label: "Connected", tone: "var(--success)" },
  error: { label: "Error", tone: "var(--danger)" },
};

export function ConnectionStatus({ status, session, metrics }: ConnectionStatusProps) {
  const connection = CONNECTION_LABEL[status];
  const live = status !== "idle" && status !== "error";

  return (
    <dl className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] px-5 py-3 text-xs backdrop-blur-xl">
      <Item label="Connection">
        <span className="flex items-center gap-1.5" style={{ color: connection.tone }}>
          <span
            className={cn(
              "size-1.5 rounded-full",
              status === "connecting" && "[animation:status-pulse_1s_ease-in-out_infinite]",
            )}
            style={{ background: connection.tone }}
          />
          {connection.label}
        </span>
      </Item>

      <Item label="Latency">
        <span className="font-mono">{formatMs(metrics.roundTripMs)}</span>
      </Item>

      <Item label="Audio">
        <span className="font-mono">
          {(session?.inputSampleRate ?? 16000) / 1000}kHz PCM →{" "}
          {(session?.outputSampleRate ?? 24000) / 1000}kHz
        </span>
      </Item>

      <Item label="Gemini Live">
        <span style={{ color: live ? "var(--success)" : "var(--text-dim)" }}>
          {live ? "Active" : "Idle"}
        </span>
      </Item>

      {session && (
        <Item label="Model">
          <span className="font-mono text-[var(--text-muted)]">{session.model}</span>
        </Item>
      )}
    </dl>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <dt className="text-[var(--text-dim)]">{label}:</dt>
      <dd className="font-medium text-[var(--text)]">{children}</dd>
    </div>
  );
}
