/**
 * Persistence for the agent configuration.
 *
 * Two processes read this: the Next route handlers and the voice gateway. They
 * meet at the database, so neither needs to know the other exists.
 *
 * The config is one document, `_id: "singleton"`, in `agent_config`. Secrets
 * are a document EACH in `agent_secrets`, keyed by name. That split is what
 * removes the write queue this file used to carry: setting one secret no longer
 * reads every secret, mutates the set, and writes it back, so two callers
 * cannot lose each other's change. The old queue only ever serialised one
 * process anyway.
 *
 * Secret values are never returned by `read()`, and nothing outside this module
 * reads them.
 */

import type { Db } from "mongodb";

import { DEFAULT_AGENT_CONFIG } from "../../lib/agent-config/defaults";
import {
  AGENT_CONFIG_VERSION,
  LIMITS,
  SECRET_KEY_RE,
  validateAgentConfig,
  type AgentConfig,
} from "../../lib/agent-config/schema";
import { getDb, type DbAccessor } from "../db/client";

export type StoreLogger = (message: string) => void;

export interface ConfigStore {
  /** The saved config, or the seed defaults if none is stored. */
  read(): Promise<AgentConfig>;
  /** Persists a config, stamping `updatedAt`. Returns what was written. */
  write(config: AgentConfig): Promise<AgentConfig>;
  listSecretKeys(): Promise<string[]>;
  /**
   * Secret VALUES, for resolving `{{NAME}}` references when the gateway calls a
   * tool on the agent's behalf.
   *
   * The only reader is the tool runner in the gateway process. Nothing in
   * `app/` may call this: the contract everywhere else is that values never
   * leave the server, and an API route that returned them would break it.
   */
  resolveSecrets(): Promise<Record<string, string>>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}

const CONFIG_COLLECTION = "agent_config";
const SECRETS_COLLECTION = "agent_secrets";
const SINGLETON = "singleton";

interface ConfigDoc {
  _id: string;
  value: AgentConfig;
}

interface SecretDoc {
  /** The secret's name, e.g. STRIPE_KEY. */
  _id: string;
  value: string;
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
    async read(): Promise<AgentConfig> {
      // Deliberately uncaught: a connection or query failure must reach the
      // caller. If it read as "defaults" instead, an outage would render the
      // editor with seed values and the next save would overwrite real work.
      const doc = await (await configs()).findOne({ _id: SINGLETON });

      // No document is the first-run path, not a failure. structuredClone
      // rather than a shallow copy, so nested objects (models, welcome,
      // variables) are not shared across every fallback read in this process.
      if (!doc) return structuredClone(DEFAULT_AGENT_CONFIG);

      const record = doc.value as Partial<AgentConfig> | null;
      if (typeof record !== "object" || record === null) {
        log("the stored agent config is not an object, using defaults");
        return structuredClone(DEFAULT_AGENT_CONFIG);
      }
      if (record.version !== AGENT_CONFIG_VERSION) {
        // Left in the database untouched so the user's data stays recoverable.
        log(
          `the stored agent config has unsupported version ${String(record.version)}, using defaults`,
        );
        return structuredClone(DEFAULT_AGENT_CONFIG);
      }

      const result = validateAgentConfig(record);
      if (!result.ok) {
        // Left in the database untouched so the user's data stays recoverable.
        const summary = result.errors.map((error) => error.path || "(root)").join(", ");
        log(`the stored agent config failed validation (${summary}), using defaults`);
        return structuredClone(DEFAULT_AGENT_CONFIG);
      }

      // validateAgentConfig stamps updatedAt with "now"; the stored value is
      // the truth about when this config was last saved.
      return {
        ...result.config,
        updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : result.config.updatedAt,
      };
    },

    async write(config: AgentConfig): Promise<AgentConfig> {
      const saved: AgentConfig = {
        ...config,
        version: AGENT_CONFIG_VERSION,
        secretKeys: [],
        updatedAt: new Date().toISOString(),
      };
      await (await configs()).replaceOne(
        { _id: SINGLETON },
        { value: saved },
        { upsert: true },
      );
      return saved;
    },

    async resolveSecrets(): Promise<Record<string, string>> {
      try {
        const docs = await (await secrets()).find({}).toArray();
        return Object.fromEntries(docs.map((doc) => [doc._id, doc.value]));
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

    async listSecretKeys(): Promise<string[]> {
      const docs = await (await secrets())
        .find({}, { projection: { _id: 1 } })
        .toArray();
      return docs.map((doc) => doc._id).sort();
    },

    async setSecret(key: string, value: string): Promise<void> {
      if (!SECRET_KEY_RE.test(key) || key.length > LIMITS.secretKeyMax) {
        throw new Error("Secret key must be UPPER_SNAKE_CASE.");
      }
      if (value.length > LIMITS.secretValueMax) {
        throw new Error(`Secret value must be at most ${LIMITS.secretValueMax} characters.`);
      }
      // One document, one upsert. No read-modify-write, so no queue.
      await (await secrets()).updateOne({ _id: key }, { $set: { value } }, { upsert: true });
    },

    async deleteSecret(key: string): Promise<void> {
      await (await secrets()).deleteOne({ _id: key });
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
