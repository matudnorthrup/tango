import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfiguredPath } from "@tango/core";
import { loadReimbursementEvidenceRecord } from "./reimbursement-evidence.js";
import { parseFlexibleDateToIso } from "./reimbursement-automation.js";
import {
  CANONICAL_VAULT_RECEIPTS_ROOT,
  LEGACY_VAULT_RECEIPTS_ROOT,
  LEGACY_VAULT_ROOT,
  resolveDefaultReceiptRoot,
} from "./receipt-paths.js";
import type {
  RampReimbursementHistoryRecord,
  ReceiptReimbursementState,
} from "./receipt-reimbursement-registry.js";

const REIMBURSEMENT_SECTION_HEADING = "## Reimbursement Tracking";
const REIMBURSEMENT_CONFIG_ENV = "TANGO_REIMBURSEMENT_CONFIG_PATH";
const CURRENT_MONTH_KEY = new Date().toISOString().slice(0, 7);

export interface ReimbursementCategoryConfig {
  memo?: string;
  vendors: string[];
}

export interface ReimbursementVendorConfig {
  receiptDir?: string;
  merchantName?: string;
  reimbursableItem?: string;
  recurring?: boolean;
  typicalAmount?: number;
  defaultCategory?: string;
}

export interface ReimbursementConfig {
  defaultSystem: string;
  categories: Record<string, ReimbursementCategoryConfig>;
  vendors: Record<string, ReimbursementVendorConfig>;
}

export interface ResolvedReimbursementVendorConfig extends ReimbursementVendorConfig {
  key: string;
  merchantName: string;
  system: string;
  defaultMemo?: string;
}

export interface UniversalReceiptRecord {
  filePath: string;
  noteName: string;
  title: string;
  receiptDir: string;
  sourceType: "venmo" | "generic";
  vendorKey?: string;
  merchant: string;
  date?: string;
  total?: number;
  recipient?: string;
  reimbursableAmount?: number;
  reimbursableItem?: string;
  categoryKey?: string;
  defaultMemo?: string;
  recurring?: boolean;
  typicalAmount?: number;
  hasReimbursementSection: boolean;
  reimbursement: ReceiptReimbursementState;
}

export interface ReceiptLineItem {
  item: string;
  quantity?: string;
  price?: number;
  raw: string;
}

export interface LinkedReceiptTransaction {
  id: string;
  amount?: number;
  description?: string;
  raw: string;
}

export interface ReceiptLookupInput {
  transactionId?: string | number;
  amount?: number;
  date?: string;
  merchant?: string;
  query?: string;
  rootDir?: string;
  maxResults?: number;
}

export interface ReceiptLookupMatch {
  score: number;
  reasons: string[];
  record: UniversalReceiptRecord & {
    fields: Record<string, string>;
    linkedTransactions: LinkedReceiptTransaction[];
    lineItems: ReceiptLineItem[];
    categoryNotes: string[];
  };
}

export interface UpsertReimbursementTrackingInput {
  notePath: string;
  vendor?: string;
  status: string;
  system?: string;
  reimbursableItem?: string;
  amount?: number;
  submitted?: string;
  note?: string;
  evidencePath?: string;
  rampReportId?: string | null;
}

export interface CheckSubmissionDedupInput {
  notePath?: string;
  vendor?: string;
  merchant?: string;
  amount?: number;
  transactionDate?: string;
  memo?: string;
  history?: RampReimbursementHistoryRecord[];
}

export interface CheckSubmissionDedupResult {
  basis: {
    notePath?: string;
    vendorKey?: string;
    merchant?: string;
    amount?: number;
    transactionDate?: string;
    memo?: string;
  };
  duplicate: boolean;
  reasons: string[];
  localMatches: UniversalReceiptRecord[];
  historyMatches: RampReimbursementHistoryRecord[];
}

export interface ReconcileUniversalReimbursementsInput {
  history: RampReimbursementHistoryRecord[];
  since?: string;
  until?: string;
  vendor?: string;
  includeSubmitted?: boolean;
  updateNotes?: boolean;
}

export interface UniversalRampReconciliationMatch {
  vendorKey?: string;
  merchant: string;
  notePath: string;
  noteName: string;
  amount?: number;
  transactionDate?: string;
  submittedDate?: string;
  noteStatusBefore?: string;
  noteStatusAfter: string;
  rampStatus?: string;
  rampReportId?: string;
  reviewUrl: string;
  memo?: string;
}

export interface ReconcileUniversalReimbursementsResult {
  records: UniversalReceiptRecord[];
  matched: UniversalRampReconciliationMatch[];
  pending: UniversalReceiptRecord[];
  unverifiedSubmitted: UniversalReceiptRecord[];
  updated: UniversalReceiptRecord[];
  notesExamined: number;
  historyEntriesExamined: number;
}

export interface ListReimbursementCandidatesInput {
  since?: string;
  until?: string;
  vendor?: string;
  includeSubmitted?: boolean;
  history?: RampReimbursementHistoryRecord[];
}

export interface MonthlyLedgerEntry {
  month: string;
  vendorKey?: string;
  merchant: string;
  categoryKey?: string;
  status: string;
  count: number;
  total: number;
  memo?: string;
}

export interface MonthlyLedgerItem {
  date?: string;
  vendorKey?: string;
  merchant: string;
  notePath: string;
  amount?: number;
  status: string;
  memo?: string;
  categoryKey?: string;
}

export interface MonthlyLedgerResult {
  month: string;
  entries: MonthlyLedgerEntry[];
  items: MonthlyLedgerItem[];
  totals: {
    all: number;
    submitted: number;
    reimbursed: number;
    pending: number;
  };
}

export interface DetectReimbursementGapsInput {
  since?: string;
  until?: string;
  vendor?: string;
  history?: RampReimbursementHistoryRecord[];
  lookbackMonths?: number;
  rootDir?: string;
}

export interface ReimbursementGap {
  type: string;
  vendorKey?: string;
  merchant?: string;
  month?: string;
  notePath?: string;
  amount?: number;
  expectedAmount?: number;
  detail: string;
}

export interface DetectReimbursementGapsResult {
  gaps: ReimbursementGap[];
  summary: {
    total: number;
    byType: Record<string, number>;
  };
}

let cachedConfig:
  | {
      path: string;
      mtimeMs: number;
      value: ReimbursementConfig;
    }
  | null = null;

type YamlScalar = string | number | boolean | string[];
interface YamlObject {
  [key: string]: YamlScalar | YamlObject;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function normalizeKey(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function humanizeToken(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .replace(/[_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/\b\w/gu, (segment) => segment.toUpperCase())
    .trim();
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

function amountsMatch(left: number | undefined, right: number | undefined): boolean {
  return left != null && right != null && Math.abs(left - right) < 0.01;
}

function hasCompletedReimbursementStatus(value: string | undefined): boolean {
  const normalized = normalizeStatus(value);
  return normalized === "submitted" || normalized === "reimbursed";
}

function deriveReceiptStatusFromRampStatus(value: string | undefined): string {
  const normalized = normalizeStatus(value);
  if (normalized === "draft") {
    return "draft";
  }
  if (normalized === "paid") {
    return "reimbursed";
  }
  if (normalized === "rejected") {
    return "rejected";
  }
  if (normalized && normalized.length > 0) {
    return "submitted";
  }
  return "submitted";
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

export function parseReimbursementState(markdown: string): ReceiptReimbursementState {
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

export function renderReimbursementSection(state: ReceiptReimbursementState): string {
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

function renderFrontmatterScalar(value: string | number | boolean | null): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return value.toFixed(2);
  }
  if (/^[A-Za-z0-9_.\/ -]+$/u.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function upsertSimpleFrontmatterFields(markdown: string, fields: Record<string, string | number | boolean | null>): string {
  const lines = markdown.replace(/\r\n/gu, "\n").split("\n");
  let frontmatterStart = -1;
  let frontmatterEnd = -1;

  if (lines[0]?.trim() === "---") {
    frontmatterStart = 0;
    frontmatterEnd = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  }

  if (frontmatterStart === -1 || frontmatterEnd === -1) {
    const renderedFields = Object.entries(fields)
      .map(([key, value]) => `${key}: ${renderFrontmatterScalar(value)}`)
      .join("\n");
    return `---\n${renderedFields}\n---\n${markdown.replace(/^\n+/u, "")}`;
  }

  const existing = lines.slice(frontmatterStart + 1, frontmatterEnd);
  const consumed = new Set<string>();
  const updated = existing.map((line) => {
    const match = /^([A-Za-z0-9_-]+):(?:\s.*)?$/u.exec(line);
    const key = match?.[1];
    if (!key || !(key in fields)) {
      return line;
    }
    consumed.add(key);
    return `${key}: ${renderFrontmatterScalar(fields[key]!)}`;
  });

  for (const [key, value] of Object.entries(fields)) {
    if (!consumed.has(key)) {
      updated.push(`${key}: ${renderFrontmatterScalar(value)}`);
    }
  }

  return [
    ...lines.slice(0, frontmatterStart + 1),
    ...updated,
    ...lines.slice(frontmatterEnd),
  ].join("\n");
}

function shouldMarkReceiptReimbursable(state: ReceiptReimbursementState): boolean {
  const status = normalizeStatus(state.status);
  return status !== "not_applicable" && state.amount != null && Number.isFinite(state.amount) && state.amount > 0;
}

function upsertReimbursementFrontmatter(
  markdown: string,
  record: UniversalReceiptRecord,
  state: ReceiptReimbursementState,
): string {
  if (!shouldMarkReceiptReimbursable(state)) {
    return markdown;
  }

  return upsertSimpleFrontmatterFields(markdown, {
    reimbursable: true,
    ramp_submitted: state.submitted ?? null,
    ramp_report_id: state.rampReportId ?? null,
    merchant: record.merchant,
    amount: state.amount ?? record.reimbursableAmount ?? record.total ?? 0,
  });
}

function resolveReimbursementConfigPath(): string {
  const configured = process.env[REIMBURSEMENT_CONFIG_ENV]?.trim();
  if (configured) {
    return resolveConfiguredPath(configured);
  }

  const searchTargets = [
    process.cwd(),
    path.dirname(fileURLToPath(import.meta.url)),
  ];

  for (const startDir of searchTargets) {
    let current = path.resolve(startDir);
    while (true) {
      const candidate = path.join(current, "config", "defaults", "reimbursement-config.yaml");
      if (fs.existsSync(candidate)) {
        return candidate;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }

  return path.resolve(process.cwd(), "config", "defaults", "reimbursement-config.yaml");
}

function parseYamlScalar(rawValue: string): YamlScalar {
  const value = rawValue.trim();
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) {
      return [];
    }
    return inner
      .split(",")
      .map((segment) => segment.trim())
      .filter(Boolean)
      .map((segment) => {
        if (
          (segment.startsWith("\"") && segment.endsWith("\""))
          || (segment.startsWith("'") && segment.endsWith("'"))
        ) {
          return segment.slice(1, -1);
        }
        return segment;
      });
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (/^-?\d+(?:\.\d+)?$/u.test(value)) {
    return Number.parseFloat(value);
  }
  return value;
}

function parseSimpleYaml(text: string): YamlObject {
  const root: YamlObject = {};
  const stack: Array<{ indent: number; value: YamlObject }> = [{ indent: -1, value: root }];

  for (const rawLine of text.replace(/\r\n/gu, "\n").split("\n")) {
    if (rawLine.trim().length === 0 || rawLine.trimStart().startsWith("#")) {
      continue;
    }

    const indent = rawLine.match(/^ */u)?.[0].length ?? 0;
    const trimmed = rawLine.trim();
    const match = /^([a-zA-Z0-9_]+):(?:\s+(.*))?$/u.exec(trimmed);
    if (!match) {
      continue;
    }

    const key = match[1]!;
    const rawValue = match[2];

    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) {
      stack.pop();
    }

    const current = stack[stack.length - 1]!.value;
    if (rawValue == null || rawValue.trim().length === 0) {
      const child: YamlObject = {};
      current[key] = child;
      stack.push({ indent, value: child });
      continue;
    }

    current[key] = parseYamlScalar(rawValue);
  }

  return root;
}

function parseStringArray(value: YamlScalar | YamlObject | undefined): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function resolveCategoryKeyForVendor(config: ReimbursementConfig, vendorKey: string): string | undefined {
  const direct = config.vendors[vendorKey]?.defaultCategory;
  if (direct) {
    return direct;
  }

  return Object.entries(config.categories).find(([, category]) =>
    category.vendors.includes(vendorKey)
  )?.[0];
}

export function loadReimbursementConfig(): ReimbursementConfig {
  const configPath = resolveReimbursementConfigPath();
  const mtimeMs = fs.existsSync(configPath) ? fs.statSync(configPath).mtimeMs : 0;
  if (cachedConfig && cachedConfig.path === configPath && cachedConfig.mtimeMs === mtimeMs) {
    return cachedConfig.value;
  }

  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = parseSimpleYaml(raw);
  const categoriesObject = (parsed.categories ?? {}) as YamlObject;
  const vendorsObject = (parsed.vendors ?? {}) as YamlObject;

  const value: ReimbursementConfig = {
    defaultSystem:
      typeof parsed.default_system === "string" && parsed.default_system.trim().length > 0
        ? parsed.default_system
        : "Ramp",
    categories: Object.fromEntries(
      Object.entries(categoriesObject).map(([key, rawCategory]) => {
        const category = (rawCategory ?? {}) as YamlObject;
        return [
          key,
          {
            memo: typeof category.memo === "string" ? category.memo : undefined,
            vendors: parseStringArray(category.vendors),
          } satisfies ReimbursementCategoryConfig,
        ];
      }),
    ),
    vendors: Object.fromEntries(
      Object.entries(vendorsObject).map(([key, rawVendor]) => {
        const vendor = (rawVendor ?? {}) as YamlObject;
        return [
          key,
          {
            receiptDir: typeof vendor.receipt_dir === "string" ? vendor.receipt_dir : undefined,
            merchantName: typeof vendor.merchant_name === "string" ? vendor.merchant_name : undefined,
            reimbursableItem:
              typeof vendor.reimbursable_item === "string" ? vendor.reimbursable_item : undefined,
            recurring: typeof vendor.recurring === "boolean" ? vendor.recurring : undefined,
            typicalAmount: typeof vendor.typical_amount === "number" ? vendor.typical_amount : undefined,
            defaultCategory:
              typeof vendor.default_category === "string" ? vendor.default_category : undefined,
          } satisfies ReimbursementVendorConfig,
        ];
      }),
    ),
  };

  cachedConfig = {
    path: configPath,
    mtimeMs,
    value,
  };
  return value;
}

export function resolveVendorConfig(input: string | undefined): ResolvedReimbursementVendorConfig | null {
  const normalizedInput = normalizeKey(input);
  if (!normalizedInput) {
    return null;
  }

  const config = loadReimbursementConfig();
  for (const [key, vendor] of Object.entries(config.vendors)) {
    const merchantName = vendor.merchantName ?? vendor.receiptDir ?? humanizeToken(key);
    const candidates = [
      key,
      vendor.receiptDir,
      vendor.merchantName,
      merchantName,
    ]
      .filter((value): value is string => Boolean(value))
      .map((value) => normalizeKey(value));

    if (!candidates.includes(normalizedInput)) {
      continue;
    }

    const categoryKey = resolveCategoryKeyForVendor(config, key);
    return {
      ...vendor,
      key,
      merchantName,
      system: config.defaultSystem,
      defaultMemo: categoryKey ? config.categories[categoryKey]?.memo : undefined,
    };
  }

  return null;
}

export function resolveDefaultMemo(merchantOrVendor: string | undefined): string | undefined {
  const normalized = normalizeKey(merchantOrVendor);
  if (!normalized) {
    return undefined;
  }

  const config = loadReimbursementConfig();
  const vendor = resolveVendorConfig(merchantOrVendor);
  if (vendor) {
    const categoryKey = resolveCategoryKeyForVendor(config, vendor.key);
    return categoryKey ? config.categories[categoryKey]?.memo : undefined;
  }

  const directCategory = Object.entries(config.categories).find(([key]) => normalizeKey(key) === normalized);
  return directCategory?.[1]?.memo;
}

function resolveNoteNameBaseDir(filePath: string): string {
  const normalizedPath = path.resolve(filePath);
  if (normalizedPath.startsWith(`${LEGACY_VAULT_ROOT}${path.sep}`)) {
    return LEGACY_VAULT_ROOT;
  }

  if (normalizedPath.startsWith(`${CANONICAL_VAULT_RECEIPTS_ROOT}${path.sep}`)) {
    return CANONICAL_VAULT_RECEIPTS_ROOT;
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

function buildNoteName(filePath: string): string {
  return path.relative(resolveNoteNameBaseDir(filePath), filePath).replace(/\\/gu, "/");
}

function extractBulletValue(markdown: string, labels: string[]): string | undefined {
  for (const label of labels) {
    const boldPattern = new RegExp(`^-\\s+\\*\\*${escapeRegex(label)}:\\*\\*\\s+(.+)$`, "imu");
    const plainPattern = new RegExp(`^-\\s+${escapeRegex(label)}:\\s+(.+)$`, "imu");
    const match = boldPattern.exec(markdown) ?? plainPattern.exec(markdown);
    const value = match?.[1]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function parseReceiptMetadataFields(markdown: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of markdown.replace(/\r\n/gu, "\n").split("\n")) {
    const match = /^\s*-\s+(?:\*\*)?([^:*]+):(?:\*\*)?\s+(.+?)\s*$/u.exec(rawLine);
    const rawKey = match?.[1]?.trim();
    const rawValue = match?.[2]?.trim();
    if (!rawKey || !rawValue) {
      continue;
    }
    result[rawKey] = rawValue;
  }
  return result;
}

function extractDateValue(markdown: string): string | undefined {
  const raw = extractBulletValue(markdown, ["Date", "Transaction Date", "Paid On", "Payment Date"]);
  if (!raw) {
    return undefined;
  }
  return parseFlexibleDateToIso(raw) ?? raw;
}

function extractHeadingTitle(markdown: string, fallbackPath: string): string {
  return /^#\s+(.+)$/mu.exec(markdown)?.[1]?.trim() ?? path.basename(fallbackPath, ".md");
}

function deriveMerchantFromTitle(title: string): string | undefined {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) {
    return undefined;
  }
  const structured = /^(.*?)\s+(?:order|receipt|invoice|payment)\b/iu.exec(normalizedTitle)?.[1]?.trim();
  if (structured) {
    return structured;
  }
  return normalizedTitle.split(/\s+-\s+/u)[0]?.trim();
}

function parseWalmartTipAmount(markdown: string): number | undefined {
  const patterns = [
    /driver tips?\s+\$([0-9.,]+)/iu,
    /includes?\s+\$([0-9.,]+)\s+driver tip/iu,
    /-\s+Driver tip:\s+\$([0-9.,]+)/iu,
    /driver tip:\s+\$([0-9.,]+)/iu,
    /\|\s*Driver tip\s*\|\s*\$([0-9.,]+)\s*\|/iu,
    /driver tip\s+\$([0-9.,]+)/iu,
  ];
  for (const pattern of patterns) {
    const parsed = parseCurrency(pattern.exec(markdown)?.[1]);
    if (parsed != null) {
      return parsed;
    }
  }
  return undefined;
}

function extractMarkdownSectionLines(markdown: string, heading: string): string[] {
  const lines = markdown.replace(/\r\n/gu, "\n").split("\n");
  const headingPattern = new RegExp(`^##\\s+${escapeRegex(heading)}\\s*$`, "iu");
  const startIndex = lines.findIndex((line) => headingPattern.test(line.trim()));
  if (startIndex < 0) {
    return [];
  }

  const sectionLines: string[] = [];
  for (const line of lines.slice(startIndex + 1)) {
    if (/^##\s+/u.test(line.trim())) {
      break;
    }
    sectionLines.push(line);
  }
  return sectionLines;
}

function splitMarkdownTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
    return null;
  }
  return trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
}

function isMarkdownSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell.trim()));
}

function parseReceiptLineItems(markdown: string): ReceiptLineItem[] {
  const rows = extractMarkdownSectionLines(markdown, "Items")
    .map(splitMarkdownTableRow)
    .filter((row): row is string[] => row !== null);
  const header = rows.find((row) => !isMarkdownSeparatorRow(row));
  if (!header) {
    return [];
  }

  const headerIndex = rows.indexOf(header);
  const headers = header.map((cell) => normalizeKey(cell));
  const itemIndex = headers.findIndex((cell) =>
    cell === "item" || cell === "name" || cell === "description"
  );
  const quantityIndex = headers.findIndex((cell) => cell === "qty" || cell === "quantity");
  const priceIndex = headers.findIndex((cell) =>
    cell === "price" || cell === "amount" || cell === "total"
  );

  if (itemIndex < 0) {
    return [];
  }

  return rows
    .slice(headerIndex + 1)
    .filter((row) => !isMarkdownSeparatorRow(row))
    .map((row) => {
      const item = row[itemIndex]?.trim() ?? "";
      if (!item) {
        return null;
      }
      const price = priceIndex >= 0 ? parseCurrency(row[priceIndex]) : undefined;
      const lineItem: ReceiptLineItem = {
        item,
        raw: `| ${row.join(" | ")} |`,
      };
      const quantity = quantityIndex >= 0 ? row[quantityIndex]?.trim() : undefined;
      if (quantity) {
        lineItem.quantity = quantity;
      }
      if (price != null) {
        lineItem.price = price;
      }
      return lineItem;
    })
    .filter((item): item is ReceiptLineItem => item !== null);
}

function parseReceiptCategoryNotes(markdown: string): string[] {
  return extractMarkdownSectionLines(markdown, "Category Notes")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^[-*]\s+/u, "").trim())
    .filter((line) => line.length > 0);
}

function parseLinkedReceiptTransactions(markdown: string): LinkedReceiptTransaction[] {
  const transactions: LinkedReceiptTransaction[] = [];
  for (const rawLine of markdown.replace(/\r\n/gu, "\n").split("\n")) {
    const line = rawLine.trim();
    const match = /^\s*(?:[-*]\s*)?(?:Lunch Money\s+)?TXN\s+(\d+)\s*:?\s*(?:\$([0-9.,]+))?\s*(?:\((.*?)\))?\s*$/iu.exec(line);
    const id = match?.[1];
    if (!id) {
      continue;
    }
    transactions.push({
      id,
      amount: parseCurrency(match?.[2]),
      description: match?.[3]?.trim(),
      raw: line,
    });
  }
  return transactions;
}

function buildMerchantCandidates(input: {
  merchant?: string;
  vendor?: ResolvedReimbursementVendorConfig | null;
  receiptDir?: string;
  recipient?: string;
}): string[] {
  const candidates = new Set<string>();
  const push = (value: string | undefined) => {
    const normalized = normalizeKey(value);
    if (normalized) {
      candidates.add(normalized);
    }
  };

  push(input.merchant);
  push(input.vendor?.merchantName);
  push(input.vendor?.receiptDir);
  push(input.receiptDir);
  push(input.recipient);
  if (input.receiptDir && /^venmo$/iu.test(input.receiptDir)) {
    push("Venmo");
  }
  return [...candidates];
}

function historyMerchantMatches(record: RampReimbursementHistoryRecord, candidates: string[]): boolean {
  if (candidates.length === 0) {
    return true;
  }
  const merchant = normalizeKey(record.merchant);
  if (!merchant) {
    return false;
  }
  return candidates.some((candidate) =>
    merchant === candidate || merchant.includes(candidate) || candidate.includes(merchant)
  );
}

function parseBaseReceiptRecord(filePath: string, markdown: string): {
  title: string;
  noteName: string;
  receiptDir: string;
  reimbursement: ReceiptReimbursementState;
  hasReimbursementSection: boolean;
} {
  const noteName = buildNoteName(filePath);
  const receiptDir = noteName.split("/")[0] ?? path.basename(path.dirname(filePath));
  return {
    title: extractHeadingTitle(markdown, filePath),
    noteName,
    receiptDir,
    reimbursement: parseReimbursementState(markdown),
    hasReimbursementSection: extractReimbursementSection(markdown) != null,
  };
}

function parseVenmoReceiptRecord(filePath: string, markdown: string): UniversalReceiptRecord {
  const base = parseBaseReceiptRecord(filePath, markdown);
  const vendor = resolveVendorConfig(base.receiptDir) ?? resolveVendorConfig("Venmo");
  const recipient = extractBulletValue(markdown, ["Recipient", "Payee", "To"]);
  const total = parseCurrency(extractBulletValue(markdown, ["Total", "Amount"]));
  const merchant = recipient?.trim() || vendor?.merchantName || "Venmo";
  const categoryKey = vendor ? resolveCategoryKeyForVendor(loadReimbursementConfig(), vendor.key) : undefined;

  return {
    filePath,
    noteName: base.noteName,
    title: base.title,
    receiptDir: base.receiptDir,
    sourceType: "venmo",
    vendorKey: vendor?.key,
    merchant,
    date: extractDateValue(markdown),
    total,
    recipient,
    reimbursableAmount: base.reimbursement.amount ?? total,
    reimbursableItem: base.reimbursement.reimbursableItem ?? vendor?.reimbursableItem,
    categoryKey,
    defaultMemo: vendor?.defaultMemo,
    recurring: vendor?.recurring,
    typicalAmount: vendor?.typicalAmount,
    hasReimbursementSection: base.hasReimbursementSection,
    reimbursement: base.reimbursement,
  };
}

function parseGenericReceiptRecord(filePath: string, markdown: string): UniversalReceiptRecord {
  const base = parseBaseReceiptRecord(filePath, markdown);
  const merchantField = extractBulletValue(markdown, ["Merchant", "Merchant Name", "Payee", "Vendor", "Recipient"]);
  const titleMerchant = deriveMerchantFromTitle(base.title);
  const vendor =
    resolveVendorConfig(base.receiptDir)
    ?? resolveVendorConfig(merchantField)
    ?? resolveVendorConfig(titleMerchant);
  const merchant =
    merchantField?.trim()
    || titleMerchant
    || vendor?.merchantName
    || humanizeToken(base.receiptDir);
  const total = parseCurrency(extractBulletValue(markdown, ["Total", "Amount", "Charge", "Paid"]));
  const vendorKey = vendor?.key;
  const reimbursableAmount =
    base.reimbursement.amount
    ?? ((vendorKey === "walmart_tip" || /^walmart$/iu.test(base.receiptDir))
      ? parseWalmartTipAmount(markdown)
      : total ?? vendor?.typicalAmount);
  const categoryKey = vendor ? resolveCategoryKeyForVendor(loadReimbursementConfig(), vendor.key) : undefined;

  return {
    filePath,
    noteName: base.noteName,
    title: base.title,
    receiptDir: base.receiptDir,
    sourceType: "generic",
    vendorKey,
    merchant,
    date: extractDateValue(markdown),
    total,
    recipient: extractBulletValue(markdown, ["Recipient", "Payee", "To"]),
    reimbursableAmount,
    reimbursableItem: base.reimbursement.reimbursableItem ?? vendor?.reimbursableItem,
    categoryKey,
    defaultMemo: vendor?.defaultMemo,
    recurring: vendor?.recurring,
    typicalAmount: vendor?.typicalAmount,
    hasReimbursementSection: base.hasReimbursementSection,
    reimbursement: base.reimbursement,
  };
}

function parseReceiptRecord(filePath: string, markdown: string): UniversalReceiptRecord {
  const noteName = buildNoteName(filePath);
  const receiptDir = noteName.split("/")[0] ?? path.basename(path.dirname(filePath));
  if (/^venmo$/iu.test(receiptDir)) {
    return parseVenmoReceiptRecord(filePath, markdown);
  }
  return parseGenericReceiptRecord(filePath, markdown);
}

function walkReceiptMarkdownFiles(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const result: string[] = [];
  const visit = (dirPath: string): void => {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith(".")) {
        continue;
      }

      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "Evidence") {
          continue;
        }
        visit(fullPath);
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(".md")) {
        result.push(fullPath);
      }
    }
  };

  visit(rootDir);
  return result;
}

export function loadAllReceiptRecords(rootDir = resolveDefaultReceiptRoot()): UniversalReceiptRecord[] {
  return walkReceiptMarkdownFiles(rootDir)
    .map((filePath) => parseReceiptRecord(filePath, fs.readFileSync(filePath, "utf8")))
    .sort((left, right) =>
      `${right.date ?? ""}::${left.noteName}`.localeCompare(`${left.date ?? ""}::${right.noteName}`)
    );
}

export function lookupReceiptRecords(input: ReceiptLookupInput = {}): ReceiptLookupMatch[] {
  const transactionId = String(input.transactionId ?? "").trim();
  const date = input.date ? parseFlexibleDateToIso(input.date) ?? input.date.trim() : undefined;
  const merchantKey = normalizeKey(input.merchant);
  const queryTokens = normalizeKey(input.query)
    .split(/\s+/u)
    .filter((token) => token.length > 1);
  const maxResults = Math.max(1, Math.min(50, Math.trunc(input.maxResults ?? 10)));
  const hasFilters = Boolean(
    transactionId
      || input.amount != null
      || date
      || merchantKey
      || queryTokens.length > 0,
  );

  return loadAllReceiptRecords(input.rootDir)
    .map((record) => {
      const markdown = fs.readFileSync(record.filePath, "utf8");
      const fields = parseReceiptMetadataFields(markdown);
      const linkedTransactions = parseLinkedReceiptTransactions(markdown);
      const lineItems = parseReceiptLineItems(markdown);
      const categoryNotes = parseReceiptCategoryNotes(markdown);
      const normalizedHaystack = normalizeKey([
        record.title,
        record.noteName,
        record.receiptDir,
        record.merchant,
        ...Object.entries(fields).flatMap(([key, value]) => [key, value]),
        markdown,
      ].join(" "));

      if (transactionId && !linkedTransactions.some((transaction) => transaction.id === transactionId)) {
        return null;
      }
      if (date && record.date !== date) {
        return null;
      }
      if (input.amount != null) {
        const matchesAmount =
          amountsMatch(record.total, input.amount)
          || linkedTransactions.some((transaction) => amountsMatch(transaction.amount, input.amount));
        if (!matchesAmount) {
          return null;
        }
      }
      if (merchantKey && !normalizedHaystack.includes(merchantKey)) {
        return null;
      }
      if (queryTokens.length > 0 && !queryTokens.every((token) => normalizedHaystack.includes(token))) {
        return null;
      }

      let score = hasFilters ? 0 : 1;
      const reasons: string[] = [];
      if (transactionId) {
        score += 100;
        reasons.push("linked_transaction_id");
      }
      if (input.amount != null && amountsMatch(record.total, input.amount)) {
        score += 30;
        reasons.push("receipt_total");
      }
      if (
        input.amount != null
        && linkedTransactions.some((transaction) => amountsMatch(transaction.amount, input.amount))
      ) {
        score += 35;
        reasons.push("linked_transaction_amount");
      }
      if (date) {
        score += 20;
        reasons.push("receipt_date");
      }
      if (merchantKey) {
        score += 15;
        reasons.push("merchant_or_note_text");
      }
      if (queryTokens.length > 0) {
        score += 10;
        reasons.push("query_text");
      }
      if (!hasFilters) {
        reasons.push("recent_receipt");
      }

      return {
        score,
        reasons,
        record: {
          ...record,
          fields,
          linkedTransactions,
          lineItems,
          categoryNotes,
        },
      } satisfies ReceiptLookupMatch;
    })
    .filter((match): match is ReceiptLookupMatch => match !== null)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return `${right.record.date ?? ""}::${right.record.noteName}`
        .localeCompare(`${left.record.date ?? ""}::${left.record.noteName}`);
    })
    .slice(0, maxResults);
}

function isReimbursementCandidate(record: UniversalReceiptRecord): boolean {
  if (!record.vendorKey) {
    return false;
  }
  return record.reimbursableAmount != null && Number.isFinite(record.reimbursableAmount) && record.reimbursableAmount > 0;
}

function recordMatchesFilters(record: UniversalReceiptRecord, input: {
  since?: string;
  until?: string;
  vendor?: string;
}): boolean {
  if (input.vendor) {
    const resolvedVendor = resolveVendorConfig(input.vendor);
    const filterKey = resolvedVendor?.key ?? input.vendor;
    if (record.vendorKey !== filterKey) {
      return false;
    }
  }
  if (input.since && record.date && record.date < input.since) {
    return false;
  }
  if (input.until && record.date && record.date > input.until) {
    return false;
  }
  return true;
}

function buildVerifiedRecord(
  record: UniversalReceiptRecord,
  historyRecord: RampReimbursementHistoryRecord,
): UniversalReceiptRecord {
  const vendor = resolveVendorConfig(record.vendorKey ?? record.receiptDir) ?? resolveVendorConfig(record.merchant);
  return {
    ...record,
    reimbursement: {
      ...record.reimbursement,
      status: deriveReceiptStatusFromRampStatus(historyRecord.status),
      system: record.reimbursement.system ?? vendor?.system ?? loadReimbursementConfig().defaultSystem,
      reimbursableItem: record.reimbursement.reimbursableItem ?? record.reimbursableItem,
      amount: record.reimbursement.amount ?? record.reimbursableAmount ?? historyRecord.amount,
      submitted: historyRecord.submittedDate ?? record.reimbursement.submitted,
      note: historyRecord.memo ?? record.reimbursement.note ?? record.defaultMemo,
      rampReportId: historyRecord.rampReportId ?? record.reimbursement.rampReportId,
    },
  };
}

function reimbursementTrackingNeedsSync(
  current: UniversalReceiptRecord,
  verified: UniversalReceiptRecord,
): boolean {
  return normalizeStatus(current.reimbursement.status) !== normalizeStatus(verified.reimbursement.status)
    || current.reimbursement.system !== verified.reimbursement.system
    || current.reimbursement.reimbursableItem !== verified.reimbursement.reimbursableItem
    || !amountsMatch(current.reimbursement.amount, verified.reimbursement.amount)
    || current.reimbursement.submitted !== verified.reimbursement.submitted
    || current.reimbursement.note !== verified.reimbursement.note
    || current.reimbursement.rampReportId !== verified.reimbursement.rampReportId;
}

function clearStaleDraftTracking(record: UniversalReceiptRecord): UniversalReceiptRecord {
  if (normalizeStatus(record.reimbursement.status) !== "draft") {
    return record;
  }

  return {
    ...record,
    reimbursement: {
      ...record.reimbursement,
      status: "not_submitted",
      submitted: undefined,
      rampReportId: undefined,
    },
  };
}

function findBestHistoryMatch(
  record: UniversalReceiptRecord,
  history: RampReimbursementHistoryRecord[],
): RampReimbursementHistoryRecord | null {
  const merchantCandidates = buildMerchantCandidates({
    merchant: record.merchant,
    vendor: resolveVendorConfig(record.vendorKey ?? record.receiptDir) ?? resolveVendorConfig(record.merchant),
    receiptDir: record.receiptDir,
    recipient: record.recipient,
  });
  const preferredMemo = normalizeKey(record.reimbursement.note ?? record.defaultMemo);
  const datedMatches = history
    .filter((entry) => entry.transactionDate && record.date && entry.transactionDate === record.date)
    .filter((entry) => amountsMatch(entry.amount, record.reimbursableAmount))
    .filter((entry) => historyMerchantMatches(entry, merchantCandidates));

  if (datedMatches.length === 0) {
    return null;
  }

  return datedMatches
    .slice()
    .sort((left, right) => {
      const leftMemoMatch = normalizeKey(left.memo) === preferredMemo ? 1 : 0;
      const rightMemoMatch = normalizeKey(right.memo) === preferredMemo ? 1 : 0;
      if (leftMemoMatch !== rightMemoMatch) {
        return rightMemoMatch - leftMemoMatch;
      }

      const leftMerchantExact = merchantCandidates.includes(normalizeKey(left.merchant));
      const rightMerchantExact = merchantCandidates.includes(normalizeKey(right.merchant));
      if (leftMerchantExact !== rightMerchantExact) {
        return rightMerchantExact ? 1 : -1;
      }

      return `${right.submittedDate ?? ""}::${right.reviewUrl}`.localeCompare(
        `${left.submittedDate ?? ""}::${left.reviewUrl}`,
      );
    })[0] ?? null;
}

export function upsertReimbursementTracking(
  input: UpsertReimbursementTrackingInput,
): UniversalReceiptRecord {
  const filePath = path.resolve(input.notePath);
  const current = fs.readFileSync(filePath, "utf8");
  const currentRecord = parseReceiptRecord(filePath, current);
  const vendor =
    resolveVendorConfig(input.vendor)
    ?? resolveVendorConfig(currentRecord.vendorKey)
    ?? resolveVendorConfig(currentRecord.receiptDir)
    ?? resolveVendorConfig(currentRecord.merchant);
  const resolvedEvidencePath = input.evidencePath ?? currentRecord.reimbursement.evidencePath;
  const evidenceRecord = resolvedEvidencePath
    ? loadReimbursementEvidenceRecord(resolvedEvidencePath)
    : null;
  const nextState: ReceiptReimbursementState = {
    ...currentRecord.reimbursement,
    status: normalizeStatus(input.status),
    system: input.system ?? currentRecord.reimbursement.system ?? vendor?.system ?? loadReimbursementConfig().defaultSystem,
    reimbursableItem:
      input.reimbursableItem
      ?? currentRecord.reimbursement.reimbursableItem
      ?? currentRecord.reimbursableItem
      ?? vendor?.reimbursableItem,
    amount: input.amount ?? currentRecord.reimbursement.amount ?? currentRecord.reimbursableAmount,
    submitted: input.submitted ?? currentRecord.reimbursement.submitted,
    note: input.note ?? currentRecord.reimbursement.note ?? vendor?.defaultMemo,
    evidencePath: evidenceRecord?.archivedPath ?? resolvedEvidencePath,
    evidenceSourcePath: evidenceRecord?.sourcePath ?? currentRecord.reimbursement.evidenceSourcePath,
    evidenceSha256: evidenceRecord?.sha256 ?? currentRecord.reimbursement.evidenceSha256,
    evidenceImageWidth: evidenceRecord?.imageWidth ?? currentRecord.reimbursement.evidenceImageWidth,
    evidenceImageHeight: evidenceRecord?.imageHeight ?? currentRecord.reimbursement.evidenceImageHeight,
    evidenceCaptureMode: evidenceRecord?.captureMode ?? currentRecord.reimbursement.evidenceCaptureMode,
    evidenceDateVisible: evidenceRecord?.dateVisible ?? currentRecord.reimbursement.evidenceDateVisible,
    evidenceDateText:
      evidenceRecord?.visibleDateText?.join(", ") ?? currentRecord.reimbursement.evidenceDateText,
    rampReportId: input.rampReportId !== undefined
      ? input.rampReportId ?? undefined
      : evidenceRecord?.rampReportId ?? currentRecord.reimbursement.rampReportId,
    rampConfirmationPath:
      evidenceRecord?.rampConfirmationPath ?? currentRecord.reimbursement.rampConfirmationPath,
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

  updated = upsertReimbursementFrontmatter(updated, currentRecord, nextState);

  fs.writeFileSync(filePath, updated.endsWith("\n") ? updated : `${updated}\n`, "utf8");
  return parseReceiptRecord(filePath, fs.readFileSync(filePath, "utf8"));
}

export function checkSubmissionDedup(
  input: CheckSubmissionDedupInput,
): CheckSubmissionDedupResult {
  const notePath = input.notePath?.trim() ? path.resolve(input.notePath) : undefined;
  const currentRecord = notePath
    ? loadAllReceiptRecords().find((record) => path.resolve(record.filePath) === notePath)
    : undefined;
  const vendor =
    resolveVendorConfig(input.vendor)
    ?? resolveVendorConfig(currentRecord?.vendorKey)
    ?? resolveVendorConfig(currentRecord?.receiptDir)
    ?? resolveVendorConfig(input.merchant)
    ?? resolveVendorConfig(currentRecord?.merchant);
  const merchant = input.merchant?.trim() || currentRecord?.merchant || vendor?.merchantName;
  const amount = input.amount ?? currentRecord?.reimbursableAmount;
  const transactionDate = input.transactionDate ?? currentRecord?.date;
  const memo = input.memo?.trim() || currentRecord?.reimbursement.note || currentRecord?.defaultMemo;
  const merchantCandidates = buildMerchantCandidates({
    merchant,
    vendor,
    receiptDir: currentRecord?.receiptDir ?? vendor?.receiptDir,
    recipient: currentRecord?.recipient,
  });

  const localMatches = loadAllReceiptRecords()
    .filter((record) => !notePath || path.resolve(record.filePath) !== notePath)
    .filter((record) => transactionDate == null || record.date === transactionDate)
    .filter((record) => amount == null || amountsMatch(record.reimbursableAmount, amount))
    .filter((record) => historyMerchantMatches({ reviewUrl: "", merchant: record.merchant }, merchantCandidates))
    .filter((record) => hasCompletedReimbursementStatus(record.reimbursement.status));

  const historyMatches = (input.history ?? [])
    .filter((record) => transactionDate == null || record.transactionDate === transactionDate)
    .filter((record) => amount == null || amountsMatch(record.amount, amount))
    .filter((record) => historyMerchantMatches(record, merchantCandidates))
    .filter((record) => !memo || normalizeKey(record.memo) === normalizeKey(memo) || normalizeKey(record.memo).length === 0);

  const reasons: string[] = [];
  if (hasCompletedReimbursementStatus(currentRecord?.reimbursement.status)) {
    reasons.push("note_already_marked_submitted");
  }
  if (localMatches.length > 0) {
    reasons.push("matching_submitted_note");
  }
  if (historyMatches.length > 0) {
    reasons.push("matching_ramp_history");
  }

  return {
    basis: {
      notePath,
      vendorKey: vendor?.key ?? currentRecord?.vendorKey,
      merchant,
      amount,
      transactionDate,
      memo,
    },
    duplicate: reasons.length > 0,
    reasons,
    localMatches,
    historyMatches,
  };
}

export function reconcileUniversalReimbursements(
  input: ReconcileUniversalReimbursementsInput,
): ReconcileUniversalReimbursementsResult {
  const candidates = loadAllReceiptRecords()
    .filter(isReimbursementCandidate)
    .filter((record) => recordMatchesFilters(record, input));
  const remainingHistory = input.history
    .filter((record) => record.transactionDate != null && record.amount != null && Number.isFinite(record.amount))
    .filter((record) => !input.since || !record.transactionDate || record.transactionDate >= input.since)
    .filter((record) => !input.until || !record.transactionDate || record.transactionDate <= input.until);

  const records: UniversalReceiptRecord[] = [];
  const matched: UniversalRampReconciliationMatch[] = [];
  const pending: UniversalReceiptRecord[] = [];
  const unverifiedSubmitted: UniversalReceiptRecord[] = [];
  const updated: UniversalReceiptRecord[] = [];

  for (const candidate of candidates) {
    const match = findBestHistoryMatch(candidate, remainingHistory);
    if (!match) {
      const verifiedPending = clearStaleDraftTracking(candidate);
      const shouldSync = reimbursementTrackingNeedsSync(candidate, verifiedPending);
      const reconciled =
        input.updateNotes === true && shouldSync
          ? upsertReimbursementTracking({
              notePath: candidate.filePath,
              vendor: candidate.vendorKey,
              status: verifiedPending.reimbursement.status ?? "not_submitted",
              system: verifiedPending.reimbursement.system,
              reimbursableItem: verifiedPending.reimbursement.reimbursableItem,
              amount: verifiedPending.reimbursement.amount,
              submitted: verifiedPending.reimbursement.submitted,
              note: verifiedPending.reimbursement.note,
              rampReportId: verifiedPending.reimbursement.rampReportId ?? null,
            })
          : verifiedPending;

      records.push(reconciled);
      if (hasCompletedReimbursementStatus(candidate.reimbursement.status)) {
        unverifiedSubmitted.push(candidate);
      } else if (input.includeSubmitted !== true) {
        pending.push(reconciled);
      }
      if (input.updateNotes === true && shouldSync) {
        updated.push(reconciled);
      }
      continue;
    }

    const historyIndex = remainingHistory.findIndex((entry) => entry.reviewUrl === match.reviewUrl);
    if (historyIndex >= 0) {
      remainingHistory.splice(historyIndex, 1);
    }

    const verified = buildVerifiedRecord(candidate, match);
    const shouldSync = reimbursementTrackingNeedsSync(candidate, verified);
    const reconciled =
      input.updateNotes === true && shouldSync
        ? upsertReimbursementTracking({
            notePath: candidate.filePath,
            vendor: candidate.vendorKey,
            status: verified.reimbursement.status ?? "submitted",
            system: verified.reimbursement.system,
            reimbursableItem: verified.reimbursement.reimbursableItem,
            amount: verified.reimbursement.amount,
            submitted: verified.reimbursement.submitted,
            note: verified.reimbursement.note,
            rampReportId: verified.reimbursement.rampReportId,
          })
        : verified;

    records.push(reconciled);
    if (input.updateNotes === true && shouldSync) {
      updated.push(reconciled);
    }
    matched.push({
      vendorKey: candidate.vendorKey,
      merchant: candidate.merchant,
      notePath: candidate.filePath,
      noteName: candidate.noteName,
      amount: candidate.reimbursableAmount,
      transactionDate: match.transactionDate,
      submittedDate: match.submittedDate,
      noteStatusBefore: candidate.reimbursement.status,
      noteStatusAfter: reconciled.reimbursement.status ?? "submitted",
      rampStatus: match.status,
      rampReportId: match.rampReportId,
      reviewUrl: match.reviewUrl,
      memo: match.memo,
    });
  }

  return {
    records,
    matched,
    pending,
    unverifiedSubmitted,
    updated,
    notesExamined: candidates.length,
    historyEntriesExamined: input.history.length,
  };
}

export function listReimbursementCandidates(
  input: ListReimbursementCandidatesInput = {},
): UniversalReceiptRecord[] {
  if (input.history) {
    const reconciled = reconcileUniversalReimbursements({
      history: input.history,
      since: input.since,
      until: input.until,
      vendor: input.vendor,
      includeSubmitted: input.includeSubmitted,
      updateNotes: false,
    });
    return input.includeSubmitted ? reconciled.records : reconciled.pending;
  }

  return loadAllReceiptRecords()
    .filter(isReimbursementCandidate)
    .filter((record) => recordMatchesFilters(record, input))
    .filter((record) => {
      if (input.includeSubmitted) {
        return true;
      }
      return !hasCompletedReimbursementStatus(record.reimbursement.status);
    });
}

function resolveLedgerRecords(input: {
  month?: string;
  since?: string;
  until?: string;
  vendor?: string;
  history?: RampReimbursementHistoryRecord[];
}): UniversalReceiptRecord[] {
  const month = input.month?.trim();
  const since = month ? `${month}-01` : input.since;
  const until = month ? `${month}-31` : input.until;

  return input.history
    ? reconcileUniversalReimbursements({
        history: input.history,
        since,
        until,
        vendor: input.vendor,
        includeSubmitted: true,
        updateNotes: false,
      }).records
    : listReimbursementCandidates({
        since,
        until,
        vendor: input.vendor,
        includeSubmitted: true,
      });
}

export function generateMonthlyLedger(input: {
  month?: string;
  since?: string;
  until?: string;
  vendor?: string;
  history?: RampReimbursementHistoryRecord[];
} = {}): MonthlyLedgerResult {
  const month = input.month?.trim() || CURRENT_MONTH_KEY;
  const records = resolveLedgerRecords({
    ...input,
    month,
  }).filter((record) => !record.date || record.date.startsWith(month));

  const entryMap = new Map<string, MonthlyLedgerEntry>();
  const items: MonthlyLedgerItem[] = [];
  let all = 0;
  let submitted = 0;
  let reimbursed = 0;
  let pending = 0;

  for (const record of records) {
    const amount = record.reimbursement.amount ?? record.reimbursableAmount;
    if (amount != null) {
      all += amount;
    }

    const status = record.reimbursement.status ?? "not_submitted";
    if (amount != null && status === "submitted") {
      submitted += amount;
    }
    if (amount != null && status === "reimbursed") {
      reimbursed += amount;
    }
    if (amount != null && !hasCompletedReimbursementStatus(status)) {
      pending += amount;
    }

    items.push({
      date: record.date,
      vendorKey: record.vendorKey,
      merchant: record.merchant,
      notePath: record.filePath,
      amount,
      status,
      memo: record.reimbursement.note ?? record.defaultMemo,
      categoryKey: record.categoryKey,
    });

    const entryKey = [
      month,
      record.vendorKey ?? "_unknown",
      record.categoryKey ?? "_uncategorized",
      status,
    ].join("::");
    const existing = entryMap.get(entryKey);
    if (existing) {
      existing.count += 1;
      existing.total += amount ?? 0;
      continue;
    }
    entryMap.set(entryKey, {
      month,
      vendorKey: record.vendorKey,
      merchant: record.merchant,
      categoryKey: record.categoryKey,
      status,
      count: 1,
      total: amount ?? 0,
      memo: record.reimbursement.note ?? record.defaultMemo,
    });
  }

  return {
    month,
    entries: [...entryMap.values()].sort((left, right) =>
      `${left.vendorKey ?? ""}::${left.status}`.localeCompare(`${right.vendorKey ?? ""}::${right.status}`)
    ),
    items: items.sort((left, right) =>
      `${right.date ?? ""}::${right.notePath}`.localeCompare(`${left.date ?? ""}::${left.notePath}`)
    ),
    totals: {
      all,
      submitted,
      reimbursed,
      pending,
    },
  };
}

function buildMonthKeys(input: { since?: string; until?: string; lookbackMonths?: number }): string[] {
  if (input.since || input.until) {
    const start = new Date(`${(input.since ?? `${CURRENT_MONTH_KEY}-01`).slice(0, 7)}-01T00:00:00.000Z`);
    const end = new Date(`${(input.until ?? `${CURRENT_MONTH_KEY}-31`).slice(0, 7)}-01T00:00:00.000Z`);
    const months: string[] = [];
    const cursor = new Date(start.getTime());
    while (cursor <= end) {
      months.push(cursor.toISOString().slice(0, 7));
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    return months;
  }

  const lookbackMonths = Math.max(1, input.lookbackMonths ?? 3);
  const base = new Date(`${CURRENT_MONTH_KEY}-01T00:00:00.000Z`);
  const months: string[] = [];
  for (let offset = lookbackMonths - 1; offset >= 0; offset -= 1) {
    const monthDate = new Date(base.getTime());
    monthDate.setUTCMonth(monthDate.getUTCMonth() - offset);
    months.push(monthDate.toISOString().slice(0, 7));
  }
  return months;
}

export function detectReimbursementGaps(
  input: DetectReimbursementGapsInput = {},
): DetectReimbursementGapsResult {
  const gaps: ReimbursementGap[] = [];
  const records = input.history
    ? reconcileUniversalReimbursements({
        history: input.history,
        since: input.since,
        until: input.until,
        vendor: input.vendor,
        includeSubmitted: true,
        updateNotes: false,
      }).records
    : loadAllReceiptRecords(input.rootDir)
        .filter(isReimbursementCandidate)
        .filter((record) => recordMatchesFilters(record, input));

  const config = loadReimbursementConfig();
  const monthKeys = buildMonthKeys(input);

  for (const record of records) {
    if (!record.hasReimbursementSection) {
      gaps.push({
        type: "missing_tracking_section",
        vendorKey: record.vendorKey,
        merchant: record.merchant,
        notePath: record.filePath,
        detail: "Configured reimbursement receipt is missing the reimbursement tracking block.",
      });
    }
    if (normalizeStatus(record.reimbursement.status) === "submitted" && !record.reimbursement.rampReportId) {
      gaps.push({
        type: "stale_tracking",
        vendorKey: record.vendorKey,
        merchant: record.merchant,
        notePath: record.filePath,
        amount: record.reimbursement.amount ?? record.reimbursableAmount,
        detail: "Receipt is marked submitted but is missing the Ramp report id.",
      });
    }
    if (!record.date) {
      gaps.push({
        type: "missing_date",
        vendorKey: record.vendorKey,
        merchant: record.merchant,
        notePath: record.filePath,
        detail: "Receipt note is missing a parseable transaction date.",
      });
    }
    if (record.reimbursableAmount == null) {
      gaps.push({
        type: "missing_amount",
        vendorKey: record.vendorKey,
        merchant: record.merchant,
        notePath: record.filePath,
        detail: "Receipt note is missing a parseable reimbursable amount.",
      });
    }
    if (record.typicalAmount != null && record.reimbursableAmount != null) {
      const threshold = Math.max(25, record.typicalAmount * 0.1);
      if (Math.abs(record.reimbursableAmount - record.typicalAmount) > threshold) {
        gaps.push({
          type: "amount_outlier",
          vendorKey: record.vendorKey,
          merchant: record.merchant,
          notePath: record.filePath,
          amount: record.reimbursableAmount,
          expectedAmount: record.typicalAmount,
          detail: "Reimbursable amount is materially different from the configured typical amount.",
        });
      }
    }
  }

  const recurringVendorKeys = Object.entries(config.vendors)
    .filter(([, vendor]) => vendor.recurring === true)
    .map(([key]) => key)
    .filter((key) => !input.vendor || resolveVendorConfig(input.vendor)?.key === key || input.vendor === key);

  for (const vendorKey of recurringVendorKeys) {
    const vendorRecords = records.filter((record) => record.vendorKey === vendorKey);
    const monthsWithRecords = new Set(
      vendorRecords
        .map((record) => record.date?.slice(0, 7))
        .filter((value): value is string => Boolean(value)),
    );

    for (const month of monthKeys) {
      if (monthsWithRecords.has(month)) {
        continue;
      }
      const vendor = resolveVendorConfig(vendorKey);
      gaps.push({
        type: "missing_recurring_receipt",
        vendorKey,
        merchant: vendor?.merchantName,
        month,
        expectedAmount: vendor?.typicalAmount,
        detail: "Recurring reimbursement vendor has no receipt note for this month.",
      });
    }
  }

  const summary: Record<string, number> = {};
  for (const gap of gaps) {
    summary[gap.type] = (summary[gap.type] ?? 0) + 1;
  }

  return {
    gaps,
    summary: {
      total: gaps.length,
      byType: summary,
    },
  };
}
