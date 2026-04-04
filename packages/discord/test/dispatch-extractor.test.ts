import { describe, expect, it } from "vitest";
import {
  DISPATCH_TOOL_FULL_NAME,
  extractDispatchToolCalls,
} from "../src/dispatch-extractor.js";

describe("extractDispatchToolCalls", () => {
  it("extracts dispatches from normalized provider tool calls", () => {
    expect(extractDispatchToolCalls([
      {
        name: DISPATCH_TOOL_FULL_NAME,
        input: {
          worker_id: "nutrition-logger",
          task: "Log breakfast",
          task_id: "breakfast",
        },
      },
    ])).toEqual([
      {
        workerId: "nutrition-logger",
        task: "Log breakfast",
        taskId: "breakfast",
      },
    ]);
  });

  it("accepts the short tool name too", () => {
    expect(extractDispatchToolCalls([
      {
        name: "dispatch_worker",
        input: {
          worker_id: "research-assistant",
          task: "Search EXA for filament deals",
        },
      },
    ])).toEqual([
      {
        workerId: "research-assistant",
        task: "Search EXA for filament deals",
      },
    ]);
  });

  it("ignores telemetry counters and malformed dispatch payloads", () => {
    expect(extractDispatchToolCalls([
      {
        name: DISPATCH_TOOL_FULL_NAME,
        input: { worker_id: "nutrition-logger" },
      },
    ])).toEqual([]);
  });
});
