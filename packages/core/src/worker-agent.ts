/**
 * Worker Agent — Runs a Claude CLI call with MCP tools.
 *
 * The CLI spawns an MCP tool server and handles the full agentic loop:
 * tool reasoning, multi-step execution, and final response. Uses OAuth
 * auth through the CLI (no API key required).
 *
 * Uses a watchdog instead of a hard timeout: the process is killed only
 * if stderr goes silent for too long (no MCP activity). This allows
 * long-running multi-step operations to complete as long as progress
 * is being made.
 *
 * Usage:
 *   const result = await runWorkerAgent({
 *     systemPrompt: "You are a nutrition expert...",
 *     mcpServerScript: "/path/to/mcp-server.js",
 *     mcpServerName: "wellness",
 *     task: "Log the user's protein yogurt bowl for breakfast",
 *   });
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseClaudePrintJson } from "./provider.js";
import { buildRuntimePathEnv, resolveDatabasePath } from "./runtime-paths.js";
import type { ProviderReasoningEffort } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Tool definition (used only for type info and reporting, not execution) */
export interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: Record<string, unknown>) => Promise<unknown>;
}

export interface AgentToolCall {
  name: string;
  input: Record<string, unknown>;
  output: unknown;
  durationMs: number;
}

export interface WorkerAgentResult {
  /** Final text output from the agent */
  text: string;
  /** Tool calls extracted from provider metadata (if available) */
  toolCalls: AgentToolCall[];
  /** Total execution time */
  durationMs: number;
  /** CLI stderr output (for debugging MCP connectivity) */
  stderr?: string;
  /** Number of agent turns (> 1 suggests tool use occurred) */
  numTurns?: number;
  /** Raw CLI response object for diagnostics */
  raw?: unknown;
  /** True when the result was salvaged from a timed-out worker */
  partial?: boolean;
  /** Human-readable reason for partial result (e.g. timeout details) */
  partialReason?: string;
}

export interface WorkerAgentConfig {
  /** System prompt with domain expertise */
  systemPrompt: string;
  /** Path to the MCP tool server script (Node.js) */
  mcpServerScript: string;
  /** MCP server name (used in tool name prefixes, default: "worker") */
  mcpServerName?: string;
  /** The task to execute */
  task: string;
  /** Claude CLI command (default: "claude") */
  command?: string;
  /** Model to use (optional, uses CLI default) */
  model?: string;
  /** Claude effort override (xhigh normalizes to Claude's max) */
  reasoningEffort?: ProviderReasoningEffort;
  /**
   * Max time in ms with no stderr activity before the process is killed.
   * The MCP server logs to stderr on every tool call, so activity means
   * the agent is making progress. Default: 90_000 (90s).
   */
  inactivityTimeoutMs?: number;
  /**
   * @deprecated Use inactivityTimeoutMs instead. If set and inactivityTimeoutMs
   * is not, this value is used as the inactivity timeout for backwards compat.
   */
  timeoutMs?: number;
  /** Worker ID for governance permission filtering (e.g. "nutrition-logger") */
  workerId?: string;
  /**
   * Port of a persistent MCP HTTP server. When set, the CLI connects to a
   * thin proxy (mcp-proxy.js) which forwards to the already-running server
   * instead of spawning the full MCP server each time. This eliminates the
   * 60-90s cold start.
   */
  persistentMcpPort?: number;
  /**
   * Additional MCP servers to include in the CLI config alongside the primary
   * server. Each entry is keyed by server name and supports both command-based
   * and URL-based (remote) servers.
   */
  additionalMcpServers?: Record<string, McpServerEntry>;
}

/** MCP server config entry — either command-based (local) or URL-based (remote). */
export type McpServerEntry =
  | { type?: "command"; command: string; args: string[]; env?: Record<string, string> }
  | { type: "url"; url: string; authorization_token?: string };

// ---------------------------------------------------------------------------
// Agent runner
// ---------------------------------------------------------------------------

export async function runWorkerAgent(config: WorkerAgentConfig): Promise<WorkerAgentResult> {
  const {
    systemPrompt,
    mcpServerScript,
    mcpServerName = "worker",
    task,
    command = "claude",
    model,
    reasoningEffort,
    inactivityTimeoutMs,
    timeoutMs,
    workerId,
    persistentMcpPort,
    additionalMcpServers,
  } = config;

  // When using persistent MCP, the 60-90s of MCP server startup noise that
  // normally keeps the watchdog alive is absent. The CLI's response generation
  // (Claude API round-trip after tool calls) can take 60-120s of silence.
  // Use a more generous default to avoid killing healthy workers mid-response.
  const defaultInactivityMs = persistentMcpPort ? 180_000 : 90_000;
  const watchdogMs = inactivityTimeoutMs ?? timeoutMs ?? defaultInactivityMs;
  const startTime = Date.now();

  // Build env vars for the MCP server (governance filtering)
  const mcpEnv: Record<string, string> = buildRuntimePathEnv({
    dbPath: resolveDatabasePath(),
  });
  if (workerId) {
    mcpEnv.WORKER_ID = workerId;
  }

  // Determine which script to spawn: proxy (fast) or direct server (cold start)
  let mcpScript: string;
  let keepaliveFile: string | undefined;
  if (persistentMcpPort) {
    // Use the thin proxy → persistent HTTP server (startup: ~100ms)
    mcpScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "mcp-proxy.js");
    mcpEnv.MCP_SERVER_PORT = String(persistentMcpPort);
    // Keepalive file: the proxy touches this on each request/response so the
    // watchdog can detect activity even though the CLI swallows MCP server stderr.
    keepaliveFile = path.join(os.tmpdir(), `tango-mcp-keepalive-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mcpEnv.MCP_KEEPALIVE_FILE = keepaliveFile;
    console.error(`[worker-agent] Using persistent MCP server on port ${persistentMcpPort} via proxy`);
  } else {
    // Direct MCP server spawn (startup: 60-90s)
    mcpScript = mcpServerScript;
  }

  // Write MCP config to a temp file
  // Strip internal `type` field from MCP entries — Claude CLI infers type from shape
  const sanitizedAdditional: Record<string, unknown> = {};
  if (additionalMcpServers) {
    for (const [name, entry] of Object.entries(additionalMcpServers)) {
      const { type: _type, ...rest } = entry as Record<string, unknown>;
      sanitizedAdditional[name] = rest;
    }
  }

  const mcpConfig: { mcpServers: Record<string, unknown> } = {
    mcpServers: {
      [mcpServerName]: {
        command: process.execPath,
        args: [mcpScript],
        env: mcpEnv,
      },
      ...sanitizedAdditional,
    },
  };

  const tmpDir = os.tmpdir();
  const configPath = path.join(tmpDir, `tango-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(configPath, JSON.stringify(mcpConfig), "utf8");

  try {
    const normalizedReasoningEffort =
      reasoningEffort === "xhigh" ? "max" : reasoningEffort;
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--mcp-config", configPath,
      "--permission-mode", "bypassPermissions",
      "--system-prompt", systemPrompt,
    ];

    if (model) args.push("--model", model);
    if (normalizedReasoningEffort) args.push("--effort", normalizedReasoningEffort);
    args.push(task);

    const result = await execCliWithWatchdog(command, args, watchdogMs, 180_000, keepaliveFile);

    if (result.timedOut) {
      const partialReason =
        `Agent stalled: no activity for ${Math.round(watchdogMs / 1000)}s ` +
        `(total elapsed: ${Math.round((Date.now() - startTime) / 1000)}s). ` +
        `Last stderr: ${result.stderr.slice(-200)}`;

      // Attempt to salvage completed work from partial stdout
      const partial = parseStreamJsonPartialOutput(result.stdout, mcpServerName);
      if (partial.toolCalls.length > 0 || partial.text) {
        console.error(
          `[worker-agent] Timeout but recovered partial output: ` +
          `${partial.toolCalls.length} tool calls, ${partial.text.length} chars text`
        );
        return {
          text: partial.text,
          toolCalls: partial.toolCalls,
          durationMs: Date.now() - startTime,
          stderr: result.stderr || undefined,
          numTurns: partial.numTurns,
          partial: true,
          partialReason,
        };
      }

      throw new Error(partialReason);
    }

    if (result.code !== 0) {
      throw new Error(`CLI failed: code=${result.code} stderr=${result.stderr.slice(0, 500)}`);
    }

    const response = parseClaudePrintJson(result.stdout);

    // Extract tool calls from metadata if available
    const toolCalls = extractToolCallsFromRaw(response.raw, mcpServerName);

    return {
      text: response.text,
      toolCalls,
      durationMs: Date.now() - startTime,
      stderr: result.stderr || undefined,
      numTurns: extractNumTurns(response.raw),
      raw: response.raw,
    };
  } finally {
    // Clean up temp files
    try { fs.unlinkSync(configPath); } catch { /* ignore */ }
    if (keepaliveFile) {
      try { fs.unlinkSync(keepaliveFile); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Partial stdout recovery from stream-json output
// ---------------------------------------------------------------------------

interface PartialRecovery {
  text: string;
  toolCalls: AgentToolCall[];
  numTurns: number;
}

/**
 * Parse Claude CLI `--output-format stream-json` stdout to recover completed
 * tool calls and text from a timed-out worker.
 *
 * Stream-json emits one JSON object per line. We look for:
 * - assistant messages with content blocks (tool_use, text)
 * - tool result messages that pair back to a tool_use by tool_use_id
 *
 * Only fully paired tool calls (tool_use + tool_result) are returned.
 */
export function parseStreamJsonPartialOutput(stdout: string, serverName: string): PartialRecovery {
  const lines = stdout.split(/\r?\n/u);
  const textParts: string[] = [];
  const toolUseById = new Map<string, { name: string; input: Record<string, unknown>; startMs: number }>();
  const toolResults = new Map<string, { output: unknown; endMs: number }>();
  let numTurns = 0;
  let lastEventMs = Date.now();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (typeof event !== "object" || event === null) continue;

    const type = event.type as string | undefined;
    const ts = typeof event.timestamp === "number" ? event.timestamp : lastEventMs;
    lastEventMs = ts;

    // Stream-json assistant message with content blocks
    if (type === "assistant" || event.role === "assistant") {
      numTurns++;
      const content = event.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;

          if (b.type === "text" && typeof b.text === "string") {
            textParts.push(b.text);
          }

          if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
            toolUseById.set(b.id, {
              name: String(b.name).replace(`mcp__${serverName}__`, ""),
              input: (typeof b.input === "object" && b.input !== null ? b.input : {}) as Record<string, unknown>,
              startMs: ts,
            });
          }
        }
      }
    }

    // Stream-json tool result message
    if (type === "tool_result" || event.role === "tool") {
      const toolUseId = (event.tool_use_id ?? event.id) as string | undefined;
      const content = event.content;
      if (toolUseId) {
        let output: unknown = content;
        // content can be an array of content blocks
        if (Array.isArray(content)) {
          const texts = content
            .filter((c: unknown) => c && typeof c === "object" && (c as Record<string, unknown>).type === "text")
            .map((c: unknown) => (c as Record<string, unknown>).text);
          output = texts.length === 1 ? texts[0] : texts.length > 0 ? texts.join("\n") : content;
        }
        toolResults.set(toolUseId, { output, endMs: ts });
      }
    }

    // Also handle the "result" type (final message in stream-json)
    if (type === "result" && typeof event.result === "string") {
      textParts.push(event.result);
    }

    // Handle content_block_delta for streaming text
    if (type === "content_block_delta") {
      const delta = event.delta as Record<string, unknown> | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        textParts.push(delta.text);
      }
    }
  }

  // Build paired tool calls
  const toolCalls: AgentToolCall[] = [];
  for (const [id, use] of toolUseById) {
    const result = toolResults.get(id);
    if (!result) continue; // Incomplete — skip
    toolCalls.push({
      name: use.name,
      input: use.input,
      output: result.output,
      durationMs: Math.max(0, result.endMs - use.startMs),
    });
  }

  return {
    text: textParts.join(""),
    toolCalls,
    numTurns,
  };
}

// ---------------------------------------------------------------------------
// Tool call extraction from CLI response metadata
// ---------------------------------------------------------------------------

function extractToolCallsFromRaw(raw: unknown, serverName: string): AgentToolCall[] {
  // The Claude CLI JSON output may include tool use metadata.
  // Extract what we can for telemetry.
  if (!raw || typeof raw !== "object") return [];

  const payload = raw as Record<string, unknown>;

  // Check for server_tool_use in the raw response
  const serverToolUse = payload.server_tool_use;
  if (Array.isArray(serverToolUse)) {
    return serverToolUse
      .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object")
      .map((entry) => ({
        name: String(entry.name ?? entry.tool_name ?? "unknown").replace(`mcp__${serverName}__`, ""),
        input: (typeof entry.input === "object" && entry.input !== null ? entry.input : {}) as Record<string, unknown>,
        output: entry.output ?? entry.result ?? null,
        durationMs: typeof entry.duration_ms === "number" ? entry.duration_ms : 0,
      }));
  }

  return [];
}

function extractNumTurns(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const payload = raw as Record<string, unknown>;
  const numTurns = payload.num_turns;
  return typeof numTurns === "number" ? numTurns : undefined;
}

// ---------------------------------------------------------------------------
// CLI execution with activity-based watchdog
// ---------------------------------------------------------------------------

interface ExecWatchdogResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/**
 * Spawn a CLI process with a two-phase watchdog:
 *
 * 1. **Startup phase**: generous grace period for CLI auth, API first response,
 *    and MCP server initialization. No output is expected during this phase.
 *    Default: 180s (3 minutes).
 *
 * 2. **Activity phase**: once the first stdout/stderr chunk arrives, switches
 *    to a shorter inactivity timeout. The process is killed only if output
 *    goes silent for longer than `inactivityMs`. Default: 90s.
 *
 * This prevents killing agents that are waiting for a slow API response
 * while still catching agents that stall mid-execution.
 */
function execCliWithWatchdog(
  command: string,
  args: string[],
  inactivityMs: number,
  startupGraceMs: number = 180_000,
  keepaliveFile?: string,
): Promise<ExecWatchdogResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let hasActivity = false;
    let keepaliveInterval: ReturnType<typeof setInterval> | undefined;

    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CLAUDECODE: "" },
    });

    const killProcess = () => {
      timedOut = true;
      if (keepaliveInterval) clearInterval(keepaliveInterval);
      child.kill("SIGTERM");
      setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 2000).unref();
    };

    // Start with startup grace period
    let watchdog = setTimeout(() => {
      console.error(`[worker-agent] startup grace expired after ${Math.round(startupGraceMs / 1000)}s with no output`);
      killProcess();
    }, startupGraceMs);
    watchdog.unref();

    const switchToActivityWatchdog = () => {
      if (!hasActivity) {
        hasActivity = true;
        console.error(`[worker-agent] first activity detected, switching to ${Math.round(inactivityMs / 1000)}s inactivity watchdog`);
      }
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        console.error(`[worker-agent] inactivity timeout after ${Math.round(inactivityMs / 1000)}s`);
        killProcess();
      }, inactivityMs);
      watchdog.unref();
    };

    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString();
      switchToActivityWatchdog();
    });

    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
      switchToActivityWatchdog();
    });

    // When using the persistent MCP server, the CLI swallows the proxy's stderr
    // so stdout/stderr activity detection doesn't work. Monitor a keepalive file
    // that the proxy touches on every request/response as an alternative signal.
    if (keepaliveFile) {
      let lastKeepalive = 0;
      let keepaliveHits = 0;
      keepaliveInterval = setInterval(() => {
        try {
          const content = fs.readFileSync(keepaliveFile, "utf8").trim();
          const ts = parseInt(content, 10);
          if (ts > lastKeepalive) {
            lastKeepalive = ts;
            keepaliveHits++;
            console.error(`[worker-agent] keepalive activity detected (hit #${keepaliveHits}, age=${Date.now() - ts}ms)`);
            switchToActivityWatchdog();
          }
        } catch {
          // File doesn't exist yet — proxy hasn't started writing
        }
      }, 5_000); // Check every 5 seconds
      keepaliveInterval.unref();
    }

    child.on("error", (err) => {
      clearTimeout(watchdog);
      if (keepaliveInterval) clearInterval(keepaliveInterval);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(watchdog);
      if (keepaliveInterval) clearInterval(keepaliveInterval);
      resolve({ stdout, stderr, code, timedOut });
    });

    child.stdin.end();
  });
}
