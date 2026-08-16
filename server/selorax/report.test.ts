import { test } from "node:test";
import assert from "node:assert/strict";

import { dispatchReport } from "./report";
import type { CallingClient } from "./calling-client";

function stubClient(overrides: Partial<CallingClient> = {}): CallingClient {
  return {
    getLine: () => new Promise(() => {}),
    reportAnswered: () => new Promise(() => {}),
    reportDeclined: () => new Promise(() => {}),
    ...overrides,
  };
}

test("returns synchronously even when the upstream report never settles", () => {
  // Simulates the exact failure the reviewer demonstrated: fetch hangs
  // forever (e.g. an unreachable Selorax burning through the client's
  // 10-second timeout). dispatchReport must not make the caller wait for
  // that — its return value proves it, since it is not even an async
  // function: there is nothing to await.
  const client = stubClient({ reportAnswered: () => new Promise(() => {}) });
  const errors: unknown[] = [];

  const result = dispatchReport(client, "answered", "+8801700000000", (cause) => errors.push(cause));

  assert.equal(result, undefined);
  assert.deepEqual(errors, []);
});

test("calls reportDeclined for a declined event, not reportAnswered", () => {
  let answeredCalls = 0;
  let declinedCalls = 0;
  const client = stubClient({
    reportAnswered: () => {
      answeredCalls += 1;
      return new Promise(() => {});
    },
    reportDeclined: () => {
      declinedCalls += 1;
      return new Promise(() => {});
    },
  });

  dispatchReport(client, "declined", "+8801700000000", () => {});

  assert.equal(answeredCalls, 0);
  assert.equal(declinedCalls, 1);
});

test("a rejected report reaches onError instead of becoming an unhandled rejection", async () => {
  const client = stubClient({
    reportAnswered: () => Promise.reject(new Error("upstream down")),
  });
  const errors: unknown[] = [];

  dispatchReport(client, "answered", "+8801700000000", (cause) => errors.push(cause));

  // Let the already-rejected promise's .catch microtask run.
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(errors.length, 1);
  assert.match(String((errors[0] as Error).message), /upstream down/);
});
