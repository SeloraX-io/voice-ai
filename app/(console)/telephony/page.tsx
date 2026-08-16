/**
 * The bridge: the agent as a softphone on a real SIP extension.
 *
 * The credentials are read on the server so the page is populated on first
 * paint, the same way the Calls list is. They include the SIP password, which
 * has to reach the browser — digest auth happens inside JsSIP, in this page.
 * That is the same thing the SeloraX dashboard already does with the same
 * secret; see the spec's §4.2.
 */

import { BridgePanel } from "@/components/telephony/BridgePanel";
import { telephonyStore } from "@/server/config/telephony-store";

export const dynamic = "force-dynamic";

export default async function TelephonyPage() {
  const credentials = await telephonyStore.read();
  return <BridgePanel initialCredentials={credentials} />;
}
