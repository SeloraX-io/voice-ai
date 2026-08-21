/**
 * Secrets are write-only over HTTP, and scoped to one client via `?client=`.
 *
 * There is no GET here and there never should be: the only responses are the
 * list of key NAMES. Values leave the server exclusively as environment
 * variables for the agent's own tool calls.
 */

import { NextResponse } from "next/server";

import { LIMITS, SECRET_KEY_RE } from "@/lib/agent-config/schema";
import { configStore } from "@/server/config/store";
import { resolveClientScope } from "../../client-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function badRequest(path: string, message: string): NextResponse {
  return NextResponse.json({ errors: [{ path, message }] }, { status: 400 });
}

export async function POST(request: Request): Promise<NextResponse> {
  const scope = await resolveClientScope(request);
  if (!scope.ok) return scope.response;

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
    await configStore.setSecret(key, value, scope.clientId);
  } catch (cause) {
    console.error("[agent-config] secret write failed:", cause);
    return NextResponse.json(
      { errors: [{ path: "", message: "Could not save the secret." }] },
      { status: 500 },
    );
  }

  return NextResponse.json({ secretKeys: await configStore.listSecretKeys(scope.clientId) });
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const scope = await resolveClientScope(request);
  if (!scope.ok) return scope.response;

  const key = new URL(request.url).searchParams.get("key");
  if (key === null || !SECRET_KEY_RE.test(key)) {
    return badRequest("key", "Not a valid secret key.");
  }

  try {
    await configStore.deleteSecret(key, scope.clientId);
  } catch (cause) {
    console.error("[agent-config] secret delete failed:", cause);
    return NextResponse.json(
      { errors: [{ path: "", message: "Could not delete the secret." }] },
      { status: 500 },
    );
  }

  return NextResponse.json({ secretKeys: await configStore.listSecretKeys(scope.clientId) });
}
