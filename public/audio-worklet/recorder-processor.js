/**
 * Microphone capture processor.
 *
 * Runs on the audio rendering thread, converts the incoming float32 mono stream
 * to 16-bit PCM at a fixed target rate (16 kHz for Gemini Live) and posts small
 * chunks (~30 ms) back to the main thread. Nothing is buffered beyond one chunk,
 * which is what keeps end-to-end latency low.
 *
 * `sampleRate` is a global provided by the AudioWorkletGlobalScope. When the
 * AudioContext was already created at the target rate the resampler collapses
 * into a straight copy.
 */
class RecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetSampleRate = opts.targetSampleRate || 16000;
    const chunkMs = opts.chunkMs || 30;

    this.chunkSamples = Math.max(
      1,
      Math.round((this.targetSampleRate * chunkMs) / 1000),
    );
    this.ratio = sampleRate / this.targetSampleRate;
    this.needsResample = Math.abs(this.ratio - 1) > 1e-6;

    this.chunk = new Int16Array(this.chunkSamples);
    this.filled = 0;
    /** Fractional read cursor carried across render quanta. */
    this.cursor = 0;
    this.closed = false;

    this.port.onmessage = (event) => {
      if (event.data && event.data.type === "close") this.closed = true;
    };
  }

  /** Appends one float sample, flushing to the main thread when full. */
  pushSample(value) {
    const clamped = value > 1 ? 1 : value < -1 ? -1 : value;
    this.chunk[this.filled++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;

    if (this.filled === this.chunkSamples) {
      let sumSquares = 0;
      for (let i = 0; i < this.chunkSamples; i++) {
        const s = this.chunk[i] / 32768;
        sumSquares += s * s;
      }
      const rms = Math.sqrt(sumSquares / this.chunkSamples);

      // Transfer the buffer so no copy happens on the audio thread.
      const out = this.chunk;
      this.chunk = new Int16Array(this.chunkSamples);
      this.filled = 0;
      this.port.postMessage({ pcm: out.buffer, rms }, [out.buffer]);
    }
  }

  process(inputs) {
    if (this.closed) return false;

    const input = inputs[0];
    const channel = input && input[0];
    if (!channel || channel.length === 0) return true;

    if (!this.needsResample) {
      for (let i = 0; i < channel.length; i++) this.pushSample(channel[i]);
      return true;
    }

    const n = channel.length;
    let pos = this.cursor;
    while (pos < n) {
      const i = pos | 0;
      const frac = pos - i;
      const a = channel[i];
      // Holding the last sample at the block edge costs one interpolated
      // sample per quantum; inaudible, and integer ratios never hit it.
      const b = i + 1 < n ? channel[i + 1] : a;
      this.pushSample(a + (b - a) * frac);
      pos += this.ratio;
    }
    this.cursor = pos - n;

    return true;
  }
}

registerProcessor("recorder-processor", RecorderProcessor);
