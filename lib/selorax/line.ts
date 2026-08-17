/**
 * Shapes a `SeloraxLine` into exactly what the browser needs to register.
 *
 * Built field by field, never by spreading `SeloraxLine` — so a field added
 * to that type later (an admin credential, say) cannot silently reach the
 * browser just because it rode along on the object. See `server/selorax/
 * calling-client.ts` for what `SeloraxLine` actually is.
 *
 * The SIP password IS included here: digest auth happens in JsSIP in the
 * browser, so without the plaintext password the bridge cannot register at
 * all. This is deliberate, not an oversight — see the spec's §3.
 */

import type { SeloraxIceServer, SeloraxLine } from "../../server/selorax/calling-client";
import type { SipCredentials } from "../telephony/credentials";

export interface LineResponse {
  wsUrl: string;
  sipUri: string;
  sipDomain: string;
  extension: string;
  password: string;
  iceServers: SeloraxIceServer[];
}

export function toLineResponse(line: SeloraxLine): LineResponse {
  return {
    wsUrl: line.wsUrl,
    sipUri: line.sipUri,
    sipDomain: line.sipDomain,
    extension: line.extension,
    password: line.password,
    iceServers: line.iceServers,
  };
}

/* -------------------------------------------------------------------------- */
/* The same response, read back in the browser                                */
/* -------------------------------------------------------------------------- */

/** What the bridge needs to register and to build a peer connection. */
export interface TelephonyLine {
  credentials: SipCredentials;
  /** Empty is legal: TURN is best-effort upstream, and STUN-only still calls. */
  iceServers: RTCIceServer[];
}

const CREDENTIAL_KEYS = ["wsUrl", "sipUri", "sipDomain", "extension", "password"] as const;

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Turns whatever the route sent into a list `RTCPeerConnection` will accept.
 *
 * A malformed entry is dropped rather than failing the whole list, deliberately:
 * one unusable TURN server upstream must not cost the bridge the STUN servers
 * that came with it, and none of them are worth refusing to answer the phone
 * over. `urls` is the only required field — `stun:` entries carry no credential.
 */
export function normaliseIceServers(value: unknown): RTCIceServer[] {
  if (!Array.isArray(value)) return [];

  const servers: RTCIceServer[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const source = entry as Record<string, unknown>;

    const urls = Array.isArray(source.urls)
      ? source.urls.filter((url): url is string => text(url) !== null)
      : (text(source.urls) ?? []);
    if (urls.length === 0) continue;

    // Built field by field, so nothing else riding on the entry reaches the
    // peer connection.
    const server: RTCIceServer = { urls };
    const username = text(source.username);
    const credential = text(source.credential);
    if (username !== null) server.username = username;
    if (credential !== null) server.credential = credential;
    servers.push(server);
  }
  return servers;
}

/**
 * How many of these servers can relay media.
 *
 * The distinction that matters: STUN only discovers an address, and behind
 * symmetric NAT the address it discovers is useless. TURN is the one that
 * actually carries the audio, so "how many ICE servers" is the wrong number to
 * show an operator and this is the right one.
 */
export function countTurnServers(servers: readonly RTCIceServer[]): number {
  return servers.filter((server) => {
    const urls = typeof server.urls === "string" ? [server.urls] : server.urls;
    return urls.some((url) => /^turns?:/i.test(url));
  }).length;
}

/**
 * Reads `GET /api/telephony/line`'s body in the browser.
 *
 * Returns null when any of the five SIP values is missing, because registering
 * with a half-line fails inside JsSIP with a message no operator can act on.
 * ICE servers are not part of that test: a line with no TURN is still a line.
 */
export function parseLineResponse(value: unknown): TelephonyLine | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;

  const credentials = {} as SipCredentials;
  for (const key of CREDENTIAL_KEYS) {
    const field = text(source[key]);
    if (field === null) return null;
    credentials[key] = field;
  }

  return { credentials, iceServers: normaliseIceServers(source.iceServers) };
}
