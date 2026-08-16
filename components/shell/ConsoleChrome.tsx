"use client";

import { usePathname } from "next/navigation";
import { useCallback, useState } from "react";

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

  const { config, dirty, save } = useAgentConfig();
  // Held here, above the router, so navigating between screens cannot tear down
  // an in-flight call.
  const voice = useVoiceSession();

  // The saved-config stamp a live call started with, so the panel can tell the
  // tester when a later save has left the running call on stale settings.
  const [callStartedWith, setCallStartedWith] = useState<string | null>(null);

  const startCall = useCallback(async () => {
    setCallStartedWith(config.updatedAt);
    await voice.start();
  }, [config.updatedAt, voice]);

  const saveAndStartCall = useCallback(async () => {
    const ok = await save();
    if (!ok) return; // The provider has already routed to the failing field.
    setCallStartedWith(config.updatedAt);
    await voice.start();
  }, [save, config.updatedAt, voice]);

  const callActive = voice.status !== "idle" && voice.status !== "error";
  // `callStartedWith` only matters while a call is active; once the call ends
  // this reads as "no call running" without a dedicated effect to reset it —
  // avoids setState-in-effect, which this codebase's lint config forbids.
  const activeCallStartedWith = callActive ? callStartedWith : null;

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
        onStart={startCall}
        agentName={config.agentName}
        dirty={dirty}
        callStartedWith={activeCallStartedWith}
        currentUpdatedAt={config.updatedAt}
        onSaveAndStart={saveAndStartCall}
      />
    </div>
  );
}
