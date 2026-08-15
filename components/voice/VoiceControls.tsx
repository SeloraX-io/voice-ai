"use client";

import { Loader2, Mic, MicOff, PhoneOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { VoiceStatus } from "@/lib/gemini/types";
import { cn } from "@/lib/utils";

interface VoiceControlsProps {
  status: VoiceStatus;
  muted: boolean;
  onStart: () => void;
  onStop: () => void;
  onToggleMute: () => void;
}

export function VoiceControls({
  status,
  muted,
  onStart,
  onStop,
  onToggleMute,
}: VoiceControlsProps) {
  const connecting = status === "connecting";
  const live = status !== "idle" && status !== "error" && !connecting;

  if (!live) {
    return (
      <div className="flex flex-col items-center gap-3">
        <Button variant="primary" size="lg" onClick={onStart} disabled={connecting}>
          {connecting ? <Loader2 className="animate-spin" /> : <Mic />}
          {connecting ? "Connecting…" : status === "error" ? "Try again" : "Start Conversation"}
        </Button>
        <p className="text-xs text-[var(--text-dim)]">
          Talk naturally with the AI — it listens while you speak.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="icon"
          onClick={onToggleMute}
          aria-pressed={muted}
          aria-label={muted ? "Unmute microphone" : "Mute microphone"}
          className={cn("size-12", muted && "border-[var(--warning)] text-[var(--warning)]")}
        >
          {muted ? <MicOff /> : <Mic />}
        </Button>

        <Button variant="danger" size="lg" onClick={onStop}>
          <PhoneOff />
          End Call
        </Button>
      </div>
      <p className="text-xs text-[var(--text-dim)]">
        {muted ? "Microphone muted" : "Just start talking — you can interrupt at any time."}
      </p>
    </div>
  );
}
