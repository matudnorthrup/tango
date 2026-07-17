import type { AgentRuntimeConfig, McpServerConfig } from "@tango/core";

export interface DiscordMemoryProvenance {
  conversationKey: string;
  channelId: string;
  threadId?: string;
  turnId?: string;
  messageId?: string;
}

export function buildDiscordMemoryProvenanceEnv(
  provenance: DiscordMemoryProvenance,
): Record<string, string> {
  return {
    TANGO_CONVERSATION_KEY: provenance.conversationKey,
    TANGO_DISCORD_CHANNEL_ID: provenance.channelId,
    ...(provenance.threadId ? { TANGO_DISCORD_THREAD_ID: provenance.threadId } : {}),
    ...(provenance.turnId ? { TANGO_TURN_ID: provenance.turnId } : {}),
    ...(provenance.messageId ? { TANGO_MESSAGE_ID: provenance.messageId } : {}),
  };
}

function isAtlasMemoryMcpServer(server: McpServerConfig): boolean {
  if (server.name === "memory") {
    return true;
  }

  return (server.args ?? []).some((arg) => arg.includes("atlas-memory"));
}

function acceptsTurnProvenance(server: McpServerConfig): boolean {
  return isAtlasMemoryMcpServer(server) || server.name === "state";
}

export function augmentRuntimeConfigWithDiscordProvenance(
  config: AgentRuntimeConfig,
  provenance: DiscordMemoryProvenance,
): AgentRuntimeConfig {
  const envPatch = buildDiscordMemoryProvenanceEnv(provenance);

  return {
    ...config,
    mcpServers: config.mcpServers.map((server) => {
      if (!acceptsTurnProvenance(server)) {
        return server;
      }

      return {
        ...server,
        env: {
          ...(server.env ?? {}),
          ...envPatch,
        },
      };
    }),
    ...(config.availableMcpServers
      ? {
          availableMcpServers: config.availableMcpServers.map((server) => {
            if (!acceptsTurnProvenance(server)) {
              return server;
            }

            return {
              ...server,
              env: {
                ...(server.env ?? {}),
                ...envPatch,
              },
            };
          }),
        }
      : {}),
  };
}
