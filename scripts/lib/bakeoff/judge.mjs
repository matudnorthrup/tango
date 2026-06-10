// Rubric judge: scores a candidate run against the fixture's rubric via
// `claude -p` (subscription print mode — decision locked 2026-06-09).
//
// The judge is BLIND to which model produced the output: the prompt contains the
// task, criteria, failure modes, tool-call log, and final reply — never the
// model name. Returns { scores, weighted, rationale } or { error }.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function truncate(value, max) {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return s == null ? "" : s.length > max ? `${s.slice(0, max)}…[truncated]` : s;
}

// Evidence budget: the judge must SEE tool outputs to distinguish grounding
// from fabrication — a 400-char cap once made it convict five models of
// "fabricating" a history entry that was real but truncated out of view
// (2026-06-09). Generous per-call caps under a total budget; sonnet's context
// absorbs this easily.
const TOOL_OUTPUT_CHAR_CAP = 6000;
const TOOL_LOG_TOTAL_CHAR_CAP = 40000;

export function buildJudgePrompt(fixture, run) {
  let toolLogBudget = TOOL_LOG_TOTAL_CHAR_CAP;
  const toolLog = (run.toolCalls ?? [])
    .map((c, i) => {
      const outputCap = Math.max(500, Math.min(TOOL_OUTPUT_CHAR_CAP, toolLogBudget));
      const line = `${i + 1}. ${c.name}(${truncate(c.input, 600)})${c.output !== undefined ? ` → ${truncate(c.output, outputCap)}` : " → (output not captured)"}`;
      toolLogBudget -= line.length;
      return line;
    })
    .join("\n") || "(no tool calls)";

  return [
    "You are a strict, impartial evaluator of an AI assistant's answer to a task. Judge ONLY what is in the transcript below. Do not reward confident prose that is not backed by the tool-call log.",
    "",
    `## Task given to the assistant`,
    `System prompt: ${truncate(fixture.system, 1500)}`,
    `User request: ${truncate(fixture.prompt, 2000)}`,
    "",
    "## Success criteria",
    ...(fixture.successCriteria ?? []).map((c) => `- ${c}`),
    "",
    "## Known failure modes to watch for",
    ...(fixture.knownFailureModes ?? []).map((c) => `- ${c}`),
    "",
    "## Tool-call log (ground truth of what was actually verified)",
    "If a call shows '(output not captured)', you cannot verify or refute claims sourced from that call — score grounding on what is verifiable and do NOT assume fabrication. Outputs may be truncated; absence of a detail inside a truncated output is not proof of fabrication.",
    toolLog,
    "",
    "## Assistant's final reply",
    truncate(run.text, 6000),
    "",
    "## Rubric — score each dimension 0.0 to 1.0",
    ...fixture.rubric.map((d) => `- "${d.name}" (weight ${d.weight}): ${d.description}`),
    "",
    'Respond with ONLY a JSON object, no prose before or after, exactly this shape:',
    `{"scores": {${fixture.rubric.map((d) => `"${d.name}": 0.0`).join(", ")}}, "rationale": "<=60 words"}`,
  ].join("\n");
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in judge output");
  return JSON.parse(body.slice(start, end + 1));
}

async function invokeClaudeJson({ prompt, model, claudeCommand, timeoutMs }) {
  const workdir = mkdtempSync(join(tmpdir(), "bakeoff-judge-"));
  try {
    return await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(claudeCommand, ["-p", "--model", model, "--output-format", "json", prompt], {
        cwd: workdir,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        rejectPromise(new Error(`judge timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("error", (err) => { clearTimeout(timer); rejectPromise(err); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) return rejectPromise(new Error(`judge exited ${code}: ${stderr.slice(0, 300)}`));
        try {
          const payload = JSON.parse(stdout);
          resolvePromise(typeof payload.result === "string" ? payload.result : stdout);
        } catch {
          resolvePromise(stdout);
        }
      });
    });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

export async function judgeRun({ fixture, run, judgeModel, claudeCommand = "claude", timeoutMs = 180_000 }) {
  const model = judgeModel ?? fixture.judge?.model ?? "sonnet";
  const prompt = buildJudgePrompt(fixture, run);

  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await invokeClaudeJson({ prompt, model, claudeCommand, timeoutMs });
      const parsed = extractJson(raw);
      const scores = {};
      for (const dim of fixture.rubric) {
        const value = parsed?.scores?.[dim.name];
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new Error(`judge omitted dimension "${dim.name}"`);
        }
        scores[dim.name] = Math.min(1, Math.max(0, value));
      }
      const weighted = fixture.rubric.reduce((sum, dim) => sum + dim.weight * scores[dim.name], 0);
      return { scores, weighted, rationale: typeof parsed.rationale === "string" ? parsed.rationale : "" };
    } catch (e) {
      lastError = e;
    }
  }
  return { error: String(lastError?.message || lastError) };
}
