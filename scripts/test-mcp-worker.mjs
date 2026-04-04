#!/usr/bin/env node
/**
 * Phase 0 Test: Prove MCP connectivity works end-to-end.
 *
 * This script MUST be run outside Claude Code (the CLAUDECODE env var
 * blocks nested CLI sessions). Use scripts/test-mcp-worker.sh or run
 * directly: env -u CLAUDECODE node scripts/test-mcp-worker.mjs
 *
 * Success criteria:
 *   1. CLI exits with code 0
 *   2. Text response is non-empty and mentions data from tools
 *   3. numTurns > 1 (suggests tool-calling loops occurred)
 */

import { runWorkerAgent } from "../packages/core/dist/index.js";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

// Resolve path to the built MCP server
const mcpServerScript = path.join(
  projectRoot,
  "packages/discord/dist/mcp-wellness-server.js"
);

const systemPrompt = [
  "You are a wellness data assistant with access to nutrition, health, and workout tools.",
  "When asked about food or nutrition data, use the fatsecret_api tool with method food_entries_get.",
  "When asked about health data, use health_query with the appropriate command (recovery, date, morning, checkin, trend, sleep).",
  "Always use the available tools to get real data. Do not make up data.",
  "After using tools, summarize what you found concisely.",
].join(" ");

const task =
  "Use the fatsecret_api tool with method food_entries_get to check what has been logged in the food diary today. Report what you find.";

console.log("=== Phase 0: MCP Worker Agent Test ===\n");
console.log("Project root:", projectRoot);
console.log("MCP server:", mcpServerScript);
console.log("CLAUDECODE env:", process.env.CLAUDECODE ?? "(not set)");
console.log("Task:", task);
console.log("\nStarting worker agent...\n");

const startMs = Date.now();

try {
  const result = await runWorkerAgent({
    systemPrompt,
    mcpServerScript,
    mcpServerName: "wellness",
    task,
    model: "sonnet",
    timeoutMs: 90_000,
  });

  const elapsed = Date.now() - startMs;

  console.log("=== Results ===\n");
  console.log("Duration:", result.durationMs, "ms");
  console.log("Num turns:", result.numTurns ?? "(not reported)");
  console.log("Tool calls extracted:", result.toolCalls.length);
  console.log("\n--- Text Response ---");
  console.log(result.text);

  if (result.toolCalls.length > 0) {
    console.log("\n--- Tool Calls ---");
    for (const tc of result.toolCalls) {
      console.log(`  ${tc.name}(${JSON.stringify(tc.input)}) => ${JSON.stringify(tc.output)?.slice(0, 200)}`);
    }
  }

  if (result.stderr) {
    console.log("\n--- CLI Stderr ---");
    console.log(result.stderr.slice(0, 2000));
  }

  // Log raw response for debugging (truncated)
  if (result.raw) {
    console.log("\n--- Raw CLI Response (keys) ---");
    console.log(Object.keys(result.raw));
  }

  // Evaluate success
  console.log("\n=== Evaluation ===\n");

  const hasText = result.text.length > 0;
  const hasToolCalls = result.toolCalls.length > 0;
  const hasMultipleTurns = (result.numTurns ?? 0) > 1;
  const stderrShowsToolUse = result.stderr?.includes("tools/call:") ?? false;

  console.log(`  Text response: ${hasText ? "PASS" : "FAIL"} (${result.text.length} chars)`);
  console.log(`  Tool calls extracted: ${hasToolCalls ? "PASS" : "INFO"} (${result.toolCalls.length})`);
  console.log(`  Multiple turns: ${hasMultipleTurns ? "PASS" : "INFO"} (${result.numTurns ?? 0})`);
  console.log(`  MCP server logged tool use: ${stderrShowsToolUse ? "PASS" : "INFO"}`);

  const passed = hasText && (hasToolCalls || hasMultipleTurns || stderrShowsToolUse);
  console.log(`\n  Overall: ${passed ? "PASS - MCP connectivity works!" : "NEEDS INVESTIGATION"}`);

  if (!passed && !hasToolCalls && !hasMultipleTurns && !stderrShowsToolUse) {
    console.log("\n  The CLI responded but may not have used tools.");
    console.log("  Check the text response for evidence of tool use.");
    console.log("  If the response contains real data, tools worked but metadata wasn't captured.");
  }

  process.exit(passed ? 0 : 1);
} catch (error) {
  console.error("\n=== ERROR ===\n");
  console.error(error instanceof Error ? error.message : String(error));
  if (error instanceof Error && error.stack) {
    console.error("\nStack:", error.stack);
  }
  process.exit(2);
}
