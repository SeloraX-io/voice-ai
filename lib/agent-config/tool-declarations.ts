/**
 * Turns configured tools into the function declarations Gemini is given.
 *
 * Pure and free of the SDK: the shapes below are plain objects that match the
 * `FunctionDeclaration` contract, so this can be unit tested without a live
 * session and without importing anything Node-only.
 *
 * Only tools the gateway can actually run are declared. Offering the model a
 * function that cannot execute is worse than not offering it — it will call it,
 * wait, and then apologise to the caller for something that was never wired up.
 */

import type { CallChannel } from "../call-logs/channel";
import type { ClientTool, HttpTool, ToolParameter, ToolsConfig } from "./tools";

/** Matches the SDK's `Schema`, whose `type` is a string enum. */
interface JsonSchema {
  type: "OBJECT" | "STRING" | "NUMBER" | "BOOLEAN";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
}

export interface FunctionDeclarationShape {
  name: string;
  description: string;
  parameters?: JsonSchema;
}

/** The name the model calls to hang up. Reserved: a configured tool may not use it. */
export const END_CALL_TOOL_NAME = "end_call";

/**
 * Always offered, never configured.
 *
 * The `reason` is required because it lands in the call log — a hang-up whose
 * cause is unrecorded tells you a call ended early but never why, which is the
 * one thing worth knowing when reviewing them.
 */
export const END_CALL_DECLARATION: FunctionDeclarationShape = {
  name: END_CALL_TOOL_NAME,
  description:
    "End the phone call. Use this only after you have said a closing line to the caller, " +
    "because the call ends as soon as you finish speaking. Give a short reason.",
  parameters: {
    type: "OBJECT",
    properties: {
      reason: {
        type: "STRING",
        description:
          "Why the call is ending, in a few words. For example: caller was abusive, " +
          "caller kept talking about unrelated things, issue resolved, caller asked to hang up.",
      },
    },
    required: ["reason"],
  },
};

const PARAM_TYPE: Record<ToolParameter["type"], JsonSchema["type"]> = {
  string: "STRING",
  number: "NUMBER",
  boolean: "BOOLEAN",
  // The model still produces text; the gateway parses that text into a real
  // object before the request is sent. See tool-runner.ts.
  json: "STRING",
};

/**
 * A json-typed parameter needs the model to actually emit valid JSON, which
 * its declared description does not otherwise say. Appended rather than left
 * to the tool author to remember, so a forgotten instruction cannot turn into
 * a parse failure the model has no way to explain to the caller.
 */
function describeParameter(parameter: ToolParameter): string {
  if (parameter.type !== "json") return parameter.description;
  return `${parameter.description} Respond with a valid JSON object string.`;
}

function parametersSchema(parameters: ToolParameter[]): JsonSchema | undefined {
  const named = parameters.filter((parameter) => parameter.name !== "");
  if (named.length === 0) return undefined;

  const properties: Record<string, JsonSchema> = {};
  for (const parameter of named) {
    properties[parameter.name] = {
      type: PARAM_TYPE[parameter.type],
      description: describeParameter(parameter),
    };
  }

  const required = named.filter((parameter) => parameter.required).map((parameter) => parameter.name);

  return { type: "OBJECT", properties, ...(required.length > 0 ? { required } : {}) };
}

function declare(tool: HttpTool | ClientTool): FunctionDeclarationShape {
  const declaration: FunctionDeclarationShape = {
    name: tool.name,
    description: tool.description,
  };
  const parameters = parametersSchema(tool.parameters);
  if (parameters) declaration.parameters = parameters;
  return declaration;
}

/**
 * Every function the model may call this session.
 *
 * Client tools are deliberately absent: running them needs a browser handler
 * that does not exist yet, so declaring them would invite a call the gateway
 * could only fail. Incomplete or unnamed tools are skipped for the same reason
 * — a half-typed draft is not something to hand the model.
 *
 * `end_call` is appended last and cannot be shadowed: a configured tool sharing
 * its name is dropped, so hanging up always means hanging up.
 *
 * On a `"phone"` channel no configured tool is declared at all. That is a
 * product decision, not a capability gap: an HTTP tool that takes three seconds
 * is a pause in a browser preview but dead air on a live line, and the first
 * phone calls are meant to answer "can the agent hold a conversation" without a
 * tool call in the way. `end_call` still stands, because hanging up on an
 * abusive caller is call control rather than a business tool.
 */
export function toolDeclarations(
  tools: ToolsConfig,
  options: { canEndCall: boolean; channel?: CallChannel },
): FunctionDeclarationShape[] {
  // Defaults to the browser, so every existing caller of this function — and
  // the preview it drives — keeps exactly the tools it has today.
  const usable =
    options.channel === "phone"
      ? []
      : tools.http.filter(
          (tool) =>
            tool.name !== "" && tool.name !== END_CALL_TOOL_NAME && tool.description.trim() !== "",
        );

  const declarations = usable.map(declare);
  if (options.canEndCall) declarations.push(END_CALL_DECLARATION);
  return declarations;
}
