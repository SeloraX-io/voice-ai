/**
 * Continuous microphone capture.
 *
 * Microphone -> MediaStreamSource -> AudioWorklet -> Int16 PCM chunks.
 * Chunks are emitted every ~30 ms and handed straight to the WebSocket; nothing
 * is accumulated here.
 */

import {
  createAudioContext,
  loadRecorderWorklet,
  RECORDER_PROCESSOR_NAME,
  type RecorderChunkMessage,
  type RecorderProcessorOptions,
} from "./audio-worklet";
import { INPUT_SAMPLE_RATE, MIC_CHUNK_MS } from "@/types/voice";

export type MicrophoneErrorKind =
  | "permission_denied"
  | "no_device"
  | "device_busy"
  | "unsupported"
  | "unknown";

export class MicrophoneError extends Error {
  readonly kind: MicrophoneErrorKind;

  constructor(kind: MicrophoneErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MicrophoneError";
    this.kind = kind;
  }
}

function toMicrophoneError(cause: unknown): MicrophoneError {
  if (cause instanceof MicrophoneError) return cause;

  const name = cause instanceof DOMException ? cause.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return new MicrophoneError(
        "permission_denied",
        "Microphone access was blocked. Allow the microphone in your browser and try again.",
        { cause },
      );
    case "NotFoundError":
    case "OverconstrainedError":
      return new MicrophoneError("no_device", "No microphone was found on this device.", {
        cause,
      });
    case "NotReadableError":
    case "AbortError":
      return new MicrophoneError(
        "device_busy",
        "The microphone is already in use by another application.",
        { cause },
      );
    default:
      return new MicrophoneError(
        "unknown",
        cause instanceof Error ? cause.message : "Could not start the microphone.",
        { cause },
      );
  }
}

export interface MicrophoneCaptureHandlers {
  /** Called ~33x/second with a fresh PCM16 chunk at 16 kHz. */
  onChunk: (pcm: Int16Array) => void;
  /** Called with the RMS level (0..1) of every chunk, for the live waveform. */
  onLevel: (level: number) => void;
  onError: (error: MicrophoneError) => void;
}

export class MicrophoneCapture {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private muted = false;
  private running = false;

  constructor(private readonly handlers: MicrophoneCaptureHandlers) {}

  get isRunning(): boolean {
    return this.running;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Effective capture rate — 16 kHz unless the browser forced another rate. */
  get sampleRate(): number {
    return this.context?.sampleRate ?? INPUT_SAMPLE_RATE;
  }

  async start(): Promise<void> {
    if (this.running) return;

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new MicrophoneError(
          "unsupported",
          "This browser does not support microphone capture. Try Chrome, Edge or Safari over HTTPS.",
        );
      }

      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          // Echo cancellation is what makes barge-in usable on speakers: it
          // keeps the agent's own voice out of the captured stream.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

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
        this.handlers.onError(
          new MicrophoneError("unknown", "The audio capture worklet stopped unexpectedly."),
        );
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
    } catch (cause) {
      await this.stop();
      throw toMicrophoneError(cause);
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    for (const track of this.stream?.getAudioTracks() ?? []) {
      track.enabled = !muted;
    }
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

    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;

    if (this.context && this.context.state !== "closed") {
      await this.context.close().catch(() => undefined);
    }
    this.context = null;
    this.muted = false;
  }
}
