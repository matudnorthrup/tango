import {
  RuntimePool,
  SessionLifecycleManager,
  selectMcpServersForTurn,
  type AgentRuntimeConfig,
  type ChatProvider,
  type ColdStartContextBuilder,
  type ContextAutoResetNotice,
  type ConversationSession,
  type RuntimeResponse,
  type SendOptions,
  type SessionLifecycleConfig,
} from "@tango/core";
import { augmentRuntimeConfigWithDiscordProvenance, buildDiscordTurnProvenanceEnv, type DiscordTurnProvenance } from "./discord-memory-provenance.js";
import { writeDiscordTurnProvenanceSnapshot } from "@tango/core";

export interface TangoRouterConfig {
  /** Map of agent IDs to their v2 runtime configs */
  agentConfigs: Map<string, AgentRuntimeConfig>;
  /** Session lifecycle settings */
  lifecycleConfig?: Partial<SessionLifecycleConfig>;
  /** Build cold-start context for a conversation */
  buildColdStartContext?: ColdStartContextBuilder;
  /** Post-turn hook (e.g., memory extraction) */
  onPostTurn?: (context: PostTurnContext) => Promise<void>;
  /**
   * Stateless chat provider used for agents whose runtime config sets
   * backend: "ollama". Passed through to the RuntimePool.
   */
  ollamaProvider?: ChatProvider;
}

export interface PostTurnContext {
  conversationKey: string;
  agentId: string;
  userMessage: string;
  response: RuntimeResponse;
  channelId: string;
  threadId?: string;
}

export interface RouteResult {
  response: RuntimeResponse;
  agentId: string;
  conversationKey: string;
}

const INTERNAL_WORKER_DISPATCH_FALLBACK =
  "Sorry, I tried to use an internal worker handoff that is not available in this runtime. Please ask again and I will handle it directly.";

export function sanitizeInternalWorkerDispatchResponse(response: RuntimeResponse): RuntimeResponse {
  if (!response.text.includes("<worker-dispatch")) {
    return response;
  }

  return {
    ...response,
    text: INTERNAL_WORKER_DISPATCH_FALLBACK,
    metadata: {
      ...response.metadata,
      sanitizedInternalWorkerDispatch: true,
      originalTextLength: response.text.length,
    },
  };
}

function attachMcpSelectionMetadata(
  response: RuntimeResponse,
  selection: AgentRuntimeConfig["mcpMountSelection"],
): RuntimeResponse {
  if (!selection) {
    return response;
  }

  return {
    ...response,
    metadata: {
      ...(response.metadata ?? {}),
      mcpTooling: selection,
    },
  };
}

export class TangoRouter {
  private readonly lifecycleManager: SessionLifecycleManager;
  private readonly agentConfigs: Map<string, AgentRuntimeConfig>;
  private readonly onPostTurn?: (context: PostTurnContext) => Promise<void>;

  constructor(config: TangoRouterConfig) {
    this.agentConfigs = config.agentConfigs;
    this.onPostTurn = config.onPostTurn;
    this.lifecycleManager = new SessionLifecycleManager(
      new RuntimePool(config.ollamaProvider ? { ollamaProvider: config.ollamaProvider } : {}),
      config.lifecycleConfig,
      config.buildColdStartContext,
    );
    this.lifecycleManager.startIdleChecker();
  }

  /**
   * Route a message to the appropriate agent runtime.
   * This is the main entry point — replaces executeTurn().
   */
  async routeMessage(params: {
    message: string;
    channelId: string;
    threadId?: string;
    conversationKey?: string;
    agentId: string;
    sendOptions?: SendOptions;
    discordTurn?: Omit<DiscordTurnProvenance, "conversationKey" | "channelId" | "threadId" | "agentId">;
  }): Promise<RouteResult> {
    const conversationKey =
      params.conversationKey?.trim()
      || this.getConversationKey(params.channelId, params.threadId);
    const turnProvenance: DiscordTurnProvenance = {
      conversationKey,
      channelId: params.channelId,
      ...(params.threadId ? { threadId: params.threadId } : {}),
      agentId: params.agentId,
      capturedBy: params.discordTurn?.capturedBy ?? "agent_save",
      ...(params.discordTurn?.requestedByUserId
        ? { requestedByUserId: params.discordTurn.requestedByUserId }
        : {}),
      ...(params.discordTurn?.trigger ? { trigger: params.discordTurn.trigger } : {}),
      ...(params.discordTurn?.timeZone ? { timeZone: params.discordTurn.timeZone } : {}),
    };
    writeDiscordTurnProvenanceSnapshot(buildDiscordTurnProvenanceEnv(turnProvenance), {
      conversationKey: turnProvenance.conversationKey,
    });
    const baseAgentConfig = augmentRuntimeConfigWithDiscordProvenance(
      this.resolveAgentConfig(params.agentId),
      turnProvenance,
    );
    const { config: agentConfig, selection: mcpSelection } = selectMcpServersForTurn(
      baseAgentConfig,
      {
        message: params.message,
        sendOptions: params.sendOptions,
      },
    );
    const runtimeResponse = await this.lifecycleManager.sendMessage(
      conversationKey,
      agentConfig,
      params.message,
      params.sendOptions,
    );
    const sanitizedResponse = sanitizeInternalWorkerDispatchResponse(runtimeResponse);
    const response = attachMcpSelectionMetadata(sanitizedResponse, mcpSelection);
    if (sanitizedResponse !== runtimeResponse) {
      console.warn(
        `[tango-router] suppressed internal worker-dispatch markup for ${conversationKey} agent=${params.agentId}`,
      );
    }

    this.schedulePostTurn({
      conversationKey,
      agentId: params.agentId,
      userMessage: params.message,
      response,
      channelId: params.channelId,
      ...(params.threadId ? { threadId: params.threadId } : {}),
    });

    return {
      response,
      agentId: params.agentId,
      conversationKey,
    };
  }

  /** Get the conversation key for a channel/thread */
  getConversationKey(channelId: string, threadId?: string): string {
    return threadId ? `thread:${threadId}` : `channel:${channelId}`;
  }

  /** Force reset a conversation (new provider session on next message). */
  async resetConversation(channelId: string, threadId?: string): Promise<void> {
    const conversationKey = this.getConversationKey(channelId, threadId);
    const session = this.lifecycleManager.getSession(conversationKey);

    if (!session) {
      return;
    }

    const agentConfig = this.resolveAgentConfig(session.agentId);
    await this.lifecycleManager.resetSession(conversationKey, agentConfig);
  }

  /** Abort an in-flight generation without rotating the provider session. */
  async abortConversation(channelId: string, threadId?: string): Promise<boolean> {
    const conversationKey = this.getConversationKey(channelId, threadId);
    return await this.lifecycleManager.abortActiveRun(conversationKey);
  }

  /** Get lifecycle session metadata for a channel/thread conversation. */
  getSession(channelId: string, threadId?: string): ConversationSession | undefined {
    return this.lifecycleManager.getSession(this.getConversationKey(channelId, threadId));
  }

  markContextPressureAlertSent(channelId: string, threadId?: string): void {
    this.lifecycleManager.markContextPressureAlertSent(this.getConversationKey(channelId, threadId));
  }

  consumeContextAutoResetNotice(
    channelId: string,
    threadId?: string,
  ): ContextAutoResetNotice | undefined {
    return this.lifecycleManager.consumeContextAutoResetNotice(
      this.getConversationKey(channelId, threadId),
    );
  }

  restoreContextAutoResetNotice(
    channelId: string,
    threadId: string | undefined,
    notice: ContextAutoResetNotice,
  ): void {
    this.lifecycleManager.restoreContextAutoResetNotice(
      this.getConversationKey(channelId, threadId),
      notice,
    );
  }

  /** Shut down all runtimes */
  async shutdown(): Promise<void> {
    await this.lifecycleManager.shutdown();
  }

  private resolveAgentConfig(agentId: string): AgentRuntimeConfig {
    const agentConfig = this.agentConfigs.get(agentId);
    if (!agentConfig) {
      throw new Error(`Unknown agentId '${agentId}'. No runtime config is registered.`);
    }

    return agentConfig;
  }

  private schedulePostTurn(context: PostTurnContext): void {
    if (!this.onPostTurn) {
      return;
    }

    setImmediate(() => {
      void this.onPostTurn?.(context).catch((error) => {
        console.warn(
          `[tango-router] post-turn hook failed for ${context.conversationKey}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    });
  }
}
