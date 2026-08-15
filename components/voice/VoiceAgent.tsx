"use client";

import { useState } from "react";
import { AlertTriangle, AudioLines, Radio, Settings2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AudioUploader } from "@/components/voice/AudioUploader";
import { CallStats } from "@/components/voice/CallStats";
import { ConnectionStatus } from "@/components/voice/ConnectionStatus";
import { Transcript } from "@/components/voice/Transcript";
import { VoiceControls } from "@/components/voice/VoiceControls";
import { VoiceOrb } from "@/components/voice/VoiceOrb";
import { VoiceWaveform } from "@/components/voice/VoiceWaveform";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useVoiceSession } from "@/hooks/useVoiceSession";
import type { VoiceStatus } from "@/lib/gemini/types";

const HEADLINE: Record<VoiceStatus, string> = {
  idle: "Ready to talk",
  connecting: "Connecting…",
  listening: "Listening",
  thinking: "Thinking…",
  speaking: "Speaking",
  interrupted: "Go ahead",
  error: "Something went wrong",
};

export function VoiceAgent() {
  const voice = useVoiceSession();
  const [showSettings, setShowSettings] = useState(false);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-5 pb-12">
      <header className="flex items-center justify-between py-6">
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-lg bg-[var(--accent)] text-[var(--accent-contrast)]">
            <AudioLines className="size-4" />
          </span>
          <span className="text-sm font-semibold tracking-tight text-[var(--text)]">
            AI Voice Agent
          </span>
        </div>

        <div className="flex items-center gap-1">
          <ThemeToggle />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowSettings((value) => !value)}
            aria-expanded={showSettings}
          >
            <Settings2 />
            Settings
          </Button>
        </div>
      </header>

      {showSettings && (
        <div className="animate-fade-rise mb-6 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-5 text-sm">
          <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--text-dim)]">
            Session configuration
          </h2>
          <dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
            <Setting label="Model" value={voice.session?.model ?? "gemini-3.1-flash-live-preview"} />
            <Setting label="Voice" value={voice.session?.voice ?? "Kore"} />
            <Setting label="Capture" value="16 kHz mono PCM16 · 30 ms chunks" />
            <Setting label="Playback" value="24 kHz mono PCM16 · scheduled" />
            <Setting label="Turn taking" value="Gemini server-side VAD" />
            <Setting label="Transport" value="Persistent WebSocket" />
          </dl>
          <p className="mt-4 text-xs leading-relaxed text-[var(--text-dim)]">
            The agent persona and the Gemini API key live on the voice gateway. Nothing sensitive is
            sent to the browser — edit{" "}
            <code className="rounded bg-[var(--surface-3)] px-1 py-0.5 font-mono">
              server/voice/agent-config.ts
            </code>{" "}
            to change how the agent behaves.
          </p>
        </div>
      )}

      <Tabs defaultValue="live" className="flex flex-1 flex-col">
        <div className="flex justify-center">
          <TabsList>
            <TabsTrigger value="live">
              <Radio className="size-3.5" />
              Live Voice
            </TabsTrigger>
            <TabsTrigger value="upload">
              <AudioLines className="size-3.5" />
              Upload Audio
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="live" className="mt-8 flex flex-1 flex-col gap-6">
          <section className="flex flex-col items-center rounded-3xl border border-[var(--border)] bg-[var(--surface-2)] px-6 py-10 backdrop-blur-xl">
            <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-[var(--text-dim)]">
              AI Customer Agent
            </p>

            <div className="mt-6">
              <VoiceOrb status={voice.status} levels={voice.levels} />
            </div>

            <p className="mt-4 text-lg font-medium text-[var(--text)]">{HEADLINE[voice.status]}</p>

            <div className="mt-6 w-full max-w-lg">
              <VoiceWaveform status={voice.status} levels={voice.levels} />
            </div>

            <div className="mt-8">
              <VoiceControls
                status={voice.status}
                muted={voice.muted}
                onStart={voice.start}
                onStop={voice.stop}
                onToggleMute={voice.toggleMute}
              />
            </div>
          </section>

          {voice.error && (
            <p
              role="alert"
              className="animate-fade-rise flex items-start gap-2.5 rounded-2xl border border-[var(--danger)]/35 bg-[var(--danger)]/10 px-5 py-4 text-sm text-[var(--danger)]"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>{voice.error}</span>
            </p>
          )}

          <Transcript
            entries={voice.transcript}
            status={voice.status}
            onClear={voice.clearTranscript}
          />

          <ConnectionStatus
            status={voice.status}
            session={voice.session}
            metrics={voice.metrics}
          />

          <CallStats metrics={voice.metrics} session={voice.session} />
        </TabsContent>

        <TabsContent value="upload" className="mt-8">
          <AudioUploader />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Setting({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-[var(--text-muted)]">{label}</dt>
      <dd className="truncate font-mono text-xs text-[var(--text)]">{value}</dd>
    </div>
  );
}
