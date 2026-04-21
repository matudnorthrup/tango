import type { AgentRuntime, AgentRuntimeConfig } from "./agent-runtime.js";
import { ClaudeCodeAdapter } from "./claude-code-adapter.js";

export class RuntimePool {
  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly pendingCreates = new Map<string, Promise<AgentRuntime>>();

  async getOrCreate(conversationKey: string, config: AgentRuntimeConfig): Promise<AgentRuntime> {
    const existing = this.runtimes.get(conversationKey);
    if (existing) {
      return existing;
    }

    const pending = this.pendingCreates.get(conversationKey);
    if (pending) {
      return await pending;
    }

    const creation = (async () => {
      const runtime = new ClaudeCodeAdapter();
      await runtime.initialize(config);
      this.runtimes.set(conversationKey, runtime);
      return runtime;
    })();

    this.pendingCreates.set(conversationKey, creation);

    try {
      return await creation;
    } finally {
      this.pendingCreates.delete(conversationKey);
    }
  }

  get(conversationKey: string): AgentRuntime | undefined {
    return this.runtimes.get(conversationKey);
  }

  async close(conversationKey: string): Promise<void> {
    const pending = this.pendingCreates.get(conversationKey);
    if (pending) {
      await pending;
    }

    const runtime = this.runtimes.get(conversationKey);
    if (!runtime) {
      return;
    }

    this.runtimes.delete(conversationKey);
    await runtime.teardown();
  }

  async closeAll(): Promise<void> {
    const pendingCreates = [...this.pendingCreates.values()];
    if (pendingCreates.length > 0) {
      await Promise.all(pendingCreates);
    }

    const entries = [...this.runtimes.entries()];
    this.runtimes.clear();

    const results = await Promise.allSettled(entries.map(async ([, runtime]) => {
      await runtime.teardown();
    }));

    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);

    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to close one or more runtimes.");
    }
  }

  keys(): string[] {
    return [...this.runtimes.keys()];
  }

  get size(): number {
    return this.runtimes.size;
  }
}
