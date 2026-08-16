"use client";

import { useState } from "react";
import { AlertTriangle, ChevronRight } from "lucide-react";

import { CallStats } from "@/components/voice/CallStats";
import { ConnectionStatus } from "@/components/voice/ConnectionStatus";
import { Transcript } from "@/components/voice/Transcript";
import { VoiceControls } from "@/components/voice/VoiceControls";
import { VoiceOrb } from "@/components/voice/VoiceOrb";
import { VoiceWaveform } from "@/components/voice/VoiceWaveform";
import type { VoiceSessionController } from "@/hooks/useVoiceSession";
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
