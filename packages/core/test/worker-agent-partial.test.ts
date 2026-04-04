import { describe, expect, it } from "vitest";
import { parseStreamJsonPartialOutput } from "../src/worker-agent.js";

describe("parseStreamJsonPartialOutput", () => {
  it("returns empty result for empty input", () => {
    const result = parseStreamJsonPartialOutput("", "wellness");
    expect(result.text).toBe("");
    expect(result.toolCalls).toEqual([]);
    expect(result.numTurns).toBe(0);
  });

  it("returns empty result for non-JSON lines", () => {
    const result = parseStreamJsonPartialOutput(
      "Warning: something\nnot json at all\n",
      "wellness",
    );
    expect(result.text).toBe("");
    expect(result.toolCalls).toEqual([]);
  });

  it("extracts text from assistant messages", () => {
    const stdout = [
      JSON.stringify({
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Here are the results." }],
      }),
    ].join("\n");

    const result = parseStreamJsonPartialOutput(stdout, "wellness");
    expect(result.text).toBe("Here are the results.");
    expect(result.numTurns).toBe(1);
  });

  it("extracts paired tool calls (tool_use + tool_result)", () => {
    const stdout = [
      JSON.stringify({
        type: "assistant",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "mcp__wellness__workout_sql",
            input: { query: "SELECT * FROM sets" },
          },
        ],
        timestamp: 1000,
      }),
      JSON.stringify({
        type: "tool_result",
        tool_use_id: "tu_1",
        content: [{ type: "text", text: "3 rows returned" }],
        timestamp: 2000,
      }),
    ].join("\n");

    const result = parseStreamJsonPartialOutput(stdout, "wellness");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe("workout_sql");
    expect(result.toolCalls[0]!.input).toEqual({ query: "SELECT * FROM sets" });
    expect(result.toolCalls[0]!.output).toBe("3 rows returned");
    expect(result.toolCalls[0]!.durationMs).toBe(1000);
  });

  it("excludes incomplete tool calls (tool_use without tool_result)", () => {
    const stdout = [
      // First tool call: complete pair
      JSON.stringify({
        type: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "mcp__wellness__fatsecret_api", input: { action: "search" } },
        ],
        timestamp: 1000,
      }),
      JSON.stringify({
        type: "tool_result",
        tool_use_id: "tu_1",
        content: "Found 5 results",
        timestamp: 1500,
      }),
      // Second tool call: incomplete (no result — agent stalled here)
      JSON.stringify({
        type: "assistant",
        content: [
          { type: "tool_use", id: "tu_2", name: "mcp__wellness__fatsecret_api", input: { action: "log" } },
        ],
        timestamp: 2000,
      }),
    ].join("\n");

    const result = parseStreamJsonPartialOutput(stdout, "wellness");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe("fatsecret_api");
    expect(result.toolCalls[0]!.output).toBe("Found 5 results");
  });

  it("handles multiple complete tool calls", () => {
    const stdout = [
      JSON.stringify({
        type: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "mcp__wellness__workout_sql", input: { q: "1" } },
        ],
      }),
      JSON.stringify({ type: "tool_result", tool_use_id: "tu_1", content: "result 1" }),
      JSON.stringify({
        type: "assistant",
        content: [
          { type: "text", text: "Now querying nutrition." },
          { type: "tool_use", id: "tu_2", name: "mcp__wellness__fatsecret_api", input: { q: "2" } },
        ],
      }),
      JSON.stringify({ type: "tool_result", tool_use_id: "tu_2", content: "result 2" }),
    ].join("\n");

    const result = parseStreamJsonPartialOutput(stdout, "wellness");
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]!.name).toBe("workout_sql");
    expect(result.toolCalls[1]!.name).toBe("fatsecret_api");
    expect(result.text).toBe("Now querying nutrition.");
    expect(result.numTurns).toBe(2);
  });

  it("handles corrupted JSON lines mixed with valid ones", () => {
    const stdout = [
      "not json",
      JSON.stringify({
        type: "assistant",
        content: [{ type: "text", text: "OK" }],
      }),
      "{broken json...",
      JSON.stringify({
        type: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "mcp__w__sql", input: {} },
        ],
      }),
      JSON.stringify({ type: "tool_result", tool_use_id: "tu_1", content: "done" }),
    ].join("\n");

    const result = parseStreamJsonPartialOutput(stdout, "w");
    expect(result.text).toBe("OK");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe("sql");
  });

  it("extracts text from final result event", () => {
    const stdout = JSON.stringify({
      type: "result",
      result: "Final summary text",
    });

    const result = parseStreamJsonPartialOutput(stdout, "wellness");
    expect(result.text).toBe("Final summary text");
  });

  it("strips MCP server name prefix from tool names", () => {
    const stdout = [
      JSON.stringify({
        type: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "mcp__my_server__do_thing", input: {} },
        ],
      }),
      JSON.stringify({ type: "tool_result", tool_use_id: "tu_1", content: "ok" }),
    ].join("\n");

    const result = parseStreamJsonPartialOutput(stdout, "my_server");
    expect(result.toolCalls[0]!.name).toBe("do_thing");
  });

  it("handles tool_result with array content containing multiple text blocks", () => {
    const stdout = [
      JSON.stringify({
        type: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "mcp__wellness__sql", input: {} },
        ],
      }),
      JSON.stringify({
        type: "tool_result",
        tool_use_id: "tu_1",
        content: [
          { type: "text", text: "Line 1" },
          { type: "text", text: "Line 2" },
        ],
      }),
    ].join("\n");

    const result = parseStreamJsonPartialOutput(stdout, "wellness");
    expect(result.toolCalls[0]!.output).toBe("Line 1\nLine 2");
  });

  it("returns no tool calls when stdout has only text content", () => {
    const stdout = JSON.stringify({
      type: "assistant",
      role: "assistant",
      content: [{ type: "text", text: "I was thinking about the query..." }],
    });

    const result = parseStreamJsonPartialOutput(stdout, "wellness");
    expect(result.text).toBe("I was thinking about the query...");
    expect(result.toolCalls).toEqual([]);
  });
});
