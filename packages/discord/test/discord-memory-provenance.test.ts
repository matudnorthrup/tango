import type { AgentRuntimeConfig } from "@tango/core";
import { describe, expect, it } from "vitest";
import {
  augmentRuntimeConfigWithDiscordProvenance,
  buildDiscordMemoryProvenanceEnv,
} from "../src/discord-memory-provenance.js";

function createConfig(): AgentRuntimeConfig {
  return {
    agentId: "cod-e",
    systemPrompt: "test",
    mcpServers: [
      {
        name: "memory",
        command: "node",
        args: ["packages/atlas-memory/dist/index.js"],
        env: {
          WORKER_ID: "cod-e",
        },
      },
      {
        name: "attachments",
        command: "node",
        args: ["packages/core/dist/mcp-proxy.js", "attachments"],
      },
    ],
    runtimePreferences: {
      model: "claude-sonnet-4-6",
      timeout: 30_000,
    },
  };
}

describe("discord memory provenance runtime config", () => {
  it("builds env patch for conversation location", () => {
    expect(
      buildDiscordMemoryProvenanceEnv({
        conversationKey: "thread:test-thread-1",
        channelId: "test-channel-1",
        threadId: "test-thread-1",
        turnId: "turn-1",
        messageId: "message-1",
        occurredAt: "2026-07-12T09:00:00.000Z",
        contextRef: "topic:shared-knowledge",
        contextLabel: "shared-knowledge review",
      }),
    ).toEqual({
      TANGO_CONVERSATION_KEY: "thread:test-thread-1",
      TANGO_DISCORD_CHANNEL_ID: "test-channel-1",
      TANGO_DISCORD_THREAD_ID: "test-thread-1",
      TANGO_TURN_ID: "turn-1",
      TANGO_MESSAGE_ID: "message-1",
      TANGO_OCCURRED_AT: "2026-07-12T09:00:00.000Z",
      TANGO_CONTEXT_REF: "topic:shared-knowledge",
      TANGO_CONTEXT_LABEL: "shared-knowledge review",
    });
  });

  it("augments only the atlas-memory MCP server env", () => {
    const augmented = augmentRuntimeConfigWithDiscordProvenance(createConfig(), {
      conversationKey: "thread:thread-9",
      channelId: "forum-1",
      threadId: "thread-9",
      turnId: "turn-9",
      messageId: "message-9",
      occurredAt: "2026-07-12T09:00:00.000Z",
      contextRef: "topic:shared-knowledge",
      contextLabel: "shared-knowledge review",
    });

    expect(augmented.mcpServers[0]?.env).toMatchObject({
      WORKER_ID: "cod-e",
      TANGO_CONVERSATION_KEY: "thread:thread-9",
      TANGO_DISCORD_CHANNEL_ID: "forum-1",
      TANGO_DISCORD_THREAD_ID: "thread-9",
      TANGO_TURN_ID: "turn-9",
      TANGO_MESSAGE_ID: "message-9",
      TANGO_OCCURRED_AT: "2026-07-12T09:00:00.000Z",
      TANGO_CONTEXT_REF: "topic:shared-knowledge",
      TANGO_CONTEXT_LABEL: "shared-knowledge review",
    });
    expect(augmented.mcpServers[1]?.env).toBeUndefined();
  });
});
