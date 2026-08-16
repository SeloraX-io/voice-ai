# Console Shell and Agent Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the tab bar with a left sidebar and real routes, delete the standalone voice console, and move talking to the agent into a preview panel that survives navigation.

**Architecture:** A Next.js route group `app/(console)/` owns a layout that mounts the sidebar, an `AgentConfigProvider` holding all configuration state, the sticky save bar, and the preview panel. Because both the config state and the voice session live above the router, navigating between screens loses neither unsaved edits nor an in-flight call. The four existing tab components and `AudioUploader` move under routes unchanged.

**Tech Stack:** Next.js 16 (App Router, route groups), React 19 (context), TypeScript strict, Tailwind CSS v4, `ws`, `@google/genai`, Node 24 built-in test runner (`node:test`) via `tsx`.

**Spec:** `docs/superpowers/specs/2026-08-16-console-shell-and-preview-design.md`

## Global Constraints

- **No new npm dependencies.** Everything is built from what is already in `package.json`.
- **Node v24.19.0.** Tests run via `node --import tsx --test`, wired to `npm test`.
- **TypeScript is strict**, `noEmit` on. `npm run typecheck` must end at ZERO errors for every task except where a task explicitly states otherwise (no task in this plan does).
- **`npm run lint` and `npm run build` must both stay clean.** The build is a real gate — it catches App Router mistakes the dev server hides.
- **The existing 51 tests must keep passing.** New pure logic adds to that count.
- **Path alias:** `@/*` maps to the repo root. Files under `server/` use RELATIVE imports because the gateway runs outside Next's module resolution.
- **Light theme only.** Every colour goes through a CSS custom property (`var(--surface-2)`, `var(--text-muted)`, `var(--border)`, `var(--ring)`, …). The only sanctioned exceptions are the documented per-state palettes in `VoiceOrb.tsx` and `VoiceWaveform.tsx`.
- **Every `Field` passes `htmlFor` matching its control's `id`.** `Field`'s `htmlFor` is optional, so a mismatch silently orphans the label.
- **File comment style:** modules open with a block comment explaining WHY they exist. Match it.
- **Secret VALUES never reach the browser**, and never reach a log. This plan tightens that, and must not loosen it.
- **Sidebar width 240px; preview panel width 420px.** Below the `md` breakpoint the sidebar collapses behind a toggle and the preview goes full-width.

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `lib/agent-config/routes.ts` | Route constants + `routeForPath`. Pure, no React. |
| `lib/agent-config/preview-hints.ts` | The two preview decisions, as pure functions. |
| `components/agent-config/AgentConfigProvider.tsx` | Config state, `TabProps`, `useAgentConfig`. |
| `components/agent-config/SaveBar.tsx` | Sticky save/discard bar, reads the provider. |
| `components/shell/Sidebar.tsx` | Nav groups, active state, mobile toggle, Test-agent control. |
| `components/preview/PreviewPanel.tsx` | Slide-over shell + the voice UI. |
| `components/preview/PreviewSession.tsx` | Orb/waveform/controls/transcript/session block. |
| `app/(console)/layout.tsx` | Sidebar + provider + save bar + preview panel. |
| `app/(console)/agent/conversation/page.tsx` | → `ConversationTab` |
| `app/(console)/agent/actions/page.tsx` | → `ActionsTab` |
| `app/(console)/agent/advanced/page.tsx` | → `AdvancedTab` |
| `app/(console)/models-voice/page.tsx` | → `ModelsVoiceTab` |
| `app/(console)/upload/page.tsx` | → `AudioUploader` |

**Modified:** `server/config/store.ts`, `app/api/upload/route.ts`, `lib/gemini/types.ts`, `app/page.tsx`, the three config tabs (import site of `TabProps`), `README.md`, `server/config/store.test.ts`.

**Deleted:** `app/configure/page.tsx`, `components/agent-config/AgentConfigForm.tsx`, `components/voice/VoiceAgent.tsx`.

---

### Task 1: Store fixes — real logger and secrets recoverability

Two findings from the previous phase's whole-branch review. They MUST land together: fixing the logger alone would make a currently-unreachable log line live, and that line prints `String(error)` from a `JSON.parse` failure on the **secrets** file — whose `SyntaxError` message embeds a snippet of the offending input, i.e. secret material.

**Files:**
- Modify: `server/config/store.ts`
- Test: `server/config/store.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `configStore` unchanged in shape; `setSecret` / `deleteSecret` now reject when the secrets file exists but is unparseable.

- [ ] **Step 1: Write the failing tests**

Append to `server/config/store.test.ts`:

```ts
test("logs when the config file is unreadable", async () => {
  const dir = await freshDir();
  await writeFile(path.join(dir, "agent-config.json"), "{ not json", "utf8");

  const messages: string[] = [];
  const store = createConfigStore(dir, (message) => messages.push(message));
  await store.read();

  assert.equal(messages.length, 1);
});

test("refuses to write over an unparseable secrets file", async () => {
  const dir = await freshDir();
  await writeFile(path.join(dir, "agent-secrets.json"), "{ not json", "utf8");
  const store = createConfigStore(dir, () => {});

  await assert.rejects(() => store.setSecret("CRM_API_KEY", "abc"));
  await assert.rejects(() => store.deleteSecret("CRM_API_KEY"));

  // The corrupt file must survive, exactly as a corrupt config file does.
  assert.equal(await readFile(path.join(dir, "agent-secrets.json"), "utf8"), "{ not json");
});

test("never logs the contents of an unparseable secrets file", async () => {
  const dir = await freshDir();
  await writeFile(
    path.join(dir, "agent-secrets.json"),
    '{"CRM_API_KEY":"super-secret-value" ',
    "utf8",
  );

  const messages: string[] = [];
  const store = createConfigStore(dir, (message) => messages.push(message));
  await store.setSecret("OTHER", "x").catch(() => undefined);

  assert.ok(!messages.join(" ").includes("super-secret-value"));
});

test("a missing secrets file is still the ordinary first-run path", async () => {
  const store = createConfigStore(await freshDir(), () => {});
  await store.setSecret("CRM_API_KEY", "abc");
  assert.deepEqual(await store.listSecretKeys(), ["CRM_API_KEY"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — the two `assert.rejects` calls fail because `setSecret` currently succeeds, silently replacing the corrupt file.

- [ ] **Step 3: Make `readSecrets` distinguish missing from unparseable**

In `server/config/store.ts`, replace `readSecrets` with:

```ts
  /**
   * A missing file is the ordinary first-run path. An unparseable one is not:
   * returning `{}` there would let the next write rename an empty object over
   * the user's real secrets, destroying every one of them. Throwing keeps the
   * file on disk and recoverable, matching how the config path behaves.
   *
   * The error's message is never logged. Node's JSON.parse SyntaxError embeds a
   * snippet of the input, which on this file is secret material.
   */
  async function readSecrets(): Promise<Record<string, string>> {
    let raw: string;
    try {
      raw = await readFile(secretsPath, "utf8");
    } catch (error) {
      if (isMissing(error)) return {};
      log(`agent-secrets.json could not be read (${(error as Error).name})`);
      throw new Error("The secrets file could not be read.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      log(`agent-secrets.json is not valid JSON (${(error as Error).name})`);
      throw new Error("The secrets file is corrupt; it was left untouched.");
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      log("agent-secrets.json is not an object; it was left untouched");
      throw new Error("The secrets file is corrupt; it was left untouched.");
    }
    return parsed as Record<string, string>;
  }
```

`listSecretKeys` calls `readSecrets`, so it now rejects on a corrupt file too. That is correct — the route's `catch` turns it into a 500 rather than reporting an empty list that would look like "you have no secrets".

- [ ] **Step 4: Give the exported store a real logger**

Replace the final export in `server/config/store.ts`:

```ts
/**
 * The instance every caller in this process should use.
 *
 * The gateway builds its own store with its own logger; this one serves the
 * Next process, where a silent fallback previously meant a rejected config file
 * produced no output anywhere and the editor showed seed defaults with no clue
 * that saved work had been refused.
 */
export const configStore = createConfigStore(path.join(process.cwd(), "data"), (message) =>
  console.warn(`[agent-config] ${message}`),
);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 55 tests, 0 failures.

- [ ] **Step 6: Verify the routes still behave**

```bash
npm run typecheck && npm run lint
```
Expected: both clean.

Then confirm the corrupt-secrets path surfaces as a 500 rather than a crash:

```bash
npm run dev:web    # note the PID; stop exactly this process when done
mkdir -p data && printf '{ not json' > data/agent-secrets.json
curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:3000/api/agent-config/secrets \
  -H 'content-type: application/json' -d '{"key":"CRM_API_KEY","value":"abc"}'
rm -rf data
```
Expected: `500`. Confirm the server log names the failure without printing file contents.

- [ ] **Step 7: Commit**

```bash
git add server/config/store.ts server/config/store.test.ts
git commit -m "fix: log store failures in the web process and stop clobbering a corrupt secrets file"
```

---

### Task 2: Upload path honours the configured language; delete dead exports

**Files:**
- Modify: `app/api/upload/route.ts`
- Modify: `lib/gemini/types.ts`

**Interfaces:**
- Consumes: `resolveAgentConfig`, `configStore` (already imported by the route).
- Produces: nothing new.

- [ ] **Step 1: Remove the hard-coded Bangla from the user turn**

In `app/api/upload/route.ts`, the parts array currently instructs the model that the reply "must be in Bangla". The route already loads `agent.instructions` as the system instruction, and the seed persona carries the language rule itself, so this second instruction fights the Models & Voice setting. Replace that text with:

```ts
              text:
                "This is a recording of a customer calling support. " +
                "Transcribe exactly what the customer says, in whatever language they used. " +
                "Then write the reply you would speak back to them.",
```

- [ ] **Step 2: Remove the hard-coded Bangla from the response schema**

In the same file, the `reply` property's description says the reply is "written in Bangla". Replace with:

```ts
            reply: {
              type: Type.STRING,
              description: "The support agent's spoken reply. One or two sentences.",
            },
```

- [ ] **Step 3: Delete the dead constants**

In `lib/gemini/types.ts`, delete the `LIVE_MODEL` and `AGENT_VOICE` exports along with their doc comments. Both are now sourced from the stored config; the comments assert behaviour that moved. `UPLOAD_UNDERSTANDING_MODEL` and `UPLOAD_TTS_MODEL` stay — the upload route still uses them.

- [ ] **Step 4: Confirm nothing referenced them**

```bash
grep -rn "LIVE_MODEL\|AGENT_VOICE" --include='*.ts' --include='*.tsx' app components hooks lib server types
```
Expected: no output. If anything appears, it is a real consumer — stop and report rather than deleting its import.

- [ ] **Step 5: Verify**

```bash
npm test && npm run typecheck && npm run lint && npm run build
```
Expected: 55 tests pass; typecheck, lint and build all clean.

- [ ] **Step 6: Commit**

```bash
git add app/api/upload/route.ts lib/gemini/types.ts
git commit -m "fix: let the configured language govern the upload path; drop dead constants"
```

---

### Task 3: Route map and the configuration provider

Creates the new state container alongside the existing form. Nothing is deleted here, so the app keeps working; Task 5 switches over.

**Files:**
- Create: `lib/agent-config/routes.ts`
- Create: `components/agent-config/AgentConfigProvider.tsx`
- Create: `components/agent-config/SaveBar.tsx`
- Test: `lib/agent-config/routes.test.ts`
- Modify: `components/agent-config/AgentConfigForm.tsx` (import `TabProps` from its new home)
- Modify: `components/agent-config/ConversationTab.tsx`, `ModelsVoiceTab.tsx`, `AdvancedTab.tsx` (import site only)

**Interfaces:**
- Consumes: `AgentConfig`, `FieldError` from `@/lib/agent-config/schema`.
- Produces:
  - `lib/agent-config/routes.ts`: `AGENT_ROUTES` (readonly array of `{href, label, group}`), `type AgentRoute = "/agent/conversation" | "/agent/actions" | "/agent/advanced" | "/models-voice"`, `routeForPath(path: string): AgentRoute | null`.
  - `components/agent-config/AgentConfigProvider.tsx`: `interface TabProps { config; update; setSecretKeys; errors }`, `AgentConfigProvider({ initialConfig, children })`, `useAgentConfig(): AgentConfigContextValue` where that value is `TabProps & { dirty: boolean; formError: string | null; saveState: "idle"|"saving"|"saved"; save: () => Promise<boolean>; discard: () => void }`.
  - `components/agent-config/SaveBar.tsx`: `SaveBar()`.

Note `save()` returns `Promise<boolean>` — `true` when the save succeeded. Task 8's save-and-test needs that answer, and a void return would force it to guess.

- [ ] **Step 1: Write the failing test**

Create `lib/agent-config/routes.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { AGENT_ROUTES, routeForPath } from "./routes";

test("routes model errors to the models screen", () => {
  assert.equal(routeForPath("models"), "/models-voice");
  assert.equal(routeForPath("models.temperature"), "/models-voice");
  assert.equal(routeForPath("models.vad.silenceDurationMs"), "/models-voice");
});

test("routes agent name and variable errors to the advanced screen", () => {
  assert.equal(routeForPath("agentName"), "/agent/advanced");
  assert.equal(routeForPath("variables"), "/agent/advanced");
  assert.equal(routeForPath("variables.0.name"), "/agent/advanced");
});

test("routes everything else to the conversation screen", () => {
  assert.equal(routeForPath("instructions"), "/agent/conversation");
  assert.equal(routeForPath("welcome.message"), "/agent/conversation");
  assert.equal(routeForPath("type"), "/agent/conversation");
});

test("does not route a form-level error", () => {
  assert.equal(routeForPath(""), null);
});

test("every configuration route in the nav has a label and a group", () => {
  for (const route of AGENT_ROUTES) {
    assert.ok(route.label.length > 0);
    assert.ok(route.group === "agent" || route.group === null);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './routes'`.

- [ ] **Step 3: Write the route map**

Create `lib/agent-config/routes.ts`:

```ts
/**
 * The console's navigation map, and where a validation error belongs.
 *
 * Kept free of React so it can be unit tested and imported from anywhere. The
 * sidebar renders from AGENT_ROUTES; the provider uses routeForPath to reveal
 * the screen owning a rejected field, the way the old tab bar switched tabs.
 */

export type AgentRoute =
  | "/agent/conversation"
  | "/agent/actions"
  | "/agent/advanced"
  | "/models-voice";

export interface NavRoute {
  href: string;
  label: string;
  /** "agent" nests the item under the Agent heading; null makes it top level. */
  group: "agent" | null;
}

export const AGENT_ROUTES: readonly NavRoute[] = [
  { href: "/agent/conversation", label: "Conversation", group: "agent" },
  { href: "/agent/actions", label: "Actions", group: "agent" },
  { href: "/agent/advanced", label: "Advanced", group: "agent" },
  { href: "/models-voice", label: "Models & Voice", group: null },
  { href: "/upload", label: "Upload Audio", group: null },
] as const;

/** Routes that edit the agent configuration, so the save bar belongs on them. */
export const CONFIG_ROUTES: readonly string[] = [
  "/agent/conversation",
  "/agent/actions",
  "/agent/advanced",
  "/models-voice",
];

/**
 * Where a server validation error should send the user. Returns null for a
 * form-level error (empty path), which must not trigger navigation.
 */
export function routeForPath(path: string): AgentRoute | null {
  if (path === "") return null;
  if (path.startsWith("models")) return "/models-voice";
  if (path.startsWith("agentName") || path.startsWith("variables")) return "/agent/advanced";
  return "/agent/conversation";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 60 tests.

- [ ] **Step 5: Write the provider**

Create `components/agent-config/AgentConfigProvider.tsx`. The state logic is moved verbatim from `AgentConfigForm.tsx` — `stableStringify`, the `strip` denylist with its eslint-disable, the save-failure handling and the guarded success parse are all preserved exactly. What changes: it exposes state through context instead of rendering tabs, `save()` returns a boolean, and error routing navigates instead of setting a tab.

```tsx
"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { routeForPath } from "@/lib/agent-config/routes";
import type { AgentConfig, FieldError } from "@/lib/agent-config/schema";

/** Props every configuration screen receives. */
export interface TabProps {
  config: AgentConfig;
  update: (patch: Partial<AgentConfig>) => void;
  /**
   * Secrets save immediately to their own endpoint, so they are not part of the
   * form's dirty state. Both snapshots move together, which keeps Discard from
   * reverting a list the server has already changed.
   */
  setSecretKeys: (keys: string[]) => void;
  /** Keyed by the dotted path from the server, e.g. "variables.0.name". */
  errors: Map<string, string>;
}

type SaveState = "idle" | "saving" | "saved";

export interface AgentConfigContextValue extends TabProps {
  dirty: boolean;
  formError: string | null;
  saveState: SaveState;
  /** Resolves true when the configuration was persisted. */
  save: () => Promise<boolean>;
  discard: () => void;
}

const AgentConfigContext = createContext<AgentConfigContextValue | null>(null);

/**
 * Order-insensitive serialisation for the dirty check.
 *
 * A plain JSON.stringify compares key order as well as content, so a screen that
 * rebuilt a nested object with its keys in a different order would leave the
 * form stuck showing "Unsaved changes" with nothing to save. Sorting keys at
 * every level makes the comparison depend on values alone. Array order is
 * preserved deliberately — reordering variables IS an edit.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

/**
 * Owns the agent configuration for the whole console.
 *
 * It lives above the router deliberately: with the four editors as routes
 * rather than tabs, state held inside a page would be unmounted — and unsaved
 * edits discarded — every time the user moved between screens.
 */
export function AgentConfigProvider({
  initialConfig,
  children,
}: {
  initialConfig: AgentConfig;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState<AgentConfig>(initialConfig);
  const [config, setConfig] = useState<AgentConfig>(initialConfig);
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [formError, setFormError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  // `updatedAt` and `secretKeys` are server-owned, so they must not count as
  // edits — otherwise the bar would appear the moment a secret is added.
  const dirty = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit these from the comparison
    const strip = ({ updatedAt: _u, secretKeys: _s, ...rest }: AgentConfig) => rest;
    return stableStringify(strip(config)) !== stableStringify(strip(saved));
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

  const setSecretKeys = useCallback((secretKeys: string[]) => {
    setSaved((current) => ({ ...current, secretKeys }));
    setConfig((current) => ({ ...current, secretKeys }));
  }, []);

  const discard = useCallback(() => {
    setConfig(saved);
    setErrors(new Map());
    setFormError(null);
    setSaveState("idle");
  }, [saved]);

  const save = useCallback(async (): Promise<boolean> => {
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
      return false;
    }

    if (!response.ok) {
      const body: { errors?: FieldError[] } = await response.json().catch(() => ({}));
      const list = body.errors ?? [{ path: "", message: "Could not save the configuration." }];
      setErrors(new Map(list.map((error) => [error.path, error.message])));
      setFormError(list.find((error) => error.path === "")?.message ?? "Some fields need fixing.");
      const firstField = list.find((error) => error.path !== "");
      const route = firstField ? routeForPath(firstField.path) : null;
      if (route) router.push(route);
      setSaveState("idle");
      return false;
    }

    let next: AgentConfig;
    try {
      next = await response.json();
    } catch {
      setSaveState("idle");
      setFormError(
        "The server sent a response we could not read. Your changes are still here — try saving again.",
      );
      return false;
    }

    setSaved(next);
    setConfig(next);
    setSaveState("saved");
    return true;
  }, [config, router]);

  const value: AgentConfigContextValue = {
    config,
    update,
    setSecretKeys,
    errors,
    dirty,
    formError,
    saveState,
    save,
    discard,
  };

  return <AgentConfigContext.Provider value={value}>{children}</AgentConfigContext.Provider>;
}

export function useAgentConfig(): AgentConfigContextValue {
  const value = useContext(AgentConfigContext);
  if (!value) throw new Error("useAgentConfig must be used inside AgentConfigProvider");
  return value;
}
```

- [ ] **Step 6: Write the save bar**

Create `components/agent-config/SaveBar.tsx`:

```tsx
"use client";

import { AlertTriangle, Check, Loader2 } from "lucide-react";

import { useAgentConfig } from "@/components/agent-config/AgentConfigProvider";
import { Button } from "@/components/ui/button";

/**
 * Saving is always explicit: a half-typed prompt must not become the live
 * persona. Rendered by the layout so it survives navigation between screens.
 */
export function SaveBar() {
  const { dirty, formError, saveState, save, discard } = useAgentConfig();

  return (
    <div className="sticky bottom-0 border-t border-[var(--border)] bg-[var(--bg)]/85 backdrop-blur">
      {formError && (
        <p
          role="alert"
          className="animate-fade-rise flex items-start gap-2.5 px-6 pt-4 text-sm text-[var(--danger)]"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{formError}</span>
        </p>
      )}
      <div className="flex items-center justify-end gap-3 px-6 py-4">
        {saveState === "saved" && !dirty && (
          <span className="mr-auto inline-flex items-center gap-1.5 text-sm text-[var(--success)]">
            <Check className="size-4" />
            Saved
          </span>
        )}
        {dirty && <span className="mr-auto text-sm text-[var(--text-muted)]">Unsaved changes</span>}
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

- [ ] **Step 7: Move `TabProps` to its new home**

In `ConversationTab.tsx`, `ModelsVoiceTab.tsx` and `AdvancedTab.tsx`, change the `TabProps` import from `@/components/agent-config/AgentConfigForm` to `@/components/agent-config/AgentConfigProvider`.

In `AgentConfigForm.tsx`, delete its local `TabProps` interface and import the type instead, so the still-live form keeps compiling until Task 5 removes it:

```ts
import type { TabProps } from "@/components/agent-config/AgentConfigProvider";
```

Leave `tabForPath` and `TabId` in `AgentConfigForm.tsx` untouched — they die with the file.

- [ ] **Step 8: Verify**

```bash
npm test && npm run typecheck && npm run lint && npm run build
```
Expected: 60 tests pass; everything else clean. `/configure` still works exactly as before, because nothing has been switched over yet.

- [ ] **Step 9: Commit**

```bash
git add lib/agent-config/routes.ts lib/agent-config/routes.test.ts components/agent-config
git commit -m "feat: add route map, config provider and save bar"
```

---

### Task 4: Sidebar

**Files:**
- Create: `components/shell/Sidebar.tsx`

**Interfaces:**
- Consumes: `AGENT_ROUTES` from `@/lib/agent-config/routes`.
- Produces: `Sidebar({ onTestAgent, callActive, callSeconds })` where `onTestAgent: () => void`, `callActive: boolean`, `callSeconds: number`.

The call props are consumed in Task 9; render them from the start so the layout wiring does not change twice.

- [ ] **Step 1: Write the sidebar**

Create `components/shell/Sidebar.tsx`:

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { AudioLines, Menu, Play, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { AGENT_ROUTES } from "@/lib/agent-config/routes";
import { cn } from "@/lib/utils";

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

interface SidebarProps {
  onTestAgent: () => void;
  callActive: boolean;
  callSeconds: number;
}

export function Sidebar({ onTestAgent, callActive, callSeconds }: SidebarProps) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const agentItems = AGENT_ROUTES.filter((route) => route.group === "agent");
  const topLevelItems = AGENT_ROUTES.filter((route) => route.group === null);

  const item = (href: string, label: string) => (
    <Link
      key={href}
      href={href}
      onClick={() => setOpen(false)}
      aria-current={pathname === href ? "page" : undefined}
      className={cn(
        "block rounded-lg px-3 py-2 text-sm transition-colors",
        pathname === href
          ? "bg-[var(--surface-3)] font-medium text-[var(--text)]"
          : "text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]",
      )}
    >
      {label}
    </Link>
  );

  return (
    <>
      {/* Mobile bar: the sidebar overlays content below md rather than squeezing it. */}
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3 md:hidden">
        <Button variant="ghost" size="icon" aria-label="Open navigation" onClick={() => setOpen(true)}>
          <Menu />
        </Button>
        <span className="text-sm font-semibold text-[var(--text)]">Voice AI</span>
      </div>

      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/20 md:hidden"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}

      <nav
        aria-label="Console"
        className={cn(
          "z-40 flex w-60 shrink-0 flex-col gap-1 border-r border-[var(--border)] bg-[var(--surface)] p-4",
          "fixed inset-y-0 left-0 transition-transform md:static md:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="mb-4 flex items-center gap-2.5 px-1">
          <span className="grid size-8 place-items-center rounded-lg bg-[var(--accent)] text-[var(--accent-contrast)]">
            <AudioLines className="size-4" />
          </span>
          <span className="text-sm font-semibold tracking-tight text-[var(--text)]">Voice AI</span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close navigation"
            className="ml-auto md:hidden"
            onClick={() => setOpen(false)}
          >
            <X />
          </Button>
        </div>

        <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--text-dim)]">
          Agent
        </p>
        {agentItems.map((route) => item(route.href, route.label))}

        <div className="pt-2">{topLevelItems.map((route) => item(route.href, route.label))}</div>

        <div className="mt-auto pt-4">
          <Button variant="outline" className="w-full" onClick={onTestAgent}>
            {callActive ? (
              <>
                <span className="size-2 rounded-full bg-[var(--success)] [animation:status-pulse_1.6s_ease-in-out_infinite]" />
                Live · {formatElapsed(callSeconds)}
              </>
            ) : (
              <>
                <Play />
                Test agent
              </>
            )}
          </Button>
        </div>
      </nav>
    </>
  );
}
```

- [ ] **Step 2: Verify**

```bash
npm run typecheck && npm run lint
```
Expected: clean. Nothing renders it yet.

- [ ] **Step 3: Commit**

```bash
git add components/shell/Sidebar.tsx
git commit -m "feat: add console sidebar"
```

---

### Task 5: Route group, layout, and the five screens

This is the switch-over. `/configure` and `AgentConfigForm` die here.

**Files:**
- Create: `app/(console)/layout.tsx`, and the five `page.tsx` files
- Modify: `app/page.tsx`
- Delete: `app/configure/page.tsx`, `components/agent-config/AgentConfigForm.tsx`

**Interfaces:**
- Consumes: `AgentConfigProvider`, `useAgentConfig`, `SaveBar`, `Sidebar`, `CONFIG_ROUTES`.
- Produces: the five routes.

- [ ] **Step 1: Create the layout**

Create `app/(console)/layout.tsx`:

```tsx
/**
 * The console shell.
 *
 * Configuration state lives here rather than in a page because the four editors
 * are routes: state held inside one would be unmounted, and unsaved edits lost,
 * on every navigation.
 */

import { AgentConfigProvider } from "@/components/agent-config/AgentConfigProvider";
import { ConsoleChrome } from "@/components/shell/ConsoleChrome";
import { configStore } from "@/server/config/store";

export const dynamic = "force-dynamic";

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const [config, secretKeys] = await Promise.all([
    configStore.read(),
    configStore.listSecretKeys(),
  ]);

  return (
    <AgentConfigProvider initialConfig={{ ...config, secretKeys }}>
      <ConsoleChrome>{children}</ConsoleChrome>
    </AgentConfigProvider>
  );
}
```

- [ ] **Step 2: Create the chrome**

The layout is a server component, but the sidebar and save bar need client state, so the chrome is a separate client component.

Create `components/shell/ConsoleChrome.tsx`:

```tsx
"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";

import { SaveBar } from "@/components/agent-config/SaveBar";
import { Sidebar } from "@/components/shell/Sidebar";
import { CONFIG_ROUTES } from "@/lib/agent-config/routes";

/**
 * Holds everything that must outlive a route change: the sidebar, the save bar,
 * and (from Task 7) the preview panel with its live call.
 */
export function ConsoleChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [previewOpen, setPreviewOpen] = useState(false);
  const showSaveBar = CONFIG_ROUTES.includes(pathname);

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <Sidebar onTestAgent={() => setPreviewOpen(true)} callActive={false} callSeconds={0} />

      <div className="flex min-w-0 flex-1 flex-col">
        <main className="flex-1 px-6 py-8">
          <div className="mx-auto w-full max-w-3xl">{children}</div>
        </main>
        {showSaveBar && <SaveBar />}
      </div>

      {previewOpen && null /* PreviewPanel arrives in Task 7 */}
    </div>
  );
}
```

`previewOpen` is unused until Task 7. If lint flags it, keep the state and render the placeholder expression exactly as written — it references the variable, so it will not be reported unused.

- [ ] **Step 3: Create the five pages**

`app/(console)/agent/conversation/page.tsx`:

```tsx
"use client";

import { useAgentConfig } from "@/components/agent-config/AgentConfigProvider";
import { ConversationTab } from "@/components/agent-config/ConversationTab";

export default function ConversationPage() {
  const { config, update, setSecretKeys, errors } = useAgentConfig();
  return <ConversationTab config={config} update={update} setSecretKeys={setSecretKeys} errors={errors} />;
}
```

`app/(console)/agent/advanced/page.tsx` — identical, with `AdvancedTab` and `AdvancedPage`.

`app/(console)/models-voice/page.tsx` — identical, with `ModelsVoiceTab` and `ModelsVoicePage`.

`app/(console)/agent/actions/page.tsx` — `ActionsTab` takes no props:

```tsx
import { ActionsTab } from "@/components/agent-config/ActionsTab";

export default function ActionsPage() {
  return <ActionsTab />;
}
```

`app/(console)/upload/page.tsx`:

```tsx
import { AudioUploader } from "@/components/voice/AudioUploader";

export default function UploadPage() {
  return <AudioUploader />;
}
```

- [ ] **Step 4: Redirect the root**

Replace `app/page.tsx` entirely:

```tsx
import { redirect } from "next/navigation";

export default function Home() {
  redirect("/agent/conversation");
}
```

- [ ] **Step 5: Delete the superseded files**

```bash
git rm app/configure/page.tsx components/agent-config/AgentConfigForm.tsx
```

- [ ] **Step 6: Confirm nothing still imports them**

```bash
grep -rn "AgentConfigForm\|/configure" --include='*.ts' --include='*.tsx' app components hooks lib server types
```
Expected: no output.

- [ ] **Step 7: Verify**

```bash
npm test && npm run typecheck && npm run lint && npm run build
```
Expected: 60 tests; everything clean. The build output should list `/agent/conversation`, `/agent/actions`, `/agent/advanced`, `/models-voice` and `/upload`, and no `/configure`.

Then exercise it. Start `npm run dev:web` (note the PID; stop exactly that process when done):

```bash
for p in / /agent/conversation /agent/actions /agent/advanced /models-voice /upload; do
  printf '%s -> ' "$p"; curl -s -o /dev/null -w "%{http_code}\n" -L "localhost:3000$p"
done
```
Expected: all `200`.

- [ ] **Step 8: Commit**

```bash
git add -A app components
git commit -m "feat: move the console onto a sidebar and routes"
```

---

### Task 6: Guard navigation away from unsaved edits

The provider's `beforeunload` covers closing the tab, but Next client-side navigation never fires it. This closes the gap the previous phase's review found.

**Files:**
- Create: `components/shell/DirtyNavGuard.tsx`
- Modify: `components/shell/Sidebar.tsx` (route through the guard)
- Modify: `components/shell/ConsoleChrome.tsx` (provide the guard)

**Interfaces:**
- Consumes: `useAgentConfig`.
- Produces: `useNavGuard(): (href: string) => boolean` — returns true when navigation may proceed.

- [ ] **Step 1: Write the guard**

Create `components/shell/DirtyNavGuard.tsx`:

```tsx
"use client";

import { useCallback } from "react";

import { useAgentConfig } from "@/components/agent-config/AgentConfigProvider";
import { CONFIG_ROUTES } from "@/lib/agent-config/routes";

/**
 * Client-side navigation never fires `beforeunload`, so leaving the editor with
 * unsaved edits would silently discard them. Moving BETWEEN configuration
 * screens is safe — the provider outlives them — so only leaving the
 * configuration area prompts.
 */
export function useNavGuard(): (href: string) => boolean {
  const { dirty } = useAgentConfig();

  return useCallback(
    (href: string) => {
      if (!dirty) return true;
      if (CONFIG_ROUTES.includes(href)) return true;
      return window.confirm(
        "You have unsaved changes to the agent configuration.\n\n" +
          "Leaving this section discards them. Leave anyway?",
      );
    },
    [dirty],
  );
}
```

- [ ] **Step 2: Route the sidebar's links through it**

In `components/shell/Sidebar.tsx`, import the hook and call it at the top of the component:

```tsx
import { useNavGuard } from "@/components/shell/DirtyNavGuard";
```

```tsx
  const mayNavigate = useNavGuard();
```

Then change the `onClick` on the `Link` inside `item` so a refused navigation is cancelled:

```tsx
      onClick={(event) => {
        if (!mayNavigate(href)) {
          event.preventDefault();
          return;
        }
        setOpen(false);
      }}
```

- [ ] **Step 3: Verify**

```bash
npm test && npm run typecheck && npm run lint && npm run build
```
Expected: all clean.

Then manually: start the dev server, edit the instructions on `/agent/conversation`, and confirm — clicking Advanced navigates freely (same section, edits intact and still shown as unsaved), while clicking Upload Audio prompts, and cancelling stays put with the edit intact.

- [ ] **Step 4: Commit**

```bash
git add components/shell
git commit -m "feat: confirm before leaving the editor with unsaved changes"
```

---

### Task 7: Preview panel

**Files:**
- Create: `components/preview/PreviewPanel.tsx`
- Create: `components/preview/PreviewSession.tsx`
- Modify: `components/shell/ConsoleChrome.tsx`

**Interfaces:**
- Consumes: `useVoiceSession` from `@/hooks/useVoiceSession`, and the existing `VoiceOrb`, `VoiceWaveform`, `VoiceControls`, `Transcript`, `ConnectionStatus`, `CallStats`.
- Produces: `PreviewPanel({ open, onClose, voice })` and `PreviewSession({ voice })`, both taking `voice: VoiceSessionController`.

The `useVoiceSession()` call moves into `ConsoleChrome` — above the router — so an in-flight call survives navigation. Neither preview component may call it.

- [ ] **Step 1: Write the session body**

Create `components/preview/PreviewSession.tsx`:

```tsx
"use client";

import { useState } from "react";
import { AlertTriangle, ChevronRight } from "lucide-react";

import { CallStats } from "@/components/voice/CallStats";
import { ConnectionStatus } from "@/components/voice/ConnectionStatus";
import { Transcript } from "@/components/voice/Transcript";
import { VoiceControls } from "@/components/voice/VoiceControls";
import { VoiceOrb } from "@/components/voice/VoiceOrb";
import { VoiceWaveform } from "@/components/voice/VoiceWaveform";
import type { VoiceSessionController } from "@/hooks/useVoiceSession";
import type { VoiceStatus } from "@/lib/gemini/types";
import { cn } from "@/lib/utils";

const HEADLINE: Record<VoiceStatus, string> = {
  idle: "Ready to talk",
  connecting: "Connecting…",
  listening: "Listening",
  thinking: "Thinking…",
  speaking: "Speaking",
  interrupted: "Go ahead",
  error: "Something went wrong",
};

export function PreviewSession({
  voice,
  onStart,
}: {
  voice: VoiceSessionController;
  onStart: () => void;
}) {
  const [sessionOpen, setSessionOpen] = useState(false);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-col items-center rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-6">
        <VoiceOrb status={voice.status} levels={voice.levels} />
        <p className="mt-3 text-base font-medium text-[var(--text)]">{HEADLINE[voice.status]}</p>
        <div className="mt-4 w-full">
          <VoiceWaveform status={voice.status} levels={voice.levels} />
        </div>
        <div className="mt-5">
          <VoiceControls
            status={voice.status}
            muted={voice.muted}
            onStart={onStart}
            onStop={voice.stop}
            onToggleMute={voice.toggleMute}
          />
        </div>
      </div>

      {voice.error && (
        <p
          role="alert"
          className="animate-fade-rise flex items-start gap-2.5 rounded-xl border border-[var(--danger)]/35 bg-[var(--danger)]/10 px-4 py-3 text-sm text-[var(--danger)]"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{voice.error}</span>
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        <Transcript
          entries={voice.transcript}
          status={voice.status}
          onClear={voice.clearTranscript}
        />
      </div>

      <div>
        <button
          type="button"
          onClick={() => setSessionOpen((value) => !value)}
          aria-expanded={sessionOpen}
          className="inline-flex items-center gap-1 text-xs font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
        >
          <ChevronRight className={cn("size-3.5 transition-transform", sessionOpen && "rotate-90")} />
          Session
        </button>
        {sessionOpen && (
          <div className="mt-2 flex flex-col gap-3">
            <ConnectionStatus
              status={voice.status}
              session={voice.session}
              metrics={voice.metrics}
            />
            <CallStats metrics={voice.metrics} session={voice.session} />
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write the panel shell**

Create `components/preview/PreviewPanel.tsx`:

```tsx
"use client";

import { X } from "lucide-react";

import { PreviewSession } from "@/components/preview/PreviewSession";
import { Button } from "@/components/ui/button";
import type { VoiceSessionController } from "@/hooks/useVoiceSession";

/**
 * A slide-over for talking to the agent, mounted by the console chrome rather
 * than by a page. Closing it never ends a call — the session lives above this
 * component, so the call continues and the sidebar shows it is live.
 */
export function PreviewPanel({
  open,
  onClose,
  voice,
  onStart,
  agentName,
}: {
  open: boolean;
  onClose: () => void;
  voice: VoiceSessionController;
  onStart: () => void;
  agentName: string;
}) {
  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-label="Test agent"
        className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-xl sm:w-[420px]"
      >
        <header className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
          <span className="truncate text-sm font-semibold text-[var(--text)]">{agentName}</span>
          <Button variant="ghost" size="icon" aria-label="Close preview" className="ml-auto" onClick={onClose}>
            <X />
          </Button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col p-4">
          <PreviewSession voice={voice} onStart={onStart} />
        </div>
      </aside>
    </>
  );
}
```

- [ ] **Step 3: Mount it in the chrome**

In `components/shell/ConsoleChrome.tsx`, add the imports and the session hook, and replace the placeholder:

```tsx
import { PreviewPanel } from "@/components/preview/PreviewPanel";
import { useAgentConfig } from "@/components/agent-config/AgentConfigProvider";
import { useVoiceSession } from "@/hooks/useVoiceSession";
```

```tsx
  const { config } = useAgentConfig();
  // Held here, above the router, so navigating between screens cannot tear down
  // an in-flight call.
  const voice = useVoiceSession();
```

```tsx
      <PreviewPanel
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        voice={voice}
        onStart={() => void voice.start()}
        agentName={config.agentName}
      />
```

- [ ] **Step 4: Verify**

```bash
npm test && npm run typecheck && npm run lint && npm run build
```
Expected: all clean.

Manually, with `npm run dev:web` and `npm run dev:gateway` both running: open the panel from the sidebar, start a call, speak, confirm the transcript fills and the Session block reports the model and voice from the configuration. Then, **while the call is live**, navigate from Conversation to Advanced and confirm the call keeps running and the transcript keeps updating. That is the whole point of mounting it here.

- [ ] **Step 5: Commit**

```bash
git add components/preview components/shell/ConsoleChrome.tsx
git commit -m "feat: add the agent preview panel"
```

---

### Task 8: The two preview hazards

Both follow from configuration being resolved once at call start.

**Files:**
- Create: `lib/agent-config/preview-hints.ts`
- Test: `lib/agent-config/preview-hints.test.ts`
- Modify: `components/preview/PreviewPanel.tsx`
- Modify: `components/shell/ConsoleChrome.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `needsSaveChoice(dirty: boolean): boolean`, `settingsChangedDuringCall(startedWith: string | null, current: string): boolean`.

- [ ] **Step 1: Write the failing test**

Create `lib/agent-config/preview-hints.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { needsSaveChoice, settingsChangedDuringCall } from "./preview-hints";

test("asks how to proceed only when there are unsaved edits", () => {
  assert.equal(needsSaveChoice(true), true);
  assert.equal(needsSaveChoice(false), false);
});

test("reports a settings change made during a call", () => {
  assert.equal(settingsChangedDuringCall("2026-08-16T10:00:00.000Z", "2026-08-16T10:05:00.000Z"), true);
});

test("reports no change when the saved stamp is untouched", () => {
  assert.equal(settingsChangedDuringCall("2026-08-16T10:00:00.000Z", "2026-08-16T10:00:00.000Z"), false);
});

test("reports no change when no call is running", () => {
  assert.equal(settingsChangedDuringCall(null, "2026-08-16T10:05:00.000Z"), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './preview-hints'`.

- [ ] **Step 3: Write the implementation**

Create `lib/agent-config/preview-hints.ts`:

```ts
/**
 * The two things a tester needs told, both consequences of configuration being
 * resolved once when a call starts.
 *
 * Kept pure and separate from the panel so the rules are testable and stated in
 * one place rather than buried in JSX.
 */

/**
 * True when starting a call would test something other than what is on screen.
 * The gateway reads the SAVED configuration, so unsaved edits would be absent
 * and the natural conclusion — "my change did nothing" — would be wrong.
 */
export function needsSaveChoice(dirty: boolean): boolean {
  return dirty;
}

/**
 * True when the configuration was saved after the current call began, so the
 * running call is still using the older settings.
 *
 * `startedWith` is null when no call is running.
 */
export function settingsChangedDuringCall(
  startedWith: string | null,
  current: string,
): boolean {
  if (startedWith === null) return false;
  return startedWith !== current;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 64 tests.

- [ ] **Step 5: Track the configuration a call started with**

In `components/shell/ConsoleChrome.tsx`, record the saved stamp when a call begins and clear it when the session returns to idle:

```tsx
  const [callStartedWith, setCallStartedWith] = useState<string | null>(null);

  const startCall = useCallback(async () => {
    setCallStartedWith(config.updatedAt);
    await voice.start();
  }, [config.updatedAt, voice]);

  useEffect(() => {
    if (voice.status === "idle") setCallStartedWith(null);
  }, [voice.status]);
```

Add `useCallback` and `useEffect` to the React import. Pass `startCall` to the panel as `onStart`, and pass `callStartedWith` through.

- [ ] **Step 6: Add the two hints to the panel**

In `components/preview/PreviewPanel.tsx`, widen the props with `dirty: boolean`, `callStartedWith: string | null`, `currentUpdatedAt: string`, `onSaveAndStart: () => void`, and render the two states.

Above `PreviewSession`, when a start is requested while dirty, show the choice instead of starting silently:

```tsx
      {choosing && (
        <div className="mx-4 mt-4 rounded-xl border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-4">
          <p className="text-sm text-[var(--text)]">
            You have unsaved changes. A test call uses the last saved settings.
          </p>
          <div className="mt-3 flex gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setChoosing(false);
                onSaveAndStart();
              }}
            >
              Save and test
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setChoosing(false);
                onStart();
              }}
            >
              Test last saved
            </Button>
          </div>
        </div>
      )}
```

Hold `choosing` in the panel's own state, set by intercepting the start button:

```tsx
  const [choosing, setChoosing] = useState(false);

  const requestStart = () => {
    if (needsSaveChoice(dirty)) {
      setChoosing(true);
      return;
    }
    onStart();
  };
```

Pass `requestStart` to `PreviewSession` as its `onStart`.

Below the header, when the configuration changed mid-call:

```tsx
      {settingsChangedDuringCall(callStartedWith, currentUpdatedAt) && (
        <p className="mx-4 mt-4 rounded-xl bg-[var(--surface-3)] px-4 py-2.5 text-xs text-[var(--text-muted)]">
          Settings saved — restart the call to hear them.
        </p>
      )}
```

- [ ] **Step 7: Wire save-and-start**

In `ConsoleChrome`, add the handler that only starts when the save actually succeeded — this is why `save()` returns a boolean:

```tsx
  const saveAndStartCall = useCallback(async () => {
    const ok = await save();
    if (!ok) return; // The provider has already routed to the failing field.
    setCallStartedWith(config.updatedAt);
    await voice.start();
  }, [save, config.updatedAt, voice]);
```

Take `save` from `useAgentConfig()` and pass `saveAndStartCall` as `onSaveAndStart`.

- [ ] **Step 8: Verify**

```bash
npm test && npm run typecheck && npm run lint && npm run build
```
Expected: 64 tests; everything clean.

Manually: edit the instructions without saving, open the panel, press start — confirm the choice appears rather than a call starting. Choose "Save and test" and confirm the call starts with the new prompt. Then, during a live call, change a setting and save, and confirm the "restart the call" line appears.

- [ ] **Step 9: Commit**

```bash
git add lib/agent-config/preview-hints.ts lib/agent-config/preview-hints.test.ts components/preview components/shell
git commit -m "feat: warn when a test would use stale settings"
```

---

### Task 9: Live-call state in the sidebar

**Files:**
- Modify: `components/shell/ConsoleChrome.tsx`

**Interfaces:**
- Consumes: `Sidebar`'s existing `callActive` / `callSeconds` props from Task 4.
- Produces: nothing new.

- [ ] **Step 1: Track elapsed call time**

In `components/shell/ConsoleChrome.tsx`:

```tsx
  const callActive = voice.status !== "idle" && voice.status !== "error";
  const [callSeconds, setCallSeconds] = useState(0);

  useEffect(() => {
    if (!callActive) {
      setCallSeconds(0);
      return;
    }
    // A plain interval is enough here: this drives a once-per-second label, not
    // anything the audio path depends on.
    const timer = setInterval(() => setCallSeconds((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [callActive]);
```

- [ ] **Step 2: Feed the sidebar**

Replace the placeholder props:

```tsx
      <Sidebar
        onTestAgent={() => setPreviewOpen(true)}
        callActive={callActive}
        callSeconds={callSeconds}
      />
```

- [ ] **Step 3: Verify**

```bash
npm test && npm run typecheck && npm run lint && npm run build
```
Expected: all clean.

Manually: start a call, close the panel, and confirm the sidebar button shows a pulsing dot with a counting timer, that clicking it reopens the panel with the call still running, and that the timer resets when the call ends.

- [ ] **Step 4: Commit**

```bash
git add components/shell/ConsoleChrome.tsx
git commit -m "feat: show a live call in the sidebar while the panel is closed"
```

---

### Task 10: Delete the console, update the README, verify the whole thing

**Files:**
- Delete: `components/voice/VoiceAgent.tsx`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing new.

- [ ] **Step 1: Delete the old console shell**

```bash
git rm components/voice/VoiceAgent.tsx
```

Its parts already live elsewhere: the voice components moved into the preview panel in Task 7, and `AudioUploader` became its own route in Task 5.

- [ ] **Step 2: Confirm nothing referenced it**

```bash
grep -rn "VoiceAgent" --include='*.ts' --include='*.tsx' app components hooks lib server types
```
Expected: no output.

- [ ] **Step 3: Update the README's file tree**

Find the tree and make these changes by content, not line number:

- Remove the `page.tsx` entry describing the voice console; it is now a redirect.
- Remove the `configure/page.tsx` entry.
- Remove the `VoiceAgent.tsx` entry.
- Add under `app/`:
  ```
    (console)/                          sidebar shell, config state, preview panel
      agent/{conversation,actions,advanced}/  the three agent screens
      models-voice/                     model, voice, language, turn taking
      upload/                           the non-real-time Upload Audio path
  ```
- Add under `components/`:
  ```
    shell/                              Sidebar, ConsoleChrome, DirtyNavGuard
    preview/                            PreviewPanel, PreviewSession
  ```
- Add under `lib/agent-config/`: `routes.ts` and `preview-hints.ts`.

- [ ] **Step 4: Replace the "Configuring the agent" section**

The section currently tells the reader to open `/configure`. Replace that sentence:

```markdown
## Configuring the agent

Open the app and use the sidebar. **Agent** holds Conversation, Actions and
Advanced; **Models & Voice** and **Upload Audio** sit alongside it.

Configuration is saved to `data/agent-config.json` and read fresh at the start of
every call, so a change takes effect on the next call with no restart. A call
already in progress keeps the settings it started with — the preview panel says
so when you save mid-call.

**Test agent** in the sidebar opens a preview panel where you can talk to the
agent from any screen. A call keeps running while you navigate, and while the
panel is closed; ending it is always explicit. If you start a test with unsaved
edits, the panel asks whether to save first, because the call would otherwise
use the last saved settings.

Secret *values* are written to `data/agent-secrets.json` (gitignored, mode 0600)
and are never sent to the browser.
```

- [ ] **Step 5: Full verification**

```bash
npm test
```
Expected: 64 tests, 0 failures.

```bash
npm run typecheck && npm run lint && npm run build
```
Expected: all clean, no `/configure` route in the build output.

```bash
grep -rn "VoiceAgent\|AgentConfigForm\|/configure\|tabForPath" --include='*.ts' --include='*.tsx' app components hooks lib server types
```
Expected: no output.

- [ ] **Step 6: End-to-end pass**

Run `npm run dev` (both processes) and walk it:

1. `/` redirects to `/agent/conversation`; the sidebar shows Agent → Conversation / Actions / Advanced, then Models & Voice and Upload Audio.
2. Edit the instructions. The save bar appears. Navigate to Advanced — the edit survives and is still unsaved.
3. Click Upload Audio — a confirmation appears. Cancel; the edit is still there.
4. Save. Confirm the bar clears.
5. Open **Test agent**, start a call, speak, and confirm a reply plus a filling transcript.
6. While the call runs, navigate to Models & Voice. The call continues.
7. Close the panel. The sidebar shows a live indicator and a counting timer. Reopen it — the call is still there.
8. End the call. The indicator clears.
9. Edit the welcome message without saving, press start — confirm the save-or-test choice, take "Save and test", and confirm the agent greets you with the new text.
10. Save a change during a live call and confirm the "restart the call" line.
11. `/upload` still transcribes and answers a recording, now in the language configured under Models & Voice rather than always Bangla.
12. `cat data/agent-config.json` — readable, no secret values.

Report which steps you verified and which you could not.

- [ ] **Step 7: Commit**

```bash
git add -A components README.md
git commit -m "feat: retire the standalone voice console"
```

---

## Self-Review

**Spec coverage:** Navigation → Tasks 4, 5. State above the router → Task 3, 5. Preview above the router → Task 7. Error routing → Task 3. Deletions → Tasks 5, 10. Sidebar responsive behaviour → Task 4. Save bar only on config routes → Task 5 (`CONFIG_ROUTES`). Preview shape → Task 7. The two hazards → Task 8. Closing behaviour → Tasks 7, 9. Folded fixes: store logger + secrets recoverability → Task 1; upload language + dead exports → Task 2; unsaved-edit navigation → Task 6. Testing → Tasks 1, 3, 8 plus the manual passes.

**Verified against the real code before writing:** `ActionsTab()` takes no props, so its page passes none. `Transcript({entries, status, onClear})`, `ConnectionStatus({status, session, metrics})`, `CallStats({metrics, session})` and `VoiceControls({status, muted, onStart, onStop, onToggleMute})` all match the calls in Task 7. `CallStats` already renders `session?.voice`, so putting it in the Session block resolves the review's "voice is displayed nowhere" finding with no extra step — do not add one.

**Type consistency:** `TabProps` is defined once in `AgentConfigProvider.tsx` and imported by the three editing tabs (Task 3, step 7). `save()` returns `Promise<boolean>` in Task 3 and is consumed as a boolean in Task 8, step 7. `VoiceSessionController` is the existing exported type from `hooks/useVoiceSession.ts`. `Sidebar`'s `callActive` / `callSeconds` props are declared in Task 4 and supplied in Task 9. `routeForPath` returns `AgentRoute | null` and every caller handles the null.

**Deliberate deviations from the spec:**

1. **`ConsoleChrome` is a component the spec did not name.** The spec put the sidebar, save bar and preview in `layout.tsx`, but a layout that reads the config on the server must be a server component, and all three need client state. Splitting the client chrome out is the smallest way to have both.
2. **The spec's "no toggle" for Inline/Widget is implemented as genuinely absent**, not as a disabled control — as agreed during design.
3. **Test count rises from 51 to 64**, adding 4 store tests, 5 route tests and 4 preview-hint tests.
