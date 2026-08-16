"use client";

import { useState } from "react";
import { X } from "lucide-react";

import { PreviewSession } from "@/components/preview/PreviewSession";
import { Button } from "@/components/ui/button";
import type { VoiceSessionController } from "@/hooks/useVoiceSession";
import { needsSaveChoice, settingsChangedDuringCall } from "@/lib/agent-config/preview-hints";

/**
 * A slide-over for talking to the agent, mounted by the console chrome rather
 * than by a page. Closing it never ends a call — the session lives above this
 * component, so the call continues and the sidebar shows it is live.
 */
export function PreviewPanel({
  open,
  onClose,
  voice,
  onStart,
  agentName,
  dirty,
  callStartedWith,
  currentUpdatedAt,
  onSaveAndStart,
}: {
  open: boolean;
  onClose: () => void;
  voice: VoiceSessionController;
  onStart: () => void;
  agentName: string;
  dirty: boolean;
  callStartedWith: string | null;
  currentUpdatedAt: string;
  onSaveAndStart: () => void;
}) {
  const [choosing, setChoosing] = useState(false);

  if (!open) return null;

  const requestStart = () => {
    if (needsSaveChoice(dirty)) {
      setChoosing(true);
      return;
    }
    onStart();
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-label="Test agent"
        className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-xl sm:w-[420px]"
      >
        <header className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
          <span className="truncate text-sm font-semibold text-[var(--text)]">{agentName}</span>
          <Button variant="ghost" size="icon" aria-label="Close preview" className="ml-auto" onClick={onClose}>
            <X />
          </Button>
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
            <div className="mt-3 flex gap-2">
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
            </div>
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col p-4">
          <PreviewSession voice={voice} onStart={requestStart} />
        </div>
      </aside>
    </>
  );
}
