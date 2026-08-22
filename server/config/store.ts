/**
 * Persistence for the agent configuration, per client.
 *
 * Two processes read this: the Next route handlers and the voice gateway. They
 * meet at the database, so neither needs to know the other exists.
 *
 * Each client's config is one document in `agent_config`, keyed by the client
 * id. The default client's id is the literal "singleton" — the key the
 * pre-client config was stored under — so old data needs no migration.
 *
 * Secrets are a document EACH in `agent_secrets`, keyed by `<clientId>:<NAME>`
 * and carrying `clientId` for querying. Documents written before clients
 * existed are keyed by the bare NAME with no `clientId` field; those belong to
 * the default client and are migrated lazily — overwritten on set, removed on
 * delete. That one-document split is what removes the write queue this file
 * used to carry: setting one secret never reads or rewrites another.
 *
 * Secret values are never returned by `read()`, and nothing outside this module
 * reads them.
 */

import type { Db, Filter } from "mongodb";

import { DEFAULT_AGENT_CONFIG } from "../../lib/agent-config/defaults";
import {
  AGENT_CONFIG_VERSION,
  LIMITS,
  SECRET_KEY_RE,
  validateAgentConfig,
  type AgentConfig,
} from "../../lib/agent-config/schema";
import { DEFAULT_CLIENT_ID } from "../../lib/clients/types";
import { getDb, type DbAccessor } from "../db/client";

export type StoreLogger = (message: string) => void;

export interface ConfigStore {
  /** The client's saved config, or the seed defaults if none is stored. */
  read(clientId?: string): Promise<AgentConfig>;
  /** Persists a config, stamping `updatedAt`. Returns what was written. */
  write(config: AgentConfig, clientId?: string): Promise<AgentConfig>;
  listSecretKeys(clientId?: string): Promise<string[]>;
  /**
   * Secret VALUES, for resolving `{{NAME}}` references when the gateway calls a
   * tool on the agent's behalf.
   *
   * The only reader is the tool runner in the gateway process. Nothing in
   * `app/` may call this: the contract everywhere else is that values never
   * leave the server, and an API route that returned them would break it.
   */
  resolveSecrets(clientId?: string): Promise<Record<string, string>>;
  setSecret(key: string, value: string, clientId?: string): Promise<void>;
  deleteSecret(key: string, clientId?: string): Promise<void>;
}

const CONFIG_COLLECTION = "agent_config";
const SECRETS_COLLECTION = "agent_secrets";

interface ConfigDoc {
  /** The owning client's id. */
  _id: string;
  value: AgentConfig;
}

interface SecretDoc {
  /** `<clientId>:<NAME>`, or the bare NAME for pre-client documents. */
  _id: string;
  /** Absent on pre-client documents, which belong to the default client. */
  clientId?: string;
  /** The secret's name, e.g. STRIPE_KEY. Absent on pre-client documents. */
  key?: string;
  value: string;
}

/**
 * The documents a client's secrets live in. Only the default client matches
 * the legacy shape — a client id contains a lowercase letter or hyphen, so a
 * bare UPPER_SNAKE key can never collide with a prefixed one.
 */
function secretSelector(clientId: string): Filter<SecretDoc> {
  return clientId === DEFAULT_CLIENT_ID
    ? { $or: [{ clientId }, { clientId: { $exists: false } }] }
    : { clientId };
}

/** The name a secret document stores, whichever shape it has. */
function secretName(doc: Pick<SecretDoc, "_id" | "key">): string {
  return doc.key ?? doc._id;
}

export function createConfigStore(
  getDatabase: DbAccessor,
  log: StoreLogger = () => {},
): ConfigStore {
  async function configs() {
    const db: Db = await getDatabase();
    return db.collection<ConfigDoc>(CONFIG_COLLECTION);
  }

  async function secrets() {
    const db: Db = await getDatabase();
    return db.collection<SecretDoc>(SECRETS_COLLECTION);
  }

  return {
    async read(clientId: string = DEFAULT_CLIENT_ID): Promise<AgentConfig> {
      // Deliberately uncaught: a connection or query failure must reach the
      // caller. If it read as "defaults" instead, an outage would render the
      // editor with seed values and the next save would overwrite real work.
      const doc = await (await configs()).findOne({ _id: clientId });

      // No document is the first-run path for this client, not a failure.
      // structuredClone rather than a shallow copy, so nested objects (models,
      // welcome, variables) are not shared across every fallback read.
      if (!doc) return structuredClone(DEFAULT_AGENT_CONFIG);

      const record = doc.value as Partial<AgentConfig> | null;
      if (typeof record !== "object" || record === null) {
        log(`the stored agent config for ${clientId} is not an object, using defaults`);
        return structuredClone(DEFAULT_AGENT_CONFIG);
      }
      if (record.version !== AGENT_CONFIG_VERSION) {
        // Left in the database untouched so the user's data stays recoverable.
        log(
          `the stored agent config for ${clientId} has unsupported version ${String(record.version)}, using defaults`,
        );
        return structuredClone(DEFAULT_AGENT_CONFIG);
      }

      const result = validateAgentConfig(record);
      if (!result.ok) {
        // Left in the database untouched so the user's data stays recoverable.
        const summary = result.errors.map((error) => error.path || "(root)").join(", ");
        log(`the stored agent config for ${clientId} failed validation (${summary}), using defaults`);
        return structuredClone(DEFAULT_AGENT_CONFIG);
      }

      // validateAgentConfig stamps updatedAt with "now"; the stored value is
      // the truth about when this config was last saved.
      return {
        ...result.config,
        updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : result.config.updatedAt,
      };
    },

    async write(config: AgentConfig, clientId: string = DEFAULT_CLIENT_ID): Promise<AgentConfig> {
      const saved: AgentConfig = {
        ...config,
        version: AGENT_CONFIG_VERSION,
        secretKeys: [],
        updatedAt: new Date().toISOString(),
      };
      await (await configs()).replaceOne(
        { _id: clientId },
        { value: saved },
        { upsert: true },
      );
      return saved;
    },

    async resolveSecrets(clientId: string = DEFAULT_CLIENT_ID): Promise<Record<string, string>> {
      try {
        const docs = await (await secrets()).find(secretSelector(clientId)).toArray();
        // Prefixed documents win: after a lazy migration both shapes can
        // briefly exist for the default client, and the prefixed one is the
        // one setSecret last wrote.
        docs.sort((a, b) => (a.clientId ? 1 : 0) - (b.clientId ? 1 : 0));
        return Object.fromEntries(docs.map((doc) => [secretName(doc), doc.value]));
      } catch (cause) {
        // The one place that still swallows a failure, and it is deliberate.
        // Leaving tools unauthenticated is better than taking a live call down:
        // the request then fails with the endpoint's own 401, which is a
        // legible outcome. Only the error's NAME is logged — a driver error can
        // quote the query, and this query is about secret material.
        log(`the secrets could not be read (${(cause as Error).name})`);
        return {};
      }
    },

    async listSecretKeys(clientId: string = DEFAULT_CLIENT_ID): Promise<string[]> {
      const docs = await (await secrets())
        .find(secretSelector(clientId), { projection: { _id: 1, key: 1 } })
        .toArray();
      return [...new Set(docs.map(secretName))].sort();
    },

    async setSecret(
      key: string,
      value: string,
      clientId: string = DEFAULT_CLIENT_ID,
    ): Promise<void> {
      if (!SECRET_KEY_RE.test(key) || key.length > LIMITS.secretKeyMax) {
        throw new Error("Secret key must be UPPER_SNAKE_CASE.");
      }
      if (value.length > LIMITS.secretValueMax) {
        throw new Error(`Secret value must be at most ${LIMITS.secretValueMax} characters.`);
      }
      // One document, one upsert. No read-modify-write, so no queue.
      await (await secrets()).updateOne(
        { _id: `${clientId}:${key}` },
        { $set: { clientId, key, value } },
        { upsert: true },
      );
      // Lazy migration: the new document now owns this name, so a legacy
      // duplicate would only shadow deletes. Written after the upsert so a
      // crash between the two leaves both — and resolveSecrets prefers the
      // prefixed one.
      if (clientId === DEFAULT_CLIENT_ID) {
        await (await secrets()).deleteOne({ _id: key, clientId: { $exists: false } });
      }
    },

    async deleteSecret(key: string, clientId: string = DEFAULT_CLIENT_ID): Promise<void> {
      await (await secrets()).deleteOne({ _id: `${clientId}:${key}` });
      if (clientId === DEFAULT_CLIENT_ID) {
        await (await secrets()).deleteOne({ _id: key, clientId: { $exists: false } });
      }
    },
  };
}

/**
 * The instance every caller in this process should use.
 *
 * The gateway builds its own store with its own logger; this one serves the
 * Next process, where a silent fallback previously meant a rejected config
 * produced no output anywhere and the editor showed seed defaults with no clue
 * that saved work had been refused.
 */
export const configStore = createConfigStore(getDb, (message) =>
  console.warn(`[agent-config] ${message}`),
);
