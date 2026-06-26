/**
 * Live validation for the Puerto Escondido amnesia fixes (TGO-688/689/690):
 * replays the failure shape against a stateless (Ollama-backed) test agent in
 * a real Discord thread and checks
 *   1. a fact stated in turn 1 survives to turn 3 (warm-start thread surface),
 *   2. natural prose starting with "On the return ..." does NOT spawn a junk
 *      topic or fork the session (inline-topic guard).
 *
 * Usage (from the repo root so .env loads):
 *   node --import tsx scripts/validate-thread-continuity.ts [--agent ollama-test]
 *
 * Posts only to the agent's own test channel — never the -ollama dogfood
 * channels.
 */
import dotenv from "dotenv";
import { resolveDatabasePath, TangoStorage } from "@tango/core";
import {
  closeHarnessContext,
  createHarnessContext,
  resolveExplicitHarnessTarget,
  runHarnessTurn,
} from "../apps/tango-voice/src/testing/discord-test-harness-lib.js";
import { ensureSmokeThread } from "../apps/tango-voice/src/testing/discord-smoke-thread.js";

dotenv.config();

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? String(process.argv[index + 1]) : fallback;
}

const AGENT_ID = flag("agent", "ollama-test");
// Placeholder default; pass --channel <id> (or set TANGO_VALIDATION_CHANNEL_ID)
// with a real channel id for a live run. Real ids live in the profile, not the repo.
const CHANNEL_ID = flag(
  "channel",
  process.env.TANGO_VALIDATION_CHANNEL_ID?.trim() || "100000000000000017",
);
const THREAD_NAME = flag("thread-name", "memory-continuity-validation");
const TURN_TIMEOUT_MS = 180_000;

async function main(): Promise<void> {
  const token = process.env.DISCORD_TOKEN?.trim();
  if (!token) throw new Error("DISCORD_TOKEN not set");

  const threadId = await ensureSmokeThread({
    token,
    agentId: AGENT_ID,
    explicitChannelId: null,
    explicitThreadName: THREAD_NAME,
  }).catch(() => null);

  const context = await createHarnessContext();
  const failures: string[] = [];
  try {
    const target = await resolveExplicitHarnessTarget(
      context.client,
      threadId && threadId !== CHANNEL_ID ? threadId : await createThread(context, CHANNEL_ID),
    );
    console.log(`[validate] target=${target.channelId} kind=${target.kind} parent=${target.parentChannelId}`);
    if (target.kind !== "thread") {
      throw new Error("Validation requires a thread target (the bug was thread-specific).");
    }

    const turn1 = await runHarnessTurn({
      context,
      target,
      content:
        "Quick note for my Puerto Escondido trip research: the offshore fishing charter runs $950 for a full day, and the inshore charter is $450 for a half day. Just acknowledge briefly — no analysis needed.",
      waitForResponse: true,
      timeoutMs: TURN_TIMEOUT_MS,
    });
    console.log(`[validate] turn1 response=${turn1.receivedResponse} session=${turn1.responseSessionId}`);
    if (!turn1.receivedResponse) failures.push("turn1: no response");

    const turn2 = await runHarnessTurn({
      context,
      target,
      content:
        "On the return there are a couple of ways to think about this: coming home June 30th, or July 1st with a hotel night near the airport. No need to decide — just confirm you noted both options.",
      waitForResponse: true,
      timeoutMs: TURN_TIMEOUT_MS,
    });
    console.log(`[validate] turn2 response=${turn2.receivedResponse} session=${turn2.responseSessionId}`);
    if (!turn2.receivedResponse) failures.push("turn2: no response");

    const turn3 = await runHarnessTurn({
      context,
      target,
      content:
        "By the way, $950 for a single charter feels pretty expensive. Remind me — which charter was that price for, and what was the cheaper option?",
      waitForResponse: true,
      timeoutMs: TURN_TIMEOUT_MS,
    });
    console.log(`[validate] turn3 response=${turn3.receivedResponse} session=${turn3.responseSessionId}`);
    if (!turn3.receivedResponse) failures.push("turn3: no response");

    const turn3Text = (turn3.responseText ?? "").toLowerCase();
    const recalls = /offshore/.test(turn3Text) && /(450|inshore)/.test(turn3Text);
    const amnesia = /don't have context|what .*(charter|fishing|trip).* (are|was)|which fishing trip/.test(turn3Text);
    if (!recalls) failures.push(`turn3: did not recall offshore/$450 facts — got: ${turn3.responseText?.slice(0, 240)}`);
    if (amnesia) failures.push(`turn3: amnesia phrasing detected — got: ${turn3.responseText?.slice(0, 240)}`);

    // Same session across all three turns (no topic fork), and no junk topic row.
    const sessions = new Set(
      [turn1, turn2, turn3].map((turn) => turn.responseSessionId).filter(Boolean),
    );
    if (sessions.size > 1) failures.push(`session forked across turns: ${[...sessions].join(", ")}`);

    const storage = new TangoStorage(resolveDatabasePath());
    try {
      const junk = storage
        .getDatabase()
        .prepare(
          `SELECT slug FROM topics WHERE slug LIKE 'the-return%' AND created_at > datetime('now','-1 hour')`,
        )
        .all() as Array<{ slug: string }>;
      if (junk.length > 0) failures.push(`junk topic created: ${junk.map((row) => row.slug).join(", ")}`);
    } finally {
      storage.close();
    }

    console.log(
      failures.length === 0
        ? "[validate] PASS — fact recalled across turns, no junk topic, single session"
        : `[validate] FAIL —\n  - ${failures.join("\n  - ")}`,
    );
    process.exitCode = failures.length === 0 ? 0 : 1;
  } finally {
    await closeHarnessContext(context);
  }
}

async function createThread(context: Awaited<ReturnType<typeof createHarnessContext>>, channelId: string): Promise<string> {
  const channel = await context.client.channels.fetch(channelId);
  if (!channel || !("threads" in (channel as object))) {
    throw new Error(`Channel ${channelId} cannot create threads`);
  }
  const parent = channel as unknown as {
    threads: {
      fetchActive(): Promise<{ threads: Map<string, { name: string; id: string }> }>;
      create(options: { name: string; autoArchiveDuration: number }): Promise<{ id: string }>;
    };
  };
  const active = await parent.threads.fetchActive();
  for (const thread of active.threads.values()) {
    if (thread.name === THREAD_NAME) return thread.id;
  }
  const created = await parent.threads.create({ name: THREAD_NAME, autoArchiveDuration: 60 });
  return created.id;
}

main().catch((error) => {
  console.error("[validate] failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
