"use client";

import { useAgentConfig } from "@/components/agent-config/AgentConfigProvider";
import { AdvancedTab } from "@/components/agent-config/AdvancedTab";

export default function AdvancedPage() {
  const { config, update, setSecretKeys, errors } = useAgentConfig();
  return <AdvancedTab config={config} update={update} setSecretKeys={setSecretKeys} errors={errors} />;
}
