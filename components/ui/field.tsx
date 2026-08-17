"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/** Shared shell for every text-like control, so they stay visually identical. */
export const controlClass =
  "w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] " +
  "placeholder:text-[var(--text-dim)] outline-none transition-colors " +
  "hover:border-[var(--border-strong)] focus-visible:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--ring)] " +
  "disabled:cursor-not-allowed disabled:opacity-50";

interface FieldProps {
  label: string;
  description?: React.ReactNode;
  error?: string;
  htmlFor?: string;
  /** Rendered on the label row, flush right — a toggle or an action. */
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function Field({
  label,
  description,
  error,
  htmlFor,
  action,
  children,
  className,
}: FieldProps) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={htmlFor} className="text-sm font-medium text-[var(--text)]">
          {label}
        </label>
        {action}
      </div>
      {description && (
        <p className="text-xs leading-relaxed text-[var(--text-muted)]">{description}</p>
      )}
      {children}
      {error && (
        <p role="alert" className="text-xs font-medium text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
}
