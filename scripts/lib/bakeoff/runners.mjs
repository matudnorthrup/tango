// Candidate runners. Every candidate — Ollama Cloud or Claude CLI — produces the
// same normalized RunResult so gates, judging, and the verdict treat them
// identically:
//
//   { model, seconds, text, toolCalls: [{name, input, output?}], stopReason,
//     usage: {inputTokens, outputTokens, ...}, error?, infraError? }
//
// `error` is a model-level failure (counts against the model's pass rate);
// `infraError` is environmental (MCP down, auth, rate limit) and excludes the
// run from the pass-rate denominator so infra flakiness never masquerades as
// model unreliability.
//
// Claude candidates (model id `claude:<cli-model>`) run via `claude -p` print
// mode on the subscription — benchmarks only, never assignment targets. They get
// the SAME governance-scoped tool catalog as Ollama candidates: the :9100
// mcp-proxy scopes tools by the X-Worker-ID header.

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INFRA_ERROR_PATTERN =
  /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|terminated|API key|unauthorized|invalid[_ ]api|401|403|429|50[0-4]|MCP server|tool client|overloaded/i;

export function classifyError(message) {
  return INFRA_ERROR_PATTERN.test(String(message)) ? "infra" : "model";
}

const CLAUDE_MCP_SERVER = "tango";
const CLAUDE_TOOL_PREFIX = `mcp__${CLAUDE_MCP_SERVER}__`;

export async function runOllamaOnce({ model, fixture, makeProvider }) {
  const provider = makeProvider(model);
  const startedAt = Date.now();
  try {
    const r = await provider.generate({
      systemPrompt: fixture.system,
      prompt: fixture.prompt,
      ...(fixture.tools ? { tools: { mode: "default" }, workerId: fixture.worker } : {}),
      model,
    });
    return {
      model,
      seconds: (Date.now() - startedAt) / 1000,
      text: r.text ?? "",
      toolCalls: (r.toolCalls ?? []).map((c) => ({ name: c.name, input: c.input ?? {}, output: c.output })),
      stopReason: r.metadata?.stopReason ?? "?",
      usage: r.metadata?.usage ?? {},
    };
  } catch (e) {
    const message = String(e?.message || e);
    const kind = classifyError(message);
    return {
      model,
      seconds: (Date.now() - startedAt) / 1000,
      text: "",
      toolCalls: [],
      stopReason: "EXCEPTION",
      usage: {},
      ...(kind === "infra" ? { infraError: message } : { error: message }),
    };
  }
}

function parseClaudeStreamJson(stdout) {
  const toolCalls = [];
  const outputsById = new Map();
  let text = "";
  let usage = {};
  let stopReason = "?";
  let isError = false;
  let resultSeen = false;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.type === "assistant") {
      for (const block of event.message?.content ?? []) {
        if (block.type === "tool_use") {
          const name = String(block.name ?? "");
          toolCalls.push({
            id: block.id,
            name: name.startsWith(CLAUDE_TOOL_PREFIX) ? name.slice(CLAUDE_TOOL_PREFIX.length) : name,
            input: block.input ?? {},
          });
        }
      }
    } else if (event.type === "user") {
      for (const block of event.message?.content ?? []) {
        if (block.type === "tool_result" && block.tool_use_id) {
          outputsById.set(block.tool_use_id, block.content);
        }
      }
    } else if (event.type === "result") {
      resultSeen = true;
      text = typeof event.result === "string" ? event.result : "";
      stopReason = event.subtype ?? "?";
      isError = Boolean(event.is_error);
      const u = event.usage ?? {};
      usage = {
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadInputTokens: u.cache_read_input_tokens,
        cacheCreationInputTokens: u.cache_creation_input_tokens,
      };
    }
  }

  for (const call of toolCalls) {
    if (call.id && outputsById.has(call.id)) call.output = outputsById.get(call.id);
    delete call.id;
  }
  return { toolCalls, text, usage, stopReason, isError, resultSeen };
}

export async function runClaudeOnce({ model, fixture, claudeCommand = "claude", mcpPort = 9100, timeoutMs }) {
  const cliModel = model.replace(/^claude:/, "");
  // Neutral cwd: keeps repo CLAUDE.md context out of the candidate's prompt and
  // gives denied file tools nothing interesting to read.
  const workdir = mkdtempSync(join(tmpdir(), "bakeoff-claude-"));
  // Prompt goes IMMEDIATELY after -p: --allowedTools/--disallowedTools are
  // variadic and would swallow a trailing positional prompt word-by-word.
  const args = ["-p", fixture.prompt, "--model", cliModel, "--output-format", "stream-json", "--verbose", "--max-turns", "40"];
  if (fixture.system) args.push("--system-prompt", fixture.system);
  if (fixture.tools) {
    const mcpConfigPath = join(workdir, "mcp.json");
    writeFileSync(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: {
          [CLAUDE_MCP_SERVER]: {
            type: "http",
            url: `http://127.0.0.1:${mcpPort}/mcp`,
            headers: { "X-Worker-ID": fixture.worker },
          },
        },
      }),
    );
    args.push(
      "--mcp-config", mcpConfigPath,
      "--strict-mcp-config",
      "--allowedTools", `mcp__${CLAUDE_MCP_SERVER}`,
      // Parity with Ollama candidates: MCP tools only — no shell, no web, no files.
      "--disallowedTools", "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Task,TodoWrite,Read,Grep,Glob",
    );
  }

  const startedAt = Date.now();
  const result = await new Promise((resolvePromise) => {
    const child = spawn(claudeCommand, args, { cwd: workdir, env: process.env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs ?? Math.max(fixture.timeoutMs ?? 300_000, 420_000));
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ code: -1, stdout, stderr: String(err?.message || err), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut });
    });
  });
  rmSync(workdir, { recursive: true, force: true });

  const seconds = (Date.now() - startedAt) / 1000;
  const parsed = parseClaudeStreamJson(result.stdout);

  if (result.timedOut) {
    return { model, seconds, text: parsed.text, toolCalls: parsed.toolCalls, stopReason: "TIMEOUT", usage: parsed.usage, error: `timed out after ${Math.round(seconds)}s` };
  }
  if (result.code !== 0 || !parsed.resultSeen) {
    const message = (result.stderr || `claude exited ${result.code} with no result event`).slice(0, 500);
    const kind = classifyError(message);
    return {
      model, seconds, text: parsed.text, toolCalls: parsed.toolCalls, stopReason: "EXCEPTION", usage: parsed.usage,
      ...(kind === "infra" ? { infraError: message } : { error: message }),
    };
  }
  if (parsed.isError) {
    return { model, seconds, text: parsed.text, toolCalls: parsed.toolCalls, stopReason: parsed.stopReason, usage: parsed.usage, error: `result error: ${parsed.stopReason}` };
  }
  return { model, seconds, text: parsed.text, toolCalls: parsed.toolCalls, stopReason: parsed.stopReason, usage: parsed.usage };
}
