import { randomUUID } from "node:crypto";
import type { ChatProvider, ProviderRequest, ProviderResponse } from "./provider.js";
import type {
  AgentRuntime,
  AgentRuntimeConfig,
  RuntimeResponse,
  RuntimeState,
  SendOptions,
} from "./agent-runtime.js";

/**
 * Runs a v2 agent turn through a stateless {@link ChatProvider} (the
 * OllamaProvider) instead of the Claude Code CLI. Mirrors
 * ClaudeCodeAdapter.send()'s prompt assembly (cold-start / context / metadata /
 * briefing / message) and response mapping so the Discord v2 path records the
 * model and token usage the same way.
 *
 * Phase 0 is text-only: tools (MCP) are ignored, and because the provider is
 * stateless and returns no providerSessionId, getSessionId() is always
 * undefined — the discord warm-start layer re-injects history each turn via
 * SendOptions.context.
 */
export class OllamaRuntimeAdapter implements AgentRuntime {
  public readonly id = randomUUID();
  public readonly type = "ollama" as const;

  private config: AgentRuntimeConfig;
  private stateValue: RuntimeState = "idle";

  constructor(
    private readonly provider: ChatProvider,
    config: AgentRuntimeConfig,
  ) {
    this.config = config;
  }

  get active(): boolean {
    return this.stateValue === "spawning" || this.stateValue === "active" || this.stateValue === "idle";
  }

  get state(): RuntimeState {
    return this.stateValue;
  }

  /** Stateless provider: there is no resumable provider session to track. */
  getSessionId(): string | undefined {
    return undefined;
  }

  async initialize(config: AgentRuntimeConfig): Promise<void> {
    this.config = config;
    this.stateValue = "idle";
  }

  async send(message: string, options: SendOptions = {}): Promise<RuntimeResponse> {
    const startedAt = Date.now();
    const prompt = this.buildPrompt(message, options);

    const request: ProviderRequest = {
      prompt,
      ...(this.config.systemPrompt.trim() ? { systemPrompt: this.config.systemPrompt } : {}),
      ...(this.config.runtimePreferences.model ? { model: this.config.runtimePreferences.model } : {}),
    };

    this.stateValue = "active";

    let response: ProviderResponse;
    try {
      response = await this.provider.generate(request);
    } catch (error) {
      this.stateValue = "error";
      throw error;
    }

    this.stateValue = "idle";

    const durationMs = Date.now() - startedAt;
    const providerMetadata = response.metadata;
    const model = providerMetadata?.model ?? this.config.runtimePreferences.model;

    if (options.onChunk && response.text.length > 0) {
      options.onChunk(response.text);
    }

    return {
      text: response.text,
      durationMs,
      ...(model ? { model } : {}),
      metadata: {
        backend: "ollama",
        // Mirror ClaudeCodeAdapter: the discord v2 path reads model / stopReason
        // / durationMs / usage off metadata.providerMetadata to populate the
        // model_runs row (see main.ts v2 turn handler).
        providerMetadata,
        ...(response.raw !== undefined ? { raw: response.raw } : {}),
      },
    };
  }

  async teardown(): Promise<void> {
    this.stateValue = "closed";
  }

  async healthCheck(): Promise<boolean> {
    return this.stateValue !== "closed" && this.stateValue !== "error";
  }

  private buildPrompt(message: string, options: SendOptions): string {
    const sections: string[] = [];
    if (this.config.coldStartContext?.trim()) {
      sections.push(`Cold start context:\n${this.config.coldStartContext.trim()}`);
    }
    if (options.context?.trim()) {
      sections.push(`Context:\n${options.context.trim()}`);
    }
    if (options.currentTurnMetadataPrompt?.trim()) {
      sections.push(options.currentTurnMetadataPrompt.trim());
    }
    if (options.turnBriefingPrompt?.trim()) {
      sections.push(options.turnBriefingPrompt.trim());
    }
    sections.push(message);
    return sections.join("\n\n");
  }
}
