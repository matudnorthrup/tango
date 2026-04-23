import {
  isV2RuntimeEnabled,
  type RuntimeResponse,
  type V2AgentConfig,
} from "@tango/core";
import type { VoiceTurnResult } from "@tango/voice";
import type { RouteResult, TangoRouter } from "./tango-router.js";

export const VOICE_V2_ROUTER_TIMEOUT_MS = 30_000;
export const VOICE_V2_TTS_ERROR_MESSAGE = "Sorry, I'm having trouble. Try again.";

function extractProviderSessionId(response: RuntimeResponse): string | undefined {
  const metadata = response.metadata;
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }

  const sessionId = (metadata as Record<string, unknown>).sessionId;
  if (typeof sessionId !== "string") {
    return undefined;
  }

  const normalized = sessionId.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function buildVoiceRouterResult(input: {
  routeResult: RouteResult;
  v2AgentConfig: V2AgentConfig;
  turnId?: string;
}): VoiceTurnResult {
  const result: VoiceTurnResult = {
    deduplicated: false,
    responseText: input.routeResult.response.text,
    providerName: input.v2AgentConfig.runtime.provider,
    providerSessionId: extractProviderSessionId(input.routeResult.response),
    providerUsedFailover: false,
  };

  if (input.turnId) {
    result.turnId = input.turnId;
  }

  return result;
}

export function buildVoiceRouterErrorResult(input: {
  v2AgentConfig: V2AgentConfig;
  turnId?: string;
  responseText?: string;
}): VoiceTurnResult {
  const fallbackText = input.responseText?.trim() || VOICE_V2_TTS_ERROR_MESSAGE;
  const result: VoiceTurnResult = {
    deduplicated: false,
    responseText: fallbackText,
    providerName: input.v2AgentConfig.runtime.provider,
    providerUsedFailover: false,
  };

  if (input.turnId) {
    result.turnId = input.turnId;
  }

  return result;
}

export async function dispatchVoiceTurnByRuntime<T>(input: {
  transcript: string;
  agentId: string;
  channelId: string;
  threadId?: string;
  conversationKey?: string;
  v2AgentConfig?: V2AgentConfig | null;
  tangoRouter?: Pick<TangoRouter, "routeMessage"> | null;
  executeLegacyTurn: () => Promise<T>;
  mapRouterResult: (routeResult: RouteResult) => Promise<T> | T;
  onRouterError?: (error: unknown) => Promise<T> | T;
  sendOptions?: { context?: string };
  timeoutMs?: number;
}): Promise<T> {
  if (!input.v2AgentConfig || !isV2RuntimeEnabled(input.v2AgentConfig)) {
    return input.executeLegacyTurn();
  }

  if (!input.tangoRouter) {
    throw new Error(
      `V2 voice runtime is enabled for agent '${input.agentId}', but TangoRouter is not configured.`,
    );
  }

  try {
    const routeResult = await input.tangoRouter.routeMessage({
      message: input.transcript,
      channelId: input.channelId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.conversationKey ? { conversationKey: input.conversationKey } : {}),
      agentId: input.agentId,
      sendOptions: {
        timeout: input.timeoutMs ?? VOICE_V2_ROUTER_TIMEOUT_MS,
        ...input.sendOptions,
      },
    });
    return await input.mapRouterResult(routeResult);
  } catch (error) {
    if (input.onRouterError) {
      return await input.onRouterError(error);
    }
    throw error;
  }
}
