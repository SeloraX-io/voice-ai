/**
 * A real mongod for tests, in-process and thrown away afterwards.
 *
 * One server per test FILE (node:test gives each file its own process), and a
 * freshly named database per call to `freshDb`, so tests stay independent
 * without paying server startup each time.
 */

import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";

import { ensureIndexes, type DbAccessor } from "./client";

let server: MongoMemoryServer | null = null;
let client: MongoClient | null = null;
let counter = 0;

export async function startTestMongo(): Promise<void> {
  server = await MongoMemoryServer.create();
  client = new MongoClient(server.getUri());
  await client.connect();
}

export async function stopTestMongo(): Promise<void> {
  await client?.close();
  await server?.stop();
  client = null;
  server = null;
}

/** A store-ready accessor onto a database no other test is using. */
export async function freshDb(): Promise<DbAccessor> {
  if (!client) throw new Error("startTestMongo() was not called");
  const db: Db = client.db(`test_${++counter}`);
  await ensureIndexes(db);
  return async () => db;
}

/** An accessor that always fails, for testing the unreachable-database path. */
export function unreachableDb(): DbAccessor {
  return async () => {
    throw new Error("connection refused");
  };
}
