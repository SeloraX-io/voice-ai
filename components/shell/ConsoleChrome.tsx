"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";

import { useAgentConfig } from "@/components/agent-config/AgentConfigProvider";
import { SaveBar } from "@/components/agent-config/SaveBar";
import { PreviewPanel } from "@/components/preview/PreviewPanel";
import { Sidebar } from "@/components/shell/Sidebar";
import { useVoiceSession } from "@/hooks/useVoiceSession";
import { CONFIG_ROUTES } from "@/lib/agent-config/routes";

/**
 * Holds everything that must outlive a route change: the sidebar, the save bar,
 * and the preview panel with its live call.
 */
export function ConsoleChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [previewOpen, setPreviewOpen] = useState(false);
  const showSaveBar = CONFIG_ROUTES.includes(pathname);

  const { config } = useAgentConfig();
  // Held here, above the router, so navigating between screens cannot tear down
  // an in-flight call.
  const voice = useVoiceSession();

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <Sidebar onTestAgent={() => setPreviewOpen(true)} callActive={false} callSeconds={0} />

      <div className="flex min-w-0 flex-1 flex-col">
        <main className="flex-1 px-6 py-8">
          <div className="mx-auto w-full max-w-3xl">{children}</div>
        </main>
        {showSaveBar && <SaveBar />}
      </div>

      <PreviewPanel
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        voice={voice}
        onStart={() => void voice.start()}
        agentName={config.agentName}
      />
    </div>
  );
}
