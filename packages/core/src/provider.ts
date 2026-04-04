import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ProviderReasoningEffort } from "./types.js";

export interface ProviderRequest {
  prompt: string;
  providerSessionId?: string;
  systemPrompt?: string;
  tools?: ProviderToolsConfig;
  model?: string;
  reasoningEffort?: ProviderReasoningEffort;
}

export interface ProviderResponse {
  text: string;
  providerSessionId?: string;
  metadata?: ProviderResponseMetadata;
  toolCalls?: ProviderToolCall[];
  raw?: unknown;
}

export interface ProviderToolCall {
  name: string;
  input: Record<string, unknown>;
  output?: unknown;
  serverName?: string;
  toolName?: string;
}

export interface ProviderUsageMetrics {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface ProviderResponseMetadata {
  model?: string;
  stopReason?: string | null;
  durationMs?: number;
  durationApiMs?: number;
  totalCostUsd?: number;
  usage?: ProviderUsageMetrics;
}

export type ProviderToolMode = "off" | "default" | "allowlist";

export interface ProviderMcpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ProviderToolsConfig {
  mode?: ProviderToolMode;
  allowlist?: string[];
  permissionMode?: "bypass";
  mcpServers?: Record<string, ProviderMcpServerConfig>;
}

export interface ChatProvider {
  generate(request: ProviderRequest): Promise<ProviderResponse>;
}

export interface ClaudeCliProviderOptions {
  command?: string;
  defaultModel?: string;
  defaultReasoningEffort?: ProviderReasoningEffort;
  cwd?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";

export interface CodexExecProviderOptions {
  command?: string;
  defaultModel?: string;
  defaultReasoningEffort?: ProviderReasoningEffort;
  cwd?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
  sandbox?: CodexSandboxMode;
  approvalPolicy?: CodexApprovalPolicy;
  skipGitRepoCheck?: boolean;
}

export const DEFAULT_PROVIDER_TIMEOUT_MS = 300_000;

const claudeResultSchema = z
  .object({
    type: z.string(),
    is_error: z.boolean().optional(),
    result: z.string().optional(),
    session_id: z.string().optional()
  })
  .passthrough();

type ExecFailure = Error & {
  code?: number | string;
  signal?: NodeJS.Signals;
  stderr?: string;
  stdout?: string;
  killed?: boolean;
};

function isExecFailure(error: unknown): error is ExecFailure {
  return error instanceof Error;
}

function describeExecFailure(error: ExecFailure): string {
  const parts: string[] = [error.message];
  if (error.code !== undefined) {
    parts.push(`code=${String(error.code)}`);
  }
  if (error.signal) {
    parts.push(`signal=${error.signal}`);
  }
  if (error.killed) {
    parts.push("killed=true");
  }

  const stderr = error.stderr?.trim();
  if (stderr) {
    parts.push(`stderr=${stderr.slice(0, 500)}`);
  }

  return parts.join(" | ");
}

interface CommandExecutionResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  bufferOverflow: boolean;
}

interface CommandRunOptions {
  cwd?: string;
  timeoutMs: number;
  maxBufferBytes: number;
}

async function runCommand(
  command: string,
  args: string[],
  options: CommandRunOptions
): Promise<CommandExecutionResult> {
  return await new Promise<CommandExecutionResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let bufferOverflow = false;
    let settled = false;

    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const finish = (result: CommandExecutionResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 2_000).unref();
    }, options.timeoutMs);
    timeoutHandle.unref();

    const appendChunk = (target: "stdout" | "stderr", chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      const bytes = Buffer.byteLength(text, "utf8");
      if (target === "stdout") {
        stdoutBytes += bytes;
        stdout += text;
      } else {
        stderrBytes += bytes;
        stderr += text;
      }

      if (stdoutBytes + stderrBytes > options.maxBufferBytes) {
        bufferOverflow = true;
        child.kill("SIGTERM");
      }
    };

    child.stdout.on("data", (chunk) => {
      appendChunk("stdout", chunk);
    });
    child.stderr.on("data", (chunk) => {
      appendChunk("stderr", chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timeoutHandle);
      fail(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeoutHandle);
      finish({
        stdout,
        stderr,
        code,
        signal,
        timedOut,
        bufferOverflow
      });
    });

    child.stdin.end();
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function parseToolInputValue(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (record) return record;

  if (value === undefined) {
    return {};
  }

  if (typeof value !== "string") {
    return null;
  }

  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function normalizeProviderToolName(input: { serverName?: string; toolName?: string; name?: string }): string | undefined {
  const serverName = input.serverName?.trim();
  const toolName = input.toolName?.trim();
  if (serverName && toolName) {
    return `mcp__${serverName}__${toolName}`;
  }

  const name = input.name?.trim();
  return name && name.length > 0 ? name : undefined;
}

function extractToolCallFromRecord(record: Record<string, unknown>): ProviderToolCall | null {
  const serverName = typeof record.server === "string" ? record.server : undefined;
  const toolName = typeof record.tool === "string" ? record.tool : undefined;
  const status = typeof record.status === "string" ? record.status : undefined;
  const error = record.error;

  if (serverName && toolName) {
    if (status && !["completed", "failed"].includes(status)) {
      return null;
    }

    const input = parseToolInputValue(
      record.arguments ?? record.input ?? record.args ?? record.parameters,
    );
    if (!input) return null;

    return {
      name: normalizeProviderToolName({ serverName, toolName })!,
      input,
      output: record.result ?? record.output ?? record.error,
      serverName,
      toolName,
    };
  }

  const rawName =
    typeof record.name === "string"
      ? record.name
      : typeof record.tool_name === "string"
        ? record.tool_name
        : typeof record.tool === "string"
          ? record.tool
        : undefined;
  if (!rawName) {
    return null;
  }

  const input = parseToolInputValue(
    record.input ?? record.arguments ?? record.args ?? record.parameters,
  );
  if (!input) {
    return null;
  }

  const name = normalizeProviderToolName({ name: rawName });
  if (!name) {
    return null;
  }

  return {
    name,
    input,
    output: record.output ?? record.result ?? record.error,
    serverName: typeof record.server === "string" ? record.server : undefined,
    toolName: rawName,
  };
}

function extractProviderToolCalls(raw: unknown): ProviderToolCall[] {
  const toolCalls: ProviderToolCall[] = [];

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }

    const record = asRecord(value);
    if (!record) {
      return;
    }

    const toolCall = extractToolCallFromRecord(record);
    if (toolCall) {
      toolCalls.push(toolCall);
    }

    for (const nestedValue of Object.values(record)) {
      visit(nestedValue);
    }
  };

  visit(raw);
  return toolCalls;
}

function normalizeMcpServers(
  servers: Record<string, ProviderMcpServerConfig> | undefined,
): Record<string, ProviderMcpServerConfig> | undefined {
  if (!servers) return undefined;

  const entries = Object.entries(servers)
    .map(([name, server]) => [name.trim(), server] as const)
    .filter(([name, server]) => name.length > 0 && !!server?.command?.trim());

  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries.map(([name, server]) => [
    name,
    {
      command: server.command.trim(),
      ...(server.args ? { args: server.args } : {}),
      ...(server.env ? { env: server.env } : {}),
    },
  ]));
}

function writeClaudeMcpConfig(
  servers: Record<string, ProviderMcpServerConfig> | undefined,
): string | undefined {
  const mcpServers = normalizeMcpServers(servers);
  if (!mcpServers) {
    return undefined;
  }

  const configPath = path.join(
    os.tmpdir(),
    `tango-provider-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  fs.writeFileSync(
    configPath,
    JSON.stringify({ mcpServers }),
    "utf8",
  );
  return configPath;
}

function formatTomlString(value: string): string {
  return JSON.stringify(value);
}

function formatTomlStringArray(values: string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(",")}]`;
}

function formatTomlInlineStringTable(values: Record<string, string>): string {
  return `{${Object.entries(values)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(",")}}`;
}

function formatTomlPathSegment(value: string): string {
  return /^[A-Za-z0-9_]+$/u.test(value) ? value : JSON.stringify(value);
}

export function parseClaudePrintJson(stdout: string): ProviderResponse {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const events: unknown[] = [];
  let providerSessionId: string | undefined;
  let responseText: string | undefined;
  let resultPayload: z.infer<typeof claudeResultSchema> | undefined;

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    events.push(parsed);
    const record = asRecord(parsed);
    if (record) {
      const eventType = typeof record.type === "string" ? record.type : undefined;
      if (typeof record.session_id === "string" && record.session_id.trim().length > 0) {
        providerSessionId = record.session_id;
      }

      if (eventType === "assistant") {
        const message = asRecord(record.message);
        const content = Array.isArray(message?.content) ? message.content : [];
        for (const item of content) {
          const part = asRecord(item);
          if (part?.type === "text" && typeof part.text === "string" && part.text.trim().length > 0) {
            responseText = part.text.trim();
          }
        }
      }
    }

    const result = claudeResultSchema.safeParse(parsed);
    if (result.success) {
      if (result.data.is_error) {
        throw new Error("Claude CLI returned an error result");
      }

      resultPayload = result.data;
      const text = (result.data.result ?? "").trim();
      if (text.length > 0) {
        responseText = text;
      }
      if (result.data.session_id?.trim()) {
        providerSessionId = result.data.session_id.trim();
      }
    }
  }

  if (events.length === 0) {
    throw new Error("Failed to parse Claude CLI JSON output");
  }

  if (!responseText) {
    throw new Error("Claude CLI returned an empty response");
  }

  return {
    text: responseText,
    providerSessionId,
    metadata: resultPayload ? extractClaudeMetadata(resultPayload) : undefined,
    toolCalls: extractProviderToolCalls({ events }),
    raw: resultPayload ?? { events }
  };
}

function extractCodexMetadata(usagePayload: Record<string, unknown> | undefined): ProviderResponseMetadata | undefined {
  if (!usagePayload) return undefined;

  const asNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

  return {
    usage: {
      inputTokens: asNumber(usagePayload.input_tokens),
      outputTokens: asNumber(usagePayload.output_tokens),
      cacheReadInputTokens: asNumber(usagePayload.cached_input_tokens)
    }
  };
}

export function parseCodexExecJson(stdout: string): ProviderResponse {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const events: unknown[] = [];
  let providerSessionId: string | undefined;
  let responseText: string | undefined;
  let usagePayload: Record<string, unknown> | undefined;

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    events.push(parsed);
    if (!parsed || typeof parsed !== "object") continue;

    const payload = parsed as Record<string, unknown>;
    const type = typeof payload.type === "string" ? payload.type : undefined;
    if (!type) continue;

    if (type === "thread.started") {
      if (typeof payload.thread_id === "string" && payload.thread_id.trim().length > 0) {
        providerSessionId = payload.thread_id;
      }
      continue;
    }

    if (type === "item.completed") {
      const item = payload.item;
      if (!item || typeof item !== "object") continue;
      const itemPayload = item as Record<string, unknown>;
      const itemType = typeof itemPayload.type === "string" ? itemPayload.type : undefined;
      const itemText = typeof itemPayload.text === "string" ? itemPayload.text.trim() : "";
      if (itemType === "agent_message" && itemText.length > 0) {
        responseText = itemText;
      }
      continue;
    }

    if (type === "turn.completed") {
      const usage = payload.usage;
      if (usage && typeof usage === "object") {
        usagePayload = usage as Record<string, unknown>;
      }
      continue;
    }

    if (type === "error") {
      const message = typeof payload.message === "string" ? payload.message : "unknown codex error";
      throw new Error(`Codex CLI returned an error event: ${message}`);
    }
  }

  if (!responseText || responseText.length === 0) {
    throw new Error("Codex CLI returned an empty response");
  }

  return {
    text: responseText,
    providerSessionId,
    metadata: extractCodexMetadata(usagePayload),
    toolCalls: extractProviderToolCalls({ events }),
    raw: { events }
  };
}

function extractClaudeMetadata(payload: Record<string, unknown>): ProviderResponseMetadata {
  const asNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const asStringOrNull = (value: unknown): string | null | undefined => {
    if (value === null) return null;
    return typeof value === "string" ? value : undefined;
  };

  const usage = payload.usage as Record<string, unknown> | undefined;
  const modelUsage = payload.modelUsage as Record<string, unknown> | undefined;
  const model = modelUsage ? Object.keys(modelUsage)[0] : undefined;

  return {
    model,
    stopReason: asStringOrNull(payload.stop_reason),
    durationMs: asNumber(payload.duration_ms),
    durationApiMs: asNumber(payload.duration_api_ms),
    totalCostUsd: asNumber(payload.total_cost_usd),
    usage: usage
      ? {
          inputTokens: asNumber(usage.input_tokens),
          outputTokens: asNumber(usage.output_tokens),
          cacheReadInputTokens: asNumber(usage.cache_read_input_tokens),
          cacheCreationInputTokens: asNumber(usage.cache_creation_input_tokens)
        }
      : undefined
  };
}

function normalizeToolMode(mode: ProviderToolMode | undefined): ProviderToolMode {
  if (mode === "default" || mode === "allowlist") return mode;
  return "off";
}

function normalizeToolAllowlist(value: string[] | undefined): string[] {
  if (!value) return [];
  const deduped = new Set<string>();
  for (const item of value) {
    const normalized = item.trim();
    if (normalized.length === 0) continue;
    deduped.add(normalized);
  }
  return [...deduped];
}

function shouldEnableCodexSearch(tools: ProviderToolsConfig | undefined): boolean {
  const mode = normalizeToolMode(tools?.mode);
  if (mode === "off") {
    return false;
  }

  if (mode === "default") {
    return true;
  }

  const allowlist = normalizeToolAllowlist(tools?.allowlist)
    .map((item) => item.toLowerCase())
    .map((item) => item.replace(/[^a-z0-9_]/gu, ""));

  return allowlist.includes("websearch") || allowlist.includes("webfetch") || allowlist.includes("web_search");
}

function appendClaudeToolArgs(args: string[], tools: ProviderToolsConfig | undefined): void {
  const mode = normalizeToolMode(tools?.mode);
  if (mode === "off") {
    args.push("--tools", "");
    return;
  }

  if (mode === "default") {
    args.push("--tools", "default");
    return;
  }

  const allowlist = normalizeToolAllowlist(tools?.allowlist);
  if (allowlist.length === 0) {
    throw new Error("Claude tool mode 'allowlist' requires at least one tool in tools.allowlist");
  }

  args.push("--tools", "default");
  args.push("--allowedTools", ...allowlist);
}

function appendCodexMcpArgs(args: string[], tools: ProviderToolsConfig | undefined): void {
  const mcpServers = normalizeMcpServers(tools?.mcpServers);
  if (!mcpServers) {
    return;
  }

  for (const [serverName, server] of Object.entries(mcpServers)) {
    const pathSegment = formatTomlPathSegment(serverName);
    args.push("-c", `mcp_servers.${pathSegment}.command=${formatTomlString(server.command)}`);
    args.push("-c", `mcp_servers.${pathSegment}.args=${formatTomlStringArray(server.args ?? [])}`);
    if (server.env && Object.keys(server.env).length > 0) {
      args.push("-c", `mcp_servers.${pathSegment}.env=${formatTomlInlineStringTable(server.env)}`);
    }
  }
}

function normalizeClaudeReasoningEffort(
  value: ProviderReasoningEffort | undefined
): "low" | "medium" | "high" | "max" | undefined {
  if (!value) return undefined;
  if (value === "xhigh") return "max";
  return value;
}

function normalizeCodexReasoningEffort(
  value: ProviderReasoningEffort | undefined
): "low" | "medium" | "high" | "xhigh" | undefined {
  if (!value) return undefined;
  if (value === "max") return "xhigh";
  return value;
}

export function buildClaudeCliArgs(
  request: ProviderRequest,
  options: Pick<ClaudeCliProviderOptions, "defaultModel" | "defaultReasoningEffort"> & { mcpConfigPath?: string },
): string[] {
  const args = ["-p", "--verbose", "--output-format", "stream-json"];

  appendClaudeToolArgs(args, request.tools);

  if (request.tools?.permissionMode === "bypass") {
    args.push("--permission-mode", "bypassPermissions");
  }

  if (options.mcpConfigPath) {
    args.push("--mcp-config", options.mcpConfigPath);
  }

  if (request.providerSessionId) {
    args.push("--resume", request.providerSessionId);
  }

  if (request.systemPrompt && request.systemPrompt.trim().length > 0) {
    args.push("--system-prompt", request.systemPrompt);
  }

  const model = request.model?.trim() || options.defaultModel;
  if (model && model.trim().length > 0) {
    args.push("--model", model);
  }

  const reasoningEffort = normalizeClaudeReasoningEffort(
    request.reasoningEffort ?? options.defaultReasoningEffort
  );
  if (reasoningEffort) {
    args.push("--effort", reasoningEffort);
  }

  args.push(request.prompt);
  return args;
}

function buildCodexPrompt(request: ProviderRequest): string {
  const systemPrompt = request.systemPrompt?.trim();
  if (!systemPrompt) {
    return request.prompt;
  }

  const userPrompt = request.prompt.trim();
  if (userPrompt.length === 0) {
    return `System instructions:\n${systemPrompt}`;
  }

  return `System instructions:\n${systemPrompt}\n\nUser request:\n${request.prompt}`;
}

export function buildCodexExecArgs(
  request: ProviderRequest,
  options: Pick<
    CodexExecProviderOptions,
    "defaultModel" | "defaultReasoningEffort" | "sandbox" | "approvalPolicy" | "skipGitRepoCheck"
  >
): string[] {
  const args: string[] = [];
  const approvalPolicy = options.approvalPolicy?.trim();
  if (approvalPolicy && approvalPolicy.length > 0) {
    args.push("-a", approvalPolicy);
  }

  const sandbox = options.sandbox?.trim();
  if (sandbox && sandbox.length > 0) {
    args.push("--sandbox", sandbox);
  }

  if (shouldEnableCodexSearch(request.tools)) {
    args.push("--search");
  }

  appendCodexMcpArgs(args, request.tools);

  const reasoningEffort = normalizeCodexReasoningEffort(
    request.reasoningEffort ?? options.defaultReasoningEffort
  );
  if (reasoningEffort) {
    args.push("-c", `model_reasoning_effort=${formatTomlString(reasoningEffort)}`);
  }

  args.push("exec");
  if (request.providerSessionId) {
    args.push("resume");
  }

  args.push("--json");

  if (options.skipGitRepoCheck !== false) {
    args.push("--skip-git-repo-check");
  }

  const model = request.model?.trim() || options.defaultModel?.trim();
  if (model && model.length > 0) {
    args.push("--model", model);
  }

  if (request.providerSessionId) {
    args.push(request.providerSessionId);
  }

  args.push(buildCodexPrompt(request));
  return args;
}

export class ClaudeCliProvider implements ChatProvider {
  constructor(private readonly options: ClaudeCliProviderOptions = {}) {}

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const command = this.options.command ?? "claude";
    const mcpConfigPath = writeClaudeMcpConfig(request.tools?.mcpServers);
    const args = buildClaudeCliArgs(request, {
      defaultModel: this.options.defaultModel,
      defaultReasoningEffort: this.options.defaultReasoningEffort,
      mcpConfigPath,
    });
    try {
      const result = await runCommand(command, args, {
        cwd: this.options.cwd,
        timeoutMs: this.options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
        maxBufferBytes: this.options.maxBufferBytes ?? 4 * 1024 * 1024
      });

      if (result.code !== 0 || result.timedOut || result.bufferOverflow) {
        const details: string[] = [];
        if (result.timedOut) {
          details.push("timedOut=true");
        }
        if (result.bufferOverflow) {
          details.push("bufferOverflow=true");
        }
        details.push(`code=${String(result.code)}`);
        if (result.signal) {
          details.push(`signal=${result.signal}`);
        }
        const stderr = result.stderr.trim();
        if (stderr.length > 0) {
          details.push(`stderr=${stderr.slice(0, 500)}`);
        }
        throw new Error(details.join(" | "));
      }

      return parseClaudePrintJson(result.stdout);
    } catch (error) {
      const message = isExecFailure(error) ? describeExecFailure(error) : String(error);
      throw new Error(`Claude CLI request failed: ${message}`);
    } finally {
      if (mcpConfigPath) {
        try {
          fs.unlinkSync(mcpConfigPath);
        } catch {
          // ignore cleanup failures
        }
      }
    }
  }
}

export class CodexExecProvider implements ChatProvider {
  constructor(private readonly options: CodexExecProviderOptions = {}) {}

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const command = this.options.command ?? "codex";
    const args = buildCodexExecArgs(request, {
      defaultModel: this.options.defaultModel,
      defaultReasoningEffort: this.options.defaultReasoningEffort,
      sandbox: this.options.sandbox ?? "read-only",
      approvalPolicy: this.options.approvalPolicy ?? "never",
      skipGitRepoCheck: this.options.skipGitRepoCheck ?? true
    });

    try {
      const result = await runCommand(command, args, {
        cwd: this.options.cwd,
        timeoutMs: this.options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
        maxBufferBytes: this.options.maxBufferBytes ?? 4 * 1024 * 1024
      });

      if (result.code !== 0 || result.timedOut || result.bufferOverflow) {
        const details: string[] = [];
        if (result.timedOut) {
          details.push("timedOut=true");
        }
        if (result.bufferOverflow) {
          details.push("bufferOverflow=true");
        }
        details.push(`code=${String(result.code)}`);
        if (result.signal) {
          details.push(`signal=${result.signal}`);
        }
        const stderr = result.stderr.trim();
        if (stderr.length > 0) {
          details.push(`stderr=${stderr.slice(0, 500)}`);
        }
        throw new Error(details.join(" | "));
      }

      return parseCodexExecJson(result.stdout);
    } catch (error) {
      const message = isExecFailure(error) ? describeExecFailure(error) : String(error);
      throw new Error(`Codex CLI request failed: ${message}`);
    }
  }
}

export class EchoProvider implements ChatProvider {
  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    return {
      text: `Echo: ${request.prompt}`,
      providerSessionId: request.providerSessionId
    };
  }
}
