/**
 * The call history, newest first, scoped to one client via `?client=`.
 *
 * Read-only: records are written by the voice gateway when a call ends, so
 * there is nothing here for the browser to create or delete. The store never
 * throws — a missing or corrupt history reads as an empty list — so this route
 * has no failure branch beyond an unknown client.
 *
 * Runs on the Node runtime because the store touches the database.
 */

import { NextResponse } from "next/server";

import { callLogStore } from "@/server/config/call-log-store";
import { resolveClientScope } from "../client-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const scope = await resolveClientScope(request);
  if (!scope.ok) return scope.response;

  return NextResponse.json({ calls: await callLogStore.read(scope.clientId) });
}
