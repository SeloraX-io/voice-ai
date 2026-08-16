"use client";

import { useState } from "react";
import { AlertTriangle, Phone, PhoneOff } from "lucide-react";

import { ToolActivity } from "@/components/preview/ToolActivity";
import { CredentialsForm } from "@/components/telephony/CredentialsForm";
import { Button } from "@/components/ui/button";
import { Transcript } from "@/components/voice/Transcript";
import { VoiceWaveform } from "@/components/voice/VoiceWaveform";
import { useSoftphoneBridge, type LineSource } from "@/hooks/useSoftphoneBridge";
import type { VoiceStatus } from "@/lib/gemini/types";
import type { BridgeStatus } from "@/lib/telephony/bridge-state";
import { isConfigured, type SipCredentials } from "@/lib/telephony/credentials";

/**
 * What the page could tell us about the Selorax connection without sending the
 * admin token to the browser. `tokenExpiresInDays` is computed on the server so
 * this component renders the same string on both sides of hydration.
 */
export interface SeloraxStatus {
  configured: boolean;
  baseUrl: string;
  /** Epoch ms, or null when the token carries no readable expiry. */
  tokenExpiresAt: number | null;
  tokenExpiresInDays: number | null;
}

/**
 * Below this, the token is close enough to lapsing to say so on the page. The
 * same threshold the Selorax settings panel uses, so the two never disagree.
 */
const EXPIRY_WARNING_DAYS = 14;

interface StatusLook {
  label: string;
  detail: string;
  /** Tailwind class carrying a theme token — never a literal colour. */
  dot: string;
  text: string;
}

const STATUS: Record<BridgeStatus, StatusLook> = {
  offline: {
    label: "Offline",
    detail: "The extension is not registered, so calls to it will not ring here.",
    dot: "bg-[var(--text-dim)]",
    text: "text-[var(--text-muted)]",
  },
  connecting: {
    label: "Connecting",
    detail: "Registering the extension with the SIP server.",
    dot: "bg-[var(--warning)]",
    text: "text-[var(--warning)]",
  },
  online: {
    label: "Online",
    detail: "Registered and waiting. The next call to this extension is answered by the agent.",
    dot: "bg-[var(--success)]",
    text: "text-[var(--success)]",
  },
  ringing: {
    label: "Ringing",
    detail: "A call arrived. Opening the voice gateway before answering.",
    dot: "bg-[var(--accent)]",
    text: "text-[var(--accent)]",
  },
  in_call: {
    label: "On a call",
    detail: "Audio is bridged in both directions.",
    dot: "bg-[var(--success)]",
    text: "text-[var(--success)]",
  },
  ending: {
    label: "Wrapping up",
    detail: "The gateway is done. Letting the agent finish speaking before hanging up.",
    dot: "bg-[var(--warning)]",
    text: "text-[var(--warning)]",
  },
  failed: {
    label: "Not registered",
    detail: "No calls ring here. The reason is below; fix it and go online again.",
    dot: "bg-[var(--danger)]",
    text: "text-[var(--danger)]",
  },
};

/** The UTC date, formatted identically on the server and in the browser. */
function isoDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** The bridge statuses in which no call is up, so the line may be changed. */
function isIdle(status: BridgeStatus): boolean {
  return status === "offline" || status === "failed";
}

/**
 * Maps the bridge's lifecycle onto the preview's speaking states, so the
 * transcript header and the waveform can be reused rather than rewritten.
 */
function toVoiceStatus(status: BridgeStatus, speaker: "user" | "assistant" | null): VoiceStatus {
  if (status === "ending") return "speaking";
  if (status !== "in_call") return "idle";
  return speaker === "assistant" ? "speaking" : "listening";
}

/**
 * The bridge, on one screen: whether the extension is registered, what call is
 * on it, and what is being said.
 *
 * The Go online control is deliberately unavailable outside `offline` and
 * `failed`. `bridgeReducer` does not guard `go_online` — it is the operator's
 * stop-and-start button — so firing it mid-call would discard the live call's
 * caller number and end reason. Preventing that is this component's job.
 */
export function BridgePanel({
  selorax,
  directCredentials,
}: {
  selorax: SeloraxStatus;
  directCredentials: SipCredentials;
}) {
  const [credentials, setCredentials] = useState(directCredentials);
  const bridge = useSoftphoneBridge();

  const { status, from, to, endReason, error } = bridge.state;
  const look = STATUS[status];
  const idle = isIdle(status);
  const problem = error ?? bridge.notice;
  const onCall = status === "ringing" || status === "in_call" || status === "ending";

  // Derived, never chosen: a complete Selorax config means the line and its
  // TURN servers come from Selorax, and anything else falls back to the SIP
  // credentials saved on this machine.
  const source: LineSource = selorax.configured
    ? { mode: "selorax" }
    : { mode: "direct", credentials };
  const canGoOnline = selorax.configured || isConfigured(credentials);
  const expiringSoon =
    selorax.tokenExpiresInDays !== null && selorax.tokenExpiresInDays <= EXPIRY_WARNING_DAYS;
  const activeLine = bridge.line;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-lg font-semibold tracking-tight text-[var(--text)]">Telephony</h1>
        <p className="mt-1 text-sm leading-relaxed text-[var(--text-muted)]">
          The agent registers as a softphone on its own SIP extension and answers calls to it.
          Keep this tab open while the bridge is online — closing it drops any call in progress.
        </p>
      </header>

      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className={`flex items-center gap-2 text-sm font-semibold ${look.text}`}>
              <span className={`size-2 shrink-0 rounded-full ${look.dot}`} />
              {look.label}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">{look.detail}</p>
          </div>

          {idle ? (
            <Button
              variant="primary"
              disabled={!canGoOnline}
              onClick={() => void bridge.goOnline(source)}
            >
              <Phone />
              Go online
            </Button>
          ) : (
            <Button variant="danger" onClick={() => void bridge.goOffline()}>
              <PhoneOff />
              Go offline
            </Button>
          )}
        </div>

        {idle && !canGoOnline && (
          <p className="mt-3 text-xs text-[var(--text-muted)]">
            Connect Selorax, or save the five SIP values below, before going online.
          </p>
        )}

        {activeLine && (
          <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-[var(--border)] pt-3 text-xs">
            <div>
              <dt className="text-[var(--text-dim)]">Extension</dt>
              <dd className="mt-0.5 font-mono text-sm text-[var(--text)]">
                {activeLine.extension}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--text-dim)]">Media path</dt>
              <dd
                className={`mt-0.5 text-sm ${
                  activeLine.turnServerCount > 0 ? "text-[var(--text)]" : "text-[var(--warning)]"
                }`}
              >
                {activeLine.turnServerCount > 0
                  ? `${activeLine.iceServerCount} ICE, ${activeLine.turnServerCount} of them TURN`
                  : activeLine.iceServerCount > 0
                    ? `${activeLine.iceServerCount} ICE, no TURN`
                    : "No ICE servers"}
              </dd>
            </div>
          </dl>
        )}

        {activeLine !== null && activeLine.turnServerCount === 0 && (
          <p className="mt-3 text-xs leading-relaxed text-[var(--warning)]">
            This line came with no TURN server, so nothing can relay the call&rsquo;s audio. Behind
            symmetric NAT or a restrictive firewall that shows up as one-way or missing audio on a
            call that otherwise looks healthy. The bridge stays online — a call that works on a
            flat network beats no call at all.
          </p>
        )}

        {onCall && (
          <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-[var(--border)] pt-3 text-xs">
            <div>
              <dt className="text-[var(--text-dim)]">Caller</dt>
              <dd className="mt-0.5 font-mono text-sm text-[var(--text)]">{from ?? "unknown"}</dd>
            </div>
            <div>
              <dt className="text-[var(--text-dim)]">Dialled</dt>
              <dd className="mt-0.5 font-mono text-sm text-[var(--text)]">{to ?? "unknown"}</dd>
            </div>
          </dl>
        )}

        {endReason && (
          <p className="mt-3 rounded-xl bg-[var(--surface-3)] px-3 py-2 text-xs text-[var(--text-muted)]">
            The agent asked to end the call: {endReason}
          </p>
        )}

        {onCall && (
          <div className="mt-4">
            <VoiceWaveform
              status={toVoiceStatus(status, bridge.activeSpeaker)}
              levels={bridge.levels}
            />
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] px-5 py-4">
        <h2 className="text-sm font-semibold text-[var(--text)]">
          Line source: {selorax.configured ? "Selorax" : "saved SIP credentials"}
        </h2>
        {selorax.configured ? (
          <>
            <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
              Going online claims the extension and its TURN servers from{" "}
              <code className="font-mono text-[var(--text)]">{selorax.baseUrl}</code>, once per
              session. The SIP line saved below is ignored.
            </p>
            <p
              className={`mt-2 text-xs leading-relaxed ${
                expiringSoon ? "text-[var(--warning)]" : "text-[var(--text-muted)]"
              }`}
            >
              {selorax.tokenExpiresAt === null
                ? "The auth token carries no readable expiry, so there is no warning before it lapses."
                : `The auth token expires on ${isoDate(selorax.tokenExpiresAt)}${
                    selorax.tokenExpiresInDays === null
                      ? ""
                      : selorax.tokenExpiresInDays < 0
                        ? " — it has already expired, so no line can be claimed."
                        : ` — ${selorax.tokenExpiresInDays} day${
                            selorax.tokenExpiresInDays === 1 ? "" : "s"
                          } from now.`
                  }`}
            </p>
          </>
        ) : (
          <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
            Selorax is not connected, so the bridge registers with the SIP line saved below. That
            line carries no TURN servers — usable for development, weaker on a real network.
            Connect Selorax to have the extension and its TURN servers claimed automatically.
          </p>
        )}
      </section>

      {problem && (
        <p
          role="alert"
          className="flex items-start gap-2.5 rounded-xl border border-[var(--danger)]/35 bg-[var(--danger)]/10 px-4 py-3 text-sm text-[var(--danger)]"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{problem}</span>
        </p>
      )}

      {/* Above the transcript for the same reason as in the preview: a tool call
          is the explanation for a silence in it. */}
      <ToolActivity entries={bridge.toolActivity} />

      <Transcript
        entries={bridge.transcript}
        status={toVoiceStatus(status, bridge.activeSpeaker)}
        onClear={bridge.clearTranscript}
      />

      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] px-5 py-4">
        <h2 className="text-sm font-semibold text-[var(--text)]">
          SIP line {selorax.configured && <span className="text-[var(--text-dim)]">(unused)</span>}
        </h2>
        <p className="mb-4 mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
          {selorax.configured
            ? "Kept for development against a PBX without Selorax. While Selorax is connected the bridge claims its line from there and these values are not read."
            : "Paste the five values the dashboard returns from GET /api/calling/extension."}{" "}
          They are stored on this machine in{" "}
          <code className="font-mono text-[var(--text)]">data/telephony.json</code>.
        </p>
        <CredentialsForm
          credentials={credentials}
          onSaved={setCredentials}
          disabled={!idle}
        />
      </section>
    </div>
  );
}
