# MongoDB Persistence — Design

**Goal:** replace every JSON file under `data/` with MongoDB collections, so
persistence stops being "two processes sharing a filesystem" and becomes a
database both processes are clients of.

**Scope:** the five stores in `server/config/`. Nothing above them changes —
the store interfaces are the seam, and they stay identical.

---

## 1. What is there today

Five stores, all writing JSON under `data/`, all built from the same template:
temp file → atomic rename, an in-process write queue, and reads that degrade to
a default instead of throwing.

| Store | File(s) | Written by | Read by |
|---|---|---|---|
| `store.ts` (agent config) | `agent-config.json` 0644, `agent-secrets.json` 0600 | Next | Next + gateway |
| `call-log-store.ts` | `call-logs.json` 0644 | gateway | Next |
| `api-key-store.ts` | `api-keys.json` 0600, `api-keys-usage.json` 0600 | Next mints/revokes, gateway stamps usage | both |
| `selorax-store.ts` | `selorax.json` 0600 | Next | Next |
| `telephony-store.ts` | `telephony.json` 0600 | Next | Next |

They are consumed through exported singletons in twelve places across `app/`
and `server/voice/`, and through the `create*(dataDir, log)` factories in
roughly 880 lines of tests plus `gemini-session.ts:85`.

The filesystem is not incidental here — it is the **only** thing connecting the
Next process to the voice gateway. Neither imports the other; they meet at
`data/`.

---

## 2. Why this is worth doing

Not merely because JSON files are unfashionable. Three concrete defects go away.

**The API-key store already documents its own inadequacy.** Its header comment
(`server/config/api-key-store.ts:22-41`) explains that `api-keys.json` and
`api-keys-usage.json` are two files specifically so a usage stamp from the
gateway cannot clobber a revoke from Next — and then says plainly:

> Two processes writing the SAME file still lose each other's updates, because
> the queue is in-process and there is no lock: four mints across two writers
> can leave two keys. [...] Anything like that needs a real lock or a database
> — do not read this split as making concurrent writers safe.

**A dropped revoke means a revoked key keeps working.** That is a security
defect the file layout cannot fix, and it is the reason this change is worth
more than tidiness.

**Every write is a whole-file rewrite.** Setting one secret reads all secrets,
mutates the object, and renames a new file over the old one. That is why
`createQueue()` exists, copy-pasted into all five stores. It serialises one
process and cannot serialise two.

**The shared filesystem forbids multi-host deployment.** Next and the gateway
must run on the same box, or on a shared volume with all the failure modes that
implies.

---

## 3. Decisions taken

Settled with the user before writing this:

1. **No migration.** Mongo starts empty. The existing `data/agent-config.json`
   (44KB) and `data/call-logs.json` (98KB) are abandoned; the agent config
   reverts to seed defaults and call history starts from zero. No migration
   code is written, and none lives in the app afterwards.
2. **Tests use `mongodb-memory-server`.** A real in-process `mongod`, so tests
   stay offline and self-contained after the first binary download.
3. **Everything moves, including secrets.** `data/` is deleted outright. Agent
   secrets, the SIP password, and the Selorax auth token live in Atlas.
4. **Reads split their failure behavior.** Missing document → defaults.
   Unreachable database → throw.
5. **No call-log cap.** `MAX_RECORDS = 500` is removed; history grows.

---

## 4. Approach: keep the stores, swap their internals

`create*Store()` takes a `Db` accessor instead of a `dataDir`. The exported
interfaces — `ConfigStore`, `CallLogStore`, `ApiKeyStore`, `SeloraxStore`,
`TelephonyStore` — do not change by one character, so **no consumer in `app/`
or `server/voice/` is edited at all**.

Two alternatives were considered and rejected:

- **A generic Mongo document-store with five thin wrappers.** The duplication
  it would remove (`writeAtomic`, `createQueue`, `isMissing`) is precisely the
  code that *disappears* under Mongo. What remains differs per store —
  different validators, different degradation — so the shared layer reduces to
  `collection.findOne()`. Churn without payoff.
- **Mongoose.** Its main draw is schema validation, which this repo already has
  hand-written and thorough in `lib/agent-config/schema.ts`,
  `lib/telephony/credentials.ts`, and `lib/selorax/config.ts`. Mongoose schemas
  would be a second source of truth that can drift from the first.

---

## 5. Collections

| Collection | Documents | Replaces |
|---|---|---|
| `agent_config` | one, `_id: "singleton"` | `agent-config.json` |
| `agent_secrets` | one per secret, `_id` is the key name | `agent-secrets.json` |
| `call_logs` | one per call, `_id: record.id` | `call-logs.json` |
| `api_keys` | one per key, `_id: id` | `api-keys.json` **and** `api-keys-usage.json` |
| `selorax_config` | one, `_id: "singleton"` | `selorax.json` |
| `telephony_credentials` | one, `_id: "singleton"` | `telephony.json` |

Indexes, created once at connection time and idempotent:

- `call_logs`: `{ startedAt: -1 }` — every read is newest-first.
- `api_keys`: `{ hash: 1 }`, unique — `verify()` is an exact-match lookup.

`CallRecord.startedAt` is ISO 8601 (`lib/call-logs/types.ts:86-87`), so it sorts
lexicographically and needs no date conversion. Note the ordering is defined
slightly differently than today: the file store returns insertion order
reversed (`call-log-store.ts:86-89`), whereas this sorts on `startedAt`. The two
agree for every record the file store could produce, since appends are
chronological — sorting on the timestamp is simply the stronger guarantee.

Documents store the domain type as-is under a `value` field for the singletons,
so the stored shape matches what the validators already accept and no field
mapping is invented. Call records and API keys are stored as their own fields,
since they are already flat records with a natural `_id`.

### 5.1 What improves structurally

**`createQueue()` is deleted from all five stores.** It exists only because a
whole-file rewrite is a read-modify-write. `setSecret` becomes one `updateOne`
upsert, `deleteSecret` one `deleteOne`, `mint` one `insertOne`. These are
atomic at the server. Nothing needs serialising in-process, and — unlike the
queue — that holds across two processes.

**The two-file API-key split collapses into one collection.** `lastUsedAt`
moves onto the key document. `updateOne({ _id }, { $set: { lastUsedAt } })`
cannot resurrect a key that `deleteOne` removed; the update simply matches
nothing. The hazard the split was working around no longer exists, so the
workaround goes with it. The `MAX_KEYS` cap and the mint-time count check stay.

**`verify()` stops scanning every key.** The current constant-time loop
(`api-key-store.ts:268-278`) guards against timing-leaking a comparison against
a *presented plaintext*. What is compared here is a SHA-256 digest of that
plaintext against an indexed field. An attacker cannot steer the lookup without
inverting SHA-256, so an indexed `findOne({ hash })` leaks nothing usable. The
`MAX_PRESENTED_CHARS` guard and the trim/blank rejection stay.

**`MAX_RECORDS` is removed from `call-log-store.ts`.** The cap existed so one
JSON file could not grow unboundedly. Appends become `insertOne` and no longer
rewrite history. The exported `MAX_RECORDS` constant and its test go.

---

## 6. Connection lifecycle

A new module, `server/db/client.ts`, exporting `getDb(): Promise<Db>`:

- Reads `MONGODB_URI` and `MONGODB_DB`. The URI in `.env` carries **no**
  database name, so `MONGODB_DB` is a new variable, defaulting to `voice-ai`.
  Both go into `.env.example`.
- Memoises a single connection *promise*, not a resolved client, so concurrent
  first callers share one connect rather than racing to open several pools.
- Caches that promise on `globalThis` under a symbol. This is the standard Next
  pattern: without it, dev hot-reload re-evaluates the module on every edit and
  opens a new pool each time until Atlas refuses connections.
- Ensures the indexes from §5 on first connect, as part of the memoised
  promise, so it happens exactly once per process.
- Fails loudly if `MONGODB_URI` is absent, matching how `server/index.ts:22-28`
  already treats a missing `GEMINI_API_KEY`.

Stores hold the accessor and `await getDb()` per operation. The driver owns
pooling, retry, and reconnection; the stores do not implement any of it.

`server/index.ts` gains a `closeDb()` call in its existing `shutdown()`
(`server/index.ts:49-61`), before `process.exit(0)`, so a SIGTERM drains the
pool rather than dropping it. The existing 3-second failsafe timeout still
applies.

---

## 7. Read-failure behavior

This is the one place behavior deliberately changes, and it needs stating
precisely because the current contract is "reads never throw".

**Missing document → defaults.** This is first-run, exactly as a missing file
is today. `configStore.read()` returns `DEFAULT_AGENT_CONFIG`, the Selorax and
telephony stores return their `EMPTY_*` constants, `callLogStore.read()`
returns `[]`, `apiKeyStore.list()` returns `[]`.

**Connection or query error → throw.** Under files, the only read failure was
corruption, which is vanishingly rare. Under Mongo, "unreachable" is an
ordinary transient event. Silently treating it as "empty" opens a data-loss
path with real consequences: Mongo blips, the agent editor renders seed
defaults, the user hits Save, and `write()` replaces their real config with the
defaults it was just shown. Throwing makes the page show an error instead.

**Validation failure → defaults, and the document is left untouched.** This
mirrors the current file behavior (`store.ts:149-156`) for the same reason: the
bad data stays recoverable rather than being overwritten.

Two call paths already handle a throwing read correctly, and neither needs
editing:

- `verifyClient` in `websocket-server.ts:267-271` catches and calls
  `done(false, 500)`. An unreachable database therefore **fails closed** —
  nobody gets a billed session while keys cannot be checked. This is the
  correct outcome and it is already implemented.
- `loadResolvedAgentConfig` in `gemini-session.ts:81-93` catches and falls back
  to defaults, so an in-progress call still connects. This is the right
  layering: the store reports the failure, and the call path — which has its
  own reason to prefer availability — decides to degrade.

**One deliberate exception: `resolveSecrets()` keeps returning `{}` on any
failure.** Its existing comment (`store.ts:180-183`) gives the reason: leaving
tools unauthenticated is better than taking a live call down, because the
request then fails with the endpoint's own 401, which is a legible outcome. The
failure is logged. This exception is documented in the code, not silent.

---

## 8. Secrets in Atlas

Agent secrets, the SIP password, and the Selorax auth token move from local
files at mode 0600 to documents in Atlas. Stated plainly so it is a decision on
the record rather than a side effect:

- In transit they are protected by TLS; at rest by Atlas encryption.
- They are readable by anyone holding cluster credentials, which is a wider
  circle than "anyone with a shell on this host and the right uid".
- `MONGODB_URI` in `.env` therefore becomes the single most sensitive value in
  the project. `.env*` is already gitignored (`.gitignore:34`).
- No application-level encryption is added. If that is wanted later it is a
  separate piece of work, and Atlas CSFLE would be the mechanism.

The existing code comments that justify mode 0600 and explain why only an
error's `name` is logged (never its message, since a `JSON.parse` SyntaxError
quotes secret material) are rewritten to match the new reality. The
log-only-the-name discipline is kept — a driver error can quote a query.

---

## 9. Tests

`mongodb-memory-server` as a devDependency. A shared helper,
`server/config/test-db.ts`, starts one `mongod` per test file and hands each
test a freshly named database, so tests remain independent without paying
startup cost per test.

Node's test runner gives each file its own process, so this means five `mongod`
instances across a run — a few seconds of added startup, in exchange for tests
that stay offline and never touch the real Atlas cluster.

**This is a rewrite, not a port.** A substantial share of the existing ~880
lines tests file-specific behavior that has no Mongo equivalent:

- "corrupt JSON → defaults" → becomes "document fails validation → defaults"
- "missing file → defaults" → becomes "missing document → defaults"
- "temp file is cleaned up when the write fails" → **deleted**, no temp files
- "file is written mode 0600" → **deleted**, no file modes
- "writes are serialised in-process" → **deleted**, replaced by real
  concurrency tests

New coverage the file version could not express:

- Two independent store instances minting concurrently keep **both** keys —
  the case `api-key-store.ts` documents as broken today.
- A usage stamp landing after a revoke does not resurrect the key.
- An unreachable database throws from `read()` rather than returning defaults.
- `resolveSecrets()` still returns `{}` when the database is unreachable.

---

## 10. Removals

- `data/` deleted from the working tree.
- The `/data/` entry and its explanatory comment in `.gitignore:44-47`.
- `writeAtomic`, `createQueue`, and `isMissing` from all five stores.
- `MAX_RECORDS` from `call-log-store.ts` and its export.
- The `api-keys-usage.json` file, `readUsage`, `stamp`, and the `UsageMap`
  type — folded into the key document.
- Every `node:fs/promises` and `node:path` import in `server/config/`.
- The `dataDir` parameter from all five factory signatures.

---

## 11. Out of scope

- Migrating the existing `data/*.json`. Decided against; Mongo starts empty.
- Authentication on the console itself. `.env.example:36-44` documents that the
  console and `/api/api-keys` are unauthenticated. This change does not alter
  that, and does not make it worse — but it does not fix it either.
- Application-level encryption of secrets at rest.
- Any change to audio, SIP, Gemini, or the React console.
