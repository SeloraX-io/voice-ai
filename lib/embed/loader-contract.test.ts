import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const loaderPath = new URL("../../public/embed.js", import.meta.url);

test("the public loader exposes the documented host controls", async () => {
  const source = await readFile(loaderPath, "utf8");
  for (const method of ["open", "minimize", "stop", "close"]) {
    assert.match(source, new RegExp(`${method}: function \\(`));
  }
  assert.match(source, /window\.SeloraXAI = api/);
});

test("the public loader forwards all documented text attributes", async () => {
  const source = await readFile(loaderPath, "utf8");
  assert.match(source, /data-prompt/);
  assert.match(source, /data-button-text/);
  assert.match(source, /data-title/);
});

test("the public loader forwards the client id, shape-checked", async () => {
  const source = await readFile(loaderPath, "utf8");
  assert.match(source, /data-client/);
  // The widget URL must only ever carry a slug-shaped client id.
  assert.match(source, /params\.set\("client", client\)/);
  assert.match(source, /\^\[a-z0-9\]\[a-z0-9-\]\{0,62\}\$/);
});

test("widget messages are bound to the iframe that the loader created", async () => {
  const source = await readFile(loaderPath, "utf8");
  assert.match(source, /event\.origin !== ORIGIN/);
  assert.match(source, /event\.source !== frame\.contentWindow/);
});

test("closing suppresses deferred mounting until open is called", async () => {
  const source = await readFile(loaderPath, "utf8");
  assert.match(source, /if \(!closed && !frame\.parentNode\)/);
  assert.match(source, /open: function \(\) \{\s+closed = false/);
  assert.match(source, /close: function \(\) \{\s+closed = true/);
});

test("mobile hosts receive the compact icon mode", async () => {
  const source = await readFile(loaderPath, "utf8");
  assert.match(source, /max-width: 640px/);
  assert.match(source, /width: 76, height: 76/);
  assert.match(source, /params\.set\("mobile", "1"\)/);
});
