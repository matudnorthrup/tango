import { describe, expect, it } from "vitest";
import {
  buildDispatchToolDefinition,
  buildDispatchToolDescription,
  handleDispatchToolCall,
  parseDispatchWorkersFromEnv,
} from "../src/mcp-dispatch-server.js";

describe("mcp dispatch server helpers", () => {
  it("parses worker ids and labels from env", () => {
    expect(parseDispatchWorkersFromEnv({
      DISPATCH_WORKER_IDS: "nutrition-logger,health-analyst,nutrition-logger",
      DISPATCH_WORKER_LABELS: "Food logging,Health summaries,ignored",
    })).toEqual([
      {
        id: "nutrition-logger",
        label: "Food logging",
      },
      {
        id: "health-analyst",
        label: "Health summaries",
      },
    ]);
  });

  it("acknowledges valid worker dispatches", () => {
    expect(handleDispatchToolCall(
      [{ id: "nutrition-logger", label: "Food logging" }],
      {
        worker_id: "nutrition-logger",
        task: "Log breakfast",
        task_id: "breakfast",
      },
    )).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "dispatched",
            worker_id: "nutrition-logger",
            task_id: "breakfast",
            note: "Dispatch accepted by Tango. Do not reply to the user yet. Tango will send an internal follow-up message with worker execution results in the same turn. Answer only after that message arrives.",
          }),
        },
      ],
    });
  });

  it("rejects unknown worker ids and lists the allowed ids", () => {
    expect(handleDispatchToolCall(
      [{ id: "nutrition-logger", label: "Food logging" }],
      {
        worker_id: "health-analyst",
        task: "Check recovery",
      },
    )).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "Unknown worker_id: health-analyst",
            allowed_worker_ids: ["nutrition-logger"],
          }),
        },
      ],
      isError: true,
    });
  });

  it("lists available workers in the tool description", () => {
    expect(buildDispatchToolDescription([
      { id: "nutrition-logger", label: "Food logging" },
      { id: "health-analyst", label: "Health summaries" },
    ])).toContain("nutrition-logger: Food logging");
    expect(buildDispatchToolDescription([
      { id: "nutrition-logger", label: "Food logging" },
    ])).toContain("do not send a progress update to the user");
    expect(buildDispatchToolDescription([
      { id: "nutrition-logger", label: "Food logging" },
    ])).toContain("internal follow-up message");
  });

  it("marks dispatch_worker as a read-only coordination tool", () => {
    expect(buildDispatchToolDefinition([
      { id: "nutrition-logger", label: "Food logging" },
    ])).toMatchObject({
      name: "dispatch_worker",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    });
  });
});
