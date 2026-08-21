"use client";

/**
 * The widget's visualiser: LiveKit's Agents UI aura, driven by this project's
 * voice session.
 *
 * The aura component and its hook are vendored under components/agents-ui and
 * hooks/agents-ui. Read the licence header on
 * components/agents-ui/agent-audio-visualizer-aura.tsx before shipping this:
 * the shader is Polyform Non-Resale (© UNCRN LLC), NOT the Apache-2.0 that
 * covers the rest of LiveKit's components repo. Its MIT-licensed shader host
 * (react-shader-toy) is a separate file with a separate licence.
 *
 * This file is the whole adapter, and it exists because upstream expects a
 * LiveKit room and this project has a plain WebSocket gateway. It does two
 * things:
 *
 *   1. maps our `VoiceStatus` onto the `AgentState` the aura animates against;
 *   2. samples the audio-rate `levels` ref into React state at a rate a React
 *      tree can actually absorb.
 */

import { useEffect, useRef, useState } from "react";

import { AgentAudioVisualizerAura } from "@/components/agents-ui/agent-audio-visualizer-aura";
import { type AgentState } from "@/hooks/agents-ui/agent-state";

export interface VoiceAuraProps {
  /** CSS pixels, square. Rendered at this exact size rather than a size preset. */
  size: number;
  /** The session's status, mapped to the aura's own state machine. */
  status?: string;
  /**
   * Live audio, 0..1. A ref because it changes at audio rate; this component
   * samples it rather than re-rendering on every change.
   */
  level?: React.RefObject<{ user: number; agent: number }> | null;
  /** Calms the aura without unmounting it — used while muted or before a call. */
  idle?: boolean;
  /** Matches the aura to the card behind it. */
  themeMode?: "light" | "dark";
}

/**
 * `pcm16Rms` returns true RMS, where conversational speech measures roughly
 * 0.03–0.25 — it only nears 1.0 on a clipped signal. Passing that straight
 * through leaves the aura almost still for the whole call. The gain maps
 * ordinary speech across most of 0..1; the sub-1 exponent lifts quiet passages
 * further than loud ones, so a soft speaker still registers.
 */
const INPUT_GAIN = 3.4;
const INPUT_CURVE = 0.62;

/**
 * How often the audio level is pushed into React state.
 *
 * Every push re-renders this subtree, so it cannot run at frame rate. 15Hz and
 * a soft attack/release keep speech expressive without making the logo twitch
 * on every syllable.
 * The shader animates continuously on its own clock regardless; this only
 * controls how often its amplitude is corrected.
 */
const SAMPLE_HZ = 15;
const ATTACK = 0.24;
const RELEASE = 0.12;

/** Our session statuses do not line up one-to-one with the aura's states. */
function toAgentState(status: string | undefined, idle: boolean): AgentState {
  if (idle) return "idle";
  switch (status) {
    case "connecting":
      return "connecting";
    // The aura has no "interrupted" state, and it does not need one: a barge-in
    // is the agent listening again, which is exactly how it should look.
    case "listening":
    case "interrupted":
      return "listening";
    case "thinking":
      return "thinking";
    case "speaking":
      return "speaking";
    case "error":
      return "failed";
    default:
      return "idle";
  }
}

export function VoiceAura({
  size,
  status,
  level = null,
  idle = false,
  themeMode = "light",
}: VoiceAuraProps) {
  const [volume, setVolume] = useState(0);
  // Held in a ref as well so the interval can compare against the last value
  // without re-subscribing every time it changes.
  const lastRef = useRef(0);
  const smoothedRef = useRef(0);

  useEffect(() => {
    // No synchronous setState on the idle path: the effect only subscribes, and
    // the idle value is derived at render instead (see `effectiveVolume`).
    // Setting state here would queue a second render every time `idle` flipped.
    if (idle || !level) {
      lastRef.current = 0;
      smoothedRef.current = 0;
      return;
    }
    const id = window.setInterval(() => {
      const current = level.current;
      const raw = current ? Math.max(current.user, current.agent) : 0;
      const target = Math.min(1, Math.pow(Math.max(raw, 0) * INPUT_GAIN, INPUT_CURVE));
      const response = target > smoothedRef.current ? ATTACK : RELEASE;
      const shaped = smoothedRef.current + (target - smoothedRef.current) * response;
      smoothedRef.current = shaped;
      // Only re-render on a change big enough to see. Without this the aura
      // re-renders 25 times a second through every silence, for nothing.
      if (Math.abs(shaped - lastRef.current) > 0.02) {
        lastRef.current = shaped;
        setVolume(shaped);
      }
    }, 1000 / SAMPLE_HZ);
    return () => window.clearInterval(id);
  }, [level, idle]);

  // Derived rather than stored, so going idle takes effect on this render
  // instead of scheduling another one.
  const effectiveVolume = idle ? 0 : volume;

  return (
    <AgentAudioVisualizerAura
      state={toAgentState(status, idle)}
      volume={effectiveVolume}
      themeMode={themeMode}
      color="#1FD5F9"
      // Upstream sizes via a Tailwind variant with fixed steps (24/56/112/…).
      // The widget needs exact pixels to fit its card, so the preset is
      // overridden here rather than the card being resized to suit it.
      className="aspect-square"
      style={{ width: size, height: size }}
    />
  );
}
