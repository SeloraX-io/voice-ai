# Agent Configuration UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded agent constants with a persisted, editable agent configuration — a LiveKit-style tabbed editor covering Conversation, Models & Voice and Advanced — and make the app light-theme only.

**Architecture:** Config lives in `data/agent-config.json`, written by a Next route handler and read fresh by the voice gateway at the start of every call. Pure, shared modules under `lib/agent-config/` own the types, validation, and `{variable}` interpolation; a thin store under `server/config/` owns all filesystem access. Secrets live in a separate gitignored file and are write-only over the API.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript strict, Tailwind CSS v4, Radix Tabs, `ws`, `@google/genai`, Node 24 built-in test runner (`node:test`) driven through `tsx`.

**Spec:** `docs/superpowers/specs/2026-08-16-agent-config-design.md`

## Global Constraints

- **No new npm dependencies.** Every primitive in this plan is built from native elements or packages already in `package.json`. Node 24 ships `node:test`, so testing adds nothing.
- **Node version:** v24.19.0. Verified: `node --import tsx --test <file>` runs TypeScript tests directly.
- **TypeScript is strict.** `noEmit` is on; `npm run typecheck` must stay clean.
- **Path alias:** `@/*` maps to the repo root. `@/server/...` imports already work from route handlers (see `app/api/upload/route.ts:25`).
- **Two processes:** Next (`npm run dev:web`) and the voice gateway (`npm run dev:gateway`), started together by `npm run dev` via `concurrently`. Both run with the repo root as cwd.
- **Design tokens:** all colors go through the CSS custom properties in `app/globals.css` (`var(--surface-2)`, `var(--text-muted)`, …). Never hardcode a hex value in a component unless it is part of a documented per-state palette.
- **Secrets never reach the browser.** Any response containing a secret *value* is a defect.
- **Existing comment style:** files open with a block comment explaining *why* the module exists. Match it.
- **Config version:** `AGENT_CONFIG_VERSION = 1`.

---

## Preflight: Commit the working tree

The branch has uncommitted Bangla-localisation edits to `app/api/upload/route.ts`, `server/voice/agent-config.ts`, and `server/voice/gemini-session.ts`. This plan modifies and eventually deletes those files. Commit the existing work first so the config changes are reviewable on their own.

- [ ] **Step 1: Verify what is uncommitted**

```bash
git status --short
git diff --stat
```

Expected: three modified files, no staged changes.

- [ ] **Step 2: Commit the Bangla localisation work**

```bash
git add app/api/upload/route.ts server/voice/agent-config.ts server/voice/gemini-session.ts
git commit -m "feat: pin agent output to Bangla across live and upload paths"
```

- [ ] **Step 3: Confirm the tree is clean**

```bash
git status --short
```

Expected: no output.

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `lib/agent-config/schema.ts` | Types, limits, patterns, `validateAgentConfig`. Pure. |
| `lib/agent-config/defaults.ts` | `DEFAULT_AGENT_CONFIG` — the seed, carrying today's Bangla prompt. Pure. |
| `lib/agent-config/template.ts` | `{token}` scanning and interpolation. Pure. |
| `lib/agent-config/resolve.ts` | `resolveAgentConfig`, `buildSystemInstruction`. Pure. |
| `server/config/store.ts` | All filesystem access for config + secrets. |
| `app/api/agent-config/route.ts` | `GET` / `PUT` the config. |
| `app/api/agent-config/secrets/route.ts` | `POST` / `DELETE` a secret. |
| `app/configure/page.tsx` | Route that loads the config and renders the form. |
| `components/ui/field.tsx` | Label + description + error wrapper. |
| `components/ui/input.tsx` | Text input. |
| `components/ui/textarea.tsx` | Multiline input. |
| `components/ui/select.tsx` | Native `<select>`, token-styled. |
| `components/ui/switch.tsx` | `role="switch"` button. |
| `components/ui/checkbox.tsx` | Native checkbox, token-styled. |
| `components/ui/dropdown.tsx` | Click-outside + Escape dropdown used by the variable menu. |
| `components/agent-config/AgentConfigForm.tsx` | Shell: tabs, dirty tracking, save/discard, error routing. |
| `components/agent-config/ConversationTab.tsx` | Type, instructions, welcome message. |
| `components/agent-config/ModelsVoiceTab.tsx` | Model, voice, language, sampling, VAD. |
| `components/agent-config/ActionsTab.tsx` | Empty state for the next phase. |
| `components/agent-config/AdvancedTab.tsx` | Agent name, variables, secrets. |
| `components/agent-config/VariableInsertMenu.tsx` | "+ Insert variable" control. |
| `components/agent-config/PromptPreview.tsx` | Resolved prompt + unknown-token warning. |

**Modified:**

| Path | Change |
|---|---|
| `package.json` | Add the `test` script. |
| `.gitignore` | Ignore `data/agent-secrets.json`. |
| `server/voice/gemini-session.ts` | `create(events, config)`; config drives model, voice, sampling, VAD; add `primeGreeting()`. |
| `server/voice/websocket-server.ts` | Load config per call; greeting gate; report config's model/voice. |
| `app/api/upload/route.ts` | Read prompt and language from the store. |
| `app/layout.tsx` | Drop the theme bootstrap. |
| `app/globals.css` | Single light `:root`. |
| `components/voice/VoiceAgent.tsx` | Remove the read-only settings panel and `ThemeToggle`; link to `/configure`. |
| `components/voice/VoiceOrb.tsx` | Light-ground palette. |
| `components/voice/VoiceWaveform.tsx` | Light-ground idle bars. |

**Deleted:** `components/ThemeToggle.tsx`, `server/voice/agent-config.ts`.

---

### Task 1: Test harness, schema, and defaults

The foundation every later task imports. `schema.ts` is the single validation implementation, used by both the browser (instant feedback) and the `PUT` handler (never trusts the client).

**Files:**
- Modify: `package.json`
- Create: `lib/agent-config/schema.ts`
- Create: `lib/agent-config/defaults.ts`
- Test: `lib/agent-config/schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AgentConfig`, `AgentVariable`, `WelcomeConfig`, `VadConfig`, `ModelsConfig`, `ConversationType`, `VariableType`, `VadSensitivity`, `FieldError`, `ValidationResult`, `LIMITS`, `VARIABLE_NAME_RE`, `AGENT_NAME_RE`, `SECRET_KEY_RE`, `AGENT_CONFIG_VERSION`, `validateAgentConfig(input: unknown): ValidationResult`, `DEFAULT_AGENT_CONFIG: AgentConfig`.

- [ ] **Step 1: Add the test script**

In `package.json`, add to `"scripts"` after `"typecheck"`:

```json
"test": "node --import tsx --test \"lib/**/*.test.ts\" \"server/**/*.test.ts\""
```

If the glob does not expand on this machine, fall back to listing files explicitly — the runner itself is what matters.

- [ ] **Step 2: Write the failing test**

Create `lib/agent-config/schema.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_AGENT_CONFIG } from "./defaults";
import { validateAgentConfig } from "./schema";

function draft(overrides: Record<string, unknown> = {}) {
  return { ...DEFAULT_AGENT_CONFIG, ...overrides };
}

function errorPaths(input: unknown): string[] {
  const result = validateAgentConfig(input);
  return result.ok ? [] : result.errors.map((error) => error.path);
}

test("accepts the default config", () => {
  const result = validateAgentConfig(draft());
  assert.equal(result.ok, true);
});

test("rejects a non-object", () => {
  assert.deepEqual(errorPaths(null), [""]);
  assert.deepEqual(errorPaths("nope"), [""]);
});

test("rejects empty instructions", () => {
  assert.ok(errorPaths(draft({ instructions: "   " })).includes("instructions"));
});

test("rejects instructions past the limit", () => {
  assert.ok(errorPaths(draft({ instructions: "x".repeat(32_001) })).includes("instructions"));
});

test("rejects an empty welcome message when the welcome is enabled", () => {
  const welcome = { enabled: true, message: "", allowInterrupt: true };
  assert.ok(errorPaths(draft({ welcome })).includes("welcome.message"));
});

test("allows an empty welcome message when the welcome is disabled", () => {
  const welcome = { enabled: false, message: "", allowInterrupt: true };
  assert.equal(errorPaths(draft({ welcome })).length, 0);
});

test("rejects a variable name that is not an identifier", () => {
  const variables = [{ id: "a", type: "string", name: "my-var", previewValue: "x" }];
  assert.ok(errorPaths(draft({ variables })).includes("variables.0.name"));
});

test("rejects duplicate variable names", () => {
  const variables = [
    { id: "a", type: "string", name: "company", previewValue: "x" },
    { id: "b", type: "string", name: "company", previewValue: "y" },
  ];
  assert.ok(errorPaths(draft({ variables })).includes("variables.1.name"));
});

test("rejects a number variable whose preview value is not numeric", () => {
  const variables = [{ id: "a", type: "number", name: "count", previewValue: "abc" }];
  assert.ok(errorPaths(draft({ variables })).includes("variables.0.previewValue"));
});

test("rejects a boolean variable whose preview value is not true or false", () => {
  const variables = [{ id: "a", type: "boolean", name: "vip", previewValue: "yes" }];
  assert.ok(errorPaths(draft({ variables })).includes("variables.0.previewValue"));
});

test("rejects the data_collection type as unsupported", () => {
  assert.ok(errorPaths(draft({ type: "data_collection" })).includes("type"));
});

test("rejects an out-of-range temperature", () => {
  const models = { ...DEFAULT_AGENT_CONFIG.models, temperature: 5 };
  assert.ok(errorPaths(draft({ models })).includes("models.temperature"));
});

test("rejects a non-finite topP", () => {
  const models = { ...DEFAULT_AGENT_CONFIG.models, topP: Number.NaN };
  assert.ok(errorPaths(draft({ models })).includes("models.topP"));
});

test("rejects an out-of-range VAD silence duration", () => {
  const vad = { ...DEFAULT_AGENT_CONFIG.models.vad, silenceDurationMs: 9000 };
  const models = { ...DEFAULT_AGENT_CONFIG.models, vad };
  assert.ok(errorPaths(draft({ models })).includes("models.vad.silenceDurationMs"));
});

test("rejects an agent name that is not a slug", () => {
  assert.ok(errorPaths(draft({ agentName: "Not A Slug" })).includes("agentName"));
});

test("ignores client-supplied secretKeys", () => {
  const result = validateAgentConfig(draft({ secretKeys: ["STOLEN"] }));
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.config.secretKeys, []);
});

test("stamps the current version regardless of input", () => {
  const result = validateAgentConfig(draft({ version: 99 }));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.config.version, 1);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './defaults'`.

- [ ] **Step 4: Write the defaults**

Create `lib/agent-config/defaults.ts`. The instruction text is moved verbatim from `server/voice/agent-config.ts` — copy it from that file rather than retyping, so the Bangla wording is preserved exactly.

```ts
/**
 * Seed configuration.
 *
 * Used on first run, and whenever the stored config is missing or unreadable.
 * This is the persona the app shipped with; once a config is saved to disk,
 * the saved copy wins.
 */

import type { AgentConfig } from "./schema";
import { AGENT_CONFIG_VERSION } from "./schema";

export const DEFAULT_INSTRUCTIONS = `<<< paste the exact template-literal body of CALL_CENTER_SYSTEM_INSTRUCTION from server/voice/agent-config.ts here, unchanged >>>`;

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  version: AGENT_CONFIG_VERSION,
  type: "open_ended",
  instructions: DEFAULT_INSTRUCTIONS,
  welcome: {
    enabled: false,
    message: "",
    allowInterrupt: true,
  },
  models: {
    liveModel: "gemini-3.1-flash-live-preview",
    voice: "Kore",
    languageCode: "bn-IN",
    temperature: 0.7,
    topP: 0.9,
    vad: {
      startSensitivity: "high",
      endSensitivity: "high",
      silenceDurationMs: 400,
      prefixPaddingMs: 20,
    },
  },
  agentName: "customer-support",
  variables: [],
  secretKeys: [],
  updatedAt: "1970-01-01T00:00:00.000Z",
};
```

The welcome message defaults to **disabled** because the seed prompt already contains `- Open the call with a short Bangla greeting and ask how you can help.` Enabling both would give the model two competing greeting instructions.

- [ ] **Step 5: Write the schema**

Create `lib/agent-config/schema.ts`:

```ts
/**
 * The agent configuration contract.
 *
 * Shared by the browser and the gateway, and deliberately free of imports so
 * either side can use it. `validateAgentConfig` is the only validation
 * implementation: the form calls it for inline feedback, and the PUT handler
 * calls it again on the raw body. The server never trusts the client's copy.
 */

export const AGENT_CONFIG_VERSION = 1;

export type ConversationType = "open_ended" | "data_collection";
export type VariableType = "string" | "number" | "boolean";
export type VadSensitivity = "high" | "low";

export interface AgentVariable {
  /** Stable React key. Not user-visible and not part of the prompt. */
  id: string;
  type: VariableType;
  name: string;
  /** Always stored as a string; coerced by `type` when resolved. */
  previewValue: string;
}

export interface WelcomeConfig {
  enabled: boolean;
  message: string;
  allowInterrupt: boolean;
}

export interface VadConfig {
  startSensitivity: VadSensitivity;
  endSensitivity: VadSensitivity;
  silenceDurationMs: number;
  prefixPaddingMs: number;
}

export interface ModelsConfig {
  liveModel: string;
  voice: string;
  languageCode: string;
  temperature: number;
  topP: number;
  vad: VadConfig;
}

export interface AgentConfig {
  version: number;
  type: ConversationType;
  instructions: string;
  welcome: WelcomeConfig;
  models: ModelsConfig;
  agentName: string;
  variables: AgentVariable[];
  /** Names only. Values live in a separate gitignored file, server-side. */
  secretKeys: string[];
  updatedAt: string;
}

export interface FieldError {
  /** Dotted path, e.g. "variables.0.name". Empty string means the whole body. */
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; config: AgentConfig }
  | { ok: false; errors: FieldError[] };

export const LIMITS = {
  instructionsMax: 32_000,
  welcomeMax: 2_000,
  agentNameMax: 63,
  variableNameMax: 64,
  variablesMax: 50,
  secretKeyMax: 128,
  secretValueMax: 4_096,
  temperature: { min: 0, max: 2 },
  topP: { min: 0, max: 1 },
  silenceDurationMs: { min: 100, max: 2_000 },
  prefixPaddingMs: { min: 0, max: 500 },
} as const;

export const VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
export const SECRET_KEY_RE = /^[A-Z][A-Z0-9_]*$/;

const VARIABLE_TYPES: readonly VariableType[] = ["string", "number", "boolean"];
const SENSITIVITIES: readonly VadSensitivity[] = ["high", "low"];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(
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

function readBoolean(value: unknown, path: string, errors: FieldError[]): boolean {
  if (typeof value !== "boolean") {
    errors.push({ path, message: "Must be true or false." });
    return false;
  }
  return value;
}

function readNumber(
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

function readEnum<T extends string>(
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

function validateVariables(value: unknown, errors: FieldError[]): AgentVariable[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push({ path: "variables", message: "Must be a list." });
    return [];
  }
  if (value.length > LIMITS.variablesMax) {
    errors.push({ path: "variables", message: `At most ${LIMITS.variablesMax} variables.` });
  }

  const seen = new Set<string>();
  const variables: AgentVariable[] = [];

  value.forEach((raw, index) => {
    const record = asRecord(raw);
    if (!record) {
      errors.push({ path: `variables.${index}`, message: "Must be an object." });
      return;
    }

    const type = readEnum(record.type, `variables.${index}.type`, VARIABLE_TYPES, errors, "string");
    const name = readString(record.name, `variables.${index}.name`, errors, "");
    const previewValue = readString(
      record.previewValue,
      `variables.${index}.previewValue`,
      errors,
      "",
    );

    if (name.length > LIMITS.variableNameMax) {
      errors.push({
        path: `variables.${index}.name`,
        message: `At most ${LIMITS.variableNameMax} characters.`,
      });
    } else if (!VARIABLE_NAME_RE.test(name)) {
      errors.push({
        path: `variables.${index}.name`,
        message: "Letters, digits and underscores only, and cannot start with a digit.",
      });
    } else if (seen.has(name)) {
      errors.push({ path: `variables.${index}.name`, message: "Already used by another variable." });
    } else {
      seen.add(name);
    }

    if (type === "number" && !Number.isFinite(Number(previewValue))) {
      errors.push({ path: `variables.${index}.previewValue`, message: "Must be a number." });
    }
    if (type === "boolean" && previewValue !== "true" && previewValue !== "false") {
      errors.push({ path: `variables.${index}.previewValue`, message: "Must be true or false." });
    }

    const id = typeof record.id === "string" && record.id !== "" ? record.id : `var-${index}`;
    variables.push({ id, type, name, previewValue });
  });

  return variables;
}

function validateVad(value: unknown, errors: FieldError[]): VadConfig {
  const record = asRecord(value);
  if (!record) {
    errors.push({ path: "models.vad", message: "Must be an object." });
    return { startSensitivity: "high", endSensitivity: "high", silenceDurationMs: 400, prefixPaddingMs: 20 };
  }
  return {
    startSensitivity: readEnum(
      record.startSensitivity, "models.vad.startSensitivity", SENSITIVITIES, errors, "high",
    ),
    endSensitivity: readEnum(
      record.endSensitivity, "models.vad.endSensitivity", SENSITIVITIES, errors, "high",
    ),
    silenceDurationMs: readNumber(
      record.silenceDurationMs, "models.vad.silenceDurationMs", LIMITS.silenceDurationMs, errors, 400,
    ),
    prefixPaddingMs: readNumber(
      record.prefixPaddingMs, "models.vad.prefixPaddingMs", LIMITS.prefixPaddingMs, errors, 20,
    ),
  };
}

function validateModels(value: unknown, errors: FieldError[]): ModelsConfig {
  const record = asRecord(value) ?? {};
  if (asRecord(value) === null) {
    errors.push({ path: "models", message: "Must be an object." });
  }

  const liveModel = readString(record.liveModel, "models.liveModel", errors, "").trim();
  if (liveModel === "") errors.push({ path: "models.liveModel", message: "Required." });

  const voice = readString(record.voice, "models.voice", errors, "").trim();
  if (voice === "") errors.push({ path: "models.voice", message: "Required." });

  const languageCode = readString(record.languageCode, "models.languageCode", errors, "").trim();
  if (languageCode === "") errors.push({ path: "models.languageCode", message: "Required." });

  return {
    liveModel,
    voice,
    languageCode,
    temperature: readNumber(record.temperature, "models.temperature", LIMITS.temperature, errors, 0.7),
    topP: readNumber(record.topP, "models.topP", LIMITS.topP, errors, 0.9),
    vad: validateVad(record.vad, errors),
  };
}

function validateWelcome(value: unknown, errors: FieldError[]): WelcomeConfig {
  const record = asRecord(value) ?? {};
  if (asRecord(value) === null) {
    errors.push({ path: "welcome", message: "Must be an object." });
  }

  const enabled = readBoolean(record.enabled, "welcome.enabled", errors);
  const message = readString(record.message, "welcome.message", errors, "");
  const allowInterrupt = readBoolean(record.allowInterrupt, "welcome.allowInterrupt", errors);

  if (message.length > LIMITS.welcomeMax) {
    errors.push({ path: "welcome.message", message: `At most ${LIMITS.welcomeMax} characters.` });
  }
  if (enabled && message.trim() === "") {
    errors.push({ path: "welcome.message", message: "Required when the welcome message is on." });
  }

  return { enabled, message, allowInterrupt };
}

/**
 * Validates an untrusted config. Errors accumulate rather than short-circuit so
 * the form can highlight every bad field at once.
 *
 * `secretKeys` and `updatedAt` are always discarded — the server owns both.
 */
export function validateAgentConfig(input: unknown): ValidationResult {
  const record = asRecord(input);
  if (!record) {
    return { ok: false, errors: [{ path: "", message: "Expected a configuration object." }] };
  }

  const errors: FieldError[] = [];

  const type = readEnum<ConversationType>(
    record.type, "type", ["open_ended", "data_collection"], errors, "open_ended",
  );
  if (type === "data_collection") {
    errors.push({ path: "type", message: "Data collection is not supported yet." });
  }

  const instructions = readString(record.instructions, "instructions", errors, "");
  if (instructions.trim() === "") {
    errors.push({ path: "instructions", message: "Required." });
  } else if (instructions.length > LIMITS.instructionsMax) {
    errors.push({
      path: "instructions",
      message: `At most ${LIMITS.instructionsMax} characters.`,
    });
  }

  const agentName = readString(record.agentName, "agentName", errors, "").trim();
  if (!AGENT_NAME_RE.test(agentName)) {
    errors.push({
      path: "agentName",
      message: `Lowercase letters, digits and hyphens, 2 to ${LIMITS.agentNameMax} characters.`,
    });
  }

  const welcome = validateWelcome(record.welcome, errors);
  const models = validateModels(record.models, errors);
  const variables = validateVariables(record.variables, errors);

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    config: {
      version: AGENT_CONFIG_VERSION,
      type: "open_ended",
      instructions,
      welcome,
      models,
      agentName,
      variables,
      secretKeys: [],
      updatedAt: new Date().toISOString(),
    },
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 17 tests, 0 failures.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add package.json lib/agent-config/schema.ts lib/agent-config/defaults.ts lib/agent-config/schema.test.ts
git commit -m "feat: add agent config schema, defaults and test runner"
```

---

### Task 2: Variable interpolation

**Files:**
- Create: `lib/agent-config/template.ts`
- Test: `lib/agent-config/template.test.ts`

**Interfaces:**
- Consumes: `AgentVariable` from `lib/agent-config/schema`.
- Produces: `findTokens(text: string): string[]`, `coercePreviewValue(variable: AgentVariable): string`, `interpolate(text: string, variables: AgentVariable[]): string`, `findUnknownTokens(text: string, variables: AgentVariable[]): string[]`.

- [ ] **Step 1: Write the failing test**

Create `lib/agent-config/template.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import type { AgentVariable } from "./schema";
import { coercePreviewValue, findTokens, findUnknownTokens, interpolate } from "./template";

const company: AgentVariable = { id: "1", type: "string", name: "company", previewValue: "Selorax" };
const count: AgentVariable = { id: "2", type: "number", name: "count", previewValue: "3" };
const vip: AgentVariable = { id: "3", type: "boolean", name: "vip", previewValue: "true" };

test("finds tokens in order without duplicates", () => {
  assert.deepEqual(findTokens("{a} then {b} then {a}"), ["a", "b"]);
});

test("ignores tokens that are not identifiers", () => {
  assert.deepEqual(findTokens("{9bad} {with space} {ok_1}"), ["ok_1"]);
});

test("returns an empty list for text with no tokens", () => {
  assert.deepEqual(findTokens("plain text"), []);
});

test("substitutes a string variable", () => {
  assert.equal(interpolate("Agent for {company}.", [company]), "Agent for Selorax.");
});

test("substitutes every occurrence", () => {
  assert.equal(interpolate("{company} and {company}", [company]), "Selorax and Selorax");
});

test("coerces a number preview value", () => {
  assert.equal(coercePreviewValue(count), "3");
  assert.equal(interpolate("You have {count}.", [count]), "You have 3.");
});

test("coerces a boolean preview value", () => {
  assert.equal(coercePreviewValue(vip), "true");
  assert.equal(coercePreviewValue({ ...vip, previewValue: "no" }), "false");
});

test("leaves unknown tokens exactly as written", () => {
  assert.equal(interpolate("Hi {missing}.", [company]), "Hi {missing}.");
});

test("does not re-expand a value that contains a token", () => {
  const nested: AgentVariable = { id: "4", type: "string", name: "a", previewValue: "{b}" };
  const b: AgentVariable = { id: "5", type: "string", name: "b", previewValue: "deep" };
  assert.equal(interpolate("{a}", [nested, b]), "{b}");
});

test("reports unknown tokens", () => {
  assert.deepEqual(findUnknownTokens("{company} {missing} {other}", [company]), ["missing", "other"]);
});

test("reports no unknown tokens when all are declared", () => {
  assert.deepEqual(findUnknownTokens("{company}", [company]), []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './template'`.

- [ ] **Step 3: Write the implementation**

Create `lib/agent-config/template.ts`:

```ts
/**
 * `{variable}` substitution for the instructions and welcome message.
 *
 * Substitution is single-pass on purpose: a preview value that itself contains
 * a token is inserted literally rather than expanded again. That rules out both
 * recursion and the surprise of a value quietly rewriting itself.
 */

import type { AgentVariable } from "./schema";

/** Matches `{name}` where `name` is a JavaScript-style identifier. */
const TOKEN_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Every distinct token in `text`, in first-appearance order. */
export function findTokens(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(TOKEN_RE)) {
    seen.add(match[1]);
  }
  return [...seen];
}

/** The preview value as the string that will actually reach the prompt. */
export function coercePreviewValue(variable: AgentVariable): string {
  if (variable.type === "number") {
    const parsed = Number(variable.previewValue);
    return Number.isFinite(parsed) ? String(parsed) : "";
  }
  if (variable.type === "boolean") {
    return variable.previewValue === "true" ? "true" : "false";
  }
  return variable.previewValue;
}

/** Replaces declared tokens. Undeclared tokens are left exactly as written. */
export function interpolate(text: string, variables: AgentVariable[]): string {
  if (variables.length === 0) return text;

  const values = new Map<string, string>();
  for (const variable of variables) {
    values.set(variable.name, coercePreviewValue(variable));
  }

  return text.replace(TOKEN_RE, (whole, name: string) => values.get(name) ?? whole);
}

/** Tokens present in `text` that no variable declares. Drives the editor warning. */
export function findUnknownTokens(text: string, variables: AgentVariable[]): string[] {
  const declared = new Set(variables.map((variable) => variable.name));
  return findTokens(text).filter((token) => !declared.has(token));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 28 tests total, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add lib/agent-config/template.ts lib/agent-config/template.test.ts
git commit -m "feat: add {variable} interpolation for agent prompts"
```

---

### Task 3: Resolution and system-instruction assembly

The seam the gateway consumes. Keeping it pure means the greeting directive is testable without a Gemini session.

**Files:**
- Create: `lib/agent-config/resolve.ts`
- Test: `lib/agent-config/resolve.test.ts`

**Interfaces:**
- Consumes: `AgentConfig`, `ModelsConfig`, `WelcomeConfig` from `./schema`; `interpolate` from `./template`.
- Produces: `ResolvedAgentConfig`, `resolveAgentConfig(config: AgentConfig): ResolvedAgentConfig`, `buildSystemInstruction(resolved: ResolvedAgentConfig): string`.

- [ ] **Step 1: Write the failing test**

Create `lib/agent-config/resolve.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_AGENT_CONFIG } from "./defaults";
import { buildSystemInstruction, resolveAgentConfig } from "./resolve";
import type { AgentConfig } from "./schema";

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { ...DEFAULT_AGENT_CONFIG, ...overrides };
}

const company = { id: "1", type: "string" as const, name: "company", previewValue: "Selorax" };

test("interpolates the instructions", () => {
  const resolved = resolveAgentConfig(
    config({ instructions: "Agent for {company}.", variables: [company] }),
  );
  assert.equal(resolved.instructions, "Agent for Selorax.");
});

test("interpolates the welcome message", () => {
  const resolved = resolveAgentConfig(
    config({
      welcome: { enabled: true, message: "Thanks for calling {company}.", allowInterrupt: true },
      variables: [company],
    }),
  );
  assert.equal(resolved.welcome.message, "Thanks for calling Selorax.");
});

test("carries the models block through untouched", () => {
  const resolved = resolveAgentConfig(config());
  assert.deepEqual(resolved.models, DEFAULT_AGENT_CONFIG.models);
});

test("appends the greeting directive when the welcome is enabled", () => {
  const resolved = resolveAgentConfig(
    config({
      instructions: "Be brief.",
      welcome: { enabled: true, message: "Hi there.", allowInterrupt: true },
    }),
  );
  assert.equal(
    buildSystemInstruction(resolved),
    'Be brief.\n\nOpen the call by saying exactly: "Hi there."',
  );
});

test("omits the greeting directive when the welcome is disabled", () => {
  const resolved = resolveAgentConfig(
    config({
      instructions: "Be brief.",
      welcome: { enabled: false, message: "Hi there.", allowInterrupt: true },
    }),
  );
  assert.equal(buildSystemInstruction(resolved), "Be brief.");
});

test("omits the greeting directive when the message is blank", () => {
  const resolved = resolveAgentConfig(
    config({
      instructions: "Be brief.",
      welcome: { enabled: true, message: "   ", allowInterrupt: true },
    }),
  );
  assert.equal(buildSystemInstruction(resolved), "Be brief.");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './resolve'`.

- [ ] **Step 3: Write the implementation**

Create `lib/agent-config/resolve.ts`:

```ts
/**
 * Turns a stored config into the exact values a call will use.
 *
 * Resolution happens once, at the start of a call. An in-flight call keeps the
 * config it started with — a prompt must never change underneath a live
 * conversation.
 */

import type { AgentConfig, ModelsConfig, WelcomeConfig } from "./schema";
import { interpolate } from "./template";

export interface ResolvedAgentConfig {
  agentName: string;
  /** Instructions with every declared `{variable}` already substituted. */
  instructions: string;
  welcome: WelcomeConfig;
  models: ModelsConfig;
}

export function resolveAgentConfig(config: AgentConfig): ResolvedAgentConfig {
  return {
    agentName: config.agentName,
    instructions: interpolate(config.instructions, config.variables),
    welcome: {
      ...config.welcome,
      message: interpolate(config.welcome.message, config.variables),
    },
    models: config.models,
  };
}

/**
 * The system instruction actually sent to Gemini.
 *
 * Gemini Live has no "say this first" field, so an enabled welcome message
 * becomes a directive appended to the prompt. It is an instruction to a
 * language model, so expect near-verbatim delivery rather than byte-exact.
 */
export function buildSystemInstruction(resolved: ResolvedAgentConfig): string {
  const greeting = resolved.welcome.message.trim();
  if (!resolved.welcome.enabled || greeting === "") return resolved.instructions;
  return `${resolved.instructions}\n\nOpen the call by saying exactly: "${greeting}"`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 34 tests total, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add lib/agent-config/resolve.ts lib/agent-config/resolve.test.ts
git commit -m "feat: resolve agent config into call-ready values"
```

---

### Task 4: The config store

All filesystem access lives here. The factory takes a directory so tests can point it at a temp path.

**Files:**
- Create: `server/config/store.ts`
- Modify: `.gitignore`
- Test: `server/config/store.test.ts`

**Interfaces:**
- Consumes: `AgentConfig`, `AGENT_CONFIG_VERSION`, `SECRET_KEY_RE`, `LIMITS` from `@/lib/agent-config/schema`; `DEFAULT_AGENT_CONFIG` from `@/lib/agent-config/defaults`.
- Produces: `ConfigStore` interface with `read()`, `write(config)`, `listSecretKeys()`, `setSecret(key, value)`, `deleteSecret(key)`; `createConfigStore(dataDir: string, log?: StoreLogger): ConfigStore`; `configStore: ConfigStore` (the process-wide instance rooted at `<cwd>/data`).

- [ ] **Step 1: Ignore the secrets file**

Append to `.gitignore`:

```
# agent secrets (values, never committed)
/data/agent-secrets.json
```

`data/agent-config.json` is deliberately *not* ignored — it contains no secrets and is useful to inspect.

- [ ] **Step 2: Write the failing test**

Create `server/config/store.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DEFAULT_AGENT_CONFIG } from "../../lib/agent-config/defaults";
import { createConfigStore } from "./store";

async function freshDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "agent-config-"));
}

test("returns the defaults when no config file exists", async () => {
  const store = createConfigStore(await freshDir());
  const config = await store.read();
  assert.equal(config.instructions, DEFAULT_AGENT_CONFIG.instructions);
  assert.equal(config.agentName, DEFAULT_AGENT_CONFIG.agentName);
});

test("round-trips a written config", async () => {
  const store = createConfigStore(await freshDir());
  await store.write({ ...DEFAULT_AGENT_CONFIG, agentName: "sales-bot" });
  const config = await store.read();
  assert.equal(config.agentName, "sales-bot");
});

test("stamps updatedAt on write", async () => {
  const store = createConfigStore(await freshDir());
  const before = new Date().toISOString();
  const saved = await store.write({ ...DEFAULT_AGENT_CONFIG, updatedAt: "stale" });
  assert.ok(saved.updatedAt >= before);
});

test("falls back to the defaults when the file is corrupt", async () => {
  const dir = await freshDir();
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "agent-config.json"), "{ not json", "utf8");

  const warnings: string[] = [];
  const store = createConfigStore(dir, (message) => warnings.push(message));
  const config = await store.read();

  assert.equal(config.agentName, DEFAULT_AGENT_CONFIG.agentName);
  assert.equal(warnings.length, 1);
});

test("leaves a corrupt file on disk so it stays recoverable", async () => {
  const dir = await freshDir();
  await writeFile(path.join(dir, "agent-config.json"), "{ not json", "utf8");
  const store = createConfigStore(dir, () => {});
  await store.read();
  assert.equal(await readFile(path.join(dir, "agent-config.json"), "utf8"), "{ not json");
});

test("falls back to the defaults on an unknown version", async () => {
  const dir = await freshDir();
  const future = JSON.stringify({ ...DEFAULT_AGENT_CONFIG, version: 99 });
  await writeFile(path.join(dir, "agent-config.json"), future, "utf8");

  const warnings: string[] = [];
  const store = createConfigStore(dir, (message) => warnings.push(message));
  const config = await store.read();

  assert.equal(config.version, 1);
  assert.equal(warnings.length, 1);
});

test("lists no secret keys before any are set", async () => {
  const store = createConfigStore(await freshDir());
  assert.deepEqual(await store.listSecretKeys(), []);
});

test("stores, lists and deletes a secret", async () => {
  const store = createConfigStore(await freshDir());
  await store.setSecret("CRM_API_KEY", "abc123");
  await store.setSecret("OTHER_KEY", "xyz");
  assert.deepEqual((await store.listSecretKeys()).sort(), ["CRM_API_KEY", "OTHER_KEY"]);

  await store.deleteSecret("OTHER_KEY");
  assert.deepEqual(await store.listSecretKeys(), ["CRM_API_KEY"]);
});

test("replaces an existing secret rather than duplicating it", async () => {
  const store = createConfigStore(await freshDir());
  await store.setSecret("CRM_API_KEY", "first");
  await store.setSecret("CRM_API_KEY", "second");
  assert.deepEqual(await store.listSecretKeys(), ["CRM_API_KEY"]);
});

test("rejects a secret key that is not upper snake case", async () => {
  const store = createConfigStore(await freshDir());
  await assert.rejects(() => store.setSecret("lower-case", "x"), /key/i);
});

test("writes the secrets file with owner-only permissions", async () => {
  const dir = await freshDir();
  const store = createConfigStore(dir);
  await store.setSecret("CRM_API_KEY", "abc");
  const { stat } = await import("node:fs/promises");
  const mode = (await stat(path.join(dir, "agent-secrets.json"))).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("never leaks a secret value through the config read path", async () => {
  const dir = await freshDir();
  const store = createConfigStore(dir);
  await store.setSecret("CRM_API_KEY", "super-secret-value");
  const serialised = JSON.stringify(await store.read());
  assert.ok(!serialised.includes("super-secret-value"));
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './store'`.

- [ ] **Step 4: Write the implementation**

Create `server/config/store.ts`:

```ts
/**
 * Persistence for the agent configuration.
 *
 * Two processes read this: the Next route handlers and the voice gateway. A
 * file on disk is the meeting point, so neither needs to know the other exists.
 * Writes go through a temp file and a rename, which is atomic on the same
 * filesystem — a crash mid-write can never truncate a good config.
 *
 * Secret values live in their own file, mode 0600 and gitignored. They are
 * never returned by `read()`, and nothing outside this module reads them.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_AGENT_CONFIG } from "../../lib/agent-config/defaults";
import { AGENT_CONFIG_VERSION, LIMITS, SECRET_KEY_RE, type AgentConfig } from "../../lib/agent-config/schema";

export type StoreLogger = (message: string) => void;

export interface ConfigStore {
  /** The saved config, or the seed defaults if none is readable. Never throws. */
  read(): Promise<AgentConfig>;
  /** Persists a config, stamping `updatedAt`. Returns what was written. */
  write(config: AgentConfig): Promise<AgentConfig>;
  listSecretKeys(): Promise<string[]>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

export function createConfigStore(dataDir: string, log: StoreLogger = () => {}): ConfigStore {
  const configPath = path.join(dataDir, "agent-config.json");
  const secretsPath = path.join(dataDir, "agent-secrets.json");

  async function writeAtomic(target: string, contents: string, mode: number): Promise<void> {
    await mkdir(dataDir, { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, contents, { encoding: "utf8", mode });
      await rename(temp, target);
    } catch (cause) {
      await unlink(temp).catch(() => undefined);
      throw cause;
    }
  }

  async function readSecrets(): Promise<Record<string, string>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(secretsPath, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
      return parsed as Record<string, string>;
    } catch (error) {
      if (!isMissing(error)) log(`agent-secrets.json is unreadable: ${String(error)}`);
      return {};
    }
  }

  return {
    async read(): Promise<AgentConfig> {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(configPath, "utf8"));
      } catch (error) {
        // A missing file is the first-run path, not a failure.
        if (!isMissing(error)) {
          log(`agent-config.json is unreadable, using defaults: ${String(error)}`);
        }
        return { ...DEFAULT_AGENT_CONFIG };
      }

      const record = parsed as Partial<AgentConfig> | null;
      if (typeof record !== "object" || record === null) {
        log("agent-config.json is not an object, using defaults");
        return { ...DEFAULT_AGENT_CONFIG };
      }
      if (record.version !== AGENT_CONFIG_VERSION) {
        // Left on disk untouched so the user's data stays recoverable.
        log(`agent-config.json has unsupported version ${String(record.version)}, using defaults`);
        return { ...DEFAULT_AGENT_CONFIG };
      }

      return { ...DEFAULT_AGENT_CONFIG, ...record, secretKeys: [] };
    },

    async write(config: AgentConfig): Promise<AgentConfig> {
      const saved: AgentConfig = {
        ...config,
        version: AGENT_CONFIG_VERSION,
        secretKeys: [],
        updatedAt: new Date().toISOString(),
      };
      await writeAtomic(configPath, `${JSON.stringify(saved, null, 2)}\n`, 0o644);
      return saved;
    },

    async listSecretKeys(): Promise<string[]> {
      return Object.keys(await readSecrets()).sort();
    },

    async setSecret(key: string, value: string): Promise<void> {
      if (!SECRET_KEY_RE.test(key) || key.length > LIMITS.secretKeyMax) {
        throw new Error("Secret key must be UPPER_SNAKE_CASE.");
      }
      if (value.length > LIMITS.secretValueMax) {
        throw new Error(`Secret value must be at most ${LIMITS.secretValueMax} characters.`);
      }
      const secrets = await readSecrets();
      secrets[key] = value;
      await writeAtomic(secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, 0o600);
    },

    async deleteSecret(key: string): Promise<void> {
      const secrets = await readSecrets();
      if (!(key in secrets)) return;
      delete secrets[key];
      await writeAtomic(secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, 0o600);
    },
  };
}

/** The instance every caller in this process should use. */
export const configStore = createConfigStore(path.join(process.cwd(), "data"));
```

Note: `writeFile`'s `mode` applies only when creating a file, so `writeAtomic` always writes a *new* temp file and renames it — that is what keeps `0600` correct on every rewrite, not just the first.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 46 tests total, 0 failures.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add .gitignore server/config/store.ts server/config/store.test.ts
git commit -m "feat: add atomic agent config and secret store"
```

---

### Task 5: API routes

**Files:**
- Create: `app/api/agent-config/route.ts`
- Create: `app/api/agent-config/secrets/route.ts`

**Interfaces:**
- Consumes: `configStore` from `@/server/config/store`; `validateAgentConfig`, `SECRET_KEY_RE` from `@/lib/agent-config/schema`.
- Produces: HTTP contract used by Task 9's form —
  - `GET /api/agent-config` → `200 AgentConfig` (with `secretKeys` populated, values never included).
  - `PUT /api/agent-config` → `200 AgentConfig` | `400 { errors: FieldError[] }` | `500 { errors: FieldError[] }`.
  - `POST /api/agent-config/secrets` body `{ key: string, value: string }` → `200 { secretKeys: string[] }` | `400 { errors: FieldError[] }`.
  - `DELETE /api/agent-config/secrets?key=NAME` → `200 { secretKeys: string[] }` | `400 { errors: FieldError[] }`.

- [ ] **Step 1: Write the config route**

Create `app/api/agent-config/route.ts`:

```ts
/**
 * Read and write the agent configuration.
 *
 * `secretKeys` is server-owned on both sides of the contract: it is filled in
 * on the way out and discarded on the way in, so a client can neither read a
 * secret value nor invent a key by saving the config.
 *
 * Runs on the Node runtime because the store touches the filesystem.
 */

import { NextResponse } from "next/server";

import { validateAgentConfig } from "@/lib/agent-config/schema";
import { configStore } from "@/server/config/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const [config, secretKeys] = await Promise.all([
    configStore.read(),
    configStore.listSecretKeys(),
  ]);
  return NextResponse.json({ ...config, secretKeys });
}

export async function PUT(request: Request): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);

  const result = validateAgentConfig(body);
  if (!result.ok) {
    return NextResponse.json({ errors: result.errors }, { status: 400 });
  }

  try {
    const saved = await configStore.write(result.config);
    const secretKeys = await configStore.listSecretKeys();
    return NextResponse.json({ ...saved, secretKeys });
  } catch (cause) {
    console.error("[agent-config] write failed:", cause);
    return NextResponse.json(
      { errors: [{ path: "", message: "Could not save the configuration." }] },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 2: Write the secrets route**

Create `app/api/agent-config/secrets/route.ts`:

```ts
/**
 * Secrets are write-only over HTTP.
 *
 * There is no GET here and there never should be: the only responses are the
 * list of key NAMES. Values leave the server exclusively as environment
 * variables for the agent's own tool calls.
 */

import { NextResponse } from "next/server";

import { LIMITS, SECRET_KEY_RE } from "@/lib/agent-config/schema";
import { configStore } from "@/server/config/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function badRequest(path: string, message: string): NextResponse {
  return NextResponse.json({ errors: [{ path, message }] }, { status: 400 });
}

export async function POST(request: Request): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null) {
    return badRequest("", "Expected a JSON object.");
  }

  const { key, value } = body as { key?: unknown; value?: unknown };
  if (typeof key !== "string" || !SECRET_KEY_RE.test(key) || key.length > LIMITS.secretKeyMax) {
    return badRequest("key", "Use UPPER_SNAKE_CASE letters, digits and underscores.");
  }
  if (typeof value !== "string" || value === "") {
    return badRequest("value", "Required.");
  }
  if (value.length > LIMITS.secretValueMax) {
    return badRequest("value", `At most ${LIMITS.secretValueMax} characters.`);
  }

  try {
    await configStore.setSecret(key, value);
  } catch (cause) {
    console.error("[agent-config] secret write failed:", cause);
    return NextResponse.json(
      { errors: [{ path: "", message: "Could not save the secret." }] },
      { status: 500 },
    );
  }

  return NextResponse.json({ secretKeys: await configStore.listSecretKeys() });
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const key = new URL(request.url).searchParams.get("key");
  if (key === null || !SECRET_KEY_RE.test(key)) {
    return badRequest("key", "Unknown secret.");
  }

  await configStore.deleteSecret(key);
  return NextResponse.json({ secretKeys: await configStore.listSecretKeys() });
}
```

- [ ] **Step 3: Verify the routes by hand**

Start the web server only: `npm run dev:web`

```bash
curl -s localhost:3000/api/agent-config | head -c 400
```
Expected: JSON with `"version":1`, the Bangla `instructions`, and `"secretKeys":[]`.

```bash
curl -s -X PUT localhost:3000/api/agent-config \
  -H 'content-type: application/json' \
  -d '{"instructions":""}' | head -c 300
```
Expected: `400` with an `errors` array including `{"path":"instructions",...}`.

```bash
curl -s -X POST localhost:3000/api/agent-config/secrets \
  -H 'content-type: application/json' \
  -d '{"key":"CRM_API_KEY","value":"abc123"}'
curl -s localhost:3000/api/agent-config | grep -c 'abc123'
```
Expected: first returns `{"secretKeys":["CRM_API_KEY"]}`; second prints `0` — the value never appears.

```bash
curl -s -X DELETE 'localhost:3000/api/agent-config/secrets?key=CRM_API_KEY'
```
Expected: `{"secretKeys":[]}`.

- [ ] **Step 4: Typecheck, lint and commit**

```bash
npm run typecheck && npm run lint
git add app/api/agent-config
git commit -m "feat: add agent config and secrets API routes"
```

---

### Task 6: Drive the gateway from the stored config

**Files:**
- Modify: `server/voice/gemini-session.ts`
- Modify: `server/voice/websocket-server.ts`
- Modify: `app/api/upload/route.ts`
- Delete: `server/voice/agent-config.ts`

**Interfaces:**
- Consumes: `ResolvedAgentConfig`, `resolveAgentConfig`, `buildSystemInstruction` from `../../lib/agent-config/resolve`; `configStore` from `../config/store`.
- Produces: `GeminiVoiceSession.create(events: GeminiSessionEvents, config: ResolvedAgentConfig)`, `GeminiVoiceSession.primeGreeting(): void`, `loadResolvedAgentConfig(log): Promise<ResolvedAgentConfig>` exported from `server/voice/gemini-session.ts`.

- [ ] **Step 1: Take the config as a parameter in the session**

In `server/voice/gemini-session.ts`, replace the import of `./agent-config` and the constants it fed:

```ts
import path from "node:path";

import {
  buildSystemInstruction,
  resolveAgentConfig,
  type ResolvedAgentConfig,
} from "../../lib/agent-config/resolve";
import { createConfigStore, type StoreLogger } from "../config/store";
```

Delete the now-unused `import { AGENT_VOICE, LIVE_MODEL } from "../../lib/gemini/types";` line — both values come from the config.

Add above the class:

```ts
/**
 * Loads and resolves the config for one call. Never throws: a call must connect
 * even if the config file is missing or unreadable.
 *
 * Builds its own store rather than using the shared instance so store problems
 * reach the gateway's log with the call id attached, instead of vanishing.
 */
export async function loadResolvedAgentConfig(
  log: StoreLogger = () => {},
): Promise<ResolvedAgentConfig> {
  const store = createConfigStore(path.join(process.cwd(), "data"), log);
  return resolveAgentConfig(await store.read());
}

/**
 * Sent as the first turn when a welcome message is enabled, because Gemini Live
 * has no field for "speak first". The text never reaches the customer; it only
 * hands the model the turn.
 */
const GREETING_PRIMER = "The call has just connected. Deliver your opening greeting now.";
```

- [ ] **Step 2: Rewrite `create` to use the config**

Replace the `static async create` signature and its `config` block in `server/voice/gemini-session.ts`:

```ts
  static async create(
    events: GeminiSessionEvents,
    agent: ResolvedAgentConfig,
  ): Promise<GeminiVoiceSession> {
    const startedAt = Date.now();
    const ai = getClient();

    const session = await ai.live.connect({
      model: agent.models.liveModel,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: buildSystemInstruction(agent),
        temperature: agent.models.temperature,
        topP: agent.models.topP,
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: agent.models.voice } },
          // Pins TTS phonetics so the prompt's language rule is not fighting a
          // synthesiser that defaults to English.
          languageCode: agent.models.languageCode,
        },
        // Live transcripts for both sides of the call.
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        // Server-side VAD owns turn taking and interruption.
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            startOfSpeechSensitivity:
              agent.models.vad.startSensitivity === "high"
                ? StartSensitivity.START_SENSITIVITY_HIGH
                : StartSensitivity.START_SENSITIVITY_LOW,
            endOfSpeechSensitivity:
              agent.models.vad.endSensitivity === "high"
                ? EndSensitivity.END_SENSITIVITY_HIGH
                : EndSensitivity.END_SENSITIVITY_LOW,
            prefixPaddingMs: agent.models.vad.prefixPaddingMs,
            silenceDurationMs: agent.models.vad.silenceDurationMs,
          },
        },
        // Lets a call run past the raw context limit instead of being dropped.
        contextWindowCompression: { slidingWindow: {} },
      },
      callbacks: {
        onmessage: (message: LiveServerMessage) => handleMessage(message, events),
        onerror: (event: ErrorEvent) => {
          events.onError(event?.message || "Gemini Live reported an error.");
        },
        onclose: (event: CloseEvent) => {
          events.onClose(event?.reason || "Gemini Live session closed.");
        },
      },
    });

    return new GeminiVoiceSession(session, Date.now() - startedAt);
  }
```

- [ ] **Step 3: Add the greeting primer method**

Add to `GeminiVoiceSession`, next to `sendText`:

```ts
  /** Hands the model the first turn so it speaks the configured greeting. */
  primeGreeting(): void {
    if (this.closed) return;
    this.session.sendClientContent({
      turns: [{ role: "user", parts: [{ text: GREETING_PRIMER }] }],
      turnComplete: true,
    });
  }
```

- [ ] **Step 4: Load the config per call in the gateway**

In `server/voice/websocket-server.ts`, extend `CallState` with the greeting gate:

```ts
interface CallState {
  readonly id: string;
  gemini: GeminiVoiceSession | null;
  readonly vad: EnergyVad;
  audioSeq: number;
  assistantSpeaking: boolean;
  alive: boolean;
  /** Rolling byte budget for the current second. */
  windowStartedAt: number;
  windowBytes: number;
  closed: boolean;
  /** True from the greeting primer until that turn completes. */
  greetingActive: boolean;
  /** Mirrors the config so the audio path does not re-read it per frame. */
  allowGreetingInterrupt: boolean;
  greetingGuard: ReturnType<typeof setTimeout> | null;
}
```

Add the constant next to `HEARTBEAT_MS`:

```ts
/** Belt and braces: a malformed turn must never leave the agent permanently deaf. */
const GREETING_GUARD_MS = 30_000;
```

Initialise the three new fields in `handleConnection`'s `state` literal:

```ts
    greetingActive: false,
    allowGreetingInterrupt: true,
    greetingGuard: null,
```

Replace the `LIVE_MODEL` / `AGENT_VOICE` import with the config loader:

```ts
import { GeminiVoiceSession, loadResolvedAgentConfig } from "./gemini-session";
```

- [ ] **Step 5: Wire the greeting into the connection flow**

In `handleConnection`, immediately before the `try` that creates the Gemini session:

```ts
  const agent = await loadResolvedAgentConfig((message) => log(message, { id: state.id }));
  state.allowGreetingInterrupt = agent.welcome.allowInterrupt;

  const endGreeting = () => {
    if (!state.greetingActive) return;
    state.greetingActive = false;
    if (state.greetingGuard) {
      clearTimeout(state.greetingGuard);
      state.greetingGuard = null;
    }
  };
```

In the `onTurnComplete` callback passed to `GeminiVoiceSession.create`, call `endGreeting()` as its first statement. In the `onInterrupted` callback, call `endGreeting()` too — if the model was interrupted the greeting is over either way.

Pass the config as the second argument:

```ts
    state.gemini = await GeminiVoiceSession.create({ /* …existing events… */ }, agent);
```

After the existing `send({ type: "session_started", … })` call, start the greeting. Capture the session into a local first — `state.gemini` is typed `GeminiVoiceSession | null`, and reading it through the mutable state object defeats narrowing:

```ts
  const gemini = state.gemini;
  if (gemini && agent.welcome.enabled && agent.welcome.message.trim() !== "") {
    state.greetingActive = true;
    state.greetingGuard = setTimeout(endGreeting, GREETING_GUARD_MS);
    gemini.primeGreeting();
  }
```

Change `session_started` to report the config's values:

```ts
    model: agent.models.liveModel,
    voice: agent.models.voice,
```

In `closeCall`, clear the timer so a hung greeting cannot keep the process alive:

```ts
  if (state.greetingGuard) {
    clearTimeout(state.greetingGuard);
    state.greetingGuard = null;
  }
```

- [ ] **Step 6: Gate barge-in during an uninterruptible greeting**

In `handleClientFrame`, inside `case "audio":` after the rate-limit check and *before* `gemini.sendAudio(...)`:

```ts
      // While an uninterruptible greeting plays, local VAD still drives the UI
      // meters but nothing goes upstream — so server-side VAD never sees a
      // barge-in and the greeting finishes.
      if (state.greetingActive && !state.allowGreetingInterrupt) {
        updateVad(message.data, state, send);
        return;
      }
```

- [ ] **Step 7: Move the upload route onto the store**

In `app/api/upload/route.ts`, replace the `@/server/voice/agent-config` import with:

```ts
import { resolveAgentConfig } from "@/lib/agent-config/resolve";
import { configStore } from "@/server/config/store";
```

Inside `POST`, before the first Gemini call, load the config once:

```ts
  const agent = resolveAgentConfig(await configStore.read());
```

Replace `CALL_CENTER_SYSTEM_INSTRUCTION` with `agent.instructions`, `AGENT_LANGUAGE_CODE` with `agent.models.languageCode`, and the two uses of `AGENT_VOICE` in the `speechConfig` with `agent.models.voice`. Remove `AGENT_VOICE` from the `@/lib/gemini/types` import if nothing else in the file uses it.

- [ ] **Step 8: Delete the superseded module**

```bash
git rm server/voice/agent-config.ts
```

Confirm nothing still references it:

```bash
grep -rn "agent-config\"" --include=*.ts --include=*.tsx . | grep -v node_modules | grep -v "lib/agent-config"
```
Expected: no output.

- [ ] **Step 9: Verify end to end**

```bash
npm test && npm run typecheck && npm run lint
```
Expected: all pass.

```bash
npm run dev
```

Then: open the console, start a call, speak, and confirm the agent still answers in Bangla. Stop the gateway. Write a welcome message directly to disk to exercise the greeting before the UI exists:

```bash
curl -s localhost:3000/api/agent-config > /tmp/cfg.json
node -e 'const c=require("/tmp/cfg.json");c.welcome={enabled:true,message:"Test greeting, how may I help?",allowInterrupt:false};require("fs").writeFileSync("/tmp/cfg2.json",JSON.stringify(c))'
curl -s -X PUT localhost:3000/api/agent-config -H 'content-type: application/json' --data-binary @/tmp/cfg2.json > /dev/null
```

Restart the gateway, start a call, and confirm: the agent speaks first; talking over it does not cut it off; after it finishes, normal barge-in works again. Then set `allowInterrupt` to `true` and confirm talking over the greeting *does* cut it off.

- [ ] **Step 10: Commit**

```bash
git add -A server/voice app/api/upload/route.ts
git commit -m "feat: drive live and upload sessions from the stored agent config"
```

---

### Task 7: Remove the dark theme

Done before any new UI is written, so every component in Tasks 8–13 is built and eyeballed on the real background.

**Files:**
- Modify: `app/globals.css:1-76`
- Modify: `app/layout.tsx:21-45`
- Modify: `components/voice/VoiceAgent.tsx`
- Modify: `components/voice/VoiceOrb.tsx:14-23,124-130`
- Modify: `components/voice/VoiceWaveform.tsx:99-107`
- Delete: `components/ThemeToggle.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: a single light `:root` token set. Every token name is unchanged, so no component's `var(--…)` reference needs editing.

- [ ] **Step 1: Collapse the token blocks**

In `app/globals.css`, replace everything from `:root,` on line 8 through the closing brace of the `:root[data-theme="light"]` block on line 69 with a single block. The values are the existing light ones, verbatim:

```css
/* --------------------------------------------------------------------------
   Theme tokens. The console is light-only.
   -------------------------------------------------------------------------- */

:root {
  color-scheme: light;

  --bg: #f4f5fa;
  --bg-tint-a: rgba(124, 92, 255, 0.14);
  --bg-tint-b: rgba(34, 211, 238, 0.12);

  --surface: #ffffff;
  --surface-2: rgba(12, 14, 40, 0.035);
  --surface-3: rgba(12, 14, 40, 0.06);
  --surface-4: #ffffff;

  --border: rgba(12, 14, 40, 0.1);
  --border-strong: rgba(12, 14, 40, 0.22);

  --text: #101223;
  --text-muted: #5a5e78;
  --text-dim: #8a8ea8;

  --accent: #6d45ff;
  --accent-2: #0891b2;
  --accent-contrast: #ffffff;
  --accent-glow: rgba(109, 69, 255, 0.4);
  --accent-soft: rgba(109, 69, 255, 0.1);

  --success: #059669;
  --warning: #d97706;
  --danger: #e11d48;
  --ring: rgba(109, 69, 255, 0.5);
}
```

Leave the `@theme inline` block and everything below it untouched.

- [ ] **Step 2: Drop the theme bootstrap**

Replace `app/layout.tsx` lines 21–45 with:

```tsx
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
```

That removes `THEME_BOOTSTRAP`, the `<head>` with its inline script, `data-theme="dark"`, and `suppressHydrationWarning` — the last of which only existed because the script mutated `<html>` before hydration.

- [ ] **Step 3: Delete the toggle and its use**

```bash
git rm components/ThemeToggle.tsx
```

In `components/voice/VoiceAgent.tsx`, remove the `import { ThemeToggle } from "@/components/ThemeToggle";` line and the `<ThemeToggle />` element in the header.

- [ ] **Step 4: Retune the orb for a light ground**

In `components/voice/VoiceOrb.tsx`, replace the `idle` entry of `PALETTE` — the current `#4b4b63 → #2a2a3a` reads as a dark blob on `#f4f5fa`:

```ts
  idle: { from: "#c2c5d8", to: "#9296b1", glow: "rgba(124,92,255,0.14)" },
```

In the core sphere's inline `style`, replace the two near-black values, which were tuned to blend into `#06060a`:

```tsx
        style={{
          background: `radial-gradient(circle at 32% 28%, ${palette.from}, ${palette.to} 68%, rgba(30,32,60,0.35))`,
          boxShadow: `0 0 60px -10px ${palette.glow}, inset 0 -14px 30px -12px rgba(30,32,60,0.45)`,
        }}
```

And strengthen the specular highlight, which is invisible against light fills:

```tsx
        <div className="absolute left-[22%] top-[16%] size-8 rounded-full bg-white/55 blur-lg" />
```

- [ ] **Step 5: Retune the waveform's idle bars**

In `components/voice/VoiceWaveform.tsx`, the two `rgba(140,140,170, …)` fills are far too faint on a light ground. Replace them:

```ts
        if (idle) {
          context.fillStyle = `rgba(90,94,120,${0.3 * age})`;
        } else if (source[i] === 2) {
          context.fillStyle = `rgba(8,145,178,${0.35 + amplitude * 0.65 * age})`;
        } else if (source[i] === 1) {
          context.fillStyle = `rgba(109,69,255,${0.35 + amplitude * 0.65 * age})`;
        } else {
          context.fillStyle = `rgba(90,94,120,${0.34 * age})`;
        }
```

The active colours now match the light `--accent` (`#6d45ff`) and `--accent-2` (`#0891b2`) rather than the dark theme's brighter pair.

- [ ] **Step 6: Sweep for remaining dark assumptions**

```bash
grep -rn "data-theme\|voice-agent-theme\|#06060a\|#0a0a11\|dark:" --include=*.ts --include=*.tsx --include=*.css . | grep -v node_modules
```
Expected: no output. Anything that turns up is a leftover — fix it before committing.

- [ ] **Step 7: Look at it**

```bash
npm run dev
```

Open `http://localhost:3000`. Check every state: idle, connecting, listening, speaking, error. Confirm text contrast, the orb reading as an object rather than a smudge, visible waveform bars at rest, and no flash of dark on load.

- [ ] **Step 8: Verify and commit**

```bash
npm run typecheck && npm run lint
git add -A app/globals.css app/layout.tsx components/
git commit -m "refactor: make the console light-theme only"
```

---

### Task 8: Form primitives

Native elements styled with the existing tokens. No new dependencies, and the same `cva`/`cn` idiom as `components/ui/button.tsx`.

**Files:**
- Create: `components/ui/field.tsx`
- Create: `components/ui/input.tsx`
- Create: `components/ui/textarea.tsx`
- Create: `components/ui/select.tsx`
- Create: `components/ui/switch.tsx`
- Create: `components/ui/checkbox.tsx`
- Create: `components/ui/dropdown.tsx`

**Interfaces:**
- Consumes: `cn` from `@/lib/utils`.
- Produces: `Field({ label, description, error, htmlFor, children })`, `Input`, `Textarea`, `Select`, `Switch({ checked, onCheckedChange, label })`, `Checkbox`, `Dropdown({ trigger, children, align })`.

- [ ] **Step 1: Create the shared control styles and Field**

Create `components/ui/field.tsx`:

```tsx
"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/** Shared shell for every text-like control, so they stay visually identical. */
export const controlClass =
  "w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] " +
  "placeholder:text-[var(--text-dim)] outline-none transition-colors " +
  "hover:border-[var(--border-strong)] focus-visible:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--ring)] " +
  "disabled:cursor-not-allowed disabled:opacity-50";

interface FieldProps {
  label: string;
  description?: React.ReactNode;
  error?: string;
  htmlFor?: string;
  /** Rendered on the label row, flush right — a toggle or an action. */
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function Field({
  label,
  description,
  error,
  htmlFor,
  action,
  children,
  className,
}: FieldProps) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={htmlFor} className="text-sm font-medium text-[var(--text)]">
          {label}
        </label>
        {action}
      </div>
      {description && (
        <p className="text-xs leading-relaxed text-[var(--text-muted)]">{description}</p>
      )}
      {children}
      {error && (
        <p role="alert" className="text-xs font-medium text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create Input, Textarea and Select**

Create `components/ui/input.tsx`:

```tsx
"use client";

import * as React from "react";

import { controlClass } from "@/components/ui/field";
import { cn } from "@/lib/utils";

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return <input className={cn(controlClass, "h-10", className)} {...props} />;
}
```

Create `components/ui/textarea.tsx`:

```tsx
"use client";

import * as React from "react";

import { controlClass } from "@/components/ui/field";
import { cn } from "@/lib/utils";

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(controlClass, "scroll-slim resize-y leading-relaxed", className)}
      {...props}
    />
  );
}
```

Create `components/ui/select.tsx`:

```tsx
"use client";

import * as React from "react";

import { controlClass } from "@/components/ui/field";
import { cn } from "@/lib/utils";

/**
 * A native select. It gets the platform's own keyboard handling, mobile picker
 * and accessibility for free, which is worth more here than a custom listbox.
 */
export function Select({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <select className={cn(controlClass, "h-10 cursor-pointer pr-8", className)} {...props}>
      {children}
    </select>
  );
}
```

- [ ] **Step 3: Create Switch and Checkbox**

Create `components/ui/switch.tsx`:

```tsx
"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Accessible name, since the visual label sits outside this control. */
  label: string;
  disabled?: boolean;
  className?: string;
}

export function Switch({ checked, onCheckedChange, label, disabled, className }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors outline-none",
        "focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-50",
        checked
          ? "border-[var(--accent)] bg-[var(--accent)]"
          : "border-[var(--border-strong)] bg-[var(--surface-3)]",
        className,
      )}
    >
      <span
        className={cn(
          "size-4 rounded-full bg-white shadow-sm transition-transform",
          checked ? "translate-x-6" : "translate-x-1",
        )}
      />
    </button>
  );
}
```

Create `components/ui/checkbox.tsx`:

```tsx
"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

export function Checkbox({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type="checkbox"
      className={cn(
        "size-4 cursor-pointer rounded border-[var(--border-strong)] accent-[var(--accent)]",
        "outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
        className,
      )}
      {...props}
    />
  );
}
```

- [ ] **Step 4: Create the dropdown**

Create `components/ui/dropdown.tsx`:

```tsx
"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

interface DropdownProps {
  /** Receives the open state so the trigger can reflect it. */
  trigger: (props: { open: boolean; toggle: () => void }) => React.ReactNode;
  children: (props: { close: () => void }) => React.ReactNode;
  align?: "left" | "right";
  className?: string;
}

/**
 * A minimal popover: click outside or press Escape to dismiss. Small enough
 * not to be worth a dependency, and the only floating UI this feature needs.
 */
export function Dropdown({ trigger, children, align = "right", className }: DropdownProps) {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      {trigger({ open, toggle: () => setOpen((value) => !value) })}
      {open && (
        <div
          className={cn(
            "absolute z-20 mt-1 min-w-52 overflow-hidden rounded-xl border border-[var(--border)]",
            "bg-[var(--surface)] p-1 shadow-lg shadow-black/5",
            align === "right" ? "right-0" : "left-0",
            className,
          )}
        >
          {children({ close: () => setOpen(false) })}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Verify and commit**

```bash
npm run typecheck && npm run lint
git add components/ui
git commit -m "feat: add form primitives for the agent config editor"
```

---

### Task 9: Config page and form shell

**Files:**
- Create: `app/configure/page.tsx`
- Create: `components/agent-config/AgentConfigForm.tsx`
- Create: `components/agent-config/ActionsTab.tsx`

**Interfaces:**
- Consumes: `configStore` from `@/server/config/store`; `AgentConfig`, `FieldError` from `@/lib/agent-config/schema`; `Tabs*` from `@/components/ui/tabs`; `Button`.
- Produces: `TabId = "conversation" | "models" | "actions" | "advanced"`; `tabForPath(path: string): TabId`; and the props contract every tab implements —
  `interface TabProps { config: AgentConfig; update: (patch: Partial<AgentConfig>) => void; errors: Map<string, string> }`.
  Exported from `AgentConfigForm.tsx` so Tasks 10–12 import them.

- [ ] **Step 1: Create the page**

Create `app/configure/page.tsx`:

```tsx
/**
 * Agent configuration editor.
 *
 * The config is read on the server so the form is populated on first paint —
 * no loading spinner, no flash of defaults over a saved config.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { AgentConfigForm } from "@/components/agent-config/AgentConfigForm";
import { configStore } from "@/server/config/store";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Agent configuration — AI Voice Agent",
};

export default async function ConfigurePage() {
  const [config, secretKeys] = await Promise.all([
    configStore.read(),
    configStore.listSecretKeys(),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-5 pb-16">
      <header className="flex items-center justify-between py-6">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
        >
          <ArrowLeft className="size-4" />
          Back to console
        </Link>
      </header>

      <h1 className="text-2xl font-semibold tracking-tight text-[var(--text)]">
        Agent configuration
      </h1>
      <p className="mt-1 text-sm text-[var(--text-muted)]">
        Changes take effect on the next call. A call already in progress keeps the settings it
        started with.
      </p>

      <AgentConfigForm initialConfig={{ ...config, secretKeys }} />
    </div>
  );
}
```

- [ ] **Step 2: Create the Actions placeholder**

Create `components/agent-config/ActionsTab.tsx`:

```tsx
"use client";

import { Globe, MonitorSmartphone, Webhook } from "lucide-react";

const PLANNED = [
  {
    icon: Globe,
    title: "HTTP tools",
    body: "Let the agent call your APIs mid-conversation, authenticated with the secrets defined in Advanced.",
  },
  {
    icon: MonitorSmartphone,
    title: "Client tools",
    body: "Expose functions that run in the caller's browser, for actions the server cannot take.",
  },
  {
    icon: Webhook,
    title: "Webhooks",
    body: "Post call events — started, ended, transcript ready — to an endpoint you control.",
  },
];

export function ActionsTab() {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-[var(--text-muted)]">
        Actions let the agent do things beyond talking. None are configured yet.
      </p>
      {PLANNED.map(({ icon: Icon, title, body }) => (
        <div
          key={title}
          className="flex gap-3 rounded-2xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)] p-5"
        >
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--surface-3)] text-[var(--text-muted)]">
            <Icon className="size-4" />
          </span>
          <div>
            <p className="text-sm font-medium text-[var(--text)]">{title}</p>
            <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">{body}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Create the form shell**

Create `components/agent-config/AgentConfigForm.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Loader2, MessageSquare, Settings2, Sparkles, Zap } from "lucide-react";

import { ActionsTab } from "@/components/agent-config/ActionsTab";
import { AdvancedTab } from "@/components/agent-config/AdvancedTab";
import { ConversationTab } from "@/components/agent-config/ConversationTab";
import { ModelsVoiceTab } from "@/components/agent-config/ModelsVoiceTab";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { AgentConfig, FieldError } from "@/lib/agent-config/schema";

export type TabId = "conversation" | "models" | "actions" | "advanced";

/** Props every tab receives. Kept in one place so the tabs stay interchangeable. */
export interface TabProps {
  config: AgentConfig;
  update: (patch: Partial<AgentConfig>) => void;
  /** Keyed by the dotted path from the server, e.g. "variables.0.name". */
  errors: Map<string, string>;
}

/** Routes a server error to the tab that owns the field, so it can be revealed. */
export function tabForPath(path: string): TabId {
  if (path.startsWith("models")) return "models";
  if (path.startsWith("agentName") || path.startsWith("variables")) return "advanced";
  return "conversation";
}

type SaveState = "idle" | "saving" | "saved";

export function AgentConfigForm({ initialConfig }: { initialConfig: AgentConfig }) {
  const [saved, setSaved] = useState<AgentConfig>(initialConfig);
  const [config, setConfig] = useState<AgentConfig>(initialConfig);
  const [tab, setTab] = useState<TabId>("conversation");
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [formError, setFormError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  // `updatedAt` and `secretKeys` are server-owned, so they must not count as
  // edits — otherwise the bar would appear the moment a secret is added.
  const dirty = useMemo(() => {
    const strip = ({ updatedAt: _u, secretKeys: _s, ...rest }: AgentConfig) => rest;
    return JSON.stringify(strip(config)) !== JSON.stringify(strip(saved));
  }, [config, saved]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const update = useCallback((patch: Partial<AgentConfig>) => {
    setSaveState("idle");
    setConfig((current) => ({ ...current, ...patch }));
  }, []);

  const discard = useCallback(() => {
    setConfig(saved);
    setErrors(new Map());
    setFormError(null);
    setSaveState("idle");
  }, [saved]);

  const save = useCallback(async () => {
    setSaveState("saving");
    setErrors(new Map());
    setFormError(null);

    let response: Response;
    try {
      response = await fetch("/api/agent-config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(config),
      });
    } catch {
      setSaveState("idle");
      setFormError("Could not reach the server. Check that it is running and try again.");
      return;
    }

    if (!response.ok) {
      const body: { errors?: FieldError[] } = await response.json().catch(() => ({}));
      const list = body.errors ?? [{ path: "", message: "Could not save the configuration." }];
      setErrors(new Map(list.map((error) => [error.path, error.message])));
      setFormError(list.find((error) => error.path === "")?.message ?? "Some fields need fixing.");
      const firstField = list.find((error) => error.path !== "");
      if (firstField) setTab(tabForPath(firstField.path));
      setSaveState("idle");
      return;
    }

    const next: AgentConfig = await response.json();
    setSaved(next);
    setConfig(next);
    setSaveState("saved");
  }, [config]);

  const tabProps: TabProps = { config, update, errors };

  return (
    <div className="mt-8 flex flex-col">
      <Tabs value={tab} onValueChange={(value) => setTab(value as TabId)}>
        <TabsList>
          <TabsTrigger value="conversation">
            <MessageSquare className="size-3.5" />
            Conversation
          </TabsTrigger>
          <TabsTrigger value="models">
            <Sparkles className="size-3.5" />
            Models &amp; Voice
          </TabsTrigger>
          <TabsTrigger value="actions">
            <Zap className="size-3.5" />
            Actions
          </TabsTrigger>
          <TabsTrigger value="advanced">
            <Settings2 className="size-3.5" />
            Advanced
          </TabsTrigger>
        </TabsList>

        <TabsContent value="conversation" className="mt-7">
          <ConversationTab {...tabProps} />
        </TabsContent>
        <TabsContent value="models" className="mt-7">
          <ModelsVoiceTab {...tabProps} />
        </TabsContent>
        <TabsContent value="actions" className="mt-7">
          <ActionsTab />
        </TabsContent>
        <TabsContent value="advanced" className="mt-7">
          <AdvancedTab {...tabProps} />
        </TabsContent>
      </Tabs>

      {formError && (
        <p
          role="alert"
          className="animate-fade-rise mt-6 flex items-start gap-2.5 rounded-2xl border border-[var(--danger)]/35 bg-[var(--danger)]/10 px-5 py-4 text-sm text-[var(--danger)]"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{formError}</span>
        </p>
      )}

      {/* Saving is always explicit: a half-typed prompt must not become the
          live persona. */}
      <div className="sticky bottom-0 mt-8 flex items-center justify-end gap-3 border-t border-[var(--border)] bg-[var(--bg)]/85 py-4 backdrop-blur">
        {saveState === "saved" && !dirty && (
          <span className="mr-auto inline-flex items-center gap-1.5 text-sm text-[var(--success)]">
            <Check className="size-4" />
            Saved
          </span>
        )}
        {dirty && (
          <span className="mr-auto text-sm text-[var(--text-muted)]">Unsaved changes</span>
        )}
        <Button variant="ghost" onClick={discard} disabled={!dirty || saveState === "saving"}>
          Discard
        </Button>
        <Button
          variant="primary"
          onClick={() => void save()}
          disabled={!dirty || saveState === "saving"}
        >
          {saveState === "saving" && <Loader2 className="animate-spin" />}
          Save changes
        </Button>
      </div>
    </div>
  );
}
```

This will not compile until Tasks 10–12 create the three remaining tabs. That is expected; the next task closes it.

- [ ] **Step 4: Commit**

```bash
git add app/configure components/agent-config
git commit -m "feat: add agent config page shell and Actions placeholder"
```

---

### Task 10: Conversation tab

**Files:**
- Create: `components/agent-config/ConversationTab.tsx`
- Create: `components/agent-config/VariableInsertMenu.tsx`
- Create: `components/agent-config/PromptPreview.tsx`

**Interfaces:**
- Consumes: `TabProps` from `@/components/agent-config/AgentConfigForm`; `interpolate`, `findUnknownTokens` from `@/lib/agent-config/template`; `Field`, `Textarea`, `Switch`, `Checkbox`, `Dropdown`.
- Produces: `ConversationTab(props: TabProps)`, `VariableInsertMenu({ variables, onInsert })`, `PromptPreview({ text, variables, label })`.

- [ ] **Step 1: Create the insert menu**

Create `components/agent-config/VariableInsertMenu.tsx`:

```tsx
"use client";

import { Plus } from "lucide-react";

import { Dropdown } from "@/components/ui/dropdown";
import type { AgentVariable } from "@/lib/agent-config/schema";

interface VariableInsertMenuProps {
  variables: AgentVariable[];
  onInsert: (name: string) => void;
}

export function VariableInsertMenu({ variables, onInsert }: VariableInsertMenuProps) {
  return (
    <Dropdown
      trigger={({ toggle }) => (
        <button
          type="button"
          onClick={toggle}
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text)] focus-visible:ring-2 focus-visible:ring-[var(--ring)] outline-none"
        >
          <Plus className="size-3.5" />
          Insert variable
        </button>
      )}
    >
      {({ close }) =>
        variables.length === 0 ? (
          <p className="px-3 py-2.5 text-xs leading-relaxed text-[var(--text-muted)]">
            No variables yet. Add one under <span className="text-[var(--text)]">Advanced</span> to
            use it here.
          </p>
        ) : (
          <ul>
            {variables.map((variable) => (
              <li key={variable.id}>
                <button
                  type="button"
                  onClick={() => {
                    onInsert(variable.name);
                    close();
                  }}
                  className="flex w-full items-baseline justify-between gap-4 rounded-lg px-3 py-2 text-left text-sm text-[var(--text)] transition-colors hover:bg-[var(--surface-3)]"
                >
                  <span className="font-mono text-xs">{`{${variable.name}}`}</span>
                  <span className="truncate text-xs text-[var(--text-dim)]">
                    {variable.previewValue || "—"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      }
    </Dropdown>
  );
}
```

- [ ] **Step 2: Create the preview**

Create `components/agent-config/PromptPreview.tsx`:

```tsx
"use client";

import { useState } from "react";
import { AlertTriangle, ChevronRight } from "lucide-react";

import type { AgentVariable } from "@/lib/agent-config/schema";
import { findUnknownTokens, interpolate } from "@/lib/agent-config/template";
import { cn } from "@/lib/utils";

interface PromptPreviewProps {
  text: string;
  variables: AgentVariable[];
}

/**
 * Shows exactly what the model will receive. Unknown tokens are a warning, not
 * an error — a prompt may legitimately contain braces.
 */
export function PromptPreview({ text, variables }: PromptPreviewProps) {
  const [open, setOpen] = useState(false);
  const unknown = findUnknownTokens(text, variables);

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="inline-flex w-fit items-center gap-1 text-xs font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
      >
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        Preview with variable values
      </button>

      {unknown.length > 0 && (
        <p className="flex items-start gap-2 text-xs text-[var(--warning)]">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            No variable is defined for {unknown.map((name) => `{${name}}`).join(", ")}. It will be
            sent to the model exactly as written.
          </span>
        </p>
      )}

      {open && (
        <pre className="scroll-slim max-h-72 overflow-auto whitespace-pre-wrap rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4 font-mono text-xs leading-relaxed text-[var(--text-muted)]">
          {interpolate(text, variables) || "Nothing to preview yet."}
        </pre>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create the Conversation tab**

Create `components/agent-config/ConversationTab.tsx`:

```tsx
"use client";

import { useRef } from "react";
import { ClipboardList, MessagesSquare } from "lucide-react";

import type { TabProps } from "@/components/agent-config/AgentConfigForm";
import { PromptPreview } from "@/components/agent-config/PromptPreview";
import { VariableInsertMenu } from "@/components/agent-config/VariableInsertMenu";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** Inserts `{name}` at the caret and restores focus, so typing can continue. */
function insertAtCaret(
  element: HTMLTextAreaElement | null,
  current: string,
  name: string,
  commit: (next: string) => void,
): void {
  const token = `{${name}}`;
  if (!element) {
    commit(current + token);
    return;
  }
  const start = element.selectionStart ?? current.length;
  const end = element.selectionEnd ?? current.length;
  commit(current.slice(0, start) + token + current.slice(end));

  requestAnimationFrame(() => {
    element.focus();
    const caret = start + token.length;
    element.setSelectionRange(caret, caret);
  });
}

export function ConversationTab({ config, update, errors }: TabProps) {
  const instructionsRef = useRef<HTMLTextAreaElement>(null);
  const welcomeRef = useRef<HTMLTextAreaElement>(null);

  return (
    <div className="flex flex-col gap-9">
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-[var(--text)]">Type</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <TypeOption
            icon={MessagesSquare}
            title="Open ended"
            body="A free-form conversation guided by your instructions."
            selected
          />
          <TypeOption
            icon={ClipboardList}
            title="Data collection"
            body="Walk the caller through a set of fields and capture structured answers."
            badge="Coming soon"
          />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <Field
          label="Instructions"
          htmlFor="instructions"
          description="Define your agent's personality, tone, and behaviour guidelines."
          error={errors.get("instructions")}
          action={
            <VariableInsertMenu
              variables={config.variables}
              onInsert={(name) =>
                insertAtCaret(instructionsRef.current, config.instructions, name, (instructions) =>
                  update({ instructions }),
                )
              }
            />
          }
        >
          <Textarea
            id="instructions"
            ref={instructionsRef}
            rows={18}
            value={config.instructions}
            onChange={(event) => update({ instructions: event.target.value })}
            className="font-mono text-[13px]"
            spellCheck={false}
          />
        </Field>
        <PromptPreview text={config.instructions} variables={config.variables} />
      </section>

      <section className="flex flex-col gap-3">
        <Field
          label="Welcome message"
          htmlFor="welcome"
          description="Spoken as soon as the call connects, before the caller says anything."
          error={errors.get("welcome.message")}
          action={
            <Switch
              label="Enable the welcome message"
              checked={config.welcome.enabled}
              onCheckedChange={(enabled) => update({ welcome: { ...config.welcome, enabled } })}
            />
          }
        >
          <div className="flex flex-col gap-3">
            <label
              className={cn(
                "inline-flex w-fit items-center gap-2 text-xs",
                config.welcome.enabled ? "text-[var(--text-muted)]" : "text-[var(--text-dim)]",
              )}
            >
              <Checkbox
                checked={config.welcome.allowInterrupt}
                disabled={!config.welcome.enabled}
                onChange={(event) =>
                  update({ welcome: { ...config.welcome, allowInterrupt: event.target.checked } })
                }
              />
              Allow callers to interrupt the greeting.
            </label>

            <div className="flex items-center justify-end">
              <VariableInsertMenu
                variables={config.variables}
                onInsert={(name) =>
                  insertAtCaret(welcomeRef.current, config.welcome.message, name, (message) =>
                    update({ welcome: { ...config.welcome, message } }),
                  )
                }
              />
            </div>

            <Textarea
              id="welcome"
              ref={welcomeRef}
              rows={4}
              value={config.welcome.message}
              disabled={!config.welcome.enabled}
              placeholder="Hi, thanks for calling. What can I help you with today?"
              onChange={(event) =>
                update({ welcome: { ...config.welcome, message: event.target.value } })
              }
            />
          </div>
        </Field>

        {config.welcome.enabled && (
          <PromptPreview text={config.welcome.message} variables={config.variables} />
        )}

        <p className="text-xs leading-relaxed text-[var(--text-dim)]">
          The greeting is delivered as an instruction to the model, so expect near-verbatim wording
          rather than an exact recording.
        </p>
      </section>
    </div>
  );
}

function TypeOption({
  icon: Icon,
  title,
  body,
  selected,
  badge,
}: {
  icon: typeof MessagesSquare;
  title: string;
  body: string;
  selected?: boolean;
  badge?: string;
}) {
  return (
    <div
      aria-disabled={!selected}
      className={cn(
        "flex gap-3 rounded-2xl border p-4",
        selected
          ? "border-[var(--accent)] bg-[var(--accent-soft)]"
          : "border-[var(--border)] bg-[var(--surface-2)] opacity-60",
      )}
    >
      <span
        className={cn(
          "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border",
          selected ? "border-[var(--accent)]" : "border-[var(--border-strong)]",
        )}
      >
        {selected && <span className="size-2 rounded-full bg-[var(--accent)]" />}
      </span>
      <div>
        <p className="flex items-center gap-2 text-sm font-medium text-[var(--text)]">
          <Icon className="size-4" />
          {title}
          {badge && (
            <span className="rounded-full bg-[var(--surface-3)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
              {badge}
            </span>
          )}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">{body}</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add components/agent-config
git commit -m "feat: add Conversation tab with variable insertion and preview"
```

---

### Task 11: Models & Voice tab

**Files:**
- Create: `components/agent-config/ModelsVoiceTab.tsx`

**Interfaces:**
- Consumes: `TabProps` from `@/components/agent-config/AgentConfigForm`; `ModelsConfig`, `VadConfig`, `LIMITS` from `@/lib/agent-config/schema`; `Field`, `Input`, `Select`.
- Produces: `ModelsVoiceTab(props: TabProps)`.

- [ ] **Step 1: Create the tab**

Create `components/agent-config/ModelsVoiceTab.tsx`:

```tsx
"use client";

import type { TabProps } from "@/components/agent-config/AgentConfigForm";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { LIMITS, type ModelsConfig, type VadConfig } from "@/lib/agent-config/schema";

/** Gemini prebuilt voices available to the Live API. */
const VOICES = ["Kore", "Puck", "Charon", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr"];

const LANGUAGES = [
  { code: "bn-IN", label: "Bangla (India)" },
  { code: "bn-BD", label: "Bangla (Bangladesh)" },
  { code: "en-US", label: "English (United States)" },
  { code: "en-GB", label: "English (United Kingdom)" },
  { code: "hi-IN", label: "Hindi (India)" },
  { code: "ar-XA", label: "Arabic" },
  { code: "es-US", label: "Spanish (United States)" },
];

export function ModelsVoiceTab({ config, update, errors }: TabProps) {
  const models = config.models;

  const patch = (changes: Partial<ModelsConfig>) => update({ models: { ...models, ...changes } });
  const patchVad = (changes: Partial<VadConfig>) =>
    patch({ vad: { ...models.vad, ...changes } });

  return (
    <div className="flex flex-col gap-9">
      <section className="flex flex-col gap-5">
        <h2 className="text-sm font-medium text-[var(--text)]">Model</h2>

        <Field
          label="Live model"
          htmlFor="liveModel"
          description="Must advertise bidiGenerateContent. Changing this affects the next call only."
          error={errors.get("models.liveModel")}
        >
          <Input
            id="liveModel"
            value={models.liveModel}
            onChange={(event) => patch({ liveModel: event.target.value })}
            spellCheck={false}
            className="font-mono text-xs"
          />
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="Temperature"
            htmlFor="temperature"
            description={`Higher is more varied. ${LIMITS.temperature.min}–${LIMITS.temperature.max}.`}
            error={errors.get("models.temperature")}
          >
            <Input
              id="temperature"
              type="number"
              step="0.05"
              min={LIMITS.temperature.min}
              max={LIMITS.temperature.max}
              value={models.temperature}
              onChange={(event) => patch({ temperature: Number(event.target.value) })}
            />
          </Field>

          <Field
            label="Top P"
            htmlFor="topP"
            description={`Nucleus sampling cutoff. ${LIMITS.topP.min}–${LIMITS.topP.max}.`}
            error={errors.get("models.topP")}
          >
            <Input
              id="topP"
              type="number"
              step="0.05"
              min={LIMITS.topP.min}
              max={LIMITS.topP.max}
              value={models.topP}
              onChange={(event) => patch({ topP: Number(event.target.value) })}
            />
          </Field>
        </div>
      </section>

      <section className="flex flex-col gap-5">
        <h2 className="text-sm font-medium text-[var(--text)]">Voice</h2>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Voice" htmlFor="voice" error={errors.get("models.voice")}>
            <Select
              id="voice"
              value={models.voice}
              onChange={(event) => patch({ voice: event.target.value })}
            >
              {VOICES.map((voice) => (
                <option key={voice} value={voice}>
                  {voice}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Language"
            htmlFor="languageCode"
            description="Pins TTS phonetics, so the synthesiser is not fighting your prompt."
            error={errors.get("models.languageCode")}
          >
            <Select
              id="languageCode"
              value={models.languageCode}
              onChange={(event) => patch({ languageCode: event.target.value })}
            >
              {LANGUAGES.map(({ code, label }) => (
                <option key={code} value={code}>
                  {label} — {code}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </section>

      <section className="flex flex-col gap-5">
        <div>
          <h2 className="text-sm font-medium text-[var(--text)]">Turn taking</h2>
          <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
            Gemini&rsquo;s server-side voice activity detection decides when the caller has finished
            speaking. Shorter silences make the agent answer faster but interrupt more.
          </p>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Start sensitivity" htmlFor="startSensitivity">
            <Select
              id="startSensitivity"
              value={models.vad.startSensitivity}
              onChange={(event) =>
                patchVad({ startSensitivity: event.target.value as VadConfig["startSensitivity"] })
              }
            >
              <option value="high">High — detects speech sooner</option>
              <option value="low">Low — ignores faint sounds</option>
            </Select>
          </Field>

          <Field label="End sensitivity" htmlFor="endSensitivity">
            <Select
              id="endSensitivity"
              value={models.vad.endSensitivity}
              onChange={(event) =>
                patchVad({ endSensitivity: event.target.value as VadConfig["endSensitivity"] })
              }
            >
              <option value="high">High — ends the turn sooner</option>
              <option value="low">Low — waits longer before ending</option>
            </Select>
          </Field>

          <Field
            label="Silence before replying"
            htmlFor="silenceDurationMs"
            description={`Milliseconds. ${LIMITS.silenceDurationMs.min}–${LIMITS.silenceDurationMs.max}.`}
            error={errors.get("models.vad.silenceDurationMs")}
          >
            <Input
              id="silenceDurationMs"
              type="number"
              step="10"
              min={LIMITS.silenceDurationMs.min}
              max={LIMITS.silenceDurationMs.max}
              value={models.vad.silenceDurationMs}
              onChange={(event) => patchVad({ silenceDurationMs: Number(event.target.value) })}
            />
          </Field>

          <Field
            label="Prefix padding"
            htmlFor="prefixPaddingMs"
            description={`Audio kept from just before speech starts. ${LIMITS.prefixPaddingMs.min}–${LIMITS.prefixPaddingMs.max} ms.`}
            error={errors.get("models.vad.prefixPaddingMs")}
          >
            <Input
              id="prefixPaddingMs"
              type="number"
              step="5"
              min={LIMITS.prefixPaddingMs.min}
              max={LIMITS.prefixPaddingMs.max}
              value={models.vad.prefixPaddingMs}
              onChange={(event) => patchVad({ prefixPaddingMs: Number(event.target.value) })}
            />
          </Field>
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add components/agent-config/ModelsVoiceTab.tsx
git commit -m "feat: add Models & Voice tab"
```

---

### Task 12: Advanced tab

**Files:**
- Create: `components/agent-config/AdvancedTab.tsx`

**Interfaces:**
- Consumes: `TabProps` from `@/components/agent-config/AgentConfigForm`; `AgentVariable`, `SECRET_KEY_RE`, `LIMITS` from `@/lib/agent-config/schema`; `findTokens` from `@/lib/agent-config/template`; `Field`, `Input`, `Select`, `Button`.
- Produces: `AdvancedTab(props: TabProps)`.

- [ ] **Step 1: Create the tab**

Create `components/agent-config/AdvancedTab.tsx`:

```tsx
"use client";

import { useCallback, useState } from "react";
import { KeyRound, Plus, Trash2 } from "lucide-react";

import type { TabProps } from "@/components/agent-config/AgentConfigForm";
import { Button } from "@/components/ui/button";
import { Field, controlClass } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { LIMITS, SECRET_KEY_RE, type AgentVariable } from "@/lib/agent-config/schema";
import { findTokens } from "@/lib/agent-config/template";
import { cn } from "@/lib/utils";

/** Where a variable is referenced, so a delete can warn instead of surprising. */
function usedIn(name: string, instructions: string, welcome: string): string[] {
  const places: string[] = [];
  if (findTokens(instructions).includes(name)) places.push("the instructions");
  if (findTokens(welcome).includes(name)) places.push("the welcome message");
  return places;
}

export function AdvancedTab({ config, update, errors }: TabProps) {
  const [secretKeys, setSecretKeys] = useState<string[]>(config.secretKeys);
  const [newSecretKey, setNewSecretKey] = useState("");
  const [newSecretValue, setNewSecretValue] = useState("");
  const [secretError, setSecretError] = useState<string | null>(null);
  const [secretBusy, setSecretBusy] = useState(false);

  const patchVariable = (index: number, changes: Partial<AgentVariable>) => {
    const variables = config.variables.map((variable, position) =>
      position === index ? { ...variable, ...changes } : variable,
    );
    update({ variables });
  };

  const addVariable = () => {
    const variable: AgentVariable = {
      id: `var-${Date.now()}-${config.variables.length}`,
      type: "string",
      name: "",
      previewValue: "",
    };
    update({ variables: [...config.variables, variable] });
  };

  const removeVariable = (index: number) => {
    const variable = config.variables[index];
    const places = usedIn(variable.name, config.instructions, config.welcome.message);
    if (places.length > 0) {
      const confirmed = window.confirm(
        `{${variable.name}} is used in ${places.join(" and ")}.\n\n` +
          "Deleting the variable leaves the token in place, and it will be sent to the model " +
          "exactly as written. Delete it anyway?",
      );
      if (!confirmed) return;
    }
    update({ variables: config.variables.filter((_, position) => position !== index) });
  };

  const addSecret = useCallback(async () => {
    setSecretError(null);
    if (!SECRET_KEY_RE.test(newSecretKey)) {
      setSecretError("Use UPPER_SNAKE_CASE letters, digits and underscores.");
      return;
    }
    if (newSecretValue === "") {
      setSecretError("A value is required.");
      return;
    }

    setSecretBusy(true);
    try {
      const response = await fetch("/api/agent-config/secrets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: newSecretKey, value: newSecretValue }),
      });
      if (!response.ok) {
        const body: { errors?: { message: string }[] } = await response.json().catch(() => ({}));
        setSecretError(body.errors?.[0]?.message ?? "Could not save the secret.");
        return;
      }
      const body: { secretKeys: string[] } = await response.json();
      setSecretKeys(body.secretKeys);
      setNewSecretKey("");
      setNewSecretValue("");
    } catch {
      setSecretError("Could not reach the server.");
    } finally {
      setSecretBusy(false);
    }
  }, [newSecretKey, newSecretValue]);

  const removeSecret = useCallback(async (key: string) => {
    if (!window.confirm(`Delete the secret ${key}? This cannot be undone.`)) return;
    const response = await fetch(`/api/agent-config/secrets?key=${encodeURIComponent(key)}`, {
      method: "DELETE",
    });
    if (!response.ok) return;
    const body: { secretKeys: string[] } = await response.json();
    setSecretKeys(body.secretKeys);
  }, []);

  return (
    <div className="flex flex-col gap-9">
      <section>
        <Field
          label="Agent name"
          htmlFor="agentName"
          description="Identifies this agent in logs and, later, in dispatch rules."
          error={errors.get("agentName")}
        >
          <Input
            id="agentName"
            value={config.agentName}
            onChange={(event) => update({ agentName: event.target.value })}
            spellCheck={false}
            className="font-mono text-xs"
          />
        </Field>
      </section>

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-sm font-medium text-[var(--text)]">Custom variables</h2>
          <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
            Reference a variable as <code className="font-mono">{"{name}"}</code> in the instructions
            or welcome message. Preview values are what calls use today.
          </p>
        </div>

        {config.variables.length > 0 && (
          <div className="flex flex-col gap-3">
            {config.variables.map((variable, index) => (
              <div
                key={variable.id}
                className="grid gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4 sm:grid-cols-[8rem_1fr_1fr_auto] sm:items-end"
              >
                <Field label="Type" htmlFor={`type-${variable.id}`}>
                  <Select
                    id={`type-${variable.id}`}
                    value={variable.type}
                    onChange={(event) =>
                      patchVariable(index, { type: event.target.value as AgentVariable["type"] })
                    }
                  >
                    <option value="string">String</option>
                    <option value="number">Number</option>
                    <option value="boolean">Boolean</option>
                  </Select>
                </Field>

                <Field
                  label="Name"
                  htmlFor={`name-${variable.id}`}
                  error={errors.get(`variables.${index}.name`)}
                >
                  <Input
                    id={`name-${variable.id}`}
                    value={variable.name}
                    placeholder="company"
                    spellCheck={false}
                    onChange={(event) => patchVariable(index, { name: event.target.value })}
                    className="font-mono text-xs"
                  />
                </Field>

                <Field
                  label="Preview value"
                  htmlFor={`value-${variable.id}`}
                  error={errors.get(`variables.${index}.previewValue`)}
                >
                  {variable.type === "boolean" ? (
                    <Select
                      id={`value-${variable.id}`}
                      value={variable.previewValue === "true" ? "true" : "false"}
                      onChange={(event) =>
                        patchVariable(index, { previewValue: event.target.value })
                      }
                    >
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </Select>
                  ) : (
                    <Input
                      id={`value-${variable.id}`}
                      value={variable.previewValue}
                      inputMode={variable.type === "number" ? "decimal" : "text"}
                      placeholder={variable.type === "number" ? "0" : "Selorax"}
                      onChange={(event) =>
                        patchVariable(index, { previewValue: event.target.value })
                      }
                    />
                  )}
                </Field>

                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete the variable ${variable.name || "unnamed"}`}
                  onClick={() => removeVariable(index)}
                  className="justify-self-end text-[var(--text-muted)] hover:text-[var(--danger)]"
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        )}

        <Button
          variant="outline"
          size="sm"
          onClick={addVariable}
          disabled={config.variables.length >= LIMITS.variablesMax}
          className="w-fit"
        >
          <Plus />
          Add variable
        </Button>
      </section>

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-sm font-medium text-[var(--text)]">Secrets</h2>
          <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
            Credentials for the agent&rsquo;s HTTP tool calls. Values are stored on the server and
            never sent back to this page — a secret can be replaced, but not read.
          </p>
        </div>

        {secretKeys.length > 0 && (
          <ul className="flex flex-col gap-2">
            {secretKeys.map((key) => (
              <li
                key={key}
                className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3"
              >
                <KeyRound className="size-4 shrink-0 text-[var(--text-muted)]" />
                <span className="font-mono text-xs text-[var(--text)]">{key}</span>
                <span className="ml-auto font-mono text-xs text-[var(--text-dim)]">••••••</span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete the secret ${key}`}
                  onClick={() => void removeSecret(key)}
                  className="text-[var(--text-muted)] hover:text-[var(--danger)]"
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="grid gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label="Key" htmlFor="secretKey">
            <Input
              id="secretKey"
              value={newSecretKey}
              placeholder="CRM_API_KEY"
              spellCheck={false}
              onChange={(event) => setNewSecretKey(event.target.value.toUpperCase())}
              className="font-mono text-xs"
            />
          </Field>
          <Field label="Value" htmlFor="secretValue">
            <input
              id="secretValue"
              type="password"
              autoComplete="off"
              value={newSecretValue}
              maxLength={LIMITS.secretValueMax}
              onChange={(event) => setNewSecretValue(event.target.value)}
              className={cn(controlClass, "h-10 font-mono text-xs")}
            />
          </Field>
          <Button
            variant="outline"
            onClick={() => void addSecret()}
            disabled={secretBusy}
            className="sm:mb-0"
          >
            <Plus />
            Add secret
          </Button>
        </div>

        {secretError && (
          <p role="alert" className="text-xs font-medium text-[var(--danger)]">
            {secretError}
          </p>
        )}

        <p className="text-xs leading-relaxed text-[var(--text-dim)]">
          Secrets save immediately — they are not part of the Save changes button above.
        </p>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Verify the whole form compiles and works**

```bash
npm run typecheck && npm run lint
```
Expected: clean. This is the first point at which `AgentConfigForm` has all four tabs.

```bash
npm run dev
```

At `http://localhost:3000/configure`:
- Add a variable named `company` with preview value `Selorax`.
- Save. Confirm the bar shows "Saved" and the dirty state clears.
- Go to Conversation, use "+ Insert variable" mid-sentence, and confirm `{company}` lands at the caret and focus returns.
- Open the preview and confirm `{company}` renders as `Selorax`.
- Type `{nope}` and confirm the amber unknown-token warning appears without blocking Save.
- Add a secret, reload the page, and confirm the key is listed with `••••••` and no value.
- Rename `company` to `brand` and confirm the prompt keeps `{company}` and now warns.
- Delete `brand` and confirm NO confirmation appears — after the rename nothing references
  `{brand}`, so there is nothing to warn about. (An earlier draft of this plan expected a
  warning here; that was wrong. The rename deliberately does not rewrite the prompt, which
  is precisely what leaves `{brand}` unreferenced.)
- Re-add a variable named `company`, confirm the unknown-token warning clears, then delete
  it and confirm the "used in the instructions" confirmation DOES appear. That is the path
  the delete-warning actually protects.
- Clear the instructions entirely and Save; confirm the error appears under the field and the tab switches to Conversation.

- [ ] **Step 3: Commit**

```bash
git add components/agent-config/AdvancedTab.tsx
git commit -m "feat: add Advanced tab with variables and secrets"
```

---

### Task 13: Console integration and full verification

**Files:**
- Modify: `components/voice/VoiceAgent.tsx:29-81`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: no new exports.

- [ ] **Step 1: Replace the read-only settings panel with a link**

In `components/voice/VoiceAgent.tsx`, delete the `showSettings` state, the `Settings2` toggle button, the whole `{showSettings && (…)}` block, and the `Setting` helper at the bottom of the file. The panel described settings that are now editable, and two places describing one thing will drift.

Replace the header's right-hand side with:

```tsx
        <Button variant="outline" size="sm" asChild>
          <Link href="/configure">
            <Settings2 />
            Configure agent
          </Link>
        </Button>
```

Add `import Link from "next/link";` at the top. Remove the now-unused `useState` import if nothing else in the file uses it.

- [ ] **Step 2: Update the README**

The README currently tells the reader to edit `server/voice/agent-config.ts` to change the agent's behaviour. Find that guidance and replace it with a short section:

```markdown
## Configuring the agent

Open `/configure` in the running app. The editor covers the prompt, the welcome
message, model and voice settings, custom `{variables}`, and secrets.

Configuration is saved to `data/agent-config.json` and read fresh at the start of
every call, so a change takes effect on the next call with no restart. A call
already in progress keeps the settings it started with.

Secret *values* are written to `data/agent-secrets.json` (gitignored, mode 0600)
and are never sent to the browser.
```

- [ ] **Step 3: Full verification**

```bash
npm test
```
Expected: PASS — 46 tests, 0 failures.

```bash
npm run typecheck
```
Expected: no output.

```bash
npm run lint
```
Expected: no errors.

```bash
grep -rn "agent-config\"\|ThemeToggle\|data-theme" --include=*.ts --include=*.tsx --include=*.css . | grep -v node_modules | grep -v "lib/agent-config"
```
Expected: no output.

- [ ] **Step 4: End-to-end run**

```bash
npm run dev
```

Walk the whole feature:

1. Console loads light, no dark flash, orb and waveform legible at rest.
2. "Configure agent" opens `/configure`.
3. Add variable `company` = `Selorax`; put `{company}` in the instructions; enable the welcome message with `Thanks for calling {company}.`; uncheck "Allow callers to interrupt"; Save.
4. Back to the console, start a call. The agent greets you first, saying the company name.
5. Talk over the greeting — it does not stop.
6. After the greeting, talk over the agent — barge-in works normally.
7. Re-enable "Allow callers to interrupt", save, restart the call, talk over the greeting — it stops.
8. Change the voice in Models & Voice, save, start a new call, confirm the voice changed and the console's status readout reports the new voice.
9. `cat data/agent-config.json` — readable, no secret values.
10. `curl -s localhost:3000/api/agent-config | grep -c '<your secret value>'` — prints `0`.

- [ ] **Step 5: Commit**

```bash
git add components/voice/VoiceAgent.tsx README.md
git commit -m "feat: link the console to the agent configuration editor"
```

---

## Self-Review

**Spec coverage:** Architecture → Tasks 1–6. Data model → Task 1. Validation → Task 1. Secrets → Tasks 4, 5, 12. Resolution → Tasks 2, 3. Welcome message → Tasks 3, 6. Greeting interruption → Task 6. Models & Voice → Tasks 6, 11. UI → Tasks 8–12. Data collection disabled → Tasks 1 (server rejection) and 10 (disabled radio). Theme removal → Task 7. Error handling → Tasks 4 (store fallbacks), 5 (HTTP codes), 9 (form routing). Testing → Tasks 1–4 plus the manual passes in 6, 12 and 13.

**Deviations from the spec, deliberate:**

1. **A test runner exists.** The spec said none would be added. Node 24's built-in `node:test` runs through the already-installed `tsx`, so real unit tests cost zero dependencies. Tasks 1–4 are properly test-driven.
2. **`server/voice/agent-config.ts` is deleted**, not repurposed, and the seed moves to `lib/agent-config/defaults.ts`. The old file's stated reason for existing — keeping the prompt out of the browser — no longer holds once the browser edits the prompt.
3. **The welcome message defaults to disabled.** The seed prompt already instructs the model to open with a Bangla greeting; enabling both would give it two competing greeting instructions.
4. **The upload route also reads the store**, so both the Live and Upload paths honour one configuration. The spec did not mention the upload route; leaving it on deleted constants would have broken the build.
