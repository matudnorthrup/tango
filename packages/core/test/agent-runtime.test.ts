import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeConfig } from "../src/agent-runtime.js";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { ClaudeCodeAdapter } from "../src/claude-code-adapter.js";
import { RuntimePool } from "../src/runtime-pool.js";

class MockChildProcess extends EventEmitter implements Partial<ChildProcessWithoutNullStreams> {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly killMock = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
    this.killed = true;
    this.lastSignal = signal;
    if (this.closeOnSignal.has(signal)) {
      queueMicrotask(() => this.close(signal === "SIGKILL" ? null : 0, signal));
    }
    return true;
  });

  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  pid = 12345;
  lastSignal?: NodeJS.Signals;
  stdinText = "";
  closeOnSignal = new Set<NodeJS.Signals>(["SIGTERM"]);

  constructor() {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk) => {
      this.stdinText += String(chunk);
    });
  }

  kill(signal?: NodeJS.Signals): boolean {
    return this.killMock(signal);
  }

  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }
}

function createConfig(overrides: Partial<AgentRuntimeConfig> = {}): AgentRuntimeConfig {
  return {
    agentId: "agent-1",
    systemPrompt: "You are the runtime.",
    mcpServers: [
      {
        name: "memory",
        command: "node",
        args: ["packages/atlas-memory/dist/index.js"],
        env: {
          MODE: "test",
        },
      },
    ],
    runtimePreferences: {
      model: "sonnet",
      reasoningEffort: "high",
      maxTokens: 1024,
      timeout: 1_000,
    },
    coldStartContext: "Existing context",
    ...overrides,
  };
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  spawnMock.mockReset();
});

describe("ClaudeCodeAdapter", () => {
  it("stores initialization config for later sends", async () => {
    const adapter = new ClaudeCodeAdapter();
    const config = createConfig();

    await adapter.initialize(config);

    expect((adapter as unknown as { config?: AgentRuntimeConfig }).config).toEqual(config);
    expect(adapter.active).toBe(true);
  });

  it("spawns claude with temp system prompt and MCP config files", async () => {
    const child = new MockChildProcess();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.write(
          JSON.stringify({
            type: "result",
            is_error: false,
            result: "Hello from Claude",
            session_id: "session-1",
            tool_uses: [{ name: "mcp__memory__lookup", input: { query: "x" } }],
          }) + "\n",
        );
        child.close(0, null);
      });
      return child;
    });

    const adapter = new ClaudeCodeAdapter();
    await adapter.initialize(createConfig());

    const response = await adapter.send("Hello Claude");

    expect(response.text).toBe("Hello from Claude");
    expect(response.toolsUsed).toEqual(["mcp__memory__lookup"]);
    expect(child.stdinText).toContain("Hello Claude");
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const [command, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(command).toBe("claude");
    expect(args).toContain("--print");
    expect(args).toEqual(expect.arrayContaining([
      "--output-format",
      "json",
      "--append-system-prompt",
      "--mcp-config",
      "--model",
      "sonnet",
      "--effort",
      "high",
      "--max-tokens",
      "1024",
    ]));

    const systemPromptPath = getFlagValue(args, "--append-system-prompt");
    const mcpConfigPath = getFlagValue(args, "--mcp-config");
    expect(systemPromptPath).toBeDefined();
    expect(mcpConfigPath).toBeDefined();
    expect(fs.readFileSync(systemPromptPath!, "utf8")).toBe("You are the runtime.");
    expect(JSON.parse(fs.readFileSync(mcpConfigPath!, "utf8"))).toEqual({
      mcpServers: {
        memory: {
          command: "node",
          args: ["packages/atlas-memory/dist/index.js"],
          env: {
            MODE: "test",
          },
        },
      },
    });

    await adapter.teardown();
    expect(fs.existsSync(systemPromptPath!)).toBe(false);
    expect(fs.existsSync(mcpConfigPath!)).toBe(false);
  });

  it("uses --resume for subsequent sends after receiving a session id", async () => {
    const firstChild = new MockChildProcess();
    const secondChild = new MockChildProcess();
    spawnMock
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          firstChild.stdout.write(
            JSON.stringify({
              type: "result",
              is_error: false,
              result: "First response",
              session_id: "session-abc",
            }) + "\n",
          );
          firstChild.close(0, null);
        });
        return firstChild;
      })
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          secondChild.stdout.write(
            JSON.stringify({
              type: "result",
              is_error: false,
              result: "Second response",
              session_id: "session-abc",
            }) + "\n",
          );
          secondChild.close(0, null);
        });
        return secondChild;
      });

    const adapter = new ClaudeCodeAdapter();
    await adapter.initialize(createConfig());

    await adapter.send("First message");
    await adapter.send("Second message");

    const [, secondArgs] = spawnMock.mock.calls[1] as [string, string[]];
    expect(secondArgs).toEqual(expect.arrayContaining(["--resume", "session-abc"]));

    await adapter.teardown();
  });

  it("returns false from healthCheck when no process is running", async () => {
    const adapter = new ClaudeCodeAdapter();
    await adapter.initialize(createConfig());

    await expect(adapter.healthCheck()).resolves.toBe(false);

    await adapter.teardown();
  });

  it("teardown sends SIGTERM and then SIGKILL when the process does not exit", async () => {
    vi.useFakeTimers();

    const adapter = new ClaudeCodeAdapter();
    await adapter.initialize(createConfig());

    const child = new MockChildProcess();
    child.closeOnSignal = new Set<NodeJS.Signals>(["SIGKILL"]);
    (adapter as unknown as { child?: MockChildProcess; stateValue: string }).child = child;
    (adapter as unknown as { child?: MockChildProcess; stateValue: string }).stateValue = "active";

    const teardownPromise = adapter.teardown();
    expect(child.killMock).toHaveBeenCalledWith("SIGTERM");

    await vi.advanceTimersByTimeAsync(TEARDOWN_WAIT_MS);
    expect(child.killMock).toHaveBeenCalledWith("SIGKILL");

    await teardownPromise;
    expect(adapter.active).toBe(false);
  });

  it("times out a send and terminates the child process", async () => {
    vi.useFakeTimers();

    const child = new MockChildProcess();
    child.closeOnSignal = new Set<NodeJS.Signals>(["SIGTERM"]);
    spawnMock.mockImplementation(() => child);

    const adapter = new ClaudeCodeAdapter();
    await adapter.initialize(createConfig({
      runtimePreferences: {
        timeout: 50,
      },
    }));

    const sendPromise = adapter.send("This will hang");
    const sendExpectation = expect(sendPromise).rejects.toThrow(/timed out/u);
    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(50);

    expect(child.killMock).toHaveBeenCalledWith("SIGTERM");

    await sendExpectation;
    await adapter.teardown();
  });
});

describe("RuntimePool", () => {
  it("returns the same runtime instance for the same conversation key", async () => {
    const pool = new RuntimePool();
    const config = createConfig();

    const first = await pool.getOrCreate("conversation-1", config);
    const second = await pool.getOrCreate("conversation-1", config);

    expect(first).toBe(second);

    await pool.closeAll();
  });

  it("removes a runtime when close is called", async () => {
    const pool = new RuntimePool();
    const config = createConfig();

    await pool.getOrCreate("conversation-1", config);
    expect(pool.get("conversation-1")).toBeDefined();

    await pool.close("conversation-1");

    expect(pool.get("conversation-1")).toBeUndefined();
    expect(pool.size).toBe(0);
  });

  it("closes all runtimes and clears the pool", async () => {
    const pool = new RuntimePool();
    const config = createConfig();

    await pool.getOrCreate("conversation-1", config);
    await pool.getOrCreate("conversation-2", config);

    expect(pool.keys()).toEqual(["conversation-1", "conversation-2"]);

    await pool.closeAll();

    expect(pool.keys()).toEqual([]);
    expect(pool.size).toBe(0);
  });
});

const TEARDOWN_WAIT_MS = 5_000;
