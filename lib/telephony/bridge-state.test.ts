import { test } from "node:test";
import assert from "node:assert/strict";

import { INITIAL_BRIDGE_STATE, bridgeReducer, type BridgeState } from "./bridge-state";

function reduce(events: Parameters<typeof bridgeReducer>[1][]): BridgeState {
  return events.reduce(bridgeReducer, INITIAL_BRIDGE_STATE);
}

test("starts offline", () => {
  assert.equal(INITIAL_BRIDGE_STATE.status, "offline");
});

test("registering moves through connecting to online", () => {
  assert.equal(reduce([{ type: "go_online" }]).status, "connecting");
  assert.equal(reduce([{ type: "go_online" }, { type: "registered" }]).status, "online");
});

test("a registration failure is reported with its message", () => {
  const state = reduce([
    { type: "go_online" },
    { type: "registration_failed", message: "401 Unauthorized" },
  ]);
  assert.equal(state.status, "failed");
  assert.equal(state.error, "401 Unauthorized");
});

test("an incoming call carries the caller's number", () => {
  const state = reduce([
    { type: "go_online" },
    { type: "registered" },
    { type: "incoming", from: "+8801700000000", to: "+8809600000000" },
  ]);
  assert.equal(state.status, "ringing");
  assert.equal(state.from, "+8801700000000");
  assert.equal(state.to, "+8809600000000");
});

test("the call becomes live only once the gateway is open", () => {
  const ringing = reduce([
    { type: "go_online" },
    { type: "registered" },
    { type: "incoming", from: null, to: null },
  ]);
  assert.equal(bridgeReducer(ringing, { type: "gateway_open" }).status, "in_call");
});

test("the agent asking to hang up records the reason without ending the call", () => {
  const inCall = reduce([
    { type: "go_online" },
    { type: "registered" },
    { type: "incoming", from: null, to: null },
    { type: "gateway_open" },
  ]);
  const ending = bridgeReducer(inCall, { type: "agent_ending", reason: "caller was abusive" });
  // Still in_call: the agent is mid-goodbye and the audio must finish playing.
  assert.equal(ending.status, "in_call");
  assert.equal(ending.endReason, "caller was abusive");
});

test("the gateway closing drains before the call is torn down", () => {
  const inCall = reduce([
    { type: "go_online" },
    { type: "registered" },
    { type: "incoming", from: null, to: null },
    { type: "gateway_open" },
  ]);
  assert.equal(bridgeReducer(inCall, { type: "gateway_closed" }).status, "ending");
});

test("returns to online after a call ends, ready for the next one", () => {
  const ending = reduce([
    { type: "go_online" },
    { type: "registered" },
    { type: "incoming", from: "+880", to: null },
    { type: "gateway_open" },
    { type: "gateway_closed" },
  ]);
  const done = bridgeReducer(ending, { type: "call_ended" });
  assert.equal(done.status, "online");
  // Per-call detail is cleared so the next call cannot inherit it.
  assert.equal(done.from, null);
  assert.equal(done.endReason, null);
});

test("a caller who hangs up mid-call returns straight to online", () => {
  const inCall = reduce([
    { type: "go_online" },
    { type: "registered" },
    { type: "incoming", from: null, to: null },
    { type: "gateway_open" },
  ]);
  assert.equal(bridgeReducer(inCall, { type: "call_ended" }).status, "online");
});

test("a caller who gives up while ringing returns to online", () => {
  const ringing = reduce([
    { type: "go_online" },
    { type: "registered" },
    { type: "incoming", from: null, to: null },
  ]);
  assert.equal(bridgeReducer(ringing, { type: "call_ended" }).status, "online");
});

test("going offline wins from any state", () => {
  const inCall = reduce([
    { type: "go_online" },
    { type: "registered" },
    { type: "incoming", from: null, to: null },
    { type: "gateway_open" },
  ]);
  assert.equal(bridgeReducer(inCall, { type: "go_offline" }).status, "offline");
});

test("an unknown event leaves the state untouched", () => {
  const online = reduce([{ type: "go_online" }, { type: "registered" }]);
  // @ts-expect-error deliberately invalid, to prove the reducer is total
  assert.equal(bridgeReducer(online, { type: "nonsense" }), online);
});
