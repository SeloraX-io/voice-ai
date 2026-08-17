/**
 * The MongoDB connection both processes share.
 *
 * Next and the voice gateway are separate processes that never import each
 * other. They used to meet at a directory of JSON files; they now meet here.
 *
 * The connection PROMISE is memoised, not the resolved client, so concurrent
 * first callers share one connect instead of racing to open several pools. It
 * is cached on `globalThis` because Next re-evaluates modules on every dev
 * hot-reload, and a module-level variable would open a fresh pool per edit
 * until Atlas started refusing connections.
 */

import { MongoClient, type Db } from "mongodb";

/** How every store gets at the database. Injected so tests need no Atlas. */
export type DbAccessor = () => Promise<Db>;

const CACHE_KEY = Symbol.for("voice-ai.mongo");

interface Cache {
  promise: Promise<{ client: MongoClient; db: Db }> | null;
}

function cache(): Cache {
  const global = globalThis as unknown as Record<symbol, Cache | undefined>;
  global[CACHE_KEY] ??= { promise: null };
  return global[CACHE_KEY] as Cache;
}

/**
 * Creates the indexes the stores rely on. Idempotent — Mongo ignores a
 * createIndex for an index that already exists with the same spec.
 */
export async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all([
    // Compound so the tie-broken `{ startedAt: -1, _id: -1 }` sort in
    // call-log-store.ts can be served entirely from the index (IXSCAN),
    // instead of an index-only prefix forcing a blocking in-memory SORT.
    db.collection("call_logs").createIndex({ startedAt: -1, _id: -1 }),
    // `verify()` is an exact-match lookup on the hash, on every upgrade.
    db.collection("api_keys").createIndex({ hash: 1 }, { unique: true }),
  ]);
}

async function connect(): Promise<{ client: MongoClient; db: Db }> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      "MONGODB_URI is not set. Copy .env.example to .env and add your connection string.",
    );
  }
  // The driver's default server-selection window is 30s. That is far too long
  // for a page render to sit on: the request hangs, then fails with a raw
  // driver error. Ten seconds is past any normal Atlas handshake and short
  // enough that a misconfiguration reads as a failure rather than a freeze.
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
  try {
    await client.connect();
  } catch (cause) {
    // The driver's own message here is an OpenSSL diagnostic — it names a
    // record-layer file and an alert number, and says nothing an operator can
    // act on. The two things that actually cause it get named instead.
    //
    // Only the error's NAME is carried through, never its message: a driver
    // error can quote the failing operation, and these connections carry
    // credentials.
    await client.close().catch(() => undefined);
    throw new Error(
      `Could not reach MongoDB (${(cause as Error).name}). Check that MONGODB_URI ` +
        `is correct and that this machine's IP is on the cluster's access list — ` +
        `Atlas refuses the TLS handshake for addresses that are not allow-listed.`,
      { cause },
    );
  }
  const db = client.db(process.env.MONGODB_DB ?? "voice-ai");
  await ensureIndexes(db);
  return { client, db };
}

/**
 * The shared database handle.
 *
 * A failed connect clears the memo before rethrowing, so one unreachable
 * moment does not poison the process forever — the next caller retries.
 */
export function getDb(): Promise<Db> {
  const entry = cache();
  entry.promise ??= connect().catch((cause: unknown) => {
    entry.promise = null;
    throw cause;
  });
  return entry.promise.then(({ db }) => db);
}

/** Drains the pool on shutdown. Safe to call when nothing ever connected. */
export async function closeDb(): Promise<void> {
  const entry = cache();
  const pending = entry.promise;
  entry.promise = null;
  if (!pending) return;
  try {
    const { client } = await pending;
    await client.close();
  } catch {
    // The connection never succeeded; there is no pool to drain.
  }
}
