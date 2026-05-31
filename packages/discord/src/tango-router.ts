import {
  RuntimePool,
  SessionLifecycleManager,
  type AgentRuntimeConfig,
  type ColdStartContextBuilder,
  type RuntimeResponse,
  type SendOptions,
  type SessionLifecycleConfig,
} from "@tango/core";

export interface TangoRouterConfig {
  /** Map of agent IDs to their v2 runtime configs */
  agentConfigs: Map<string, AgentRuntimeConfig>;
  /** Session lifecycle settings */
  lifecycleConfig?: Partial<SessionLifecycleConfig>;
  /** Build cold-start context for a conversation */
  buildColdStartContext?: ColdStartContextBuilder;
  /** Post-turn hook (e.g., memory extraction) */
  onPostTurn?: (context: PostTurnContext) => Promise<void>;
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

export class TangoRouter {
  private readonly lifecycleManager: SessionLifecycleManager;
  private readonly agentConfigs: Map<string, AgentRuntimeConfig>;
  private readonly onPostTurn?: (context: PostTurnContext) => Promise<void>;

  constructor(config: TangoRouterConfig) {
    this.agentConfigs = config.agentConfigs;
    this.onPostTurn = config.onPostTurn;
    this.lifecycleManager = new SessionLifecycleManager(
      new RuntimePool(),
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
  }): Promise<RouteResult> {
    const conversationKey =
      params.conversationKey?.trim()
      || this.getConversationKey(params.channelId, params.threadId);
    const agentConfig = this.resolveAgentConfig(params.agentId);
    const runtimeResponse = await this.lifecycleManager.sendMessage(
      conversationKey,
      agentConfig,
      params.message,
      params.sendOptions,
    );
    const response = sanitizeInternalWorkerDispatchResponse(runtimeResponse);
    if (response !== runtimeResponse) {
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
