/**
 * Persistence for the bridge's Selorax connection configuration.
 *
 * One document, `_id: "singleton"`, in `selorax_config`. A write is a single
 * upsert, so there is nothing to serialise in-process — which matters, because
 * an in-process queue never protected against the other process anyway.
 *
 * A missing document is the first-run path and reads as unconfigured. A
 * document that fails validation also reads as unconfigured and is left where
 * it is, so bad data stays recoverable. A database that cannot be reached
 * THROWS: treating "unreachable" as "unconfigured" would let the settings page
 * render blank fields and the next save wipe a real configuration.
 *
 * This document holds an auth token. Only an error's name is ever logged — a
 * driver error can quote the query that failed, and the query carries the token.
 */

import type { Db } from "mongodb";

import {
  EMPTY_SELORAX_CONFIG,
  validateSeloraxConfig,
  type SeloraxConfig,
} from "../../lib/selorax/config";
import { getDb, type DbAccessor } from "../db/client";

export type StoreLogger = (message: string) => void;

export interface SeloraxStore {
  read(): Promise<SeloraxConfig>;
  write(config: SeloraxConfig): Promise<SeloraxConfig>;
}

const COLLECTION = "selorax_config";
const SINGLETON = "singleton";

interface SeloraxDoc {
  _id: string;
  value: SeloraxConfig;
}

export function createSeloraxStore(
  getDatabase: DbAccessor,
  log: StoreLogger = () => {},
): SeloraxStore {
  async function collection() {
    const db: Db = await getDatabase();
    return db.collection<SeloraxDoc>(COLLECTION);
  }

  return {
    async read(): Promise<SeloraxConfig> {
      // Not wrapped in try/catch on purpose: a connection or query failure must
      // reach the caller, not masquerade as "not configured".
      const doc = await (await collection()).findOne({ _id: SINGLETON });
      if (!doc) return EMPTY_SELORAX_CONFIG;

      const result = validateSeloraxConfig(doc.value);
      if (!result.ok) {
        log("the stored Selorax config failed validation; treating it as unconfigured");
        return EMPTY_SELORAX_CONFIG;
      }
      return result.value;
    },

    async write(config: SeloraxConfig): Promise<SeloraxConfig> {
      await (await collection()).replaceOne(
        { _id: SINGLETON },
        { value: config },
        { upsert: true },
      );
      return config;
    },
  };
}

export const seloraxStore = createSeloraxStore(getDb, (message) =>
  console.warn(`[selorax] ${message}`),
);
