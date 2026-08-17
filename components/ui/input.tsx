"use client";

import * as React from "react";

import { controlClass } from "@/components/ui/field";
import { cn } from "@/lib/utils";

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return <input className={cn(controlClass, "h-10", className)} {...props} />;
}
