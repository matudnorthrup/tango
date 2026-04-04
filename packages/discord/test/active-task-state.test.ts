import type { ActiveTaskRecord } from "@tango/core";
import { describe, expect, it } from "vitest";
import { buildActiveTaskPersistencePlan, renderActiveTasksContext, resolveActiveTaskContinuation } from "../src/active-task-state.js";
import type { ExecutionReceipt } from "../src/deterministic-runtime.js";

function task(input: Partial<ActiveTaskRecord> = {}): ActiveTaskRecord {
  return {
    id: input.id ?? "task-1",
    sessionId: input.sessionId ?? "project:wellness",
    agentId: input.agentId ?? "malibu",
    status: input.status ?? "awaiting_user",
    title: input.title ?? "Analyze recent TDEE",
    objective: input.objective ?? "Review the last four weeks of TDEE and suggest a calorie target.",
    ownerWorkerId: input.ownerWorkerId ?? "health-analyst",
    intentIds: input.intentIds ?? ["health.morning_brief"],
    missingSlots: input.missingSlots ?? [],
    clarificationQuestion: input.clarificationQuestion ?? "Want me to pull a few weeks of TDEE?",
    suggestedNextAction: input.suggestedNextAction ?? "Confirm whether to run the analysis.",
    structuredContext: input.structuredContext ?? {
      proposedDays: 28,
    },
    sourceKind: input.sourceKind ?? "assistant-offer",
    createdByMessageId: input.createdByMessageId ?? 10,
    updatedByMessageId: input.updatedByMessageId ?? 10,
    createdAt: input.createdAt ?? "2026-03-30T13:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-03-30T13:05:00.000Z",
    resolvedAt: input.resolvedAt ?? null,
    expiresAt: input.expiresAt ?? "2099-01-01T00:00:00.000Z",
  };
}

function receipt(input: Partial<ExecutionReceipt> = {}): ExecutionReceipt {
  return {
    stepId: input.stepId ?? "step-1",
    intentId: input.intentId ?? "health.morning_brief",
    mode: input.mode ?? "read",
    kind: input.kind ?? "worker",
    targetId: input.targetId ?? "health-analyst",
    workerId: input.workerId ?? "health-analyst",
    status: input.status ?? "completed",
    durationMs: input.durationMs ?? 50,
    operations: input.operations ?? [],
    hasWriteOperations: input.hasWriteOperations ?? false,
    data: input.data ?? { workerText: "27-day average TDEE is 2,550 calories." },
    warnings: input.warnings ?? [],
    error: input.error,
    clarification: input.clarification,
  };
}

describe("active task state", () => {
  it("renders open tasks for prompt grounding", () => {
    const prompt = renderActiveTasksContext([
      task(),
      task({
        id: "task-2",
        title: "Clarify pulled pork amount",
        objective: "Resolve missing taco pork amount for dinner logging.",
        clarificationQuestion: "How much pulled pork was in each taco?",
      }),
    ]);

    expect(prompt).toContain("active_tasks:");
    expect(prompt).toContain("Analyze recent TDEE");
    expect(prompt).toContain("How much pulled pork was in each taco?");
  });

  it("resolves terse follow-ups against the latest open task", () => {
    const resolution = resolveActiveTaskContinuation({
      tasks: [task()],
      userMessage: "yeah, take a look at TDEE",
    });

    expect(resolution.kind).toBe("continue");
    expect(resolution.matchedTask?.id).toBe("task-1");
    expect(resolution.effectiveUserMessage).toContain("Open task objective");
    expect(resolution.effectiveUserMessage).toContain("Review the last four weeks of TDEE");
    expect(resolution.effectiveUserMessage).toContain("User follow-up message: yeah, take a look at TDEE");
  });

  it("uses structured context to match the right open task across domains", () => {
    const financeTask = task({
      id: "task-finance",
      sessionId: "watson-live-deterministic",
      agentId: "watson",
      title: "Review recent Amazon transactions",
      objective: "Look up the most recent Amazon transactions and summarize the latest charges.",
      ownerWorkerId: "personal-assistant",
      intentIds: ["finance.transaction_lookup"],
      clarificationQuestion: "Want me to pull the recent Amazon transactions?",
      suggestedNextAction: "Confirm the transaction lookup.",
      structuredContext: {
        merchant: "Amazon",
        system: "Lunch Money",
      },
      updatedAt: "2026-03-30T13:06:00.000Z",
    });
    const noteTask = task({
      id: "task-note",
      sessionId: "watson-live-deterministic",
      agentId: "watson",
      title: "Read desk project note",
      objective: "Read the Large Desk OpenGrid and Underware Project note.",
      ownerWorkerId: "personal-assistant",
      intentIds: ["notes.note_read"],
      clarificationQuestion: "Want me to read the desk project note?",
      suggestedNextAction: "Confirm the note read.",
      structuredContext: {
        noteQuery: "Large Desk OpenGrid and Underware Project",
      },
      updatedAt: "2026-03-30T13:05:00.000Z",
    });

    const resolution = resolveActiveTaskContinuation({
      tasks: [noteTask, financeTask],
      userMessage: "yeah, check those Amazon transactions",
    });

    expect(resolution.kind).toBe("continue");
    expect(resolution.matchedTask?.id).toBe("task-finance");
    expect(resolution.effectiveUserMessage).toContain("Look up the most recent Amazon transactions");
    expect(resolution.effectiveUserMessage).toContain("User follow-up message: yeah, check those Amazon transactions");
  });

  it("creates awaiting-user tasks from assistant offers", () => {
    const plan = buildActiveTaskPersistencePlan({
      sessionId: "project:wellness",
      agentId: "malibu",
      userMessage: "Can you help with my TDEE?",
      responseText: "What does your TDEE look like lately — want me to pull a few weeks of data?",
      existingTasks: [],
      continuation: {
        kind: "none",
        matchedTask: null,
        effectiveUserMessage: "Can you help with my TDEE?",
      },
      requestMessageId: 11,
      responseMessageId: 12,
    });

    expect(plan.statusUpdates).toHaveLength(0);
    expect(plan.upserts).toHaveLength(1);
    expect(plan.upserts[0]).toMatchObject({
      status: "awaiting_user",
      sourceKind: "assistant-offer",
      title: "Pull a few weeks of data",
    });
  });

  it("extracts clarification tasks from multi-paragraph deterministic replies", () => {
    const plan = buildActiveTaskPersistencePlan({
      sessionId: "project:wellness",
      agentId: "malibu",
      userMessage:
        "Did you log my food from earlier? Breakfast protein yogurt bowl. Lunch egg and fries hash.",
      responseText: `Breakfast is locked.\n\nLunch is stuck though. The Egg & Fries Hash recipe isn't in the vault.\nWhat went into that hash?`,
      existingTasks: [],
      continuation: {
        kind: "none",
        matchedTask: null,
        effectiveUserMessage:
          "Did you log my food from earlier? Breakfast protein yogurt bowl. Lunch egg and fries hash.",
      },
      deterministicTurn: {
        state: {
          auth: {
            initiatingPrincipalId: "user:1",
            leadAgentPrincipalId: "agent:malibu",
            delegationChain: ["user:1", "agent:malibu", "worker:nutrition-logger"],
          },
          intent: {
            envelopes: [
              {
                id: "intent-1",
                domain: "wellness",
                intentId: "nutrition.log_recipe",
                mode: "write",
                confidence: 0.92,
                entities: { recipe_query: "egg and fries hash" },
                rawEntities: ["egg and fries hash"],
                missingSlots: [],
                canRunInParallel: false,
                routeHint: { kind: "workflow", targetId: "wellness.log_recipe_meal" },
              },
            ],
          },
          routing: {
            clarificationNeeded: false,
            routeOutcome: "executed",
          },
          execution: {
            receipts: [receipt({ intentId: "nutrition.log_recipe", workerId: "nutrition-logger" })],
            completed: true,
            partialFailure: false,
          },
          narration: {},
        },
        receipts: [receipt({ intentId: "nutrition.log_recipe", workerId: "nutrition-logger" })],
      },
      requestMessageId: 21,
      responseMessageId: 22,
    });

    expect(plan.statusUpdates).toHaveLength(0);
    expect(plan.upserts).toHaveLength(1);
    expect(plan.upserts[0]).toMatchObject({
      status: "awaiting_user",
      sourceKind: "assistant-deterministic-clarification",
      ownerWorkerId: "nutrition-logger",
      intentIds: ["nutrition.log_recipe"],
      clarificationQuestion: "What went into that hash?",
    });
    expect(plan.upserts[0]?.structuredContext).toMatchObject({
      source: "assistant-deterministic-clarification",
      routeOutcome: "executed",
    });
  });

  it("completes a matched task after deterministic execution succeeds", () => {
    const matchedTask = task();
    const plan = buildActiveTaskPersistencePlan({
      sessionId: "project:wellness",
      agentId: "malibu",
      userMessage: "yeah, do that",
      responseText: "Your 27-day average TDEE is about 2,550 calories.",
      existingTasks: [matchedTask],
      continuation: {
        kind: "continue",
        matchedTask,
        effectiveUserMessage: "Continuation of the open TDEE task.",
      },
      deterministicTurn: {
        state: {
          auth: {
            initiatingPrincipalId: "user:1",
            leadAgentPrincipalId: "agent:malibu",
            delegationChain: ["user:1", "agent:malibu", "worker:health-analyst"],
          },
          intent: {
            envelopes: [],
          },
          routing: {
            clarificationNeeded: false,
            routeOutcome: "executed",
          },
          execution: {
            receipts: [receipt()],
            completed: true,
            partialFailure: false,
          },
          narration: {},
        },
        receipts: [receipt()],
      },
      requestMessageId: 13,
      responseMessageId: 14,
    });

    expect(plan.upserts).toHaveLength(0);
    expect(plan.statusUpdates).toHaveLength(1);
    expect(plan.statusUpdates[0]).toMatchObject({
      id: matchedTask.id,
      status: "completed",
      updatedByMessageId: 14,
    });
  });

  it("keeps a matched write task blocked when execution completed with unverified-write warnings", () => {
    const matchedTask = task({
      id: "task-taco",
      title: "How many tacos we logging, brah",
      objective: "chicken breast. and, again...the recipe is in obsidian...",
      intentIds: ["nutrition.log_food", "recipe.read"],
      clarificationQuestion: "How many tacos we logging, brah?",
      ownerWorkerId: "nutrition-logger",
    });

    const warningReceipt = receipt({
      intentId: "nutrition.log_recipe",
      mode: "write",
      workerId: "nutrition-logger",
      hasWriteOperations: true,
      warnings: ["Worker reported blocked result."],
      data: { workerText: "FatSecret writes were cancelled." },
    });

    const plan = buildActiveTaskPersistencePlan({
      sessionId: "project:wellness",
      agentId: "malibu",
      userMessage: "3",
      responseText:
        "Three chicken tacos lands dinner around 651 calories, but the FatSecret writes got canceled again, so I can't honestly say the diary entry stuck.",
      existingTasks: [matchedTask],
      continuation: {
        kind: "continue",
        matchedTask,
        effectiveUserMessage: "Continuation of the taco logging task.",
      },
      deterministicTurn: {
        state: {
          auth: {
            initiatingPrincipalId: "user:1",
            leadAgentPrincipalId: "agent:malibu",
            delegationChain: ["user:1", "agent:malibu", "worker:nutrition-logger"],
          },
          intent: {
            envelopes: [
              {
                id: "intent-1",
                domain: "wellness",
                intentId: "nutrition.log_recipe",
                mode: "write",
                confidence: 0.97,
                entities: {
                  recipe_query: "Taco Tuesday",
                  servings: 3,
                  protein: "chicken breast",
                  tortilla: "la abuela flour tortilla",
                },
                rawEntities: ["3", "chicken breast", "Taco Tuesday"],
                missingSlots: [],
                canRunInParallel: false,
                routeHint: { kind: "workflow", targetId: "wellness.log_recipe_meal" },
              },
            ],
          },
          routing: {
            clarificationNeeded: false,
            routeOutcome: "executed",
          },
          execution: {
            receipts: [warningReceipt],
            completed: true,
            partialFailure: false,
          },
          narration: {},
        },
        receipts: [warningReceipt],
      },
      requestMessageId: 31,
      responseMessageId: 32,
    });

    expect(plan.statusUpdates).toHaveLength(0);
    expect(plan.upserts).toHaveLength(1);
    expect(plan.upserts[0]).toMatchObject({
      id: "task-taco",
      status: "blocked",
      ownerWorkerId: "nutrition-logger",
      intentIds: ["nutrition.log_recipe"],
      clarificationQuestion: null,
      sourceKind: "execution-blocked",
    });
    expect(plan.upserts[0]?.structuredContext).toMatchObject({
      source: "execution-blocked",
      latestResolvedEntities: {
        recipe_query: "Taco Tuesday",
        servings: 3,
        protein: "chicken breast",
        tortilla: "la abuela flour tortilla",
      },
      blockingWarnings: ["Worker reported blocked result."],
    });
  });

  it("keeps a matched write task blocked when a write was attempted but no confirmed committed result exists", () => {
    const matchedTask = task({
      id: "task-file",
      title: "Update printer prep note",
      objective: "Update the printer prep note with the latest summary.",
      intentIds: ["files.local_write"],
      ownerWorkerId: "research-assistant",
    });

    const failedWriteReceipt = receipt({
      intentId: "files.local_write",
      mode: "write",
      workerId: "research-assistant",
      hasWriteOperations: true,
      warnings: [],
      operations: [
        {
          name: "file_ops",
          toolNames: ["file_ops"],
          input: { operation: "write", path: "/tmp/codex-write-check.txt" },
          output: { error: "permission denied" },
          mode: "write",
        },
      ],
      data: { workerText: "Tried the write, but it did not land." },
    });

    const plan = buildActiveTaskPersistencePlan({
      sessionId: "project:research",
      agentId: "sierra",
      userMessage: "go ahead and update the file",
      responseText: "Patched it.",
      existingTasks: [matchedTask],
      continuation: {
        kind: "continue",
        matchedTask,
        effectiveUserMessage: "Continuation of the file update task.",
      },
      deterministicTurn: {
        state: {
          auth: {
            initiatingPrincipalId: "user:1",
            leadAgentPrincipalId: "agent:sierra",
            delegationChain: ["user:1", "agent:sierra", "worker:research-assistant"],
          },
          intent: {
            envelopes: [
              {
                id: "intent-1",
                domain: "research",
                intentId: "files.local_write",
                mode: "write",
                confidence: 0.96,
                entities: {
                  path: "/tmp/codex-write-check.txt",
                },
                rawEntities: ["/tmp/codex-write-check.txt"],
                missingSlots: [],
                canRunInParallel: false,
                routeHint: { kind: "worker", targetId: "research-assistant" },
              },
            ],
          },
          routing: {
            clarificationNeeded: false,
            routeOutcome: "executed",
          },
          execution: {
            receipts: [failedWriteReceipt],
            completed: true,
            partialFailure: false,
          },
          narration: {},
        },
        receipts: [failedWriteReceipt],
      },
      requestMessageId: 61,
      responseMessageId: 62,
    });

    expect(plan.statusUpdates).toHaveLength(0);
    expect(plan.upserts).toHaveLength(1);
    expect(plan.upserts[0]).toMatchObject({
      id: "task-file",
      status: "blocked",
      ownerWorkerId: "research-assistant",
      intentIds: ["files.local_write"],
      sourceKind: "execution-blocked",
    });
  });

  it("completes a matched blocked task when write operations succeeded and the reply is not failure-shaped", () => {
    const matchedTask = task({
      id: "task-repair",
      status: "blocked",
      title: "Repair lunch diary writes",
      objective: "Finish logging lunch with the already established details.",
      intentIds: ["nutrition.log_recipe"],
      ownerWorkerId: "nutrition-logger",
    });

    const recoveredWriteReceipt = receipt({
      intentId: "nutrition.log_recipe",
      mode: "write",
      workerId: "nutrition-logger",
      hasWriteOperations: true,
      warnings: ["Initial verification call was cancelled."],
      operations: [
        {
          name: "fatsecret_api",
          toolNames: ["fatsecret_api"],
          input: {
            method: "food_entry_create",
          },
          output: {
            ok: true,
            value: "entry-123",
          },
          mode: "write",
        },
      ],
      data: { workerText: "Lunch is locked in now." },
    });

    const plan = buildActiveTaskPersistencePlan({
      sessionId: "project:wellness",
      agentId: "malibu",
      userMessage: "go ahead and finish it",
      responseText: "Lunch is locked in now, dude.",
      existingTasks: [matchedTask],
      continuation: {
        kind: "continue",
        matchedTask,
        effectiveUserMessage: "Continuation of the blocked lunch repair task.",
      },
      deterministicTurn: {
        state: {
          auth: {
            initiatingPrincipalId: "user:1",
            leadAgentPrincipalId: "agent:malibu",
            delegationChain: ["user:1", "agent:malibu", "worker:nutrition-logger"],
          },
          intent: {
            envelopes: [
              {
                id: "intent-1",
                domain: "wellness",
                intentId: "nutrition.log_recipe",
                mode: "write",
                confidence: 0.99,
                entities: {
                  recipe_query: "Egg & Fries Hash",
                },
                rawEntities: ["Egg & Fries Hash"],
                missingSlots: [],
                canRunInParallel: false,
                routeHint: { kind: "workflow", targetId: "wellness.log_recipe_meal" },
              },
            ],
          },
          routing: {
            clarificationNeeded: false,
            routeOutcome: "executed",
          },
          execution: {
            receipts: [recoveredWriteReceipt],
            completed: true,
            partialFailure: false,
          },
          narration: {},
        },
        receipts: [recoveredWriteReceipt],
      },
      requestMessageId: 41,
      responseMessageId: 42,
    });

    expect(plan.upserts).toHaveLength(0);
    expect(plan.statusUpdates).toHaveLength(1);
    expect(plan.statusUpdates[0]).toMatchObject({
      id: "task-repair",
      status: "completed",
      updatedByMessageId: 42,
    });
  });

  it("supersedes older duplicate blocked execution tasks when a later repair succeeds", () => {
    const olderBlockedTask = task({
      id: "task-repair-old",
      status: "blocked",
      title: "Repair lunch diary writes",
      objective: "Finish logging lunch with the already established details.",
      intentIds: ["nutrition.log_recipe"],
      ownerWorkerId: "nutrition-logger",
      sourceKind: "execution-blocked",
      updatedAt: "2026-03-30T12:00:00.000Z",
    });
    const matchedTask = task({
      id: "task-repair-new",
      status: "blocked",
      title: "Repair lunch diary writes",
      objective: "Finish logging lunch with the already established details.",
      intentIds: ["nutrition.log_recipe"],
      ownerWorkerId: "nutrition-logger",
      sourceKind: "execution-blocked",
      updatedAt: "2026-03-30T12:05:00.000Z",
    });

    const recoveredWriteReceipt = receipt({
      intentId: "nutrition.log_recipe",
      mode: "write",
      workerId: "nutrition-logger",
      hasWriteOperations: true,
      operations: [
        {
          name: "fatsecret_api",
          toolNames: ["fatsecret_api"],
          input: { method: "food_entry_create" },
          output: { ok: true, value: "entry-123" },
          mode: "write",
        },
      ],
      data: { workerText: "Lunch is locked in now." },
    });

    const plan = buildActiveTaskPersistencePlan({
      sessionId: "project:wellness",
      agentId: "malibu",
      userMessage: "go ahead and finish it",
      responseText: "Lunch is locked in now, dude.",
      existingTasks: [olderBlockedTask, matchedTask],
      continuation: {
        kind: "continue",
        matchedTask,
        effectiveUserMessage: "Continuation of the blocked lunch repair task.",
      },
      deterministicTurn: {
        state: {
          auth: {
            initiatingPrincipalId: "user:1",
            leadAgentPrincipalId: "agent:malibu",
            delegationChain: ["user:1", "agent:malibu", "worker:nutrition-logger"],
          },
          intent: {
            envelopes: [
              {
                id: "intent-1",
                domain: "wellness",
                intentId: "nutrition.log_recipe",
                mode: "write",
                confidence: 0.99,
                entities: {
                  recipe_query: "Egg & Fries Hash",
                },
                rawEntities: ["Egg & Fries Hash"],
                missingSlots: [],
                canRunInParallel: false,
                routeHint: { kind: "workflow", targetId: "wellness.log_recipe_meal" },
              },
            ],
          },
          routing: {
            clarificationNeeded: false,
            routeOutcome: "executed",
          },
          execution: {
            receipts: [recoveredWriteReceipt],
            completed: true,
            partialFailure: false,
          },
          narration: {},
        },
        receipts: [recoveredWriteReceipt],
      },
      requestMessageId: 51,
      responseMessageId: 52,
    });

    expect(plan.upserts).toHaveLength(0);
    expect(plan.statusUpdates).toHaveLength(2);
    expect(plan.statusUpdates[0]).toMatchObject({
      id: "task-repair-new",
      status: "completed",
      updatedByMessageId: 52,
    });
    expect(plan.statusUpdates[1]).toMatchObject({
      id: "task-repair-old",
      status: "superseded",
      updatedByMessageId: 52,
    });
    expect(plan.statusUpdates[1]?.structuredContext).toMatchObject({
      supersededByTaskId: "task-repair-new",
    });
  });

  it("completes the latest matching blocked task even when explicit continuation matching is missing", () => {
    const blockedTask = task({
      id: "task-banana",
      status: "blocked",
      title: "Finish banana entry",
      objective: "Finish logging one medium banana as other for 2026-04-01.",
      ownerWorkerId: "nutrition-logger",
      intentIds: ["nutrition.log_food"],
      clarificationQuestion: null,
      suggestedNextAction: "Retry the blocked banana diary entry using the established details.",
      structuredContext: {
        source: "execution-blocked",
        latestResolvedEntities: {
          items: "one medium banana",
          meal: "other",
          date: "2026-04-01",
        },
      },
      sourceKind: "execution-blocked",
      updatedAt: "2026-04-01T05:33:00.000Z",
    });

    const plan = buildActiveTaskPersistencePlan({
      sessionId: "project:wellness#smoke-malibu-write",
      agentId: "malibu",
      userMessage: "go ahead and finish that banana entry",
      responseText: "Banana's in there now.",
      existingTasks: [blockedTask],
      continuation: {
        kind: "none",
        matchedTask: null,
        effectiveUserMessage: "go ahead and finish that banana entry",
      },
      deterministicTurn: {
        state: {
          auth: {
            initiatingPrincipalId: "user:1",
            leadAgentPrincipalId: "agent:malibu",
            delegationChain: ["user:1", "agent:malibu", "worker:nutrition-logger"],
          },
          intent: {
            envelopes: [
              {
                id: "intent-1",
                domain: "wellness",
                intentId: "nutrition.log_food",
                mode: "write",
                confidence: 0.96,
                entities: {
                  items: "one medium banana",
                  meal: "other",
                  date: "2026-04-01",
                },
                rawEntities: ["one medium banana"],
                missingSlots: [],
                canRunInParallel: false,
                routeHint: { kind: "workflow", targetId: "wellness.log_food_items" },
              },
            ],
          },
          routing: {
            clarificationNeeded: false,
            routeOutcome: "executed",
          },
          execution: {
            receipts: [
              receipt({
                intentId: "nutrition.log_food",
                mode: "write",
                workerId: "nutrition-logger",
                status: "completed",
                hasWriteOperations: false,
                warnings: [],
                data: {
                  workerText: JSON.stringify({
                    action: "nutrition.log_food",
                    status: "ok",
                    runtimeReplay: {
                      diaryRefreshRecovered: true,
                    },
                  }),
                },
              }),
            ],
            completed: true,
            partialFailure: false,
          },
          narration: {},
        },
        receipts: [
          receipt({
            intentId: "nutrition.log_food",
            mode: "write",
            workerId: "nutrition-logger",
            status: "completed",
            hasWriteOperations: false,
            warnings: [],
            data: {
              workerText: JSON.stringify({
                action: "nutrition.log_food",
                status: "ok",
                runtimeReplay: {
                  diaryRefreshRecovered: true,
                },
              }),
            },
          }),
        ],
      },
      requestMessageId: 51,
      responseMessageId: 52,
    });

    expect(plan.upserts).toHaveLength(0);
    expect(plan.statusUpdates).toHaveLength(1);
    expect(plan.statusUpdates[0]).toMatchObject({
      id: "task-banana",
      status: "completed",
      updatedByMessageId: 52,
    });
  });
});
