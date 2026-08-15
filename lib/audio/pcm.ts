/**
 * PCM / base64 / WAV helpers. Pure functions, safe on both the browser and the
 * Node gateway (base64 conversion branches on the available primitive).
 */

const hasBuffer = typeof globalThis.Buffer !== "undefined";

/** Encodes signed 16-bit PCM as base64. */
export function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  if (hasBuffer) return globalThis.Buffer.from(bytes).toString("base64");

  // Chunked to stay well under the argument limit of String.fromCharCode.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Decodes base64 into signed 16-bit PCM. Odd trailing bytes are dropped. */
export function base64ToPcm16(base64: string): Int16Array {
  let bytes: Uint8Array;
  if (hasBuffer) {
    const buf = globalThis.Buffer.from(base64, "base64");
    bytes = new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  } else {
    const binary = atob(base64);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  }
  const usable = bytes.byteLength - (bytes.byteLength % 2);
  return new Int16Array(bytes.buffer, 0, usable / 2);
}

/** Root-mean-square level of a PCM frame, normalised to 0..1. */
export function pcm16Rms(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const s = pcm[i] / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / pcm.length);
}

/**
 * Wraps raw PCM16 in a minimal RIFF/WAVE container so it can be handed to an
 * `<audio>` element or downloaded. Used by the Upload Audio pipeline, where
 * Gemini returns headerless `audio/L16`.
 */
export function pcm16ToWav(pcm: Uint8Array, sampleRate: number, channels = 1): Uint8Array {
  const blockAlign = channels * 2;
  const byteRate = sampleRate * blockAlign;
  const out = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(out.buffer);

  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);

  return out;
}

/** Reads the `rate=NNNN` parameter out of a Gemini `audio/L16;rate=24000` mime. */
export function sampleRateFromMimeType(mimeType: string, fallback = 24000): number {
  const match = /rate=(\d+)/i.exec(mimeType);
  if (!match) return fallback;
  const rate = Number.parseInt(match[1], 10);
  return Number.isFinite(rate) && rate > 0 ? rate : fallback;
}
