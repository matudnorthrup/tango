#!/usr/bin/env node
// Model bake-off harness — run the SAME task across multiple Ollama Cloud models and
// compare completion, tool-call efficiency, latency, and (with --full) output quality.
//
// Intended practice ("golden path first"): when building a NEW task/workflow, have a
// capable model (Claude, or you by hand) establish the CORRECT process first — the tool
// sequence, the prompt, the edge cases. THEN bake off cheaper candidate models on that
// SAME established process to find the cheapest one that still meets the quality bar, and
// assign it per-persona via `runtime.model` in config/v2/agents/<agent>.yaml.
//
// Findings that motivated this (2026-06-08): on BOUNDED tasks all models complete
// identically — pick the fastest (MiniMax M2.5 ~1.8x faster than deepseek-v4-pro). On
// AMBIGUOUS / judgment tasks the "thinking" models (GLM-5, Kimi K2.6) reason deeper and
// win on quality; the fast models are shallower. So: fast model for operational personas,
// thinking model for judgment-heavy ones. Match the model to the task, not one-size-fits-all.
//
// Usage:
//   node scripts/model-bakeoff.mjs --prompt "..." [--system "..."] [--models a,b,c] [--worker watson-ollama] [--full] [--no-tools]
//   node scripts/model-bakeoff.mjs --task path/to/task.json [--models a,b,c] [--full]
//     task.json: { "worker": "watson-ollama", "system": "...", "prompt": "...", "tools": true }
//
// Requires: OLLAMA_API_KEY in .env; the :9100 MCP server running when tools are used.
// Runs SEQUENTIALLY so wall-clock timings are comparable (no contention skew).

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { OllamaProvider } = await import(resolve(ROOT, "packages/core/dist/provider.js"));
const { McpHttpToolClient } = await import(resolve(ROOT, "packages/core/dist/mcp-http-tool-client.js"));

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const DEFAULT_MODELS = [
  "deepseek-v4-pro:cloud", // baseline
  "deepseek-v4-flash",     // same family, faster
  "minimax-m2.5",          // fast + agentic
  "kimi-k2.6",             // strong agentic / thinking
  "glm-5",                 // strong judgment / thinking
];

const apiKey = (readFileSync(resolve(ROOT, ".env"), "utf8").match(/^OLLAMA_API_KEY=(.*)$/m) || [])[1]?.trim();
if (!apiKey) { console.error("OLLAMA_API_KEY not found in .env"); process.exit(2); }

let task = { worker: arg("worker", "watson-ollama"), system: arg("system", "You are a helpful assistant. Use tools when useful."), prompt: arg("prompt"), tools: !has("no-tools") };
const taskFile = arg("task");
if (taskFile) task = { ...task, ...JSON.parse(readFileSync(resolve(process.cwd(), taskFile), "utf8")) };
if (!task.prompt) { console.error("Provide --prompt or --task <file with prompt>"); process.exit(2); }

const models = (arg("models") ? arg("models").split(",").map((s) => s.trim()) : DEFAULT_MODELS).filter(Boolean);
const full = has("full");
const toolClient = task.tools ? new McpHttpToolClient({ port: 9100, timeoutMs: 120000 }) : undefined;

console.log(`Bake-off: worker=${task.worker} tools=${!!task.tools} models=${models.length}`);
console.log(`Task: ${task.prompt.slice(0, 140)}${task.prompt.length > 140 ? "…" : ""}\n`);
console.log("model".padEnd(22) + "| stop        | calls | secs | tools");

const rows = [];
for (const model of models) {
  const provider = new OllamaProvider({ baseUrl: "https://ollama.com/v1", defaultModel: model, apiKey, timeoutMs: 300000, toolClient });
  const t = Date.now();
  try {
    const r = await provider.generate({
      systemPrompt: task.system,
      prompt: task.prompt,
      ...(task.tools ? { tools: { mode: "default" }, workerId: task.worker } : {}),
      model,
    });
    const names = (r.toolCalls || []).map((c) => c.name);
    const secs = ((Date.now() - t) / 1000).toFixed(0);
    rows.push({ model, stop: r.metadata?.stopReason ?? "?", calls: names.length, secs, tools: [...new Set(names)].join(","), reply: r.text || "" });
    console.log(model.padEnd(22) + `| ${String(rows.at(-1).stop).padEnd(11)} | ${String(names.length).padStart(5)} | ${secs.padStart(4)} | ${rows.at(-1).tools}`);
  } catch (e) {
    rows.push({ model, stop: "EXCEPTION", calls: "-", secs: ((Date.now() - t) / 1000).toFixed(0), tools: "", reply: String(e?.message || e) });
    console.log(model.padEnd(22) + `| EXCEPTION   |     - | ${rows.at(-1).secs.padStart(4)} | ${String(e?.message || e).slice(0, 60)}`);
  }
}

if (full) {
  console.log("\n=== FULL OUTPUTS (judge quality here) ===");
  for (const r of rows) {
    console.log(`\n---------- ${r.model}  [stop=${r.stop} calls=${r.calls} ${r.secs}s] ----------`);
    console.log((r.reply || "").replace(/\n{3,}/g, "\n\n").slice(0, 2000));
  }
}
