export class RuntimeAbortedError extends Error {
  readonly aborted = true;

  constructor(message = "Runtime request aborted.") {
    super(message);
    this.name = "RuntimeAbortedError";
  }
}

export function isRuntimeAbortedError(error: unknown): error is RuntimeAbortedError {
  return error instanceof RuntimeAbortedError
    || (typeof error === "object"
      && error !== null
      && "aborted" in error
      && (error as { aborted?: unknown }).aborted === true);
}

export interface AgentRuntime {
  readonly id: string;
  readonly type: "claude-code" | "codex" | "ollama";
  readonly active: boolean;

  send(message: string, options?: SendOptions): Promise<RuntimeResponse>;
  initialize(config: AgentRuntimeConfig): Promise<void>;
  teardown(): Promise<void>;
  healthCheck(): Promise<boolean>;
  /** Kill an in-flight request without clearing the provider session. */
  abortActiveRun?(): boolean;
}

export interface AgentRuntimeConfig {
  agentId: string;
  systemPrompt: string;
  mcpServers: McpServerConfig[];
  runtimePreferences: {
    model?: string;
    reasoningEffort?: "low" | "medium" | "high" | "max";
    maxTokens?: number;
    timeout?: number;
  };
  coldStartContext?: string;
  /**
   * Which runtime backend should serve this agent's turns. Defaults to
   * "claude-code" (the Claude Code CLI adapter). When "ollama", the
   * RuntimePool constructs an OllamaRuntimeAdapter backed by the shared
   * OllamaProvider instead. Populated from V2AgentConfig.legacyProvider.default.
   */
  backend?: "claude-code" | "ollama";
}

export interface McpServerConfig {
  name: string;
  // Local process-based server
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // Remote URL-based server
  url?: string;
  headers?: Record<string, string>;
}

export interface SendOptions {
  context?: string;
  currentTurnMetadataPrompt?: string;
  /**
   * Per-turn behavioral briefing ("whisper"). Unlike `context`, this is NOT
   * stripped on resumed provider sessions (see omitContextForResumedRuntime),
   * so it reaches the model on every turn — the channel for state-file
   * pointers, search-first reminders, and context-usage signals.
   */
  turnBriefingPrompt?: string;
  timeout?: number;
  onChunk?: (chunk: string) => void;
}

export interface RuntimeResponse {
  text: string;
  durationMs: number;
  model?: string;
  toolsUsed?: string[];
  metadata?: Record<string, unknown>;
}

export type RuntimeState = "spawning" | "active" | "idle" | "closed" | "error";
