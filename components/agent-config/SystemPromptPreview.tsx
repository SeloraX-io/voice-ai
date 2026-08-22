"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";

import { buildSystemInstruction, resolveAgentConfig } from "@/lib/agent-config/resolve";
import type { AgentConfig } from "@/lib/agent-config/schema";
import { cn } from "@/lib/utils";

/**
 * The assembled system prompt, rendered by the SAME functions the gateway
 * runs at call time — resolveAgentConfig then buildSystemInstruction — so what
 * this shows cannot drift from what a call sends. The field-level previews
 * above it show one field each; this is the whole thing: instructions, the
 * opening directive (exact greeting or caller-speaks-first), and the
 * call-ending section when the agent may hang up.
 */
export function SystemPromptPreview({ config }: { config: AgentConfig }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="inline-flex w-fit items-center gap-1 text-xs font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
      >
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        Preview the full system prompt
      </button>

      {open && (
        <pre className="scroll-slim max-h-96 overflow-auto whitespace-pre-wrap rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4 font-mono text-xs leading-relaxed text-[var(--text-muted)]">
          {buildSystemInstruction(resolveAgentConfig(config))}
        </pre>
      )}
    </div>
  );
}
