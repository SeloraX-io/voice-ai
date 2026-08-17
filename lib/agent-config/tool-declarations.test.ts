import { test } from "node:test";
import assert from "node:assert/strict";

import { END_CALL_TOOL_NAME, toolDeclarations } from "./tool-declarations";
import type { HttpTool, ToolsConfig } from "./tools";

function httpTool(overrides: Partial<HttpTool> = {}): HttpTool {
  return {
    id: "t1",
    name: "check_order",
    description: "Use when the customer asks where their order is.",
    method: "GET",
    url: "https://api.example.com/orders/{order_id}",
    parameters: [],
    headers: [],
    silent: false,
    ...overrides,
  };
}

function tools(overrides: Partial<ToolsConfig> = {}): ToolsConfig {
  return { http: [], client: [], webhooks: [], ...overrides };
}

test("declares a configured http tool", () => {
  const declared = toolDeclarations(tools({ http: [httpTool()] }), { canEndCall: false });
  assert.equal(declared.length, 1);
  assert.equal(declared[0].name, "check_order");
  assert.equal(declared[0].description, "Use when the customer asks where their order is.");
});

test("builds a parameter schema, marking only the required ones", () => {
  const declared = toolDeclarations(
    tools({
      http: [
        httpTool({
          parameters: [
            { id: "p1", name: "order_id", type: "string", description: "The order.", required: true },
            { id: "p2", name: "verbose", type: "boolean", description: "More detail.", required: false },
          ],
        }),
      ],
    }),
    { canEndCall: false },
  );

  assert.deepEqual(declared[0].parameters, {
    type: "OBJECT",
    properties: {
      order_id: { type: "STRING", description: "The order." },
      verbose: { type: "BOOLEAN", description: "More detail." },
    },
    required: ["order_id"],
  });
});

test("omits the schema entirely for a tool with no parameters", () => {
  const declared = toolDeclarations(tools({ http: [httpTool()] }), { canEndCall: false });
  assert.equal(declared[0].parameters, undefined);
});

test("omits `required` when nothing is required", () => {
  const declared = toolDeclarations(
    tools({
      http: [
        httpTool({
          parameters: [
            { id: "p", name: "note", type: "string", description: "Optional.", required: false },
          ],
        }),
      ],
    }),
    { canEndCall: false },
  );
  assert.equal("required" in (declared[0].parameters ?? {}), false);
});

test("does not declare client tools, which the gateway cannot run", () => {
  const declared = toolDeclarations(
    tools({
      client: [
        { id: "c", name: "open_page", description: "Show a page.", parameters: [], awaitResult: true },
      ],
    }),
    { canEndCall: false },
  );
  assert.deepEqual(declared, []);
});

test("skips a half-typed tool rather than handing the model a draft", () => {
  const declared = toolDeclarations(
    tools({ http: [httpTool({ name: "" }), httpTool({ id: "t2", description: "   " })] }),
    { canEndCall: false },
  );
  assert.deepEqual(declared, []);
});

test("offers end_call when the agent is allowed to hang up", () => {
  const declared = toolDeclarations(tools(), { canEndCall: true });
  assert.equal(declared.length, 1);
  assert.equal(declared[0].name, END_CALL_TOOL_NAME);
  assert.deepEqual(declared[0].parameters?.required, ["reason"]);
});

test("withholds end_call when the agent is not allowed to hang up", () => {
  assert.deepEqual(toolDeclarations(tools(), { canEndCall: false }), []);
});

test("a configured tool cannot shadow end_call", () => {
  const declared = toolDeclarations(
    tools({ http: [httpTool({ name: END_CALL_TOOL_NAME, description: "Impostor." })] }),
    { canEndCall: true },
  );

  const endCalls = declared.filter((entry) => entry.name === END_CALL_TOOL_NAME);
  assert.equal(endCalls.length, 1);
  // The real one, not the configured impostor.
  assert.equal(endCalls[0].description.includes("End the phone call"), true);
});

/* --- phone calls declare no tools ------------------------------------- */

test("a phone call is offered end_call and nothing else", () => {
  const declared = toolDeclarations(
    tools({
      http: [httpTool(), httpTool({ id: "t2", name: "refund", description: "Issue a refund." })],
      client: [
        { id: "c", name: "open_page", description: "Show a page.", parameters: [], awaitResult: true },
      ],
    }),
    { canEndCall: true, channel: "phone" },
  );

  assert.deepEqual(
    declared.map((entry) => entry.name),
    [END_CALL_TOOL_NAME],
  );
});

test("a phone call with hang-up disabled is offered nothing at all", () => {
  assert.deepEqual(
    toolDeclarations(tools({ http: [httpTool()] }), { canEndCall: false, channel: "phone" }),
    [],
  );
});

test("the browser channel is unchanged, named or defaulted", () => {
  const configured = tools({ http: [httpTool()] });
  const withChannel = toolDeclarations(configured, { canEndCall: true, channel: "browser" });
  const withoutChannel = toolDeclarations(configured, { canEndCall: true });

  assert.deepEqual(
    withChannel.map((entry) => entry.name),
    ["check_order", END_CALL_TOOL_NAME],
  );
  assert.deepEqual(withoutChannel, withChannel);
});

test("end_call is dropped from the list even when hang-up is disabled", () => {
  const declared = toolDeclarations(
    tools({ http: [httpTool({ name: END_CALL_TOOL_NAME, description: "Impostor." })] }),
    { canEndCall: false },
  );
  assert.deepEqual(declared, []);
});
