import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseClaudePrintJson } from "./provider.js";
import type {
  AgentRuntime,
  AgentRuntimeConfig,
  McpServerConfig,
  RuntimeResponse,
  RuntimeState,
  SendOptions,
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

function cloneServerConfig(server: McpServerConfig): McpServerConfig {
  return {
    name: server.name,
    command: server.command,
    ...(server.args ? { args: [...server.args] } : {}),
    ...(server.env ? { env: { ...server.env } } : {}),
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

function normalizeMcpServers(servers: McpServerConfig[]): Record<string, {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}> {
  const entries = servers
    .map((server) => ({
      name: server.name.trim(),
      command: server.command.trim(),
      args: server.args ? [...server.args] : undefined,
      env: server.env ? { ...server.env } : undefined,
    }))
    .filter((server) => server.name.length > 0 && server.command.length > 0);

  return Object.fromEntries(entries.map((server) => [
    server.name,
    {
      command: server.command,
      ...(server.args ? { args: server.args } : {}),
      ...(server.env ? { env: server.env } : {}),
    },
  ]));
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

export class ClaudeCodeAdapter implements AgentRuntime {
  public readonly id = randomUUID();
  public readonly type = "claude-code" as const;

  private config?: AgentRuntimeConfig;
  private stateValue: RuntimeState = "closed";
  private child?: ChildProcessWithoutNullStreams;
  private sessionId?: string;
  private systemPromptPath?: string;
  private mcpConfigPath?: string;

  constructor(private readonly command = "claude") {}

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
  }

  async initialize(config: AgentRuntimeConfig): Promise<void> {
    await this.teardown();
    this.config = cloneRuntimeConfig(config);
    this.sessionId = undefined;
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
    const prompt = this.buildPrompt(message, options);
    const args = this.buildArgs();

    this.stateValue = "spawning";

    let execution: SpawnExecutionResult;
    try {
      execution = await this.runClaudeProcess(args, prompt, timeoutMs);
    } catch (error) {
      this.sessionId = undefined;
      this.stateValue = "error";
      throw error;
    }

    const durationMs = Date.now() - startedAt;
    const baseMetadata: Record<string, unknown> = {
      exitCode: execution.code,
      signal: execution.signal ?? undefined,
      ...(execution.stderr.trim().length > 0 ? { stderr: execution.stderr.trim() } : {}),
    };

    if (execution.code !== 0) {
      this.sessionId = undefined;
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
          `Claude Code exited with code ${execution.code}. ${execution.stderr.trim() || "No stderr output."}`,
        );
      }
    }

    let parsed;
    try {
      parsed = parseClaudeJsonOutput(execution.stdout);
    } catch (error) {
      this.sessionId = undefined;
      this.stateValue = "error";
      throw error;
    }
    this.sessionId = parsed.providerSessionId?.trim() || this.sessionId;
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

    await removeFileIfPresent(this.systemPromptPath);
    await removeFileIfPresent(this.mcpConfigPath);
    this.systemPromptPath = undefined;
    this.mcpConfigPath = undefined;
    this.sessionId = undefined;
    this.stateValue = "closed";
  }

  async healthCheck(): Promise<boolean> {
    if (!this.child) {
      return false;
    }

    return this.child.exitCode === null && this.child.signalCode === null && !this.child.killed;
  }

  private buildPrompt(message: string, options: SendOptions): string {
    const sections: string[] = [];
    if (!this.sessionId && this.config?.coldStartContext?.trim()) {
      sections.push(`Cold start context:\n${this.config.coldStartContext.trim()}`);
    }
    if (options.context?.trim()) {
      sections.push(`Context:\n${options.context.trim()}`);
    }
    sections.push(message);
    return sections.join("\n\n");
  }

  private buildArgs(): string[] {
    if (!this.config || !this.systemPromptPath || !this.mcpConfigPath) {
      throw new Error("ClaudeCodeAdapter is missing required runtime files.");
    }

    const args = [
      "--print",
      "--dangerously-skip-permissions",
      "--output-format",
      "json",
      "--append-system-prompt",
      this.systemPromptPath,
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
    if (this.sessionId) {
      args.push("--resume", this.sessionId);
    }

    return args;
  }

  private async ensureTempFiles(): Promise<void> {
    if (!this.config) {
      throw new Error("ClaudeCodeAdapter has not been initialized.");
    }

    if (!this.systemPromptPath) {
      this.systemPromptPath = path.join(os.tmpdir(), `tango-claude-system-${randomUUID()}.txt`);
      await fs.promises.writeFile(this.systemPromptPath, this.config.systemPrompt, "utf8");
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
    args: string[],
    prompt: string,
    timeoutMs: number,
  ): Promise<SpawnExecutionResult> {
    return await new Promise<SpawnExecutionResult>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;

      const child = spawn(this.command, args, {
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
              `Claude Code CLI command not found: '${this.command}'. Install Claude Code or configure the adapter command.`,
            ),
          );
          return;
        }

        fail(error);
      });

      child.once("close", (code, signal) => {
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
