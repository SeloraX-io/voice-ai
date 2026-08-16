/**
 * Secrets are write-only over HTTP.
 *
 * There is no GET here and there never should be: the only responses are the
 * list of key NAMES. Values leave the server exclusively as environment
 * variables for the agent's own tool calls.
 */

import { NextResponse } from "next/server";

import { LIMITS, SECRET_KEY_RE } from "@/lib/agent-config/schema";
import { configStore } from "@/server/config/store";

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

  const { key, value } = body as { key?: unknown; value?: unknown };
  if (typeof key !== "string" || !SECRET_KEY_RE.test(key) || key.length > LIMITS.secretKeyMax) {
    return badRequest("key", "Use UPPER_SNAKE_CASE letters, digits and underscores.");
  }
  if (typeof value !== "string" || value === "") {
    return badRequest("value", "Required.");
  }
  if (value.length > LIMITS.secretValueMax) {
    return badRequest("value", `At most ${LIMITS.secretValueMax} characters.`);
  }

  try {
    await configStore.setSecret(key, value);
  } catch (cause) {
    console.error("[agent-config] secret write failed:", cause);
    return NextResponse.json(
      { errors: [{ path: "", message: "Could not save the secret." }] },
      { status: 500 },
    );
  }

  return NextResponse.json({ secretKeys: await configStore.listSecretKeys() });
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const key = new URL(request.url).searchParams.get("key");
  if (key === null || !SECRET_KEY_RE.test(key)) {
    return badRequest("key", "Unknown secret.");
  }

  await configStore.deleteSecret(key);
  return NextResponse.json({ secretKeys: await configStore.listSecretKeys() });
}
