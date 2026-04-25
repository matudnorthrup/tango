/**
 * Research Agent Tools — Tool definitions for Sierra (research/procurement) worker agents.
 *
 * Tools:
 *   - exa_search: Web search via EXA API (neural search)
 *   - exa_answer: Quick factual answers via EXA
 *   - printer_command: PrusaLink API for 3D printer management
 *   - openscad_render: Render OpenSCAD files to STL
 *   - prusa_slice: Slice STL files to G-code via PrusaSlicer
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import {
  resolveConfiguredPath,
  resolveLegacyDataDir,
  resolveTangoHome,
  resolveTangoProfileDataDir,
  resolveTangoProfileDir,
  type AgentTool,
} from "@tango/core";
import { getSecret } from "./op-secret.js";
import {
  addToQueue,
  listQueue,
  clearQueue,
  removeFromQueue,
  loadQueue,
  summarizePreferences,
  type CartQueueItem,
} from "./walmart-cart-processor.js";
import {
  parseReceipts,
  analyzeHistory,
  getRestockRecommendations,
} from "./walmart-history-parser.js";

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
    const spawnEnv = env ? { ...process.env, ...env } : undefined;
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], ...(spawnEnv ? { env: spawnEnv } : {}) });

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
): Promise<string> {
  const result = await execCommand(command, args, timeoutMs);
  if (result.code !== 0 && result.stderr) {
    return `Error (exit ${result.code}): ${result.stderr.trim()}\n${result.stdout.trim()}`.trim();
  }
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export interface ResearchToolPaths {
  exaSearchScript?: string;
  exaAnswerScript?: string;
  openscadCommand?: string;
  prusaSlicerCommand?: string;
  printingDir?: string;
  prusaPrinterIp?: string;
  prusaApiKey?: string;
}

function resolveExistingOrFallback(candidates: string[], fallback: string): string {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return fallback;
}

function resolveConfiguredOrFallback(
  configured: string | undefined,
  candidates: string[],
  fallback: string,
): string {
  const normalized = configured?.trim();
  if (normalized && normalized.length > 0) {
    return resolveConfiguredPath(normalized);
  }
  return resolveExistingOrFallback(candidates, fallback);
}

function resolvePaths(overrides?: ResearchToolPaths) {
  const home = os.homedir();
  const tangoHome = resolveTangoHome();
  const profileDir = resolveTangoProfileDir();
  const genericExaSearchScript = path.join(tangoHome, "tools/research/exa-search.js");
  const legacyExaSearchScript = path.join(home, "clawd/scripts/exa-search.js");
  const genericExaAnswerScript = path.join(tangoHome, "tools/research/exa-answer.js");
  const legacyExaAnswerScript = path.join(home, "clawd/scripts/exa-answer.js");
  const genericPrintingDir = path.join(profileDir, "projects", "3d-printing");
  const legacyPrintingDir = path.join(home, "3d-printing");
  return {
    exaSearchScript: overrides?.exaSearchScript ?? resolveConfiguredOrFallback(
      process.env.TANGO_EXA_SEARCH_SCRIPT,
      [genericExaSearchScript, legacyExaSearchScript],
      genericExaSearchScript,
    ),
    exaAnswerScript: overrides?.exaAnswerScript ?? resolveConfiguredOrFallback(
      process.env.TANGO_EXA_ANSWER_SCRIPT,
      [genericExaAnswerScript, legacyExaAnswerScript],
      genericExaAnswerScript,
    ),
    openscadCommand: overrides?.openscadCommand ?? resolveConfiguredOrFallback(
      process.env.TANGO_OPENSCAD_COMMAND,
      ["/opt/homebrew/bin/openscad"],
      "/opt/homebrew/bin/openscad",
    ),
    prusaSlicerCommand: overrides?.prusaSlicerCommand ?? resolveConfiguredOrFallback(
      process.env.TANGO_PRUSA_SLICER_COMMAND,
      [path.join(home, "bin/prusa-slicer")],
      path.join(home, "bin/prusa-slicer"),
    ),
    printingDir: overrides?.printingDir ?? resolveConfiguredOrFallback(
      process.env.TANGO_PRINTING_DIR,
      [genericPrintingDir, legacyPrintingDir],
      genericPrintingDir,
    ),
    prusaPrinterIp: overrides?.prusaPrinterIp ?? process.env.TANGO_PRUSA_PRINTER_HOST ?? "printer.local",
    prusaApiKey: overrides?.prusaApiKey ?? undefined,
  };
}

// Resolve EXA API key from 1Password
async function resolveExaApiKey(): Promise<string> {
  const opKey = await getSecret("Watson", "EXA API Key");
  if (opKey) return opKey;
  throw new Error("EXA API key not found in 1Password (Watson vault, item 'EXA API Key')");
}

// Resolve PrusaLink API key: 1Password → no fallback (was hardcoded)
async function resolvePrusaApiKey(): Promise<string> {
  const opKey = await getSecret("Watson", "PrusaLink API Key");
  if (opKey) return opKey;
  throw new Error("PrusaLink API key not found in 1Password (Watson vault, item 'PrusaLink API Key')");
}

// ---------------------------------------------------------------------------
// EXA Search
// ---------------------------------------------------------------------------

export function createExaTools(overrides?: ResearchToolPaths): AgentTool[] {
  const paths = resolvePaths(overrides);

  // Cached EXA API key — resolved from 1Password with file fallback
  let cachedExaKey: string | null = null;
  async function getExaKey(): Promise<string> {
    if (!cachedExaKey) {
      cachedExaKey = await resolveExaApiKey();
    }
    return cachedExaKey;
  }

  return [
    {
      name: "exa_search",
      description: [
        "Search the web using EXA's neural search API. Understands intent, not just keywords.",
        "",
        "Options:",
        "  query (required): Search query string",
        "  num: Number of results (default 10, max 25)",
        "  text: Include full page text in results (costs more, use for deep analysis)",
        "  highlights: Include key highlights (lighter than full text)",
        "  category: Filter by category — news, research paper, tweet, company, people",
        "",
        "Cost: ~$0.005 per search. Rate limit: 5 QPS.",
        "Use for: Research questions, current events, product comparisons, finding sources.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          num: { type: "number", description: "Number of results (default 10)" },
          text: { type: "boolean", description: "Include full page text (default false)" },
          highlights: { type: "boolean", description: "Include highlights (default false)" },
          category: { type: "string", enum: ["news", "research paper", "tweet", "company", "people"], description: "Category filter" },
        },
        required: ["query"],
      },
      handler: async (input) => {
        const apiKey = await getExaKey();
        const args: string[] = [paths.exaSearchScript, String(input.query)];
        if (typeof input.num === "number") args.push("--num", String(input.num));
        if (input.text) args.push("--text");
        if (input.highlights) args.push("--highlights");
        if (input.category) args.push("--category", String(input.category));
        const result = await execCommand(process.execPath, args, 30_000, { EXA_API_KEY: apiKey });
        if (result.code !== 0 && result.stderr) {
          return { result: `Error (exit ${result.code}): ${result.stderr.trim()}\n${result.stdout.trim()}`.trim() };
        }
        return { result: result.stdout.trim() };
      },
    },

    {
      name: "exa_answer",
      description: [
        "Get a quick factual answer from the web using EXA's answer API.",
        "Returns a synthesized answer with citations. Best for factual queries.",
        "Cost: ~$0.005 per query.",
        "Use for: Quick facts, current info, price checks, availability.",
        "NOT for: Deep research (use exa_search with multiple queries instead).",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: "Factual question to answer" },
        },
        required: ["question"],
      },
      handler: async (input) => {
        const apiKey = await getExaKey();
        const result = await execCommand(
          process.execPath,
          [paths.exaAnswerScript, String(input.question)],
          30_000,
          { EXA_API_KEY: apiKey },
        );
        if (result.code !== 0 && result.stderr) {
          return { result: `Error (exit ${result.code}): ${result.stderr.trim()}\n${result.stdout.trim()}`.trim() };
        }
        return { result: result.stdout.trim() };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// 3D Printing tools
// ---------------------------------------------------------------------------

export function createPrintingTools(overrides?: ResearchToolPaths): AgentTool[] {
  const paths = resolvePaths(overrides);

  return [
    {
      name: "printer_command",
      description: [
        "Prusa MK4 3D printer management via PrusaLink REST API.",
        "Printer endpoint: configurable via ResearchToolPaths.prusaPrinterIp or local overrides.",
        "Build volume: 250x210x220mm | Nozzle: 0.4mm",
        "",
        "Actions:",
        "  status — Get printer state (IDLE, PRINTING, FINISHED, PAUSED, ERROR)",
        "  job — Get current print job progress (percentage, time remaining)",
        "  upload — Upload a .gcode file to the printer",
        "  start — Start printing an uploaded file (use 8.3 filename from upload response)",
        "  stop — Stop current print job",
        "",
        "Safety:",
        "  dry_run=true previews upload/start/stop without changing the printer.",
        "",
        "File locations: configurable printing workspace (profile project dir by default).",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["status", "job", "upload", "start", "stop"],
            description: "Printer action to perform",
          },
          file_path: {
            type: "string",
            description: "For upload: local path to .gcode file. For start: 8.3 filename on printer.",
          },
          job_id: {
            type: "string",
            description: "For stop: job ID to cancel.",
          },
          dry_run: {
            type: "boolean",
            description: "Preview upload/start/stop without changing the printer.",
          },
        },
        required: ["action"],
      },
      handler: async (input) => {
        const action = String(input.action);
        const ip = paths.prusaPrinterIp;
        const dryRun = input.dry_run === true;
        if (dryRun && (action === "upload" || action === "start" || action === "stop")) {
          return {
            dry_run: true,
            action,
            preview: action === "upload"
              ? `Would upload ${String(input.file_path)} to printer ${ip}`
              : action === "start"
                ? `Would start printer file ${String(input.file_path)} on printer ${ip}`
                : `Would stop printer job ${String(input.job_id)} on printer ${ip}`,
          };
        }

        const apiKey = paths.prusaApiKey ?? await resolvePrusaApiKey();
        const baseUrl = `http://${ip}/api/v1`;
        const headers: Record<string, string> = { "X-Api-Key": apiKey };

        /** Safely parse JSON from a fetch response, returning an error object on failure. */
        const safeJson = async (res: Response): Promise<unknown> => {
          const text = await res.text();
          if (!text) return { error: `HTTP ${res.status}: empty response body` };
          try { return JSON.parse(text); }
          catch { return { error: `HTTP ${res.status}: invalid JSON — ${text.slice(0, 200)}` }; }
        };

        try {
          switch (action) {
            case "status": {
              const res = await fetch(`${baseUrl}/status`, { headers });
              return res.ok ? await safeJson(res) : { error: `HTTP ${res.status}` };
            }
            case "job": {
              const res = await fetch(`${baseUrl}/job`, { headers });
              return res.ok ? await safeJson(res) : { error: `HTTP ${res.status}` };
            }
            case "upload": {
              const filePath = String(input.file_path);
              const data = fs.readFileSync(filePath);
              const filename = path.basename(filePath);
              const res = await fetch(`${baseUrl}/files/usb/${filename}`, {
                method: "PUT",
                headers: { ...headers, "Content-Type": "application/octet-stream", "Overwrite": "?1" },
                body: data,
              });
              return res.ok ? await safeJson(res) : { error: `HTTP ${res.status}: ${await res.text()}` };
            }
            case "start": {
              const filename = String(input.file_path);
              const res = await fetch(`${baseUrl}/files/usb/${filename}`, {
                method: "POST",
                headers,
              });
              return res.ok ? { success: true, message: `Print started: ${filename}` } : { error: `HTTP ${res.status}` };
            }
            case "stop": {
              const jobId = String(input.job_id);
              const res = await fetch(`${baseUrl}/job/${jobId}`, {
                method: "DELETE",
                headers,
              });
              return res.ok ? { success: true, message: "Print stopped" } : { error: `HTTP ${res.status}` };
            }
            default:
              return { error: `Unknown action: ${action}` };
          }
        } catch (err) {
          return { error: `printer_command failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },

    {
      name: "openscad_render",
      description: [
        "Render an OpenSCAD .scad file to .stl.",
        "OpenSCAD CLI path is configurable via local overrides or environment.",
        "",
        "Parameters can be overridden with -D flags (e.g. gridx=3, gridy=2).",
        "Output goes to the configured printing workspace by default.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          input_file: { type: "string", description: "Path to .scad source file" },
          output_file: { type: "string", description: "Path for .stl output" },
          parameters: {
            type: "object",
            description: "OpenSCAD parameter overrides (e.g. {\"gridx\": 3, \"gridy\": 2})",
          },
        },
        required: ["input_file", "output_file"],
      },
      handler: async (input) => {
        const args: string[] = ["-o", String(input.output_file)];
        if (input.parameters && typeof input.parameters === "object") {
          for (const [key, value] of Object.entries(input.parameters as Record<string, unknown>)) {
            args.push("-D", `${key}=${value}`);
          }
        }
        args.push(String(input.input_file));
        const stdout = await runCommand(paths.openscadCommand, args, 120_000);
        return { success: true, output: String(input.output_file), log: stdout };
      },
    },

    {
      name: "prusa_slice",
      description: [
        "Slice an .stl file to .gcode using PrusaSlicer CLI.",
        "",
        "Print profiles: '0.10mm FAST DETAIL', '0.15mm SPEED', '0.20mm SPEED' (fastest), '0.20mm STRUCTURAL'",
        "Materials: 'Generic PLA @PGIS', 'Generic PETG @PGIS', 'Prusament PLA @PGIS'",
        "Tip: 5% infill for organizers/holders — 15% default wastes hours for no benefit.",
        "",
        "IMPORTANT: After slicing, comments must be truncated to prevent MK4 buffer overflow.",
        "This tool handles the truncation automatically.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          input_file: { type: "string", description: "Path to .stl file" },
          output_file: { type: "string", description: "Path for .gcode output" },
          print_profile: {
            type: "string",
            description: "Print profile (default: '0.20mm SPEED @MK4IS 0.4')",
          },
          material_profile: {
            type: "string",
            description: "Material profile (default: 'Generic PLA @PGIS')",
          },
          infill: {
            type: "number",
            description: "Infill percentage (default: 15, use 5 for organizers)",
          },
        },
        required: ["input_file", "output_file"],
      },
      handler: async (input) => {
        const printProfile = String(input.print_profile ?? "0.20mm SPEED @MK4IS 0.4");
        const materialProfile = String(input.material_profile ?? "Generic PLA @PGIS");
        const args: string[] = [
          "-g", String(input.input_file),
          "--printer-profile", "Original Prusa MK4 Input Shaper 0.4 nozzle",
          "--print-profile", printProfile,
          "--material-profile", materialProfile,
          "--binary-gcode=0",
          "-o", String(input.output_file),
        ];

        if (typeof input.infill === "number") {
          args.push("--fill-density", `${input.infill}%`);
        }

        const stdout = await runCommand(paths.prusaSlicerCommand, args, 120_000);

        // Truncate long comment lines to prevent MK4 buffer overflow
        const gcodeFile = String(input.output_file);
        if (fs.existsSync(gcodeFile)) {
          await runCommand("sed", ["-i", "", "s/^\\(.\\{250\\}\\).*/\\1/", gcodeFile], 10_000);
        }

        return { success: true, output: gcodeFile, log: stdout };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Travel tools (location + diesel finder)
// ---------------------------------------------------------------------------

export function createTravelTools(): AgentTool[] {
  const profileLocationFile = path.join(resolveTangoProfileDataDir(), "location", "latest.json");
  const configuredLocationFile = process.env.TANGO_LOCATION_FILE?.trim();
  const locationFile = configuredLocationFile && configuredLocationFile.length > 0
    ? resolveConfiguredPath(configuredLocationFile)
    : profileLocationFile;
  const dieselScript = path.join(process.cwd(), "scripts/find-diesel.js");

  return [
    {
      name: "location_read",
      description: [
        "Read the current GPS location from the OwnTracks receiver.",
        "Returns: lat, lon, velocity (km/h), heading (degrees), battery %, timestamp, receivedAt, ageSec.",
        "velocity > 0 means actively driving. heading: 0=N 90=E 180=S 270=W.",
        "ageSec = seconds since last GPS update — warn user if > 3600 (stale).",
      ].join("\n"),
      inputSchema: { type: "object", properties: {}, required: [] },
      handler: async () => {
        try {
          const raw = fs.readFileSync(locationFile, "utf-8");
          const data = JSON.parse(raw) as Record<string, unknown>;
          const ageSec = typeof data.timestamp === "number"
            ? Math.round(Date.now() / 1000 - data.timestamp)
            : null;
          return { ...data, ageSec };
        } catch (err: unknown) {
          return { error: `Cannot read location: ${err instanceof Error ? err.message : err}` };
        }
      },
    },

    {
      name: "find_diesel",
      description: [
        "Find the best-value diesel stations along a route from the current GPS location.",
        "Uses HERE Fuel Prices API (primary) with GasBuddy fallback.",
        "Scores stations by price × detour distance penalty.",
        "",
        "Parameters:",
        "  destination (required): Address string or 'lat,lon' — the endpoint of your route",
        "  near: Search around destination only, ignore GPS/routing",
        "  from: Override start location instead of GPS (e.g. 'Tonopah, NV')",
        "  top: Number of results (default 5)",
        "  source: Force 'here' or 'gasbuddy' (default: auto, prefers HERE if key available)",
        "",
        "Returns top stations with: name, address, dieselPrice ($/gal), detourMiles, googleMapsLink.",
        "IMPORTANT: This routing assumes a diesel vehicle. If the user says 'gas' casually, interpret it as diesel unless they say otherwise.",
        "Always recommend stations AHEAD on the route, never behind.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          destination: { type: "string", description: "Route endpoint — address or lat,lon" },
          near: { type: "boolean", description: "Search near destination only, no routing" },
          from: { type: "string", description: "Override start location (default: GPS)" },
          top: { type: "number", description: "Number of results (default 5)" },
          source: { type: "string", enum: ["here", "gasbuddy"], description: "Force data source" },
        },
        required: ["destination"],
      },
      handler: async (input) => {
        const scriptArgs: string[] = [dieselScript, String(input.destination)];
        if (input.near) scriptArgs.push("--near");
        if (input.from) scriptArgs.push(`--from=${input.from}`);
        if (typeof input.top === "number") scriptArgs.push(`--top=${input.top}`);
        if (input.source) scriptArgs.push(`--source=${input.source}`);

        const env: Record<string, string> = {
          TANGO_LOCATION_FILE: locationFile,
          ...(process.env.HERE_API_KEY ? { HERE_API_KEY: process.env.HERE_API_KEY } : {}),
        };

        const result = await execCommand(process.execPath, scriptArgs, 60_000, env);
        if (result.code !== 0) {
          return { error: result.stderr.trim() || `Exit ${result.code}`, output: result.stdout.trim() };
        }
        try {
          return JSON.parse(result.stdout);
        } catch {
          return { output: result.stdout.trim() };
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Walmart shopping tool
// ---------------------------------------------------------------------------

export function createWalmartTools(): AgentTool[] {
  return [
    {
      name: "walmart",
      description: [
        "Walmart shopping queue and purchase history — manage a shopping list and analyze purchase patterns.",
        "",
        "## Actions",
        "",
        "### Queue management",
        "  action: 'queue_add'   — Add items to the shopping queue",
        "    items (required): string[] — List of item queries to queue",
        "    note: string — Optional note for all items",
        "",
        "  action: 'queue_list'  — Show current queue",
        "",
        "  action: 'queue_clear' — Clear all items from queue",
        "",
        "  action: 'queue_remove' — Remove specific item by index (0-based)",
        "    index (required): number",
        "",
        "### Purchase history & restock",
        "  action: 'history_analyze' — Parse receipts from the configured Walmart receipts directory",
        "    days_back: number — Days of history to include (default 365)",
        "    top_n: number — Return only top N items by purchase count (default 20)",
        "",
        "  action: 'history_restock' — Get restock recommendations based on purchase patterns",
        "    days_back: number — Days of history to analyze (default 365)",
        "    Returns items grouped by urgency: overdue, soon (≤7 days), upcoming (≤14 days)",
        "",
        "  action: 'history_preferences' — Show saved product preferences",
        "",
        "## Data files",
        "  Queue: profile data or configured Walmart data directory",
        "  Preferences: profile data or configured Walmart data directory",
        "  Receipts: profile data or TANGO_WALMART_RECEIPTS_DIR",
        "",
        "## Browser automation",
        "  Use the `browser` tool to navigate Walmart.com, search for items,",
        "  and add them to cart. This tool only manages the queue and history data.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "queue_add",
              "queue_list",
              "queue_clear",
              "queue_remove",
              "history_analyze",
              "history_restock",
              "history_preferences",
            ],
            description: "Walmart operation to perform",
          },
          items: {
            type: "array",
            items: { type: "string" },
            description: "For queue_add: list of item queries to add",
          },
          query: {
            type: "string",
            description: "For queue_add: single item query (alternative to items array)",
          },
          index: {
            type: "number",
            description: "For queue_remove: 0-based queue index",
          },
          note: {
            type: "string",
            description: "For queue_add: optional note for all queued items",
          },
          days_back: {
            type: "number",
            description: "For history_*: days of purchase history to include (default 365)",
          },
          top_n: {
            type: "number",
            description: "For history_analyze: limit results to top N items (default 20)",
          },
        },
        required: ["action"],
      },
      handler: async (input) => {
        const action = String(input.action);

        switch (action) {
          case "queue_add": {
            const queries = Array.isArray(input.items)
              ? (input.items as string[])
              : input.query ? [String(input.query)]
              : [];
            if (queries.length === 0) {
              return { error: "queue_add requires 'items' array or 'query' string" };
            }
            const note = input.note ? String(input.note) : undefined;
            const added: CartQueueItem[] = [];
            for (const q of queries) {
              added.push(addToQueue(q.trim(), note));
            }
            const queue = loadQueue();
            return {
              added: added.map((i) => i.query),
              queue_length: queue.items.length,
              message: `Added ${added.length} item(s) to queue. Total pending: ${queue.items.filter((i) => i.status === "pending").length}`,
            };
          }

          case "queue_list": {
            const items = listQueue();
            return {
              items: items.map((i, idx) => ({
                index: idx,
                query: i.query,
                status: i.status,
                addedAt: i.addedAt,
                note: i.note,
              })),
              total: items.length,
              pending: items.filter((i) => i.status === "pending").length,
            };
          }

          case "queue_clear": {
            const before = listQueue().length;
            clearQueue();
            return { cleared: before, message: `Cleared ${before} item(s) from queue` };
          }

          case "queue_remove": {
            const idx = typeof input.index === "number" ? input.index : parseInt(String(input.index), 10);
            const removed = removeFromQueue(idx);
            if (!removed) {
              return { error: `No item at index ${idx}` };
            }
            return { removed: removed.query, index: idx };
          }

          case "history_analyze": {
            const daysBack = typeof input.days_back === "number" ? input.days_back : 365;
            const topN = typeof input.top_n === "number" ? input.top_n : 20;
            const records = parseReceipts(daysBack);
            const stats = analyzeHistory(records);
            return {
              total_receipts_items: records.length,
              total_unique_items: stats.length,
              days_analyzed: daysBack,
              items: stats.slice(0, topN).map((s) => ({
                name: s.displayName,
                purchase_count: s.purchaseCount,
                total_spend: s.totalSpend,
                avg_price: s.averagePrice,
                avg_interval_days: s.averageIntervalDays,
                last_purchase: s.lastPurchase,
                next_expected: s.nextExpectedDate,
                days_until_next: s.daysUntilNext,
                is_staple: s.isStaple,
              })),
            };
          }

          case "history_restock": {
            const daysBack = typeof input.days_back === "number" ? input.days_back : 365;
            const records = parseReceipts(daysBack);
            const stats = analyzeHistory(records);
            const recs = getRestockRecommendations(stats);
            return {
              total_recommendations: recs.length,
              overdue: recs.filter((r) => r.urgency === "overdue").map((r) => ({
                name: r.item.displayName,
                days_overdue: r.daysOverdue,
                last_purchase: r.item.lastPurchase,
                avg_price: r.item.averagePrice,
              })),
              soon: recs.filter((r) => r.urgency === "soon").map((r) => ({
                name: r.item.displayName,
                days_until_needed: r.daysUntilNeeded,
                last_purchase: r.item.lastPurchase,
                avg_price: r.item.averagePrice,
              })),
              upcoming: recs.filter((r) => r.urgency === "upcoming").map((r) => ({
                name: r.item.displayName,
                days_until_needed: r.daysUntilNeeded,
                last_purchase: r.item.lastPurchase,
                avg_price: r.item.averagePrice,
              })),
            };
          }

          case "history_preferences": {
            return summarizePreferences();
          }

          default:
            return { error: `Unknown action: ${action}` };
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// File operations tool
// ---------------------------------------------------------------------------

export function createFileOpsTools(): AgentTool[] {
  const home = os.homedir();

  // Directories Sierra is allowed to access
  const ALLOWED_ROOTS = [
    path.join(home, "Downloads"),
    path.join(home, "3d-printing"),
    path.join(home, "Documents"),
  ];

  function isAllowed(p: string): boolean {
    const resolved = path.resolve(p);
    return ALLOWED_ROOTS.some((root) => resolved.startsWith(root));
  }

  return [
    {
      name: "file_ops",
      description: [
        "File operations — list, read, copy, move, append to, and overwrite files in allowed directories.",
        "",
        "Allowed directories: ~/Downloads, ~/3d-printing, ~/Documents",
        "",
        "Actions:",
        "  list — List files in a directory",
        "    path (required): directory path",
        "    pattern: glob filter (e.g. '*.stl', '*.gcode')",
        "",
        "  read — Read a text file (returns first 50KB)",
        "    path (required): file path",
        "",
        "  copy — Copy a file to a new location",
        "    path (required): source file path",
        "    destination (required): destination file path",
        "",
        "  move — Move/rename a file",
        "    path (required): source file path",
        "    destination (required): destination file path",
        "",
        "  append — Append text to the end of a text file",
        "    path (required): file path",
        "    content (required): text to append",
        "",
        "  write — Overwrite a text file with new content",
        "    path (required): file path",
        "    content (required): full replacement text",
        "",
        "Common workflow: list ~/Downloads for new STL files, then copy to ~/3d-printing/gridfinity/stl/",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "read", "copy", "move", "append", "write"],
            description: "File operation to perform",
          },
          path: {
            type: "string",
            description: "File or directory path",
          },
          destination: {
            type: "string",
            description: "For copy/move: destination path",
          },
          pattern: {
            type: "string",
            description: "For list: glob filter (e.g. '*.stl')",
          },
          content: {
            type: "string",
            description: "For append/write: text content to write",
          },
        },
        required: ["action", "path"],
      },
      handler: async (input) => {
        const action = String(input.action);
        const filePath = String(input.path).replace(/^~/, home);
        const resolved = path.resolve(filePath);

        if (!isAllowed(resolved)) {
          return { error: `Access denied: ${filePath}. Allowed: ~/Downloads, ~/3d-printing, ~/Documents` };
        }

        switch (action) {
          case "list": {
            if (!fs.existsSync(resolved)) {
              return { error: `Directory not found: ${filePath}` };
            }
            const stat = fs.statSync(resolved);
            if (!stat.isDirectory()) {
              return { error: `Not a directory: ${filePath}` };
            }
            const entries = fs.readdirSync(resolved, { withFileTypes: true });
            let items = entries.map((e) => ({
              name: e.name,
              type: e.isDirectory() ? "directory" as const : "file" as const,
              size: e.isFile() ? fs.statSync(path.join(resolved, e.name)).size : undefined,
            }));

            // Apply glob pattern filter if provided
            if (input.pattern) {
              const pattern = String(input.pattern);
              const regex = new RegExp(
                "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
                "i",
              );
              items = items.filter((i) => i.type === "directory" || regex.test(i.name));
            }

            return { path: filePath, items, count: items.length };
          }

          case "read": {
            if (!fs.existsSync(resolved)) {
              return { error: `File not found: ${filePath}` };
            }
            const content = fs.readFileSync(resolved, "utf8");
            if (content.length > 50_000) {
              return { content: content.slice(0, 50_000), truncated: true, totalLength: content.length };
            }
            return { content };
          }

          case "copy":
          case "move": {
            if (!input.destination) {
              return { error: `${action} requires 'destination'` };
            }
            const destPath = String(input.destination).replace(/^~/, home);
            const destResolved = path.resolve(destPath);

            if (!isAllowed(destResolved)) {
              return { error: `Access denied for destination: ${destPath}. Allowed: ~/Downloads, ~/3d-printing, ~/Documents` };
            }
            if (!fs.existsSync(resolved)) {
              return { error: `Source not found: ${filePath}` };
            }

            // Ensure destination directory exists
            const destDir = path.dirname(destResolved);
            if (!fs.existsSync(destDir)) {
              fs.mkdirSync(destDir, { recursive: true });
            }

            if (action === "copy") {
              fs.copyFileSync(resolved, destResolved);
              return { success: true, action: "copy", from: filePath, to: destPath };
            } else {
              fs.renameSync(resolved, destResolved);
              return { success: true, action: "move", from: filePath, to: destPath };
            }
          }

          case "append":
          case "write": {
            if (typeof input.content !== "string") {
              return { error: `${action} requires 'content'` };
            }
            const nextContent = String(input.content);
            const dir = path.dirname(resolved);
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true });
            }
            if (action === "append") {
              const prefix = fs.existsSync(resolved) && fs.statSync(resolved).size > 0 ? "\n" : "";
              fs.appendFileSync(resolved, `${prefix}${nextContent}`, "utf8");
              return { success: true, action: "append", path: filePath, appended: nextContent.length };
            }
            fs.writeFileSync(resolved, nextContent, "utf8");
            return { success: true, action: "write", path: filePath, bytes: nextContent.length };
          }

          default:
            return { error: `Unknown action: ${action}` };
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// All research tools combined
// ---------------------------------------------------------------------------

export function createAllResearchTools(overrides?: ResearchToolPaths): AgentTool[] {
  return [
    ...createExaTools(overrides),
    ...createPrintingTools(overrides),
    ...createTravelTools(),
    ...createWalmartTools(),
    ...createFileOpsTools(),
  ];
}
