import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface NutritionLogItemInput {
  name: string;
  quantity: string;
}

export interface NutritionLogItemsInput {
  items: NutritionLogItemInput[];
  meal: string;
  date?: string;
  strict?: boolean;
}

export interface NutritionLogItemsDeps {
  atlasDbPath: string;
  fatsecretCall(method: string, params: Record<string, unknown>): Promise<unknown>;
  fatsecretBatchCall?(
    calls: Array<{ method: string; params?: Record<string, unknown> }>,
  ): Promise<Array<{ ok: boolean; result?: unknown; error?: string }>>;
}

interface AtlasIngredientRow {
  name?: string;
  brand?: string;
  product?: string;
  food_id?: number | string | null;
  serving_id?: number | string | null;
  serving_description?: string | null;
  serving_size?: string | null;
  grams_per_serving?: number | string | null;
  calories?: number | string | null;
  protein?: number | string | null;
  carbs?: number | string | null;
  fat?: number | string | null;
  fiber?: number | string | null;
  aliases?: string | null;
}

interface PlannedAtlasLogEntry {
  input: NutritionLogItemInput;
  row: AtlasIngredientRow;
  writeUnits: number;
  macroMultiplier: number;
  foodId: string;
  servingId: string;
  foodEntryName: string;
}

interface UnresolvedNutritionLogItem {
  item: string;
  quantity: string;
  reason: string;
}

const NUMBER_WORD_VALUES: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

const FATSECRET_WRITE_CONCURRENCY = 4;

export function resolveAtlasDbPath(atlasCommand: string): string {
  const resolvedCommand = resolveRealPath(atlasCommand);
  return path.join(path.dirname(resolvedCommand), "atlas.db");
}

function resolveRealPath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return value;
  }
}

export async function executeNutritionLogItems(
  input: NutritionLogItemsInput,
  deps: NutritionLogItemsDeps,
): Promise<Record<string, unknown>> {
  const meal = input.meal.trim().toLowerCase();
  const date = normalizeLogDate(input.date);
  const strict = input.strict !== false;
  const items = input.items
    .map((item) => ({
      name: typeof item.name === "string" ? item.name.trim() : "",
      quantity: typeof item.quantity === "string" ? item.quantity.trim() : "",
    }))
    .filter((item) => item.name.length > 0 && item.quantity.length > 0);

  if (items.length === 0) {
    return {
      action: "nutrition_log_items",
      status: "needs_clarification",
      date,
      meal,
      logged: [],
      unresolved: [{ item: "", quantity: "", reason: "No valid items were provided." }],
      totals: null,
      errors: [],
    };
  }

  const db = new DatabaseSync(deps.atlasDbPath, { readOnly: true });
  try {
    const plannedEntries: PlannedAtlasLogEntry[] = [];
    const unresolved: UnresolvedNutritionLogItem[] = [];

    for (const item of items) {
      const row = findBestAtlasMatchForItem(db, item.name);
      if (!row) {
        unresolved.push({
          item: item.name,
          quantity: item.quantity,
          reason: "No Atlas ingredient match found. Use low-level FatSecret search for this item.",
        });
        continue;
      }

      const foodId = stringifyId(row.food_id);
      const servingId = stringifyId(row.serving_id);
      if (!foodId || !servingId) {
        unresolved.push({
          item: item.name,
          quantity: item.quantity,
          reason: "Atlas match is missing food_id or serving_id.",
        });
        continue;
      }

      const derived = deriveAtlasWriteUnits(item.quantity, row);
      if (!derived) {
        unresolved.push({
          item: item.name,
          quantity: item.quantity,
          reason: "Could not derive FatSecret units from the Atlas serving definition.",
        });
        continue;
      }

      plannedEntries.push({
        input: item,
        row,
        writeUnits: derived.writeUnits,
        macroMultiplier: derived.macroMultiplier,
        foodId,
        servingId,
        foodEntryName: selectAtlasEntryName(row),
      });
    }

    if (strict && unresolved.length > 0) {
      return {
        action: "nutrition_log_items",
        status: "needs_clarification",
        date,
        meal,
        logged: [],
        unresolved,
        totals: null,
        errors: [],
      };
    }

    const { logged, errors, diaryEntries } = await writeEntriesAndRefreshDiary(
      plannedEntries,
      {
        meal,
        date,
      },
      deps,
    );

    const status =
      logged.length === 0
        ? unresolved.length > 0
          ? "needs_clarification"
          : "blocked"
        : unresolved.length > 0 || errors.length > 0
          ? "partial_success"
          : "confirmed";

    return {
      action: "nutrition_log_items",
      status,
      date,
      meal,
      logged,
      unresolved,
      totals: buildNutritionTotals(logged),
      diary_entries: diaryEntries,
      errors,
    };
  } finally {
    db.close();
  }
}

async function mapWithConcurrencyLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await fn(items[currentIndex]!);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function writeEntriesAndRefreshDiary(
  plannedEntries: PlannedAtlasLogEntry[],
  context: { meal: string; date: string },
  deps: NutritionLogItemsDeps,
): Promise<{
  logged: Record<string, unknown>[];
  errors: string[];
  diaryEntries: unknown;
}> {
  if (plannedEntries.length === 0) {
    return {
      logged: [],
      errors: [],
      diaryEntries: null,
    };
  }

  if (deps.fatsecretBatchCall) {
    try {
      return await writeEntriesViaBatch(plannedEntries, context, deps);
    } catch (error) {
      return writeEntriesViaIndividualCalls(plannedEntries, context, deps);
    }
  }

  return writeEntriesViaIndividualCalls(plannedEntries, context, deps);
}

async function writeEntriesViaBatch(
  plannedEntries: PlannedAtlasLogEntry[],
  context: { meal: string; date: string },
  deps: NutritionLogItemsDeps,
): Promise<{
  logged: Record<string, unknown>[];
  errors: string[];
  diaryEntries: unknown;
}> {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = plannedEntries.map((plannedEntry) => ({
    method: "food_entry_create",
    params: {
      food_id: plannedEntry.foodId,
      food_entry_name: plannedEntry.foodEntryName,
      serving_id: plannedEntry.servingId,
      number_of_units: plannedEntry.writeUnits,
      meal: context.meal,
      date: context.date,
    },
  }));
  calls.push({
    method: "food_entries_get",
    params: { date: context.date },
  });

  const batchResults = await deps.fatsecretBatchCall!(calls);
  const logged: Record<string, unknown>[] = [];
  const errors: string[] = [];

  for (const [index, plannedEntry] of plannedEntries.entries()) {
    const result = batchResults[index];
    if (!result?.ok) {
      errors.push(
        `FatSecret write for ${plannedEntry.input.name} failed: ${result?.error ?? "Unknown batch failure."}`,
      );
      continue;
    }
    const outputRecord = asRecord(result.result);
    const success = Boolean(outputRecord?.success);
    if (!success) {
      errors.push(`FatSecret write for ${plannedEntry.input.name} returned a non-success response.`);
      continue;
    }
    logged.push(buildLoggedEntry(plannedEntry, outputRecord?.food_entry_id ?? null));
  }

  const diaryResult = batchResults[plannedEntries.length];
  let diaryEntries: unknown = null;
  if (logged.length > 0) {
    if (diaryResult?.ok) {
      diaryEntries = diaryResult.result ?? null;
    } else {
      errors.push(`FatSecret diary refresh failed: ${diaryResult?.error ?? "Unknown batch failure."}`);
    }
  }

  return {
    logged,
    errors,
    diaryEntries,
  };
}

async function writeEntriesViaIndividualCalls(
  plannedEntries: PlannedAtlasLogEntry[],
  context: { meal: string; date: string },
  deps: NutritionLogItemsDeps,
): Promise<{
  logged: Record<string, unknown>[];
  errors: string[];
  diaryEntries: unknown;
}> {
  const logged: Record<string, unknown>[] = [];
  const errors: string[] = [];

  const writeResults = await mapWithConcurrencyLimit(
    plannedEntries,
    FATSECRET_WRITE_CONCURRENCY,
    async (plannedEntry) => {
      try {
        const output = await deps.fatsecretCall("food_entry_create", {
          food_id: plannedEntry.foodId,
          food_entry_name: plannedEntry.foodEntryName,
          serving_id: plannedEntry.servingId,
          number_of_units: plannedEntry.writeUnits,
          meal: context.meal,
          date: context.date,
        });
        const outputRecord = asRecord(output);
        const success = Boolean(outputRecord?.success);
        if (!success) {
          return {
            error: `FatSecret write for ${plannedEntry.input.name} returned a non-success response.`,
          };
        }
        return {
          logged: buildLoggedEntry(plannedEntry, outputRecord?.food_entry_id ?? null),
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          error: `FatSecret write for ${plannedEntry.input.name} failed: ${detail}`,
        };
      }
    },
  );

  for (const result of writeResults) {
    if (result?.logged) {
      logged.push(result.logged);
    }
    if (result?.error) {
      errors.push(result.error);
    }
  }

  let diaryEntries: unknown = null;
  if (logged.length > 0) {
    try {
      diaryEntries = await deps.fatsecretCall("food_entries_get", { date: context.date });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      errors.push(`FatSecret diary refresh failed: ${detail}`);
    }
  }

  return {
    logged,
    errors,
    diaryEntries,
  };
}

function buildLoggedEntry(
  plannedEntry: PlannedAtlasLogEntry,
  foodEntryId: unknown,
): Record<string, unknown> {
  return {
    item: plannedEntry.input.name,
    quantity: plannedEntry.input.quantity,
    food_entry_name: plannedEntry.foodEntryName,
    food_entry_id: foodEntryId,
    food_id: plannedEntry.foodId,
    serving_id: plannedEntry.servingId,
    number_of_units: plannedEntry.writeUnits,
    source: "atlas",
    estimated_macros: estimateMacrosFromAtlas(plannedEntry.row, plannedEntry.macroMultiplier),
  };
}

function normalizeLogDate(value: string | undefined): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value.trim())) {
    return value.trim();
  }
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringifyId(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Number.parseFloat(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
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

function normalizeFoodLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b\d+(?:\.\d+)?\s*g\b/gu, " ")
    .replace(/&/gu, " and ")
    .replace(/[^a-z0-9]+/gu, " ")
    .split(/\s+/u)
    .filter((token) => token.length > 0)
    .map((token) => singularizeToken(token))
    .join(" ")
    .trim();
}

function parseAtlasAliasList(value: unknown): string[] {
  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
  } catch {
    return value
      .split(",")
      .map((entry) => entry.replaceAll("\"", "").trim())
      .filter((entry) => entry.length > 0);
  }
}

function scoreAtlasRowForItem(itemLabel: string, row: AtlasIngredientRow): number {
  const normalizedItem = normalizeFoodLabel(itemLabel);
  if (!normalizedItem) {
    return 0;
  }
  const aliases = parseAtlasAliasList(row.aliases);
  const haystacks = [
    row.name ?? "",
    row.product ?? "",
    row.brand ?? "",
    ...aliases,
  ]
    .map((value) => normalizeFoodLabel(value))
    .filter((value) => value.length > 0);
  const itemWords = normalizedItem.split(" ").filter((word) => word.length > 1);
  const matchedWords = new Set<string>();
  let score = 0;
  for (const haystack of haystacks) {
    if (haystack === normalizedItem) {
      score += 100;
    } else if (haystack.includes(normalizedItem) || normalizedItem.includes(haystack)) {
      score += 50;
    }
    for (const word of itemWords) {
      if (haystack.includes(word)) {
        matchedWords.add(word);
      }
    }
  }
  score += matchedWords.size * 5;
  return score;
}

function findBestAtlasMatchForItem(db: DatabaseSync, itemLabel: string): AtlasIngredientRow | null {
  const normalizedItem = normalizeFoodLabel(itemLabel);
  const tokens = normalizedItem.split(/\s+/u).filter((token) => token.length > 1);
  const searchTerms = tokens.length > 0 ? tokens : [normalizedItem];
  const conditions: string[] = [];
  const params: string[] = [];
  for (const term of searchTerms) {
    const like = `%${term}%`;
    conditions.push("(lower(name) LIKE ? OR lower(product) LIKE ? OR lower(brand) LIKE ? OR lower(aliases) LIKE ?)");
    params.push(like, like, like, like);
  }
  const sql = [
    "SELECT name, brand, product, food_id, serving_id, serving_description, serving_size, grams_per_serving, calories, protein, carbs, fat, fiber, aliases",
    "FROM ingredients",
    conditions.length > 0 ? `WHERE ${conditions.join(" OR ")}` : "",
    "LIMIT 50",
  ]
    .filter((part) => part.length > 0)
    .join(" ");
  const rows = db.prepare(sql).all(...params) as AtlasIngredientRow[];
  let bestRow: AtlasIngredientRow | null = null;
  let bestScore = 0;
  for (const row of rows) {
    const score = scoreAtlasRowForItem(itemLabel, row);
    if (score > bestScore) {
      bestScore = score;
      bestRow = row;
    }
  }
  return bestScore >= 10 ? bestRow : null;
}

function parseGramsFromAmountText(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  const directMatch = normalized.match(/(\d+(?:\.\d+)?)\s*g\b/iu);
  const parsed = directMatch?.[1] ? Number.parseFloat(directMatch[1]) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function extractCountFromAmountText(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  const directMatch = normalized.match(/^(\d+(?:\.\d+)?)\b/u);
  if (directMatch?.[1]) {
    const parsed = Number.parseFloat(directMatch[1]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  const words = Object.keys(NUMBER_WORD_VALUES).join("|");
  const wordMatch = normalized.match(new RegExp(`^(${words})\\b`, "iu"));
  if (wordMatch?.[1]) {
    return NUMBER_WORD_VALUES[wordMatch[1].toLowerCase()] ?? null;
  }
  return null;
}

function parseLeadingQuantityToken(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  const mixedFractionMatch = normalized.match(/^(\d+)\s+(\d+)\/(\d+)\b/u);
  if (mixedFractionMatch?.[1] && mixedFractionMatch[2] && mixedFractionMatch[3]) {
    const whole = Number.parseFloat(mixedFractionMatch[1]);
    const numerator = Number.parseFloat(mixedFractionMatch[2]);
    const denominator = Number.parseFloat(mixedFractionMatch[3]);
    if (Number.isFinite(whole) && Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) {
      return whole + (numerator / denominator);
    }
  }
  const fractionMatch = normalized.match(/^(\d+)\/(\d+)\b/u);
  if (fractionMatch?.[1] && fractionMatch[2]) {
    const numerator = Number.parseFloat(fractionMatch[1]);
    const denominator = Number.parseFloat(fractionMatch[2]);
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) {
      return numerator / denominator;
    }
  }
  return extractCountFromAmountText(normalized);
}

function extractAmountUnitHint(value: string): string | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  const withoutLeadingCount = normalized
    .replace(/^(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/iu, "")
    .replace(/^\s+/u, "");
  const match = withoutLeadingCount.match(/^([a-z]+(?:\s+[a-z]+){0,2})/iu);
  return match?.[1] ? normalizeFoodLabel(match[1]) : null;
}

function extractServingUnitCount(row: AtlasIngredientRow): number | null {
  const candidates = [
    typeof row.serving_description === "string" ? row.serving_description.trim() : "",
    typeof row.serving_size === "string" ? row.serving_size.trim() : "",
  ];
  for (const candidate of candidates) {
    const parsed = parseLeadingQuantityToken(candidate);
    if (parsed && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

function servingMatchesAmountUnit(row: AtlasIngredientRow, amountUnit: string | null): boolean {
  if (!amountUnit) {
    return false;
  }
  const haystack = normalizeFoodLabel(`${row.serving_description ?? ""} ${row.serving_size ?? ""}`);
  if (!haystack) {
    return false;
  }
  if (haystack.includes(amountUnit)) {
    return true;
  }
  const tokens = amountUnit
    .split(/\s+/u)
    .map((token) => normalizeFoodLabel(token))
    .filter((token) => token.length >= 3);
  return tokens.some((token) => haystack.includes(token));
}

function deriveAtlasWriteUnits(
  amountText: string,
  row: AtlasIngredientRow,
): { writeUnits: number; macroMultiplier: number } | null {
  const grams = parseGramsFromAmountText(amountText);
  const gramsPerServing = parseFiniteNumber(row.grams_per_serving);
  if (grams && gramsPerServing && gramsPerServing > 0) {
    const macroMultiplier = Number.parseFloat((grams / gramsPerServing).toFixed(6));
    return {
      writeUnits: macroMultiplier,
      macroMultiplier,
    };
  }

  const count = extractCountFromAmountText(amountText);
  if (!count) {
    return null;
  }
  const amountUnit = extractAmountUnitHint(amountText);
  if (!amountUnit) {
    return {
      writeUnits: Number.parseFloat(count.toFixed(6)),
      macroMultiplier: Number.parseFloat(count.toFixed(6)),
    };
  }
  if (!servingMatchesAmountUnit(row, amountUnit)) {
    return null;
  }
  const servingUnitCount = extractServingUnitCount(row) ?? 1;
  if (!Number.isFinite(servingUnitCount) || servingUnitCount <= 0) {
    return {
      writeUnits: Number.parseFloat(count.toFixed(6)),
      macroMultiplier: Number.parseFloat(count.toFixed(6)),
    };
  }
  const multiplier = Number.parseFloat((count / servingUnitCount).toFixed(6));
  return {
    writeUnits: multiplier,
    macroMultiplier: multiplier,
  };
}

function selectAtlasEntryName(row: AtlasIngredientRow): string {
  return row.product?.trim() || row.name?.trim() || "Logged Food";
}

function estimateMacrosFromAtlas(row: AtlasIngredientRow, multiplier: number): Record<string, number | null> {
  const calories = parseFiniteNumber(row.calories);
  const protein = parseFiniteNumber(row.protein);
  const carbs = parseFiniteNumber(row.carbs);
  const fat = parseFiniteNumber(row.fat);
  const fiber = parseFiniteNumber(row.fiber);
  const scale = (value: number | null, digits = 1): number | null =>
    value === null ? null : Number.parseFloat((value * multiplier).toFixed(digits));
  return {
    calories: calories === null ? null : Math.round(calories * multiplier),
    protein: scale(protein),
    carbs: scale(carbs),
    fat: scale(fat),
    fiber: scale(fiber),
  };
}

function buildNutritionTotals(logged: readonly Record<string, unknown>[]): Record<string, number> | null {
  if (logged.length === 0) {
    return null;
  }
  let calories = 0;
  let protein = 0;
  let carbs = 0;
  let fat = 0;
  let fiber = 0;
  for (const entry of logged) {
    const macros = asRecord(entry.estimated_macros);
    calories += parseFiniteNumber(macros?.calories) ?? 0;
    protein += parseFiniteNumber(macros?.protein) ?? 0;
    carbs += parseFiniteNumber(macros?.carbs) ?? 0;
    fat += parseFiniteNumber(macros?.fat) ?? 0;
    fiber += parseFiniteNumber(macros?.fiber) ?? 0;
  }
  return {
    calories: Math.round(calories),
    protein: Number.parseFloat(protein.toFixed(1)),
    carbs: Number.parseFloat(carbs.toFixed(1)),
    fat: Number.parseFloat(fat.toFixed(1)),
    fiber: Number.parseFloat(fiber.toFixed(1)),
  };
}
