import type { ExecutionReceipt } from "./deterministic-runtime.js";
import { receiptHasConfirmedWriteOutcome } from "./deterministic-runtime.js";
import {
  reportHasConfirmedWriteOutcome,
  reportIndicatesSafeNoopWriteResult,
  type WorkerReport,
} from "./worker-report.js";
import { sanitizeWorkerTextForDisplay } from "./worker-text-sanitizer.js";

const GENERIC_WORKER_FAILURE_PATTERNS = [
  /^Sorry, something went wrong before I could finish that step\. Please try again\.$/iu,
  /^Sorry, something went wrong before I could finish that step\./iu,
  /^Sorry, something went wrong before I could actually start that worker task\./iu,
  /^Sorry, something went wrong processing that request\./iu,
];

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

function extractWorkerText(data: Record<string, unknown> | undefined): string {
  const workerText =
    data && typeof data["workerText"] === "string"
      ? data["workerText"].trim()
      : "";
  return sanitizeWorkerTextForDisplay(workerText);
}

function workerTextLooksDeliverable(workerText: string): boolean {
  if (!workerText) {
    return false;
  }
  if (workerText.includes("<worker-dispatch")) {
    return false;
  }
  if (parseStructuredWorkerText(workerText)) {
    return false;
  }
  return !responseLooksLikeGenericWorkerFailure(workerText);
}

function hasQualityWarnings(data: Record<string, unknown> | undefined): boolean {
  const warnings = data?.["qualityWarnings"];
  return Array.isArray(warnings) && warnings.some((warning) => typeof warning === "string" && warning.trim().length > 0);
}

export function responseLooksLikeGenericWorkerFailure(responseText: string): boolean {
  const normalized = responseText.trim();
  return GENERIC_WORKER_FAILURE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function extractDeliverableWorkerTextFromReceipt(
  receipt: ExecutionReceipt | undefined,
): string | null {
  if (!receipt || receipt.status !== "completed") {
    return null;
  }
  if (receipt.clarification || receipt.warnings.length > 0 || receipt.data?.["partial"] === true) {
    return null;
  }
  if (
    (receipt.mode === "write" || receipt.mode === "mixed")
    && !receiptHasConfirmedWriteOutcome(receipt)
  ) {
    return null;
  }

  const workerText = extractWorkerText(receipt.data);
  return workerTextLooksDeliverable(workerText) ? workerText : null;
}

export function extractDeliverableWorkerTextsFromReceipts(
  receipts: readonly ExecutionReceipt[],
): string[] | null {
  if (receipts.length === 0) {
    return null;
  }

  const texts: string[] = [];
  for (const receipt of receipts) {
    const workerText = extractDeliverableWorkerTextFromReceipt(receipt);
    if (!workerText) {
      return null;
    }
    texts.push(workerText);
  }
  return texts;
}

export function extractDeliverableWorkerTextFromReport(
  report: WorkerReport | null | undefined,
): string | null {
  if (!report || report.clarification || report.data?.["partial"] === true || hasQualityWarnings(report.data)) {
    return null;
  }

  const mutatesState = report.hasWriteOperations || report.operations.some((operation) => operation.mode === "write");
  if (
    mutatesState
    && !reportHasConfirmedWriteOutcome(report)
    && !reportIndicatesSafeNoopWriteResult(report)
  ) {
    return null;
  }

  const workerText = extractWorkerText(report.data);
  return workerTextLooksDeliverable(workerText) ? workerText : null;
}
