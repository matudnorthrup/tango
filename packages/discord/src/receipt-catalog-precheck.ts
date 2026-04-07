import fs from "node:fs";
import path from "node:path";

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

const LINKED_TRANSACTION_ID_PATTERN = /\b(?:Lunch Money\s+)?TXN\s+(\d+)\b/gu;
const RETAILER_PATTERN = /\b(amazon|walmart|costco|venmo)\b/iu;

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

export function formatReceiptCatalogCandidateDetails(candidates: ReceiptCatalogCandidate[]): string {
  return candidates
    .map((candidate) => {
      const extra = candidate.originalName ? ` — ${candidate.originalName}` : "";
      return `- TXN ${candidate.id} | ${candidate.date} | ${candidate.payee} | $${candidate.amount} | ${candidate.status}${extra}`;
    })
    .join("\n");
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
