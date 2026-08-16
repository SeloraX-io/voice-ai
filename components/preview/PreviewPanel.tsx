"use client";

import { X } from "lucide-react";

import { PreviewSession } from "@/components/preview/PreviewSession";
import { Button } from "@/components/ui/button";
import type { VoiceSessionController } from "@/hooks/useVoiceSession";

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
}: {
  open: boolean;
  onClose: () => void;
  voice: VoiceSessionController;
  onStart: () => void;
  agentName: string;
}) {
  if (!open) return null;

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

        <div className="flex min-h-0 flex-1 flex-col p-4">
          <PreviewSession voice={voice} onStart={onStart} />
        </div>
      </aside>
    </>
  );
}
