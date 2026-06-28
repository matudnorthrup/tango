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
      }),
    ).toEqual({
      TANGO_CONVERSATION_KEY: "thread:test-thread-1",
      TANGO_DISCORD_CHANNEL_ID: "test-channel-1",
      TANGO_DISCORD_THREAD_ID: "test-thread-1",
      TANGO_AGENT_ID: "unknown",
      TANGO_CAPTURED_BY: "agent_save",
    });
  });

  it("augments memory and mcp-proxy MCP server env", () => {
    const augmented = augmentRuntimeConfigWithDiscordProvenance(createConfig(), {
      conversationKey: "thread:thread-9",
      channelId: "forum-1",
      threadId: "thread-9",
      agentId: "cod-e",
      capturedBy: "save_pass",
      requestedByUserId: "user-1",
      timeZone: "America/Denver",
    });

    expect(augmented.mcpServers[0]?.env).toMatchObject({
      WORKER_ID: "cod-e",
      TANGO_CONVERSATION_KEY: "thread:thread-9",
      TANGO_DISCORD_CHANNEL_ID: "forum-1",
      TANGO_DISCORD_THREAD_ID: "thread-9",
      TANGO_AGENT_ID: "cod-e",
      TANGO_CAPTURED_BY: "save_pass",
      TANGO_REQUESTED_BY_USER_ID: "user-1",
      TANGO_TURN_TIMEZONE: "America/Denver",
    });
    expect(augmented.mcpServers[1]?.env).toMatchObject({
      TANGO_CONVERSATION_KEY: "thread:thread-9",
      TANGO_AGENT_ID: "cod-e",
      TANGO_CAPTURED_BY: "save_pass",
      TANGO_TURN_PROVENANCE_FILE: expect.stringMatching(/current-turn-provenance\.json$/),
    });
    expect(augmented.mcpServers[0]?.env).not.toHaveProperty("TANGO_TURN_PROVENANCE_FILE");
  });
});
