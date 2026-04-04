import type { AgentConfig } from "@tango/core";

export interface AgentLookup {
  get(id: string): AgentConfig | undefined;
}

export function resolveTargetAgent(
  agentLookup: AgentLookup,
  routeAgentId: string,
  agentOverride: string | null
): AgentConfig | null {
  if (agentOverride) {
    const selected = agentLookup.get(agentOverride);
    if (selected) return selected;
  }

  const routeAgent = agentLookup.get(routeAgentId);
  if (!routeAgent) return null;

  if (routeAgent.id !== "dispatch") {
    return routeAgent;
  }

  const configuredDefaultId = routeAgent.voice?.defaultPromptAgent?.trim();
  if (configuredDefaultId) {
    const configuredDefault = agentLookup.get(configuredDefaultId);
    if (configuredDefault) return configuredDefault;
  }

  return routeAgent;
}
