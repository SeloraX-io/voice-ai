/**
 * The SIP line the bridge registers as.
 *
 * These are the same five values the SeloraX dashboard receives from
 * `GET /api/calling/extension` and hands to JsSIP. They are pasted in by an
 * operator for now — see the spec's "Credentials, for now".
 *
 * Absent credentials validate to the empty set rather than failing, because
 * `read()` validates on the way out: a first run with no file must not throw.
 */

import type { FieldError } from "../agent-config/validate-helpers";

export interface SipCredentials {
  /** The SIP-over-WebSocket endpoint, e.g. wss://host:8089/ws */
  wsUrl: string;
  /** The line's own address, e.g. sip:ext-8@host */
  sipUri: string;
  sipDomain: string;
  extension: string;
  /** SIP digest password. Needed in the browser; there is no way around it. */
  password: string;
}

export const EMPTY_CREDENTIALS: SipCredentials = {
  wsUrl: "",
  sipUri: "",
  sipDomain: "",
  extension: "",
  password: "",
};

export type CredentialsResult =
  | { ok: true; value: SipCredentials }
  | { ok: false; errors: FieldError[] };

function read(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value.trim() : "";
}

export function isConfigured(creds: SipCredentials): boolean {
  return Object.values(creds).every((value) => value.length > 0);
}

export function validateSipCredentials(value: unknown): CredentialsResult {
  if (value === undefined || value === null) return { ok: true, value: EMPTY_CREDENTIALS };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: [{ path: "", message: "Expected an object." }] };
  }

  const source = value as Record<string, unknown>;
  const parsed: SipCredentials = {
    wsUrl: read(source, "wsUrl"),
    sipUri: read(source, "sipUri"),
    sipDomain: read(source, "sipDomain"),
    extension: read(source, "extension"),
    password: read(source, "password"),
  };

  // An entirely empty object is "not configured yet", not a validation error —
  // that is the state the page starts in.
  if (Object.values(parsed).every((field) => field.length === 0)) {
    return { ok: true, value: EMPTY_CREDENTIALS };
  }

  // Every missing field is reported at once: an operator pasting five values
  // should not have to submit five times to find all the mistakes.
  const errors: FieldError[] = [];
  for (const [key, label] of [
    ["wsUrl", "The WebSocket URL"],
    ["sipUri", "The SIP URI"],
    ["sipDomain", "The SIP domain"],
    ["extension", "The extension"],
    ["password", "The password"],
  ] as const) {
    if (parsed[key].length === 0) errors.push({ path: key, message: `${label} is required.` });
  }

  if (parsed.wsUrl.length > 0 && !/^wss?:\/\//i.test(parsed.wsUrl)) {
    errors.push({ path: "wsUrl", message: "Must start with ws:// or wss://." });
  }
  if (parsed.sipUri.length > 0 && !/^sip:/i.test(parsed.sipUri)) {
    errors.push({ path: "sipUri", message: "Must start with sip:." });
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: parsed };
}
