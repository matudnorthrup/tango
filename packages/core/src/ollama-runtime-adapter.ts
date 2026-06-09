import { randomUUID } from "node:crypto";
import {
  OLLAMA_CONTEXT_WINDOW_TOKENS,
  type ChatProvider,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderToolsConfig,
} from "./provider.js";
import type {
  AgentRuntime,
  AgentRuntimeConfig,
  RuntimeResponse,
  RuntimeState,
  SendOptions,
} from "./agent-runtime.js";

// Appended to every Ollama-backed agent's system prompt. DeepSeek tends to fan out
// search/list tools serially (validation saw a one-day Slack digest fire the slack tool
// 20× and a notes lookup hit obsidian 8×), which is slow though not wrong. This nudges it
// toward broad-query-then-drill and batching, cutting latency/iteration use. Ollama-only:
// the adapter is only constructed for clones, so the Claude originals' souls are untouched.
const OLLAMA_TOOL_EFFICIENCY_GUIDANCE =
  "\n\nTool efficiency: when you search or list (Slack, Obsidian, email, web, transactions), " +
  "run ONE broad query first and then drill into only the results that matter — do not loop a " +
  "tool one item, channel, or note at a time. Use batch/multi-target options when a tool offers " +
  "them, and finish in as few tool calls as you can.";

// Per-task model routing (Devin: "per task with a per-agent fallback"). A cheap classifier
// labels the incoming task; clearly-judgment tasks route to a thinking model and
// clearly-data-analysis tasks to a thorough model, while everything else falls back to the
// agent's own configured runtime.model. Defaults are bake-off-backed; all env-overridable.
// The classifier is one fast (~ministral) call and returns the fallback on any failure, so
// routing can never break or block a turn.
const PER_TASK_ROUTING = (process.env.TANGO_PER_TASK_MODEL_ROUTING ?? "true") !== "false";
const TASK_ROUTER_MODEL = process.env.TANGO_TASK_ROUTER_MODEL?.trim() || "ministral-3:3b";
const TASK_ROUTER_BASE_URL = process.env.OLLAMA_BASE_URL?.trim() || "https://ollama.com/v1";
const MODEL_FOR_JUDGMENT = process.env.TANGO_MODEL_JUDGMENT?.trim() || "glm-5";
const MODEL_FOR_DATA = process.env.TANGO_MODEL_DATA?.trim() || "deepseek-v4-pro:cloud";

async function classifyTaskShape(task: string, apiKey: string): Promise<"JUDGMENT" | "DATA" | "OTHER"> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(`${TASK_ROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: TASK_ROUTER_MODEL,
        max_tokens: 4,
        messages: [
          {
            role: "system",
            content:
              "Classify the user's task into exactly one word. " +
              "JUDGMENT = open-ended reasoning, planning, prioritization, recommendations, advice, weighing options, analyze-and-decide. " +
              "DATA = analyzing the user's own structured records (finance, health metrics, transactions, workout/nutrition logs). " +
              "OTHER = everything else: simple lookups, retrieval, tool actions, browsing, ordering, logging, short factual answers. " +
              "Reply with ONLY one word: JUDGMENT, DATA, or OTHER.",
          },
          { role: "user", content: task.slice(0, 2000) },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return "OTHER";
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const out = (json.choices?.[0]?.message?.content ?? "").toUpperCase();
    if (out.includes("JUDGMENT")) return "JUDGMENT";
    if (out.includes("DATA")) return "DATA";
    return "OTHER";
  } catch {
    return "OTHER";
  } finally {
    clearTimeout(timer);
  }
}

// Resolve the model for a turn: per-task override for JUDGMENT/DATA, else the agent's
// configured model (fallback). Returns the fallback if routing is off, no key, or on error.
async function resolveModelForTask(
  task: string,
  fallbackModel: string | undefined,
): Promise<string | undefined> {
  if (!PER_TASK_ROUTING) return fallbackModel;
  const apiKey = process.env.OLLAMA_API_KEY?.trim();
  if (!apiKey || !task.trim()) return fallbackModel;
  const shape = await classifyTaskShape(task, apiKey);
  if (shape === "JUDGMENT") return MODEL_FOR_JUDGMENT;
  if (shape === "DATA") return MODEL_FOR_DATA;
  return fallbackModel;
}

/**
 * Runs a v2 agent turn through a stateless {@link ChatProvider} (the
 * OllamaProvider) instead of the Claude Code CLI. Mirrors
 * ClaudeCodeAdapter.send()'s prompt assembly (cold-start / context / metadata /
 * briefing / message) and response mapping so the Discord v2 path records the
 * model and token usage the same way.
 *
 * Phase 2 adds a provider-agnostic agentic tool loop: when the provider holds an
 * HTTP MCP tool client, send() passes the agent's tool policy + worker id on the
 * ProviderRequest, and OllamaProvider.generate() runs the bounded tool loop
 * against the persistent MCP server. The provider uses a single shared
 * fixed-port (9100) tool client injected in main.ts — the port is not passed per
 * request. toolsUsed is derived from the resulting tool calls (mirroring
 * ClaudeCodeAdapter).
 *
 * The provider remains stateless and returns no providerSessionId, so
 * getSessionId() is always undefined — the discord warm-start layer re-injects
 * history each turn via SendOptions.context.
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

    const tools = this.resolveTools();
    // Per-task routing: clearly-judgment tasks -> a thinking model, clearly-data tasks
    // -> a thorough model, everything else -> this agent's configured model (the
    // fallback). On any failure the classifier returns the fallback, so it can never
    // break a turn.
    const routedModel = await resolveModelForTask(message, this.config.runtimePreferences.model);
    const request: ProviderRequest = {
      prompt,
      ...(this.config.systemPrompt.trim()
        ? { systemPrompt: this.config.systemPrompt + OLLAMA_TOOL_EFFICIENCY_GUIDANCE }
        : { systemPrompt: OLLAMA_TOOL_EFFICIENCY_GUIDANCE.trim() }),
      ...(routedModel ? { model: routedModel } : {}),
      ...(tools ? { tools } : {}),
      // Inbound image bytes for same-turn vision. OllamaProvider folds these
      // through a vision model (qwen3-vl) and strips them before the tool loop,
      // so DeepSeek can reason over image content on the turn it arrives.
      ...(options.images && options.images.length > 0 ? { images: options.images } : {}),
      // Governance principal for the HTTP MCP tool loop. The persistent server
      // resolves this agent's tool permissions from X-Worker-ID. The provider's
      // shared fixed-port tool client targets the server; no port is passed here.
      workerId: this.config.agentId,
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

    // Context-window occupancy stamping. The stateless provider never reports
    // window occupancy, so SessionLifecycleManager's context-reset (0.80
    // threshold) + compaction would never fire and Ollama conversations would
    // grow unbounded. Stamp the peak prompt occupancy + a conservative window so
    // extractOccupancyUsage() (context-usage.ts) computes a fraction the
    // lifecycle can act on. occupancy = peak PROMPT tokens only (matching the
    // Claude provider's prompt-only semantics); completion tokens stay in `usage`
    // for cost accounting but are excluded from the compaction trigger. Because
    // warm-start re-injects the FULL transcript every turn, inputTokens tracks the
    // growing history and the fraction climbs as the conversation does.
    const usage = providerMetadata?.usage;
    const contextOccupancyTokens = usage?.inputTokens ?? 0;

    if (options.onChunk && response.text.length > 0) {
      options.onChunk(response.text);
    }

    // Mirror ClaudeCodeAdapter:417 — deduped tool names drive the model_runs
    // toolsUsed column.
    const toolsUsed = [...new Set((response.toolCalls ?? []).map((tool) => tool.name))];

    return {
      text: response.text,
      durationMs,
      ...(model ? { model } : {}),
      ...(toolsUsed.length > 0 ? { toolsUsed } : {}),
      metadata: {
        backend: "ollama",
        // Mirror ClaudeCodeAdapter: the discord v2 path reads model / stopReason
        // / durationMs / usage off metadata.providerMetadata to populate the
        // model_runs row (see main.ts v2 turn handler).
        providerMetadata,
        // Occupancy fields read by extractOccupancyUsage() → the lifecycle
        // context-reset. findNumericField() recurses into metadata, so these are
        // discovered here at the top level.
        ...(contextOccupancyTokens > 0
          ? {
              contextOccupancyTokens,
              contextWindowTokens: OLLAMA_CONTEXT_WINDOW_TOKENS,
            }
          : {}),
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

  /**
   * The agent's tool policy for the provider tool loop. Enabled whenever the
   * agent is configured with at least one MCP server (the persistent HTTP
   * wellness server). The provider only runs the loop when it also holds a tool
   * client, so this is a no-op for tool-client-less providers.
   */
  private resolveTools(): ProviderToolsConfig | undefined {
    if (this.config.mcpServers.length === 0) {
      return undefined;
    }
    return { mode: "default" };
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
