import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";

import { createCallingClient, SeloraxError } from "./calling-client";

const CONFIG = {
  baseUrl: "https://api.selorax.io",
  authToken: "token-abc",
  storeId: "42",
};

function stub(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, calls };
}

const LINE = {
  data: {
    ws_url: "wss://sip.example.com/ws",
    sip_uri: "sip:ext-8@sip.example.com",
    sip_domain: "sip.example.com",
    extension: "ext-8",
    password: "s3cret",
    iceServers: [{ urls: "turn:turn.example.com", username: "u", credential: "c" }],
  },
  status: 200,
};

test("asks the right endpoint with the right identity headers", async () => {
  const { impl, calls } = stub(200, LINE);
  await createCallingClient(CONFIG, impl).getLine();

  assert.equal(calls[0].url, "https://api.selorax.io/api/calling/extension");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers["x-auth-token"], "token-abc");
  // Stable, so a restart does not look like a new device and churn the claim.
  assert.equal(headers["x-device-id"], "ai-bridge-42");
});

test("never sends x-store-id — it makes Selorax demand a dashboard session", async () => {
  // Verified against the live API: `x-auth-token` alone returns 200, and
  // adding *any* non-empty `x-store-id` — even one matching the token's own
  // `store_id` claim — turns the same request into 401 `session_required`.
  // That header puts the request on the store-switching path, which wants a
  // registered browser session the bridge does not and cannot have. The store
  // is already in the token; sending it again only breaks the request.
  const { impl, calls } = stub(200, LINE);
  const client = createCallingClient(CONFIG, impl);

  await client.getLine();
  await client.reportAnswered("+8801700000000");
  await client.reportDeclined("+8801700000000");

  for (const call of calls) {
    const headers = call.init.headers as Record<string, string>;
    assert.ok(!("x-store-id" in headers), `${call.url} sent x-store-id`);
  }
});

test("returns the SIP line and the TURN servers", async () => {
  const { impl } = stub(200, LINE);
  const line = await createCallingClient(CONFIG, impl).getLine();

  assert.equal(line.extension, "ext-8");
  assert.equal(line.password, "s3cret");
  assert.equal(line.iceServers?.length, 1);
});

test("a line with no iceServers is usable, not an error", async () => {
  // TURN is best-effort in Selorax too: a failure there must not stop a call.
  const { impl } = stub(200, { data: { ...LINE.data, iceServers: undefined }, status: 200 });
  const line = await createCallingClient(CONFIG, impl).getLine();
  assert.deepEqual(line.iceServers, []);
});

test("an expired token says so, rather than 'Unauthorized'", async () => {
  const { impl } = stub(401, { message: "Access denied. No token provided", status: 401 });
  const error = await createCallingClient(CONFIG, impl)
    .getLine()
    .catch((cause: unknown) => cause);

  assert.ok(error instanceof SeloraxError);
  assert.equal((error as SeloraxError).code, "token_expired");
  assert.match((error as SeloraxError).message, /token/i);
});

test("a missing extension is reported as its own cause, in plain language", async () => {
  const { impl } = stub(503, { message: "no active selx-sip extension", code: "extension_not_active", status: 503 });
  const error = await createCallingClient(CONFIG, impl)
    .getLine()
    .catch((cause: unknown) => cause);

  assert.equal((error as SeloraxError).code, "extension_not_active");
  // The reader is an operator, not a Selorax developer: the machine code must
  // not be the message.
  assert.match((error as SeloraxError).message, /needs an extension in Selorax/i);
  assert.ok(!(error as SeloraxError).message.includes("extension_not_active"));
});

test("calling disabled is reported in plain language, not a machine code", async () => {
  const { impl } = stub(503, { message: "calling disabled", code: "calling_disabled", status: 503 });
  const error = await createCallingClient(CONFIG, impl)
    .getLine()
    .catch((cause: unknown) => cause);

  assert.equal((error as SeloraxError).code, "calling_disabled");
  assert.match((error as SeloraxError).message, /calling is disabled/i);
  assert.ok(!(error as SeloraxError).message.includes("calling_disabled"));
});

test("a rejected session is not reported as an expired token", async () => {
  // The failure that cost a debugging session: Selorax answers 401 with
  // `session_required`, the client called it "likely expired", and the
  // settings page said the token had 89 days left. Two true-looking claims
  // pointing opposite ways sends the operator to reissue a perfectly good
  // token. This cause is not about expiry and must not say it is.
  const { impl } = stub(401, {
    message: "Session not registered. Please sign in again.",
    code: "session_required",
    status: 401,
  });
  const error = await createCallingClient(CONFIG, impl)
    .getLine()
    .catch((cause: unknown) => cause);

  assert.ok(error instanceof SeloraxError);
  assert.equal((error as SeloraxError).code, "session_required");
  assert.ok(!(error as SeloraxError).message.includes("session_required"));
  // Denying the expiry reading is fine — asserting it is not. What must never
  // survive is the instruction to go reissue a token that has months left.
  assert.doesNotMatch((error as SeloraxError).message, /likely expired|issue a new one/i);
  assert.match((error as SeloraxError).message, /not an expired token/i);
});

test("a specific cause wins even when the status is also 401", async () => {
  // A 401 that also names a known cause should report the specific one —
  // "your extension is gone" beats "your token is bad" when both are true,
  // because it points at the fix that actually applies.
  const { impl } = stub(401, {
    message: "no active selx-sip extension",
    code: "extension_not_active",
    status: 401,
  });
  const error = await createCallingClient(CONFIG, impl)
    .getLine()
    .catch((cause: unknown) => cause);

  assert.equal((error as SeloraxError).code, "extension_not_active");
});

test("an unreachable backend is a readable error, not a raw TypeError", async () => {
  const impl = async () => {
    throw new TypeError("fetch failed");
  };
  const error = await createCallingClient(CONFIG, impl)
    .getLine()
    .catch((cause: unknown) => cause);

  assert.ok(error instanceof SeloraxError);
  assert.equal((error as SeloraxError).code, "unreachable");
});

test("a hung backend times out with its own code, not a generic failure", async () => {
  // Stand in for a fetch that never settles on its own, but honors an abort
  // signal the way a real fetch honors AbortSignal.timeout. A short signal
  // here (not the client's real 10s one) keeps the test fast.
  const impl = async () => {
    const signal = AbortSignal.timeout(20);
    await new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason));
    });
    throw new Error("unreachable in this test");
  };

  const error = await createCallingClient(CONFIG, impl)
    .getLine()
    .catch((cause: unknown) => cause);

  assert.ok(error instanceof SeloraxError);
  assert.equal((error as SeloraxError).code, "timeout");
  assert.match((error as SeloraxError).message, /10 seconds/);
});

test("never puts the token in an error message", async () => {
  const { impl } = stub(500, { message: "boom" });
  const error = await createCallingClient(CONFIG, impl)
    .getLine()
    .catch((cause: unknown) => cause);

  assert.ok(!String((error as Error).message).includes("token-abc"));
});

test("never puts the token anywhere an ordinary log line would render it", async () => {
  // console.log(err) runs util.inspect under the hood, which prints a
  // `cause` chain even when `.message` is clean. If the underlying fetch
  // error's own message ever embedded the token, that must not survive into
  // this module's error either — the token must never be attached as cause.
  const impl = async () => {
    throw new TypeError("fetch failed: token-abc was rejected by the upstream proxy");
  };
  const error = await createCallingClient(CONFIG, impl)
    .getLine()
    .catch((cause: unknown) => cause);

  assert.ok(error instanceof SeloraxError);
  const rendered = inspect(error, { depth: null });
  assert.ok(!rendered.includes("token-abc"), rendered);
});

test("reports an answered inbound call with the caller's number", async () => {
  const { impl, calls } = stub(200, { data: {}, status: 200 });
  await createCallingClient(CONFIG, impl).reportAnswered("+8801700000000");

  assert.equal(calls[0].url, "https://api.selorax.io/api/calling/inbound-answered");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { caller_phone: "+8801700000000" });
});

test("reports a declined call on its own endpoint", async () => {
  const { impl, calls } = stub(200, { data: {}, status: 200 });
  await createCallingClient(CONFIG, impl).reportDeclined("+8801700000000");
  assert.equal(calls[0].url, "https://api.selorax.io/api/calling/inbound-declined");
});
