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
    }),
  );
  assert.equal(buildSystemInstruction(resolved), "Be brief.");
});

test("omits the greeting directive when the message is blank", () => {
  const resolved = resolveAgentConfig(
    config({
      instructions: "Be brief.",
      welcome: { enabled: true, message: "   ", allowInterrupt: true },
    }),
  );
  assert.equal(buildSystemInstruction(resolved), "Be brief.");
});
