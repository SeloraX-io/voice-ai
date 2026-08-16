/**
 * Mint, list and revoke the gateway's API keys.
 *
 * Like the secrets route, this is deliberately one-way: `GET` returns names,
 * dates and a short fingerprint, never a key. A minted key's plaintext is in
 * the `POST` response and nowhere else — the store keeps only a hash, so a
 * second request for it could not be answered even if one existed.
 *
 * Runs on the Node runtime because the store touches the filesystem.
 */

import { NextResponse } from "next/server";

import { MAX_NAME_CHARS } from "@/lib/api-keys/types";
import { apiKeyStore } from "@/server/config/api-key-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function badRequest(path: string, message: string): NextResponse {
  return NextResponse.json({ errors: [{ path, message }] }, { status: 400 });
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ keys: await apiKeyStore.list() });
}

export async function POST(request: Request): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null) {
    return badRequest("", "Expected a JSON object.");
  }

  const { name } = body as { name?: unknown };
  if (typeof name !== "string" || name.trim() === "") {
    return badRequest("name", "Give the key a name so you can tell it apart later.");
  }
  if (name.trim().length > MAX_NAME_CHARS) {
    return badRequest("name", `At most ${MAX_NAME_CHARS} characters.`);
  }

  try {
    const minted = await apiKeyStore.mint(name);
    // The only time this plaintext exists outside the client that asked for it.
    return NextResponse.json({ key: minted.key, keys: await apiKeyStore.list() });
  } catch (cause) {
    // The message is the store's own ("Revoke one first"), never key material.
    console.error("[api-keys] mint failed:", (cause as Error).name);
    return NextResponse.json(
      { errors: [{ path: "", message: (cause as Error).message || "Could not mint the key." }] },
      { status: 400 },
    );
  }
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const id = new URL(request.url).searchParams.get("id");
  if (id === null || id === "") return badRequest("id", "Which key?");

  try {
    await apiKeyStore.revoke(id);
  } catch (cause) {
    console.error("[api-keys] revoke failed:", cause);
    return NextResponse.json(
      { errors: [{ path: "", message: "Could not revoke the key." }] },
      { status: 500 },
    );
  }

  return NextResponse.json({ keys: await apiKeyStore.list() });
}
