import { test } from "node:test";
import assert from "node:assert/strict";

import { needsSaveChoice, settingsChangedDuringCall } from "./preview-hints";

test("asks how to proceed only when there are unsaved edits", () => {
  assert.equal(needsSaveChoice(true), true);
  assert.equal(needsSaveChoice(false), false);
});

test("reports a settings change made during a call", () => {
  assert.equal(settingsChangedDuringCall("2026-08-16T10:00:00.000Z", "2026-08-16T10:05:00.000Z"), true);
});

test("reports no change when the saved stamp is untouched", () => {
  assert.equal(settingsChangedDuringCall("2026-08-16T10:00:00.000Z", "2026-08-16T10:00:00.000Z"), false);
});

test("reports no change when no call is running", () => {
  assert.equal(settingsChangedDuringCall(null, "2026-08-16T10:05:00.000Z"), false);
});
