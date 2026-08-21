import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

import type { HttpTool } from "../../lib/agent-config/tools";
import { executeHttpTool } from "./tool-runner";

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A throwaway endpoint, so the runner is exercised over real HTTP. */
async function withServer(
  handler: (seen: Seen) => { status?: number; body?: string },
  run: (base: string, seen: () => Seen) => Promise<void>,
): Promise<void> {
  let captured: Seen = { method: "", url: "", headers: {}, body: "" };

  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      captured = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      const { status = 200, body: out = '{"ok":true}' } = handler(captured);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(out);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  try {
    await run(`http://127.0.0.1:${port}`, () => captured);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function tool(overrides: Partial<HttpTool> = {}): HttpTool {
  return {
    id: "t",
    name: "check_order",
    description: "Look up an order.",
    method: "GET",
    url: "https://example.invalid/orders",
    parameters: [],
    headers: [],
    silent: false,
    ...overrides,
  };
}

test("substitutes a path parameter from the model's arguments", async () => {
  await withServer(
    () => ({}),
    async (base, seen) => {
      await executeHttpTool(tool({ url: `${base}/orders/{order_id}` }), { order_id: "A-123" }, {});
      assert.equal(seen().url, "/orders/A-123");
    },
  );
});

test("escapes a path value rather than letting it alter the path", async () => {
  await withServer(
    () => ({}),
    async (base, seen) => {
      await executeHttpTool(tool({ url: `${base}/orders/{order_id}` }), { order_id: "a/../b" }, {});
      assert.equal(seen().url.includes("/orders/a%2F..%2Fb"), true);
    },
  );
});

test("sends leftover arguments as a query string on a GET", async () => {
  await withServer(
    () => ({}),
    async (base, seen) => {
      await executeHttpTool(tool({ url: `${base}/orders` }), { q: "shoes", limit: 2 }, {});
      assert.equal(seen().url, "/orders?q=shoes&limit=2");
    },
  );
});

test("sends leftover arguments as a JSON body on a POST", async () => {
  await withServer(
    () => ({}),
    async (base, seen) => {
      await executeHttpTool(
        tool({ method: "POST", url: `${base}/tickets` }),
        { subject: "Late delivery" },
        {},
      );
      assert.equal(seen().method, "POST");
      assert.deepEqual(JSON.parse(seen().body), { subject: "Late delivery" });
    },
  );
});

test("parses a json-typed argument into a nested object in the body", async () => {
  await withServer(
    () => ({}),
    async (base, seen) => {
      await executeHttpTool(
        tool({
          method: "POST",
          url: `${base}/orders`,
          parameters: [
            { id: "p1", name: "address", type: "json", description: "The address.", required: true },
          ],
        }),
        { address: '{"address":"12 Road, Dhaka"}', customer_name: "Jane" },
        {},
      );
      assert.deepEqual(JSON.parse(seen().body), {
        address: { address: "12 Road, Dhaka" },
        customer_name: "Jane",
      });
    },
  );
});

test("returns a readable error for invalid JSON in a json-typed argument, without calling the endpoint", async () => {
  let called = false;
  await withServer(
    () => {
      called = true;
      return {};
    },
    async (base) => {
      const result = await executeHttpTool(
        tool({
          method: "POST",
          url: `${base}/orders`,
          parameters: [
            { id: "p1", name: "address", type: "json", description: "The address.", required: true },
          ],
        }),
        { address: "{not valid json" },
        {},
      );
      assert.equal(result.ok, false);
      assert.equal(typeof result.error, "string");
      assert.equal(called, false);
    },
  );
});

test("resolves a secret reference into the header actually sent", async () => {
  await withServer(
    () => ({}),
    async (base, seen) => {
      await executeHttpTool(
        tool({
          url: `${base}/orders`,
          headers: [{ id: "h", name: "Authorization", value: "Bearer {{CRM_API_KEY}}" }],
        }),
        {},
        { CRM_API_KEY: "s3cret-value" },
      );
      assert.equal(seen().headers.authorization, "Bearer s3cret-value");
    },
  );
});

test("leaves an unknown secret reference as written rather than sending an empty credential", async () => {
  await withServer(
    () => ({}),
    async (base, seen) => {
      await executeHttpTool(
        tool({
          url: `${base}/orders`,
          headers: [{ id: "h", name: "Authorization", value: "Bearer {{MISSING}}" }],
        }),
        {},
        {},
      );
      // "Bearer " would look like a malformed token; the literal is diagnosable.
      assert.equal(seen().headers.authorization, "Bearer {{MISSING}}");
    },
  );
});

test("returns parsed JSON to the model", async () => {
  await withServer(
    () => ({ body: '{"status":"shipped"}' }),
    async (base) => {
      const result = await executeHttpTool(tool({ url: `${base}/orders` }), {}, {});
      assert.deepEqual(result, { ok: true, status: 200, data: { status: "shipped" } });
    },
  );
});

test("returns non-JSON as text rather than failing", async () => {
  await withServer(
    () => ({ body: "shipped" }),
    async (base) => {
      const result = await executeHttpTool(tool({ url: `${base}/orders` }), {}, {});
      assert.equal((result as { data: unknown }).data, "shipped");
    },
  );
});

test("reports a failing status to the model instead of throwing", async () => {
  await withServer(
    () => ({ status: 404, body: '{"error":"no such order"}' }),
    async (base) => {
      const result = await executeHttpTool(tool({ url: `${base}/orders` }), {}, {});
      assert.equal(result.ok, false);
      assert.equal(result.status, 404);
    },
  );
});

test("returns a readable result when the host cannot be reached", async () => {
  const result = await executeHttpTool(
    tool({ url: "http://127.0.0.1:1/orders" }),
    {},
    {},
  );
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, "string");
});

test("returns a readable result for a malformed URL", async () => {
  const result = await executeHttpTool(tool({ url: "not a url" }), {}, {});
  assert.equal(typeof result.error, "string");
});

test("truncates a very large response rather than flooding the context", async () => {
  await withServer(
    () => ({ body: JSON.stringify({ blob: "x".repeat(20_000) }) }),
    async (base) => {
      const result = await executeHttpTool(tool({ url: `${base}/orders` }), {}, {});
      // Truncation breaks the JSON, so it comes back as text — the point is that
      // 20 kB never reaches the model.
      assert.ok(JSON.stringify(result).length < 9_000);
    },
  );
});
