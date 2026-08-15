"use client";

import { useState } from "react";
import { Activity, ChevronDown } from "lucide-react";

import type { CallMetrics } from "@/lib/gemini/types";
import { cn, formatMs } from "@/lib/utils";
import type { SessionInfo } from "@/types/voice";

interface CallStatsProps {
  metrics: CallMetrics;
  session: SessionInfo | null;
}

/**
 * Developer latency panel. The headline number is time-to-first-audio, measured
 * from the acoustic end of the customer's speech to the first sample leaving
 * the speakers — including the OS output buffer.
 */
export function CallStats({ metrics, session }: CallStatsProps) {
  const [open, setOpen] = useState(false);

  return (
    <section className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] backdrop-blur-xl">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-[var(--surface-3)]"
      >
        <Activity className="size-4 text-[var(--accent)]" />
        <span className="text-sm font-semibold text-[var(--text)]">Latency</span>

        <span className="ml-auto flex items-center gap-4 font-mono text-xs">
          <Headline label="TTFA" value={formatMs(metrics.timeToFirstAudioMs)} highlight />
          <Headline label="RTT" value={formatMs(metrics.roundTripMs)} />
          <ChevronDown
            className={cn(
              "size-4 text-[var(--text-muted)] transition-transform",
              open && "rotate-180",
            )}
          />
        </span>
      </button>

      {open && (
        <div className="grid gap-x-8 gap-y-1 border-t border-[var(--border)] px-5 py-4 sm:grid-cols-2">
          <Group title="Session start-up">
            <Row label="WebSocket connect" value={formatMs(metrics.wsConnectMs)} />
            <Row label="Gemini Live connect" value={formatMs(metrics.geminiConnectMs)} />
            <Row label="Microphone + worklet" value={formatMs(metrics.micStartMs)} />
            <Row label="Click → listening" value={formatMs(metrics.sessionReadyMs)} />
          </Group>

          <Group title="Last response">
            <Row label="First Gemini event" value={formatMs(metrics.firstResponseMs)} />
            <Row label="First audio chunk" value={formatMs(metrics.firstAudioChunkMs)} />
            <Row
              label="Time to first audio"
              value={formatMs(metrics.timeToFirstAudioMs)}
              highlight
            />
            <Row label="Response duration" value={formatMs(metrics.responseDurationMs)} />
          </Group>

          <Group title="Turn taking">
            <Row label="Interruption latency" value={formatMs(metrics.interruptionLatencyMs)} />
            <Row label="Turns completed" value={String(metrics.turns)} />
            <Row label="Interruptions" value={String(metrics.interruptions)} />
            <Row label="WebSocket round trip" value={formatMs(metrics.roundTripMs)} />
          </Group>

          <Group title="Pipeline">
            <Row label="Capture" value={`${(session?.inputSampleRate ?? 16000) / 1000} kHz PCM16`} />
            <Row label="Playback" value={`${(session?.outputSampleRate ?? 24000) / 1000} kHz PCM16`} />
            <Row label="Voice" value={session?.voice ?? "—"} />
            <Row label="Session" value={session ? session.sessionId.slice(0, 8) : "—"} />
          </Group>

          <p className="col-span-full mt-3 text-[11px] leading-relaxed text-[var(--text-dim)]">
            Response timings are measured from the acoustic end of your speech (the gateway&apos;s
            VAD debounce is subtracted), and time-to-first-audio includes the operating
            system&apos;s output buffer.
          </p>
        </div>
      )}
    </section>
  );
}

function Headline({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-[var(--text-dim)]">{label}</span>
      <span className={highlight ? "text-[var(--accent)]" : "text-[var(--text-muted)]"}>
        {value}
      </span>
    </span>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="py-2">
      <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-dim)]">
        {title}
      </h3>
      <dl className="space-y-1">{children}</dl>
    </div>
  );
}

function Row({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-xs">
      <dt className="text-[var(--text-muted)]">{label}</dt>
      <dd
        className={cn(
          "font-mono tabular-nums",
          highlight ? "text-[var(--accent)]" : "text-[var(--text)]",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
