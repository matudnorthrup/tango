import fs from "node:fs";
import path from "node:path";
import {
  detectReimbursementGaps,
  loadAllReceiptRecords,
  resolveVendorConfig,
} from "./receipt-universal-registry.js";

export interface ReceiptCatalogTransactionRecord {
  id?: number | string | null;
  date?: string | null;
  payee?: string | null;
  original_name?: string | null;
  notes?: string | null;
  amount?: string | number | null;
  status?: string | null;
}

export interface ReceiptCatalogCandidate {
  id: string;
  date: string;
  payee: string;
  originalName: string;
  amount: string;
  status: string;
}

export interface ReimbursementGapCandidate {
  type: "missing_tracking_section" | "stale_tracking" | "missing_recurring_receipt";
  vendorKey?: string;
  merchant?: string;
  month?: string;
  notePath?: string;
  noteName?: string;
  amount?: string;
  expectedAmount?: string;
  detail: string;
}

export interface BuildReimbursementGapCandidatesInput {
  receiptsRoot?: string;
  since?: string;
  until?: string;
  vendor?: string;
  lookbackMonths?: number;
}

const LINKED_TRANSACTION_ID_PATTERN = /\b(?:Lunch Money\s+)?TXN\s+(\d+)\b/gu;
const RETAILER_PATTERN = /\b(amazon|walmart|costco|venmo|maid in newport|factor)\b/iu;
const REIMBURSEMENT_GAP_TYPE_ORDER: Record<ReimbursementGapCandidate["type"], number> = {
  missing_tracking_section: 0,
  stale_tracking: 1,
  missing_recurring_receipt: 2,
};

export function collectLinkedReceiptTransactionIds(receiptsRoot: string): Set<string> {
  const linkedIds = new Set<string>();
  if (!fs.existsSync(receiptsRoot)) {
    return linkedIds;
  }

  const pending = [receiptsRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }
      const content = fs.readFileSync(fullPath, "utf8");
      for (const match of content.matchAll(LINKED_TRANSACTION_ID_PATTERN)) {
        linkedIds.add(match[1]!);
      }
    }
  }

  return linkedIds;
}

export function buildMissingReceiptCandidates(
  transactions: ReceiptCatalogTransactionRecord[],
  linkedTransactionIds: Set<string>,
): ReceiptCatalogCandidate[] {
  return transactions
    .map((transaction) => {
      const id = String(transaction.id ?? "").trim();
      if (!id || linkedTransactionIds.has(id)) {
        return null;
      }
      const haystack = [
        String(transaction.payee ?? ""),
        String(transaction.original_name ?? ""),
        String(transaction.notes ?? ""),
      ].join(" ");
      if (!RETAILER_PATTERN.test(haystack)) {
        return null;
      }
      return {
        id,
        date: String(transaction.date ?? "").trim() || "unknown-date",
        payee: String(transaction.payee ?? "").trim() || "Unknown",
        originalName: String(transaction.original_name ?? "").trim(),
        amount: normalizeAmount(transaction.amount),
        status: String(transaction.status ?? "").trim() || "unknown",
      } satisfies ReceiptCatalogCandidate;
    })
    .filter((candidate): candidate is ReceiptCatalogCandidate => candidate !== null)
    .sort((left, right) => {
      if (left.date !== right.date) {
        return left.date.localeCompare(right.date);
      }
      return left.id.localeCompare(right.id);
    });
}

export function buildReimbursementGapCandidates(
  input: BuildReimbursementGapCandidatesInput = {},
): ReimbursementGapCandidate[] {
  const candidates = new Map<string, ReimbursementGapCandidate>();
  const records = loadAllReceiptRecords(input.receiptsRoot)
    .filter((record) => Boolean(record.vendorKey))
    .filter((record) => recordMatchesGapFilters(record.date, record.vendorKey, input));

  for (const record of records) {
    if (!record.hasReimbursementSection) {
      addGapCandidate(candidates, {
        type: "missing_tracking_section",
        vendorKey: record.vendorKey,
        merchant: record.merchant,
        notePath: record.filePath,
        noteName: record.noteName,
        detail: "Configured reimbursement receipt is missing the reimbursement tracking block.",
      });
    }

    if (normalizeTrackingStatus(record.reimbursement.status) === "submitted" && !record.reimbursement.rampReportId) {
      addGapCandidate(candidates, {
        type: "stale_tracking",
        vendorKey: record.vendorKey,
        merchant: record.merchant,
        notePath: record.filePath,
        noteName: record.noteName,
        amount: normalizeOptionalAmount(record.reimbursement.amount ?? record.reimbursableAmount),
        detail: "Receipt is marked submitted but is missing the Ramp report id.",
      });
    }
  }

  const detected = detectReimbursementGaps({
    since: input.since,
    until: input.until,
    vendor: input.vendor,
    lookbackMonths: input.lookbackMonths,
    rootDir: input.receiptsRoot,
  });

  for (const gap of detected.gaps) {
    if (
      gap.type !== "missing_tracking_section"
      && gap.type !== "stale_tracking"
      && gap.type !== "missing_recurring_receipt"
    ) {
      continue;
    }

    addGapCandidate(candidates, {
      type: gap.type,
      vendorKey: gap.vendorKey,
      merchant: gap.merchant,
      month: gap.month,
      notePath: gap.notePath,
      noteName: deriveNoteName(gap.notePath, input.receiptsRoot),
      amount: normalizeOptionalAmount(gap.amount),
      expectedAmount: normalizeOptionalAmount(gap.expectedAmount),
      detail: gap.detail,
    });
  }

  return [...candidates.values()].sort((left, right) => {
    const leftType = REIMBURSEMENT_GAP_TYPE_ORDER[left.type];
    const rightType = REIMBURSEMENT_GAP_TYPE_ORDER[right.type];
    if (leftType !== rightType) {
      return leftType - rightType;
    }

    const leftKey = [
      left.month ?? "",
      left.noteName ?? "",
      left.vendorKey ?? "",
      left.merchant ?? "",
    ].join("::");
    const rightKey = [
      right.month ?? "",
      right.noteName ?? "",
      right.vendorKey ?? "",
      right.merchant ?? "",
    ].join("::");
    return leftKey.localeCompare(rightKey);
  });
}

export function formatReceiptCatalogCandidateDetails(candidates: ReceiptCatalogCandidate[]): string {
  if (candidates.length === 0) {
    return "(none)";
  }

  return candidates
    .map((candidate) => {
      const extra = candidate.originalName ? ` — ${candidate.originalName}` : "";
      return `- TXN ${candidate.id} | ${candidate.date} | ${candidate.payee} | $${candidate.amount} | ${candidate.status}${extra}`;
    })
    .join("\n");
}

export function formatReimbursementGapCandidateDetails(
  candidates: ReimbursementGapCandidate[],
): string {
  if (candidates.length === 0) {
    return "(none)";
  }

  return candidates
    .map((candidate) => {
      const merchant = candidate.merchant ?? humanizeVendorKey(candidate.vendorKey);
      const target =
        candidate.noteName
        ?? candidate.month
        ?? candidate.notePath
        ?? "unknown-target";
      switch (candidate.type) {
        case "missing_tracking_section":
          return `- missing_tracking_section | ${merchant} | ${target} | add ## Reimbursement Tracking`;
        case "stale_tracking":
          return `- stale_tracking | ${merchant} | ${target} | status=submitted but no Ramp report id${candidate.amount ? ` | $${candidate.amount}` : ""}`;
        case "missing_recurring_receipt":
          return `- missing_recurring_receipt | ${merchant} | ${target}${candidate.expectedAmount ? ` | expected $${candidate.expectedAmount}` : ""}`;
        default:
          return `- ${candidate.type} | ${merchant} | ${target} | ${candidate.detail}`;
      }
    })
    .join("\n");
}

function addGapCandidate(
  candidates: Map<string, ReimbursementGapCandidate>,
  candidate: ReimbursementGapCandidate,
): void {
  const key = [
    candidate.type,
    candidate.vendorKey ?? "",
    candidate.month ?? "",
    candidate.notePath ?? "",
  ].join("::");
  if (!candidates.has(key)) {
    candidates.set(key, candidate);
  }
}

function deriveNoteName(notePath: string | undefined, receiptsRoot: string | undefined): string | undefined {
  if (!notePath) {
    return undefined;
  }
  if (receiptsRoot) {
    return path.relative(receiptsRoot, notePath).replace(/\\/gu, "/");
  }
  return path.basename(notePath);
}

function humanizeVendorKey(vendorKey: string | undefined): string {
  if (!vendorKey) {
    return "Unknown";
  }
  return vendorKey
    .replace(/[_-]+/gu, " ")
    .replace(/\b\w/gu, (segment) => segment.toUpperCase());
}

function normalizeTrackingStatus(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function normalizeAmount(value: string | number | null | undefined): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toFixed(2);
  }
  const text = String(value ?? "").trim();
  if (!text) return "0.00";
  const numeric = Number(text);
  if (Number.isFinite(numeric)) {
    return numeric.toFixed(2);
  }
  return text;
}

function normalizeOptionalAmount(value: string | number | null | undefined): string | undefined {
  const normalized = normalizeAmount(value);
  return normalized === "0.00" && (value == null || String(value).trim().length === 0)
    ? undefined
    : normalized;
}

function recordMatchesGapFilters(
  date: string | undefined,
  vendorKey: string | undefined,
  input: BuildReimbursementGapCandidatesInput,
): boolean {
  if (input.vendor) {
    const resolved = resolveVendorConfig(input.vendor);
    const filterKey = resolved?.key ?? input.vendor;
    if (vendorKey !== filterKey) {
      return false;
    }
  }

  if (!date) {
    return input.since == null && input.until == null;
  }
  if (input.since && date < input.since) {
    return false;
  }
  if (input.until && date > input.until) {
    return false;
  }
  return true;
}
