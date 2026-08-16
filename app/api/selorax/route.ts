/**
 * Read and write the bridge's Selorax connection configuration.
 *
 * Unlike `app/api/telephony/route.ts`, the auth token here is a Selorax admin
 * JWT, not a per-line SIP password — see `lib/selorax/config.ts` for why it
 * must never reach the browser. GET (and PUT's response) report only whether
 * a token is set and when it expires, built field by field so a future field
 * on `SeloraxConfig` cannot silently reach the response by being spread in.
 */

import { NextResponse } from "next/server";

import { tokenExpiryMs, validateSeloraxConfig, type SeloraxConfig } from "@/lib/selorax/config";
import { seloraxStore } from "@/server/config/selorax-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SeloraxSummary {
  baseUrl: string;
  storeId: string;
  hasToken: boolean;
  tokenExpiresAt: number | null;
}

function toSeloraxSummary(config: SeloraxConfig): SeloraxSummary {
  const hasToken = config.authToken.length > 0;
  return {
    baseUrl: config.baseUrl,
    storeId: config.storeId,
    hasToken,
    tokenExpiresAt: hasToken ? tokenExpiryMs(config.authToken) : null,
  };
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(toSeloraxSummary(await seloraxStore.read()));
}

export async function PUT(request: Request): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);

  const record =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};

  const rawBaseUrl = typeof record.baseUrl === "string" ? record.baseUrl : "";
  const rawStoreId = typeof record.storeId === "string" ? record.storeId : "";
  const rawToken = typeof record.authToken === "string" ? record.authToken : "";
  const allBlank =
    rawBaseUrl.trim().length === 0 &&
    rawStoreId.trim().length === 0 &&
    rawToken.trim().length === 0;

  // An empty authToken means "keep the existing one" — an operator editing
  // just the URL or store id must not silently wipe a saved token. A request
  // with every field blank is a deliberate clear and keeps that behaviour.
  const merged: Record<string, unknown> = { ...record };
  if (!allBlank && rawToken.trim().length === 0) {
    merged.authToken = (await seloraxStore.read()).authToken;
  }

  const result = validateSeloraxConfig(merged);
  if (!result.ok) {
    return NextResponse.json({ errors: result.errors }, { status: 400 });
  }

  try {
    return NextResponse.json(toSeloraxSummary(await seloraxStore.write(result.value)));
  } catch (cause) {
    console.error("[selorax] write failed:", cause);
    return NextResponse.json(
      { errors: [{ path: "", message: "Could not save the configuration." }] },
      { status: 500 },
    );
  }
}
