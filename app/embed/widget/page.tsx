"use client";

/**
 * The widget, as it appears inside the injected iframe.
 *
 * Served from this deployment but rendered on somebody else's page, so it lives
 * outside the (console) route group: no sidebar, no console chrome, no
 * navigation. Everything it needs is on this one screen.
 *
 * It reuses `useVoiceSession` unchanged — the same hook behind the console's
 * preview player — so audio capture, playout, barge-in and the gateway protocol
 * are the ones already in service, not a second implementation that can drift.
 *
 * Two states: a closed pill and an open call panel. The parent frame is sized to
 * whichever is showing, via postMessage, because an iframe cannot resize itself.
 *
 * Styling is a <style> block rather than Tailwind classes: it keeps the whole
 * widget legible as one visual object, and it renders correctly even if the
 * host page's stylesheet somehow reaches in.
 */

import { useCallback, useEffect, useState } from "react";

import { VoiceAura } from "@/components/embed/VoiceAura";
import { useVoiceSession } from "@/hooks/useVoiceSession";

/** Matches the constants in public/embed.js. Both sides must agree. */
const MESSAGE_SOURCE = "voice-ai-widget";

/**
 * Tells the loader to grow or shrink.
 *
 * `"*"` as the target origin is correct here and is not a leak: the message
 * carries no data beyond "open" or "closed", and the widget cannot know which
 * site it was embedded on. The loader verifies OUR origin on receipt, which is
 * the direction that matters.
 */
function postToParent(message: Record<string, unknown>): void {
  if (typeof window === "undefined" || window.parent === window) return;
  window.parent.postMessage({ source: MESSAGE_SOURCE, ...message }, "*");
}

export default function EmbedWidgetPage() {
  const voice = useVoiceSession();
  const [open, setOpen] = useState(false);
  const { status, error, start, stop, muted, toggleMute, levels } = voice;

  useEffect(() => {
    postToParent({ type: "resize", open });
  }, [open]);

  const openAndStart = useCallback(async () => {
    setOpen(true);
    // Called straight from the click, so the browser still counts this as a
    // user gesture — getUserMedia and AudioContext both require one.
    await start();
  }, [start]);

  const endCall = useCallback(async () => {
    await stop();
    setOpen(false);
  }, [stop]);

  const live = status !== "idle" && status !== "error";

  return (
    <>
      <style>{STYLES}</style>
      <div className="vw-root">
        {open ? (
          <CallPanel
            status={status}
            error={error}
            muted={muted}
            onToggleMute={toggleMute}
            onEnd={endCall}
            levels={levels}
            live={live}
          />
        ) : (
          <Pill onStart={openAndStart} />
        )}
      </div>
    </>
  );
}

/** The closed state: the ring, a question, and the call button. */
function Pill({ onStart }: { onStart: () => void }) {
  return (
    <div className="vw-card vw-enter">
      <div className="vw-pill-head">
        <VoiceAura size={44} idle themeMode="light" />
        <p className="vw-pill-title">সাহায্য দরকার?</p>
      </div>
      <button type="button" onClick={onStart} className="vw-btn vw-btn-primary">
        <PhoneIcon />
        কল শুরু করুন
      </button>
    </div>
  );
}

function CallPanel({
  status,
  error,
  muted,
  onToggleMute,
  onEnd,
  levels,
  live,
}: {
  status: string;
  error: string | null;
  muted: boolean;
  onToggleMute: () => void;
  onEnd: () => void;
  levels: React.RefObject<{ user: number; agent: number }>;
  live: boolean;
}) {
  return (
    <div className="vw-card vw-card-open vw-enter">
      <header className="vw-head">
        <p className="vw-head-title">ভয়েস সহকারী</p>
        <p className="vw-head-status">
          <span className={`vw-dot${status === "connecting" ? " vw-dot-pulse" : ""}`} />
          {statusLabel(status)}
        </p>
      </header>

      <div className="vw-stage">
        <VoiceAura size={150} status={status} level={levels} idle={!live || muted} />
      </div>

      {error && <p className="vw-error">{error}</p>}

      <div className="vw-controls">
        <button
          type="button"
          onClick={onToggleMute}
          aria-pressed={muted}
          className={`vw-btn vw-btn-ghost${muted ? " vw-btn-active" : ""}`}
        >
          {muted ? <MicOffIcon /> : <MicIcon />}
          {muted ? "আনমিউট" : "মিউট"}
        </button>
        <button type="button" onClick={onEnd} className="vw-btn vw-btn-end" aria-label="কল শেষ করুন">
          <HangUpIcon />
        </button>
      </div>
    </div>
  );
}

/** Bengali status text. Deliberately vague — callers do not need our jargon. */
function statusLabel(status: string): string {
  switch (status) {
    case "connecting":
      return "সংযোগ হচ্ছে…";
    case "listening":
      return "শুনছি";
    case "thinking":
      return "ভাবছি…";
    case "speaking":
      return "বলছি";
    case "interrupted":
      return "শুনছি";
    case "error":
      return "সমস্যা হয়েছে";
    default:
      return "প্রস্তুত";
  }
}

function PhoneIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.4.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1-9.4 0-17-7.6-17-17 0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1l-2.3 2.2z" />
    </svg>
  );
}

function HangUpIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 9c-1.6 0-3.15.25-4.6.7v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.99.99 0 0 1-.29-.7c0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .27-.11.52-.29.7l-2.48 2.46c-.18.18-.43.29-.71.29-.27 0-.52-.1-.7-.28a11.27 11.27 0 0 0-2.66-1.85.996.996 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z" />
    </svg>
  );
}

function MicOffIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M15 11V5a3 3 0 0 0-5.9-.75L15 11.2V11zM4.4 3.6 3 5l6 6v.2a3 3 0 0 0 3.8 2.9l1.5 1.5A5 5 0 0 1 7 11H5a7 7 0 0 0 6 6.92V21h2v-3.08a7 7 0 0 0 3.2-1.3L19 19l1.4-1.4L4.4 3.6z" />
    </svg>
  );
}

/**
 * The widget's entire visual definition.
 *
 * Light and dark both keyed off the HOST page's preference — the widget floats
 * on their page, so matching the surrounding site is what looks deliberate
 * rather than pasted on.
 */
const STYLES = `
.vw-root {
  --vw-card: #ffffff;
  --vw-border: rgba(0, 0, 0, 0.07);
  --vw-text: #09090b;
  --vw-muted: #71717a;
  --vw-btn: #09090b;
  --vw-btn-text: #ffffff;
  --vw-ghost-border: rgba(0, 0, 0, 0.10);
  --vw-ghost-hover: rgba(0, 0, 0, 0.04);

  height: 100%;
  width: 100%;
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  padding: 5px;
  box-sizing: border-box;
  overflow: hidden;
  background: transparent;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
}

@media (prefers-color-scheme: dark) {
  .vw-root {
    --vw-card: #0e0e10;
    --vw-border: rgba(255, 255, 255, 0.10);
    --vw-text: #fafafa;
    --vw-muted: #a1a1aa;
    --vw-btn: #fafafa;
    --vw-btn-text: #09090b;
    --vw-ghost-border: rgba(255, 255, 255, 0.14);
    --vw-ghost-hover: rgba(255, 255, 255, 0.06)
  }
}

.vw-card {
  width: 100%;
  box-sizing: border-box;
  background: var(--vw-card);
  border: 1px solid var(--vw-border);
  border-radius: 18px;
  box-shadow: var(--vw-shadow);
  padding: 11px;
  color: var(--vw-text);
}
.vw-card-open { height: 100%; display: flex; flex-direction: column; }

/* A short rise, not a bounce: the widget should feel placed, not thrown. */
.vw-enter { animation: vw-in 220ms cubic-bezier(0.22, 1, 0.36, 1); }
@keyframes vw-in {
  from { opacity: 0; transform: translateY(8px) scale(0.975); }
  to   { opacity: 1; transform: none; }
}

.vw-pill-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.vw-pill-title { margin: 0; font-size: 14.5px; font-weight: 550; letter-spacing: -0.01em; }

.vw-head {
  display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
  padding: 0 2px 9px; border-bottom: 1px solid var(--vw-border);
}
.vw-head-title { margin: 0; font-size: 13px; font-weight: 550; letter-spacing: -0.01em; }
.vw-head-status {
  margin: 0; font-size: 11.5px; color: var(--vw-muted);
  display: flex; align-items: center; gap: 5px; white-space: nowrap;
}
.vw-dot { width: 5px; height: 5px; border-radius: 50%; background: #3aa5f5; }
.vw-dot-pulse { animation: vw-blink 1.1s ease-in-out infinite; }
@keyframes vw-blink { 0%, 100% { opacity: 0.25; } 50% { opacity: 1; } }

.vw-stage { flex: 1; display: grid; place-items: center; min-height: 0; }

.vw-controls { display: flex; gap: 7px; }

.vw-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  border-radius: 999px; border: 1px solid transparent;
  font-family: inherit; font-size: 14.5px; font-weight: 550; letter-spacing: -0.01em;
  cursor: pointer;
  transition: background-color 160ms ease, border-color 160ms ease,
              transform 160ms ease, opacity 160ms ease;
}
.vw-btn:focus-visible { outline: 2px solid #3aa5f5; outline-offset: 2px; }
.vw-btn:active { transform: scale(0.98); }

.vw-btn-primary {
  width: 100%; padding: 10px 18px;
  background: var(--vw-btn); color: var(--vw-btn-text);
}
.vw-btn-primary:hover { opacity: 0.88; }

.vw-btn-ghost {
  flex: 1; padding: 9px 12px; font-size: 13.5px;
  background: transparent; color: var(--vw-text);
  border-color: var(--vw-ghost-border);
}
.vw-btn-ghost:hover { background: var(--vw-ghost-hover); }
.vw-btn-active { background: var(--vw-ghost-hover); }

.vw-btn-end {
  width: 40px; height: 40px; padding: 0; flex-shrink: 0;
  background: #e5484d; color: #ffffff;
}
.vw-btn-end:hover { background: #d13b40; }

.vw-error {
  margin: 0 0 8px; padding: 8px 10px; border-radius: 10px;
  background: rgba(229, 72, 77, 0.10); color: #c9353a;
  font-size: 12px; line-height: 1.4;
}
@media (prefers-color-scheme: dark) {
  .vw-error { color: #ff9ea1; }
}

/* Motion here decorates a state the text already conveys, so it drops safely.
   The ring stills itself — see VoiceRing. */
@media (prefers-reduced-motion: reduce) {
  .vw-enter, .vw-dot-pulse { animation: none !important; }
  .vw-btn { transition: none; }
}
`;
