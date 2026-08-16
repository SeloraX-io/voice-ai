/**
 * The agent configuration contract.
 *
 * Shared by the browser and the gateway, and deliberately free of imports so
 * either side can use it. `validateAgentConfig` is the only validation
 * implementation: the form calls it for inline feedback, and the PUT handler
 * calls it again on the raw body. The server never trusts the client's copy.
 */

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
  liveModel: string;
  voice: string;
  languageCode: string;
  temperature: number;
  topP: number;
  vad: VadConfig;
}

export interface AgentConfig {
  version: number;
  type: ConversationType;
  instructions: string;
  welcome: WelcomeConfig;
  models: ModelsConfig;
  agentName: string;
  variables: AgentVariable[];
  /** Names only. Values live in a separate gitignored file, server-side. */
  secretKeys: string[];
  updatedAt: string;
}

export interface FieldError {
  /** Dotted path, e.g. "variables.0.name". Empty string means the whole body. */
  path: string;
  message: string;
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(
  value: unknown,
  path: string,
  errors: FieldError[],
  fallback: string,
): string {
  if (typeof value !== "string") {
    errors.push({ path, message: "Must be text." });
    return fallback;
  }
  return value;
}

function readBoolean(value: unknown, path: string, errors: FieldError[]): boolean {
  if (typeof value !== "boolean") {
    errors.push({ path, message: "Must be true or false." });
    return false;
  }
  return value;
}

function readNumber(
  value: unknown,
  path: string,
  range: { min: number; max: number },
  errors: FieldError[],
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push({ path, message: "Must be a number." });
    return fallback;
  }
  if (value < range.min || value > range.max) {
    errors.push({ path, message: `Must be between ${range.min} and ${range.max}.` });
    return fallback;
  }
  return value;
}

function readEnum<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
  errors: FieldError[],
  fallback: T,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    errors.push({ path, message: `Must be one of: ${allowed.join(", ")}.` });
    return fallback;
  }
  return value as T;
}

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
  const models = validateModels(record.models, errors);
  const variables = validateVariables(record.variables, errors);

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    config: {
      version: AGENT_CONFIG_VERSION,
      type: "open_ended",
      instructions,
      welcome,
      models,
      agentName,
      variables,
      secretKeys: [],
      updatedAt: new Date().toISOString(),
    },
  };
}
