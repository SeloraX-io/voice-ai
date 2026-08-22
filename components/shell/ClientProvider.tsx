"use client";

/**
 * Which client the console is working on, and how to change that.
 *
 * The roster and the active client are resolved on the server — the console
 * layout reads the cookie and passes both down — so this provider's job is
 * mutation: switch, create, rename, delete, each followed by a router.refresh()
 * that re-renders the layout under the new state. There is no client-side
 * roster cache to drift out of date.
 */

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, useTransition } from "react";

import { ACTIVE_CLIENT_COOKIE, type ClientSummary } from "@/lib/clients/types";

export interface ClientsContextValue {
  clients: ClientSummary[];
  activeClient: ClientSummary;
  /** True while a switch/create/delete is refreshing the console. */
  pending: boolean;
  switchTo: (id: string) => void;
  /** Resolve to null on success, or a message to show the user. */
  createClient: (name: string) => Promise<string | null>;
  renameClient: (id: string, name: string) => Promise<string | null>;
  deleteClient: (id: string) => Promise<string | null>;
}

const ClientsContext = createContext<ClientsContextValue | null>(null);

function rememberClient(id: string | null): void {
  // A year: the choice of client is workspace state, not a session.
  document.cookie =
    id === null
      ? `${ACTIVE_CLIENT_COOKIE}=; path=/; max-age=0; samesite=lax`
      : `${ACTIVE_CLIENT_COOKIE}=${encodeURIComponent(id)}; path=/; max-age=31536000; samesite=lax`;
}

async function errorFrom(response: Response, fallback: string): Promise<string> {
  const body: { errors?: { message: string }[] } = await response.json().catch(() => ({}));
  return body.errors?.[0]?.message ?? fallback;
}

export function ClientProvider({
  clients,
  activeClient,
  children,
}: {
  clients: ClientSummary[];
  activeClient: ClientSummary;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const refresh = useCallback(() => {
    startTransition(() => router.refresh());
  }, [router]);

  const switchTo = useCallback(
    (id: string) => {
      if (id === activeClient.id) return;
      rememberClient(id);
      refresh();
    },
    [activeClient.id, refresh],
  );

  const createClient = useCallback(
    async (name: string): Promise<string | null> => {
      let response: Response;
      try {
        response = await fetch("/api/clients", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        });
      } catch {
        return "Could not reach the server.";
      }
      if (!response.ok) return errorFrom(response, "Could not create the client.");

      const body: { client: ClientSummary } = await response.json();
      // Jump straight into the new client: creating one is always the first
      // step of setting it up.
      rememberClient(body.client.id);
      refresh();
      return null;
    },
    [refresh],
  );

  const renameClient = useCallback(
    async (id: string, name: string): Promise<string | null> => {
      let response: Response;
      try {
        response = await fetch(`/api/clients/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        });
      } catch {
        return "Could not reach the server.";
      }
      if (!response.ok) return errorFrom(response, "Could not rename the client.");
      refresh();
      return null;
    },
    [refresh],
  );

  const deleteClient = useCallback(
    async (id: string): Promise<string | null> => {
      let response: Response;
      try {
        response = await fetch(`/api/clients/${encodeURIComponent(id)}`, { method: "DELETE" });
      } catch {
        return "Could not reach the server.";
      }
      if (!response.ok) return errorFrom(response, "Could not delete the client.");

      // The cookie may now point at nothing; clearing it lets the layout fall
      // back to the first remaining client.
      if (id === activeClient.id) rememberClient(null);
      refresh();
      return null;
    },
    [activeClient.id, refresh],
  );

  const value = useMemo<ClientsContextValue>(
    () => ({ clients, activeClient, pending, switchTo, createClient, renameClient, deleteClient }),
    [clients, activeClient, pending, switchTo, createClient, renameClient, deleteClient],
  );

  return <ClientsContext.Provider value={value}>{children}</ClientsContext.Provider>;
}

export function useClients(): ClientsContextValue {
  const value = useContext(ClientsContext);
  if (!value) throw new Error("useClients must be used inside ClientProvider");
  return value;
}
