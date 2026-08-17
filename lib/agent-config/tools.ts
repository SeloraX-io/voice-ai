/**
 * Tool and webhook definitions.
 *
 * Separate from `schema.ts` so neither file has to hold two unrelated shapes,
 * and pure so the browser and the gateway can both import it.
 *
 * Nothing here executes anything. These are definitions the next phase turns
 * into function declarations and HTTP calls.
 */

import {
  asRecord,
  readBoolean,
  readEnum,
  readString,
  type FieldError,
} from "./validate-helpers";

export type ToolValueType = "string" | "number" | "boolean";
export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";
export type WebhookEvent = "call_started" | "call_ended" | "transcript_ready";
export type RetryPolicy = "none" | "once" | "backoff";

export const HTTP_METHODS: readonly HttpMethod[] = ["GET", "POST", "PATCH", "DELETE"];
export const WEBHOOK_EVENTS: readonly WebhookEvent[] = [
  "call_started",
  "call_ended",
  "transcript_ready",
];
export const RETRY_POLICIES: readonly RetryPolicy[] = ["none", "once", "backoff"];
const VALUE_TYPES: readonly ToolValueType[] = ["string", "number", "boolean"];

/** Lowercase snake case, because these become function names the model calls. */
export const TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/;
export const HEADER_NAME_RE = /^[A-Za-z0-9-]+$/;

export const TOOL_LIMITS = {
  toolsMax: 25,
  parametersMax: 25,
  headersMax: 25,
  nameMax: 64,
  descriptionMax: 2_000,
  urlMax: 2_000,
} as const;

export interface ToolParameter {
  id: string;
  name: string;
  type: ToolValueType;
  description: string;
  required: boolean;
}

export interface ToolHeader {
  id: string;
  name: string;
  /** May contain {{SECRET_NAME}}; resolved server-side when execution ships. */
  value: string;
}

export interface HttpTool {
  id: string;
  name: string;
  description: string;
  method: HttpMethod;
  url: string;
  parameters: ToolParameter[];
  headers: ToolHeader[];
  silent: boolean;
}

export interface ClientTool {
  id: string;
  name: string;
  description: string;
  parameters: ToolParameter[];
  awaitResult: boolean;
}

export interface Webhook {
  id: string;
  name: string;
  description: string;
  method: HttpMethod;
  url: string;
  headers: ToolHeader[];
  queryParams: ToolHeader[];
  events: WebhookEvent[];
  retry: RetryPolicy;
}

export interface ToolsConfig {
  http: HttpTool[];
  client: ClientTool[];
  webhooks: Webhook[];
}

export const EMPTY_TOOLS: ToolsConfig = { http: [], client: [], webhooks: [] };

const BRACE_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Every distinct `{brace}` identifier in a URL, in first-appearance order. */
export function bracedParams(url: string): string[] {
  const seen = new Set<string>();
  for (const match of url.matchAll(BRACE_RE)) seen.add(match[1]);
  return [...seen];
}

/**
 * A tool URL is absolute http(s), but only after its brace segments are
 * substituted — `https://x/{id}` is not a parseable URL as written.
 */
export function isValidToolUrl(url: string): boolean {
  try {
    const parsed = new URL(url.replace(BRACE_RE, "x"));
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function validateName(
  raw: unknown,
  path: string,
  errors: FieldError[],
  taken: Set<string>,
): string {
  const name = readString(raw, path, errors, "").trim();
  if (name.length > TOOL_LIMITS.nameMax) {
    errors.push({ path, message: `At most ${TOOL_LIMITS.nameMax} characters.` });
  } else if (!TOOL_NAME_RE.test(name)) {
    errors.push({
      path,
      message: "Lowercase letters, digits and underscores, starting with a letter.",
    });
  } else if (taken.has(name)) {
    errors.push({ path, message: "Another action already uses this name." });
  } else {
    taken.add(name);
  }
  return name;
}

function validateDescription(raw: unknown, path: string, errors: FieldError[]): string {
  const description = readString(raw, path, errors, "");
  if (description.trim() === "") {
    errors.push({ path, message: "Required — the agent reads this to decide when to use it." });
  } else if (description.length > TOOL_LIMITS.descriptionMax) {
    errors.push({ path, message: `At most ${TOOL_LIMITS.descriptionMax} characters.` });
  }
  return description;
}

function validateUrl(raw: unknown, path: string, errors: FieldError[]): string {
  const url = readString(raw, path, errors, "").trim();
  if (url.length > TOOL_LIMITS.urlMax) {
    errors.push({ path, message: `At most ${TOOL_LIMITS.urlMax} characters.` });
  } else if (!isValidToolUrl(url)) {
    errors.push({ path, message: "Must be an absolute http:// or https:// URL." });
  }
  return url;
}

function validateParameters(
  value: unknown,
  path: string,
  errors: FieldError[],
): ToolParameter[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push({ path, message: "Must be a list." });
    return [];
  }
  if (value.length > TOOL_LIMITS.parametersMax) {
    errors.push({ path, message: `At most ${TOOL_LIMITS.parametersMax} parameters.` });
  }

  const seen = new Set<string>();
  const parameters: ToolParameter[] = [];

  value.forEach((raw, index) => {
    const record = asRecord(raw);
    if (!record) {
      errors.push({ path: `${path}.${index}`, message: "Must be an object." });
      return;
    }
    const name = validateName(record.name, `${path}.${index}.name`, errors, seen);
    parameters.push({
      id: typeof record.id === "string" && record.id !== "" ? record.id : `param-${index}`,
      name,
      type: readEnum(record.type, `${path}.${index}.type`, VALUE_TYPES, errors, "string"),
      description: readString(record.description, `${path}.${index}.description`, errors, ""),
      required: readBoolean(record.required, `${path}.${index}.required`, errors),
    });
  });

  return parameters;
}

function validateHeaders(value: unknown, path: string, errors: FieldError[]): ToolHeader[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push({ path, message: "Must be a list." });
    return [];
  }
  if (value.length > TOOL_LIMITS.headersMax) {
    errors.push({ path, message: `At most ${TOOL_LIMITS.headersMax} entries.` });
  }

  return value.map((raw, index) => {
    const record = asRecord(raw);
    if (!record) {
      errors.push({ path: `${path}.${index}`, message: "Must be an object." });
      return { id: `header-${index}`, name: "", value: "" };
    }
    const name = readString(record.name, `${path}.${index}.name`, errors, "").trim();
    if (!HEADER_NAME_RE.test(name)) {
      errors.push({
        path: `${path}.${index}.name`,
        message: "Letters, digits and hyphens only.",
      });
    }
    return {
      id: typeof record.id === "string" && record.id !== "" ? record.id : `header-${index}`,
      name,
      value: readString(record.value, `${path}.${index}.value`, errors, ""),
    };
  });
}

function validateEvents(value: unknown, path: string, errors: FieldError[]): WebhookEvent[] {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push({ path, message: "Pick at least one event." });
    return [];
  }
  return value.map((raw, index) =>
    readEnum(raw, `${path}.${index}`, WEBHOOK_EVENTS, errors, "call_ended"),
  );
}

function validateList<T>(
  value: unknown,
  path: string,
  errors: FieldError[],
  each: (record: Record<string, unknown>, path: string, index: number) => T,
): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push({ path, message: "Must be a list." });
    return [];
  }
  if (value.length > TOOL_LIMITS.toolsMax) {
    errors.push({ path, message: `At most ${TOOL_LIMITS.toolsMax}.` });
  }

  const out: T[] = [];
  value.forEach((raw, index) => {
    const record = asRecord(raw);
    if (!record) {
      errors.push({ path: `${path}.${index}`, message: "Must be an object." });
      return;
    }
    out.push(each(record, `${path}.${index}`, index));
  });
  return out;
}

/**
 * Validates the whole tools block.
 *
 * `undefined` is the ordinary upgrade path, not an error: every configuration
 * saved before this feature lacks the field, and `store.read()` validates on
 * the way out — so requiring it would silently reset those users' prompt,
 * voice and variables to seed defaults.
 *
 * HTTP and client tool names share one `taken` set because both kinds are
 * declared to the model in a single namespace; a collision would make one
 * unreachable. Webhooks get their own set — nothing calls them by name.
 */
export function validateTools(value: unknown, errors: FieldError[]): ToolsConfig {
  if (value === undefined) return { http: [], client: [], webhooks: [] };

  const record = asRecord(value);
  if (!record) {
    errors.push({ path: "tools", message: "Must be an object." });
    return { http: [], client: [], webhooks: [] };
  }

  const takenToolNames = new Set<string>();

  const http = validateList<HttpTool>(record.http, "tools.http", errors, (item, path, index) => ({
    id: typeof item.id === "string" && item.id !== "" ? item.id : `http-${index}`,
    name: validateName(item.name, `${path}.name`, errors, takenToolNames),
    description: validateDescription(item.description, `${path}.description`, errors),
    method: readEnum(item.method, `${path}.method`, HTTP_METHODS, errors, "GET"),
    url: validateUrl(item.url, `${path}.url`, errors),
    parameters: validateParameters(item.parameters, `${path}.parameters`, errors),
    headers: validateHeaders(item.headers, `${path}.headers`, errors),
    silent: readBoolean(item.silent, `${path}.silent`, errors),
  }));

  const client = validateList<ClientTool>(
    record.client,
    "tools.client",
    errors,
    (item, path, index) => ({
      id: typeof item.id === "string" && item.id !== "" ? item.id : `client-${index}`,
      name: validateName(item.name, `${path}.name`, errors, takenToolNames),
      description: validateDescription(item.description, `${path}.description`, errors),
      parameters: validateParameters(item.parameters, `${path}.parameters`, errors),
      awaitResult: readBoolean(item.awaitResult, `${path}.awaitResult`, errors),
    }),
  );

  const takenWebhookNames = new Set<string>();

  const webhooks = validateList<Webhook>(
    record.webhooks,
    "tools.webhooks",
    errors,
    (item, path, index) => ({
      id: typeof item.id === "string" && item.id !== "" ? item.id : `hook-${index}`,
      name: validateName(item.name, `${path}.name`, errors, takenWebhookNames),
      description: validateDescription(item.description, `${path}.description`, errors),
      method: readEnum(item.method, `${path}.method`, HTTP_METHODS, errors, "POST"),
      url: validateUrl(item.url, `${path}.url`, errors),
      headers: validateHeaders(item.headers, `${path}.headers`, errors),
      queryParams: validateHeaders(item.queryParams, `${path}.queryParams`, errors),
      events: validateEvents(item.events, `${path}.events`, errors),
      retry: readEnum(item.retry, `${path}.retry`, RETRY_POLICIES, errors, "backoff"),
    }),
  );

  return { http, client, webhooks };
}
