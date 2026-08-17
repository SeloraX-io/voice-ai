"use client";

import { useState } from "react";
import { AlertTriangle, ChevronRight } from "lucide-react";

import { CallStats } from "@/components/voice/CallStats";
import { ConnectionStatus } from "@/components/voice/ConnectionStatus";
import { ToolActivity } from "@/components/preview/ToolActivity";
import { Transcript } from "@/components/voice/Transcript";
import { VoiceControls } from "@/components/voice/VoiceControls";
import { VoiceOrb } from "@/components/voice/VoiceOrb";
import { VoiceWaveform } from "@/components/voice/VoiceWaveform";
import type { VoiceSessionController } from "@/hooks/useVoiceSession";
import { BDT_PER_USD, formatBdt, formatUsd } from "@/lib/call-logs/pricing";
import type { VoiceStatus } from "@/lib/gemini/types";
import { cn } from "@/lib/utils";

const HEADLINE: Record<VoiceStatus, string> = {
  idle: "Ready to talk",
  connecting: "Connecting…",
  listening: "Listening",
  thinking: "Thinking…",
  speaking: "Speaking",
  interrupted: "Go ahead",
  error: "Something went wrong",
};

/**
 * The body of the preview panel: orb, waveform, controls, transcript, and a
 * collapsible developer detail section. Purely presentational — it composes
 * the existing voice components around a `VoiceSessionController` it is
 * handed, rather than owning any call state itself.
 */
export function PreviewSession({
  voice,
  onStart,
}: {
  voice: VoiceSessionController;
  onStart: () => void;
}) {
  const [sessionOpen, setSessionOpen] = useState(false);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-col items-center rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-6">
        <VoiceOrb status={voice.status} levels={voice.levels} />
        <p className="mt-3 text-base font-medium text-[var(--text)]">{HEADLINE[voice.status]}</p>
        <div className="mt-4 w-full">
          <VoiceWaveform status={voice.status} levels={voice.levels} />
        </div>
        <div className="mt-5">
          <VoiceControls
            status={voice.status}
            muted={voice.muted}
            onStart={onStart}
            onStop={voice.stop}
            onToggleMute={voice.toggleMute}
          />
        </div>
      </div>

      {voice.error && (
        <p
          role="alert"
          className="animate-fade-rise flex items-start gap-2.5 rounded-xl border border-[var(--danger)]/35 bg-[var(--danger)]/10 px-4 py-3 text-sm text-[var(--danger)]"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{voice.error}</span>
        </p>
      )}

      {/* Above the transcript, because a tool call is the explanation for a gap
          in it — seeing it after the fact is much less useful. */}
      <ToolActivity entries={voice.toolActivity} />

      <div className="min-h-0 flex-1 overflow-auto">
        <Transcript
          entries={voice.transcript}
          status={voice.status}
          onClear={voice.clearTranscript}
        />
      </div>

      <div>
        <button
          type="button"
          onClick={() => setSessionOpen((value) => !value)}
          aria-expanded={sessionOpen}
          className="inline-flex items-center gap-1 text-xs font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
        >
          <ChevronRight className={cn("size-3.5 transition-transform", sessionOpen && "rotate-90")} />
          Session
        </button>
        {sessionOpen && (
          <div className="mt-2 flex flex-col gap-3">
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] px-5 py-3">
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-xs text-[var(--text-muted)]">Estimated cost</span>
                <span className="text-right">
                  {/* An em dash, not a zero — before the first usage report we do
                      not know the cost, and zero would read as "this was free". */}
                  <span className="block font-mono text-sm font-semibold tabular-nums text-[var(--text)]">
                    {voice.costUsd === null ? "—" : formatBdt(voice.costUsd)}
                  </span>
                  {voice.costUsd !== null && (
                    // Google bills in dollars; taka is a conversion, so the
                    // source figure stays visible rather than being replaced.
                    <span className="block font-mono text-[11px] tabular-nums text-[var(--text-dim)]">
                      {formatUsd(voice.costUsd)}
                    </span>
                  )}
                </span>
              </div>
              {voice.usage && (
                <p className="mt-1 font-mono text-[11px] tabular-nums text-[var(--text-dim)]">
                  in {voice.usage.inputAudioTokens.toLocaleString()} audio ·{" "}
                  {voice.usage.inputTextTokens.toLocaleString()} text — out{" "}
                  {voice.usage.outputAudioTokens.toLocaleString()} audio
                </p>
              )}
              <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--text-dim)]">
                At paid-tier rates for this model, converted at {BDT_PER_USD} BDT to the dollar. A key on the free tier is billed nothing.
              </p>
            </div>

            <ConnectionStatus
              status={voice.status}
              session={voice.session}
              metrics={voice.metrics}
            />
            <CallStats metrics={voice.metrics} session={voice.session} />
          </div>
        )}
      </div>
    </div>
  );
}
