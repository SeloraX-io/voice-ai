"use client";

import { useAgentConfig } from "@/components/agent-config/AgentConfigProvider";
import { ModelsVoiceTab } from "@/components/agent-config/ModelsVoiceTab";

export default function ModelsVoicePage() {
  const { config, update, setSecretKeys, errors } = useAgentConfig();
  return <ModelsVoiceTab config={config} update={update} setSecretKeys={setSecretKeys} errors={errors} />;
}
