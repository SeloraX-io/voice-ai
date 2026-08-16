/**
 * How this instance talks to SeloraX-Backend.
 *
 * `authToken` is a Selorax admin JWT for the dedicated AI user — the same
 * `x-auth-token` the dashboard keeps in a cookie. It is a powerful credential
 * and MUST NOT reach the browser: only server code reads this, and no route
 * may return it. See the spec's §3.
 */

import type { FieldError } from "../agent-config/validate-helpers";

export interface SeloraxConfig {
  /** Origin of the Selorax API, no trailing slash. */
  baseUrl: string;
  /** The AI user's x-auth-token. Server-side only. */
  authToken: string;
  /** Sent as x-store-id. A string because it travels as a header. */
  storeId: string;
}

export const EMPTY_SELORAX_CONFIG: SeloraxConfig = { baseUrl: "", authToken: "", storeId: "" };

export type SeloraxConfigResult =
  | { ok: true; value: SeloraxConfig }
  | { ok: false; errors: FieldError[] };

export function isSeloraxConfigured(config: SeloraxConfig): boolean {
  return Object.values(config).every((field) => field.length > 0);
}

/**
 * The device identity this bridge claims, derived rather than configured —
 * there is exactly one correct answer, so it should not be a field an operator
 * can get wrong. `GET /api/calling/extension` claims the device from this, and
 * a stable value keeps a restart from looking like a new device.
 */
export function deviceIdFor(storeId: string): string {
  return `ai-bridge-${storeId}`;
}

/**
 * The token's expiry, for warning the operator before it lapses. Decoded, not
 * verified — we do not hold the signing secret. Never let this drive a
 * decision: an unreadable token returns null and the request is what finds out.
 */
export function tokenExpiryMs(token: string): number | null {
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(segments[1], "base64url").toString("utf8"),
    );
    const exp = (payload as { exp?: unknown })?.exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function read(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value.trim() : "";
}

export function validateSeloraxConfig(value: unknown): SeloraxConfigResult {
  if (value === undefined || value === null) return { ok: true, value: EMPTY_SELORAX_CONFIG };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: [{ path: "", message: "Expected an object." }] };
  }

  const source = value as Record<string, unknown>;
  const parsed: SeloraxConfig = {
    baseUrl: read(source, "baseUrl").replace(/\/+$/, ""),
    authToken: read(source, "authToken"),
    storeId: read(source, "storeId"),
  };

  if (Object.values(parsed).every((field) => field.length === 0)) {
    return { ok: true, value: EMPTY_SELORAX_CONFIG };
  }

  const errors: FieldError[] = [];
  for (const [key, label] of [
    ["baseUrl", "The Selorax API URL"],
    ["authToken", "The auth token"],
    ["storeId", "The store id"],
  ] as const) {
    if (parsed[key].length === 0) errors.push({ path: key, message: `${label} is required.` });
  }

  if (parsed.baseUrl.length > 0 && !/^https?:\/\//i.test(parsed.baseUrl)) {
    errors.push({ path: "baseUrl", message: "Must start with http:// or https://." });
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: parsed };
}
