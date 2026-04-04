#!/usr/bin/env node
/**
 * MCP Wellness Tool Server — Standalone server for Claude CLI.
 *
 * Exposes wellness tools (nutrition, health, workout) as MCP tools.
 *
 * Two transport modes:
 *
 * 1. **stdio** (default): Spawned by the Claude CLI via --mcp-config.
 *    Each CLI invocation spawns a new process (60-90s cold start).
 *    Usage: node mcp-wellness-server.js
 *
 * 2. **http** (persistent): Started once on tango boot, serves all workers.
 *    Workers connect via the thin mcp-proxy.ts bridge (~100ms startup).
 *    Usage: node mcp-wellness-server.js --http [--port 9100]
 *
 * In HTTP mode, the worker identity comes from the X-Worker-ID request header
 * (set by the proxy). Governance filtering is done per-request.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import {
  createNutritionTools,
  createHealthTools,
  createWorkoutTools,
  createRecipeTools,
} from "./wellness-agent-tools.js";
import { createAllPersonalTools } from "./personal-agent-tools.js";
import { createAllResearchTools } from "./research-agent-tools.js";
import { createBrowserTools } from "./browser-agent-tools.js";
import { createTangoTools } from "./tango-agent-tools.js";
import { createDevTools } from "./tango-dev-tools.js";
import { createDiscordManageTools } from "./discord-manage-tools.js";
import { createOnePasswordTools } from "./onepassword-agent-tools.js";
import { createMemoryTools } from "./memory-agent-tools.js";
import { createLinearTools } from "./linear-agent-tools.js";
import { createSlackTools } from "./slack-tools.js";
import { createYouTubeTools } from "./youtube-agent-tools.js";
import { buildMcpListedTool } from "./mcp-tool-metadata.js";
import { GovernanceChecker, resolveDatabasePath } from "@tango/core";
import type { AgentTool, AccessLevel } from "@tango/core";

// Debug logging via stderr (safe — MCP protocol uses stdout only)
const debug = (...args: unknown[]) => {
  console.error("[mcp-wellness]", ...args);
};

const EMPTY_ALLOWED_TOOL_IDS = "__none__";

// ---------------------------------------------------------------------------
// Thread session storage (reuses the same DB path as governance)
// ---------------------------------------------------------------------------

function createThreadSessionStorage(): { setThreadSession(threadId: string, sessionId: string, agentId: string): void } | undefined {
  try {
    const dbPath = resolveDatabasePath(process.env.TANGO_DB_PATH);
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");
    debug("Thread session storage initialized");
    return {
      setThreadSession(threadId: string, sessionId: string, agentId: string): void {
        db.prepare(
          `INSERT INTO discord_thread_sessions (thread_id, session_id, agent_id)
           VALUES (?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET
             session_id = excluded.session_id,
             agent_id = excluded.agent_id`
        ).run(threadId, sessionId, agentId);
      },
    };
  } catch (err) {
    debug("Thread session storage init failed:", err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

const threadSessionStorage = createThreadSessionStorage();

// ---------------------------------------------------------------------------
// Tool initialization (shared by both modes)
// ---------------------------------------------------------------------------

const allTools: AgentTool[] = [
  ...createNutritionTools(),
  ...createHealthTools(),
  ...createWorkoutTools(),
  ...createRecipeTools(),
  ...createAllPersonalTools(),
  ...createAllResearchTools(),
  ...createBrowserTools(),
  ...createTangoTools(),
  ...createDevTools(),
  ...createDiscordManageTools({ storage: threadSessionStorage }),
  ...createOnePasswordTools(),
  ...createMemoryTools(),
  ...createLinearTools(),
  ...createSlackTools(),
  ...createYouTubeTools(),
];

debug(`Loaded ${allTools.length} tools:`, allTools.map((t) => t.name).join(", "));

const handlerMap = new Map(allTools.map((t) => [t.name, t.handler]));
const FATSECRET_WRITE_METHODS = new Set([
  "food_entry_create",
  "food_entry_edit",
  "food_entry_delete",
]);
const READ_ONLY_TANGO_FILE_OPERATIONS = new Set([
  "read",
  "stat",
  "list",
  "glob",
  "find",
  "search",
  "exists",
]);
const READ_ONLY_PRINTER_ACTIONS = new Set([
  "status",
  "get_status",
  "job_status",
  "state",
  "info",
  "get_info",
  "list",
]);

function getCommandHead(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }
  return value.trim().toLowerCase().split(/\s+/u).filter((part) => part.length > 0);
}

function looksLikeLinearReadQuery(value: unknown): boolean {
  if (typeof value !== "string") {
    return true;
  }
  return !/^\s*mutation\b/iu.test(value);
}

function isReadOnlyGogEmailCommand(command: unknown): boolean {
  const head = getCommandHead(command);
  return (
    (head[0] === "gmail" && head[1] === "messages" && (head[2] === "search" || head[2] === "list"))
    || (head[0] === "gmail" && head[1] === "thread" && head[2] !== "modify")
  );
}

function isReadOnlyGogCalendarCommand(command: unknown): boolean {
  const head = getCommandHead(command);
  return head[0] === "calendar" && head[1] === "events";
}

function isReadOnlyGogDocsCommand(command: unknown): boolean {
  const head = getCommandHead(command);
  return head[0] === "docs" && ["list", "cat", "read", "export"].includes(head[1] ?? "");
}

function isReadOnlyObsidianCommand(command: unknown): boolean {
  const head = getCommandHead(command);
  if (head[0] === "print" || head[0] === "search-content") {
    return true;
  }
  return head[0] === "frontmatter" && head.includes("--print");
}

function isReadOnlyIMessageCommand(command: unknown): boolean {
  const head = getCommandHead(command);
  return head[0] === "chats" || head[0] === "history";
}

// ---------------------------------------------------------------------------
// Governance initialization
// ---------------------------------------------------------------------------

function createGovernance(): GovernanceChecker | null {
  try {
    const dbPath = resolveDatabasePath(process.env.TANGO_DB_PATH);
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");
    const gov = new GovernanceChecker(db);
    debug("Governance checker initialized");
    return gov;
  } catch (err) {
    debug(`Governance init failed, allowing all tools:`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

function parseAllowedToolIds(value: string | undefined): Set<string> | null {
  if (value === undefined) {
    return null;
  }

  const normalized = value.trim();
  if (normalized.length === 0 || normalized === EMPTY_ALLOWED_TOOL_IDS) {
    return new Set<string>();
  }

  return new Set(
    normalized
      .split(",")
      .map((toolId) => toolId.trim())
      .filter((toolId) => toolId.length > 0),
  );
}

function getToolsForWorker(
  governance: GovernanceChecker | null,
  principalId: string | null,
  allowedToolIds: Set<string> | null,
): AgentTool[] {
  const governanceTools = (!principalId || !governance)
    ? allTools
    : allTools.filter((tool) => {
      const requiredLevel = (governance.getToolAccessType(tool.name) ?? "read") as AccessLevel;
      return governance.hasPermission(principalId, tool.name, requiredLevel);
    });

  if (!allowedToolIds) {
    return governanceTools;
  }

  return governanceTools.filter((tool) => allowedToolIds.has(tool.name));
}

function isToolExplicitlyAllowed(name: string, allowedToolIds: Set<string> | null): boolean {
  return !allowedToolIds || allowedToolIds.has(name);
}

function isReadOnlySql(value: unknown): boolean {
  if (typeof value !== "string") {
    return true;
  }
  const normalized = value.trim();
  if (!normalized) {
    return true;
  }
  return /^(select|with|pragma|explain)\b/i.test(normalized);
}

function inferRequestedAccessLevel(
  name: string,
  args: Record<string, unknown>,
  governance: GovernanceChecker | null,
): AccessLevel {
  switch (name) {
    case "fatsecret_api": {
      const method = typeof args.method === "string" ? args.method.trim() : "";
      return FATSECRET_WRITE_METHODS.has(method) ? "write" : "read";
    }
    case "atlas_sql":
    case "workout_sql":
      return isReadOnlySql(args.sql) ? "read" : "write";
    case "recipe_write":
    case "discord_manage":
      return "write";
    case "tango_file": {
      const operation = typeof args.operation === "string" ? args.operation.trim().toLowerCase() : "";
      return READ_ONLY_TANGO_FILE_OPERATIONS.has(operation) ? "read" : "write";
    }
    case "printer_command": {
      const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
      return READ_ONLY_PRINTER_ACTIONS.has(action) ? "read" : "write";
    }
    case "lunch_money": {
      const method = typeof args.method === "string" ? args.method.trim().toUpperCase() : "GET";
      return method === "GET" ? "read" : "write";
    }
    case "gog_email":
      return isReadOnlyGogEmailCommand(args.command) ? "read" : "write";
    case "gog_calendar":
      return isReadOnlyGogCalendarCommand(args.command) ? "read" : "write";
    case "gog_docs":
      return isReadOnlyGogDocsCommand(args.command) ? "read" : "write";
    case "obsidian":
      return isReadOnlyObsidianCommand(args.command) ? "read" : "write";
    case "imessage":
      return isReadOnlyIMessageCommand(args.command) ? "read" : "write";
    case "linear":
      return looksLikeLinearReadQuery(args.query) ? "read" : "write";
    case "walmart": {
      const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
      return action.startsWith("history_") || action === "queue_list" ? "read" : "write";
    }
    case "file_ops": {
      const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
      return action === "list" || action === "read" ? "read" : "write";
    }
    case "browser": {
      const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
      return ["status", "open", "snapshot", "screenshot", "wait", "eval", "connect", "launch", "close", "scroll"].includes(action)
        ? "read"
        : "write";
    }
    default:
      return (governance?.getToolAccessType(name) ?? "read") as AccessLevel;
  }
}

async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
  governance: GovernanceChecker | null,
  principalId: string | null,
  readOnlyStep: boolean,
  allowedToolIds: Set<string> | null,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const handler = handlerMap.get(name);

  if (!handler) {
    debug(`tools/call: unknown tool "${name}"`);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
      isError: true,
    };
  }

  if (!isToolExplicitlyAllowed(name, allowedToolIds)) {
    debug(`tools/call: DENIED ${name} for ${principalId || "unknown"} (not allowlisted)`);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: `Tool not allowlisted for this run: ${name}` }) }],
      isError: true,
    };
  }

  // Governance: check permission before executing
  const requestedLevel = inferRequestedAccessLevel(name, args, governance);
  if (readOnlyStep && requestedLevel === "write") {
    debug(`tools/call: DENIED ${name} for ${principalId || "unknown"} (read-only step)`);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: `Read-only step cannot call write tool: ${name}` }) }],
      isError: true,
    };
  }

  if (governance && principalId) {
    const check = governance.checkPermission(principalId, name, requestedLevel);
    if (!check.granted) {
      debug(`tools/call: DENIED ${name} for ${principalId} (${check.resolvedVia})`);
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Permission denied: ${name} (${check.resolvedVia})` }) }],
        isError: true,
      };
    }
  }

  try {
    const startMs = Date.now();
    const result = await handler(args);
    const text = JSON.stringify(result);
    debug(`tools/call: ${name} completed in ${Date.now() - startMs}ms (${text.length} chars)`);
    return {
      content: [{ type: "text", text }],
    };
  } catch (error) {
    debug(`tools/call: ${name} error:`, error instanceof Error ? error.message : String(error));
    return {
      content: [{ type: "text", text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Mode selection: --http or stdio (default)
// ---------------------------------------------------------------------------

const isHttpMode = process.argv.includes("--http");

if (isHttpMode) {
  // ==========================================================================
  // HTTP MODE — Persistent server, handles JSON-RPC over HTTP
  // ==========================================================================

  const portArg = process.argv.find((a) => a.startsWith("--port="));
  const port = portArg ? parseInt(portArg.split("=")[1]!, 10) : parseInt(process.env.MCP_SERVER_PORT || "9100", 10);

  const governance = createGovernance();

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });
  }

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Health check endpoint
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", tools: allTools.length }));
      return;
    }

    // MCP endpoint — JSON-RPC over POST
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    const workerIdHeader = req.headers["x-worker-id"] as string | undefined;
    const principalId = workerIdHeader ? `worker:${workerIdHeader}` : null;
    const readOnlyStep = req.headers["x-read-only-step"] === "1";
    const allowedToolIds = parseAllowedToolIds(req.headers["x-allowed-tool-ids"] as string | undefined);

    try {
      const body = await readBody(req);
      const message = JSON.parse(body) as {
        jsonrpc: string;
        id?: string | number;
        method?: string;
        params?: Record<string, unknown>;
      };

      let response: Record<string, unknown> | null = null;

      switch (message.method) {
        case "initialize":
          debug(`HTTP initialize (worker=${workerIdHeader || "none"})`);
          response = {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: (message.params as Record<string, unknown>)?.protocolVersion || "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "wellness", version: "1.0.0" },
            },
          };
          break;

        case "notifications/initialized":
          debug(`HTTP initialized notification (worker=${workerIdHeader || "none"})`);
          res.writeHead(204);
          res.end();
          return;

        case "tools/list": {
          const tools = getToolsForWorker(governance, principalId, allowedToolIds);
          debug(
            `HTTP tools/list: ${tools.length} tools for ${principalId || "all"} ` +
            `readOnly=${readOnlyStep ? "yes" : "no"} ` +
            `allowedTools=${allowedToolIds ? [...allowedToolIds].join(",") || "(none)" : "all"}`,
          );
          response = {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              tools: tools.map((t) => ({
                ...buildMcpListedTool(t, governance, readOnlyStep ? "read" : null),
              })),
            },
          };
          break;
        }

        case "tools/call": {
          const params = message.params as { name: string; arguments?: Record<string, unknown> };
          debug(
            `HTTP tools/call: ${params.name} (worker=${workerIdHeader || "none"} ` +
            `readOnly=${readOnlyStep ? "yes" : "no"} ` +
            `allowedTools=${allowedToolIds ? [...allowedToolIds].join(",") || "(none)" : "all"})`,
          );
          const toolResult = await executeToolCall(
            params.name,
            params.arguments || {},
            governance,
            principalId,
            readOnlyStep,
            allowedToolIds,
          );
          response = {
            jsonrpc: "2.0",
            id: message.id,
            result: toolResult,
          };
          break;
        }

        case "ping":
          response = { jsonrpc: "2.0", id: message.id, result: {} };
          break;

        default:
          if (message.id !== undefined) {
            // Unknown request method — return error
            debug(`HTTP unknown method: ${message.method}`);
            response = {
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32601, message: `Method not found: ${message.method}` },
            };
          } else {
            // Unknown notification — ignore
            res.writeHead(204);
            res.end();
            return;
          }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    } catch (err) {
      debug("HTTP request error:", err instanceof Error ? err.message : String(err));
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      }));
    }
  });

  httpServer.listen(port, "127.0.0.1", () => {
    debug(`HTTP MCP server listening on http://127.0.0.1:${port}/mcp`);
    // Signal readiness to parent process
    if (process.send) {
      process.send({ type: "ready", port });
    }
  });

  // Graceful shutdown
  const shutdown = () => {
    debug("Shutting down HTTP MCP server...");
    httpServer.close(() => {
      debug("HTTP MCP server closed");
      process.exit(0);
    });
    // Force exit after 5s if close doesn't complete
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

} else {
  // ==========================================================================
  // STDIO MODE — Original behavior, spawned per worker invocation
  // ==========================================================================

  const workerId = process.env.WORKER_ID;
  const principalId = workerId ? `worker:${workerId}` : null;
  const readOnlyStep = process.env.READ_ONLY_STEP === "1";
  const allowedToolIds = parseAllowedToolIds(process.env.ALLOWED_TOOL_IDS);
  const governance = createGovernance();
  const visibleTools = getToolsForWorker(governance, principalId, allowedToolIds);

  if (principalId) {
    debug(
      `Governance: worker=${workerId}, readOnly=${readOnlyStep ? "yes" : "no"}, ` +
      `allowedTools=${allowedToolIds ? [...allowedToolIds].join(",") || "(none)" : "all"}, ` +
      `${visibleTools.length}/${allTools.length} tools permitted: ${visibleTools.map((t) => t.name).join(", ")}`,
    );
  }

  const server = new Server(
    { name: "wellness", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    debug(`tools/list requested — returning ${visibleTools.length} tools (readOnly=${readOnlyStep ? "yes" : "no"})`);
    return {
      tools: visibleTools.map((t) => buildMcpListedTool(t, governance, readOnlyStep ? "read" : null)),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    debug(`tools/call: ${name} readOnly=${readOnlyStep ? "yes" : "no"}`, JSON.stringify(args ?? {}));
    return executeToolCall(
      name,
      (args ?? {}) as Record<string, unknown>,
      governance,
      principalId,
      readOnlyStep,
      allowedToolIds,
    );
  });

  debug("Starting MCP wellness server via stdio transport");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  debug("MCP wellness server connected");
}
