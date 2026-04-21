import {
  ClaudeCliProvider,
  DEFAULT_PROVIDER_TIMEOUT_MS,
} from "@tango/core";
import { AtlasMemoryClient } from "./atlas-memory-client.js";

export interface MemoryCaptureConfig {
  enabled: boolean;
  extractionModel: string;
  importanceThreshold: number;
}

export interface MemoryCaptureContext {
  conversationKey: string;
  agentId: string;
  userMessage: string;
  agentResponse: string;
  channelId: string;
  threadId?: string;
}

interface ExtractedMemory {
  content: string;
  importance: number;
  tags: string[];
}

/**
 * Post-turn memory extraction.
 * Called from TangoRouter's onPostTurn hook.
 * Uses a lightweight model to extract salient facts from the exchange.
 *
 * Example wiring:
 * ```ts
 * const router = new TangoRouter({
 *   agentConfigs,
 *   onPostTurn: async (context) => {
 *     await extractAndStoreMemories(
 *       {
 *         conversationKey: context.conversationKey,
 *         agentId: context.agentId,
 *         userMessage: context.userMessage,
 *         agentResponse: context.response.text,
 *         channelId: context.channelId,
 *         threadId: context.threadId,
 *       },
 *       agentMemoryConfig,
 *       atlasMemoryClient,
 *     );
 *   },
 * });
 * ```
 */
export async function extractAndStoreMemories(
  context: MemoryCaptureContext,
  config: MemoryCaptureConfig,
  atlasMemoryEndpoint: AtlasMemoryClient,
): Promise<void> {
  if (!config.enabled) {
    return;
  }

  try {
    const provider = new ClaudeCliProvider({
      command: normalizeClaudeCommand(process.env.CLAUDE_CLI_COMMAND),
      timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
    });
    const response = await provider.generate({
      prompt: buildExtractionPrompt(context),
      model: config.extractionModel,
      reasoningEffort: "low",
    });
    const extractedMemories = parseExtractionResponse(response.text);

    for (const memory of extractedMemories) {
      if (memory.importance < config.importanceThreshold) {
        continue;
      }

      try {
        await atlasMemoryEndpoint.memoryAdd({
          content: memory.content,
          source: "conversation",
          agent_id: context.agentId,
          session_id: context.conversationKey,
          importance: memory.importance,
          tags: memory.tags,
          metadata: {
            captured_by: "post_turn_extraction",
            conversation_key: context.conversationKey,
            channel_id: context.channelId,
            ...(context.threadId ? { thread_id: context.threadId } : {}),
            extraction_model: config.extractionModel,
          },
        });
      } catch (error) {
        console.warn(
          `[memory-capture] failed to store extracted memory for ${context.conversationKey}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  } catch (error) {
    console.warn(
      `[memory-capture] extraction failed for ${context.conversationKey}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function buildExtractionPrompt(context: MemoryCaptureContext): string {
  return [
    "Extract any facts, decisions, preferences, or commitments worth remembering from this exchange.",
    "Return a JSON array of objects: [{content, importance (0-1), tags: string[]}].",
    "If nothing worth remembering, return [].",
    "",
    `User: ${context.userMessage}`,
    `Agent: ${context.agentResponse}`,
  ].join("\n");
}

function normalizeClaudeCommand(value?: string): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : "claude";
}

function parseExtractionResponse(text: string): ExtractedMemory[] {
  for (const candidate of buildJsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate);
      if (!Array.isArray(parsed)) {
        continue;
      }

      return parsed.flatMap(normalizeExtractedMemory);
    } catch {
      continue;
    }
  }

  throw new Error("Extraction model did not return a valid JSON array");
}

function buildJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  const trimmed = text.trim();

  if (trimmed.length > 0) {
    candidates.push(trimmed);
  }

  const fencedJsonPattern = /```(?:json)?\s*([\s\S]*?)```/giu;
  for (const match of text.matchAll(fencedJsonPattern)) {
    const candidate = match[1]?.trim();
    if (candidate) {
      candidates.push(candidate);
    }
  }

  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start >= 0 && end > start) {
    candidates.push(text.slice(start, end + 1).trim());
  }

  return [...new Set(candidates.filter((candidate) => candidate.length > 0))];
}

function normalizeExtractedMemory(value: unknown): ExtractedMemory[] {
  if (!isRecord(value)) {
    return [];
  }

  const content = normalizeNonEmptyString(value.content);
  const importance = normalizeImportance(value.importance);
  if (!content || importance === null) {
    return [];
  }

  return [{
    content,
    importance,
    tags: normalizeTags(value.tags),
  }];
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeImportance(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) {
    return null;
  }

  return Math.min(Math.max(numeric, 0), 1);
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const tags: string[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }

    const normalized = item.trim().toLowerCase();
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    tags.push(normalized);
  }

  return tags;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
