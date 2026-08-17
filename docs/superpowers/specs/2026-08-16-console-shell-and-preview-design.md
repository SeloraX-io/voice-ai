# Console Shell and Agent Preview — Design

Date: 2026-08-16
Status: Approved
Supersedes parts of: `2026-08-16-agent-config-design.md` (navigation only; the
config data model, store and API from that spec are unchanged)

## Problem

The agent configuration built in the previous phase lives behind a tab bar on a
`/configure` page, reachable from a voice console at `/`. Configuration is now
the main thing this app does, and the console — a full page dedicated to a
single orb and a transcript — occupies the front door.

The tab bar also caps how much the editor can grow. The next phases add HTTP
tools and webhooks, each of which needs real estate a tab strip cannot give.

This design replaces the navigation shell and moves talking to the agent into a
preview panel available from every screen.

## Scope

In scope (pieces A and B of a five-piece plan):

- A left sidebar replacing the tab bar, with the four configuration screens and
  Upload Audio as routes.
- Deleting the standalone voice console page.
- An agent preview panel: a slide-over where you talk to the agent, available
  from anywhere, surviving navigation.
- Four Important findings from the previous phase's whole-branch review, folded
  in because they touch the same code.

Out of scope, deliberately, each its own later project:

- **C — HTTP tools:** schema, storage, the Actions tab's real content.
- **D — Tool execution:** Gemini function declarations, tool-call events,
  server-side HTTP calls, the `silent` flag, and the "Mock tools" toggle.
- **E — Webhooks:** auth connections, path and query parameters, dynamic
  variables and assignments, response mocks, edit-as-JSON.
- **F — Embeddable widget:** a real embeddable chat widget and its embed
  script, and only then a "Widget" mode in the preview that previews something
  that exists.

The Actions screen keeps the empty state it has today until piece C.

## Navigation

```
◈  Voice AI
   AGENT
    › Conversation          /agent/conversation
    › Actions               /agent/actions
    › Advanced              /agent/advanced
   › Models & Voice         /models-voice
   › Upload Audio           /upload
   ─────────────────
   [ ▶  Test agent ]
```

`Conversation`, `Actions` and `Advanced` are grouped under an **Agent** heading.
`Models & Voice` and `Upload Audio` are top-level peers of that group, not
children of it.

`/` redirects to `/agent/conversation`. `/configure` is removed.

The active route is highlighted. "Test agent" opens the preview panel from any
screen, and reflects a live call when one is running (see Preview panel).

The sidebar is a fixed 240px column on screens wide enough for it. Below the
`md` breakpoint it collapses behind a header toggle and overlays the content
when opened, so the editor remains usable on a narrow window. The preview panel
takes the full width on those screens rather than 420px.

## Architecture

### The problem tabs-to-routes creates

Today the four tabs are children of one `AgentConfigForm`, which owns `config`,
`saved`, `dirty`, `errors` and the save and discard actions. Switching tabs is
local state, so edits survive it.

Making those tabs routes would unmount the form on every navigation and discard
unsaved edits without a word. This is the same failure the previous phase's
review found for the "Back to console" link: `beforeunload` does not fire for
client-side navigation.

### Configuration state moves above the router

```
app/(console)/layout.tsx
    Sidebar + AgentConfigProvider + save bar + PreviewPanel
  ├── agent/conversation/page.tsx    → <ConversationTab/>
  ├── agent/actions/page.tsx         → <ActionsTab/>
  ├── agent/advanced/page.tsx        → <AdvancedTab/>
  ├── models-voice/page.tsx          → <ModelsVoiceTab/>
  └── upload/page.tsx                → <AudioUploader/>
```

`AgentConfigProvider` is a client component holding exactly what
`AgentConfigForm` holds today: `config`, `saved`, `dirty`, `errors`, `save()`,
`discard()` and `setSecretKeys()`. It is consumed through a `useAgentConfig()`
hook.

The four tab components are moved unchanged. They currently take a `TabProps`
of `{ config, update, errors, setSecretKeys }`; the hook returns that same
shape, so each route is a thin wrapper that calls the hook and spreads it.
`AgentConfigForm.tsx` is deleted; its state logic moves into the provider
verbatim, including `stableStringify`, the `strip` denylist, and the
save-failure handling.

Consequences, both of which are the point:

- The sticky save bar renders in the layout, so it is visible from every
  configuration route and unsaved edits survive navigation between them.
- Navigating out of the configuration area — to Upload Audio, or away from the
  app — prompts when dirty. This closes review finding #3 properly, because it
  guards client-side navigation rather than only `beforeunload`.

`/upload` sits inside the same route group so it gets the sidebar, but it edits
no configuration. The save bar renders only on the four configuration routes,
not on `/upload`. The preview panel remains available there, since testing the
agent by voice is useful from any screen.

### The preview panel also lives above the router

The panel and its `useVoiceSession` hook are mounted in the layout, not in a
route. If the panel were per-route, navigating from Conversation to Advanced
during a call would unmount the hook, tear down the WebSocket and hang up.

Since configuration is resolved once at call start, moving between screens
during a call is a normal thing to do — to read a setting, or to watch the
transcript while looking at the prompt. It must not end the call.

### Error routing

`tabForPath` becomes `routeForPath`, mapping a validation error's dotted path to
a route rather than a tab id:

| Path prefix | Route |
|---|---|
| `models` | `/models-voice` |
| `agentName`, `variables` | `/agent/advanced` |
| everything else | `/agent/conversation` |
| `""` (form-level) | no navigation |

On a 400 from `PUT /api/agent-config`, the provider maps errors by path and
navigates to the route owning the first field-level error, exactly as the tab
version switched tabs. A form-level error with an empty path must not trigger
navigation.

## What is deleted, moved and kept

**Deleted:**

- `app/page.tsx` — replaced by a redirect to `/agent/conversation`.
- `app/configure/page.tsx` — replaced by the route group.
- `components/voice/VoiceAgent.tsx` — the header and tab shell; its
  responsibilities split between the sidebar and the preview panel.
- `components/agent-config/AgentConfigForm.tsx` — becomes the provider.
- `lib/gemini/types.ts`: the `LIVE_MODEL` and `AGENT_VOICE` constants, now dead
  and carrying doc comments that describe behaviour which moved into the config.

**Moved into the preview panel, unchanged:** `VoiceOrb`, `VoiceWaveform`,
`Transcript`, `VoiceControls`, `ConnectionStatus`, `CallStats`, and the
`useVoiceSession` hook. These are the working parts of the console; they lose
their page, not their implementation.

**Moved under a route, unchanged:** the four tab components and `AudioUploader`.

## Preview panel

### Shape

A right-hand slide-over, 420px wide, full height, over a scrim. The header
carries the agent's name and a close button.

There is no Inline/Widget toggle in this phase. The Widget mode in the
reference product previews an embeddable widget on a simulated customer site;
this app has no embeddable widget, no embed script and no public endpoint. A
disabled control pointing at something that does not exist is dead UI. The
toggle arrives with piece F, when it has two real modes to switch between.

There is no "Mock tools" toggle either: it mocks tool responses, and tools
arrive in pieces C and D. It ships with D, where it has something to mock.

Body, top to bottom:

1. `VoiceOrb`, scaled to the panel.
2. The status headline (`Ready to talk`, `Listening`, `Speaking`, …).
3. `VoiceWaveform`.
4. `VoiceControls` — start, stop, mute.
5. `Transcript`, scrollable, taking the remaining height.
6. A collapsible **Session** block containing `ConnectionStatus` and
   `CallStats` — model, voice, and the latency read-outs.

The Session block is where `session_started.voice` finally renders. It travels
the whole protocol today and is displayed nowhere, because the only surface
that showed it was the read-only panel the previous phase deleted.

### Two hazards this panel must handle

Both follow from the previous phase's rule that configuration is read fresh at
the start of every call and an in-flight call keeps what it started with. That
rule is correct; it needs to be visible here rather than silently surprising.

**1. Starting a test with unsaved edits would mislead.** The gateway reads the
*saved* configuration from disk. Starting a call with a half-edited prompt on
screen tests the previous settings, and the natural conclusion is that the edit
did nothing.

When `dirty` is true and the user starts a call, the panel does not start it
silently. It offers:

- **Save and test** — saves, and starts the call once the save succeeds. If the
  save fails validation, no call starts and the user is routed to the failing
  field exactly as a normal save failure would route them.
- **Test last saved** — starts the call against what is on disk, with the panel
  showing that unsaved edits are not included.

**2. Saving during a call changes nothing until the next call.** If a save
succeeds while a call is running, the panel shows a quiet, non-blocking line:
*"Settings saved — restart the call to hear them."* It clears when the call
ends or restarts.

### Closing behaviour

Closing the panel during a call **leaves the call running**. The sidebar's
"Test agent" control switches to a live state — a pulsing indicator and an
elapsed timer — and reopens the panel on click.

Ending a call is always an explicit action, never a side effect of closing a
panel or navigating. Because configuration is read at call start, moving around
the app mid-call is expected; hanging up in response would be hostile and would
lose a call the user is in the middle of.

## Folded-in fixes from the previous review

These come from the whole-branch review of the configuration phase. They are
included here because they touch the same files, and because building a new
shell on top of a known data-loss bug is not sensible.

**1. The shared store instance swallows every failure.**
`server/config/store.ts` exports `configStore` built with the default no-op
logger, so in the Next process a corrupt or unknown-version `agent-config.json`
falls back to defaults with no output. The gateway constructs its own store
*with* a logger; the Next side never learned the lesson. The user opens the
editor, sees seed defaults, and on save overwrites the file the store
deliberately preserved.

Fix: give the exported instance a real logger.

**2. A corrupt secrets file is silently emptied on the next write.**
`readSecrets` swallows a parse failure into `{}`; `setSecret` then writes that
empty object back over the real file, destroying every stored secret with no log
and no UI signal. The configuration path does the opposite — it leaves a corrupt
file on disk and has a test asserting recoverability.

Fix: `readSecrets` distinguishes *missing* (`{}`, the first-run path) from
*unparseable* (throws). `setSecret` and `deleteSecret` refuse to write over an
unparseable file, and the route's existing catch surfaces a 500.

**Both must be fixed together.** `store.ts` currently logs `String(error)` on a
secrets parse failure. Node's `JSON.parse` `SyntaxError` embeds a snippet of the
offending input — which on that file is secret material. Fixing #1 alone would
make a currently-unreachable log line live and start printing secret fragments
into the server log. On the secrets path, log `error.name` only, never the
message.

**3. Unsaved edits lost on in-app navigation.** Fixed structurally by hoisting
state into the layout, as described in Architecture.

**4. The Upload path hard-codes Bangla.** `app/api/upload/route.ts` injects "the
reply must be in Bangla" into the user turn and into the response schema's
description, while reading `instructions`, `voice` and `languageCode` from the
configuration. Setting Language to English therefore produces an English
question answered in Bangla, spoken with an English `languageCode`.

Fix: remove both Bangla clauses and let `agent.instructions` — which carries the
language rule in the seed persona — and `agent.models.languageCode` govern. The
transcription clause ("in whatever language they used") stays.

**5. Dead exports.** `LIVE_MODEL` and `AGENT_VOICE` deleted, as above.

Remaining minor findings from that review stay deferred.

## Error handling

- **Config load fails at page render** — the layout reads the config server-side
  and passes it to the provider. `store.read()` never throws, so the failure
  mode is seed defaults plus a server log (fix #1 above), not a broken page.
- **Save fails validation (400)** — errors map by path, the provider navigates
  to the route owning the first field-level error, and edits are preserved.
- **Save fails otherwise (500, network)** — a form-level message; edits
  preserved and still dirty.
- **A call fails to start** — the panel shows the existing error banner from
  `useVoiceSession`. The panel stays open.
- **A call drops mid-conversation** — existing behaviour; the panel shows the
  error and returns to idle.
- **Save-and-test where the save fails** — no call starts; the user lands on the
  failing field.

## Testing

The 51 existing tests must continue to pass unchanged; none of them touch React.

New pure logic is thin and gets tests:

- `routeForPath` — one case per path prefix, including the form-level empty path
  mapping to no navigation.
- The start-a-call decision — dirty versus clean, and the save-then-start
  sequencing.

Everything else is UI and is verified by typecheck, lint, production build, and
a manual pass: navigate every route with unsaved edits, confirm the guard fires
leaving the config area; start a call and navigate between screens confirming it
survives; start a call with unsaved edits and confirm the save-and-test choice
appears; save during a call and confirm the restart hint; close the panel
mid-call and confirm the sidebar shows the live state.

## Open questions

None. Deferred work is listed under Scope.
