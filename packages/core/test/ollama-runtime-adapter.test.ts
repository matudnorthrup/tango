import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeConfig } from "../src/agent-runtime.js";
import type { ChatProvider, ProviderRequest, ProviderResponse } from "../src/provider.js";
import { OLLAMA_CONTEXT_WINDOW_TOKENS } from "../src/provider.js";
import { extractResponderContextUsage } from "../src/context-usage.js";
import { OllamaRuntimeAdapter } from "../src/ollama-runtime-adapter.js";

function createConfig(overrides: Partial<AgentRuntimeConfig> = {}): AgentRuntimeConfig {
  return {
    agentId: "agent-ollama",
    systemPrompt: "You are the Ollama-backed runtime.",
    mcpServers: [],
    runtimePreferences: {
      model: "deepseek-v4-pro:cloud",
      timeout: 1_000,
    },
    backend: "ollama",
    ...overrides,
  };
}

function createFakeProvider(
  response: ProviderResponse,
  capture?: (request: ProviderRequest) => void,
): ChatProvider {
  return {
    async generate(request: ProviderRequest): Promise<ProviderResponse> {
      capture?.(request);
      return response;
    },
  };
}

describe("OllamaRuntimeAdapter", () => {
  it("maps a ProviderResponse to a RuntimeResponse with model + token usage", async () => {
    const providerResponse: ProviderResponse = {
      text: "Hello from Ollama.",
      metadata: {
        model: "deepseek-v4-pro:cloud",
        stopReason: "stop",
        durationMs: 1234,
        usage: { inputTokens: 42, outputTokens: 7 },
      },
      raw: { ok: true },
    };
    const adapter = new OllamaRuntimeAdapter(createFakeProvider(providerResponse), createConfig());
    await adapter.initialize(createConfig());

    const response = await adapter.send("ping");

    expect(response.text).toBe("Hello from Ollama.");
    expect(response.model).toBe("deepseek-v4-pro:cloud");
    expect(typeof response.durationMs).toBe("number");

    // The discord v2 path reads model_runs token/model fields off
    // metadata.providerMetadata — assert that shape is preserved verbatim.
    const providerMetadata = response.metadata?.providerMetadata as
      | ProviderResponse["metadata"]
      | undefined;
    expect(providerMetadata?.model).toBe("deepseek-v4-pro:cloud");
    expect(providerMetadata?.stopReason).toBe("stop");
    expect(providerMetadata?.usage).toEqual({ inputTokens: 42, outputTokens: 7 });
    expect(response.metadata?.backend).toBe("ollama");
    expect(response.metadata?.raw).toEqual({ ok: true });
  });

  it("stamps context-window occupancy so the lifecycle reset can fire", async () => {
    const providerResponse: ProviderResponse = {
      text: "Reply.",
      metadata: {
        model: "deepseek-v4-pro:cloud",
        usage: { inputTokens: 700_000, outputTokens: 5_000 },
      },
    };
    const adapter = new OllamaRuntimeAdapter(createFakeProvider(providerResponse), createConfig());

    const response = await adapter.send("ping");

    // occupancy = inputTokens + outputTokens; window = OLLAMA_CONTEXT_WINDOW_TOKENS.
    expect(response.metadata?.contextOccupancyTokens).toBe(705_000);
    expect(response.metadata?.contextWindowTokens).toBe(OLLAMA_CONTEXT_WINDOW_TOKENS);

    // End-to-end: the stamped fields are exactly what the lifecycle reads to
    // compute the occupancy fraction (705k / 800k ≈ 0.881 > the 0.80 threshold).
    const usage = extractResponderContextUsage(
      response.metadata as Record<string, unknown>,
    );
    expect(usage).toBeDefined();
    expect(usage?.totalTokens).toBe(705_000);
    expect(usage?.contextWindow).toBe(OLLAMA_CONTEXT_WINDOW_TOKENS);
    expect(usage?.fraction).toBeCloseTo(705_000 / OLLAMA_CONTEXT_WINDOW_TOKENS, 5);
    expect(usage?.fraction).toBeGreaterThan(0.8);
  });

  it("omits occupancy stamping when the provider reports no token usage", async () => {
    const adapter = new OllamaRuntimeAdapter(
      createFakeProvider({ text: "ok", metadata: { model: "deepseek-v4-pro:cloud" } }),
      createConfig(),
    );

    const response = await adapter.send("ping");

    expect(response.metadata?.contextOccupancyTokens).toBeUndefined();
    expect(response.metadata?.contextWindowTokens).toBeUndefined();
  });

  it("carries no session id (stateless provider)", async () => {
    const adapter = new OllamaRuntimeAdapter(
      createFakeProvider({ text: "ok" }),
      createConfig(),
    );

    const response = await adapter.send("hi");

    expect(adapter.getSessionId()).toBeUndefined();
    expect(response.metadata?.sessionId).toBeUndefined();
    expect(adapter.type).toBe("ollama");
  });

  it("assembles the prompt from cold-start, context, metadata, briefing, and message", async () => {
    let captured: ProviderRequest | undefined;
    const adapter = new OllamaRuntimeAdapter(
      createFakeProvider({ text: "ok" }, (request) => {
        captured = request;
      }),
      createConfig({ coldStartContext: "Pinned: foo" }),
    );

    await adapter.send("the message", {
      context: "warm history",
      currentTurnMetadataPrompt: "Now: 2026",
      turnBriefingPrompt: "State file: bar",
    });

    expect(captured?.systemPrompt).toBe("You are the Ollama-backed runtime.");
    expect(captured?.model).toBe("deepseek-v4-pro:cloud");
    expect(captured?.prompt).toBe(
      [
        "Cold start context:\nPinned: foo",
        "Context:\nwarm history",
        "Now: 2026",
        "State file: bar",
        "the message",
      ].join("\n\n"),
    );
  });

  it("falls back to the configured model when the provider omits one", async () => {
    const adapter = new OllamaRuntimeAdapter(
      createFakeProvider({ text: "ok", metadata: { usage: { inputTokens: 1 } } }),
      createConfig({ runtimePreferences: { model: "fallback-model" } }),
    );

    const response = await adapter.send("hi");

    expect(response.model).toBe("fallback-model");
  });

  it("propagates provider errors without falling back", async () => {
    const boom = new Error("ollama down");
    const adapter = new OllamaRuntimeAdapter(
      {
        generate: vi.fn(async () => {
          throw boom;
        }),
      },
      createConfig(),
    );

    await expect(adapter.send("hi")).rejects.toBe(boom);
    expect(await adapter.healthCheck()).toBe(false);
  });
});
