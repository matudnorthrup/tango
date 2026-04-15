import type { WorkerAgentResult } from "@tango/core";
import type { NutritionLogItemInput } from "./nutrition-log-executor.js";
import { executeNutritionLogItems } from "./nutrition-log-executor.js";
import {
  callFatsecretApi,
  findRecipeMatchesByQuery,
  resolveWellnessToolPaths,
  type WellnessToolPaths,
} from "./wellness-agent-tools.js";

interface DeterministicTaskMetadata {
  intentId: string;
  userMessage: string;
  entities: Record<string, unknown>;
}

export interface DeterministicWorkerFastPathInput {
  workerId: string;
  task: string;
  toolIds?: string[];
  wellnessToolPaths?: WellnessToolPaths;
  fatsecretExecutor?: (input: {
    method: string;
    params: Record<string, unknown>;
  }) => Promise<unknown>;
}

type NutritionFastPathMeal = "breakfast" | "lunch" | "dinner" | "other";

export async function tryExecuteDeterministicWorkerFastPath(
  input: DeterministicWorkerFastPathInput,
): Promise<WorkerAgentResult | null> {
  const task = parseDeterministicTaskMetadata(input.task);
  if (!task) {
    return null;
  }

  const allowedToolIds = new Set((input.toolIds ?? []).map((toolId) => toolId.trim()).filter(Boolean));
  if (input.workerId !== "nutrition-logger" || !allowedToolIds.has("nutrition_log_items")) {
    return null;
  }

  if (task.intentId === "nutrition.log_food") {
    const foodItems = extractLogFoodItems(task.entities);
    if (!foodItems || foodItems.length === 0) {
      return null;
    }
    return executeNutritionFastPath({
      items: foodItems,
      meal: normalizeMeal(task.entities["meal"], task.userMessage),
      date: normalizeDateScope(task.entities["date_scope"] ?? task.entities["dateScope"] ?? task.entities["date"]),
      input,
    });
  }

  if (task.intentId === "nutrition.log_recipe") {
    const recipeQuery = getStringEntity(task.entities, ["recipe_query", "recipeQuery"]);
    if (!recipeQuery) {
      return null;
    }
    const recipeMatch = findRecipeMatchesByQuery(recipeQuery, input.wellnessToolPaths)[0];
    if (!recipeMatch) {
      return null;
    }
    const recipeItems = parseRecipeIngredients(recipeMatch.content);
    if (!recipeItems || recipeItems.length === 0) {
      return null;
    }
    const overrides = extractIngredientOverrides(task.userMessage);
    const itemsWithOverrides = applyIngredientOverrides(recipeItems, overrides);
    if (!itemsWithOverrides) {
      return null;
    }
    return executeNutritionFastPath({
      items: itemsWithOverrides,
      meal: normalizeMeal(task.entities["meal"], task.userMessage),
      date: normalizeDateScope(task.entities["date_scope"] ?? task.entities["dateScope"] ?? task.entities["date"]),
      input,
    });
  }

  return null;
}

async function executeNutritionFastPath(input: {
  items: NutritionLogItemInput[];
  meal: NutritionFastPathMeal;
  date?: string;
  input: DeterministicWorkerFastPathInput;
}): Promise<WorkerAgentResult> {
  const startedAt = Date.now();
  const paths = resolveWellnessToolPaths(input.input.wellnessToolPaths);
  const rawOutput = await executeNutritionLogItems(
    {
      items: input.items,
      meal: input.meal,
      date: input.date,
    },
    {
      atlasDbPath: paths.atlasDbPath,
      fatsecretCall: (method, params) =>
        input.input.fatsecretExecutor
          ? input.input.fatsecretExecutor({ method, params })
          : callFatsecretApi(method, params, input.input.wellnessToolPaths),
    },
  );
  const output = annotateVerifiedWriteOutcome(rawOutput);

  return {
    text: buildNutritionFastPathSummary(output, input.meal, input.date),
    toolCalls: [
      {
        name: "nutrition_log_items",
        input: {
          items: input.items,
          meal: input.meal,
          ...(input.date ? { date: input.date } : {}),
        },
        output,
        durationMs: Date.now() - startedAt,
      },
    ],
    durationMs: Date.now() - startedAt,
    raw: output,
  };
}

function parseDeterministicTaskMetadata(task: string): DeterministicTaskMetadata | null {
  const intentId = extractPrefixedLine(task, "Intent contract: ");
  const entitiesJson =
    extractPrefixedLine(task, "Extracted entities: ")
    ?? extractPrefixedLine(task, "Extracted inputs: ");
  if (!intentId || !entitiesJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(entitiesJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return {
      intentId,
      userMessage:
        extractPrefixedLine(task, "User follow-up message: ")
        ?? extractPrefixedLine(task, "Latest user message: ")
        ?? extractPrefixedLine(task, "User message: ")
        ?? extractPrefixedLine(task, "Original user message (background only): ")
        ?? "",
      entities: parsed as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

function extractPrefixedLine(task: string, prefix: string): string | null {
  const line = task.split(/\r?\n/u).find((candidate) => candidate.startsWith(prefix));
  const value = line?.slice(prefix.length).trim();
  return value && value.length > 0 ? value : null;
}

function extractLogFoodItems(entities: Record<string, unknown>): NutritionLogItemInput[] | null {
  const itemsValue = entities["items"];
  if (!Array.isArray(itemsValue)) {
    return null;
  }

  const items: NutritionLogItemInput[] = [];
  for (const entry of itemsValue) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const name = typeof entry["name"] === "string" ? entry["name"].trim() : "";
      const quantity = typeof entry["quantity"] === "string" ? entry["quantity"].trim() : "";
      if (!name || !quantity) {
        return null;
      }
      items.push({ name, quantity });
      continue;
    }

    if (typeof entry === "string") {
      const parsed = parseInlineFoodItem(entry);
      if (!parsed) {
        return null;
      }
      items.push(parsed);
      continue;
    }

    return null;
  }

  return items.length > 0 ? items : null;
}

function parseInlineFoodItem(value: string): NutritionLogItemInput | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(
    /^(?<quantity>\d+(?:\.\d+)?\s*(?:g|ml|oz|tbsp|tsp|cup|cups|egg|eggs|slice|slices|serving|servings|bar|bars|piece|pieces))\s+(?<name>.+)$/iu,
  );
  if (!match?.groups?.quantity || !match.groups.name) {
    return null;
  }

  return {
    quantity: normalizeWhitespace(match.groups.quantity),
    name: normalizeWhitespace(match.groups.name),
  };
}

function parseRecipeIngredients(content: string): NutritionLogItemInput[] | null {
  const section = extractMarkdownSection(content, "## Ingredients");
  if (!section) {
    return null;
  }

  const items: NutritionLogItemInput[] = [];
  for (const rawLine of section.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line.startsWith("- ")) {
      continue;
    }
    const match = line.match(/^-+\s*(?<quantity>\d+(?:\.\d+)?\s*(?:g|ml))\s+(?<name>.+?)(?:\s+—.*)?$/iu);
    if (!match?.groups?.quantity || !match.groups.name) {
      return null;
    }
    items.push({
      quantity: normalizeWhitespace(match.groups.quantity),
      name: normalizeWhitespace(match.groups.name),
    });
  }

  return items.length > 0 ? items : null;
}

function extractMarkdownSection(content: string, heading: string): string | null {
  const headingIndex = content.indexOf(heading);
  if (headingIndex < 0) {
    return null;
  }
  const afterHeading = content.slice(headingIndex + heading.length);
  const nextHeadingMatch = afterHeading.match(/\n##\s+/u);
  return (nextHeadingMatch ? afterHeading.slice(0, nextHeadingMatch.index) : afterHeading).trim();
}

interface IngredientOverride {
  quantity: string;
  name: string;
}

function extractIngredientOverrides(userMessage: string): IngredientOverride[] {
  const overrides: IngredientOverride[] = [];
  const regex =
    /(?<amount>\d+(?:\.\d+)?)\s*(?<unit>g|ml)\s+(?:of\s+)?(?<name>[a-z][a-z0-9&'()\/ -]*?)(?=(?:\s+(?:and|plus)\s+\d)|[.,;]|$)/giu;

  for (const match of userMessage.matchAll(regex)) {
    const amount = match.groups?.amount?.trim();
    const unit = match.groups?.unit?.trim();
    const name = match.groups?.name?.trim();
    if (!amount || !unit || !name) {
      continue;
    }
    overrides.push({
      quantity: `${amount}${unit}`,
      name: normalizeWhitespace(name),
    });
  }

  return overrides;
}

function applyIngredientOverrides(
  items: NutritionLogItemInput[],
  overrides: IngredientOverride[],
): NutritionLogItemInput[] | null {
  if (overrides.length === 0) {
    return items;
  }

  const nextItems = [...items];
  const usedIndexes = new Set<number>();

  for (const override of overrides) {
    let bestIndex = -1;
    let bestScore = 0;

    for (const [index, item] of nextItems.entries()) {
      if (usedIndexes.has(index)) {
        continue;
      }
      const score = scoreIngredientMatch(override.name, item.name);
      if (score > bestScore) {
        bestIndex = index;
        bestScore = score;
      }
    }

    if (bestIndex < 0 || bestScore <= 0) {
      return null;
    }

    usedIndexes.add(bestIndex);
    const existingItem = nextItems[bestIndex];
    if (!existingItem) {
      return null;
    }
    nextItems[bestIndex] = {
      ...existingItem,
      quantity: override.quantity,
    };
  }

  return nextItems;
}

function scoreIngredientMatch(query: string, candidate: string): number {
  const queryTokens = tokenizeIngredientLabel(query);
  const candidateTokens = tokenizeIngredientLabel(candidate);
  if (queryTokens.length === 0 || candidateTokens.length === 0) {
    return 0;
  }

  const candidateTokenSet = new Set(candidateTokens);
  if (queryTokens.every((token) => candidateTokenSet.has(token))) {
    return 100 + queryTokens.length * 10 - candidateTokens.length;
  }

  const overlap = queryTokens.filter((token) => candidateTokenSet.has(token)).length;
  return overlap >= Math.max(2, queryTokens.length) ? overlap : 0;
}

function tokenizeIngredientLabel(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/\([^)]*\)/gu, " ")
    .replace(/&/gu, " and ")
    .replace(/[^a-z0-9]+/gu, " ")
    .split(/\s+/u)
    .map((token) => singularizeToken(token))
    .filter((token) => token.length > 1);
}

function singularizeToken(token: string): string {
  if (token.endsWith("ies") && token.length > 3) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) {
    return token.slice(0, -1);
  }
  return token;
}

function getStringEntity(
  entities: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    if (typeof entities[key] === "string" && entities[key].trim().length > 0) {
      return entities[key].trim();
    }
  }
  return null;
}

function normalizeMeal(
  value: unknown,
  userMessage: string,
): "breakfast" | "lunch" | "dinner" | "other" {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "breakfast" || normalized === "lunch" || normalized === "dinner") {
    return normalized;
  }
  if (normalized === "snack" || normalized === "other") {
    return "other";
  }

  const message = userMessage.toLowerCase();
  if (/\bbreakfast\b/u.test(message)) return "breakfast";
  if (/\blunch\b/u.test(message)) return "lunch";
  if (/\bdinner\b/u.test(message)) return "dinner";
  return "other";
}

function normalizeDateScope(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    return normalized;
  }
  if (normalized === "today") {
    return formatLocalDate(0);
  }
  if (normalized === "yesterday") {
    return formatLocalDate(-1);
  }
  return undefined;
}

function formatLocalDate(offsetDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function annotateVerifiedWriteOutcome(value: Record<string, unknown>): Record<string, unknown> {
  const logged = Array.isArray(value.logged) ? value.logged : [];
  const verified =
    logged.length > 0
    && (value.status === "confirmed" || value.diary_entries !== null && value.diary_entries !== undefined);

  return verified
    ? {
        ...value,
        committedStateVerified: true,
        verifiedWriteOutcome: true,
      }
    : value;
}

function buildNutritionFastPathSummary(
  output: Record<string, unknown>,
  meal: NutritionFastPathMeal,
  requestedDate?: string,
): string {
  const status = typeof output.status === "string" ? output.status.trim().toLowerCase() : "";
  const date =
    typeof output.date === "string" && output.date.trim().length > 0
      ? output.date.trim()
      : requestedDate;
  const logged = Array.isArray(output.logged)
    ? output.logged.map((item) => item && typeof item === "object" && !Array.isArray(item)
      ? item as Record<string, unknown>
      : null).filter((item): item is Record<string, unknown> => item !== null)
    : [];
  const unresolved = Array.isArray(output.unresolved)
    ? output.unresolved.map((item) => item && typeof item === "object" && !Array.isArray(item)
      ? item as Record<string, unknown>
      : null).filter((item): item is Record<string, unknown> => item !== null)
    : [];

  const context = meal === "other"
    ? date ? ` for ${date}` : ""
    : ` for ${meal}${date ? ` on ${date}` : ""}`;
  const summarySuffix = meal === "other"
    ? date ? ` for ${date}` : ""
    : ` ${meal}${date ? ` for ${date}` : ""}`;

  if (status === "confirmed" && logged.length > 0) {
    return `Logged${summarySuffix}: ${summarizeLoggedNutritionItems(logged)}. Write confirmed in diary.`;
  }

  if (status === "partial_success" && logged.length > 0) {
    const unresolvedSummary = summarizeUnresolvedNutritionItems(unresolved);
    return unresolvedSummary
      ? `Partially logged${summarySuffix}: ${summarizeLoggedNutritionItems(logged)}. Still unresolved: ${unresolvedSummary}.`
      : `Partially logged${summarySuffix}: ${summarizeLoggedNutritionItems(logged)}.`;
  }

  if ((status === "needs_clarification" || status === "clarification") && unresolved.length > 0) {
    return `I still need clarification${context}: ${summarizeUnresolvedNutritionItems(unresolved)}.`;
  }

  if (logged.length > 0) {
    return `Processed${summarySuffix}: ${summarizeLoggedNutritionItems(logged)}.`;
  }

  const unresolvedSummary = summarizeUnresolvedNutritionItems(unresolved);
  if (unresolvedSummary) {
    return `I couldn't finish logging${summarySuffix}: ${unresolvedSummary}.`;
  }

  return `I couldn't finish logging${summarySuffix}.`;
}

function summarizeLoggedNutritionItems(items: readonly Record<string, unknown>[]): string {
  const parts = items
    .map((item) => {
      const label =
        typeof item.item === "string" && item.item.trim().length > 0
          ? item.item.trim()
          : typeof item.food_entry_name === "string" && item.food_entry_name.trim().length > 0
            ? item.food_entry_name.trim()
            : null;
      const quantity = typeof item.quantity === "string" ? item.quantity.trim() : "";
      if (!label) {
        return null;
      }
      return quantity ? `${label} (${quantity})` : label;
    })
    .filter((part): part is string => typeof part === "string" && part.length > 0);

  if (parts.length <= 4) {
    return parts.join("; ");
  }
  return `${parts.slice(0, 4).join("; ")}; +${parts.length - 4} more`;
}

function summarizeUnresolvedNutritionItems(items: readonly Record<string, unknown>[]): string {
  const parts = items
    .map((item) => {
      const label =
        typeof item.item === "string" && item.item.trim().length > 0
          ? item.item.trim()
          : typeof item.name === "string" && item.name.trim().length > 0
            ? item.name.trim()
            : null;
      const reason = typeof item.reason === "string" ? item.reason.trim() : "";
      if (!label) {
        return null;
      }
      return reason ? `${label} (${reason})` : label;
    })
    .filter((part): part is string => typeof part === "string" && part.length > 0);

  if (parts.length <= 3) {
    return parts.join("; ");
  }
  return `${parts.slice(0, 3).join("; ")}; +${parts.length - 3} more`;
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}
