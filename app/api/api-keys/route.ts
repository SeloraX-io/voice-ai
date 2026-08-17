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

import { MongoError } from "mongodb";
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
    // `mint()` now calls `countDocuments()` and `insertOne()`, either of which
    // can reject with a driver error instead of the store's own validation
    // error — and a driver error can quote the failing query, which here can
    // carry a full key hash or the cluster hostname. Never interpolate it into
    // the response; only the store's own message (never a `MongoError`) is
    // safe to echo back.
    console.error("[api-keys] mint failed:", (cause as Error).name);
    if (cause instanceof MongoError) {
      return NextResponse.json(
        { errors: [{ path: "", message: "Could not mint the key. Try again shortly." }] },
        { status: 503 },
      );
    }
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
    // A revoke that matched nothing is not a revoke: saying 200 would tell a
    // stale console its key is gone when it is still opening calls.
    if (!(await apiKeyStore.revoke(id))) {
      return NextResponse.json(
        { errors: [{ path: "id", message: "That key is already gone — nothing was revoked." }] },
        { status: 404 },
      );
    }
  } catch (cause) {
    console.error("[api-keys] revoke failed:", (cause as Error).name);
    return NextResponse.json(
      { errors: [{ path: "", message: "Could not revoke the key." }] },
      { status: 500 },
    );
  }

  return NextResponse.json({ keys: await apiKeyStore.list() });
}
