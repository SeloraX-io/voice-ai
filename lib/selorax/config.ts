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
  /**
   * The store this bridge serves. NOT sent as `x-store-id` — that header puts
   * the request on Selorax's store-switching path and gets a 401 demanding a
   * dashboard session. The token already carries the store; this only names
   * the device, via `deviceIdFor`. A string because it came from a form.
   */
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

/** What the browser is allowed to know about the connection — never the token itself. */
export interface SeloraxSummary {
  baseUrl: string;
  storeId: string;
  hasToken: boolean;
  tokenExpiresAt: number | null;
}

/**
 * Built field by field, not by spreading `config`, so a future field on
 * `SeloraxConfig` cannot silently reach the browser by being added there.
 * Shared by `GET /api/selorax` and the settings page's initial server render,
 * so the two cannot drift on what "configured" means.
 */
export function toSeloraxSummary(config: SeloraxConfig): SeloraxSummary {
  const hasToken = config.authToken.length > 0;
  return {
    baseUrl: config.baseUrl,
    storeId: config.storeId,
    hasToken,
    tokenExpiresAt: hasToken ? tokenExpiryMs(config.authToken) : null,
  };
}

/** These tokens last 90 days and lapse silently; warn well before that. */
export const TOKEN_EXPIRY_WARNING_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Whether the operator should be warned about this expiry, `now` passed in so
 * it stays a pure function a test can pin. A missing expiry (unreadable token,
 * or none stored) is never itself a warning — the "no token" state already
 * says so more plainly.
 */
export function isTokenExpiringSoon(tokenExpiresAt: number | null, now: number): boolean {
  if (tokenExpiresAt === null) return false;
  return tokenExpiresAt - now <= TOKEN_EXPIRY_WARNING_MS;
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
