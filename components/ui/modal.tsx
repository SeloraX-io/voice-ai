"use client";

import * as React from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * A dialog built on the native `<dialog>` element, which gives us the top layer,
 * a real backdrop and Escape-to-close without reimplementing any of it.
 *
 * `showModal()` also traps focus for free — the reason this wraps the element
 * rather than a positioned div.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);

  React.useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      // Fires for Escape as well as close(), so both routes tell the parent.
      onClose={onClose}
      onClick={(event) => {
        // The backdrop is the dialog element itself; a click that lands on the
        // panel has a different target.
        if (event.target === ref.current) onClose();
      }}
      className="m-0 max-h-none max-w-none bg-transparent p-0 backdrop:bg-black/20"
      style={{ width: "100%", height: "100%" }}
      aria-label={title}
    >
      <div className="mx-auto my-6 flex max-h-[calc(100vh-3rem)] w-[min(640px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-xl">
        <header className="flex items-center gap-3 border-b border-[var(--border)] px-5 py-4">
          <h2 className="flex-1 text-base font-semibold text-[var(--text)]">{title}</h2>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
            <X />
          </Button>
        </header>

        <div className="scroll-slim flex flex-col gap-5 overflow-y-auto p-5">{children}</div>

        <footer className="flex justify-end gap-2 border-t border-[var(--border)] bg-[var(--surface-2)] px-5 py-4">
          {footer}
        </footer>
      </div>
    </dialog>
  );
}
