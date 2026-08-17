/**
 * What an API key looks like once it has left the store.
 *
 * Kept in lib/ rather than beside the store because three places share it: the
 * store that writes it, the route handler that serves it and the console page
 * that renders it. Nothing here describes the key itself — that is the point.
 */

/** How much of a key's hash the console may see. Names a key; cannot be one. */
export const FINGERPRINT_CHARS = 8;

/** Ceiling on the key name, which is free text typed in the console. */
export const MAX_NAME_CHARS = 64;

/** Keys are cheap to mint and never expire, so the file needs a stop. */
export const MAX_KEYS = 100;

/**
 * A key as everything outside the store sees it: enough to recognise, revoke
 * and audit, with no way back to the key itself.
 */
export interface ApiKeySummary {
  id: string;
  name: string;
  createdAt: string;
  /** Stamped on every accepted connection. Null until the key is first used. */
  lastUsedAt: string | null;
  /** The first {@link FINGERPRINT_CHARS} characters of the key's SHA-256 hash. */
  fingerprint: string;
}

export interface MintedApiKey {
  /** The plaintext, returned by `mint` and nowhere else, ever. */
  key: string;
  record: ApiKeySummary;
}
