/**
 * One persistent Gemini Live session per browser call.
 *
 * The API key is read from the server process environment and never leaves it.
 * Everything is streaming: audio goes up as it is captured and comes back down
 * as it is generated — there is no request/response turn boundary here.
 */

import path from "node:path";

import {
  EndSensitivity,
  GoogleGenAI,
  Modality,
  StartSensitivity,
  type LiveServerMessage,
  type Session,
} from "@google/genai";

import { DEFAULT_AGENT_CONFIG } from "../../lib/agent-config/defaults";
import {
  buildSystemInstruction,
  resolveAgentConfig,
  type ResolvedAgentConfig,
} from "../../lib/agent-config/resolve";
import { createConfigStore, type StoreLogger } from "../config/store";

export interface GeminiSessionEvents {
  /** Base64 PCM16 @ 24 kHz, emitted per chunk with zero buffering. */
  onAudio: (base64: string) => void;
  onInputTranscript: (text: string) => void;
  onOutputTranscript: (text: string) => void;
  /** Gemini detected the user talking over the model and stopped generating. */
  onInterrupted: () => void;
  onGenerationComplete: () => void;
  onTurnComplete: () => void;
  onError: (message: string) => void;
  onClose: (reason: string) => void;
}

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (client) return client;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. Copy .env.example to .env.local and add your key.",
    );
  }
  client = new GoogleGenAI({ apiKey });
  return client;
}

/**
 * Loads and resolves the config for one call. Never throws: a call must connect
 * even if the config file is missing or unreadable.
 *
 * Builds its own store rather than using the shared instance so store problems
 * reach the gateway's log with the call id attached, instead of vanishing.
 */
export async function loadResolvedAgentConfig(
  log: StoreLogger = () => {},
): Promise<ResolvedAgentConfig> {
  try {
    const store = createConfigStore(path.join(process.cwd(), "data"), log);
    return resolveAgentConfig(await store.read());
  } catch (cause) {
    // Defense in depth: `store.read()` should already never throw, but a call
    // must connect even if that guarantee is ever violated.
    log(`loadResolvedAgentConfig failed, using defaults: ${String(cause)}`);
    return resolveAgentConfig(structuredClone(DEFAULT_AGENT_CONFIG));
  }
}

/**
 * Sent as the first turn when a welcome message is enabled, because Gemini Live
 * has no field for "speak first". The text never reaches the customer; it only
 * hands the model the turn.
 */
const GREETING_PRIMER = "The call has just connected. Deliver your opening greeting now.";

export class GeminiVoiceSession {
  private closed = false;

  private constructor(
    private readonly session: Session,
    readonly connectMs: number,
  ) {}

  static async create(
    events: GeminiSessionEvents,
    agent: ResolvedAgentConfig,
  ): Promise<GeminiVoiceSession> {
    const startedAt = Date.now();
    const ai = getClient();

    const session = await ai.live.connect({
      model: agent.models.liveModel,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: buildSystemInstruction(agent),
        temperature: agent.models.temperature,
        topP: agent.models.topP,
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: agent.models.voice } },
          // Pins TTS phonetics so the prompt's language rule is not fighting a
          // synthesiser that defaults to English.
          languageCode: agent.models.languageCode,
        },
        // Live transcripts for both sides of the call.
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        // Server-side VAD owns turn taking and interruption.
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            startOfSpeechSensitivity:
              agent.models.vad.startSensitivity === "high"
                ? StartSensitivity.START_SENSITIVITY_HIGH
                : StartSensitivity.START_SENSITIVITY_LOW,
            endOfSpeechSensitivity:
              agent.models.vad.endSensitivity === "high"
                ? EndSensitivity.END_SENSITIVITY_HIGH
                : EndSensitivity.END_SENSITIVITY_LOW,
            prefixPaddingMs: agent.models.vad.prefixPaddingMs,
            silenceDurationMs: agent.models.vad.silenceDurationMs,
          },
        },
        // Lets a call run past the raw context limit instead of being dropped.
        contextWindowCompression: { slidingWindow: {} },
      },
      callbacks: {
        onmessage: (message: LiveServerMessage) => handleMessage(message, events),
        onerror: (event: ErrorEvent) => {
          events.onError(event?.message || "Gemini Live reported an error.");
        },
        onclose: (event: CloseEvent) => {
          events.onClose(event?.reason || "Gemini Live session closed.");
        },
      },
    });

    return new GeminiVoiceSession(session, Date.now() - startedAt);
  }

  /** Hands the model the first turn so it speaks the configured greeting. */
  primeGreeting(): void {
    if (this.closed) return;
    this.session.sendClientContent({
      turns: [{ role: "user", parts: [{ text: GREETING_PRIMER }] }],
      turnComplete: true,
    });
  }

  /** Forwards one microphone chunk. `base64` is PCM16 @ 16 kHz mono. */
  sendAudio(base64: string): void {
    if (this.closed) return;
    this.session.sendRealtimeInput({
      audio: { data: base64, mimeType: "audio/pcm;rate=16000" },
    });
  }

  sendText(text: string): void {
    if (this.closed) return;
    this.session.sendRealtimeInput({ text });
  }

  /** Tells Gemini the microphone stopped so it can close out the turn. */
  signalAudioStreamEnd(): void {
    if (this.closed) return;
    this.session.sendRealtimeInput({ audioStreamEnd: true });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.session.close();
    } catch {
      // The socket may already be gone; closing twice is not an error here.
    }
  }
}

function handleMessage(message: LiveServerMessage, events: GeminiSessionEvents): void {
  const content = message.serverContent;

  // Audio first: forwarding it before anything else shaves a tick off TTFA.
  for (const part of content?.modelTurn?.parts ?? []) {
    const inline = part.inlineData;
    if (inline?.data && inline.mimeType?.startsWith("audio/")) {
      events.onAudio(inline.data);
    }
  }

  if (!content) return;

  if (content.interrupted) events.onInterrupted();

  const inputText = content.inputTranscription?.text ?? content.interimInputTranscription?.text;
  if (inputText) events.onInputTranscript(inputText);

  const outputText = content.outputTranscription?.text;
  if (outputText) events.onOutputTranscript(outputText);

  if (content.generationComplete) events.onGenerationComplete();
  if (content.turnComplete) events.onTurnComplete();
}
