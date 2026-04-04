import { z } from "zod";
import type {
  ChatProvider,
  IntentContractConfig,
  IntentRouteKind,
  ProviderReasoningEffort,
  ProviderResponse,
} from "@tango/core";
import {
  generateWithFailover,
  type ProviderFailoverFailure,
} from "./provider-failover.js";

export type DeterministicIntentCatalogEntry = IntentContractConfig;

export interface IntentEnvelope {
  id: string;
  domain: string;
  intentId: string;
  mode: "read" | "write" | "mixed";
  confidence: number;
  entities: Record<string, unknown>;
  rawEntities: string[];
  missingSlots: string[];
  canRunInParallel: boolean;
  routeHint?: {
    kind: IntentRouteKind;
    targetId: string;
  };
}

export interface DeterministicIntentClassification {
  envelopes: IntentEnvelope[];
  meetsThreshold: boolean;
  providerName: string;
  usedFailover: boolean;
  requestPrompt: string;
  systemPrompt: string;
  response: ProviderResponse;
  responseText: string;
  attemptCount: number;
  attemptErrors: string[];
  failures: ProviderFailoverFailure[];
}

export interface IntentClassifierContinuationContext {
  title?: string;
  objective: string;
  expectedIntentIds: string[];
  structuredContext?: Record<string, unknown> | null;
}

const classifierResponseSchema = z.object({
  intents: z.array(
    z.object({
      intentId: z.string().min(1),
      mode: z.enum(["read", "write", "mixed"]).optional(),
      confidence: z.number().min(0).max(1),
      entities: z.record(z.string(), z.unknown()).optional(),
      rawEntities: z.array(z.unknown()).optional(),
      missingSlots: z.array(z.string()).optional(),
      canRunInParallel: z.boolean().optional(),
      routeHint: z
        .object({
          kind: z.enum(["workflow", "worker"]),
          targetId: z.string().min(1),
        })
        .optional(),
    }),
  ).default([]),
}).strict();

function buildCatalogBlock(catalog: readonly DeterministicIntentCatalogEntry[]): string {
  return catalog
    .map((entry) => {
      const lines = [
        `- intentId: ${entry.id}`,
        `  domain: ${entry.domain}`,
        `  displayName: ${entry.displayName ?? entry.id}`,
        `  mode: ${entry.mode}`,
        `  route: ${entry.route.kind}:${entry.route.targetId}`,
        `  description: ${entry.description}`,
      ];
      const requiredSlots = (entry.slots ?? [])
        .filter((slot) => slot.required)
        .map((slot) => slot.name);
      if (requiredSlots.length > 0) {
        lines.push(`  requiredSlots: ${requiredSlots.join(", ")}`);
      }
      const slotDescriptions = (entry.slots ?? [])
        .map((slot) => {
          const markers = [
            slot.required ? "required" : null,
            slot.inferable ? "inferable" : null,
          ].filter((value): value is string => typeof value === "string");
          const suffix = markers.length > 0 ? ` (${markers.join(", ")})` : "";
          return `${slot.name}${suffix}${slot.description ? `: ${slot.description}` : ""}`;
        });
      if (slotDescriptions.length > 0) {
        lines.push(`  slots: ${slotDescriptions.join(" | ")}`);
      }
      if ((entry.examples ?? []).length > 0) {
        lines.push(`  examples: ${entry.examples?.join(" | ")}`);
      }
      if ((entry.classifierHints ?? []).length > 0) {
        lines.push(`  classifierHints: ${entry.classifierHints?.join(" | ")}`);
      }
      if (entry.evaluation?.taskClass) {
        lines.push(`  taskClass: ${entry.evaluation.taskClass}`);
      }
      if ((entry.evaluation?.successCriteria ?? []).length > 0) {
        lines.push(`  successCriteria: ${entry.evaluation?.successCriteria?.join(" | ")}`);
      }
      if ((entry.evaluation?.mustAnswer ?? []).length > 0) {
        lines.push(`  mustAnswer: ${entry.evaluation?.mustAnswer?.join(" | ")}`);
      }
      if ((entry.evaluation?.comparisonAxes ?? []).length > 0) {
        lines.push(`  comparisonAxes: ${entry.evaluation?.comparisonAxes?.join(" | ")}`);
      }
      if ((entry.evaluation?.requiredFields ?? []).length > 0) {
        lines.push(`  requiredFields: ${entry.evaluation?.requiredFields?.join(" | ")}`);
      }
      if (entry.evaluation?.qualityGateRequired !== undefined) {
        lines.push(`  qualityGateRequired: ${entry.evaluation.qualityGateRequired ? "yes" : "no"}`);
      }
      return lines.join("\n");
    })
    .join("\n");
}

function buildClassifierSystemPrompt(catalog: readonly DeterministicIntentCatalogEntry[]): string {
  const supportedDomains = [...new Set(catalog.map((entry) => entry.domain))];
  return [
    "You classify user requests into one or more structured intents.",
    "Return strict JSON only. No prose, no markdown fences, no explanation.",
    "Choose only from the allowed intent IDs below.",
    `Supported domains: ${supportedDomains.join(", ") || "none"}.`,
    "If the message is general chat, emotional support, or not clearly a covered action in one of the supported domains, return {\"intents\":[]}.",
    "If one user message contains multiple covered requests, return multiple intents in the same order they should execute.",
    "Set missingSlots when the intent is clear but a required detail is absent or ambiguous.",
    "Populate inferable slots and useful structured entities when the user message clearly implies them.",
    "Respect the intent catalog below. Use route hints, examples, slot requirements, and classifier hints to disambiguate similar intents.",
    "When the catalog includes taskClass, successCriteria, mustAnswer, comparisonAxes, or requiredFields, use them to infer the right intent and capture matching entities from the user message when possible.",
    "Allowed intents:",
    buildCatalogBlock(catalog),
    'JSON shape: {"intents":[{"intentId":"...","mode":"read|write|mixed","confidence":0.0,"entities":{},"rawEntities":[],"missingSlots":[],"canRunInParallel":true,"routeHint":{"kind":"workflow|worker","targetId":"..."}}]}',
  ].join("\n\n");
}

function buildClassifierPrompt(
  userMessage: string,
  continuation?: IntentClassifierContinuationContext,
  conversationContext?: string,
): string {
  const lines: string[] = [];
  if (continuation) {
    lines.push("Open task continuation context:");
    if (continuation.title?.trim()) {
      lines.push(`Open task title: ${continuation.title.trim()}`);
    }
    lines.push(`Open task objective: ${continuation.objective}`);
    if (continuation.expectedIntentIds.length > 0) {
      lines.push(`Expected intents: ${continuation.expectedIntentIds.join(", ")}`);
    }
    if (continuation.structuredContext && Object.keys(continuation.structuredContext).length > 0) {
      lines.push(`Structured task context: ${JSON.stringify(continuation.structuredContext)}`);
    }
    lines.push(
      "Prefer continuing the open task above unless the new user message clearly changes direction or contradicts it.",
    );
    lines.push("");
  }

  if (conversationContext?.trim()) {
    lines.push("Recent conversation (for reference — do not classify these, only the current message below):");
    lines.push(conversationContext.trim());
    lines.push("");
  }

  lines.push("Current user message:");
  lines.push(userMessage);
  lines.push("");
  lines.push("Return the classification JSON now.");
  return lines.join("\n");
}

function extractJsonBlock(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Intent classifier returned an empty response.");
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

function normalizeRawEntity(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["text", "value", "name", "label"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }
    const serialized = JSON.stringify(value);
    return serialized !== "{}" ? serialized : null;
  }
  return null;
}

function normalizeEnvelope(
  raw: z.infer<typeof classifierResponseSchema>["intents"][number],
  index: number,
  catalogByIntentId: ReadonlyMap<string, DeterministicIntentCatalogEntry>,
): IntentEnvelope {
  const catalogEntry = catalogByIntentId.get(raw.intentId);
  return {
    id: `intent-${index + 1}`,
    domain: catalogEntry?.domain ?? "unknown",
    intentId: raw.intentId,
    mode: raw.mode ?? catalogEntry?.mode ?? "read",
    confidence: raw.confidence,
    entities: raw.entities ?? {},
    rawEntities: (raw.rawEntities ?? [])
      .map((value) => normalizeRawEntity(value))
      .filter((value): value is string => typeof value === "string"),
    missingSlots: raw.missingSlots ?? [],
    canRunInParallel: raw.canRunInParallel ?? catalogEntry?.canRunInParallel ?? true,
    routeHint: raw.routeHint ?? (catalogEntry ? { ...catalogEntry.route } : undefined),
  };
}

function extractSingleGoogleDocReference(texts: Array<string | undefined>): string | null {
  const matches = new Set<string>();
  for (const text of texts) {
    if (!text) {
      continue;
    }
    for (const match of text.matchAll(/https?:\/\/docs\.google\.com\/document\/d\/[A-Za-z0-9_-]+[^\s)"]*/giu)) {
      const url = match[0]?.trim();
      if (url) {
        matches.add(url);
      }
    }
  }
  return matches.size === 1 ? [...matches][0] ?? null : null;
}

function hydrateContextualEntities(
  envelope: IntentEnvelope,
  input: {
    userMessage: string;
    continuation?: IntentClassifierContinuationContext;
    conversationContext?: string;
  },
): IntentEnvelope {
  if (
    envelope.intentId !== "docs.google_doc_read_or_update"
    || typeof envelope.entities?.["doc_query"] === "string"
  ) {
    return envelope;
  }

  const docReference = extractSingleGoogleDocReference([
    input.userMessage,
    input.continuation?.objective,
    input.continuation?.structuredContext ? JSON.stringify(input.continuation.structuredContext) : undefined,
    input.conversationContext,
  ]);
  if (!docReference) {
    return envelope;
  }

  return {
    ...envelope,
    entities: {
      ...envelope.entities,
      doc_query: docReference,
    },
    rawEntities: [...new Set([...envelope.rawEntities, docReference])],
    missingSlots: envelope.missingSlots.filter((slot) => slot !== "doc_query"),
  };
}

export async function classifyDeterministicIntents(input: {
  userMessage: string;
  catalog: readonly DeterministicIntentCatalogEntry[];
  providerChain: Array<{ providerName: string; provider: ChatProvider }>;
  retryLimit: number;
  confidenceThreshold: number;
  model?: string;
  reasoningEffort?: ProviderReasoningEffort;
  continuation?: IntentClassifierContinuationContext;
  conversationContext?: string;
}): Promise<DeterministicIntentClassification> {
  const catalogByIntentId = new Map(input.catalog.map((entry) => [entry.id, entry] as const));
  const requestPrompt = buildClassifierPrompt(input.userMessage, input.continuation, input.conversationContext);
  const systemPrompt = buildClassifierSystemPrompt(input.catalog);
  let remainingChain = [...input.providerChain];
  const aggregateFailures: ProviderFailoverFailure[] = [];

  while (remainingChain.length > 0) {
    const result = await generateWithFailover(
      remainingChain,
      {
        prompt: requestPrompt,
        systemPrompt,
        tools: { mode: "off" },
        model: input.model,
        reasoningEffort: input.reasoningEffort,
      },
      input.retryLimit,
      {},
      {},
    );

    try {
      const parsed = classifierResponseSchema.parse(
        JSON.parse(extractJsonBlock(result.retryResult.response.text)),
      );
      const envelopes = parsed.intents
        .map((intent, index) =>
          normalizeEnvelope(intent, index, catalogByIntentId),
        )
        .map((envelope) =>
          hydrateContextualEntities(envelope, {
            userMessage: input.userMessage,
            continuation: input.continuation,
            conversationContext: input.conversationContext,
          }),
        );
      const meetsThreshold =
        envelopes.length > 0 &&
        envelopes.every((envelope) => envelope.confidence >= input.confidenceThreshold);

      return {
        envelopes,
        meetsThreshold,
        providerName: result.providerName,
        usedFailover: result.usedFailover || aggregateFailures.length > 0,
        requestPrompt: result.requestPrompt,
        systemPrompt,
        response: result.retryResult.response,
        responseText: result.retryResult.response.text,
        attemptCount:
          aggregateFailures.reduce((sum, failure) => sum + failure.attempts, 0) +
          result.retryResult.attempts,
        attemptErrors: [
          ...aggregateFailures.flatMap((failure) => failure.attemptErrors),
          ...result.retryResult.attemptErrors,
        ],
        failures: [...aggregateFailures, ...result.failures],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      aggregateFailures.push(
        ...result.failures,
        {
          providerName: result.providerName,
          attempts: result.retryResult.attempts,
          attemptErrors: [...result.retryResult.attemptErrors, message],
          lastError: message,
        },
      );
      const consumedIndex = remainingChain.findIndex(
        (candidate) => candidate.providerName === result.providerName,
      );
      remainingChain =
        consumedIndex >= 0 ? remainingChain.slice(consumedIndex + 1) : [];
    }
  }

  const summary = aggregateFailures.map((failure) => `${failure.providerName}:${failure.lastError}`).join(" | ");
  throw new Error(summary ? `Intent classifier failed: ${summary}` : "Intent classifier failed.");
}
