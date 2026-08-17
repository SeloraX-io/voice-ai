"use client";

import { useState } from "react";

import { ParameterRows } from "@/components/agent-config/ParameterRows";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { ClientTool } from "@/lib/agent-config/tools";

/**
 * Add/edit form for a single client tool: the definition the agent is given
 * for a function that runs in the caller's browser. It only builds the
 * definition — nothing here executes it.
 */
function blank(): ClientTool {
  return {
    id: crypto.randomUUID(),
    name: "",
    description: "",
    parameters: [],
    awaitResult: true,
  };
}

export function ClientToolModal({
  open,
  tool,
  onCancel,
  onSave,
  errors,
  pathPrefix,
}: {
  open: boolean;
  tool: ClientTool | null;
  onCancel: () => void;
  onSave: (tool: ClientTool) => void;
  errors: Map<string, string>;
  pathPrefix: string;
}) {
  const [draft, setDraft] = useState<ClientTool>(() => tool ?? blank());

  // Re-seed whenever the modal is opened for a different tool: the component
  // stays mounted between opens, so its draft would otherwise be the last one.
  // Adjusting state during render (rather than in an effect) avoids the extra
  // commit an effect would cost, per https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes.
  //
  // `seed` must be updated on EVERY change, including the close — if it is only
  // written while open, `seed.open` latches true and a re-open with the same
  // tool (or another Add, where `tool` is null both times) never reseeds, so the
  // modal reopens holding the previous record's draft AND its id.
  const [seed, setSeed] = useState<{ open: boolean; tool: ClientTool | null }>({ open, tool });
  if (seed.open !== open || seed.tool !== tool) {
    setSeed({ open, tool });
    if (open) setDraft(tool ?? blank());
  }

  const patch = (changes: Partial<ClientTool>) =>
    setDraft((current) => ({ ...current, ...changes }));

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={tool ? "Edit client tool" : "Add client tool"}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onSave(draft)}>
            {tool ? "Save tool" : "Add tool"}
          </Button>
        </>
      }
    >
      <p className="rounded-xl border border-[var(--border)] border-l-[3px] border-l-[var(--accent)] bg-[var(--surface-2)] px-4 py-3 text-xs leading-relaxed text-[var(--text-muted)]">
        A client tool runs in the caller&rsquo;s browser. Your page listens for the call and decides
        what to do — the gateway passes the request along and waits for a result.
      </p>

      <Field
        label="Tool name"
        htmlFor="client-name"
        description="Your page listens for this exact name."
        error={errors.get(`${pathPrefix}.name`)}
      >
        <Input
          id="client-name"
          value={draft.name}
          placeholder="open_tracking_page"
          spellCheck={false}
          className="font-mono text-xs"
          onChange={(event) => patch({ name: event.target.value })}
        />
      </Field>

      <Field
        label="When to use it"
        htmlFor="client-desc"
        description="The agent reads this to decide whether to call the tool."
        error={errors.get(`${pathPrefix}.description`)}
      >
        <Textarea
          id="client-desc"
          rows={3}
          value={draft.description}
          placeholder="Use this to show the tracking page once the customer has confirmed their order number."
          onChange={(event) => patch({ description: event.target.value })}
        />
      </Field>

      <ParameterRows
        parameters={draft.parameters}
        onChange={(parameters) => patch({ parameters })}
        errors={errors}
        pathPrefix={`${pathPrefix}.parameters`}
      />

      {/* A standalone toggle, so not a `Field` — that wrapper exists to pair a
          label with a control below it, and there is no control here. */}
      <div className="flex items-start gap-3">
        <Switch
          label="Wait for a result"
          checked={draft.awaitResult}
          onCheckedChange={(awaitResult) => patch({ awaitResult })}
        />
        <div>
          <p className="text-sm font-medium text-[var(--text)]">Wait for a result</p>
          <p className="mt-0.5 text-xs leading-relaxed text-[var(--text-muted)]">
            Hold the agent&rsquo;s turn until the browser replies. Turn off for fire-and-forget
            actions.
          </p>
        </div>
      </div>
    </Modal>
  );
}
