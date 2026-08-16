"use client";

import { useState } from "react";

import { HeaderRows } from "@/components/agent-config/HeaderRows";
import { ParameterRows } from "@/components/agent-config/ParameterRows";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { bracedParams, HTTP_METHODS, type HttpTool } from "@/lib/agent-config/tools";

/**
 * Add/edit form for a single HTTP tool: the definition the agent is given
 * for calling an API mid-conversation. It only builds the definition — the
 * gateway does not execute it yet.
 */
function blank(): HttpTool {
  return {
    id: crypto.randomUUID(),
    name: "",
    description: "",
    method: "GET",
    url: "",
    parameters: [],
    headers: [],
    silent: false,
  };
}

export function HttpToolModal({
  open,
  tool,
  onCancel,
  onSave,
  errors,
}: {
  open: boolean;
  tool: HttpTool | null;
  onCancel: () => void;
  onSave: (tool: HttpTool) => void;
  errors: Map<string, string>;
}) {
  const [draft, setDraft] = useState<HttpTool>(() => tool ?? blank());

  // Re-seed whenever the modal is opened for a different tool: the component
  // stays mounted between opens, so its draft would otherwise be the last one.
  // Adjusting state during render (rather than in an effect) avoids the extra
  // commit an effect would cost, per https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes.
  const [seed, setSeed] = useState<{ open: boolean; tool: HttpTool | null }>({ open, tool });
  if (open && (seed.open !== open || seed.tool !== tool)) {
    setSeed({ open, tool });
    setDraft(tool ?? blank());
  }

  const patch = (changes: Partial<HttpTool>) => setDraft((current) => ({ ...current, ...changes }));

  const declared = new Set(draft.parameters.map((parameter) => parameter.name));
  const missing = bracedParams(draft.url).filter((name) => !declared.has(name));

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={tool ? "Edit HTTP tool" : "Add HTTP tool"}
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
      <Field
        label="Tool name"
        htmlFor="http-name"
        description="How the agent refers to it. Lowercase with underscores."
        error={errors.get("name")}
      >
        <Input
          id="http-name"
          value={draft.name}
          placeholder="check_order_status"
          spellCheck={false}
          className="font-mono text-xs"
          onChange={(event) => patch({ name: event.target.value })}
        />
      </Field>

      <Field
        label="When to use it"
        htmlFor="http-desc"
        description="The agent reads this to decide whether to call the tool. Say when it should — and when it shouldn't."
        error={errors.get("description")}
      >
        <Textarea
          id="http-desc"
          rows={3}
          value={draft.description}
          placeholder="Use this when the customer asks where their order is and gives an order number."
          onChange={(event) => patch({ description: event.target.value })}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-[8rem_minmax(0,1fr)]">
        <Field label="Method" htmlFor="http-method">
          <Select
            id="http-method"
            value={draft.method}
            onChange={(event) => patch({ method: event.target.value as HttpTool["method"] })}
          >
            {HTTP_METHODS.map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="URL" htmlFor="http-url" error={errors.get("url")}>
          <Input
            id="http-url"
            value={draft.url}
            placeholder="https://api.example.com/orders/{order_id}"
            spellCheck={false}
            className="font-mono text-xs"
            onChange={(event) => patch({ url: event.target.value })}
          />
        </Field>
      </div>

      {missing.length > 0 && (
        <p className="rounded-xl border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-4 py-3 text-xs text-[var(--text)]">
          The URL uses {missing.map((name) => `{${name}}`).join(", ")}, which{" "}
          {missing.length === 1 ? "is not a parameter" : "are not parameters"} yet.{" "}
          <button
            type="button"
            className="font-medium underline underline-offset-2"
            onClick={() =>
              patch({
                parameters: [
                  ...draft.parameters,
                  ...missing.map((name) => ({
                    id: crypto.randomUUID(),
                    name,
                    type: "string" as const,
                    description: "",
                    required: true,
                  })),
                ],
              })
            }
          >
            Add {missing.length === 1 ? "it" : "them"}
          </button>
          .
        </p>
      )}

      <ParameterRows
        parameters={draft.parameters}
        onChange={(parameters) => patch({ parameters })}
        errors={errors}
        pathPrefix="parameters"
      />

      <HeaderRows
        rows={draft.headers}
        onChange={(headers) => patch({ headers })}
        errors={errors}
        pathPrefix="headers"
        title="Headers"
        description="Write {{SECRET_NAME}} to use a secret from Advanced. Values stay on the server."
      />

      {/* A standalone toggle, so not a `Field` — that wrapper exists to pair a
          label with a control below it, and there is no control here. */}
      <div className="flex items-start gap-3">
        <Switch
          label="Silent"
          checked={draft.silent}
          onCheckedChange={(silent) => patch({ silent })}
        />
        <div>
          <p className="text-sm font-medium text-[var(--text)]">Silent</p>
          <p className="mt-0.5 text-xs leading-relaxed text-[var(--text-muted)]">
            Run the call without telling the caller and without speaking the result.
          </p>
        </div>
      </div>
    </Modal>
  );
}
