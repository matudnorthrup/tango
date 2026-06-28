import { createHash } from "node:crypto";
import type {
  AgentRuntime,
  AgentRuntimeConfig,
  McpServerConfig,
  RuntimeResponse,
  RuntimeState,
  SendOptions,
} from "./agent-runtime.js";
import { isRuntimeAbortedError } from "./agent-runtime.js";
import type { RuntimePool } from "./runtime-pool.js";
import {
  extractContextUsageFraction,
  extractResponderContextUsage,
  shouldResetContextPressureAlert,
  type LastContextUsageSnapshot,
} from "./context-usage.js";

const CLOSED_SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

const DEFAULT_SESSION_LIFECYCLE_CONFIG: SessionLifecycleConfig = {
  idleTimeoutHours: 24,
  contextResetThreshold: 0.80,
  idleCheckIntervalMs: 60_000,
};

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
  closedAt?: Date;
  lastContextUsage?: LastContextUsageSnapshot;
  contextPressureAlertSent?: boolean;
  contextAutoResetNotice?: ContextAutoResetNotice;
  runtimeResumeSignature?: string;
  mcpServerNames?: string[];
}

export interface ContextAutoResetNotice {
  fraction: number;
  recordedAt: Date;
}

export interface ColdStartContext {
  pinnedFacts: string;
  recentMessages: string;
  relevantMemories: string;
  attachmentDirectories?: string;
}

export type ColdStartContextBuilder = (
  conversationKey: string,
  agentId: string,
) => Promise<ColdStartContext>;

function cloneServerConfig(server: McpServerConfig): McpServerConfig {
  return {
    name: server.name,
    ...(server.command ? { command: server.command } : {}),
    ...(server.args ? { args: [...server.args] } : {}),
    ...(server.env ? { env: { ...server.env } } : {}),
    ...(server.url ? { url: server.url } : {}),
    ...(server.headers ? { headers: { ...server.headers } } : {}),
  };
}

function cloneMcpMountSelection(
  selection: AgentRuntimeConfig["mcpMountSelection"],
): AgentRuntimeConfig["mcpMountSelection"] {
  if (!selection) {
    return undefined;
  }

  return {
    defaultServerNames: [...selection.defaultServerNames],
    availableServerNames: [...selection.availableServerNames],
    mountedServerNames: [...selection.mountedServerNames],
    activatedServerNames: [...selection.activatedServerNames],
    triggerReasons: Object.fromEntries(
      Object.entries(selection.triggerReasons).map(([name, reasons]) => [name, [...reasons]]),
    ),
  };
}

function cloneRuntimeConfig(config: AgentRuntimeConfig): AgentRuntimeConfig {
  return {
    agentId: config.agentId,
    systemPrompt: config.systemPrompt,
    mcpServers: config.mcpServers.map((server) => cloneServerConfig(server)),
    ...(config.availableMcpServers
      ? { availableMcpServers: config.availableMcpServers.map((server) => cloneServerConfig(server)) }
      : {}),
    ...(config.mcpMountSelection
      ? { mcpMountSelection: cloneMcpMountSelection(config.mcpMountSelection) }
      : {}),
    runtimePreferences: {
      ...config.runtimePreferences,
    },
    ...(config.coldStartContext ? { coldStartContext: config.coldStartContext } : {}),
    ...(config.backend ? { backend: config.backend } : {}),
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
    { heading: "Attachment directories", content: normalizeTextBlock(context.attachmentDirectories ?? "") },
  ].filter((section): section is { heading: string; content: string } => Boolean(section.content));

  if (sections.length === 0) {
    return undefined;
  }

  return sections.map((section) => `${section.heading}:\n${section.content}`).join("\n\n");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function buildRuntimeResumeSignature(config: AgentRuntimeConfig): string {
  const payload = {
    agentId: config.agentId,
    backend: config.backend ?? "claude-code",
    systemPrompt: config.systemPrompt,
    mcpServers: config.mcpServers.map((server) => ({
      name: server.name,
      command: server.command,
      args: server.args ?? [],
      env: server.env ?? {},
      url: server.url,
      headers: server.headers ?? {},
    })),
    runtimePreferences: config.runtimePreferences,
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function toConversationSession(session: ConversationSession): ConversationSession {
  return {
    conversationKey: session.conversationKey,
    agentId: session.agentId,
    state: session.state,
    lastMessageAt: new Date(session.lastMessageAt),
    createdAt: new Date(session.createdAt),
    ...(session.sessionId ? { sessionId: session.sessionId } : {}),
    messageCount: session.messageCount,
    ...(session.closedAt ? { closedAt: new Date(session.closedAt) } : {}),
    ...(session.lastContextUsage
      ? {
          lastContextUsage: {
            ...session.lastContextUsage,
            recordedAt: new Date(session.lastContextUsage.recordedAt),
          },
        }
      : {}),
    ...(session.contextPressureAlertSent
      ? { contextPressureAlertSent: session.contextPressureAlertSent }
      : {}),
    ...(session.contextAutoResetNotice
      ? {
          contextAutoResetNotice: {
            fraction: session.contextAutoResetNotice.fraction,
            recordedAt: new Date(session.contextAutoResetNotice.recordedAt),
          },
        }
      : {}),
    ...(session.runtimeResumeSignature
      ? { runtimeResumeSignature: session.runtimeResumeSignature }
      : {}),
    ...(session.mcpServerNames ? { mcpServerNames: [...session.mcpServerNames] } : {}),
  };
}

function isResumableRuntime(runtime: AgentRuntime): runtime is ResumableRuntime {
  return typeof (runtime as ResumableRuntime).resumeSession === "function"
    || typeof (runtime as ResumableRuntime).getSessionId === "function";
}

function omitContextForResumedRuntime(
  options: SendOptions | undefined,
  hasProviderSession: boolean,
): SendOptions | undefined {
  if (!hasProviderSession || !options?.context?.trim()) {
    return options;
  }

  const { context: _context, ...rest } = options;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

export class SessionLifecycleManager {
  private readonly sessions = new Map<string, ConversationSession>();
  private readonly resolvedConfig: Required<
    Pick<SessionLifecycleConfig, "idleTimeoutHours" | "contextResetThreshold" | "idleCheckIntervalMs">
  >;
  private idleTimer?: NodeJS.Timeout;
  private idleCheckInFlight?: Promise<void>;

  constructor(
    private readonly pool: RuntimePool,
    config: Partial<SessionLifecycleConfig> = {},
    private readonly buildColdStartContext?: ColdStartContextBuilder,
  ) {
    this.resolvedConfig = {
      idleTimeoutHours: config.idleTimeoutHours ?? DEFAULT_SESSION_LIFECYCLE_CONFIG.idleTimeoutHours,
      contextResetThreshold:
        config.contextResetThreshold ?? DEFAULT_SESSION_LIFECYCLE_CONFIG.contextResetThreshold,
      idleCheckIntervalMs:
        config.idleCheckIntervalMs ?? DEFAULT_SESSION_LIFECYCLE_CONFIG.idleCheckIntervalMs,
    };
  }

  async sendMessage(
    conversationKey: string,
    agentConfig: AgentRuntimeConfig,
    message: string,
    options?: SendOptions,
  ): Promise<RuntimeResponse> {
    let session = this.sessions.get(conversationKey);
    const runtimeResumeSignature = buildRuntimeResumeSignature(agentConfig);
    const mcpServerNames = agentConfig.mcpServers.map((server) => server.name);

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
    const runtimeSurfaceChanged =
      Boolean(runtime)
      && Boolean(session.runtimeResumeSignature)
      && session.runtimeResumeSignature !== runtimeResumeSignature;
    if (runtimeSurfaceChanged) {
      await this.pool.close(conversationKey);
      runtime = undefined;
      session.state = "spawning";
      session.sessionId = undefined;
      session.messageCount = 0;
      session.contextPressureAlertSent = false;
      session.lastContextUsage = undefined;
      session.contextAutoResetNotice = undefined;
    }

    const needsRuntime = !runtime || session.state === "closed" || session.state === "error";

    if (needsRuntime) {
      if (runtime && session.state === "error") {
        await this.pool.close(conversationKey);
        runtime = undefined;
      }

      if (session.state === "closed") {
        session.contextPressureAlertSent = false;
        session.lastContextUsage = undefined;
      }

      session.state = "spawning";
      session.closedAt = undefined;
      session.runtimeResumeSignature = runtimeResumeSignature;
      session.mcpServerNames = mcpServerNames;
      runtime = await this.createRuntime(conversationKey, agentConfig, session.sessionId);
      if (session.sessionId) {
        this.restoreRuntimeSession(runtime, session.sessionId);
      }
    } else {
      session.runtimeResumeSignature = runtimeResumeSignature;
      session.mcpServerNames = mcpServerNames;
    }

    if (!runtime) {
      session.state = "error";
      throw new Error(`Failed to acquire runtime for conversation '${conversationKey}'.`);
    }

    this.ensureRuntimeSessionBound(runtime, session.sessionId);

    session.state = "active";

    let response: RuntimeResponse;
    try {
      const effectiveOptions = omitContextForResumedRuntime(
        options,
        Boolean(this.getRuntimeSessionId(runtime)?.trim()),
      );
      response = await runtime.send(message, effectiveOptions);
    } catch (error) {
      if (isRuntimeAbortedError(error)) {
        session.state = "idle";
        session.sessionId = this.getRuntimeSessionId(runtime) ?? session.sessionId;
        throw error;
      }
      session.state = "error";
      throw error;
    }

    const now = new Date();
    session.lastMessageAt = now;
    session.messageCount += 1;
    session.sessionId = this.resolveSessionId(response, runtime) ?? session.sessionId;
    session.state = "idle";

    const responderUsage = extractResponderContextUsage(response.metadata);
    const contextUsage =
      responderUsage?.fraction ?? extractContextUsageFraction(response.metadata);

    if (responderUsage) {
      session.lastContextUsage = {
        fraction: responderUsage.fraction,
        totalTokens: responderUsage.totalTokens,
        contextWindow: responderUsage.contextWindow,
        recordedAt: now,
      };
    } else if (contextUsage !== undefined) {
      session.lastContextUsage = {
        fraction: contextUsage,
        totalTokens: 0,
        contextWindow: 0,
        recordedAt: now,
      };
    }

    if (shouldResetContextPressureAlert(session.lastContextUsage)) {
      session.contextPressureAlertSent = false;
    }

    if (
      contextUsage !== undefined
      && contextUsage > this.resolvedConfig.contextResetThreshold
    ) {
      const resetFraction = contextUsage;
      try {
        await this.recreateRuntime(conversationKey, agentConfig, {
          lastMessageAt: now,
        });
        const resetSession = this.sessions.get(conversationKey);
        if (resetSession) {
          resetSession.contextAutoResetNotice = {
            fraction: resetFraction,
            recordedAt: now,
          };
        }
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

  markContextPressureAlertSent(conversationKey: string): void {
    const session = this.sessions.get(conversationKey);
    if (session) {
      session.contextPressureAlertSent = true;
    }
  }

  consumeContextAutoResetNotice(conversationKey: string): ContextAutoResetNotice | undefined {
    const session = this.sessions.get(conversationKey);
    if (!session?.contextAutoResetNotice) {
      return undefined;
    }

    const notice = {
      fraction: session.contextAutoResetNotice.fraction,
      recordedAt: new Date(session.contextAutoResetNotice.recordedAt),
    };
    delete session.contextAutoResetNotice;
    return notice;
  }

  restoreContextAutoResetNotice(
    conversationKey: string,
    notice: ContextAutoResetNotice,
  ): void {
    const session = this.sessions.get(conversationKey);
    if (!session) {
      return;
    }

    session.contextAutoResetNotice = {
      fraction: notice.fraction,
      recordedAt: new Date(notice.recordedAt),
    };
  }

  async resetSession(conversationKey: string, agentConfig: AgentRuntimeConfig): Promise<void> {
    await this.recreateRuntime(conversationKey, agentConfig, {});
  }

  async abortActiveRun(conversationKey: string): Promise<boolean> {
    const session = this.sessions.get(conversationKey);
    const runtime = this.pool.get(conversationKey);
    if (!runtime) {
      return false;
    }

    const preservedSessionId = this.getRuntimeSessionId(runtime) ?? session?.sessionId;
    const aborted = runtime.abortActiveRun?.() ?? false;

    if (session && (aborted || session.state === "active" || session.state === "spawning")) {
      session.state = "idle";
      if (preservedSessionId) {
        session.sessionId = preservedSessionId;
      }
    }

    return aborted;
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

  private ensureRuntimeSessionBound(
    runtime: AgentRuntime,
    sessionId: string | undefined,
  ): void {
    const boundSessionId = sessionId?.trim();
    if (!boundSessionId) {
      return;
    }

    const runtimeSessionId = this.getRuntimeSessionId(runtime)?.trim();
    if (runtimeSessionId === boundSessionId) {
      return;
    }

    this.restoreRuntimeSession(runtime, boundSessionId);
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
    const runtimeResumeSignature = buildRuntimeResumeSignature(agentConfig);

    this.sessions.set(conversationKey, {
      conversationKey,
      agentId: agentConfig.agentId,
      state: "idle",
      lastMessageAt: options.lastMessageAt ? new Date(options.lastMessageAt) : now,
      createdAt: now,
      messageCount: 0,
      sessionId: this.getRuntimeSessionId(runtime),
      contextPressureAlertSent: false,
      lastContextUsage: undefined,
      runtimeResumeSignature,
      mcpServerNames: agentConfig.mcpServers.map((server) => server.name),
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
