/**
 * Persistence for the agent configuration.
 *
 * Two processes read this: the Next route handlers and the voice gateway. A
 * file on disk is the meeting point, so neither needs to know the other exists.
 * Writes go through a temp file and a rename, which is atomic on the same
 * filesystem — a crash mid-write can never truncate a good config.
 *
 * Secret values live in their own file, mode 0600 and gitignored. They are
 * never returned by `read()`, and nothing outside this module reads them.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_AGENT_CONFIG } from "../../lib/agent-config/defaults";
import {
  AGENT_CONFIG_VERSION,
  LIMITS,
  SECRET_KEY_RE,
  validateAgentConfig,
  type AgentConfig,
} from "../../lib/agent-config/schema";

export type StoreLogger = (message: string) => void;

export interface ConfigStore {
  /** The saved config, or the seed defaults if none is readable. Never throws. */
  read(): Promise<AgentConfig>;
  /** Persists a config, stamping `updatedAt`. Returns what was written. */
  write(config: AgentConfig): Promise<AgentConfig>;
  listSecretKeys(): Promise<string[]>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * Serialises the secrets read-modify-write cycle. Atomic writes protect a
 * single write; they do not protect read → mutate → write across two callers,
 * where the later rename would silently drop the earlier caller's change.
 *
 * This is in-process serialization only, which is the right scope here: the
 * gateway process only ever reads the secrets file, and Next is the sole
 * writer. It is not a cross-process lock.
 */
function createQueue(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job, job);
    // Keep the chain alive even when a job rejects, so one failure does not
    // wedge every later write.
    tail = run.catch(() => undefined);
    return run;
  };
}

export function createConfigStore(dataDir: string, log: StoreLogger = () => {}): ConfigStore {
  const configPath = path.join(dataDir, "agent-config.json");
  const secretsPath = path.join(dataDir, "agent-secrets.json");
  const enqueueSecretWrite = createQueue();

  async function writeAtomic(target: string, contents: string, mode: number): Promise<void> {
    await mkdir(dataDir, { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, contents, { encoding: "utf8", mode });
      await rename(temp, target);
    } catch (cause) {
      await unlink(temp).catch(() => undefined);
      throw cause;
    }
  }

  /**
   * A missing file is the ordinary first-run path. An unparseable one is not:
   * returning `{}` there would let the next write rename an empty object over
   * the user's real secrets, destroying every one of them. Throwing keeps the
   * file on disk and recoverable, matching how the config path behaves.
   *
   * The error's message is never logged. Node's JSON.parse SyntaxError embeds a
   * snippet of the input, which on this file is secret material.
   */
  async function readSecrets(): Promise<Record<string, string>> {
    let raw: string;
    try {
      raw = await readFile(secretsPath, "utf8");
    } catch (error) {
      if (isMissing(error)) return {};
      log(`agent-secrets.json could not be read (${(error as Error).name})`);
      throw new Error("The secrets file could not be read.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      log(`agent-secrets.json is not valid JSON (${(error as Error).name})`);
      throw new Error("The secrets file is corrupt; it was left untouched.");
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      log("agent-secrets.json is not an object; it was left untouched");
      throw new Error("The secrets file is corrupt; it was left untouched.");
    }
    return parsed as Record<string, string>;
  }

  return {
    async read(): Promise<AgentConfig> {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(configPath, "utf8"));
      } catch (error) {
        // A missing file is the first-run path, not a failure.
        if (!isMissing(error)) {
          log(`agent-config.json is unreadable, using defaults: ${String(error)}`);
        }
        // A shallow copy would share DEFAULT_AGENT_CONFIG's nested objects
        // (models, welcome, variables) across every fallback read in this
        // process; structuredClone gives each caller its own object graph.
        return structuredClone(DEFAULT_AGENT_CONFIG);
      }

      const record = parsed as Partial<AgentConfig> | null;
      if (typeof record !== "object" || record === null) {
        log("agent-config.json is not an object, using defaults");
        return structuredClone(DEFAULT_AGENT_CONFIG);
      }
      if (record.version !== AGENT_CONFIG_VERSION) {
        // Left on disk untouched so the user's data stays recoverable.
        log(`agent-config.json has unsupported version ${String(record.version)}, using defaults`);
        return structuredClone(DEFAULT_AGENT_CONFIG);
      }

      const result = validateAgentConfig(record);
      if (!result.ok) {
        // Left on disk untouched so the user's data stays recoverable.
        const summary = result.errors.map((error) => error.path || "(root)").join(", ");
        log(`agent-config.json failed validation (${summary}), using defaults`);
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
      await writeAtomic(configPath, `${JSON.stringify(saved, null, 2)}\n`, 0o644);
      return saved;
    },

    async listSecretKeys(): Promise<string[]> {
      try {
        return Object.keys(await readSecrets()).sort();
      } catch {
        // A corrupt file must not take down the console that lists these names.
        // Writes still refuse (see setSecret/deleteSecret), so nothing is lost.
        return [];
      }
    },

    async setSecret(key: string, value: string): Promise<void> {
      if (!SECRET_KEY_RE.test(key) || key.length > LIMITS.secretKeyMax) {
        throw new Error("Secret key must be UPPER_SNAKE_CASE.");
      }
      if (value.length > LIMITS.secretValueMax) {
        throw new Error(`Secret value must be at most ${LIMITS.secretValueMax} characters.`);
      }
      await enqueueSecretWrite(async () => {
        const secrets = await readSecrets();
        secrets[key] = value;
        await writeAtomic(secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, 0o600);
      });
    },

    async deleteSecret(key: string): Promise<void> {
      await enqueueSecretWrite(async () => {
        const secrets = await readSecrets();
        if (!(key in secrets)) return;
        delete secrets[key];
        await writeAtomic(secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, 0o600);
      });
    },
  };
}

/**
 * The instance every caller in this process should use.
 *
 * The gateway builds its own store with its own logger; this one serves the
 * Next process, where a silent fallback previously meant a rejected config file
 * produced no output anywhere and the editor showed seed defaults with no clue
 * that saved work had been refused.
 */
export const configStore = createConfigStore(path.join(process.cwd(), "data"), (message) =>
  console.warn(`[agent-config] ${message}`),
);
