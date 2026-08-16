"use client";

import { useRef } from "react";
import { ClipboardList, MessagesSquare } from "lucide-react";

import type { TabProps } from "@/components/agent-config/AgentConfigProvider";
import { PromptPreview } from "@/components/agent-config/PromptPreview";
import { VariableInsertMenu } from "@/components/agent-config/VariableInsertMenu";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** Inserts `{name}` at the caret and restores focus, so typing can continue. */
function insertAtCaret(
  element: HTMLTextAreaElement | null,
  current: string,
  name: string,
  commit: (next: string) => void,
): void {
  const token = `{${name}}`;
  if (!element) {
    commit(current + token);
    return;
  }
  const start = element.selectionStart ?? current.length;
  const end = element.selectionEnd ?? current.length;
  commit(current.slice(0, start) + token + current.slice(end));

  requestAnimationFrame(() => {
    element.focus();
    const caret = start + token.length;
    element.setSelectionRange(caret, caret);
  });
}

export function ConversationTab({ config, update, errors }: TabProps) {
  const instructionsRef = useRef<HTMLTextAreaElement>(null);
  const welcomeRef = useRef<HTMLTextAreaElement>(null);

  return (
    <div className="flex flex-col gap-9">
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-[var(--text)]">Type</h2>
        <div role="radiogroup" aria-label="Conversation type" className="grid gap-3 sm:grid-cols-2">
          <TypeOption
            icon={MessagesSquare}
            title="Open ended"
            body="A free-form conversation guided by your instructions."
            selected
          />
          <TypeOption
            icon={ClipboardList}
            title="Data collection"
            body="Walk the caller through a set of fields and capture structured answers."
            badge="Coming soon"
          />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <Field
          label="Instructions"
          htmlFor="instructions"
          description="Define your agent's personality, tone, and behaviour guidelines."
          error={errors.get("instructions")}
          action={
            <VariableInsertMenu
              variables={config.variables}
              onInsert={(name) =>
                insertAtCaret(instructionsRef.current, config.instructions, name, (instructions) =>
                  update({ instructions }),
                )
              }
            />
          }
        >
          <Textarea
            id="instructions"
            ref={instructionsRef}
            rows={18}
            value={config.instructions}
            onChange={(event) => update({ instructions: event.target.value })}
            className="font-mono text-[13px]"
            spellCheck={false}
          />
        </Field>
        <PromptPreview text={config.instructions} variables={config.variables} />
      </section>

      <section className="flex flex-col gap-3">
        <Field
          label="Welcome message"
          htmlFor="welcome"
          description="Spoken as soon as the call connects, before the caller says anything."
          error={errors.get("welcome.message")}
          action={
            <Switch
              label="Enable the welcome message"
              checked={config.welcome.enabled}
              onCheckedChange={(enabled) => update({ welcome: { ...config.welcome, enabled } })}
            />
          }
        >
          <div className="flex flex-col gap-3">
            <label
              className={cn(
                "inline-flex w-fit items-center gap-2 text-xs",
                config.welcome.enabled ? "text-[var(--text-muted)]" : "text-[var(--text-dim)]",
              )}
            >
              <Checkbox
                checked={config.welcome.allowInterrupt}
                disabled={!config.welcome.enabled}
                onChange={(event) =>
                  update({ welcome: { ...config.welcome, allowInterrupt: event.target.checked } })
                }
              />
              Allow callers to interrupt the greeting.
            </label>

            <div className="flex items-center justify-end">
              <VariableInsertMenu
                variables={config.variables}
                disabled={!config.welcome.enabled}
                onInsert={(name) =>
                  insertAtCaret(welcomeRef.current, config.welcome.message, name, (message) =>
                    update({ welcome: { ...config.welcome, message } }),
                  )
                }
              />
            </div>

            <Textarea
              id="welcome"
              ref={welcomeRef}
              rows={4}
              value={config.welcome.message}
              disabled={!config.welcome.enabled}
              placeholder="Hi, thanks for calling. What can I help you with today?"
              onChange={(event) =>
                update({ welcome: { ...config.welcome, message: event.target.value } })
              }
            />
          </div>
        </Field>

        {config.welcome.enabled && (
          <PromptPreview text={config.welcome.message} variables={config.variables} />
        )}

        <p className="text-xs leading-relaxed text-[var(--text-dim)]">
          The greeting is delivered as an instruction to the model, so expect near-verbatim wording
          rather than an exact recording.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <Field
          label="Call ending"
          htmlFor="call-ending"
          description="When the agent should hang up on its own. It decides using this text, so write it the way you would brief a person."
          error={errors.get("callEnding.policy")}
          action={
            <Switch
              label="Let the agent end calls"
              checked={config.callEnding.enabled}
              onCheckedChange={(enabled) =>
                update({ callEnding: { ...config.callEnding, enabled } })
              }
            />
          }
        >
          <Textarea
            id="call-ending"
            rows={10}
            value={config.callEnding.policy}
            disabled={!config.callEnding.enabled}
            onChange={(event) =>
              update({ callEnding: { ...config.callEnding, policy: event.target.value } })
            }
            className="font-mono text-[13px]"
            spellCheck={false}
          />
        </Field>

        <p className="text-xs leading-relaxed text-[var(--text-dim)]">
          The agent says its closing line first, then hangs up about two seconds later so the line
          finishes playing. Every call it ends is recorded under Calls with the reason it gave.
        </p>
      </section>
    </div>
  );
}

function TypeOption({
  icon: Icon,
  title,
  body,
  selected,
  badge,
}: {
  icon: typeof MessagesSquare;
  title: string;
  body: string;
  selected?: boolean;
  badge?: string;
}) {
  return (
    <div
      role="radio"
      aria-checked={Boolean(selected)}
      aria-disabled={!selected}
      className={cn(
        "flex gap-3 rounded-2xl border p-4",
        selected
          ? "border-[var(--accent)] bg-[var(--accent-soft)]"
          : "border-[var(--border)] bg-[var(--surface-2)] opacity-60",
      )}
    >
      <span
        className={cn(
          "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border",
          selected ? "border-[var(--accent)]" : "border-[var(--border-strong)]",
        )}
      >
        {selected && <span className="size-2 rounded-full bg-[var(--accent)]" />}
      </span>
      <div>
        <p className="flex items-center gap-2 text-sm font-medium text-[var(--text)]">
          <Icon className="size-4" />
          {title}
          {badge && (
            <span className="rounded-full bg-[var(--surface-3)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
              {badge}
            </span>
          )}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">{body}</p>
      </div>
    </div>
  );
}
