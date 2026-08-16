"use client";

import { AlertTriangle, Check, Loader2 } from "lucide-react";

import { useAgentConfig } from "@/components/agent-config/AgentConfigProvider";
import { Button } from "@/components/ui/button";

/**
 * Saving is always explicit: a half-typed prompt must not become the live
 * persona. Rendered by the layout so it survives navigation between screens.
 */
export function SaveBar() {
  const { dirty, formError, saveState, save, discard } = useAgentConfig();

  return (
    <div className="sticky bottom-0 border-t border-[var(--border)] bg-[var(--bg)]/85 backdrop-blur">
      {formError && (
        <p
          role="alert"
          className="animate-fade-rise flex items-start gap-2.5 px-6 pt-4 text-sm text-[var(--danger)]"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{formError}</span>
        </p>
      )}
      <div className="flex items-center justify-end gap-3 px-6 py-4">
        {saveState === "saved" && !dirty && (
          <span className="mr-auto inline-flex items-center gap-1.5 text-sm text-[var(--success)]">
            <Check className="size-4" />
            Saved
          </span>
        )}
        {dirty && <span className="mr-auto text-sm text-[var(--text-muted)]">Unsaved changes</span>}
        <Button variant="ghost" onClick={discard} disabled={!dirty || saveState === "saving"}>
          Discard
        </Button>
        <Button
          variant="primary"
          onClick={() => void save()}
          disabled={!dirty || saveState === "saving"}
        >
          {saveState === "saving" && <Loader2 className="animate-spin" />}
          Save changes
        </Button>
      </div>
    </div>
  );
}
