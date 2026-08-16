import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_SELORAX_CONFIG,
  isSeloraxConfigured,
  tokenExpiryMs,
  validateSeloraxConfig,
} from "./config";

const VALID = {
  baseUrl: "https://api.selorax.io",
  authToken: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE3ODk1MDAwMDB9.sig",
  storeId: "42",
};

test("accepts a complete connection", () => {
  const result = validateSeloraxConfig(VALID);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.storeId, "42");
});

test("absent config reads as empty rather than failing", () => {
  const result = validateSeloraxConfig(undefined);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, EMPTY_SELORAX_CONFIG);
});

test("an entirely blank form is 'not configured yet', not an error", () => {
  const result = validateSeloraxConfig({ baseUrl: "", authToken: "", storeId: "" });
  assert.equal(result.ok, true);
});

test("reports every missing field at once", () => {
  const result = validateSeloraxConfig({ ...VALID, authToken: "", storeId: "" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errors.length, 2);
});

test("rejects a base URL that is not http or https", () => {
  const result = validateSeloraxConfig({ ...VALID, baseUrl: "ftp://api.selorax.io" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errors[0].path, "baseUrl");
});

test("strips a trailing slash so paths never double up", () => {
  const result = validateSeloraxConfig({ ...VALID, baseUrl: "https://api.selorax.io/" });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.baseUrl, "https://api.selorax.io");
});

test("trims whitespace, which a pasted token almost always carries", () => {
  const result = validateSeloraxConfig({ ...VALID, authToken: `  ${VALID.authToken}  ` });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.authToken, VALID.authToken);
});

test("isSeloraxConfigured is false until every field is present", () => {
  assert.equal(isSeloraxConfigured(EMPTY_SELORAX_CONFIG), false);
  assert.equal(isSeloraxConfigured({ ...VALID, authToken: "" }), false);
  assert.equal(isSeloraxConfigured(VALID), true);
});

test("reads the expiry out of a JWT so the operator can be warned before it lapses", () => {
  // Payload {"exp":1789500000}. Not verified — we do not hold the secret and
  // do not need to; this drives a warning, never a decision.
  assert.equal(tokenExpiryMs(VALID.authToken), 1789500000 * 1000);
});

test("an unreadable token has no expiry rather than throwing", () => {
  assert.equal(tokenExpiryMs("not-a-jwt"), null);
  assert.equal(tokenExpiryMs(""), null);
  assert.equal(tokenExpiryMs("a.b.c"), null);
});
