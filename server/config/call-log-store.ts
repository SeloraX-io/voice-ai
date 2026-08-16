/**
 * Persistence for finished call records.
 *
 * Written by the voice gateway when a call ends and read by the Next process
 * to display them, so — like the agent configuration — a file on disk is the
 * meeting point and neither process needs to know the other exists.
 *
 * Appends go through the same temp-file-and-rename dance as the config store:
 * a crash mid-write can truncate the temp file, never the history. Writes are
 * serialised in-process because an append is a read-modify-write, and two
 * overlapping calls hanging up together would otherwise lose one record.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CallRecord } from "../../lib/call-logs/types";

export type StoreLogger = (message: string) => void;

/**
 * How many calls to keep. Old records are dropped from the front, so the file
 * cannot grow without bound on a busy deployment.
 */
export const MAX_RECORDS = 500;

export interface CallLogStore {
  /** Newest first. Never throws — a broken file reads as an empty history. */
  read(): Promise<CallRecord[]>;
  append(record: CallRecord): Promise<void>;
  /**
   * Amends a record in place, for detail that arrives after the call — the
   * summary is written once the transcript has been through a text model.
   * A record that has since fallen off the end of the history is a no-op.
   */
  update(id: string, patch: (record: CallRecord) => CallRecord): Promise<void>;
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

export function createCallLogStore(dataDir: string, log: StoreLogger = () => {}): CallLogStore {
  const file = path.join(dataDir, "call-logs.json");
  const enqueue = createQueue();

  async function readAll(): Promise<CallRecord[]> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      // A missing file is the first-run path, not a failure.
      if (!isMissing(error)) log(`call-logs.json is unreadable (${(error as Error).name})`);
      return [];
    }
    if (!Array.isArray(parsed)) {
      log("call-logs.json is not a list; ignoring it");
      return [];
    }
    return parsed as CallRecord[];
  }

  async function writeAll(records: CallRecord[]): Promise<void> {
    await mkdir(dataDir, { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(records, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
      await rename(temp, file);
    } catch (cause) {
      await unlink(temp).catch(() => undefined);
      throw cause;
    }
  }

  return {
    async read(): Promise<CallRecord[]> {
      const records = await readAll();
      return [...records].reverse();
    },

    async update(id: string, patch: (record: CallRecord) => CallRecord): Promise<void> {
      await enqueue(async () => {
        const records = await readAll();
        const index = records.findIndex((entry) => entry.id === id);
        if (index === -1) return;
        records[index] = patch(records[index]);
        await writeAll(records);
      });
    },

    async append(record: CallRecord): Promise<void> {
      await enqueue(async () => {
        const records = await readAll();
        records.push(record);

        await writeAll(records.slice(-MAX_RECORDS));
      });
    },
  };
}

/** The instance the Next process should use. */
export const callLogStore = createCallLogStore(path.join(process.cwd(), "data"), (message) =>
  console.warn(`[call-logs] ${message}`),
);
