# Actions Configuration — Design

Date: 2026-08-16
Status: Approved
Design preview: the clickable mock approved before this spec was written.

## Problem

The Actions screen is an empty state naming three things that do not exist:
HTTP tools, client tools and webhooks. This spec defines all three as
configuration — their data model, validation, persistence and editing UI.

## Scope

In scope — **configuration and persistence only**:

- Three tool kinds defined, validated, stored and edited.
- The Actions screen: three sections, each listing what is configured, each
  with an Add control.
- Three modal forms, matching the approved preview.
- Secret references (`{{SECRET_NAME}}`) captured in header values as text.

Out of scope, and the next piece of work:

- **Execution.** Nothing built here causes the agent to call anything. Turning
  these definitions into Gemini function declarations, handling tool-call
  events, performing the HTTP requests server-side, resolving `{{SECRET}}`
  references, honouring `silent` and `awaitResult`, and delivering webhook
  events are all the following project. That work reopens the live call path;
  this one does not touch it.
- **Response mocks** and the preview panel's "Mock tools" toggle. They exist to
  test execution, so they belong with it.

Because nothing executes yet, the Actions screen states plainly that these
definitions are saved but not yet called. Shipping a form that looks live and
silently does nothing is worse than shipping one that says what it is.

## Storage

Everything goes in the existing `data/agent-config.json`, written through
`server/config/store.ts` — atomic temp-file-and-rename, validated on read,
falling back to seed defaults when unreadable. No new file, no new store, no
new dependency. A database can replace the store later behind the same
interface.

Secret *values* remain in the separate gitignored `data/agent-secrets.json` and
are never part of this data. A tool header holds only the reference text.

## Data model

Added to `lib/agent-config/schema.ts`.

```ts
export type ToolValueType = "string" | "number" | "boolean";
export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";
export type WebhookEvent = "call_started" | "call_ended" | "transcript_ready";
export type RetryPolicy = "none" | "once" | "backoff";

/** A value the model works out from the conversation and passes to a tool. */
export interface ToolParameter {
  id: string;              // stable React key, not sent anywhere
  name: string;            // identifier; the model uses this
  type: ToolValueType;
  description: string;     // the model reads this to fill the value
  required: boolean;
}

/** A name/value pair. `value` may contain {{SECRET_NAME}} references. */
export interface ToolHeader {
  id: string;
  name: string;
  value: string;
}

export interface HttpTool {
  id: string;
  name: string;            // identifier the model calls
  description: string;     // "when to use it" — read by the model
  method: HttpMethod;
  url: string;             // may contain {path_params} in braces
  parameters: ToolParameter[];
  headers: ToolHeader[];
  /** Run without narrating the call or speaking the result. */
  silent: boolean;
}

export interface ClientTool {
  id: string;
  name: string;
  description: string;
  parameters: ToolParameter[];
  /** Hold the agent's turn until the browser replies. */
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
```

`AgentConfig` gains one field:

```ts
  tools: ToolsConfig;
```

### Why webhooks are not a third kind of tool

The reference product presents webhooks alongside tools. They are a different
thing and the model shows it: a tool is *called by the agent*, so it needs a
description the model reads and parameters the model fills. A webhook is
*fired by a call event*, so it has neither — it has an event list and a retry
policy instead. Modelling them the same way would put meaningless fields on
both. They are separate types with separate forms.

## Validation

Extends `validateAgentConfig` in the same accumulate-all-errors style, so the
form can highlight every bad field at once.

**Compatibility, and a trap worth naming.** `read()` now runs every stored
config through `validateAgentConfig`. Every config written before this change
lacks `tools`. If the validator required the field, every existing saved
configuration would fail validation on the next read and silently fall back to
seed defaults — the user's prompt, voice and variables replaced without a word.
So `tools` is **optional on input** and defaults to `{http: [], client: [], webhooks: []}`.
A test asserts a `tools`-less config still loads with its other fields intact.

Rules:

- `name` on every tool and webhook: matches `/^[a-z][a-z0-9_]*$/`, 2–64 chars.
  Lowercase-with-underscores because these become function names.
- **Tool names are unique across HTTP *and* client tools together.** Both kinds
  are declared to the model in one namespace, so a collision would make one
  unreachable. Webhook names live in their own namespace and only need to be
  unique among webhooks.
- `description`: non-empty, max 2 000 characters. It is a prompt, not a label.
- `url`: non-empty, max 2 000, and must parse as an absolute `http:` or
  `https:` URL once its `{brace}` segments are substituted with a placeholder.
- `parameters[].name`: identifier pattern, unique within its tool.
- `headers[].name`: matches `/^[A-Za-z0-9-]+$/`.
- Counts capped: 25 HTTP tools, 25 client tools, 25 webhooks, 25 parameters and
  25 headers each.
- `events`: at least one, when the webhook exists at all.

Unknown `{{SECRET}}` references are **not** validation errors — the secret may
be added afterwards. The editor shows them as a warning, the same way the
prompt editor treats undeclared `{variables}`.

Path parameters in a URL (`{order_id}`) that have no matching entry in
`parameters` are likewise a warning, not an error.

## Editing UI

`ActionsTab` becomes three sections. Each shows what is configured — method
chip, name in mono, description, a `Silent` tag where set — with an Add control
in the section header and Edit and Delete per row. An empty section explains
what that kind of action is for rather than showing a bare "none".

Three modal forms, matching the approved preview:

- **HTTP tool** — name, when-to-use, method and URL, parameters, headers,
  silent.
- **Client tool** — name, when-to-use, parameters, wait-for-result.
- **Webhook** — name, description, method and URL, event checkboxes, headers,
  and an Advanced fold holding query parameters and the retry policy.

A new `components/ui/modal.tsx` wraps the native `<dialog>` element: focus
moves into the dialog on open, Escape closes, the backdrop closes, and focus
returns to the control that opened it. The repo has no modal primitive today.

Field labels are the preview's, not the underlying property names. The
description field is labelled **"When to use it"** because it is a prompt the
model reads to decide whether to call the tool, and naming it for its job
produces better text than calling it a description.

Typing `{order_id}` into an HTTP tool's URL offers to add the matching
parameter, so the same name is not declared twice.

Editing is local until the form's own Save; the modal's Cancel discards. The
tools themselves are part of the ordinary configuration, so they participate in
the console's existing dirty state and Save bar — unlike secrets, which save
immediately to their own endpoint.

## Error handling

- **A stored config with no `tools`** — loads with empty collections. Not an
  error.
- **A stored config with a malformed `tools`** — fails validation like any other
  field; `read()` logs and falls back to defaults, leaving the file on disk
  recoverable, exactly as it does today.
- **Save rejected (400)** — errors map by dotted path
  (`tools.http.0.name`) and the console navigates to the Actions screen, using
  the existing `routeForPath`, which needs a `tools` prefix added.
- **Duplicate name across tool kinds** — reported on the second occurrence, so
  the field the user just edited is the one highlighted.

## Testing

Pure logic gets tests in the existing `node:test` suite, which stands at 65:

- Validation: name pattern, cross-kind uniqueness, URL parsing with and without
  brace segments, parameter-name uniqueness within a tool, the count caps, the
  empty-events rule.
- **Backward compatibility**: a config with no `tools` validates, defaults to
  empty collections, and keeps every other field.
- `routeForPath("tools.http.0.name")` resolves to the Actions screen.
- Brace-parameter extraction from a URL.

The forms are verified by typecheck, lint, a production build, and a manual
pass: add one of each kind, save, reload, confirm it persists in
`data/agent-config.json`; provoke a duplicate name and confirm the error lands
on the right field.

## Open questions

None. Execution is scoped out and named above.
