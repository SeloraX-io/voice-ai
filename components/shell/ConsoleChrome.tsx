"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { useAgentConfig } from "@/components/agent-config/AgentConfigProvider";
import { SaveBar } from "@/components/agent-config/SaveBar";
import { PreviewPanel } from "@/components/preview/PreviewPanel";
import { useClients } from "@/components/shell/ClientProvider";
import { Sidebar } from "@/components/shell/Sidebar";
import { useVoiceSession } from "@/hooks/useVoiceSession";
import { CONFIG_ROUTES } from "@/lib/agent-config/routes";

/**
 * Holds everything that must outlive a route change: the sidebar, the save bar,
 * and the preview panel with its live call.
 */
export function ConsoleChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const showSaveBar = CONFIG_ROUTES.includes(pathname);

  const { config, dirty, save } = useAgentConfig();
  const { activeClient } = useClients();
  // Held here, above the router, so navigating between screens cannot tear down
  // an in-flight call. Scoped to the active client so the preview exercises the
  // same configuration the editors are showing. A client switch remounts this
  // component (the layout keys the provider), which is what ends a call rather
  // than leaving it running against the previous client.
  const voice = useVoiceSession({ clientId: activeClient.id });

  // The saved-config stamp a live call started with, so the panel can tell the
  // tester when a later save has left the running call on stale settings.
  const [callStartedWith, setCallStartedWith] = useState<string | null>(null);

  const [callSeconds, setCallSeconds] = useState(0);

  const startCall = useCallback(async () => {
    setCallStartedWith(config.updatedAt);
    setCallSeconds(0);
    await voice.start();
  }, [config.updatedAt, voice]);

  const saveAndStartCall = useCallback(async () => {
    const persisted = await save();
    if (!persisted) return; // The provider has already routed to the failing field.
    setCallStartedWith(persisted.updatedAt);
    setCallSeconds(0);
    await voice.start();
  }, [save, voice]);

  const callActive = voice.status !== "idle" && voice.status !== "error";
  // Both of these only matter while a call is active; once the call ends they
  // read as "no call running" / "0 seconds" purely by being gated here, rather
  // than through a dedicated effect that resets them — this codebase's lint
  // config forbids calling setState directly in an effect body.
  // The bridge page runs its own call over a real phone line. Offering the
  // preview there invites a second, separately billed Gemini session on top of
  // a live call. A preview call already in flight keeps its panel wherever the
  // operator navigates, so hiding it can never strand a running call with no
  // way to stop it.
  const showPreview = pathname !== "/telephony" || callActive;

  const activeCallStartedWith = callActive ? callStartedWith : null;
  const displayedCallSeconds = callActive ? callSeconds : 0;

  useEffect(() => {
    if (!callActive) return;
    // A plain interval is enough here: this drives a once-per-second label, not
    // anything the audio path depends on. The counter is reset to 0 by
    // startCall/saveAndStartCall so each call begins from zero.
    const timer = setInterval(() => setCallSeconds((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [callActive]);

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <Sidebar />

      {/* Below lg the preview stacks under the content rather than hiding: with
          no button to summon it, hiding would leave no way to test at all on a
          narrow window. */}
      <div className="flex min-w-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-w-0 flex-1 flex-col">
          <main className="flex-1 px-6 py-8">
            <div className="mx-auto w-full max-w-3xl">{children}</div>
          </main>
          {showSaveBar && <SaveBar />}
        </div>

        {showPreview && (
          <PreviewPanel
            voice={voice}
            onStart={startCall}
            agentName={config.agentName}
            dirty={dirty}
            callStartedWith={activeCallStartedWith}
            currentUpdatedAt={config.updatedAt}
            callActive={callActive}
            callSeconds={displayedCallSeconds}
            onSaveAndStart={saveAndStartCall}
          />
        )}
      </div>
    </div>
  );
}
