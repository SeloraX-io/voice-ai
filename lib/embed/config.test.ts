import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_EMBED_TEXT, parseEmbedTextConfig } from "./config";

test("uses the existing widget copy by default", () => {
  assert.deepEqual(parseEmbedTextConfig(""), DEFAULT_EMBED_TEXT);
});

test("reads configurable widget labels", () => {
  assert.deepEqual(
    parseEmbedTextConfig("?prompt=Talk%20to%20us&buttonText=Start%20a%20call&title=Colleen"),
    { prompt: "Talk to us", buttonText: "Start a call", title: "Colleen" },
  );
});

test("trims labels and falls back when one is blank", () => {
  assert.deepEqual(parseEmbedTextConfig("?prompt=%20Hello%20&buttonText=%20%20"), {
    ...DEFAULT_EMBED_TEXT,
    prompt: "Hello",
  });
});

test("bounds text forwarded by an embedding page", () => {
  const config = parseEmbedTextConfig(`?title=${"x".repeat(200)}`);
  assert.equal(config.title.length, 120);
});
