/**
 * POST /api/telephony/report — tells Selorax whether an inbound call was
 * answered or declined, for its own call correlation.
 *
 * Always responds 202 immediately, without waiting on the upstream report:
 * correlation bookkeeping must never fail *or delay* a live call. This route
 * is called at the instant the bridge answers a ringing phone, and
 * `createCallingClient`'s requests carry a 10-second timeout — awaiting the
 * report before responding could hold that response open for up to 10
 * seconds whenever Selorax is slow or unreachable. See `dispatchReport` in
 * `server/selorax/report.ts` for how the report is fired without being
 * awaited, and why that is safe on this route's `runtime = "nodejs"`.
 *
 * Guarded on `isSeloraxConfigured`, the same precondition `GET
 * /api/telephony/line` already checks — without it, a call in direct mode (no
 * Selorax config) would build a client against an empty base URL and log a
 * pointless failure on every answer and decline. The bridge itself now skips
 * this call in direct mode too (see `useSoftphoneBridge.ts`); this guard is
 * what keeps the two routes agreeing about the same precondition rather than
 * only one of them enforcing it.
 */

import { NextResponse } from "next/server";

import { isSeloraxConfigured } from "@/lib/selorax/config";
import { seloraxStore } from "@/server/config/selorax-store";
import { createCallingClient } from "@/server/selorax/calling-client";
import { dispatchReport } from "@/server/selorax/report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function badRequest(path: string, message: string): NextResponse {
  return NextResponse.json({ errors: [{ path, message }] }, { status: 400 });
}

export async function POST(request: Request): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null) {
    return badRequest("", "Expected a JSON object.");
  }

  const { event, callerPhone } = body as { event?: unknown; callerPhone?: unknown };
  if (event !== "answered" && event !== "declined") {
    return badRequest("event", 'Must be "answered" or "declined".');
  }
  if (typeof callerPhone !== "string" || callerPhone.trim().length === 0) {
    return badRequest("callerPhone", "Required.");
  }

  const config = await seloraxStore.read();
  if (!isSeloraxConfigured(config)) {
    // Nothing to correlate against — Selorax is not connected. Not an error:
    // the bridge should never have called this route in direct mode, and a
    // 202 here matches this route's own "always succeeds" contract rather
    // than surfacing a precondition the caller cannot act on mid-call.
    return NextResponse.json({}, { status: 202 });
  }

  const client = createCallingClient(config);
  dispatchReport(client, event, callerPhone, (cause) => {
    console.error(`[selorax] report(${event}) failed:`, cause);
  });

  return NextResponse.json({}, { status: 202 });
}
