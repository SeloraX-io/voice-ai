/**
 * Turns a stored config into the exact values a call will use.
 *
 * Resolution happens once, at the start of a call. An in-flight call keeps the
 * config it started with — a prompt must never change underneath a live
 * conversation.
 */

import { END_CALL_TOOL_NAME } from "./tool-declarations";
import type {
  AgentConfig,
  CallEndingConfig,
  ModelsConfig,
  SummaryConfig,
  WelcomeConfig,
} from "./schema";
import type { ToolsConfig } from "./tools";
import { interpolate } from "./template";

export interface ResolvedAgentConfig {
  agentName: string;
  /** Instructions with every declared `{variable}` already substituted. */
  instructions: string;
  welcome: WelcomeConfig;
  callEnding: CallEndingConfig;
  summary: SummaryConfig;
  models: ModelsConfig;
  tools: ToolsConfig;
}

export function resolveAgentConfig(config: AgentConfig): ResolvedAgentConfig {
  return {
    agentName: config.agentName,
    instructions: interpolate(config.instructions, config.variables),
    welcome: {
      ...config.welcome,
      message: interpolate(config.welcome.message, config.variables),
    },
    callEnding: {
      ...config.callEnding,
      policy: interpolate(config.callEnding.policy, config.variables),
    },
    summary: config.summary,
    models: config.models,
    tools: config.tools,
  };
}

/**
 * Appended when no greeting will be primed, so the prompt describes the call
 * the agent is actually on. Without it, instructions that mention opening the
 * call order behaviour the agent cannot perform — the model never gets a first
 * turn unless the gateway primes one, and it only primes when the welcome
 * message is enabled.
 */
export const WAIT_FOR_CALLER_DIRECTIVE =
  "The caller speaks first. Do not deliver a scripted opening; respond directly to whatever the caller says.";

/**
 * The system instruction actually sent to Gemini.
 *
 * Gemini Live has no "say this first" field, so an enabled welcome message
 * becomes a directive appended to the prompt. It is an instruction to a
 * language model, so expect near-verbatim delivery rather than byte-exact.
 *
 * The opening is stated in BOTH branches on purpose: either the exact greeting,
 * or the fact that the caller speaks first. The two branches mirror the
 * gateway's primeGreeting condition exactly, which is what keeps the prompt and
 * the agent's actual behaviour from contradicting each other.
 */
export function buildSystemInstruction(resolved: ResolvedAgentConfig): string {
  const sections = [resolved.instructions];

  const greeting = resolved.welcome.message.trim();
  if (resolved.welcome.enabled && greeting !== "") {
    sections.push(`Open the call by saying exactly: "${greeting}"`);
  } else {
    sections.push(WAIT_FOR_CALLER_DIRECTIVE);
  }

  // The policy alone is not enough: the model also has to be told the mechanism,
  // or it will announce that it is ending the call and then keep listening.
  const policy = resolved.callEnding.policy.trim();
  if (resolved.callEnding.enabled && policy !== "") {
    sections.push(
      `Ending the call\n\n${policy}\n\nTo end a call, call the ${END_CALL_TOOL_NAME} function ` +
        `with a short reason. Say your closing line first; the call ends once you stop speaking.`,
    );
  }

  return sections.join("\n\n");
}
