/**
 * Read and write the agent configuration for one client.
 *
 * The client comes from `?client=<id>` and defaults to the default client, so
 * pre-client callers keep working — see `app/api/client-scope.ts`.
 *
 * `secretKeys` is server-owned on both sides of the contract: it is filled in
 * on the way out and discarded on the way in, so a client can neither read a
 * secret value nor invent a key by saving the config.
 *
 * Runs on the Node runtime because the store touches the database.
 */

import { NextResponse } from "next/server";

import { validateAgentConfig } from "@/lib/agent-config/schema";
import { configStore } from "@/server/config/store";
import { resolveClientScope } from "../client-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const scope = await resolveClientScope(request);
  if (!scope.ok) return scope.response;

  const [config, secretKeys] = await Promise.all([
    configStore.read(scope.clientId),
    configStore.listSecretKeys(scope.clientId),
  ]);
  return NextResponse.json({ ...config, secretKeys });
}

export async function PUT(request: Request): Promise<NextResponse> {
  const scope = await resolveClientScope(request);
  if (!scope.ok) return scope.response;

  const body: unknown = await request.json().catch(() => null);

  const result = validateAgentConfig(body);
  if (!result.ok) {
    return NextResponse.json({ errors: result.errors }, { status: 400 });
  }

  try {
    const saved = await configStore.write(result.config, scope.clientId);
    const secretKeys = await configStore.listSecretKeys(scope.clientId);
    return NextResponse.json({ ...saved, secretKeys });
  } catch (cause) {
    console.error("[agent-config] write failed:", (cause as Error).name);
    return NextResponse.json(
      { errors: [{ path: "", message: "Could not save the configuration." }] },
      { status: 500 },
    );
  }
}
