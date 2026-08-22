import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_AGENT_CONFIG } from "./defaults";
import {
  WAIT_FOR_CALLER_DIRECTIVE,
  buildSystemInstruction,
  resolveAgentConfig,
} from "./resolve";
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

test("a disabled welcome states that the caller speaks first", () => {
  // The gateway will not prime a greeting turn, so the prompt must not leave
  // room for instructions that assume the agent opens the call.
  const resolved = resolveAgentConfig(
    config({
      instructions: "Be brief.",
      welcome: { enabled: false, message: "Hi there.", allowInterrupt: true },
      callEnding: { enabled: false, policy: "" },
    }),
  );
  assert.equal(buildSystemInstruction(resolved), `Be brief.\n\n${WAIT_FOR_CALLER_DIRECTIVE}`);
});

test("a blank welcome message states that the caller speaks first", () => {
  const resolved = resolveAgentConfig(
    config({
      instructions: "Be brief.",
      welcome: { enabled: true, message: "   ", allowInterrupt: true },
      callEnding: { enabled: false, policy: "" },
    }),
  );
  assert.equal(buildSystemInstruction(resolved), `Be brief.\n\n${WAIT_FOR_CALLER_DIRECTIVE}`);
});

test("an enabled greeting and the wait directive are mutually exclusive", () => {
  const resolved = resolveAgentConfig(
    config({
      instructions: "Be brief.",
      welcome: { enabled: true, message: "Hi there.", allowInterrupt: true },
      callEnding: { enabled: false, policy: "" },
    }),
  );
  assert.equal(buildSystemInstruction(resolved).includes(WAIT_FOR_CALLER_DIRECTIVE), false);
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
  const instruction = buildSystemInstruction(resolved);
  assert.equal(instruction.includes("end_call"), false);
  assert.equal(instruction.includes("End on abuse."), false);
});

test("the default config opens with the default greeting, not the wait directive", () => {
  // The seed persona greets: welcome is enabled by default, and the
  // instructions themselves say nothing about opening the call — the greeting
  // directive is the single source of that behaviour.
  const instruction = buildSystemInstruction(resolveAgentConfig(config()));
  assert.equal(DEFAULT_AGENT_CONFIG.welcome.enabled, true);
  assert.equal(DEFAULT_AGENT_CONFIG.instructions.includes("Open the call"), false);
  assert.ok(instruction.includes(`Open the call by saying exactly: "${DEFAULT_AGENT_CONFIG.welcome.message}"`));
  assert.equal(instruction.includes(WAIT_FOR_CALLER_DIRECTIVE), false);
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
