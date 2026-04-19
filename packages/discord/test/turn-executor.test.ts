import {
  CapabilityRegistry,
  type AgentConfig,
  type ChatProvider,
  type IntentContractConfig,
  type ProjectConfig,
  type ProviderRequest,
  type ProviderResponse,
  type WorkerConfig,
  type WorkflowConfig,
} from "@tango/core";
import { describe, expect, it } from "vitest";
import { DISPATCH_TOOL_FULL_NAME } from "../src/dispatch-extractor.js";
import { __testOnly, createDiscordVoiceTurnExecutor } from "../src/turn-executor.js";

class ScriptedProvider implements ChatProvider {
  readonly calls: ProviderRequest[] = [];

  constructor(
    private readonly impl: (callNumber: number, request: ProviderRequest) => ProviderResponse | Error
  ) {}

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push(request);
    const result = this.impl(this.calls.length, request);
    if (result instanceof Error) {
      throw result;
    }
    return result;
  }
}

function createDeterministicRegistry(): CapabilityRegistry {
  const agents: AgentConfig[] = [
    {
      id: "malibu",
      type: "wellness",
      provider: { default: "codex" },
      orchestration: {
        workerIds: ["nutrition-logger", "health-analyst", "workout-recorder"],
      },
    },
    {
      id: "sierra",
      type: "research",
      provider: { default: "codex" },
      orchestration: {
        workerIds: ["research-assistant"],
      },
    },
    {
      id: "watson",
      type: "personal",
      provider: { default: "codex" },
      orchestration: {
        workerIds: ["personal-assistant"],
      },
    },
    {
      id: "victor",
      type: "developer",
      provider: { default: "codex" },
      orchestration: {
        workerIds: ["dev-assistant"],
      },
    },
  ];
  const projects: ProjectConfig[] = [
    {
      id: "wellness",
      workerIds: ["nutrition-logger", "health-analyst", "workout-recorder"],
    },
  ];
  const workers: WorkerConfig[] = [
    {
      id: "nutrition-logger",
      type: "logger",
      ownerAgentId: "malibu",
      provider: { default: "codex" },
    },
    {
      id: "health-analyst",
      type: "analyst",
      ownerAgentId: "malibu",
      provider: { default: "codex" },
    },
    {
      id: "workout-recorder",
      type: "recorder",
      ownerAgentId: "malibu",
      provider: { default: "codex" },
    },
    {
      id: "research-assistant",
      type: "researcher",
      ownerAgentId: "sierra",
      provider: { default: "codex" },
    },
    {
      id: "personal-assistant",
      type: "assistant",
      ownerAgentId: "watson",
      provider: { default: "codex" },
    },
    {
      id: "dev-assistant",
      type: "developer",
      ownerAgentId: "victor",
      provider: { default: "codex" },
    },
  ];
  const workflows: WorkflowConfig[] = [
    {
      id: "wellness.log_food_items",
      description: "Log ad-hoc foods.",
      ownerWorkerId: "nutrition-logger",
      mode: "write",
      handler: "log_food_items",
    },
    {
      id: "wellness.analyze_health_trends",
      description: "Analyze broader health and TDEE trends.",
      ownerWorkerId: "health-analyst",
      mode: "read",
      handler: "analyze_health_trends",
    },
    {
      id: "wellness.check_nutrition_budget",
      description: "Check calorie, protein, or room-left budget.",
      ownerWorkerId: "nutrition-logger",
      mode: "read",
      handler: "check_nutrition_budget",
    },
  ];
  const intentContracts: IntentContractConfig[] = [
    {
      id: "nutrition.log_food",
      domain: "wellness",
      displayName: "Log Food Items",
      description: "Log ad-hoc foods.",
      mode: "write",
      route: { kind: "workflow", targetId: "wellness.log_food_items" },
      slots: [{ name: "items", required: true }],
      examples: ["Log two eggs and toast for breakfast"],
    },
    {
      id: "health.trend_analysis",
      domain: "wellness",
      displayName: "Health Trend Analysis",
      description: "Read and analyze multi-day health, activity, sleep, recovery, weight, or TDEE trends and recommendations.",
      mode: "read",
      route: { kind: "workflow", targetId: "wellness.analyze_health_trends" },
      examples: ["Take a look at my TDEE over the last few weeks"],
      slots: [
        { name: "date_scope", required: false },
        { name: "compare_date_scopes", required: false },
        { name: "days", required: false },
        { name: "focus", required: false },
        { name: "goal", required: false },
      ],
    },
    {
      id: "nutrition.check_budget",
      domain: "wellness",
      displayName: "Nutrition Budget Check",
      description: "Read current nutrition diary state and activity context to answer calorie, protein, or room-left questions about the day.",
      mode: "read",
      route: { kind: "workflow", targetId: "wellness.check_nutrition_budget" },
      examples: ["Do I still have room for yogurt tonight?"],
      slots: [
        { name: "date_scope", required: false },
        { name: "meal", required: false },
        { name: "planned_item", required: false },
        { name: "focus", required: false },
        { name: "goal", required: false },
      ],
    },
    {
      id: "workout.log",
      domain: "wellness",
      displayName: "Log Workout",
      description: "Log workout progress, sets, or an active workout session.",
      mode: "write",
      route: { kind: "worker", targetId: "workout-recorder" },
      examples: ["Log my workout"],
    },
    {
      id: "workout.history",
      domain: "wellness",
      displayName: "Workout History",
      description: "Read prior workouts, exercise history, or recent training data.",
      mode: "read",
      route: { kind: "worker", targetId: "workout-recorder" },
      examples: ["What did I do on my last push day?"],
    },
    {
      id: "research.note_read",
      domain: "research",
      displayName: "Read Research Note",
      description: "Read or summarize an existing note.",
      mode: "read",
      route: { kind: "worker", targetId: "research-assistant" },
      slots: [{ name: "note_query", required: true }],
      examples: ["Read the Obsidian note titled Large Desk OpenGrid and Underware Project"],
    },
    {
      id: "printing.printer_status",
      domain: "printing",
      displayName: "Printer Status",
      description: "Read and summarize the current 3D printer state.",
      mode: "read",
      route: { kind: "worker", targetId: "research-assistant" },
      examples: ["What's the current printer status?"],
    },
    {
      id: "travel.location_read",
      domain: "travel",
      displayName: "Current Location",
      description: "Read and summarize the current GPS location.",
      mode: "read",
      route: { kind: "worker", targetId: "research-assistant" },
      examples: ["Where am I right now?"],
    },
    {
      id: "travel.diesel_lookup",
      domain: "travel",
      displayName: "Diesel Lookup",
      description: "Find diesel stations along a route or near a destination.",
      mode: "read",
      route: { kind: "worker", targetId: "research-assistant" },
      slots: [{ name: "destination", required: true }],
      examples: ["Find the best diesel stops on the route to Tonopah, Nevada"],
    },
    {
      id: "shopping.walmart_queue_review",
      domain: "shopping",
      displayName: "Review Walmart Queue",
      description: "Read and summarize the Walmart queue or restock suggestions.",
      mode: "read",
      route: { kind: "worker", targetId: "research-assistant" },
      examples: ["What's currently in the Walmart queue?"],
    },
    {
      id: "finance.unreviewed_transactions",
      domain: "finance",
      displayName: "Review Unreviewed Transactions",
      description: "Read and summarize Lunch Money transactions that need review.",
      mode: "read",
      route: { kind: "worker", targetId: "personal-assistant" },
      examples: ["Can you summarize our unconfirmed transactions for me please so we can go through them?"],
    },
    {
      id: "finance.transaction_lookup",
      domain: "finance",
      displayName: "Look Up Transactions",
      description: "Read and summarize Lunch Money transactions by merchant, category, or recent spending window.",
      mode: "read",
      route: { kind: "worker", targetId: "personal-assistant" },
      examples: ["What were my most recent Amazon transactions?"],
    },
    {
      id: "finance.budget_review",
      domain: "finance",
      displayName: "Review Budget",
      description: "Read and summarize budget performance or category budget status.",
      mode: "read",
      route: { kind: "worker", targetId: "personal-assistant" },
      examples: ["How am I doing against budget this month?"],
    },
    {
      id: "planning.calendar_review",
      domain: "planning",
      displayName: "Review Calendar",
      description: "Read and summarize calendar events or schedule windows.",
      mode: "read",
      route: { kind: "worker", targetId: "personal-assistant" },
      examples: ["What's on my calendar today?"],
    },
    {
      id: "planning.current_time_read",
      domain: "planning",
      displayName: "Read Current Time",
      description: "Read the current local time or date.",
      mode: "read",
      route: { kind: "worker", targetId: "personal-assistant" },
      examples: ["What time is it?"],
    },
    {
      id: "email.inbox_review",
      domain: "email",
      displayName: "Review Inbox",
      description: "Read and summarize unread or actionable email.",
      mode: "read",
      route: { kind: "worker", targetId: "personal-assistant" },
      examples: ["What unread emails need attention today?"],
    },
    {
      id: "health.morning_brief",
      domain: "health",
      displayName: "Morning Health Brief",
      description: "Read and summarize the morning health briefing or recovery check-in.",
      mode: "read",
      route: { kind: "worker", targetId: "personal-assistant" },
      examples: ["Give me my morning health briefing"],
    },
    {
      id: "notes.note_read",
      domain: "notes",
      displayName: "Read Note",
      description: "Read or summarize an existing Obsidian note.",
      mode: "read",
      route: { kind: "worker", targetId: "personal-assistant" },
      slots: [{ name: "note_query", required: true }],
      examples: ["Read the Obsidian note titled Large Desk OpenGrid and Underware Project"],
    },
    {
      id: "notes.note_update",
      domain: "notes",
      displayName: "Update Note",
      description: "Update or append to an existing Obsidian note.",
      mode: "write",
      route: { kind: "worker", targetId: "personal-assistant" },
      slots: [
        { name: "note_query", required: true },
        { name: "change_request", required: true },
      ],
      examples: ["Update today's daily note to mark meal prep complete."],
    },
    {
      id: "docs.google_doc_read_or_update",
      domain: "docs",
      displayName: "Read or Update Google Doc",
      description: "Read, summarize, or update a specific Google Doc tab.",
      mode: "write",
      route: { kind: "worker", targetId: "personal-assistant" },
      slots: [
        { name: "doc_query", required: true },
        { name: "change_request", required: false },
      ],
      examples: ["Update this Google Doc tab with the revised homepage copy."],
    },
    {
      id: "engineering.repo_status",
      domain: "engineering",
      displayName: "Review Repo Status",
      description: "Read and summarize the current git status, branch state, or dirty files in the Tango repo.",
      mode: "read",
      route: { kind: "worker", targetId: "dev-assistant" },
      examples: ["What's the current git status for the repo?"],
    },
    {
      id: "engineering.codebase_read",
      domain: "engineering",
      displayName: "Read Codebase",
      description: "Read, summarize, or explain code, config, tests, or scripts in the Tango repo.",
      mode: "read",
      route: { kind: "worker", targetId: "dev-assistant" },
      slots: [{ name: "target_query", required: true }],
      examples: ["Read packages/discord/src/turn-executor.ts and explain deterministic routing"],
    },
  ];

  return new CapabilityRegistry({
    agents,
    projects,
    workers,
    toolContracts: [],
    workflows,
    intentContracts,
  });
}

describe("createDiscordVoiceTurnExecutor", () => {
  it("executes turn via resolver and maps transcript to provider prompt", async () => {
    const provider = new ScriptedProvider(() => ({
      text: "hello from provider",
      providerSessionId: "session-1"
    }));
    const saveCalls: Array<{
      conversationKey: string;
      sessionId: string;
      agentId: string;
      providerName: string;
      providerSessionId: string;
    }> = [];

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: (input) => {
          saveCalls.push(input);
        },
        buildWarmStartContextPrompt: () => undefined
      },
      () => ({
        conversationKey: "tango-default:watson",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        overrideProviderName: undefined,
        systemPrompt: "You are Watson.",
        tools: { mode: "allowlist", allowlist: ["WebSearch"] }
      })
    );

    const result = await executor.executeTurn({
      sessionId: "tango-default",
      agentId: "watson",
      transcript: "Summarize this thread.",
      channelId: "channel-1",
      discordUserId: "user-1"
    });

    expect(result.responseText).toBe("hello from provider");
    expect(result.providerName).toBe("codex");
    expect(result.providerSessionId).toBe("session-1");
    expect(result.providerUsedFailover).toBe(false);
    expect(result.warmStartUsed).toBe(false);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.prompt).toBe("Summarize this thread.");
    expect(provider.calls[0]?.systemPrompt).toBe("You are Watson.");
    expect(provider.calls[0]?.tools).toEqual({ mode: "allowlist", allowlist: ["WebSearch"] });
    expect(saveCalls).toEqual([
      {
        conversationKey: "tango-default:watson",
        sessionId: "tango-default",
        agentId: "watson",
        providerName: "codex",
        providerSessionId: "session-1"
      }
    ]);
  });

  it("forwards resolved model and reasoning effort into provider requests", async () => {
    const provider = new ScriptedProvider(() => ({
      text: "done",
    }));

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => undefined,
      },
      () => ({
        conversationKey: "project:wellness:malibu",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        model: "gpt-5.4-mini",
        reasoningEffort: "medium",
      })
    );

    await executor.executeTurn({
      sessionId: "project:wellness",
      agentId: "malibu",
      transcript: "Log that please.",
      channelId: "channel-1",
      discordUserId: "user-1",
    });

    expect(provider.calls[0]?.model).toBe("gpt-5.4-mini");
    expect(provider.calls[0]?.reasoningEffort).toBe("medium");
  });

  it("supports explicit context wiring with failover and continuity reuse", async () => {
    const primary = new ScriptedProvider(() => new Error("primary down"));
    const secondary = new ScriptedProvider(() => ({ text: "secondary-ok" }));

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: () => {
          throw new Error("resolveProviderChain should not run when providerChain is supplied");
        },
        loadProviderContinuityMap: () => {
          throw new Error("loadProviderContinuityMap should not run when continuity is supplied");
        },
        savePersistedProviderSession: () => {
          throw new Error("savePersistedProviderSession should not run without a new session id");
        },
        buildWarmStartContextPrompt: () => "Context handoff packet:\n- latest summary"
      },
      () => ({
        conversationKey: "unused",
        providerNames: ["unused"],
        configuredProviderNames: ["unused"]
      })
    );

    const result = await executor.executeTurnDetailed(
      {
        sessionId: "tango-default",
        agentId: "watson",
        transcript: "What changed?",
        channelId: "channel-1",
        discordUserId: "user-1"
      },
      {
        conversationKey: "tango-default:watson",
        providerNames: ["primary", "secondary"],
        configuredProviderNames: ["primary", "secondary"],
        providerChain: [
          { providerName: "primary", provider: primary },
          { providerName: "secondary", provider: secondary }
        ],
        continuityByProvider: {
          secondary: "persisted-secondary-session"
        },
        warmStartPrompt: "Context handoff packet:\n- latest summary"
      }
    );

    expect(result.providerName).toBe("secondary");
    expect(result.providerUsedFailover).toBe(true);
    expect(result.warmStartUsed).toBe(false);
    expect(result.providerSessionId).toBe("persisted-secondary-session");
    expect(result.providerFailures).toHaveLength(1);
    expect(result.providerFailures[0]?.providerName).toBe("primary");
    expect(primary.calls).toHaveLength(1);
    expect(secondary.calls).toHaveLength(1);
    expect(secondary.calls[0]?.providerSessionId).toBe("persisted-secondary-session");
    expect(secondary.calls[0]?.prompt).toBe("What changed?");
  });

  it("injects warm-start context when failing over without continuity", async () => {
    const primary = new ScriptedProvider(() => new Error("primary down"));
    const secondary = new ScriptedProvider((_callNumber, request) => ({
      text: request.prompt
    }));

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({
            providerName,
            provider: providerName === "primary" ? primary : secondary
          })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => "Context handoff packet:\n- prior actions"
      },
      () => ({
        conversationKey: "tango-default:watson",
        providerNames: ["primary", "secondary"],
        configuredProviderNames: ["primary", "secondary"]
      })
    );

    const result = await executor.executeTurn({
      sessionId: "tango-default",
      agentId: "watson",
      transcript: "Continue please.",
      channelId: "channel-1",
      discordUserId: "user-1"
    });

    expect(result.providerName).toBe("secondary");
    expect(result.providerUsedFailover).toBe(true);
    expect(result.warmStartUsed).toBe(true);
    expect(secondary.calls).toHaveLength(1);
    expect(secondary.calls[0]?.prompt).toContain("Context handoff packet");
    expect(secondary.calls[0]?.prompt).toContain("Current user message");
    expect(secondary.calls[0]?.prompt).toContain("Continue please.");
  });

  it("drops stale continuity and warm-starts from session history", async () => {
    const provider = new ScriptedProvider((_callNumber, request) => ({
      text: request.prompt,
      providerSessionId: "fresh-session-2"
    }));

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({
          "claude-oauth": "stale-session-1"
        }),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () =>
          "Context handoff packet:\n- [assistant] Logged lunch, but skipped black beans.",
        normalizeProviderContinuityMap: ({ continuityByProvider }) => {
          const normalized = { ...continuityByProvider };
          delete normalized["claude-oauth"];
          return normalized;
        }
      },
      () => ({
        conversationKey: "project:wellness:malibu",
        providerNames: ["claude-oauth"],
        configuredProviderNames: ["claude-oauth"]
      })
    );

    const result = await executor.executeTurn({
      sessionId: "project:wellness",
      agentId: "malibu",
      transcript: "what do you mean you couldn't map them cleanly?",
      channelId: "channel-1",
      discordUserId: "user-1"
    });

    expect(result.providerName).toBe("claude-oauth");
    expect(result.warmStartUsed).toBe(true);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.providerSessionId).toBeUndefined();
    expect(provider.calls[0]?.prompt).toContain("Context handoff packet");
    expect(provider.calls[0]?.prompt).toContain("Current user message");
    expect(provider.calls[0]?.prompt).toContain("what do you mean you couldn't map them cleanly?");
  });

  it("ignores persisted continuity for stateless orchestrator turns", async () => {
    const provider = new ScriptedProvider((_callNumber, request) => ({
      text: request.prompt,
      providerSessionId: "fresh-session-1",
    }));

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => {
          throw new Error("loadProviderContinuityMap should not run for stateless turns");
        },
        savePersistedProviderSession: () => {
          throw new Error("savePersistedProviderSession should not run for stateless turns");
        },
        buildWarmStartContextPrompt: () => "Context handoff packet:\n- latest summary"
      },
      () => ({
        conversationKey: "project:wellness:malibu",
        providerNames: ["claude-oauth"],
        configuredProviderNames: ["claude-oauth"]
      })
    );

    const result = await executor.executeTurnDetailed(
      {
        sessionId: "project:wellness",
        agentId: "malibu",
        transcript: "continue from my latest health note",
        channelId: "channel-1",
        discordUserId: "user-1"
      },
      {
        conversationKey: "project:wellness:malibu",
        providerNames: ["claude-oauth"],
        configuredProviderNames: ["claude-oauth"],
        orchestratorContinuityMode: "stateless",
        continuityByProvider: {
          "claude-oauth": "persisted-session-should-be-ignored"
        },
        warmStartPrompt: "Context handoff packet:\n- latest summary"
      }
    );

    expect(result.providerName).toBe("claude-oauth");
    expect(result.warmStartUsed).toBe(true);
    expect(result.providerSessionId).toBe("fresh-session-1");
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.providerSessionId).toBeUndefined();
    expect(provider.calls[0]?.prompt).toContain("Context handoff packet");
    expect(provider.calls[0]?.prompt).toContain("Current user message");
  });

  it("uses a fresh tool-free synthesis prompt for worker-backed turns", async () => {
    const provider = new ScriptedProvider((callNumber, request) => {
      if (callNumber === 1) {
        return {
          text: '<worker-dispatch worker="planner">Pull the latest task state.</worker-dispatch>',
          providerSessionId: "phase-1-session"
        };
      }

      return {
        text: `synthesized via ${request.providerSessionId ?? "missing-session"}`
      };
    });

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => {
          throw new Error("loadProviderContinuityMap should not run for stateless turns");
        },
        savePersistedProviderSession: () => {
          throw new Error("savePersistedProviderSession should not run for stateless turns");
        },
        buildWarmStartContextPrompt: () => "Context handoff packet:\n- current project summary",
        executeWorkerWithTask: async () => ({
          operations: [{
            name: "planner.pull_state",
            toolNames: ["planner.pull_state"],
            input: {},
            output: { status: "ok" },
            mode: "read" as const,
          }],
          hasWriteOperations: false,
          data: { status: "ok" },
        })
      },
      () => ({
        conversationKey: "tango-default:watson",
        providerNames: ["claude-oauth"],
        configuredProviderNames: ["claude-oauth"]
      })
    );

    const result = await executor.executeTurnDetailed(
      {
        sessionId: "tango-default",
        agentId: "watson",
        transcript: "what changed after the worker ran?",
        channelId: "channel-1",
        discordUserId: "user-1"
      },
      {
        conversationKey: "tango-default:watson",
        providerNames: ["claude-oauth"],
        configuredProviderNames: ["claude-oauth"],
        orchestratorContinuityMode: "stateless",
        warmStartPrompt: "Context handoff packet:\n- current project summary"
      }
    );

    expect(result.usedWorkerSynthesis).toBe(true);
    expect(result.providerSessionId).toBeUndefined();
    expect(result.responseText).toContain("missing-session");
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0]?.providerSessionId).toBeUndefined();
    expect(provider.calls[1]?.providerSessionId).toBeUndefined();
    expect(provider.calls[1]?.tools).toEqual({ mode: "off" });
    expect(provider.calls[1]?.prompt).toContain("Original user message:");
    expect(provider.calls[1]?.prompt).toContain("what changed after the worker ran?");
  });

  it("routes worker results through synthesis even when the worker already returned deliverable user text", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      if (callNumber === 1) {
        return {
          text: "Checking that now.",
          toolCalls: [
            {
              name: DISPATCH_TOOL_FULL_NAME,
              input: {
                worker_id: "planner",
                task: "Pull the latest task state.",
              },
            },
          ],
          providerSessionId: "phase-1-session",
        };
      }

      return {
        text: "Repo status is clean, and the latest executor latency patch is on `codex/executor-affinity-hardening`.",
      };
    });

    const workerText = [
      "Here’s the update:",
      "- The repo status is clean.",
      "- The latest executor latency patch is on branch codex/executor-affinity-hardening.",
    ].join("\n");

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => undefined,
        executeWorkerWithTask: async () => ({
          operations: [{
            name: "planner.pull_state",
            toolNames: ["planner.pull_state"],
            input: {},
            output: { status: "ok" },
            mode: "read" as const,
          }],
          hasWriteOperations: false,
          data: { workerText },
        }),
      },
      () => ({
        conversationKey: "tango-default:watson",
        providerNames: ["claude-oauth"],
        configuredProviderNames: ["claude-oauth"],
        tools: { mode: "allowlist", allowlist: [DISPATCH_TOOL_FULL_NAME] },
      }),
    );

    const result = await executor.executeTurnDetailed(
      {
        sessionId: "tango-default",
        agentId: "watson",
        transcript: "what changed after the worker ran?",
        channelId: "channel-1",
        discordUserId: "user-1",
      },
      {
        conversationKey: "tango-default:watson",
        providerNames: ["claude-oauth"],
        configuredProviderNames: ["claude-oauth"],
        tools: { mode: "allowlist", allowlist: [DISPATCH_TOOL_FULL_NAME] },
      },
    );

    expect(result.responseText).toBe(
      "Repo status is clean, and the latest executor latency patch is on `codex/executor-affinity-hardening`.",
    );
    expect(result.usedWorkerSynthesis).toBe(true);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]?.tools).toEqual({ mode: "off" });
    expect(provider.calls[1]?.prompt).toContain(workerText);
  });

  it("prefers structured dispatch tool calls before XML fallback", async () => {
    const provider = new ScriptedProvider((callNumber, request) => {
      if (callNumber === 1) {
        return {
          text: "Let me check that.",
          toolCalls: [
            {
              name: DISPATCH_TOOL_FULL_NAME,
              input: {
                worker_id: "planner",
                task: "Pull the latest task state.",
              },
            },
          ],
          providerSessionId: "phase-1-session",
        };
      }

      return {
        text: `synthesized via ${request.providerSessionId ?? "missing-session"}`,
      };
    });

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => {
          throw new Error("loadProviderContinuityMap should not run for stateless turns");
        },
        savePersistedProviderSession: () => {
          throw new Error("savePersistedProviderSession should not run for stateless turns");
        },
        buildWarmStartContextPrompt: () => "Context handoff packet:\n- current project summary",
        executeWorkerWithTask: async () => ({
          operations: [{
            name: "planner.pull_state",
            toolNames: ["planner.pull_state"],
            input: {},
            output: { status: "ok" },
            mode: "read" as const,
          }],
          hasWriteOperations: false,
          data: { status: "ok" },
        }),
      },
      () => ({
        conversationKey: "tango-default:watson",
        providerNames: ["claude-oauth"],
        configuredProviderNames: ["claude-oauth"],
      }),
    );

    const result = await executor.executeTurnDetailed(
      {
        sessionId: "tango-default",
        agentId: "watson",
        transcript: "what changed after the worker ran?",
        channelId: "channel-1",
        discordUserId: "user-1",
      },
      {
        conversationKey: "tango-default:watson",
        providerNames: ["claude-oauth"],
        configuredProviderNames: ["claude-oauth"],
        orchestratorContinuityMode: "stateless",
        warmStartPrompt: "Context handoff packet:\n- current project summary",
      },
    );

    expect(result.usedWorkerSynthesis).toBe(true);
    expect(result.providerSessionId).toBeUndefined();
    expect(result.responseText).toContain("missing-session");
    expect(result.workerDispatchTelemetry?.dispatchSource).toBe("tool");
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0]?.providerSessionId).toBeUndefined();
    expect(provider.calls[1]?.providerSessionId).toBeUndefined();
    expect(provider.calls[1]?.tools).toEqual({ mode: "off" });
    expect(provider.calls[1]?.prompt).toContain("Original user message:");
    expect(provider.calls[1]?.prompt).toContain("what changed after the worker ran?");
  });

  it("retries narrated worker-progress replies before allowing them through", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      if (callNumber === 1) {
        return {
          text: "Grabbing both files now — new project dimensions + old project as the model. Back in a sec.",
          providerSessionId: "phase-1-session-a",
        };
      }

      if (callNumber === 2) {
        return {
          text: "Dispatching now.",
          toolCalls: [
            {
              name: DISPATCH_TOOL_FULL_NAME,
              input: {
                worker_id: "research-assistant",
                task: "Open the two Obsidian files and summarize the print strategy.",
              },
            },
          ],
          providerSessionId: "phase-1-session-b",
        };
      }

      return {
        text: "I found both files and summarized the prior print strategy.",
      };
    });

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => "Context handoff packet:\n- prior print strategy summary",
        executeWorkerWithTask: async () => ({
          operations: [{
            name: "obsidian.read",
            toolNames: ["obsidian"],
            input: {},
            output: { status: "ok" },
            mode: "read" as const,
          }],
          hasWriteOperations: false,
          data: { status: "ok" },
        }),
      },
      () => ({
        conversationKey: "topic:desk:sierra",
        providerNames: ["claude-oauth"],
        configuredProviderNames: ["claude-oauth"],
        systemPrompt: "You are Sierra.",
        tools: { mode: "allowlist", allowlist: [DISPATCH_TOOL_FULL_NAME] },
      }),
    );

    const result = await executor.executeTurn({
      sessionId: "topic:desk",
      agentId: "sierra",
      transcript: "Open both desk project files and use the old one as the model.",
      channelId: "channel-1",
      discordUserId: "user-1",
    });

    expect(result.responseText).toBe("I found both files and summarized the prior print strategy.");
    expect(result.usedWorkerSynthesis).toBe(true);
    expect(result.workerDispatchTelemetry?.dispatchSource).toBe("tool");
    expect(provider.calls).toHaveLength(3);
    expect(provider.calls[1]?.systemPrompt).toContain("Do not send progress-only replies");
    expect(provider.calls[1]?.providerSessionId).toBeUndefined();
    expect(provider.calls[1]?.prompt).toContain("Context handoff packet:");
    expect(provider.calls[1]?.prompt).toContain("Current user message:");
    expect(provider.calls[2]?.providerSessionId).toBeUndefined();
    expect(provider.calls[2]?.tools).toEqual({ mode: "off" });
  });

  it("retries conversational follow-up narration in a fresh session with warm-start context", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      if (callNumber === 1) {
        return {
          text: "Let me grab that and check on it.",
          providerSessionId: "phase-1-session-a",
        };
      }

      return {
        text: "The next step is to confirm the transfer rules and then wire them into the workflow.",
        providerSessionId: "phase-1-session-b",
      };
    });

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => [
          "Context handoff packet:",
          "- prior workflow discussion",
          "- assistant had already outlined the workflow",
        ].join("\n"),
      },
      () => ({
        conversationKey: "watson-follow-up:watson",
        providerNames: ["claude-oauth"],
        configuredProviderNames: ["claude-oauth"],
        systemPrompt: "You are Watson.",
        tools: { mode: "allowlist", allowlist: [DISPATCH_TOOL_FULL_NAME] },
      }),
    );

    const result = await executor.executeTurn({
      sessionId: "watson-follow-up",
      agentId: "watson",
      transcript: "thanks",
      channelId: "channel-1",
      discordUserId: "user-1",
    });

    expect(result.responseText).toBe(
      "The next step is to confirm the transfer rules and then wire them into the workflow.",
    );
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0]?.tools).toEqual({ mode: "off" });
    expect(provider.calls[1]?.tools).toEqual({ mode: "off" });
    expect(provider.calls[1]?.systemPrompt).toContain("Do not emit worker-dispatch tags");
    expect(provider.calls[1]?.providerSessionId).toBeUndefined();
    expect(provider.calls[1]?.prompt).toContain("Context handoff packet:");
    expect(provider.calls[1]?.prompt).toContain("Current user message:");
    expect(provider.calls[1]?.prompt).toContain("thanks");
  });

  it("detects 'reply in context' confusion on conversational follow-ups", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      if (callNumber === 1) {
        return {
          text: "I need to reply in context, but I don't have the conversation context right now.",
          providerSessionId: "phase-1-session-a",
        };
      }

      return {
        text: "The transfer rules stay the same as the last step we discussed.",
        providerSessionId: "phase-1-session-b",
      };
    });

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({ "claude-oauth": "stale-session-1" }),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => [
          "Context handoff packet:",
          "- prior workflow discussion",
          "- assistant had already outlined the workflow",
        ].join("\n"),
      },
      () => ({
        conversationKey: "watson-follow-up:watson",
        providerNames: ["claude-oauth"],
        configuredProviderNames: ["claude-oauth"],
        systemPrompt: "You are Watson.",
        tools: { mode: "allowlist", allowlist: [DISPATCH_TOOL_FULL_NAME] },
      }),
    );

    const result = await executor.executeTurn({
      sessionId: "watson-follow-up",
      agentId: "watson",
      transcript: "thanks",
      channelId: "channel-1",
      discordUserId: "user-1",
    });

    expect(result.contextConfusionDetected).toBe(true);
    expect(result.responseText).toBe("The transfer rules stay the same as the last step we discussed.");
    expect(provider.calls).toHaveLength(2);
  });

  it("retries with tools enabled when context confusion is detected on conversational bypass", async () => {
    const provider = new ScriptedProvider((callNumber, request) => {
      if (callNumber === 1) {
        expect(request.tools).toEqual({ mode: "off" });
        expect(request.providerSessionId).toBe("stale-session-1");
        return {
          text: "I can't reply without the conversation context here.",
          providerSessionId: "phase-1-session-a",
        };
      }

      expect(request.tools).toEqual({ mode: "allowlist", allowlist: [DISPATCH_TOOL_FULL_NAME] });
      expect(request.systemPrompt).toBe("You are Watson.");
      expect(request.providerSessionId).toBeUndefined();
      expect(request.prompt).toContain("Context handoff packet:");
      expect(request.prompt).toContain("Current user message:");
      expect(request.prompt).toContain("thanks");
      return {
        text: "I checked the thread and can answer directly now.",
        providerSessionId: "phase-1-session-b",
      };
    });

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({ "claude-oauth": "stale-session-1" }),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => [
          "Context handoff packet:",
          "- prior workflow discussion",
          "- assistant had already outlined the workflow",
        ].join("\n"),
      },
      () => ({
        conversationKey: "watson-follow-up:watson",
        providerNames: ["claude-oauth"],
        configuredProviderNames: ["claude-oauth"],
        systemPrompt: "You are Watson.",
        tools: { mode: "allowlist", allowlist: [DISPATCH_TOOL_FULL_NAME] },
      }),
    );

    const result = await executor.executeTurn({
      sessionId: "watson-follow-up",
      agentId: "watson",
      transcript: "thanks",
      channelId: "channel-1",
      discordUserId: "user-1",
    });

    expect(result.contextConfusionDetected).toBe(true);
    expect(result.responseText).toBe("I checked the thread and can answer directly now.");
    expect(result.attemptCount).toBe(2);
    expect(provider.calls).toHaveLength(2);
  });

  it("suppresses repeated fake worker-progress replies when no dispatch ever happens", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      if (callNumber === 1) {
        return {
          text: "Grabbing both files now — back in a sec.",
          providerSessionId: "phase-1-session-a",
        };
      }

      return {
        text: "Dispatched again — waiting on results.",
        providerSessionId: "phase-1-session-b",
      };
    });

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => undefined,
        executeWorkerWithTask: async () => {
          throw new Error("worker should not run");
        },
      },
      () => ({
        conversationKey: "topic:desk:sierra",
        providerNames: ["claude-oauth"],
        configuredProviderNames: ["claude-oauth"],
        tools: { mode: "allowlist", allowlist: [DISPATCH_TOOL_FULL_NAME] },
      }),
    );

    const result = await executor.executeTurn({
      sessionId: "topic:desk",
      agentId: "sierra",
      transcript: "Find both files.",
      channelId: "channel-1",
      discordUserId: "user-1",
    });

    expect(result.responseText).toBe(
      "Sorry, something went wrong before I could actually start that worker task. Please try again.",
    );
    expect(result.usedWorkerSynthesis).toBe(false);
    expect(result.attemptCount).toBe(2);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]?.systemPrompt).toContain("Do not send progress-only replies");
  });

  it("suppresses invented worker-failure replies when no dispatch ever happened", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      if (callNumber === 1) {
        return {
          text: "Couldn’t lock it yet. The nutrition worker call got canceled before it returned, so I can’t claim those meals made it into the diary.",
          providerSessionId: "phase-1-session-a",
        };
      }

      return {
        text: "Still not locked. The nutrition worker got canceled again, so I can’t honestly say those meals made it into the diary.",
        providerSessionId: "phase-1-session-b",
      };
    });

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => undefined,
        executeWorkerWithTask: async () => {
          throw new Error("worker should not run");
        },
      },
      () => ({
        conversationKey: "project:wellness:malibu",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        tools: { mode: "allowlist", allowlist: [DISPATCH_TOOL_FULL_NAME] },
      }),
    );

    const result = await executor.executeTurn({
      sessionId: "project:wellness",
      agentId: "malibu",
      transcript: "Log breakfast and lunch for today.",
      channelId: "channel-1",
      discordUserId: "user-1",
    });

    expect(result.responseText).toBe(
      "Sorry, something went wrong before I could actually start that worker task. Please try again.",
    );
    expect(result.usedWorkerSynthesis).toBe(false);
    expect(result.attemptCount).toBe(2);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]?.systemPrompt).toContain("Do not claim a worker, tool call, or dispatch was canceled");
  });

  it("injects worker report into provider prompt when executeWorker returns data", async () => {
    const provider = new ScriptedProvider(() => ({
      text: "synthesized from worker data",
      providerSessionId: "sess-1"
    }));

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => undefined,
        executeWorker: async () => ({
          operations: [{
            name: "health.recovery_summary",
            toolNames: ["healthdb.recovery_summary"],
            input: {},
            output: { sleep_hours: 7.2 },
            mode: "read" as const,
          }],
          hasWriteOperations: false,
          data: { sleep_hours: 7.2 },
        })
      },
      () => ({
        conversationKey: "project:wellness:malibu",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"]
      })
    );

    const result = await executor.executeTurn({
      sessionId: "project:wellness",
      agentId: "malibu",
      transcript: "how did I sleep",
      channelId: "channel-1",
      discordUserId: "user-1"
    });

    expect(result.responseText).toBe("synthesized from worker data");
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.prompt).toContain("[Worker execution results");
    expect(provider.calls[0]?.prompt).toContain("User message: how did I sleep");
  });

  it("retries synthesis when the final answer still sounds like incomplete worker status", async () => {
    let callCount = 0;
    const provider = new ScriptedProvider(() => {
      callCount++;
      if (callCount === 1) {
        return {
          text: 'Let me check that.\n\n<worker-dispatch worker="dev-assistant">Check the binary.</worker-dispatch>',
          providerSessionId: "phase-1-session"
        };
      }
      if (callCount === 2) {
        return {
          text: "Dispatched again — standing by for results.",
        };
      }
      return {
        text: "The binary is at /opt/homebrew/bin/gog and supports docs, drive, and sheets.",
        providerSessionId: "retry-session"
      };
    });

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => "Session context summary",
        executeWorkerWithTask: async () => ({
          operations: [{
            name: "agent_response",
            toolNames: [],
            input: {},
            output: "gog binary found at /opt/homebrew/bin/gog",
            mode: "read" as const,
          }],
          hasWriteOperations: false,
          data: { workerText: JSON.stringify({ status: "ok" }) },
        })
      },
      () => ({
        conversationKey: "topic:test-session:victor",
        providerNames: ["claude-oauth"],
        configuredProviderNames: ["claude-oauth"],
        orchestratorContinuityMode: "stateless",
      })
    );

    const result = await executor.executeTurnDetailed(
      {
        sessionId: "topic:test-session",
        agentId: "victor",
        transcript: "Check if gog has a docs subcommand",
        channelId: "channel-1",
        discordUserId: "user-1"
      },
      {
        conversationKey: "topic:test-session:victor",
        providerNames: ["claude-oauth"],
        configuredProviderNames: ["claude-oauth"],
        orchestratorContinuityMode: "stateless",
        warmStartPrompt: "Session context summary"
      }
    );

    expect(result.usedWorkerSynthesis).toBe(true);
    expect(result.synthesisRetried).toBe(true);
    expect(result.responseText).toContain("gog");
    expect(result.responseText).not.toContain("standing by");
    expect(provider.calls).toHaveLength(3);
    expect(provider.calls[1]?.providerSessionId).toBeUndefined();
    expect(provider.calls[1]?.tools).toEqual({ mode: "off" });
    expect(provider.calls[2]?.providerSessionId).toBeUndefined();
    expect(provider.calls[2]?.tools).toEqual({ mode: "off" });
    expect(provider.calls[2]?.prompt).toContain("Original user message:");
    expect(provider.calls[2]?.prompt).toContain("Check if gog has a docs subcommand");
    expect(provider.calls[2]?.prompt).toContain("gog binary found");
    expect(provider.calls[2]?.systemPrompt).toContain("The worker report already contains the actual results.");
  });

  it("routes eligible wellness turns through the deterministic runtime before orchestration", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      if (callNumber === 1) {
        return {
          text: JSON.stringify({
            intents: [
              {
                intentId: "nutrition.log_food",
                confidence: 0.94,
                entities: {
                  items: ["two eggs", "toast"],
                  meal: "breakfast",
                },
                rawEntities: ["two eggs", "toast"],
                missingSlots: [],
                canRunInParallel: true,
                routeHint: {
                  kind: "workflow",
                  targetId: "wellness.log_food_items",
                },
              },
            ],
          }),
          metadata: { model: "gpt-5.4" },
        };
      }

      return {
        text: "Logged breakfast: two eggs and toast.",
        metadata: { model: "gpt-5.4" },
      };
    });

    const workerCalls: Array<{ workerId: string; task: string }> = [];
    const deterministicRouting = {
      enabled: true,
      projectScope: "wellness",
      confidenceThreshold: 0.8,
      providerNames: ["codex"],
      configuredProviderNames: ["codex"],
      reasoningEffort: "low" as const,
      allowDirectStepExecution: false,
    };

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => undefined,
        executeWorkerWithTask: async (workerId, task) => {
          workerCalls.push({ workerId, task });
          return {
            operations: [
              {
                name: "log_food_items",
                toolNames: ["fatsecret.log_food"],
                input: {
                  items: ["two eggs", "toast"],
                  meal: "breakfast",
                },
                output: { logged: 2 },
                mode: "write",
              },
            ],
            hasWriteOperations: true,
            data: {
              workerText: "Logged breakfast: two eggs and toast.",
              logged: 2,
            },
          };
        },
      },
      () => ({
        conversationKey: "project:wellness:malibu",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        projectId: "wellness",
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      }),
    );

    const result = await executor.executeTurnDetailed(
      {
        sessionId: "project:wellness",
        agentId: "malibu",
        transcript: "Log two eggs and toast for breakfast",
        channelId: "channel-1",
        discordUserId: "user-1",
      },
      {
        conversationKey: "project:wellness:malibu",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        projectId: "wellness",
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
        warmStartPrompt: [
          "Session memory context:",
          "session=project:wellness agent=malibu",
          "recent_messages:",
          "inbound: We are logging tacos with pulled pork for dinner.",
          "outbound: How much pulled pork was in each taco?",
          "inbound: It was 60g per taco.",
          "End session memory context.",
        ].join("\n"),
      },
    );

    expect(result.responseText).toBe("Logged breakfast: two eggs and toast.");
    expect(result.usedWorkerSynthesis).toBe(false);
    expect(result.deterministicTurn?.state.routing.routeOutcome).toBe("executed");
    expect(result.deterministicTurn?.receipts).toHaveLength(1);
    expect(result.deterministicTurn?.receipts[0]).toMatchObject({
      workerId: "nutrition-logger",
      status: "completed",
      hasWriteOperations: true,
    });
    expect(workerCalls).toHaveLength(1);
    expect(workerCalls[0]?.workerId).toBe("nutrition-logger");
    expect(workerCalls[0]?.task).toContain("wellness.log_food_items");
    expect(workerCalls[0]?.task).toContain("Recent conversation:");
    expect(workerCalls[0]?.task).toContain("It was 60g per taco.");
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0]?.tools).toEqual({ mode: "off" });
    expect(provider.calls[1]?.tools).toEqual({ mode: "off" });
    expect(provider.calls[1]?.prompt).toContain("Logged breakfast: two eggs and toast.");
  });

  it("narrows deterministic workout history turns to workout_sql when dispatching workout-recorder", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      if (callNumber !== 1) {
        return new Error(`Unexpected provider call ${callNumber}`);
      }

      return {
        text: JSON.stringify({
          intents: [
            {
              intentId: "workout.history",
              confidence: 0.95,
              entities: {
                workout_type: "push",
              },
              rawEntities: ["last push day", "push"],
              missingSlots: [],
              canRunInParallel: true,
              routeHint: {
                kind: "worker",
                targetId: "workout-recorder",
              },
            },
          ],
        }),
        metadata: { model: "gpt-5.4" },
      };
    });

    const workerCalls: Array<{
      workerId: string;
      task: string;
      toolIds?: string[];
    }> = [];
    const deterministicRouting = {
      enabled: true,
      projectScope: "wellness",
      confidenceThreshold: 0.8,
      providerNames: ["codex"],
      configuredProviderNames: ["codex"],
      reasoningEffort: "low" as const,
      allowDirectStepExecution: false,
    };

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => undefined,
        executeWorkerWithTask: async (workerId, task, _turn, _context, options) => {
          workerCalls.push({
            workerId,
            task,
            toolIds: options?.toolIds,
          });
          return {
            operations: [
              {
                name: "workout_sql",
                toolNames: ["workout_sql"],
                input: {
                  sql: "SELECT id FROM workouts WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1;",
                },
                output: { result: "[]" },
                mode: "read",
              },
            ],
            hasWriteOperations: false,
            data: {
              workerText: "Last push day included bench press and incline dumbbell press.",
            },
          };
        },
      },
      () => ({
        conversationKey: "project:wellness:malibu",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        projectId: "wellness",
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      }),
    );

    const result = await executor.executeTurnDetailed(
      {
        sessionId: "project:wellness",
        agentId: "malibu",
        transcript: "What did I do on my last push day?",
        channelId: "channel-1",
        discordUserId: "user-1",
      },
      {
        conversationKey: "project:wellness:malibu",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        projectId: "wellness",
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      },
    );

    expect(result.responseText).toBe("Last push day included bench press and incline dumbbell press.");
    expect(result.deterministicTurn?.state.routing.routeOutcome).toBe("executed");
    expect(workerCalls).toHaveLength(1);
    expect(workerCalls[0]?.workerId).toBe("workout-recorder");
    expect(workerCalls[0]?.toolIds).toEqual(["workout_sql"]);
    expect(workerCalls[0]?.task).toContain("Intent contract: workout.history");
    expect(workerCalls[0]?.task).toContain(
      "Tool surface for this intent is intentionally narrowed to: workout_sql.",
    );
  });

  it("resolves open-task follow-ups before deterministic classification", async () => {
    const provider = new ScriptedProvider((callNumber, request) => {
      if (callNumber === 1) {
        expect(request.prompt).toContain("Open task objective: Log dinner tacos with pulled pork once the portion is confirmed.");
        expect(request.prompt).toContain("User follow-up message: yeah, log that dinner");
        return {
          text: JSON.stringify({
            intents: [
              {
                intentId: "nutrition.log_food",
                confidence: 0.95,
                entities: {
                  items: ["pulled pork tacos"],
                  meal: "dinner",
                },
                rawEntities: ["pulled pork tacos", "dinner"],
                missingSlots: [],
                canRunInParallel: true,
                routeHint: {
                  kind: "workflow",
                  targetId: "wellness.log_food_items",
                },
              },
            ],
          }),
          metadata: { model: "gpt-5.4" },
        };
      }

      return {
        text: "Dinner logged: pulled pork tacos.",
        metadata: { model: "gpt-5.4" },
      };
    });

    const workerCalls: Array<{ workerId: string; task: string }> = [];
    const deterministicRouting = {
      enabled: true,
      confidenceThreshold: 0.8,
      providerNames: ["codex"],
      configuredProviderNames: ["codex"],
      reasoningEffort: "low" as const,
      allowDirectStepExecution: false,
    };

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => "recent_messages:\noutbound: Want me to pull a few weeks of TDEE?",
        listActiveTasks: () => [
          {
            id: "task-1",
            sessionId: "project:wellness",
            agentId: "malibu",
            status: "awaiting_user",
            title: "Log taco dinner",
            objective: "Log dinner tacos with pulled pork once the portion is confirmed.",
            ownerWorkerId: "nutrition-logger",
            intentIds: ["nutrition.log_food"],
            missingSlots: [],
            clarificationQuestion: "Want me to log the taco dinner now that we have the portion?",
            suggestedNextAction: "Confirm the dinner log.",
            structuredContext: {
              gramsPerTaco: 60,
              meal: "dinner",
            },
            sourceKind: "assistant-offer",
            createdByMessageId: 10,
            updatedByMessageId: 10,
            createdAt: "2026-03-30T13:00:00.000Z",
            updatedAt: "2026-03-30T13:05:00.000Z",
            resolvedAt: null,
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
        ],
        executeWorkerWithTask: async (workerId, task) => {
          workerCalls.push({ workerId, task });
          return {
            operations: [
              {
                name: "fatsecret_api",
                toolNames: ["fatsecret_api"],
                input: {
                  method: "food_entry_create",
                },
                output: {
                  ok: true,
                },
                mode: "write",
              },
            ],
            hasWriteOperations: true,
            data: {
              workerText: "Dinner logged: pulled pork tacos.",
            },
          };
        },
      },
      () => ({
        conversationKey: "project:wellness:malibu",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      }),
    );

    const result = await executor.executeTurnDetailed(
      {
        sessionId: "project:wellness",
        agentId: "malibu",
        transcript: "yeah, log that dinner",
        channelId: "channel-1",
        discordUserId: "user-1",
      },
      {
        conversationKey: "project:wellness:malibu",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      },
    );

    expect(result.activeTaskResolution?.kind).toBe("continue");
    expect(result.activeTaskResolution?.matchedTask?.id).toBe("task-1");
    expect(result.deterministicTurn?.state.routing.routeOutcome).toBe("executed");
    expect(workerCalls).toHaveLength(1);
    expect(workerCalls[0]?.task).toContain("User message: The user is continuing an existing open task");
    expect(result.responseText).toContain("Dinner logged");
  });

  it("only bypasses deterministic routing for pure acknowledgements", () => {
    const noTaskResolution = {
      kind: "none" as const,
      matchedTask: null,
      effectiveUserMessage: "",
    };

    expect(
      __testOnly.detectConversationalTurnBypass({
        userMessage: "thanks",
        activeTaskResolution: noTaskResolution,
      })?.kind,
    ).toBe("feedback");
    expect(
      __testOnly.detectConversationalTurnBypass({
        userMessage: "Ok.",
        activeTaskResolution: noTaskResolution,
      })?.kind,
    ).toBe("feedback");
    expect(
      __testOnly.detectConversationalTurnBypass({
        userMessage: "What are the next steps to implement the workflow?",
        activeTaskResolution: noTaskResolution,
      }),
    ).toBeNull();
    expect(
      __testOnly.detectConversationalTurnBypass({
        userMessage: "That is not what I asked.",
        activeTaskResolution: noTaskResolution,
      }),
    ).toBeNull();
    expect(
      __testOnly.detectConversationalTurnBypass({
        userMessage: "Ok. Try adding freeze dried apples",
        activeTaskResolution: noTaskResolution,
      }),
    ).toBeNull();
  });

  it("falls back to the LLM for Watson planning follow-ups when classification is not confident", async () => {
    const provider = new ScriptedProvider((callNumber, request) => {
      if (callNumber === 1) {
        expect(request.tools).toEqual({ mode: "off" });
        expect(request.prompt).toContain("Current user message:\nSo what's the next step to implement your proposed workflow then?");
        expect(request.prompt).toContain("proposed sinking-fund workflow");
        return {
          text: JSON.stringify({ conversationMode: "follow_up", intents: [] }),
          metadata: { model: "gpt-5.4" },
        };
      }
      expect(request.prompt).toContain("So what's the next step to implement your proposed workflow then?");
      expect(request.tools).toEqual({ mode: "off" });
      expect(request.systemPrompt).toContain("conversational follow-up");
      return {
        text: "1. Confirm the categories and transfer rules. 2. Add the recurring transfer automation. 3. Add the reconciliation review and exception-handling loop.",
        metadata: { model: "gpt-5.4" },
      };
    });

    const workerCalls: Array<{ workerId: string; task: string }> = [];
    const deterministicRouting = {
      enabled: true,
      confidenceThreshold: 0.8,
      providerNames: ["codex"],
      configuredProviderNames: ["codex"],
      reasoningEffort: "low" as const,
    };

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => [
          "recent_messages:",
          "[assistant] Here is the proposed sinking-fund workflow: reconcile the current balances, codify transfer rules, and add a weekly exception review.",
          "[user] Okay.",
        ].join("\n"),
        executeWorkerWithTask: async (workerId, task) => {
          workerCalls.push({ workerId, task });
          return {
            operations: [],
            hasWriteOperations: false,
            data: {
              workerText: "unexpected worker execution",
            },
          };
        },
      },
      () => ({
        conversationKey: "watson-live-deterministic:watson",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
        tools: {
          mode: "allowlist",
          allowlist: [DISPATCH_TOOL_FULL_NAME],
        },
      }),
    );

    const result = await executor.executeTurnDetailed(
      {
        sessionId: "watson-live-deterministic",
        agentId: "watson",
        transcript: "So what's the next step to implement your proposed workflow then?",
        channelId: "channel-1",
        discordUserId: "user-1",
      },
      {
        conversationKey: "watson-live-deterministic:watson",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
        tools: {
          mode: "allowlist",
          allowlist: [DISPATCH_TOOL_FULL_NAME],
        },
      },
    );

    expect(result.responseText).toContain("Confirm the categories");
    expect(result.deterministicTurn?.state.routing.routeOutcome).toBe("fallback");
    expect(result.deterministicTurn?.state.routing.fallbackReason).toBe(
      "Intent classifier marked this turn as conversational.",
    );
    expect(result.warmStartUsed).toBe(true);
    expect(result.warmStartContextChars).toBeGreaterThan(0);
    expect(workerCalls).toHaveLength(0);
    expect(provider.calls).toHaveLength(2);
  });

  it("falls back to the LLM for correction follow-ups even with an open task", async () => {
    const provider = new ScriptedProvider((callNumber, request) => {
      if (callNumber === 1) {
        expect(request.prompt).toContain("Current user message:\nno I meant implementation steps, not another finance report");
        expect(request.prompt).toContain("active_tasks:");
        expect(request.tools).toEqual({ mode: "off" });
        return {
          text: JSON.stringify({ conversationMode: "follow_up", intents: [] }),
          metadata: { model: "gpt-5.4" },
        };
      }

      expect(request.prompt).toContain("no I meant implementation steps, not another finance report");
      expect(request.tools).toEqual({ mode: "off" });
      return {
        text: "Understood. The next implementation steps are to define the transfer triggers, map the account movements, and decide where the reconciliation note lives.",
        metadata: { model: "gpt-5.4" },
      };
    });

    const workerCalls: Array<{ workerId: string; task: string }> = [];
    const deterministicRouting = {
      enabled: true,
      confidenceThreshold: 0.8,
      providerNames: ["codex"],
      configuredProviderNames: ["codex"],
      reasoningEffort: "low" as const,
    };

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => [
          "recent_messages:",
          "[assistant] I can pull the recent sinking-fund transactions if you want.",
          "[user] maybe",
        ].join("\n"),
        listActiveTasks: () => [
          {
            id: "task-1",
            sessionId: "watson-live-deterministic",
            agentId: "watson",
            status: "awaiting_user",
            title: "Review recent sinking-fund transactions",
            objective: "Pull the recent sinking-fund transactions and summarize the transfer activity.",
            ownerWorkerId: "personal-assistant",
            intentIds: ["finance.transaction_lookup"],
            missingSlots: [],
            clarificationQuestion: "Want me to pull the recent sinking-fund transactions?",
            suggestedNextAction: "Confirm the transaction lookup.",
            structuredContext: {
              focus: "sinking funds",
            },
            sourceKind: "assistant-offer",
            createdByMessageId: 10,
            updatedByMessageId: 10,
            createdAt: "2026-03-30T13:00:00.000Z",
            updatedAt: "2026-03-30T13:05:00.000Z",
            resolvedAt: null,
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
        ],
        executeWorkerWithTask: async (workerId, task) => {
          workerCalls.push({ workerId, task });
          return {
            operations: [],
            hasWriteOperations: false,
            data: {
              workerText: "unexpected worker execution",
            },
          };
        },
      },
      () => ({
        conversationKey: "watson-live-deterministic:watson",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
        tools: {
          mode: "allowlist",
          allowlist: [DISPATCH_TOOL_FULL_NAME],
        },
      }),
    );

    const result = await executor.executeTurnDetailed(
      {
        sessionId: "watson-live-deterministic",
        agentId: "watson",
        transcript: "no I meant implementation steps, not another finance report",
        channelId: "channel-1",
        discordUserId: "user-1",
      },
      {
        conversationKey: "watson-live-deterministic:watson",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
        tools: {
          mode: "allowlist",
          allowlist: [DISPATCH_TOOL_FULL_NAME],
        },
      },
    );

    expect(result.responseText).toContain("next implementation steps");
    expect(result.activeTaskResolution?.kind).toBe("none");
    expect(result.deterministicTurn?.state.routing.routeOutcome).toBe("fallback");
    expect(result.deterministicTurn?.state.routing.fallbackReason).toBe(
      "Intent classifier marked this turn as conversational.",
    );
    expect(result.warmStartUsed).toBe(true);
    expect(workerCalls).toHaveLength(0);
    expect(provider.calls).toHaveLength(2);
  });

  it("passes older URL-bearing recent context into deterministic worker tasks", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      if (callNumber !== 1) {
        return new Error(`Unexpected provider call ${callNumber}`);
      }

      return {
        text: "Budget review completed successfully.",
        metadata: { model: "gpt-5.4" },
      };
    });

    const workerCalls: Array<{ workerId: string; task: string }> = [];
    const deterministicRouting = {
      enabled: true,
      confidenceThreshold: 0.8,
      providerNames: ["codex"],
      configuredProviderNames: ["codex"],
      reasoningEffort: "low" as const,
      explicitIntentIds: ["finance.budget_review"],
    };

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => [
          "Session memory context:",
          "session=topic:docs agent=watson",
          "recent_messages:",
          "[user] Initial comparison request for the pricing doc.",
          "[assistant] I can help rewrite that draft.",
          "[user] Here's the doc: https://docs.google.com/document/d/abc123/edit",
          "[assistant] Review pass one complete.",
          "[user] I have some tone feedback.",
          "[assistant] I updated the draft and cleaned up the phrasing.",
          "[user] Please add the markdown sections back in so it's easier to scan.",
          "End session memory context.",
        ].join("\n"),
        executeWorkerWithTask: async (workerId, task) => {
          workerCalls.push({ workerId, task });
          return {
            operations: [
              {
                name: "lunch_money",
                toolNames: ["lunch_money"],
                input: { method: "GET", endpoint: "/budgets" },
                output: { status: "under-budget" },
                mode: "read",
              },
            ],
            hasWriteOperations: false,
            data: {
              workerText: "Budget looks under control.",
            },
          };
        },
      },
      () => ({
        conversationKey: "topic:docs:watson",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      }),
    );

    await executor.executeTurnDetailed(
      {
        sessionId: "topic:docs",
        agentId: "watson",
        transcript: "Please finish the review.",
      },
      {
        conversationKey: "topic:docs:watson",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      },
    );

    expect(workerCalls).toHaveLength(1);
    expect(workerCalls[0]?.task).toContain("https://docs.google.com/document/d/abc123/edit");
    expect(workerCalls[0]?.task).toContain("Please add the markdown sections back in so it's easier to scan.");
  });

  it("classifies obvious docs follow-ups using recent deterministic context", async () => {
    const provider = new ScriptedProvider((callNumber, request) => {
      if (callNumber === 1) {
        expect(request.tools).toEqual({ mode: "off" });
        expect(request.prompt).toContain("Continue recent deterministic intent docs.google_doc_read_or_update");
        expect(request.prompt).toContain("Expected intents: docs.google_doc_read_or_update");
        expect(request.prompt).toContain("\"priorIntentId\":\"docs.google_doc_read_or_update\"");
        expect(request.prompt).toContain("use this tab instead https://docs.google.com/document/d/1abcDocId/edit?tab=t.new");
        return {
          text: JSON.stringify({
            intents: [
              {
                intentId: "docs.google_doc_read_or_update",
                confidence: 0.96,
                entities: {
                  doc_query: "https://docs.google.com/document/d/1abcDocId/edit?tab=t.new",
                  account: "devin@latitude.io",
                  change_request: "Update the homepage copy",
                },
                rawEntities: ["https://docs.google.com/document/d/1abcDocId/edit?tab=t.new"],
                missingSlots: [],
                canRunInParallel: true,
                routeHint: {
                  kind: "worker",
                  targetId: "personal-assistant",
                },
              },
            ],
          }),
          metadata: { model: "gpt-5.4" },
        };
      }

      expect(callNumber).toBe(2);
      expect(request.tools).toEqual({ mode: "off" });
      expect(request.prompt).toContain("Updated the requested Google Doc tab.");
      return {
        text: "Updated the requested Google Doc tab.",
        metadata: { model: "gpt-5.4" },
      };
    });

    const workerCalls: Array<{ workerId: string; task: string }> = [];
    const deterministicRouting = {
      enabled: true,
      confidenceThreshold: 0.8,
      providerNames: ["codex"],
      configuredProviderNames: ["codex"],
      reasoningEffort: "low" as const,
    };

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => undefined,
        getLatestDeterministicTurnForConversation: () => ({
          id: "turn-1",
          sessionId: "topic:docs",
          agentId: "watson",
          conversationKey: "topic:docs:watson",
          initiatingPrincipalId: "user:user-1",
          leadAgentPrincipalId: "agent:watson",
          projectId: null,
          topicId: "topic-1",
          intentCount: 1,
          intentIds: ["docs.google_doc_read_or_update"],
          intentJson: [
            {
              id: "intent-1",
              domain: "docs",
              intentId: "docs.google_doc_read_or_update",
              mode: "write",
              confidence: 0.96,
              entities: {
                doc_query: "https://docs.google.com/document/d/1abcDocId/edit?tab=t.original",
                account: "devin@latitude.io",
                change_request: "Update the homepage copy",
              },
              rawEntities: ["https://docs.google.com/document/d/1abcDocId/edit?tab=t.original"],
              missingSlots: [],
              canRunInParallel: true,
              routeHint: {
                kind: "worker",
                targetId: "personal-assistant",
              },
            },
          ],
          intentModelRunId: null,
          routeOutcome: "executed",
          fallbackReason: null,
          executionPlanJson: null,
          stepCount: 1,
          completedStepCount: 1,
          failedStepCount: 0,
          hasWriteOperations: true,
          workerIds: ["personal-assistant"],
          delegationChain: ["user:user-1", "agent:watson", "worker:personal-assistant"],
          receiptsJson: [],
          narrationProvider: "codex",
          narrationModel: "gpt-5.4",
          narrationLatencyMs: 1200,
          narrationRetried: false,
          narrationModelRunId: null,
          intentLatencyMs: 3000,
          routeLatencyMs: 5,
          executionLatencyMs: 4000,
          totalLatencyMs: 8000,
          requestMessageId: 1,
          responseMessageId: 2,
          createdAt: new Date().toISOString(),
        }),
        executeWorkerWithTask: async (workerId, task) => {
          workerCalls.push({ workerId, task });
          return {
            operations: [
              {
                name: "gog_docs_update_tab",
                toolNames: ["gog_docs_update_tab"],
                input: {
                  doc: "https://docs.google.com/document/d/1abcDocId/edit?tab=t.new",
                },
                output: { status: "confirmed" },
                mode: "write",
              },
            ],
            hasWriteOperations: true,
            data: {
              workerText: "Updated the requested Google Doc tab.",
            },
          };
        },
      },
      () => ({
        conversationKey: "topic:docs:watson",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      }),
    );

    const result = await executor.executeTurnDetailed(
      {
        sessionId: "topic:docs",
        agentId: "watson",
        transcript: "use this tab instead https://docs.google.com/document/d/1abcDocId/edit?tab=t.new",
        channelId: "channel-1",
        discordUserId: "user-1",
      },
      {
        conversationKey: "topic:docs:watson",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      },
    );

    expect(result.responseText).toContain("Updated the requested Google Doc tab.");
    expect(result.deterministicTurn?.state.intent.classifierProvider).toBe("codex");
    expect(workerCalls).toHaveLength(1);
    expect(workerCalls[0]?.workerId).toBe("personal-assistant");
    expect(workerCalls[0]?.task).toContain("docs.google_doc_read_or_update");
    expect(workerCalls[0]?.task).toContain("https://docs.google.com/document/d/1abcDocId/edit?tab=t.new");
    expect(provider.calls).toHaveLength(2);
  });

  it("classifies recent nutrition follow-ups through recent deterministic context", async () => {
    const provider = new ScriptedProvider((callNumber, request) => {
      expect(request.tools).toEqual({ mode: "off" });
      expect(request.prompt).toContain("Continue recent deterministic intent nutrition.log_food");
      expect(request.prompt).toContain("Expected intents: nutrition.log_food");
      expect(request.prompt).toContain("\"priorIntentId\":\"nutrition.log_food\"");
      expect(request.prompt).toContain("Short follow-up requests that explicitly ask to add or log food");
      expect(request.prompt).toContain("want to try adding that rice now?");

      if (callNumber === 1) {
        return {
          text: JSON.stringify({
            conversationMode: "follow_up",
            intents: [],
          }),
          metadata: { model: "gpt-5.4" },
        };
      }

      expect(callNumber).toBe(2);
      return {
        text: JSON.stringify({
          conversationMode: "follow_up",
          intents: [
            {
              intentId: "nutrition.log_food",
              confidence: 0.95,
              entities: {
                items: ["2 tablespoons of white rice"],
                meal: "other",
              },
              rawEntities: ["white rice", "2 tablespoons"],
              missingSlots: [],
              canRunInParallel: true,
              routeHint: {
                kind: "workflow",
                targetId: "wellness.log_food_items",
              },
            },
          ],
        }),
        metadata: { model: "gpt-5.4" },
      };
    });

    const workerCalls: Array<{ workerId: string; task: string }> = [];
    const deterministicRouting = {
      enabled: true,
      confidenceThreshold: 0.8,
      providerNames: ["codex"],
      configuredProviderNames: ["codex"],
      reasoningEffort: "low" as const,
      allowDirectStepExecution: false,
    };

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => undefined,
        getLatestDeterministicTurnForConversation: () => ({
          id: "turn-1",
          sessionId: "project:wellness",
          agentId: "malibu",
          conversationKey: "project:wellness:malibu",
          initiatingPrincipalId: "user:user-1",
          leadAgentPrincipalId: "agent:malibu",
          projectId: "wellness",
          topicId: "topic-1",
          intentCount: 1,
          intentIds: ["nutrition.log_food"],
          intentJson: [
            {
              id: "intent-1",
              domain: "wellness",
              intentId: "nutrition.log_food",
              mode: "write",
              confidence: 0.96,
              entities: {
                items: ["2 tablespoons of white rice"],
                meal: "other",
              },
              rawEntities: ["white rice", "2 tablespoons"],
              missingSlots: [],
              canRunInParallel: true,
              routeHint: {
                kind: "workflow",
                targetId: "wellness.log_food_items",
              },
            },
          ],
          intentModelRunId: null,
          routeOutcome: "executed",
          fallbackReason: null,
          executionPlanJson: null,
          stepCount: 1,
          completedStepCount: 1,
          failedStepCount: 0,
          hasWriteOperations: true,
          workerIds: ["nutrition-logger"],
          delegationChain: ["user:user-1", "agent:malibu", "worker:nutrition-logger"],
          receiptsJson: [],
          narrationProvider: "codex",
          narrationModel: "gpt-5.4",
          narrationLatencyMs: 1200,
          narrationRetried: false,
          narrationModelRunId: null,
          intentLatencyMs: 3000,
          routeLatencyMs: 5,
          executionLatencyMs: 4000,
          totalLatencyMs: 8000,
          requestMessageId: 1,
          responseMessageId: 2,
          createdAt: new Date().toISOString(),
        }),
        executeWorkerWithTask: async (workerId, task) => {
          workerCalls.push({ workerId, task });
          return {
            operations: [
              {
                name: "log_food_items",
                toolNames: ["fatsecret.log_food"],
                input: {
                  items: ["2 tablespoons of white rice"],
                  meal: "other",
                },
                output: { logged: 1 },
                mode: "write",
              },
            ],
            hasWriteOperations: true,
            data: {
              workerText: "Logged snack: 2 tablespoons of white rice.",
            },
          };
        },
      },
      () => ({
        conversationKey: "project:wellness:malibu",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        projectId: "wellness",
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      }),
    );

    const result = await executor.executeTurnDetailed(
      {
        sessionId: "project:wellness",
        agentId: "malibu",
        transcript: "want to try adding that rice now?",
        channelId: "channel-1",
        discordUserId: "user-1",
      },
      {
        conversationKey: "project:wellness:malibu",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        projectId: "wellness",
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      },
    );

    expect(result.responseText).toContain("white rice");
    expect(result.deterministicTurn?.state.intent.classifierProvider).toBe("codex");
    expect(result.deterministicTurn?.state.routing.routeOutcome).toBe("executed");
    expect(workerCalls).toHaveLength(1);
    expect(workerCalls[0]?.workerId).toBe("nutrition-logger");
    expect(workerCalls[0]?.task).toContain("wellness.log_food_items");
    expect(workerCalls[0]?.task).toContain("white rice");
    expect(provider.calls).toHaveLength(2);
  });

  it("does not reuse a prior nutrition food intent for an explicit recipe update", () => {
    expect(
      __testOnly.isLikelyContinuationForIntent(
        "nutrition.log_food",
        'Update the recipe named "Codex Deterministic Smoke Recipe" and add this exact note somewhere in the notes section: "Codex deterministic write smoke validation." Keep everything else the same.',
      ),
    ).toBe(false);
    expect(
      __testOnly.isLikelyContinuationForIntent(
        "nutrition.log_food",
        "go ahead and finish that banana entry",
      ),
    ).toBe(true);
    expect(
      __testOnly.isLikelyContinuationForIntent(
        "nutrition.log_food",
        "Log one medium banana as other for 2026-04-12, and then tell me my calories so far for 2026-04-12.",
      ),
    ).toBe(false);
  });

  it("only reuses a prior food-log intent for changed meal content when the new request is still an explicit food-log action", () => {
    expect(
      __testOnly.isLikelyContinuationForIntent(
        "nutrition.log_food",
        "Whoa. Breakfast looks wrong. I've cleared it. Can you re-add my protein yogurt bowl?",
        {
          items: [{ name: "tortilla chips", quantity: "15g" }],
          meal: "other",
          date_scope: "today",
        },
      ),
    ).toBe(false);
    expect(
      __testOnly.isLikelyContinuationForIntent(
        "nutrition.log_food",
        "Ok. Try adding freeze dried apples",
        {
          items: [{ name: "white rice", quantity: "2 tablespoons" }],
          meal: "other",
          date_scope: "today",
        },
      ),
    ).toBe(true);
    expect(
      __testOnly.isLikelyContinuationForIntent(
        "nutrition.log_food",
        "Move that to breakfast instead.",
        {
          items: [{ name: "tortilla chips", quantity: "15g" }],
          meal: "other",
          date_scope: "today",
        },
      ),
    ).toBe(true);
  });

  it("does not let deterministic write narration claim success when the worker still needs clarification", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      if (callNumber === 1) {
        return {
          text: JSON.stringify({
            intents: [
              {
                intentId: "nutrition.log_food",
                confidence: 0.95,
                entities: {
                  items: ["protein chili bowl"],
                },
                rawEntities: ["protein chili bowl"],
                missingSlots: [],
                canRunInParallel: true,
                routeHint: {
                  kind: "workflow",
                  targetId: "wellness.log_food_items",
                },
              },
            ],
          }),
          metadata: { model: "gpt-5.4" },
        };
      }

      return {
        text: "Breakfast is in, dude.",
        metadata: { model: "gpt-5.4" },
      };
    });

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => undefined,
        executeWorkerWithTask: async () => ({
          operations: [],
          hasWriteOperations: false,
          clarification: "What meal should that be logged under?",
          data: {
            workerText: "status: needs_clarification",
          },
        }),
      },
      () => ({
        conversationKey: "project:wellness:malibu",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting: {
          enabled: true,
          confidenceThreshold: 0.8,
          providerNames: ["codex"],
          configuredProviderNames: ["codex"],
          reasoningEffort: "low",
        },
      }),
    );

    const result = await executor.executeTurnDetailed(
      {
        sessionId: "project:wellness",
        agentId: "malibu",
        transcript: "log the protein chili bowl and breakfast too",
        channelId: "channel-1",
        discordUserId: "user-1",
      },
      {
        conversationKey: "project:wellness:malibu",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting: {
          enabled: true,
          confidenceThreshold: 0.8,
          providerNames: ["codex"],
          configuredProviderNames: ["codex"],
          reasoningEffort: "low",
        },
      },
    );

    expect(result.responseText).toBe("I didn't get a confirmed write through yet. What meal should that be logged under?");
  });

  it("does not let deterministic write narration claim success when no write was recorded", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      if (callNumber === 1) {
        return {
          text: JSON.stringify({
            intents: [
              {
                intentId: "nutrition.log_food",
                confidence: 0.95,
                entities: {
                  items: ["march 31 dinner repair"],
                },
                rawEntities: ["march 31 dinner repair"],
                missingSlots: [],
                canRunInParallel: true,
                routeHint: {
                  kind: "workflow",
                  targetId: "wellness.log_food_items",
                },
              },
            ],
          }),
          metadata: { model: "gpt-5.4" },
        };
      }

      return {
        text: "Patched, dude.",
        metadata: { model: "gpt-5.4" },
      };
    });

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => undefined,
        executeWorkerWithTask: async () => ({
          operations: [],
          hasWriteOperations: false,
          data: {
            workerText: "{\"action\":\"repair_fatsecret_dinner_entry_date\",\"status\":\"ok\"}",
          },
        }),
      },
      () => ({
        conversationKey: "project:wellness:malibu",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting: {
          enabled: true,
          confidenceThreshold: 0.8,
          providerNames: ["codex"],
          configuredProviderNames: ["codex"],
          reasoningEffort: "low",
        },
      }),
    );

    const result = await executor.executeTurnDetailed(
      {
        sessionId: "project:wellness",
        agentId: "malibu",
        transcript: "repair the march 31 dinner diary entry",
        channelId: "channel-1",
        discordUserId: "user-1",
      },
      {
        conversationKey: "project:wellness:malibu",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting: {
          enabled: true,
          confidenceThreshold: 0.8,
          providerNames: ["codex"],
          configuredProviderNames: ["codex"],
          reasoningEffort: "low",
        },
      },
    );

    expect(result.responseText).toBe("I didn't get a confirmed write through on that step, so I can't say it was logged yet.");
  });

  it("does not let deterministic write narration claim success when a write attempt failed to produce a confirmed committed result", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      if (callNumber === 1) {
        return {
          text: JSON.stringify({
            intents: [
              {
                intentId: "nutrition.log_food",
                confidence: 0.95,
                entities: {
                  items: ["banana"],
                },
                rawEntities: ["banana"],
                missingSlots: [],
                canRunInParallel: true,
                routeHint: {
                  kind: "workflow",
                  targetId: "wellness.log_food_items",
                },
              },
            ],
          }),
          metadata: { model: "gpt-5.4" },
        };
      }

      return {
        text: "Patched it.",
        metadata: { model: "gpt-5.4" },
      };
    });

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => undefined,
        executeWorkerWithTask: async () => ({
          operations: [
            {
              name: "fatsecret_api",
              toolNames: ["fatsecret_api"],
              input: { method: "food_entry_create" },
              mode: "write",
              output: { error: "cancelled by provider" },
            },
          ],
          hasWriteOperations: true,
          data: {
            workerText: "{\"status\":\"blocked\"}",
          },
        }),
      },
      () => ({
        conversationKey: "project:wellness:malibu",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting: {
          enabled: true,
          confidenceThreshold: 0.8,
          providerNames: ["codex"],
          configuredProviderNames: ["codex"],
          reasoningEffort: "low",
        },
      }),
    );

    const result = await executor.executeTurnDetailed(
      {
        sessionId: "project:wellness",
        agentId: "malibu",
        transcript: "Log one banana for me.",
        channelId: "channel-1",
        discordUserId: "user-1",
      },
      {
        conversationKey: "project:wellness:malibu",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting: {
          enabled: true,
          confidenceThreshold: 0.8,
          providerNames: ["codex"],
          configuredProviderNames: ["codex"],
          reasoningEffort: "low",
        },
      },
    );

    expect(result.responseText).toBe("I didn't get a confirmed write through on that step, so I can't say it was logged yet.");
  });

  it("suppresses deterministic fake dispatch narration for Watson note writes", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      if (callNumber === 1) {
        return {
          text: JSON.stringify({
            intents: [
              {
                intentId: "notes.note_update",
                confidence: 0.95,
                entities: {
                  note_query: "Planning/Daily/2026-04-07",
                  change_request: "mark meal prep complete and keep website copy in progress",
                },
                rawEntities: ["Planning/Daily/2026-04-07", "meal prep complete", "website copy in progress"],
                missingSlots: [],
                canRunInParallel: false,
                routeHint: {
                  kind: "worker",
                  targetId: "personal-assistant",
                },
              },
            ],
          }),
          metadata: { model: "gpt-5.4" },
        };
      }

      return {
        text: [
          "The read came back clean - I can see today's note clearly. Now let me push those updates through.",
          "",
          "<worker-dispatch worker=\"personal-assistant\">",
          "Update the daily note now.",
          "</worker-dispatch>",
        ].join("\n"),
        metadata: { model: "gpt-5.4" },
      };
    });

    const deterministicRouting = {
      enabled: true,
      confidenceThreshold: 0.8,
      providerNames: ["codex"],
      configuredProviderNames: ["codex"],
      reasoningEffort: "low" as const,
    };

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => undefined,
        executeWorkerWithTask: async () => ({
          operations: [
            {
              name: "obsidian",
              toolNames: ["obsidian"],
              input: { command: "print 'Planning/Daily/2026-04-07' --vault main" },
              output: { found: true },
              mode: "read",
            },
          ],
          hasWriteOperations: false,
          data: {
            workerText: "Read succeeded. Write targets identified, but no write receipt was returned.",
          },
        }),
      },
      () => ({
        conversationKey: "tango-default:watson",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      }),
    );

    const result = await executor.executeTurnDetailed(
      {
        sessionId: "tango-default",
        agentId: "watson",
        transcript: "Update today's daily note to mark meal prep complete and keep website copy in progress.",
        channelId: "channel-1",
        discordUserId: "user-1",
      },
      {
        conversationKey: "tango-default:watson",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      },
    );

    expect(result.responseText).toBe("I didn't get a confirmed write through on that step, so I can't say it was logged yet.");
  });

  it("delivers confirmed Obsidian write results without tripping the deterministic write guard", async () => {
    const provider = new ScriptedProvider(() => ({
      text: JSON.stringify({
        intents: [
          {
            intentId: "notes.note_update",
            confidence: 0.95,
            entities: {
              note_query: "Planning/Daily/2026-04-07",
              change_request: "mark meal prep complete and keep website copy in progress",
            },
            rawEntities: ["Planning/Daily/2026-04-07", "meal prep complete", "website copy in progress"],
            missingSlots: [],
            canRunInParallel: false,
            routeHint: {
              kind: "worker",
              targetId: "personal-assistant",
            },
          },
        ],
      }),
      metadata: { model: "gpt-5.4" },
    }));

    const deterministicRouting = {
      enabled: true,
      confidenceThreshold: 0.8,
      providerNames: ["codex"],
      configuredProviderNames: ["codex"],
      reasoningEffort: "low" as const,
    };

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => undefined,
        executeWorkerWithTask: async () => ({
          operations: [
            {
              name: "obsidian",
              toolNames: ["obsidian"],
              input: {
                command: "create 'Planning/Daily/2026-04-07' --vault main --overwrite",
                content: "# Daily note",
              },
              output: { result: "Created note successfully." },
              mode: "write",
            },
          ],
          hasWriteOperations: true,
          data: {
            workerText: "Updated today's daily note in Obsidian.",
          },
        }),
      },
      () => ({
        conversationKey: "tango-default:watson",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      }),
    );

    const result = await executor.executeTurnDetailed(
      {
        sessionId: "tango-default",
        agentId: "watson",
        transcript: "Update today's daily note to mark meal prep complete and keep website copy in progress.",
        channelId: "channel-1",
        discordUserId: "user-1",
      },
      {
        conversationKey: "tango-default:watson",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      },
    );

    expect(result.responseText).toBe("Updated today's daily note in Obsidian.");
    expect(result.deterministicTurn?.receipts[0]).toMatchObject({
      status: "completed",
      hasWriteOperations: true,
    });
    expect(provider.calls).toHaveLength(1);
  });

  it("routes Sierra research turns through the deterministic runtime without project scope", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      if (callNumber === 1) {
        return {
          text: JSON.stringify({
            intents: [
              {
                intentId: "research.note_read",
                confidence: 0.95,
                entities: {
                  note_query: "Large Desk OpenGrid and Underware Project",
                  focus: "Print Summary",
                },
                rawEntities: ["Large Desk OpenGrid and Underware Project", "Print Summary"],
                missingSlots: [],
                canRunInParallel: true,
                routeHint: {
                  kind: "worker",
                  targetId: "research-assistant",
                },
              },
            ],
          }),
          metadata: { model: "gpt-5.4" },
        };
      }

      return {
        text: "Print Summary says the section should be split into the two desk zones plus trench pieces.",
        metadata: { model: "gpt-5.4" },
      };
    });

    const workerCalls: Array<{ workerId: string; task: string }> = [];
    const deterministicRouting = {
      enabled: true,
      confidenceThreshold: 0.8,
      providerNames: ["codex"],
      configuredProviderNames: ["codex"],
      reasoningEffort: "low" as const,
    };

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => undefined,
        executeWorkerWithTask: async (workerId, task) => {
          workerCalls.push({ workerId, task });
          return {
            operations: [
              {
                name: "obsidian",
                toolNames: ["obsidian"],
                input: { note_query: "Large Desk OpenGrid and Underware Project" },
                output: { found: true },
                mode: "read",
              },
            ],
            hasWriteOperations: false,
            data: {
              workerText: "Print Summary says the section should be split into the two desk zones plus trench pieces.",
            },
          };
        },
      },
      () => ({
        conversationKey: "sierra-live-deterministic:sierra",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      }),
    );

    const result = await executor.executeTurnDetailed(
      {
        sessionId: "sierra-live-deterministic",
        agentId: "sierra",
        transcript: "Read the Obsidian note titled Large Desk OpenGrid and Underware Project and summarize the Print Summary section.",
        channelId: "channel-1",
        discordUserId: "user-1",
      },
      {
        conversationKey: "sierra-live-deterministic:sierra",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      },
    );

    expect(result.responseText).toContain("Print Summary");
    expect(result.deterministicTurn?.state.routing.routeOutcome).toBe("executed");
    expect(result.deterministicTurn?.receipts[0]).toMatchObject({
      workerId: "research-assistant",
      status: "completed",
      hasWriteOperations: false,
    });
    expect(workerCalls).toHaveLength(1);
    expect(workerCalls[0]?.workerId).toBe("research-assistant");
    expect(workerCalls[0]?.task).toContain("research.note_read");
    expect(provider.calls[0]?.tools).toEqual({ mode: "off" });
    expect(provider.calls[1]?.tools).toEqual({ mode: "off" });
    expect(provider.calls[1]?.prompt).toContain(
      "Print Summary says the section should be split into the two desk zones plus trench pieces.",
    );
    expect(provider.calls).toHaveLength(2);
  });

  it("routes Malibu health-trend and nutrition-budget analysis through the deterministic runtime", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      if (callNumber === 1) {
        return {
          text: JSON.stringify({
            intents: [
              {
                intentId: "health.trend_analysis",
                confidence: 0.95,
                entities: {
                  days: 21,
                  focus: "tdee",
                  goal: "cut",
                },
                rawEntities: ["TDEE", "last few weeks"],
                missingSlots: [],
                canRunInParallel: true,
                routeHint: {
                  kind: "workflow",
                  targetId: "wellness.analyze_health_trends",
                },
              },
              {
                intentId: "nutrition.check_budget",
                confidence: 0.93,
                entities: {
                  planned_item: "yogurt",
                  focus: "room_left",
                  goal: "cut",
                },
                rawEntities: ["yogurt", "room left"],
                missingSlots: [],
                canRunInParallel: true,
                routeHint: {
                  kind: "workflow",
                  targetId: "wellness.check_nutrition_budget",
                },
              },
            ],
          }),
          metadata: { model: "gpt-5.4" },
        };
      }

      return {
        text: "Your recent TDEE trend is holding near a moderate deficit, and you still have room for yogurt tonight without blowing the day.",
        metadata: { model: "gpt-5.4" },
      };
    });

    const workerCalls: Array<{ workerId: string; task: string }> = [];
    const deterministicRouting = {
      enabled: true,
      projectScope: "wellness",
      confidenceThreshold: 0.8,
      providerNames: ["codex"],
      configuredProviderNames: ["codex"],
      reasoningEffort: "low" as const,
    };

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => undefined,
        executeWorkerWithTask: async (workerId, task) => {
          workerCalls.push({ workerId, task });
          if (task.includes("health.trend_analysis")) {
            return {
              operations: [
                {
                  name: "health_query",
                  toolNames: ["health_query"],
                  input: { focus: "tdee", days: 21 },
                  output: { average_tdee: 2980, deficit: 420 },
                  mode: "read",
                },
              ],
              hasWriteOperations: false,
              data: {
                workerText: "Recent TDEE trend over the last three weeks is about 2,980 calories with a moderate deficit holding steady.",
              },
            };
          }

          return {
            operations: [
              {
                name: "fatsecret_api",
                toolNames: ["fatsecret_api", "health_query"],
                input: { planned_item: "yogurt", focus: "room_left" },
                output: { room_left: true, calories_left: 310 },
                mode: "read",
              },
            ],
            hasWriteOperations: false,
            data: {
              workerText: "You still have room for a yogurt tonight, with roughly 310 calories left and protein pace still on track.",
            },
          };
        },
      },
      () => ({
        conversationKey: "project:wellness:malibu",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        projectId: "wellness",
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      }),
    );

    const result = await executor.executeTurnDetailed(
      {
        sessionId: "project:wellness",
        agentId: "malibu",
        transcript: "Take a look at my TDEE over the last few weeks and tell me if I still have room for yogurt tonight.",
        channelId: "channel-1",
        discordUserId: "user-1",
      },
      {
        conversationKey: "project:wellness:malibu",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        projectId: "wellness",
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      },
    );

    expect(result.responseText).toContain("TDEE");
    expect(result.responseText).toMatch(/yogurt/i);
    expect(result.deterministicTurn?.state.routing.routeOutcome).toBe("executed");
    expect(result.deterministicTurn?.receipts).toHaveLength(2);
    expect(result.deterministicTurn?.receipts.map((receipt) => receipt.workerId).sort()).toEqual([
      "health-analyst",
      "nutrition-logger",
    ]);
    expect(workerCalls).toHaveLength(1);
    expect(workerCalls[0]?.workerId).toBe("health-analyst");
    expect(workerCalls[0]?.task).toContain("health.trend_analysis");
    expect(provider.calls[0]?.tools).toEqual({ mode: "off" });
    expect(provider.calls).toHaveLength(1);
    expect(result.usedWorkerSynthesis).toBe(false);
  });

  it("routes Sierra mixed printer and live-location turns through the deterministic runtime", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      if (callNumber === 1) {
        return {
          text: JSON.stringify({
            intents: [
              {
                intentId: "travel.location_read",
                confidence: 0.94,
                entities: {
                  focus: "current_location",
                },
                rawEntities: ["right now"],
                missingSlots: [],
                canRunInParallel: true,
                routeHint: {
                  kind: "worker",
                  targetId: "research-assistant",
                },
              },
              {
                intentId: "printing.printer_status",
                confidence: 0.92,
                entities: {
                  focus: "status",
                },
                rawEntities: ["printer status"],
                missingSlots: [],
                canRunInParallel: true,
                routeHint: {
                  kind: "worker",
                  targetId: "research-assistant",
                },
              },
            ],
          }),
          metadata: { model: "gpt-5.4" },
        };
      }

      return {
        text: "You are near Springville and the printer is currently printing.",
        metadata: { model: "gpt-5.4" },
      };
    });

    const workerCalls: Array<{ workerId: string; task: string }> = [];
    const deterministicRouting = {
      enabled: true,
      confidenceThreshold: 0.8,
      providerNames: ["codex"],
      configuredProviderNames: ["codex"],
      reasoningEffort: "low" as const,
    };

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => undefined,
        executeWorkerWithTask: async (workerId, task) => {
          workerCalls.push({ workerId, task });
          if (task.includes("travel.location_read")) {
            return {
              operations: [
                {
                  name: "location_read",
                  toolNames: ["location_read"],
                  input: {},
                  output: { city: "Springville", state: "UT" },
                  mode: "read",
                },
              ],
              hasWriteOperations: false,
              data: {
                workerText: "Current location is near Springville, Utah.",
              },
            };
          }

          return {
            operations: [
              {
                name: "printer_command",
                toolNames: ["printer_command"],
                input: { action: "status" },
                output: { state: "PRINTING" },
                mode: "read",
              },
            ],
            hasWriteOperations: false,
            data: {
              workerText: "Printer status is PRINTING on the current job.",
            },
          };
        },
      },
      () => ({
        conversationKey: "sierra-live-deterministic:sierra",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      }),
    );

    const result = await executor.executeTurnDetailed(
      {
        sessionId: "sierra-live-deterministic",
        agentId: "sierra",
        transcript: "Where am I right now and what's the current printer status?",
        channelId: "channel-1",
        discordUserId: "user-1",
      },
      {
        conversationKey: "sierra-live-deterministic:sierra",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      },
    );

    expect(result.responseText).toMatch(/printer/i);
    expect(result.responseText).toContain("Springville");
    expect(result.deterministicTurn?.state.routing.routeOutcome).toBe("executed");
    expect(result.deterministicTurn?.receipts).toHaveLength(2);
    expect(result.deterministicTurn?.receipts.every((receipt) => receipt.workerId === "research-assistant")).toBe(true);
    expect(workerCalls).toHaveLength(2);
    expect(workerCalls[0]?.task).toContain("travel.location_read");
    expect(workerCalls[1]?.task).toContain("printing.printer_status");
  });

  it("routes Sierra diesel and Walmart queue turns through the deterministic runtime", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      if (callNumber === 1) {
        return {
          text: JSON.stringify({
            intents: [
              {
                intentId: "travel.diesel_lookup",
                confidence: 0.95,
                entities: {
                  destination: "Tonopah, Nevada",
                  top: 3,
                },
                rawEntities: ["Tonopah, Nevada"],
                missingSlots: [],
                canRunInParallel: true,
                routeHint: {
                  kind: "worker",
                  targetId: "research-assistant",
                },
              },
              {
                intentId: "shopping.walmart_queue_review",
                confidence: 0.93,
                entities: {
                  focus: "queue",
                },
                rawEntities: ["Walmart queue"],
                missingSlots: [],
                canRunInParallel: true,
                routeHint: {
                  kind: "worker",
                  targetId: "research-assistant",
                },
              },
            ],
          }),
          metadata: { model: "gpt-5.4" },
        };
      }

      return {
        text: "Best diesel stops on the Tonopah route are lined up, and the Walmart queue currently has two pending items.",
        metadata: { model: "gpt-5.4" },
      };
    });

    const workerCalls: Array<{ workerId: string; task: string }> = [];
    const deterministicRouting = {
      enabled: true,
      confidenceThreshold: 0.8,
      providerNames: ["codex"],
      configuredProviderNames: ["codex"],
      reasoningEffort: "low" as const,
    };

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => undefined,
        executeWorkerWithTask: async (workerId, task) => {
          workerCalls.push({ workerId, task });
          if (task.includes("travel.diesel_lookup")) {
            return {
              operations: [
                {
                  name: "find_diesel",
                  toolNames: ["find_diesel"],
                  input: { destination: "Tonopah, Nevada", top: 3 },
                  output: { stations: 3 },
                  mode: "read",
                },
              ],
              hasWriteOperations: false,
              data: {
                workerText: "Top diesel options on the Tonopah route include three ahead-of-route stations with low detours.",
              },
            };
          }

          return {
            operations: [
              {
                name: "walmart",
                toolNames: ["walmart"],
                input: { action: "queue_list" },
                output: { pending: 2 },
                mode: "read",
              },
            ],
            hasWriteOperations: false,
            data: {
              workerText: "The Walmart queue currently has two pending items and no completed pickups.",
            },
          };
        },
      },
      () => ({
        conversationKey: "sierra-live-deterministic:sierra",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      }),
    );

    const result = await executor.executeTurnDetailed(
      {
        sessionId: "sierra-live-deterministic",
        agentId: "sierra",
        transcript: "Find the best diesel stops on the route to Tonopah, Nevada and show the Walmart queue.",
        channelId: "channel-1",
        discordUserId: "user-1",
      },
      {
        conversationKey: "sierra-live-deterministic:sierra",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      },
    );

    expect(result.responseText).toContain("diesel");
    expect(result.responseText).toContain("Walmart");
    expect(result.deterministicTurn?.state.routing.routeOutcome).toBe("executed");
    expect(result.deterministicTurn?.receipts).toHaveLength(2);
    expect(result.deterministicTurn?.receipts.every((receipt) => receipt.workerId === "research-assistant")).toBe(true);
    expect(workerCalls).toHaveLength(2);
    expect(workerCalls[0]?.task).toContain("travel.diesel_lookup");
    expect(workerCalls[1]?.task).toContain("shopping.walmart_queue_review");
  });

  it("routes Watson finance review turns through the deterministic runtime", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      if (callNumber === 1) {
        return {
          text: JSON.stringify({
            intents: [
              {
                intentId: "finance.unreviewed_transactions",
                confidence: 0.94,
                entities: {
                  date_scope: "recent",
                  focus: "review",
                },
                rawEntities: ["unconfirmed transactions"],
                missingSlots: [],
                canRunInParallel: true,
                routeHint: {
                  kind: "worker",
                  targetId: "personal-assistant",
                },
              },
            ],
          }),
          metadata: { model: "gpt-5.4" },
        };
      }

      return {
        text: "You have 4 unreviewed transactions: one gas charge auto-categorizable and three vendors that still need review.",
        metadata: { model: "gpt-5.4" },
      };
    });

    const workerCalls: Array<{ workerId: string; task: string }> = [];
    const deterministicRouting = {
      enabled: true,
      confidenceThreshold: 0.8,
      providerNames: ["codex"],
      configuredProviderNames: ["codex"],
      reasoningEffort: "low" as const,
    };

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => undefined,
        executeWorkerWithTask: async (workerId, task) => {
          workerCalls.push({ workerId, task });
          return {
            operations: [
              {
                name: "lunch_money",
                toolNames: ["lunch_money"],
                input: { method: "GET", endpoint: "/transactions?status=unreviewed" },
                output: { transactions: 4 },
                mode: "read",
              },
            ],
            hasWriteOperations: false,
            data: {
              workerText: "You have 4 unreviewed transactions: one gas charge auto-categorizable and three vendors that still need review.",
            },
          };
        },
      },
      () => ({
        conversationKey: "watson-live-deterministic:watson",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      }),
    );

    const result = await executor.executeTurnDetailed(
      {
        sessionId: "watson-live-deterministic",
        agentId: "watson",
        transcript: "Can you summarize our unconfirmed transactions for me please so we can go through them?",
        channelId: "channel-1",
        discordUserId: "user-1",
      },
      {
        conversationKey: "watson-live-deterministic:watson",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      },
    );

    expect(result.responseText).toContain("4 unreviewed transactions");
    expect(result.deterministicTurn?.state.routing.routeOutcome).toBe("executed");
    expect(result.deterministicTurn?.receipts[0]).toMatchObject({
      workerId: "personal-assistant",
      status: "completed",
      hasWriteOperations: false,
    });
    expect(workerCalls).toHaveLength(1);
    expect(workerCalls[0]?.workerId).toBe("personal-assistant");
    expect(workerCalls[0]?.task).toContain("finance.unreviewed_transactions");
  });

  it("routes Watson current-time turns through the deterministic runtime", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      if (callNumber !== 1) {
        return new Error(`Unexpected provider call ${callNumber}`);
      }

      return {
        text: JSON.stringify({
          intents: [
            {
              intentId: "planning.current_time_read",
              confidence: 0.95,
              entities: {},
              rawEntities: ["current time"],
              missingSlots: [],
              canRunInParallel: true,
              routeHint: {
                kind: "worker",
                targetId: "personal-assistant",
              },
            },
          ],
        }),
        metadata: { model: "gpt-5.4" },
      };
    });

    const workerCalls: Array<{
      workerId: string;
      task: string;
      toolIds?: string[];
    }> = [];
    const deterministicRouting = {
      enabled: true,
      confidenceThreshold: 0.8,
      providerNames: ["codex"],
      configuredProviderNames: ["codex"],
      reasoningEffort: "low" as const,
    };

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => undefined,
        executeWorkerWithTask: async (workerId, task, _turn, _context, options) => {
          workerCalls.push({
            workerId,
            task,
            toolIds: options?.toolIds,
          });
          return {
            operations: [
              {
                name: "system_clock",
                toolNames: ["system_clock"],
                input: {},
                output: { time: "9:53 AM PDT" },
                mode: "read",
              },
            ],
            hasWriteOperations: false,
            data: {
              workerText: "9:53 AM PDT.",
            },
          };
        },
      },
      () => ({
        conversationKey: "watson-live-deterministic:watson",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      }),
    );

    const result = await executor.executeTurnDetailed(
      {
        sessionId: "watson-live-deterministic",
        agentId: "watson",
        transcript: "What time is it?",
        channelId: "channel-1",
        discordUserId: "user-1",
      },
      {
        conversationKey: "watson-live-deterministic:watson",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      },
    );

    expect(result.responseText).toContain("AM");
    expect(result.deterministicTurn?.state.routing.routeOutcome).toBe("executed");
    expect(workerCalls).toHaveLength(1);
    expect(workerCalls[0]?.workerId).toBe("personal-assistant");
    expect(workerCalls[0]?.task).toContain("planning.current_time_read");
    expect(workerCalls[0]?.toolIds).toEqual(["system_clock"]);
  });

  it("routes Watson mixed calendar and inbox review turns through the deterministic runtime", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      if (callNumber === 1) {
        return {
          text: JSON.stringify({
            intents: [
              {
                intentId: "planning.calendar_review",
                confidence: 0.94,
                entities: {
                  date_scope: "today",
                },
                rawEntities: ["today"],
                missingSlots: [],
                canRunInParallel: true,
                routeHint: {
                  kind: "worker",
                  targetId: "personal-assistant",
                },
              },
              {
                intentId: "email.inbox_review",
                confidence: 0.92,
                entities: {
                  date_scope: "today",
                  focus: "actionable",
                },
                rawEntities: ["unread emails"],
                missingSlots: [],
                canRunInParallel: true,
                routeHint: {
                  kind: "worker",
                  targetId: "personal-assistant",
                },
              },
            ],
          }),
          metadata: { model: "gpt-5.4" },
        };
      }

      return {
        text: "You have three calendar events today and two unread emails that likely need a reply.",
        metadata: { model: "gpt-5.4" },
      };
    });

    const workerCalls: Array<{ workerId: string; task: string }> = [];
    const deterministicRouting = {
      enabled: true,
      confidenceThreshold: 0.8,
      providerNames: ["codex"],
      configuredProviderNames: ["codex"],
      reasoningEffort: "low" as const,
    };

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => undefined,
        executeWorkerWithTask: async (workerId, task) => {
          workerCalls.push({ workerId, task });
          if (task.includes("planning.calendar_review")) {
            return {
              operations: [
                {
                  name: "gog_calendar",
                  toolNames: ["gog_calendar"],
                  input: { command: "calendar events --today --all --json" },
                  output: { events: 3 },
                  mode: "read",
                },
              ],
              hasWriteOperations: false,
              data: {
                workerText: "Today has three calendar events, including a noon workout and an evening family block.",
              },
            };
          }

          return {
            operations: [
              {
                name: "gog_email",
                toolNames: ["gog_email"],
                input: { command: "gmail messages search 'is:unread newer_than:1d' --max 20" },
                output: { actionableThreads: 2 },
                mode: "read",
              },
            ],
            hasWriteOperations: false,
            data: {
              workerText: "Two unread emails look actionable: one scheduling thread and one billing follow-up.",
            },
          };
        },
      },
      () => ({
        conversationKey: "watson-live-deterministic:watson",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      }),
    );

    const result = await executor.executeTurnDetailed(
      {
        sessionId: "watson-live-deterministic",
        agentId: "watson",
        transcript: "What's on my calendar today and what unread emails need attention?",
        channelId: "channel-1",
        discordUserId: "user-1",
      },
      {
        conversationKey: "watson-live-deterministic:watson",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      },
    );

    expect(result.responseText).toContain("calendar");
    expect(result.responseText).toContain("emails");
    expect(result.deterministicTurn?.state.routing.routeOutcome).toBe("executed");
    expect(result.deterministicTurn?.receipts).toHaveLength(2);
    expect(result.deterministicTurn?.receipts.every((receipt) => receipt.workerId === "personal-assistant")).toBe(true);
    expect(workerCalls).toHaveLength(2);
    expect(workerCalls.map((call) => call.workerId)).toEqual(["personal-assistant", "personal-assistant"]);
    expect(workerCalls[0]?.task).toContain("planning.calendar_review");
    expect(workerCalls[1]?.task).toContain("email.inbox_review");
  });

  it("routes Watson health briefing and budget review turns through the deterministic runtime", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      if (callNumber === 1) {
        return {
          text: JSON.stringify({
            intents: [
              {
                intentId: "health.morning_brief",
                confidence: 0.95,
                entities: {
                  mode: "morning",
                },
                rawEntities: ["morning health briefing"],
                missingSlots: [],
                canRunInParallel: true,
                routeHint: {
                  kind: "worker",
                  targetId: "personal-assistant",
                },
              },
              {
                intentId: "finance.budget_review",
                confidence: 0.93,
                entities: {
                  date_scope: "this_month",
                  focus: "budget",
                },
                rawEntities: ["budget", "this month"],
                missingSlots: [],
                canRunInParallel: true,
                routeHint: {
                  kind: "worker",
                  targetId: "personal-assistant",
                },
              },
            ],
          }),
          metadata: { model: "gpt-5.4" },
        };
      }

      return {
        text: "Your morning recovery looks solid, and you're currently under budget for the month overall.",
        metadata: { model: "gpt-5.4" },
      };
    });

    const workerCalls: Array<{ workerId: string; task: string }> = [];
    const deterministicRouting = {
      enabled: true,
      confidenceThreshold: 0.8,
      providerNames: ["codex"],
      configuredProviderNames: ["codex"],
      reasoningEffort: "low" as const,
    };

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => undefined,
        executeWorkerWithTask: async (workerId, task) => {
          workerCalls.push({ workerId, task });
          if (task.includes("health.morning_brief")) {
            return {
              operations: [
                {
                  name: "health_morning",
                  toolNames: ["health_morning"],
                  input: { mode: "morning" },
                  output: { recovery: "good" },
                  mode: "read",
                },
              ],
              hasWriteOperations: false,
              data: {
                workerText: "Morning health briefing shows solid recovery, acceptable sleep, and normal activity so far.",
              },
            };
          }

          return {
            operations: [
              {
                name: "lunch_money",
                toolNames: ["lunch_money"],
                input: { method: "GET", endpoint: "/budgets?start_date=2026-03-01&end_date=2026-03-31" },
                output: { monthStatus: "under-budget" },
                mode: "read",
              },
            ],
            hasWriteOperations: false,
            data: {
              workerText: "Budget review says month-to-date spending is under budget overall, with groceries slightly elevated but still within target.",
            },
          };
        },
      },
      () => ({
        conversationKey: "watson-live-deterministic:watson",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      }),
    );

    const result = await executor.executeTurnDetailed(
      {
        sessionId: "watson-live-deterministic",
        agentId: "watson",
        transcript: "Give me my morning health briefing and tell me how I'm doing against budget this month.",
        channelId: "channel-1",
        discordUserId: "user-1",
      },
      {
        conversationKey: "watson-live-deterministic:watson",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      },
    );

    expect(result.responseText).toContain("recovery");
    expect(result.responseText).toContain("budget");
    expect(result.deterministicTurn?.state.routing.routeOutcome).toBe("executed");
    expect(result.deterministicTurn?.receipts).toHaveLength(2);
    expect(result.deterministicTurn?.receipts.every((receipt) => receipt.workerId === "personal-assistant")).toBe(true);
    expect(workerCalls).toHaveLength(2);
    expect(workerCalls[0]?.task).toContain("health.morning_brief");
    expect(workerCalls[1]?.task).toContain("finance.budget_review");
  });

  it("routes Victor repo-status and codebase-read turns through the deterministic runtime", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      if (callNumber === 1) {
        return {
          text: JSON.stringify({
            intents: [
              {
                intentId: "engineering.repo_status",
                confidence: 0.95,
                entities: {
                  focus: "git_status",
                },
                rawEntities: ["git status", "repo"],
                missingSlots: [],
                canRunInParallel: true,
                routeHint: {
                  kind: "worker",
                  targetId: "dev-assistant",
                },
              },
              {
                intentId: "engineering.codebase_read",
                confidence: 0.93,
                entities: {
                  target_query: "config/agents/victor.yaml",
                  focus: "deterministic routing",
                },
                rawEntities: ["config/agents/victor.yaml", "deterministic routing"],
                missingSlots: [],
                canRunInParallel: true,
                routeHint: {
                  kind: "worker",
                  targetId: "dev-assistant",
                },
              },
            ],
          }),
          metadata: { model: "gpt-5.4" },
        };
      }

      return {
        text: "The repo is currently dirty, and victor.yaml enables deterministic routing with low-effort classification fallback.",
        metadata: { model: "gpt-5.4" },
      };
    });

    const workerCalls: Array<{ workerId: string; task: string }> = [];
    const deterministicRouting = {
      enabled: true,
      confidenceThreshold: 0.8,
      providerNames: ["codex"],
      configuredProviderNames: ["codex"],
      reasoningEffort: "low" as const,
    };

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => undefined,
        executeWorkerWithTask: async (workerId, task) => {
          workerCalls.push({ workerId, task });
          if (task.includes("engineering.repo_status")) {
            return {
              operations: [
                {
                  name: "tango_shell",
                  toolNames: ["tango_shell"],
                  input: { command: "git status --short --branch" },
                  output: { branch: "main", dirty: true },
                  mode: "read",
                },
              ],
              hasWriteOperations: false,
              data: {
                workerText: "Git status shows the branch is main with local modifications present.",
              },
            };
          }

          return {
            operations: [
              {
                name: "tango_file",
                toolNames: ["tango_file"],
                input: { operation: "read", path: "config/agents/victor.yaml" },
                output: { found: true },
                mode: "read",
              },
            ],
            hasWriteOperations: false,
            data: {
              workerText: "config/agents/victor.yaml enables deterministic routing with engineering scope, an 0.8 threshold, and low-effort classifier fallback to Codex.",
            },
          };
        },
      },
      () => ({
        conversationKey: "victor-live-deterministic:victor",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      }),
    );

    const result = await executor.executeTurnDetailed(
      {
        sessionId: "victor-live-deterministic",
        agentId: "victor",
        transcript: "What's the current git status and summarize what config/agents/victor.yaml says about deterministic routing?",
        channelId: "channel-1",
        discordUserId: "user-1",
      },
      {
        conversationKey: "victor-live-deterministic:victor",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      },
    );

    expect(result.responseText).toContain("Git status");
    expect(result.responseText).toContain("deterministic routing");
    expect(result.deterministicTurn?.state.routing.routeOutcome).toBe("executed");
    expect(result.deterministicTurn?.receipts).toHaveLength(2);
    expect(result.deterministicTurn?.receipts.every((receipt) => receipt.workerId === "dev-assistant")).toBe(true);
    expect(workerCalls).toHaveLength(2);
    expect(workerCalls[0]?.task).toContain("engineering.repo_status");
    expect(workerCalls[1]?.task).toContain("engineering.codebase_read");
  });

  it("can execute explicit deterministic intents without running the classifier", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      if (callNumber !== 1) {
        return new Error(`Unexpected provider call ${callNumber}`);
      }

      return {
        text: "Budget review completed successfully.",
        metadata: {
          model: "gpt-5.4",
          durationMs: 45,
        },
      };
    });

    const workerCalls: Array<{ workerId: string; task: string }> = [];
    const deterministicRouting = {
      enabled: true,
      confidenceThreshold: 0.8,
      providerNames: ["codex"],
      configuredProviderNames: ["codex"],
      reasoningEffort: "low" as const,
      explicitIntentIds: ["finance.budget_review"],
    };

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => undefined,
        executeWorkerWithTask: async (workerId, task) => {
          workerCalls.push({ workerId, task });
          return {
            operations: [
              {
                name: "lunch_money",
                toolNames: ["lunch_money"],
                input: { method: "GET", endpoint: "/budgets" },
                output: { status: "under-budget" },
                mode: "read",
              },
            ],
            hasWriteOperations: false,
            data: {
              workerText: "Budget looks under control.",
            },
          };
        },
      },
      () => ({
        conversationKey: "schedule:watson:watson",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      }),
    );

    const result = await executor.executeTurnDetailed(
      {
        sessionId: "schedule:watson:daily-budget-review",
        agentId: "watson",
        transcript: "Run the weekly finance review and summarize budget status.",
      },
      {
        conversationKey: "schedule:watson:watson",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      },
    );

    expect(result.responseText).toBe("Budget review completed successfully.");
    expect(result.deterministicTurn?.state.routing.routeOutcome).toBe("executed");
    expect(result.deterministicTurn?.state.intent.classifierProvider).toBe("config");
    expect(workerCalls).toHaveLength(1);
    expect(workerCalls[0]?.workerId).toBe("personal-assistant");
    expect(workerCalls[0]?.task).toContain("finance.budget_review");
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.prompt).toContain("Budget looks under control.");
  });

  it("still narrates explicit deterministic receipts when worker text is already deliverable", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      if (callNumber !== 1) {
        return new Error(`Unexpected provider call ${callNumber}`);
      }

      return {
        text: "Budget review completed. Groceries are under budget, and travel remains on track.",
        metadata: {
          model: "gpt-5.4",
          durationMs: 12,
        },
      };
    });

    const workerText = [
      "Budget review completed.",
      "- Groceries are under budget.",
      "- Travel is on track.",
    ].join("\n");

    const deterministicRouting = {
      enabled: true,
      confidenceThreshold: 0.8,
      providerNames: ["codex"],
      configuredProviderNames: ["codex"],
      reasoningEffort: "low" as const,
      explicitIntentIds: ["finance.budget_review"],
    };

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((providerName) => ({ providerName, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => undefined,
        executeWorkerWithTask: async () => ({
          operations: [
            {
              name: "lunch_money",
              toolNames: ["lunch_money"],
              input: { method: "GET", endpoint: "/budgets" },
              output: { status: "under-budget" },
              mode: "read",
            },
          ],
          hasWriteOperations: false,
          data: {
            workerText,
          },
        }),
      },
      () => ({
        conversationKey: "schedule:watson:watson",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      }),
    );

    const result = await executor.executeTurnDetailed(
      {
        sessionId: "schedule:watson:daily-budget-review",
        agentId: "watson",
        transcript: "Run the weekly finance review and summarize budget status.",
      },
      {
        conversationKey: "schedule:watson:watson",
        providerNames: ["codex"],
        configuredProviderNames: ["codex"],
        capabilityRegistry: createDeterministicRegistry(),
        deterministicRouting,
      },
    );

    expect(result.responseText).toBe(
      "Budget review completed. Groceries are under budget, and travel remains on track.",
    );
    expect(result.providerName).toBe("codex");
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.prompt).toContain(workerText);
  });
});
