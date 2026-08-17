import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_AGENT_CONFIG } from "./defaults";
import { validateAgentConfig } from "./schema";

function draft(overrides: Record<string, unknown> = {}) {
  return { ...DEFAULT_AGENT_CONFIG, ...overrides };
}

function errorPaths(input: unknown): string[] {
  const result = validateAgentConfig(input);
  return result.ok ? [] : result.errors.map((error) => error.path);
}

test("accepts the default config", () => {
  const result = validateAgentConfig(draft());
  assert.equal(result.ok, true);
});

test("rejects a non-object", () => {
  assert.deepEqual(errorPaths(null), [""]);
  assert.deepEqual(errorPaths("nope"), [""]);
});

test("rejects empty instructions", () => {
  assert.ok(errorPaths(draft({ instructions: "   " })).includes("instructions"));
});

test("rejects instructions past the limit", () => {
  assert.ok(errorPaths(draft({ instructions: "x".repeat(32_001) })).includes("instructions"));
});

test("rejects an empty welcome message when the welcome is enabled", () => {
  const welcome = { enabled: true, message: "", allowInterrupt: true };
  assert.ok(errorPaths(draft({ welcome })).includes("welcome.message"));
});

test("allows an empty welcome message when the welcome is disabled", () => {
  const welcome = { enabled: false, message: "", allowInterrupt: true };
  assert.equal(errorPaths(draft({ welcome })).length, 0);
});

test("rejects a variable name that is not an identifier", () => {
  const variables = [{ id: "a", type: "string", name: "my-var", previewValue: "x" }];
  assert.ok(errorPaths(draft({ variables })).includes("variables.0.name"));
});

test("rejects duplicate variable names", () => {
  const variables = [
    { id: "a", type: "string", name: "company", previewValue: "x" },
    { id: "b", type: "string", name: "company", previewValue: "y" },
  ];
  assert.ok(errorPaths(draft({ variables })).includes("variables.1.name"));
});

test("rejects a number variable whose preview value is not numeric", () => {
  const variables = [{ id: "a", type: "number", name: "count", previewValue: "abc" }];
  assert.ok(errorPaths(draft({ variables })).includes("variables.0.previewValue"));
});

test("rejects a boolean variable whose preview value is not true or false", () => {
  const variables = [{ id: "a", type: "boolean", name: "vip", previewValue: "yes" }];
  assert.ok(errorPaths(draft({ variables })).includes("variables.0.previewValue"));
});

test("rejects the data_collection type as unsupported", () => {
  assert.ok(errorPaths(draft({ type: "data_collection" })).includes("type"));
});

test("rejects an out-of-range temperature", () => {
  const models = { ...DEFAULT_AGENT_CONFIG.models, temperature: 5 };
  assert.ok(errorPaths(draft({ models })).includes("models.temperature"));
});

test("rejects a non-finite topP", () => {
  const models = { ...DEFAULT_AGENT_CONFIG.models, topP: Number.NaN };
  assert.ok(errorPaths(draft({ models })).includes("models.topP"));
});

test("rejects an out-of-range VAD silence duration", () => {
  const vad = { ...DEFAULT_AGENT_CONFIG.models.vad, silenceDurationMs: 9000 };
  const models = { ...DEFAULT_AGENT_CONFIG.models, vad };
  assert.ok(errorPaths(draft({ models })).includes("models.vad.silenceDurationMs"));
});

test("rejects an agent name that is not a slug", () => {
  assert.ok(errorPaths(draft({ agentName: "Not A Slug" })).includes("agentName"));
});

test("ignores client-supplied secretKeys", () => {
  const result = validateAgentConfig(draft({ secretKeys: ["STOLEN"] }));
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.config.secretKeys, []);
});

test("stamps the current version regardless of input", () => {
  const result = validateAgentConfig(draft({ version: 99 }));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.config.version, 1);
});

test("a config saved before tools existed still loads, keeping its other fields", () => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop `tools`
  const { tools: _tools, ...withoutTools } = DEFAULT_AGENT_CONFIG;
  const result = validateAgentConfig({ ...withoutTools, instructions: "Keep me." });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.config.instructions, "Keep me.");
    assert.deepEqual(result.config.tools, { http: [], client: [], webhooks: [] });
  }
});

test("a config saved before call-ending existed gets the ability, not silence", () => {
  // Defaulting this off would leave an existing agent announcing that it is
  // ending a call and then continuing to listen, because `end_call` would never
  // be declared to it.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit the field
  const { callEnding: _c, ...withoutCallEnding } = DEFAULT_AGENT_CONFIG;
  const result = validateAgentConfig({ ...withoutCallEnding, instructions: "Keep me." });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.config.callEnding.enabled, true);
    assert.ok(result.config.callEnding.policy.length > 0);
    assert.equal(result.config.instructions, "Keep me.");
  }
});
