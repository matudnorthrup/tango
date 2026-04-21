import type {
  AgentRuntime,
  AgentRuntimeConfig,
  McpServerConfig,
  RuntimeResponse,
  RuntimeState,
  SendOptions,
} from "./agent-runtime.js";
import type { RuntimePool } from "./runtime-pool.js";

const CLOSED_SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

const DEFAULT_SESSION_LIFECYCLE_CONFIG: SessionLifecycleConfig = {
  idleTimeoutHours: 24,
  contextResetThreshold: 0.80,
  idleCheckIntervalMs: 60_000,
};

interface InternalConversationSession extends ConversationSession {
  closedAt?: Date;
}

interface ResumableRuntime extends AgentRuntime {
  getSessionId?: () => string | undefined;
  resumeSession?: (sessionId: string) => void;
}

export interface SessionLifecycleConfig {
  /** Hours of inactivity before closing runtime (default: 24) */
  idleTimeoutHours: number;
  /** Fraction of context window used before hard reset (default: 0.80) */
  contextResetThreshold: number;
  /** Interval in ms to check for idle sessions (default: 60000 = 1 min) */
  idleCheckIntervalMs: number;
}

export interface ConversationSession {
  conversationKey: string;
  agentId: string;
  state: RuntimeState;
  lastMessageAt: Date;
  createdAt: Date;
  sessionId?: string;
  messageCount: number;
}

export interface ColdStartContext {
  pinnedFacts: string;
  recentMessages: string;
  relevantMemories: string;
}

export type ColdStartContextBuilder = (
  conversationKey: string,
  agentId: string,
) => Promise<ColdStartContext>;

function cloneServerConfig(server: McpServerConfig): McpServerConfig {
  return {
    name: server.name,
    command: server.command,
    ...(server.args ? { args: [...server.args] } : {}),
    ...(server.env ? { env: { ...server.env } } : {}),
  };
}

function cloneRuntimeConfig(config: AgentRuntimeConfig): AgentRuntimeConfig {
  return {
    agentId: config.agentId,
    systemPrompt: config.systemPrompt,
    mcpServers: config.mcpServers.map((server) => cloneServerConfig(server)),
    runtimePreferences: {
      ...config.runtimePreferences,
    },
    ...(config.coldStartContext ? { coldStartContext: config.coldStartContext } : {}),
  };
}

function normalizeTextBlock(value: string): string | undefined {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function formatColdStartContext(context: ColdStartContext): string | undefined {
  const sections = [
    { heading: "Pinned facts", content: normalizeTextBlock(context.pinnedFacts) },
    { heading: "Recent conversation", content: normalizeTextBlock(context.recentMessages) },
    { heading: "Relevant memories", content: normalizeTextBlock(context.relevantMemories) },
  ].filter((section): section is { heading: string; content: string } => Boolean(section.content));

  if (sections.length === 0) {
    return undefined;
  }

  return sections.map((section) => `${section.heading}:\n${section.content}`).join("\n\n");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function normalizeFraction(value: unknown): number | undefined {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(numeric) || numeric < 0) {
    return undefined;
  }

  if (numeric <= 1) {
    return numeric;
  }

  if (numeric <= 100) {
    return numeric / 100;
  }

  return undefined;
}

function extractContextUsageFraction(
  metadata: Record<string, unknown> | undefined,
): number | undefined {
  if (!metadata) {
    return undefined;
  }

  const keys = new Set([
    "contextUsage",
    "contextUsageFraction",
    "contextWindowUsage",
    "contextWindowFraction",
    "context_usage",
    "context_usage_fraction",
    "context_window_usage",
    "context_window_fraction",
  ]);

  const seen = new Set<object>();
  const visit = (value: unknown): number | undefined => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = visit(item);
        if (nested !== undefined) {
          return nested;
        }
      }
      return undefined;
    }

    const record = asRecord(value);
    if (!record || seen.has(record)) {
      return undefined;
    }

    seen.add(record);

    for (const key of keys) {
      const nestedValue = normalizeFraction(record[key]);
      if (nestedValue !== undefined) {
        return nestedValue;
      }
    }

    for (const nestedValue of Object.values(record)) {
      const nested = visit(nestedValue);
      if (nested !== undefined) {
        return nested;
      }
    }

    return undefined;
  };

  return visit(metadata);
}

function toConversationSession(session: InternalConversationSession): ConversationSession {
  return {
    conversationKey: session.conversationKey,
    agentId: session.agentId,
    state: session.state,
    lastMessageAt: new Date(session.lastMessageAt),
    createdAt: new Date(session.createdAt),
    ...(session.sessionId ? { sessionId: session.sessionId } : {}),
    messageCount: session.messageCount,
  };
}

function isResumableRuntime(runtime: AgentRuntime): runtime is ResumableRuntime {
  return typeof (runtime as ResumableRuntime).resumeSession === "function"
    || typeof (runtime as ResumableRuntime).getSessionId === "function";
}

export class SessionLifecycleManager {
  private readonly sessions = new Map<string, InternalConversationSession>();
  private readonly resolvedConfig: SessionLifecycleConfig;
  private idleTimer?: NodeJS.Timeout;
  private idleCheckInFlight?: Promise<void>;

  constructor(
    private readonly pool: RuntimePool,
    config: Partial<SessionLifecycleConfig> = {},
    private readonly buildColdStartContext?: ColdStartContextBuilder,
  ) {
    this.resolvedConfig = {
      ...DEFAULT_SESSION_LIFECYCLE_CONFIG,
      ...config,
    };
  }

  async sendMessage(
    conversationKey: string,
    agentConfig: AgentRuntimeConfig,
    message: string,
    options?: SendOptions,
  ): Promise<RuntimeResponse> {
    let session = this.sessions.get(conversationKey);

    if (session && session.agentId !== agentConfig.agentId) {
      await this.resetSession(conversationKey, agentConfig);
      session = this.sessions.get(conversationKey);
    }

    if (!session) {
      const now = new Date();
      session = {
        conversationKey,
        agentId: agentConfig.agentId,
        state: "spawning",
        lastMessageAt: now,
        createdAt: now,
        messageCount: 0,
      };
      this.sessions.set(conversationKey, session);
    }

    let runtime = this.pool.get(conversationKey);
    const needsRuntime = !runtime || session.state === "closed" || session.state === "error";

    if (needsRuntime) {
      if (runtime && session.state === "error") {
        await this.pool.close(conversationKey);
        runtime = undefined;
      }

      session.state = "spawning";
      session.closedAt = undefined;
      runtime = await this.createRuntime(conversationKey, agentConfig, session.sessionId);
      if (session.sessionId) {
        this.restoreRuntimeSession(runtime, session.sessionId);
      }
    }

    if (!runtime) {
      session.state = "error";
      throw new Error(`Failed to acquire runtime for conversation '${conversationKey}'.`);
    }

    session.state = "active";

    let response: RuntimeResponse;
    try {
      response = await runtime.send(message, options);
    } catch (error) {
      session.state = "error";
      throw error;
    }

    const now = new Date();
    session.lastMessageAt = now;
    session.messageCount += 1;
    session.sessionId = this.resolveSessionId(response, runtime) ?? session.sessionId;
    session.state = "idle";

    const contextUsage = extractContextUsageFraction(response.metadata);
    if (
      contextUsage !== undefined
      && contextUsage > this.resolvedConfig.contextResetThreshold
    ) {
      try {
        await this.recreateRuntime(conversationKey, agentConfig, {
          lastMessageAt: now,
        });
      } catch {
        session.state = "error";
      }
    }

    return response;
  }

  getSession(conversationKey: string): ConversationSession | undefined {
    const session = this.sessions.get(conversationKey);
    return session ? toConversationSession(session) : undefined;
  }

  getAllSessions(): ConversationSession[] {
    return [...this.sessions.values()].map((session) => toConversationSession(session));
  }

  async resetSession(conversationKey: string, agentConfig: AgentRuntimeConfig): Promise<void> {
    await this.recreateRuntime(conversationKey, agentConfig, {});
  }

  async closeSession(conversationKey: string): Promise<void> {
    const session = this.sessions.get(conversationKey);
    if (!session) {
      return;
    }

    const runtime = this.pool.get(conversationKey);
    if (runtime) {
      session.sessionId = this.getRuntimeSessionId(runtime) ?? session.sessionId;
      await this.pool.close(conversationKey);
    }

    session.state = "closed";
    session.closedAt = new Date();
  }

  startIdleChecker(): void {
    if (this.idleTimer) {
      return;
    }

    this.idleTimer = setInterval(() => {
      if (!this.idleCheckInFlight) {
        this.idleCheckInFlight = this.runIdleCheck()
          .finally(() => {
            this.idleCheckInFlight = undefined;
          });
      }
    }, this.resolvedConfig.idleCheckIntervalMs);

    this.idleTimer.unref();
  }

  async shutdown(): Promise<void> {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }

    await this.idleCheckInFlight;
    await this.pool.closeAll();

    const closedAt = new Date();
    for (const session of this.sessions.values()) {
      session.state = "closed";
      session.closedAt = closedAt;
    }
  }

  private async createRuntime(
    conversationKey: string,
    agentConfig: AgentRuntimeConfig,
    sessionId?: string,
  ): Promise<AgentRuntime> {
    const coldStartContext = sessionId ? undefined : await this.buildColdStartContextString(
      conversationKey,
      agentConfig.agentId,
    );

    const runtimeConfig = cloneRuntimeConfig(agentConfig);
    if (coldStartContext) {
      runtimeConfig.coldStartContext = coldStartContext;
    }

    return await this.pool.getOrCreate(conversationKey, runtimeConfig);
  }

  private async buildColdStartContextString(
    conversationKey: string,
    agentId: string,
  ): Promise<string | undefined> {
    if (!this.buildColdStartContext) {
      return undefined;
    }

    const coldStartContext = await this.buildColdStartContext(conversationKey, agentId);
    return formatColdStartContext(coldStartContext);
  }

  private restoreRuntimeSession(runtime: AgentRuntime, sessionId: string): void {
    if (!isResumableRuntime(runtime) || typeof runtime.resumeSession !== "function") {
      return;
    }

    runtime.resumeSession(sessionId);
  }

  private getRuntimeSessionId(runtime: AgentRuntime): string | undefined {
    if (!isResumableRuntime(runtime) || typeof runtime.getSessionId !== "function") {
      return undefined;
    }

    return runtime.getSessionId();
  }

  private resolveSessionId(
    response: RuntimeResponse,
    runtime: AgentRuntime,
  ): string | undefined {
    const metadata = asRecord(response.metadata);
    const metadataSessionId = typeof metadata?.sessionId === "string" ? metadata.sessionId.trim() : "";
    if (metadataSessionId.length > 0) {
      return metadataSessionId;
    }

    const runtimeSessionId = this.getRuntimeSessionId(runtime)?.trim();
    return runtimeSessionId && runtimeSessionId.length > 0 ? runtimeSessionId : undefined;
  }

  private async recreateRuntime(
    conversationKey: string,
    agentConfig: AgentRuntimeConfig,
    options: {
      lastMessageAt?: Date;
    },
  ): Promise<void> {
    await this.pool.close(conversationKey);
    const runtime = await this.createRuntime(conversationKey, agentConfig);
    const now = new Date();

    this.sessions.set(conversationKey, {
      conversationKey,
      agentId: agentConfig.agentId,
      state: "idle",
      lastMessageAt: options.lastMessageAt ? new Date(options.lastMessageAt) : now,
      createdAt: now,
      messageCount: 0,
      sessionId: this.getRuntimeSessionId(runtime),
    });
  }

  private async runIdleCheck(): Promise<void> {
    const nowMs = Date.now();
    const idleTimeoutMs = this.resolvedConfig.idleTimeoutHours * 60 * 60 * 1_000;

    for (const [conversationKey, session] of this.sessions.entries()) {
      if (session.state === "closed") {
        if (session.closedAt && nowMs - session.closedAt.getTime() > CLOSED_SESSION_RETENTION_MS) {
          this.sessions.delete(conversationKey);
        }
        continue;
      }

      if (session.state !== "idle") {
        continue;
      }

      if (nowMs - session.lastMessageAt.getTime() <= idleTimeoutMs) {
        continue;
      }

      const runtime = this.pool.get(conversationKey);
      if (runtime) {
        session.sessionId = this.getRuntimeSessionId(runtime) ?? session.sessionId;
      }

      try {
        await this.pool.close(conversationKey);
        session.state = "closed";
        session.closedAt = new Date(nowMs);
      } catch {
        session.state = "error";
      }
    }
  }
}
