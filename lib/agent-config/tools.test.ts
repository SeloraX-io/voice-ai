import { test } from "node:test";
import assert from "node:assert/strict";

import type { FieldError } from "./validate-helpers";
import { bracedParams, isValidToolUrl, validateTools } from "./tools";

function paths(value: unknown): string[] {
  const errors: FieldError[] = [];
  validateTools(value, errors);
  return errors.map((error) => error.path);
}

function httpTool(overrides: Record<string, unknown> = {}) {
  return {
    id: "a",
    name: "check_order",
    description: "Use when the customer asks where their order is.",
    method: "GET",
    url: "https://api.example.com/orders",
    parameters: [],
    headers: [],
    silent: false,
    ...overrides,
  };
}

function webhook(overrides: Record<string, unknown> = {}) {
  return {
    id: "w",
    name: "crm_sync",
    description: "Send the transcript to the CRM.",
    method: "POST",
    url: "https://api.example.com/hook",
    headers: [],
    queryParams: [],
    events: ["call_ended"],
    retry: "backoff",
    ...overrides,
  };
}

test("an absent tools field is the ordinary upgrade path", () => {
  const errors: FieldError[] = [];
  const tools = validateTools(undefined, errors);
  assert.deepEqual(errors, []);
  assert.deepEqual(tools, { http: [], client: [], webhooks: [] });
});

test("accepts a well-formed set", () => {
  assert.deepEqual(paths({ http: [httpTool()], client: [], webhooks: [webhook()] }), []);
});

test("rejects a tool name that is not lowercase snake case", () => {
  assert.ok(paths({ http: [httpTool({ name: "CheckOrder" })] }).includes("tools.http.0.name"));
  assert.ok(paths({ http: [httpTool({ name: "check-order" })] }).includes("tools.http.0.name"));
});

test("rejects an empty description, because the model reads it", () => {
  assert.ok(paths({ http: [httpTool({ description: "  " })] }).includes("tools.http.0.description"));
});

test("rejects a url that is not absolute http or https", () => {
  assert.ok(paths({ http: [httpTool({ url: "/orders" })] }).includes("tools.http.0.url"));
  assert.ok(paths({ http: [httpTool({ url: "ftp://x.example" })] }).includes("tools.http.0.url"));
});

test("accepts a url whose braces make it unparseable until substituted", () => {
  assert.deepEqual(paths({ http: [httpTool({ url: "https://api.example.com/o/{order_id}" })] }), []);
});

test("rejects two tools sharing a name within the same kind", () => {
  const two = [httpTool({ id: "a" }), httpTool({ id: "b" })];
  assert.ok(paths({ http: two }).includes("tools.http.1.name"));
});

test("rejects a client tool colliding with an http tool, since the model sees one namespace", () => {
  const client = [{ id: "c", name: "check_order", description: "Do it.", parameters: [], awaitResult: true }];
  assert.ok(paths({ http: [httpTool()], client }).includes("tools.client.0.name"));
});

test("allows a webhook to share a name with a tool, as they are separate namespaces", () => {
  assert.deepEqual(paths({ http: [httpTool()], webhooks: [webhook({ name: "check_order" })] }), []);
});

test("rejects duplicate parameter names within one tool", () => {
  const parameters = [
    { id: "p1", name: "order_id", type: "string", description: "The order.", required: true },
    { id: "p2", name: "order_id", type: "string", description: "Again.", required: false },
  ];
  assert.ok(paths({ http: [httpTool({ parameters })] }).includes("tools.http.0.parameters.1.name"));
});

test("rejects a header name with illegal characters", () => {
  const headers = [{ id: "h", name: "X Api Key", value: "{{K}}" }];
  assert.ok(paths({ http: [httpTool({ headers })] }).includes("tools.http.0.headers.0.name"));
});

test("rejects a webhook with no events, since nothing would ever fire it", () => {
  assert.ok(paths({ webhooks: [webhook({ events: [] })] }).includes("tools.webhooks.0.events"));
});

test("rejects more tools than the cap", () => {
  const many = Array.from({ length: 26 }, (_, i) => httpTool({ id: `t${i}`, name: `tool_${i}` }));
  assert.ok(paths({ http: many }).includes("tools.http"));
});

test("finds brace parameters in a url, without duplicates", () => {
  assert.deepEqual(bracedParams("https://x.example/{a}/{b}/{a}"), ["a", "b"]);
  assert.deepEqual(bracedParams("https://x.example/plain"), []);
});

test("ignores brace segments that are not identifiers", () => {
  assert.deepEqual(bracedParams("https://x.example/{9bad}/{ok_1}"), ["ok_1"]);
});

test("isValidToolUrl substitutes braces before parsing", () => {
  assert.equal(isValidToolUrl("https://x.example/{id}"), true);
  assert.equal(isValidToolUrl("not a url"), false);
});
