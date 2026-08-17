import { test } from "node:test";
import assert from "node:assert/strict";

import {
  countTurnServers,
  normaliseIceServers,
  parseLineResponse,
  toLineResponse,
} from "./line";

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

/* -------------------------------------------------------------------------- */
/* normaliseIceServers                                                        */
/* -------------------------------------------------------------------------- */

test("keeps a TURN server whole, credentials included", () => {
  assert.deepEqual(normaliseIceServers(LINE.iceServers), [
    { urls: "turn:turn.example.com", username: "u", credential: "c" },
  ]);
});

test("keeps a bare STUN entry, which has no credentials", () => {
  assert.deepEqual(normaliseIceServers([{ urls: "stun:stun.example.com:3478" }]), [
    { urls: "stun:stun.example.com:3478" },
  ]);
});

test("accepts urls as a list, dropping empty entries in it", () => {
  assert.deepEqual(normaliseIceServers([{ urls: ["turn:a", "", "turns:b"] }]), [
    { urls: ["turn:a", "turns:b"] },
  ]);
});

test("drops only the unusable server, never the whole list", () => {
  // TURN is best-effort upstream: one malformed entry must not cost the bridge
  // the servers that arrived alongside it.
  const servers = normaliseIceServers([
    { urls: "" },
    null,
    "turn:not-an-object",
    { username: "u" },
    { urls: "turn:good.example.com", username: "u", credential: "c" },
  ]);
  assert.deepEqual(servers, [{ urls: "turn:good.example.com", username: "u", credential: "c" }]);
});

test("a missing or malformed list is no ICE servers, not a failure", () => {
  assert.deepEqual(normaliseIceServers(undefined), []);
  assert.deepEqual(normaliseIceServers({ urls: "turn:a" }), []);
});

test("nothing but urls, username and credential reaches the peer connection", () => {
  const [server] = normaliseIceServers([
    { urls: "turn:a", username: "u", credential: "c", credentialType: "password", extra: 1 },
  ]);
  assert.deepEqual(Object.keys(server).sort(), ["credential", "urls", "username"]);
});

/* -------------------------------------------------------------------------- */
/* countTurnServers                                                           */
/* -------------------------------------------------------------------------- */

test("counts what can actually relay, not what is merely present", () => {
  const servers = normaliseIceServers([
    { urls: "stun:stun.example.com:3478" },
    { urls: "turn:turn.example.com:3478", username: "u", credential: "c" },
    { urls: ["stun:other.example.com", "turns:turn.example.com:5349"] },
  ]);
  assert.equal(servers.length, 3);
  assert.equal(countTurnServers(servers), 2);
});

test("STUN alone counts as no TURN — the whole point of the distinction", () => {
  assert.equal(countTurnServers(normaliseIceServers([{ urls: "stun:stun.example.com" }])), 0);
  assert.equal(countTurnServers([]), 0);
});

test("a scheme is not matched inside a host name", () => {
  assert.equal(countTurnServers([{ urls: "stun:turn.example.com" }]), 0);
});

/* -------------------------------------------------------------------------- */
/* parseLineResponse                                                          */
/* -------------------------------------------------------------------------- */

test("reads the five SIP values and the ICE servers back out", () => {
  const line = parseLineResponse(LINE);
  assert.deepEqual(line?.credentials, {
    wsUrl: LINE.wsUrl,
    sipUri: LINE.sipUri,
    sipDomain: LINE.sipDomain,
    extension: LINE.extension,
    password: LINE.password,
  });
  assert.equal(line?.iceServers.length, 1);
});

test("a line with no ICE servers is still a line", () => {
  // Registering STUN-only beats not answering the phone — Selorax treats TURN
  // as best-effort for the same reason.
  const line = parseLineResponse({ ...LINE, iceServers: [] });
  assert.equal(line?.iceServers.length, 0);
  assert.equal(line?.credentials.extension, "ext-8");
});

test("a half-line is rejected rather than half-registered", () => {
  for (const key of ["wsUrl", "sipUri", "sipDomain", "extension", "password"]) {
    assert.equal(parseLineResponse({ ...LINE, [key]: "" }), null, key);
    assert.equal(parseLineResponse({ ...LINE, [key]: undefined }), null, key);
  }
  assert.equal(parseLineResponse(null), null);
  assert.equal(parseLineResponse([LINE]), null);
});
