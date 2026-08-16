import { test } from "node:test";
import assert from "node:assert/strict";

import { EMPTY_CREDENTIALS, validateSipCredentials } from "./credentials";

const VALID = {
  wsUrl: "wss://sip.example.com:8089/ws",
  sipUri: "sip:ext-8@sip.example.com",
  sipDomain: "sip.example.com",
  extension: "ext-8",
  password: "s3cret",
};

test("accepts a complete set of credentials", () => {
  const result = validateSipCredentials(VALID);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.extension, "ext-8");
});

test("absent credentials read as empty rather than failing", () => {
  const result = validateSipCredentials(undefined);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, EMPTY_CREDENTIALS);
});

test("rejects a websocket URL that is not ws or wss", () => {
  const result = validateSipCredentials({ ...VALID, wsUrl: "https://sip.example.com/ws" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errors[0].path, "wsUrl");
});

test("rejects a SIP URI without the sip: scheme", () => {
  const result = validateSipCredentials({ ...VALID, sipUri: "ext-8@sip.example.com" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errors[0].path, "sipUri");
});

test("an entirely blank form is 'not configured yet', not an error", () => {
  // This is the state the page starts in; it must not show five red errors
  // before the operator has typed anything.
  const result = validateSipCredentials({ wsUrl: "", sipUri: "", sipDomain: "", extension: "", password: "" });
  assert.equal(result.ok, true);
});

test("reports every missing field at once, not just the first", () => {
  const result = validateSipCredentials({ ...VALID, sipUri: "", sipDomain: "", extension: "", password: "" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errors.length, 4);
});

test("trims surrounding whitespace, which a paste almost always carries", () => {
  const result = validateSipCredentials({ ...VALID, extension: "  ext-8  " });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.extension, "ext-8");
});

test("a partially filled form is rejected rather than half-saved", () => {
  const result = validateSipCredentials({ ...VALID, password: "" });
  assert.equal(result.ok, false);
});
