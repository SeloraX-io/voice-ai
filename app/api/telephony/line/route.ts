/**
 * GET /api/telephony/line — claims this bridge's SIP line from Selorax.
 *
 * The browser calls this to get what JsSIP needs to register: a WS URL, SIP
 * URI/domain, extension, password, and TURN servers. It never sees the
 * Selorax admin token that was used to fetch them — see `lib/selorax/line.ts`
 * for why the response is built field by field rather than by spreading the
 * `SeloraxLine` Selorax returns.
 */

import { NextResponse } from "next/server";

import { isSeloraxConfigured } from "@/lib/selorax/config";
import { toLineResponse } from "@/lib/selorax/line";
import { seloraxStore } from "@/server/config/selorax-store";
import {
  createCallingClient,
  SeloraxError,
  type SeloraxErrorCode,
} from "@/server/selorax/calling-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Exhaustive over SeloraxErrorCode by construction: adding a new code without
// a status here is a compile error, not a runtime 500.
const STATUS_BY_CODE: Record<SeloraxErrorCode, number> = {
  token_expired: 401,
  extension_not_active: 503,
  calling_disabled: 503,
  unreachable: 502,
  timeout: 504,
  request_failed: 502,
};

export async function GET(): Promise<NextResponse> {
  const config = await seloraxStore.read();
  if (!isSeloraxConfigured(config)) {
    return NextResponse.json(
      {
        errors: [
          { path: "", message: "Selorax is not configured. Set the connection details first." },
        ],
      },
      { status: 503 },
    );
  }

  try {
    const line = await createCallingClient(config).getLine();
    return NextResponse.json(toLineResponse(line));
  } catch (cause) {
    if (cause instanceof SeloraxError) {
      console.error(`[selorax] getLine failed: ${cause.code}`, cause.underlying ?? "");
      return NextResponse.json(
        { errors: [{ path: "", message: cause.message }] },
        { status: STATUS_BY_CODE[cause.code] },
      );
    }
    console.error("[selorax] getLine failed with an unexpected error:", cause);
    return NextResponse.json(
      { errors: [{ path: "", message: "Could not reach the Selorax calling API." }] },
      { status: 502 },
    );
  }
}
