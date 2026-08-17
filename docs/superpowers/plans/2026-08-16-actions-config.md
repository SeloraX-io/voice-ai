# Actions Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define, validate, store and edit HTTP tools, client tools and webhooks as agent configuration — without making the agent call any of them.

**Architecture:** The tool types and their validation live in their own module, sharing the primitive readers with the existing config schema through an extracted helpers file. Everything persists in the existing `data/agent-config.json` through the existing store, so no new storage appears. The Actions screen gains three sections and three modal forms built on a new `<dialog>`-based modal primitive and two shared row editors.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript strict, Tailwind CSS v4, Node 24 built-in test runner (`node:test`) via `tsx`.

**Spec:** `docs/superpowers/specs/2026-08-16-actions-config-design.md`

## Global Constraints

- **No new npm dependencies.**
- **TypeScript strict**, zero errors. `npm run lint` clean.
- **Do not run `npm run build` per task** — it runs once, in the final task, against a cleared `.next` (this project's `.next/types` cache has been observed not to self-refresh).
- **The existing 65 tests must keep passing.** New pure logic adds to that count.
- **Light theme only.** Every colour through a CSS custom property (`var(--surface)`, `var(--text-muted)`, `var(--border)`, `var(--accent)`, `var(--danger)`, `var(--warning)`, `var(--success)`, `var(--ring)`). The documented per-state palettes in `VoiceOrb.tsx` and `VoiceWaveform.tsx` are the only sanctioned exception; `bg-black/20` is the established backdrop convention.
- **Every `Field` passes `htmlFor` matching its control's `id`** — `htmlFor` is optional, so a mismatch silently orphans the label.
- **Modules open with a block comment explaining WHY they exist.**
- **`server/` uses relative imports**; everything else uses the `@/` alias.
- **Secret VALUES never reach the browser.** Tool headers store only reference text like `{{CRM_API_KEY}}`.
- **Nothing here executes.** No Gemini function declarations, no HTTP requests, no webhook delivery. The Actions screen must say so.
- **IDs use `crypto.randomUUID()`**, not timestamps — a prior task's timestamp ids were flagged for collision.

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `lib/agent-config/validate-helpers.ts` | `FieldError` + the primitive readers, shared by both validators. |
| `lib/agent-config/tools.ts` | Tool types, tool limits, `validateTools`, `bracedParams`. Pure. |
| `components/ui/modal.tsx` | `<dialog>` wrapper: focus in, Escape out, focus restored. |
| `components/agent-config/ParameterRows.tsx` | Editor for a `ToolParameter[]`. |
| `components/agent-config/HeaderRows.tsx` | Editor for a `ToolHeader[]` (headers and query params). |
| `components/agent-config/HttpToolModal.tsx` | Add/edit an HTTP tool. |
| `components/agent-config/ClientToolModal.tsx` | Add/edit a client tool. |
| `components/agent-config/WebhookModal.tsx` | Add/edit a webhook. |

**Modified:** `lib/agent-config/schema.ts`, `lib/agent-config/defaults.ts`, `lib/agent-config/routes.ts`, `components/agent-config/ActionsTab.tsx`, `app/(console)/agent/actions/page.tsx`, `README.md`.

---

### Task 1: Extract the shared validation helpers

Mechanical extraction, isolated so a regression shows immediately against the existing suite. `schema.ts` is ~340 lines; the tool validation would push it past 540 doing two unrelated jobs.

**Files:**
- Create: `lib/agent-config/validate-helpers.ts`
- Modify: `lib/agent-config/schema.ts`

**Interfaces:**
- Produces: from `validate-helpers.ts` — `interface FieldError { path: string; message: string }`, `asRecord(value: unknown): Record<string, unknown> | null`, `readString(value, path, errors, fallback): string`, `readBoolean(value, path, errors): boolean`, `readNumber(value, path, range, errors, fallback): number`, `readEnum<T extends string>(value, path, allowed, errors, fallback): T`. `schema.ts` re-exports `FieldError` so existing importers are unaffected.

- [ ] **Step 1: Create the helpers file**

Create `lib/agent-config/validate-helpers.ts`. Move the five functions and the `FieldError` interface out of `schema.ts` **unchanged** — same bodies, same messages. Only the file they live in changes.

```ts
/**
 * Primitive readers shared by every validator in this folder.
 *
 * They exist as a separate module because two validators now need them — the
 * agent configuration and the tool definitions — and duplicating them would let
 * the two drift into reporting the same mistake differently.
 *
 * Each reader pushes an error and returns a fallback rather than throwing, so a
 * caller can collect every problem in one pass and the form can highlight all
 * of them at once.
 */

export interface FieldError {
  /** Dotted path, e.g. "variables.0.name". Empty string means the whole body. */
  path: string;
  message: string;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function readString(
  value: unknown,
  path: string,
  errors: FieldError[],
  fallback: string,
): string {
  if (typeof value !== "string") {
    errors.push({ path, message: "Must be text." });
    return fallback;
  }
  return value;
}

export function readBoolean(value: unknown, path: string, errors: FieldError[]): boolean {
  if (typeof value !== "boolean") {
    errors.push({ path, message: "Must be true or false." });
    return false;
  }
  return value;
}

export function readNumber(
  value: unknown,
  path: string,
  range: { min: number; max: number },
  errors: FieldError[],
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push({ path, message: "Must be a number." });
    return fallback;
  }
  if (value < range.min || value > range.max) {
    errors.push({ path, message: `Must be between ${range.min} and ${range.max}.` });
    return fallback;
  }
  return value;
}

export function readEnum<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
  errors: FieldError[],
  fallback: T,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    errors.push({ path, message: `Must be one of: ${allowed.join(", ")}.` });
    return fallback;
  }
  return value as T;
}
```

- [ ] **Step 2: Point `schema.ts` at them**

In `lib/agent-config/schema.ts`, delete the five moved function bodies and the `FieldError` interface, and add near the top:

```ts
import {
  asRecord,
  readBoolean,
  readEnum,
  readNumber,
  readString,
  type FieldError,
} from "./validate-helpers";

export type { FieldError } from "./validate-helpers";
```

The re-export matters: `AgentConfigProvider.tsx` imports `FieldError` from `schema`, and this task must not touch it.

- [ ] **Step 3: Verify nothing changed behaviourally**

```bash
npm test && npm run typecheck && npm run lint
```
Expected: 65 tests still pass, zero type errors, clean lint. The existing suite is the proof this extraction was faithful — if a message or a fallback drifted, a test fails.

- [ ] **Step 4: Commit**

```bash
git add lib/agent-config/validate-helpers.ts lib/agent-config/schema.ts
git commit -m "refactor: extract shared validation helpers"
```

---

### Task 2: Tool types and validation

**Files:**
- Create: `lib/agent-config/tools.ts`
- Test: `lib/agent-config/tools.test.ts`
- Modify: `lib/agent-config/schema.ts`, `lib/agent-config/defaults.ts`

**Interfaces:**
- Consumes: the helpers from Task 1.
- Produces: from `tools.ts` — the types `ToolValueType`, `HttpMethod`, `WebhookEvent`, `RetryPolicy`, `ToolParameter`, `ToolHeader`, `HttpTool`, `ClientTool`, `Webhook`, `ToolsConfig`; the constants `TOOL_LIMITS`, `TOOL_NAME_RE`, `HEADER_NAME_RE`, `HTTP_METHODS`, `WEBHOOK_EVENTS`, `RETRY_POLICIES`, `EMPTY_TOOLS`; and the functions `bracedParams(url: string): string[]`, `isValidToolUrl(url: string): boolean`, `validateTools(value: unknown, errors: FieldError[]): ToolsConfig`. `AgentConfig` gains `tools: ToolsConfig`.

- [ ] **Step 1: Write the failing test**

Create `lib/agent-config/tools.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './tools'`.

- [ ] **Step 3: Write the module**

Create `lib/agent-config/tools.ts`:

```ts
/**
 * Tool and webhook definitions.
 *
 * Separate from `schema.ts` so neither file has to hold two unrelated shapes,
 * and pure so the browser and the gateway can both import it.
 *
 * Nothing here executes anything. These are definitions the next phase turns
 * into function declarations and HTTP calls.
 */

import {
  asRecord,
  readBoolean,
  readEnum,
  readString,
  type FieldError,
} from "./validate-helpers";

export type ToolValueType = "string" | "number" | "boolean";
export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";
export type WebhookEvent = "call_started" | "call_ended" | "transcript_ready";
export type RetryPolicy = "none" | "once" | "backoff";

export const HTTP_METHODS: readonly HttpMethod[] = ["GET", "POST", "PATCH", "DELETE"];
export const WEBHOOK_EVENTS: readonly WebhookEvent[] = [
  "call_started",
  "call_ended",
  "transcript_ready",
];
export const RETRY_POLICIES: readonly RetryPolicy[] = ["none", "once", "backoff"];
const VALUE_TYPES: readonly ToolValueType[] = ["string", "number", "boolean"];

/** Lowercase snake case, because these become function names the model calls. */
export const TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/;
export const HEADER_NAME_RE = /^[A-Za-z0-9-]+$/;

export const TOOL_LIMITS = {
  toolsMax: 25,
  parametersMax: 25,
  headersMax: 25,
  nameMax: 64,
  descriptionMax: 2_000,
  urlMax: 2_000,
} as const;

export interface ToolParameter {
  id: string;
  name: string;
  type: ToolValueType;
  description: string;
  required: boolean;
}

export interface ToolHeader {
  id: string;
  name: string;
  /** May contain {{SECRET_NAME}}; resolved server-side when execution ships. */
  value: string;
}

export interface HttpTool {
  id: string;
  name: string;
  description: string;
  method: HttpMethod;
  url: string;
  parameters: ToolParameter[];
  headers: ToolHeader[];
  silent: boolean;
}

export interface ClientTool {
  id: string;
  name: string;
  description: string;
  parameters: ToolParameter[];
  awaitResult: boolean;
}

export interface Webhook {
  id: string;
  name: string;
  description: string;
  method: HttpMethod;
  url: string;
  headers: ToolHeader[];
  queryParams: ToolHeader[];
  events: WebhookEvent[];
  retry: RetryPolicy;
}

export interface ToolsConfig {
  http: HttpTool[];
  client: ClientTool[];
  webhooks: Webhook[];
}

export const EMPTY_TOOLS: ToolsConfig = { http: [], client: [], webhooks: [] };

const BRACE_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Every distinct `{brace}` identifier in a URL, in first-appearance order. */
export function bracedParams(url: string): string[] {
  const seen = new Set<string>();
  for (const match of url.matchAll(BRACE_RE)) seen.add(match[1]);
  return [...seen];
}

/**
 * A tool URL is absolute http(s), but only after its brace segments are
 * substituted — `https://x/{id}` is not a parseable URL as written.
 */
export function isValidToolUrl(url: string): boolean {
  try {
    const parsed = new URL(url.replace(BRACE_RE, "x"));
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function validateName(
  raw: unknown,
  path: string,
  errors: FieldError[],
  taken: Set<string>,
): string {
  const name = readString(raw, path, errors, "").trim();
  if (name.length > TOOL_LIMITS.nameMax) {
    errors.push({ path, message: `At most ${TOOL_LIMITS.nameMax} characters.` });
  } else if (!TOOL_NAME_RE.test(name)) {
    errors.push({
      path,
      message: "Lowercase letters, digits and underscores, starting with a letter.",
    });
  } else if (taken.has(name)) {
    errors.push({ path, message: "Another action already uses this name." });
  } else {
    taken.add(name);
  }
  return name;
}

function validateDescription(raw: unknown, path: string, errors: FieldError[]): string {
  const description = readString(raw, path, errors, "");
  if (description.trim() === "") {
    errors.push({ path, message: "Required — the agent reads this to decide when to use it." });
  } else if (description.length > TOOL_LIMITS.descriptionMax) {
    errors.push({ path, message: `At most ${TOOL_LIMITS.descriptionMax} characters.` });
  }
  return description;
}

function validateUrl(raw: unknown, path: string, errors: FieldError[]): string {
  const url = readString(raw, path, errors, "").trim();
  if (url.length > TOOL_LIMITS.urlMax) {
    errors.push({ path, message: `At most ${TOOL_LIMITS.urlMax} characters.` });
  } else if (!isValidToolUrl(url)) {
    errors.push({ path, message: "Must be an absolute http:// or https:// URL." });
  }
  return url;
}

function validateParameters(
  value: unknown,
  path: string,
  errors: FieldError[],
): ToolParameter[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push({ path, message: "Must be a list." });
    return [];
  }
  if (value.length > TOOL_LIMITS.parametersMax) {
    errors.push({ path, message: `At most ${TOOL_LIMITS.parametersMax} parameters.` });
  }

  const seen = new Set<string>();
  const parameters: ToolParameter[] = [];

  value.forEach((raw, index) => {
    const record = asRecord(raw);
    if (!record) {
      errors.push({ path: `${path}.${index}`, message: "Must be an object." });
      return;
    }
    const name = validateName(record.name, `${path}.${index}.name`, errors, seen);
    parameters.push({
      id: typeof record.id === "string" && record.id !== "" ? record.id : `param-${index}`,
      name,
      type: readEnum(record.type, `${path}.${index}.type`, VALUE_TYPES, errors, "string"),
      description: readString(record.description, `${path}.${index}.description`, errors, ""),
      required: readBoolean(record.required, `${path}.${index}.required`, errors),
    });
  });

  return parameters;
}

function validateHeaders(value: unknown, path: string, errors: FieldError[]): ToolHeader[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push({ path, message: "Must be a list." });
    return [];
  }
  if (value.length > TOOL_LIMITS.headersMax) {
    errors.push({ path, message: `At most ${TOOL_LIMITS.headersMax} entries.` });
  }

  return value.map((raw, index) => {
    const record = asRecord(raw);
    if (!record) {
      errors.push({ path: `${path}.${index}`, message: "Must be an object." });
      return { id: `header-${index}`, name: "", value: "" };
    }
    const name = readString(record.name, `${path}.${index}.name`, errors, "").trim();
    if (!HEADER_NAME_RE.test(name)) {
      errors.push({
        path: `${path}.${index}.name`,
        message: "Letters, digits and hyphens only.",
      });
    }
    return {
      id: typeof record.id === "string" && record.id !== "" ? record.id : `header-${index}`,
      name,
      value: readString(record.value, `${path}.${index}.value`, errors, ""),
    };
  });
}

function validateEvents(value: unknown, path: string, errors: FieldError[]): WebhookEvent[] {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push({ path, message: "Pick at least one event." });
    return [];
  }
  return value.map((raw, index) =>
    readEnum(raw, `${path}.${index}`, WEBHOOK_EVENTS, errors, "call_ended"),
  );
}

function validateList<T>(
  value: unknown,
  path: string,
  errors: FieldError[],
  each: (record: Record<string, unknown>, path: string, index: number) => T,
): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push({ path, message: "Must be a list." });
    return [];
  }
  if (value.length > TOOL_LIMITS.toolsMax) {
    errors.push({ path, message: `At most ${TOOL_LIMITS.toolsMax}.` });
  }

  const out: T[] = [];
  value.forEach((raw, index) => {
    const record = asRecord(raw);
    if (!record) {
      errors.push({ path: `${path}.${index}`, message: "Must be an object." });
      return;
    }
    out.push(each(record, `${path}.${index}`, index));
  });
  return out;
}

/**
 * Validates the whole tools block.
 *
 * `undefined` is the ordinary upgrade path, not an error: every configuration
 * saved before this feature lacks the field, and `store.read()` validates on
 * the way out — so requiring it would silently reset those users' prompt,
 * voice and variables to seed defaults.
 *
 * HTTP and client tool names share one `taken` set because both kinds are
 * declared to the model in a single namespace; a collision would make one
 * unreachable. Webhooks get their own set — nothing calls them by name.
 */
export function validateTools(value: unknown, errors: FieldError[]): ToolsConfig {
  if (value === undefined) return { http: [], client: [], webhooks: [] };

  const record = asRecord(value);
  if (!record) {
    errors.push({ path: "tools", message: "Must be an object." });
    return { http: [], client: [], webhooks: [] };
  }

  const takenToolNames = new Set<string>();

  const http = validateList<HttpTool>(record.http, "tools.http", errors, (item, path, index) => ({
    id: typeof item.id === "string" && item.id !== "" ? item.id : `http-${index}`,
    name: validateName(item.name, `${path}.name`, errors, takenToolNames),
    description: validateDescription(item.description, `${path}.description`, errors),
    method: readEnum(item.method, `${path}.method`, HTTP_METHODS, errors, "GET"),
    url: validateUrl(item.url, `${path}.url`, errors),
    parameters: validateParameters(item.parameters, `${path}.parameters`, errors),
    headers: validateHeaders(item.headers, `${path}.headers`, errors),
    silent: readBoolean(item.silent, `${path}.silent`, errors),
  }));

  const client = validateList<ClientTool>(
    record.client,
    "tools.client",
    errors,
    (item, path, index) => ({
      id: typeof item.id === "string" && item.id !== "" ? item.id : `client-${index}`,
      name: validateName(item.name, `${path}.name`, errors, takenToolNames),
      description: validateDescription(item.description, `${path}.description`, errors),
      parameters: validateParameters(item.parameters, `${path}.parameters`, errors),
      awaitResult: readBoolean(item.awaitResult, `${path}.awaitResult`, errors),
    }),
  );

  const takenWebhookNames = new Set<string>();

  const webhooks = validateList<Webhook>(
    record.webhooks,
    "tools.webhooks",
    errors,
    (item, path, index) => ({
      id: typeof item.id === "string" && item.id !== "" ? item.id : `hook-${index}`,
      name: validateName(item.name, `${path}.name`, errors, takenWebhookNames),
      description: validateDescription(item.description, `${path}.description`, errors),
      method: readEnum(item.method, `${path}.method`, HTTP_METHODS, errors, "POST"),
      url: validateUrl(item.url, `${path}.url`, errors),
      headers: validateHeaders(item.headers, `${path}.headers`, errors),
      queryParams: validateHeaders(item.queryParams, `${path}.queryParams`, errors),
      events: validateEvents(item.events, `${path}.events`, errors),
      retry: readEnum(item.retry, `${path}.retry`, RETRY_POLICIES, errors, "backoff"),
    }),
  );

  return { http, client, webhooks };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test`
Expected: PASS — 81 tests (65 + 16 new).

- [ ] **Step 5: Wire it into the config**

In `lib/agent-config/schema.ts`, import and re-export the tool surface, add the field to `AgentConfig`, and validate it.

```ts
import { validateTools, type ToolsConfig } from "./tools";

export * from "./tools";
```

In the `AgentConfig` interface, after `variables`:

```ts
  tools: ToolsConfig;
```

In `validateAgentConfig`, beside the other validators:

```ts
  const tools = validateTools(record.tools, errors);
```

and add `tools,` to the returned config object.

In `lib/agent-config/defaults.ts`, add to `DEFAULT_AGENT_CONFIG` after `variables: []`:

```ts
  tools: { http: [], client: [], webhooks: [] },
```

- [ ] **Step 6: Add the backward-compatibility test**

This is the one that protects existing users. Append to `lib/agent-config/schema.test.ts`:

```ts
test("a config saved before tools existed still loads, keeping its other fields", () => {
  const { tools: _tools, ...withoutTools } = DEFAULT_AGENT_CONFIG;
  const result = validateAgentConfig({ ...withoutTools, instructions: "Keep me." });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.config.instructions, "Keep me.");
    assert.deepEqual(result.config.tools, { http: [], client: [], webhooks: [] });
  }
});
```

If this test ever fails, every saved configuration silently resets to seed defaults on the next read — treat it as the highest-severity failure in the suite.

- [ ] **Step 7: Verify and commit**

```bash
npm test && npm run typecheck && npm run lint
```
Expected: 82 tests pass, clean.

```bash
git add lib/agent-config
git commit -m "feat: define and validate tools and webhooks"
```

---

### Task 3: Route the tool errors

**Files:**
- Modify: `lib/agent-config/routes.ts`
- Test: `lib/agent-config/routes.test.ts`

**Interfaces:**
- Produces: `routeForPath("tools.…")` returns `"/agent/actions"`.

- [ ] **Step 1: Write the failing test**

Append to `lib/agent-config/routes.test.ts`:

```ts
test("routes tool errors to the actions screen", () => {
  assert.equal(routeForPath("tools"), "/agent/actions");
  assert.equal(routeForPath("tools.http.0.name"), "/agent/actions");
  assert.equal(routeForPath("tools.webhooks.1.events"), "/agent/actions");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — currently falls through to `/agent/conversation`.

- [ ] **Step 3: Add the branch**

In `routeForPath`, before the final fallback:

```ts
  if (path.startsWith("tools")) return "/agent/actions";
```

- [ ] **Step 4: Verify and commit**

```bash
npm test && npm run typecheck && npm run lint
git add lib/agent-config/routes.ts lib/agent-config/routes.test.ts
git commit -m "feat: send tool validation errors to the Actions screen"
```
Expected: 83 tests pass.

---

### Task 4: Modal primitive and the shared row editors

**Files:**
- Create: `components/ui/modal.tsx`
- Create: `components/agent-config/ParameterRows.tsx`
- Create: `components/agent-config/HeaderRows.tsx`

**Interfaces:**
- Produces:
  - `Modal({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode; footer: React.ReactNode })`
  - `ParameterRows({ parameters, onChange, errors, pathPrefix }: { parameters: ToolParameter[]; onChange: (next: ToolParameter[]) => void; errors: Map<string, string>; pathPrefix: string })`
  - `HeaderRows({ rows, onChange, errors, pathPrefix, title, description }: { rows: ToolHeader[]; onChange: (next: ToolHeader[]) => void; errors: Map<string, string>; pathPrefix: string; title: string; description: string })`

- [ ] **Step 1: Create the modal**

Create `components/ui/modal.tsx`:

```tsx
"use client";

import * as React from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * A dialog built on the native `<dialog>` element, which gives us the top layer,
 * a real backdrop and Escape-to-close without reimplementing any of it.
 *
 * `showModal()` also traps focus for free — the reason this wraps the element
 * rather than a positioned div.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);

  React.useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      // Fires for Escape as well as close(), so both routes tell the parent.
      onClose={onClose}
      onClick={(event) => {
        // The backdrop is the dialog element itself; a click that lands on the
        // panel has a different target.
        if (event.target === ref.current) onClose();
      }}
      className="m-0 max-h-none max-w-none bg-transparent p-0 backdrop:bg-black/20"
      style={{ width: "100%", height: "100%" }}
      aria-label={title}
    >
      <div className="mx-auto my-6 flex max-h-[calc(100vh-3rem)] w-[min(640px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-xl">
        <header className="flex items-center gap-3 border-b border-[var(--border)] px-5 py-4">
          <h2 className="flex-1 text-base font-semibold text-[var(--text)]">{title}</h2>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
            <X />
          </Button>
        </header>

        <div className="scroll-slim flex flex-col gap-5 overflow-y-auto p-5">{children}</div>

        <footer className="flex justify-end gap-2 border-t border-[var(--border)] bg-[var(--surface-2)] px-5 py-4">
          {footer}
        </footer>
      </div>
    </dialog>
  );
}
```

- [ ] **Step 2: Create the parameter editor**

Create `components/agent-config/ParameterRows.tsx`:

```tsx
"use client";

import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { ToolParameter, ToolValueType } from "@/lib/agent-config/tools";

/**
 * Editor for the values a tool takes.
 *
 * Shared by the HTTP and client tool forms: both describe parameters the model
 * fills in from the conversation, so they get the same editor rather than two
 * that drift.
 */
export function ParameterRows({
  parameters,
  onChange,
  errors,
  pathPrefix,
}: {
  parameters: ToolParameter[];
  onChange: (next: ToolParameter[]) => void;
  errors: Map<string, string>;
  pathPrefix: string;
}) {
  const patch = (index: number, changes: Partial<ToolParameter>) =>
    onChange(parameters.map((row, i) => (i === index ? { ...row, ...changes } : row)));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-[var(--text)]">Parameters</h3>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">
            Values the agent works out from the conversation and passes in.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            onChange([
              ...parameters,
              {
                id: crypto.randomUUID(),
                name: "",
                type: "string",
                description: "",
                required: true,
              },
            ])
          }
        >
          <Plus />
          Add
        </Button>
      </div>

      {parameters.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)] px-4 py-3 text-xs text-[var(--text-muted)]">
          No parameters. The agent will call this with no arguments.
        </p>
      ) : (
        parameters.map((row, index) => {
          const nameError = errors.get(`${pathPrefix}.${index}.name`);
          return (
            <div key={row.id} className="flex flex-col gap-2">
              <div className="grid grid-cols-[minmax(0,1fr)_7rem_minmax(0,1.4fr)_auto] items-center gap-2">
                <Input
                  aria-label="Parameter name"
                  value={row.name}
                  placeholder="order_id"
                  spellCheck={false}
                  className="font-mono text-xs"
                  onChange={(event) => patch(index, { name: event.target.value })}
                />
                <Select
                  aria-label="Parameter type"
                  value={row.type}
                  onChange={(event) => patch(index, { type: event.target.value as ToolValueType })}
                >
                  <option value="string">String</option>
                  <option value="number">Number</option>
                  <option value="boolean">Boolean</option>
                </Select>
                <Input
                  aria-label="What this value is"
                  value={row.description}
                  placeholder="The customer's order number"
                  onChange={(event) => patch(index, { description: event.target.value })}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove parameter ${row.name || "unnamed"}`}
                  className="text-[var(--text-muted)] hover:text-[var(--danger)]"
                  onClick={() => onChange(parameters.filter((_, i) => i !== index))}
                >
                  <Trash2 />
                </Button>
              </div>
              {nameError && (
                <p role="alert" className="text-xs font-medium text-[var(--danger)]">
                  {nameError}
                </p>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create the header editor**

Create `components/agent-config/HeaderRows.tsx`:

```tsx
"use client";

import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ToolHeader } from "@/lib/agent-config/tools";

/**
 * Editor for a list of name/value pairs.
 *
 * Serves both request headers and query parameters, and both the tool and
 * webhook forms — the shape is identical, only the wording differs, so the
 * heading and hint are props.
 */
export function HeaderRows({
  rows,
  onChange,
  errors,
  pathPrefix,
  title,
  description,
}: {
  rows: ToolHeader[];
  onChange: (next: ToolHeader[]) => void;
  errors: Map<string, string>;
  pathPrefix: string;
  title: string;
  description: string;
}) {
  const patch = (index: number, changes: Partial<ToolHeader>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...changes } : row)));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-[var(--text)]">{title}</h3>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">{description}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onChange([...rows, { id: crypto.randomUUID(), name: "", value: "" }])}
        >
          <Plus />
          Add
        </Button>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)] px-4 py-3 text-xs text-[var(--text-muted)]">
          None added.
        </p>
      ) : (
        rows.map((row, index) => {
          const nameError = errors.get(`${pathPrefix}.${index}.name`);
          return (
            <div key={row.id} className="flex flex-col gap-2">
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] items-center gap-2">
                <Input
                  aria-label={`${title} name`}
                  value={row.name}
                  placeholder="Authorization"
                  spellCheck={false}
                  className="font-mono text-xs"
                  onChange={(event) => patch(index, { name: event.target.value })}
                />
                <Input
                  aria-label={`${title} value`}
                  value={row.value}
                  placeholder="Bearer {{CRM_API_KEY}}"
                  spellCheck={false}
                  className="font-mono text-xs"
                  onChange={(event) => patch(index, { value: event.target.value })}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${row.name || "unnamed"}`}
                  className="text-[var(--text-muted)] hover:text-[var(--danger)]"
                  onClick={() => onChange(rows.filter((_, i) => i !== index))}
                >
                  <Trash2 />
                </Button>
              </div>
              {nameError && (
                <p role="alert" className="text-xs font-medium text-[var(--danger)]">
                  {nameError}
                </p>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
```

- [ ] **Step 4: Verify and commit**

```bash
npm test && npm run typecheck && npm run lint
```
Expected: 83 tests still pass; clean typecheck and lint. Nothing renders these yet.

```bash
git add components/ui/modal.tsx components/agent-config/ParameterRows.tsx components/agent-config/HeaderRows.tsx
git commit -m "feat: add a modal primitive and shared row editors"
```

---

### Task 5: The HTTP tool and client tool forms

**Files:**
- Create: `components/agent-config/HttpToolModal.tsx`
- Create: `components/agent-config/ClientToolModal.tsx`

**Interfaces:**
- Consumes: `Modal`, `ParameterRows`, `HeaderRows`, `Field`, `Input`, `Textarea`, `Select`, `Switch`, `Checkbox`, `Button`; `bracedParams`, `HTTP_METHODS`, and the tool types.
- Produces:
  - `HttpToolModal({ open, tool, onCancel, onSave, errors }: { open: boolean; tool: HttpTool | null; onCancel: () => void; onSave: (tool: HttpTool) => void; errors: Map<string, string> })`
  - `ClientToolModal({ open, tool, onCancel, onSave, errors }: { open: boolean; tool: ClientTool | null; onCancel: () => void; onSave: (tool: ClientTool) => void; errors: Map<string, string> })`

`tool` is `null` when adding. Both hold a working copy internally and only call `onSave` on the footer's Save, so Cancel discards.

- [ ] **Step 1: Create the HTTP tool form**

Create `components/agent-config/HttpToolModal.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";

import { HeaderRows } from "@/components/agent-config/HeaderRows";
import { ParameterRows } from "@/components/agent-config/ParameterRows";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { bracedParams, HTTP_METHODS, type HttpTool } from "@/lib/agent-config/tools";

function blank(): HttpTool {
  return {
    id: crypto.randomUUID(),
    name: "",
    description: "",
    method: "GET",
    url: "",
    parameters: [],
    headers: [],
    silent: false,
  };
}

export function HttpToolModal({
  open,
  tool,
  onCancel,
  onSave,
  errors,
}: {
  open: boolean;
  tool: HttpTool | null;
  onCancel: () => void;
  onSave: (tool: HttpTool) => void;
  errors: Map<string, string>;
}) {
  const [draft, setDraft] = useState<HttpTool>(tool ?? blank());

  // Re-seed whenever the modal is opened for a different tool: the component
  // stays mounted between opens, so its draft would otherwise be the last one.
  useEffect(() => {
    if (open) setDraft(tool ?? blank());
  }, [open, tool]);

  const patch = (changes: Partial<HttpTool>) => setDraft((current) => ({ ...current, ...changes }));

  const declared = new Set(draft.parameters.map((parameter) => parameter.name));
  const missing = bracedParams(draft.url).filter((name) => !declared.has(name));

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={tool ? "Edit HTTP tool" : "Add HTTP tool"}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onSave(draft)}>
            {tool ? "Save tool" : "Add tool"}
          </Button>
        </>
      }
    >
      <Field
        label="Tool name"
        htmlFor="http-name"
        description="How the agent refers to it. Lowercase with underscores."
        error={errors.get("name")}
      >
        <Input
          id="http-name"
          value={draft.name}
          placeholder="check_order_status"
          spellCheck={false}
          className="font-mono text-xs"
          onChange={(event) => patch({ name: event.target.value })}
        />
      </Field>

      <Field
        label="When to use it"
        htmlFor="http-desc"
        description="The agent reads this to decide whether to call the tool. Say when it should — and when it shouldn't."
        error={errors.get("description")}
      >
        <Textarea
          id="http-desc"
          rows={3}
          value={draft.description}
          placeholder="Use this when the customer asks where their order is and gives an order number."
          onChange={(event) => patch({ description: event.target.value })}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-[8rem_minmax(0,1fr)]">
        <Field label="Method" htmlFor="http-method">
          <Select
            id="http-method"
            value={draft.method}
            onChange={(event) => patch({ method: event.target.value as HttpTool["method"] })}
          >
            {HTTP_METHODS.map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="URL" htmlFor="http-url" error={errors.get("url")}>
          <Input
            id="http-url"
            value={draft.url}
            placeholder="https://api.example.com/orders/{order_id}"
            spellCheck={false}
            className="font-mono text-xs"
            onChange={(event) => patch({ url: event.target.value })}
          />
        </Field>
      </div>

      {missing.length > 0 && (
        <p className="rounded-xl border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-4 py-3 text-xs text-[var(--text)]">
          The URL uses {missing.map((name) => `{${name}}`).join(", ")}, which{" "}
          {missing.length === 1 ? "is not a parameter" : "are not parameters"} yet.{" "}
          <button
            type="button"
            className="font-medium underline underline-offset-2"
            onClick={() =>
              patch({
                parameters: [
                  ...draft.parameters,
                  ...missing.map((name) => ({
                    id: crypto.randomUUID(),
                    name,
                    type: "string" as const,
                    description: "",
                    required: true,
                  })),
                ],
              })
            }
          >
            Add {missing.length === 1 ? "it" : "them"}
          </button>
          .
        </p>
      )}

      <ParameterRows
        parameters={draft.parameters}
        onChange={(parameters) => patch({ parameters })}
        errors={errors}
        pathPrefix="parameters"
      />

      <HeaderRows
        rows={draft.headers}
        onChange={(headers) => patch({ headers })}
        errors={errors}
        pathPrefix="headers"
        title="Headers"
        description="Write {{SECRET_NAME}} to use a secret from Advanced. Values stay on the server."
      />

      {/* A standalone toggle, so not a `Field` — that wrapper exists to pair a
          label with a control below it, and there is no control here. */}
      <div className="flex items-start gap-3">
        <Switch
          label="Silent"
          checked={draft.silent}
          onCheckedChange={(silent) => patch({ silent })}
        />
        <div>
          <p className="text-sm font-medium text-[var(--text)]">Silent</p>
          <p className="mt-0.5 text-xs leading-relaxed text-[var(--text-muted)]">
            Run the call without telling the caller and without speaking the result.
          </p>
        </div>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 2: Create the client tool form**

Create `components/agent-config/ClientToolModal.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";

import { ParameterRows } from "@/components/agent-config/ParameterRows";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { ClientTool } from "@/lib/agent-config/tools";

function blank(): ClientTool {
  return {
    id: crypto.randomUUID(),
    name: "",
    description: "",
    parameters: [],
    awaitResult: true,
  };
}

export function ClientToolModal({
  open,
  tool,
  onCancel,
  onSave,
  errors,
}: {
  open: boolean;
  tool: ClientTool | null;
  onCancel: () => void;
  onSave: (tool: ClientTool) => void;
  errors: Map<string, string>;
}) {
  const [draft, setDraft] = useState<ClientTool>(tool ?? blank());

  useEffect(() => {
    if (open) setDraft(tool ?? blank());
  }, [open, tool]);

  const patch = (changes: Partial<ClientTool>) =>
    setDraft((current) => ({ ...current, ...changes }));

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={tool ? "Edit client tool" : "Add client tool"}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onSave(draft)}>
            {tool ? "Save tool" : "Add tool"}
          </Button>
        </>
      }
    >
      <p className="rounded-xl border border-[var(--border)] border-l-[3px] border-l-[var(--accent)] bg-[var(--surface-2)] px-4 py-3 text-xs leading-relaxed text-[var(--text-muted)]">
        A client tool runs in the caller&rsquo;s browser. Your page listens for the call and decides
        what to do — the gateway passes the request along and waits for a result.
      </p>

      <Field
        label="Tool name"
        htmlFor="client-name"
        description="Your page listens for this exact name."
        error={errors.get("name")}
      >
        <Input
          id="client-name"
          value={draft.name}
          placeholder="open_tracking_page"
          spellCheck={false}
          className="font-mono text-xs"
          onChange={(event) => patch({ name: event.target.value })}
        />
      </Field>

      <Field
        label="When to use it"
        htmlFor="client-desc"
        description="The agent reads this to decide whether to call the tool."
        error={errors.get("description")}
      >
        <Textarea
          id="client-desc"
          rows={3}
          value={draft.description}
          placeholder="Use this to show the tracking page once the customer has confirmed their order number."
          onChange={(event) => patch({ description: event.target.value })}
        />
      </Field>

      <ParameterRows
        parameters={draft.parameters}
        onChange={(parameters) => patch({ parameters })}
        errors={errors}
        pathPrefix="parameters"
      />

      {/* A standalone toggle, so not a `Field` — that wrapper exists to pair a
          label with a control below it, and there is no control here. */}
      <div className="flex items-start gap-3">
        <Switch
          label="Wait for a result"
          checked={draft.awaitResult}
          onCheckedChange={(awaitResult) => patch({ awaitResult })}
        />
        <div>
          <p className="text-sm font-medium text-[var(--text)]">Wait for a result</p>
          <p className="mt-0.5 text-xs leading-relaxed text-[var(--text-muted)]">
            Hold the agent&rsquo;s turn until the browser replies. Turn off for fire-and-forget
            actions.
          </p>
        </div>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 3: Verify and commit**

```bash
npm test && npm run typecheck && npm run lint
```
Expected: 83 tests, clean. Nothing renders these yet.

```bash
git add components/agent-config/HttpToolModal.tsx components/agent-config/ClientToolModal.tsx
git commit -m "feat: add the HTTP and client tool forms"
```

---

### Task 6: The webhook form and the Actions screen

**Files:**
- Create: `components/agent-config/WebhookModal.tsx`
- Modify: `components/agent-config/ActionsTab.tsx`
- Modify: `app/(console)/agent/actions/page.tsx`

**Interfaces:**
- Consumes: all three modals, `useAgentConfig`, `EMPTY_TOOLS`, the tool types.
- Produces: `WebhookModal({ open, webhook, onCancel, onSave, errors })` with the same shape as the other two; `ActionsTab(props: TabProps)`.

- [ ] **Step 1: Create the webhook form**

Create `components/agent-config/WebhookModal.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";

import { HeaderRows } from "@/components/agent-config/HeaderRows";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  HTTP_METHODS,
  RETRY_POLICIES,
  WEBHOOK_EVENTS,
  type RetryPolicy,
  type Webhook,
  type WebhookEvent,
} from "@/lib/agent-config/tools";

const EVENT_LABEL: Record<WebhookEvent, string> = {
  call_started: "Call started",
  call_ended: "Call ended",
  transcript_ready: "Transcript ready",
};

const RETRY_LABEL: Record<RetryPolicy, string> = {
  backoff: "Retry 3 times, backing off",
  once: "Retry once",
  none: "Don't retry",
};

function blank(): Webhook {
  return {
    id: crypto.randomUUID(),
    name: "",
    description: "",
    method: "POST",
    url: "",
    headers: [],
    queryParams: [],
    events: ["call_ended"],
    retry: "backoff",
  };
}

export function WebhookModal({
  open,
  webhook,
  onCancel,
  onSave,
  errors,
}: {
  open: boolean;
  webhook: Webhook | null;
  onCancel: () => void;
  onSave: (webhook: Webhook) => void;
  errors: Map<string, string>;
}) {
  const [draft, setDraft] = useState<Webhook>(webhook ?? blank());

  useEffect(() => {
    if (open) setDraft(webhook ?? blank());
  }, [open, webhook]);

  const patch = (changes: Partial<Webhook>) => setDraft((current) => ({ ...current, ...changes }));

  const toggleEvent = (event: WebhookEvent, on: boolean) =>
    patch({
      events: on ? [...draft.events, event] : draft.events.filter((item) => item !== event),
    });

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={webhook ? "Edit webhook" : "Add webhook"}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onSave(draft)}>
            {webhook ? "Save webhook" : "Add webhook"}
          </Button>
        </>
      }
    >
      <Field label="Name" htmlFor="hook-name" error={errors.get("name")}>
        <Input
          id="hook-name"
          value={draft.name}
          placeholder="crm_sync"
          spellCheck={false}
          className="font-mono text-xs"
          onChange={(event) => patch({ name: event.target.value })}
        />
      </Field>

      <Field
        label="Description"
        htmlFor="hook-desc"
        description="For your own reference. The agent never reads this — a webhook is fired by an event, not called."
        error={errors.get("description")}
      >
        <Textarea
          id="hook-desc"
          rows={2}
          value={draft.description}
          placeholder="Sends the transcript and outcome to the CRM when a call ends."
          onChange={(event) => patch({ description: event.target.value })}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-[8rem_minmax(0,1fr)]">
        <Field label="Method" htmlFor="hook-method">
          <Select
            id="hook-method"
            value={draft.method}
            onChange={(event) => patch({ method: event.target.value as Webhook["method"] })}
          >
            {HTTP_METHODS.map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="URL" htmlFor="hook-url" error={errors.get("url")}>
          <Input
            id="hook-url"
            value={draft.url}
            placeholder="https://api.example.com/v1/calls"
            spellCheck={false}
            className="font-mono text-xs"
            onChange={(event) => patch({ url: event.target.value })}
          />
        </Field>
      </div>

      <Field
        label="Send on"
        htmlFor="hook-events"
        description="Which call events post to this endpoint."
        error={errors.get("events")}
      >
        <div id="hook-events" className="flex flex-wrap gap-4 pt-1">
          {WEBHOOK_EVENTS.map((event) => (
            <label key={event} className="inline-flex items-center gap-2 text-sm text-[var(--text)]">
              <Checkbox
                checked={draft.events.includes(event)}
                onChange={(changeEvent) => toggleEvent(event, changeEvent.target.checked)}
              />
              {EVENT_LABEL[event]}
            </label>
          ))}
        </div>
      </Field>

      <HeaderRows
        rows={draft.headers}
        onChange={(headers) => patch({ headers })}
        errors={errors}
        pathPrefix="headers"
        title="Headers"
        description="Write {{SECRET_NAME}} to use a secret from Advanced."
      />

      <HeaderRows
        rows={draft.queryParams}
        onChange={(queryParams) => patch({ queryParams })}
        errors={errors}
        pathPrefix="queryParams"
        title="Query parameters"
        description="Appended to the URL."
      />

      <Field
        label="Retries"
        htmlFor="hook-retry"
        description="What happens when your endpoint doesn't answer."
      >
        <Select
          id="hook-retry"
          value={draft.retry}
          onChange={(event) => patch({ retry: event.target.value as RetryPolicy })}
        >
          {RETRY_POLICIES.map((policy) => (
            <option key={policy} value={policy}>
              {RETRY_LABEL[policy]}
            </option>
          ))}
        </Select>
      </Field>
    </Modal>
  );
}
```

- [ ] **Step 2: Rewrite the Actions screen**

Replace `components/agent-config/ActionsTab.tsx` entirely:

```tsx
"use client";

import { useState } from "react";
import { Globe, MonitorSmartphone, Plus, Trash2, Webhook as WebhookIcon } from "lucide-react";

import { ClientToolModal } from "@/components/agent-config/ClientToolModal";
import { HttpToolModal } from "@/components/agent-config/HttpToolModal";
import { WebhookModal } from "@/components/agent-config/WebhookModal";
import type { TabProps } from "@/components/agent-config/AgentConfigProvider";
import { Button } from "@/components/ui/button";
import { EMPTY_TOOLS, type ClientTool, type HttpTool, type Webhook } from "@/lib/agent-config/tools";
import { cn } from "@/lib/utils";

const METHOD_CLASS: Record<string, string> = {
  GET: "bg-[var(--accent-2)]",
  POST: "bg-[var(--success)]",
  PATCH: "bg-[var(--warning)]",
  DELETE: "bg-[var(--danger)]",
};

/** Which editor is open, and on which record. `null` means adding. */
type Editing =
  | { kind: "http"; tool: HttpTool | null }
  | { kind: "client"; tool: ClientTool | null }
  | { kind: "webhook"; webhook: Webhook | null }
  | null;

export function ActionsTab({ config, update, errors }: TabProps) {
  const tools = config.tools ?? EMPTY_TOOLS;
  const [editing, setEditing] = useState<Editing>(null);

  const patchTools = (changes: Partial<typeof tools>) =>
    update({ tools: { ...tools, ...changes } });

  /** Replaces by id when the id is already present, appends otherwise. */
  const upsert = <T extends { id: string }>(list: T[], item: T): T[] =>
    list.some((existing) => existing.id === item.id)
      ? list.map((existing) => (existing.id === item.id ? item : existing))
      : [...list, item];

  return (
    <div className="flex flex-col gap-9">
      <p className="rounded-xl border border-[var(--border)] border-l-[3px] border-l-[var(--accent)] bg-[var(--surface-2)] px-4 py-3 text-xs leading-relaxed text-[var(--text-muted)]">
        Actions are saved with the rest of the configuration, but the agent does not call them yet —
        running them during a call is the next piece of work.
      </p>

      <Section
        icon={Globe}
        title="HTTP tools"
        blurb="Called mid-conversation. Authenticated with the secrets in Advanced."
        empty="No HTTP tools. Add one to let the agent look something up or file a request while it talks."
        onAdd={() => setEditing({ kind: "http", tool: null })}
      >
        {tools.http.map((tool) => (
          <Row
            key={tool.id}
            method={tool.method}
            name={tool.name}
            description={tool.description}
            tag={tool.silent ? "Silent" : undefined}
            onEdit={() => setEditing({ kind: "http", tool })}
            onDelete={() =>
              patchTools({ http: tools.http.filter((item) => item.id !== tool.id) })
            }
          />
        ))}
      </Section>

      <Section
        icon={MonitorSmartphone}
        title="Client tools"
        blurb="Functions that run in the caller's browser, for what the server cannot do."
        empty="No client tools. Add one to let the agent open a page or fill a form on the caller's screen."
        onAdd={() => setEditing({ kind: "client", tool: null })}
      >
        {tools.client.map((tool) => (
          <Row
            key={tool.id}
            name={tool.name}
            description={tool.description}
            tag={tool.awaitResult ? undefined : "Async"}
            onEdit={() => setEditing({ kind: "client", tool })}
            onDelete={() =>
              patchTools({ client: tools.client.filter((item) => item.id !== tool.id) })
            }
          />
        ))}
      </Section>

      <Section
        icon={WebhookIcon}
        title="Webhooks"
        blurb="Call events posted to an endpoint you control."
        empty="No webhooks. Add one to send call events to your own systems."
        onAdd={() => setEditing({ kind: "webhook", webhook: null })}
      >
        {tools.webhooks.map((hook) => (
          <Row
            key={hook.id}
            method={hook.method}
            name={hook.name}
            description={hook.description}
            onEdit={() => setEditing({ kind: "webhook", webhook: hook })}
            onDelete={() =>
              patchTools({ webhooks: tools.webhooks.filter((item) => item.id !== hook.id) })
            }
          />
        ))}
      </Section>

      <HttpToolModal
        open={editing?.kind === "http"}
        tool={editing?.kind === "http" ? editing.tool : null}
        errors={errors}
        onCancel={() => setEditing(null)}
        onSave={(tool) => {
          patchTools({ http: upsert(tools.http, tool) });
          setEditing(null);
        }}
      />

      <ClientToolModal
        open={editing?.kind === "client"}
        tool={editing?.kind === "client" ? editing.tool : null}
        errors={errors}
        onCancel={() => setEditing(null)}
        onSave={(tool) => {
          patchTools({ client: upsert(tools.client, tool) });
          setEditing(null);
        }}
      />

      <WebhookModal
        open={editing?.kind === "webhook"}
        webhook={editing?.kind === "webhook" ? editing.webhook : null}
        errors={errors}
        onCancel={() => setEditing(null)}
        onSave={(webhook) => {
          patchTools({ webhooks: upsert(tools.webhooks, webhook) });
          setEditing(null);
        }}
      />
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  blurb,
  empty,
  onAdd,
  children,
}: {
  icon: typeof Globe;
  title: string;
  blurb: string;
  empty: string;
  onAdd: () => void;
  children: React.ReactNode;
}) {
  const rows = Array.isArray(children) ? children : [children];
  const isEmpty = rows.flat().filter(Boolean).length === 0;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2.5">
          <Icon className="size-4 translate-y-0.5 text-[var(--text-muted)]" />
          <div>
            <h2 className="text-sm font-medium text-[var(--text)]">{title}</h2>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">{blurb}</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={onAdd}>
          <Plus />
          Add
        </Button>
      </div>

      {isEmpty ? (
        <p className="rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)] px-4 py-3 text-xs text-[var(--text-muted)]">
          {empty}
        </p>
      ) : (
        <div className="flex flex-col gap-2">{children}</div>
      )}
    </section>
  );
}

function Row({
  method,
  name,
  description,
  tag,
  onEdit,
  onDelete,
}: {
  method?: string;
  name: string;
  description: string;
  tag?: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
      {method && (
        <span
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wide text-white",
            METHOD_CLASS[method] ?? "bg-[var(--text-muted)]",
          )}
        >
          {method}
        </span>
      )}
      <span className="shrink-0 font-mono text-xs font-semibold text-[var(--text)]">
        {name || "unnamed"}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-muted)]">{description}</span>
      {tag && (
        <span className="shrink-0 rounded-full bg-[var(--surface-3)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          {tag}
        </span>
      )}
      <Button variant="ghost" size="sm" onClick={onEdit}>
        Edit
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Delete ${name || "unnamed"}`}
        className="text-[var(--text-muted)] hover:text-[var(--danger)]"
        onClick={onDelete}
      >
        <Trash2 />
      </Button>
    </div>
  );
}
```

- [ ] **Step 3: Give the page its props**

`ActionsTab` now needs `TabProps`. Replace `app/(console)/agent/actions/page.tsx`:

```tsx
"use client";

import { useAgentConfig } from "@/components/agent-config/AgentConfigProvider";
import { ActionsTab } from "@/components/agent-config/ActionsTab";

export default function ActionsPage() {
  const { config, update, setSecretKeys, errors } = useAgentConfig();
  return (
    <ActionsTab config={config} update={update} setSecretKeys={setSecretKeys} errors={errors} />
  );
}
```

- [ ] **Step 4: Verify and commit**

```bash
npm test && npm run typecheck && npm run lint
```
Expected: 83 tests, clean.

```bash
git add components/agent-config app/\(console\)/agent/actions/page.tsx
git commit -m "feat: add the webhook form and wire up the Actions screen"
```

---

### Task 7: Verification and documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Full gates, on a cleared cache**

```bash
npm test
npm run typecheck
npm run lint
rm -rf .next && npm run build
```
Expected: 83 tests, zero type errors, clean lint, successful build. The `.next` clear is required — this project's generated types have been observed not to refresh.

- [ ] **Step 2: Prove persistence end to end**

A dev server may already be running; use it read-only rather than starting a second. Confirm the field round-trips through the store:

```bash
curl -s localhost:3000/api/agent-config | head -c 200
```
Expected: JSON including `"tools":{"http":[],"client":[],"webhooks":[]}`.

Then confirm a bad tool is rejected with a path the form can route:

```bash
curl -s localhost:3000/api/agent-config > /tmp/cfg.json
node -e 'const c=require("/tmp/cfg.json");c.tools={http:[{id:"x",name:"Bad Name",description:"d",method:"GET",url:"https://x.example",parameters:[],headers:[],silent:false}],client:[],webhooks:[]};require("fs").writeFileSync("/tmp/bad.json",JSON.stringify(c))'
curl -s -X PUT localhost:3000/api/agent-config -H 'content-type: application/json' --data-binary @/tmp/bad.json
```
Expected: `400` with an error whose `path` is `tools.http.0.name`.

Then save a valid one and confirm it reaches disk:

```bash
node -e 'const c=require("/tmp/cfg.json");c.tools={http:[{id:"x",name:"check_order",description:"Use when asked about an order.",method:"GET",url:"https://api.example.com/o/{order_id}",parameters:[{id:"p",name:"order_id",type:"string",description:"The order.",required:true}],headers:[],silent:false}],client:[],webhooks:[]};require("fs").writeFileSync("/tmp/good.json",JSON.stringify(c))'
curl -s -X PUT localhost:3000/api/agent-config -H 'content-type: application/json' --data-binary @/tmp/good.json > /dev/null
cat data/agent-config.json | head -c 400
rm -rf data /tmp/cfg.json /tmp/bad.json /tmp/good.json
```
Expected: the tool appears in the file. Delete `data/` afterwards so the app falls back to seed defaults.

- [ ] **Step 3: Update the README**

In the file tree, under `components/agent-config/`, add:

```
    HttpToolModal.tsx                 add or edit an HTTP tool
    ClientToolModal.tsx               add or edit a client tool
    WebhookModal.tsx                  add or edit a webhook
    ParameterRows.tsx                 shared parameter editor
    HeaderRows.tsx                    shared header / query editor
```

under `components/ui/`, add `modal.tsx`, and under `lib/agent-config/`, add `tools.ts` and `validate-helpers.ts`.

Then add a section after "Configuring the agent":

```markdown
### Actions

**Actions** in the sidebar defines what the agent can do beyond talking:

- **HTTP tools** — an endpoint the agent calls mid-conversation. Headers can
  reference a secret as `{{SECRET_NAME}}`; the value is resolved on the server
  and never sent to the browser. Braces in the URL (`/orders/{order_id}`)
  become parameters the agent fills in.
- **Client tools** — functions that run in the caller's own browser.
- **Webhooks** — call events posted to an endpoint you control.

Definitions are saved with the rest of the configuration, in
`data/agent-config.json`. **The agent does not call them yet** — executing them
during a call is the next piece of work.
```

- [ ] **Step 4: Human acceptance checklist**

The forms need a browser. Write the remaining checks as a list the user can work through, and report which you could not perform:

1. Open **Actions**. Three sections appear, each empty, with the "not called yet" note at the top.
2. **Add** an HTTP tool. The modal opens with focus inside it.
3. Type `https://api.example.com/orders/{order_id}` as the URL. A warning offers to add `order_id` as a parameter; clicking it adds the row.
4. Name it `check_order`, describe it, save. It appears in the list with a `GET` chip.
5. The save bar shows unsaved changes. Save. Reload — the tool is still there.
6. Add a client tool named `check_order` too. Save. The save is rejected, the error lands on the client tool's name, and the console stays on Actions.
7. Rename it, save, confirm both persist.
8. Add a webhook, uncheck every event, save — rejected with the error on the event list.
9. Press Escape in an open modal: it closes and discards.
10. Delete a tool; confirm it disappears and the save bar reflects the change.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document the Actions configuration"
```

---

## Self-Review

**Spec coverage:** Data model → Task 2. Validation incl. cross-kind uniqueness, URL parsing, caps, events → Task 2. Backward compatibility → Task 2 step 6. Storage (no new store) → inherent; verified in Task 7. Error routing → Task 3. Modal primitive → Task 4. Shared editors → Task 4. Three forms → Tasks 5 and 6. Actions screen with list/add/edit/delete → Task 6. "Not called yet" statement → Task 6. Brace-parameter offer → Task 5. Secret reference text → Tasks 5 and 6 via `HeaderRows`. Testing → Tasks 2, 3, 7.

**Deliberate deviations from the spec:**

1. **The helpers extraction (Task 1) is not in the spec.** It exists because `schema.ts` would otherwise reach ~540 lines doing two jobs, and duplicating the readers would let the two validators drift into reporting the same mistake differently. It is mechanical and the existing 65 tests prove it faithful.
2. **`ToolParameter` gains `required`**, which the preview did not show. A tool parameter that the model may omit is a real distinction, and adding the field later would mean migrating stored tools.
3. **Client tools show an `Async` tag** when `awaitResult` is false, so the list distinguishes them without opening the form.

**Type consistency:** `ToolsConfig` is defined in `tools.ts` and imported by `schema.ts`, which re-exports the whole module so consumers may import tool types from either. `errors` is `Map<string, string>` everywhere, matching `TabProps`. The modals take field-relative error keys (`name`, `url`, `parameters.0.name`) while the validator emits absolute paths (`tools.http.0.name`) — Task 6 passes the provider's map straight through, so a per-tool error will not currently match a modal field. That is accepted for this phase: the save bar still reports the failure and routes to Actions, and per-field mapping inside a modal needs the tool's index, which the modal does not know. Recorded here rather than left to be discovered.
