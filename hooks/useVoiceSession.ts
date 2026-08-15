"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { StreamingAudioPlayer } from "@/lib/audio/audio-player";
import { MicrophoneCapture, MicrophoneError } from "@/lib/audio/microphone";
import { base64ToPcm16 } from "@/lib/audio/pcm";
import { resolveGatewayUrl, VoiceClient } from "@/lib/websocket/voice-client";
import {
  EMPTY_METRICS,
  type CallMetrics,
  type TranscriptEntry,
  type VoiceStatus,
} from "@/lib/gemini/types";
import type { ServerMessage, SessionInfo, Speaker } from "@/types/voice";

/** How long the INTERRUPTED visual state is held before returning to LISTENING. */
const INTERRUPT_FLASH_MS = 500;

/**
 * If the gateway does not confirm an interruption this soon after local speech
 * onset, the optimistic duck is undone — the user was not actually barging in.
 */
const DUCK_TIMEOUT_MS = 700;

export interface VoiceLevels {
  /** Live microphone RMS, 0..1. */
  user: number;
  /** Live speaker-output RMS of the agent's voice, 0..1. */
  agent: number;
}

export interface VoiceSessionController {
  status: VoiceStatus;
  error: string | null;
  session: SessionInfo | null;
  transcript: TranscriptEntry[];
  metrics: CallMetrics;
  muted: boolean;
  /** Mutated at audio rate; read it from rAF so React never re-renders on it. */
  levels: React.RefObject<VoiceLevels>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  toggleMute: () => void;
  sendText: (text: string) => void;
  clearTranscript: () => void;
}

interface TurnTimings {
  speechStartedAt: number | null;
  speechEndedAt: number | null;
  firstResponseAt: number | null;
  firstAudioChunkAt: number | null;
  measured: boolean;
}

const EMPTY_TURN: TurnTimings = {
  speechStartedAt: null,
  speechEndedAt: null,
  firstResponseAt: null,
  firstAudioChunkAt: null,
  measured: false,
};

let entrySeq = 0;
const nextEntryId = () => `entry-${++entrySeq}`;

export function useVoiceSession(): VoiceSessionController {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [metrics, setMetrics] = useState<CallMetrics>(EMPTY_METRICS);
  const [muted, setMuted] = useState(false);

  const levels = useRef<VoiceLevels>({ user: 0, agent: 0 });

  const micRef = useRef<MicrophoneCapture | null>(null);
  const playerRef = useRef<StreamingAudioPlayer | null>(null);
  const clientRef = useRef<VoiceClient | null>(null);

  const turnRef = useRef<TurnTimings>({ ...EMPTY_TURN });
  const openEntriesRef = useRef<Record<Speaker, string | null>>({ user: null, assistant: null });
  const startedAtRef = useRef<number>(0);
  const duckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interruptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  /** Guards against overlapping start()/stop() calls from rapid clicking. */
  const busyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const patchMetrics = useCallback((patch: Partial<CallMetrics>) => {
    if (!mountedRef.current) return;
    setMetrics((current) => ({ ...current, ...patch }));
  }, []);

  const clearTimers = useCallback(() => {
    if (duckTimerRef.current !== null) {
      clearTimeout(duckTimerRef.current);
      duckTimerRef.current = null;
    }
    if (interruptTimerRef.current !== null) {
      clearTimeout(interruptTimerRef.current);
      interruptTimerRef.current = null;
    }
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  /* ---------------------------------------------------------------------- */
  /* Transcript                                                             */
  /* ---------------------------------------------------------------------- */

  const appendTranscript = useCallback((speaker: Speaker, text: string) => {
    if (!mountedRef.current || text.length === 0) return;

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

  /* ---------------------------------------------------------------------- */
  /* Teardown                                                               */
  /* ---------------------------------------------------------------------- */

  const teardown = useCallback(async () => {
    clearTimers();

    clientRef.current?.close();
    clientRef.current = null;

    const mic = micRef.current;
    micRef.current = null;
    const player = playerRef.current;
    playerRef.current = null;

    await Promise.all([mic?.stop(), player?.stop()]);

    levels.current.user = 0;
    levels.current.agent = 0;
    turnRef.current = { ...EMPTY_TURN };
    openEntriesRef.current = { user: null, assistant: null };
  }, [clearTimers]);

  const stop = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      finaliseTranscript();
      await teardown();
      if (!mountedRef.current) return;
      setStatus("idle");
      setSession(null);
      setMuted(false);
    } finally {
      busyRef.current = false;
    }
  }, [finaliseTranscript, teardown]);

  const failWith = useCallback(
    async (message: string) => {
      await teardown();
      if (!mountedRef.current) return;
      setError(message);
      setStatus("error");
      setSession(null);
    },
    [teardown],
  );

  /* ---------------------------------------------------------------------- */
  /* Gateway events                                                         */
  /* ---------------------------------------------------------------------- */

  const handleServerMessage = useCallback(
    (message: ServerMessage) => {
      const player = playerRef.current;
      const now = performance.now();
      const turn = turnRef.current;

      /** Marks the first sign of life from the model for the current turn. */
      const markFirstResponse = () => {
        if (turn.firstResponseAt !== null || turn.speechEndedAt === null) return;
        turn.firstResponseAt = now;
        patchMetrics({ firstResponseMs: now - turn.speechEndedAt });
      };

      switch (message.type) {
        case "session_started": {
          setSession(message);
          setStatus("listening");
          patchMetrics({
            geminiConnectMs: message.geminiConnectMs,
            sessionReadyMs: now - startedAtRef.current,
          });
          return;
        }

        case "audio": {
          markFirstResponse();
          if (turn.firstAudioChunkAt === null && turn.speechEndedAt !== null) {
            turn.firstAudioChunkAt = now;
            patchMetrics({ firstAudioChunkMs: now - turn.speechEndedAt });
          }
          player?.enqueue(base64ToPcm16(message.data));
          return;
        }

        case "transcript": {
          if (message.speaker === "assistant") markFirstResponse();
          appendTranscript(message.speaker, message.text);
          return;
        }

        case "user_started_speaking": {
          turn.speechStartedAt = now - message.msAgo;
          turn.speechEndedAt = null;
          turn.firstResponseAt = null;
          turn.firstAudioChunkAt = null;
          turn.measured = false;

          if (player?.isPlaying) {
            // Optimistic: soften the agent now, let Gemini confirm the barge-in.
            player.duck();
            if (duckTimerRef.current !== null) clearTimeout(duckTimerRef.current);
            duckTimerRef.current = setTimeout(() => {
              duckTimerRef.current = null;
              playerRef.current?.unduck();
            }, DUCK_TIMEOUT_MS);
          } else {
            setStatus("listening");
          }
          return;
        }

        case "user_stopped_speaking": {
          turn.speechEndedAt = now - message.msAgo;
          if (!playerRef.current?.isPlaying) setStatus("thinking");
          return;
        }

        case "assistant_started_speaking":
          markFirstResponse();
          return;

        case "interrupted": {
          if (duckTimerRef.current !== null) {
            clearTimeout(duckTimerRef.current);
            duckTimerRef.current = null;
          }
          player?.clear();
          finaliseTranscript("assistant");

          setStatus("interrupted");
          if (interruptTimerRef.current !== null) clearTimeout(interruptTimerRef.current);
          interruptTimerRef.current = setTimeout(() => {
            interruptTimerRef.current = null;
            setStatus((current) => (current === "interrupted" ? "listening" : current));
          }, INTERRUPT_FLASH_MS);

          setMetrics((current) => ({
            ...current,
            interruptions: current.interruptions + 1,
            interruptionLatencyMs:
              turn.speechStartedAt !== null ? now - turn.speechStartedAt : current.interruptionLatencyMs,
          }));
          return;
        }

        case "assistant_stopped_speaking":
          // Generation finished. Playback usually has audio left in the queue,
          // so the visual SPEAKING state is driven by the player, not this.
          return;

        case "turn_complete": {
          finaliseTranscript();
          setMetrics((current) => ({ ...current, turns: current.turns + 1 }));
          return;
        }

        case "pong":
          patchMetrics({ roundTripMs: now - message.t });
          return;

        case "error": {
          if (message.fatal) {
            void failWith(message.message);
          } else if (mountedRef.current) {
            setError(message.message);
          }
          return;
        }
      }
    },
    [appendTranscript, failWith, finaliseTranscript, patchMetrics],
  );

  /* ---------------------------------------------------------------------- */
  /* Start                                                                  */
  /* ---------------------------------------------------------------------- */

  const start = useCallback(async () => {
    if (busyRef.current || micRef.current) return;
    busyRef.current = true;

    startedAtRef.current = performance.now();
    setError(null);
    setStatus("connecting");
    setMetrics({ ...EMPTY_METRICS });
    turnRef.current = { ...EMPTY_TURN };
    openEntriesRef.current = { user: null, assistant: null };

    try {
      // 1. Playback context first: it must be created inside the click handler
      //    or the browser leaves it suspended.
      const player = new StreamingAudioPlayer({
        onStarted: () => {
          if (mountedRef.current) setStatus("speaking");
        },
        onStopped: (playedMs) => {
          if (!mountedRef.current) return;
          patchMetrics({ responseDurationMs: playedMs });
          setStatus((current) => (current === "speaking" ? "listening" : current));
        },
        onFirstPlayback: () => {
          const turn = turnRef.current;
          if (turn.measured || turn.speechEndedAt === null) return;
          turn.measured = true;
          patchMetrics({ timeToFirstAudioMs: performance.now() - turn.speechEndedAt });
        },
      });
      await player.start();
      playerRef.current = player;

      // 2. Microphone + worklet.
      const micStartedAt = performance.now();
      const mic = new MicrophoneCapture({
        onChunk: (pcm) => clientRef.current?.sendAudio(pcm),
        onLevel: (level) => {
          levels.current.user = level;
        },
        onError: (micError) => void failWith(micError.message),
      });
      await mic.start();
      micRef.current = mic;
      patchMetrics({ micStartMs: performance.now() - micStartedAt });

      // 3. Persistent WebSocket to the gateway, which opens the Gemini session.
      const client = new VoiceClient(resolveGatewayUrl(), {
        onMessage: handleServerMessage,
        onClose: ({ clean, reason }) => {
          if (clean) return;
          void failWith(
            reason || "The connection to the voice gateway was lost. Start a new call to retry.",
          );
        },
        onError: (socketError) => void failWith(socketError.message),
      });
      clientRef.current = client;
      const wsConnectMs = await client.connect();
      patchMetrics({ wsConnectMs });

      // 4. Mirror the agent's real output level for the waveform.
      const pump = () => {
        levels.current.agent = playerRef.current?.getOutputLevel() ?? 0;
        rafRef.current = requestAnimationFrame(pump);
      };
      rafRef.current = requestAnimationFrame(pump);
    } catch (cause) {
      const message =
        cause instanceof MicrophoneError || cause instanceof Error
          ? cause.message
          : "Could not start the call.";
      if (process.env.NODE_ENV !== "production") console.error("[voice] start failed", cause);
      await failWith(message);
    } finally {
      busyRef.current = false;
    }
  }, [failWith, handleServerMessage, patchMetrics]);

  /* ---------------------------------------------------------------------- */

  const toggleMute = useCallback(() => {
    const mic = micRef.current;
    if (!mic) return;
    const next = !mic.isMuted;
    mic.setMuted(next);
    setMuted(next);
    if (next) {
      levels.current.user = 0;
      // Let Gemini close out the turn instead of waiting on a dead stream.
      clientRef.current?.signalAudioStreamEnd();
    }
  }, []);

  const sendText = useCallback((text: string) => {
    clientRef.current?.sendText(text);
  }, []);

  const clearTranscript = useCallback(() => {
    openEntriesRef.current = { user: null, assistant: null };
    setTranscript([]);
  }, []);

  // Release the microphone and both AudioContexts if the page unmounts mid-call.
  useEffect(() => {
    return () => {
      clearTimers();
      clientRef.current?.close();
      clientRef.current = null;
      void micRef.current?.stop();
      micRef.current = null;
      void playerRef.current?.stop();
      playerRef.current = null;
    };
  }, [clearTimers]);

  return {
    status,
    error,
    session,
    transcript,
    metrics,
    muted,
    levels,
    start,
    stop,
    toggleMute,
    sendText,
    clearTranscript,
  };
}
