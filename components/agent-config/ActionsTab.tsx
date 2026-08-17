"use client";

/**
 * The Actions screen: HTTP tools, client tools and webhooks.
 *
 * These are definitions only — saved with the rest of the configuration, but
 * the agent does not call any of them yet. Running them during a call is a
 * later piece of work, so the screen says so up front rather than looking
 * live and silently doing nothing.
 */

import { useState } from "react";
import { Globe, MonitorSmartphone, Plus, Trash2, Webhook as WebhookIcon } from "lucide-react";

import { ClientToolModal } from "@/components/agent-config/ClientToolModal";
import { HttpToolModal } from "@/components/agent-config/HttpToolModal";
import { WebhookModal } from "@/components/agent-config/WebhookModal";
import type { TabProps } from "@/components/agent-config/AgentConfigProvider";
import { Button } from "@/components/ui/button";
import { EMPTY_TOOLS, type ClientTool, type HttpTool, type Webhook } from "@/lib/agent-config/tools";
import { cn } from "@/lib/utils";

const METHOD_CLASS: Record<string, string> = {
  GET: "bg-[var(--accent-2)]",
  POST: "bg-[var(--success)]",
  PATCH: "bg-[var(--warning)]",
  DELETE: "bg-[var(--danger)]",
};

/** Which editor is open, and on which record. `null` means adding. */
type Editing =
  | { kind: "http"; tool: HttpTool | null }
  | { kind: "client"; tool: ClientTool | null }
  | { kind: "webhook"; webhook: Webhook | null }
  | null;

export function ActionsTab({ config, update, errors }: TabProps) {
  const tools = config.tools ?? EMPTY_TOOLS;
  const [editing, setEditing] = useState<Editing>(null);

  const patchTools = (changes: Partial<typeof tools>) =>
    update({ tools: { ...tools, ...changes } });

  /** Replaces by id when the id is already present, appends otherwise. */
  const upsert = <T extends { id: string }>(list: T[], item: T): T[] =>
    list.some((existing) => existing.id === item.id)
      ? list.map((existing) => (existing.id === item.id ? item : existing))
      : [...list, item];

  return (
    <div className="flex flex-col gap-9">
      <p className="rounded-xl border border-[var(--border)] border-l-[3px] border-l-[var(--accent)] bg-[var(--surface-2)] px-4 py-3 text-xs leading-relaxed text-[var(--text-muted)]">
        Actions are saved with the rest of the configuration, but the agent does not call them yet —
        running them during a call is the next piece of work.
      </p>

      <Section
        icon={Globe}
        title="HTTP tools"
        blurb="Called mid-conversation. Authenticated with the secrets in Advanced."
        empty="No HTTP tools. Add one to let the agent look something up or file a request while it talks."
        isEmpty={tools.http.length === 0}
        onAdd={() => setEditing({ kind: "http", tool: null })}
      >
        {tools.http.map((tool) => (
          <Row
            key={tool.id}
            method={tool.method}
            name={tool.name}
            description={tool.description}
            tag={tool.silent ? "Silent" : undefined}
            onEdit={() => setEditing({ kind: "http", tool })}
            onDelete={() =>
              patchTools({ http: tools.http.filter((item) => item.id !== tool.id) })
            }
          />
        ))}
      </Section>

      <Section
        icon={MonitorSmartphone}
        title="Client tools"
        blurb="Functions that run in the caller's browser, for what the server cannot do."
        empty="No client tools. Add one to let the agent open a page or fill a form on the caller's screen."
        isEmpty={tools.client.length === 0}
        onAdd={() => setEditing({ kind: "client", tool: null })}
      >
        {tools.client.map((tool) => (
          <Row
            key={tool.id}
            name={tool.name}
            description={tool.description}
            tag={tool.awaitResult ? undefined : "Async"}
            onEdit={() => setEditing({ kind: "client", tool })}
            onDelete={() =>
              patchTools({ client: tools.client.filter((item) => item.id !== tool.id) })
            }
          />
        ))}
      </Section>

      <Section
        icon={WebhookIcon}
        title="Webhooks"
        blurb="Call events posted to an endpoint you control."
        empty="No webhooks. Add one to send call events to your own systems."
        isEmpty={tools.webhooks.length === 0}
        onAdd={() => setEditing({ kind: "webhook", webhook: null })}
      >
        {tools.webhooks.map((hook) => (
          <Row
            key={hook.id}
            method={hook.method}
            name={hook.name}
            description={hook.description}
            onEdit={() => setEditing({ kind: "webhook", webhook: hook })}
            onDelete={() =>
              patchTools({ webhooks: tools.webhooks.filter((item) => item.id !== hook.id) })
            }
          />
        ))}
      </Section>

      <HttpToolModal
        open={editing?.kind === "http"}
        tool={editing?.kind === "http" ? editing.tool : null}
        errors={errors}
        pathPrefix={`tools.http.${
          editing?.kind === "http" && editing.tool
            ? tools.http.findIndex((item) => item.id === editing.tool!.id)
            : tools.http.length
        }`}
        onCancel={() => setEditing(null)}
        onSave={(tool) => {
          patchTools({ http: upsert(tools.http, tool) });
          setEditing(null);
        }}
      />

      <ClientToolModal
        open={editing?.kind === "client"}
        tool={editing?.kind === "client" ? editing.tool : null}
        errors={errors}
        pathPrefix={`tools.client.${
          editing?.kind === "client" && editing.tool
            ? tools.client.findIndex((item) => item.id === editing.tool!.id)
            : tools.client.length
        }`}
        onCancel={() => setEditing(null)}
        onSave={(tool) => {
          patchTools({ client: upsert(tools.client, tool) });
          setEditing(null);
        }}
      />

      <WebhookModal
        open={editing?.kind === "webhook"}
        webhook={editing?.kind === "webhook" ? editing.webhook : null}
        errors={errors}
        pathPrefix={`tools.webhooks.${
          editing?.kind === "webhook" && editing.webhook
            ? tools.webhooks.findIndex((item) => item.id === editing.webhook!.id)
            : tools.webhooks.length
        }`}
        onCancel={() => setEditing(null)}
        onSave={(webhook) => {
          patchTools({ webhooks: upsert(tools.webhooks, webhook) });
          setEditing(null);
        }}
      />
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  blurb,
  empty,
  isEmpty,
  onAdd,
  children,
}: {
  icon: typeof Globe;
  title: string;
  blurb: string;
  empty: string;
  /**
   * Computed by the caller from the underlying data, not inferred from
   * `children` — React's own normalisation of children (a stray whitespace
   * node, a conditional child) is not a reliable proxy for "the list is
   * empty".
   */
  isEmpty: boolean;
  onAdd: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2.5">
          <Icon className="size-4 translate-y-0.5 text-[var(--text-muted)]" />
          <div>
            <h2 className="text-sm font-medium text-[var(--text)]">{title}</h2>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">{blurb}</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={onAdd}>
          <Plus />
          Add
        </Button>
      </div>

      {isEmpty ? (
        <p className="rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)] px-4 py-3 text-xs text-[var(--text-muted)]">
          {empty}
        </p>
      ) : (
        <div className="flex flex-col gap-2">{children}</div>
      )}
    </section>
  );
}

function Row({
  method,
  name,
  description,
  tag,
  onEdit,
  onDelete,
}: {
  method?: string;
  name: string;
  description: string;
  tag?: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
      {method && (
        <span
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wide text-white",
            METHOD_CLASS[method] ?? "bg-[var(--text-muted)]",
          )}
        >
          {method}
        </span>
      )}
      <span className="shrink-0 font-mono text-xs font-semibold text-[var(--text)]">
        {name || "unnamed"}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-muted)]">{description}</span>
      {tag && (
        <span className="shrink-0 rounded-full bg-[var(--surface-3)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          {tag}
        </span>
      )}
      <Button variant="ghost" size="sm" onClick={onEdit}>
        Edit
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Delete ${name || "unnamed"}`}
        className="text-[var(--text-muted)] hover:text-[var(--danger)]"
        onClick={onDelete}
      >
        <Trash2 />
      </Button>
    </div>
  );
}
