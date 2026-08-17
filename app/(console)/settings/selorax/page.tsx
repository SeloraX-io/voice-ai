/**
 * Where the bridge's Selorax connection is configured: the base URL, the
 * dedicated user's auth token, and the store id — the same three fields
 * `GET /api/selorax` and `lib/selorax/config.ts` already validate.
 *
 * Read on the server, the same way the Telephony page reads it, so the panel
 * paints with real values on first render instead of an empty flash while a
 * client fetch resolves. Only the summary crosses the boundary; the admin
 * token itself never does — see `toSeloraxSummary`.
 *
 * The expiry warning is decided here rather than in the panel for the same
 * reason `telephony/page.tsx` computes `tokenExpiresInDays` server-side:
 * `force-dynamic` makes this render once per request, so reading the clock
 * here is request time, not a value a later re-render could disagree with.
 */

import { SeloraxPanel } from "@/components/settings/SeloraxPanel";
import { isTokenExpiringSoon, toSeloraxSummary } from "@/lib/selorax/config";
import { seloraxStore } from "@/server/config/selorax-store";

export const dynamic = "force-dynamic";

export default async function SeloraxSettingsPage() {
  const summary = toSeloraxSummary(await seloraxStore.read());

  return (
    <SeloraxPanel
      initial={summary}
      // eslint-disable-next-line react-hooks/purity -- request-time clock read, see module doc
      initialExpiringSoon={isTokenExpiringSoon(summary.tokenExpiresAt, Date.now())}
    />
  );
}
