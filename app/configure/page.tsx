/**
 * Agent configuration editor.
 *
 * The config is read on the server so the form is populated on first paint —
 * no loading spinner, no flash of defaults over a saved config.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { AgentConfigForm } from "@/components/agent-config/AgentConfigForm";
import { configStore } from "@/server/config/store";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Agent configuration — AI Voice Agent",
};

export default async function ConfigurePage() {
  const [config, secretKeys] = await Promise.all([
    configStore.read(),
    configStore.listSecretKeys(),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-5 pb-16">
      <header className="flex items-center justify-between py-6">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
        >
          <ArrowLeft className="size-4" />
          Back to console
        </Link>
      </header>

      <h1 className="text-2xl font-semibold tracking-tight text-[var(--text)]">
        Agent configuration
      </h1>
      <p className="mt-1 text-sm text-[var(--text-muted)]">
        Changes take effect on the next call. A call already in progress keeps the settings it
        started with.
      </p>

      <AgentConfigForm initialConfig={{ ...config, secretKeys }} />
    </div>
  );
}
