"use client";

import { useCallback } from "react";

import { useAgentConfig } from "@/components/agent-config/AgentConfigProvider";
import { CONFIG_ROUTES } from "@/lib/agent-config/routes";

/**
 * Client-side navigation never fires `beforeunload`, so leaving the editor with
 * unsaved edits would silently discard them. Moving BETWEEN configuration
 * screens is safe — the provider outlives them — so only leaving the
 * configuration area prompts.
 */
export function useNavGuard(): (href: string) => boolean {
  const { dirty } = useAgentConfig();

  return useCallback(
    (href: string) => {
      if (!dirty) return true;
      if (CONFIG_ROUTES.includes(href)) return true;
      return window.confirm(
        "You have unsaved changes to the agent configuration.\n\n" +
          "Leaving this section discards them. Leave anyway?",
      );
    },
    [dirty],
  );
}
