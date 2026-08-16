/**
 * The call history, newest first.
 *
 * Read-only: records are written by the voice gateway when a call ends, so
 * there is nothing here for the browser to create or delete. The store never
 * throws — a missing or corrupt history reads as an empty list — so this route
 * has no failure branch of its own.
 *
 * Runs on the Node runtime because the store touches the filesystem.
 */

import { NextResponse } from "next/server";

import { callLogStore } from "@/server/config/call-log-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ calls: await callLogStore.read() });
}
