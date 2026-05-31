import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseClaudePrintJson } from "./provider.js";
import {
  RuntimeAbortedError,
  isRuntimeAbortedError,
  type AgentRuntime,
  type AgentRuntimeConfig,
  type McpServerConfig,
  type RuntimeResponse,
  type RuntimeState,
  type SendOptions,
} from "./agent-runtime.js";

const DEFAULT_SEND_TIMEOUT_MS = 900_000;
const TEARDOWN_GRACE_PERIOD_MS = 5_000;
const FORCE_KILL_GRACE_PERIOD_MS = 2_000;

interface SpawnExecutionResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ClaudeCodeAdapterOptions {
  command?: string | null;
  fallbackCommand?: string | null;
}

function cloneServerConfig(server: McpServerConfig): McpServerConfig {
  return {
    name: server.name,
    ...(server.command ? { command: server.command } : {}),
    ...(server.args ? { args: [...server.args] } : {}),
    ...(server.env ? { env: { ...server.env } } : {}),
    ...(server.url ? { url: server.url } : {}),
    ...(server.headers ? { headers: { ...server.headers } } : {}),
  };
}

function cloneRuntimeConfig(config: AgentRuntimeConfig): AgentRuntimeConfig {
  return {
    agentId: config.agentId,
    systemPrompt: config.systemPrompt,
    mcpServers: config.mcpServers.map((server) => cloneServerConfig(server)),
    runtimePreferences: {
      ...config.runtimePreferences,
    },
    ...(config.coldStartContext ? { coldStartContext: config.coldStartContext } : {}),
  };
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "");
}

function normalizeCommand(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function normalizeMcpServers(servers: McpServerConfig[]): Record<string, Record<string, unknown>> {
  const entries = servers
    .map((server) => {
      const name = server.name.trim();
      if (name.length === 0) return null;

      // URL-based remote server
      if (server.url) {
        const url = server.url.trim();
        if (url.length === 0) return null;
        return {
          name,
          config: {
            url,
            ...(server.headers ? { headers: Object.fromEntries(
              Object.entries(server.headers).map(([k, v]) => [k, resolveEnvVars(v)]),
            ) } : {}),
          },
        };
      }

      // Command-based local server
      const command = server.command?.trim();
      if (!command || command.length === 0) return null;
      return {
        name,
        config: {
          command,
          ...(server.args ? { args: [...server.args] } : {}),
          ...(server.env ? { env: { ...server.env } } : {}),
        },
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  return Object.fromEntries(entries.map((entry) => [entry.name, entry.config]));
}

function parseClaudeJsonOutput(stdout: string) {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new Error("Claude Code returned an empty response.");
  }

  try {
    const parsed = JSON.parse(trimmed);
    return parseClaudePrintJson(`${JSON.stringify(parsed)}\n`);
  } catch {
    return parseClaudePrintJson(stdout);
  }
}

function parseJsonLines(stdout: string): unknown[] {
  const events: unknown[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Non-JSON lines are ignored; Claude stream-json output can include tool chatter.
    }
  }
  return events;
}

function extractTextFragments(value: unknown, fragments: string[], limit = 8): void {
  if (fragments.length >= limit || value === null || value === undefined) {
    return;
  }

  if (typeof value === "string") {
    const normalized = value.trim();
    if (normalized.length > 0) {
      fragments.push(normalized);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      extractTextFragments(item, fragments, limit);
      if (fragments.length >= limit) return;
    }
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  const record = value as Record<string, unknown>;
  for (const key of ["message", "text", "result", "error", "type"]) {
    extractTextFragments(record[key], fragments, limit);
    if (fragments.length >= limit) return;
  }
}

function summarizeClaudeFailureOutput(stdout: string): string | undefined {
  const fragments: string[] = [];
  for (const event of parseJsonLines(stdout)) {
    extractTextFragments(event, fragments);
    if (fragments.length >= 8) break;
  }

  const summary = fragments
    .filter((fragment, index, all) => all.indexOf(fragment) === index)
    .join(" | ")
    .trim();
  if (summary.length > 0) {
    return summary.slice(0, 800);
  }

  const raw = stdout.trim();
  return raw.length > 0 ? raw.slice(0, 800) : undefined;
}

function describeClaudeFailure(execution: SpawnExecutionResult): string {
  const parts: string[] = [];
  const stderr = execution.stderr.trim();
  if (stderr.length > 0) {
    parts.push(`stderr=${stderr.slice(0, 800)}`);
  }

  const stdoutSummary = summarizeClaudeFailureOutput(execution.stdout);
  if (stdoutSummary) {
    parts.push(`stdout=${stdoutSummary}`);
  }

  if (execution.signal) {
    parts.push(`signal=${execution.signal}`);
  }

  return parts.length > 0 ? parts.join(" | ") : "No stderr output.";
}

function isClaudeAuthenticationFailure(execution: SpawnExecutionResult): boolean {
  const haystack = `${execution.stderr}\n${execution.stdout}`.toLowerCase();
  return (
    haystack.includes("authentication_failed") ||
    haystack.includes("authentication_error") ||
    haystack.includes("failed to authenticate") ||
    haystack.includes("invalid authentication credentials") ||
    haystack.includes("api error: 401")
  );
}

async function removeFileIfPresent(filePath: string | undefined): Promise<void> {
  if (!filePath) return;
  try {
    await fs.promises.unlink(filePath);
  } catch {
    // Ignore cleanup failures for already-removed temp files.
  }
}

async function waitForChildClose(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("close", onClose);
      resolve(value);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();

    child.once("close", onClose);
  });
}

const SYSTEM_PROMPT_WARN_BYTES = 512 * 1024; // warn if prompt exceeds 512KB

export class ClaudeCodeAdapter implements AgentRuntime {
  public readonly id = randomUUID();
  public readonly type = "claude-code" as const;

  private readonly command: string;
  private readonly fallbackCommand?: string;
  private config?: AgentRuntimeConfig;
  private stateValue: RuntimeState = "closed";
  private child?: ChildProcessWithoutNullStreams;
  private sessionId?: string;
  private sessionCommand?: string;
  private mcpConfigPath?: string;
  private abortRequested = false;

  constructor(commandOrOptions: string | ClaudeCodeAdapterOptions = "claude") {
    if (typeof commandOrOptions === "string") {
      this.command = normalizeCommand(commandOrOptions) ?? "claude";
      this.fallbackCommand = normalizeCommand(process.env.CLAUDE_SECONDARY_CLI_COMMAND);
      return;
    }

    this.command = normalizeCommand(commandOrOptions.command) ?? "claude";
    this.fallbackCommand = Object.prototype.hasOwnProperty.call(commandOrOptions, "fallbackCommand")
      ? normalizeCommand(commandOrOptions.fallbackCommand)
      : normalizeCommand(process.env.CLAUDE_SECONDARY_CLI_COMMAND);
  }

  get active(): boolean {
    return this.stateValue === "spawning" || this.stateValue === "active" || this.stateValue === "idle";
  }

  get state(): RuntimeState {
    return this.stateValue;
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  resumeSession(sessionId: string): void {
    const normalized = sessionId.trim();
    this.sessionId = normalized.length > 0 ? normalized : undefined;
    this.sessionCommand = undefined;
  }

  abortActiveRun(): boolean {
    const child = this.child;
    if (!child) {
      return false;
    }

    this.abortRequested = true;
    child.kill("SIGTERM");
    return true;
  }

  async initialize(config: AgentRuntimeConfig): Promise<void> {
    await this.teardown();
    this.config = cloneRuntimeConfig(config);
    this.sessionId = undefined;
    this.sessionCommand = undefined;
    this.stateValue = "idle";
  }

  async send(message: string, options: SendOptions = {}): Promise<RuntimeResponse> {
    if (!this.config) {
      throw new Error("ClaudeCodeAdapter has not been initialized.");
    }
    if (this.child) {
      throw new Error("ClaudeCodeAdapter is already processing a message.");
    }

    await this.ensureTempFiles();

    const startedAt = Date.now();
    const timeoutMs = options.timeout ?? this.config.runtimePreferences.timeout ?? DEFAULT_SEND_TIMEOUT_MS;
    const attempts = this.buildCommandAttempts();

    for (const [attemptIndex, attempt] of attempts.entries()) {
      const hasFallbackAttempt = attemptIndex < attempts.length - 1;
      const resumeForCommand = this.shouldResumeForCommand(attempt.command, attempt.allowUnboundSession);
      const prompt = this.buildPrompt(message, options, resumeForCommand);
      const args = this.buildArgs(resumeForCommand);

      this.stateValue = "spawning";

      let execution: SpawnExecutionResult;
      try {
        execution = await this.runClaudeProcess(attempt.command, args, prompt, timeoutMs);
      } catch (error) {
        if (isRuntimeAbortedError(error)) {
          this.stateValue = "idle";
          throw error;
        }
        this.sessionId = undefined;
        this.sessionCommand = undefined;
        this.stateValue = "error";
        throw error;
      }

      const durationMs = Date.now() - startedAt;
      const baseMetadata: Record<string, unknown> = {
        exitCode: execution.code,
        signal: execution.signal ?? undefined,
        command: attempt.command,
        ...(execution.stderr.trim().length > 0 ? { stderr: execution.stderr.trim() } : {}),
      };

      if (execution.code !== 0) {
        if (hasFallbackAttempt && isClaudeAuthenticationFailure(execution)) {
          continue;
        }

        this.sessionId = undefined;
        this.sessionCommand = undefined;
        this.stateValue = "error";

        try {
          const parsed = parseClaudeJsonOutput(execution.stdout);
          const toolsUsed = [...new Set((parsed.toolCalls ?? []).map((tool) => tool.name))];
          return {
            text: parsed.text,
            durationMs,
            model: parsed.metadata?.model ?? this.config.runtimePreferences.model,
            toolsUsed,
            metadata: {
              ...baseMetadata,
              sessionId: parsed.providerSessionId,
              raw: parsed.raw,
              providerMetadata: parsed.metadata,
              error: true,
            },
          };
        } catch {
          throw new Error(
            `Claude Code exited with code ${execution.code}. ${describeClaudeFailure(execution)}`,
          );
        }
      }

      let parsed;
      try {
        parsed = parseClaudeJsonOutput(execution.stdout);
      } catch (error) {
        this.sessionId = undefined;
        this.sessionCommand = undefined;
        this.stateValue = "error";
        throw error;
      }
      this.sessionId = parsed.providerSessionId?.trim() || this.sessionId;
      if (this.sessionId) {
        this.sessionCommand = attempt.command;
      }
      this.stateValue = "idle";

      if (options.onChunk && parsed.text.length > 0) {
        options.onChunk(parsed.text);
      }

      const toolsUsed = [...new Set((parsed.toolCalls ?? []).map((tool) => tool.name))];

      return {
        text: parsed.text,
        durationMs,
        model: parsed.metadata?.model ?? this.config.runtimePreferences.model,
        toolsUsed,
        metadata: {
          ...baseMetadata,
          sessionId: this.sessionId,
          raw: parsed.raw,
          providerMetadata: parsed.metadata,
        },
      };
    }

    this.sessionId = undefined;
    this.sessionCommand = undefined;
    this.stateValue = "error";
    throw new Error("Claude Code request failed before any command could be attempted.");
  }

  async teardown(): Promise<void> {
    const child = this.child;
    this.child = undefined;

    if (child) {
      child.kill("SIGTERM");
      const exitedOnTerm = await waitForChildClose(child, TEARDOWN_GRACE_PERIOD_MS);
      if (!exitedOnTerm && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForChildClose(child, FORCE_KILL_GRACE_PERIOD_MS);
      }
    }

    await removeFileIfPresent(this.mcpConfigPath);
    this.mcpConfigPath = undefined;
    this.sessionId = undefined;
    this.sessionCommand = undefined;
    this.stateValue = "closed";
  }

  async healthCheck(): Promise<boolean> {
    if (!this.child) {
      return false;
    }

    return this.child.exitCode === null && this.child.signalCode === null && !this.child.killed;
  }

  private buildPrompt(message: string, options: SendOptions, resumeForCommand: boolean): string {
    const sections: string[] = [];
    if (!resumeForCommand && this.config?.coldStartContext?.trim()) {
      sections.push(`Cold start context:\n${this.config.coldStartContext.trim()}`);
    }
    if (options.context?.trim()) {
      sections.push(`Context:\n${options.context.trim()}`);
    }
    sections.push(message);
    return sections.join("\n\n");
  }

  private buildCommandAttempts(): Array<{ command: string; allowUnboundSession: boolean }> {
    const attempts: Array<{ command: string; allowUnboundSession: boolean }> = [];
    const seen = new Set<string>();
    const add = (command: string | undefined, allowUnboundSession: boolean) => {
      if (!command || seen.has(command)) return;
      seen.add(command);
      attempts.push({ command, allowUnboundSession });
    };

    if (this.sessionCommand) {
      add(this.sessionCommand, true);
    }
    add(this.command, true);
    add(this.fallbackCommand, false);
    return attempts;
  }

  private shouldResumeForCommand(command: string, allowUnboundSession: boolean): boolean {
    if (!this.sessionId) {
      return false;
    }
    if (this.sessionCommand) {
      return this.sessionCommand === command;
    }
    return allowUnboundSession;
  }

  private buildArgs(resumeForCommand: boolean): string[] {
    if (!this.config || !this.mcpConfigPath) {
      throw new Error("ClaudeCodeAdapter is missing required runtime files.");
    }

    const systemPrompt = this.config.systemPrompt;
    const promptBytes = Buffer.byteLength(systemPrompt, "utf8");
    if (promptBytes > SYSTEM_PROMPT_WARN_BYTES) {
      console.warn(
        `[ClaudeCodeAdapter] System prompt is ${promptBytes} bytes (${(promptBytes / 1024).toFixed(0)}KB). ` +
        `Prompts exceeding OS ARG_MAX (~1MB on macOS) may be silently truncated.`,
      );
    }

    const args = [
      "--print",
      "--dangerously-skip-permissions",
      "--verbose",
      "--output-format",
      "stream-json",
      "--append-system-prompt",
      systemPrompt,
      "--mcp-config",
      this.mcpConfigPath,
    ];

    const { model, reasoningEffort, maxTokens } = this.config.runtimePreferences;
    if (model) {
      args.push("--model", model);
    }
    if (reasoningEffort) {
      args.push("--effort", reasoningEffort);
    }
    if (typeof maxTokens === "number" && Number.isFinite(maxTokens)) {
      args.push("--max-tokens", String(Math.trunc(maxTokens)));
    }
    if (resumeForCommand && this.sessionId) {
      args.push("--resume", this.sessionId);
    }

    return args;
  }

  private async ensureTempFiles(): Promise<void> {
    if (!this.config) {
      throw new Error("ClaudeCodeAdapter has not been initialized.");
    }

    if (!this.mcpConfigPath) {
      this.mcpConfigPath = path.join(os.tmpdir(), `tango-claude-mcp-${randomUUID()}.json`);
      await fs.promises.writeFile(
        this.mcpConfigPath,
        JSON.stringify({ mcpServers: normalizeMcpServers(this.config.mcpServers) }),
        "utf8",
      );
    }
  }

  private async runClaudeProcess(
    command: string,
    args: string[],
    prompt: string,
    timeoutMs: number,
  ): Promise<SpawnExecutionResult> {
    return await new Promise<SpawnExecutionResult>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;

      const child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      this.stateValue = "active";

      const finish = (result: SpawnExecutionResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        this.child = undefined;
        resolve(result);
      };

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        this.child = undefined;
        reject(error);
      };

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        const forceKillTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }, FORCE_KILL_GRACE_PERIOD_MS);
        forceKillTimer.unref();
      }, timeoutMs);
      timeoutHandle.unref();

      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      });

      child.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          fail(
            new Error(
              `Claude Code CLI command not found: '${command}'. Install Claude Code or configure the adapter command.`,
            ),
          );
          return;
        }

        fail(error);
      });

      child.once("close", (code, signal) => {
        if (this.abortRequested) {
          this.abortRequested = false;
          this.stateValue = "idle";
          fail(new RuntimeAbortedError("Claude Code run aborted by user."));
          return;
        }

        if (timedOut) {
          fail(new Error(`Claude Code request timed out after ${timeoutMs}ms.`));
          return;
        }

        finish({
          stdout,
          stderr,
          code,
          signal,
        });
      });

      child.stdin.end(prompt, "utf8");
    });
  }
}
