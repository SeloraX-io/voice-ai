/**
 * Persistence for the client roster.
 *
 * One document per client in `clients`. The roster is never empty: `list()`
 * seeds the default client on first read, under the id the pre-client config
 * document was stored with, so an existing deployment wakes up with its data
 * already belonging to "Default".
 *
 * Removing a client removes what it owns — its config document and its
 * secrets. Call records are kept: they are billing history, and deleting a
 * client must not rewrite what was spent.
 */

import type { Db } from "mongodb";

import {
  CLIENT_NAME_MAX,
  CLIENTS_MAX,
  DEFAULT_CLIENT_ID,
  DEFAULT_CLIENT_NAME,
  type ClientSummary,
} from "../../lib/clients/types";
import { getDb, type DbAccessor } from "../db/client";

export interface ClientStore {
  /** Every client, oldest first. Seeds and returns the default when empty. */
  list(): Promise<ClientSummary[]>;
  get(id: string): Promise<ClientSummary | null>;
  create(name: string): Promise<ClientSummary>;
  rename(id: string, name: string): Promise<ClientSummary | null>;
  /**
   * Deletes the client, its config and its secrets. Refuses to delete the
   * last client, so the console always has something to show.
   */
  remove(id: string): Promise<{ ok: true } | { ok: false; reason: string }>;
}

const COLLECTION = "clients";
const CONFIG_COLLECTION = "agent_config";
const SECRETS_COLLECTION = "agent_secrets";

interface ClientDoc {
  _id: string;
  name: string;
  createdAt: string;
}

function toSummary(doc: ClientDoc): ClientSummary {
  return { id: doc._id, name: doc.name, createdAt: doc.createdAt };
}

function cleanName(name: string): string {
  const value = name.trim().replace(/\s+/g, " ");
  if (value === "" || value.length > CLIENT_NAME_MAX) {
    throw new Error(`Client name must be 1–${CLIENT_NAME_MAX} characters.`);
  }
  return value;
}

/** "Acme Dental!" → "acme-dental". Falls back to "client" for names with no slug in them. */
export function slugifyClientName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug === "" ? "client" : slug;
}

export function createClientStore(getDatabase: DbAccessor): ClientStore {
  async function clients() {
    const db: Db = await getDatabase();
    return db.collection<ClientDoc>(COLLECTION);
  }

  return {
    async list(): Promise<ClientSummary[]> {
      const collection = await clients();
      const docs = await collection.find({}).sort({ createdAt: 1, _id: 1 }).toArray();
      if (docs.length > 0) return docs.map(toSummary);

      // First run: adopt the pre-client data by seeding under its config id.
      // $setOnInsert so two concurrent first reads cannot fight over the name.
      const seed: ClientDoc = {
        _id: DEFAULT_CLIENT_ID,
        name: DEFAULT_CLIENT_NAME,
        createdAt: new Date().toISOString(),
      };
      await collection.updateOne({ _id: seed._id }, { $setOnInsert: seed }, { upsert: true });
      const seeded = await collection.findOne({ _id: seed._id });
      return [toSummary(seeded ?? seed)];
    },

    async get(id: string): Promise<ClientSummary | null> {
      const doc = await (await clients()).findOne({ _id: id });
      return doc ? toSummary(doc) : null;
    },

    async create(name: string): Promise<ClientSummary> {
      const cleaned = cleanName(name);
      const collection = await clients();

      if ((await collection.countDocuments()) >= CLIENTS_MAX) {
        throw new Error(`At most ${CLIENTS_MAX} clients are supported.`);
      }

      // The plain slug first, because "acme-dental" beats "acme-dental-x7k2"
      // in a script tag; a random suffix only on collision.
      const slug = slugifyClientName(cleaned);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const id = attempt === 0 ? slug : `${slug}-${Math.random().toString(36).slice(2, 6)}`;
        const doc: ClientDoc = { _id: id, name: cleaned, createdAt: new Date().toISOString() };
        try {
          await collection.insertOne(doc);
          return toSummary(doc);
        } catch (cause) {
          // 11000 is Mongo's duplicate-key error — someone owns this id already.
          if ((cause as { code?: number }).code !== 11000) throw cause;
        }
      }
      throw new Error("Could not find a free id for this client. Try a different name.");
    },

    async rename(id: string, name: string): Promise<ClientSummary | null> {
      const cleaned = cleanName(name);
      const collection = await clients();
      const result = await collection.findOneAndUpdate(
        { _id: id },
        { $set: { name: cleaned } },
        { returnDocument: "after" },
      );
      return result ? toSummary(result) : null;
    },

    async remove(id: string): Promise<{ ok: true } | { ok: false; reason: string }> {
      const collection = await clients();
      if ((await collection.countDocuments()) <= 1) {
        return { ok: false, reason: "The last client cannot be deleted." };
      }

      const deleted = await collection.deleteOne({ _id: id });
      if (deleted.deletedCount === 0) {
        return { ok: false, reason: "No such client." };
      }

      const db: Db = await getDatabase();
      // The default client also owns the legacy secrets written before secrets
      // carried a clientId at all — see store.ts.
      const secretSelector =
        id === DEFAULT_CLIENT_ID
          ? { $or: [{ clientId: id }, { clientId: { $exists: false } }] }
          : { clientId: id };
      await Promise.all([
        db.collection(CONFIG_COLLECTION).deleteOne({ _id: id as never }),
        db.collection(SECRETS_COLLECTION).deleteMany(secretSelector),
      ]);
      return { ok: true };
    },
  };
}

/** The instance the Next process uses. The gateway never lists clients. */
export const clientStore = createClientStore(getDb);
