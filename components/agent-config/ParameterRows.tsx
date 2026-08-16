"use client";

import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { ToolParameter, ToolValueType } from "@/lib/agent-config/tools";

/**
 * Editor for the values a tool takes.
 *
 * Shared by the HTTP and client tool forms: both describe parameters the model
 * fills in from the conversation, so they get the same editor rather than two
 * that drift.
 */
export function ParameterRows({
  parameters,
  onChange,
  errors,
  pathPrefix,
}: {
  parameters: ToolParameter[];
  onChange: (next: ToolParameter[]) => void;
  errors: Map<string, string>;
  pathPrefix: string;
}) {
  const patch = (index: number, changes: Partial<ToolParameter>) =>
    onChange(parameters.map((row, i) => (i === index ? { ...row, ...changes } : row)));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-[var(--text)]">Parameters</h3>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">
            Values the agent works out from the conversation and passes in.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            onChange([
              ...parameters,
              {
                id: crypto.randomUUID(),
                name: "",
                type: "string",
                description: "",
                required: true,
              },
            ])
          }
        >
          <Plus />
          Add
        </Button>
      </div>

      {parameters.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)] px-4 py-3 text-xs text-[var(--text-muted)]">
          No parameters. The agent will call this with no arguments.
        </p>
      ) : (
        parameters.map((row, index) => {
          const nameError = errors.get(`${pathPrefix}.${index}.name`);
          return (
            <div key={row.id} className="flex flex-col gap-2">
              <div className="grid grid-cols-[minmax(0,1fr)_7rem_minmax(0,1.4fr)_auto] items-center gap-2">
                <Input
                  aria-label="Parameter name"
                  value={row.name}
                  placeholder="order_id"
                  spellCheck={false}
                  className="font-mono text-xs"
                  onChange={(event) => patch(index, { name: event.target.value })}
                />
                <Select
                  aria-label="Parameter type"
                  value={row.type}
                  onChange={(event) => patch(index, { type: event.target.value as ToolValueType })}
                >
                  <option value="string">String</option>
                  <option value="number">Number</option>
                  <option value="boolean">Boolean</option>
                </Select>
                <Input
                  aria-label="What this value is"
                  value={row.description}
                  placeholder="The customer's order number"
                  onChange={(event) => patch(index, { description: event.target.value })}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove parameter ${row.name || "unnamed"}`}
                  className="text-[var(--text-muted)] hover:text-[var(--danger)]"
                  onClick={() => onChange(parameters.filter((_, i) => i !== index))}
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
