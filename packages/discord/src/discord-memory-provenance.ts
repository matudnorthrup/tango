import type { AgentRuntimeConfig, McpServerConfig } from "@tango/core";
import { resolveTangoCurrentTurnProvenancePath } from "@tango/core";

export type DiscordCapturedBy = "save_pass" | "agent_save";

export interface DiscordTurnProvenance {
  conversationKey: string;
  channelId: string;
  threadId?: string;
  agentId: string;
  capturedBy: DiscordCapturedBy;
  requestedByUserId?: string;
  trigger?: string;
  timeZone?: string;
}

/** @deprecated Use DiscordTurnProvenance */
export type DiscordMemoryProvenance = Pick<
  DiscordTurnProvenance,
  "conversationKey" | "channelId" | "threadId"
>;

function isMcpProxyServer(server: McpServerConfig): boolean {
  return (server.args ?? []).some((arg) => String(arg).includes("mcp-proxy"));
}

function isAtlasMemoryMcpServer(server: McpServerConfig): boolean {
  if (server.name === "memory") {
    return true;
  }

  return (server.args ?? []).some((arg) => String(arg).includes("atlas-memory"));
}

function shouldReceiveTurnProvenance(server: McpServerConfig): boolean {
  return isAtlasMemoryMcpServer(server) || isMcpProxyServer(server);
}

export function buildDiscordTurnProvenanceEnv(
  provenance: DiscordTurnProvenance,
): Record<string, string> {
  const env: Record<string, string> = {
    TANGO_CONVERSATION_KEY: provenance.conversationKey,
    TANGO_DISCORD_CHANNEL_ID: provenance.channelId,
    TANGO_AGENT_ID: provenance.agentId,
    TANGO_CAPTURED_BY: provenance.capturedBy,
  };

  if (provenance.threadId) {
    env.TANGO_DISCORD_THREAD_ID = provenance.threadId;
  }
  if (provenance.requestedByUserId) {
    env.TANGO_REQUESTED_BY_USER_ID = provenance.requestedByUserId;
  }
  if (provenance.trigger) {
    env.TANGO_SAVE_TRIGGER = provenance.trigger;
  }
  if (provenance.timeZone) {
    env.TANGO_TURN_TIMEZONE = provenance.timeZone;
  }

  return env;
}

/** Back-compat wrapper for atlas-memory provenance env. */
export function buildDiscordMemoryProvenanceEnv(
  provenance: DiscordMemoryProvenance,
): Record<string, string> {
  return buildDiscordTurnProvenanceEnv({
    ...provenance,
    agentId: process.env.TANGO_AGENT_ID?.trim() || process.env.WORKER_ID?.trim() || "unknown",
    capturedBy: (process.env.TANGO_CAPTURED_BY?.trim() as DiscordCapturedBy | undefined) ?? "agent_save",
  });
}

export function augmentRuntimeConfigWithDiscordProvenance(
  config: AgentRuntimeConfig,
  provenance: DiscordTurnProvenance,
): AgentRuntimeConfig {
  const envPatch = buildDiscordTurnProvenanceEnv(provenance);

  return {
    ...config,
    mcpServers: config.mcpServers.map((server) => {
      if (!shouldReceiveTurnProvenance(server)) {
        return server;
      }

      return {
        ...server,
        env: {
          ...(server.env ?? {}),
          ...envPatch,
          ...(isMcpProxyServer(server)
            ? { TANGO_TURN_PROVENANCE_FILE: resolveTangoCurrentTurnProvenancePath() }
            : {}),
        },
      };
    }),
    ...(config.availableMcpServers
      ? {
          availableMcpServers: config.availableMcpServers.map((server) => {
            if (!isAtlasMemoryMcpServer(server)) {
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
