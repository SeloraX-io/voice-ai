/**
 * Which client a request is operating on.
 *
 * Client-scoped routes take `?client=<id>`. A missing parameter means the
 * default client, so pre-client callers — and anything scripted against the
 * old single-tenant API — keep working unchanged. A malformed or unknown id is
 * an error, not a fallback: silently writing another client's config is the
 * one outcome this must make impossible.
 *
 * Not a route itself — routes import it — which is why it lives beside them
 * rather than under a path Next would try to serve.
 */

import { NextResponse } from "next/server";

import { DEFAULT_CLIENT_ID, normaliseClientId } from "@/lib/clients/types";
import { clientStore } from "@/server/config/client-store";

export type ClientScope =
  | { ok: true; clientId: string }
  | { ok: false; response: NextResponse };

export async function resolveClientScope(request: Request): Promise<ClientScope> {
  const raw = new URL(request.url).searchParams.get("client");
  if (raw === null) return { ok: true, clientId: DEFAULT_CLIENT_ID };

  const clientId = normaliseClientId(raw);
  if (!clientId) {
    return {
      ok: false,
      response: NextResponse.json(
        { errors: [{ path: "client", message: "Not a valid client id." }] },
        { status: 400 },
      ),
    };
  }

  const client = await clientStore.get(clientId);
  if (!client) {
    return {
      ok: false,
      response: NextResponse.json(
        { errors: [{ path: "client", message: "No such client." }] },
        { status: 404 },
      ),
    };
  }

  return { ok: true, clientId };
}
