"use client";

import { useEffect, useRef } from "react";

import type { VoiceLevels } from "@/hooks/useVoiceSession";
import type { VoiceStatus } from "@/lib/gemini/types";
import { cn } from "@/lib/utils";

interface VoiceOrbProps {
  status: VoiceStatus;
  levels: React.RefObject<VoiceLevels>;
}

/** Per-state palette. Kept here so every visual state is defined in one place. */
const PALETTE: Record<VoiceStatus, { from: string; to: string; glow: string }> = {
  idle: { from: "#4b4b63", to: "#2a2a3a", glow: "rgba(124,92,255,0.18)" },
  connecting: { from: "#7c5cff", to: "#4c3bd6", glow: "rgba(124,92,255,0.45)" },
  listening: { from: "#7c5cff", to: "#22d3ee", glow: "rgba(124,92,255,0.55)" },
  thinking: { from: "#8b6bff", to: "#5b3fd8", glow: "rgba(124,92,255,0.5)" },
  speaking: { from: "#22d3ee", to: "#7c5cff", glow: "rgba(34,211,238,0.55)" },
  interrupted: { from: "#fbbf24", to: "#f97316", glow: "rgba(251,191,36,0.5)" },
  error: { from: "#f43f5e", to: "#9f1239", glow: "rgba(244,63,94,0.45)" },
};

/** Which live level the orb should follow in each state. */
function levelFor(status: VoiceStatus, levels: VoiceLevels): number {
  if (status === "speaking") return levels.agent;
  if (status === "listening" || status === "interrupted") return levels.user;
  return 0;
}

export function VoiceOrb({ status, levels }: VoiceOrbProps) {
  const coreRef = useRef<HTMLDivElement>(null);
  const haloRef = useRef<HTMLDivElement>(null);
  const smoothed = useRef(0);
  // Mirrored into a ref so the animation loop always sees the current state
  // without being torn down and rebuilt on every status change.
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    let frame = 0;

    const render = () => {
      const raw = levelFor(statusRef.current, levels.current);
      // Perceptual boost: speech RMS rarely exceeds ~0.3, so map it up.
      const target = Math.min(1, Math.sqrt(Math.max(0, raw)) * 1.9);
      smoothed.current += (target - smoothed.current) * (target > smoothed.current ? 0.4 : 0.12);

      const value = smoothed.current;
      if (coreRef.current) {
        coreRef.current.style.transform = `scale(${1 + value * 0.22})`;
      }
      if (haloRef.current) {
        haloRef.current.style.transform = `scale(${1 + value * 0.5})`;
        haloRef.current.style.opacity = `${0.25 + value * 0.55}`;
      }
      frame = requestAnimationFrame(render);
    };

    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [levels]);

  const palette = PALETTE[status];
  const isActive = status !== "idle" && status !== "error";
  const rippling = status === "listening" || status === "speaking";

  return (
    <div
      className="relative grid size-52 place-items-center sm:size-60"
      role="img"
      aria-label={`Voice agent state: ${status}`}
    >
      {/* Soft ambient glow that tracks the live level. */}
      <div
        ref={haloRef}
        className="pointer-events-none absolute size-40 rounded-full blur-3xl transition-colors duration-500 sm:size-48"
        style={{ background: palette.glow }}
      />

      {/* Expanding rings, only while there is actual audio in flight. */}
      {rippling && (
        <>
          <span
            className="pointer-events-none absolute size-36 rounded-full border sm:size-40"
            style={{
              borderColor: palette.from,
              animation: "ring-ripple 2.4s ease-out infinite",
            }}
          />
          <span
            className="pointer-events-none absolute size-36 rounded-full border sm:size-40"
            style={{
              borderColor: palette.to,
              animation: "ring-ripple 2.4s ease-out 1.2s infinite",
            }}
          />
        </>
      )}

      {/* Slowly rotating gradient rim. */}
      <div
        className={cn(
          "absolute size-40 rounded-full opacity-70 blur-[2px] sm:size-48",
          isActive ? "" : "opacity-30",
        )}
        style={{
          background: `conic-gradient(from 0deg, transparent, ${palette.from}, transparent 45%, ${palette.to}, transparent)`,
          animation: `orb-spin ${status === "thinking" ? "3s" : "9s"} linear infinite`,
        }}
      />

      {/* Core sphere. */}
      <div
        ref={coreRef}
        className={cn(
          "relative size-32 rounded-full will-change-transform sm:size-36",
          "transition-[background] duration-500",
          status === "thinking" && "[animation:orb-breathe_1.6s_ease-in-out_infinite]",
        )}
        style={{
          background: `radial-gradient(circle at 32% 28%, ${palette.from}, ${palette.to} 68%, rgba(0,0,0,0.55))`,
          boxShadow: `0 0 60px -10px ${palette.glow}, inset 0 -14px 30px -12px rgba(0,0,0,0.8)`,
        }}
      >
        {/* Specular highlight. */}
        <div className="absolute left-[22%] top-[16%] size-8 rounded-full bg-white/35 blur-lg" />
      </div>
    </div>
  );
}
