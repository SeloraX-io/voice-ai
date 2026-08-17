"use client";

import { useAgentConfig } from "@/components/agent-config/AgentConfigProvider";
import { ConversationTab } from "@/components/agent-config/ConversationTab";

export default function ConversationPage() {
  const { config, update, setSecretKeys, errors } = useAgentConfig();
  return <ConversationTab config={config} update={update} setSecretKeys={setSecretKeys} errors={errors} />;
}
