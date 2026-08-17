/**
 * The console shell.
 *
 * Configuration state lives here rather than in a page because the four editors
 * are routes: state held inside one would be unmounted, and unsaved edits lost,
 * on every navigation.
 */

import { AgentConfigProvider } from "@/components/agent-config/AgentConfigProvider";
import { ConsoleChrome } from "@/components/shell/ConsoleChrome";
import { configStore } from "@/server/config/store";

export const dynamic = "force-dynamic";

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const [config, secretKeys] = await Promise.all([
    configStore.read(),
    configStore.listSecretKeys(),
  ]);

  return (
    <AgentConfigProvider initialConfig={{ ...config, secretKeys }}>
      <ConsoleChrome>{children}</ConsoleChrome>
    </AgentConfigProvider>
  );
}
