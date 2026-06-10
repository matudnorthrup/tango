#!/usr/bin/env node
// Model bake-off harness v2 — evaluate which model should run a Tango task.
//
// Doctrine (docs/guides/model-selection.md): reliability first, then cost, then
// speed. Each candidate runs the SAME task N times; a run passes only if every
// machine-checked gate passes (tool contract with argument checks, output
// assertions, forbidden actions); quality is scored by a blind Claude-CLI judge
// against the fixture rubric. The verdict gates on pass-rate, then ranks the
// eligible candidates by cost-per-successful-run (token fallback when prices are
// unknown), with latency as the tiebreak and incumbent hysteresis so assignments
// only change when a challenger strictly earns it.
//
// Usage:
//   node scripts/model-bakeoff.mjs --task agents/evals/model-bakeoff/tasks/<fixture>.json [--runs N] [--models a,b] [--benchmarks claude:sonnet,claude:opus] [--no-judge] [--full]
//   node scripts/model-bakeoff.mjs --prompt "..." [--system "..."] [--worker watson-ollama] [--models a,b,c] [--no-tools] [--full]
//
// Requires: OLLAMA_API_KEY in .env (Ollama candidates); the :9100 MCP server when
// tools are used; a logged-in `claude` CLI for claude:* benchmarks and the judge.
// Candidates run SEQUENTIALLY so wall-clock timings are comparable.
//
// Full per-run results (transcripts) → ~/.tango/evals/results/<fixture>/ (private).
// Committed-safe verdict summary     → agents/evals/model-bakeoff/verdicts/<fixture>.json

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { loadFixture, adHocFixture, normalizeFixture, isClaudeModel, HARNESS_VERSION } from "./lib/bakeoff/fixtures.mjs";
import { evaluateGates } from "./lib/bakeoff/gates.mjs";
import { runOllamaOnce, runClaudeOnce, loadFixtureImages } from "./lib/bakeoff/runners.mjs";
import { judgeRun } from "./lib/bakeoff/judge.mjs";
import { loadPricing, runCostUsd } from "./lib/bakeoff/pricing.mjs";
import { summarizeCandidate, computeVerdict, isEligible, pct, costLabel } from "./lib/bakeoff/verdict.mjs";
import { persistFullResults, persistVerdictSummary, defaultResultsRoot } from "./lib/bakeoff/persist.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);
const csv = (value) => (value ? value.split(",").map((s) => s.trim()).filter(Boolean) : []);
// --task alongside --recompute/--rejudge means "use the current fixture file,
// not the fixture snapshot stored with the results".
const taskFileForRecompute = () => arg("task");

const DEFAULT_MODELS = [
  "deepseek-v4-pro:cloud",
  "deepseek-v4-flash",
  "minimax-m2.5",
  "kimi-k2.6",
  "glm-5",
];

// ---- Recompute mode: re-apply the current verdict policy to stored results ----
// Policy changes (thresholds, floors, ranking) shouldn't require re-running
// models: `--recompute <results.json>` re-summarizes and re-verdicts a stored
// run from ~/.tango/evals/results/ and refreshes the committed verdict summary.
const recomputePath = arg("recompute");
if (recomputePath) {
  const stored = JSON.parse(readFileSync(resolve(process.cwd(), recomputePath), "utf8"));
  // Re-apply the CURRENT fixture definition when available, so gate fixes
  // (not just thresholds) re-score stored runs without re-running models.
  let fixtureSource = stored.fixture;
  if (taskFileForRecompute()) fixtureSource = JSON.parse(readFileSync(resolve(process.cwd(), taskFileForRecompute()), "utf8"));
  const fx = normalizeFixture(fixtureSource, { sourcePath: fixtureSource.sourcePath ?? stored.fixture.sourcePath });
  for (const candidate of stored.candidates) {
    for (const run of candidate.runs) {
      run.gates = evaluateGates(fx, run);
    }
  }
  const summaries = stored.candidates.map((c) => summarizeCandidate(fx, c));
  const verdict = computeVerdict(fx, summaries);
  console.log(`Recompute (policy v${HARNESS_VERSION}) from ${recomputePath} — original run ${stored.when}`);
  console.log("model".padEnd(24) + "| pass | rubric mean(min) | eligible");
  for (const s of summaries) {
    const eligible = s.benchmarkOnly ? "benchmark" : isEligible(fx, s) ? "yes" : "no";
    const rubric = s.rubricMean == null ? "-" : `${s.rubricMean.toFixed(2)}(${s.rubricMin?.toFixed(2) ?? "-"})`;
    console.log(s.model.padEnd(24) + `| ${pct(s.passRate).padStart(4)} | ${rubric.padStart(16)} | ${eligible}`);
  }
  console.log(`\nVERDICT: ${verdict.recommendation ?? "NO ELIGIBLE MODEL"}\n  ${verdict.reason}`);
  const verdictPath = persistVerdictSummary({ fixture: fx, summaries, verdict, repoRoot: ROOT });
  console.log(`Verdict summary updated: ${verdictPath}`);
  process.exit(0);
}

// ---- Rejudge mode: re-run the judge over stored runs (judge-prompt iterations
// shouldn't require re-running models), then recompute the verdict. ------------
const rejudgePath = arg("rejudge");
if (rejudgePath) {
  const stored = JSON.parse(readFileSync(resolve(process.cwd(), rejudgePath), "utf8"));
  const fx = normalizeFixture(stored.fixture, { sourcePath: stored.fixture.sourcePath });
  const judgeModelOverride = arg("judge-model", fx.judge.model);
  for (const candidate of stored.candidates) {
    for (const run of candidate.runs) {
      if (run.gates?.infra || !run.text) continue;
      const result = await judgeRun({ fixture: fx, run, judgeModel: judgeModelOverride });
      run.rubricScore = result.error ? null : result.weighted;
      run.judge = result;
    }
    const scores = candidate.runs.map((r) => r.rubricScore).filter((s) => typeof s === "number");
    console.log(`  ${candidate.model.padEnd(24)} rubric: ${scores.map((s) => s.toFixed(2)).join(", ") || "-"}`);
  }
  const summaries = stored.candidates.map((c) => summarizeCandidate(fx, c));
  const verdict = computeVerdict(fx, summaries);
  console.log(`\nVERDICT: ${verdict.recommendation ?? "NO ELIGIBLE MODEL"}\n  ${verdict.reason}`);
  const rejudgedPath = persistFullResults({ fixture: fx, candidates: stored.candidates, summaries, verdict, resultsRoot: arg("results-dir") ?? defaultResultsRoot() });
  const verdictPath = persistVerdictSummary({ fixture: fx, summaries, verdict, repoRoot: ROOT });
  console.log(`Rejudged results: ${rejudgedPath}\nVerdict summary updated: ${verdictPath}`);
  process.exit(0);
}

// ---- Build the fixture -------------------------------------------------------
const taskFile = arg("task");
let fixture;
if (taskFile) {
  fixture = loadFixture(taskFile);
} else if (arg("prompt")) {
  fixture = adHocFixture({
    prompt: arg("prompt"),
    system: arg("system", "You are a helpful assistant. Use tools when useful."),
    worker: arg("worker", "watson-ollama"),
    tools: !has("no-tools"),
  });
} else {
  console.error("Provide --task <fixture.json> or --prompt \"...\"");
  process.exit(2);
}
if (has("no-tools")) fixture.tools = false;
if (arg("runs")) fixture.runs = Math.max(1, Number(arg("runs")) || fixture.runs);

const candidateModels = csv(arg("models")).length > 0
  ? csv(arg("models"))
  : fixture.candidateModels.length > 0 ? fixture.candidateModels : DEFAULT_MODELS;
const benchmarkModels = arg("benchmarks") === "none"
  ? []
  : csv(arg("benchmarks")).length > 0 ? csv(arg("benchmarks")) : fixture.benchmarkModels;
const seen = new Set();
let allModels = [
  ...candidateModels.map((model) => ({ model, benchmarkOnly: isClaudeModel(model) })),
  ...benchmarkModels.map((model) => ({ model: isClaudeModel(model) ? model : `claude:${model}`, benchmarkOnly: true })),
].filter(({ model }) => (seen.has(model) ? false : (seen.add(model), true)));

let fixtureImages = [];
if (fixture.images.length > 0) {
  try {
    fixtureImages = loadFixtureImages(fixture, ROOT);
  } catch (e) {
    console.error(`INFRA: cannot load fixture images (${String(e?.message || e)})`);
    process.exit(3);
  }
  const excluded = allModels.filter(({ model }) => isClaudeModel(model));
  if (excluded.length > 0) {
    console.log(`NOTE: vision fixture — excluding claude:* candidates (print-mode runner has no image input): ${excluded.map((m) => m.model).join(", ")}`);
    allModels = allModels.filter(({ model }) => !isClaudeModel(model));
  }
}

const judgeEnabled = fixture.judge.enabled && !has("no-judge");
const judgeModel = arg("judge-model", fixture.judge.model);
const full = has("full");

// ---- Preflight: fail loudly on INFRA problems before blaming any model --------
function readEnvKey(name) {
  if (process.env[name]) return process.env[name];
  try {
    return (readFileSync(resolve(ROOT, ".env"), "utf8").match(new RegExp(`^${name}=(.*)$`, "m")) || [])[1]?.trim();
  } catch {
    return undefined;
  }
}

const needsOllama = allModels.some(({ model }) => !isClaudeModel(model));
const needsClaude = judgeEnabled || allModels.some(({ model }) => isClaudeModel(model));

const apiKey = readEnvKey("OLLAMA_API_KEY");
if (needsOllama && !apiKey) {
  console.error("INFRA: OLLAMA_API_KEY not found in env or .env");
  process.exit(3);
}
if (needsClaude) {
  const probe = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    console.error("INFRA: `claude` CLI not available (needed for judge and claude:* benchmarks)");
    process.exit(3);
  }
}

const { OllamaProvider } = await import(resolve(ROOT, "packages/core/dist/provider.js"));
const { McpHttpToolClient } = await import(resolve(ROOT, "packages/core/dist/mcp-http-tool-client.js"));

let toolClient;
if (fixture.tools) {
  toolClient = new McpHttpToolClient({ port: 9100, timeoutMs: 120_000 });
  try {
    const catalog = await toolClient.listOpenAITools(fixture.worker);
    const names = new Set(catalog.map((t) => t?.function?.name).filter(Boolean));
    const missing = (fixture.toolContract ?? []).map((c) => c.name).filter((n) => !names.has(n));
    if (missing.length > 0) {
      console.error(`INFRA: worker '${fixture.worker}' cannot see required tool(s) [${missing.join(", ")}] on :9100 — fix governance permissions before baking off models (otherwise every model 'fails').`);
      process.exit(3);
    }
    console.log(`Tool catalog for worker '${fixture.worker}': ${names.size} tools (contract tools all visible)`);
  } catch (e) {
    console.error(`INFRA: cannot reach :9100 MCP server (${String(e?.message || e).slice(0, 200)})`);
    process.exit(3);
  }
}

const pricing = loadPricing(join(ROOT, "agents", "evals", "model-bakeoff", "pricing.json"));
const makeProvider = (model) =>
  new OllamaProvider({ baseUrl: "https://ollama.com/v1", defaultModel: model, apiKey, timeoutMs: fixture.timeoutMs, toolClient });

// ---- Run candidates × runs (sequential for comparable timings) ----------------
console.log(`\nBake-off v${HARNESS_VERSION}: ${fixture.id} — ${fixture.title}`);
console.log(`worker=${fixture.worker} tools=${fixture.tools} runs/candidate=${fixture.runs} passRate>=${fixture.passRateThreshold} rubric>=${fixture.rubricThreshold} judge=${judgeEnabled ? judgeModel : "off"}`);
console.log(`candidates: ${allModels.map((m) => m.model + (m.benchmarkOnly ? "*" : "")).join(", ")}  (*benchmark only)\n`);
console.log("model".padEnd(24) + "| run | stop         | calls | secs | gates");

async function runOnce(model) {
  if (isClaudeModel(model)) {
    return runClaudeOnce({ model, fixture });
  }
  return runOllamaOnce({ model, fixture, makeProvider, images: fixtureImages });
}

const candidates = [];
for (const { model, benchmarkOnly } of allModels) {
  const runs = [];
  for (let i = 1; i <= fixture.runs; i += 1) {
    let result = await runOnce(model);
    if (result.infraError) {
      await new Promise((r) => setTimeout(r, 3000));
      result = await runOnce(model); // one retry: infra flakes shouldn't burn a run
    }
    result.costUsd = runCostUsd(result.usage, pricing.models[model.replace(/^claude:/, "")]);
    result.gates = evaluateGates(fixture, result);
    runs.push(result);
    const gateLabel = result.gates.infra
      ? `INFRA: ${String(result.infraError).slice(0, 60)}`
      : result.gates.pass ? "pass" : result.gates.failures.map((f) => f.gate).join(",").slice(0, 60);
    console.log(
      model.padEnd(24) + `| ${String(i).padStart(3)} | ${String(result.stopReason).padEnd(12)} | ${String(result.toolCalls.length).padStart(5)} | ${String(Math.round(result.seconds)).padStart(4)} | ${gateLabel}`,
    );
  }
  candidates.push({ model, benchmarkOnly, runs });
}

// ---- Judge (blind, after all runs so candidate timing stays clean) -------------
if (judgeEnabled) {
  console.log(`\nJudging ${candidates.reduce((n, c) => n + c.runs.filter((r) => !r.gates.infra && r.text).length, 0)} runs with ${judgeModel} (blind)…`);
  for (const candidate of candidates) {
    for (const run of candidate.runs) {
      if (run.gates.infra || !run.text) continue;
      const verdict = await judgeRun({ fixture, run, judgeModel });
      if (verdict.error) {
        run.rubricScore = null;
        run.judge = { error: verdict.error };
      } else {
        run.rubricScore = verdict.weighted;
        run.judge = verdict;
      }
    }
    const scores = candidate.runs.map((r) => r.rubricScore).filter((s) => typeof s === "number");
    console.log(`  ${candidate.model.padEnd(24)} rubric: ${scores.map((s) => s.toFixed(2)).join(", ") || "-"}`);
  }
}

// ---- Verdict -------------------------------------------------------------------
const summaries = candidates.map((c) => summarizeCandidate(fixture, c));
const verdict = computeVerdict(fixture, summaries);

console.log(`\n=== SUMMARY (${fixture.runs} runs/candidate) ===`);
console.log("model".padEnd(24) + "| pass | rubric mean(min) | secs | out-tok | cost/success | eligible");
for (const s of summaries) {
  const eligible = s.benchmarkOnly ? "benchmark" : isEligible(fixture, s) ? "yes" : "no";
  const rubric = s.rubricMean == null ? "-" : `${s.rubricMean.toFixed(2)}(${s.rubricMin?.toFixed(2) ?? "-"})`;
  console.log(
    s.model.padEnd(24) +
    `| ${pct(s.passRate).padStart(4)} | ${rubric.padStart(16)} | ${String(s.meanSeconds == null ? "-" : Math.round(s.meanSeconds)).padStart(4)} | ${String(s.meanOutputTokens == null ? "-" : Math.round(s.meanOutputTokens)).padStart(7)} | ${costLabel(s).padEnd(12)} | ${eligible}`,
  );
  if (s.infraRuns > 0) console.log(`  ⚠ ${s.model}: ${s.infraRuns} run(s) excluded as infra failures`);
}

console.log(`\nVERDICT: ${verdict.recommendation ?? "NO ELIGIBLE MODEL"}`);
console.log(`  ${verdict.reason}`);
if (verdict.incumbent) console.log(`  incumbent: ${verdict.incumbent}`);

if (full) {
  console.log("\n=== FULL OUTPUTS ===");
  for (const c of candidates) {
    for (const [i, r] of c.runs.entries()) {
      console.log(`\n---------- ${c.model} run ${i + 1} [stop=${r.stopReason} gates=${r.gates.pass ? "pass" : "FAIL"} rubric=${r.rubricScore?.toFixed(2) ?? "-"}] ----------`);
      console.log((r.text || "").replace(/\n{3,}/g, "\n\n"));
      if (r.judge?.rationale) console.log(`\n[judge] ${r.judge.rationale}`);
    }
  }
}

// ---- Persist --------------------------------------------------------------------
const resultsPath = persistFullResults({ fixture, candidates, summaries, verdict, resultsRoot: arg("results-dir") ?? defaultResultsRoot() });
console.log(`\nFull results (private): ${resultsPath}`);
if (taskFile && existsSync(join(ROOT, "agents", "evals", "model-bakeoff"))) {
  const verdictPath = persistVerdictSummary({ fixture, summaries, verdict, repoRoot: ROOT });
  console.log(`Verdict summary (committed-safe): ${verdictPath}`);
}

process.exit(verdict.infraIncomplete ? 3 : 0);
