export const DEFAULT_CONTEXT_PRESSURE_ALERT_THRESHOLD = 0.70;

export interface ResponderContextUsage {
  fraction: number;
  totalTokens: number;
  contextWindow: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface LastContextUsageSnapshot {
  fraction: number;
  totalTokens: number;
  contextWindow: number;
  recordedAt: Date;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function normalizeFraction(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  if (value >= 0 && value <= 1) {
    return value;
  }

  if (value > 1 && value <= 100) {
    return value / 100;
  }

  return undefined;
}

interface ModelUsageEntryStats {
  fraction: number;
  totalTokens: number;
  contextWindow: number;
  carriesConversationContext: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

function statsForModelUsageEntry(entry: Record<string, unknown>): ModelUsageEntryStats | undefined {
  const contextWindow = typeof entry.contextWindow === "number" ? entry.contextWindow : 0;
  if (contextWindow <= 0) {
    return undefined;
  }

  const inputTokens = typeof entry.inputTokens === "number" ? entry.inputTokens : 0;
  const outputTokens = typeof entry.outputTokens === "number" ? entry.outputTokens : 0;
  const cacheRead = typeof entry.cacheReadInputTokens === "number" ? entry.cacheReadInputTokens : 0;
  const cacheCreation = typeof entry.cacheCreationInputTokens === "number" ? entry.cacheCreationInputTokens : 0;

  const totalTokens = inputTokens + outputTokens + cacheRead + cacheCreation;
  if (totalTokens <= 0) {
    return undefined;
  }

  const carriesConversationContext = cacheRead > 0 || cacheCreation > 0;

  return {
    fraction: totalTokens / contextWindow,
    totalTokens,
    contextWindow,
    carriesConversationContext,
    inputTokens,
    outputTokens,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
  };
}

function selectResponderModelUsageStats(
  modelUsage: Record<string, unknown>,
): ModelUsageEntryStats | undefined {
  let bestResponder: ModelUsageEntryStats | undefined;
  let bestOverall: ModelUsageEntryStats | undefined;

  for (const rawEntry of Object.values(modelUsage)) {
    const entry = asRecord(rawEntry);
    if (!entry) {
      continue;
    }

    const stats = statsForModelUsageEntry(entry);
    if (!stats) {
      continue;
    }

    if (!bestOverall || stats.fraction > bestOverall.fraction) {
      bestOverall = stats;
    }

    if (stats.carriesConversationContext) {
      if (!bestResponder || stats.fraction > bestResponder.fraction) {
        bestResponder = stats;
      }
    }
  }

  return bestResponder ?? bestOverall;
}

function findModelUsage(
  value: unknown,
  seen = new Set<object>(),
): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (!record || seen.has(record)) {
    return undefined;
  }

  seen.add(record);

  if (record.modelUsage) {
    const modelUsage = asRecord(record.modelUsage);
    if (modelUsage) {
      return modelUsage;
    }
  }

  for (const child of Object.values(record)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = findModelUsage(item, seen);
        if (found) {
          return found;
        }
      }
    } else {
      const found = findModelUsage(child, seen);
      if (found) {
        return found;
      }
    }
  }

  return undefined;
}

/**
 * Responder-level usage from Claude CLI `modelUsage` metadata.
 * Picks the model entry carrying conversation context (cache read/create),
 * not small Haiku router calls on the same turn.
 */
export function extractResponderContextUsage(
  metadata: Record<string, unknown> | undefined,
): ResponderContextUsage | undefined {
  if (!metadata) {
    return undefined;
  }

  const modelUsage = findModelUsage(metadata);
  if (!modelUsage) {
    return undefined;
  }

  const picked = selectResponderModelUsageStats(modelUsage);
  if (!picked) {
    return undefined;
  }

  return {
    fraction: picked.fraction,
    totalTokens: picked.totalTokens,
    contextWindow: picked.contextWindow,
    inputTokens: picked.inputTokens,
    outputTokens: picked.outputTokens,
    cacheReadInputTokens: picked.cacheReadInputTokens,
    cacheCreationInputTokens: picked.cacheCreationInputTokens,
  };
}

export function extractContextUsageFraction(
  metadata: Record<string, unknown> | undefined,
): number | undefined {
  const responderUsage = extractResponderContextUsage(metadata);
  if (responderUsage !== undefined) {
    return responderUsage.fraction;
  }

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

export function formatCompactTokenCount(value: number): string {
  if (value >= 10_000) {
    return `${Math.round(value / 1000)}K`;
  }

  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}K`;
  }

  return `${Math.round(value)}`;
}

export function formatContextUsageSummary(
  usage: Pick<LastContextUsageSnapshot, "fraction" | "totalTokens" | "contextWindow"> | undefined,
): string {
  if (!usage) {
    return "Context: unknown (CLI did not report usage on the last turn)";
  }

  const percent = Math.round(usage.fraction * 100);
  return `Context: ${percent}% (${formatCompactTokenCount(usage.totalTokens)} / ${formatCompactTokenCount(usage.contextWindow)} tokens)`;
}

export function shouldSendContextPressureAlert(
  usage: Pick<LastContextUsageSnapshot, "fraction"> | undefined,
  alreadySent: boolean,
  threshold = DEFAULT_CONTEXT_PRESSURE_ALERT_THRESHOLD,
): boolean {
  return !alreadySent && usage !== undefined && usage.fraction >= threshold;
}

export function shouldResetContextPressureAlert(
  usage: Pick<LastContextUsageSnapshot, "fraction"> | undefined,
  threshold = DEFAULT_CONTEXT_PRESSURE_ALERT_THRESHOLD,
): boolean {
  return usage === undefined || usage.fraction < threshold - 0.05;
}
