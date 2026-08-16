"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";

import { SaveBar } from "@/components/agent-config/SaveBar";
import { Sidebar } from "@/components/shell/Sidebar";
import { CONFIG_ROUTES } from "@/lib/agent-config/routes";

/**
 * Holds everything that must outlive a route change: the sidebar, the save bar,
 * and (from Task 7) the preview panel with its live call.
 */
export function ConsoleChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [previewOpen, setPreviewOpen] = useState(false);
  const showSaveBar = CONFIG_ROUTES.includes(pathname);

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <Sidebar onTestAgent={() => setPreviewOpen(true)} callActive={false} callSeconds={0} />

      <div className="flex min-w-0 flex-1 flex-col">
        <main className="flex-1 px-6 py-8">
          <div className="mx-auto w-full max-w-3xl">{children}</div>
        </main>
        {showSaveBar && <SaveBar />}
      </div>

      {previewOpen && null /* PreviewPanel arrives in Task 7 */}
    </div>
  );
}
