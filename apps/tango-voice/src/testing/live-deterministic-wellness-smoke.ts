import dotenv from "dotenv";
import { DatabaseSync } from "node:sqlite";
import { resolveDatabasePath } from "@tango/core";
import { ensureSmokeThread } from "./discord-smoke-thread.js";

dotenv.config();

import {
  deprecatedExpectationNote,
  latestOutboundMessageId,
  toolUsedMatches,
  waitForV2TurnEvidence,
} from "./v2-turn-evidence.js";

type VoiceTurnHttpResponse = {
  ok: boolean;
  error?: string;
  message?: string;
  sessionId?: string;
  agentId?: string;
  responseText?: string;
  providerName?: string;
  providerSessionId?: string | null;
  warmStartUsed?: boolean;
  providerUsedFailover?: boolean;
};

interface DeterministicSmokeCase {
  id: string;
  transcript: string;
  expectIntents: string[];
  expectWorkers: string[];
  expectRoute: "executed" | "clarification" | "fallback";
  expectWriteOperations?: boolean;
  expectStepCount?: number;
  requiredResponsePatterns?: RegExp[];
  requiredWarningPatterns?: RegExp[];
  requiredOperationNames?: string[];
  requireLocationFreshnessConsistency?: boolean;
  allowDegradedReadReply?: boolean;
  waitTimeoutMs?: number;
}

const PHASE1_READ_CASES: readonly DeterministicSmokeCase[] = [
  {
    id: "sleep-recovery",
    transcript: "How did I sleep last night?",
    expectIntents: ["health.sleep_recovery"],
    expectWorkers: ["health-analyst"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 1,
  },
  {
    id: "nutrition-day-summary",
    transcript: "What have I eaten today?",
    expectIntents: ["nutrition.day_summary"],
    expectWorkers: ["nutrition-logger"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 1,
  },
  {
    id: "recipe-read",
    transcript: "What's in my protein yogurt bowl recipe?",
    expectIntents: ["recipe.read"],
    expectWorkers: ["recipe-librarian"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 1,
  },
  {
    id: "workout-history",
    transcript: "What was my last workout?",
    expectIntents: ["workout.history"],
    expectWorkers: ["workout-recorder"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 1,
  },
];

const PHASE3_MIXED_READ_CASES: readonly DeterministicSmokeCase[] = [
  {
    id: "sleep-and-workout",
    transcript: "How did I sleep last night and what was my last workout?",
    expectIntents: ["health.sleep_recovery", "workout.history"],
    expectWorkers: ["health-analyst", "workout-recorder"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 2,
  },
];

const PHASE4_MALIBU_EXPANSION_CASES: readonly DeterministicSmokeCase[] = [
  {
    id: "health-trend-analysis",
    transcript: "Take a look at my TDEE over the last few weeks and tell me what trend you see.",
    expectIntents: ["health.trend_analysis"],
    expectWorkers: ["health-analyst"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 1,
    requiredResponsePatterns: [/(TDEE|trend|weeks?|average|deficit|calories)/i],
  },
  {
    id: "nutrition-budget-check",
    transcript: "Do I still have room for yogurt tonight?",
    expectIntents: ["nutrition.check_budget"],
    expectWorkers: ["nutrition-logger"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 1,
    requiredResponsePatterns: [/(room|yogurt|calories|protein|budget|snack)/i],
  },
  {
    id: "health-trend-plus-budget",
    transcript: "Take a look at my TDEE over the last few weeks and tell me if I still have room for yogurt tonight.",
    expectIntents: ["health.trend_analysis", "nutrition.check_budget"],
    expectWorkers: ["health-analyst", "nutrition-logger"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 2,
    requiredResponsePatterns: [/(TDEE|trend|weeks?|average|deficit|calories)/i, /(room|yogurt|protein|budget|snack)/i],
  },
  {
    id: "health-metric-question",
    transcript: "How many steps did I get yesterday?",
    expectIntents: ["health.metric_lookup_or_question"],
    expectWorkers: ["health-analyst"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 1,
    requiredResponsePatterns: [/(steps|yesterday|exercise|workouts?)/i],
    requiredOperationNames: ["health_query"],
  },
  {
    id: "workout-routine-push-a",
    transcript: "What exercises are in Push Day A?",
    expectIntents: ["workout.history"],
    expectWorkers: ["workout-recorder"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 1,
    requiredResponsePatterns: [/(push day a|dumbbell bench press|db bench|overhead press|cable tricep extension|lateral raise)/i],
    requiredOperationNames: ["workout_sql"],
  },
  {
    id: "workout-routine-pull-day-2",
    transcript: "What exercises are in the Friday pull day 2 routine?",
    expectIntents: ["workout.history"],
    expectWorkers: ["workout-recorder"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 1,
    requiredResponsePatterns: [/(pull day 2|pull day b|dumbbell row|close grip lat pulldown|rear delt fly|hammer curl)/i],
    requiredOperationNames: ["workout_sql"],
  },
];

const PHASE4_RESEARCH_CORE_CASES: readonly DeterministicSmokeCase[] = [
  {
    id: "research-note-read",
    transcript: "Read the Obsidian note titled Large Desk OpenGrid and Underware Project and summarize the Print Summary section.",
    expectIntents: ["research.note_read"],
    expectWorkers: ["research-assistant"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 1,
  },
  {
    id: "research-note-plus-web",
    transcript: "Read the Obsidian note titled Large Desk OpenGrid and Underware Project and also look up the official Prusa MK4S product page.",
    expectIntents: ["research.note_read", "research.web_lookup"],
    expectWorkers: ["research-assistant"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 2,
  },
  {
    id: "research-product-selection",
    transcript:
      "Help me figure out which Keychron keyboard model is right for me. I want a full layout with a full number pad, USB and Bluetooth, backlighting, mechanical feel, and good Mac support.",
    expectIntents: ["research.product_selection"],
    expectWorkers: ["research-assistant"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 1,
    requiredResponsePatterns: [/(keychron|keyboard|mac|bluetooth|numpad|full layout|full-size)/i],
  },
  {
    id: "research-account-identity",
    transcript: "Use the worker to run 1Password whoami and summarize only the account URL.",
    expectIntents: ["accounts.identity_read"],
    expectWorkers: ["research-assistant"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 1,
    requiredResponsePatterns: [/(1password|account|url|signin|\.1password\.com)/i],
    requiredOperationNames: ["onepassword"],
  },
  {
    id: "research-printer-status",
    transcript: "Use the worker to check the current printer status and summarize it briefly.",
    expectIntents: ["printing.printer_status"],
    expectWorkers: ["research-assistant"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 1,
    allowDegradedReadReply: true,
  },
  {
    id: "research-local-files",
    transcript:
      "Use the worker to list the most recent files in ~/Downloads and summarize what kinds of files are there.",
    expectIntents: ["files.local_read"],
    expectWorkers: ["research-assistant"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 1,
    requiredResponsePatterns: [/(downloads|files|recent|folder|items|documents)/i],
  },
  {
    id: "research-location-read",
    transcript: "Where am I right now?",
    expectIntents: ["travel.location_read"],
    expectWorkers: ["research-assistant"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 1,
    requireLocationFreshnessConsistency: true,
  },
  {
    id: "research-location-plus-printer",
    transcript: "Where am I right now and what's the current printer status?",
    expectIntents: ["travel.location_read", "printing.printer_status"],
    expectWorkers: ["research-assistant"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 2,
    requireLocationFreshnessConsistency: true,
    allowDegradedReadReply: true,
  },
];

const PHASE4_RESEARCH_EXPANSION_CASES: readonly DeterministicSmokeCase[] = [
  {
    id: "research-print-preview",
    transcript: "Get the 7x7 OpenGrid print ready for the MK4, but preview only. Do not upload or start it.",
    expectIntents: ["printing.job_prepare_or_start"],
    expectWorkers: ["research-assistant"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 1,
    requiredResponsePatterns: [/(preview|ready|7x7|OpenGrid|MK4|upload|start)/i],
    requiredOperationNames: ["printer_command"],
    waitTimeoutMs: 300_000,
  },
  {
    id: "research-diesel-lookup",
    transcript: "Find the best diesel stops on the route to Tonopah, Nevada.",
    expectIntents: ["travel.diesel_lookup"],
    expectWorkers: ["research-assistant"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 1,
    waitTimeoutMs: 900_000,
  },
  {
    id: "research-local-business-shortlist",
    transcript:
      "Find a shortlist of restaurants worth checking out in Puerto Escondido. Use local candidate discovery first, and only include hours or contact details if you verified them from a source.",
    expectIntents: ["research.local_business"],
    expectWorkers: ["research-coordinator"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 1,
    requiredResponsePatterns: [/(Puerto Escondido|restaurant|restaurants)/i, /(verified|unverified|source|official)/i],
    requiredOperationNames: ["local_business_search"],
    waitTimeoutMs: 300_000,
  },
  {
    id: "research-video-read",
    transcript: "Use the transcript to summarize this YouTube video briefly: https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    expectIntents: ["research.video_read"],
    expectWorkers: ["research-assistant"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 1,
    requiredResponsePatterns: [/(video|youtube|music|song|rick|astley|never gonna give you up)/i],
    waitTimeoutMs: 300_000,
  },
];

const PHASE4_FOXTROT_CASES: readonly DeterministicSmokeCase[] = [
  {
    id: "foxtrot-walmart-queue",
    transcript: "Use the worker to list the current Walmart queue and summarize it briefly.",
    expectIntents: ["shopping.walmart_queue_review"],
    expectWorkers: ["foxtrot"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 1,
  },
];

const PHASE4_WATSON_CASES: readonly DeterministicSmokeCase[] = [
  {
    id: "watson-finance-unreviewed",
    transcript: "Can you summarize our unconfirmed transactions for me please so we can go through them?",
    expectIntents: ["finance.unreviewed_transactions"],
    expectWorkers: ["personal-assistant"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 1,
  },
  {
    id: "watson-calendar-review",
    transcript: "What's on my calendar today?",
    expectIntents: ["planning.calendar_review"],
    expectWorkers: ["personal-assistant"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 1,
  },
  {
    id: "watson-transaction-lookup",
    transcript: "What were my most recent Amazon transactions?",
    expectIntents: ["finance.transaction_lookup"],
    expectWorkers: ["personal-assistant"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 1,
  },
  {
    id: "watson-budget-review",
    transcript: "How am I doing against budget this month?",
    expectIntents: ["finance.budget_review"],
    expectWorkers: ["personal-assistant"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 1,
  },
  {
    id: "watson-email-review",
    transcript: "What unread emails need attention today?",
    expectIntents: ["email.inbox_review"],
    expectWorkers: ["personal-assistant"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 1,
  },
  {
    id: "watson-health-brief",
    transcript: "Give me my morning health briefing.",
    expectIntents: ["health.morning_brief"],
    expectWorkers: ["personal-assistant"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 1,
  },
  {
    id: "watson-note-read",
    transcript: "Read the Obsidian note titled Large Desk OpenGrid and Underware Project and summarize the Print Summary section.",
    expectIntents: ["notes.note_read"],
    expectWorkers: ["personal-assistant"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 1,
  },
  {
    id: "watson-calendar-plus-email",
    transcript: "What's on my calendar today and what unread emails need attention?",
    expectIntents: ["planning.calendar_review", "email.inbox_review"],
    expectWorkers: ["personal-assistant"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 2,
  },
  {
    id: "watson-health-plus-budget",
    transcript: "Give me my morning health briefing and tell me how I'm doing against budget this month.",
    expectIntents: ["health.morning_brief", "finance.budget_review"],
    expectWorkers: ["personal-assistant"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 2,
  },
];

const PHASE4_WATSON_EXPANSION_CASES: readonly DeterministicSmokeCase[] = [
  {
    id: "watson-receipt-lookup",
    transcript: "Can you look up what the Amazon charge on Mar 27 for $15.19 was for?",
    expectIntents: ["finance.receipt_lookup"],
    expectWorkers: ["personal-assistant"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 1,
    requiredResponsePatterns: [/(amazon|charge|receipt|order|transaction)/i],
    waitTimeoutMs: 300_000,
  },
];

const PHASE4_VICTOR_CASES: readonly DeterministicSmokeCase[] = [
  {
    id: "victor-operations-project-review",
    transcript: "Review the Victor Operations Chief project in Linear.",
    expectIntents: ["operations.project_review"],
    expectWorkers: ["operations-assistant"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 1,
    requiredResponsePatterns: [/(Victor Operations Chief|Linear|project|milestone|status|blocker)/i],
  },
  {
    id: "victor-decision-packet",
    transcript: "Prepare a decision packet for the Victor Operations Chief validation milestone.",
    expectIntents: ["operations.decision_packet"],
    expectWorkers: ["operations-assistant"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 1,
    requiredResponsePatterns: [/(decision packet|validation|facts|open questions|next actions|sources?)/i],
  },
  {
    id: "victor-project-plus-decision-packet",
    transcript: "Review the Victor Operations Chief project and prepare a decision packet for the validation milestone.",
    expectIntents: ["operations.project_review", "operations.decision_packet"],
    expectWorkers: ["operations-assistant"],
    expectRoute: "executed",
    expectWriteOperations: false,
    expectStepCount: 2,
    requiredResponsePatterns: [/(Victor Operations Chief|Linear|project)/i, /(decision packet|validation|open questions|next actions)/i],
  },
];

function buildProjectScopedSessionId(projectId: string, scope: string): string {
  return `project:${projectId}#${scope.trim().replace(/\s+/g, "-")}`;
}

function defaultSmokeSessionId(agentId: string): string {
  if (agentId === "malibu") {
    return buildProjectScopedSessionId("wellness", "smoke-malibu-deterministic");
  }
  return `${agentId}-live-deterministic`;
}

const INVALID_STATUS_REPLY = /\b(waiting on (?:the )?(?:worker|results?|response)|waiting for (?:the )?(?:worker|results?|response)|still loading|back in a sec|hit me back|next message|results are loading|standing by|waves are loading|dispatched again)\b/i;
const DEGRADED_READ_REPLY =
  /\b(can(?:not|'t) verify|couldn'?t verify|no read on|re-?check(?: it| that| again)?\b|flaked\b|wiping out before it returned|retry (?:the )?.*?(?:lookup|read|query)|tool call was cancelled|could not be verified)\b/i;

function getArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

function getNumberArg(flag: string, fallback: number): number {
  const value = getArg(flag);
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveCases(
  suite: string | null,
  transcript: string | null,
): readonly DeterministicSmokeCase[] {
  return suite === "phase1-read"
    ? PHASE1_READ_CASES
    : suite === "phase3-mixed-read"
      ? PHASE3_MIXED_READ_CASES
      : suite === "phase4-malibu-expansion"
        ? PHASE4_MALIBU_EXPANSION_CASES
      : suite === "phase4-research"
        ? PHASE4_RESEARCH_CORE_CASES
      : suite === "phase4-research-expansion"
        ? PHASE4_RESEARCH_EXPANSION_CASES
      : suite === "phase4-foxtrot"
        ? PHASE4_FOXTROT_CASES
      : suite === "phase4-watson"
        ? PHASE4_WATSON_CASES
      : suite === "phase4-watson-expansion"
        ? PHASE4_WATSON_EXPANSION_CASES
      : suite === "phase4-victor"
        ? PHASE4_VICTOR_CASES
      : [
          {
            id: "single",
            transcript: transcript ?? "How did I sleep last night?",
            expectIntents: [getArg("--expect-intent") ?? "health.sleep_recovery"],
            expectWorkers: [getArg("--expect-worker") ?? "health-analyst"],
            expectRoute: (getArg("--expect-route") ?? "executed") as "executed" | "clarification" | "fallback",
            expectWriteOperations: getArg("--expect-write-operations") === null
              ? undefined
              : getArg("--expect-write-operations") === "true",
            expectStepCount: getArg("--expect-step-count") ? Number(getArg("--expect-step-count")) : undefined,
          },
        ];
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
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}${text ? `: ${text}` : ""}`);
  }
  return JSON.parse(text) as T;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientSmokeError(error: Error): boolean {
  return /\bfetch failed\b|\bECONN(?:RESET|REFUSED)\b|\bsocket hang up\b|\btimed out waiting for a new v2 outbound message row\b/i
    .test(error.message);
}

async function runSmokeCaseOnce(input: {
  db: DatabaseSync;
  baseUrl: string;
  headers: Record<string, string>;
  sessionId: string;
  agentId: string;
  channelId?: string | null;
  discordUserId: string;
  testCase: DeterministicSmokeCase;
}): Promise<void> {
  const baselineMessageId = latestOutboundMessageId(input.db, input.sessionId, input.agentId);
  console.log(
    `[deterministic-smoke] case=${input.testCase.id} baseline outbound message id=${baselineMessageId || "(none)"}`,
  );

  const responsePromise = fetchJson<VoiceTurnHttpResponse>(`${input.baseUrl}/voice/turn`, {
    method: "POST",
    headers: {
      ...input.headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sessionId: input.sessionId,
      agentId: input.agentId,
      transcript: input.testCase.transcript,
      channelId: input.channelId,
      discordUserId: input.discordUserId,
    }),
  });

  let result: VoiceTurnHttpResponse | null = null;
  let responseError: Error | null = null;
  try {
    result = await responsePromise;
    console.log(
      `[deterministic-smoke] case=${input.testCase.id} response ok=${result.ok} provider=${result.providerName ?? "-"} failover=${result.providerUsedFailover ? "yes" : "no"} warmStart=${result.warmStartUsed ? "yes" : "no"}`,
    );
    console.log(`[deterministic-smoke] case=${input.testCase.id} responseText=${JSON.stringify(result.responseText ?? "")}`);
  } catch (error) {
    responseError = error instanceof Error ? error : new Error(String(error));
    console.warn(
      `[deterministic-smoke] case=${input.testCase.id} transport error waiting for /voice/turn: ${responseError.message}`,
    );
  }

  const latest = await waitForV2TurnEvidence({
    db: input.db,
    sessionId: input.sessionId,
    agentId: input.agentId,
    afterMessageId: baselineMessageId,
    timeoutMs: input.testCase.waitTimeoutMs,
  });
  if (!latest) {
    throw responseError ?? new Error(`Case '${input.testCase.id}' timed out waiting for a new v2 outbound message row.`);
  }

  console.log(
    `[deterministic-smoke] case=${input.testCase.id} v2 turn message=${latest.messageId} runtime=${latest.runtimePath ?? "-"} latencyMs=${latest.latencyMs ?? "-"} toolsUsed=${latest.toolsUsed.join(",") || "-"}`,
  );

  // expectRoute "executed" maps to "a v2 turn completed and replied"; the
  // remaining deterministic-pipeline expectations have no v2 equivalent.
  deprecatedExpectationNote("deterministic-smoke", input.testCase.id, [
    ...(input.testCase.expectIntents.length > 0 ? ["expectIntents"] : []),
    ...(input.testCase.expectWorkers.length > 0 ? ["expectWorkers"] : []),
    ...(input.testCase.expectWriteOperations !== undefined ? ["expectWriteOperations"] : []),
    ...(input.testCase.expectStepCount !== undefined ? ["expectStepCount"] : []),
  ]);
  if (latest.runtimeStderr && latest.runtimeStderr.trim().length > 0) {
    throw new Error(
      `Case '${input.testCase.id}' v2 turn recorded runtime stderr: ${JSON.stringify(latest.runtimeStderr.slice(0, 400))}`,
    );
  }
  const responseText = (
    result?.responseText
    ?? latest.responseText
    ?? ""
  ).trim();
  if (!result && responseError) {
    console.log(
      `[deterministic-smoke] case=${input.testCase.id} recovered response text from persisted messages after transport error`,
    );
    console.log(`[deterministic-smoke] case=${input.testCase.id} responseText=${JSON.stringify(responseText)}`);
  }
  if (responseText.length === 0) {
    throw new Error(`Case '${input.testCase.id}' returned an empty response.`);
  }
  if (INVALID_STATUS_REPLY.test(responseText)) {
    throw new Error(`Case '${input.testCase.id}' returned an invalid status-style reply: ${JSON.stringify(responseText)}`);
  }
  if (!input.testCase.allowDegradedReadReply && DEGRADED_READ_REPLY.test(responseText)) {
    throw new Error(`Case '${input.testCase.id}' returned a degraded read reply: ${JSON.stringify(responseText)}`);
  }
  for (const pattern of input.testCase.requiredResponsePatterns ?? []) {
    if (!pattern.test(responseText)) {
      throw new Error(
        `Case '${input.testCase.id}' response did not include required pattern ${pattern}: ${JSON.stringify(responseText)}`
      );
    }
  }
  for (const operationName of input.testCase.requiredOperationNames ?? []) {
    if (!toolUsedMatches(latest.toolsUsed, operationName)) {
      throw new Error(
        `Case '${input.testCase.id}' expected tool ${operationName} to be used, got ${latest.toolsUsed.join(",") || "(none)"}`,
      );
    }
  }
  deprecatedExpectationNote("deterministic-smoke", input.testCase.id, [
    ...((input.testCase.requiredWarningPatterns ?? []).length > 0 ? ["requiredWarningPatterns"] : []),
    ...(input.testCase.requireLocationFreshnessConsistency ? ["requireLocationFreshnessConsistency"] : []),
  ]);
}

async function runSmokeCase(input: {
  db: DatabaseSync;
  baseUrl: string;
  headers: Record<string, string>;
  sessionId: string;
  agentId: string;
  channelId?: string | null;
  discordUserId: string;
  testCase: DeterministicSmokeCase;
  maxAttempts: number;
}): Promise<void> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= input.maxAttempts; attempt++) {
    if (input.maxAttempts > 1) {
      console.log(`[deterministic-smoke] case=${input.testCase.id} attempt=${attempt}/${input.maxAttempts}`);
    }
    try {
      await runSmokeCaseOnce(input);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt >= input.maxAttempts || !isTransientSmokeError(lastError)) {
        throw lastError;
      }
      console.warn(`[deterministic-smoke] case=${input.testCase.id} transient failure: ${lastError.message}`);
      await sleep(1_000);
    }
  }
  throw lastError ?? new Error(`Case '${input.testCase.id}' failed without a captured error.`);
}

async function main(): Promise<void> {
  const baseUrl = getBridgeBaseUrl();
  const headers = getBridgeHeaders();
  const agentId = getArg("--agent") ?? "malibu";
  const sessionBase = getArg("--session") ?? defaultSmokeSessionId(agentId);
  const suite = getArg("--suite");
  const caseId = getArg("--case");
  const transcript = getArg("--transcript");
  const requestedChannelId = getArg("--channel");
  const threadName = getArg("--thread-name");
  const discordUserId = getArg("--user") ?? "live-smoke";
  const maxAttempts = getNumberArg("--max-attempts", 3);
  const token = process.env["DISCORD_TOKEN"]?.trim();
  const channelId = token
    ? await ensureSmokeThread({
        token,
        agentId,
        explicitChannelId: requestedChannelId,
        explicitThreadName: threadName,
      })
    : requestedChannelId;

  const resolvedCases = resolveCases(suite, transcript);
  const cases = caseId
    ? resolvedCases.filter((testCase) => testCase.id === caseId)
    : resolvedCases;
  if (caseId && cases.length === 0) {
    throw new Error(
      `No deterministic smoke case matched --case=${JSON.stringify(caseId)} in suite ${JSON.stringify(suite ?? "single")}.`,
    );
  }

  console.log(`[deterministic-smoke] bridge=${baseUrl}`);
  console.log(`[deterministic-smoke] db=${getDbPath()}`);
  console.log(`[deterministic-smoke] agent=${agentId} channel=${channelId ?? "(none)"}`);
  console.log(`[deterministic-smoke] suite=${suite ?? "single"} cases=${cases.length}${caseId ? ` case=${caseId}` : ""}`);

  const health = await fetchJson<{ ok: boolean; status: string }>(`${baseUrl}/health`, {
    headers,
  });
  console.log(`[deterministic-smoke] health ok=${health.ok} status=${health.status}`);

  const db = new DatabaseSync(getDbPath());
  try {
    for (const testCase of cases) {
      const sessionId = sessionBase;
      console.log(
        `[deterministic-smoke] case=${testCase.id} session=${sessionId} transcript=${JSON.stringify(testCase.transcript)}`,
      );
      await runSmokeCase({
        db,
        baseUrl,
        headers,
        sessionId,
        agentId,
        channelId,
        discordUserId,
        testCase,
        maxAttempts,
      });
    }
  } finally {
    db.close();
  }

  console.log("[deterministic-smoke] live deterministic validation passed");
}

void main().catch((error) => {
  console.error(`[deterministic-smoke] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
