/**
 * Persistence for the gateway's API keys.
 *
 * The gateway opens a billed Gemini session for whoever connects to it, so a
 * key is what separates "a client of this service" from "anyone who can reach
 * port 4000". Keys are minted in the console and presented by the client on the
 * WebSocket upgrade.
 *
 * Only a SHA-256 hash is stored. `mint` hands the plaintext back exactly once
 * and nothing — not this store, not the database, not the listing — can produce
 * it again; a lost key is re-minted, never recovered. That is why `list()`
 * returns a short fingerprint instead: enough to tell two keys apart in the UI,
 * useless as a credential.
 *
 * This used to be TWO files, and the split was load-bearing: Next mints and
 * revokes while the gateway stamps usage, and with whole-file rewrites a stamp
 * could undo a revoke — silently putting a revoked key back. One document per
 * key removes the problem at the root rather than working around it. A stamp is
 * `$set` on one document and a revoke is `deleteOne` on another; the stamp
 * simply matches nothing once the key is gone, so the two cannot fight. The
 * multi-writer hazard that comment warned about is gone with it.
 *
 * A database that cannot be reached makes `verify` THROW, which the gateway's
 * `verifyClient` catches and turns into a refusal. That is the right way round:
 * while keys cannot be checked, nobody gets a billed session.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { Db } from "mongodb";

import {
  FINGERPRINT_CHARS,
  MAX_KEYS,
  MAX_NAME_CHARS,
  type ApiKeySummary,
  type MintedApiKey,
} from "../../lib/api-keys/types";
import { getDb, type DbAccessor } from "../db/client";

export type StoreLogger = (message: string) => void;

/**
 * Longest string worth hashing on an upgrade. A minted key is 43 characters
 * (32 random bytes as base64url); anything far longer is not a typo.
 */
const MAX_PRESENTED_CHARS = 256;

const COLLECTION = "api_keys";

/** What is written. The hash never leaves this module. */
interface ApiKeyDoc {
  _id: string;
  name: string;
  /** SHA-256 of the plaintext key, hex encoded. Uniquely indexed. */
  hash: string;
  createdAt: string;
  /** ISO time this key was last accepted, or null if never. */
  lastUsedAt: string | null;
}

export interface ApiKeyStore {
  /** Newest first. */
  list(): Promise<ApiKeySummary[]>;
  /** Creates a key and returns its plaintext once. Throws on a bad name. */
  mint(name: string): Promise<MintedApiKey>;
  /**
   * Checks a presented key, stamping `lastUsedAt` on a match.
   * Returns null for anything unknown, revoked, blank or malformed.
   */
  verify(presented: string): Promise<ApiKeySummary | null>;
  /** Removes a key. Returns false if there was nothing with that id. */
  revoke(id: string): Promise<boolean>;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function summarise(doc: ApiKeyDoc, lastUsedAt: string | null): ApiKeySummary {
  return {
    id: doc._id,
    name: doc.name,
    createdAt: doc.createdAt,
    lastUsedAt,
    fingerprint: doc.hash.slice(0, FINGERPRINT_CHARS),
  };
}

export function createApiKeyStore(
  getDatabase: DbAccessor,
  log: StoreLogger = () => {},
): ApiKeyStore {
  async function collection() {
    const db: Db = await getDatabase();
    return db.collection<ApiKeyDoc>(COLLECTION);
  }

  return {
    async list(): Promise<ApiKeySummary[]> {
      const docs = await (await collection()).find({}).sort({ createdAt: -1 }).toArray();
      return docs.map((doc) => summarise(doc, doc.lastUsedAt));
    },

    async mint(name: string): Promise<MintedApiKey> {
      const clean = name.trim();
      if (clean === "") throw new Error("Give the key a name.");
      if (clean.length > MAX_NAME_CHARS) {
        throw new Error(`The name must be at most ${MAX_NAME_CHARS} characters.`);
      }

      const keys = await collection();
      if ((await keys.countDocuments()) >= MAX_KEYS) {
        throw new Error(`There are already ${MAX_KEYS} keys. Revoke one first.`);
      }

      const key = randomBytes(32).toString("base64url");
      const doc: ApiKeyDoc = {
        _id: randomUUID(),
        name: clean,
        hash: sha256Hex(key),
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
      };
      await keys.insertOne(doc);

      return { key, record: summarise(doc, null) };
    },

    async verify(presented: string): Promise<ApiKeySummary | null> {
      const candidate = typeof presented === "string" ? presented.trim() : "";
      if (candidate === "" || candidate.length > MAX_PRESENTED_CHARS) return null;

      // An indexed exact-match lookup, where the old file store compared every
      // record in constant time. That loop guarded a comparison against the
      // presented PLAINTEXT; what is matched here is its SHA-256 digest, and an
      // attacker cannot steer the lookup without inverting SHA-256. Nothing
      // usable leaks from how long the index takes.
      const digest = sha256Hex(candidate);
      const matched = await (await collection()).findOne({ hash: digest });
      if (!matched) return null;

      // Belt and braces: confirm in constant time that the index handed back
      // the record we asked for, so a hand-edited document cannot widen a match.
      const stored = Buffer.from(matched.hash, "hex");
      const expected = Buffer.from(digest, "hex");
      if (stored.length !== expected.length || !timingSafeEqual(stored, expected)) return null;

      // `lastUsedAt` is telemetry, not part of the decision, so the write is
      // fired and forgotten. Awaiting it would let a database problem turn every
      // correct key into a refused connection and take the phone bridge down.
      const lastUsedAt = new Date().toISOString();
      void (await collection())
        .updateOne({ _id: matched._id }, { $set: { lastUsedAt } })
        .catch((cause: unknown) => {
          log(`could not record when a key was last used (${(cause as Error).name})`);
        });

      return summarise(matched, lastUsedAt);
    },

    async revoke(id: string): Promise<boolean> {
      const result = await (await collection()).deleteOne({ _id: id });
      return result.deletedCount === 1;
    },
  };
}

/**
 * The instance both processes use: Next mints and revokes, the gateway
 * verifies. The database is the meeting point, as with every other store here,
 * so neither process needs to know the other exists.
 */
export const apiKeyStore = createApiKeyStore(getDb, (message) =>
  console.warn(`[api-keys] ${message}`),
);
