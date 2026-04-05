/**
 * Overnight Memory System Evaluation
 *
 * Multi-hour scripted conversation test that exercises the memory system
 * and documents real-time memory construction, retrieval, and scoping behavior.
 *
 * Usage:
 *   cd <repo-root> && npx tsx scripts/overnight-memory-eval.ts
 *
 * Requires tango to be running (voice bridge on port 8787 by default).
 */

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  loadAgentConfigs,
  resolveConfigDir,
  resolveDatabasePath,
  resolveTangoDataPath,
} from "@tango/core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const VOICE_PORT = process.env["TANGO_VOICE_BRIDGE_PORT"]?.trim() || "8787";
const VOICE_URL = `http://127.0.0.1:${VOICE_PORT}/voice/turn`;
const VOICE_API_KEY =
  process.env["TANGO_VOICE_BRIDGE_API_KEY"]?.trim() || "";

const DB_PATH = resolveDatabasePath(process.env["TANGO_DB_PATH"]);
const REPORTS_DIR = resolveTangoDataPath("reports");
const DATE_TAG = new Date().toISOString().slice(0, 10);
const EVAL_SESSION_PREFIX = "memory-eval-overnight";
const SESSION_SUFFIX = process.env["EVAL_SESSION_SUFFIX"]?.trim() || "";
const SESSION_ID = `${EVAL_SESSION_PREFIX}-${DATE_TAG}${SESSION_SUFFIX ? `-${SESSION_SUFFIX}` : ""}`;

// --skip-phases N: skip the first N phases (for resuming after a crash)
const SKIP_PHASES = (() => {
  const idx = process.argv.indexOf("--skip-phases");
  return idx >= 0 ? parseInt(process.argv[idx + 1] ?? "0", 10) : 0;
})();

// Gap between messages within a phase (ms)
const INTER_MESSAGE_GAP_MS = 3 * 60 * 1000; // 3 minutes
// Observation phase poll interval (ms)
const OBSERVATION_POLL_MS = 10 * 60 * 1000; // 10 minutes
// Observation phase total duration (ms)
const OBSERVATION_DURATION_MS = 60 * 60 * 1000; // 60 minutes

function resolveSmokeChannel(agentId: string): string {
  const envKey = `TANGO_SMOKE_CHANNEL_${agentId.toUpperCase()}`;
  const explicit = process.env[envKey]?.trim();
  if (explicit) {
    return explicit;
  }

  const agent = loadAgentConfigs(resolveConfigDir()).find((candidate) => candidate.id === agentId);
  const configuredChannel =
    agent?.voice?.smokeTestChannelId?.trim()
    || agent?.voice?.defaultChannelId?.trim()
    || "";

  if (/^\d+$/.test(configuredChannel)) {
    return configuredChannel;
  }

  throw new Error(
    `No smoke channel configured for agent '${agentId}'. Set ${envKey} or provide a numeric voice.smoke_test_channel_id in the active profile.`,
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TurnResult {
  ok: boolean;
  error?: string;
  message?: string;
  sessionId?: string;
  agentId?: string;
  responseText?: string;
  providerName?: string;
  warmStartUsed?: boolean;
  providerUsedFailover?: boolean;
}

interface PhaseMessage {
  transcript: string;
  agentId: string;
}

interface Phase {
  id: string;
  name: string;
  agentId: string;
  messages: PhaseMessage[];
  description: string;
}

interface TurnAnalysis {
  turnIndex: number;
  transcript: string;
  agentId: string;
  responseText: string;
  timestamp: string;
  warmStartUsed: boolean;
  providerName: string;
  retrievedMemories: TraceMemory[];
  scoreSpread: number;
  contamination: ContaminationFlag[];
  obsidianLeaks: number;
  newMemoriesCreated: MemoryRecord[];
  summariesExist: boolean;
  summaryCount: number;
  latencyMs: number | null;
  issues: string[];
  wins: string[];
}

interface TraceMemory {
  id: number;
  source: string;
  content: string;
  importance: number;
  score: number;
  relevanceScore: number;
  keywordScore: number;
  semanticScore: number;
  recencyScore: number;
  sourceBonus: number;
  qualityPenalty: number;
}

interface ContaminationFlag {
  memoryId: number;
  memorySource: string;
  memoryContent: string;
  expectedDomain: string;
  reason: string;
}

interface MemoryRecord {
  id: number;
  session_id: string | null;
  agent_id: string | null;
  source: string;
  content: string;
  importance: number;
  created_at: string;
}

interface PhaseReport {
  phaseId: string;
  phaseName: string;
  agentId: string;
  turnAnalyses: TurnAnalysis[];
  totalMemoriesCreated: number;
  totalIssues: number;
  totalWins: number;
  summaryFormed: boolean;
}

// ---------------------------------------------------------------------------
// Conversation Phases
// ---------------------------------------------------------------------------

const PHASES: Phase[] = [
  {
    id: "phase1-wellness-baseline",
    name: "Phase 1: Wellness Baseline",
    agentId: "malibu",
    description:
      "Sleep, activity, heart rate, workout topics. Establishes memory footprint.",
    messages: [
      { transcript: "How did I sleep last night?", agentId: "malibu" },
      {
        transcript: "What's my average sleep score been this week?",
        agentId: "malibu",
      },
      {
        transcript: "My resting heart rate felt high this morning, what does the data say?",
        agentId: "malibu",
      },
      {
        transcript: "How many steps have I gotten so far today?",
        agentId: "malibu",
      },
      {
        transcript: "I'm feeling kind of tired, should I work out today or rest?",
        agentId: "malibu",
      },
      {
        transcript: "What was my last workout? How heavy did I go?",
        agentId: "malibu",
      },
      {
        transcript: "Can you compare my workout volume this week versus last week?",
        agentId: "malibu",
      },
      {
        transcript: "I want to hit a new PR on bench press. What's my current max?",
        agentId: "malibu",
      },
      {
        transcript: "Let's plan my workout for tomorrow. I want to do push day.",
        agentId: "malibu",
      },
      {
        transcript: "Actually, let me do a quick stretch routine instead. What do you recommend?",
        agentId: "malibu",
      },
    ],
  },
  {
    id: "phase2-nutrition-pivot",
    name: "Phase 2: Nutrition Pivot",
    agentId: "malibu",
    description:
      "Food logging, macros, recipes, calorie tracking. Checks domain coherence.",
    messages: [
      {
        transcript: "Log breakfast: two eggs, toast with butter, and a glass of OJ",
        agentId: "malibu",
      },
      {
        transcript: "How many calories have I had so far today?",
        agentId: "malibu",
      },
      {
        transcript: "What's my protein intake looking like this week?",
        agentId: "malibu",
      },
      {
        transcript: "Log lunch: grilled chicken salad with avocado and ranch dressing",
        agentId: "malibu",
      },
      {
        transcript: "Am I on track to hit my macro targets today?",
        agentId: "malibu",
      },
      {
        transcript: "I need a high protein dinner recipe that's easy to make",
        agentId: "malibu",
      },
      {
        transcript: "Log snack: protein bar and a banana",
        agentId: "malibu",
      },
      {
        transcript: "What's my calorie trend been over the past week?",
        agentId: "malibu",
      },
      {
        transcript: "How much water should I be drinking given my activity level?",
        agentId: "malibu",
      },
      {
        transcript: "Log dinner: salmon, rice, and steamed broccoli",
        agentId: "malibu",
      },
    ],
  },
  {
    id: "phase3-edge-cases",
    name: "Phase 3: Edge Cases",
    agentId: "malibu",
    description:
      "Low-entropy, terse, and ambiguous messages. Checks filtering and graceful handling.",
    messages: [
      { transcript: "ok", agentId: "malibu" },
      { transcript: "yes", agentId: "malibu" },
      { transcript: "thanks", agentId: "malibu" },
      { transcript: "30x15 bench press", agentId: "malibu" },
      { transcript: "help me out here", agentId: "malibu" },
      { transcript: "never mind, forget it", agentId: "malibu" },
    ],
  },
  {
    id: "phase4-cross-agent",
    name: "Phase 4: Cross-Agent Switch (Watson)",
    agentId: "watson",
    description:
      "Calendar, email, budget, tasks. Checks agent-domain isolation.",
    messages: [
      { transcript: "What's on my calendar today?", agentId: "watson" },
      {
        transcript: "Do I have any meetings tomorrow morning?",
        agentId: "watson",
      },
      {
        transcript: "Remind me about the dentist appointment next Tuesday",
        agentId: "watson",
      },
      {
        transcript: "What's in my inbox that I haven't read yet?",
        agentId: "watson",
      },
      {
        transcript: "Help me draft a reply to the latest email from my manager",
        agentId: "watson",
      },
      {
        transcript: "How much did I spend on groceries this month?",
        agentId: "watson",
      },
      {
        transcript: "Add a task: finish the quarterly report by Friday",
        agentId: "watson",
      },
      {
        transcript: "What are my top priorities for this week?",
        agentId: "watson",
      },
    ],
  },
  {
    id: "phase5-return-recall",
    name: "Phase 5: Return & Recall",
    agentId: "malibu",
    description:
      "References Phase 1/2 topics. Checks session continuity and long-range recall.",
    messages: [
      {
        transcript: "Hey, remember when we talked about my sleep earlier? How was it?",
        agentId: "malibu",
      },
      {
        transcript: "What did I eat for lunch today? I already logged it.",
        agentId: "malibu",
      },
      {
        transcript: "Give me a summary of everything I've done today — workouts, food, health stats",
        agentId: "malibu",
      },
      {
        transcript: "How does my protein intake compare to my workout volume this week?",
        agentId: "malibu",
      },
      {
        transcript: "What trends should I be paying attention to?",
        agentId: "malibu",
      },
      {
        transcript: "Based on everything, what should I focus on tomorrow?",
        agentId: "malibu",
      },
      {
        transcript: "Am I making progress toward my fitness goals?",
        agentId: "malibu",
      },
      {
        transcript: "Let's wrap up. Anything I should know before bed?",
        agentId: "malibu",
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function now(): string {
  return new Date().toISOString();
}

function log(msg: string): void {
  console.log(`[${now()}] ${msg}`);
}

function truncate(s: string, max = 120): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "...";
}

// ---------------------------------------------------------------------------
// HTTP turn sender
// ---------------------------------------------------------------------------

async function sendTurn(
  sessionId: string,
  agentId: string,
  transcript: string
): Promise<TurnResult> {
  const channelId = resolveSmokeChannel(agentId);
  const payload: Record<string, string> = { sessionId, agentId, transcript };
  if (channelId) payload.channelId = channelId;
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (VOICE_API_KEY) {
    headers["X-Tango-Api-Key"] = VOICE_API_KEY;
  }
  const res = await fetch(VOICE_URL, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(300_000), // 5 min timeout per turn
  });
  return (await res.json()) as TurnResult;
}

// ---------------------------------------------------------------------------
// Seed memories for retrieval testing
// ---------------------------------------------------------------------------

interface SeedMemory {
  content: string;
  source: "conversation" | "reflection" | "obsidian" | "manual" | "backfill";
  importance: number;
  agentId: string | null;
  /** Domain tag for contamination testing */
  domain: "wellness" | "personal" | "noise";
}

const SEED_MEMORIES: SeedMemory[] = [
  // --- Wellness domain (should appear for Malibu, not Watson) ---
  { content: "User sleeps an average of 7.5 hours per night. Best nights are after rest days. HRV tends to dip below 45 on consecutive training days.", source: "reflection", importance: 0.85, agentId: "malibu", domain: "wellness" },
  { content: "User prefers push/pull/legs split, training 4 days per week. Current bench press working weight is 55lb dumbbells for 15 reps.", source: "conversation", importance: 0.80, agentId: "malibu", domain: "wellness" },
  { content: "User's protein target is 150g per day. Consistently falls short at lunch — averages only 25g protein at that meal.", source: "reflection", importance: 0.90, agentId: "malibu", domain: "wellness" },
  { content: "User tracks calories in FatSecret. Breakfast is usually a protein yogurt bowl (~437 cal, 54g protein). This is a recurring meal.", source: "conversation", importance: 0.75, agentId: "malibu", domain: "wellness" },
  { content: "User lost 50 pounds over the past year through consistent training and calorie tracking. Current weight is 175 lbs, goal is 165.", source: "conversation", importance: 0.95, agentId: "malibu", domain: "wellness" },
  { content: "User's resting heart rate has been trending down from 48 to 41 over the past month. This correlates with increased cardio.", source: "reflection", importance: 0.70, agentId: "malibu", domain: "wellness" },
  { content: "User drinks protein shakes post-workout. Preferred brand is Optimum Nutrition Gold Standard whey, chocolate flavor.", source: "conversation", importance: 0.60, agentId: "malibu", domain: "wellness" },
  { content: "User has a recurring dinner recipe: chicken tacos with La Abuela flour tortillas, about 217 cal and 21g protein per taco.", source: "backfill", importance: 0.70, agentId: "malibu", domain: "wellness" },
  { content: "User's body is the outward symbol of who they are as a person — discipline, hard work, self-control. This is their core 'why' for fitness.", source: "conversation", importance: 0.95, agentId: "malibu", domain: "wellness" },
  { content: "User tends to snack on light yogurt with cocoa and cacao nibs as an afternoon snack. About 236 cal and 27g protein.", source: "conversation", importance: 0.65, agentId: "malibu", domain: "wellness" },
  { content: "Sleep quality degrades when user has screen time within 30 minutes of bed. This pattern appeared in 3 of the last 5 poor sleep nights.", source: "reflection", importance: 0.80, agentId: "malibu", domain: "wellness" },
  { content: "User's weekly workout volume averaged 39,000 lbs last week. Current week is tracking lower at 5,360 lbs through Monday.", source: "backfill", importance: 0.65, agentId: "malibu", domain: "wellness" },

  // --- Personal domain (should appear for Watson, not Malibu) ---
  { content: "User has a weekly Monday standup with the engineering team at 9:30 AM. Usually runs 30 minutes.", source: "conversation", importance: 0.70, agentId: "watson", domain: "personal" },
  { content: "User's manager is Nick. They communicate primarily via email at the latitude.io domain.", source: "conversation", importance: 0.80, agentId: "watson", domain: "personal" },
  { content: "User tracks finances through Lunch Money. Monthly grocery budget target is around $600.", source: "reflection", importance: 0.75, agentId: "watson", domain: "personal" },
  { content: "User has an orthodontist appointment at Paventy and Brown in Newport, recurring every 6-8 weeks.", source: "conversation", importance: 0.65, agentId: "watson", domain: "personal" },
  { content: "User prefers to batch email replies on Monday and Thursday mornings. Does not want to be interrupted for non-urgent email.", source: "reflection", importance: 0.85, agentId: "watson", domain: "personal" },
  { content: "User is working on a quarterly report due by end of week. This is a high priority deliverable.", source: "conversation", importance: 0.90, agentId: "watson", domain: "personal" },
  { content: "User's son has soccer practice on Tuesday and Thursday afternoons. Calendar blocks exist for pickup.", source: "conversation", importance: 0.70, agentId: "watson", domain: "personal" },
  { content: "User subscribes to 12 email newsletters. Wants a weekly digest summary rather than individual notifications.", source: "reflection", importance: 0.60, agentId: "watson", domain: "personal" },

  // --- Noise / off-topic (should NOT surface for either agent) ---
  { content: "Obsidian vault contains 847 notes. Last synced 2026-03-15. Tags include #planning, #health, #projects, #recipes.", source: "obsidian", importance: 0.30, agentId: null, domain: "noise" },
  { content: "System maintenance note: FatSecret API experienced 503 errors on 2026-03-20. Resolved after 4 hours.", source: "manual", importance: 0.20, agentId: null, domain: "noise" },
  { content: "Reflection cycle ran at 2026-03-25T12:30:00Z. Processed 42 memories, archived 8, created 3 new reflections.", source: "reflection", importance: 0.25, agentId: null, domain: "noise" },
  { content: "User asked about the weather in Portland last Tuesday. Temperature was 52F with light rain.", source: "conversation", importance: 0.15, agentId: "watson", domain: "noise" },

  // --- Cross-domain traps (wellness content tagged to watson, and vice versa) ---
  { content: "User mentioned wanting to try a new Thai restaurant downtown. No dietary restrictions noted.", source: "conversation", importance: 0.40, agentId: "watson", domain: "noise" },
  { content: "User's morning walk is both a fitness activity and a calendar event. Logged as exercise in health and as a 7:45 AM block in calendar.", source: "backfill", importance: 0.55, agentId: null, domain: "noise" },
];

function seedEvalMemories(db: DatabaseSync, sessionId: string): number {
  // Check if we already seeded this session
  const existing = db.prepare(
    `SELECT COUNT(*) as cnt FROM memories WHERE source_ref LIKE ?`
  ).get(`eval-seed:${sessionId}%`) as { cnt: number };

  if (existing.cnt > 0) {
    log(`Seed memories already exist for ${sessionId} (${existing.cnt} found), skipping`);
    return existing.cnt;
  }

  // Ensure the eval session exists (FK constraint on memories.session_id)
  db.prepare(
    `INSERT OR IGNORE INTO sessions (id, session_type, default_agent_id) VALUES (?, 'ephemeral', 'malibu')`
  ).run(sessionId);

  let inserted = 0;
  const createdAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(); // 1 week ago

  for (const [index, seed] of SEED_MEMORIES.entries()) {
    const sourceRef = `eval-seed:${sessionId}:${index}`;
    db.prepare(
      `INSERT INTO memories (session_id, agent_id, source, content, importance, source_ref, created_at, last_accessed_at, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      sessionId,
      seed.agentId,
      seed.source,
      seed.content,
      seed.importance,
      sourceRef,
      createdAt,
      createdAt,
      JSON.stringify({ evalSeed: true, domain: seed.domain, seedIndex: index }),
    );
    inserted++;
  }

  log(`Seeded ${inserted} eval memories for session ${sessionId}`);
  return inserted;
}

function cleanupEvalMemories(db: DatabaseSync, sessionId: string): number {
  const result = db.prepare(
    `DELETE FROM memories WHERE source_ref LIKE ?`
  ).run(`eval-seed:${sessionId}%`);
  return (result as { changes: number }).changes;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function openDb(): DatabaseSync {
  return new DatabaseSync(DB_PATH, { open: true });
}

function queryMemoriesCreatedSince(
  db: DatabaseSync,
  since: string
): MemoryRecord[] {
  const stmt = db.prepare(
    `SELECT id, session_id, agent_id, source, content, importance, created_at
     FROM memories
     WHERE created_at > ?
     ORDER BY created_at`
  );
  return stmt.all(since) as MemoryRecord[];
}

function queryPromptSnapshot(
  db: DatabaseSync,
  sessionId: string,
  limit = 1
): Array<{
  id: number;
  session_id: string;
  agent_id: string;
  warm_start_prompt: string | null;
  metadata_json: string | null;
  created_at: string;
}> {
  const stmt = db.prepare(
    `SELECT id, session_id, agent_id, warm_start_prompt, metadata_json, created_at
     FROM prompt_snapshots
     WHERE session_id = ?
     ORDER BY id DESC
     LIMIT ?`
  );
  return stmt.all(sessionId, limit) as Array<{
    id: number;
    session_id: string;
    agent_id: string;
    warm_start_prompt: string | null;
    metadata_json: string | null;
    created_at: string;
  }>;
}

function querySessionSummaries(
  db: DatabaseSync,
  sessionId: string
): Array<{
  id: number;
  session_id: string;
  agent_id: string;
  summary_text: string;
  token_count: number;
  created_at: string;
}> {
  const stmt = db.prepare(
    `SELECT id, session_id, agent_id, summary_text, token_count, created_at
     FROM session_summaries
     WHERE session_id = ?
     ORDER BY id DESC`
  );
  return stmt.all(sessionId) as Array<{
    id: number;
    session_id: string;
    agent_id: string;
    summary_text: string;
    token_count: number;
    created_at: string;
  }>;
}

function queryLatestModelRun(
  db: DatabaseSync,
  sessionId: string
): {
  id: number;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  is_error: number;
  error_message: string | null;
  created_at: string;
} | null {
  const stmt = db.prepare(
    `SELECT id, latency_ms, input_tokens, output_tokens, is_error, error_message, created_at
     FROM model_runs
     WHERE session_id = ?
     ORDER BY id DESC
     LIMIT 1`
  );
  const rows = stmt.all(sessionId) as Array<{
    id: number;
    latency_ms: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    is_error: number;
    error_message: string | null;
    created_at: string;
  }>;
  return rows[0] ?? null;
}

function countTotalMemories(db: DatabaseSync): number {
  const stmt = db.prepare(`SELECT COUNT(*) as cnt FROM memories`);
  const row = stmt.get() as { cnt: number };
  return row.cnt;
}

// ---------------------------------------------------------------------------
// Analysis functions
// ---------------------------------------------------------------------------

function extractTraceMemories(metadataJson: string | null): TraceMemory[] {
  if (!metadataJson) return [];
  try {
    const meta = JSON.parse(metadataJson);
    // Trace can live in multiple places depending on the snapshot type
    const trace =
      meta?.warmStartContext?.memoryPrompt?.trace ??
      meta?.trace ??
      meta?.warmStartTrace ??
      meta;
    const memories = trace?.memories;
    if (!Array.isArray(memories)) return [];
    return memories.map((m: Record<string, unknown>) => ({
      id: (m.id as number) ?? 0,
      source: (m.source as string) ?? "unknown",
      content: (m.content as string) ?? "",
      importance: (m.importance as number) ?? 0,
      score: (m.score as number) ?? 0,
      relevanceScore: (m.relevanceScore as number) ?? 0,
      keywordScore: (m.keywordScore as number) ?? 0,
      semanticScore: (m.semanticScore as number) ?? 0,
      recencyScore: (m.recencyScore as number) ?? 0,
      sourceBonus: (m.sourceBonus as number) ?? 0,
      qualityPenalty: (m.qualityPenalty as number) ?? 0,
    }));
  } catch {
    return [];
  }
}

function computeScoreSpread(memories: TraceMemory[]): number {
  if (memories.length < 2) return 0;
  const scores = memories.map((m) => m.score);
  return Math.max(...scores) - Math.min(...scores);
}

const WELLNESS_KEYWORDS = [
  "sleep", "workout", "exercise", "heart", "steps", "calories",
  "protein", "food", "meal", "nutrition", "macro", "weight",
  "bench", "squat", "deadlift", "run", "cardio", "rest",
  "recovery", "health", "fitness", "vitamin", "water",
];

const PERSONAL_KEYWORDS = [
  "calendar", "email", "meeting", "task", "budget", "schedule",
  "inbox", "appointment", "reminder", "priority", "spend",
  "report", "draft", "reply", "agenda",
];

function detectDomainContamination(
  memories: TraceMemory[],
  currentPhaseId: string
): ContaminationFlag[] {
  const flags: ContaminationFlag[] = [];
  const isWellnessPhase =
    currentPhaseId.includes("wellness") ||
    currentPhaseId.includes("nutrition") ||
    currentPhaseId.includes("edge") ||
    currentPhaseId.includes("recall");
  const isPersonalPhase = currentPhaseId.includes("cross-agent");

  for (const mem of memories) {
    const lc = mem.content.toLowerCase();
    if (isPersonalPhase) {
      // In Watson phase, flag wellness memories
      const wellnessMatch = WELLNESS_KEYWORDS.some((kw) => lc.includes(kw));
      if (wellnessMatch) {
        flags.push({
          memoryId: mem.id,
          memorySource: mem.source,
          memoryContent: truncate(mem.content, 80),
          expectedDomain: "personal",
          reason: "Wellness memory surfaced in Watson/personal context",
        });
      }
    }
    if (isWellnessPhase) {
      // In Malibu phases, flag personal/scheduling memories
      const personalMatch = PERSONAL_KEYWORDS.some((kw) => lc.includes(kw));
      if (personalMatch && !WELLNESS_KEYWORDS.some((kw) => lc.includes(kw))) {
        flags.push({
          memoryId: mem.id,
          memorySource: mem.source,
          memoryContent: truncate(mem.content, 80),
          expectedDomain: "wellness",
          reason: "Personal/scheduling memory surfaced in Malibu/wellness context",
        });
      }
    }
  }
  return flags;
}

function countObsidianLeaks(memories: TraceMemory[]): number {
  return memories.filter((m) => m.source === "obsidian").length;
}

function analyzeTurn(
  turnIndex: number,
  phaseId: string,
  msg: PhaseMessage,
  turnResult: TurnResult,
  db: DatabaseSync,
  checkpointTime: string,
  totalTurnsSoFar: number
): TurnAnalysis {
  const issues: string[] = [];
  const wins: string[] = [];

  // Find the prompt snapshot for this session
  const snapshots = queryPromptSnapshot(db, SESSION_ID, 1);
  const snap = snapshots[0] ?? null;

  // Extract trace memories
  const traceMemories = snap
    ? extractTraceMemories(snap.metadata_json)
    : [];

  // Score spread
  const scoreSpread = computeScoreSpread(traceMemories);
  if (traceMemories.length >= 3 && scoreSpread < 0.05) {
    issues.push(
      `Tight score clustering: spread=${scoreSpread.toFixed(4)} across ${traceMemories.length} memories`
    );
  } else if (traceMemories.length >= 3 && scoreSpread > 0.3) {
    wins.push(`Good score spread: ${scoreSpread.toFixed(4)}`);
  }

  // Domain contamination
  const contamination = detectDomainContamination(traceMemories, phaseId);
  if (contamination.length > 0) {
    issues.push(
      `Cross-domain contamination: ${contamination.length} off-topic memories surfaced`
    );
  } else if (traceMemories.length > 0) {
    wins.push("No cross-domain contamination in retrieved memories");
  }

  // Obsidian leaks
  const obsidianLeaks = countObsidianLeaks(traceMemories);
  if (obsidianLeaks > 0) {
    issues.push(
      `Obsidian leaks: ${obsidianLeaks} obsidian-source memories in retrieval`
    );
  }

  // New memories since checkpoint
  const newMems = queryMemoriesCreatedSince(db, checkpointTime);
  if (newMems.length > 0) {
    wins.push(`${newMems.length} new memories created this turn`);
  }

  // Summaries
  const summaries = querySessionSummaries(db, SESSION_ID);
  const summariesExist = summaries.length > 0;
  if (totalTurnsSoFar >= 12 && !summariesExist) {
    issues.push(
      `No session summaries after ${totalTurnsSoFar} turns — expected at least one`
    );
  } else if (summariesExist) {
    wins.push(`${summaries.length} session summaries exist`);
  }

  // Model run latency
  const modelRun = queryLatestModelRun(db, SESSION_ID);
  const latencyMs = modelRun?.latency_ms ?? null;
  if (latencyMs !== null && latencyMs > 30_000) {
    issues.push(`High latency: ${latencyMs}ms`);
  }
  if (modelRun?.is_error) {
    issues.push(`Model run error: ${modelRun.error_message ?? "unknown"}`);
  }

  // Low-entropy check
  const lowEntropy = msg.transcript.length < 10;
  if (lowEntropy && traceMemories.length > 0) {
    issues.push(
      `Low-entropy message ("${msg.transcript}") still triggered memory retrieval (${traceMemories.length} memories)`
    );
  } else if (lowEntropy && traceMemories.length === 0) {
    wins.push(
      `Low-entropy filtering working: no memories retrieved for "${msg.transcript}"`
    );
  }

  return {
    turnIndex,
    transcript: msg.transcript,
    agentId: msg.agentId,
    responseText: turnResult.responseText ?? "",
    timestamp: now(),
    warmStartUsed: turnResult.warmStartUsed ?? false,
    providerName: turnResult.providerName ?? "unknown",
    retrievedMemories: traceMemories,
    scoreSpread,
    contamination,
    obsidianLeaks,
    newMemoriesCreated: newMems,
    summariesExist,
    summaryCount: summaries.length,
    latencyMs,
    issues,
    wins,
  };
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function formatTurnAnalysis(a: TurnAnalysis): string {
  const lines: string[] = [];
  lines.push(`### Turn ${a.turnIndex + 1}: \`${truncate(a.transcript, 80)}\``);
  lines.push(`- Agent: ${a.agentId}`);
  lines.push(`- Timestamp: ${a.timestamp}`);
  lines.push(`- Provider: ${a.providerName}`);
  lines.push(`- Warm start: ${a.warmStartUsed ? "yes" : "no"}`);
  lines.push(`- Response: ${truncate(a.responseText, 200)}`);
  lines.push(
    `- Retrieved memories: ${a.retrievedMemories.length} (score spread: ${a.scoreSpread.toFixed(4)})`
  );
  if (a.latencyMs !== null) {
    lines.push(`- Latency: ${a.latencyMs}ms`);
  }
  lines.push(
    `- New memories created: ${a.newMemoriesCreated.length}`
  );
  lines.push(`- Session summaries: ${a.summaryCount}`);

  if (a.retrievedMemories.length > 0) {
    lines.push(`- Top memories:`);
    for (const m of a.retrievedMemories.slice(0, 5)) {
      lines.push(
        `  - [${m.source}] score=${m.score.toFixed(3)} importance=${m.importance.toFixed(2)}: ${truncate(m.content, 100)}`
      );
    }
  }

  if (a.contamination.length > 0) {
    lines.push(`- **Contamination flags:**`);
    for (const c of a.contamination) {
      lines.push(`  - mem#${c.memoryId} [${c.memorySource}]: ${c.reason}`);
    }
  }

  for (const issue of a.issues) {
    lines.push(`  - **issue**: ${issue}`);
  }
  for (const win of a.wins) {
    lines.push(`  - win: ${win}`);
  }

  return lines.join("\n");
}

function formatPhaseReport(pr: PhaseReport): string {
  const lines: string[] = [];
  lines.push(`## ${pr.phaseName}`);
  lines.push(`- Agent: ${pr.agentId}`);
  lines.push(`- Turns: ${pr.turnAnalyses.length}`);
  lines.push(`- New memories created: ${pr.totalMemoriesCreated}`);
  lines.push(`- Issues: ${pr.totalIssues}`);
  lines.push(`- Wins: ${pr.totalWins}`);
  lines.push(`- Summary formed: ${pr.summaryFormed ? "yes" : "no"}`);
  lines.push("");
  for (const ta of pr.turnAnalyses) {
    lines.push(formatTurnAnalysis(ta));
    lines.push("");
  }
  return lines.join("\n");
}

function writeCheckpointReport(
  phaseIndex: number,
  phaseReports: PhaseReport[],
  db: DatabaseSync
): void {
  const totalMems = countTotalMemories(db);
  const lines: string[] = [];
  lines.push(`# Overnight Memory Eval — Checkpoint ${phaseIndex + 1}`);
  lines.push("");
  lines.push(`- Generated: ${now()}`);
  lines.push(`- Session: ${SESSION_ID}`);
  lines.push(`- Phases completed: ${phaseReports.length}`);
  lines.push(`- Total memories in DB: ${totalMems}`);
  lines.push("");

  for (const pr of phaseReports) {
    lines.push(formatPhaseReport(pr));
    lines.push("");
  }

  const outPath = path.join(
    REPORTS_DIR,
    `overnight-memory-eval-${DATE_TAG}-checkpoint-${phaseIndex + 1}.md`
  );
  mkdirSync(REPORTS_DIR, { recursive: true });
  writeFileSync(outPath, lines.join("\n"), "utf-8");
  log(`Checkpoint report written: ${outPath}`);
}

function writeFinalReport(
  phaseReports: PhaseReport[],
  observationSnapshots: string[],
  db: DatabaseSync
): void {
  const totalMems = countTotalMemories(db);
  const allIssues = phaseReports.flatMap((pr) =>
    pr.turnAnalyses.flatMap((ta) => ta.issues)
  );
  const allWins = phaseReports.flatMap((pr) =>
    pr.turnAnalyses.flatMap((ta) => ta.wins)
  );
  const allContaminations = phaseReports.flatMap((pr) =>
    pr.turnAnalyses.flatMap((ta) => ta.contamination)
  );
  const allScoresSpreads = phaseReports.flatMap((pr) =>
    pr.turnAnalyses
      .filter((ta) => ta.retrievedMemories.length >= 2)
      .map((ta) => ta.scoreSpread)
  );
  const avgSpread =
    allScoresSpreads.length > 0
      ? allScoresSpreads.reduce((a, b) => a + b, 0) / allScoresSpreads.length
      : 0;

  const totalTurns = phaseReports.reduce(
    (acc, pr) => acc + pr.turnAnalyses.length,
    0
  );

  const lines: string[] = [];
  lines.push(`# Overnight Memory System Evaluation Report`);
  lines.push("");
  lines.push(`- Generated: ${now()}`);
  lines.push(`- Session: ${SESSION_ID}`);
  lines.push(`- Total phases: ${phaseReports.length}`);
  lines.push(`- Total turns: ${totalTurns}`);
  lines.push(`- Total memories in DB: ${totalMems}`);
  lines.push("");

  // Executive summary
  lines.push(`## Executive Summary`);
  lines.push("");
  lines.push(`- **Issues found:** ${allIssues.length}`);
  lines.push(`- **Wins:** ${allWins.length}`);
  lines.push(
    `- **Cross-domain contaminations:** ${allContaminations.length}`
  );
  lines.push(`- **Average score spread:** ${avgSpread.toFixed(4)}`);
  lines.push(
    `- **Obsidian leaks:** ${phaseReports.reduce((acc, pr) => acc + pr.turnAnalyses.reduce((a2, ta) => a2 + ta.obsidianLeaks, 0), 0)}`
  );
  lines.push("");

  // Phase-by-phase
  for (const pr of phaseReports) {
    lines.push(formatPhaseReport(pr));
    lines.push("---");
    lines.push("");
  }

  // Score distribution
  lines.push(`## Score Distribution Analysis`);
  lines.push("");
  if (allScoresSpreads.length > 0) {
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Turns with scored memories | ${allScoresSpreads.length} |`);
    lines.push(`| Average spread | ${avgSpread.toFixed(4)} |`);
    lines.push(
      `| Min spread | ${Math.min(...allScoresSpreads).toFixed(4)} |`
    );
    lines.push(
      `| Max spread | ${Math.max(...allScoresSpreads).toFixed(4)} |`
    );
    lines.push(
      `| Tight clusters (<0.05) | ${allScoresSpreads.filter((s) => s < 0.05).length} |`
    );
  } else {
    lines.push("No scored memory retrievals observed.");
  }
  lines.push("");

  // Cross-domain contamination log
  lines.push(`## Cross-Domain Contamination Log`);
  lines.push("");
  if (allContaminations.length > 0) {
    for (const c of allContaminations) {
      lines.push(
        `- mem#${c.memoryId} [${c.memorySource}] expected=${c.expectedDomain}: ${c.reason}`
      );
      lines.push(`  content: ${c.memoryContent}`);
    }
  } else {
    lines.push("No cross-domain contamination detected.");
  }
  lines.push("");

  // Observation phase
  if (observationSnapshots.length > 0) {
    lines.push(`## Phase 6: Extended Observation`);
    lines.push("");
    for (const snap of observationSnapshots) {
      lines.push(snap);
    }
    lines.push("");
  }

  // All issues
  lines.push(`## All Issues`);
  lines.push("");
  if (allIssues.length > 0) {
    for (const issue of allIssues) {
      lines.push(`- ${issue}`);
    }
  } else {
    lines.push("No issues found.");
  }
  lines.push("");

  // All wins
  lines.push(`## All Wins`);
  lines.push("");
  if (allWins.length > 0) {
    for (const win of allWins) {
      lines.push(`- ${win}`);
    }
  } else {
    lines.push("No wins recorded.");
  }
  lines.push("");

  const outPath = path.join(
    REPORTS_DIR,
    `overnight-memory-eval-${DATE_TAG}.md`
  );
  mkdirSync(REPORTS_DIR, { recursive: true });
  writeFileSync(outPath, lines.join("\n"), "utf-8");
  log(`Final report written: ${outPath}`);
}

// ---------------------------------------------------------------------------
// Observation phase: monitor DB without sending messages
// ---------------------------------------------------------------------------

async function runObservationPhase(
  db: DatabaseSync,
  startMemoryCount: number
): Promise<string[]> {
  log("Phase 6: Extended Observation — monitoring for async processes");
  const snapshots: string[] = [];
  const startTime = Date.now();
  let pollIndex = 0;

  while (Date.now() - startTime < OBSERVATION_DURATION_MS) {
    await sleep(OBSERVATION_POLL_MS);
    pollIndex++;

    const currentMemCount = countTotalMemories(db);
    const memDelta = currentMemCount - startMemoryCount;
    const summaries = querySessionSummaries(db, SESSION_ID);

    const snap = [
      `### Observation snapshot ${pollIndex} (${now()})`,
      `- Total memories: ${currentMemCount} (delta: ${memDelta > 0 ? "+" : ""}${memDelta})`,
      `- Session summaries: ${summaries.length}`,
    ].join("\n");

    snapshots.push(snap);
    log(
      `Observation ${pollIndex}: mems=${currentMemCount} delta=${memDelta} summaries=${summaries.length}`
    );
  }

  return snapshots;
}

// ---------------------------------------------------------------------------
// Main execution
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log(`=== Overnight Memory Eval Starting ===`);
  log(`Session: ${SESSION_ID}`);
  log(`Voice endpoint: ${VOICE_URL}`);
  log(`Database: ${DB_PATH}`);
  log(`Reports: ${REPORTS_DIR}`);
  log("");

  const db = openDb();

  // Pre-seed memories so retrieval has something to work with
  seedEvalMemories(db, SESSION_ID);

  const phaseReports: PhaseReport[] = [];
  let totalTurnsSoFar = 0;

  if (SKIP_PHASES > 0) {
    log(`Skipping first ${SKIP_PHASES} phases (resume mode)`);
    totalTurnsSoFar = PHASES.slice(0, SKIP_PHASES).reduce((sum, p) => sum + p.messages.length, 0);
  }

  for (let pi = SKIP_PHASES; pi < PHASES.length; pi++) {
    const phase = PHASES[pi];
    log(`\n--- ${phase.name} (${phase.messages.length} messages) ---`);
    log(`Description: ${phase.description}`);

    const turnAnalyses: TurnAnalysis[] = [];
    let phaseMemsCreated = 0;

    for (let mi = 0; mi < phase.messages.length; mi++) {
      const msg = phase.messages[mi];
      const checkpointTime = now();

      log(
        `Turn ${totalTurnsSoFar + 1} [${phase.id}/${mi + 1}]: "${truncate(msg.transcript, 60)}"`
      );

      // Send the turn
      let turnResult: TurnResult;
      try {
        turnResult = await sendTurn(SESSION_ID, msg.agentId, msg.transcript);
      } catch (err) {
        log(`ERROR sending turn: ${err}`);
        turnResult = {
          ok: false,
          error: "network-error",
          message: String(err),
        };
      }

      if (!turnResult.ok) {
        log(
          `Turn FAILED: ${turnResult.error} — ${turnResult.message ?? ""}`
        );
        turnAnalyses.push({
          turnIndex: totalTurnsSoFar,
          transcript: msg.transcript,
          agentId: msg.agentId,
          responseText: `ERROR: ${turnResult.error} — ${turnResult.message ?? ""}`,
          timestamp: now(),
          warmStartUsed: false,
          providerName: "none",
          retrievedMemories: [],
          scoreSpread: 0,
          contamination: [],
          obsidianLeaks: 0,
          newMemoriesCreated: [],
          summariesExist: false,
          summaryCount: 0,
          latencyMs: null,
          issues: [
            `Turn failed: ${turnResult.error} — ${turnResult.message ?? ""}`,
          ],
          wins: [],
        });
        totalTurnsSoFar++;
        // Still wait between turns even on failure to avoid hammering a recovering server
        if (mi < phase.messages.length - 1) {
          log(`  Waiting ${INTER_MESSAGE_GAP_MS / 1000}s before next turn (after failure)...`);
          await sleep(INTER_MESSAGE_GAP_MS);
        }
        continue;
      }

      log(
        `Response (${turnResult.providerName}): ${truncate(turnResult.responseText ?? "", 100)}`
      );

      // Wait a beat for async DB writes to settle
      await sleep(2000);

      // Analyze the turn
      const analysis = analyzeTurn(
        totalTurnsSoFar,
        phase.id,
        msg,
        turnResult,
        db,
        checkpointTime,
        totalTurnsSoFar + 1
      );
      turnAnalyses.push(analysis);
      phaseMemsCreated += analysis.newMemoriesCreated.length;
      totalTurnsSoFar++;

      log(
        `  Issues: ${analysis.issues.length}, Wins: ${analysis.wins.length}, Memories retrieved: ${analysis.retrievedMemories.length}`
      );

      // Wait between messages (skip wait after last message of phase)
      if (mi < phase.messages.length - 1) {
        log(`  Waiting ${INTER_MESSAGE_GAP_MS / 1000}s before next turn...`);
        await sleep(INTER_MESSAGE_GAP_MS);
      }
    }

    const phaseReport: PhaseReport = {
      phaseId: phase.id,
      phaseName: phase.name,
      agentId: phase.agentId,
      turnAnalyses,
      totalMemoriesCreated: phaseMemsCreated,
      totalIssues: turnAnalyses.reduce(
        (acc, ta) => acc + ta.issues.length,
        0
      ),
      totalWins: turnAnalyses.reduce(
        (acc, ta) => acc + ta.wins.length,
        0
      ),
      summaryFormed: turnAnalyses.some((ta) => ta.summariesExist),
    };
    phaseReports.push(phaseReport);

    // Write checkpoint
    writeCheckpointReport(pi, phaseReports, db);
  }

  // Phase 6: Extended Observation
  const startMemCount = countTotalMemories(db);
  const observationSnapshots = await runObservationPhase(db, startMemCount);

  // Final report
  writeFinalReport(phaseReports, observationSnapshots, db);

  // Clean up seed memories
  const cleaned = cleanupEvalMemories(db, SESSION_ID);
  log(`Cleaned up ${cleaned} seed memories`);

  db.close();
  log(`\n=== Overnight Memory Eval Complete ===`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
