"use client";

/**
 * The glowing, undulating ring — and the call's audio meter.
 *
 * Canvas rather than CSS or SVG. The shape is a circle whose radius is summed
 * from several sine waves at different frequencies, each drifting at its own
 * rate, so the outline never returns to the same shape. No CSS gradient or SVG
 * path can express a radius that varies continuously with angle AND time, and
 * an SVG smooth enough would mean rebuilding a path string every frame.
 *
 * Everything about how it reacts is in `energy` below. Getting that number
 * right is the whole job: a ring driven by raw RMS looks broken, because raw
 * RMS almost never approaches 1.
 */

import { useEffect, useRef } from "react";

export interface VoiceRingProps {
  /** CSS pixels, square. */
  size: number;
  /**
   * Live audio, 0..1. A ref rather than a prop value because it changes at
   * audio rate: passing it through React state would re-render on every frame
   * for a number only the canvas reads.
   */
  level?: React.RefObject<{ user: number; agent: number }> | null;
  /** Dims and calms the ring without unmounting it. */
  idle?: boolean;
}

/**
 * How much to amplify incoming RMS before it drives anything.
 *
 * `pcm16Rms` returns true RMS, and conversational speech measures roughly
 * 0.03–0.25 there — it reaches 1.0 only on a clipped signal. Feeding that
 * straight in means the ring spends the whole call in the bottom fifth of its
 * range, which reads as "barely responds" no matter how large the multipliers
 * downstream are. The gain maps ordinary speech onto most of 0..1, and the
 * exponent below 1 lifts quiet passages further than loud ones so the ring
 * still moves for a softly-spoken caller.
 */
const INPUT_GAIN = 3.4;
const INPUT_CURVE = 0.62;

/**
 * Asymmetric smoothing — the single thing that makes a meter feel alive.
 *
 * Rising fast means a syllable registers on the frame it arrives. Falling slow
 * means the ring glides down through the gaps between words instead of
 * strobing on every pause. Symmetric smoothing has to choose one or the other:
 * quick enough to feel responsive is quick enough to flicker.
 */
const ATTACK = 0.5;
const RELEASE = 0.075;

/**
 * The waves that make up the outline.
 *
 * Not harmonics of one another, and drifting at rates with no common multiple,
 * so the shape never visibly loops. `reactive` is extra amplitude that only
 * appears with the voice: at rest the ring is a slow smooth wobble, and loud
 * speech adds the tighter, spikier detail.
 */
const WAVES = [
  { lobes: 3, amplitude: 0.055, reactive: 0.1, drift: 0.00045 },
  { lobes: 5, amplitude: 0.03, reactive: 0.075, drift: -0.00068 },
  { lobes: 7, amplitude: 0.016, reactive: 0.055, drift: 0.00095 },
  // Silent at rest. This is the one that makes a shout look different from
  // a murmur rather than just bigger.
  { lobes: 11, amplitude: 0.0, reactive: 0.042, drift: -0.0016 },
];

/** Enough points that the outline reads as a curve at any size we render. */
const POINTS = 180;

export function VoiceRing({ size, level = null, idle = false }: VoiceRingProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Match the device's pixel density, or the glow renders visibly stepped.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    const centre = size / 2;
    // Leaves room for the bloom, which extends well past the stroke.
    const baseRadius = size * 0.32;
    const stroke = Math.max(1.5, size * 0.034);

    let raf = 0;
    let smoothed = 0;
    let spin = 0;
    // Each wave carries its own accumulated phase rather than being computed
    // from absolute time, because the drift RATE changes with energy — driving
    // it from `time * rate` would make the shape jump whenever speed changed.
    const phases = WAVES.map(() => 0);

    function outline(radius: number, energy: number): void {
      if (!ctx) return;
      ctx.beginPath();
      for (let i = 0; i <= POINTS; i += 1) {
        const angle = (i / POINTS) * Math.PI * 2;
        let offset = 0;
        for (let w = 0; w < WAVES.length; w += 1) {
          const wave = WAVES[w];
          const amplitude = wave.amplitude + wave.reactive * energy;
          offset += Math.sin(angle * wave.lobes + phases[w]) * amplitude;
        }
        const r = radius * (1 + offset);
        const x = centre + Math.cos(angle + spin) * r;
        const y = centre + Math.sin(angle + spin) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
    }

    function draw(delta: number): void {
      if (!ctx) return;

      const current = level?.current;
      const raw = current ? Math.max(current.user, current.agent) : 0;
      // Amplify, curve, clamp — see INPUT_GAIN.
      const target = idle ? 0 : Math.min(1, Math.pow(Math.max(raw, 0) * INPUT_GAIN, INPUT_CURVE));
      smoothed += (target - smoothed) * (target > smoothed ? ATTACK : RELEASE);
      const energy = smoothed;

      // Everything speeds up with the voice: the waves travel further per
      // frame and the whole ring turns faster. Motion rate reads as urgency in
      // a way that amplitude alone does not.
      for (let w = 0; w < WAVES.length; w += 1) {
        phases[w] += WAVES[w].drift * delta * (1 + energy * 3.2);
      }
      spin += 0.00012 * delta * (1 + energy * 5);

      ctx.clearRect(0, 0, size, size);

      const radius = baseRadius * (1 + energy * 0.14);

      // Deep enough to survive a white card. The reference art glows on black,
      // where a pale cyan reads as emitted light; on white the same colour just
      // reads as washed out, so the mid and end stops carry real saturation and
      // only the leading stop stays bright.
      const gradient = ctx.createLinearGradient(0, 0, size, size);
      gradient.addColorStop(0, "#4ad9f0");
      gradient.addColorStop(0.45, "#1f8ae8");
      gradient.addColorStop(1, "#1546b8");

      ctx.lineJoin = "round";
      ctx.lineCap = "round";

      // Three passes, widest and faintest first: the bloom is light scattering
      // outward from a bright core, which one stroke with a large shadowBlur
      // cannot express — it reads flat.
      //
      // The balance matters more than the values. Too much weight in the wide
      // pass and the ring turns into a haze with no edge; the core pass is what
      // gives it a definite shape, so it stays fully opaque and reasonably
      // thick while the outer passes stay restrained.
      const passes = [
        { width: stroke * (2.9 + energy * 2.2), alpha: 0.09 + energy * 0.1, blur: size * 0.15 },
        { width: stroke * (1.6 + energy * 0.7), alpha: 0.26 + energy * 0.16, blur: size * 0.08 },
        { width: stroke * 1.15, alpha: 1, blur: size * 0.035 },
      ];

      const dim = idle ? 0.55 : 1;
      for (const pass of passes) {
        ctx.globalAlpha = Math.min(1, pass.alpha) * dim;
        ctx.lineWidth = pass.width;
        ctx.strokeStyle = gradient;
        ctx.shadowBlur = pass.blur * (1 + energy * 1.4);
        // Saturated rather than pale: a near-white shadow is what bleached the
        // whole ring against a light card.
        ctx.shadowColor = "rgba(30, 130, 230, 0.85)";
        outline(radius, energy);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    }

    if (reduced) {
      // One static frame: the ring still says "assistant", it just does not move.
      draw(0);
      return;
    }

    let previous = performance.now();
    const tick = (now: number) => {
      // Advance by elapsed time, not frame count, so the motion runs at the
      // same speed on a 60Hz and a 120Hz display. Capped so a backgrounded tab
      // does not resume with one enormous jump.
      const delta = Math.min(now - previous, 50);
      previous = now;
      draw(delta);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [size, level, idle]);

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      style={{ width: size, height: size, display: "block" }}
      aria-hidden
    />
  );
}
