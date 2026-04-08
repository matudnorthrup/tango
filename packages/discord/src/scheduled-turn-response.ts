import type { ExecutionReceipt } from "./deterministic-runtime.js";
import type { DiscordTurnExecutionResult } from "./turn-executor.js";

const GENERIC_SCHEDULE_FAILURE_PATTERNS = [
  /^Sorry, something went wrong before I could finish that step\. Please try again\.$/iu,
  /^Sorry, something went wrong before I could finish that step\./iu,
];

function responseLooksLikeGenericScheduledFailure(responseText: string): boolean {
  const normalized = responseText.trim();
  return GENERIC_SCHEDULE_FAILURE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function parseStructuredWorkerText(workerText: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(workerText);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function extractDeliverableWorkerText(
  receipt: ExecutionReceipt | undefined,
  responseText: string,
): string | null {
  if (!receipt || receipt.status !== "completed") {
    return null;
  }
  if (receipt.warnings.length > 0 || receipt.data?.["partial"] === true) {
    return null;
  }

  const workerText =
    receipt.data && typeof receipt.data["workerText"] === "string"
      ? receipt.data["workerText"].trim()
      : "";
  if (!workerText) {
    return null;
  }

  if (workerText.includes("<worker-dispatch")) {
    return null;
  }

  if (parseStructuredWorkerText(workerText)) {
    return null;
  }

  if (responseLooksLikeGenericScheduledFailure(workerText)) {
    return null;
  }

  return workerText.length > responseText.trim().length + 80 ? workerText : null;
}

export function selectScheduledTurnResponseText(
  intentIds: string[],
  turnResult: DiscordTurnExecutionResult,
): string {
  const responseText = turnResult.responseText;
  const receipts = turnResult.deterministicTurn?.receipts ?? [];
  const workerText = receipts.length === 1 ? extractDeliverableWorkerText(receipts[0], responseText) : null;

  if (
    workerText
    && intentIds.length === 1
    && intentIds[0] === "research.slack_digest"
    && /\bpartial\b|\btruncated\b/iu.test(responseText)
  ) {
    return workerText;
  }

  if (workerText && responseLooksLikeGenericScheduledFailure(responseText)) {
    return workerText;
  }

  return responseText;
}
