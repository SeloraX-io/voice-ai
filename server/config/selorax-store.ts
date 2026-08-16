/**
 * Persistence for the bridge's Selorax connection configuration.
 *
 * Same shape as the other stores here: a JSON file under data/, written
 * temp-file-and-rename so a crash mid-write cannot truncate it, and reads that
 * never throw — a corrupt file degrades to "not configured", which the page can
 * show, rather than taking the route down.
 *
 * This file holds an auth token in plaintext. data/ is git-ignored precisely
 * because of files like this one.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  EMPTY_SELORAX_CONFIG,
  validateSeloraxConfig,
  type SeloraxConfig,
} from "../../lib/selorax/config";

export type StoreLogger = (message: string) => void;

export interface SeloraxStore {
  read(): Promise<SeloraxConfig>;
  write(config: SeloraxConfig): Promise<SeloraxConfig>;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function createQueue(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job, job);
    tail = run.catch(() => undefined);
    return run;
  };
}

export function createSeloraxStore(dataDir: string, log: StoreLogger = () => {}): SeloraxStore {
  const file = path.join(dataDir, "selorax.json");
  const enqueue = createQueue();

  return {
    async read(): Promise<SeloraxConfig> {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(file, "utf8"));
      } catch (error) {
        // Log the error's name only — the file contains an auth token.
        if (!isMissing(error)) log(`selorax.json is unreadable (${(error as Error).name})`);
        return EMPTY_SELORAX_CONFIG;
      }
      const result = validateSeloraxConfig(parsed);
      if (!result.ok) {
        log("selorax.json failed validation; treating it as unconfigured");
        return EMPTY_SELORAX_CONFIG;
      }
      return result.value;
    },

    async write(config: SeloraxConfig): Promise<SeloraxConfig> {
      return enqueue(async () => {
        await mkdir(dataDir, { recursive: true });
        const temp = `${file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600,
          });
          await rename(temp, file);
        } catch (cause) {
          await unlink(temp).catch(() => undefined);
          throw cause;
        }
        return config;
      });
    },
  };
}

export const seloraxStore = createSeloraxStore(path.join(process.cwd(), "data"), (message) =>
  console.warn(`[selorax] ${message}`),
);
