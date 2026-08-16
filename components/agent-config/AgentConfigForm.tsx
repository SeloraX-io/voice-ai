"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Loader2, MessageSquare, Settings2, Sparkles, Zap } from "lucide-react";

import { ActionsTab } from "@/components/agent-config/ActionsTab";
import { AdvancedTab } from "@/components/agent-config/AdvancedTab";
import { ConversationTab } from "@/components/agent-config/ConversationTab";
import { ModelsVoiceTab } from "@/components/agent-config/ModelsVoiceTab";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { AgentConfig, FieldError } from "@/lib/agent-config/schema";

export type TabId = "conversation" | "models" | "actions" | "advanced";

/** Props every tab receives. Kept in one place so the tabs stay interchangeable. */
export interface TabProps {
  config: AgentConfig;
  update: (patch: Partial<AgentConfig>) => void;
  /** Keyed by the dotted path from the server, e.g. "variables.0.name". */
  errors: Map<string, string>;
}

/** Routes a server error to the tab that owns the field, so it can be revealed. */
export function tabForPath(path: string): TabId {
  if (path.startsWith("models")) return "models";
  if (path.startsWith("agentName") || path.startsWith("variables")) return "advanced";
  return "conversation";
}

type SaveState = "idle" | "saving" | "saved";

export function AgentConfigForm({ initialConfig }: { initialConfig: AgentConfig }) {
  const [saved, setSaved] = useState<AgentConfig>(initialConfig);
  const [config, setConfig] = useState<AgentConfig>(initialConfig);
  const [tab, setTab] = useState<TabId>("conversation");
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [formError, setFormError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  // `updatedAt` and `secretKeys` are server-owned, so they must not count as
  // edits — otherwise the bar would appear the moment a secret is added.
  const dirty = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit these from the comparison
    const strip = ({ updatedAt: _u, secretKeys: _s, ...rest }: AgentConfig) => rest;
    return JSON.stringify(strip(config)) !== JSON.stringify(strip(saved));
  }, [config, saved]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const update = useCallback((patch: Partial<AgentConfig>) => {
    setSaveState("idle");
    setConfig((current) => ({ ...current, ...patch }));
  }, []);

  const discard = useCallback(() => {
    setConfig(saved);
    setErrors(new Map());
    setFormError(null);
    setSaveState("idle");
  }, [saved]);

  const save = useCallback(async () => {
    setSaveState("saving");
    setErrors(new Map());
    setFormError(null);

    let response: Response;
    try {
      response = await fetch("/api/agent-config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(config),
      });
    } catch {
      setSaveState("idle");
      setFormError("Could not reach the server. Check that it is running and try again.");
      return;
    }

    if (!response.ok) {
      const body: { errors?: FieldError[] } = await response.json().catch(() => ({}));
      const list = body.errors ?? [{ path: "", message: "Could not save the configuration." }];
      setErrors(new Map(list.map((error) => [error.path, error.message])));
      setFormError(list.find((error) => error.path === "")?.message ?? "Some fields need fixing.");
      const firstField = list.find((error) => error.path !== "");
      if (firstField) setTab(tabForPath(firstField.path));
      setSaveState("idle");
      return;
    }

    const next: AgentConfig = await response.json();
    setSaved(next);
    setConfig(next);
    setSaveState("saved");
  }, [config]);

  const tabProps: TabProps = { config, update, errors };

  return (
    <div className="mt-8 flex flex-col">
      <Tabs value={tab} onValueChange={(value) => setTab(value as TabId)}>
        <TabsList>
          <TabsTrigger value="conversation">
            <MessageSquare className="size-3.5" />
            Conversation
          </TabsTrigger>
          <TabsTrigger value="models">
            <Sparkles className="size-3.5" />
            Models &amp; Voice
          </TabsTrigger>
          <TabsTrigger value="actions">
            <Zap className="size-3.5" />
            Actions
          </TabsTrigger>
          <TabsTrigger value="advanced">
            <Settings2 className="size-3.5" />
            Advanced
          </TabsTrigger>
        </TabsList>

        <TabsContent value="conversation" className="mt-7">
          <ConversationTab {...tabProps} />
        </TabsContent>
        <TabsContent value="models" className="mt-7">
          <ModelsVoiceTab {...tabProps} />
        </TabsContent>
        <TabsContent value="actions" className="mt-7">
          <ActionsTab />
        </TabsContent>
        <TabsContent value="advanced" className="mt-7">
          <AdvancedTab {...tabProps} />
        </TabsContent>
      </Tabs>

      {formError && (
        <p
          role="alert"
          className="animate-fade-rise mt-6 flex items-start gap-2.5 rounded-2xl border border-[var(--danger)]/35 bg-[var(--danger)]/10 px-5 py-4 text-sm text-[var(--danger)]"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{formError}</span>
        </p>
      )}

      {/* Saving is always explicit: a half-typed prompt must not become the
          live persona. */}
      <div className="sticky bottom-0 mt-8 flex items-center justify-end gap-3 border-t border-[var(--border)] bg-[var(--bg)]/85 py-4 backdrop-blur">
        {saveState === "saved" && !dirty && (
          <span className="mr-auto inline-flex items-center gap-1.5 text-sm text-[var(--success)]">
            <Check className="size-4" />
            Saved
          </span>
        )}
        {dirty && (
          <span className="mr-auto text-sm text-[var(--text-muted)]">Unsaved changes</span>
        )}
        <Button variant="ghost" onClick={discard} disabled={!dirty || saveState === "saving"}>
          Discard
        </Button>
        <Button
          variant="primary"
          onClick={() => void save()}
          disabled={!dirty || saveState === "saving"}
        >
          {saveState === "saving" && <Loader2 className="animate-spin" />}
          Save changes
        </Button>
      </div>
    </div>
  );
}
