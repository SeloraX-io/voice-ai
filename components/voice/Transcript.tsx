"use client";

import { useEffect, useRef } from "react";
import { Bot, Trash2, User } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { TranscriptEntry, VoiceStatus } from "@/lib/gemini/types";
import { cn } from "@/lib/utils";

interface TranscriptProps {
  entries: TranscriptEntry[];
  status: VoiceStatus;
  onClear: () => void;
}

export function Transcript({ entries, status, onClear }: TranscriptProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  // Follow the conversation, but stop hijacking scroll once the user reads back.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !pinnedRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [entries]);

  const handleScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    pinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
  };

  const speakerNow =
    status === "speaking" ? "assistant" : status === "listening" ? "user" : null;

  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] backdrop-blur-xl">
      <header className="flex items-center justify-between border-b border-[var(--border)] px-5 py-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold tracking-wide text-[var(--text)]">
            Conversation Transcript
          </h2>
          {speakerNow && (
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-muted)]">
              <span
                className={cn(
                  "size-1.5 rounded-full [animation:status-pulse_1.2s_ease-in-out_infinite]",
                  speakerNow === "user" ? "bg-[var(--accent)]" : "bg-[var(--accent-2)]",
                )}
              />
              {speakerNow === "user" ? "Customer speaking" : "AI speaking"}
            </span>
          )}
        </div>

        {entries.length > 0 && (
          <Button variant="ghost" size="sm" onClick={onClear}>
            <Trash2 />
            Clear
          </Button>
        )}
      </header>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="scroll-slim max-h-80 min-h-40 space-y-4 overflow-y-auto px-5 py-4"
      >
        {entries.length === 0 ? (
          <p className="py-8 text-center text-sm text-[var(--text-dim)]">
            The transcript appears here, live, as the call happens.
          </p>
        ) : (
          entries.map((entry) => <TranscriptRow key={entry.id} entry={entry} />)
        )}
      </div>
    </section>
  );
}

function TranscriptRow({ entry }: { entry: TranscriptEntry }) {
  const isUser = entry.speaker === "user";

  return (
    <article className="animate-fade-rise flex gap-3">
      <div
        className={cn(
          "mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border",
          isUser
            ? "border-[var(--accent)]/40 bg-[var(--accent)]/12 text-[var(--accent)]"
            : "border-[var(--accent-2)]/40 bg-[var(--accent-2)]/12 text-[var(--accent-2)]",
        )}
      >
        {isUser ? <User className="size-3.5" /> : <Bot className="size-3.5" />}
      </div>

      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "text-[11px] font-semibold uppercase tracking-[0.14em]",
            isUser ? "text-[var(--accent)]" : "text-[var(--accent-2)]",
          )}
        >
          {isUser ? "Customer" : "AI"}
        </p>
        <p className="mt-0.5 text-sm leading-relaxed text-[var(--text)]">
          {entry.text}
          {!entry.final && (
            <span className="ml-0.5 inline-block h-3.5 w-px translate-y-0.5 bg-[var(--text-muted)] [animation:status-pulse_1s_steps(2)_infinite]" />
          )}
        </p>
      </div>
    </article>
  );
}
