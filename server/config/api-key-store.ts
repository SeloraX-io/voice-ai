/**
 * Persistence for the gateway's API keys.
 *
 * The gateway opens a billed Gemini session for whoever connects to it, so a
 * key is what separates "a client of this service" from "anyone who can reach
 * port 4000". Keys are minted in the console and presented by the client on the
 * WebSocket upgrade.
 *
 * Only a SHA-256 hash is stored. `mint` hands the plaintext back exactly once
 * and nothing — not this store, not the file, not the listing — can produce it
 * again; a lost key is re-minted, never recovered. That is why `list()` returns
 * a short fingerprint instead: enough to tell two keys apart in the UI, useless
 * as a credential.
 *
 * Same shape as the other stores here: a JSON file under data/, written
 * temp-file-and-rename so a crash mid-write cannot truncate it, with the
 * read-modify-write cycle serialised in-process so two mints landing together
 * cannot lose each other. A corrupt file reads as "no keys", which fails
 * closed — every connection is rejected while enforcement is on — rather than
 * taking the gateway down.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  FINGERPRINT_CHARS,
  MAX_KEYS,
  MAX_NAME_CHARS,
  type ApiKeySummary,
  type MintedApiKey,
} from "../../lib/api-keys/types";

export type StoreLogger = (message: string) => void;

/**
 * Longest string worth hashing on an upgrade. A minted key is 43 characters
 * (32 random bytes as base64url); anything far longer is not a typo.
 */
const MAX_PRESENTED_CHARS = 256;

/** What is written to disk. The hash never leaves this module. */
interface StoredApiKey {
  id: string;
  name: string;
  /** SHA-256 of the plaintext key, hex encoded. */
  hash: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ApiKeyStore {
  /** Newest first. Never throws — an unreadable file lists nothing. */
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

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function createQueue(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job, job);
    // Keep the chain alive when a job rejects, so one failed mint does not
    // wedge every later one.
    tail = run.catch(() => undefined);
    return run;
  };
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function summarise(record: StoredApiKey): ApiKeySummary {
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    fingerprint: record.hash.slice(0, FINGERPRINT_CHARS),
  };
}

function isStoredKey(value: unknown): value is StoredApiKey {
  const record = value as Partial<StoredApiKey> | null;
  return (
    typeof record === "object" &&
    record !== null &&
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    typeof record.hash === "string" &&
    typeof record.createdAt === "string"
  );
}

export function createApiKeyStore(dataDir: string, log: StoreLogger = () => {}): ApiKeyStore {
  const file = path.join(dataDir, "api-keys.json");
  const enqueue = createQueue();

  async function readAll(): Promise<StoredApiKey[]> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      // A missing file is the first-run path, not a failure. Only the error's
      // NAME is logged: a JSON.parse SyntaxError quotes the input, and the
      // input here is key material.
      if (!isMissing(error)) log(`api-keys.json is unreadable (${(error as Error).name})`);
      return [];
    }
    if (!Array.isArray(parsed)) {
      log("api-keys.json is not a list; treating it as no keys");
      return [];
    }
    const records = parsed.filter(isStoredKey).map((record) => ({
      ...record,
      lastUsedAt: typeof record.lastUsedAt === "string" ? record.lastUsedAt : null,
    }));
    if (records.length !== parsed.length) {
      log(`api-keys.json has ${parsed.length - records.length} unusable record(s); ignoring them`);
    }
    return records;
  }

  async function writeAll(records: StoredApiKey[]): Promise<void> {
    await mkdir(dataDir, { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      // 0600: hashes are not secrets the way a password is, but they are the
      // only thing standing between a reader and an offline guessing attack.
      await writeFile(temp, `${JSON.stringify(records, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temp, file);
    } catch (cause) {
      await unlink(temp).catch(() => undefined);
      throw cause;
    }
  }

  /**
   * Records that a key was just used.
   *
   * One small write per accepted connection, which is the same order of cost as
   * the call record written when that connection ends.
   */
  async function stamp(id: string, at: string): Promise<void> {
    await enqueue(async () => {
      const records = await readAll();
      const index = records.findIndex((record) => record.id === id);
      if (index === -1) return;
      records[index] = { ...records[index], lastUsedAt: at };
      await writeAll(records);
    });
  }

  return {
    async list(): Promise<ApiKeySummary[]> {
      const records = await readAll();
      return records
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(summarise);
    },

    async mint(name: string): Promise<MintedApiKey> {
      const clean = name.trim();
      if (clean === "") throw new Error("Give the key a name.");
      if (clean.length > MAX_NAME_CHARS) {
        throw new Error(`The name must be at most ${MAX_NAME_CHARS} characters.`);
      }

      const key = randomBytes(32).toString("base64url");
      const record: StoredApiKey = {
        id: randomUUID(),
        name: clean,
        hash: sha256(key).toString("hex"),
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
      };

      await enqueue(async () => {
        const records = await readAll();
        if (records.length >= MAX_KEYS) {
          throw new Error(`There are already ${MAX_KEYS} keys. Revoke one first.`);
        }
        records.push(record);
        await writeAll(records);
      });

      return { key, record: summarise(record) };
    },

    async verify(presented: string): Promise<ApiKeySummary | null> {
      const candidate = typeof presented === "string" ? presented.trim() : "";
      if (candidate === "" || candidate.length > MAX_PRESENTED_CHARS) return null;

      const digest = sha256(candidate);
      const records = await readAll();

      // Every record is compared, with no early exit, so the work done does not
      // depend on which key was presented.
      let matched: StoredApiKey | null = null;
      for (const record of records) {
        const stored = Buffer.from(record.hash, "hex");
        // timingSafeEqual throws on a length mismatch. Both sides are SHA-256
        // digests, so this only skips a record whose hash was hand-edited or
        // truncated — never a legitimate one.
        if (stored.length !== digest.length) continue;
        if (timingSafeEqual(stored, digest)) matched = record;
      }
      if (!matched) return null;

      const lastUsedAt = new Date().toISOString();
      await stamp(matched.id, lastUsedAt);
      return summarise({ ...matched, lastUsedAt });
    },

    async revoke(id: string): Promise<boolean> {
      return enqueue(async () => {
        const records = await readAll();
        const remaining = records.filter((record) => record.id !== id);
        if (remaining.length === records.length) return false;
        await writeAll(remaining);
        return true;
      });
    },
  };
}

/**
 * The instance both processes use: Next mints and revokes, the gateway
 * verifies. A file on disk is the meeting point, as with every other store
 * here, so neither process needs to know the other exists.
 */
export const apiKeyStore = createApiKeyStore(path.join(process.cwd(), "data"), (message) =>
  console.warn(`[api-keys] ${message}`),
);
