import { test } from "node:test";
import assert from "node:assert/strict";

import { remainingPlayoutMs } from "./playout";

test("nothing scheduled means nothing left to play", () => {
  assert.equal(remainingPlayoutMs(5, 5), 0);
});

test("audio scheduled ahead reports the gap in milliseconds", () => {
  assert.equal(remainingPlayoutMs(5.5, 5), 500);
});

test("a schedule already in the past never reports negative time", () => {
  // Web Audio's currentTime runs on past a finished schedule; a naive
  // subtraction would return a negative wait and the caller would hang up early.
  assert.equal(remainingPlayoutMs(4, 5), 0);
});

test("rounds to whole milliseconds so it can drive a timer", () => {
  assert.equal(remainingPlayoutMs(5.0004, 5), 0);
  assert.equal(remainingPlayoutMs(5.0006, 5), 1);
});
