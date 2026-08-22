import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_AGENT_CONFIG } from "../../lib/agent-config/defaults";
import { DEFAULT_CLIENT_ID } from "../../lib/clients/types";
import { freshDb, startTestMongo, stopTestMongo } from "../db/test-db";
import { createClientStore, slugifyClientName } from "./client-store";
import { createConfigStore } from "./store";

before(startTestMongo);
after(stopTestMongo);

test("an empty deployment lists exactly the seeded default client", async () => {
  const store = createClientStore(await freshDb());
  const clients = await store.list();
  assert.equal(clients.length, 1);
  assert.equal(clients[0].id, DEFAULT_CLIENT_ID);
});

test("the default client's id is the pre-client config key, so old data is adopted", async () => {
  const getDb = await freshDb();
  // A config written by the single-tenant version of this app.
  await createConfigStore(getDb).write({ ...DEFAULT_AGENT_CONFIG, agentName: "ada" });

  const clients = await createClientStore(getDb).list();
  assert.equal((await createConfigStore(getDb).read(clients[0].id)).agentName, "ada");
});

test("create slugifies the name and returns the client", async () => {
  const store = createClientStore(await freshDb());
  const client = await store.create("  Acme   Dental!  ");
  assert.equal(client.id, "acme-dental");
  assert.equal(client.name, "Acme Dental!");
});

test("two clients with the same name get distinct ids", async () => {
  const store = createClientStore(await freshDb());
  const first = await store.create("Acme");
  const second = await store.create("Acme");
  assert.notEqual(first.id, second.id);
  // No seed here: the roster was never listed while empty, and these two
  // stop it from ever being empty.
  assert.equal((await store.list()).length, 2);
});

test("create rejects a blank name", async () => {
  const store = createClientStore(await freshDb());
  await assert.rejects(() => store.create("   "), /1–80/);
});

test("rename changes the name and keeps the id", async () => {
  const store = createClientStore(await freshDb());
  const created = await store.create("Acme");
  const renamed = await store.rename(created.id, "Acme Dental");
  assert.equal(renamed?.id, created.id);
  assert.equal(renamed?.name, "Acme Dental");
});

test("rename of an unknown client returns null", async () => {
  const store = createClientStore(await freshDb());
  await store.list(); // seed
  assert.equal(await store.rename("nope", "Whatever"), null);
});

test("the last client cannot be deleted", async () => {
  const store = createClientStore(await freshDb());
  const [only] = await store.list();
  const result = await store.remove(only.id);
  assert.equal(result.ok, false);
});

test("removing a client deletes its config and secrets but not its call records", async () => {
  const getDb = await freshDb();
  const clients = createClientStore(getDb);
  const configs = createConfigStore(getDb);
  await clients.list(); // seed, so the removal below is not "the last client"

  const acme = await clients.create("Acme");
  await configs.write({ ...DEFAULT_AGENT_CONFIG, agentName: "acme-agent" }, acme.id);
  await configs.setSecret("API_KEY", "shh", acme.id);

  const db = await getDb();
  await db.collection("call_logs").insertOne({ _id: "call-1", clientId: acme.id } as never);

  assert.deepEqual((await clients.remove(acme.id)), { ok: true });
  assert.equal(await clients.get(acme.id), null);
  assert.equal((await configs.read(acme.id)).agentName, DEFAULT_AGENT_CONFIG.agentName);
  assert.deepEqual(await configs.listSecretKeys(acme.id), []);
  assert.equal(await db.collection("call_logs").countDocuments(), 1);
});

test("removing the default client also removes legacy, un-prefixed secrets", async () => {
  const getDb = await freshDb();
  const clients = createClientStore(getDb);
  await clients.list();
  await clients.create("Acme"); // so the default is not the last client

  const db = await getDb();
  // A secret written before secrets carried a clientId.
  await db.collection("agent_secrets").insertOne({ _id: "OLD_KEY", value: "v" } as never);

  assert.deepEqual(await clients.remove(DEFAULT_CLIENT_ID), { ok: true });
  assert.equal(await db.collection("agent_secrets").countDocuments(), 0);
});

test("slugifyClientName falls back for names with nothing sluggable", () => {
  assert.equal(slugifyClientName("Acme Dental"), "acme-dental");
  assert.equal(slugifyClientName("!!!"), "client");
  assert.equal(slugifyClientName("বাংলা"), "client");
});
