import { parseProjectSessionId, type VoiceTurnInput } from "@tango/voice";
import type { DiscordTurnExecutionContext } from "./turn-executor.js";
import type { WorkerReport } from "./worker-report.js";
import type { AgentWorkerOptions } from "./agent-worker-bridge.js";

export interface WellnessDispatcherOptions {
  /** Agent worker configuration (required — all workers are agent-powered) */
  agentWorkerOptions?: AgentWorkerOptions;
}

/**
 * Wellness dispatcher — orchestrator-directed only.
 *
 * Pre-dispatch is disabled. All worker execution goes through orchestrator-directed
 * dispatch (`<worker-dispatch>` tags in the orchestrator's response). The orchestrator
 * has full conversation history via `--resume` and formulates explicit task instructions
 * for workers.
 *
 * Pre-dispatch caused problems: stateless workers running writes without context
 * (e.g., starting duplicate workout sessions because they didn't know one existed).
 * The orchestrator-directed path is safer and produces better results.
 *
 * This dispatcher returns null for all wellness turns, telling the turn executor
 * to call the orchestrator first. The orchestrator outputs `<worker-dispatch>` tags
 * when it needs a worker, and `executeWorkerWithTask` in main.ts handles them.
 */
export function createWellnessDispatcher(
  _options: WellnessDispatcherOptions = {},
): ((turn: VoiceTurnInput, context: DiscordTurnExecutionContext) => Promise<WorkerReport | null>) | null {
  return async (turn, _context) => {
    if (!isWellnessTurn(turn)) return null;

    console.log(`[wellness-dispatcher] orchestrator-directed mode — transcript=${JSON.stringify(turn.transcript.slice(0, 120))}`);
    return null;
  };
}

function isWellnessTurn(turn: VoiceTurnInput): boolean {
  return (
    turn.agentId.trim().toLowerCase() === "malibu" ||
    parseProjectSessionId(turn.sessionId)?.trim().toLowerCase() === "wellness"
  );
}
