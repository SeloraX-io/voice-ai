/**
 * Persistence for the bridge's SIP credentials.
 *
 * One document, `_id: "singleton"`, in `telephony_credentials`. A write is a
 * single upsert, so nothing needs serialising in-process.
 *
 * A missing document is the first-run path and reads as unconfigured. A
 * document that fails validation also reads as unconfigured and is left where
 * it is. A database that cannot be reached THROWS, so an outage can never look
 * like "no credentials" and get saved over.
 *
 * This document holds a SIP password. Only an error's name is ever logged — a
 * driver error can quote the query that failed, and the query carries it.
 */

import type { Db } from "mongodb";

import {
  EMPTY_CREDENTIALS,
  validateSipCredentials,
  type SipCredentials,
} from "../../lib/telephony/credentials";
import { getDb, type DbAccessor } from "../db/client";

export type StoreLogger = (message: string) => void;

export interface TelephonyStore {
  read(): Promise<SipCredentials>;
  write(credentials: SipCredentials): Promise<SipCredentials>;
}

const COLLECTION = "telephony_credentials";
const SINGLETON = "singleton";

interface TelephonyDoc {
  _id: string;
  value: SipCredentials;
}

export function createTelephonyStore(
  getDatabase: DbAccessor,
  log: StoreLogger = () => {},
): TelephonyStore {
  async function collection() {
    const db: Db = await getDatabase();
    return db.collection<TelephonyDoc>(COLLECTION);
  }

  return {
    async read(): Promise<SipCredentials> {
      // Not wrapped in try/catch on purpose — see the note at the top.
      const doc = await (await collection()).findOne({ _id: SINGLETON });
      if (!doc) return EMPTY_CREDENTIALS;

      const result = validateSipCredentials(doc.value);
      if (!result.ok) {
        log("the stored SIP credentials failed validation; treating them as unconfigured");
        return EMPTY_CREDENTIALS;
      }
      return result.value;
    },

    async write(credentials: SipCredentials): Promise<SipCredentials> {
      await (await collection()).replaceOne(
        { _id: SINGLETON },
        { value: credentials },
        { upsert: true },
      );
      return credentials;
    },
  };
}

export const telephonyStore = createTelephonyStore(getDb, (message) =>
  console.warn(`[telephony] ${message}`),
);
