/**
 * `{variable}` substitution for the instructions and welcome message.
 *
 * Substitution is single-pass on purpose: a preview value that itself contains
 * a token is inserted literally rather than expanded again. That rules out both
 * recursion and the surprise of a value quietly rewriting itself.
 */

import type { AgentVariable } from "./schema";

/** Matches `{name}` where `name` is a JavaScript-style identifier. */
const TOKEN_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Every distinct token in `text`, in first-appearance order. */
export function findTokens(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(TOKEN_RE)) {
    seen.add(match[1]);
  }
  return [...seen];
}

/** The preview value as the string that will actually reach the prompt. */
export function coercePreviewValue(variable: AgentVariable): string {
  if (variable.type === "number") {
    const parsed = Number(variable.previewValue);
    return Number.isFinite(parsed) ? String(parsed) : "";
  }
  if (variable.type === "boolean") {
    return variable.previewValue === "true" ? "true" : "false";
  }
  return variable.previewValue;
}

/** Replaces declared tokens. Undeclared tokens are left exactly as written. */
export function interpolate(text: string, variables: AgentVariable[]): string {
  if (variables.length === 0) return text;

  const values = new Map<string, string>();
  for (const variable of variables) {
    values.set(variable.name, coercePreviewValue(variable));
  }

  return text.replace(TOKEN_RE, (whole, name: string) => values.get(name) ?? whole);
}

/** Tokens present in `text` that no variable declares. Drives the editor warning. */
export function findUnknownTokens(text: string, variables: AgentVariable[]): string[] {
  const declared = new Set(variables.map((variable) => variable.name));
  return findTokens(text).filter((token) => !declared.has(token));
}
