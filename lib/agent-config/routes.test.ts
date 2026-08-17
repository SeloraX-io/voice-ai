import { test } from "node:test";
import assert from "node:assert/strict";

import { AGENT_ROUTES, routeForPath } from "./routes";

test("routes model errors to the models screen", () => {
  assert.equal(routeForPath("models"), "/models-voice");
  assert.equal(routeForPath("models.temperature"), "/models-voice");
  assert.equal(routeForPath("models.vad.silenceDurationMs"), "/models-voice");
});

test("routes agent name and variable errors to the advanced screen", () => {
  assert.equal(routeForPath("agentName"), "/agent/advanced");
  assert.equal(routeForPath("variables"), "/agent/advanced");
  assert.equal(routeForPath("variables.0.name"), "/agent/advanced");
});

test("routes everything else to the conversation screen", () => {
  assert.equal(routeForPath("instructions"), "/agent/conversation");
  assert.equal(routeForPath("welcome.message"), "/agent/conversation");
  assert.equal(routeForPath("type"), "/agent/conversation");
});

test("does not route a form-level error", () => {
  assert.equal(routeForPath(""), null);
});

test("routes tool errors to the actions screen", () => {
  assert.equal(routeForPath("tools"), "/agent/actions");
  assert.equal(routeForPath("tools.http.0.name"), "/agent/actions");
  assert.equal(routeForPath("tools.webhooks.1.events"), "/agent/actions");
});

test("every configuration route in the nav has a label and a group", () => {
  for (const route of AGENT_ROUTES) {
    assert.ok(route.label.length > 0);
    assert.ok(route.group === "agent" || route.group === null);
  }
});
