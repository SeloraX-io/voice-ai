/**
 * The agent configuration contract.
 *
 * Shared by the browser and the gateway, and deliberately free of imports so
 * either side can use it. `validateAgentConfig` is the only validation
 * implementation: the form calls it for inline feedback, and the PUT handler
 * calls it again on the raw body. The server never trusts the client's copy.
 */

import {
  asRecord,
  readBoolean,
  readEnum,
  readNumber,
  readString,
  type FieldError,
} from "./validate-helpers";
import { validateTools, type ToolsConfig } from "./tools";

export type { FieldError } from "./validate-helpers";
export * from "./tools";

export const AGENT_CONFIG_VERSION = 1;

export type ConversationType = "open_ended" | "data_collection";
export type VariableType = "string" | "number" | "boolean";
export type VadSensitivity = "high" | "low";

export interface AgentVariable {
  /** Stable React key. Not user-visible and not part of the prompt. */
  id: string;
  type: VariableType;
  name: string;
  /** Always stored as a string; coerced by `type` when resolved. */
  previewValue: string;
}

export interface WelcomeConfig {
  enabled: boolean;
  message: string;
  allowInterrupt: boolean;
}

export interface VadConfig {
  startSensitivity: VadSensitivity;
  endSensitivity: VadSensitivity;
  silenceDurationMs: number;
  prefixPaddingMs: number;
}

export interface ModelsConfig {
  /**
   * Ask Gemini for live transcripts of both sides of the call.
   *
   * Turning it off means the console shows no conversation text — the audio is
   * unaffected.
   *
   * Not a cost control. Measured against this model, output-text tokens were
   * zero whether transcripts were on or off, so this saves privacy and noise
   * rather than money.
   */
  transcripts: boolean;
  liveModel: string;
  voice: string;
  languageCode: string;
  temperature: number;
  topP: number;
  vad: VadConfig;
}

/**
 * The default hang-up policy.
 *
 * Abuse ends a call promptly; merely off-topic gets redirected twice first. An
 * agent that hangs up on a confused customer is worse than one that is slightly
 * too patient, so the two cases are deliberately not treated alike.
 */
export const DEFAULT_END_CALL_POLICY = `End the call yourself in these situations:

- The caller is abusive, uses slurs or obscene language, or is threatening. Say
  once, calmly, that you cannot continue the call if that continues. If it
  continues, say a short closing line and end the call.
- The caller repeatedly talks about things unrelated to support after you have
  twice tried to bring them back to the reason they called. Say you are ending
  the call and that they are welcome to call back about their order.
- The caller says they want to hang up, or the matter is resolved and they have
  nothing further.

Never end a call because someone is confused, slow, upset about their order, or
hard to understand. Those are the calls you are for.

Always say a short closing line first, then end the call — the line is spoken
before the call actually ends.`;

export type SummaryLanguage = "en" | "bn";

/** An after-the-call summary, written by a text model. */
export interface SummaryConfig {
  enabled: boolean;
  language: SummaryLanguage;
  /** The text model that writes it. Cheap by design; this is not a live model. */
  model: string;
}

/** Whether and when the agent may hang up on its own. */
export interface CallEndingConfig {
  enabled: boolean;
  /**
   * Appended to the instructions, so it is the model — not code — that judges
   * when a call should end. Judgement about tone and relevance is exactly what
   * a rule in code cannot do well.
   */
  policy: string;
}

export interface AgentConfig {
  version: number;
  type: ConversationType;
  instructions: string;
  welcome: WelcomeConfig;
  callEnding: CallEndingConfig;
  summary: SummaryConfig;
  models: ModelsConfig;
  agentName: string;
  variables: AgentVariable[];
  tools: ToolsConfig;
  /** Names only. Values live in a separate gitignored file, server-side. */
  secretKeys: string[];
  updatedAt: string;
}

export type ValidationResult =
  | { ok: true; config: AgentConfig }
  | { ok: false; errors: FieldError[] };

export const LIMITS = {
  instructionsMax: 32_000,
  welcomeMax: 2_000,
  agentNameMax: 63,
  variableNameMax: 64,
  variablesMax: 50,
  secretKeyMax: 128,
  secretValueMax: 4_096,
  temperature: { min: 0, max: 2 },
  topP: { min: 0, max: 1 },
  silenceDurationMs: { min: 100, max: 2_000 },
  prefixPaddingMs: { min: 0, max: 500 },
} as const;

export const VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
export const SECRET_KEY_RE = /^[A-Z][A-Z0-9_]*$/;

const VARIABLE_TYPES: readonly VariableType[] = ["string", "number", "boolean"];
const SENSITIVITIES: readonly VadSensitivity[] = ["high", "low"];

function validateVariables(value: unknown, errors: FieldError[]): AgentVariable[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push({ path: "variables", message: "Must be a list." });
    return [];
  }
  if (value.length > LIMITS.variablesMax) {
    errors.push({ path: "variables", message: `At most ${LIMITS.variablesMax} variables.` });
  }

  const seen = new Set<string>();
  const variables: AgentVariable[] = [];

  value.forEach((raw, index) => {
    const record = asRecord(raw);
    if (!record) {
      errors.push({ path: `variables.${index}`, message: "Must be an object." });
      return;
    }

    const type = readEnum(record.type, `variables.${index}.type`, VARIABLE_TYPES, errors, "string");
    const name = readString(record.name, `variables.${index}.name`, errors, "");
    const previewValue = readString(
      record.previewValue,
      `variables.${index}.previewValue`,
      errors,
      "",
    );

    if (name.length > LIMITS.variableNameMax) {
      errors.push({
        path: `variables.${index}.name`,
        message: `At most ${LIMITS.variableNameMax} characters.`,
      });
    } else if (!VARIABLE_NAME_RE.test(name)) {
      errors.push({
        path: `variables.${index}.name`,
        message: "Letters, digits and underscores only, and cannot start with a digit.",
      });
    } else if (seen.has(name)) {
      errors.push({ path: `variables.${index}.name`, message: "Already used by another variable." });
    } else {
      seen.add(name);
    }

    if (type === "number" && !Number.isFinite(Number(previewValue))) {
      errors.push({ path: `variables.${index}.previewValue`, message: "Must be a number." });
    }
    if (type === "boolean" && previewValue !== "true" && previewValue !== "false") {
      errors.push({ path: `variables.${index}.previewValue`, message: "Must be true or false." });
    }

    const id = typeof record.id === "string" && record.id !== "" ? record.id : `var-${index}`;
    variables.push({ id, type, name, previewValue });
  });

  return variables;
}

function validateVad(value: unknown, errors: FieldError[]): VadConfig {
  const record = asRecord(value);
  if (!record) {
    errors.push({ path: "models.vad", message: "Must be an object." });
    return { startSensitivity: "high", endSensitivity: "high", silenceDurationMs: 400, prefixPaddingMs: 20 };
  }
  return {
    startSensitivity: readEnum(
      record.startSensitivity, "models.vad.startSensitivity", SENSITIVITIES, errors, "high",
    ),
    endSensitivity: readEnum(
      record.endSensitivity, "models.vad.endSensitivity", SENSITIVITIES, errors, "high",
    ),
    silenceDurationMs: readNumber(
      record.silenceDurationMs, "models.vad.silenceDurationMs", LIMITS.silenceDurationMs, errors, 400,
    ),
    prefixPaddingMs: readNumber(
      record.prefixPaddingMs, "models.vad.prefixPaddingMs", LIMITS.prefixPaddingMs, errors, 20,
    ),
  };
}

function validateModels(value: unknown, errors: FieldError[]): ModelsConfig {
  const record = asRecord(value) ?? {};
  if (asRecord(value) === null) {
    errors.push({ path: "models", message: "Must be an object." });
  }

  const liveModel = readString(record.liveModel, "models.liveModel", errors, "").trim();
  if (liveModel === "") errors.push({ path: "models.liveModel", message: "Required." });

  const voice = readString(record.voice, "models.voice", errors, "").trim();
  if (voice === "") errors.push({ path: "models.voice", message: "Required." });

  const languageCode = readString(record.languageCode, "models.languageCode", errors, "").trim();
  if (languageCode === "") errors.push({ path: "models.languageCode", message: "Required." });

  return {
    liveModel,
    voice,
    languageCode,
    // Absent on every config saved before the toggle existed; defaulting true
    // preserves exactly what those calls did.
    transcripts: record.transcripts === undefined
      ? true
      : readBoolean(record.transcripts, "models.transcripts", errors),
    temperature: readNumber(record.temperature, "models.temperature", LIMITS.temperature, errors, 0.7),
    topP: readNumber(record.topP, "models.topP", LIMITS.topP, errors, 0.9),
    vad: validateVad(record.vad, errors),
  };
}

function validateWelcome(value: unknown, errors: FieldError[]): WelcomeConfig {
  const record = asRecord(value) ?? {};
  if (asRecord(value) === null) {
    errors.push({ path: "welcome", message: "Must be an object." });
  }

  const enabled = readBoolean(record.enabled, "welcome.enabled", errors);
  const message = readString(record.message, "welcome.message", errors, "");
  const allowInterrupt = readBoolean(record.allowInterrupt, "welcome.allowInterrupt", errors);

  if (message.length > LIMITS.welcomeMax) {
    errors.push({ path: "welcome.message", message: `At most ${LIMITS.welcomeMax} characters.` });
  }
  if (enabled && message.trim() === "") {
    errors.push({ path: "welcome.message", message: "Required when the welcome message is on." });
  }

  return { enabled, message, allowInterrupt };
}

/**
 * Absent on every configuration saved before the agent could hang up, so it
 * defaults rather than failing — requiring it would reset those users to seed
 * defaults on the next read.
 *
 * The default is ENABLED, matching a freshly seeded config. Defaulting it off
 * would mean an existing agent silently lacked the ability while a new one had
 * it, and the difference would only show up as an agent announcing it is ending
 * a call and then carrying on listening. The shipped policy is conservative:
 * abuse ends a call, confusion never does.
 */
function validateCallEnding(value: unknown, errors: FieldError[]): CallEndingConfig {
  if (value === undefined) return { enabled: true, policy: DEFAULT_END_CALL_POLICY };

  const record = asRecord(value);
  if (!record) {
    errors.push({ path: "callEnding", message: "Must be an object." });
    return { enabled: true, policy: DEFAULT_END_CALL_POLICY };
  }

  const enabled = readBoolean(record.enabled, "callEnding.enabled", errors);
  const policy = readString(record.policy, "callEnding.policy", errors, "");

  if (policy.length > LIMITS.instructionsMax) {
    errors.push({
      path: "callEnding.policy",
      message: `At most ${LIMITS.instructionsMax} characters.`,
    });
  }
  if (enabled && policy.trim() === "") {
    errors.push({
      path: "callEnding.policy",
      message: "Required when the agent is allowed to end calls.",
    });
  }

  return { enabled, policy };
}

const SUMMARY_LANGUAGES: readonly SummaryLanguage[] = ["en", "bn"];

/** The default summariser: the cheapest model that writes a usable paragraph. */
export const DEFAULT_SUMMARY_MODEL = "gemini-2.5-flash";

/**
 * Absent on every configuration saved before summaries existed.
 *
 * Defaults to ON, matching a freshly seeded config — the alternative is a
 * setting that silently does nothing for existing agents. Each summary costs a
 * fraction of a cent and is recorded separately in the call log, so the spend
 * is visible rather than folded into the call.
 */
function validateSummary(value: unknown, errors: FieldError[]): SummaryConfig {
  const fallback: SummaryConfig = {
    enabled: true,
    language: "en",
    model: DEFAULT_SUMMARY_MODEL,
  };
  if (value === undefined) return fallback;

  const record = asRecord(value);
  if (!record) {
    errors.push({ path: "summary", message: "Must be an object." });
    return fallback;
  }

  const model = readString(record.model, "summary.model", errors, DEFAULT_SUMMARY_MODEL).trim();
  if (model === "") errors.push({ path: "summary.model", message: "Required." });

  return {
    enabled: readBoolean(record.enabled, "summary.enabled", errors),
    language: readEnum(record.language, "summary.language", SUMMARY_LANGUAGES, errors, "en"),
    model,
  };
}

/**
 * Validates an untrusted config. Errors accumulate rather than short-circuit so
 * the form can highlight every bad field at once.
 *
 * `secretKeys` and `updatedAt` are always discarded — the server owns both.
 */
export function validateAgentConfig(input: unknown): ValidationResult {
  const record = asRecord(input);
  if (!record) {
    return { ok: false, errors: [{ path: "", message: "Expected a configuration object." }] };
  }

  const errors: FieldError[] = [];

  const type = readEnum<ConversationType>(
    record.type, "type", ["open_ended", "data_collection"], errors, "open_ended",
  );
  if (type === "data_collection") {
    errors.push({ path: "type", message: "Data collection is not supported yet." });
  }

  const instructions = readString(record.instructions, "instructions", errors, "");
  if (instructions.trim() === "") {
    errors.push({ path: "instructions", message: "Required." });
  } else if (instructions.length > LIMITS.instructionsMax) {
    errors.push({
      path: "instructions",
      message: `At most ${LIMITS.instructionsMax} characters.`,
    });
  }

  const agentName = readString(record.agentName, "agentName", errors, "").trim();
  if (!AGENT_NAME_RE.test(agentName)) {
    errors.push({
      path: "agentName",
      message: `Lowercase letters, digits and hyphens, 2 to ${LIMITS.agentNameMax} characters.`,
    });
  }

  const welcome = validateWelcome(record.welcome, errors);
  const callEnding = validateCallEnding(record.callEnding, errors);
  const summary = validateSummary(record.summary, errors);
  const models = validateModels(record.models, errors);
  const variables = validateVariables(record.variables, errors);
  const tools = validateTools(record.tools, errors);

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    config: {
      version: AGENT_CONFIG_VERSION,
      type: "open_ended",
      instructions,
      welcome,
      callEnding,
      summary,
      models,
      agentName,
      variables,
      tools,
      secretKeys: [],
      updatedAt: new Date().toISOString(),
    },
  };
}
