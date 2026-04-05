import dotenv from "dotenv";
import { DatabaseSync } from "node:sqlite";
import { resolveDatabasePath } from "@tango/core";
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
  requestMessageId: number | null;
  responseMessageId: number | null;
} | null;

type ActiveTaskRow = {
  id: string;
  status: string;
  title: string;
  objective: string;
  resolvedAt: string | null;
  updatedAt: string;
} | null;

interface ContinuationSmokeCase {
  id: string;
  agentId: string;
  sessionId: string;
  threadName: string;
  transcript: string;
  taskStatus?: "awaiting_user" | "blocked";
  sourceKind?: string;
  title: string;
  objective: string;
  ownerWorkerId: string;
  intentIds: string[];
  clarificationQuestion?: string;
  suggestedNextAction: string;
  structuredContext: Record<string, unknown>;
  responsePatterns: RegExp[];
}

function buildProjectScopedSessionId(projectId: string, scope: string): string {
  return `project:${projectId}#${scope.trim().replace(/\s+/g, "-")}`;
}

const CONTINUATION_CASES: readonly ContinuationSmokeCase[] = [
  {
    id: "malibu-recipe-read",
    agentId: "malibu",
    sessionId: buildProjectScopedSessionId("wellness", "smoke-malibu-continuation"),
    threadName: "codex-malibu-continuation-live",
    transcript: "yeah, check that recipe",
    title: "Review protein yogurt bowl recipe",
    objective: "Read the protein yogurt bowl recipe and summarize the ingredients and totals.",
    ownerWorkerId: "recipe-librarian",
    intentIds: ["recipe.read"],
    clarificationQuestion: "Want me to pull up the protein yogurt bowl recipe?",
    suggestedNextAction: "Confirm the recipe read.",
    structuredContext: {
      recipeTitle: "protein yogurt bowl",
      meal: "breakfast",
    },
    responsePatterns: [/recipe|protein|yogurt/i],
  },
  {
    id: "malibu-diary-repair",
    agentId: "malibu",
    sessionId: buildProjectScopedSessionId("wellness", "smoke-malibu-repair-continuation"),
    threadName: "codex-malibu-repair-continuation-live",
    transcript: "go ahead and finish that meal entry",
    taskStatus: "blocked",
    sourceKind: "execution-blocked",
    title: "Finish banana entry",
    objective: "Finish logging one medium banana as other for tomorrow.",
    ownerWorkerId: "nutrition-logger",
    intentIds: ["nutrition.log_food"],
    suggestedNextAction: "Retry the blocked meal entry using the established details.",
    structuredContext: {
      items: "one medium banana",
      meal: "other",
      source: "execution-blocked",
      blockingWarnings: ["fatsecret_api food_entry_create returned `user cancelled MCP tool call`."],
    },
    responsePatterns: [/banana|logged|entry|other/i],
  },
  {
    id: "watson-finance-lookup",
    agentId: "watson",
    sessionId: "watson-live-deterministic",
    threadName: "codex-watson-continuation-live",
    transcript: "yeah, check those transactions",
    title: "Review recent Amazon transactions",
    objective: "Look up the most recent Amazon transactions and summarize the latest charges.",
    ownerWorkerId: "personal-assistant",
    intentIds: ["finance.transaction_lookup"],
    clarificationQuestion: "Want me to pull the recent Amazon transactions?",
    suggestedNextAction: "Confirm the transaction lookup.",
    structuredContext: {
      merchant: "Amazon",
      system: "Lunch Money",
      focus: "recent charges",
    },
    responsePatterns: [/amazon|transactions?|charges?|spend/i],
  },
  {
    id: "watson-calendar-review",
    agentId: "watson",
    sessionId: "watson-live-deterministic",
    threadName: "codex-watson-continuation-live",
    transcript: "yeah, check the calendar",
    title: "Review tomorrow's calendar",
    objective: "Review tomorrow's calendar and summarize the next notable events.",
    ownerWorkerId: "personal-assistant",
    intentIds: ["planning.calendar_review"],
    clarificationQuestion: "Want me to check tomorrow's calendar?",
    suggestedNextAction: "Confirm the calendar review.",
    structuredContext: {
      system: "Google Calendar",
      focus: "tomorrow",
    },
    responsePatterns: [/calendar|tomorrow|meeting|event/i],
  },
  {
    id: "sierra-note-read",
    agentId: "sierra",
    sessionId: "sierra-live-deterministic",
    threadName: "codex-sierra-continuation-live",
    transcript: "yeah, read that note",
    title: "Read the desk project note",
    objective: "Read the Large Desk OpenGrid and Underware Project note and summarize the Print Summary section.",
    ownerWorkerId: "research-assistant",
    intentIds: ["research.note_read"],
    clarificationQuestion: "Want me to read the desk project note and pull the Print Summary section?",
    suggestedNextAction: "Confirm the note read.",
    structuredContext: {
      noteQuery: "Large Desk OpenGrid and Underware Project",
      focus: "Print Summary",
    },
    responsePatterns: [/print summary|large desk|opengrid|underware|tiles?|plate setups?/i],
  },
  {
    id: "sierra-printer-status",
    agentId: "sierra",
    sessionId: "sierra-live-deterministic",
    threadName: "codex-sierra-continuation-live",
    transcript: "yeah, check that printer",
    title: "Check the MK4 printer",
    objective: "Read the current MK4 printer status and summarize whether it is idle, printing, or blocked.",
    ownerWorkerId: "research-assistant",
    intentIds: ["printing.printer_status"],
    clarificationQuestion: "Want me to check the MK4 printer status?",
    suggestedNextAction: "Confirm the printer status read.",
    structuredContext: {
      printerQuery: "MK4",
      focus: "current status",
    },
    responsePatterns: [/printer|mk4|printing|idle|status|minutes left|temps?|nozzle|bed|\bdone\b/i],
  },
  {
    id: "victor-codebase-read",
    agentId: "victor",
    sessionId: "victor-live-deterministic",
    threadName: "codex-victor-continuation-live",
    transcript: "yeah, check that file",
    title: "Review victor routing config",
    objective: "Read config/agents/victor.yaml and summarize what it says about deterministic routing.",
    ownerWorkerId: "dev-assistant",
    intentIds: ["engineering.codebase_read"],
    clarificationQuestion: "Want me to check victor.yaml and summarize the deterministic routing bits?",
    suggestedNextAction: "Confirm the codebase read.",
    structuredContext: {
      targetQuery: "config/agents/victor.yaml",
      focus: "deterministic routing",
    },
    responsePatterns: [/deterministic routing|victor\.yaml|agent/i],
  },
];

const SUITES: Record<string, readonly string[]> = {
  core: CONTINUATION_CASES.map((scenario) => scenario.id),
  extended: [
    "malibu-recipe-read",
    "malibu-diary-repair",
    "watson-finance-lookup",
    "watson-calendar-review",
    "sierra-note-read",
    "sierra-printer-status",
    "victor-codebase-read",
  ],
};

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

function getDbPath(): string {
  return resolveDatabasePath(process.env["TANGO_DB_PATH"]);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
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

function loadMessageContent(db: DatabaseSync, id: number | null): string | null {
  if (!id) {
    return null;
  }
  const row = db.prepare(`SELECT content FROM messages WHERE id = ?`).get(id) as
    | { content: string }
    | undefined;
  return row?.content ?? null;
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
       request_message_id AS requestMessageId,
       response_message_id AS responseMessageId
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
        requestMessageId: number | null;
        responseMessageId: number | null;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    routeOutcome: row.routeOutcome,
    intentIds: parseJsonArray(row.intentIdsJson),
    workerIds: parseJsonArray(row.workerIdsJson),
    requestMessageId: row.requestMessageId,
    responseMessageId: row.responseMessageId,
  };
}

async function waitForNewDeterministicTurn(input: {
  db: DatabaseSync;
  sessionId: string;
  agentId: string;
  previousId: string | null;
  timeoutMs?: number;
}): Promise<StoredDeterministicTurn> {
  const deadline = Date.now() + (input.timeoutMs ?? 180_000);
  while (Date.now() < deadline) {
    const latest = loadLatestDeterministicTurn(input.db, input.sessionId, input.agentId);
    if (latest && latest.id !== input.previousId) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return null;
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
  if (sessionId.startsWith("project:")) {
    return "project";
  }
  if (sessionId.startsWith("ephemeral:")) {
    return "ephemeral";
  }
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
  clarificationQuestion?: string;
  suggestedNextAction: string;
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

function getSelectedCases(): readonly ContinuationSmokeCase[] {
  const scenarioId = getArg("--scenario")?.trim();
  if (scenarioId) {
    const match = CONTINUATION_CASES.find((scenario) => scenario.id === scenarioId);
    if (!match) {
      throw new Error(`Unknown continuation scenario '${scenarioId}'.`);
    }
    return [match];
  }

  const suiteId = getArg("--suite")?.trim() || "core";
  const caseIds = SUITES[suiteId];
  if (!caseIds) {
    throw new Error(`Unknown continuation suite '${suiteId}'.`);
  }
  return caseIds.map((caseId) => {
    const match = CONTINUATION_CASES.find((scenario) => scenario.id === caseId);
    if (!match) {
      throw new Error(`Suite '${suiteId}' references unknown scenario '${caseId}'.`);
    }
    return match;
  });
}

async function runCase(input: {
  db: DatabaseSync;
  baseUrl: string;
  headers: Record<string, string>;
  token: string | null;
  scenario: ContinuationSmokeCase;
  discordUserId: string;
}): Promise<void> {
  const { db, baseUrl, headers, token, scenario, discordUserId } = input;
  const taskId = `codex-live-continuation-${scenario.id}`;
  const channelId = token
    ? await ensureSmokeThread({
        token,
        agentId: scenario.agentId,
        explicitThreadName: scenario.threadName,
      })
    : null;

  console.log(
    `[continuation-smoke:${scenario.id}] session=${scenario.sessionId} agent=${scenario.agentId} channel=${channelId ?? "(none)"}`,
  );

  seedActiveTask(db, {
    id: taskId,
    sessionId: scenario.sessionId,
    agentId: scenario.agentId,
    status: scenario.taskStatus ?? "awaiting_user",
    title: scenario.title,
    objective: scenario.objective,
    ownerWorkerId: scenario.ownerWorkerId,
    intentIds: scenario.intentIds,
    clarificationQuestion: scenario.clarificationQuestion,
    suggestedNextAction: scenario.suggestedNextAction,
    structuredContext: scenario.structuredContext,
    sourceKind: scenario.sourceKind ?? "assistant-offer",
  });

  const seeded = loadActiveTask(db, taskId);
  if (!seeded || seeded.status !== (scenario.taskStatus ?? "awaiting_user")) {
    throw new Error(`[${scenario.id}] Failed to seed active task.`);
  }

  const previousTurn = loadLatestDeterministicTurn(db, scenario.sessionId, scenario.agentId);
  console.log(
    `[continuation-smoke:${scenario.id}] seeded task=${taskId} previous_turn=${previousTurn?.id ?? "(none)"} status=${seeded.status}`,
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  let result: VoiceTurnHttpResponse | null = null;
  let responseError: Error | null = null;
  try {
    result = await fetchJson<VoiceTurnHttpResponse>(`${baseUrl}/voice/turn`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sessionId: scenario.sessionId,
        agentId: scenario.agentId,
        transcript: scenario.transcript,
        channelId,
        discordUserId,
      }),
      signal: controller.signal,
    });
    console.log(
      `[continuation-smoke:${scenario.id}] response ok=${result.ok} provider=${result.providerName ?? "-"} failover=${result.providerUsedFailover ? "yes" : "no"} warmStart=${result.warmStartUsed ? "yes" : "no"}`,
    );
    console.log(
      `[continuation-smoke:${scenario.id}] responseText=${JSON.stringify(result.responseText ?? "")}`,
    );
  } catch (error) {
    responseError = error instanceof Error ? error : new Error(String(error));
    console.warn(
      `[continuation-smoke:${scenario.id}] transport error waiting for /voice/turn: ${responseError.message}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  const latestTurn = await waitForNewDeterministicTurn({
    db,
    sessionId: scenario.sessionId,
    agentId: scenario.agentId,
    previousId: previousTurn?.id ?? null,
    timeoutMs: 180_000,
  });
  if (!latestTurn) {
    throw new Error(`[${scenario.id}] Timed out waiting for deterministic turn after continuation.`);
  }

  const finalTask = loadActiveTask(db, taskId);
  const persistedResponseText = loadMessageContent(db, latestTurn.responseMessageId);
  const responseText = result?.responseText ?? persistedResponseText ?? "";
  console.log(
    `[continuation-smoke:${scenario.id}] deterministic_turn=${latestTurn.id} route=${latestTurn.routeOutcome} intents=${latestTurn.intentIds.join(",") || "-"} workers=${latestTurn.workerIds.join(",") || "-"} task_status=${finalTask?.status ?? "(missing)"}`,
  );

  if (latestTurn.routeOutcome !== "executed") {
    throw new Error(`[${scenario.id}] Expected executed route, got ${latestTurn.routeOutcome}`);
  }
  for (const intentId of scenario.intentIds) {
    if (!latestTurn.intentIds.includes(intentId)) {
      throw new Error(
        `[${scenario.id}] Expected intent ${intentId}, got ${latestTurn.intentIds.join(",") || "(none)"}`,
      );
    }
  }
  if (!latestTurn.workerIds.includes(scenario.ownerWorkerId)) {
    throw new Error(
      `[${scenario.id}] Expected worker ${scenario.ownerWorkerId}, got ${latestTurn.workerIds.join(",") || "(none)"}`,
    );
  }
  if (!responseText || !scenario.responsePatterns.some((pattern) => pattern.test(responseText))) {
    throw new Error(
      `[${scenario.id}] Expected grounded response text, got ${JSON.stringify(responseText || result?.responseText || "")}`,
    );
  }
  if (!finalTask || finalTask.status !== "completed" || !finalTask.resolvedAt) {
    throw new Error(`[${scenario.id}] Expected active task to complete, got ${JSON.stringify(finalTask)}`);
  }
  if (responseError && !persistedResponseText) {
    throw responseError;
  }
}

async function main(): Promise<void> {
  const token = process.env["DISCORD_TOKEN"]?.trim()
    || process.env["DISCORD_BOT_TOKEN"]?.trim()
    || null;
  const baseUrl = getBridgeBaseUrl();
  const headers = getBridgeHeaders();
  const dbPath = getDbPath();
  const db = new DatabaseSync(dbPath);
  const discordUserId = "codex-live-user";
  const scenarios = getSelectedCases();

  console.log(`[continuation-smoke] bridge=${baseUrl}`);
  console.log(`[continuation-smoke] db=${dbPath}`);
  console.log(`[continuation-smoke] scenarios=${scenarios.map((scenario) => scenario.id).join(",")}`);

  const health = await fetchJson<{ ok?: boolean; status?: string }>(`${baseUrl}/health`, {
    headers,
  });
  if (health.ok !== true && health.status !== "healthy") {
    throw new Error(`Bridge health check failed: ${JSON.stringify(health)}`);
  }

  for (const scenario of scenarios) {
    await runCase({
      db,
      baseUrl,
      headers,
      token,
      scenario,
      discordUserId,
    });
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[continuation-smoke] failed: ${message}`);
  process.exitCode = 1;
});
