/**
 * Call history: what each of the active client's calls cost and what it spent
 * to get there.
 *
 * Read on the server so the table is populated on first paint. Scoped the same
 * way the console layout scopes everything: the cookie names the client, the
 * first client is the fallback, and the default client also owns records
 * written before calls carried a client id.
 */

import { CallsTable } from "@/components/calls/CallsTable";
import { callLogStore } from "@/server/config/call-log-store";
import { resolveActiveClient } from "../active-client";

export const dynamic = "force-dynamic";

export default async function CallsPage() {
  const { activeClient } = await resolveActiveClient();
  const calls = await callLogStore.read(activeClient.id);
  return <CallsTable calls={calls} />;
}
