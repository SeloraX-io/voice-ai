/**
 * Gap-free streaming playback for the agent's voice.
 *
 * Chunks arrive from Gemini as raw PCM16 @ 24 kHz and are scheduled back to
 * back on a single AudioContext timeline, so consecutive buffers are
 * sample-accurate with no clicks and no HTMLAudioElement churn. Only a tiny
 * lead-in is buffered, which keeps time-to-first-audio close to the network
 * round trip.
 */

import { createAudioContext } from "./audio-worklet";
import { remainingPlayoutMs } from "./playout";
import { OUTPUT_SAMPLE_RATE } from "@/types/voice";

/**
 * Scheduling lead. Enough to survive jitter between WebSocket frames, small
 * enough that barge-in never has more than this much audio committed to the
 * hardware.
 */
const SCHEDULE_LEAD_SECONDS = 0.08;

/** How long the ducked (barge-in suspected) gain ramp takes. */
const DUCK_RAMP_SECONDS = 0.05;

const END_POLL_MS = 60;

/**
 * Where the agent's voice goes. `"speakers"` is the operator preview;
 * `"stream"` routes into a `MediaStreamAudioDestinationNode` so the audio can
 * be handed to a SIP call as its outgoing track instead.
 */
export type PlayerOutput = "speakers" | "stream";

export interface AudioPlayerHandlers {
  /** First scheduled sample is about to reach the speakers. */
  onFirstPlayback?: (latencyToSpeakerMs: number) => void;
  onStarted?: () => void;
  onStopped?: (playedMs: number) => void;
}

export class StreamingAudioPlayer {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserBuffer: Float32Array<ArrayBuffer> | null = null;
  private streamDestination: MediaStreamAudioDestinationNode | null = null;

  private readonly sources = new Set<AudioBufferSourceNode>();
  private nextStartTime = 0;
  private playing = false;
  private startedAt = 0;
  private firstPlaybackTimer: ReturnType<typeof setTimeout> | null = null;
  private endPollTimer: ReturnType<typeof setInterval> | null = null;
  /** Incremented on clear() so late timers from a cancelled turn are ignored. */
  private generation = 0;

  constructor(private readonly handlers: AudioPlayerHandlers = {}) {}

  get isPlaying(): boolean {
    return this.playing;
  }

  /** Seconds of audio already scheduled but not yet played. */
  get bufferedSeconds(): number {
    if (!this.context) return 0;
    return Math.max(0, this.nextStartTime - this.context.currentTime);
  }

  /** The agent's voice as a MediaStream, when started in `"stream"` mode. */
  get outputStream(): MediaStream | null {
    return this.streamDestination?.stream ?? null;
  }

  /** Milliseconds of audio still scheduled ahead of the current playhead. */
  get remainingPlayoutMs(): number {
    const context = this.context;
    if (!context) return 0;
    return remainingPlayoutMs(this.nextStartTime, context.currentTime);
  }

  /**
   * Must be called from a user gesture so the AudioContext starts unsuspended.
   */
  async start(output: PlayerOutput = "speakers"): Promise<void> {
    if (this.context) {
      if (this.context.state === "suspended") await this.context.resume();
      return;
    }

    const context = createAudioContext(OUTPUT_SAMPLE_RATE);
    const master = context.createGain();
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;

    master.connect(analyser);

    if (output === "stream") {
      // A phone call takes the audio as a track, not through the speakers. The
      // node emits digital silence when idle, which WebRTC encodes happily —
      // there is no gap-in-the-stream failure mode here.
      this.streamDestination = context.createMediaStreamDestination();
      analyser.connect(this.streamDestination);
    } else {
      analyser.connect(context.destination);
    }

    if (context.state === "suspended") await context.resume();

    this.context = context;
    this.master = master;
    this.analyser = analyser;
    this.analyserBuffer = new Float32Array(analyser.fftSize);
    this.nextStartTime = context.currentTime;
  }

  /** Schedules one chunk. Safe to call before `start()` resolves — it no-ops. */
  enqueue(pcm: Int16Array): void {
    const context = this.context;
    const master = this.master;
    if (!context || !master || pcm.length === 0) return;

    const buffer = context.createBuffer(1, pcm.length, OUTPUT_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(master);

    const now = context.currentTime;
    const wasIdle = !this.playing;
    if (wasIdle || this.nextStartTime < now + SCHEDULE_LEAD_SECONDS) {
      this.nextStartTime = now + SCHEDULE_LEAD_SECONDS;
    }

    const startAt = this.nextStartTime;
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;

    this.sources.add(source);
    source.onended = () => {
      source.disconnect();
      this.sources.delete(source);
    };

    if (wasIdle) {
      this.playing = true;
      this.startedAt = startAt;
      this.unduck();
      this.scheduleFirstPlaybackCallback(startAt - now);
      this.watchForEnd();
      this.handlers.onStarted?.();
    }
  }

  /**
   * Barge-in: drop everything that has been scheduled but not yet heard.
   * Audio already inside the hardware buffer (< ~80 ms) still plays out.
   */
  clear(): void {
    this.generation++;
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already finished — nothing to cancel.
      }
      source.disconnect();
    }
    this.sources.clear();

    if (this.context) this.nextStartTime = this.context.currentTime;
    this.cancelTimers();
    this.unduck();

    if (this.playing) {
      this.playing = false;
      this.handlers.onStopped?.(this.playedMs());
    }
  }

  /**
   * Softens the agent while a possible interruption is being confirmed. Cheap,
   * instantly reversible, and makes barge-in feel immediate even though the
   * authoritative stop comes from Gemini a moment later.
   */
  duck(): void {
    if (!this.master || !this.context) return;
    const gain = this.master.gain;
    gain.cancelScheduledValues(this.context.currentTime);
    gain.setTargetAtTime(0.12, this.context.currentTime, DUCK_RAMP_SECONDS);
  }

  unduck(): void {
    if (!this.master || !this.context) return;
    const gain = this.master.gain;
    gain.cancelScheduledValues(this.context.currentTime);
    gain.setTargetAtTime(1, this.context.currentTime, DUCK_RAMP_SECONDS);
  }

  /** Instantaneous RMS of what is currently leaving the speakers (0..1). */
  getOutputLevel(): number {
    const analyser = this.analyser;
    const buffer = this.analyserBuffer;
    if (!analyser || !buffer || !this.playing) return 0;

    analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
    return Math.sqrt(sum / buffer.length);
  }

  async stop(): Promise<void> {
    this.clear();
    this.analyser?.disconnect();
    this.master?.disconnect();
    this.analyser = null;
    this.master = null;
    this.analyserBuffer = null;
    this.streamDestination = null;

    if (this.context && this.context.state !== "closed") {
      await this.context.close().catch(() => undefined);
    }
    this.context = null;
  }

  private playedMs(): number {
    if (!this.context) return 0;
    return Math.max(0, (this.context.currentTime - this.startedAt) * 1000);
  }

  private scheduleFirstPlaybackCallback(delaySeconds: number): void {
    const handler = this.handlers.onFirstPlayback;
    if (!handler || !this.context) return;

    // outputLatency accounts for the OS/hardware buffer between the audio
    // graph and the actual speaker, so the number reported is honest.
    const context = this.context;
    const hardwareLatency = context.outputLatency || context.baseLatency || 0;
    const generation = this.generation;

    this.firstPlaybackTimer = setTimeout(
      () => {
        this.firstPlaybackTimer = null;
        if (generation === this.generation) handler(hardwareLatency * 1000);
      },
      Math.max(0, (delaySeconds + hardwareLatency) * 1000),
    );
  }

  private watchForEnd(): void {
    if (this.endPollTimer) return;
    this.endPollTimer = setInterval(() => {
      const context = this.context;
      if (!context) return;
      if (this.sources.size === 0 && context.currentTime >= this.nextStartTime) {
        const played = this.playedMs();
        this.cancelTimers();
        this.playing = false;
        this.handlers.onStopped?.(played);
      }
    }, END_POLL_MS);
  }

  private cancelTimers(): void {
    if (this.firstPlaybackTimer !== null) {
      clearTimeout(this.firstPlaybackTimer);
      this.firstPlaybackTimer = null;
    }
    if (this.endPollTimer !== null) {
      clearInterval(this.endPollTimer);
      this.endPollTimer = null;
    }
  }
}
