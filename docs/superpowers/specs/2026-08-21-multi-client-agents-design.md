# Multi-Client Agents — Design

**Goal:** support running one agent per client/store (today: ~20, growing) from
a single console, instead of the one global agent this app supports today.
Add a client picker, a "＋ Add store" flow, and route live calls and embed
widgets to the right client's agent.

**Scope:** agent configuration (prompt, voice, tools, secrets), the embed
widget, and call-log filtering become per-client. Telephony (the shared SIP
line), API-key management as a page, and Selorax settings stay global.

---

## 1. What is there today

Everything is a global singleton:

| Concern | Collection | Key | Read by |
|---|---|---|---|
| Agent config | `agent_config` | `_id: "singleton"` | Next + gateway |
| Agent secrets | `agent_secrets` | `_id` is the secret name | gateway only |
| SIP credentials | `telephony_credentials` | `_id: "singleton"` | Next |
| API keys | `api_keys` | `_id` is the key id | Next mints/revokes, gateway verifies |
| Call logs | `call_logs` | `_id` is the call id | Next |

`app/(console)/layout.tsx` reads the one agent config server-side and hands it
to `AgentConfigProvider`, which every screen under `/agent/*` and
`/models-voice` edits and saves via `PUT /api/agent-config`
(`app/api/agent-config/route.ts`). The gateway
(`server/voice/websocket-server.ts`) loads that same singleton for every call,
regardless of who connected.

API keys already exist as a *list* (`lib/api-keys/types.ts`,
`server/config/api-key-store.ts`) and are already checked on every gateway
WebSocket upgrade, in `authorizeUpgrade` (`server/voice/upgrade-auth.ts:83`) —
but only for accept/reject. The `ApiKeySummary` the check resolves is never
used to pick *which* configuration a call gets; every accepted connection gets
the same one.

The embed widget (`public/embed.js`, `app/embed/widget/page.tsx`) carries no
identity at all today. It forwards display text
(`data-prompt`/`data-button-text`/`data-title`) as query params
(`lib/embed/config.ts`), and the gateway key it presents comes from a
build-time env var, `NEXT_PUBLIC_VOICE_GATEWAY_KEY`
(`lib/websocket/voice-client.ts:178-192`) — the same key used by the console's
own live-preview player, since both go through `useVoiceSession`. There is no
per-page, per-site identity to route on.

There is no login/session system anywhere in the app — the console is a
single-operator tool. This design does not add one; "select a client" is a
navigation choice, not an access-control boundary.

---

## 2. Decisions taken

Settled with the user before writing this:

1. **Per-client scope: agent config, call-log filtering, and the embed
   widget.** Telephony (the SIP line), the API-keys page, and Selorax settings
   stay global/shared for v1.
2. **Routing mechanism: API keys.** Each client gets its own dedicated
   gateway key. Whichever key a connection presents (phone bridge, browser
   preview, embed widget) determines which client's agent config is loaded.
3. **Migration: the existing config becomes the first client, named
   "Default".** No data migration script — see §4.
4. **Client switching is URL-scoped**, not cookie/session state:
   `/clients/[clientId]/...`. Shareable, bookmarkable, and it removes an
   entire class of "which client am I editing?" bugs that hidden state would
   invite.

---

## 3. Data model

### 3.1 New: `clients` collection

The roster. One document per client/store.

```ts
interface ClientDoc {
  _id: string;            // "singleton" for Default; randomUUID() for the rest
  name: string;            // display name, e.g. "Riverside Cafe"
  apiKeyId: string | null; // the id of this client's dedicated gateway key
  createdAt: string;       // ISO 8601
  updatedAt: string;       // ISO 8601
}
```

- `list()` — all clients, `name` ascending.
- `create(name)` — validates the name (reuse the trim/length shape from
  `apiKeyStore.mint`'s name validation), inserts the doc, then mints a
  dedicated API key via `apiKeyStore.mint(name)` and stores its id as
  `apiKeyId`. One store call, then one composed operation — not a
  transaction, since a key without a client-linked doc yet is harmless (it
  just isn't routable until the client doc exists, and the doc is written
  right after).
- `rename(id, name)` — updates `name`/`updatedAt`. No delete in v1: a client
  has call history and a live key, and removing either safely (revoke the
  key? keep the calls? orphan the config?) is a separate decision, not needed
  for the "add 20 clients" ask.
- No document ever exists for `"singleton"` until first accessed — see §4.

### 3.2 `agent_config` / `agent_secrets`: keyed by client, not fixed

`createConfigStore` (`server/config/store.ts`) changes from a fixed
`SINGLETON` constant to a `clientId` parameter on every method:

```ts
interface ConfigStore {
  read(clientId: string): Promise<AgentConfig>;
  write(clientId: string, config: AgentConfig): Promise<AgentConfig>;
  listSecretKeys(clientId: string): Promise<string[]>;
  resolveSecrets(clientId: string): Promise<Record<string, string>>;
  setSecret(clientId: string, key: string, value: string): Promise<void>;
  deleteSecret(clientId: string, key: string): Promise<void>;
}
```

Both collections' documents gain a `clientId` field instead of a fixed
`_id: "singleton"`; `agent_config`'s `_id` becomes `clientId` directly (one
config per client, same as today's one config total).
`agent_secrets` needs a compound key since secret *names* are not
globally unique across clients — `_id` becomes `` `${clientId}:${name}` ``,
with `clientId` and `name` also stored as plain fields so
`listSecretKeys`/`resolveSecrets` can query by `clientId` with an index:

```ts
db.collection("agent_secrets").createIndex({ clientId: 1 });
```

This is a scope addition beyond what was asked directly: secrets hold tool
credentials (e.g. a Zapier webhook header), and tools are now part of a
per-client config. Leaving secrets global would let Client B's agent
reference a secret named by Client A — a cross-tenant leak. Namespacing them
the same way as config closes that off at negligible cost.

### 3.3 `api_keys`: gains `clientId`

```ts
interface ApiKeyDoc {
  // ...unchanged fields...
  clientId: string | null; // null on every key that exists before this ships
}
```

`ApiKeySummary` (`lib/api-keys/types.ts`) gains the same field. Nothing reads
`clientId` at write time for existing keys — it is simply absent, and every
read site treats absent/`null` as `"singleton"` (see §4). `mint()` gains an
optional `clientId` parameter, set when `clients.create()` calls it.

### 3.4 `call_logs`: gains `clientId` + `clientName`

```ts
interface CallRecord {
  // ...unchanged fields...
  clientId?: string;    // absent on every record written before this ships
  clientName?: string;  // snapshot at call time, so a later rename doesn't rewrite history
}
```

Optional, matching how `channel` and `summary` were added previously
(`lib/call-logs/types.ts:108-112`) — an absent field reads as "written before
this existed," not as an error.

---

## 4. Migration: none, by construction

The Default client's id is literally the string `"singleton"`. Since
`agent_config` and `agent_secrets` already store their one document under
that exact key (§1), keying those collections by `clientId` and setting
Default's id to `"singleton"` means **today's real config *is* Default's
config, unchanged, with no data to move.**

The only new thing needed is the roster entry. `clients.list()` (or the new
`/clients` page) lazily inserts `{ _id: "singleton", name: "Default",
apiKeyId: null, createdAt: now, updatedAt: now }` the first time it finds the
`clients` collection empty. `apiKeyId: null` is correct here — every API key
minted before this shipped has no `clientId`, and per §3.3 that already reads
as `"singleton"` everywhere it's looked up, so Default doesn't need one
specific key on record to keep working.

---

## 5. Gateway wiring

`authorizeUpgrade` (`server/voice/upgrade-auth.ts`) is unchanged in shape —
it still returns `{ ok: true, key: ApiKeySummary | null }`. What changes is
what `websocket-server.ts` does with `decision.key` once accepted:

```ts
const clientId = decision.key?.clientId ?? "singleton";
```

This one line is the actual routing mechanism. It replaces the current
unconditional `configStore.read()` / `configStore.resolveSecrets()` calls
(`websocket-server.ts:836`, and inside `loadResolvedAgentConfig` in
`gemini-session.ts`) with the `clientId`-parameterized versions from §3.2.
`recordCall` (`websocket-server.ts:702`) stamps `clientId` and `clientName`
(looked up once from the `clients` store, or carried on `ApiKeySummary` if
that's cheaper — implementation detail for the plan) onto the `CallRecord`.

When `VOICE_GATEWAY_REQUIRE_KEY` is off (the dev default), `decision.key` is
always `null`, so every call resolves to `"singleton"` / Default — matching
today's behavior exactly in the unconfigured case.

The phone bridge (`hooks/useSoftphoneBridge.ts`) is untouched: it presents
whatever key `NEXT_PUBLIC_VOICE_GATEWAY_KEY` holds (or none), which — per the
same rule — resolves to Default unless that env var is ever pointed at a
client-specific key. Telephony staying "shared" in practice means "routes to
Default," which matches decision #1.

---

## 6. Console routes and navigation

```
/clients                              list of stores + "＋ Add store"
/clients/[clientId]/agent/conversation
/clients/[clientId]/agent/actions
/clients/[clientId]/agent/advanced
/clients/[clientId]/models-voice
/clients/[clientId]/embed             snippet with this client's key baked in

/calls                                unchanged location; gains a client filter
/calls/[id]                           unchanged; shows which client the call belongs to
/telephony                            unchanged
/settings/keys                        unchanged; each row now shows its client (or "—" if none)
/settings/selorax                     unchanged
/upload                               unchanged
```

`app/(console)/layout.tsx` stays as today's shell (chrome + sidebar), but
stops loading an agent config — not every route under it has a client in
scope. A new `app/(console)/clients/[clientId]/layout.tsx` takes over the job
`(console)/layout.tsx` does today: read `params.clientId` (Next 16 async
params, matching the existing `app/(console)/calls/[id]/page.tsx` pattern),
load that client's config via `configStore.read(clientId)`, and wrap its
children in `AgentConfigProvider`. If `clientId` doesn't resolve to a known
client, `notFound()`.

`AgentConfigProvider.save()` (`components/agent-config/AgentConfigProvider.tsx:114`)
posts to `PUT /api/clients/[clientId]/agent-config` instead of the current
global `/api/agent-config`; the client id comes down as a prop from the new
layout rather than a route param read inside the provider, keeping the
provider itself free of routing concerns.

`lib/agent-config/routes.ts` (`AGENT_ROUTES`, `CONFIG_ROUTES`, `routeForPath`)
becomes parameterized by `clientId` — hrefs become
`` `/clients/${clientId}/agent/conversation` `` etc. — so server-validation
error navigation (`routeForPath`, used in `AgentConfigProvider.ts:131`) still
lands on the right screen for the right client.

`components/shell/Sidebar.tsx` reads the current `clientId` via
`useParams()`:

- **With a `clientId` in the URL:** renders a client switcher above the
  "Agent" group — current client's name, a dropdown of every other client
  (from a lightweight client-side fetch of `GET /api/clients`), and "＋ Add
  store". The Agent/Models & Voice/Embed links point at that client.
  "＋ Add store" opens a small inline form (name only); on submit it calls
  `POST /api/clients`, then navigates to the new client's
  `/clients/[id]/agent/conversation`.
- **Without one** (on `/calls`, `/telephony`, `/clients`, `/settings/*`): the
  Agent group shows "Select a store →" linking to `/clients` instead of the
  three sub-links.

`/clients` itself (`app/(console)/clients/page.tsx`) is a plain server
component: list every client (`GET`-equivalent server call), each row linking
into `/clients/[id]/agent/conversation`, plus the same "＋ Add store" entry
point as the sidebar for when there is no client selected yet.

---

## 7. Embed widget

`consoleSnippet`/`scriptTagSnippet` (`lib/embed/snippet.ts`) take an
additional `key` argument and emit it as `data-key` on the generated
`<script>` tag, the same shape as the existing text customization attributes
documented on the Embed page. The per-client Embed page
(`/clients/[clientId]/embed`) resolves that client's key (via `apiKeyId` on
its `ClientDoc`) and renders the snippet with it already filled in — nothing
for the operator to copy separately.

`public/embed.js` reads `data-key` alongside `data-prompt` et al.
(`public/embed.js:75-80`) and forwards it into the iframe `src` as a `key`
query param.

`app/embed/widget/page.tsx` reads `key` from `window.location.search`
alongside the existing `parseEmbedTextConfig` call, and passes it down to
`useVoiceSession` → `resolveGatewayUrl()` (`lib/websocket/voice-client.ts:178`)
as an override for the build-time env var — a widget carrying its own key
takes precedence over `NEXT_PUBLIC_VOICE_GATEWAY_KEY`, so the console's own
live-preview player (which has no such query param) keeps using the env var
unchanged, while every embedded widget authenticates as the client it
belongs to.

The existing "this snippet is public" warning on the Embed page
(`app/(console)/embed/page.tsx:151-158`) still applies per client: anyone who
can read a client's snippet can open billed sessions against that client's
key. Worth a line added to that section noting the key is now scoped to one
client, so revoking it only affects that client's widget — an improvement
over today's single shared key.

---

## 8. Calls page filtering

`GET /api/calls` (`app/api/calls/route.ts`) and `callLogStore.read()` gain an
optional `clientId` query filter. The Calls page
(`app/(console)/calls/page.tsx`) adds a client-select dropdown (options from
`GET /api/clients`, plus "All clients" as the default) that sets
`?client=<id>` and re-fetches. Records written before this ships have no
`clientId` and simply never match a specific-client filter — visible only
under "All clients," labeled something like "Client: —" in the table, which
is accurate: those calls predate the concept.

---

## 9. API surface (new)

| Route | Method | Does |
|---|---|---|
| `/api/clients` | `GET` | List clients (lazily seeds Default if empty) |
| `/api/clients` | `POST` | Create a client: validates `name`, inserts doc, mints a key |
| `/api/clients/[clientId]` | `PATCH` | Rename |
| `/api/clients/[clientId]/agent-config` | `GET`/`PUT` | Replaces today's `/api/agent-config`, scoped |
| `/api/clients/[clientId]/agent-config/secrets` | as today | Replaces today's `/api/agent-config/secrets`, scoped |
| `/api/calls` | `GET` | Gains optional `?client=<id>` filter |

`/api/agent-config` and `/api/agent-config/secrets` are removed — nothing
outside the moved console pages calls them.

---

## 10. Tests

- `server/config/store.test.ts` (agent config) and the new client-store test
  file follow the existing pattern (`mongodb-memory-server`, one store per
  test file per `2026-08-17-mongodb-persistence-design.md` §9), parameterized
  by `clientId` instead of asserting against the fixed singleton.
- `server/config/api-key-store.test.ts` gains cases for `clientId` on
  mint/list, and for the absent-`clientId` → `"singleton"` read-time default.
- `server/voice/websocket-server.test.ts` gains a case asserting that a call
  authorized with Client B's key loads Client B's config/secrets, not
  Default's, and that the resulting `CallRecord` carries Client B's
  `clientId`.
- `lib/agent-config/routes.test.ts` updates for the parameterized hrefs.
- `lib/embed/snippet.test.ts` gains cases for the `data-key` attribute.
- New route tests for `/api/clients` (create validation, list, lazy-seed of
  Default) mirroring `app/api/agent-config/route.ts`'s existing coverage
  shape.

---

## 11. Out of scope

- Deleting a client, or revoking/reassigning its key as part of that.
- Authentication or access control — the console remains a single-operator
  tool; "select a client" is navigation, not a permission boundary.
- Per-client telephony (a dedicated SIP line/number per client). Telephony
  stays shared, routing to Default, per decision #1.
- A dedicated "API keys per client" management UI beyond the existing global
  `/settings/keys` list gaining a client column. Minting/revoking additional
  keys for an existing client (beyond the one auto-minted at creation) is not
  built in v1.
- Any change to audio, SIP transport, or Gemini session handling beyond
  reading a different `clientId`.
