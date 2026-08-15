/**
 * Energy-gate voice activity detection.
 *
 * This exists purely to drive UI state (`user_started_speaking` /
 * `user_stopped_speaking`) and the optimistic duck used for barge-in. The
 * authoritative turn-taking and interruption decisions come from Gemini's own
 * server-side VAD, so this stays deliberately simple: RMS threshold, a short
 * onset debounce and a hangover window.
 */

export interface VadOptions {
  /** RMS (0..1) above which a frame counts as speech. */
  threshold?: number;
  /** Speech must persist this long before onset is reported. */
  onsetMs?: number;
  /** Silence must persist this long before offset is reported. */
  hangoverMs?: number;
}

export interface VadTransition {
  type: "start" | "end";
  /**
   * How long ago the transition actually happened. Both edges are debounced,
   * so the event fires later than the acoustic boundary; reporting the offset
   * keeps latency measurements honest instead of billing the debounce to the
   * model.
   */
  msAgo: number;
}

export class EnergyVad {
  private readonly threshold: number;
  private readonly onsetMs: number;
  private readonly hangoverMs: number;

  private speaking = false;
  private voicedMs = 0;
  private silentMs = 0;

  constructor(options: VadOptions = {}) {
    this.threshold = options.threshold ?? 0.02;
    this.onsetMs = options.onsetMs ?? 90;
    // Kept just above Gemini's own `silenceDurationMs` so the UI flips to
    // "thinking" at roughly the moment the model starts generating.
    this.hangoverMs = options.hangoverMs ?? 420;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** Feeds one frame; returns a transition when the state flips. */
  push(rms: number, durationMs: number): VadTransition | null {
    const voiced = rms >= this.threshold;

    if (voiced) {
      this.silentMs = 0;
      this.voicedMs += durationMs;
      if (!this.speaking && this.voicedMs >= this.onsetMs) {
        const msAgo = this.voicedMs;
        this.speaking = true;
        this.voicedMs = 0;
        return { type: "start", msAgo };
      }
      return null;
    }

    this.voicedMs = 0;
    this.silentMs += durationMs;
    if (this.speaking && this.silentMs >= this.hangoverMs) {
      const msAgo = this.silentMs;
      this.speaking = false;
      return { type: "end", msAgo };
    }
    return null;
  }

  reset(): void {
    this.speaking = false;
    this.voicedMs = 0;
    this.silentMs = 0;
  }
}
