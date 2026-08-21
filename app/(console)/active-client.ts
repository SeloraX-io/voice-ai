/**
 * The one way console server components resolve "which client am I showing?".
 *
 * The switcher writes a cookie; a stale or missing one falls back to the first
 * client; `list()` seeds the default client on an empty deployment. Every
 * consumer — the layout, the calls page, the embed page — goes through here so
 * none of them can disagree about whose data is on screen.
 *
 * Lives in the route group rather than `server/` because it reads request
 * cookies, which only exists inside Next's request scope — the gateway process
 * must never import this.
 */

import { cookies } from "next/headers";

import { ACTIVE_CLIENT_COOKIE, type ClientSummary } from "@/lib/clients/types";
import { clientStore } from "@/server/config/client-store";

export async function resolveActiveClient(): Promise<{
  clients: ClientSummary[];
  activeClient: ClientSummary;
}> {
  const [clients, cookieStore] = await Promise.all([clientStore.list(), cookies()]);
  const requested = cookieStore.get(ACTIVE_CLIENT_COOKIE)?.value;
  const activeClient = clients.find((client) => client.id === requested) ?? clients[0];
  return { clients, activeClient };
}
