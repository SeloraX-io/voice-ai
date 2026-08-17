/**
 * The bridge's lifecycle, as a pure reducer.
 *
 * Everything else in the bridge touches JsSIP, WebRTC or an AudioContext and
 * cannot be tested in this repo's Node test runner. This file deliberately
 * holds no browser object, so the part most likely to be wrong — the ordering
 * rules between SIP events and gateway events — is the part under test.
 */

export type BridgeStatus =
  | "offline"
  | "connecting"
  | "online"
  | "ringing"
  | "in_call"
  | "ending"
  | "failed";

export type BridgeEvent =
  | { type: "go_online" }
  | { type: "registered" }
  | { type: "registration_failed"; message: string }
  | { type: "incoming"; from: string | null; to: string | null }
  | { type: "gateway_open" }
  | { type: "agent_ending"; reason: string }
  | { type: "gateway_closed" }
  | { type: "call_ended" }
  | { type: "go_offline" };

export interface BridgeState {
  status: BridgeStatus;
  /** The caller's number, when the SIP headers carried one. */
  from: string | null;
  /** The number that was dialled. */
  to: string | null;
  /** Set when the agent decided to hang up, for the call record. */
  endReason: string | null;
  /** Set on a registration failure, shown to the operator. */
  error: string | null;
}

export const INITIAL_BRIDGE_STATE: BridgeState = {
  status: "offline",
  from: null,
  to: null,
  endReason: null,
  error: null,
};

/** Clears per-call detail so the next call cannot inherit the last one's. */
function idle(status: BridgeStatus): BridgeState {
  return { status, from: null, to: null, endReason: null, error: null };
}

export function bridgeReducer(state: BridgeState, event: BridgeEvent): BridgeState {
  switch (event.type) {
    // An operator hanging up the bridge wins from anywhere, including
    // mid-call — it is the stop button.
    case "go_offline":
      return idle("offline");

    case "go_online":
      return { ...idle("connecting") };

    case "registered":
      return state.status === "connecting" ? idle("online") : state;

    case "registration_failed":
      return { ...idle("failed"), error: event.message };

    case "incoming":
      // Only an idle, registered bridge takes a call. A second INVITE while
      // one is live is ignored here and rejected by the shell.
      if (state.status !== "online") return state;
      return { ...state, status: "ringing", from: event.from, to: event.to };

    case "gateway_open":
      return state.status === "ringing" ? { ...state, status: "in_call" } : state;

    // The agent asked to hang up, but its closing sentence is still being
    // generated and then played. The call ends on `gateway_closed`, not here.
    case "agent_ending":
      return state.status === "in_call" ? { ...state, endReason: event.reason } : state;

    // The gateway is done. Audio may still be queued in the player, so the
    // shell drains before terminating SIP — hence a distinct state.
    case "gateway_closed":
      return state.status === "in_call" ? { ...state, status: "ending" } : state;

    case "call_ended":
      if (state.status === "offline" || state.status === "failed") return state;
      return idle("online");

    default:
      return state;
  }
}
