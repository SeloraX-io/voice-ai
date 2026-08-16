"use client";

import type { TabProps } from "@/components/agent-config/AgentConfigProvider";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { LIMITS, type ModelsConfig, type VadConfig } from "@/lib/agent-config/schema";

/** Gemini prebuilt voices available to the Live API. */
const VOICES = ["Kore", "Puck", "Charon", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr"];

const LANGUAGES = [
  { code: "bn-IN", label: "Bangla (India)" },
  { code: "bn-BD", label: "Bangla (Bangladesh)" },
  { code: "en-US", label: "English (United States)" },
  { code: "en-GB", label: "English (United Kingdom)" },
  { code: "hi-IN", label: "Hindi (India)" },
  { code: "ar-XA", label: "Arabic" },
  { code: "es-US", label: "Spanish (United States)" },
];

export function ModelsVoiceTab({ config, update, errors }: TabProps) {
  const models = config.models;

  const patch = (changes: Partial<ModelsConfig>) => update({ models: { ...models, ...changes } });
  const patchVad = (changes: Partial<VadConfig>) =>
    patch({ vad: { ...models.vad, ...changes } });

  return (
    <div className="flex flex-col gap-9">
      <section className="flex flex-col gap-5">
        <h2 className="text-sm font-medium text-[var(--text)]">Model</h2>

        <Field
          label="Live model"
          htmlFor="liveModel"
          description="Must advertise bidiGenerateContent. Changing this affects the next call only."
          error={errors.get("models.liveModel")}
        >
          <Input
            id="liveModel"
            value={models.liveModel}
            onChange={(event) => patch({ liveModel: event.target.value })}
            spellCheck={false}
            className="font-mono text-xs"
          />
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="Temperature"
            htmlFor="temperature"
            description={`Higher is more varied. ${LIMITS.temperature.min}–${LIMITS.temperature.max}.`}
            error={errors.get("models.temperature")}
          >
            <Input
              id="temperature"
              type="number"
              step="0.05"
              min={LIMITS.temperature.min}
              max={LIMITS.temperature.max}
              value={models.temperature}
              onChange={(event) => patch({ temperature: Number(event.target.value) })}
            />
          </Field>

          <Field
            label="Top P"
            htmlFor="topP"
            description={`Nucleus sampling cutoff. ${LIMITS.topP.min}–${LIMITS.topP.max}.`}
            error={errors.get("models.topP")}
          >
            <Input
              id="topP"
              type="number"
              step="0.05"
              min={LIMITS.topP.min}
              max={LIMITS.topP.max}
              value={models.topP}
              onChange={(event) => patch({ topP: Number(event.target.value) })}
            />
          </Field>
        </div>
      </section>

      <section className="flex flex-col gap-5">
        <h2 className="text-sm font-medium text-[var(--text)]">Voice</h2>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Voice" htmlFor="voice" error={errors.get("models.voice")}>
            <Select
              id="voice"
              value={models.voice}
              onChange={(event) => patch({ voice: event.target.value })}
            >
              {VOICES.map((voice) => (
                <option key={voice} value={voice}>
                  {voice}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Language"
            htmlFor="languageCode"
            description="Pins TTS phonetics, so the synthesiser is not fighting your prompt."
            error={errors.get("models.languageCode")}
          >
            <Select
              id="languageCode"
              value={models.languageCode}
              onChange={(event) => patch({ languageCode: event.target.value })}
            >
              {LANGUAGES.map(({ code, label }) => (
                <option key={code} value={code}>
                  {label} — {code}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </section>

      <section className="flex flex-col gap-5">
        <div>
          <h2 className="text-sm font-medium text-[var(--text)]">Turn taking</h2>
          <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
            Gemini&rsquo;s server-side voice activity detection decides when the caller has finished
            speaking. Shorter silences make the agent answer faster but interrupt more.
          </p>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Start sensitivity" htmlFor="startSensitivity">
            <Select
              id="startSensitivity"
              value={models.vad.startSensitivity}
              onChange={(event) =>
                patchVad({ startSensitivity: event.target.value as VadConfig["startSensitivity"] })
              }
            >
              <option value="high">High — detects speech sooner</option>
              <option value="low">Low — ignores faint sounds</option>
            </Select>
          </Field>

          <Field label="End sensitivity" htmlFor="endSensitivity">
            <Select
              id="endSensitivity"
              value={models.vad.endSensitivity}
              onChange={(event) =>
                patchVad({ endSensitivity: event.target.value as VadConfig["endSensitivity"] })
              }
            >
              <option value="high">High — ends the turn sooner</option>
              <option value="low">Low — waits longer before ending</option>
            </Select>
          </Field>

          <Field
            label="Silence before replying"
            htmlFor="silenceDurationMs"
            description={`Milliseconds. ${LIMITS.silenceDurationMs.min}–${LIMITS.silenceDurationMs.max}.`}
            error={errors.get("models.vad.silenceDurationMs")}
          >
            <Input
              id="silenceDurationMs"
              type="number"
              step="10"
              min={LIMITS.silenceDurationMs.min}
              max={LIMITS.silenceDurationMs.max}
              value={models.vad.silenceDurationMs}
              onChange={(event) => patchVad({ silenceDurationMs: Number(event.target.value) })}
            />
          </Field>

          <Field
            label="Prefix padding"
            htmlFor="prefixPaddingMs"
            description={`Audio kept from just before speech starts. ${LIMITS.prefixPaddingMs.min}–${LIMITS.prefixPaddingMs.max} ms.`}
            error={errors.get("models.vad.prefixPaddingMs")}
          >
            <Input
              id="prefixPaddingMs"
              type="number"
              step="5"
              min={LIMITS.prefixPaddingMs.min}
              max={LIMITS.prefixPaddingMs.max}
              value={models.vad.prefixPaddingMs}
              onChange={(event) => patchVad({ prefixPaddingMs: Number(event.target.value) })}
            />
          </Field>
        </div>
      </section>
    </div>
  );
}
