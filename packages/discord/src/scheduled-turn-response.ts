import type { ExecutionReceipt } from "./deterministic-runtime.js";
import type { DiscordTurnExecutionResult } from "./turn-executor.js";
import {
  extractDeliverableWorkerTextFromReceipt,
  responseLooksLikeGenericWorkerFailure,
} from "./deliverable-worker-text.js";

export function selectScheduledTurnResponseText(
  intentIds: string[],
  turnResult: DiscordTurnExecutionResult,
): string {
  const responseText = turnResult.responseText;
  const receipts = turnResult.deterministicTurn?.receipts ?? [];
  const workerText = receipts.length === 1 ? extractDeliverableWorkerTextFromReceipt(receipts[0]) : null;

  if (
    workerText
    && intentIds.length === 1
    && intentIds[0] === "research.slack_digest"
    && /\bpartial\b|\btruncated\b/iu.test(responseText)
  ) {
    return workerText;
  }

  if (workerText && responseLooksLikeGenericWorkerFailure(responseText)) {
    return workerText;
  }

  return responseText;
}
