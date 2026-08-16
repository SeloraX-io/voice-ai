/**
 * Upload Audio mode (not real-time).
 *
 * A whole recording is sent once, transcribed and answered by Gemini, then the
 * reply is synthesised back to speech. This exists for testing prompts and
 * voices without a microphone — the Live tab is the real product path.
 *
 * Runs on the Node runtime because it handles binary audio and needs the
 * server-only GEMINI_API_KEY.
 */

import { NextResponse } from "next/server";
import { GoogleGenAI, Type } from "@google/genai";

import { pcm16ToWav, sampleRateFromMimeType } from "@/lib/audio/pcm";
import {
  UPLOAD_TTS_MODEL,
  UPLOAD_UNDERSTANDING_MODEL,
  type UploadAnalysis,
} from "@/lib/gemini/types";
import { resolveAgentConfig } from "@/lib/agent-config/resolve";
import { configStore } from "@/server/config/store";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Inline request data is capped by the API; stay comfortably under it. */
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

const ACCEPTED_MIME_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/aac",
  "audio/webm",
  "audio/ogg",
  "video/webm", // MediaRecorder output is often labelled this way
]);

const EXTENSION_FALLBACK: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  webm: "audio/webm",
  ogg: "audio/ogg",
  aac: "audio/aac",
};

function resolveMimeType(file: File): string | null {
  if (file.type && ACCEPTED_MIME_TYPES.has(file.type)) {
    // Gemini expects a canonical audio/* type for m4a/mp4 containers.
    if (file.type === "video/webm") return "audio/webm";
    return file.type;
  }
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_FALLBACK[extension] ?? null;
}

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function POST(request: Request): Promise<NextResponse> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("[upload] GEMINI_API_KEY is not configured");
    return NextResponse.json(
      { error: "The server is not configured for audio processing." },
      { status: 500 },
    );
  }

  let file: File | null = null;
  try {
    const form = await request.formData();
    const value = form.get("file");
    if (value instanceof File) file = value;
  } catch {
    return badRequest("Could not read the uploaded file.");
  }

  if (!file) return badRequest("No audio file was provided.");
  if (file.size === 0) return badRequest("The uploaded file is empty.");
  if (file.size > MAX_UPLOAD_BYTES) {
    return badRequest(`Audio files must be under ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
  }

  const mimeType = resolveMimeType(file);
  if (!mimeType) {
    return badRequest("Unsupported format. Upload an MP3, WAV, M4A, WebM or OGG file.");
  }

  const ai = new GoogleGenAI({ apiKey });
  const startedAt = Date.now();
  const agent = resolveAgentConfig(await configStore.read());

  try {
    const audioBase64 = Buffer.from(await file.arrayBuffer()).toString("base64");

    /* 1. Transcribe the caller and draft the agent's reply in one pass. */
    const understandingStartedAt = Date.now();
    const analysis = await ai.models.generateContent({
      model: UPLOAD_UNDERSTANDING_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType, data: audioBase64 } },
            {
              text:
                "This is a recording of a customer calling support. " +
                "Transcribe exactly what the customer says, in whatever language they used. " +
                "Then write the reply you would speak back to them — the reply must be in Bangla.",
            },
          ],
        },
      ],
      config: {
        systemInstruction: agent.instructions,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            transcript: {
              type: Type.STRING,
              description: "Verbatim transcript of the customer's speech.",
            },
            reply: {
              type: Type.STRING,
              description:
                "The support agent's spoken reply, written in Bangla. One or two sentences.",
            },
          },
          required: ["transcript", "reply"],
        },
      },
    });
    const understandingMs = Date.now() - understandingStartedAt;

    const parsed = safeParse(analysis.text);
    if (!parsed) {
      return NextResponse.json(
        { error: "Gemini could not interpret that recording. Try a clearer audio file." },
        { status: 502 },
      );
    }

    /* 2. Speak the reply with the same voice the Live agent uses. */
    const synthesisStartedAt = Date.now();
    const speech = await ai.models.generateContent({
      model: UPLOAD_TTS_MODEL,
      contents: parsed.reply,
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: agent.models.voice } },
          languageCode: agent.models.languageCode,
        },
      },
    });
    const synthesisMs = Date.now() - synthesisStartedAt;

    const inline = speech.candidates?.[0]?.content?.parts?.find((part) => part.inlineData)
      ?.inlineData;
    if (!inline?.data) {
      return NextResponse.json(
        { error: "The reply could not be converted to speech." },
        { status: 502 },
      );
    }

    // Gemini returns headerless L16; wrap it so an <audio> element can play it.
    const wav = pcm16ToWav(
      Buffer.from(inline.data, "base64"),
      sampleRateFromMimeType(inline.mimeType ?? ""),
    );

    const result: UploadAnalysis = {
      transcript: parsed.transcript,
      reply: parsed.reply,
      replyAudioUrl: `data:audio/wav;base64,${Buffer.from(wav).toString("base64")}`,
      timings: {
        understandingMs,
        synthesisMs,
        totalMs: Date.now() - startedAt,
      },
    };

    return NextResponse.json(result);
  } catch (cause) {
    // Upstream errors can carry configuration detail — keep them in the logs.
    console.error("[upload] processing failed", cause);
    return NextResponse.json(
      { error: "Audio processing failed. Check the server logs for details." },
      { status: 502 },
    );
  }
}

function safeParse(text: string | undefined): { transcript: string; reply: string } | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as Record<string, unknown>).transcript === "string" &&
      typeof (value as Record<string, unknown>).reply === "string"
    ) {
      return value as { transcript: string; reply: string };
    }
  } catch {
    // Fall through to null; the caller turns this into a 502.
  }
  return null;
}
