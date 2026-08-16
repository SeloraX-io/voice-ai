/**
 * Turns a stored config into the exact values a call will use.
 *
 * Resolution happens once, at the start of a call. An in-flight call keeps the
 * config it started with — a prompt must never change underneath a live
 * conversation.
 */

import type { AgentConfig, ModelsConfig, WelcomeConfig } from "./schema";
import { interpolate } from "./template";

export interface ResolvedAgentConfig {
  agentName: string;
  /** Instructions with every declared `{variable}` already substituted. */
  instructions: string;
  welcome: WelcomeConfig;
  models: ModelsConfig;
}

export function resolveAgentConfig(config: AgentConfig): ResolvedAgentConfig {
  return {
    agentName: config.agentName,
    instructions: interpolate(config.instructions, config.variables),
    welcome: {
      ...config.welcome,
      message: interpolate(config.welcome.message, config.variables),
    },
    models: config.models,
  };
}

/**
 * The system instruction actually sent to Gemini.
 *
 * Gemini Live has no "say this first" field, so an enabled welcome message
 * becomes a directive appended to the prompt. It is an instruction to a
 * language model, so expect near-verbatim delivery rather than byte-exact.
 */
export function buildSystemInstruction(resolved: ResolvedAgentConfig): string {
  const greeting = resolved.welcome.message.trim();
  if (!resolved.welcome.enabled || greeting === "") return resolved.instructions;
  return `${resolved.instructions}\n\nOpen the call by saying exactly: "${greeting}"`;
}
