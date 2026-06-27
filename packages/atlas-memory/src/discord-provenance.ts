function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

/** Discord location env vars injected by TangoRouter into the atlas-memory MCP server. */
export function readDiscordProvenanceFromEnv(): Record<string, string> {
  const result: Record<string, string> = {};

  const conversationKey = process.env.TANGO_CONVERSATION_KEY?.trim();
  if (conversationKey) {
    result.conversation_key = conversationKey;
  }

  const channelId = process.env.TANGO_DISCORD_CHANNEL_ID?.trim();
  if (channelId) {
    result.channel_id = channelId;
  }

  const threadId = process.env.TANGO_DISCORD_THREAD_ID?.trim();
  if (threadId) {
    result.thread_id = threadId;
  }

  return result;
}

export function mergeDiscordProvenanceIntoMemoryAddArgs(
  args: Record<string, unknown>,
  runtimeAgentId?: string,
): Record<string, unknown> {
  const provenance = readDiscordProvenanceFromEnv();
  const existingMetadata = isRecord(args.metadata) ? args.metadata : {};
  const mergedMetadata: Record<string, unknown> = {
    ...provenance,
    ...existingMetadata,
  };

  const runtimeId = runtimeAgentId?.trim();
  const canonicalAgentId = normalizeOptionalString(args.agent_id);
  if (runtimeId && canonicalAgentId && runtimeId !== canonicalAgentId) {
    mergedMetadata.runtime_agent_id = runtimeId;
  }

  const sessionId =
    normalizeOptionalString(args.session_id)
    ?? provenance.conversation_key;

  return {
    ...args,
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(Object.keys(mergedMetadata).length > 0 ? { metadata: mergedMetadata } : {}),
  };
}
