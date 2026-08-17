/**
 * Read and write the bridge's SIP credentials.
 *
 * The password is returned to the browser, unlike the agent-config route which
 * withholds secret values. It has to be: SIP digest auth happens in the page,
 * so JsSIP needs the plaintext. This is the same thing the SeloraX dashboard
 * already does with the same credential.
 *
 * Runs on the Node runtime because the store touches the filesystem.
 */

import { NextResponse } from "next/server";

import { validateSipCredentials } from "@/lib/telephony/credentials";
import { telephonyStore } from "@/server/config/telephony-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(await telephonyStore.read());
}

export async function PUT(request: Request): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);

  const result = validateSipCredentials(body);
  if (!result.ok) {
    return NextResponse.json({ errors: result.errors }, { status: 400 });
  }

  try {
    return NextResponse.json(await telephonyStore.write(result.value));
  } catch (cause) {
    console.error("[telephony] write failed:", cause);
    return NextResponse.json(
      { errors: [{ path: "", message: "Could not save the credentials." }] },
      { status: 500 },
    );
  }
}
