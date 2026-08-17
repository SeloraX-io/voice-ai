/**
 * Continuous microphone capture.
 *
 * Microphone -> MediaStreamSource -> AudioWorklet -> Int16 PCM chunks.
 * Chunks are emitted every ~30 ms and handed straight to the WebSocket; nothing
 * is accumulated here.
 *
 * The PCM pipeline itself lives in AudioCapture (lib/audio/audio-capture.ts)
 * so it can also be driven by a remote WebRTC track for phone calls.
 * MicrophoneCapture's job is narrower: acquire the mic via getUserMedia, map
 * its errors, and release the tracks it acquired — releasing the microphone
 * is this class's responsibility alone, since AudioCapture never owns the
 * tracks it's handed.
 */

import { AudioCapture, type AudioCaptureHandlers } from "./audio-capture";

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
  private readonly capture: AudioCapture;
  private stream: MediaStream | null = null;
  private muted = false;

  constructor(private readonly handlers: MicrophoneCaptureHandlers) {
    const captureHandlers: AudioCaptureHandlers = {
      onChunk: (pcm) => this.handlers.onChunk(pcm),
      onLevel: (level) => this.handlers.onLevel(level),
      onError: (error) => this.handlers.onError(toMicrophoneError(error)),
    };
    this.capture = new AudioCapture(captureHandlers);
  }

  get isRunning(): boolean {
    return this.capture.isRunning;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Effective capture rate — 16 kHz unless the browser forced another rate. */
  get sampleRate(): number {
    return this.capture.sampleRate;
  }

  async start(): Promise<void> {
    if (this.capture.isRunning) return;

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

      await this.capture.start(this.stream);
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
    this.capture.setMuted(muted);
  }

  async stop(): Promise<void> {
    await this.capture.stop();

    // AudioCapture does not own these tracks — it never called getUserMedia,
    // so releasing the microphone (and turning off the recording indicator)
    // is done here alone.
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.muted = false;
  }
}
