import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_AGENT_CONFIG } from "./defaults";
import { buildSystemInstruction, resolveAgentConfig } from "./resolve";
import type { AgentConfig } from "./schema";

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { ...DEFAULT_AGENT_CONFIG, ...overrides };
}

const company = { id: "1", type: "string" as const, name: "company", previewValue: "Selorax" };

test("interpolates the instructions", () => {
  const resolved = resolveAgentConfig(
    config({ instructions: "Agent for {company}.", variables: [company] }),
  );
  assert.equal(resolved.instructions, "Agent for Selorax.");
});

test("interpolates the welcome message", () => {
  const resolved = resolveAgentConfig(
    config({
      welcome: { enabled: true, message: "Thanks for calling {company}.", allowInterrupt: true },
      variables: [company],
    }),
  );
  assert.equal(resolved.welcome.message, "Thanks for calling Selorax.");
});

test("carries the models block through untouched", () => {
  const resolved = resolveAgentConfig(config());
  assert.deepEqual(resolved.models, DEFAULT_AGENT_CONFIG.models);
});

test("appends the greeting directive when the welcome is enabled", () => {
  const resolved = resolveAgentConfig(
    config({
      instructions: "Be brief.",
      welcome: { enabled: true, message: "Hi there.", allowInterrupt: true },
      callEnding: { enabled: false, policy: "" },
    }),
  );
  assert.equal(
    buildSystemInstruction(resolved),
    'Be brief.\n\nOpen the call by saying exactly: "Hi there."',
  );
});

test("omits the greeting directive when the welcome is disabled", () => {
  const resolved = resolveAgentConfig(
    config({
      instructions: "Be brief.",
      welcome: { enabled: false, message: "Hi there.", allowInterrupt: true },
      callEnding: { enabled: false, policy: "" },
    }),
  );
  assert.equal(buildSystemInstruction(resolved), "Be brief.");
});

test("omits the greeting directive when the message is blank", () => {
  const resolved = resolveAgentConfig(
    config({
      instructions: "Be brief.",
      welcome: { enabled: true, message: "   ", allowInterrupt: true },
      callEnding: { enabled: false, policy: "" },
    }),
  );
  assert.equal(buildSystemInstruction(resolved), "Be brief.");
});

test("appends the hang-up policy, and names the mechanism as well as the rule", () => {
  const resolved = resolveAgentConfig(
    config({
      instructions: "Be brief.",
      welcome: { enabled: false, message: "", allowInterrupt: true },
      callEnding: { enabled: true, policy: "End on abuse." },
    }),
  );

  const instruction = buildSystemInstruction(resolved);
  assert.ok(instruction.includes("End on abuse."));
  // Policy without mechanism produces an agent that announces it is hanging up
  // and then keeps listening, so the function name must be spelled out.
  assert.ok(instruction.includes("end_call"));
});

test("omits the hang-up section when the agent may not end calls", () => {
  const resolved = resolveAgentConfig(
    config({
      instructions: "Be brief.",
      welcome: { enabled: false, message: "", allowInterrupt: true },
      callEnding: { enabled: false, policy: "End on abuse." },
    }),
  );
  assert.equal(buildSystemInstruction(resolved), "Be brief.");
});

test("interpolates variables into the hang-up policy", () => {
  const resolved = resolveAgentConfig(
    config({
      welcome: { enabled: false, message: "", allowInterrupt: true },
      callEnding: { enabled: true, policy: "Say goodbye on behalf of {company}." },
      variables: [company],
    }),
  );
  assert.ok(resolved.callEnding.policy.includes("Selorax"));
});
