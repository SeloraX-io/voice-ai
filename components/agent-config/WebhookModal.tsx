"use client";

import { useState } from "react";

import { HeaderRows } from "@/components/agent-config/HeaderRows";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  HTTP_METHODS,
  RETRY_POLICIES,
  WEBHOOK_EVENTS,
  type RetryPolicy,
  type Webhook,
  type WebhookEvent,
} from "@/lib/agent-config/tools";

/**
 * Add/edit form for a single webhook: the definition of a call event posted
 * to an endpoint the operator controls. It only builds the definition —
 * firing it on the actual event is separate, later work.
 */
const EVENT_LABEL: Record<WebhookEvent, string> = {
  call_started: "Call started",
  call_ended: "Call ended",
  transcript_ready: "Transcript ready",
};

const RETRY_LABEL: Record<RetryPolicy, string> = {
  backoff: "Retry 3 times, backing off",
  once: "Retry once",
  none: "Don't retry",
};

function blank(): Webhook {
  return {
    id: crypto.randomUUID(),
    name: "",
    description: "",
    method: "POST",
    url: "",
    headers: [],
    queryParams: [],
    events: ["call_ended"],
    retry: "backoff",
  };
}

export function WebhookModal({
  open,
  webhook,
  onCancel,
  onSave,
  errors,
  pathPrefix,
}: {
  open: boolean;
  webhook: Webhook | null;
  onCancel: () => void;
  onSave: (webhook: Webhook) => void;
  errors: Map<string, string>;
  pathPrefix: string;
}) {
  const [draft, setDraft] = useState<Webhook>(() => webhook ?? blank());

  // Re-seed whenever the modal is opened for a different webhook: the
  // component stays mounted between opens, so its draft would otherwise be
  // the last one. Adjusting state during render (rather than in an effect)
  // avoids the extra commit an effect would cost, per
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes.
  //
  // `seed` must be updated on EVERY change, including the close — if it is only
  // written while open, `seed.open` latches true and a re-open with the same
  // webhook (or another Add, where `webhook` is null both times) never
  // reseeds, so the modal reopens holding the previous record's draft AND
  // its id.
  const [seed, setSeed] = useState<{ open: boolean; webhook: Webhook | null }>({ open, webhook });
  if (seed.open !== open || seed.webhook !== webhook) {
    setSeed({ open, webhook });
    if (open) setDraft(webhook ?? blank());
  }

  const patch = (changes: Partial<Webhook>) => setDraft((current) => ({ ...current, ...changes }));

  const toggleEvent = (event: WebhookEvent, on: boolean) =>
    patch({
      events: on ? [...draft.events, event] : draft.events.filter((item) => item !== event),
    });

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={webhook ? "Edit webhook" : "Add webhook"}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onSave(draft)}>
            {webhook ? "Save webhook" : "Add webhook"}
          </Button>
        </>
      }
    >
      <Field label="Name" htmlFor="hook-name" error={errors.get(`${pathPrefix}.name`)}>
        <Input
          id="hook-name"
          value={draft.name}
          placeholder="crm_sync"
          spellCheck={false}
          className="font-mono text-xs"
          onChange={(event) => patch({ name: event.target.value })}
        />
      </Field>

      <Field
        label="Description"
        htmlFor="hook-desc"
        description="For your own reference. The agent never reads this — a webhook is fired by an event, not called."
        error={errors.get(`${pathPrefix}.description`)}
      >
        <Textarea
          id="hook-desc"
          rows={2}
          value={draft.description}
          placeholder="Sends the transcript and outcome to the CRM when a call ends."
          onChange={(event) => patch({ description: event.target.value })}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-[8rem_minmax(0,1fr)]">
        <Field label="Method" htmlFor="hook-method">
          <Select
            id="hook-method"
            value={draft.method}
            onChange={(event) => patch({ method: event.target.value as Webhook["method"] })}
          >
            {HTTP_METHODS.map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="URL" htmlFor="hook-url" error={errors.get(`${pathPrefix}.url`)}>
          <Input
            id="hook-url"
            value={draft.url}
            placeholder="https://api.example.com/v1/calls"
            spellCheck={false}
            className="font-mono text-xs"
            onChange={(event) => patch({ url: event.target.value })}
          />
        </Field>
      </div>

      <Field
        label="Send on"
        htmlFor="hook-events"
        description="Which call events post to this endpoint."
        error={errors.get(`${pathPrefix}.events`)}
      >
        <div id="hook-events" className="flex flex-wrap gap-4 pt-1">
          {WEBHOOK_EVENTS.map((event) => (
            <label key={event} className="inline-flex items-center gap-2 text-sm text-[var(--text)]">
              <Checkbox
                checked={draft.events.includes(event)}
                onChange={(changeEvent) => toggleEvent(event, changeEvent.target.checked)}
              />
              {EVENT_LABEL[event]}
            </label>
          ))}
        </div>
      </Field>

      <HeaderRows
        rows={draft.headers}
        onChange={(headers) => patch({ headers })}
        errors={errors}
        pathPrefix={`${pathPrefix}.headers`}
        title="Headers"
        description="Write {{SECRET_NAME}} to use a secret from Advanced."
      />

      <HeaderRows
        rows={draft.queryParams}
        onChange={(queryParams) => patch({ queryParams })}
        errors={errors}
        pathPrefix={`${pathPrefix}.queryParams`}
        title="Query parameters"
        description="Appended to the URL."
      />

      <Field
        label="Retries"
        htmlFor="hook-retry"
        description="What happens when your endpoint doesn't answer."
      >
        <Select
          id="hook-retry"
          value={draft.retry}
          onChange={(event) => patch({ retry: event.target.value as RetryPolicy })}
        >
          {RETRY_POLICIES.map((policy) => (
            <option key={policy} value={policy}>
              {RETRY_LABEL[policy]}
            </option>
          ))}
        </Select>
      </Field>
    </Modal>
  );
}
