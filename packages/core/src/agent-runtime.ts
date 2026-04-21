export interface AgentRuntime {
  readonly id: string;
  readonly type: "claude-code" | "codex";
  readonly active: boolean;

  send(message: string, options?: SendOptions): Promise<RuntimeResponse>;
  initialize(config: AgentRuntimeConfig): Promise<void>;
  teardown(): Promise<void>;
  healthCheck(): Promise<boolean>;
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
}

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface SendOptions {
  context?: string;
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
