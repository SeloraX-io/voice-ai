"use client";

import { useEffect, useRef } from "react";

import type { VoiceLevels } from "@/hooks/useVoiceSession";
import type { VoiceStatus } from "@/lib/gemini/types";

interface VoiceWaveformProps {
  status: VoiceStatus;
  levels: React.RefObject<VoiceLevels>;
  /** Number of bars in the rolling history. */
  bars?: number;
  className?: string;
}

const HEIGHT = 72;

/**
 * Rolling level history rendered on a canvas.
 *
 * Every bar is a real RMS measurement — user bars come from the capture
 * worklet, agent bars from an AnalyserNode on the playback graph. Nothing here
 * is synthesised, so a silent room draws a flat line.
 */
export function VoiceWaveform({ status, levels, bars = 72, className }: VoiceWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const historyRef = useRef<Float32Array>(new Float32Array(bars));
  const sourceRef = useRef<Uint8Array>(new Uint8Array(bars));
  // Mirrored into a ref so the render loop reads the live status without
  // restarting the animation frame on every change.
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    historyRef.current = new Float32Array(bars);
    sourceRef.current = new Uint8Array(bars);
  }, [bars]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    let frame = 0;
    let width = 0;
    let dpr = 1;

    const resize = () => {
      const next = canvas.clientWidth;
      const nextDpr = Math.min(window.devicePixelRatio || 1, 2);
      if (next === width && nextDpr === dpr) return;
      width = next;
      dpr = nextDpr;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.round(HEIGHT * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const render = () => {
      resize();
      const history = historyRef.current;
      const source = sourceRef.current;
      const current = statusRef.current;
      const live = levels.current;

      // 0 = idle, 1 = user, 2 = agent. Drives the per-bar colour.
      let value = 0;
      let kind = 0;
      if (current === "speaking") {
        value = live.agent;
        kind = 2;
      } else if (current === "listening" || current === "interrupted" || current === "thinking") {
        value = live.user;
        kind = live.user > 0.012 ? 1 : 0;
      }

      history.copyWithin(0, 1);
      source.copyWithin(0, 1);
      history[bars - 1] = Math.min(1, Math.sqrt(Math.max(0, value)) * 1.85);
      source[bars - 1] = kind;

      context.clearRect(0, 0, width, HEIGHT);

      const gap = 3;
      const barWidth = Math.max(2, (width - gap * (bars - 1)) / bars);
      const mid = HEIGHT / 2;
      const idle = current === "idle" || current === "error";

      for (let i = 0; i < bars; i++) {
        const amplitude = history[i];
        const height = Math.max(2, amplitude * (HEIGHT - 8));
        const x = i * (barWidth + gap);
        // Fade the tail of the history so motion reads left-to-right.
        const age = 0.25 + (i / bars) * 0.75;

        if (idle) {
          context.fillStyle = `rgba(140,140,170,${0.18 * age})`;
        } else if (source[i] === 2) {
          context.fillStyle = `rgba(34,211,238,${0.35 + amplitude * 0.65 * age})`;
        } else if (source[i] === 1) {
          context.fillStyle = `rgba(124,92,255,${0.35 + amplitude * 0.65 * age})`;
        } else {
          context.fillStyle = `rgba(140,140,170,${0.22 * age})`;
        }

        const radius = Math.min(barWidth / 2, height / 2);
        context.beginPath();
        context.roundRect(x, mid - height / 2, barWidth, height, radius);
        context.fill();
      }

      frame = requestAnimationFrame(render);
    };

    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [bars, levels]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: "100%", height: HEIGHT }}
      aria-hidden
    />
  );
}
