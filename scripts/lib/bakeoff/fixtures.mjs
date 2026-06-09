// Fixture loading + normalization for the model bake-off harness (v2).
//
// A fixture is the eval contract for one Tango task. v2 splits scoring into:
//   - GATES: machine-checked, binary, per-run (toolContract, outputAssertions, forbiddenTools)
//   - RUBRIC: LLM-judged quality dimensions (weights sum to 1), scored 0..1
// Reliability is measured by repeating each candidate `runs` times and gating on
// pass-rate, with defaults keyed to safetyTier: failure on write-path tasks is
// more expensive, so the bar is higher.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const HARNESS_VERSION = "2.0.0";

export const SAFETY_TIERS = ["read_only_bounded", "read_only_judgment", "write_dry_run", "write_live"];

export const SAFETY_TIER_DEFAULTS = {
  read_only_bounded: { runs: 3, passRateThreshold: 0.8 },
  read_only_judgment: { runs: 3, passRateThreshold: 0.8 },
  write_dry_run: { runs: 5, passRateThreshold: 1.0 },
  write_live: { runs: 5, passRateThreshold: 1.0 },
};

export const DEFAULT_RUBRIC_THRESHOLD = 0.7;

/** Models run for comparison only — never eligible for assignment (subscription
 *  print-mode benchmarks, e.g. Opus/Sonnet). Identified by the `claude:` prefix. */
export function isClaudeModel(model) {
  return typeof model === "string" && model.startsWith("claude:");
}

export function normalizeFixture(raw, { sourcePath } = {}) {
  const tierDefaults = SAFETY_TIER_DEFAULTS[raw.safetyTier] ?? SAFETY_TIER_DEFAULTS.read_only_bounded;

  // Legacy `requiredTools` (v1) lifts into the v2 toolContract form.
  const toolContract = Array.isArray(raw.toolContract)
    ? raw.toolContract
    : (raw.requiredTools ?? []).map((name) => ({ name: String(name).trim() }));

  const rubric = Array.isArray(raw.rubric) ? raw.rubric : [];

  return {
    ...raw,
    sourcePath: sourcePath ?? raw.sourcePath,
    tools: raw.tools !== false,
    runs: Number.isInteger(raw.runs) && raw.runs > 0 ? raw.runs : tierDefaults.runs,
    passRateThreshold: typeof raw.passRateThreshold === "number" ? raw.passRateThreshold : tierDefaults.passRateThreshold,
    rubricThreshold: typeof raw.rubricThreshold === "number" ? raw.rubricThreshold : DEFAULT_RUBRIC_THRESHOLD,
    toolContract,
    outputAssertions: Array.isArray(raw.outputAssertions) ? raw.outputAssertions : [],
    forbiddenTools: Array.isArray(raw.forbiddenTools) ? raw.forbiddenTools : [],
    candidateModels: Array.isArray(raw.candidateModels) ? raw.candidateModels : [],
    benchmarkModels: Array.isArray(raw.benchmarkModels) ? raw.benchmarkModels : [],
    incumbentModel: typeof raw.incumbentModel === "string" ? raw.incumbentModel : null,
    rubric,
    judge: {
      enabled: rubric.length > 0,
      model: "sonnet",
      ...(raw.judge && typeof raw.judge === "object" ? raw.judge : {}),
    },
    timeoutMs: Number.isInteger(raw.timeoutMs) ? raw.timeoutMs : 300_000,
  };
}

export function loadFixture(path) {
  const sourcePath = resolve(process.cwd(), path);
  const raw = JSON.parse(readFileSync(sourcePath, "utf8"));
  return normalizeFixture(raw, { sourcePath });
}

/** Quick-mode fixture for `--prompt` runs with no JSON file. */
export function adHocFixture({ prompt, system, worker, tools }) {
  return normalizeFixture({
    id: "adhoc",
    title: "Ad hoc bake-off",
    category: "adhoc",
    worker,
    taskShape: "unknown",
    safetyTier: "read_only_bounded",
    tools,
    candidateModels: [],
    system,
    prompt,
    successCriteria: [],
    knownFailureModes: [],
    rubric: [],
  });
}
