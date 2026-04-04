import dotenv from "dotenv";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getBrowserManager } from "../../../../packages/discord/src/browser-manager.js";
import { ensureSmokeThread } from "./discord-smoke-thread.js";

dotenv.config();

type VoiceTurnHttpResponse = {
  ok: boolean;
  error?: string;
  responseText?: string;
  providerName?: string;
  providerUsedFailover?: boolean;
  warmStartUsed?: boolean;
};

type StoredDeterministicTurn = {
  id: string;
  routeOutcome: "executed" | "clarification" | "fallback";
  intentIds: string[];
  workerIds: string[];
  hasWriteOperations: boolean;
  stepCount: number;
  receiptsJson: unknown;
  createdAt: string;
} | null;

type DeterministicTurn = Exclude<StoredDeterministicTurn, null>;

type ActiveTaskRow = {
  id: string;
  status: string;
  title: string;
  objective: string;
  resolvedAt: string | null;
  updatedAt: string;
} | null;

function buildProjectScopedSessionId(projectId: string, scope: string): string {
  return `project:${projectId}#${scope.trim().replace(/\s+/g, "-")}`;
}

type FatSecretEntry = {
  food_entry_id: string;
  food_entry_name?: string;
  meal?: string;
} & Record<string, unknown>;

function getArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

function getBridgeBaseUrl(): string {
  const host = process.env["TANGO_VOICE_BRIDGE_HOST"]?.trim() || "127.0.0.1";
  const port = process.env["TANGO_VOICE_BRIDGE_PORT"]?.trim() || "8787";
  return `http://${host}:${port}`;
}

function getBridgeHeaders(): Record<string, string> {
  const apiKey = process.env["TANGO_VOICE_BRIDGE_API_KEY"]?.trim();
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function getOptionalEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function getRequiredEnv(name: string): string {
  const value = getOptionalEnv(name);
  if (!value) {
    throw new Error(`Set ${name} before running this live write smoke script.`);
  }
  return value;
}

function getRecipeSmokeDir(): string {
  const configured = getOptionalEnv("TANGO_RECIPE_SMOKE_DIR");
  const dir = configured ? path.resolve(configured) : path.join(os.tmpdir(), "tango-recipe-smoke");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getDbPath(): string {
  const configured = process.env["TANGO_DB_PATH"]?.trim() || "./data/tango.sqlite";
  return path.resolve(configured);
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonValue<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function loadActiveTask(db: DatabaseSync, id: string): ActiveTaskRow {
  const row = db.prepare(
    `SELECT
       id,
       status,
       title,
       objective,
       resolved_at AS resolvedAt,
       updated_at AS updatedAt
     FROM active_tasks
     WHERE id = ?`,
  ).get(id) as
    | {
        id: string;
        status: string;
        title: string;
        objective: string;
        resolvedAt: string | null;
        updatedAt: string;
      }
    | undefined;
  return row ?? null;
}

function inferSessionType(sessionId: string): "project" | "persistent" | "ephemeral" {
  if (sessionId.startsWith("project:")) return "project";
  if (sessionId.startsWith("ephemeral:")) return "ephemeral";
  return "persistent";
}

function ensureSessionRow(
  db: DatabaseSync,
  input: { sessionId: string; agentId: string },
): void {
  db.prepare(
    `INSERT INTO sessions (id, session_type, default_agent_id, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       session_type = excluded.session_type,
       default_agent_id = excluded.default_agent_id,
       updated_at = datetime('now')`,
  ).run(input.sessionId, inferSessionType(input.sessionId), input.agentId);
}

function seedActiveTask(db: DatabaseSync, input: {
  id: string;
  sessionId: string;
  agentId: string;
  status: "awaiting_user" | "blocked";
  title: string;
  objective: string;
  ownerWorkerId: string;
  intentIds: string[];
  suggestedNextAction: string;
  clarificationQuestion?: string | null;
  structuredContext: Record<string, unknown>;
  sourceKind: string;
}): void {
  ensureSessionRow(db, {
    sessionId: input.sessionId,
    agentId: input.agentId,
  });
  db.prepare(`DELETE FROM active_tasks WHERE id = ?`).run(input.id);
  db.prepare(
    `INSERT INTO active_tasks (
       id,
       session_id,
       agent_id,
       status,
       title,
       objective,
       owner_worker_id,
       intent_ids,
       missing_slots,
       clarification_question,
       suggested_next_action,
       structured_context_json,
       source_kind,
       created_by_message_id,
       updated_by_message_id,
       created_at,
       updated_at,
       expires_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, datetime('now'), datetime('now'), datetime('now', '+3 days'))`,
  ).run(
    input.id,
    input.sessionId,
    input.agentId,
    input.status,
    input.title,
    input.objective,
    input.ownerWorkerId,
    JSON.stringify(input.intentIds),
    JSON.stringify([]),
    input.clarificationQuestion ?? null,
    input.suggestedNextAction,
    JSON.stringify(input.structuredContext),
    input.sourceKind,
  );
}

function extractReceiptWarnings(turn: DeterministicTurn): string[] {
  if (!Array.isArray(turn.receiptsJson)) {
    return [];
  }
  const warnings = turn.receiptsJson.flatMap((receipt) => {
    if (!receipt || typeof receipt !== "object") {
      return [];
    }
    const value = (receipt as Record<string, unknown>)["warnings"];
    return Array.isArray(value)
      ? value.filter((warning): warning is string => typeof warning === "string")
      : [];
  });
  return [...new Set(warnings)];
}

function extractRuntimeReplayFlags(turn: DeterministicTurn): string[] {
  if (!Array.isArray(turn.receiptsJson)) {
    return [];
  }
  const flags = new Set<string>();
  for (const receipt of turn.receiptsJson) {
    if (!receipt || typeof receipt !== "object") continue;
    const data = (receipt as Record<string, unknown>)["data"];
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    const workerText = (data as Record<string, unknown>)["workerText"];
    if (typeof workerText !== "string") continue;
    try {
      const parsed = JSON.parse(workerText) as Record<string, unknown>;
      const replay = parsed["runtimeReplay"];
      if (!replay || typeof replay !== "object" || Array.isArray(replay)) continue;
      if ((replay as Record<string, unknown>)["diaryWriteRecovered"] === true) {
        flags.add("diaryWriteRecovered");
      }
      if ((replay as Record<string, unknown>)["diaryRefreshRecovered"] === true) {
        flags.add("diaryRefreshRecovered");
      }
    } catch {
      // ignore
    }
  }
  return [...flags];
}

function hasSevereWriteWarning(warnings: readonly string[]): boolean {
  return warnings.some((warning) =>
    /\bcancelled\b|\bcould not be verified\b|\bworker reported blocked result\b|\bremain unconfirmed\b|\bdid not stick\b/iu.test(warning),
  );
}

function loadLatestDeterministicTurn(
  db: DatabaseSync,
  sessionId: string,
  agentId: string,
): StoredDeterministicTurn {
  const row = db.prepare(
    `SELECT
       id,
       route_outcome AS routeOutcome,
       intent_ids AS intentIdsJson,
       worker_ids AS workerIdsJson,
       has_write_operations AS hasWriteOperations,
       step_count AS stepCount,
       receipts_json AS receiptsJson,
       created_at AS createdAt
     FROM deterministic_turns
     WHERE session_id = ? AND agent_id = ?
     ORDER BY created_at DESC, rowid DESC
     LIMIT 1`,
  ).get(sessionId, agentId) as
    | {
        id: string;
        routeOutcome: "executed" | "clarification" | "fallback";
        intentIdsJson: string | null;
        workerIdsJson: string | null;
        hasWriteOperations: number;
        stepCount: number;
        receiptsJson: string | null;
        createdAt: string;
      }
    | undefined;

  if (!row) return null;
  return {
    id: row.id,
    routeOutcome: row.routeOutcome,
    intentIds: parseJsonArray(row.intentIdsJson),
    workerIds: parseJsonArray(row.workerIdsJson),
    hasWriteOperations: row.hasWriteOperations === 1,
    stepCount: row.stepCount,
    receiptsJson: parseJsonValue(row.receiptsJson),
    createdAt: row.createdAt,
  };
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}${text ? `: ${text}` : ""}`);
  }
  return JSON.parse(text) as T;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForNewDeterministicTurn(input: {
  db: DatabaseSync;
  sessionId: string;
  agentId: string;
  previousId: string | null;
  timeoutMs?: number;
}): Promise<StoredDeterministicTurn> {
  const startedAt = Date.now();
  const timeoutMs = input.timeoutMs ?? 30_000;
  while ((Date.now() - startedAt) < timeoutMs) {
    const latest = loadLatestDeterministicTurn(input.db, input.sessionId, input.agentId);
    if (latest && latest.id !== input.previousId) {
      return latest;
    }
    await sleep(250);
  }
  return null;
}

function tomorrowDateString(now = new Date()): string {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow.toISOString().slice(0, 10);
}

async function runCommand(command: string, args: string[]): Promise<string> {
  const { execFile } = await import("node:child_process");
  return await new Promise<string>((resolve, reject) => {
    execFile(command, args, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || stdout.trim() || error.message));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function callFatSecret(method: string, params: Record<string, unknown>): Promise<unknown> {
  const python = path.resolve(getRequiredEnv("TANGO_FATSECRET_PYTHON"));
  const script = path.resolve(getRequiredEnv("TANGO_FATSECRET_SCRIPT"));
  const stdout = await runCommand(python, [script, method, JSON.stringify(params)]);
  return stdout ? JSON.parse(stdout) : null;
}

async function getFatSecretEntries(date: string): Promise<FatSecretEntry[]> {
  const result = await callFatSecret("food_entries_get", { date });
  return Array.isArray(result)
    ? result.filter((entry): entry is FatSecretEntry => Boolean(entry && typeof entry === "object" && typeof (entry as FatSecretEntry).food_entry_id === "string"))
    : [];
}

async function deleteFatSecretEntries(entryIds: readonly string[]): Promise<void> {
  for (const entryId of entryIds) {
    await callFatSecret("food_entry_delete", { food_entry_id: entryId });
  }
}

async function runTurn(input: {
  baseUrl: string;
  headers: Record<string, string>;
  sessionId: string;
  agentId: string;
  channelId?: string | null;
  discordUserId: string;
  transcript: string;
}): Promise<VoiceTurnHttpResponse> {
  return await fetchJson<VoiceTurnHttpResponse>(`${input.baseUrl}/voice/turn`, {
    method: "POST",
    headers: {
      ...input.headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sessionId: input.sessionId,
      agentId: input.agentId,
      transcript: input.transcript,
      channelId: input.channelId,
      discordUserId: input.discordUserId,
    }),
  });
}

async function validateDeterministicWriteTurn(input: {
  db: DatabaseSync;
  sessionId: string;
  agentId: string;
  previousId: string | null;
  expectIntents: string[];
  expectAnyOfIntents?: string[];
  expectWorkers: string[];
  expectStepCount?: number;
  allowReadOnlyVerification?: boolean;
}): Promise<DeterministicTurn> {
  const latest = await waitForNewDeterministicTurn({
    db: input.db,
    sessionId: input.sessionId,
    agentId: input.agentId,
    previousId: input.previousId,
  });
  if (!latest) {
    throw new Error(`Timed out waiting for a new deterministic turn for intents ${input.expectIntents.join(", ")}.`);
  }
  if (latest.routeOutcome !== "executed") {
    throw new Error(`Expected executed route, got ${latest.routeOutcome}`);
  }
  for (const expectedIntent of input.expectIntents) {
    if (!latest.intentIds.includes(expectedIntent)) {
      throw new Error(`Expected intent ${expectedIntent}, got ${latest.intentIds.join(",") || "(none)"}`);
    }
  }
  if (input.expectAnyOfIntents && input.expectAnyOfIntents.length > 0) {
    const matched = input.expectAnyOfIntents.some((expectedIntent) => latest.intentIds.includes(expectedIntent));
    if (!matched) {
      throw new Error(
        `Expected one of intents ${input.expectAnyOfIntents.join(", ")}, got ${latest.intentIds.join(",") || "(none)"}`,
      );
    }
  }
  for (const expectedWorker of input.expectWorkers) {
    if (!latest.workerIds.includes(expectedWorker)) {
      throw new Error(`Expected worker ${expectedWorker}, got ${latest.workerIds.join(",") || "(none)"}`);
    }
  }
  if (!latest.hasWriteOperations && !input.allowReadOnlyVerification) {
    throw new Error(`Expected write operations for intents ${input.expectIntents.join(", ")}, got read-only turn.`);
  }
  if (input.expectStepCount !== undefined && latest.stepCount !== input.expectStepCount) {
    throw new Error(`Expected stepCount=${input.expectStepCount}, got ${latest.stepCount}`);
  }
  return latest;
}

async function runNutritionWriteSmoke(input: {
  db: DatabaseSync;
  baseUrl: string;
  headers: Record<string, string>;
  sessionId: string;
  agentId: string;
  channelId?: string | null;
  discordUserId: string;
}): Promise<void> {
  const date = tomorrowDateString();
  const beforeEntries = await getFatSecretEntries(date);
  const beforeIds = new Set(beforeEntries.map((entry) => entry.food_entry_id));
  const previousTurn = loadLatestDeterministicTurn(input.db, input.sessionId, input.agentId);
  const transcript = `Log one medium banana as other for ${date}. This is a deterministic write smoke test.`;

  console.log(`[write-smoke] nutrition before entries=${beforeEntries.length} date=${date}`);
  const response = await runTurn({
    ...input,
    transcript,
  });
  console.log(
    `[write-smoke] nutrition response ok=${response.ok} provider=${response.providerName ?? "-"} failover=${response.providerUsedFailover ? "yes" : "no"} warmStart=${response.warmStartUsed ? "yes" : "no"}`,
  );
  console.log(`[write-smoke] nutrition responseText=${JSON.stringify(response.responseText ?? "")}`);

  const turn = await validateDeterministicWriteTurn({
    db: input.db,
    sessionId: input.sessionId,
    agentId: input.agentId,
    previousId: previousTurn?.id ?? null,
    expectIntents: ["nutrition.log_food"],
    expectWorkers: ["nutrition-logger"],
    expectStepCount: 1,
  });
  console.log(`[write-smoke] nutrition deterministic turn=${turn.id}`);

  const afterEntries = await getFatSecretEntries(date);
  const newEntries = afterEntries.filter((entry) => !beforeIds.has(entry.food_entry_id));
  if (newEntries.length === 0) {
    throw new Error("Nutrition write smoke did not create any new FatSecret entries.");
  }
  console.log(
    `[write-smoke] nutrition created entries=${newEntries.map((entry) => `${entry.food_entry_id}:${entry.food_entry_name ?? "unknown"}`).join(", ")}`,
  );

  try {
    const responseText = (response.responseText ?? "").trim();
    if (!responseText) {
      throw new Error("Nutrition write smoke returned an empty response.");
    }
  } finally {
    await deleteFatSecretEntries(newEntries.map((entry) => entry.food_entry_id));
    const cleanupEntries = await getFatSecretEntries(date);
    const lingering = cleanupEntries.filter((entry) => newEntries.some((created) => created.food_entry_id === entry.food_entry_id));
    if (lingering.length > 0) {
      throw new Error(`Nutrition cleanup failed for entries: ${lingering.map((entry) => entry.food_entry_id).join(", ")}`);
    }
    console.log("[write-smoke] nutrition cleanup ok");
  }
}

function buildTempRecipeContent(recipeTitle: string): string {
  return [
    "---",
    "source:",
    "  - ai/codex",
    "created: 2026-03-29",
    "meal:",
    "  - lunch",
    "calories: 320",
    "protein: 28",
    "carbs: 24",
    "fat: 12",
    "fiber: 5",
    "prep_minutes: 5",
    "tags:",
    "  - health",
    "  - recipe",
    "types:",
    "  - \"[[Recipes]]\"",
    "  - \"Nutrition\"",
    "areas:",
    "  - \"Health\"",
    "---",
    "",
    `# ${recipeTitle}`,
    "",
    "## Macros",
    "| Calories | Protein | Carbs | Fat | Fiber |",
    "|----------|---------|-------|-----|-------|",
    "| 320 | 28g | 24g | 12g | 5g |",
    "",
    "## Ingredients",
    "- 150g chicken breast",
    "- 120g rice",
    "- 40g avocado",
    "",
    "## Instructions",
    "1. Cook the chicken.",
    "2. Warm the rice.",
    "3. Plate and top with avocado.",
    "",
    "## Notes",
    "- Temporary Codex smoke recipe.",
    "",
  ].join("\n");
}

function isBananaOtherEntry(entry: FatSecretEntry, date: string): boolean {
  const name = typeof entry.food_entry_name === "string" ? entry.food_entry_name.toLowerCase() : "";
  const meal = typeof entry.meal === "string" ? entry.meal.toLowerCase() : "";
  return name.includes("banana") && meal === "other" && date.length > 0;
}

async function runRecipeUpdateSmoke(input: {
  db: DatabaseSync;
  baseUrl: string;
  headers: Record<string, string>;
  sessionId: string;
  agentId: string;
  channelId?: string | null;
  discordUserId: string;
}): Promise<void> {
  const recipesDir = getRecipeSmokeDir();
  const recipeTitle = `Codex Deterministic Smoke Recipe ${Date.now()}`;
  const recipePath = path.join(recipesDir, `${recipeTitle}.md`);
  const marker = "Codex deterministic write smoke validation.";
  fs.writeFileSync(recipePath, buildTempRecipeContent(recipeTitle), "utf8");
  const previousTurn = loadLatestDeterministicTurn(input.db, input.sessionId, input.agentId);
  const transcript = `Update the recipe named "${recipeTitle}" and add this exact note somewhere in the notes section: "${marker}" Keep everything else the same.`;

  console.log(`[write-smoke] recipe created temp file=${recipePath}`);
  try {
    const response = await runTurn({
      ...input,
      transcript,
    });
    console.log(
      `[write-smoke] recipe response ok=${response.ok} provider=${response.providerName ?? "-"} failover=${response.providerUsedFailover ? "yes" : "no"} warmStart=${response.warmStartUsed ? "yes" : "no"}`,
    );
    console.log(`[write-smoke] recipe responseText=${JSON.stringify(response.responseText ?? "")}`);

    const turn = await validateDeterministicWriteTurn({
      db: input.db,
      sessionId: input.sessionId,
      agentId: input.agentId,
      previousId: previousTurn?.id ?? null,
      expectIntents: ["recipe.update"],
      expectWorkers: ["recipe-librarian"],
      expectStepCount: 1,
    });
    console.log(`[write-smoke] recipe deterministic turn=${turn.id}`);

    const updatedContent = fs.readFileSync(recipePath, "utf8");
    if (!updatedContent.includes(marker)) {
      throw new Error("Recipe update smoke did not write the expected marker into the recipe file.");
    }
    const responseText = (response.responseText ?? "").trim();
    if (!responseText) {
      throw new Error("Recipe update smoke returned an empty response.");
    }
  } finally {
    fs.rmSync(recipePath, { force: true });
    if (fs.existsSync(recipePath)) {
      throw new Error(`Recipe cleanup failed for ${recipePath}`);
    }
    console.log("[write-smoke] recipe cleanup ok");
  }
}

async function runSierraLocalFileWriteSmoke(input: {
  db: DatabaseSync;
  baseUrl: string;
  headers: Record<string, string>;
  sessionId: string;
  agentId: string;
  channelId?: string | null;
  discordUserId: string;
}): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-sierra-write-"));
  const targetPath = path.join(tempDir, "smoke-note.md");
  const marker = `Codex Sierra write smoke marker ${Date.now()}`;
  fs.writeFileSync(targetPath, "Sierra deterministic write smoke\n\nInitial content.\n", "utf8");
  const previousTurn = loadLatestDeterministicTurn(input.db, input.sessionId, input.agentId);
  const transcript = `Use the worker to update the local file at "${targetPath}" and append this exact line at the end: "${marker}" Keep the rest of the file unchanged.`;

  console.log(`[write-smoke] sierra file created temp file=${targetPath}`);
  try {
    const response = await runTurn({
      ...input,
      transcript,
    });
    console.log(
      `[write-smoke] sierra file response ok=${response.ok} provider=${response.providerName ?? "-"} failover=${response.providerUsedFailover ? "yes" : "no"} warmStart=${response.warmStartUsed ? "yes" : "no"}`,
    );
    console.log(`[write-smoke] sierra file responseText=${JSON.stringify(response.responseText ?? "")}`);

    const turn = await validateDeterministicWriteTurn({
      db: input.db,
      sessionId: input.sessionId,
      agentId: input.agentId,
      previousId: previousTurn?.id ?? null,
      expectIntents: [],
      expectAnyOfIntents: ["files.local_write", "notes.note_update"],
      expectWorkers: ["research-assistant"],
      expectStepCount: 1,
    });
    console.log(`[write-smoke] sierra file deterministic turn=${turn.id}`);

    const updatedContent = fs.readFileSync(targetPath, "utf8");
    if (!updatedContent.includes(marker)) {
      throw new Error("Sierra local file write smoke did not append the expected marker.");
    }
    const responseText = (response.responseText ?? "").trim();
    if (!responseText) {
      throw new Error("Sierra local file write smoke returned an empty response.");
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (fs.existsSync(targetPath)) {
      throw new Error(`Sierra file cleanup failed for ${targetPath}`);
    }
    console.log("[write-smoke] sierra file cleanup ok");
  }
}

async function getWalmartCartQuantity(itemLabel: string): Promise<number | null> {
  const manager = getBrowserManager();
  await manager.launch();
  await manager.open("https://www.walmart.com/cart");

  const target = itemLabel.toLowerCase();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const quantity = await manager.evaluate(`(() => {
      const target = ${JSON.stringify(target)};
      const labels = Array.from(document.querySelectorAll("[aria-label]"))
        .map((element) => element.getAttribute("aria-label") || "");
      for (const label of labels) {
        const lower = label.toLowerCase();
        if (!lower.includes(target)) continue;
        let match = lower.match(/(\\d+)\\s+in cart/);
        if (match) return Number(match[1]);
        match = lower.match(/current quantity\\s+(\\d+)/);
        if (match) return Number(match[1]);
        if (lower.startsWith("add to cart")) return 0;
      }
      return null;
    })()`);
    if (typeof quantity === "number" && Number.isFinite(quantity)) {
      return quantity;
    }
    await manager.wait({ timeout: 1500 });
  }

  return null;
}

async function runSierraWalmartWriteSmoke(input: {
  db: DatabaseSync;
  baseUrl: string;
  headers: Record<string, string>;
  sessionId: string;
  agentId: string;
  channelId?: string | null;
  discordUserId: string;
}): Promise<void> {
  const itemLabel = "Great Value Vanilla Light Nonfat Greek Yogurt";
  const baselineQuantity = await getWalmartCartQuantity(itemLabel);
  if (baselineQuantity === null || baselineQuantity < 1) {
    throw new Error(`Sierra Walmart write smoke could not determine a reversible baseline quantity for ${itemLabel}.`);
  }

  const targetQuantity = baselineQuantity + 1;
  const previousTurn = loadLatestDeterministicTurn(input.db, input.sessionId, input.agentId);
  const transcript = `Use the worker to set ${itemLabel} in my Walmart cart to quantity ${targetQuantity}.`;

  console.log(`[write-smoke] sierra walmart baseline=${baselineQuantity} target=${targetQuantity}`);
  try {
    const response = await runTurn({
      ...input,
      transcript,
    });
    console.log(
      `[write-smoke] sierra walmart response ok=${response.ok} provider=${response.providerName ?? "-"} failover=${response.providerUsedFailover ? "yes" : "no"} warmStart=${response.warmStartUsed ? "yes" : "no"}`,
    );
    console.log(`[write-smoke] sierra walmart responseText=${JSON.stringify(response.responseText ?? "")}`);

    const turn = await validateDeterministicWriteTurn({
      db: input.db,
      sessionId: input.sessionId,
      agentId: input.agentId,
      previousId: previousTurn?.id ?? null,
      expectIntents: ["shopping.browser_order_action"],
      expectWorkers: ["research-assistant"],
      expectStepCount: 1,
    });
    console.log(`[write-smoke] sierra walmart deterministic turn=${turn.id}`);

    const finalQuantity = await getWalmartCartQuantity(itemLabel);
    if (finalQuantity !== targetQuantity) {
      throw new Error(`Sierra Walmart write smoke expected quantity ${targetQuantity}, got ${String(finalQuantity)}.`);
    }

    const responseText = (response.responseText ?? "").trim();
    if (!responseText) {
      throw new Error("Sierra Walmart write smoke returned an empty response.");
    }
    if (/\bcould not\b|\bcan't\b|\bblocked\b|\bcancelled\b/iu.test(responseText)) {
      throw new Error(`Sierra Walmart write smoke reply still sounds blocked: ${responseText}`);
    }
  } finally {
    const revertTurn = loadLatestDeterministicTurn(input.db, input.sessionId, input.agentId);
    const revertResponse = await runTurn({
      ...input,
      transcript: `Use the worker to set ${itemLabel} in my Walmart cart to quantity ${baselineQuantity}.`,
    });
    console.log(
      `[write-smoke] sierra walmart cleanup ok=${revertResponse.ok} provider=${revertResponse.providerName ?? "-"} failover=${revertResponse.providerUsedFailover ? "yes" : "no"}`,
    );
    await validateDeterministicWriteTurn({
      db: input.db,
      sessionId: input.sessionId,
      agentId: input.agentId,
      previousId: revertTurn?.id ?? null,
      expectIntents: ["shopping.browser_order_action"],
      expectWorkers: ["research-assistant"],
      expectStepCount: 1,
    });
    const restoredQuantity = await getWalmartCartQuantity(itemLabel);
    if (restoredQuantity !== baselineQuantity) {
      throw new Error(`Sierra Walmart cleanup expected quantity ${baselineQuantity}, got ${String(restoredQuantity)}.`);
    }
    console.log("[write-smoke] sierra walmart cleanup ok");
  }
}

async function runWatsonRampReimbursementRepairSmoke(input: {
  db: DatabaseSync;
  baseUrl: string;
  headers: Record<string, string>;
  sessionId: string;
  agentId: string;
  channelId?: string | null;
  discordUserId: string;
}): Promise<void> {
  const orderUrl = getRequiredEnv("TANGO_WALMART_ORDER_URL");
  const reviewUrl = getRequiredEnv("TANGO_RAMP_REVIEW_URL");
  const manager = getBrowserManager();
  await manager.launch();

  const capture = await manager.captureWalmartTipEvidence({ orderUrl });
  if (capture.captureMode !== "order-date+payment-summary-clip") {
    throw new Error(
      `Watson reimbursement smoke expected order-date+payment-summary-clip, got ${capture.captureMode}.`,
    );
  }
  if (!capture.dateVisible || capture.visibleDateText.length === 0) {
    throw new Error("Watson reimbursement smoke expected date-visible evidence capture.");
  }

  const previousTurn = loadLatestDeterministicTurn(input.db, input.sessionId, input.agentId);
  const transcript = `Use the worker to replace the receipt evidence on the existing Walmart Ramp reimbursement review ${reviewUrl} using a fresh screenshot from the Walmart order ${orderUrl}. Keep the reimbursement amount and memo unchanged.`;

  console.log(`[write-smoke] watson reimbursement repair capture=${capture.captureMode} evidence=${capture.screenshotPath}`);
  const response = await runTurn({
    ...input,
    transcript,
  });
  console.log(
    `[write-smoke] watson reimbursement repair response ok=${response.ok} provider=${response.providerName ?? "-"} failover=${response.providerUsedFailover ? "yes" : "no"} warmStart=${response.warmStartUsed ? "yes" : "no"}`,
  );
  console.log(`[write-smoke] watson reimbursement repair responseText=${JSON.stringify(response.responseText ?? "")}`);

  const turn = await validateDeterministicWriteTurn({
    db: input.db,
    sessionId: input.sessionId,
    agentId: input.agentId,
    previousId: previousTurn?.id ?? null,
    expectIntents: ["finance.reimbursement_submit"],
    expectWorkers: ["personal-assistant"],
    expectStepCount: 1,
  });
  console.log(`[write-smoke] watson reimbursement deterministic turn=${turn.id}`);

  await manager.open(reviewUrl);
  const reviewBody = await manager.evaluate("document.body.innerText");
  if (typeof reviewBody !== "string" || !/\bauto-verified\b/iu.test(reviewBody)) {
    throw new Error("Watson reimbursement smoke expected the Ramp review page to remain auto-verified.");
  }

  const responseText = (response.responseText ?? "").trim();
  if (!responseText) {
    throw new Error("Watson reimbursement smoke returned an empty response.");
  }
  if (/\bcould not\b|\bcan't\b|\bblocked\b|\bcancelled\b/iu.test(responseText)) {
    throw new Error(`Watson reimbursement smoke reply still sounds blocked: ${responseText}`);
  }
}

async function runWatsonRampReimbursementBackfillRepairSmoke(input: {
  db: DatabaseSync;
  baseUrl: string;
  headers: Record<string, string>;
  sessionId: string;
  agentId: string;
  channelId?: string | null;
  discordUserId: string;
}): Promise<void> {
  const manager = getBrowserManager();
  await manager.launch();

  const since = "2025-09-01";
  const until = "2025-12-31";
  const orderId = getRequiredEnv("TANGO_WALMART_ORDER_ID");
  const orderUrl = getRequiredEnv("TANGO_WALMART_ORDER_URL");
  const reviewUrl = getRequiredEnv("TANGO_RAMP_REVIEW_URL");
  const discovered = await manager.discoverWalmartDeliveryCandidates({
    since,
    until,
    maxPages: 6,
  });
  const discoveredIds = new Set(discovered.map((candidate) => candidate.orderId));
  if (!discoveredIds.has(orderId)) {
    throw new Error(
      `Watson reimbursement backfill smoke expected to discover ${orderId}, got ${JSON.stringify(discovered.map((candidate) => candidate.orderId))}`,
    );
  }

  const previousTurn = loadLatestDeterministicTurn(input.db, input.sessionId, input.agentId);
  const transcript = [
    `Use the worker to scan Walmart delivery-tip reimbursement candidates between ${since} and ${until}.`,
    `Ensure Walmart order ${orderId} is represented in the reimbursement registry, then capture a fresh screenshot for ${orderUrl}.`,
    `Replace the receipt evidence on the existing Ramp reimbursement review ${reviewUrl} with that fresh screenshot and keep the amount and memo unchanged.`,
  ].join(" ");

  console.log(`[write-smoke] watson reimbursement backfill discovered=${discovered.length} target=${orderId}`);
  const response = await runTurn({
    ...input,
    transcript,
  });
  console.log(
    `[write-smoke] watson reimbursement backfill response ok=${response.ok} provider=${response.providerName ?? "-"} failover=${response.providerUsedFailover ? "yes" : "no"} warmStart=${response.warmStartUsed ? "yes" : "no"}`,
  );
  console.log(`[write-smoke] watson reimbursement backfill responseText=${JSON.stringify(response.responseText ?? "")}`);

  const turn = await validateDeterministicWriteTurn({
    db: input.db,
    sessionId: input.sessionId,
    agentId: input.agentId,
    previousId: previousTurn?.id ?? null,
    expectIntents: ["finance.reimbursement_submit"],
    expectWorkers: ["personal-assistant"],
    expectStepCount: 1,
  });
  console.log(`[write-smoke] watson reimbursement backfill deterministic turn=${turn.id}`);

  await manager.open(reviewUrl);
  const reviewBody = await manager.evaluate("document.body.innerText");
  if (typeof reviewBody !== "string" || !/\bauto-verified\b/iu.test(reviewBody)) {
    throw new Error("Watson reimbursement backfill smoke expected the Ramp review page to remain auto-verified.");
  }

  const responseText = (response.responseText ?? "").trim();
  if (!responseText) {
    throw new Error("Watson reimbursement backfill smoke returned an empty response.");
  }
  if (/\bcould not\b|\bcan't\b|\bblocked\b|\bcancelled\b/iu.test(responseText)) {
    throw new Error(`Watson reimbursement backfill smoke reply still sounds blocked: ${responseText}`);
  }
}

async function runNutritionWriteThenSummarySmoke(input: {
  db: DatabaseSync;
  baseUrl: string;
  headers: Record<string, string>;
  sessionId: string;
  agentId: string;
  channelId?: string | null;
  discordUserId: string;
}): Promise<void> {
  const date = tomorrowDateString();
  const beforeEntries = await getFatSecretEntries(date);
  const beforeIds = new Set(beforeEntries.map((entry) => entry.food_entry_id));
  const previousTurn = loadLatestDeterministicTurn(input.db, input.sessionId, input.agentId);
  const transcript = `Log one medium banana as other for ${date}, and then tell me my calories so far for ${date}. This is a deterministic mixed write smoke test.`;

  console.log(`[write-smoke] mixed nutrition before entries=${beforeEntries.length} date=${date}`);
  const response = await runTurn({
    ...input,
    transcript,
  });
  console.log(
    `[write-smoke] mixed nutrition response ok=${response.ok} provider=${response.providerName ?? "-"} failover=${response.providerUsedFailover ? "yes" : "no"} warmStart=${response.warmStartUsed ? "yes" : "no"}`,
  );
  console.log(`[write-smoke] mixed nutrition responseText=${JSON.stringify(response.responseText ?? "")}`);

  const turn = await validateDeterministicWriteTurn({
    db: input.db,
    sessionId: input.sessionId,
    agentId: input.agentId,
    previousId: previousTurn?.id ?? null,
    expectIntents: ["nutrition.log_food", "nutrition.day_summary"],
    expectWorkers: ["nutrition-logger"],
    expectStepCount: 2,
  });
  console.log(`[write-smoke] mixed nutrition deterministic turn=${turn.id}`);

  const receipts = Array.isArray(turn.receiptsJson)
    ? turn.receiptsJson as Array<{ intentId?: string; status?: string; hasWriteOperations?: boolean }>
    : [];
  if (receipts.length !== 2) {
    throw new Error(`Mixed nutrition smoke expected 2 receipts, got ${receipts.length}`);
  }
  if (receipts[0]?.intentId !== "nutrition.log_food" || receipts[1]?.intentId !== "nutrition.day_summary") {
    throw new Error(
      `Mixed nutrition smoke expected ordered receipts [nutrition.log_food, nutrition.day_summary], got [${receipts.map((receipt) => receipt.intentId ?? "?").join(", ")}]`,
    );
  }
  if (receipts.some((receipt) => receipt.status !== "completed")) {
    throw new Error(
      `Mixed nutrition smoke expected completed receipts, got [${receipts.map((receipt) => receipt.status ?? "?").join(", ")}]`,
    );
  }
  if (receipts[0]?.hasWriteOperations !== true || receipts[1]?.hasWriteOperations !== false) {
    throw new Error(
      `Mixed nutrition smoke expected write/read receipt modes, got [${receipts.map((receipt) => String(receipt.hasWriteOperations)).join(", ")}]`,
    );
  }

  const afterEntries = await getFatSecretEntries(date);
  const newEntries = afterEntries.filter((entry) => !beforeIds.has(entry.food_entry_id));
  if (newEntries.length !== 1) {
    throw new Error(`Mixed nutrition smoke expected exactly 1 new FatSecret entry, got ${newEntries.length}.`);
  }

  try {
    const responseText = (response.responseText ?? "").trim();
    if (!responseText) {
      throw new Error("Mixed nutrition smoke returned an empty response.");
    }
  } finally {
    await deleteFatSecretEntries(newEntries.map((entry) => entry.food_entry_id));
    const cleanupEntries = await getFatSecretEntries(date);
    const lingering = cleanupEntries.filter((entry) => newEntries.some((created) => created.food_entry_id === entry.food_entry_id));
    if (lingering.length > 0) {
      throw new Error(`Mixed nutrition cleanup failed for entries: ${lingering.map((entry) => entry.food_entry_id).join(", ")}`);
    }
    console.log("[write-smoke] mixed nutrition cleanup ok");
  }
}

async function runNutritionRepairContinuationSmoke(input: {
  db: DatabaseSync;
  baseUrl: string;
  headers: Record<string, string>;
  sessionId: string;
  agentId: string;
  channelId?: string | null;
  discordUserId: string;
}): Promise<void> {
  const date = tomorrowDateString();
  const taskId = `codex-live-write-repair-${Date.now()}`;
  const beforeEntries = await getFatSecretEntries(date);
  const beforeIds = new Set(beforeEntries.map((entry) => entry.food_entry_id));
  const previousTurn = loadLatestDeterministicTurn(input.db, input.sessionId, input.agentId);

  seedActiveTask(input.db, {
    id: taskId,
    sessionId: input.sessionId,
    agentId: input.agentId,
    status: "blocked",
    title: "Finish banana entry",
    objective: `Finish logging one medium banana as other for ${date}.`,
    ownerWorkerId: "nutrition-logger",
    intentIds: ["nutrition.log_food"],
    suggestedNextAction: "Retry the blocked banana diary entry using the established details.",
    structuredContext: {
      source: "execution-blocked",
      latestResolvedEntities: {
        items: "one medium banana",
        meal: "other",
        date,
      },
      blockingWarnings: [
        "fatsecret_api food_entry_create returned `user cancelled MCP tool call`.",
      ],
    },
    sourceKind: "execution-blocked",
  });

  const transcript = "go ahead and finish that banana entry";
  console.log(`[write-smoke] repair before entries=${beforeEntries.length} date=${date} task=${taskId}`);
  const response = await runTurn({
    ...input,
    transcript,
  });
  console.log(
    `[write-smoke] repair response ok=${response.ok} provider=${response.providerName ?? "-"} failover=${response.providerUsedFailover ? "yes" : "no"} warmStart=${response.warmStartUsed ? "yes" : "no"}`,
  );
  console.log(`[write-smoke] repair responseText=${JSON.stringify(response.responseText ?? "")}`);

  const turn = await validateDeterministicWriteTurn({
    db: input.db,
    sessionId: input.sessionId,
    agentId: input.agentId,
    previousId: previousTurn?.id ?? null,
    expectIntents: ["nutrition.log_food"],
    expectWorkers: ["nutrition-logger"],
    expectStepCount: 1,
    allowReadOnlyVerification: true,
  });
  console.log(`[write-smoke] repair deterministic turn=${turn.id}`);

  const warnings = extractReceiptWarnings(turn);
  const replayFlags = extractRuntimeReplayFlags(turn);
  if (hasSevereWriteWarning(warnings)) {
    throw new Error(`Repair write smoke still has severe warnings: ${warnings.join(" | ")}`);
  }

  const finalTask = loadActiveTask(input.db, taskId);
  if (!finalTask || finalTask.status !== "completed" || !finalTask.resolvedAt) {
    throw new Error(`Repair write smoke expected completed active task, got ${JSON.stringify(finalTask)}`);
  }

  const afterEntries = await getFatSecretEntries(date);
  const newEntries = afterEntries.filter((entry) => !beforeIds.has(entry.food_entry_id));
  const hasVerifiedExistingEntry = turn.hasWriteOperations === false
    && afterEntries.some((entry) => isBananaOtherEntry(entry, date))
    && beforeEntries.some((entry) => isBananaOtherEntry(entry, date));
  if (newEntries.length === 0 && !hasVerifiedExistingEntry) {
    throw new Error("Repair write smoke neither created a new FatSecret entry nor verified an existing repaired entry.");
  }
  console.log(
    `[write-smoke] repair result=${newEntries.length > 0 ? `created entries=${newEntries.map((entry) => `${entry.food_entry_id}:${entry.food_entry_name ?? "unknown"}`).join(", ")}` : "verified existing banana entry"} replay=${replayFlags.join(",") || "-"}`,
  );

  try {
    const responseText = (response.responseText ?? "").trim();
    if (!responseText) {
      throw new Error("Repair write smoke returned an empty response.");
    }
    if (/\bcould not\b|\bcan't\b|\bdid not stick\b|\bblocked\b|\bcancelled\b/iu.test(responseText)) {
      throw new Error(`Repair write smoke reply still sounds blocked: ${responseText}`);
    }
  } finally {
    if (newEntries.length > 0) {
      await deleteFatSecretEntries(newEntries.map((entry) => entry.food_entry_id));
      const cleanupEntries = await getFatSecretEntries(date);
      const lingering = cleanupEntries.filter((entry) => newEntries.some((created) => created.food_entry_id === entry.food_entry_id));
      if (lingering.length > 0) {
        throw new Error(`Repair cleanup failed for entries: ${lingering.map((entry) => entry.food_entry_id).join(", ")}`);
      }
    }
    console.log("[write-smoke] repair cleanup ok");
  }
}

async function main(): Promise<void> {
  const baseUrl = getBridgeBaseUrl();
  const headers = getBridgeHeaders();
  const agentId = getArg("--agent") ?? "malibu";
  const sessionId = getArg("--session") ?? (
    agentId === "malibu"
      ? buildProjectScopedSessionId("wellness", "smoke-malibu-write")
      : `${agentId}-live-write-smoke`
  );
  const requestedChannelId = getArg("--channel");
  const threadName = getArg("--thread-name") ?? "codex-malibu-live-write-smoke";
  const discordUserId = getArg("--user") ?? "live-smoke";
  const suite = getArg("--suite") ?? "all";
  const token = process.env["DISCORD_TOKEN"]?.trim();
  const channelId = token
    ? await ensureSmokeThread({
        token,
        agentId,
        explicitChannelId: requestedChannelId,
        explicitThreadName: threadName,
      })
    : requestedChannelId;

  console.log(`[write-smoke] bridge=${baseUrl}`);
  console.log(`[write-smoke] db=${getDbPath()}`);
  console.log(`[write-smoke] session=${sessionId} agent=${agentId} channel=${channelId ?? "(none)"}`);

  const health = await fetchJson<{ ok: boolean; status: string }>(`${baseUrl}/health`, {
    headers,
  });
  console.log(`[write-smoke] health ok=${health.ok} status=${health.status}`);

  const db = new DatabaseSync(getDbPath());
  try {
    if (suite === "all" || suite === "simple-writes") {
      await runNutritionWriteSmoke({
        db,
        baseUrl,
        headers,
        sessionId,
        agentId,
        channelId,
        discordUserId,
      });
      await runRecipeUpdateSmoke({
        db,
        baseUrl,
        headers,
        sessionId,
        agentId,
        channelId,
        discordUserId,
      });
    }
    if (suite === "all" || suite === "repair-flow") {
      await runNutritionRepairContinuationSmoke({
        db,
        baseUrl,
        headers,
        sessionId,
        agentId,
        channelId,
        discordUserId,
      });
    }
    if (suite === "all" || suite === "phase3-mixed") {
      await runNutritionWriteThenSummarySmoke({
        db,
        baseUrl,
        headers,
        sessionId,
        agentId,
        channelId,
        discordUserId,
      });
    }
    if (suite === "all" || suite === "sierra-file-write") {
      await runSierraLocalFileWriteSmoke({
        db,
        baseUrl,
        headers,
        sessionId,
        agentId,
        channelId,
        discordUserId,
      });
    }
    if (suite === "all" || suite === "sierra-walmart-write") {
      await runSierraWalmartWriteSmoke({
        db,
        baseUrl,
        headers,
        sessionId,
        agentId,
        channelId,
        discordUserId,
      });
    }
    if (suite === "watson-ramp-reimbursement-repair") {
      await runWatsonRampReimbursementRepairSmoke({
        db,
        baseUrl,
        headers,
        sessionId,
        agentId,
        channelId,
        discordUserId,
      });
    }
    if (suite === "watson-ramp-reimbursement-backfill-repair") {
      await runWatsonRampReimbursementBackfillRepairSmoke({
        db,
        baseUrl,
        headers,
        sessionId,
        agentId,
        channelId,
        discordUserId,
      });
    }
  } finally {
    db.close();
  }

  console.log("[write-smoke] live deterministic wellness write validation passed");
}

void main().catch((error) => {
  console.error(`[write-smoke] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
