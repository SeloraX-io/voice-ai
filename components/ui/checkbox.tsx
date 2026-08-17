"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

export function Checkbox({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type="checkbox"
      className={cn(
        "size-4 cursor-pointer rounded border-[var(--border-strong)] accent-[var(--accent)]",
        "outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
        className,
      )}
      {...props}
    />
  );
}
