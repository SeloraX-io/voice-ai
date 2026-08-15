"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, FileAudio, Loader2, Upload, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { UploadAnalysis } from "@/lib/gemini/types";
import { cn, formatMs } from "@/lib/utils";

const ACCEPT = ".mp3,.wav,.m4a,.webm,.ogg,audio/*";

interface Selection {
  file: File;
  /** Object URL for the local preview player. */
  url: string;
}

export function AudioUploader() {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [result, setResult] = useState<UploadAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const objectUrlRef = useRef<string | null>(null);

  const select = useCallback((next: File | null) => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = next ? URL.createObjectURL(next) : null;

    setSelection(next && objectUrlRef.current ? { file: next, url: objectUrlRef.current } : null);
    setResult(null);
    setError(null);
  }, []);

  // Release the last preview URL when the tab unmounts.
  useEffect(
    () => () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    },
    [],
  );

  const analyse = useCallback(async () => {
    const file = selection?.file;
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);

    try {
      const body = new FormData();
      body.append("file", file);
      const response = await fetch("/api/upload", { method: "POST", body });
      const payload: unknown = await response.json();

      if (!response.ok) {
        const message =
          typeof payload === "object" && payload !== null && "error" in payload
            ? String((payload as { error: unknown }).error)
            : "Audio processing failed.";
        throw new Error(message);
      }
      setResult(payload as UploadAnalysis);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Audio processing failed.");
    } finally {
      setBusy(false);
    }
  }, [selection]);

  return (
    <div className="space-y-5">
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const dropped = event.dataTransfer.files?.[0];
          if (dropped) select(dropped);
        }}
        className={cn(
          "rounded-2xl border border-dashed p-8 text-center transition-colors",
          dragging
            ? "border-[var(--accent)] bg-[var(--accent-soft)]"
            : "border-[var(--border-strong)] bg-[var(--surface-2)]",
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="sr-only"
          onChange={(event) => select(event.target.files?.[0] ?? null)}
        />

        {selection ? (
          <div className="space-y-4">
            <div className="flex items-center justify-center gap-3 text-sm">
              <FileAudio className="size-4 text-[var(--accent)]" />
              <span className="max-w-xs truncate font-medium text-[var(--text)]">
                {selection.file.name}
              </span>
              <span className="text-[var(--text-dim)]">
                {(selection.file.size / 1024 / 1024).toFixed(1)} MB
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Remove file"
                onClick={() => select(null)}
              >
                <X />
              </Button>
            </div>

            <audio src={selection.url} controls className="mx-auto w-full max-w-md" />

            <Button variant="primary" onClick={analyse} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Upload />}
              {busy ? "Processing…" : "Transcribe & respond"}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <Upload className="mx-auto size-6 text-[var(--text-muted)]" />
            <p className="text-sm text-[var(--text)]">Drop a recording here</p>
            <p className="text-xs text-[var(--text-dim)]">MP3, WAV, M4A, WebM or OGG · up to 15 MB</p>
            <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
              Choose file
            </Button>
          </div>
        )}
      </div>

      {error && (
        <p className="flex items-start gap-2 rounded-xl border border-[var(--danger)]/35 bg-[var(--danger)]/10 px-4 py-3 text-sm text-[var(--danger)]">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      )}

      {result && (
        <div className="animate-fade-rise space-y-4">
          <Panel title="Transcript" accent="var(--accent)">
            {result.transcript}
          </Panel>

          <Panel title="AI Response" accent="var(--accent-2)">
            {result.reply}
          </Panel>

          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
            <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--text-dim)]">
              Generated audio
            </h3>
            <audio src={result.replyAudioUrl} controls className="w-full" />
            <p className="mt-3 font-mono text-[11px] text-[var(--text-dim)]">
              understanding {formatMs(result.timings.understandingMs)} · synthesis{" "}
              {formatMs(result.timings.synthesisMs)} · total {formatMs(result.timings.totalMs)}
            </p>
          </div>
        </div>
      )}

      <p className="text-center text-xs text-[var(--text-dim)]">
        Upload mode is a batch pipeline for testing prompts and voices. It is deliberately not
        streaming — use the Live Voice tab for the real-time experience.
      </p>
    </div>
  );
}

function Panel({
  title,
  accent,
  children,
}: {
  title: string;
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
      <h3
        className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em]"
        style={{ color: accent }}
      >
        {title}
      </h3>
      <p className="text-sm leading-relaxed text-[var(--text)]">{children}</p>
    </div>
  );
}
