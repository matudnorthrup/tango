import { describe, expect, it } from "vitest";
import { selectScheduledTurnResponseText } from "../src/scheduled-turn-response.js";
import type { DiscordTurnExecutionResult } from "../src/turn-executor.js";
import type { ExecutionReceipt } from "../src/deterministic-runtime.js";

function receipt(overrides: Partial<ExecutionReceipt> = {}): ExecutionReceipt {
  return {
    stepId: "step-1",
    intentId: "email.inbox_maintenance",
    mode: "read",
    kind: "worker",
    targetId: "personal-assistant",
    workerId: "personal-assistant",
    status: "completed",
    durationMs: 1000,
    operations: [],
    hasWriteOperations: false,
    data: {},
    warnings: [],
    ...overrides,
  };
}

function turnResult(
  responseText: string,
  receipts: ExecutionReceipt[],
): DiscordTurnExecutionResult {
  return {
    responseText,
    providerName: "claude-oauth",
    providerRequestPrompt: "prompt",
    providerRequestWarmStartUsed: false,
    initialRequestPrompt: "prompt",
    initialRequestWarmStartUsed: false,
    response: {
      text: responseText,
      metadata: { model: "claude-sonnet-4-6" },
    },
    attemptCount: 1,
    attemptErrors: [],
    providerFailures: [],
    warmStartContextChars: 0,
    configuredProviders: ["claude-oauth"],
    effectiveProviders: ["claude-oauth"],
    deterministicTurn: {
      state: {
        auth: {
          initiatingPrincipalId: "user:unknown",
          leadAgentPrincipalId: "agent:watson",
          delegationChain: ["user:unknown", "agent:watson", "worker:personal-assistant"],
        },
        intent: {
          envelopes: [],
        },
        routing: {
          clarificationNeeded: false,
          routeOutcome: "executed",
        },
        execution: {
          receipts,
          completed: true,
          partialFailure: false,
          hasWriteOperations: receipts.some((currentReceipt) => currentReceipt.hasWriteOperations),
        },
        narration: {},
      },
      summaryText: "",
      classifier: {
        envelopes: [],
        rawResponseText: "{}",
        providerName: "config",
        response: {
          text: "{}",
          metadata: { model: "config:explicit-intents" },
        },
        meetsThreshold: true,
        attemptCount: 0,
        attemptErrors: [],
        providerFailures: [],
      },
      receipts,
    },
  } as DiscordTurnExecutionResult;
}

describe("selectScheduledTurnResponseText", () => {
  it("promotes rich worker text when scheduled synthesis degrades to the generic failure apology", () => {
    const workerText = [
      "## Daily Email Review - 2026-04-07",
      "",
      "### Actionable",
      "- GDC follow-up needs a Friday invite.",
      "- VSC interview needs a James Currier intro.",
      "",
      "### Notifications",
      "- Supabase flagged a critical RLS vulnerability.",
      "- Gusto Iowa tax setup still needs correction.",
      "",
      "Archived 21 threads across 3 accounts.",
    ].join("\n");

    const response = selectScheduledTurnResponseText(
      ["email.inbox_maintenance"],
      turnResult(
        "Sorry, something went wrong before I could finish that step. Please try again.",
        [receipt({ hasWriteOperations: true, data: { workerText } })],
      ),
    );

    expect(response).toBe(workerText);
  });

  it("keeps the existing slack-digest passthrough behavior for truncated summaries", () => {
    const workerText = [
      "## Slack Summary",
      "",
      "A long, detailed digest that is much more complete than the truncated narrator output.",
      "It covers enough lines to clearly exceed the truncation fallback threshold.",
      "This should be promoted for delivery.",
    ].join("\n");

    const response = selectScheduledTurnResponseText(
      ["research.slack_digest"],
      turnResult("Partial digest - truncated before the final section.", [receipt({ data: { workerText } })]),
    );

    expect(response).toBe(workerText);
  });

  it("does not promote worker text when the receipt is partial", () => {
    const responseText = "Sorry, something went wrong before I could finish that step. Please try again.";
    const response = selectScheduledTurnResponseText(
      ["email.inbox_maintenance"],
      turnResult(responseText, [receipt({ data: { workerText: "## Daily Email Review\n\nPartial." , partial: true } })]),
    );

    expect(response).toBe(responseText);
  });
});
