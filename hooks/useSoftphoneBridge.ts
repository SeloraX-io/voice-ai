"use client";

/**
 * The bridge shell: SIP on one side, the voice gateway on the other.
 *
 * Everything about *when* a transition is legal lives in `bridgeReducer`, which
 * is pure and tested. This hook is the wiring — it owns the four objects a call
 * needs (SIP session, capture, player, gateway socket), dispatches events into
 * the reducer, and reads `status` back out.
 *
 * Every state change here is driven by an event callback or an explicit user
 * action. Nothing derives state inside an effect: the React Compiler lint rule
 * `react-hooks/set-state-in-effect` forbids it, and the ordering rules between
 * SIP and gateway events are far easier to follow written as callbacks anyway.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import type { VoiceLevels } from "@/hooks/useVoiceSession";
import { AudioCapture } from "@/lib/audio/audio-capture";
import { StreamingAudioPlayer } from "@/lib/audio/audio-player";
import { base64ToPcm16 } from "@/lib/audio/pcm";
import type { ToolActivity } from "@/lib/call-logs/types";
import type { TranscriptEntry } from "@/lib/gemini/types";
import {
  bridgeReducer,
  INITIAL_BRIDGE_STATE,
  type BridgeState,
} from "@/lib/telephony/bridge-state";
import type { SipCredentials } from "@/lib/telephony/credentials";
import { SipBridge } from "@/lib/telephony/sip-bridge";
import { resolveGatewayUrl, VoiceClient } from "@/lib/websocket/voice-client";
import type { ServerMessage, Speaker } from "@/types/voice";

/**
 * Ceiling on the drain wait after the gateway closes. The player only ever has
 * a second or two queued, so this is a guard against a stuck AudioContext
 * holding the phone line open, not a normal wait.
 */
const MAX_DRAIN_MS = 5000;

export interface SoftphoneBridgeController {
  state: BridgeState;
  transcript: TranscriptEntry[];
  toolActivity: ToolActivity[];
  /** Who the gateway last reported speaking. Null between turns. */
  activeSpeaker: Speaker | null;
  /** The latest thing worth telling the operator. Not necessarily fatal. */
  notice: string | null;
  /**
   * Live RMS levels, mutated at audio rate — read from rAF, never rendered.
   * `user` is the caller, `agent` the AI, matching the shape `VoiceWaveform`
   * already draws so the bridge reuses the preview's meter unchanged.
   */
  levels: React.RefObject<VoiceLevels>;
  goOnline: (credentials: SipCredentials) => Promise<void>;
  goOffline: () => Promise<void>;
  clearTranscript: () => void;
}

let entrySeq = 0;
const nextEntryId = () => `bridge-entry-${++entrySeq}`;

function describe(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

/**
 * The gateway URL for a phone call, tagged so the resulting call record is
 * told apart from a browser preview.
 *
 * `from`/`to` are whatever the SIP INVITE carried — possibly absent, never
 * validated here. The gateway treats them as opaque, length-bounded strings,
 * so nothing beyond `URLSearchParams`'s own encoding happens to them.
 *
 * An absent number is omitted rather than sent as an empty value, and the two
 * are independent: a caller who withholds their number still tells us which of
 * our numbers was dialled, and the gateway records whichever of the pair it is
 * given.
 */
function phoneGatewayUrl(from: string | null, to: string | null): string {
  const url = new URL(resolveGatewayUrl());
  url.searchParams.set("channel", "phone");
  if (from !== null) url.searchParams.set("from", from);
  if (to !== null) url.searchParams.set("to", to);
  return url.toString();
}

export function useSoftphoneBridge(): SoftphoneBridgeController {
  const [state, dispatch] = useReducer(bridgeReducer, INITIAL_BRIDGE_STATE);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [toolActivity, setToolActivity] = useState<ToolActivity[]>([]);
  const [activeSpeaker, setActiveSpeaker] = useState<Speaker | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const levels = useRef<VoiceLevels>({ user: 0, agent: 0 });

  const sipRef = useRef<SipBridge | null>(null);
  const captureRef = useRef<AudioCapture | null>(null);
  const playerRef = useRef<StreamingAudioPlayer | null>(null);
  const clientRef = useRef<VoiceClient | null>(null);

  /**
   * Remote tracks that arrived before `AudioCapture.start()` resolved.
   * `addTrack()` is a no-op until then, so they would otherwise be lost and the
   * agent would not hear the caller.
   */
  const pendingTracksRef = useRef<MediaStreamTrack[]>([]);
  const captureReadyRef = useRef(false);

  const openEntriesRef = useRef<Record<Speaker, string | null>>({ user: null, assistant: null });
  const drainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);
  /** End of caller speech, so time-to-first-audio can be measured over the phone. */
  const turnRef = useRef<{ speechEndedAt: number | null; measured: boolean }>({
    speechEndedAt: null,
    measured: false,
  });
  const ttfaRef = useRef<number | null>(null);
  /** Guards `onIncoming` against a second INVITE racing the first one's setup. */
  const answeringRef = useRef(false);
  /** Bumped per call, so a deferred hang-up cannot land on the following one. */
  const callIdRef = useRef(0);

  /* ---------------------------------------------------------------------- */
  /* Transcript                                                             */
  /* ---------------------------------------------------------------------- */

  const appendTranscript = useCallback((speaker: Speaker, text: string) => {
    if (text.length === 0) return;
    setTranscript((entries) => {
      const openId = openEntriesRef.current[speaker];
      if (openId) {
        return entries.map((entry) =>
          entry.id === openId ? { ...entry, text: entry.text + text } : entry,
        );
      }
      const id = nextEntryId();
      openEntriesRef.current[speaker] = id;
      return [...entries, { id, speaker, text, at: Date.now(), final: false }];
    });
  }, []);

  const finaliseTranscript = useCallback((speaker?: Speaker) => {
    const speakers: Speaker[] = speaker ? [speaker] : ["user", "assistant"];
    const ids = speakers
      .map((s) => openEntriesRef.current[s])
      .filter((id): id is string => id !== null);
    for (const s of speakers) openEntriesRef.current[s] = null;
    if (ids.length === 0) return;
    setTranscript((entries) =>
      entries.map((entry) => (ids.includes(entry.id) ? { ...entry, final: true } : entry)),
    );
  }, []);

  const clearTranscript = useCallback(() => {
    openEntriesRef.current = { user: null, assistant: null };
    setTranscript([]);
    setToolActivity([]);
  }, []);

  /* ---------------------------------------------------------------------- */
  /* Per-call teardown                                                      */
  /* ---------------------------------------------------------------------- */

  /**
   * Releases everything one call owns. Idempotent: the SIP `ended` event and an
   * operator clicking Go offline can both reach it, in either order.
   */
  const teardownCall = useCallback(async () => {
    if (drainTimerRef.current !== null) {
      clearTimeout(drainTimerRef.current);
      drainTimerRef.current = null;
    }
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    const client = clientRef.current;
    clientRef.current = null;
    // Carries the one metric only the browser can measure, so the gateway can
    // put it on the call record.
    client?.close(ttfaRef.current);

    const capture = captureRef.current;
    captureRef.current = null;
    const player = playerRef.current;
    playerRef.current = null;

    // AudioCapture does not own the remote track and must not stop it; JsSIP
    // closes the peer connection, which is what releases it.
    await Promise.all([capture?.stop(), player?.stop()]);

    captureReadyRef.current = false;
    pendingTracksRef.current = [];
    openEntriesRef.current = { user: null, assistant: null };
    turnRef.current = { speechEndedAt: null, measured: false };
    ttfaRef.current = null;
    answeringRef.current = false;
    levels.current.user = 0;
    levels.current.agent = 0;
    setActiveSpeaker(null);
  }, []);

  /* ---------------------------------------------------------------------- */
  /* Gateway events                                                         */
  /* ---------------------------------------------------------------------- */

  const handleServerMessage = useCallback(
    (message: ServerMessage) => {
      const player = playerRef.current;

      switch (message.type) {
        case "session_started":
          // Nothing to do: the agent's greeting plays itself.
          return;

        case "audio":
          player?.enqueue(base64ToPcm16(message.data));
          return;

        case "interrupted":
          // Barge-in. Drop everything queued but not yet heard, so the caller
          // is not talking over a sentence the agent has already abandoned.
          player?.clear();
          finaliseTranscript("assistant");
          setActiveSpeaker("user");
          return;

        case "transcript":
          appendTranscript(message.speaker, message.text);
          return;

        case "turn_complete":
          finaliseTranscript();
          setActiveSpeaker(null);
          return;

        case "user_started_speaking":
          setActiveSpeaker("user");
          return;

        case "user_stopped_speaking":
          turnRef.current = {
            speechEndedAt: performance.now() - message.msAgo,
            measured: false,
          };
          return;

        case "assistant_started_speaking":
          setActiveSpeaker("assistant");
          return;

        case "assistant_stopped_speaking":
          // Generation finished; playback usually still has audio queued, so
          // the speaking indicator is cleared by `turn_complete` instead.
          return;

        case "tool_call":
          setToolActivity((current) => [
            ...current,
            {
              id: message.id,
              name: message.name,
              silent: message.silent,
              status: "running",
              durationMs: null,
            },
          ]);
          return;

        case "tool_result":
          setToolActivity((current) =>
            current.map((entry) =>
              entry.id === message.id
                ? { ...entry, status: message.ok ? "ok" : "failed", durationMs: message.durationMs }
                : entry,
            ),
          );
          return;

        case "agent_ending_call":
          // A notice, not the end. The closing line is still being generated
          // and then played; the call ends when the socket closes and the
          // player has drained.
          dispatch({ type: "agent_ending", reason: message.reason });
          return;

        case "error":
          setNotice(message.message);
          // A fatal error is followed by the gateway closing the socket, which
          // runs the normal drain-then-terminate path. Nothing extra to do.
          return;

        default:
          // `pong` and `usage_update` carry nothing the bridge acts on.
          return;
      }
    },
    [appendTranscript, finaliseTranscript],
  );

  /**
   * The gateway is done talking. Audio may still be scheduled in the player, so
   * the SIP call is held open until it has played out — hanging up immediately
   * cuts the agent off mid-goodbye, which is exactly what the agent's own
   * hang-up path must not do.
   *
   * Takes the socket that closed, because this callback is shared by every
   * call's `VoiceClient` and a close arrives 10–100 ms after `close()` is
   * called. That is long enough for the next call to have opened its own
   * socket, and acting on the dead one's close would null the live client
   * (the agent then hears nothing and its Gemini session is never released)
   * and drag the new call into `ending`. `callIdRef` guards only the timer,
   * not the body — the identity check has to be the first thing here.
   */
  const handleGatewayClose = useCallback((client: VoiceClient) => {
    if (clientRef.current !== client) return;
    clientRef.current = null;
    dispatch({ type: "gateway_closed" });

    const remaining = playerRef.current?.remainingPlayoutMs ?? 0;
    const wait = Math.min(Math.max(remaining, 0), MAX_DRAIN_MS);
    // If the caller hung up first this close is the tail of a call that is
    // already gone, and by the time the timer fires the next one could be up.
    // The token makes the timer hang up only the call that armed it.
    const callId = callIdRef.current;

    if (drainTimerRef.current !== null) clearTimeout(drainTimerRef.current);
    drainTimerRef.current = setTimeout(() => {
      drainTimerRef.current = null;
      if (callIdRef.current !== callId) return;
      sipRef.current?.terminate();
    }, wait);
  }, []);

  /* ---------------------------------------------------------------------- */
  /* SIP events                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * An INVITE arrived. The gateway is opened *before* the call is answered: if
   * it cannot be reached the call is declined instead, because Asterisk's
   * no-answer handling is a better outcome for a caller than silence on an
   * answered line.
   */
  const handleIncoming = useCallback(
    (info: { from: string | null; to: string | null }) => {
      // `goOffline()` drops its reference before it awaits the unregister, so
      // an INVITE can still reach this handler after the bridge has been taken
      // offline. Building a call there would open a Gemini session with nothing
      // to answer, and leave `answeringRef` stuck true so every later INVITE
      // got 480.
      if (!sipRef.current) return;

      if (answeringRef.current) {
        // The previous call is still being released. Decline rather than
        // answer into a half-torn-down audio graph.
        sipRef.current?.reject();
        return;
      }
      answeringRef.current = true;
      callIdRef.current += 1;
      dispatch({ type: "incoming", from: info.from, to: info.to });

      void (async () => {
        setNotice(null);
        clearTranscript();

        try {
          const player = new StreamingAudioPlayer({
            onFirstPlayback: () => {
              const turn = turnRef.current;
              if (turn.measured || turn.speechEndedAt === null) return;
              turn.measured = true;
              ttfaRef.current = performance.now() - turn.speechEndedAt;
            },
          });
          // Stored before it is started so a failure part-way through still
          // leaves the AudioContext for teardownCall to close.
          playerRef.current = player;
          // "stream" mode routes the agent's voice into a
          // MediaStreamAudioDestinationNode instead of the speakers, which is
          // the track SIP is about to be handed.
          await player.start("stream");
          const outbound = player.outputStream;
          if (!outbound) throw new Error("The audio player produced no outgoing stream.");

          // `info.from`/`info.to` are exactly what was just dispatched onto
          // `BridgeState.from`/`.to` above — read from here rather than the
          // reducer's state, which this closure would otherwise see stale.
          const client: VoiceClient = new VoiceClient(phoneGatewayUrl(info.from, info.to), {
            onMessage: handleServerMessage,
            // Names the socket whose close this is. Safe despite `client` not
            // being assigned yet: the handler only ever runs after connect().
            onClose: () => handleGatewayClose(client),
            onError: (error) => setNotice(error.message),
          });
          clientRef.current = client;
          await client.connect();

          // Re-read rather than reusing the earlier check: going offline during
          // the connect above must not leave a Gemini session running against a
          // call nobody can answer.
          const sip = sipRef.current;
          if (!sip) throw new Error("The bridge went offline before the call could be answered.");
          sip.answer(outbound);
        } catch (cause) {
          setNotice(
            `${describe(cause, "Could not reach the voice gateway.")} The call was not answered.`,
          );
          await teardownCall();
          sipRef.current?.reject();
          // `reject()` makes JsSIP emit `failed`, which runs the normal ended
          // path; this dispatch is the safety net for a session that had
          // already gone away.
          dispatch({ type: "call_ended" });
        }
      })();
    },
    [clearTranscript, handleGatewayClose, handleServerMessage, teardownCall],
  );

  /** The caller's audio is flowing. Point it at the gateway. */
  const handleAnswered = useCallback(
    (remoteStream: MediaStream) => {
      void (async () => {
        const capture = new AudioCapture({
          onChunk: (pcm) => clientRef.current?.sendAudio(pcm),
          onLevel: (level) => {
            levels.current.user = level;
          },
          onError: (error) => setNotice(error.message),
        });
        captureRef.current = capture;

        try {
          await capture.start(remoteStream);
          captureReadyRef.current = true;
          for (const track of pendingTracksRef.current) capture.addTrack(track);
          pendingTracksRef.current = [];

          // Mirror the agent's real output level. Both levels live in a ref and
          // are read from an animation frame, so a meter never costs a render.
          const pump = () => {
            levels.current.agent = playerRef.current?.getOutputLevel() ?? 0;
            rafRef.current = requestAnimationFrame(pump);
          };
          rafRef.current = requestAnimationFrame(pump);

          dispatch({ type: "gateway_open" });
        } catch (cause) {
          setNotice(describe(cause, "Could not capture the caller's audio."));
          sipRef.current?.terminate();
        }
      })();
    },
    [],
  );

  const handleRemoteTrack = useCallback((track: MediaStreamTrack) => {
    const capture = captureRef.current;
    if (capture && captureReadyRef.current) {
      capture.addTrack(track);
      return;
    }
    pendingTracksRef.current.push(track);
  }, []);

  const handleEnded = useCallback(() => {
    void (async () => {
      finaliseTranscript();
      await teardownCall();
      dispatch({ type: "call_ended" });
    })();
  }, [finaliseTranscript, teardownCall]);

  /* ---------------------------------------------------------------------- */
  /* Operator actions                                                       */
  /* ---------------------------------------------------------------------- */

  const goOnline = useCallback(
    async (credentials: SipCredentials) => {
      if (sipRef.current) return;

      setNotice(null);
      dispatch({ type: "go_online" });

      const sip = new SipBridge({
        onRegistered: () => dispatch({ type: "registered" }),
        onRegistrationFailed: (message) => {
          const failed = sipRef.current;

          // JsSIP re-registers on a timer, and a refresh REGISTER can fail
          // during a call — a PBX blip, a moment of packet loss. Stopping the
          // UA then would terminate the live session and drop the caller,
          // which is strictly worse than JsSIP's own retry. The registration
          // is only worth acting on when there is no call riding on it.
          if (failed?.hasSession) {
            setNotice(`${message} The current call is unaffected; JsSIP is retrying.`);
            return;
          }

          dispatch({ type: "registration_failed", message });
          // With no call in flight, JsSIP would keep retrying behind a UI that
          // says "failed", and the reducer only accepts `registered` out of
          // `connecting`. Stopping the UA keeps the two honest: recovery is
          // the operator clicking Go online again.
          sipRef.current = null;
          queueMicrotask(() => void failed?.goOffline());
        },
        onIncoming: handleIncoming,
        onAnswered: handleAnswered,
        onRemoteTrack: handleRemoteTrack,
        onEnded: handleEnded,
        onNotice: setNotice,
      });
      sipRef.current = sip;

      try {
        await sip.goOnline(credentials);
      } catch (cause) {
        sipRef.current = null;
        dispatch({
          type: "registration_failed",
          message: describe(cause, "Could not start the SIP connection."),
        });
      }
    },
    [handleAnswered, handleEnded, handleIncoming, handleRemoteTrack],
  );

  const goOffline = useCallback(async () => {
    dispatch({ type: "go_offline" });
    const sip = sipRef.current;
    sipRef.current = null;
    // Terminate SIP first so the caller is released immediately, then release
    // the audio graph and the gateway socket.
    await sip?.goOffline();
    await teardownCall();
  }, [teardownCall]);

  /* ---------------------------------------------------------------------- */

  // A closed tab drops the call — a named limitation of a browser runtime — but
  // an unmount inside the tab must at least not leave a SIP registration, an
  // open gateway socket and two AudioContexts behind.
  useEffect(() => {
    return () => {
      if (drainTimerRef.current !== null) clearTimeout(drainTimerRef.current);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      const sip = sipRef.current;
      sipRef.current = null;
      void sip?.goOffline();
      clientRef.current?.close(ttfaRef.current);
      clientRef.current = null;
      void captureRef.current?.stop();
      captureRef.current = null;
      void playerRef.current?.stop();
      playerRef.current = null;
    };
  }, []);

  return {
    state,
    transcript,
    toolActivity,
    activeSpeaker,
    notice,
    levels,
    goOnline,
    goOffline,
    clearTranscript,
  };
}
