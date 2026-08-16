"use client";

import { Plus } from "lucide-react";

import { Dropdown } from "@/components/ui/dropdown";
import type { AgentVariable } from "@/lib/agent-config/schema";

interface VariableInsertMenuProps {
  variables: AgentVariable[];
  onInsert: (name: string) => void;
}

export function VariableInsertMenu({ variables, onInsert }: VariableInsertMenuProps) {
  return (
    <Dropdown
      trigger={({ toggle }) => (
        <button
          type="button"
          onClick={toggle}
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text)] focus-visible:ring-2 focus-visible:ring-[var(--ring)] outline-none"
        >
          <Plus className="size-3.5" />
          Insert variable
        </button>
      )}
    >
      {({ close }) =>
        variables.length === 0 ? (
          <p className="px-3 py-2.5 text-xs leading-relaxed text-[var(--text-muted)]">
            No variables yet. Add one under <span className="text-[var(--text)]">Advanced</span> to
            use it here.
          </p>
        ) : (
          <ul>
            {variables.map((variable) => (
              <li key={variable.id}>
                <button
                  type="button"
                  onClick={() => {
                    onInsert(variable.name);
                    close();
                  }}
                  className="flex w-full items-baseline justify-between gap-4 rounded-lg px-3 py-2 text-left text-sm text-[var(--text)] transition-colors hover:bg-[var(--surface-3)]"
                >
                  <span className="font-mono text-xs">{`{${variable.name}}`}</span>
                  <span className="truncate text-xs text-[var(--text-dim)]">
                    {variable.previewValue || "—"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      }
    </Dropdown>
  );
}
