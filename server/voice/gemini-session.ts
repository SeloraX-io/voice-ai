/**
 * One persistent Gemini Live session per browser call.
 *
 * The API key is read from the server process environment and never leaves it.
 * Everything is streaming: audio goes up as it is captured and comes back down
 * as it is generated — there is no request/response turn boundary here.
 */

import {
  EndSensitivity,
  GoogleGenAI,
  Modality,
  StartSensitivity,
  type LiveServerMessage,
  type Session,
} from "@google/genai";

import { AGENT_VOICE, LIVE_MODEL } from "../../lib/gemini/types";
import { CALL_CENTER_SYSTEM_INSTRUCTION, LIVE_GENERATION_SETTINGS } from "./agent-config";

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

export class GeminiVoiceSession {
  private closed = false;

  private constructor(
    private readonly session: Session,
    readonly connectMs: number,
  ) {}

  static async create(events: GeminiSessionEvents): Promise<GeminiVoiceSession> {
    const startedAt = Date.now();
    const ai = getClient();

    const session = await ai.live.connect({
      model: LIVE_MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: CALL_CENTER_SYSTEM_INSTRUCTION,
        temperature: LIVE_GENERATION_SETTINGS.temperature,
        topP: LIVE_GENERATION_SETTINGS.topP,
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: AGENT_VOICE } },
        },
        // Live transcripts for both sides of the call.
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        // Server-side VAD owns turn taking and interruption. Tight silence
        // settings make the agent answer quickly after the customer stops.
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
            endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
            prefixPaddingMs: 20,
            silenceDurationMs: 400,
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
