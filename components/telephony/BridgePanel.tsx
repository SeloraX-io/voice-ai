"use client";

import { useState } from "react";
import { AlertTriangle, Phone, PhoneOff } from "lucide-react";

import { ToolActivity } from "@/components/preview/ToolActivity";
import { CredentialsForm } from "@/components/telephony/CredentialsForm";
import { Button } from "@/components/ui/button";
import { Transcript } from "@/components/voice/Transcript";
import { VoiceWaveform } from "@/components/voice/VoiceWaveform";
import { useSoftphoneBridge } from "@/hooks/useSoftphoneBridge";
import type { VoiceStatus } from "@/lib/gemini/types";
import type { BridgeStatus } from "@/lib/telephony/bridge-state";
import { isConfigured, type SipCredentials } from "@/lib/telephony/credentials";

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
    label: "Registration failed",
    detail: "The extension is not registered. Check the credentials and try again.",
    dot: "bg-[var(--danger)]",
    text: "text-[var(--danger)]",
  },
};

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
export function BridgePanel({ initialCredentials }: { initialCredentials: SipCredentials }) {
  const [credentials, setCredentials] = useState(initialCredentials);
  const bridge = useSoftphoneBridge();

  const { status, from, to, endReason, error } = bridge.state;
  const look = STATUS[status];
  const idle = isIdle(status);
  const configured = isConfigured(credentials);
  const problem = error ?? bridge.notice;
  const onCall = status === "ringing" || status === "in_call" || status === "ending";

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
              disabled={!configured}
              onClick={() => void bridge.goOnline(credentials)}
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

        {idle && !configured && (
          <p className="mt-3 text-xs text-[var(--text-muted)]">
            Save the five SIP values below before going online.
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
        <h2 className="text-sm font-semibold text-[var(--text)]">SIP line</h2>
        <p className="mb-4 mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
          Paste the five values the dashboard returns from{" "}
          <code className="font-mono text-[var(--text)]">GET /api/calling/extension</code>. They
          are stored on this machine in <code className="font-mono text-[var(--text)]">data/telephony.json</code>.
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
