/**
 * JsSIP, wrapped so the page never touches it directly.
 *
 * Deliberately small: registration, one inbound call at a time, answer with a
 * caller-supplied MediaStream, terminate. Everything about *when* to do these
 * things lives in bridge-state.ts, which is testable; this file is the hands.
 *
 * JsSIP is browser-only — it reads `window` while its module body evaluates —
 * so it is never imported at the top level. The `await import("jssip")` inside
 * `goOnline()` is what keeps this module safe to pull into a file that Next
 * renders on the server. Only the type imports below are static, and those are
 * erased at compile time.
 */

import type { RTCSession } from "jssip/lib/RTCSession";
import type { RTCSessionEvent, UA } from "jssip/lib/UA";

import type { SipCredentials } from "./credentials";

export interface SipBridgeHandlers {
  onRegistered(): void;
  onRegistrationFailed(message: string): void;
  onIncoming(info: { from: string | null; to: string | null }): void;
  /** The first remote audio track, wrapped in a stream ready for AudioCapture. */
  onAnswered(remoteStream: MediaStream): void;
  /** A remote track that arrived after the first one — renegotiation, hold resume. */
  onRemoteTrack(track: MediaStreamTrack): void;
  onEnded(): void;
  /** Non-fatal transport trouble, for display only. JsSIP reconnects itself. */
  onNotice(message: string): void;
}

/** Status returned to Asterisk when the bridge cannot take a call. */
const UNAVAILABLE_STATUS = 480;
/** Status returned when a second INVITE arrives while one call is live. */
const BUSY_STATUS = 486;

/**
 * `Originator` and `SessionDirection` are `declare enum`s in JsSIP's typings,
 * so comparing them to string literals is a type error and importing them as
 * values would drag the browser-only module into this file statically. Their
 * runtime values are plain strings, so widening is both correct and cheap.
 */
function asString(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

export interface SipLineOptions {
  /**
   * STUN/TURN servers for the call's peer connection. Claimed once per online
   * session and reused by every call, because the upstream that issues them
   * rate-limits and re-claims the device on each request.
   */
  iceServers?: RTCIceServer[];
}

export class SipBridge {
  private ua: UA | null = null;
  private session: RTCSession | null = null;
  /**
   * Held from `goOnline` until `goOffline`, and read by every `answer()`.
   *
   * Null means "let JsSIP decide", which is `{ iceServers: [] }` — host
   * candidates only (jssip/lib/RTCSession.js:381). That is the pre-TURN
   * behaviour and is kept deliberately: a call that only works on a flat
   * network beats refusing to answer the phone at all.
   */
  private pcConfig: RTCConfiguration | null = null;
  private peerConnection: RTCPeerConnection | null = null;
  /** Built from the first remote audio track; later tracks are added to it. */
  private remoteStream: MediaStream | null = null;
  /** `ended`, `failed` and the ICE watchdog can all fire for one call. The shell sees one. */
  private endedEmitted = false;

  constructor(private readonly handlers: SipBridgeHandlers) {}

  get hasSession(): boolean {
    return this.session !== null;
  }

  async goOnline(creds: SipCredentials, options: SipLineOptions = {}): Promise<void> {
    if (this.ua) return;

    // An empty list is not the same as no list: `{ iceServers: [] }` and the
    // absence of a config both mean host candidates only, so either way the
    // sensible thing is to leave it unset and say so upstream.
    const iceServers = options.iceServers ?? [];
    this.pcConfig = iceServers.length > 0 ? { iceServers } : null;

    // jssip is published as CommonJS. Bundlers expose `module.exports` as the
    // synthetic `default`, and may or may not also hoist its keys onto the
    // namespace — two of them are getters. Preferring `default` works either
    // way, and the fallback covers a bundler that gives a real namespace.
    const imported = await import("jssip");
    const JsSIP = imported.default ?? imported;

    const socket = new JsSIP.WebSocketInterface(creds.wsUrl);
    const ua = new JsSIP.UA({
      sockets: [socket],
      uri: creds.sipUri,
      password: creds.password,
      realm: creds.sipDomain,
      register: true,
      // Session timers add periodic re-INVITEs that buy us nothing here and
      // are one more renegotiation that could disturb the media path.
      session_timers: false,
    });

    ua.on("registered", () => this.handlers.onRegistered());

    ua.on("registrationFailed", (event) => {
      const cause = event.cause ? asString(event.cause) : "";
      this.handlers.onRegistrationFailed(
        cause.length > 0
          ? `SIP registration was refused (${cause}).`
          : "SIP registration was refused.",
      );
    });

    // The transport dropping is not the same as being unregistered: JsSIP
    // reconnects and re-registers on its own, so this is a notice rather than
    // a state change.
    ua.on("disconnected", (event) => {
      if (!event.error) return;
      this.handlers.onNotice(
        event.reason
          ? `Lost the connection to the SIP server (${event.reason}). Retrying.`
          : "Lost the connection to the SIP server. Retrying.",
      );
    });

    ua.on("newRTCSession", (event: RTCSessionEvent) => this.handleNewSession(event));

    this.ua = ua;
    ua.start();
  }

  /**
   * Answer with our own audio. `mediaStream` makes JsSIP skip getUserMedia
   * entirely (jssip/lib/RTCSession.js:482) — this one option is the whole
   * reason this design works without touching the SIP server.
   *
   * `pcConfig` here is the only place the ICE servers can be applied. JsSIP
   * reads it from *these* options and passes it straight to the
   * `RTCPeerConnection` constructor (RTCSession.js:381 → :477 → :1364-1365);
   * `JsSIP.UA` has no `pcConfig` setting at all, and Config.load() copies only
   * parameters it knows (Config.js:256-273), so setting one there would be
   * silently dropped. The dashboard sets both (CallContext.js:608, :1296) —
   * only its per-session one does anything.
   */
  answer(mediaStream: MediaStream): void {
    this.session?.answer({
      mediaStream,
      // Undefined when no ICE servers were claimed, which is what JsSIP's own
      // default already is — see `pcConfig` above.
      ...(this.pcConfig ? { pcConfig: this.pcConfig } : {}),
      // audio MUST be true here. JsSIP strips tracks from the supplied stream
      // when the matching constraint is false (RTCSession.js:442-446), so
      // `audio: false` would delete the agent's own voice and the caller would
      // hear nothing. `video: false` is correct — it removes video tracks we
      // do not have.
      mediaConstraints: { audio: true, video: false },
      rtcAnswerConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false },
    });
  }

  /**
   * Decline a ringing call without answering it. Used when the gateway cannot
   * be reached: Asterisk then falls through to its normal no-answer handling,
   * which is a better outcome for the caller than silence on a live call.
   */
  reject(status: number = UNAVAILABLE_STATUS): void {
    this.endSession({ status_code: status });
  }

  /** Hang up the live call. Safe to call twice, and after the caller hung up. */
  terminate(): void {
    this.endSession({});
  }

  async goOffline(): Promise<void> {
    this.terminate();
    const ua = this.ua;
    this.ua = null;
    this.pcConfig = null;
    this.clearSession();
    if (!ua) return;
    try {
      // stop() unregisters, closes any remaining dialogs and shuts the socket.
      ua.stop();
    } catch {
      // Already stopped, or never started. Nothing left to do.
    }
  }

  /* ---------------------------------------------------------------------- */

  private endSession(options: { status_code?: number }): void {
    const session = this.session;
    if (!session || session.isEnded()) return;
    try {
      session.terminate(options);
    } catch {
      // JsSIP throws InvalidStateError if the session raced us to terminated.
      // That is exactly the outcome we wanted, so it is not an error here.
    }
  }

  private handleNewSession(event: RTCSessionEvent): void {
    // Outbound calls are out of scope; this bridge only answers.
    if (asString(event.originator) !== "remote") return;

    // One call at a time. A second INVITE is refused here rather than being
    // dropped silently, so the caller hears busy instead of ringing forever.
    if (this.session) {
      try {
        event.session.terminate({ status_code: BUSY_STATUS });
      } catch {
        // The far end gave up before we could refuse it.
      }
      return;
    }

    const session = event.session;
    this.session = session;
    this.endedEmitted = false;
    this.remoteStream = null;

    session.on("ended", () => this.finishSession());
    session.on("failed", () => this.finishSession());

    // Subscribed here rather than after answer(): JsSIP emits this while
    // building the peer connection inside answer(), so a later subscription
    // would miss it.
    session.on("peerconnection", ({ peerconnection }) => {
      this.attachPeerConnection(peerconnection);
    });

    // `accepted` fires when our 200 OK goes out and `confirmed` on the ACK.
    // The remote description — and therefore the receivers — exist by the
    // first of the two; collecting on both is harmless and covers either
    // ordering. Mirrors SeloraX-dashboard/contexts/CallContext.js:776.
    session.on("accepted", () => this.collectReceivers());
    session.on("confirmed", () => this.collectReceivers());

    this.handlers.onIncoming({
      from: identityOf(session, "remote"),
      to: identityOf(session, "local"),
    });
  }

  private attachPeerConnection(pc: RTCPeerConnection): void {
    if (this.peerConnection === pc) return;
    this.peerConnection = pc;
    // The late-arriving track. CallContext.js:809 exists because missing this
    // showed up as "the agent cannot hear the customer" after a renegotiation.
    pc.addEventListener("track", (trackEvent) => {
      this.offerTrack(trackEvent.track);
    });

    // Media death without a BYE. If ICE fails mid-call — a NAT rebinding, the
    // far end vanishing, a network change — SIP signalling is none the wiser:
    // no `ended`, no `failed`, and the gateway keeps its Gemini session open
    // and billing while the caller hears silence. These two events are the
    // only notice the browser gives.
    //
    // `disconnected` is deliberately not handled: it is the transient state
    // ICE enters on a few lost packets and recovers from on its own, so acting
    // on it would hang up on a caller who walked between two cell towers.
    const watchdog = () => {
      if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "closed") {
        this.handleMediaFailure(pc);
        return;
      }
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        this.handleMediaFailure(pc);
      }
    };
    pc.addEventListener("iceconnectionstatechange", watchdog);
    pc.addEventListener("connectionstatechange", watchdog);

    this.collectReceivers();
  }

  /**
   * The media path died. Send a BYE so the far end is released, then end the
   * call through the very same path a normal hang-up takes — teardown stays
   * single-pathed, and `finishSession` is idempotent, so it does not matter
   * whether `terminate()` already made JsSIP emit `ended` first.
   */
  private handleMediaFailure(pc: RTCPeerConnection): void {
    // A peer connection from a call that has already been cleared away. Its
    // states go to `closed` as it is torn down and mean nothing to the call
    // running now.
    if (this.peerConnection !== pc) return;
    this.terminate();
    this.finishSession();
  }

  /** Emits `onEnded` exactly once per call, however the call came to an end. */
  private finishSession(): void {
    if (this.endedEmitted) return;
    this.endedEmitted = true;
    this.clearSession();
    this.handlers.onEnded();
  }

  private collectReceivers(): void {
    const pc = this.peerConnection ?? this.session?.connection ?? null;
    if (!pc) return;
    if (this.peerConnection !== pc) {
      // Reached the peer connection through the session rather than through
      // the `peerconnection` event; subscribe first, then let it collect.
      this.attachPeerConnection(pc);
      return;
    }
    for (const receiver of pc.getReceivers()) {
      if (receiver.track) this.offerTrack(receiver.track);
    }
  }

  /**
   * Routes one remote track: the first audio track opens the capture stream,
   * anything after it is an addition to the stream already being captured.
   */
  private offerTrack(track: MediaStreamTrack): void {
    if (track.kind !== "audio") return;

    if (!this.remoteStream) {
      this.remoteStream = new MediaStream([track]);
      this.handlers.onAnswered(this.remoteStream);
      return;
    }

    // AudioCapture.addTrack() puts the track into this same stream, so
    // membership is what tells a genuinely new track from a repeat of one we
    // have already handed over.
    if (this.remoteStream.getTracks().includes(track)) return;
    this.handlers.onRemoteTrack(track);
  }

  private clearSession(): void {
    this.session = null;
    this.peerConnection = null;
    this.remoteStream = null;
  }
}

/**
 * The caller's number, or the number dialled. Prefers the user part of the SIP
 * URI — `sip:+8801711...@pbx` reads as a phone number, the full URI does not —
 * and falls back to the whole header when there is no user part.
 */
function identityOf(session: RTCSession, side: "remote" | "local"): string | null {
  try {
    const header = side === "remote" ? session.remote_identity : session.local_identity;
    const user = header?.uri?.user;
    if (typeof user === "string" && user.length > 0) return user;
    const text = header?.toString() ?? "";
    return text.length > 0 ? text : null;
  } catch {
    // A malformed From/To header must not stop the call being answered.
    return null;
  }
}
