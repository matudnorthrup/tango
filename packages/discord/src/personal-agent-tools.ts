/**
 * Personal Agent Tools — Tool definitions for Watson (personal assistant) worker agents.
 *
 * Tools:
 *   - gog_email: Gmail operations via gog CLI
 *   - system_clock: Current local date/time lookup
 *   - gog_calendar: Google Calendar operations via gog CLI
 *   - obsidian: Obsidian vault operations via obsidian-cli
 *   - health_morning: Morning health briefing via health-query script
 *   - lunch_money: Lunch Money REST API for finance
 *   - imessage: iMessage read/send via imsg CLI
 */

import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { AgentTool } from "@tango/core";
import { getBrowserManager } from "./browser-manager.js";
import { getSecret } from "./op-secret.js";
import {
  backfillWalmartReceiptNote,
  findWalmartReceiptRecord,
  listWalmartDeliveryCandidates,
  reconcileWalmartReimbursementsAgainstRamp,
  upsertWalmartReimbursementTracking,
} from "./receipt-reimbursement-registry.js";
import {
  checkSubmissionDedup,
  detectReimbursementGaps,
  generateMonthlyLedger,
  listReimbursementCandidates,
  reconcileUniversalReimbursements,
  resolveDefaultMemo,
  resolveVendorConfig,
  upsertReimbursementTracking,
} from "./receipt-universal-registry.js";
import { executeGoogleDocTabUpdate } from "./google-doc-update-executor.js";
import { loadReimbursementEvidenceRecord } from "./reimbursement-evidence.js";
import { extractRampReimbursementIdFromUrl } from "./reimbursement-automation.js";

// ---------------------------------------------------------------------------
// Command runner (shared)
// ---------------------------------------------------------------------------

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function execCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  env?: Record<string, string>,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: env ? { ...process.env, ...env } : undefined,
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 2000).unref();
    }, timeoutMs);
    timer.unref();

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.stdin.end();
  });
}

async function runCommand(
  command: string,
  args: string[],
  timeoutMs = 30_000,
  env?: Record<string, string>,
): Promise<string> {
  const result = await execCommand(command, args, timeoutMs, env);
  if (result.code !== 0 && result.stderr) {
    return `Error (exit ${result.code}): ${result.stderr.trim()}\n${result.stdout.trim()}`.trim();
  }
  return result.stdout.trim();
}

async function runRequiredCommand(
  command: string,
  args: string[],
  timeoutMs = 30_000,
  env?: Record<string, string>,
): Promise<string> {
  const result = await execCommand(command, args, timeoutMs, env);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export interface PersonalToolPaths {
  gogCommand?: string;
  obsidianCliCommand?: string;
  healthScript?: string;
  imsgCommand?: string;
}

function resolvePaths(overrides?: PersonalToolPaths) {
  const home = os.homedir();
  return {
    gogCommand: overrides?.gogCommand ?? "/opt/homebrew/bin/gog",
    obsidianCliCommand: overrides?.obsidianCliCommand ?? "/opt/homebrew/bin/obsidian-cli",
    healthScript:
      overrides?.healthScript
      ?? process.env.TANGO_HEALTH_QUERY_SCRIPT?.trim()
      ?? path.join(home, ".tango", "bin", "health-query.js"),
    imsgCommand: overrides?.imsgCommand ?? "/opt/homebrew/bin/imsg",
  };
}

// ---------------------------------------------------------------------------
// Email tools
// ---------------------------------------------------------------------------

export function createEmailTools(overrides?: PersonalToolPaths): AgentTool[] {
  const paths = resolvePaths(overrides);

  return [
    {
      name: "gog_email",
      description: [
        "Run Gmail operations via the gog CLI. Supports search, message fetch, attachment download, thread fetch, archive, and draft creation.",
        "",
        "Commands:",
        "  gog gmail messages search '<query>' [--max N] [--account <email>]",
        "    Search Gmail. Query uses Gmail syntax: from:, to:, subject:, is:unread, newer_than:1d, etc.",
        "    Accounts are installation-specific. Common patterns are personal@example.com and work@example.com.",
        "",
        "  gog gmail get <messageId> --format full [--account <email>]",
        "    Fetch a specific message with body text and attachment metadata.",
        "",
        "  gog gmail attachment <messageId> <attachmentId> --out /tmp --name '<filename>' [--account <email>]",
        "    Download a specific attachment to a real local file path for use as evidence in another tool.",
        "",
        "  gog gmail thread <thread_id> [--account <email>]",
        "    Fetch full thread conversation by ID.",
        "",
        "  gog gmail thread modify <thread_id> --remove INBOX [--account <email>]",
        "    Archive a thread (remove from inbox).",
        "",
        "  gog gmail drafts create --to <email> --subject '<subject>' --body '<body>' [--reply-to-message-id <id>] [--account <email>]",
        "    Create a draft email. Use --reply-to-message-id to reply to an existing thread.",
        "",
        "  gog gmail messages list [--max N] [--account <email>]",
        "    List recent inbox messages.",
        "",
        "Output: JSON. Message/thread objects include from, to, subject, body, date, and attachment metadata when present.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Full gog gmail command (everything after 'gog'). Example: \"gmail messages search 'is:unread newer_than:1d' --max 20\"",
          },
        },
        required: ["command"],
      },
      handler: async (input) => {
        const cmdStr = String(input.command).trim();
        // Parse the command string into args, respecting quotes
        const args = parseShellArgs(cmdStr);
        const stdout = await runCommand(paths.gogCommand, args, 60_000);
        return { result: stdout };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// System clock tools
// ---------------------------------------------------------------------------

export function createSystemClockTools(): AgentTool[] {
  return [
    {
      name: "system_clock",
      description: [
        "Read the current local date and time from the runtime.",
        "",
        "Use this for questions like:",
        '  - "What time is it?"',
        '  - "What day is it today?"',
        '  - "What time is it in New York?"',
        "",
        "Returns structured local date/time strings plus the current UTC ISO timestamp.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          timezone: {
            type: "string",
            description: "Optional IANA timezone like America/Los_Angeles or America/New_York.",
          },
        },
      },
      handler: async (input) => {
        const requestedTimeZone =
          typeof input.timezone === "string" && input.timezone.trim().length > 0
            ? input.timezone.trim()
            : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

        try {
          const now = new Date();
          const date = new Intl.DateTimeFormat("en-CA", {
            timeZone: requestedTimeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(now);
          const time = new Intl.DateTimeFormat("en-US", {
            timeZone: requestedTimeZone,
            hour: "numeric",
            minute: "2-digit",
            timeZoneName: "short",
          }).format(now);

          return {
            now: {
              iso: now.toISOString(),
              timeZone: requestedTimeZone,
              date,
              time,
              dateTime: `${date} ${time}`,
            },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            error: `Invalid timezone: ${requestedTimeZone}. ${message}`,
          };
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Calendar tools
// ---------------------------------------------------------------------------

export function createCalendarTools(overrides?: PersonalToolPaths): AgentTool[] {
  const paths = resolvePaths(overrides);

  return [
    {
      name: "gog_calendar",
      description: [
        "Run Google Calendar operations via the gog CLI.",
        "",
        "Commands:",
        "  gog calendar events [--today] [--all] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--days N] [--max N] [--account <email>] [--json]",
        "    List calendar events. Use --today for today, --days 7 for next week, or --from/--to for ranges.",
        "    IMPORTANT: --to is EXCLUSIVE — for a single day, use --today or set --to to the NEXT day.",
        "    Use --all to include all calendars (not just primary). Use --json for structured output.",
        "    Accounts are installation-specific. Common patterns are personal@example.com and work@example.com.",
        "",
        "  gog calendar create --title '<title>' --start '<ISO datetime>' --end '<ISO datetime>' [--description '<desc>'] [--account <email>]",
        "    Create a calendar event.",
        "",
        "Output: JSON with event details (summary, start, end, location, attendees).",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Full gog calendar command (everything after 'gog'). Example: \"calendar events --today --all --json\"",
          },
        },
        required: ["command"],
      },
      handler: async (input) => {
        const cmdStr = String(input.command).trim();
        const args = parseShellArgs(cmdStr);
        const stdout = await runCommand(paths.gogCommand, args, 30_000);
        return { result: stdout };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Obsidian tools
// ---------------------------------------------------------------------------

export function createObsidianTools(overrides?: PersonalToolPaths): AgentTool[] {
  const paths = resolvePaths(overrides);

  return [
    {
      name: "obsidian",
      description: [
        "Obsidian vault operations via obsidian-cli against the configured vault for this installation.",
        "Always include the active vault name in commands.",
        "",
        "Commands:",
        "  print '<note name>' --vault main",
        "    Read a note's full content (markdown with YAML frontmatter).",
        "    Note name is the display name, not file path (e.g. '3D Printing Setup', '2026 Week 10 Plan').",
        "",
        "  search-content '<term>' --vault main",
        "    Search note contents for a term.",
        "",
        "  create '<note name>' --vault main [--append] [--overwrite]",
        "    Create a new note or update an existing one. NEVER create new folders.",
        "    Pass note body via the separate 'content' parameter (NOT --content in the command string).",
        "    --append            Append to existing note instead of failing if it exists.",
        "    --overwrite         Replace existing note content. REQUIRED when updating an existing note.",
        "    For daily notes: create 'Planning/Daily/YYYY-MM-DD' --vault main --overwrite",
        "",
        "  frontmatter '<note name>' --vault main --edit --key '<key>' --value '<value>'",
        "    Modify a single frontmatter key. Also supports --print and --delete --key '<key>'.",
        "",
        "  move '<source>' '<dest>' --vault main",
        "    Move/rename a note.",
        "",
        "For bulk search/read, use shell commands against the configured notes root directly.",
        "",
        "Conventions:",
        "  Frontmatter: date, areas, types (always required for new notes)",
        "  Areas are installation-specific. Common examples: Family, Health, Home, Personal, Projects, Travel, Work.",
        "  Tappable links depend on the local note-link service for this installation",
        "  Task format: - [ ] Task description—YYYY-MM-DD (em-dash + date)",
        "  Key folders: Planning/ (Daily/Weekly), Records/ (Health Daily, Nutrition, Finance), References/",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "CLI command (everything after 'obsidian-cli'). For writes, omit --content here and use the 'content' parameter instead. Example: \"create 'Planning/Daily/2026-03-13' --vault main --overwrite\"",
          },
          content: {
            type: "string",
            description: "Note body text (markdown). Used with create command — passed directly to obsidian-cli, bypassing shell quoting issues. Always use this instead of --content in the command string.",
          },
        },
        required: ["command"],
      },
      handler: async (input) => {
        const cmdStr = String(input.command).trim();
        const args = parseShellArgs(cmdStr);

        if (input.content != null) {
          args.push("--content", String(input.content));
        }

        const stdout = await runCommand(paths.obsidianCliCommand, args, 30_000);
        return { result: stdout };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Health morning briefing
// ---------------------------------------------------------------------------

export function createHealthBriefingTools(overrides?: PersonalToolPaths): AgentTool[] {
  const paths = resolvePaths(overrides);

  return [
    {
      name: "health_morning",
      description: [
        "Get the morning health briefing — sleep, recovery (HRV, RHR), and today's activity.",
        "Calls health-query.js --morning. Returns JSON with sleep hours, HRV, RHR, steps, exercise.",
        "",
        "Health baselines:",
        "  RHR: normal 46-48 bpm, good 40-43 bpm",
        "  HRV: normal 35-40ms, good 47-55ms",
        "  Steps: normal 8-10k, good 15k+",
        "  Sleep: normal 6-7h, good 8h+",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["morning", "recovery", "checkin", "trend"],
            description: "Query mode: morning (default), recovery, checkin, or trend",
          },
          days: {
            type: "number",
            description: "For trend mode: number of days (default 7)",
          },
          date: {
            type: "string",
            description: "Specific date in YYYY-MM-DD format (optional)",
          },
        },
      },
      handler: async (input) => {
        const mode = String(input.mode ?? "morning");
        const args: string[] = [`--${mode}`];
        if (mode === "trend" && typeof input.days === "number") {
          args.push(String(Math.round(input.days)));
        }
        if (input.date) {
          args.push("--date", String(input.date));
        }
        const stdout = await runCommand(process.execPath, [paths.healthScript, ...args], 60_000);
        try {
          return JSON.parse(stdout);
        } catch {
          return { result: stdout };
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Lunch Money API
// ---------------------------------------------------------------------------

export function createFinanceTools(overrides?: PersonalToolPaths): AgentTool[] {
  const paths = resolvePaths(overrides);

  let cachedApiKey: string | null = null;
  async function getApiKey(): Promise<string> {
    if (!cachedApiKey) {
      // Prefer env var — op CLI hangs on macOS when desktop app integration is active
      const envKey = process.env.LUNCH_MONEY_ACCESS_TOKEN;
      if (envKey) {
        cachedApiKey = envKey;
      } else {
        const opKey = await getSecret("Watson", "Lunch Money API Key");
        if (!opKey) throw new Error("Lunch Money API key not found. Set LUNCH_MONEY_ACCESS_TOKEN in .env or add 'Lunch Money API Key' to Watson vault in 1Password.");
        cachedApiKey = opKey;
      }
    }
    return cachedApiKey;
  }

  return [
    {
      name: "lunch_money",
      description: [
        "Lunch Money REST API for personal finance — transactions, categories, and budgets.",
        "Base URL: https://dev.lunchmoney.app/v1",
        "",
        "Common endpoints:",
        "  GET /transactions?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD — list transactions",
        "  GET /transactions?status=unreviewed — uncategorized transactions",
        "  PUT /transactions/:id — update transaction (body: {\"transaction\": {\"category_id\": N, \"notes\": \"...\"}})",
        "  POST /transactions/:id/group — split transaction",
        "  GET /categories — list all categories with IDs",
        "  GET /budgets?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD — budget summaries",
        "",
        "Notes:",
        "  - Split amounts are DOLLAR STRINGS, not cents",
        "  - Updates require {\"transaction\": {...}} wrapper",
        "  - Rate limit: ~0.3s between calls",
        "  - Rules reference: use the installation's active finance rules note or profile override",
        "  - This environment does not expose a working recurring-items endpoint; verify recurring transfers/subscriptions from transactions instead.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          method: {
            type: "string",
            enum: ["GET", "PUT", "POST", "DELETE"],
            description: "HTTP method",
          },
          endpoint: {
            type: "string",
            description: "API endpoint path (e.g. '/transactions?start_date=2026-03-01&end_date=2026-03-09')",
          },
          body: {
            type: "object",
            description: "Request body for PUT/POST requests (optional)",
          },
        },
        required: ["method", "endpoint"],
      },
      handler: async (input) => {
        const method = String(input.method ?? "GET").toUpperCase();
        const endpoint = String(input.endpoint);
        const url = new URL(`https://dev.lunchmoney.app/v1${endpoint.startsWith("/") ? endpoint : "/" + endpoint}`);

        const isTransactionsCollectionRequest =
          method === "GET" &&
          url.pathname.startsWith("/v1/transactions") &&
          !/^\/v1\/transactions\/\d+(?:\/|$)/.test(url.pathname);

        if (isTransactionsCollectionRequest) {
          const hasStartDate = url.searchParams.has("start_date");
          const hasEndDate = url.searchParams.has("end_date");

          if (!hasStartDate || !hasEndDate) {
            const endDate = currentLocalIsoDate();
            const [yearText = "0", monthText = "1", dayText = "1"] = endDate.split("-");
            const startDateValue = new Date(Number(yearText), Number(monthText) - 1, Number(dayText));
            startDateValue.setDate(startDateValue.getDate() - 14);
            const startDate = [
              String(startDateValue.getFullYear()),
              String(startDateValue.getMonth() + 1).padStart(2, "0"),
              String(startDateValue.getDate()).padStart(2, "0"),
            ].join("-");

            if (!hasStartDate) {
              url.searchParams.set("start_date", startDate);
            }
            if (!hasEndDate) {
              url.searchParams.set("end_date", endDate);
            }
          }
        }

        const headers: Record<string, string> = {
          Authorization: `Bearer ${await getApiKey()}`,
          "Content-Type": "application/json",
        };

        const fetchOptions: RequestInit = { method, headers };
        if (input.body && (method === "PUT" || method === "POST")) {
          fetchOptions.body = JSON.stringify(input.body);
        }

        const response = await fetch(url, fetchOptions);
        const text = await response.text();

        if (!response.ok) {
          return { error: `HTTP ${response.status}: ${text}` };
        }

        try {
          return JSON.parse(text);
        } catch {
          return { result: text };
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Receipt reimbursement tracking
// ---------------------------------------------------------------------------

function currentLocalIsoDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function syncWalmartTrackingFromRampEvidence(input: {
  evidencePath: string;
  status: string;
  amount?: number;
  submitted?: string;
  note?: string;
  rampReportId?: string;
}): void {
  const evidenceRecord = loadReimbursementEvidenceRecord(input.evidencePath);
  const orderId = evidenceRecord?.orderId?.trim();
  if (!orderId) {
    return;
  }

  const existing = findWalmartReceiptRecord(orderId);
  if (!existing) {
    return;
  }
  const existingStatus = existing?.reimbursement.status?.trim().toLowerCase();
  const nextStatus = existingStatus === "reimbursed" ? "reimbursed" : input.status;
  upsertWalmartReimbursementTracking({
    orderId,
    status: nextStatus,
    system: "Ramp",
    reimbursableItem: "Driver tip",
    amount: input.amount,
    submitted: input.submitted,
    note: input.note,
    evidencePath: input.evidencePath,
    rampReportId: input.rampReportId,
  });
}

export function createReceiptRegistryTools(): AgentTool[] {
  return [
    {
      name: "receipt_registry",
      description: [
        "Structured receipt and reimbursement tracking for cataloged Obsidian receipt notes.",
        "",
        "Actions:",
        "  list_walmart_delivery_candidates",
        "    List Walmart receipt notes that include a delivery driver tip and are still missing reimbursement submission state.",
        "    By default this verifies the candidate list against live Ramp reimbursement history before returning anything as pending.",
        "    Optional params: since (YYYY-MM-DD), until (YYYY-MM-DD), include_submitted (boolean), verify_with_ramp (boolean), max_pages (number).",
        "",
        "  backfill_walmart_delivery_candidates",
        "    Scan live Walmart purchase history for delivery-from-store orders with driver tips, create missing receipt notes,",
        "    and return the pending reimbursement candidates Watson can file next.",
        "    Optional params: since (YYYY-MM-DD), until (YYYY-MM-DD), include_submitted (boolean), verify_with_ramp (boolean), max_pages (number).",
        "",
        "  reconcile_walmart_reimbursements",
        "    Verify Walmart tip notes against live Ramp reimbursement history and update stale note status fields in place.",
        "    Optional params: since (YYYY-MM-DD), until (YYYY-MM-DD), max_pages (number).",
        "",
        "  upsert_walmart_reimbursement",
        "    Create or update the standardized reimbursement tracking block inside a Walmart receipt note.",
        "    Provide either note_path or order_id, plus status.",
        "",
        "  check_submission_dedup",
        "    Check whether a reimbursement note or proposed submission already appears in local receipt notes or live Ramp history.",
        "    Optional params: note_path, vendor, merchant, amount, transaction_date, memo, verify_with_ramp (boolean), max_pages (number).",
        "",
        "  list_reimbursement_candidates",
        "    List configured reimbursement candidates across receipt folders using the universal reimbursement config.",
        "    Optional params: since, until, vendor, include_submitted, verify_with_ramp, max_pages.",
        "",
        "  reconcile_reimbursements",
        "    Verify configured reimbursement notes against live Ramp history and update stale tracking blocks in place.",
        "    Optional params: since, until, vendor, max_pages.",
        "",
        "  upsert_reimbursement",
        "    Create or update the standardized reimbursement tracking block inside any receipt note.",
        "    Requires note_path and status. Optional params: vendor, system, reimbursable_item, amount, submitted, note, evidence_path, ramp_report_id.",
        "",
        "  generate_monthly_ledger",
        "    Build a reimbursement ledger for a month or date range, grouped by vendor/category/status.",
        "    Optional params: month (YYYY-MM), since, until, vendor, verify_with_ramp, max_pages.",
        "",
        "  detect_gaps",
        "    Detect missing tracking blocks, stale submitted notes, missing recurring receipts, and other reimbursement coverage gaps.",
        "    Optional params: since, until, vendor, lookback_months, verify_with_ramp, max_pages.",
        "",
        "Tracking block fields:",
        "  status, system, reimbursable item, amount, submitted, note, evidence path, evidence provenance, Ramp report id",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "list_walmart_delivery_candidates",
              "backfill_walmart_delivery_candidates",
              "reconcile_walmart_reimbursements",
              "upsert_walmart_reimbursement",
              "check_submission_dedup",
              "list_reimbursement_candidates",
              "reconcile_reimbursements",
              "upsert_reimbursement",
              "generate_monthly_ledger",
              "detect_gaps",
            ],
            description: "Receipt-registry action to perform.",
          },
          since: {
            type: "string",
            description: "For list/backfill/reconcile actions: optional lower date bound in YYYY-MM-DD format.",
          },
          until: {
            type: "string",
            description: "For list/backfill/reconcile actions: optional upper date bound in YYYY-MM-DD format.",
          },
          include_submitted: {
            type: "boolean",
            description: "For list/backfill actions: include already-submitted or reimbursed notes.",
          },
          verify_with_ramp: {
            type: "boolean",
            description: "For list/backfill actions: verify note state against live Ramp history before claiming anything is pending. Defaults to true.",
          },
          max_pages: {
            type: "number",
            description: "For backfill/list/reconcile actions: maximum history pages to scan (default 8 for Walmart, 3 for Ramp).",
          },
          vendor: {
            type: "string",
            description: "For universal reimbursement actions: configured vendor key, receipt directory, or merchant alias from reimbursement-config.yaml.",
          },
          merchant: {
            type: "string",
            description: "For check_submission_dedup: merchant or payee name when note_path is omitted.",
          },
          transaction_date: {
            type: "string",
            description: "For check_submission_dedup: transaction date in YYYY-MM-DD format when note_path is omitted.",
          },
          month: {
            type: "string",
            description: "For generate_monthly_ledger: optional month in YYYY-MM format.",
          },
          lookback_months: {
            type: "number",
            description: "For detect_gaps: recurring-receipt lookback window when since/until are omitted. Defaults to 3.",
          },
          note_path: {
            type: "string",
            description: "For upsert_walmart_reimbursement, upsert_reimbursement, or check_submission_dedup: absolute note path.",
          },
          order_id: {
            type: "string",
            description: "For upsert_walmart_reimbursement: Walmart order id if note_path is omitted.",
          },
          status: {
            type: "string",
            description: "For upsert_walmart_reimbursement: tracking status such as submitted, reimbursed, skipped, or not_submitted.",
          },
          system: {
            type: "string",
            description: "For upsert_walmart_reimbursement: reimbursement system name, e.g. Ramp.",
          },
          reimbursable_item: {
            type: "string",
            description: "For upsert_walmart_reimbursement: what is being reimbursed, e.g. Driver tip.",
          },
          amount: {
            type: "number",
            description: "For upsert_walmart_reimbursement: reimbursed or submitted amount in dollars.",
          },
          submitted: {
            type: "string",
            description: "For upsert_walmart_reimbursement: submission date in YYYY-MM-DD format.",
          },
          note: {
            type: "string",
            description: "For upsert_walmart_reimbursement or upsert_reimbursement: note or memo used on the submission.",
          },
          memo: {
            type: "string",
            description: "For check_submission_dedup: proposed reimbursement memo when note_path is omitted.",
          },
          evidence_path: {
            type: "string",
            description: "For upsert_walmart_reimbursement or upsert_reimbursement: screenshot or file path used as evidence.",
          },
          ramp_report_id: {
            type: "string",
            description: "For upsert_walmart_reimbursement or upsert_reimbursement: optional Ramp report or reimbursement identifier.",
          },
        },
        required: ["action"],
      },
      handler: async (input) => {
        const action = String(input.action);
        const since = typeof input.since === "string" ? input.since : undefined;
        const until = typeof input.until === "string" ? input.until : undefined;
        const vendor = typeof input.vendor === "string" ? input.vendor : undefined;
        const includeSubmitted = input.include_submitted === true;
        const verifyWithRamp = input.verify_with_ramp !== false;
        switch (action) {
          case "list_walmart_delivery_candidates": {
            const localResults = listWalmartDeliveryCandidates({
              since,
              includeSubmitted,
            }).filter((record) => !until || !record.date || record.date <= until);
            if (!verifyWithRamp) {
              return {
                retailer: "Walmart",
                verified_with_ramp: false,
                results: localResults,
              };
            }

            const bm = getBrowserManager();
            await bm.launch(9223);
            const history = await bm.listRampReimbursementHistory({
              maxPages: typeof input.max_pages === "number" ? input.max_pages : undefined,
            });
            const reconciled = reconcileWalmartReimbursementsAgainstRamp({
              history,
              since,
              until,
              updateNotes: false,
            });
            return {
              retailer: "Walmart",
              verified_with_ramp: true,
              results: includeSubmitted ? reconciled.records : reconciled.pending,
              verification: {
                notes_examined: reconciled.notesExamined,
                history_entries_examined: reconciled.historyEntriesExamined,
                matched: reconciled.matched,
                unverified_submitted: reconciled.unverifiedSubmitted,
              },
            };
          }
          case "backfill_walmart_delivery_candidates": {
            const bm = getBrowserManager();
            await bm.launch(9223);
            const discovered = await bm.discoverWalmartDeliveryCandidates({
              since,
              until,
              maxPages: typeof input.max_pages === "number" ? input.max_pages : undefined,
            });
            const discoveredOrderIds = new Set<string>();
            const backfilled = discovered
              .map((candidate) => {
                discoveredOrderIds.add(candidate.orderId);
                const existing = findWalmartReceiptRecord(candidate.orderId);
                const noteRecord = existing ?? backfillWalmartReceiptNote({
                  orderId: candidate.orderId,
                  date: candidate.date,
                  total: candidate.total,
                  cardCharge: candidate.cardCharge,
                  itemsLine: candidate.itemsLine,
                  grocerySummary: "Walmart grocery delivery. Full item breakdown not yet backfilled into the note.",
                  notes: candidate.notes,
                  driverTip: candidate.driverTip,
                });
                return {
                  ...candidate,
                  note_path: noteRecord.filePath,
                  reimbursement_status: noteRecord.reimbursement.status ?? "not_submitted",
                };
              })
              .filter((candidate) => {
                if (includeSubmitted) {
                  return true;
                }
                return candidate.reimbursement_status !== "submitted"
                  && candidate.reimbursement_status !== "reimbursed";
              });

            if (!verifyWithRamp) {
              return {
                retailer: "Walmart",
                verified_with_ramp: false,
                results: backfilled,
              };
            }

            const history = await bm.listRampReimbursementHistory({
              maxPages: typeof input.max_pages === "number" ? input.max_pages : undefined,
            });
            const reconciled = reconcileWalmartReimbursementsAgainstRamp({
              history,
              since,
              until,
              updateNotes: false,
            });
            const pendingByOrderId = new Set(reconciled.pending.map((record) => record.orderId));
            const verifiedMatches = reconciled.matched.filter((match) => discoveredOrderIds.has(match.orderId));
            const unverifiedSubmitted = reconciled.unverifiedSubmitted
              .filter((record) => discoveredOrderIds.has(record.orderId));
            const results = backfilled.filter((candidate) => {
              if (includeSubmitted) {
                return true;
              }
              return pendingByOrderId.has(candidate.orderId);
            });

            return {
              retailer: "Walmart",
              results,
              verified_with_ramp: true,
              verification: {
                notes_examined: reconciled.notesExamined,
                history_entries_examined: reconciled.historyEntriesExamined,
                matched: verifiedMatches,
                unverified_submitted: unverifiedSubmitted,
              },
            };
          }
          case "reconcile_walmart_reimbursements": {
            const bm = getBrowserManager();
            await bm.launch(9223);
            const history = await bm.listRampReimbursementHistory({
              maxPages: typeof input.max_pages === "number" ? input.max_pages : undefined,
            });
            const reconciled = reconcileWalmartReimbursementsAgainstRamp({
              history,
              since,
              until,
              updateNotes: true,
            });
            return {
              retailer: "Walmart",
              verified_with_ramp: true,
              matched: reconciled.matched,
              updated: reconciled.updated,
              pending: reconciled.pending,
              unverified_submitted: reconciled.unverifiedSubmitted,
              notes_examined: reconciled.notesExamined,
              history_entries_examined: reconciled.historyEntriesExamined,
            };
          }
          case "upsert_walmart_reimbursement":
            if (typeof input.status !== "string" || input.status.trim().length === 0) {
              return { error: "upsert_walmart_reimbursement requires 'status'" };
            }
            return {
              retailer: "Walmart",
              result: upsertWalmartReimbursementTracking({
                notePath: typeof input.note_path === "string" ? input.note_path : undefined,
                orderId: typeof input.order_id === "string" ? input.order_id : undefined,
                status: input.status,
                system: typeof input.system === "string" ? input.system : undefined,
                reimbursableItem: typeof input.reimbursable_item === "string" ? input.reimbursable_item : undefined,
                amount: typeof input.amount === "number" ? input.amount : undefined,
                submitted: typeof input.submitted === "string" ? input.submitted : undefined,
                note: typeof input.note === "string" ? input.note : undefined,
                evidencePath: typeof input.evidence_path === "string" ? input.evidence_path : undefined,
                rampReportId: typeof input.ramp_report_id === "string" ? input.ramp_report_id : undefined,
              }),
            };
          case "check_submission_dedup": {
            if (
              (typeof input.note_path !== "string" || input.note_path.trim().length === 0)
              && (typeof input.amount !== "number"
                || typeof input.transaction_date !== "string"
                || input.transaction_date.trim().length === 0)
            ) {
              return {
                error: "check_submission_dedup requires note_path or both amount and transaction_date",
              };
            }

            const history = verifyWithRamp
              ? await (async () => {
                  const bm = getBrowserManager();
                  await bm.launch(9223);
                  return bm.listRampReimbursementHistory({
                    maxPages: typeof input.max_pages === "number" ? input.max_pages : undefined,
                  });
                })()
              : undefined;

            return {
              vendor: resolveVendorConfig(vendor)?.key ?? vendor,
              verified_with_ramp: verifyWithRamp,
              result: checkSubmissionDedup({
                notePath: typeof input.note_path === "string" ? input.note_path : undefined,
                vendor,
                merchant: typeof input.merchant === "string" ? input.merchant : undefined,
                amount: typeof input.amount === "number" ? input.amount : undefined,
                transactionDate:
                  typeof input.transaction_date === "string" ? input.transaction_date : undefined,
                memo: typeof input.memo === "string" ? input.memo : undefined,
                history,
              }),
            };
          }
          case "list_reimbursement_candidates": {
            if (!verifyWithRamp) {
              return {
                vendor: resolveVendorConfig(vendor)?.key ?? vendor,
                verified_with_ramp: false,
                results: listReimbursementCandidates({
                  since,
                  until,
                  vendor,
                  includeSubmitted,
                }),
              };
            }

            const bm = getBrowserManager();
            await bm.launch(9223);
            const history = await bm.listRampReimbursementHistory({
              maxPages: typeof input.max_pages === "number" ? input.max_pages : undefined,
            });
            const reconciled = reconcileUniversalReimbursements({
              history,
              since,
              until,
              vendor,
              includeSubmitted,
              updateNotes: false,
            });
            return {
              vendor: resolveVendorConfig(vendor)?.key ?? vendor,
              verified_with_ramp: true,
              results: includeSubmitted ? reconciled.records : reconciled.pending,
              verification: {
                notes_examined: reconciled.notesExamined,
                history_entries_examined: reconciled.historyEntriesExamined,
                matched: reconciled.matched,
                unverified_submitted: reconciled.unverifiedSubmitted,
              },
            };
          }
          case "reconcile_reimbursements": {
            const bm = getBrowserManager();
            await bm.launch(9223);
            const history = await bm.listRampReimbursementHistory({
              maxPages: typeof input.max_pages === "number" ? input.max_pages : undefined,
            });
            const reconciled = reconcileUniversalReimbursements({
              history,
              since,
              until,
              vendor,
              includeSubmitted: true,
              updateNotes: true,
            });
            return {
              vendor: resolveVendorConfig(vendor)?.key ?? vendor,
              verified_with_ramp: true,
              matched: reconciled.matched,
              updated: reconciled.updated,
              pending: reconciled.pending,
              unverified_submitted: reconciled.unverifiedSubmitted,
              notes_examined: reconciled.notesExamined,
              history_entries_examined: reconciled.historyEntriesExamined,
            };
          }
          case "upsert_reimbursement":
            if (typeof input.note_path !== "string" || input.note_path.trim().length === 0) {
              return { error: "upsert_reimbursement requires note_path" };
            }
            if (typeof input.status !== "string" || input.status.trim().length === 0) {
              return { error: "upsert_reimbursement requires 'status'" };
            }
            return {
              vendor: resolveVendorConfig(vendor)?.key ?? vendor,
              result: upsertReimbursementTracking({
                notePath: input.note_path,
                vendor,
                status: input.status,
                system: typeof input.system === "string" ? input.system : undefined,
                reimbursableItem: typeof input.reimbursable_item === "string" ? input.reimbursable_item : undefined,
                amount: typeof input.amount === "number" ? input.amount : undefined,
                submitted: typeof input.submitted === "string" ? input.submitted : undefined,
                note: typeof input.note === "string" ? input.note : undefined,
                evidencePath: typeof input.evidence_path === "string" ? input.evidence_path : undefined,
                rampReportId: typeof input.ramp_report_id === "string" ? input.ramp_report_id : undefined,
              }),
            };
          case "generate_monthly_ledger": {
            const history = verifyWithRamp
              ? await (async () => {
                  const bm = getBrowserManager();
                  await bm.launch(9223);
                  return bm.listRampReimbursementHistory({
                    maxPages: typeof input.max_pages === "number" ? input.max_pages : undefined,
                  });
                })()
              : undefined;

            return {
              vendor: resolveVendorConfig(vendor)?.key ?? vendor,
              verified_with_ramp: verifyWithRamp,
              ledger: generateMonthlyLedger({
                month: typeof input.month === "string" ? input.month : undefined,
                since,
                until,
                vendor,
                history,
              }),
            };
          }
          case "detect_gaps": {
            const history = verifyWithRamp
              ? await (async () => {
                  const bm = getBrowserManager();
                  await bm.launch(9223);
                  return bm.listRampReimbursementHistory({
                    maxPages: typeof input.max_pages === "number" ? input.max_pages : undefined,
                  });
                })()
              : undefined;

            return {
              vendor: resolveVendorConfig(vendor)?.key ?? vendor,
              verified_with_ramp: verifyWithRamp,
              result: detectReimbursementGaps({
                since,
                until,
                vendor,
                history,
                lookbackMonths:
                  typeof input.lookback_months === "number" ? input.lookback_months : undefined,
              }),
            };
          }
          default:
            return { error: `Unknown receipt_registry action: ${action}` };
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Ramp reimbursement automation
// ---------------------------------------------------------------------------

export function createReimbursementAutomationTools(): AgentTool[] {
  return [
    {
      name: "ramp_reimbursement",
      description: [
        "Deterministic Ramp reimbursement browser automation for both generic invoice-backed submissions and Walmart delivery-tip reimbursements.",
        "",
        "Actions:",
        "  capture_walmart_tip_evidence",
        "    Open a Walmart order page and capture archived evidence that shows Driver tip plus an explicit visible date.",
        "",
        "  capture_email_reimbursement_evidence",
        "    Render a raw reimbursement email body into an archived screenshot evidence file for Ramp uploads when no better attachment exists.",
        "",
        "  submit_ramp_reimbursement",
        "    Create and submit a Ramp reimbursement draft with archived evidence, amount, date, memo, and merchant. Evidence may be a PDF or an image file.",
        "    A recent-history dedup gate runs automatically unless skip_dedup_check is true.",
        "",
        "  replace_ramp_reimbursement_receipt",
        "    Open an existing Ramp reimbursement review page and replace or add receipt evidence, then capture a Ramp confirmation screenshot. Evidence may be a PDF or an image file.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "capture_walmart_tip_evidence",
              "capture_email_reimbursement_evidence",
              "submit_ramp_reimbursement",
              "replace_ramp_reimbursement_receipt",
            ],
            description: "Ramp reimbursement automation action to perform.",
          },
          order_url: {
            type: "string",
            description: "For capture_walmart_tip_evidence: absolute Walmart order url.",
          },
          output_path: {
            type: "string",
            description: "For capture_walmart_tip_evidence or capture_email_reimbursement_evidence: optional destination png path.",
          },
          email_content: {
            type: "string",
            description: "For capture_email_reimbursement_evidence: raw `gog gmail get --format full` output for the reimbursement email.",
          },
          label: {
            type: "string",
            description: "For capture_email_reimbursement_evidence: optional evidence label.",
          },
          amount: {
            type: "number",
            description: "For submit_ramp_reimbursement: amount in dollars.",
          },
          transaction_date: {
            type: "string",
            description: "For submit_ramp_reimbursement: date in YYYY-MM-DD or MM/DD/YYYY.",
          },
          memo: {
            type: "string",
            description: "For submit_ramp_reimbursement: optional reimbursement memo text. Defaults from reimbursement-config.yaml when merchant or vendor matches.",
          },
          evidence_path: {
            type: "string",
            description: "For submit or replace actions: absolute evidence file path (PDF or image).",
          },
          merchant: {
            type: "string",
            description: "For submit_ramp_reimbursement: merchant name. Falls back to the vendor config when provided.",
          },
          vendor: {
            type: "string",
            description: "For submit_ramp_reimbursement: configured vendor key, receipt directory, or merchant alias from reimbursement-config.yaml.",
          },
          skip_dedup_check: {
            type: "boolean",
            description: "For submit_ramp_reimbursement: bypass the automatic date+amount dedup gate. Use only for intentional re-submissions.",
          },
          review_url: {
            type: "string",
            description: "For replace_ramp_reimbursement_receipt: absolute Ramp reimbursement review url.",
          },
        },
        required: ["action"],
      },
      handler: async (input) => {
        const bm = getBrowserManager();
        await bm.launch(9223);
        const action = String(input.action ?? "");
        switch (action) {
          case "capture_walmart_tip_evidence":
            if (typeof input.order_url !== "string" || input.order_url.trim().length === 0) {
              return { error: "capture_walmart_tip_evidence requires order_url" };
            }
            return {
              result: await bm.captureWalmartTipEvidence({
                orderUrl: input.order_url,
                outputPath: typeof input.output_path === "string" ? input.output_path : undefined,
              }),
            };
          case "capture_email_reimbursement_evidence":
            if (typeof input.email_content !== "string" || input.email_content.trim().length === 0) {
              return { error: "capture_email_reimbursement_evidence requires email_content" };
            }
            return {
              result: await bm.captureEmailReimbursementEvidence({
                emailContent: input.email_content,
                label: typeof input.label === "string" ? input.label : undefined,
                outputPath: typeof input.output_path === "string" ? input.output_path : undefined,
              }),
            };
          case "submit_ramp_reimbursement":
            if (typeof input.amount !== "number") {
              return { error: "submit_ramp_reimbursement requires amount" };
            }
            if (typeof input.transaction_date !== "string" || input.transaction_date.trim().length === 0) {
              return { error: "submit_ramp_reimbursement requires transaction_date" };
            }
            if (typeof input.evidence_path !== "string" || input.evidence_path.trim().length === 0) {
              return { error: "submit_ramp_reimbursement requires evidence_path" };
            }
            {
              const vendor = typeof input.vendor === "string" ? input.vendor : undefined;
              const resolvedVendor =
                resolveVendorConfig(vendor)
                ?? resolveVendorConfig(typeof input.merchant === "string" ? input.merchant : undefined);
              const resolvedMerchant =
                typeof input.merchant === "string" && input.merchant.trim().length > 0
                  ? input.merchant.trim()
                  : resolvedVendor?.merchantName;
              const resolvedMemo =
                typeof input.memo === "string" && input.memo.trim().length > 0
                  ? input.memo.trim()
                  : resolveDefaultMemo(vendor ?? resolvedMerchant);
              if (!resolvedMemo) {
                return {
                  error: "submit_ramp_reimbursement requires memo or a merchant/vendor with a configured default memo",
                };
              }

              if (input.skip_dedup_check !== true) {
                const history = await bm.listRampReimbursementHistory();
                const dedup = checkSubmissionDedup({
                  vendor,
                  merchant: resolvedMerchant,
                  amount: input.amount,
                  transactionDate: input.transaction_date,
                  memo: resolvedMemo,
                  history,
                });
                if (dedup.duplicate) {
                  return {
                    error: `submit_ramp_reimbursement blocked by dedup gate: ${dedup.reasons.join(", ")}`,
                    dedup,
                  };
                }
              }

              const result = await bm.submitRampReimbursement({
                amount: input.amount,
                transactionDate: input.transaction_date,
                memo: resolvedMemo,
                evidencePath: input.evidence_path,
                merchant: resolvedMerchant,
              });
              syncWalmartTrackingFromRampEvidence({
                evidencePath: result.evidencePath,
                status: "draft",
                amount: result.amount,
                submitted: currentLocalIsoDate(),
                note: result.memo,
                rampReportId: result.rampReportId,
              });
              return {
                result,
                draftUrl: result.reviewUrl,
                message: `Ramp reimbursement draft created - ready for manual review at ${result.reviewUrl}`,
              };
            }
          case "replace_ramp_reimbursement_receipt":
            if (typeof input.review_url !== "string" || input.review_url.trim().length === 0) {
              return { error: "replace_ramp_reimbursement_receipt requires review_url" };
            }
            if (typeof input.evidence_path !== "string" || input.evidence_path.trim().length === 0) {
              return { error: "replace_ramp_reimbursement_receipt requires evidence_path" };
            }
            {
              const result = await bm.replaceRampReimbursementReceipt({
                reviewUrl: input.review_url,
                evidencePath: input.evidence_path,
              });
              syncWalmartTrackingFromRampEvidence({
                evidencePath: result.evidencePath,
                status: "submitted",
                rampReportId: extractRampReimbursementIdFromUrl(result.reviewUrl) ?? undefined,
              });
              return {
                result,
              };
            }
          default:
            return { error: `Unknown ramp_reimbursement action: ${action}` };
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// iMessage tools
// ---------------------------------------------------------------------------

export function createIMessageTools(overrides?: PersonalToolPaths): AgentTool[] {
  const paths = resolvePaths(overrides);

  return [
    {
      name: "imessage",
      description: [
        "Read and send iMessages via the imsg CLI. Supports listing conversations, reading history, and sending messages.",
        "",
        "Commands:",
        "  imsg chats [--limit N] [--json]",
        "    List recent conversations. Use --json for structured output.",
        "    Output includes chat_id, display_name, participant handles, last message date.",
        "",
        "  imsg history --chat-id <id> [--limit N] [--start <ISO8601>] [--end <ISO8601>] [--attachments] [--json]",
        "    Read message history for a conversation. chat-id comes from 'chats' output.",
        "    Use --start/--end for date ranges (--end is exclusive).",
        "    Use --json for structured output with sender, text, timestamps.",
        "",
        "  imsg send --to <handle> --text '<message>'",
        "    Send a message to a phone number or email address.",
        "    Handle format: +15551234567 (E.164 phone) or email@example.com",
        "",
        "  imsg send --chat-id <id> --text '<message>'",
        "    Send a message to an existing conversation by chat ID.",
        "",
        "Notes:",
        "  - Always use --json for chats and history to get structured output.",
        "  - Use 'chats' first to find the chat_id for a person, then 'history' to read.",
        "  - For send: prefer --chat-id over --to when the conversation already exists.",
        "  - Sending is a real action — the recipient will see the message immediately.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Full imsg command (everything after 'imsg'). Example: \"chats --limit 10 --json\"",
          },
        },
        required: ["command"],
      },
      handler: async (input) => {
        const cmdStr = String(input.command).trim();
        const args = parseShellArgs(cmdStr);
        const stdout = await runCommand(paths.imsgCommand, args, 30_000);
        try {
          return JSON.parse(stdout);
        } catch {
          return { result: stdout };
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Google Docs tools
// ---------------------------------------------------------------------------

export function createDocsTools(overrides?: PersonalToolPaths): AgentTool[] {
  const paths = resolvePaths(overrides);

  return [
    {
      name: "gog_docs",
      description: [
        "Run Google Docs operations via the gog CLI. Supports list, read, create, write, insert, rename, delete, share, export.",
        "Use gog_docs_update_tab instead when you already know the exact doc, tab, account, and edits.",
        "",
        "Commands:",
        "  gog docs list [--account <email>]",
        "    List Google Docs in the account.",
        "",
        "  gog docs cat <docId> [--account <email>]",
        "  gog docs read <docId> [--account <email>]",
        "    Read the full content of a document by ID.",
        "",
        "  gog docs create --title '<title>' [--account <email>]",
        "    Create a new empty Google Doc.",
        "",
        "  gog docs write <docId> --content '<text>' [--account <email>]",
        "    Overwrite a document's content.",
        "",
        "  gog docs insert <docId> --content '<text>' [--index N] [--account <email>]",
        "    Insert text at a position in a document.",
        "",
        "  gog docs rename <docId> --title '<new title>' [--account <email>]",
        "    Rename a document.",
        "",
        "  gog docs delete <docId> [--account <email>]",
        "    Delete a document.",
        "",
        "  gog docs share <docId> --email <email> [--role reader|writer|commenter] [--account <email>]",
        "    Share a document with another user.",
        "",
        "  gog docs export <docId> --format <pdf|docx|txt|html> [--output <path>] [--account <email>]",
        "    Export a document in a different format.",
        "",
        "Accounts are installation-specific. Common patterns are personal@example.com and work@example.com.",
        "Output: Returns CLI output in `result`. Use --json where supported for structured output.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Full gog docs command (everything after 'gog'). Example: \"docs list --account work@example.com\" or \"docs cat <docId> --account personal@example.com\"",
          },
        },
        required: ["command"],
      },
      handler: async (input) => {
        const cmdStr = String(input.command).trim();
        const args = parseShellArgs(cmdStr);
        const stdout = await runCommand(paths.gogCommand, args, 60_000);
        return { result: stdout };
      },
    },
    {
      name: "gog_docs_update_tab",
      description: [
        "High-level Google Docs tab updater for targeted edit batches.",
        "Use this instead of many separate gog_docs reads/writes when you already know the doc, tab, and exact edits.",
        "It reads the target tab once, applies the replacement batch or full content write, then verifies the same tab before returning.",
        "",
        "Inputs:",
        "  doc: Google Doc id or full Google Docs URL",
        "  tab: tab id or full Google Docs URL with ?tab=...",
        "  account: Google account email to use",
        "  replacements?: [{ find, replace, first? }]",
        "  content?: full replacement text for the tab",
        "  verify_contains?: snippets that must appear in the verified tab after the write",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          doc: { type: "string" },
          tab: { type: "string" },
          account: { type: "string" },
          replacements: {
            type: "array",
            items: {
              type: "object",
              properties: {
                find: { type: "string" },
                replace: { type: "string" },
                first: { type: "boolean" },
              },
              required: ["find", "replace"],
            },
          },
          content: { type: "string" },
          verify_contains: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["doc", "tab", "account"],
      },
      handler: async (input) => ({
        result: await executeGoogleDocTabUpdate(
          {
            doc: String(input.doc),
            tab: String(input.tab),
            account: String(input.account),
            replacements: Array.isArray(input.replacements)
              ? input.replacements.map((replacement) => ({
                  find: String((replacement as Record<string, unknown>).find ?? ""),
                  replace: String((replacement as Record<string, unknown>).replace ?? ""),
                  first: Boolean((replacement as Record<string, unknown>).first),
                }))
              : undefined,
            content: typeof input.content === "string" ? input.content : undefined,
            verify_contains: Array.isArray(input.verify_contains)
              ? input.verify_contains.map((value) => String(value))
              : undefined,
          },
          {
            gogCommand: paths.gogCommand,
            runCommand: (command, args, timeoutMs) => runRequiredCommand(command, args, timeoutMs),
          },
        ),
      }),
    },
  ];
}

// ---------------------------------------------------------------------------
// All personal tools combined
// ---------------------------------------------------------------------------

export function createAllPersonalTools(overrides?: PersonalToolPaths): AgentTool[] {
  return [
    ...createEmailTools(overrides),
    ...createSystemClockTools(),
    ...createCalendarTools(overrides),
    ...createDocsTools(overrides),
    ...createObsidianTools(overrides),
    ...createHealthBriefingTools(overrides),
    ...createFinanceTools(overrides),
    ...createReceiptRegistryTools(),
    ...createReimbursementAutomationTools(),
    ...createIMessageTools(overrides),
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a shell-like command string into args, respecting single/double quotes.
 */
function parseShellArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === " " && !inSingle && !inDouble) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
}
