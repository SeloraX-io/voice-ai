import { test } from "node:test";
import assert from "node:assert/strict";

import type { AgentVariable } from "./schema";
import { coercePreviewValue, findTokens, findUnknownTokens, interpolate } from "./template";

const company: AgentVariable = { id: "1", type: "string", name: "company", previewValue: "Selorax" };
const count: AgentVariable = { id: "2", type: "number", name: "count", previewValue: "3" };
const vip: AgentVariable = { id: "3", type: "boolean", name: "vip", previewValue: "true" };

test("finds tokens in order without duplicates", () => {
  assert.deepEqual(findTokens("{a} then {b} then {a}"), ["a", "b"]);
});

test("ignores tokens that are not identifiers", () => {
  assert.deepEqual(findTokens("{9bad} {with space} {ok_1}"), ["ok_1"]);
});

test("returns an empty list for text with no tokens", () => {
  assert.deepEqual(findTokens("plain text"), []);
});

test("substitutes a string variable", () => {
  assert.equal(interpolate("Agent for {company}.", [company]), "Agent for Selorax.");
});

test("substitutes every occurrence", () => {
  assert.equal(interpolate("{company} and {company}", [company]), "Selorax and Selorax");
});

test("coerces a number preview value", () => {
  assert.equal(coercePreviewValue(count), "3");
  assert.equal(interpolate("You have {count}.", [count]), "You have 3.");
});

test("coerces a boolean preview value", () => {
  assert.equal(coercePreviewValue(vip), "true");
  assert.equal(coercePreviewValue({ ...vip, previewValue: "no" }), "false");
});

test("leaves unknown tokens exactly as written", () => {
  assert.equal(interpolate("Hi {missing}.", [company]), "Hi {missing}.");
});

test("does not re-expand a value that contains a token", () => {
  const nested: AgentVariable = { id: "4", type: "string", name: "a", previewValue: "{b}" };
  const b: AgentVariable = { id: "5", type: "string", name: "b", previewValue: "deep" };
  assert.equal(interpolate("{a}", [nested, b]), "{b}");
});

test("reports unknown tokens", () => {
  assert.deepEqual(findUnknownTokens("{company} {missing} {other}", [company]), ["missing", "other"]);
});

test("reports no unknown tokens when all are declared", () => {
  assert.deepEqual(findUnknownTokens("{company}", [company]), []);
});
