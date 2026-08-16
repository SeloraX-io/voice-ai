import { test } from "node:test";
import assert from "node:assert/strict";

import { readCallChannel } from "./channel";

test("an absent channel defaults to browser, so old records stay valid", () => {
  // ~500 records were written before this field existed. None may be dropped.
  assert.equal(readCallChannel(undefined), "browser");
});

test("reads a known channel", () => {
  assert.equal(readCallChannel("phone"), "phone");
});

test("an unknown channel falls back rather than throwing", () => {
  assert.equal(readCallChannel("carrier-pigeon"), "browser");
});
