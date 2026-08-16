/**
 * Browser side of the voice protocol.
 *
 * One WebSocket is opened when the call starts and stays open until the user
 * hangs up — audio chunks flow over it continuously, never as HTTP requests.
 */

import { pcm16ToBase64 } from "@/lib/audio/pcm";
import {
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from "@/types/voice";

const PING_INTERVAL_MS = 3000;
const CONNECT_TIMEOUT_MS = 10000;

export interface VoiceClientHandlers {
  onMessage: (message: ServerMessage) => void;
  /** Socket closed, either by us or by the gateway. */
  onClose: (info: { code: number; reason: string; clean: boolean }) => void;
  onError: (error: Error) => void;
}

export class VoiceClient {
  private socket: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closing = false;

  constructor(
    private readonly url: string,
    private readonly handlers: VoiceClientHandlers,
  ) {}

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Resolves with the handshake duration in milliseconds. */
  connect(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const startedAt = performance.now();
      let settled = false;

      let socket: WebSocket;
      try {
        socket = new WebSocket(this.url);
      } catch (cause) {
        reject(new Error(`Could not open a connection to the voice gateway at ${this.url}.`, { cause }));
        return;
      }

      socket.binaryType = "arraybuffer";
      this.socket = socket;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.close();
        reject(new Error("Timed out connecting to the voice gateway. Is it running?"));
      }, CONNECT_TIMEOUT_MS);

      socket.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.startPinging();
        resolve(performance.now() - startedAt);
      };

      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        const message = parseServerMessage(event.data);
        if (!message) {
          if (process.env.NODE_ENV !== "production") {
            console.warn("[voice] discarded malformed gateway frame");
          }
          return;
        }
        this.handlers.onMessage(message);
      };

      socket.onerror = () => {
        const error = new Error(
          "The voice gateway connection failed. Make sure `npm run dev:gateway` is running.",
        );
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
          return;
        }
        this.handlers.onError(error);
      };

      socket.onclose = (event) => {
        clearTimeout(timeout);
        this.stopPinging();
        this.socket = null;
        const wasClosing = this.closing;
        this.closing = false;
        if (!settled) {
          settled = true;
          reject(new Error("The voice gateway closed the connection during setup."));
          return;
        }
        this.handlers.onClose({
          code: event.code,
          reason: event.reason,
          clean: wasClosing || event.wasClean,
        });
      };
    });
  }

  sendAudio(pcm: Int16Array): void {
    this.send({ type: "audio", data: pcm16ToBase64(pcm) });
  }

  sendText(text: string): void {
    this.send({ type: "text", text });
  }

  signalAudioStreamEnd(): void {
    this.send({ type: "audio_stream_end" });
  }

  /**
   * `timeToFirstAudioMs` is measured here, in the browser — the gateway cannot
   * see when audio actually reached the speakers — so the hang-up carries it
   * along for the call log.
   */
  close(timeToFirstAudioMs: number | null = null): void {
    this.closing = true;
    this.stopPinging();
    const socket = this.socket;
    if (!socket) return;
    if (socket.readyState === WebSocket.OPEN) {
      this.send({ type: "end", timeToFirstAudioMs });
      socket.close(1000, "client hangup");
    } else {
      socket.close();
    }
  }

  private send(message: ClientMessage): void {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message));
  }

  private startPinging(): void {
    this.stopPinging();
    this.pingTimer = setInterval(() => {
      this.send({ type: "ping", t: performance.now() });
    }, PING_INTERVAL_MS);
    this.send({ type: "ping", t: performance.now() });
  }

  private stopPinging(): void {
    if (this.pingTimer === null) return;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}

/**
 * Resolves the gateway URL. `NEXT_PUBLIC_VOICE_GATEWAY_URL` is a public
 * endpoint address, never a credential.
 *
 * When the gateway is running with `VOICE_GATEWAY_REQUIRE_KEY=1`, the console
 * has to present a key too. It goes in the query string because the browser's
 * `WebSocket` constructor cannot set an `Authorization` header, and it comes
 * from `NEXT_PUBLIC_VOICE_GATEWAY_KEY`, which — being NEXT_PUBLIC — is baked
 * into the bundle and readable by anyone who loads the console. Mint a key for
 * the console alone, and revoke it on its own when the time comes.
 */
export function resolveGatewayUrl(): string {
  const configured = process.env.NEXT_PUBLIC_VOICE_GATEWAY_URL;
  const base =
    configured ||
    (typeof window === "undefined"
      ? "ws://localhost:4000/voice"
      : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.hostname}:4000/voice`);

  const key = process.env.NEXT_PUBLIC_VOICE_GATEWAY_KEY;
  if (!key) return base;

  const url = new URL(base);
  url.searchParams.set("key", key);
  return url.toString();
}
