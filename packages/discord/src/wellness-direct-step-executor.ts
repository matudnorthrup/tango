import type { DeterministicExecutionStep } from "./deterministic-router.js";
import type { WorkerReport, WorkerReportOperation } from "./worker-report.js";
import {
  callFatsecretApi,
  callFatsecretApiBatch,
  createHealthTools,
  resolveWellnessToolPaths,
} from "./wellness-agent-tools.js";
import {
  executeNutritionLogItems,
  type NutritionLogItemInput,
} from "./nutrition-log-executor.js";

interface DirectWellnessStepExecutorDeps {
  callFatsecretApi?: typeof callFatsecretApi;
  callFatsecretApiBatch?: typeof callFatsecretApiBatch;
  executeNutritionLogItems?: typeof executeNutritionLogItems;
  runHealthQuery?: (input: { command: string; date?: string; days?: number }) => Promise<unknown>;
}

interface NutritionDiaryEntry {
  food_entry_id?: string;
  food_entry_name?: string;
  meal?: string;
  calories?: string | number;
  protein?: string | number;
  carbohydrate?: string | number;
  fat?: string | number;
  fiber?: string | number;
}

interface MealMacroTotals {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
}

interface FatsecretSearchRow {
  food_id?: string | number | null;
  food_name?: string | null;
  food_type?: string | null;
  brand_name?: string | null;
}

interface FatsecretServing {
  serving_id?: string | number | null;
  serving_description?: string | null;
  measurement_description?: string | null;
  metric_serving_amount?: string | number | null;
  number_of_units?: string | number | null;
  calories?: string | number | null;
  protein?: string | number | null;
  carbohydrate?: string | number | null;
  fat?: string | number | null;
  fiber?: string | number | null;
}

interface DirectFatsecretResolvedLogEntry {
  input: NutritionLogItemInput;
  foodId: string;
  foodName: string;
  foodEntryName: string;
  servingId: string;
  numberOfUnits: number;
  estimatedMacros: Record<string, number | null>;
}

interface DirectFatsecretWriteResult {
  logged: Record<string, unknown>[];
  errors: string[];
  diaryEntries: unknown;
  operations: WorkerReportOperation[];
}

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");
const ONE_DECIMAL_FORMAT = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});
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
const FATSECRET_SEARCH_STOPWORDS = new Set([
  ...Object.keys(NUMBER_WORD_VALUES),
  "small",
  "medium",
  "large",
  "plain",
  "fresh",
  "raw",
  "frozen",
  "whole",
]);
const FATSECRET_MEASUREMENT_TOKENS = new Set([
  "g",
  "gram",
  "grams",
  "kg",
  "oz",
  "ounce",
  "ounces",
  "lb",
  "lbs",
  "cup",
  "cups",
  "tbsp",
  "tsp",
  "tablespoon",
  "tablespoons",
  "teaspoon",
  "teaspoons",
  "slice",
  "slices",
  "piece",
  "pieces",
  "serving",
  "servings",
  "container",
  "containers",
  "bag",
  "bags",
  "can",
  "cans",
  "bar",
  "bars",
  "bowl",
  "bowls",
  "package",
  "packages",
]);
const WHOLE_NUMBER_PATTERN = /^(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+(?:\.\d+)?|\d+\/\d+)\b/iu;
const LEADING_QUANTITY_PATTERN =
  /^(?<quantity>(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+(?:\.\d+)?|\d+\/\d+)(?:\s+\d+\/\d+)?(?:\s+(?:small|medium|large|extra[- ]large|g|gram|grams|kg|oz|ounce|ounces|lb|lbs|pound|pounds|cup|cups|tbsp|tablespoon|tablespoons|tsp|teaspoon|teaspoons|slice|slices|piece|pieces|serving|servings|container|containers|bag|bags|can|cans|bar|bars|bowl|bowls|package|packages))?)\s+(?<name>.+)$/iu;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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

function formatCount(value: number | null | undefined): string {
  return NUMBER_FORMAT.format(Math.round(value ?? 0));
}

function formatMaybeNumber(value: number | null | undefined, decimals = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "n/a";
  }
  if (decimals === 0) {
    return formatCount(value);
  }
  return ONE_DECIMAL_FORMAT.format(value);
}

function localDateString(offsetDays = 0): string {
  const now = new Date();
  const local = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
  const year = local.getFullYear();
  const month = String(local.getMonth() + 1).padStart(2, "0");
  const day = String(local.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function resolveDateScope(scope: unknown, fallback: "today" | "yesterday" = "today"): string {
  if (typeof scope === "string") {
    const normalized = scope.trim().toLowerCase();
    if (/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
      return normalized;
    }
    if (normalized === "today") {
      return localDateString(0);
    }
    if (normalized === "yesterday" || normalized === "last_night" || normalized === "last night") {
      return localDateString(-1);
    }
  }
  return fallback === "yesterday" ? localDateString(-1) : localDateString(0);
}

function formatDateLabel(date: string): string {
  if (date === localDateString(0)) {
    return "today";
  }
  if (date === localDateString(-1)) {
    return "yesterday";
  }
  return date;
}

function normalizeMeal(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (["breakfast", "lunch", "dinner", "other"].includes(normalized)) {
    return normalized;
  }
  if (normalized === "snack") {
    return "other";
  }
  return null;
}

function normalizeMealLabel(value: string | null): string | null {
  if (!value) {
    return null;
  }
  return value === "other" ? "other/snacks" : value;
}

function buildMealMacroTotals(entries: NutritionDiaryEntry[]): MealMacroTotals {
  return entries.reduce<MealMacroTotals>(
    (totals, entry) => ({
      calories: totals.calories + (parseFiniteNumber(entry.calories) ?? 0),
      protein: totals.protein + (parseFiniteNumber(entry.protein) ?? 0),
      carbs: totals.carbs + (parseFiniteNumber(entry.carbohydrate) ?? 0),
      fat: totals.fat + (parseFiniteNumber(entry.fat) ?? 0),
      fiber: totals.fiber + (parseFiniteNumber(entry.fiber) ?? 0),
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 },
  );
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

function normalizeDiaryEntries(value: unknown): NutritionDiaryEntry[] {
  return Array.isArray(value)
    ? value.map((entry) => asRecord(entry) as NutritionDiaryEntry | null).filter((entry): entry is NutritionDiaryEntry => entry !== null)
    : [];
}

function mealNameKey(entry: NutritionDiaryEntry): string {
  return normalizeMeal(entry.meal) ?? "other";
}

function buildMealBreakdown(entries: NutritionDiaryEntry[]): Array<{ meal: string; calories: number }> {
  const totals = new Map<string, number>();
  for (const entry of entries) {
    const meal = mealNameKey(entry);
    totals.set(meal, (totals.get(meal) ?? 0) + (parseFiniteNumber(entry.calories) ?? 0));
  }
  return [...totals.entries()]
    .map(([meal, calories]) => ({ meal, calories }))
    .sort((a, b) => b.calories - a.calories);
}

function buildTopItems(entries: NutritionDiaryEntry[], limit = 3): string[] {
  return entries
    .slice()
    .sort((a, b) => (parseFiniteNumber(b.calories) ?? 0) - (parseFiniteNumber(a.calories) ?? 0))
    .map((entry) => entry.food_entry_name?.trim())
    .filter((name): name is string => typeof name === "string" && name.length > 0)
    .filter((name, index, values) => values.indexOf(name) === index)
    .slice(0, limit);
}

function buildNutritionDayWorkerText(input: {
  date: string;
  meal: string | null;
  entries: NutritionDiaryEntry[];
  totals: MealMacroTotals;
}): string {
  const dateLabel = formatDateLabel(input.date);
  const mealLabel = normalizeMealLabel(input.meal);
  if (input.entries.length === 0) {
    return mealLabel
      ? `You don't have anything logged for ${mealLabel} ${dateLabel === "today" || dateLabel === "yesterday" ? dateLabel : `on ${dateLabel}`} yet.`
      : `You don't have anything logged for ${dateLabel} yet.`;
  }

  const topItems = buildTopItems(input.entries);
  const itemPhrase =
    topItems.length > 0
      ? ` Main items: ${topItems.join(", ")}.`
      : "";

  if (mealLabel) {
    return [
      `For ${mealLabel} ${dateLabel === "today" || dateLabel === "yesterday" ? dateLabel : `on ${dateLabel}`},`,
      `you've logged ${input.entries.length} entr${input.entries.length === 1 ? "y" : "ies"} totaling`,
      `${formatCount(input.totals.calories)} calories, ${formatMaybeNumber(input.totals.protein, 1)}g protein,`,
      `${formatMaybeNumber(input.totals.carbs, 1)}g carbs, and ${formatMaybeNumber(input.totals.fat, 1)}g fat.${itemPhrase}`,
    ].join(" ");
  }

  const mealBreakdown = buildMealBreakdown(input.entries)
    .slice(0, 3)
    .map((entry) => `${normalizeMealLabel(entry.meal) ?? entry.meal} ${formatCount(entry.calories)} cal`);
  const mealPhrase = mealBreakdown.length > 0 ? ` Biggest meals: ${mealBreakdown.join(", ")}.` : "";

  return [
    `For ${dateLabel}, you've logged ${input.entries.length} entr${input.entries.length === 1 ? "y" : "ies"} totaling`,
    `${formatCount(input.totals.calories)} calories, ${formatMaybeNumber(input.totals.protein, 1)}g protein,`,
    `${formatMaybeNumber(input.totals.carbs, 1)}g carbs, and ${formatMaybeNumber(input.totals.fat, 1)}g fat.${mealPhrase}${itemPhrase}`,
  ].join(" ");
}

function isCompareRequest(step: DeterministicExecutionStep): boolean {
  return Array.isArray(step.input.compare_date_scopes) && step.input.compare_date_scopes.length > 0;
}

function buildSleepRecoveryWorkerText(date: string, recoveryResult: unknown): string {
  const record = asRecord(recoveryResult) ?? {};
  const sleep = asRecord(record.sleep) ?? {};
  const hrv = asRecord(record.hrv) ?? {};
  const rhr = asRecord(record.rhr) ?? {};
  const averages = asRecord(record.seven_day_avg) ?? {};
  const totalSleep = parseFiniteNumber(sleep.total_hrs);
  const hrvValue = parseFiniteNumber(hrv.value);
  const rhrValue = parseFiniteNumber(rhr.value);

  if ((totalSleep ?? 0) <= 0 && hrvValue === null && rhrValue === null) {
    return [
      `I don't have complete sleep/recovery data for ${formatDateLabel(date)} yet.`,
      `Your 7-day baselines are about ${formatMaybeNumber(parseFiniteNumber(averages.sleep_hrs), 1)} hours of sleep,`,
      `HRV ${formatMaybeNumber(parseFiniteNumber(averages.hrv), 1)}, and resting HR ${formatMaybeNumber(parseFiniteNumber(averages.rhr), 1)}.`,
    ].join(" ");
  }

  return [
    `For ${formatDateLabel(date)}, you slept ${formatMaybeNumber(totalSleep, 1)} hours.`,
    `HRV was ${formatMaybeNumber(hrvValue, 1)} and resting HR ${formatMaybeNumber(rhrValue, 1)}.`,
    `Your 7-day baselines are ${formatMaybeNumber(parseFiniteNumber(averages.sleep_hrs), 1)} hours of sleep,`,
    `HRV ${formatMaybeNumber(parseFiniteNumber(averages.hrv), 1)}, and resting HR ${formatMaybeNumber(parseFiniteNumber(averages.rhr), 1)}.`,
  ].join(" ");
}

function buildBudgetWorkerText(input: {
  date: string;
  plannedItem: string | null;
  intakeTotals: MealMacroTotals;
  foodBudget: number | null;
}): string {
  const remaining = input.foodBudget !== null ? input.foodBudget - input.intakeTotals.calories : null;
  const dateLabel = formatDateLabel(input.date);
  if (input.foodBudget === null || remaining === null) {
    return `You've logged about ${formatCount(input.intakeTotals.calories)} calories and ${formatMaybeNumber(input.intakeTotals.protein, 1)}g protein for ${dateLabel}, but I couldn't compute the day's calorie budget from the health data.`;
  }

  const fitSentence = (() => {
    if (!input.plannedItem) {
      return `That leaves roughly ${formatCount(remaining)} calories available.`;
    }
    if (remaining >= 250) {
      return `${capitalize(input.plannedItem)} should fit comfortably, with roughly ${formatCount(remaining)} calories left before it.`;
    }
    if (remaining >= 100) {
      return `${capitalize(input.plannedItem)} likely still fits, but the room is getting tighter at about ${formatCount(remaining)} calories remaining.`;
    }
    if (remaining >= 0) {
      return `There isn't much room left for ${input.plannedItem} — only about ${formatCount(remaining)} calories remain.`;
    }
    return `You're already over the calculated food budget by about ${formatCount(Math.abs(remaining))} calories, so ${input.plannedItem} probably doesn't fit cleanly.`;
  })();

  return [
    `For ${dateLabel}, you've logged about ${formatCount(input.intakeTotals.calories)} calories and ${formatMaybeNumber(input.intakeTotals.protein, 1)}g protein against a food budget of roughly ${formatCount(input.foodBudget)} calories.`,
    fitSentence,
  ].join(" ");
}

function capitalize(value: string): string {
  return value.length > 0 ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
}

function buildMetricLookupWorkerText(step: DeterministicExecutionStep, metricResult: unknown, command: string, date: string): string {
  const focus = typeof step.input.metric_focus === "string" ? step.input.metric_focus.trim().toLowerCase() : "";
  const record = asRecord(metricResult) ?? {};

  if (command === "recovery") {
    if (focus.includes("resting heart rate") || focus.includes("rhr")) {
      return `Your resting heart rate for ${formatDateLabel(date)} was ${formatMaybeNumber(parseFiniteNumber(asRecord(record.rhr)?.value), 1)} bpm.`;
    }
    if (focus.includes("hrv")) {
      return `Your HRV for ${formatDateLabel(date)} was ${formatMaybeNumber(parseFiniteNumber(asRecord(record.hrv)?.value), 1)} ms.`;
    }
    return buildSleepRecoveryWorkerText(date, record);
  }

  if (focus.includes("step")) {
    return `You logged ${formatCount(parseFiniteNumber(record.steps) ?? 0)} steps ${formatDateLabel(date)}.`;
  }
  if (focus.includes("exercise")) {
    return `You logged ${formatCount(parseFiniteNumber(record.exercise_min) ?? 0)} exercise minutes ${formatDateLabel(date)}.`;
  }
  if (focus.includes("active")) {
    return `You burned about ${formatCount(parseFiniteNumber(record.active_cal) ?? 0)} active calories ${formatDateLabel(date)}.`;
  }
  if (focus.includes("tdee")) {
    return `Your TDEE ${formatDateLabel(date)} was about ${formatCount(parseFiniteNumber(record.tdee) ?? 0)} calories.`;
  }
  if (focus.includes("weight")) {
    return `Your recorded weight ${formatDateLabel(date)} was ${formatMaybeNumber(parseFiniteNumber(record.weight_lbs), 1)} lbs.`;
  }

  return [
    `For ${formatDateLabel(date)}, you logged ${formatCount(parseFiniteNumber(record.steps) ?? 0)} steps,`,
    `${formatCount(parseFiniteNumber(record.exercise_min) ?? 0)} exercise minutes,`,
    `and about ${formatCount(parseFiniteNumber(record.tdee) ?? 0)} TDEE calories.`,
  ].join(" ");
}

function extractNutritionLogItems(value: unknown): NutritionLogItemInput[] | null {
  if (typeof value === "string") {
    const parsed = parseNutritionItemDescription(value);
    return parsed ? [parsed] : null;
  }

  if (!Array.isArray(value)) {
    return null;
  }

  const parsedItems = value
    .map((entry) => extractNutritionLogItem(entry))
    .filter((entry): entry is NutritionLogItemInput => entry !== null);

  return parsedItems.length > 0 ? parsedItems : null;
}

function extractNutritionLogItem(value: unknown): NutritionLogItemInput | null {
  if (typeof value === "string") {
    return parseNutritionItemDescription(value);
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const existingName = typeof record.name === "string" ? record.name.trim() : "";
  const existingQuantity = typeof record.quantity === "string" ? record.quantity.trim() : "";
  if (existingName && existingQuantity) {
    return { name: existingName, quantity: existingQuantity };
  }

  const description = typeof record.description === "string" ? record.description.trim() : "";
  if (!description) {
    return null;
  }

  const quantityValue =
    typeof record.quantity === "number" || typeof record.quantity === "string"
      ? String(record.quantity).trim()
      : "";
  const unitValue = typeof record.unit === "string" ? record.unit.trim() : "";

  if (quantityValue) {
    const parsed = parseNutritionItemDescription(description);
    const quantity = [quantityValue, unitValue].filter((part) => part.length > 0).join(" ").trim();
    if (parsed?.name && quantity) {
      return {
        name: parsed.name,
        quantity,
      };
    }
  }

  return parseNutritionItemDescription(description);
}

function parseNutritionItemDescription(description: string): NutritionLogItemInput | null {
  const normalized = description.trim();
  if (!normalized) {
    return null;
  }

  const gramsMatch = normalized.match(/^(?<quantity>\d+(?:\.\d+)?\s*g(?:rams?)?)\s+(?<name>.+)$/iu);
  if (gramsMatch?.groups?.quantity && gramsMatch.groups.name) {
    return {
      quantity: gramsMatch.groups.quantity.trim(),
      name: gramsMatch.groups.name.trim(),
    };
  }

  const directMatch = normalized.match(LEADING_QUANTITY_PATTERN);
  if (directMatch?.groups?.quantity && directMatch.groups.name) {
    return {
      quantity: directMatch.groups.quantity.trim(),
      name: directMatch.groups.name.trim(),
    };
  }

  if (WHOLE_NUMBER_PATTERN.test(normalized)) {
    return null;
  }

  return {
    name: normalized,
    quantity: "1 serving",
  };
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

function normalizeFoodItemLabelForMatch(label: string): string {
  return label
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

function extractCoreFoodSearchPhrase(label: string): string {
  const normalized = normalizeFoodItemLabelForMatch(label);
  if (!normalized) {
    return "";
  }
  const tokens = normalized
    .split(/\s+/u)
    .filter((token) =>
      token.length > 0
      && !FATSECRET_SEARCH_STOPWORDS.has(token)
      && !FATSECRET_MEASUREMENT_TOKENS.has(token),
    );
  if (tokens.length === 0) {
    return normalized;
  }
  return tokens.join(" ").trim();
}

function buildFatsecretSearchQueries(itemLabel: string): string[] {
  const normalized = normalizeFoodItemLabelForMatch(itemLabel);
  const core = extractCoreFoodSearchPhrase(itemLabel);
  const queries = [normalized, core];
  if (core && !/\braw\b/iu.test(core) && core.split(/\s+/u).length === 1) {
    queries.push(`${core} raw`);
  }
  return [...new Set(queries.map((query) => query.trim()).filter((query) => query.length > 0))];
}

function normalizeFatsecretSearchRows(value: unknown): FatsecretSearchRow[] {
  return Array.isArray(value)
    ? value
        .map((row) => asRecord(row) as FatsecretSearchRow | null)
        .filter((row): row is FatsecretSearchRow => row !== null)
    : [];
}

function extractSignificantFoodTokens(value: string): string[] {
  return normalizeFoodItemLabelForMatch(value)
    .split(" ")
    .filter((token) =>
      token.length > 2
      && !NUMBER_WORD_VALUES[token]
      && !["raw", "medium", "small", "large"].includes(token),
    );
}

function scoreFatsecretSearchRowForItem(itemLabel: string, row: FatsecretSearchRow): number {
  const normalizedItem = normalizeFoodItemLabelForMatch(itemLabel);
  const normalizedFoodName = normalizeFoodItemLabelForMatch(typeof row.food_name === "string" ? row.food_name : "");
  if (!normalizedItem || !normalizedFoodName) {
    return 0;
  }

  const itemTokens = [...new Set(extractSignificantFoodTokens(itemLabel))];
  const rowTokens = [...new Set(extractSignificantFoodTokens(String(row.food_name ?? "")))];
  if (itemTokens.length === 0 || rowTokens.length === 0) {
    return 0;
  }
  const matchedTokens = rowTokens.filter((token) => itemTokens.includes(token));
  if (matchedTokens.length === 0 || matchedTokens.length / itemTokens.length < 0.5) {
    return 0;
  }

  let score = 0;
  if (normalizedFoodName === normalizedItem) {
    score += 50;
  } else if (normalizedItem.includes(normalizedFoodName) || normalizedFoodName.includes(normalizedItem)) {
    score += 20;
  }
  score += matchedTokens.length * 5;

  const brandTokens = [...new Set(extractSignificantFoodTokens(String(row.brand_name ?? "")))];
  const matchedBrandTokens = brandTokens.filter((token) => itemTokens.includes(token));
  score += matchedBrandTokens.length * 8;
  if (typeof row.food_type === "string" && row.food_type.trim().toLowerCase() === "generic") {
    score += 2;
  } else if (brandTokens.length > 0 && matchedBrandTokens.length === 0) {
    score -= 1;
  }
  return score;
}

function findBestFatsecretSearchMatchForItem(
  itemLabel: string,
  searchRows: readonly FatsecretSearchRow[],
): FatsecretSearchRow | null {
  let bestRow: FatsecretSearchRow | null = null;
  let bestScore = 0;
  for (const row of searchRows) {
    const score = scoreFatsecretSearchRowForItem(itemLabel, row);
    if (score > bestScore) {
      bestScore = score;
      bestRow = row;
    }
  }
  return bestScore > 0 ? bestRow : null;
}

function fatsecretSearchRowLooksGeneric(row: FatsecretSearchRow | null | undefined): boolean {
  if (!row) {
    return false;
  }
  if (typeof row.food_type === "string" && row.food_type.trim().toLowerCase() === "generic") {
    return true;
  }
  const brandName = typeof row.brand_name === "string" ? row.brand_name.trim() : "";
  return brandName.length === 0;
}

function normalizeFatsecretServings(output: unknown): FatsecretServing[] {
  const record = asRecord(output);
  const servings = asRecord(record?.servings);
  const value = servings?.serving;
  if (Array.isArray(value)) {
    return value
      .map((item) => asRecord(item) as FatsecretServing | null)
      .filter((item): item is FatsecretServing => item !== null);
  }
  const single = asRecord(value) as FatsecretServing | null;
  return single ? [single] : [];
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

function parseGramsFromAmountText(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  const directMatch = normalized.match(/(\d+(?:\.\d+)?)\s*g\b/iu);
  const parsed = directMatch?.[1] ? Number.parseFloat(directMatch[1]) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
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
    if (
      Number.isFinite(whole)
      && Number.isFinite(numerator)
      && Number.isFinite(denominator)
      && denominator > 0
    ) {
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
  return match?.[1] ? normalizeFoodItemLabelForMatch(match[1]) : null;
}

function extractServingUnitCount(serving: FatsecretServing): number | null {
  const candidates = [
    typeof serving.serving_description === "string" ? serving.serving_description.trim() : "",
    typeof serving.measurement_description === "string" ? serving.measurement_description.trim() : "",
  ];
  for (const candidate of candidates) {
    const parsed = parseLeadingQuantityToken(candidate);
    if (parsed && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

function servingMatchesAmountUnit(serving: FatsecretServing, amountUnit: string | null): boolean {
  if (!amountUnit) {
    return false;
  }
  const haystack = normalizeFoodItemLabelForMatch(
    `${serving.serving_description ?? ""} ${serving.measurement_description ?? ""}`,
  );
  if (!haystack) {
    return false;
  }
  if (haystack.includes(amountUnit)) {
    return true;
  }
  const tokens = amountUnit
    .split(/\s+/u)
    .map((token) => normalizeFoodItemLabelForMatch(token))
    .filter((token) => token.length >= 3);
  return tokens.some((token) => haystack.includes(token));
}

function looksLikeGramServing(serving: FatsecretServing): boolean {
  const text = `${serving.serving_description ?? ""} ${serving.measurement_description ?? ""}`.toLowerCase();
  return /\b\d+(?:\.\d+)?\s*g\b/u.test(text) || /\bg\b/u.test(text);
}

function fatsecretServingUsesRawGramUnits(serving: FatsecretServing): boolean {
  const measurement = normalizeFoodItemLabelForMatch(String(serving.measurement_description ?? ""));
  if (measurement === "g" || measurement === "gram" || measurement === "grams") {
    return true;
  }

  const metricServingAmount = parseFiniteNumber(serving.metric_serving_amount);
  const servingUnitCount = parseFiniteNumber(serving.number_of_units);
  const description = String(serving.serving_description ?? "").toLowerCase();
  return Boolean(
    metricServingAmount
      && servingUnitCount
      && Math.abs(metricServingAmount - servingUnitCount) < 0.000001
      && /\b\d+(?:\.\d+)?\s*g\b/u.test(description),
  );
}

function selectBestFatsecretServing(output: unknown, amountText: string): FatsecretServing | null {
  const servings = normalizeFatsecretServings(output);
  if (servings.length === 0) {
    return null;
  }

  const grams = parseGramsFromAmountText(amountText);
  if (grams) {
    const gramServing = servings.find((serving) => looksLikeGramServing(serving));
    if (gramServing) {
      return gramServing;
    }
  }

  const amountUnit = extractAmountUnitHint(amountText);
  if (amountUnit) {
    const unitMatched = servings.find((serving) => servingMatchesAmountUnit(serving, amountUnit));
    if (unitMatched) {
      return unitMatched;
    }
  }

  return servings[0] ?? null;
}

function deriveFatsecretUnitsFromServing(grams: number, serving: FatsecretServing): number | null {
  const metricServingAmount = parseFiniteNumber(serving.metric_serving_amount);
  if (!metricServingAmount || metricServingAmount <= 0) {
    return null;
  }
  if (fatsecretServingUsesRawGramUnits(serving)) {
    return Number.parseFloat(grams.toFixed(6));
  }
  const units = grams / metricServingAmount;
  if (!Number.isFinite(units) || units <= 0) {
    return null;
  }
  return Number.parseFloat(units.toFixed(6));
}

function deriveFatsecretUnitsFromAmountText(
  amountText: string,
  serving: FatsecretServing,
): number | null {
  const grams = parseGramsFromAmountText(amountText);
  if (grams) {
    return deriveFatsecretUnitsFromServing(grams, serving);
  }

  const count = extractCountFromAmountText(amountText);
  if (!count) {
    return null;
  }
  const amountUnit = extractAmountUnitHint(amountText);
  if (!servingMatchesAmountUnit(serving, amountUnit)) {
    return amountUnit ? null : Number.parseFloat(count.toFixed(6));
  }
  const servingUnitCount = extractServingUnitCount(serving) ?? 1;
  if (!Number.isFinite(servingUnitCount) || servingUnitCount <= 0) {
    return Number.parseFloat(count.toFixed(6));
  }
  return Number.parseFloat((count / servingUnitCount).toFixed(6));
}

function estimateMacrosFromFatsecretServing(
  serving: FatsecretServing,
  numberOfUnits: number,
): Record<string, number | null> {
  const servingMultiplier = fatsecretServingUsesRawGramUnits(serving)
    ? (() => {
        const baseUnits =
          parseFiniteNumber(serving.number_of_units)
          ?? parseFiniteNumber(serving.metric_serving_amount);
        if (!baseUnits || baseUnits <= 0) {
          return numberOfUnits;
        }
        return numberOfUnits / baseUnits;
      })()
    : numberOfUnits;
  const scale = (value: unknown, digits = 1): number | null => {
    const parsed = parseFiniteNumber(value);
    return parsed === null ? null : Number.parseFloat((parsed * servingMultiplier).toFixed(digits));
  };
  const calories = parseFiniteNumber(serving.calories);
  return {
    calories: calories === null ? null : Math.round(calories * servingMultiplier),
    protein: scale(serving.protein),
    carbs: scale(serving.carbohydrate),
    fat: scale(serving.fat),
    fiber: scale(serving.fiber),
  };
}

function fatsecretWriteSucceeded(output: unknown): { ok: boolean; foodEntryId: string | null } {
  if (output === true) {
    return { ok: true, foodEntryId: null };
  }
  const record = asRecord(output);
  if (!record) {
    return { ok: false, foodEntryId: null };
  }

  const foodEntryId =
    typeof record.food_entry_id === "string" || typeof record.food_entry_id === "number"
      ? String(record.food_entry_id).trim()
      : typeof record.value === "string" || typeof record.value === "number"
        ? String(record.value).trim()
        : typeof record.result === "string" || typeof record.result === "number"
          ? String(record.result).trim()
      : null;
  if (foodEntryId) {
    return { ok: true, foodEntryId };
  }
  if (record.success === true || record.ok === true) {
    return { ok: true, foodEntryId: null };
  }
  if (typeof record.value === "string" && record.value.trim().length > 0) {
    return { ok: true, foodEntryId: null };
  }
  if (typeof record.result === "string" && record.result.trim().length > 0) {
    return { ok: true, foodEntryId: null };
  }
  return { ok: false, foodEntryId: null };
}

function buildFatsecretLoggedEntry(
  resolved: DirectFatsecretResolvedLogEntry,
  foodEntryId: string | null,
): Record<string, unknown> {
  return {
    item: resolved.input.name,
    quantity: resolved.input.quantity,
    food_entry_name: resolved.foodEntryName,
    food_entry_id: foodEntryId,
    food_id: resolved.foodId,
    serving_id: resolved.servingId,
    number_of_units: resolved.numberOfUnits,
    source: "fatsecret",
    estimated_macros: resolved.estimatedMacros,
  };
}

function buildNutritionLogWorkerText(input: {
  date: string;
  meal: string;
  logged: readonly Record<string, unknown>[];
  totals: Record<string, unknown> | null;
  dayTotals: MealMacroTotals | null;
  unresolvedNames?: readonly string[];
}): string {
  const entryCount = input.logged.length;
  const entryIds = input.logged
    .map((entry) => entry.food_entry_id)
    .filter((value): value is string | number => typeof value === "string" || typeof value === "number");
  const foodNames = input.logged
    .map((entry) => typeof entry.item === "string" ? entry.item : null)
    .filter((value): value is string => value !== null);
  const summaryLine =
    entryCount === 1
      ? `${capitalize(foodNames[0] ?? "Item")} logged to ${normalizeMealLabel(input.meal) ?? input.meal} on ${input.date}`
      : `${entryCount} items logged to ${normalizeMealLabel(input.meal) ?? input.meal} on ${input.date}`;
  const macroText = [
    `${formatCount(parseFiniteNumber(input.totals?.calories) ?? 0)} cal`,
    `${formatMaybeNumber(parseFiniteNumber(input.totals?.protein), 1)}g P`,
    `${formatMaybeNumber(parseFiniteNumber(input.totals?.carbs), 1)}g C`,
    `${formatMaybeNumber(parseFiniteNumber(input.totals?.fat), 1)}g F`,
  ].join(" / ");
  const entryIdText = entryIds.length > 0
    ? ` Entry ID${entryIds.length === 1 ? "" : "s"} ${entryIds.map((value) => `\`${value}\``).join(", ")} confirmed.`
    : "";
  const unresolvedText = input.unresolvedNames && input.unresolvedNames.length > 0
    ? ` I still couldn't resolve ${input.unresolvedNames.join(", ")}.`
    : "";
  const dayTotalText = input.dayTotals
    ? ` Day total: **${formatCount(input.dayTotals.calories)} cal**.`
    : "";

  return `${summaryLine} — ${macroText}.${entryIdText}${dayTotalText}${unresolvedText}`.trim();
}

async function resolveNutritionItemsViaFatsecret(
  items: readonly NutritionLogItemInput[],
  deps: Required<DirectWellnessStepExecutorDeps>,
): Promise<{
  resolved: DirectFatsecretResolvedLogEntry[];
  unresolved: Array<{ item: string; quantity: string; reason: string }>;
  operations: WorkerReportOperation[];
}> {
  const queryCache = new Map<string, FatsecretSearchRow[]>();
  const foodCache = new Map<string, unknown>();
  const operations: WorkerReportOperation[] = [];
  const resolved: DirectFatsecretResolvedLogEntry[] = [];
  const unresolved: Array<{ item: string; quantity: string; reason: string }> = [];

  for (const item of items) {
    const searchQueries = buildFatsecretSearchQueries(item.name);
    const collectedRows: FatsecretSearchRow[] = [];

    for (const query of searchQueries) {
      let rows = queryCache.get(query);
      if (!rows) {
        const output = await deps.callFatsecretApi("foods_search", {
          search_expression: query,
          max_results: 10,
        });
        rows = normalizeFatsecretSearchRows(output);
        queryCache.set(query, rows);
        operations.push(buildOperation({
          name: "fatsecret_api",
          toolNames: ["fatsecret.log_food"],
          operationInput: {
            method: "foods_search",
            params: {
              search_expression: query,
              max_results: 10,
            },
          },
          output,
        }));
      }
      collectedRows.push(...rows);
      const currentBest = findBestFatsecretSearchMatchForItem(item.name, collectedRows);
      if (currentBest && fatsecretSearchRowLooksGeneric(currentBest)) {
        break;
      }
    }

    const bestMatch = findBestFatsecretSearchMatchForItem(item.name, collectedRows);
    const foodId =
      typeof bestMatch?.food_id === "string" || typeof bestMatch?.food_id === "number"
        ? String(bestMatch.food_id).trim()
        : "";
    if (!bestMatch || !foodId) {
      unresolved.push({
        item: item.name,
        quantity: item.quantity,
        reason: "No FatSecret food match found.",
      });
      continue;
    }

    let foodDetails = foodCache.get(foodId);
    if (!foodDetails) {
      foodDetails = await deps.callFatsecretApi("food_get", { food_id: foodId });
      foodCache.set(foodId, foodDetails);
      operations.push(buildOperation({
        name: "fatsecret_api",
        toolNames: ["fatsecret.log_food"],
        operationInput: {
          method: "food_get",
          params: { food_id: foodId },
        },
        output: foodDetails,
      }));
    }

    const serving = selectBestFatsecretServing(foodDetails, item.quantity);
    const servingId =
      typeof serving?.serving_id === "string" || typeof serving?.serving_id === "number"
        ? String(serving.serving_id).trim()
        : "";
    if (!serving || !servingId) {
      unresolved.push({
        item: item.name,
        quantity: item.quantity,
        reason: "No usable FatSecret serving metadata was available.",
      });
      continue;
    }

    const numberOfUnits = deriveFatsecretUnitsFromAmountText(item.quantity, serving);
    if (!numberOfUnits) {
      unresolved.push({
        item: item.name,
        quantity: item.quantity,
        reason: "Could not derive FatSecret units from the serving metadata.",
      });
      continue;
    }

    const foodName = typeof bestMatch.food_name === "string" && bestMatch.food_name.trim().length > 0
      ? bestMatch.food_name.trim()
      : item.name;

    resolved.push({
      input: item,
      foodId,
      foodName,
      foodEntryName: foodName,
      servingId,
      numberOfUnits,
      estimatedMacros: estimateMacrosFromFatsecretServing(serving, numberOfUnits),
    });
  }

  return { resolved, unresolved, operations };
}

async function writeFatsecretResolvedEntries(
  entries: readonly DirectFatsecretResolvedLogEntry[],
  input: { meal: string; date: string },
  deps: Required<DirectWellnessStepExecutorDeps>,
): Promise<DirectFatsecretWriteResult> {
  if (entries.length === 0) {
    return {
      logged: [],
      errors: [],
      diaryEntries: null,
      operations: [],
    };
  }

  const operations: WorkerReportOperation[] = [];
  const logged: Record<string, unknown>[] = [];
  const errors: string[] = [];

  const calls = [
    ...entries.map((entry) => ({
      method: "food_entry_create",
      params: {
        food_id: entry.foodId,
        food_entry_name: entry.foodEntryName,
        serving_id: entry.servingId,
        number_of_units: entry.numberOfUnits,
        meal: input.meal,
        date: input.date,
      },
    })),
    {
      method: "food_entries_get",
      params: { date: input.date },
    },
  ];

  let diaryEntries: unknown = null;
  try {
    const batchResults = await deps.callFatsecretApiBatch(calls);
    for (const [index, entry] of entries.entries()) {
      const result = batchResults[index];
      operations.push(buildOperation({
        name: "fatsecret_api",
        toolNames: ["fatsecret.log_food"],
        operationInput: {
          method: "food_entry_create",
          params: calls[index]?.params ?? {},
        },
        output: result?.ok ? result.result : { error: result?.error ?? "Unknown batch failure." },
        mode: "write",
      }));

      if (!result?.ok) {
        errors.push(`FatSecret write for ${entry.input.name} failed: ${result?.error ?? "Unknown batch failure."}`);
        continue;
      }
      const writeOutcome = fatsecretWriteSucceeded(result.result);
      if (!writeOutcome.ok) {
        errors.push(`FatSecret write for ${entry.input.name} returned a non-success response.`);
        continue;
      }
      logged.push(buildFatsecretLoggedEntry(entry, writeOutcome.foodEntryId));
    }

    const diaryResult = batchResults[entries.length];
    operations.push(buildOperation({
      name: "fatsecret_api",
      toolNames: ["fatsecret.day_summary"],
      operationInput: {
        method: "food_entries_get",
        params: { date: input.date },
      },
      output: diaryResult?.ok ? diaryResult.result : { error: diaryResult?.error ?? "Unknown batch failure." },
    }));
    if (logged.length > 0) {
      if (diaryResult?.ok) {
        diaryEntries = diaryResult.result ?? null;
      } else {
        errors.push(`FatSecret diary refresh failed: ${diaryResult?.error ?? "Unknown batch failure."}`);
      }
    }
  } catch (error) {
    for (const entry of entries) {
      let output: unknown;
      try {
        output = await deps.callFatsecretApi("food_entry_create", {
          food_id: entry.foodId,
          food_entry_name: entry.foodEntryName,
          serving_id: entry.servingId,
          number_of_units: entry.numberOfUnits,
          meal: input.meal,
          date: input.date,
        });
      } catch (writeError) {
        const detail = writeError instanceof Error ? writeError.message : String(writeError);
        errors.push(`FatSecret write for ${entry.input.name} failed: ${detail}`);
        operations.push(buildOperation({
          name: "fatsecret_api",
          toolNames: ["fatsecret.log_food"],
          operationInput: {
            method: "food_entry_create",
            params: {
              food_id: entry.foodId,
              food_entry_name: entry.foodEntryName,
              serving_id: entry.servingId,
              number_of_units: entry.numberOfUnits,
              meal: input.meal,
              date: input.date,
            },
          },
          output: { error: detail },
          mode: "write",
        }));
        continue;
      }

      operations.push(buildOperation({
        name: "fatsecret_api",
        toolNames: ["fatsecret.log_food"],
        operationInput: {
          method: "food_entry_create",
          params: {
            food_id: entry.foodId,
            food_entry_name: entry.foodEntryName,
            serving_id: entry.servingId,
            number_of_units: entry.numberOfUnits,
            meal: input.meal,
            date: input.date,
          },
        },
        output,
        mode: "write",
      }));

      const writeOutcome = fatsecretWriteSucceeded(output);
      if (!writeOutcome.ok) {
        errors.push(`FatSecret write for ${entry.input.name} returned a non-success response.`);
        continue;
      }
      logged.push(buildFatsecretLoggedEntry(entry, writeOutcome.foodEntryId));
    }

    if (logged.length > 0) {
      try {
        diaryEntries = await deps.callFatsecretApi("food_entries_get", { date: input.date });
        operations.push(buildOperation({
          name: "fatsecret_api",
          toolNames: ["fatsecret.day_summary"],
          operationInput: {
            method: "food_entries_get",
            params: { date: input.date },
          },
          output: diaryEntries,
        }));
      } catch (diaryError) {
        const detail = diaryError instanceof Error ? diaryError.message : String(diaryError);
        errors.push(`FatSecret diary refresh failed: ${detail}`);
        operations.push(buildOperation({
          name: "fatsecret_api",
          toolNames: ["fatsecret.day_summary"],
          operationInput: {
            method: "food_entries_get",
            params: { date: input.date },
          },
          output: { error: detail },
        }));
      }
    } else {
      errors.push(`FatSecret batch write path failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    logged,
    errors,
    diaryEntries,
    operations,
  };
}

async function defaultRunHealthQuery(input: { command: string; date?: string; days?: number }): Promise<unknown> {
  const [tool] = createHealthTools();
  if (!tool) {
    throw new Error("Health tools are unavailable.");
  }
  return tool.handler(input);
}

function buildOperation(input: {
  name: string;
  toolNames: string[];
  operationInput: Record<string, unknown>;
  output: unknown;
  mode?: "read" | "write";
}): WorkerReportOperation {
  return {
    name: input.name,
    toolNames: input.toolNames,
    input: input.operationInput,
    output: input.output,
    mode: input.mode ?? "read",
  };
}

async function executeDirectNutritionLog(
  step: DeterministicExecutionStep,
  deps: Required<DirectWellnessStepExecutorDeps>,
): Promise<WorkerReport | null> {
  const meal = normalizeMeal(step.input.meal);
  const items = extractNutritionLogItems(step.input.items);
  if (!meal || !items || items.length === 0) {
    return null;
  }

  const date = resolveDateScope(step.input.date_scope);
  const paths = resolveWellnessToolPaths();
  const result = await deps.executeNutritionLogItems(
    {
      items,
      meal,
      date,
      strict: true,
    },
    {
      atlasDbPath: paths.atlasDbPath,
      fatsecretCall: (method, params) => deps.callFatsecretApi(method, params),
      fatsecretBatchCall: (calls) => deps.callFatsecretApiBatch(calls),
    },
  );

  const status = typeof result.status === "string" ? result.status : "";
  const logged = Array.isArray(result.logged) ? result.logged.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => entry !== null) : [];
  if (status === "confirmed" && logged.length > 0) {
    const totals = asRecord(result.totals) ?? {};
    const workerText = buildNutritionLogWorkerText({
      date,
      meal,
      logged,
      totals,
      dayTotals: buildMealMacroTotals(normalizeDiaryEntries(result.diary_entries)),
    });

    return {
      operations: [
        buildOperation({
          name: "nutrition_log_items",
          toolNames: ["fatsecret.log_food", "fatsecret.day_summary"],
          operationInput: {
            items,
            meal,
            date,
            strict: true,
          },
          output: result,
          mode: "write",
        }),
      ],
      hasWriteOperations: true,
      data: {
        workerText,
        directFastPath: true,
        directFastPathId: "wellness.log_food_items",
        verifiedWriteOutcome: true,
        date,
      },
    };
  }

  const permissiveResult = await deps.executeNutritionLogItems(
    {
      items,
      meal,
      date,
      strict: false,
    },
    {
      atlasDbPath: paths.atlasDbPath,
      fatsecretCall: (method, params) => deps.callFatsecretApi(method, params),
      fatsecretBatchCall: (calls) => deps.callFatsecretApiBatch(calls),
    },
  );

  const permissiveLogged = Array.isArray(permissiveResult.logged)
    ? permissiveResult.logged
        .map((entry) => asRecord(entry))
        .filter((entry): entry is Record<string, unknown> => entry !== null)
    : [];
  const permissiveUnresolved = Array.isArray(permissiveResult.unresolved)
    ? permissiveResult.unresolved
        .map((entry) => asRecord(entry))
        .filter((entry): entry is Record<string, unknown> => entry !== null)
    : [];
  const permissiveErrors = Array.isArray(permissiveResult.errors)
    ? permissiveResult.errors.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];

  const unresolvedItems = permissiveUnresolved
    .map((entry) => {
      const itemName = typeof entry.item === "string" ? entry.item.trim() : "";
      const quantity = typeof entry.quantity === "string" ? entry.quantity.trim() : "";
      return itemName && quantity ? { name: itemName, quantity } : null;
    })
    .filter((entry): entry is NutritionLogItemInput => entry !== null);

  const recovered = unresolvedItems.length > 0
    ? await resolveNutritionItemsViaFatsecret(unresolvedItems, deps)
    : { resolved: [], unresolved: [], operations: [] };
  const recoveredWrites = await writeFatsecretResolvedEntries(recovered.resolved, { meal, date }, deps);

  const combinedLogged = [...permissiveLogged, ...recoveredWrites.logged];
  if (combinedLogged.length === 0) {
    return null;
  }

  const unresolvedNames = [
    ...permissiveUnresolved
      .filter((entry) => !recovered.resolved.some((resolved) =>
        normalizeFoodItemLabelForMatch(resolved.input.name) === normalizeFoodItemLabelForMatch(typeof entry.item === "string" ? entry.item : ""),
      ))
      .map((entry) => typeof entry.item === "string" ? entry.item.trim() : "")
      .filter((value): value is string => value.length > 0),
    ...recovered.unresolved
      .map((entry) => entry.item.trim())
      .filter((value) => value.length > 0),
  ];
  const totals = buildNutritionTotals(combinedLogged);
  const diaryEntries = recoveredWrites.diaryEntries ?? permissiveResult.diary_entries;
  const dayTotals = diaryEntries ? buildMealMacroTotals(normalizeDiaryEntries(diaryEntries)) : null;
  const workerText = buildNutritionLogWorkerText({
    date,
    meal,
    logged: combinedLogged,
    totals,
    dayTotals,
    unresolvedNames,
  });
  const qualityWarnings = [
    ...permissiveErrors,
    ...recoveredWrites.errors,
  ];

  return {
    operations: [
      buildOperation({
        name: "nutrition_log_items",
        toolNames: ["fatsecret.log_food", "fatsecret.day_summary"],
        operationInput: {
          items,
          meal,
          date,
          strict: false,
        },
        output: permissiveResult,
        mode: "write",
      }),
      ...recovered.operations,
      ...recoveredWrites.operations,
    ],
    hasWriteOperations: true,
    data: {
      workerText,
      ...(qualityWarnings.length > 0 ? { qualityWarnings } : {}),
      directFastPath: true,
      directFastPathId: "wellness.log_food_items",
      verifiedWriteOutcome: qualityWarnings.length === 0 && unresolvedNames.length === 0,
      date,
    },
  };
}

async function executeDirectNutritionDaySummary(
  step: DeterministicExecutionStep,
  deps: Required<DirectWellnessStepExecutorDeps>,
): Promise<WorkerReport | null> {
  if (isCompareRequest(step)) {
    return null;
  }

  const date = resolveDateScope(step.input.date_scope);
  const meal = normalizeMeal(step.input.meal);
  const entries = normalizeDiaryEntries(await deps.callFatsecretApi("food_entries_get", { date }));
  const filteredEntries = meal ? entries.filter((entry) => mealNameKey(entry) === meal) : entries;
  const totals = buildMealMacroTotals(filteredEntries);
  const workerText = buildNutritionDayWorkerText({
    date,
    meal,
    entries: filteredEntries,
    totals,
  });

  return {
    operations: [
      buildOperation({
        name: "fatsecret_api",
        toolNames: ["fatsecret.day_summary"],
        operationInput: { method: "food_entries_get", date, meal: meal ?? undefined },
        output: {
          date,
          meal,
          entry_count: filteredEntries.length,
          totals,
          entries: filteredEntries,
        },
      }),
    ],
    hasWriteOperations: false,
    data: {
      workerText,
      directFastPath: true,
      directFastPathId: "wellness.analyze_nutrition_day",
      date,
    },
  };
}

async function executeDirectNutritionBudget(
  step: DeterministicExecutionStep,
  deps: Required<DirectWellnessStepExecutorDeps>,
): Promise<WorkerReport | null> {
  const date = resolveDateScope(step.input.date_scope);
  if (date !== localDateString(0)) {
    return null;
  }

  const entries = normalizeDiaryEntries(await deps.callFatsecretApi("food_entries_get", { date }));
  const health = asRecord(await deps.runHealthQuery({ command: "checkin" })) ?? {};
  const calorieBudget = asRecord(health.calorie_budget) ?? {};
  const intakeTotals = buildMealMacroTotals(entries);
  const foodBudget = parseFiniteNumber(calorieBudget.food_budget);
  const plannedItem = typeof step.input.planned_item === "string" ? step.input.planned_item.trim() : null;
  const workerText = buildBudgetWorkerText({
    date,
    plannedItem,
    intakeTotals,
    foodBudget,
  });

  return {
    operations: [
      buildOperation({
        name: "fatsecret_api",
        toolNames: ["fatsecret.day_summary"],
        operationInput: { method: "food_entries_get", date },
        output: {
          date,
          entry_count: entries.length,
          totals: intakeTotals,
        },
      }),
      buildOperation({
        name: "health_query",
        toolNames: ["healthdb.today_summary", "healthdb.activity_summary"],
        operationInput: { command: "checkin" },
        output: health,
      }),
    ],
    hasWriteOperations: false,
    data: {
      workerText,
      directFastPath: true,
      directFastPathId: "wellness.check_nutrition_budget",
      date,
    },
  };
}

async function executeDirectSleepRecovery(
  step: DeterministicExecutionStep,
  deps: Required<DirectWellnessStepExecutorDeps>,
): Promise<WorkerReport | null> {
  const date = resolveDateScope(step.input.date_scope, "yesterday");
  const recoveryResult = await deps.runHealthQuery({ command: "recovery", date });
  const workerText = buildSleepRecoveryWorkerText(date, recoveryResult);

  return {
    operations: [
      buildOperation({
        name: "health_query",
        toolNames: ["healthdb.recovery_summary"],
        operationInput: { command: "recovery", date },
        output: recoveryResult,
      }),
    ],
    hasWriteOperations: false,
    data: {
      workerText,
      directFastPath: true,
      directFastPathId: "wellness.analyze_sleep_recovery",
      date,
    },
  };
}

async function executeDirectHealthMetricLookup(
  step: DeterministicExecutionStep,
  deps: Required<DirectWellnessStepExecutorDeps>,
): Promise<WorkerReport | null> {
  const focus = typeof step.input.metric_focus === "string" ? step.input.metric_focus.trim().toLowerCase() : "";
  if (!focus) {
    return null;
  }

  const date = resolveDateScope(step.input.date_scope, focus.includes("sleep") || focus.includes("hrv") || focus.includes("rhr") ? "yesterday" : "today");
  const useRecovery = /(sleep|recovery|hrv|resting heart rate|rhr)/iu.test(focus);
  const command = useRecovery ? "recovery" : "date";
  const result = await deps.runHealthQuery({ command, date });
  const workerText = buildMetricLookupWorkerText(step, result, command, date);

  return {
    operations: [
      buildOperation({
        name: "health_query",
        toolNames: [useRecovery ? "healthdb.recovery_summary" : "healthdb.activity_summary"],
        operationInput: { command, date, metric_focus: focus },
        output: result,
      }),
    ],
    hasWriteOperations: false,
    data: {
      workerText,
      directFastPath: true,
      directFastPathId: "health.metric_lookup_or_question",
      date,
    },
  };
}

export async function tryExecuteDirectWellnessStep(
  step: DeterministicExecutionStep,
  deps: DirectWellnessStepExecutorDeps = {},
): Promise<WorkerReport | null> {
  const resolvedDeps: Required<DirectWellnessStepExecutorDeps> = {
    callFatsecretApi: deps.callFatsecretApi ?? callFatsecretApi,
    callFatsecretApiBatch: deps.callFatsecretApiBatch ?? callFatsecretApiBatch,
    executeNutritionLogItems: deps.executeNutritionLogItems ?? executeNutritionLogItems,
    runHealthQuery: deps.runHealthQuery ?? defaultRunHealthQuery,
  };

  if (step.intentId === "health.metric_lookup_or_question" && step.mode === "read") {
    return executeDirectHealthMetricLookup(step, resolvedDeps);
  }

  if (step.kind !== "workflow") {
    return null;
  }

  switch (step.targetId) {
    case "wellness.log_food_items":
      // Roll back deterministic nutrition writes so the LLM worker owns
      // serving resolution, restaurant selection, and recipe modifications.
      return null;
    case "wellness.analyze_nutrition_day":
      return step.mode === "read" ? executeDirectNutritionDaySummary(step, resolvedDeps) : null;
    case "wellness.check_nutrition_budget":
      return step.mode === "read" ? executeDirectNutritionBudget(step, resolvedDeps) : null;
    case "wellness.analyze_sleep_recovery":
      return step.mode === "read" ? executeDirectSleepRecovery(step, resolvedDeps) : null;
    default:
      return null;
  }
}
