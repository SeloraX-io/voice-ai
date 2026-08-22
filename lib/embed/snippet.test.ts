import { test } from "node:test";
import assert from "node:assert/strict";

import {
  consoleSnippet,
  isSecureContextOrigin,
  normaliseOrigin,
  scriptTagSnippet,
} from "./snippet";

test("accepts a bare https origin", () => {
  const result = normaliseOrigin("https://voice.example.com");
  assert.deepEqual(result, { ok: true, origin: "https://voice.example.com" });
});

test("trims a trailing slash rather than rejecting it", () => {
  const result = normaliseOrigin("https://voice.example.com/");
  assert.deepEqual(result, { ok: true, origin: "https://voice.example.com" });
});

test("keeps an explicit port", () => {
  const result = normaliseOrigin("http://localhost:3000");
  assert.deepEqual(result, { ok: true, origin: "http://localhost:3000" });
});

test("rejects an unset or blank value", () => {
  for (const value of [undefined, null, "", "   "]) {
    const result = normaliseOrigin(value);
    assert.equal(result.ok, false);
  }
});

test("rejects a value that is not a URL", () => {
  const result = normaliseOrigin("voice.example.com");
  assert.equal(result.ok, false);
});

test("rejects a non-http protocol", () => {
  // wss:// is the gateway's scheme and an easy thing to paste here by mistake.
  const result = normaliseOrigin("wss://voice.example.com");
  assert.equal(result.ok, false);
});

test("rejects an origin carrying a path, query or hash", () => {
  // These would be concatenated into the script URL and silently produce
  // something like https://host/app/embed.js.
  for (const value of [
    "https://voice.example.com/app",
    "https://voice.example.com/?a=1",
    "https://voice.example.com/#x",
  ]) {
    assert.equal(normaliseOrigin(value).ok, false, value);
  }
});

test("https and loopback are secure contexts; deployed http is not", () => {
  assert.equal(isSecureContextOrigin("https://voice.example.com"), true);
  assert.equal(isSecureContextOrigin("http://localhost:3000"), true);
  assert.equal(isSecureContextOrigin("http://127.0.0.1:3000"), true);
  assert.equal(isSecureContextOrigin("http://voice.example.com"), false);
});

test("the console snippet is a single line pointing at this origin's embed.js", () => {
  const snippet = consoleSnippet("https://voice.example.com");
  assert.ok(snippet.includes("https://voice.example.com/embed.js"));
  // Pasted into a console, a newline would submit a half-written statement.
  assert.equal(snippet.includes("\n"), false);
});

test("the console snippet is an immediately-invoked expression", () => {
  // It has to run on paste, not merely define something.
  const snippet = consoleSnippet("https://voice.example.com");
  assert.ok(snippet.startsWith("(function()"));
  assert.ok(snippet.endsWith("()"));
});

test("the script tag points at the same file", () => {
  const tag = scriptTagSnippet("https://voice.example.com");
  assert.equal(tag, '<script src="https://voice.example.com/embed.js" async></script>');
});

test("a client id rides along as data-client on the script tag", () => {
  const tag = scriptTagSnippet("https://voice.example.com", "acme-dental");
  assert.equal(
    tag,
    '<script src="https://voice.example.com/embed.js" data-client="acme-dental" async></script>',
  );
});

test("the console snippet sets data-client before mounting the script", () => {
  const snippet = consoleSnippet("https://voice.example.com", "acme-dental");
  assert.ok(snippet.includes("s.setAttribute('data-client','acme-dental')"));
  // The attribute must exist before the loader runs, so it is set pre-append.
  assert.ok(
    snippet.indexOf("data-client") < snippet.indexOf("appendChild"),
    "data-client must be set before the script is appended",
  );
  assert.equal(snippet.includes("\n"), false);
});

test("without a client id, neither snippet mentions data-client", () => {
  assert.equal(consoleSnippet("https://voice.example.com").includes("data-client"), false);
  assert.equal(scriptTagSnippet("https://voice.example.com").includes("data-client"), false);
});
