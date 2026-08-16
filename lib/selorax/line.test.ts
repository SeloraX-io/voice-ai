import { test } from "node:test";
import assert from "node:assert/strict";

import { toLineResponse } from "./line";

const LINE = {
  wsUrl: "wss://sip.example.com/ws",
  sipUri: "sip:ext-8@sip.example.com",
  sipDomain: "sip.example.com",
  extension: "ext-8",
  password: "s3cret",
  iceServers: [{ urls: "turn:turn.example.com", username: "u", credential: "c" }],
};

test("passes through exactly the fields the browser needs", () => {
  const body = toLineResponse(LINE);
  assert.deepEqual(Object.keys(body).sort(), [
    "extension", "iceServers", "password", "sipDomain", "sipUri", "wsUrl",
  ]);
});

test("cannot leak a Selorax credential even if one is attached upstream", () => {
  // The response is built field by field rather than spread, so a field added
  // to SeloraxLine later cannot silently reach the browser.
  const contaminated = { ...LINE, authToken: "token-abc", storeId: "42" } as never;
  const body = toLineResponse(contaminated);
  const serialised = JSON.stringify(body);
  assert.ok(!serialised.includes("token-abc"));
  assert.ok(!("authToken" in body));
});

test("the SIP password IS included — digest auth happens in the browser", () => {
  // Stated as a test so nobody 'fixes' it later: without this the bridge
  // cannot register at all. See the spec's §3.
  assert.equal(toLineResponse(LINE).password, "s3cret");
});
