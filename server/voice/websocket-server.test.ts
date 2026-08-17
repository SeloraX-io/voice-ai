import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCallOrigin } from "./websocket-server";

/** Just enough of an upgrade request for the query string to be read off it. */
const request = (url: string) => ({ url, headers: {} });

test("a preview connection is a browser call with no numbers", () => {
  assert.deepEqual(parseCallOrigin(request("/voice")), { channel: "browser", phone: null });
});

test("keeps both numbers when the bridge sends both", () => {
  assert.deepEqual(parseCallOrigin(request("/voice?channel=phone&from=%2B8801711&to=%2B8809610")), {
    channel: "phone",
    phone: { from: "+8801711", to: "+8809610" },
  });
});

test("a withheld caller ID does not discard the number that was dialled", () => {
  assert.deepEqual(parseCallOrigin(request("/voice?channel=phone&to=%2B8809610")), {
    channel: "phone",
    phone: { from: null, to: "+8809610" },
  });
});

test("keeps the caller when the dialled number is missing", () => {
  assert.deepEqual(parseCallOrigin(request("/voice?channel=phone&from=%2B8801711")), {
    channel: "phone",
    phone: { from: "+8801711", to: null },
  });
});

test("phone is null only when neither number was sent", () => {
  assert.equal(parseCallOrigin(request("/voice?channel=phone")).phone, null);
});

test("bounds a hostile number rather than putting it on the call record", () => {
  const long = "9".repeat(500);
  const { phone } = parseCallOrigin(request(`/voice?channel=phone&from=${long}`));
  assert.equal(phone?.from?.length, 64);
  assert.equal(phone?.to, null);
});

test("an unrecognised channel reads as a browser call", () => {
  assert.equal(parseCallOrigin(request("/voice?channel=carrier-pigeon")).channel, "browser");
});
