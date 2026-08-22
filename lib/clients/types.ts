/**
 * Clients: the tenants of this console.
 *
 * Each client owns its own agent configuration, secrets, call history and
 * embed snippet. Everything else — API keys, telephony, the gateway itself —
 * is deployment-level and stays shared.
 *
 * Pure types and constants, shared by the browser, the Next routes and the
 * voice gateway, so all three agree on what a client id looks like.
 */

export interface ClientSummary {
  /** Stable slug, e.g. "acme-dental". Appears in embed snippets and call URLs. */
  id: string;
  name: string;
  createdAt: string;
}

/**
 * The seed client every deployment has.
 *
 * Deliberately the literal `"singleton"`: that is the `_id` the pre-client
 * config document was stored under, so the default client reads the existing
 * configuration with no migration at all. Legacy secrets and call records —
 * written before anything carried a client id — belong to this client too.
 */
export const DEFAULT_CLIENT_ID = "singleton";
export const DEFAULT_CLIENT_NAME = "Default";

/**
 * Also what an embed or gateway URL may carry. Matches AGENT_NAME_RE's shape:
 * lowercase slugs read well in a script tag and cannot smuggle a Mongo
 * operator or a query-string delimiter.
 */
export const CLIENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const CLIENT_NAME_MAX = 80;
export const CLIENTS_MAX = 200;

/** Where the console remembers which client is being worked on. */
export const ACTIVE_CLIENT_COOKIE = "voice-ai-client";

/** The id as carried in untrusted input, or null if it is not one. */
export function normaliseClientId(value: string | null | undefined): string | null {
  const id = (value ?? "").trim();
  return CLIENT_ID_RE.test(id) ? id : null;
}
