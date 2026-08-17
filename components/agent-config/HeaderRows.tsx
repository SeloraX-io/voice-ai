"use client";

import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ToolHeader } from "@/lib/agent-config/tools";

/**
 * Editor for a list of name/value pairs.
 *
 * Serves both request headers and query parameters, and both the tool and
 * webhook forms — the shape is identical, only the wording differs, so the
 * heading and hint are props.
 */
export function HeaderRows({
  rows,
  onChange,
  errors,
  pathPrefix,
  title,
  description,
}: {
  rows: ToolHeader[];
  onChange: (next: ToolHeader[]) => void;
  errors: Map<string, string>;
  pathPrefix: string;
  title: string;
  description: string;
}) {
  const patch = (index: number, changes: Partial<ToolHeader>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...changes } : row)));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-[var(--text)]">{title}</h3>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">{description}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onChange([...rows, { id: crypto.randomUUID(), name: "", value: "" }])}
        >
          <Plus />
          Add
        </Button>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)] px-4 py-3 text-xs text-[var(--text-muted)]">
          None added.
        </p>
      ) : (
        rows.map((row, index) => {
          const nameError = errors.get(`${pathPrefix}.${index}.name`);
          return (
            <div key={row.id} className="flex flex-col gap-2">
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] items-center gap-2">
                <Input
                  aria-label={`${title} name`}
                  value={row.name}
                  placeholder="Authorization"
                  spellCheck={false}
                  className="font-mono text-xs"
                  onChange={(event) => patch(index, { name: event.target.value })}
                />
                <Input
                  aria-label={`${title} value`}
                  value={row.value}
                  placeholder="Bearer {{CRM_API_KEY}}"
                  spellCheck={false}
                  className="font-mono text-xs"
                  onChange={(event) => patch(index, { value: event.target.value })}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${row.name || "unnamed"}`}
                  className="text-[var(--text-muted)] hover:text-[var(--danger)]"
                  onClick={() => onChange(rows.filter((_, i) => i !== index))}
                >
                  <Trash2 />
                </Button>
              </div>
              {nameError && (
                <p role="alert" className="text-xs font-medium text-[var(--danger)]">
                  {nameError}
                </p>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
