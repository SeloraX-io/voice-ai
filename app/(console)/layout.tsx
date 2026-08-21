/**
 * The console shell.
 *
 * The active client is resolved here, from the cookie the switcher writes,
 * and everything below renders in that client's world: its configuration, its
 * calls, its embed snippet. A stale or missing cookie falls back to the first
 * client, and `list()` seeds the default client on an empty deployment, so
 * there is always something to show.
 *
 * Configuration state lives here rather than in a page because the four
 * editors are routes: state held inside one would be unmounted, and unsaved
 * edits lost, on every navigation. The provider is KEYED by client id so a
 * switch remounts it on the new client's saved state instead of carrying one
 * client's edits over another's baseline.
 */

import { AgentConfigProvider } from "@/components/agent-config/AgentConfigProvider";
import { ClientProvider } from "@/components/shell/ClientProvider";
import { ConsoleChrome } from "@/components/shell/ConsoleChrome";
import { configStore } from "@/server/config/store";
import { resolveActiveClient } from "./active-client";

export const dynamic = "force-dynamic";

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const { clients, activeClient } = await resolveActiveClient();

  const [config, secretKeys] = await Promise.all([
    configStore.read(activeClient.id),
    configStore.listSecretKeys(activeClient.id),
  ]);

  return (
    <ClientProvider clients={clients} activeClient={activeClient}>
      <AgentConfigProvider
        key={activeClient.id}
        clientId={activeClient.id}
        initialConfig={{ ...config, secretKeys }}
      >
        <ConsoleChrome>{children}</ConsoleChrome>
      </AgentConfigProvider>
    </ClientProvider>
  );
}
