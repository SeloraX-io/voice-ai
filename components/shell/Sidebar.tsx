"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { AudioLines, Menu, Play, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { AGENT_ROUTES } from "@/lib/agent-config/routes";
import { cn } from "@/lib/utils";
import { useNavGuard } from "@/components/shell/DirtyNavGuard";

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

interface SidebarProps {
  onTestAgent: () => void;
  callActive: boolean;
  callSeconds: number;
}

export function Sidebar({ onTestAgent, callActive, callSeconds }: SidebarProps) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const mayNavigate = useNavGuard();

  const agentItems = AGENT_ROUTES.filter((route) => route.group === "agent");
  const topLevelItems = AGENT_ROUTES.filter((route) => route.group === null);

  const item = (href: string, label: string) => (
    <Link
      key={href}
      href={href}
      onClick={(event) => {
        if (!mayNavigate(href)) {
          event.preventDefault();
          return;
        }
        setOpen(false);
      }}
      aria-current={pathname === href ? "page" : undefined}
      className={cn(
        "block rounded-lg px-3 py-2 text-sm transition-colors",
        pathname === href
          ? "bg-[var(--surface-3)] font-medium text-[var(--text)]"
          : "text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]",
      )}
    >
      {label}
    </Link>
  );

  return (
    <>
      {/* Mobile bar: the sidebar overlays content below md rather than squeezing it. */}
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3 md:hidden">
        <Button variant="ghost" size="icon" aria-label="Open navigation" onClick={() => setOpen(true)}>
          <Menu />
        </Button>
        <span className="text-sm font-semibold text-[var(--text)]">Voice AI</span>
      </div>

      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/20 md:hidden"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}

      <nav
        aria-label="Console"
        className={cn(
          "z-40 flex w-60 shrink-0 flex-col gap-1 border-r border-[var(--border)] bg-[var(--surface)] p-4",
          "fixed inset-y-0 left-0 transition-transform md:static md:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="mb-4 flex items-center gap-2.5 px-1">
          <span className="grid size-8 place-items-center rounded-lg bg-[var(--accent)] text-[var(--accent-contrast)]">
            <AudioLines className="size-4" />
          </span>
          <span className="text-sm font-semibold tracking-tight text-[var(--text)]">Voice AI</span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close navigation"
            className="ml-auto md:hidden"
            onClick={() => setOpen(false)}
          >
            <X />
          </Button>
        </div>

        <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--text-dim)]">
          Agent
        </p>
        {agentItems.map((route) => item(route.href, route.label))}

        <div className="pt-2">{topLevelItems.map((route) => item(route.href, route.label))}</div>

        <div className="mt-auto pt-4">
          <Button
            variant="outline"
            className="w-full"
            onClick={onTestAgent}
            aria-label={callActive ? "Show the call in progress" : "Test agent"}
          >
            {callActive ? (
              <>
                <span className="size-2 rounded-full bg-[var(--success)] [animation:status-pulse_1.6s_ease-in-out_infinite]" />
                Live · {formatElapsed(callSeconds)}
              </>
            ) : (
              <>
                <Play />
                Test agent
              </>
            )}
          </Button>
        </div>
      </nav>
    </>
  );
}
