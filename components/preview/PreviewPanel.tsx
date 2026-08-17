"use client";

import { useState } from "react";

import { PreviewSession } from "@/components/preview/PreviewSession";
import { Button } from "@/components/ui/button";
import type { VoiceSessionController } from "@/hooks/useVoiceSession";
import { needsSaveChoice, settingsChangedDuringCall } from "@/lib/agent-config/preview-hints";

/** Elapsed call time, shown in the header while a call is running. */
function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/**
 * The always-visible column for talking to the agent, mounted by the console
 * chrome rather than by a page.
 *
 * It has no open or closed state: the point of keeping it on screen is that a
 * configuration change and the call testing it are visible at once. The voice
 * session itself lives above this component, so navigating between screens
 * never interrupts a call.
 */
export function PreviewPanel({
  voice,
  onStart,
  agentName,
  dirty,
  callStartedWith,
  currentUpdatedAt,
  callActive,
  callSeconds,
  onSaveAndStart,
}: {
  voice: VoiceSessionController;
  onStart: () => void;
  agentName: string;
  dirty: boolean;
  callStartedWith: string | null;
  currentUpdatedAt: string;
  callActive: boolean;
  callSeconds: number;
  onSaveAndStart: () => void;
}) {
  const [choosing, setChoosing] = useState(false);

  const requestStart = () => {
    if (needsSaveChoice(dirty)) {
      setChoosing(true);
      return;
    }
    onStart();
  };

  return (
    <aside
      aria-label="Test agent"
      className="flex w-full shrink-0 flex-col border-t border-[var(--border)] bg-[var(--surface)] lg:w-[420px] lg:border-l lg:border-t-0"
    >
      <header className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
        <span className="truncate text-sm font-semibold text-[var(--text)]">{agentName}</span>
        {callActive && (
          <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-xs text-[var(--text-muted)]">
            <span className="size-2 rounded-full bg-[var(--success)] [animation:status-pulse_1.6s_ease-in-out_infinite]" />
            <span className="tabular-nums">{formatElapsed(callSeconds)}</span>
          </span>
        )}
      </header>

      {settingsChangedDuringCall(callStartedWith, currentUpdatedAt) && (
        <p className="mx-4 mt-4 rounded-xl bg-[var(--surface-3)] px-4 py-2.5 text-xs text-[var(--text-muted)]">
          Settings saved — restart the call to hear them.
        </p>
      )}

      {choosing && (
        <div className="mx-4 mt-4 rounded-xl border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-4">
          <p className="text-sm text-[var(--text)]">
            You have unsaved changes. A test call uses the last saved settings.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setChoosing(false);
                onSaveAndStart();
              }}
            >
              Save and test
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setChoosing(false);
                onStart();
              }}
            >
              Test last saved
            </Button>
            {/* The panel no longer closes, so this is the only way out of the
                choice without starting a call. */}
            <Button variant="ghost" size="sm" onClick={() => setChoosing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col p-4">
        <PreviewSession voice={voice} onStart={requestStart} />
      </div>
    </aside>
  );
}
