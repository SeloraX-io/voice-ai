# Agent Configuration UI — Design

Date: 2026-08-16
Status: Approved

## Problem

The agent's persona, language, sampling settings and voice are hardcoded as
constants in `server/voice/agent-config.ts` and `lib/gemini/types.ts`. Changing
how the agent behaves means editing TypeScript and restarting the gateway. There
is no way to parameterise a prompt, no way to define a greeting, and nowhere to
put the credentials that HTTP tools will need in the next phase.

This design adds a configuration subsystem: a persisted agent config, an editor
UI modelled on LiveKit's agent settings, and the runtime plumbing that makes a
saved config take effect on the next call.

## Scope

In scope:

- A single agent config (not a multi-agent workspace).
- Tabs: Conversation, Models & Voice, Advanced — all functional. Actions ships
  as an empty state.
- Custom variables (`{name}`) interpolated into the instructions and welcome
  message from their preview values.
- Secrets storage, write-only over the API, for the next phase's HTTP tools.
- Removal of the dark theme; light becomes the only theme.

Out of scope (explicitly deferred):

- HTTP tools, client tools, webhooks — the Actions tab's real content.
- Data collection conversation type.
- Multi-agent management, telephony, dispatch rules.
- Variable values sourced from anywhere other than preview values.

## Architecture

The Next.js app and the voice gateway are separate Node processes started by
`npm run dev` via `concurrently`. Both run with the repo root as their working
directory. Config therefore crosses the process boundary through a shared file
store rather than a new transport.

```
Browser (config UI at /configure)
   │  GET / PUT  /api/agent-config
   ▼
Next route handler
   │
   ▼
lib/agent-config/schema.ts     types, defaults, validation (pure, shared)
lib/agent-config/template.ts   {variable} scanning + interpolation (pure, shared)
   │
   ▼
server/config/store.ts         atomic read / write
   │
   ├── data/agent-config.json    no secrets, safe to inspect
   └── data/agent-secrets.json   gitignored, chmod 0600
   │
   ▼
Gateway reads FRESH at each call start
   │
   ▼
resolveAgentConfig() ──► GeminiVoiceSession.create(events, resolved)
```

Reading the config fresh at the start of every call means a saved edit takes
effect on the next call with no restart and no cache to invalidate. In-flight
calls keep the config they started with, which is the correct behaviour — a
prompt must not change underneath a live conversation.

`server/voice/agent-config.ts` stops being the live source of truth and becomes
the seed defaults: the existing Bangla system instruction, `bn-IN`, temperature
0.7 and topP 0.9 are used verbatim when `data/agent-config.json` does not yet
exist. No current behaviour is lost on first run.

## Data model

Defined in `lib/agent-config/schema.ts`, imported by both the browser and the
gateway.

```ts
export type ConversationType = "open_ended" | "data_collection";
export type VariableType = "string" | "number" | "boolean";

export interface AgentVariable {
  id: string;            // stable key for React lists; not user-visible
  type: VariableType;
  name: string;          // /^[A-Za-z_][A-Za-z0-9_]*$/, unique within the config
  previewValue: string;  // always stored as a string; coerced by type on resolve
}

export interface WelcomeConfig {
  enabled: boolean;
  message: string;
  allowInterrupt: boolean;
}

export interface VadConfig {
  startSensitivity: "high" | "low";
  endSensitivity: "high" | "low";
  silenceDurationMs: number;   // 100–2000
  prefixPaddingMs: number;     // 0–500
}

export interface ModelsConfig {
  liveModel: string;
  voice: string;
  languageCode: string;
  temperature: number;   // 0–2
  topP: number;          // 0–1
  vad: VadConfig;
}

export interface AgentConfig {
  version: 1;
  type: ConversationType;
  instructions: string;
  welcome: WelcomeConfig;
  models: ModelsConfig;
  agentName: string;        // /^[a-z0-9][a-z0-9-]{1,62}$/
  variables: AgentVariable[];
  secretKeys: string[];     // NAMES ONLY — values live in agent-secrets.json
  updatedAt: string;        // ISO 8601
}
```

`version` exists so a future shape change can migrate rather than crash. A
config with an unrecognised `version` is rejected by the store, which falls back
to defaults and logs loudly rather than silently discarding a user's work.

### Validation

`validateAgentConfig(input: unknown): { config: AgentConfig } | { errors: FieldError[] }`
lives in `schema.ts` and is the single validation implementation. The browser
calls it for instant inline feedback; the `PUT` handler calls it again on the
raw request body. The server never trusts the client's copy.

Rules:

- `instructions` — non-empty, max 32 000 characters.
- `welcome.message` — max 2 000 characters; may be empty only when
  `welcome.enabled` is false.
- `agentName` — lowercase slug, 2–63 characters.
- `variables[].name` — matches the identifier pattern, unique, max 64 chars.
- `variables[].previewValue` — for `number`, must parse as a finite number; for
  `boolean`, must be `"true"` or `"false"`.
- `models.temperature`, `models.topP`, and the VAD numbers are range-clamped and
  rejected if non-finite.
- `type` — `"data_collection"` is rejected with a "not yet supported" error.
  The type exists in the union so the UI can render the disabled radio without
  casting.

Unknown `{tokens}` in the instructions or welcome message are **not** validation
errors. They surface as a non-blocking warning in the editor and pass through
literally at runtime, because a prompt legitimately may contain braces.

### Secrets

Secret values are stored in `data/agent-secrets.json` as a flat
`Record<string, string>`, written with mode `0600`, and listed in `.gitignore`.
They are stored in plaintext. Encrypting them with a key held in the same `.env`
file on the same disk would be security theatre, not security; real secret
management is a deployment concern outside this design.

The API contract makes them write-only:

- `GET /api/agent-config` returns `secretKeys: string[]` — names only. Values
  are never serialised to the browser under any circumstance.
- `POST /api/agent-config/secrets` with `{ key, value }` creates or replaces one
  secret.
- `DELETE /api/agent-config/secrets?key=NAME` removes one.

Secrets are not read by anything in this phase. They exist so the HTTP tools
work in the next phase has a place to read credentials from.

## Runtime behaviour

### Resolution

At call start the gateway loads the config and calls
`resolveAgentConfig(config)`, which returns a `ResolvedAgentConfig` — the same
shape with `instructions` and `welcome.message` already interpolated.

`interpolate(text, variables)` in `template.ts` replaces each `{name}` where
`name` matches a declared variable. `number` and `boolean` preview values are
coerced from their stored string form, then stringified. Tokens with no matching
declaration are left exactly as written. Replacement is single-pass: a value
that itself contains `{other}` is not re-expanded, which prevents both surprise
and infinite recursion.

### Speaking the welcome message

Gemini Live has no native "say this first" field. When `welcome.enabled` is
true, the gateway:

1. Appends `Open the call by saying exactly: "<resolved message>"` to the system
   instruction.
2. Sends a priming turn immediately after the session opens so the model
   produces the first turn instead of waiting for the customer.

This is a directive to a language model, so the greeting will be near-verbatim
rather than byte-exact. That is an accepted limitation of the approach, recorded
here so it is not rediscovered as a bug.

When `welcome.enabled` is false, neither the directive nor the priming turn is
sent and the model waits for the customer to speak first.

The existing seed instruction contains the line
`- Open the call with a short Bangla greeting and ask how you can help.` That
line stays in the seed prompt; it is the user's text to edit or remove once the
welcome message is configured.

### Greeting interruption

`welcome.allowInterrupt: false` is enforced in the gateway, not in the prompt.

`CallState` gains a `greetingActive: boolean`, set true when the priming turn is
sent and cleared on the first `turn_complete`. While `greetingActive` is true
and interruption is disallowed, `handleClientFrame` drops inbound `audio` frames
instead of forwarding them to Gemini, so server-side VAD never observes a
barge-in. Local VAD still runs, so the console's UI meters stay live — only the
upstream forward is suppressed.

A safety timeout clears `greetingActive` after 30 seconds regardless, so a
malformed turn can never permanently deafen the agent.

When `allowInterrupt` is true, behaviour is identical to today.

### Models & Voice

`models.liveModel`, `voice`, `languageCode`, `temperature` and `topP` replace
the constants currently read at `gemini-session.ts:65-77`. The `vad` block maps
directly onto the `automaticActivityDetection` object at `gemini-session.ts:83`,
with the string sensitivities mapped to the `StartSensitivity` /
`EndSensitivity` enums.

`session_started` already reports `model` and `voice` to the client; both now
come from the resolved config rather than the module constants, so the console's
status readout reflects what is actually running.

## UI

A new route `/configure`, linked from the console header. The existing read-only
"Session configuration" panel in `VoiceAgent.tsx` is removed — it describes
settings that become editable here, and keeping both would mean two places
claiming to describe one thing.

```
app/configure/page.tsx           loads config server-side, renders the form
components/agent-config/
  AgentConfigForm.tsx            shell: tabs, dirty tracking, save / discard
  ConversationTab.tsx            type radios, instructions, welcome message
  ModelsVoiceTab.tsx             model, voice, language, temperature, topP, VAD
  ActionsTab.tsx                 empty state for the next phase
  AdvancedTab.tsx                agent name, variables, secrets
  VariableInsertMenu.tsx         "+ Insert variable" popover
  PromptPreview.tsx              resolved prompt with preview values
```

New primitives in `components/ui/`, matching the existing `button.tsx` and
`tabs.tsx` house style: `Input`, `Textarea`, `Select`, `Switch`, `Checkbox`,
`Field` (label + description + error slot).

### Interaction rules

- **Insert variable** appears above both the instructions and the welcome
  textarea. It lists declared variables and inserts `{name}` at the caret,
  restoring focus and selection afterwards. With none declared it shows a link
  to the Advanced tab.
- **Prompt preview** is a collapsible panel under the instructions showing the
  text with preview values substituted, and a warning listing any `{tokens}`
  that match no declared variable.
- **Saving is explicit.** A dirty-state bar exposes Save and Discard; a
  `beforeunload` guard and an in-app confirmation prevent losing edits. There is
  no autosave — a half-typed prompt must not become the live persona.
- **Renaming a variable does not rewrite the prompt.** The prompt keeps the old
  token, which then shows in the unknown-token warning. Silent find-and-replace
  inside a user's prompt is more dangerous than a visible warning.
- **Deleting a variable** used in the prompt warns before removal, naming where
  it is used.
- **Secrets** render as a list of names with a delete control, and an "Add
  secret" form taking a key and a value. An existing key's value shows as
  `••••••` and can only be replaced, never read.

### Data collection

The Type radio renders both options exactly as in the reference. "Data
collection" is disabled, marked "Coming soon", and rejected server-side. It
requires a field-schema builder and an extraction pipeline, which is a separate
project.

## Theme removal

Light becomes the only theme. Every CSS custom property keeps its name, so no
component's `var(--surface-2)` reference changes.

- `app/globals.css` — remove the `:root[data-theme="dark"]` block; promote the
  light values from `:root[data-theme="light"]` onto a bare `:root` with
  `color-scheme: light`.
- `app/layout.tsx` — remove `THEME_BOOTSTRAP`, the inline `<script>`, the
  `<head>` element, and `data-theme="dark"` from `<html>`.
- Delete `components/ThemeToggle.tsx` and its import and use in
  `VoiceAgent.tsx`.
- Audit components tuned against the near-black `#06060a` ground for contrast on
  a light background: `VoiceOrb.tsx`, `VoiceWaveform.tsx`, the `body::before`
  ambient gradients, and any `/10`-style alpha fills that assumed a dark base.

The stale `localStorage["voice-agent-theme"]` key is left alone; nothing reads
it after this change.

## Error handling

- **Missing config file** — the store returns seed defaults. Not an error; this
  is the first-run path.
- **Corrupt or unparseable config file** — the store logs the failure and
  returns seed defaults rather than crashing the gateway. A call always
  connects.
- **Unknown `version`** — rejected, defaults used, logged loudly. The file is
  left on disk untouched so the user's data is recoverable.
- **`PUT` validation failure** — `400` with a `FieldError[]` body; the form maps
  errors to fields and switches to the tab holding the first error.
- **Write failure** — writes go to a temp file in the same directory and are
  atomically renamed, so a crash mid-write can never truncate a good config. A
  failed write returns `500` and leaves the previous config intact.
- **Gateway cannot read config at call start** — falls back to defaults and
  sends the call through rather than failing the connection.

## Testing

The repository has no test runner today, and this design does not add one as a
side effect. Instead:

- `lib/agent-config/schema.ts` and `lib/agent-config/template.ts` are pure,
  dependency-free modules exporting pure functions, so a runner drops in later
  with no restructuring.
- `server/config/store.ts` isolates all filesystem access behind a small
  interface, so it can be faked when tests exist.

Verification for this build:

1. `npm run typecheck` — clean.
2. `npm run lint` — clean.
3. Manual end-to-end: declare a variable, use `{name}` in the instructions and
   the welcome message, save, dial, and confirm the greeting is spoken with the
   substituted value.
4. Manual: set `allowInterrupt: false`, talk over the greeting, and confirm the
   agent finishes it; set it true and confirm barge-in still works.
5. Manual: confirm `GET /api/agent-config` never contains a secret value.
6. Visual: every screen on a light ground with no dark-theme remnants.

## Open questions

None. Deferred items are listed under Scope.
