export function buildV2ConversationKey(channelId: string, threadId?: string): string {
  return threadId ? `thread:${threadId}` : `channel:${channelId}`;
}

export function buildSavePassContext(): string {
  return [
    "Save pass (requested by [redacted] via /tango save):",
    "Review this conversation and capture anything that would be lost if the session ended now.",
    "Use memory_add for decisions, insights, corrections, and commitments.",
    'Use source: "manual" and metadata captured_by: "save_pass".',
    "Do not save test artifacts, smoke-test codewords, or ephemeral session-only details unless [redacted] explicitly asked to preserve them.",
    "Confirm what you saved in your reply.",
  ].join("\n");
}

export function mergeSendContext(...sections: Array<string | undefined | null>): string | undefined {
  const merged = sections
    .map((section) => section?.trim())
    .filter((section): section is string => Boolean(section && section.length > 0))
    .join("\n\n");

  return merged.length > 0 ? merged : undefined;
}

export function buildSendContextWithOptionalSavePass(
  warmStartPrompt: string | undefined,
  pendingSave: boolean,
): string | undefined {
  if (!pendingSave) {
    return warmStartPrompt?.trim() ? warmStartPrompt : undefined;
  }

  return mergeSendContext(warmStartPrompt, buildSavePassContext());
}
