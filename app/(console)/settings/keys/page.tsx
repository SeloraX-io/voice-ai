/**
 * API keys for the voice gateway.
 *
 * Read on the server so the list is populated on first paint, the same way the
 * Calls table and the bridge credentials are. Only summaries cross to the
 * browser — a key's plaintext exists exactly once, in the response to the mint
 * that created it.
 */

import { ApiKeysPanel } from "@/components/settings/ApiKeysPanel";
import { apiKeyStore } from "@/server/config/api-key-store";

export const dynamic = "force-dynamic";

export default async function ApiKeysPage() {
  return <ApiKeysPanel initialKeys={await apiKeyStore.list()} />;
}
