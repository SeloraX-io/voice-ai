"use client";

import { Globe, MonitorSmartphone, Webhook } from "lucide-react";

const PLANNED = [
  {
    icon: Globe,
    title: "HTTP tools",
    body: "Let the agent call your APIs mid-conversation, authenticated with the secrets defined in Advanced.",
  },
  {
    icon: MonitorSmartphone,
    title: "Client tools",
    body: "Expose functions that run in the caller's browser, for actions the server cannot take.",
  },
  {
    icon: Webhook,
    title: "Webhooks",
    body: "Post call events — started, ended, transcript ready — to an endpoint you control.",
  },
];

export function ActionsTab() {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-[var(--text-muted)]">
        Actions let the agent do things beyond talking. None are configured yet.
      </p>
      {PLANNED.map(({ icon: Icon, title, body }) => (
        <div
          key={title}
          className="flex gap-3 rounded-2xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)] p-5"
        >
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--surface-3)] text-[var(--text-muted)]">
            <Icon className="size-4" />
          </span>
          <div>
            <p className="text-sm font-medium text-[var(--text)]">{title}</p>
            <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">{body}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
