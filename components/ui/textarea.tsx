"use client";

import * as React from "react";

import { controlClass } from "@/components/ui/field";
import { cn } from "@/lib/utils";

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(controlClass, "scroll-slim resize-y leading-relaxed", className)}
      {...props}
    />
  );
}
