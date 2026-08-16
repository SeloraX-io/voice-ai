/**
 * The bridge: the agent as a softphone on a real SIP extension.
 *
 * The Selorax connection decides where the line comes from, so it is read here
 * on the server and the mode is derived from it — there is no toggle to get
 * wrong. Only a summary crosses to the browser: the admin token stays on this
 * side, exactly as `GET /api/selorax` does it (see `lib/selorax/config.ts`).
 *
 * The saved SIP credentials are still read, but only to fill the fallback form
 * used when Selorax is not connected. They include the SIP password, which has
 * to reach the browser — digest auth happens inside JsSIP, in this page. That
 * is the same thing the SeloraX dashboard already does with the same secret;
 * see the spec's §4.2.
 *
 * `tokenExpiresInDays` is computed here rather than in the panel so the two
 * renders of a client component either side of hydration cannot disagree about
 * what "now" is.
 */

import { BridgePanel } from "@/components/telephony/BridgePanel";
import { isSeloraxConfigured, tokenExpiryMs } from "@/lib/selorax/config";
import { seloraxStore } from "@/server/config/selorax-store";
import { telephonyStore } from "@/server/config/telephony-store";

export const dynamic = "force-dynamic";

const DAY_MS = 86_400_000;

export default async function TelephonyPage() {
  const [selorax, credentials] = await Promise.all([seloraxStore.read(), telephonyStore.read()]);

  const tokenExpiresAt =
    selorax.authToken.length > 0 ? tokenExpiryMs(selorax.authToken) : null;

  return (
    <BridgePanel
      selorax={{
        configured: isSeloraxConfigured(selorax),
        baseUrl: selorax.baseUrl,
        tokenExpiresAt,
        // `force-dynamic` means this Server Component renders once per request, so reading the
        // clock here is request time, not a value a re-render could change underneath the page.
        // Doing it in the client component instead is what would be wrong: its server render and
        // its browser render would disagree and the expiry would flicker on hydration.
        tokenExpiresInDays:
          // eslint-disable-next-line react-hooks/purity -- see above
          tokenExpiresAt === null ? null : Math.floor((tokenExpiresAt - Date.now()) / DAY_MS),
      }}
      directCredentials={credentials}
    />
  );
}
