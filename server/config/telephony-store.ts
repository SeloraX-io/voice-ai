/**
 * Persistence for the bridge's SIP credentials.
 *
 * Same shape as the other stores here: a JSON file under data/, written
 * temp-file-and-rename so a crash mid-write cannot truncate it, and reads that
 * never throw — a corrupt file degrades to "not configured", which the page can
 * show, rather than taking the route down.
 *
 * This file holds a SIP password in plaintext. data/ is git-ignored precisely
 * because of files like this one.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  EMPTY_CREDENTIALS,
  validateSipCredentials,
  type SipCredentials,
} from "../../lib/telephony/credentials";

export type StoreLogger = (message: string) => void;

export interface TelephonyStore {
  read(): Promise<SipCredentials>;
  write(credentials: SipCredentials): Promise<SipCredentials>;
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

export function createTelephonyStore(dataDir: string, log: StoreLogger = () => {}): TelephonyStore {
  const file = path.join(dataDir, "telephony.json");
  const enqueue = createQueue();

  return {
    async read(): Promise<SipCredentials> {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(file, "utf8"));
      } catch (error) {
        // Log the error's name only — the file contains a password.
        if (!isMissing(error)) log(`telephony.json is unreadable (${(error as Error).name})`);
        return EMPTY_CREDENTIALS;
      }
      const result = validateSipCredentials(parsed);
      if (!result.ok) {
        log("telephony.json failed validation; treating it as unconfigured");
        return EMPTY_CREDENTIALS;
      }
      return result.value;
    },

    async write(credentials: SipCredentials): Promise<SipCredentials> {
      return enqueue(async () => {
        await mkdir(dataDir, { recursive: true });
        const temp = `${file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temp, `${JSON.stringify(credentials, null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600,
          });
          await rename(temp, file);
        } catch (cause) {
          await unlink(temp).catch(() => undefined);
          throw cause;
        }
        return credentials;
      });
    },
  };
}

export const telephonyStore = createTelephonyStore(path.join(process.cwd(), "data"), (message) =>
  console.warn(`[telephony] ${message}`),
);
