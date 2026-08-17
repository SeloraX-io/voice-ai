"use client";

import { useAgentConfig } from "@/components/agent-config/AgentConfigProvider";
import { ActionsTab } from "@/components/agent-config/ActionsTab";

export default function ActionsPage() {
  const { config, update, setSecretKeys, errors } = useAgentConfig();
  return (
    <ActionsTab config={config} update={update} setSecretKeys={setSecretKeys} errors={errors} />
  );
}
