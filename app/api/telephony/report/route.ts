/**
 * POST /api/telephony/report — tells Selorax whether an inbound call was
 * answered or declined, for its own call correlation.
 *
 * Always responds 202, even when the upstream report fails: correlation
 * bookkeeping must never fail or delay a live call. A caller waiting on this
 * HTTP round trip is a worse outcome than a call missing from a report, so
 * failures are logged server-side instead of surfaced to the response.
 */

import { NextResponse } from "next/server";

import { seloraxStore } from "@/server/config/selorax-store";
import { createCallingClient } from "@/server/selorax/calling-client";

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

  try {
    const client = createCallingClient(await seloraxStore.read());
    if (event === "answered") {
      await client.reportAnswered(callerPhone);
    } else {
      await client.reportDeclined(callerPhone);
    }
  } catch (cause) {
    console.error(`[selorax] report(${event}) failed:`, cause);
  }

  return NextResponse.json({}, { status: 202 });
}
