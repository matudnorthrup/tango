import { describe, expect, it } from "vitest";

import { aggregateModelPairs, buildModelScorecard, type ModelRunStatLike } from "../src/model-scorecard.js";

function run(overrides: Partial<ModelRunStatLike> = {}): ModelRunStatLike {
  return {
    agentId: "sierra-ollama",
    model: "deepseek-v4-pro:cloud",
    stopReason: "stop",
    latencyMs: 1000,
    outputTokens: 500,
    isError: false,
    ...overrides,
  };
}

describe("aggregateModelPairs", () => {
  it("groups by agent and model with error rates, cap hits, and percentiles", () => {
    const rows = [
      run({ latencyMs: 1000 }),
      run({ latencyMs: 2000 }),
      run({ latencyMs: 9000, isError: true }),
      run({ stopReason: "max_tool_iters", latencyMs: 4000 }),
      run({ agentId: "watson", model: "glm-5" }),
    ];
    const pairs = aggregateModelPairs(rows);
    expect(pairs).toHaveLength(2);
    const sierra = pairs[0];
    expect(sierra.agentId).toBe("sierra-ollama");
    expect(sierra.runs).toBe(4);
    expect(sierra.errors).toBe(1);
    expect(sierra.errorRate).toBeCloseTo(0.25);
    expect(sierra.capHits).toBe(1);
    expect(sierra.p50LatencyMs).toBe(2000);
    expect(sierra.p95LatencyMs).toBe(9000);
  });

  it("handles null models and missing latency without NaN", () => {
    const pairs = aggregateModelPairs([run({ model: null, latencyMs: null, outputTokens: null })]);
    expect(pairs[0].model).toBe("(unknown)");
    expect(pairs[0].p50LatencyMs).toBeNull();
    expect(pairs[0].meanOutputTokens).toBeNull();
  });
});

describe("buildModelScorecard flags", () => {
  const base = {
    evaluatedModels: new Set(["deepseek-v4-pro:cloud", "glm-5", "minimax-m2.5"]),
    windowDays: 7,
    now: new Date("2026-06-09T12:00:00Z"),
  };

  it("flags high error rates only above the run minimum", () => {
    const failing = Array.from({ length: 5 }, () => run({ isError: true }));
    const scorecard = buildModelScorecard({ ...base, current: failing, previous: [] });
    expect(scorecard.flags.some((f) => f.startsWith("HIGH ERROR RATE"))).toBe(true);

    const tooFew = buildModelScorecard({ ...base, current: failing.slice(0, 3), previous: [] });
    expect(tooFew.flags.some((f) => f.startsWith("HIGH ERROR RATE"))).toBe(false);
  });

  it("flags regressions vs the prior window", () => {
    const previous = Array.from({ length: 10 }, (_, i) => run({ isError: i === 0 })); // 10%
    const current = Array.from({ length: 10 }, (_, i) => run({ isError: i < 3 })); // 30%
    const scorecard = buildModelScorecard({ ...base, current, previous });
    expect(scorecard.flags.some((f) => f.startsWith("REGRESSION"))).toBe(true);
  });

  it("flags cap hits at any volume", () => {
    const scorecard = buildModelScorecard({
      ...base,
      current: [run({ stopReason: "max_tool_iters" })],
      previous: [],
    });
    expect(scorecard.flags.some((f) => f.startsWith("CAP HITS"))).toBe(true);
  });

  it("flags high-volume pairs whose model has no verdict coverage", () => {
    const current = Array.from({ length: 25 }, () => run({ model: "mystery-model" }));
    const scorecard = buildModelScorecard({ ...base, current, previous: [] });
    expect(scorecard.flags.some((f) => f.startsWith("NEVER BAKED OFF"))).toBe(true);

    const covered = buildModelScorecard({
      ...base,
      current: Array.from({ length: 25 }, () => run()),
      previous: [],
    });
    expect(covered.flags.some((f) => f.startsWith("NEVER BAKED OFF"))).toBe(false);
  });

  it("renders a summary with the table and no flags note when nominal", () => {
    const scorecard = buildModelScorecard({ ...base, current: [run(), run()], previous: [] });
    expect(scorecard.summary).toContain("Model scorecard");
    expect(scorecard.summary).toContain("No flags");
    expect(scorecard.summary).toContain("sierra-ollama deepseek-v4-pro:cloud");
  });
});

describe("coverage alias normalization", () => {
  it("counts claude:sonnet verdict coverage for claude-sonnet-4-6 production runs", () => {
    const current = Array.from({ length: 25 }, () =>
      run({ agentId: "watson", model: "claude-sonnet-4-6" }),
    );
    const scorecard = buildModelScorecard({
      current,
      previous: [],
      evaluatedModels: new Set(["sonnet"]),
      windowDays: 7,
      now: new Date("2026-06-09T12:00:00Z"),
    });
    expect(scorecard.flags.some((f) => f.startsWith("NEVER BAKED OFF"))).toBe(false);
  });
});

describe("recent-window sub-line", () => {
  it("reports the last-24h provider split when recent rows are provided", () => {
    const scorecard = buildModelScorecard({
      current: [run(), run()],
      previous: [],
      recent: [run({ providerName: "ollama" }), run({ providerName: "ollama" }), run({ providerName: "claude-code-v2" })],
      evaluatedModels: new Set(["deepseek-v4-pro:cloud"]),
      windowDays: 7,
      now: new Date("2026-06-09T12:00:00Z"),
    });
    expect(scorecard.summary).toContain("Last 24h: 3 runs (2 ollama, 1 claude-code-v2)");
  });
});
