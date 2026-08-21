"use client";

/**
 * The copyable snippet blocks, and a live preview of the widget.
 *
 * A client component only because copying needs the clipboard and the preview
 * needs an iframe the user can actually click. The snippet strings themselves
 * are built on the server, so this never has to know the origin rules.
 */

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

export function EmbedSnippet({
  consoleSnippet,
  scriptTag,
  origin,
}: {
  consoleSnippet: string;
  scriptTag: string;
  origin: string;
}) {
  return (
    <div className="space-y-6">
      <Block
        title="Paste into a browser console"
        hint="Open devtools on any site, paste this into the Console tab, and press Enter. The widget appears bottom-right until you reload."
        code={consoleSnippet}
      />
      <Block
        title="Or add it to the page properly"
        hint="Put this before the closing </body> tag to make it permanent."
        code={scriptTag}
      />
      <Preview origin={origin} />
    </div>
  );
}

function Block({ title, hint, code }: { title: string; hint: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access is denied in some contexts; the code is selectable
      // on screen either way, so there is nothing useful to say here.
    }
  };

  return (
    <section>
      <div className="mb-2 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text)]">{title}</h2>
          <p className="mt-1 text-sm text-[var(--text-muted)]">{hint}</p>
        </div>
        <button
          type="button"
          onClick={copy}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-medium text-[var(--text)] transition-colors hover:bg-[var(--surface-2)]"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--surface-3)] p-3.5 text-[13px] leading-relaxed text-[var(--text)]">
        <code>{code}</code>
      </pre>
    </section>
  );
}

/**
 * The real widget, in a real iframe.
 *
 * Loaded the same way the injected script loads it, so what is shown here is
 * what a visitor gets — including the microphone permission prompt. It is a
 * genuine call, billed like any other.
 */
function Preview({ origin }: { origin: string }) {
  const [live, setLive] = useState(false);
  const [view, setView] = useState<"compact" | "panel" | "full">("compact");
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const receiveResize = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== frameRef.current?.contentWindow) return;
      const message = event.data as { source?: unknown; type?: unknown; view?: unknown } | null;
      if (message?.source !== "voice-ai-widget" || message.type !== "resize") return;
      if (message.view === "compact" || message.view === "panel" || message.view === "full") {
        setView(message.view);
      }
    };
    window.addEventListener("message", receiveResize);
    return () => window.removeEventListener("message", receiveResize);
  }, [origin]);

  const frameClass =
    view === "full"
      ? "absolute inset-0 h-full w-full"
      : view === "panel"
        ? "absolute bottom-2 right-2 h-[340px] w-[292px]"
        : "absolute bottom-2 right-2 h-[124px] w-[262px]";

  return (
    <section>
      <div className="mb-2 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text)]">Preview</h2>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            The real widget, loaded exactly as a visitor would get it. Starting a call here is a
            real, billed call.
          </p>
        </div>
        {!live && (
          <button
            type="button"
            onClick={() => setLive(true)}
            className="shrink-0 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-medium text-[var(--text)] transition-colors hover:bg-[var(--surface-2)]"
          >
            Load
          </button>
        )}
      </div>
      <div className="relative h-[400px] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-2)]">
        {live ? (
          <iframe
            ref={frameRef}
            src={`${origin}/embed/widget`}
            title="Widget preview"
            allow={`microphone ${origin}`}
            className={`${frameClass} border-0 bg-transparent transition-[width,height] duration-200`}
          />
        ) : (
          <p className="grid h-full place-items-center px-6 text-center text-sm text-[var(--text-dim)]">
            Not loaded. The preview opens a live connection to the gateway, so it stays off until
            you ask for it.
          </p>
        )}
      </div>
    </section>
  );
}
