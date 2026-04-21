import type { AgentRuntimeConfig, RuntimeResponse, SendOptions } from "@tango/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => {
  const sendMessage = vi.fn();
  const resetSession = vi.fn();
  const shutdown = vi.fn();
  const startIdleChecker = vi.fn();
  const getSession = vi.fn();
  const constructorCalls: Array<{
    pool: unknown;
    config: unknown;
    buildColdStartContext: unknown;
  }> = [];

  class MockRuntimePool {}

  class MockSessionLifecycleManager {
    constructor(pool: unknown, config?: unknown, buildColdStartContext?: unknown) {
      constructorCalls.push({
        pool,
        config,
        buildColdStartContext,
      });
    }

    readonly sendMessage = sendMessage;
    readonly resetSession = resetSession;
    readonly shutdown = shutdown;
    readonly startIdleChecker = startIdleChecker;
    readonly getSession = getSession;
  }

  return {
    sendMessage,
    resetSession,
    shutdown,
    startIdleChecker,
    getSession,
    constructorCalls,
    MockRuntimePool,
    MockSessionLifecycleManager,
  };
});

vi.mock("@tango/core", () => ({
  RuntimePool: mockState.MockRuntimePool,
  SessionLifecycleManager: mockState.MockSessionLifecycleManager,
}));

import { TangoRouter } from "../src/tango-router.js";

function createAgentConfig(agentId: string): AgentRuntimeConfig {
  return {
    agentId,
    systemPrompt: `You are ${agentId}.`,
    mcpServers: [
      {
        name: "memory",
        command: "node",
        args: ["memory.js"],
      },
    ],
    runtimePreferences: {
      model: "sonnet",
      timeout: 30_000,
    },
  };
}

function createResponse(text: string): RuntimeResponse {
  return {
    text,
    durationMs: 25,
    metadata: {
      sessionId: "session-1",
    },
  };
}

async function waitForImmediate(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

afterEach(() => {
  mockState.sendMessage.mockReset();
  mockState.resetSession.mockReset();
  mockState.shutdown.mockReset();
  mockState.startIdleChecker.mockReset();
  mockState.getSession.mockReset();
  mockState.constructorCalls.length = 0;
  vi.restoreAllMocks();
});

describe("TangoRouter", () => {
  it("routes a message to the correct agent runtime", async () => {
    const alphaConfig = createAgentConfig("alpha");
    const bravoConfig = createAgentConfig("bravo");
    const response = createResponse("Routed reply");
    const sendOptions: SendOptions = { timeout: 5_000 };

    mockState.sendMessage.mockResolvedValue(response);

    const router = new TangoRouter({
      agentConfigs: new Map([
        ["alpha", alphaConfig],
        ["bravo", bravoConfig],
      ]),
    });

    const result = await router.routeMessage({
      message: "hello",
      channelId: "channel-1",
      agentId: "bravo",
      sendOptions,
    });

    expect(result).toEqual({
      response,
      agentId: "bravo",
      conversationKey: "channel:channel-1",
    });
    expect(mockState.sendMessage).toHaveBeenCalledWith(
      "channel:channel-1",
      bravoConfig,
      "hello",
      sendOptions,
    );
    expect(mockState.startIdleChecker).toHaveBeenCalledTimes(1);
  });

  it("generates distinct conversation keys for channels and threads", () => {
    const router = new TangoRouter({
      agentConfigs: new Map([
        ["alpha", createAgentConfig("alpha")],
      ]),
    });

    expect(router.getConversationKey("channel-1")).toBe("channel:channel-1");
    expect(router.getConversationKey("channel-1", "thread-9")).toBe("thread:thread-9");
  });

  it("fires the post-turn hook after returning the response", async () => {
    const response = createResponse("Async reply");
    const onPostTurn = vi.fn(async () => {});

    mockState.sendMessage.mockResolvedValue(response);

    const router = new TangoRouter({
      agentConfigs: new Map([
        ["alpha", createAgentConfig("alpha")],
      ]),
      onPostTurn,
    });

    const result = await router.routeMessage({
      message: "remember this",
      channelId: "channel-1",
      threadId: "thread-1",
      agentId: "alpha",
    });

    expect(result.response).toBe(response);
    expect(onPostTurn).not.toHaveBeenCalled();

    await waitForImmediate();

    expect(onPostTurn).toHaveBeenCalledWith({
      conversationKey: "thread:thread-1",
      agentId: "alpha",
      userMessage: "remember this",
      response,
      channelId: "channel-1",
      threadId: "thread-1",
    });
  });

  it("delegates conversation resets to the lifecycle manager", async () => {
    const alphaConfig = createAgentConfig("alpha");

    mockState.getSession.mockReturnValue({
      conversationKey: "thread:thread-1",
      agentId: "alpha",
      state: "idle",
      lastMessageAt: new Date(),
      createdAt: new Date(),
      messageCount: 1,
    });
    mockState.resetSession.mockResolvedValue(undefined);

    const router = new TangoRouter({
      agentConfigs: new Map([
        ["alpha", alphaConfig],
      ]),
    });

    await router.resetConversation("channel-1", "thread-1");

    expect(mockState.getSession).toHaveBeenCalledWith("thread:thread-1");
    expect(mockState.resetSession).toHaveBeenCalledWith("thread:thread-1", alphaConfig);
  });

  it("delegates shutdown to the lifecycle manager", async () => {
    mockState.shutdown.mockResolvedValue(undefined);

    const router = new TangoRouter({
      agentConfigs: new Map([
        ["alpha", createAgentConfig("alpha")],
      ]),
    });

    await router.shutdown();

    expect(mockState.shutdown).toHaveBeenCalledTimes(1);
  });

  it("throws a clear error for an unknown agent id", async () => {
    const router = new TangoRouter({
      agentConfigs: new Map([
        ["alpha", createAgentConfig("alpha")],
      ]),
    });

    await expect(router.routeMessage({
      message: "hello",
      channelId: "channel-1",
      agentId: "missing-agent",
    })).rejects.toThrow("Unknown agentId 'missing-agent'. No runtime config is registered.");

    expect(mockState.sendMessage).not.toHaveBeenCalled();
  });
});
