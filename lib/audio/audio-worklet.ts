/**
 * AudioWorklet loading helpers.
 *
 * `addModule` is idempotent per AudioContext but not free, so results are
 * memoised. Failures are surfaced as typed errors instead of raw DOMExceptions
 * so the UI can render something useful.
 */

export const RECORDER_WORKLET_URL = "/audio-worklet/recorder-processor.js";
export const RECORDER_PROCESSOR_NAME = "recorder-processor";

export interface RecorderProcessorOptions {
  targetSampleRate: number;
  chunkMs: number;
}

/** Message posted by the recorder worklet for every completed chunk. */
export interface RecorderChunkMessage {
  pcm: ArrayBuffer;
  rms: number;
}

const loaded = new WeakMap<BaseAudioContext, Promise<void>>();

export async function loadRecorderWorklet(context: BaseAudioContext): Promise<void> {
  const existing = loaded.get(context);
  if (existing) return existing;

  const pending = context.audioWorklet
    .addModule(RECORDER_WORKLET_URL)
    .catch((cause: unknown) => {
      loaded.delete(context);
      throw new Error(
        `Failed to load the audio worklet from ${RECORDER_WORKLET_URL}. ` +
          "Audio capture is unavailable in this browser.",
        { cause },
      );
    });

  loaded.set(context, pending);
  return pending;
}

/**
 * Creates an AudioContext, preferring the exact sample rate so no resampling is
 * needed. Browsers that refuse the requested rate fall back to the device rate
 * and the worklet resamples instead.
 */
export function createAudioContext(sampleRate: number): AudioContext {
  const Ctor =
    typeof window !== "undefined"
      ? window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      : undefined;

  if (!Ctor) {
    throw new Error("The Web Audio API is not available in this browser.");
  }

  try {
    return new Ctor({ sampleRate, latencyHint: "interactive" });
  } catch {
    return new Ctor({ latencyHint: "interactive" });
  }
}
