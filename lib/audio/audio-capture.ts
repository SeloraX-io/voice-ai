/**
 * Turns any MediaStream into PCM16 chunks at 16 kHz.
 *
 * Split out of MicrophoneCapture so the same pipeline serves both a microphone
 * and the remote track of a phone call — the only difference between the two
 * is where the stream comes from.
 *
 * AudioCapture does not own the tracks in the stream it is given: it never
 * calls getUserMedia and its stop() never calls track.stop(). Releasing
 * tracks is the caller's responsibility (see MicrophoneCapture.stop()).
 */

import {
  createAudioContext,
  loadRecorderWorklet,
  RECORDER_PROCESSOR_NAME,
  type RecorderChunkMessage,
  type RecorderProcessorOptions,
} from "./audio-worklet";
import { INPUT_SAMPLE_RATE, MIC_CHUNK_MS } from "@/types/voice";

export interface AudioCaptureHandlers {
  /** Called ~33x/second with a fresh PCM16 chunk at 16 kHz. */
  onChunk: (pcm: Int16Array) => void;
  /** Called with the RMS level (0..1) of every chunk, for the live waveform. */
  onLevel: (level: number) => void;
  onError: (error: Error) => void;
}

export class AudioCapture {
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private stream: MediaStream | null = null;
  private muted = false;
  private running = false;

  constructor(private readonly handlers: AudioCaptureHandlers) {}

  get isRunning(): boolean {
    return this.running;
  }

  /** Effective capture rate — 16 kHz unless the browser forced another rate. */
  get sampleRate(): number {
    return this.context?.sampleRate ?? INPUT_SAMPLE_RATE;
  }

  async start(stream: MediaStream): Promise<void> {
    if (this.running) return;

    this.stream = stream;
    this.context = createAudioContext(INPUT_SAMPLE_RATE);
    if (this.context.state === "suspended") await this.context.resume();
    await loadRecorderWorklet(this.context);

    const processorOptions: RecorderProcessorOptions = {
      targetSampleRate: INPUT_SAMPLE_RATE,
      chunkMs: MIC_CHUNK_MS,
    };

    this.worklet = new AudioWorkletNode(this.context, RECORDER_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions,
    });

    this.worklet.port.onmessage = (event: MessageEvent<RecorderChunkMessage>) => {
      const { pcm, rms } = event.data;
      if (this.muted) {
        this.handlers.onLevel(0);
        return;
      }
      this.handlers.onLevel(rms);
      this.handlers.onChunk(new Int16Array(pcm));
    };

    this.worklet.onprocessorerror = () => {
      this.handlers.onError(new Error("The audio capture worklet stopped unexpectedly."));
    };

    this.source = this.context.createMediaStreamSource(this.stream);
    // Silent sink: keeps the worklet inside the rendering graph without
    // routing the microphone back to the speakers.
    this.sink = this.context.createGain();
    this.sink.gain.value = 0;

    this.source.connect(this.worklet);
    this.worklet.connect(this.sink);
    this.sink.connect(this.context.destination);

    this.running = true;
  }

  /**
   * A renegotiated or late-arriving remote track — after a transfer or a hold
   * resume — is not in the snapshot taken at answer time. The dashboard hit
   * exactly this as an "agent can't hear the customer" bug
   * (SeloraX-dashboard/contexts/CallContext.js:809), so handle it here too.
   */
  addTrack(track: MediaStreamTrack): void {
    if (!this.stream || !this.context || !this.source) return;
    this.stream.addTrack(track);
    // Rebuild the source node: a MediaStreamAudioSourceNode is bound to the
    // track set it was created with and does not pick up additions.
    this.source.disconnect();
    this.source = this.context.createMediaStreamSource(this.stream);
    if (this.worklet) this.source.connect(this.worklet);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.handlers.onLevel(0);
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.worklet) {
      this.worklet.port.onmessage = null;
      this.worklet.onprocessorerror = null;
      this.worklet.port.postMessage({ type: "close" });
      this.worklet.disconnect();
      this.worklet = null;
    }
    this.source?.disconnect();
    this.source = null;
    this.sink?.disconnect();
    this.sink = null;

    // AudioCapture does not own the stream's tracks — it never called
    // getUserMedia, so it must not stop them. The caller (e.g.
    // MicrophoneCapture, or whoever owns the remote WebRTC track) does that.
    this.stream = null;

    if (this.context && this.context.state !== "closed") {
      await this.context.close().catch(() => undefined);
    }
    this.context = null;
    this.muted = false;
  }
}
