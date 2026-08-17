"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

interface DropdownProps {
  /** Receives the open state so the trigger can reflect it. */
  trigger: (props: { open: boolean; toggle: () => void }) => React.ReactNode;
  children: (props: { close: () => void }) => React.ReactNode;
  align?: "left" | "right";
  className?: string;
}

/**
 * A minimal popover: click outside or press Escape to dismiss. Small enough
 * not to be worth a dependency, and the only floating UI this feature needs.
 */
export function Dropdown({ trigger, children, align = "right", className }: DropdownProps) {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      {trigger({ open, toggle: () => setOpen((value) => !value) })}
      {open && (
        <div
          className={cn(
            "absolute z-20 mt-1 min-w-52 overflow-hidden rounded-xl border border-[var(--border)]",
            "bg-[var(--surface)] p-1 shadow-lg shadow-black/5",
            align === "right" ? "right-0" : "left-0",
            className,
          )}
        >
          {children({ close: () => setOpen(false) })}
        </div>
      )}
    </div>
  );
}
