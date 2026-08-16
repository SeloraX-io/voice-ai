/**
 * The console's navigation map, and where a validation error belongs.
 *
 * Kept free of React so it can be unit tested and imported from anywhere. The
 * sidebar renders from AGENT_ROUTES; the provider uses routeForPath to reveal
 * the screen owning a rejected field, the way the old tab bar switched tabs.
 */

export type AgentRoute =
  | "/agent/conversation"
  | "/agent/actions"
  | "/agent/advanced"
  | "/models-voice";

export interface NavRoute {
  href: string;
  label: string;
  /** "agent" nests the item under the Agent heading; null makes it top level. */
  group: "agent" | null;
}

export const AGENT_ROUTES: readonly NavRoute[] = [
  { href: "/agent/conversation", label: "Conversation", group: "agent" },
  { href: "/agent/actions", label: "Actions", group: "agent" },
  { href: "/agent/advanced", label: "Advanced", group: "agent" },
  { href: "/models-voice", label: "Models & Voice", group: null },
  { href: "/upload", label: "Upload Audio", group: null },
] as const;

/** Routes that edit the agent configuration, so the save bar belongs on them. */
export const CONFIG_ROUTES: readonly string[] = [
  "/agent/conversation",
  "/agent/actions",
  "/agent/advanced",
  "/models-voice",
];

/**
 * Where a server validation error should send the user. Returns null for a
 * form-level error (empty path), which must not trigger navigation.
 */
export function routeForPath(path: string): AgentRoute | null {
  if (path === "") return null;
  if (path.startsWith("models")) return "/models-voice";
  if (path.startsWith("agentName") || path.startsWith("variables")) return "/agent/advanced";
  if (path.startsWith("tools")) return "/agent/actions";
  return "/agent/conversation";
}
