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
