/**
 * Call history: what each call cost and what it spent to get there.
 *
 * Read on the server so the table is populated on first paint — the records
 * are a file on disk, not something worth a loading state.
 */

import { CallsTable } from "@/components/calls/CallsTable";
import { callLogStore } from "@/server/config/call-log-store";

export const dynamic = "force-dynamic";

export default async function CallsPage() {
  const calls = await callLogStore.read();
  return <CallsTable calls={calls} />;
}
