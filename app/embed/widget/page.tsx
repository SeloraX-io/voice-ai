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
 * Compact, call-panel and full-view states are reflected to the parent through
 * postMessage, because an iframe cannot resize itself.
 *
 * Styling is a <style> block rather than Tailwind classes: it keeps the whole
 * widget legible as one visual object, and it renders correctly even if the
 * host page's stylesheet somehow reaches in.
 */

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";

import { VoiceAura } from "@/components/embed/VoiceAura";
import { useVoiceSession } from "@/hooks/useVoiceSession";
import { normaliseClientId } from "@/lib/clients/types";
import { DEFAULT_EMBED_TEXT, parseEmbedTextConfig } from "@/lib/embed/config";

/** Matches the constants in public/embed.js. Both sides must agree. */
const MESSAGE_SOURCE = "voice-ai-widget";
const SELORAX_LOGO_URL = "/SeloraX%20Logo.svg";
const END_BRAND_MS = 5_200;

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
  // Forwarded by embed.js from the snippet's data-client attribute. A missing
  // or malformed value means the default client — exactly how snippets copied
  // before clients existed behave.
  const [clientId] = useState(() =>
    typeof window === "undefined"
      ? null
      : normaliseClientId(new URLSearchParams(window.location.search).get("client")),
  );
  const voice = useVoiceSession({ clientId });
  const [view, setView] = useState<"compact" | "panel" | "full">("compact");
  const [dismissedEndedAt, setDismissedEndedAt] = useState<number | null>(null);
  const [text] = useState(() =>
    typeof window === "undefined" ? DEFAULT_EMBED_TEXT : parseEmbedTextConfig(window.location.search),
  );
  const [mobileCompact] = useState(() =>
    typeof window === "undefined"
      ? false
      : new URLSearchParams(window.location.search).get("mobile") === "1",
  );
  const { status, error, endedAt, start, stop, muted, toggleMute, levels } = voice;

  useEffect(() => {
    postToParent({ type: "resize", view });
  }, [view]);

  useEffect(() => {
    const receiveCommand = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const message = event.data as { source?: unknown; type?: unknown } | null;
      if (message?.source !== "voice-ai-host") return;
      if (message.type === "open") setView("full");
      if (message.type === "minimize") {
        setView(status !== "idle" && status !== "error" ? "panel" : "compact");
      }
      if (message.type === "stop") {
        setView((current) => (current === "full" ? "full" : "panel"));
        void stop();
      }
    };
    window.addEventListener("message", receiveCommand);
    return () => window.removeEventListener("message", receiveCommand);
  }, [status, stop]);

  const live = status !== "idle" && status !== "error";
  const ended = endedAt !== null && endedAt !== dismissedEndedAt;

  useEffect(() => {
    if (!ended) return;
    const timer = setTimeout(() => {
      setDismissedEndedAt(endedAt);
      setView("compact");
    }, END_BRAND_MS);
    return () => clearTimeout(timer);
  }, [ended, endedAt]);

  const openAndStart = useCallback(async () => {
    setView(view === "full" ? "full" : "panel");
    // Called straight from the click, so the browser still counts this as a
    // user gesture — getUserMedia and AudioContext both require one.
    await start();
  }, [start, view]);

  const endCall = useCallback(async () => {
    await stop();
  }, [stop]);

  return (
    <>
      <style>{STYLES}</style>
      <div className={`vw-root${view === "full" ? " vw-root-full" : ""}`}>
        {view !== "compact" ? (
          <CallPanel
            status={status}
            error={error}
            muted={muted}
            onToggleMute={toggleMute}
            onEnd={endCall}
            levels={levels}
            live={live}
            text={text}
            full={view === "full"}
            onStart={openAndStart}
            onMinimize={() => setView(live ? "panel" : "compact")}
            ended={ended}
          />
        ) : (
          <Pill
            onStart={openAndStart}
            prompt={text.prompt}
            buttonText={text.buttonText}
            mobile={mobileCompact}
          />
        )}
      </div>
    </>
  );
}

/** The closed state: the ring, a question, and the call button. */
function Pill({
  onStart,
  prompt,
  buttonText,
  mobile,
}: {
  onStart: () => void;
  prompt: string;
  buttonText: string;
  mobile: boolean;
}) {
  if (mobile) {
    return (
      <button
        type="button"
        onClick={onStart}
        className="vw-mobile-launch"
        aria-label={buttonText}
      >
        <VoiceAura size={50} idle themeMode="light" />
      </button>
    );
  }

  return (
    <div className="vw-card vw-enter">
      <div className="vw-pill-head">
        <VoiceAura size={44} idle themeMode="light" />
        <p className="vw-pill-title">{prompt}</p>
      </div>
      <button type="button" onClick={onStart} className="vw-btn vw-btn-primary">
        <PhoneIcon />
        {buttonText}
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
  text,
  full,
  onStart,
  onMinimize,
  ended,
}: {
  status: string;
  error: string | null;
  muted: boolean;
  onToggleMute: () => void;
  onEnd: () => void;
  levels: React.RefObject<{ user: number; agent: number }>;
  live: boolean;
  text: typeof DEFAULT_EMBED_TEXT;
  full: boolean;
  onStart: () => void;
  onMinimize: () => void;
  ended: boolean;
}) {
  return (
    <div className={`vw-card vw-card-open vw-enter${full ? " vw-card-full" : ""}`}>
      <header className="vw-head">
        <p className="vw-head-title">{text.title}</p>
        <p className="vw-head-status">
          <span className={`vw-dot${status === "connecting" ? " vw-dot-pulse" : ""}`} />
          {ended ? "কল শেষ হয়েছে" : statusLabel(status)}
        </p>
      </header>

      {full && (
        <button
          type="button"
          className="vw-minimize"
          onClick={onMinimize}
          aria-label="Minimize widget"
        >
          <MinimizeIcon />
        </button>
      )}

      <div className="vw-stage">
        {ended ? (
          <EndBrand />
        ) : (
          <VoiceAura size={150} status={status} level={levels} idle={!live || muted} />
        )}
      </div>

      {error && <p className="vw-error">{error}</p>}

      {ended ? null : !live && !error ? (
        <button type="button" onClick={onStart} className="vw-btn vw-btn-primary">
          <PhoneIcon />
          {text.buttonText}
        </button>
      ) : (
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
          <button
            type="button"
            onClick={onEnd}
            className="vw-btn vw-btn-end"
            aria-label="কল শেষ করুন"
          >
            <HangUpIcon />
          </button>
        </div>
      )}

      {!ended && <PoweredBy />}
    </div>
  );
}

/** Where the logo leads. A new tab, because the widget lives in an iframe on somebody else's page. */
const SELORAX_SITE_URL = "https://selorax.io";

function PoweredBy() {
  return (
    <a
      className="vw-powered"
      href={SELORAX_SITE_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Powered by SeloraX — visit selorax.io"
    >
      <span>Powered by</span>
      <Image src={SELORAX_LOGO_URL} alt="SeloraX" width={1918} height={407} unoptimized />
    </a>
  );
}

function EndBrand() {
  return (
    <div className="vw-end-brand" role="status" aria-label="Call ended. Powered by SeloraX">
      <span className="vw-end-orbit" aria-hidden />
      <p>Powered by</p>
      <a
        href={SELORAX_SITE_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Visit selorax.io"
      >
        <Image src={SELORAX_LOGO_URL} alt="SeloraX" width={1918} height={407} unoptimized />
      </a>
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

function MinimizeIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
    >
      <path d="M5 12h14" />
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
.vw-root-full {
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(8, 10, 14, 0.52);
  backdrop-filter: blur(8px);
}
/* A full-viewport backdrop blur is one of the most expensive things a mobile
   GPU can be asked for, and it runs on every frame the page under it moves.
   Touch devices get a slightly darker plain scrim instead, which reads the
   same. */
@media (pointer: coarse) {
  .vw-root-full { backdrop-filter: none; background: rgba(8, 10, 14, 0.7); }
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
.vw-card-full {
  position: relative;
  width: min(420px, 100%);
  height: min(560px, 100%);
  padding: 18px;
  border-radius: 24px;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.28);
}
.vw-minimize {
  position: absolute; top: 12px; right: 12px;
  display: grid; place-items: center; width: 30px; height: 30px;
  border: 1px solid var(--vw-ghost-border); border-radius: 999px;
  background: var(--vw-card); color: var(--vw-text); cursor: pointer;
}
.vw-card-full .vw-head { padding-right: 38px; }

.vw-mobile-launch {
  position: relative; display: grid; place-items: center;
  width: 66px; height: 66px; padding: 0;
  border: 1px solid rgba(255, 129, 35, 0.32); border-radius: 50%;
  background: #0b0b0d; color: #ffffff; cursor: pointer;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.24);
  animation: vw-in 220ms cubic-bezier(0.22, 1, 0.36, 1);
}
.vw-mobile-launch::before {
  content: ""; position: absolute; inset: 5px; border-radius: inherit;
  border: 1px solid rgba(255, 255, 255, 0.09); pointer-events: none;
}
/* The pulse animates opacity/transform on a pseudo-element rather than the
   button's own box-shadow: shadow animation repaints the layer every frame,
   while this composites — the difference is visible on a phone that is also
   running the host page. */
.vw-mobile-launch::after {
  content: ""; position: absolute; inset: -6px; border-radius: 50%;
  border: 2px solid rgba(255, 129, 35, 0.3); pointer-events: none;
  opacity: 0;
  animation: vw-mobile-glow 2.4s 300ms ease-in-out infinite;
  will-change: transform, opacity;
}
.vw-mobile-launch:focus-visible { outline: 2px solid #ff8123; outline-offset: 3px; }
.vw-mobile-launch:active { transform: scale(0.96); }
@keyframes vw-mobile-glow {
  0%, 100% { opacity: 0; transform: scale(0.9); }
  50% { opacity: 1; transform: scale(1); }
}

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

.vw-powered {
  align-self: center; display: inline-flex; align-items: center; gap: 6px;
  margin-top: 9px; padding: 5px 8px; border-radius: 999px;
  background: #0b0b0d; color: #a1a1aa;
  font-size: 8px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
  text-decoration: none; cursor: pointer; transition: color 160ms ease;
}
.vw-powered:hover { color: #e4e4e7; }
.vw-powered:focus-visible { outline: 2px solid #3aa5f5; outline-offset: 2px; }
.vw-powered img { display: block; width: 62px; height: auto; }

.vw-end-brand {
  position: relative; isolation: isolate; overflow: hidden;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  width: 100%; min-height: 150px; padding: 22px; box-sizing: border-box;
  border: 1px solid rgba(255, 129, 35, 0.22); border-radius: 18px;
  background: radial-gradient(circle at 50% 110%, rgba(255, 129, 35, 0.18), transparent 55%), #09090b;
  box-shadow: inset 0 1px rgba(255, 255, 255, 0.05);
  animation: vw-brand-in 500ms cubic-bezier(0.22, 1, 0.36, 1) both;
}
.vw-end-brand::after {
  content: ""; position: absolute; z-index: -1; inset: -70% -20%;
  background: linear-gradient(100deg, transparent 35%, rgba(255, 255, 255, 0.09) 49%, transparent 63%);
  animation: vw-brand-sweep 2.4s ease-in-out infinite;
}
.vw-end-brand p {
  margin: 0 0 10px; color: #a1a1aa;
  font-size: 10px; font-weight: 650; letter-spacing: 0.16em; text-transform: uppercase;
  animation: vw-brand-copy 500ms 100ms ease-out both;
}
/* The logo link owns the width the image used to have, so the image fills it
   and the click target is exactly the logo. */
.vw-end-brand a {
  display: block; width: min(190px, 82%); border-radius: 6px;
}
.vw-end-brand a:focus-visible { outline: 2px solid #ff8123; outline-offset: 4px; }
.vw-end-brand img {
  display: block; width: 100%; height: auto;
  animation: vw-brand-logo 650ms 130ms cubic-bezier(0.22, 1, 0.36, 1) both;
}
.vw-end-orbit {
  position: absolute; z-index: -1; width: 190px; height: 190px; border-radius: 50%;
  border: 1px solid rgba(255, 129, 35, 0.16);
  box-shadow: 0 0 50px rgba(255, 129, 35, 0.12);
  animation: vw-brand-orbit 3.2s ease-in-out infinite;
}
@keyframes vw-brand-in {
  from { opacity: 0; transform: scale(0.94); }
  to { opacity: 1; transform: none; }
}
@keyframes vw-brand-copy {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}
@keyframes vw-brand-logo {
  from { opacity: 0; transform: translateY(10px) scale(0.9); filter: blur(5px); }
  to { opacity: 1; transform: none; filter: blur(0); }
}
@keyframes vw-brand-sweep {
  0%, 30% { transform: translateX(-35%) rotate(8deg); opacity: 0; }
  50% { opacity: 1; }
  75%, 100% { transform: translateX(35%) rotate(8deg); opacity: 0; }
}
@keyframes vw-brand-orbit {
  0%, 100% { transform: scale(0.82); opacity: 0.35; }
  50% { transform: scale(1); opacity: 0.8; }
}

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
  .vw-enter, .vw-dot-pulse, .vw-end-brand, .vw-end-brand::after,
  .vw-end-brand p, .vw-end-brand img, .vw-end-orbit,
  .vw-mobile-launch, .vw-mobile-launch::after { animation: none !important; }
  .vw-btn { transition: none; }
}
`;
