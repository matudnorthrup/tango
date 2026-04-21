import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentRuntime,
  AgentRuntimeConfig,
  RuntimeResponse,
  SendOptions,
} from "../src/agent-runtime.js";
import { SessionLifecycleManager } from "../src/session-lifecycle.js";
import type { RuntimePool } from "../src/runtime-pool.js";

function createConfig(overrides: Partial<AgentRuntimeConfig> = {}): AgentRuntimeConfig {
  return {
    agentId: "agent-1",
    systemPrompt: "You are the session runtime.",
    mcpServers: [
      {
        name: "memory",
        command: "node",
        args: ["memory.js"],
      },
    ],
    runtimePreferences: {
      model: "sonnet",
      timeout: 1_000,
    },
    ...overrides,
  };
}

function createResponse(
  text: string,
  options: {
    sessionId?: string;
    metadata?: Record<string, unknown>;
  } = {},
): RuntimeResponse {
  const metadata: Record<string, unknown> = {
    ...(options.metadata ?? {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
  };

  return {
    text,
    durationMs: 25,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

class MockRuntime implements AgentRuntime {
  readonly type = "claude-code" as const;
  active = true;
  sessionId?: string;
  readonly queuedResponses: RuntimeResponse[] = [];
  readonly sentMessages: string[] = [];

  readonly send = vi.fn(async (message: string, _options?: SendOptions) => {
    this.sentMessages.push(message);
    const response = this.queuedResponses.shift();
    if (!response) {
      throw new Error(`No queued response for ${this.id}.`);
    }

    const sessionId = typeof response.metadata?.sessionId === "string"
      ? response.metadata.sessionId
      : undefined;
    if (sessionId) {
      this.sessionId = sessionId;
    }

    return response;
  });

  readonly initialize = vi.fn(async (_config: AgentRuntimeConfig) => {
    this.active = true;
  });

  readonly teardown = vi.fn(async () => {
    this.active = false;
  });

  readonly healthCheck = vi.fn(async () => this.active);
  readonly getSessionId = vi.fn(() => this.sessionId);
  readonly resumeSession = vi.fn((sessionId: string) => {
    this.sessionId = sessionId;
  });

  constructor(readonly id: string) {}

  queueResponse(response: RuntimeResponse): void {
    this.queuedResponses.push(response);
  }
}

class MockRuntimePool {
  readonly getOrCreateCalls: Array<{ conversationKey: string; config: AgentRuntimeConfig }> = [];
  readonly closeCalls: string[] = [];
  closeAllCalls = 0;

  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly queuedRuntimes: MockRuntime[] = [];
  private createdRuntimeCount = 0;

  enqueueRuntime(runtime: MockRuntime): MockRuntime {
    this.queuedRuntimes.push(runtime);
    return runtime;
  }

  get(conversationKey: string): AgentRuntime | undefined {
    return this.runtimes.get(conversationKey);
  }

  async getOrCreate(conversationKey: string, config: AgentRuntimeConfig): Promise<AgentRuntime> {
    this.getOrCreateCalls.push({
      conversationKey,
      config,
    });

    const existing = this.runtimes.get(conversationKey);
    if (existing) {
      return existing;
    }

    const runtime = this.queuedRuntimes.shift() ?? new MockRuntime(`runtime-${++this.createdRuntimeCount}`);
    this.runtimes.set(conversationKey, runtime);
    return runtime;
  }

  async close(conversationKey: string): Promise<void> {
    this.closeCalls.push(conversationKey);
    const runtime = this.runtimes.get(conversationKey);
    if (!runtime) {
      return;
    }

    this.runtimes.delete(conversationKey);
    await runtime.teardown();
  }

  async closeAll(): Promise<void> {
    this.closeAllCalls += 1;

    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();

    await Promise.all(runtimes.map(async (runtime) => {
      await runtime.teardown();
    }));
  }

  keys(): string[] {
    return [...this.runtimes.keys()];
  }

  get size(): number {
    return this.runtimes.size;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SessionLifecycleManager", () => {
  it("creates a new session on the first send", async () => {
    const pool = new MockRuntimePool();
    const runtime = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    runtime.queueResponse(createResponse("First reply", { sessionId: "session-1" }));

    const builder = vi.fn(async () => ({
      pinnedFacts: "Pinned fact A",
      recentMessages: "Recent summary A",
      relevantMemories: "Memory hit A",
    }));

    const manager = new SessionLifecycleManager(
      pool as unknown as RuntimePool,
      undefined,
      builder,
    );

    const response = await manager.sendMessage("conversation-1", createConfig(), "hello");

    expect(response.text).toBe("First reply");
    expect(builder).toHaveBeenCalledWith("conversation-1", "agent-1");
    expect(pool.getOrCreateCalls).toHaveLength(1);
    expect(pool.getOrCreateCalls[0]?.config.coldStartContext).toBe(
      "Pinned facts:\nPinned fact A\n\nRecent conversation:\nRecent summary A\n\nRelevant memories:\nMemory hit A",
    );

    expect(manager.getSession("conversation-1")).toMatchObject({
      conversationKey: "conversation-1",
      agentId: "agent-1",
      state: "idle",
      messageCount: 1,
      sessionId: "session-1",
    });
  });

  it("reuses an existing session on subsequent sends", async () => {
    const pool = new MockRuntimePool();
    const runtime = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    runtime.queueResponse(createResponse("First reply", { sessionId: "session-1" }));
    runtime.queueResponse(createResponse("Second reply", { sessionId: "session-1" }));

    const builder = vi.fn(async () => ({
      pinnedFacts: "Pinned fact A",
      recentMessages: "Recent summary A",
      relevantMemories: "Memory hit A",
    }));

    const manager = new SessionLifecycleManager(
      pool as unknown as RuntimePool,
      undefined,
      builder,
    );

    await manager.sendMessage("conversation-1", createConfig(), "hello");
    await manager.sendMessage("conversation-1", createConfig(), "again");

    expect(pool.getOrCreateCalls).toHaveLength(1);
    expect(runtime.send).toHaveBeenCalledTimes(2);
    expect(builder).toHaveBeenCalledTimes(1);
    expect(manager.getSession("conversation-1")?.messageCount).toBe(2);
  });

  it("updates lastMessageAt on each send", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T10:00:00.000Z"));

    const pool = new MockRuntimePool();
    const runtime = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    runtime.queueResponse(createResponse("First reply", { sessionId: "session-1" }));
    runtime.queueResponse(createResponse("Second reply", { sessionId: "session-1" }));

    const manager = new SessionLifecycleManager(pool as unknown as RuntimePool);

    await manager.sendMessage("conversation-1", createConfig(), "hello");
    const firstTimestamp = manager.getSession("conversation-1")?.lastMessageAt;

    vi.setSystemTime(new Date("2026-04-21T11:00:00.000Z"));
    await manager.sendMessage("conversation-1", createConfig(), "again");
    const secondTimestamp = manager.getSession("conversation-1")?.lastMessageAt;

    expect(firstTimestamp).toBeDefined();
    expect(secondTimestamp).toBeDefined();
    expect(secondTimestamp!.getTime()).toBeGreaterThan(firstTimestamp!.getTime());
  });

  it("idle checker closes sessions past the timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T10:00:00.000Z"));

    const pool = new MockRuntimePool();
    const runtime = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    runtime.queueResponse(createResponse("First reply", { sessionId: "session-1" }));

    const manager = new SessionLifecycleManager(
      pool as unknown as RuntimePool,
      {
        idleTimeoutHours: 1,
        idleCheckIntervalMs: 1_000,
      },
    );

    await manager.sendMessage("conversation-1", createConfig(), "hello");
    manager.startIdleChecker();

    vi.setSystemTime(new Date("2026-04-21T12:00:00.000Z"));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(pool.closeCalls).toEqual(["conversation-1"]);
    expect(pool.get("conversation-1")).toBeUndefined();
    expect(manager.getSession("conversation-1")?.state).toBe("closed");
  });

  it("resumes a closed session on the next message", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T10:00:00.000Z"));

    const pool = new MockRuntimePool();
    const runtime1 = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    runtime1.queueResponse(createResponse("First reply", { sessionId: "session-1" }));

    const builder = vi.fn(async () => ({
      pinnedFacts: "Pinned fact A",
      recentMessages: "Recent summary A",
      relevantMemories: "Memory hit A",
    }));

    const manager = new SessionLifecycleManager(
      pool as unknown as RuntimePool,
      {
        idleTimeoutHours: 1,
        idleCheckIntervalMs: 1_000,
      },
      builder,
    );

    await manager.sendMessage("conversation-1", createConfig(), "hello");
    manager.startIdleChecker();

    vi.setSystemTime(new Date("2026-04-21T12:00:00.000Z"));
    await vi.advanceTimersByTimeAsync(1_000);

    const runtime2 = pool.enqueueRuntime(new MockRuntime("runtime-2"));
    runtime2.queueResponse(createResponse("Resumed reply", { sessionId: "session-1" }));

    await manager.sendMessage("conversation-1", createConfig(), "welcome back");

    expect(runtime2.resumeSession).toHaveBeenCalledWith("session-1");
    expect(builder).toHaveBeenCalledTimes(1);
    expect(manager.getSession("conversation-1")).toMatchObject({
      state: "idle",
      messageCount: 2,
      sessionId: "session-1",
    });
  });

  it("resetSession forces a hard reset", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T10:00:00.000Z"));

    const pool = new MockRuntimePool();
    const runtime1 = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    runtime1.queueResponse(createResponse("First reply", { sessionId: "session-1" }));

    let buildCount = 0;
    const builder = vi.fn(async () => {
      buildCount += 1;
      return {
        pinnedFacts: `Pinned fact ${buildCount}`,
        recentMessages: `Recent summary ${buildCount}`,
        relevantMemories: `Memory hit ${buildCount}`,
      };
    });

    const manager = new SessionLifecycleManager(
      pool as unknown as RuntimePool,
      undefined,
      builder,
    );

    await manager.sendMessage("conversation-1", createConfig(), "hello");
    const beforeReset = manager.getSession("conversation-1")?.createdAt;

    vi.setSystemTime(new Date("2026-04-21T11:00:00.000Z"));
    pool.enqueueRuntime(new MockRuntime("runtime-2"));

    await manager.resetSession("conversation-1", createConfig());

    const session = manager.getSession("conversation-1");

    expect(pool.closeCalls).toEqual(["conversation-1"]);
    expect(pool.getOrCreateCalls).toHaveLength(2);
    expect(builder).toHaveBeenCalledTimes(2);
    expect(session).toMatchObject({
      state: "idle",
      messageCount: 0,
    });
    expect(session?.sessionId).toBeUndefined();
    expect(session?.createdAt.getTime()).toBeGreaterThan(beforeReset!.getTime());
  });

  it("getAllSessions returns tracked sessions", async () => {
    const pool = new MockRuntimePool();
    const runtime1 = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    const runtime2 = pool.enqueueRuntime(new MockRuntime("runtime-2"));
    runtime1.queueResponse(createResponse("Reply one", { sessionId: "session-1" }));
    runtime2.queueResponse(createResponse("Reply two", { sessionId: "session-2" }));

    const manager = new SessionLifecycleManager(pool as unknown as RuntimePool);

    await manager.sendMessage("conversation-1", createConfig(), "hello");
    await manager.sendMessage(
      "conversation-2",
      createConfig({ agentId: "agent-2" }),
      "hi",
    );

    expect(manager.getAllSessions()).toHaveLength(2);
    expect(manager.getAllSessions().map((session) => session.conversationKey)).toEqual([
      "conversation-1",
      "conversation-2",
    ]);
  });

  it("shutdown closes all sessions and stops the idle checker", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T10:00:00.000Z"));

    const pool = new MockRuntimePool();
    const runtime1 = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    const runtime2 = pool.enqueueRuntime(new MockRuntime("runtime-2"));
    runtime1.queueResponse(createResponse("Reply one", { sessionId: "session-1" }));
    runtime2.queueResponse(createResponse("Reply two", { sessionId: "session-2" }));

    const manager = new SessionLifecycleManager(
      pool as unknown as RuntimePool,
      {
        idleTimeoutHours: 1,
        idleCheckIntervalMs: 1_000,
      },
    );

    await manager.sendMessage("conversation-1", createConfig(), "hello");
    await manager.sendMessage(
      "conversation-2",
      createConfig({ agentId: "agent-2" }),
      "hi",
    );

    manager.startIdleChecker();
    await manager.shutdown();

    expect(pool.closeAllCalls).toBe(1);
    expect(manager.getAllSessions().every((session) => session.state === "closed")).toBe(true);

    vi.setSystemTime(new Date("2026-04-21T12:00:00.000Z"));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(pool.closeAllCalls).toBe(1);
    expect(pool.closeCalls).toHaveLength(0);
  });

  it("hard resets automatically when context usage crosses the threshold", async () => {
    const pool = new MockRuntimePool();
    const runtime1 = pool.enqueueRuntime(new MockRuntime("runtime-1"));
    runtime1.queueResponse(createResponse("First reply", {
      sessionId: "session-1",
      metadata: {
        contextUsage: 0.95,
      },
    }));
    const runtime2 = pool.enqueueRuntime(new MockRuntime("runtime-2"));

    let buildCount = 0;
    const builder = vi.fn(async () => {
      buildCount += 1;
      return {
        pinnedFacts: `Pinned fact ${buildCount}`,
        recentMessages: `Recent summary ${buildCount}`,
        relevantMemories: `Memory hit ${buildCount}`,
      };
    });

    const manager = new SessionLifecycleManager(
      pool as unknown as RuntimePool,
      {
        contextResetThreshold: 0.80,
      },
      builder,
    );

    const response = await manager.sendMessage("conversation-1", createConfig(), "hello");
    const session = manager.getSession("conversation-1");

    expect(response.text).toBe("First reply");
    expect(pool.closeCalls).toEqual(["conversation-1"]);
    expect(pool.getOrCreateCalls).toHaveLength(2);
    expect(builder).toHaveBeenCalledTimes(2);
    expect(runtime2.resumeSession).not.toHaveBeenCalled();
    expect(session).toMatchObject({
      state: "idle",
      messageCount: 0,
    });
    expect(session?.sessionId).toBeUndefined();
  });
});
