"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { routeForPath } from "@/lib/agent-config/routes";
import type { AgentConfig, FieldError } from "@/lib/agent-config/schema";

/** Props every configuration screen receives. */
export interface TabProps {
  config: AgentConfig;
  update: (patch: Partial<AgentConfig>) => void;
  /**
   * Secrets save immediately to their own endpoint, so they are not part of the
   * form's dirty state. Both snapshots move together, which keeps Discard from
   * reverting a list the server has already changed.
   */
  setSecretKeys: (keys: string[]) => void;
  /** Keyed by the dotted path from the server, e.g. "variables.0.name". */
  errors: Map<string, string>;
}

type SaveState = "idle" | "saving" | "saved";

export interface AgentConfigContextValue extends TabProps {
  /** Whose configuration this is. Client-scoped fetches must carry it. */
  clientId: string;
  dirty: boolean;
  formError: string | null;
  saveState: SaveState;
  /** Resolves the persisted configuration, or null when the save failed. */
  save: () => Promise<AgentConfig | null>;
  discard: () => void;
}

const AgentConfigContext = createContext<AgentConfigContextValue | null>(null);

/**
 * Order-insensitive serialisation for the dirty check.
 *
 * A plain JSON.stringify compares key order as well as content, so a screen that
 * rebuilt a nested object with its keys in a different order would leave the
 * form stuck showing "Unsaved changes" with nothing to save. Sorting keys at
 * every level makes the comparison depend on values alone. Array order is
 * preserved deliberately — reordering variables IS an edit.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

/**
 * Owns the agent configuration for the whole console.
 *
 * It lives above the router deliberately: with the four editors as routes
 * rather than tabs, state held inside a page would be unmounted — and unsaved
 * edits discarded — every time the user moved between screens.
 */
export function AgentConfigProvider({
  clientId,
  initialConfig,
  children,
}: {
  /**
   * The client whose config is being edited. The layout keys this provider by
   * it, so switching clients remounts with the new client's saved state
   * rather than diffing one client's edits against another's baseline.
   */
  clientId: string;
  initialConfig: AgentConfig;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState<AgentConfig>(initialConfig);
  const [config, setConfig] = useState<AgentConfig>(initialConfig);
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [formError, setFormError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  // `updatedAt` and `secretKeys` are server-owned, so they must not count as
  // edits — otherwise the bar would appear the moment a secret is added.
  const dirty = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit these from the comparison
    const strip = ({ updatedAt: _u, secretKeys: _s, ...rest }: AgentConfig) => rest;
    return stableStringify(strip(config)) !== stableStringify(strip(saved));
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

  const setSecretKeys = useCallback((secretKeys: string[]) => {
    setSaved((current) => ({ ...current, secretKeys }));
    setConfig((current) => ({ ...current, secretKeys }));
  }, []);

  const discard = useCallback(() => {
    setConfig(saved);
    setErrors(new Map());
    setFormError(null);
    setSaveState("idle");
  }, [saved]);

  const save = useCallback(async (): Promise<AgentConfig | null> => {
    setSaveState("saving");
    setErrors(new Map());
    setFormError(null);

    let response: Response;
    try {
      response = await fetch(`/api/agent-config?client=${encodeURIComponent(clientId)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(config),
      });
    } catch {
      setSaveState("idle");
      setFormError("Could not reach the server. Check that it is running and try again.");
      return null;
    }

    if (!response.ok) {
      const body: { errors?: FieldError[] } = await response.json().catch(() => ({}));
      const list = body.errors ?? [{ path: "", message: "Could not save the configuration." }];
      setErrors(new Map(list.map((error) => [error.path, error.message])));
      setFormError(list.find((error) => error.path === "")?.message ?? "Some fields need fixing.");
      const firstField = list.find((error) => error.path !== "");
      const route = firstField ? routeForPath(firstField.path) : null;
      if (route) router.push(route);
      setSaveState("idle");
      return null;
    }

    let next: AgentConfig;
    try {
      next = await response.json();
    } catch {
      setSaveState("idle");
      setFormError(
        "The server sent a response we could not read. Your changes are still here — try saving again.",
      );
      return null;
    }

    setSaved(next);
    setConfig(next);
    setSaveState("saved");
    return next;
  }, [clientId, config, router]);

  const value: AgentConfigContextValue = {
    clientId,
    config,
    update,
    setSecretKeys,
    errors,
    dirty,
    formError,
    saveState,
    save,
    discard,
  };

  return <AgentConfigContext.Provider value={value}>{children}</AgentConfigContext.Provider>;
}

export function useAgentConfig(): AgentConfigContextValue {
  const value = useContext(AgentConfigContext);
  if (!value) throw new Error("useAgentConfig must be used inside AgentConfigProvider");
  return value;
}
