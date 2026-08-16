/**
 * Who is allowed to open a call.
 *
 * The gateway spends the owner's money the moment a connection is accepted — a
 * Gemini session is opened for it — so the key is checked during the HTTP
 * upgrade, before the socket exists and before anything is billed. Rejecting a
 * connection later, once it is established, would already be too late.
 *
 * Kept apart from the socket plumbing so the accept/reject decision can be
 * tested on its own, with no server listening and no Gemini anywhere near it.
 *
 * Enforcement is opt-in: `VOICE_GATEWAY_REQUIRE_KEY` defaults off so a checkout
 * still runs with `npm run dev` and no setup. Turning it on is a deployment
 * decision, not a development one.
 */

import type { IncomingMessage } from "node:http";

import type { ApiKeySummary } from "../../lib/api-keys/types";

/**
 * Base for parsing `request.url`, which on an upgrade is only ever the path and
 * query string — the server never sees an absolute URL. Shared with the call
 * origin parsing in the gateway so there is one placeholder, not two.
 */
export const UPGRADE_URL_BASE = "http://voice-gateway.invalid";

/** Just enough of an upgrade request to make a decision about it. */
export type UpgradeRequestLike = Pick<IncomingMessage, "headers"> & { url?: string };

export type UpgradeDecision =
  | { ok: true; key: ApiKeySummary | null }
  | { ok: false; status: number; message: string; reason: string };

export interface UpgradeAuthOptions {
  /** Whether a key is demanded at all. */
  requireKey: boolean;
  /** Usually `apiKeyStore.verify`; injected so tests need no filesystem. */
  verify: (presented: string) => Promise<ApiKeySummary | null>;
}

/** Parses `request.url` against the placeholder base. Never throws. */
export function upgradeUrl(request: UpgradeRequestLike): URL {
  return new URL(request.url ?? "", UPGRADE_URL_BASE);
}

/**
 * The key the client presented, from either accepted place.
 *
 * The header is the conventional form and wins when both are present. The query
 * parameter is not laziness: the browser `WebSocket` constructor cannot set
 * headers, and the softphone bridge — the thing that answers real phone calls —
 * is a browser.
 */
export function readPresentedKey(request: UpgradeRequestLike): string | null {
  const header = request.headers.authorization;
  if (typeof header === "string") {
    const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
  }

  const fromQuery = upgradeUrl(request).searchParams.get("key");
  if (fromQuery !== null && fromQuery.trim() !== "") return fromQuery.trim();

  return null;
}

/** Whether `VOICE_GATEWAY_REQUIRE_KEY` is switched on. Off unless it is. */
export function apiKeyRequired(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.VOICE_GATEWAY_REQUIRE_KEY?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/**
 * Accept or reject an upgrade.
 *
 * A missing key and a wrong key get the same answer, so the response cannot be
 * used to tell one from the other. A revoked key is simply a key that is no
 * longer there: it fails the next upgrade, while calls already in flight on it
 * run to their end — cutting a caller off mid-sentence is worse than letting
 * one call finish.
 */
export async function authorizeUpgrade(
  request: UpgradeRequestLike,
  options: UpgradeAuthOptions,
): Promise<UpgradeDecision> {
  // Nothing is read from disk when enforcement is off, so the default path
  // costs an environment lookup and nothing else.
  if (!options.requireKey) return { ok: true, key: null };

  const presented = readPresentedKey(request);
  if (presented === null) {
    return { ok: false, status: 401, message: "Unauthorized", reason: "no key presented" };
  }

  const key = await options.verify(presented);
  if (!key) {
    return { ok: false, status: 401, message: "Unauthorized", reason: "unrecognised key" };
  }

  return { ok: true, key };
}
