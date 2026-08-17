/**
 * One call, in full: what it cost, what was said, and what happened.
 *
 * Read on the server — the record is a file on disk, so there is nothing worth
 * a loading state.
 */

import { notFound } from "next/navigation";

import { CallDetail } from "@/components/calls/CallDetail";
import { callLogStore } from "@/server/config/call-log-store";

export const dynamic = "force-dynamic";

export default async function CallPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const call = (await callLogStore.read()).find((entry) => entry.id === id);
  if (!call) notFound();

  return <CallDetail call={call} />;
}
