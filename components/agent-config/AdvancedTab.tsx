"use client";

import { useCallback, useState } from "react";
import { KeyRound, Plus, Trash2 } from "lucide-react";

import type { TabProps } from "@/components/agent-config/AgentConfigForm";
import { Button } from "@/components/ui/button";
import { Field, controlClass } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { LIMITS, SECRET_KEY_RE, type AgentVariable } from "@/lib/agent-config/schema";
import { findTokens } from "@/lib/agent-config/template";
import { cn } from "@/lib/utils";

/** Where a variable is referenced, so a delete can warn instead of surprising. */
function usedIn(name: string, instructions: string, welcome: string): string[] {
  const places: string[] = [];
  if (findTokens(instructions).includes(name)) places.push("the instructions");
  if (findTokens(welcome).includes(name)) places.push("the welcome message");
  return places;
}

export function AdvancedTab({ config, update, setSecretKeys, errors }: TabProps) {
  const secretKeys = config.secretKeys;
  const [newSecretKey, setNewSecretKey] = useState("");
  const [newSecretValue, setNewSecretValue] = useState("");
  const [secretError, setSecretError] = useState<string | null>(null);
  const [secretBusy, setSecretBusy] = useState(false);

  const patchVariable = (index: number, changes: Partial<AgentVariable>) => {
    const variables = config.variables.map((variable, position) =>
      position === index ? { ...variable, ...changes } : variable,
    );
    update({ variables });
  };

  const addVariable = () => {
    const variable: AgentVariable = {
      id: `var-${Date.now()}-${config.variables.length}`,
      type: "string",
      name: "",
      previewValue: "",
    };
    update({ variables: [...config.variables, variable] });
  };

  const removeVariable = (index: number) => {
    const variable = config.variables[index];
    const places = usedIn(variable.name, config.instructions, config.welcome.message);
    if (places.length > 0) {
      const confirmed = window.confirm(
        `{${variable.name}} is used in ${places.join(" and ")}.\n\n` +
          "Deleting the variable leaves the token in place, and it will be sent to the model " +
          "exactly as written. Delete it anyway?",
      );
      if (!confirmed) return;
    }
    update({ variables: config.variables.filter((_, position) => position !== index) });
  };

  const addSecret = useCallback(async () => {
    setSecretError(null);
    if (!SECRET_KEY_RE.test(newSecretKey)) {
      setSecretError("Use UPPER_SNAKE_CASE letters, digits and underscores.");
      return;
    }
    if (newSecretValue === "") {
      setSecretError("A value is required.");
      return;
    }

    setSecretBusy(true);
    try {
      const response = await fetch("/api/agent-config/secrets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: newSecretKey, value: newSecretValue }),
      });
      if (!response.ok) {
        const body: { errors?: { message: string }[] } = await response.json().catch(() => ({}));
        setSecretError(body.errors?.[0]?.message ?? "Could not save the secret.");
        return;
      }
      const body: { secretKeys: string[] } = await response.json();
      setSecretKeys(body.secretKeys);
      setNewSecretKey("");
      setNewSecretValue("");
    } catch {
      setSecretError("Could not reach the server.");
    } finally {
      setSecretBusy(false);
    }
  }, [newSecretKey, newSecretValue, setSecretKeys]);

  const removeSecret = useCallback(
    async (key: string) => {
      if (!window.confirm(`Delete the secret ${key}? This cannot be undone.`)) return;
      setSecretError(null);

      try {
        const response = await fetch(`/api/agent-config/secrets?key=${encodeURIComponent(key)}`, {
          method: "DELETE",
        });
        if (!response.ok) {
          const body: { errors?: { message: string }[] } = await response.json().catch(() => ({}));
          setSecretError(body.errors?.[0]?.message ?? "Could not delete the secret.");
          return;
        }
        const body: { secretKeys: string[] } = await response.json();
        setSecretKeys(body.secretKeys);
      } catch {
        setSecretError("Could not reach the server.");
      }
    },
    [setSecretKeys],
  );

  return (
    <div className="flex flex-col gap-9">
      <section>
        <Field
          label="Agent name"
          htmlFor="agentName"
          description="Identifies this agent in logs and, later, in dispatch rules."
          error={errors.get("agentName")}
        >
          <Input
            id="agentName"
            value={config.agentName}
            onChange={(event) => update({ agentName: event.target.value })}
            spellCheck={false}
            className="font-mono text-xs"
          />
        </Field>
      </section>

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-sm font-medium text-[var(--text)]">Custom variables</h2>
          <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
            Reference a variable as <code className="font-mono">{"{name}"}</code> in the instructions
            or welcome message. Preview values are what calls use today.
          </p>
        </div>

        {config.variables.length > 0 && (
          <div className="flex flex-col gap-3">
            {config.variables.map((variable, index) => (
              <div
                key={variable.id}
                className="grid gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4 sm:grid-cols-[8rem_1fr_1fr_auto] sm:items-end"
              >
                <Field label="Type" htmlFor={`type-${variable.id}`}>
                  <Select
                    id={`type-${variable.id}`}
                    value={variable.type}
                    onChange={(event) =>
                      patchVariable(index, { type: event.target.value as AgentVariable["type"] })
                    }
                  >
                    <option value="string">String</option>
                    <option value="number">Number</option>
                    <option value="boolean">Boolean</option>
                  </Select>
                </Field>

                <Field
                  label="Name"
                  htmlFor={`name-${variable.id}`}
                  error={errors.get(`variables.${index}.name`)}
                >
                  <Input
                    id={`name-${variable.id}`}
                    value={variable.name}
                    placeholder="company"
                    spellCheck={false}
                    onChange={(event) => patchVariable(index, { name: event.target.value })}
                    className="font-mono text-xs"
                  />
                </Field>

                <Field
                  label="Preview value"
                  htmlFor={`value-${variable.id}`}
                  error={errors.get(`variables.${index}.previewValue`)}
                >
                  {variable.type === "boolean" ? (
                    <Select
                      id={`value-${variable.id}`}
                      value={variable.previewValue === "true" ? "true" : "false"}
                      onChange={(event) =>
                        patchVariable(index, { previewValue: event.target.value })
                      }
                    >
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </Select>
                  ) : (
                    <Input
                      id={`value-${variable.id}`}
                      value={variable.previewValue}
                      inputMode={variable.type === "number" ? "decimal" : "text"}
                      placeholder={variable.type === "number" ? "0" : "Selorax"}
                      onChange={(event) =>
                        patchVariable(index, { previewValue: event.target.value })
                      }
                    />
                  )}
                </Field>

                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete the variable ${variable.name || "unnamed"}`}
                  onClick={() => removeVariable(index)}
                  className="justify-self-end text-[var(--text-muted)] hover:text-[var(--danger)]"
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        )}

        <Button
          variant="outline"
          size="sm"
          onClick={addVariable}
          disabled={config.variables.length >= LIMITS.variablesMax}
          className="w-fit"
        >
          <Plus />
          Add variable
        </Button>
      </section>

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-sm font-medium text-[var(--text)]">Secrets</h2>
          <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
            Credentials for the agent&rsquo;s HTTP tool calls. Values are stored on the server and
            never sent back to this page — a secret can be replaced, but not read.
          </p>
        </div>

        {secretKeys.length > 0 && (
          <ul className="flex flex-col gap-2">
            {secretKeys.map((key) => (
              <li
                key={key}
                className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3"
              >
                <KeyRound className="size-4 shrink-0 text-[var(--text-muted)]" />
                <span className="font-mono text-xs text-[var(--text)]">{key}</span>
                <span className="ml-auto font-mono text-xs text-[var(--text-dim)]">••••••</span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete the secret ${key}`}
                  onClick={() => void removeSecret(key)}
                  className="text-[var(--text-muted)] hover:text-[var(--danger)]"
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="grid gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label="Key" htmlFor="secretKey">
            <Input
              id="secretKey"
              value={newSecretKey}
              placeholder="CRM_API_KEY"
              spellCheck={false}
              onChange={(event) => setNewSecretKey(event.target.value.toUpperCase())}
              className="font-mono text-xs"
            />
          </Field>
          <Field label="Value" htmlFor="secretValue">
            <input
              id="secretValue"
              type="password"
              autoComplete="off"
              value={newSecretValue}
              maxLength={LIMITS.secretValueMax}
              onChange={(event) => setNewSecretValue(event.target.value)}
              className={cn(controlClass, "h-10 font-mono text-xs")}
            />
          </Field>
          <Button
            variant="outline"
            onClick={() => void addSecret()}
            disabled={secretBusy}
            className="sm:mb-0"
          >
            <Plus />
            Add secret
          </Button>
        </div>

        {secretError && (
          <p role="alert" className="text-xs font-medium text-[var(--danger)]">
            {secretError}
          </p>
        )}

        <p className="text-xs leading-relaxed text-[var(--text-dim)]">
          Secrets save immediately — they are not part of the Save changes button above.
        </p>
      </section>
    </div>
  );
}
