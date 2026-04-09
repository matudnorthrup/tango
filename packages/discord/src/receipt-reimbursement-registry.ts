import * as fs from "node:fs";
import * as path from "node:path";
import { resolveConfiguredPath, resolveTangoProfileDataDir } from "@tango/core";
import { loadReimbursementEvidenceRecord } from "./reimbursement-evidence.js";
import {
  CANONICAL_VAULT_RECEIPTS_ROOT,
  LEGACY_VAULT_RECEIPTS_ROOT,
  LEGACY_VAULT_ROOT,
  resolveDefaultReceiptRoot,
  resolveWalmartReceiptDir,
} from "./receipt-paths.js";

const REIMBURSEMENT_SECTION_HEADING = "## Reimbursement Tracking";
const WALMART_RECEIPTS_ENV = "TANGO_WALMART_RECEIPTS_DIR";

export interface ReceiptReimbursementState {
  status?: string;
  system?: string;
  reimbursableItem?: string;
  amount?: number;
  submitted?: string;
  note?: string;
  evidencePath?: string;
  evidenceSourcePath?: string;
  evidenceSha256?: string;
  evidenceImageWidth?: number;
  evidenceImageHeight?: number;
  evidenceCaptureMode?: string;
  evidenceDateVisible?: boolean;
  evidenceDateText?: string;
  rampReportId?: string;
  rampConfirmationPath?: string;
  lastUpdated?: string;
}

export interface WalmartReceiptRecord {
  filePath: string;
  noteName: string;
  orderId: string;
  date?: string;
  total?: number;
  cardCharge?: string;
  driverTip?: number;
  deliverySummary?: string;
  isDelivery: boolean;
  reimbursement: ReceiptReimbursementState;
}

interface ScoredWalmartReceiptRecord extends WalmartReceiptRecord {
  fileSize: number;
}

export interface ListWalmartDeliveryCandidatesInput {
  since?: string;
  includeSubmitted?: boolean;
}

export interface UpsertWalmartReimbursementInput {
  notePath?: string;
  orderId?: string;
  status: string;
  system?: string;
  reimbursableItem?: string;
  amount?: number;
  submitted?: string;
  note?: string;
  evidencePath?: string;
  rampReportId?: string;
}

export interface BackfillWalmartReceiptInput {
  orderId: string;
  date: string;
  total?: number;
  cardCharge?: string;
  itemsLine?: string;
  grocerySummary?: string;
  notes: string;
  driverTip?: number;
}

function getWalmartReceiptDir(): string {
  const configured = process.env[WALMART_RECEIPTS_ENV]?.trim();
  return configured && configured.length > 0
    ? resolveConfiguredPath(configured)
    : resolveWalmartReceiptDir(resolveDefaultReceiptRoot());
}

function resolveNoteNameBaseDir(filePath: string): string {
  const normalizedPath = path.resolve(filePath);
  if (normalizedPath.startsWith(`${LEGACY_VAULT_ROOT}${path.sep}`)) {
    return LEGACY_VAULT_ROOT;
  }

  if (normalizedPath.startsWith(`${CANONICAL_VAULT_RECEIPTS_ROOT}${path.sep}`)) {
    return CANONICAL_VAULT_RECEIPTS_ROOT;
  }

  const walmartReceiptDir = getWalmartReceiptDir();
  if (normalizedPath.startsWith(`${walmartReceiptDir}${path.sep}`)) {
    return walmartReceiptDir;
  }

  const receiptRoot = resolveDefaultReceiptRoot();
  if (normalizedPath.startsWith(`${receiptRoot}${path.sep}`)) {
    return receiptRoot;
  }

  if (normalizedPath.startsWith(`${LEGACY_VAULT_RECEIPTS_ROOT}${path.sep}`)) {
    return LEGACY_VAULT_RECEIPTS_ROOT;
  }

  return path.dirname(normalizedPath);
}

function parseCurrency(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.replace(/[$,]/gu, "").trim();
  if (!normalized) {
    return undefined;
  }
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function renderBackfilledWalmartReceipt(input: BackfillWalmartReceiptInput): string {
  const tip = input.driverTip ?? 0;
  const reimbursementStatus = tip > 0 ? "not_submitted" : "not_applicable";
  const reimbursementAmount = tip > 0 ? formatCurrency(tip) : "$0.00";
  const grocerySummary = input.grocerySummary?.trim()
    || (tip > 0
      ? "Walmart grocery delivery. Full item breakdown not yet backfilled into the note."
      : "Delivery from store order with no reimbursable driver tip shown.");

  const lines = [
    "---",
    `created: ${input.date}`,
    "---",
    `# Walmart Order ${input.orderId}`,
    "",
    `- **Date:** ${input.date}`,
  ];
  if (input.total != null) {
    lines.push(`- **Total:** ${formatCurrency(input.total)}`);
  }
  if (input.cardCharge) {
    lines.push(`- **Card Charge:** ${input.cardCharge}`);
  }
  if (input.itemsLine) {
    lines.push(`- **Items:** ${input.itemsLine}`);
  }
  lines.push(
    "",
    "## Non-Grocery Items",
    "",
    "Unknown from current backfill pass.",
    "",
    "## Grocery Items (Summary)",
    "",
    grocerySummary,
    "",
    "## Linked Transactions",
    "",
    "Not yet backfilled.",
    "",
    "## Notes",
    "",
    input.notes.trim(),
    "",
    "## Reimbursement Tracking",
    "",
    `- Status: ${reimbursementStatus}`,
    "- System: Ramp",
    "- Reimbursable Item: Driver tip",
    `- Amount: ${reimbursementAmount}`,
  );
  if (tip > 0) {
    lines.push("- Note: executive buy back time");
  } else {
    lines.push("- Note: no driver tip on order detail");
  }
  return `${lines.join("\n")}\n`;
}

function parseFirstCurrencyFromRegex(markdown: string, patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(markdown);
    const parsed = parseCurrency(match?.[1]);
    if (parsed != null) {
      return parsed;
    }
  }
  return undefined;
}

function formatCurrency(value: number | undefined): string | undefined {
  if (value == null || !Number.isFinite(value)) {
    return undefined;
  }
  return `$${value.toFixed(2)}`;
}

function normalizeStatus(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function parseBooleanValue(value: string | undefined): boolean | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "yes" || trimmed === "true") {
    return true;
  }
  if (trimmed === "no" || trimmed === "false") {
    return false;
  }
  return undefined;
}

function parseDimensions(value: string | undefined): { width?: number; height?: number } {
  const match = /^(\d+)x(\d+)$/u.exec(value?.trim() ?? "");
  if (!match) {
    return {};
  }
  return {
    width: Number.parseInt(match[1]!, 10),
    height: Number.parseInt(match[2]!, 10),
  };
}

function parseKeyValueLines(block: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    const match = /^-\s+([^:]+):\s*(.+)\s*$/u.exec(line);
    if (!match) {
      continue;
    }
    const [, rawKey, rawValue] = match;
    if (!rawKey || !rawValue) {
      continue;
    }
    result.set(rawKey.trim().toLowerCase(), rawValue.trim());
  }
  return result;
}

function extractReimbursementSection(markdown: string): string | null {
  const match = new RegExp(
    `${REIMBURSEMENT_SECTION_HEADING}\\n\\n([\\s\\S]*?)(?=\\n##\\s|$)`,
    "u",
  ).exec(markdown);
  return match?.[1]?.trim() ?? null;
}

function parseReimbursementState(markdown: string): ReceiptReimbursementState {
  const section = extractReimbursementSection(markdown);
  if (!section) {
    return {};
  }

  const fields = parseKeyValueLines(section);
  const dimensions = parseDimensions(fields.get("evidence dimensions"));
  return {
    status: normalizeStatus(fields.get("status")),
    system: fields.get("system"),
    reimbursableItem: fields.get("reimbursable item"),
    amount: parseCurrency(fields.get("amount")),
    submitted: fields.get("submitted"),
    note: fields.get("note"),
    evidencePath: fields.get("evidence"),
    evidenceSourcePath: fields.get("evidence source"),
    evidenceSha256: fields.get("evidence sha256"),
    evidenceImageWidth: dimensions.width,
    evidenceImageHeight: dimensions.height,
    evidenceCaptureMode: fields.get("evidence capture mode"),
    evidenceDateVisible: parseBooleanValue(fields.get("evidence date visible")),
    evidenceDateText: fields.get("evidence date text"),
    rampReportId: fields.get("ramp report id"),
    rampConfirmationPath: fields.get("ramp confirmation"),
    lastUpdated: fields.get("last updated"),
  };
}

export function parseWalmartReceiptMarkdown(filePath: string, markdown: string): WalmartReceiptRecord {
  const noteName = path
    .relative(resolveNoteNameBaseDir(filePath), filePath)
    .replace(/\\/gu, "/");
  const orderId =
    /^#\s+Walmart Order\s+(.+)$/mu.exec(markdown)?.[1]?.trim()
    ?? /Order\s+([^./]+)\.md$/u.exec(path.basename(filePath))?.[1]?.trim()
    ?? path.basename(filePath, ".md");
  const date = /-\s+\*\*Date:\*\*\s+([0-9]{4}-[0-9]{2}-[0-9]{2})/u.exec(markdown)?.[1];
  const total = parseCurrency(/-\s+\*\*Total:\*\*\s+\$([0-9.,]+)/u.exec(markdown)?.[1]);
  const cardCharge = /-\s+\*\*Card Charge:\*\*\s+(.+)/u.exec(markdown)?.[1]?.trim();
  const driverTip = parseFirstCurrencyFromRegex(markdown, [
    /driver tips\s+\$([0-9.,]+)/iu,
    /includes?\s+\$([0-9.,]+)\s+driver tip/iu,
    /-\s+Driver tip:\s+\$([0-9.,]+)/iu,
    /driver tip:\s+\$([0-9.,]+)/iu,
    /\|\s*Driver tip\s*\|\s*\$([0-9.,]+)\s*\|/iu,
    /driver tip\s+\$([0-9.,]+)/iu,
  ]);
  const deliverySummary =
    /-\s+(Delivery[^\n]+)/iu.exec(markdown)?.[1]?.trim()
    ?? /(Walmart\+\s+grocery delivery[^\n]+)/iu.exec(markdown)?.[1]?.trim()
    ?? /(Delivery order[^\n]+)/iu.exec(markdown)?.[1]?.trim()
    ?? /(Delivered[^\n]+)/iu.exec(markdown)?.[1]?.trim();
  const reimbursement = parseReimbursementState(markdown);

  return {
    filePath,
    noteName,
    orderId,
    date,
    total,
    cardCharge,
    driverTip,
    deliverySummary,
    isDelivery: Boolean(deliverySummary ?? driverTip != null),
    reimbursement,
  };
}

function choosePreferredReceiptRecord(
  current: ScoredWalmartReceiptRecord | undefined,
  candidate: ScoredWalmartReceiptRecord,
): ScoredWalmartReceiptRecord {
  if (!current) {
    return candidate;
  }

  const currentScore =
    (current.reimbursement.status ? 1000 : 0)
    + (current.driverTip != null ? 100 : 0)
    + (current.deliverySummary ? 50 : 0)
    + current.fileSize;
  const candidateScore =
    (candidate.reimbursement.status ? 1000 : 0)
    + (candidate.driverTip != null ? 100 : 0)
    + (candidate.deliverySummary ? 50 : 0)
    + candidate.fileSize;

  if (candidateScore > currentScore) {
    return candidate;
  }
  if (candidateScore < currentScore) {
    return current;
  }

  return candidate.filePath < current.filePath ? candidate : current;
}

function loadWalmartReceiptRecords(): WalmartReceiptRecord[] {
  const receiptDir = getWalmartReceiptDir();
  if (!fs.existsSync(receiptDir)) {
    return [];
  }

  const deduped = new Map<string, ScoredWalmartReceiptRecord>();

  for (const entry of fs.readdirSync(receiptDir)
    .filter((entry) => entry.endsWith(".md"))
    .sort()) {
      const filePath = path.join(receiptDir, entry);
      const markdown = fs.readFileSync(filePath, "utf8");
      const parsed = parseWalmartReceiptMarkdown(filePath, markdown);
      const scored: ScoredWalmartReceiptRecord = {
        ...parsed,
        fileSize: markdown.length,
      };
      deduped.set(parsed.orderId, choosePreferredReceiptRecord(deduped.get(parsed.orderId), scored));
    }

  return [...deduped.values()]
    .sort((left, right) => left.filePath.localeCompare(right.filePath))
    .map(({ fileSize: _fileSize, ...record }) => record);
}

export function findWalmartReceiptRecord(orderId: string): WalmartReceiptRecord | null {
  const normalized = orderId.trim();
  return loadWalmartReceiptRecords().find((record) => record.orderId === normalized) ?? null;
}

export function backfillWalmartReceiptNote(
  input: BackfillWalmartReceiptInput,
): WalmartReceiptRecord {
  const existing = findWalmartReceiptRecord(input.orderId);
  if (existing) {
    return existing;
  }

  const receiptDir = getWalmartReceiptDir();
  fs.mkdirSync(receiptDir, { recursive: true });
  const filePath = path.join(receiptDir, `${input.date} Order ${input.orderId}.md`);
  const markdown = renderBackfilledWalmartReceipt(input);
  fs.writeFileSync(filePath, markdown, "utf8");
  return parseWalmartReceiptMarkdown(filePath, markdown);
}

export function listWalmartDeliveryCandidates(
  input: ListWalmartDeliveryCandidatesInput = {},
): WalmartReceiptRecord[] {
  const includeSubmitted = input.includeSubmitted === true;
  const since = input.since?.trim();

  return loadWalmartReceiptRecords()
    .filter((record) => record.isDelivery && (record.driverTip ?? 0) > 0)
    .filter((record) => !since || !record.date || record.date >= since)
    .filter((record) => {
      if (includeSubmitted) {
        return true;
      }
      const status = normalizeStatus(record.reimbursement.status);
      return status !== "submitted" && status !== "reimbursed";
    });
}

function renderReimbursementSection(state: ReceiptReimbursementState): string {
  const lines = [
    REIMBURSEMENT_SECTION_HEADING,
    "",
    `- Status: ${state.status ?? "not_submitted"}`,
  ];

  if (state.system) {
    lines.push(`- System: ${state.system}`);
  }
  if (state.reimbursableItem) {
    lines.push(`- Reimbursable Item: ${state.reimbursableItem}`);
  }
  if (state.amount != null) {
    lines.push(`- Amount: ${formatCurrency(state.amount)}`);
  }
  if (state.submitted) {
    lines.push(`- Submitted: ${state.submitted}`);
  }
  if (state.note) {
    lines.push(`- Note: ${state.note}`);
  }
  if (state.evidencePath) {
    lines.push(`- Evidence: ${state.evidencePath}`);
  }
  if (state.evidenceSourcePath) {
    lines.push(`- Evidence Source: ${state.evidenceSourcePath}`);
  }
  if (state.evidenceSha256) {
    lines.push(`- Evidence SHA256: ${state.evidenceSha256}`);
  }
  if (state.evidenceImageWidth != null && state.evidenceImageHeight != null) {
    lines.push(`- Evidence Dimensions: ${state.evidenceImageWidth}x${state.evidenceImageHeight}`);
  }
  if (state.evidenceCaptureMode) {
    lines.push(`- Evidence Capture Mode: ${state.evidenceCaptureMode}`);
  }
  if (state.evidenceDateVisible != null) {
    lines.push(`- Evidence Date Visible: ${state.evidenceDateVisible ? "yes" : "no"}`);
  }
  if (state.evidenceDateText) {
    lines.push(`- Evidence Date Text: ${state.evidenceDateText}`);
  }
  if (state.rampReportId) {
    lines.push(`- Ramp Report ID: ${state.rampReportId}`);
  }
  if (state.rampConfirmationPath) {
    lines.push(`- Ramp Confirmation: ${state.rampConfirmationPath}`);
  }
  if (state.lastUpdated) {
    lines.push(`- Last Updated: ${state.lastUpdated}`);
  }

  return `${lines.join("\n")}\n`;
}

function resolveReceiptPath(input: UpsertWalmartReimbursementInput): string {
  if (input.notePath?.trim()) {
    return path.resolve(input.notePath);
  }

  const orderId = input.orderId?.trim();
  if (!orderId) {
    throw new Error("upsert requires either notePath or orderId");
  }

  const match = loadWalmartReceiptRecords().find((record) => record.orderId === orderId);
  if (!match) {
    throw new Error(`No Walmart receipt found for order ${orderId}`);
  }
  return match.filePath;
}

export function upsertWalmartReimbursementTracking(
  input: UpsertWalmartReimbursementInput,
): WalmartReceiptRecord {
  const filePath = resolveReceiptPath(input);
  const current = fs.readFileSync(filePath, "utf8");
  const currentRecord = parseWalmartReceiptMarkdown(filePath, current);
  const resolvedEvidencePath = input.evidencePath ?? currentRecord.reimbursement.evidencePath;
  const evidenceRecord = resolvedEvidencePath
    ? loadReimbursementEvidenceRecord(resolvedEvidencePath)
    : null;
  const nextState: ReceiptReimbursementState = {
    ...currentRecord.reimbursement,
    status: normalizeStatus(input.status),
    system: input.system ?? currentRecord.reimbursement.system ?? "Ramp",
    reimbursableItem: input.reimbursableItem ?? currentRecord.reimbursement.reimbursableItem ?? "Driver tip",
    amount: input.amount ?? currentRecord.reimbursement.amount ?? currentRecord.driverTip,
    submitted: input.submitted ?? currentRecord.reimbursement.submitted,
    note: input.note ?? currentRecord.reimbursement.note,
    evidencePath: evidenceRecord?.archivedPath ?? resolvedEvidencePath,
    evidenceSourcePath: evidenceRecord?.sourcePath ?? currentRecord.reimbursement.evidenceSourcePath,
    evidenceSha256: evidenceRecord?.sha256 ?? currentRecord.reimbursement.evidenceSha256,
    evidenceImageWidth: evidenceRecord?.imageWidth ?? currentRecord.reimbursement.evidenceImageWidth,
    evidenceImageHeight: evidenceRecord?.imageHeight ?? currentRecord.reimbursement.evidenceImageHeight,
    evidenceCaptureMode: evidenceRecord?.captureMode ?? currentRecord.reimbursement.evidenceCaptureMode,
    evidenceDateVisible: evidenceRecord?.dateVisible ?? currentRecord.reimbursement.evidenceDateVisible,
    evidenceDateText: evidenceRecord?.visibleDateText?.join(", ") ?? currentRecord.reimbursement.evidenceDateText,
    rampReportId: input.rampReportId ?? evidenceRecord?.rampReportId ?? currentRecord.reimbursement.rampReportId,
    rampConfirmationPath: evidenceRecord?.rampConfirmationPath ?? currentRecord.reimbursement.rampConfirmationPath,
    lastUpdated: new Date().toISOString(),
  };

  const renderedSection = renderReimbursementSection(nextState);
  const sectionMatch = new RegExp(
    `${REIMBURSEMENT_SECTION_HEADING}\\n\\n[\\s\\S]*?(?=\\n##\\s|$)`,
    "u",
  );

  let updated = current;
  if (sectionMatch.test(current)) {
    updated = current.replace(sectionMatch, renderedSection.trimEnd());
  } else {
    updated = `${current.trimEnd()}\n\n${renderedSection}`;
  }

  fs.writeFileSync(filePath, updated.endsWith("\n") ? updated : `${updated}\n`, "utf8");
  return parseWalmartReceiptMarkdown(filePath, fs.readFileSync(filePath, "utf8"));
}
