"use client";

import { useState } from "react";
import { AlertTriangle, ChevronRight } from "lucide-react";

import type { AgentVariable } from "@/lib/agent-config/schema";
import { findUnknownTokens, interpolate } from "@/lib/agent-config/template";
import { cn } from "@/lib/utils";

interface PromptPreviewProps {
  text: string;
  variables: AgentVariable[];
}

/**
 * Shows exactly what the model will receive. Unknown tokens are a warning, not
 * an error — a prompt may legitimately contain braces.
 */
export function PromptPreview({ text, variables }: PromptPreviewProps) {
  const [open, setOpen] = useState(false);
  const unknown = findUnknownTokens(text, variables);

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="inline-flex w-fit items-center gap-1 text-xs font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
      >
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        Preview with variable values
      </button>

      {unknown.length > 0 && (
        <p className="flex items-start gap-2 text-xs text-[var(--warning)]">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            No variable is defined for {unknown.map((name) => `{${name}}`).join(", ")}. It will be
            sent to the model exactly as written.
          </span>
        </p>
      )}

      {open && (
        <pre className="scroll-slim max-h-72 overflow-auto whitespace-pre-wrap rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4 font-mono text-xs leading-relaxed text-[var(--text-muted)]">
          {interpolate(text, variables) || "Nothing to preview yet."}
        </pre>
      )}
    </div>
  );
}
