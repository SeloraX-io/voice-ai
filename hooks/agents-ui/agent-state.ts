/**
 * The agent states the aura visualiser reacts to.
 *
 * Upstream this type comes from `@livekit/components-react`. It is reproduced
 * here so the visualiser needs no LiveKit dependency: the union is the full set
 * the aura hook switches on, and nothing in this project ever produces the
 * LiveKit-specific members — they are kept so the vendored hook stays a
 * minimal diff against upstream and can be re-synced later.
 */
export type AgentState =
  | "idle"
  | "connecting"
  | "initializing"
  | "listening"
  | "thinking"
  | "speaking"
  | "pre-connect-buffering"
  | "failed"
  | "disconnected";
