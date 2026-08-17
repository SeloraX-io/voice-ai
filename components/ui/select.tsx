"use client";

import * as React from "react";

import { controlClass } from "@/components/ui/field";
import { cn } from "@/lib/utils";

/**
 * A native select. It gets the platform's own keyboard handling, mobile picker
 * and accessibility for free, which is worth more here than a custom listbox.
 */
export function Select({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <select className={cn(controlClass, "h-10 cursor-pointer pr-8", className)} {...props}>
      {children}
    </select>
  );
}
