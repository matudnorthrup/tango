import type { V2AgentConfig } from "@tango/core";
import { describe, expect, it, vi } from "vitest";
import {
  buildVoiceRouterErrorResult,
  buildVoiceRouterResult,
  dispatchVoiceTurnByRuntime,
  VOICE_V2_ROUTER_TIMEOUT_MS,
  VOICE_V2_TTS_ERROR_MESSAGE,
} from "../src/voice-turn-runtime-routing.js";

function createV2AgentConfig(
  provider: V2AgentConfig["runtime"]["provider"] = "claude-code-v2",
): V2AgentConfig {
  return {
    id: "malibu",
    displayName: "Malibu",
    type: "wellness",
    systemPromptFile: "agents/assistants/malibu/soul.md",
    mcpServers: [
      {
        name: "wellness",
        command: "node",
        args: ["packages/discord/dist/mcp-wellness-server.js"],
      },
    ],
    runtime: {
      mode: "persistent",
      provider,
      fallback: "codex",
      model: "claude-sonnet-4-6",
      reasoningEffort: "medium",
      idleTimeoutHours: 24,
      contextResetThreshold: 0.8,
    },
    memory: {
      postTurnExtraction: "enabled",
      extractionModel: "claude-haiku-4-5",
      importanceThreshold: 0.4,
      scheduledReflection: "enabled",
    },
    discord: {
      defaultChannelId: "channel-1",
    },
  };
}

describe("dispatchVoiceTurnByRuntime", () => {
  it("routes voice turns through TangoRouter when v2 is enabled", async () => {
    const routeMessage = vi.fn(async () => ({
      response: {
        text: "Routed reply",
        durationMs: 42,
        metadata: {
          sessionId: "runtime-session-1",
        },
      },
      agentId: "malibu",
      conversationKey: "voice:session-1:malibu",
    }));
    const executeLegacyTurn = vi.fn(async () => "legacy");

    const result = await dispatchVoiceTurnByRuntime({
      transcript: "hello from voice",
      agentId: "malibu",
      channelId: "channel-1",
      threadId: "thread-7",
      conversationKey: "voice:session-1:malibu",
      v2AgentConfig: createV2AgentConfig(),
      tangoRouter: {
        routeMessage,
      },
      executeLegacyTurn,
      mapRouterResult: (routeResult) =>
        buildVoiceRouterResult({
          routeResult,
          v2AgentConfig: createV2AgentConfig(),
          turnId: "turn-1",
        }),
    });

    expect(result).toEqual({
      turnId: "turn-1",
      deduplicated: false,
      responseText: "Routed reply",
      providerName: "claude-code-v2",
      providerSessionId: "runtime-session-1",
      providerUsedFailover: false,
    });
    expect(routeMessage).toHaveBeenCalledWith({
      message: "hello from voice",
      channelId: "channel-1",
      threadId: "thread-7",
      conversationKey: "voice:session-1:malibu",
      agentId: "malibu",
      sendOptions: {
        timeout: VOICE_V2_ROUTER_TIMEOUT_MS,
      },
    });
    expect(executeLegacyTurn).not.toHaveBeenCalled();
  });

  it("uses the legacy executor when v2 is disabled", async () => {
    const executeLegacyTurn = vi.fn(async () => "legacy reply");
    const routeMessage = vi.fn();

    const result = await dispatchVoiceTurnByRuntime({
      transcript: "keep using legacy",
      agentId: "malibu",
      channelId: "channel-1",
      v2AgentConfig: createV2AgentConfig("legacy"),
      tangoRouter: {
        routeMessage,
      },
      executeLegacyTurn,
      mapRouterResult: () => "v2 reply",
    });

    expect(result).toBe("legacy reply");
    expect(executeLegacyTurn).toHaveBeenCalledTimes(1);
    expect(routeMessage).not.toHaveBeenCalled();
  });

  it("allows voice routing errors to resolve to a TTS-friendly reply", async () => {
    const routeMessage = vi.fn(async () => {
      throw new Error("runtime unavailable");
    });

    const result = await dispatchVoiceTurnByRuntime({
      transcript: "hello",
      agentId: "malibu",
      channelId: "channel-1",
      v2AgentConfig: createV2AgentConfig(),
      tangoRouter: {
        routeMessage,
      },
      executeLegacyTurn: async () => {
        throw new Error("legacy should not run");
      },
      mapRouterResult: () => {
        throw new Error("success path should not run");
      },
      onRouterError: () =>
        buildVoiceRouterErrorResult({
          v2AgentConfig: createV2AgentConfig(),
          turnId: "turn-err",
        }),
    });

    expect(result).toEqual({
      turnId: "turn-err",
      deduplicated: false,
      responseText: VOICE_V2_TTS_ERROR_MESSAGE,
      providerName: "claude-code-v2",
      providerUsedFailover: false,
    });
  });
});
