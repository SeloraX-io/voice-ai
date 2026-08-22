/**
 * One client: rename and delete.
 *
 * Deleting removes the client's config and secrets but keeps its call
 * records — they are billing history, and history does not get rewritten.
 */

import { NextResponse } from "next/server";

import { CLIENT_NAME_MAX, normaliseClientId } from "@/lib/clients/types";
import { clientStore } from "@/server/config/client-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

async function clientIdFrom(context: Context): Promise<string | null> {
  return normaliseClientId((await context.params).id);
}

export async function PATCH(request: Request, context: Context): Promise<NextResponse> {
  const id = await clientIdFrom(context);
  if (!id) {
    return NextResponse.json(
      { errors: [{ path: "client", message: "Not a valid client id." }] },
      { status: 400 },
    );
  }

  const body: unknown = await request.json().catch(() => null);
  const name = (body as { name?: unknown } | null)?.name;
  if (typeof name !== "string" || name.trim() === "" || name.trim().length > CLIENT_NAME_MAX) {
    return NextResponse.json(
      { errors: [{ path: "name", message: `A name of 1–${CLIENT_NAME_MAX} characters is required.` }] },
      { status: 400 },
    );
  }

  const client = await clientStore.rename(id, name);
  if (!client) {
    return NextResponse.json(
      { errors: [{ path: "client", message: "No such client." }] },
      { status: 404 },
    );
  }
  return NextResponse.json({ client });
}

export async function DELETE(_request: Request, context: Context): Promise<NextResponse> {
  const id = await clientIdFrom(context);
  if (!id) {
    return NextResponse.json(
      { errors: [{ path: "client", message: "Not a valid client id." }] },
      { status: 400 },
    );
  }

  const result = await clientStore.remove(id);
  if (!result.ok) {
    return NextResponse.json(
      { errors: [{ path: "", message: result.reason }] },
      { status: 400 },
    );
  }
  return NextResponse.json({ ok: true });
}
