/**
 * Persistence for finished call records.
 *
 * Written by the voice gateway when a call ends and read by the Next process to
 * display them, so — like the agent configuration — the database is the meeting
 * point and neither process needs to know the other exists.
 *
 * One document per call, `_id` being the record's own id. An append is a single
 * insert rather than a rewrite of the whole history, which is why there is no
 * write queue here any more and why there is no longer a cap on how many
 * records are kept: the old 500-record limit existed only so one JSON file
 * could not grow without bound.
 */

import type { Db } from "mongodb";

import type { CallRecord } from "../../lib/call-logs/types";
import { DEFAULT_CLIENT_ID } from "../../lib/clients/types";
import { getDb, type DbAccessor } from "../db/client";

export type StoreLogger = (message: string) => void;

export interface CallLogStore {
  /**
   * Newest first. With a clientId, only that client's calls — where the
   * default client also owns every record written before calls carried a
   * client at all.
   */
  read(clientId?: string): Promise<CallRecord[]>;
  append(record: CallRecord): Promise<void>;
  /**
   * Amends a record in place, for detail that arrives after the call — the
   * summary is written once the transcript has been through a text model.
   * A record that is not there is a no-op.
   */
  update(id: string, patch: (record: CallRecord) => CallRecord): Promise<void>;
}

const COLLECTION = "call_logs";

/** The record as stored: its own id doubles as the document key. */
type CallLogDoc = CallRecord & { _id: string };

/**
 * Strips the document key back off, leaving the domain record.
 *
 * `_id` always equals `record.id`, so nothing is lost. Written as a delete
 * rather than a destructure because the discarded binding an `{ _id, ...rest }`
 * would create is exactly what the unused-variable lint flags.
 */
function toRecord(doc: CallLogDoc): CallRecord {
  const record: Partial<CallLogDoc> = { ...doc };
  delete record._id;
  return record as CallRecord;
}

export function createCallLogStore(
  getDatabase: DbAccessor,
  log: StoreLogger = () => {},
): CallLogStore {
  async function collection() {
    const db: Db = await getDatabase();
    return db.collection<CallLogDoc>(COLLECTION);
  }

  return {
    async read(clientId?: string): Promise<CallRecord[]> {
      const filter =
        clientId === undefined
          ? {}
          : clientId === DEFAULT_CLIENT_ID
            ? { $or: [{ clientId }, { clientId: { $exists: false } }] }
            : { clientId };
      // Sorted on startedAt rather than insertion order, backed by the index
      // created in server/db/client.ts. The _id tie-break only decides records
      // that started in the same millisecond, and exists so the order is at
      // least stable when that happens.
      const docs = await (await collection())
        .find(filter)
        .sort({ startedAt: -1, _id: -1 })
        .toArray();
      return docs.map(toRecord);
    },

    async append(record: CallRecord): Promise<void> {
      await (await collection()).insertOne({ ...record, _id: record.id } as CallLogDoc);
    },

    async update(id: string, patch: (record: CallRecord) => CallRecord): Promise<void> {
      const calls = await collection();
      const doc = await calls.findOne({ _id: id });
      if (!doc) {
        // Worth a line now. Under the old file store a record could fall off
        // the 500-record cap and legitimately vanish before its summary
        // arrived; with no cap, a missing record means something unexpected.
        log(`there is no call record ${id} to update`);
        return;
      }

      const next = patch(toRecord(doc));
      // No `_id` in the replacement: mongodb v7 types it `WithoutId<TSchema>`,
      // and the filter's `_id` is what identifies the document anyway.
      await calls.replaceOne({ _id: id }, next);
    },
  };
}

/** The instance the Next process should use. */
export const callLogStore = createCallLogStore(getDb, (message) =>
  console.warn(`[call-logs] ${message}`),
);
