/**
 * The client roster: list and create.
 *
 * Listing seeds the default client on an empty deployment, so the console
 * always has at least one client to select.
 *
 * Runs on the Node runtime because the store touches the database.
 */

import { NextResponse } from "next/server";

import { CLIENT_NAME_MAX } from "@/lib/clients/types";
import { clientStore } from "@/server/config/client-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ clients: await clientStore.list() });
}

export async function POST(request: Request): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  const name = (body as { name?: unknown } | null)?.name;

  if (typeof name !== "string" || name.trim() === "" || name.trim().length > CLIENT_NAME_MAX) {
    return NextResponse.json(
      { errors: [{ path: "name", message: `A name of 1–${CLIENT_NAME_MAX} characters is required.` }] },
      { status: 400 },
    );
  }

  try {
    const client = await clientStore.create(name);
    return NextResponse.json({ client }, { status: 201 });
  } catch (cause) {
    console.error("[clients] create failed:", (cause as Error).name);
    return NextResponse.json(
      { errors: [{ path: "", message: (cause as Error).message || "Could not create the client." }] },
      { status: 500 },
    );
  }
}
