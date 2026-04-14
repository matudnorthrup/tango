import { describe, expect, it } from "vitest";
import {
  CapabilityRegistry,
  type AgentConfig,
  type IntentContractConfig,
  type ProjectConfig,
  type WorkerConfig,
  type WorkflowConfig,
} from "@tango/core";
import {
  buildDeterministicExecutionPlan,
  getDeterministicIntentCatalog,
} from "../src/deterministic-router.js";
import type { IntentEnvelope } from "../src/intent-classifier.js";

function createRegistry(): CapabilityRegistry {
  const agents: AgentConfig[] = [
    {
      id: "malibu",
      type: "wellness",
      provider: { default: "claude-oauth" },
      orchestration: {
        workerIds: ["nutrition-logger", "workout-recorder", "recipe-librarian", "health-analyst"],
      },
    },
    {
      id: "sierra",
      type: "research",
      provider: { default: "claude-oauth" },
      orchestration: {
        workerIds: ["research-assistant"],
      },
    },
    {
      id: "watson",
      type: "personal",
      provider: { default: "claude-oauth" },
      orchestration: {
        workerIds: ["personal-assistant"],
      },
    },
    {
      id: "victor",
      type: "developer",
      provider: { default: "claude-oauth" },
      orchestration: {
        workerIds: ["dev-assistant"],
      },
    },
  ];
  const projects: ProjectConfig[] = [
    {
      id: "wellness",
      workerIds: ["nutrition-logger", "workout-recorder", "recipe-librarian", "health-analyst"],
    },
  ];
  const workers: WorkerConfig[] = [
    {
      id: "nutrition-logger",
      type: "logger",
      ownerAgentId: "malibu",
      provider: { default: "claude-oauth" },
    },
    {
      id: "workout-recorder",
      type: "recorder",
      ownerAgentId: "malibu",
      provider: { default: "claude-oauth" },
    },
    {
      id: "recipe-librarian",
      type: "librarian",
      ownerAgentId: "malibu",
      provider: { default: "claude-oauth" },
    },
    {
      id: "health-analyst",
      type: "analyst",
      ownerAgentId: "malibu",
      provider: { default: "claude-oauth" },
    },
    {
      id: "research-assistant",
      type: "researcher",
      ownerAgentId: "sierra",
      provider: { default: "claude-oauth" },
    },
    {
      id: "personal-assistant",
      type: "assistant",
      ownerAgentId: "watson",
      provider: { default: "claude-oauth" },
    },
    {
      id: "dev-assistant",
      type: "developer",
      ownerAgentId: "victor",
      provider: { default: "claude-oauth" },
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
      id: "wellness.log_recipe_meal",
      description: "Log a named recipe meal.",
      ownerWorkerId: "nutrition-logger",
      mode: "write",
      handler: "log_recipe_meal",
    },
    {
      id: "wellness.analyze_sleep_recovery",
      description: "Analyze sleep and recovery.",
      ownerWorkerId: "health-analyst",
      mode: "read",
      handler: "analyze_sleep_recovery",
    },
    {
      id: "wellness.analyze_health_trends",
      description: "Analyze broader health and TDEE trends.",
      ownerWorkerId: "health-analyst",
      mode: "read",
      handler: "analyze_health_trends",
    },
    {
      id: "wellness.analyze_nutrition_day",
      description: "Analyze day nutrition totals.",
      ownerWorkerId: "nutrition-logger",
      mode: "read",
      handler: "analyze_nutrition_day",
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
      id: "nutrition.log_recipe",
      domain: "wellness",
      displayName: "Log Recipe Meal",
      description: "Log a named recipe meal.",
      mode: "write",
      route: { kind: "workflow", targetId: "wellness.log_recipe_meal" },
      slots: [{ name: "recipe_query", required: true }],
      examples: ["Log my protein yogurt bowl for lunch"],
    },
    {
      id: "health.sleep_recovery",
      domain: "wellness",
      displayName: "Sleep Recovery",
      description: "Analyze sleep and recovery.",
      mode: "read",
      route: { kind: "workflow", targetId: "wellness.analyze_sleep_recovery" },
      examples: ["How did I sleep last night?"],
    },
    {
      id: "nutrition.day_summary",
      domain: "wellness",
      displayName: "Nutrition Day Summary",
      description: "Read day nutrition totals.",
      mode: "read",
      route: { kind: "workflow", targetId: "wellness.analyze_nutrition_day" },
      examples: ["What have I eaten today?"],
    },
    {
      id: "health.trend_analysis",
      domain: "wellness",
      displayName: "Health Trend Analysis",
      description: "Analyze multi-day health, recovery, activity, or TDEE trends.",
      mode: "read",
      route: { kind: "workflow", targetId: "wellness.analyze_health_trends" },
      examples: ["Take a look at my TDEE over the last few weeks"],
    },
    {
      id: "health.metric_lookup_or_question",
      domain: "wellness",
      displayName: "Health Metric Lookup Or Question",
      description: "Read and answer concrete health-metric questions grounded in recent data.",
      mode: "read",
      route: { kind: "worker", targetId: "health-analyst" },
      examples: ["What was my resting heart rate yesterday?"],
    },
    {
      id: "nutrition.check_budget",
      domain: "wellness",
      displayName: "Nutrition Budget Check",
      description: "Check calorie, protein, or room-left budget against current intake and activity.",
      mode: "read",
      route: { kind: "workflow", targetId: "wellness.check_nutrition_budget" },
      examples: ["Do I still have room for yogurt tonight?"],
    },
    {
      id: "nutrition.log_repair",
      domain: "wellness",
      displayName: "Repair Nutrition Log",
      description: "Repair, reconcile, or deduplicate existing diary entries.",
      mode: "write",
      route: { kind: "worker", targetId: "nutrition-logger" },
      examples: ["That lunch didn't log. Please repair it."],
    },
    {
      id: "nutrition.ingredient_catalog_update",
      domain: "wellness",
      displayName: "Update Ingredient Catalog",
      description: "Create or update reusable Atlas ingredient catalog entries.",
      mode: "write",
      route: { kind: "worker", targetId: "nutrition-logger" },
      slots: [{ name: "ingredient_query", required: true }],
      examples: ["Find a pulled pork in FatSecret and add it to Atlas for future use."],
    },
    {
      id: "workout.log",
      domain: "wellness",
      displayName: "Log Workout",
      description: "Log workout progress.",
      mode: "write",
      route: { kind: "worker", targetId: "workout-recorder" },
      examples: ["Bench 185 for 8"],
    },
    {
      id: "workout.history",
      domain: "wellness",
      displayName: "Workout History",
      description: "Read prior workouts.",
      mode: "read",
      route: { kind: "worker", targetId: "workout-recorder" },
      examples: ["What was my last bench workout?"],
    },
    {
      id: "recipe.read",
      domain: "wellness",
      displayName: "Read Recipe",
      description: "Read an existing recipe.",
      mode: "read",
      route: { kind: "worker", targetId: "recipe-librarian" },
      slots: [{ name: "recipe_query", required: true }],
      examples: ["What's in my egg hash recipe?"],
    },
    {
      id: "recipe.update",
      domain: "wellness",
      displayName: "Update Recipe",
      description: "Update an existing recipe.",
      mode: "write",
      route: { kind: "worker", targetId: "recipe-librarian" },
      slots: [
        { name: "recipe_query", required: true },
        { name: "change_request", required: true },
      ],
      examples: ["Update the recipe with the new macros"],
    },
    {
      id: "research.note_read",
      domain: "research",
      displayName: "Read Research Note",
      description: "Read or summarize a local note.",
      mode: "read",
      route: { kind: "worker", targetId: "research-assistant" },
      slots: [{ name: "note_query", required: true }],
      examples: ["Read the Obsidian note titled Large Desk OpenGrid and Underware Project"],
    },
    {
      id: "research.web_lookup",
      domain: "research",
      displayName: "Web Research Lookup",
      description: "Look up external or current web information.",
      mode: "read",
      route: { kind: "worker", targetId: "research-assistant" },
      slots: [{ name: "query", required: true }],
      examples: ["Look up the official Prusa MK4S product page"],
    },
    {
      id: "research.product_selection",
      domain: "research",
      displayName: "Product Selection",
      description: "Research a product category or lineup and recommend the best fit for the user's constraints.",
      mode: "read",
      route: { kind: "worker", targetId: "research-assistant" },
      slots: [{ name: "product_family", required: true }],
      examples: ["Help me choose the right Keychron keyboard model for me"],
    },
    {
      id: "research.video_read",
      domain: "research",
      displayName: "Read Video",
      description: "Read, transcribe, analyze, or summarize a specific video or YouTube link.",
      mode: "read",
      route: { kind: "worker", targetId: "research-assistant" },
      slots: [{ name: "video_query", required: true }],
      examples: ["Summarize this YouTube video for me."],
    },
    {
      id: "files.local_read",
      domain: "files",
      displayName: "Local File Review",
      description: "Read and summarize local non-repo files or directories like Downloads or Desktop.",
      mode: "read",
      route: { kind: "worker", targetId: "research-assistant" },
      slots: [{ name: "path_query", required: false }],
      examples: ["Use the worker to list the most recent files in ~/Downloads and summarize what kinds of files are there."],
    },
    {
      id: "files.local_write",
      domain: "files",
      displayName: "Local File Write",
      description: "Copy, move, rename, or organize non-repo local files.",
      mode: "write",
      route: { kind: "worker", targetId: "research-assistant" },
      slots: [
        { name: "path_query", required: true },
        { name: "change_request", required: true },
      ],
      examples: ["Move the newest STL from Downloads into the 3d-printing folder."],
    },
    {
      id: "accounts.identity_read",
      domain: "accounts",
      displayName: "Account Identity Read",
      description: "Read and summarize the current 1Password service-account identity or account URL.",
      mode: "read",
      route: { kind: "worker", targetId: "research-assistant" },
      examples: ["Use the worker to run 1Password whoami and summarize only the account URL."],
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
      id: "printing.job_prepare_or_start",
      domain: "printing",
      displayName: "Prepare Or Start Print Job",
      description: "Prepare, slice, upload, or start a requested print job.",
      mode: "write",
      route: { kind: "worker", targetId: "research-assistant" },
      slots: [{ name: "print_request", required: false }],
      examples: ["Can you do a 7x7 grid print please? No brim needed. Printer is ready."],
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
      id: "travel.route_plan",
      domain: "travel",
      displayName: "Route Plan",
      description: "Plan and summarize a travel route or directions request.",
      mode: "read",
      route: { kind: "worker", targetId: "research-assistant" },
      slots: [{ name: "destination", required: true }],
      examples: ["Plan the drive from Las Vegas to Tonopah, Nevada."],
    },
    {
      id: "travel.weather_read",
      domain: "travel",
      displayName: "Weather Read",
      description: "Read and summarize current weather or forecast conditions for a destination or route.",
      mode: "read",
      route: { kind: "worker", targetId: "research-assistant" },
      slots: [{ name: "location_query", required: true }],
      examples: ["What's the weather in Tonopah, Nevada right now?"],
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
      id: "shopping.browser_order_lookup",
      domain: "shopping",
      displayName: "Browser Order Lookup",
      description: "Look up browser-backed order or cart details without making changes.",
      mode: "read",
      route: { kind: "worker", targetId: "research-assistant" },
      examples: ["Check my Walmart order status."],
    },
    {
      id: "shopping.browser_order_action",
      domain: "shopping",
      displayName: "Browser Order Action",
      description: "Perform browser-backed shopping actions such as cart edits or order steps.",
      mode: "write",
      route: { kind: "worker", targetId: "research-assistant" },
      slots: [{ name: "action_request", required: true }],
      examples: ["Add those items to my Walmart cart."],
    },
    {
      id: "notes.note_update",
      domain: "notes",
      displayName: "Update Note",
      description: "Update or append to an existing local or Obsidian note.",
      mode: "write",
      route: { kind: "worker", targetId: "research-assistant" },
      slots: [
        { name: "note_query", required: true },
        { name: "change_request", required: true },
      ],
      examples: ["Update the desk project note with today's measurements."],
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
      id: "finance.transaction_categorization",
      domain: "finance",
      displayName: "Categorize Transactions",
      description: "Review and categorize Lunch Money transactions.",
      mode: "write",
      route: { kind: "worker", targetId: "personal-assistant" },
      examples: ["Go through these uncategorized transactions."],
    },
    {
      id: "finance.receipt_lookup",
      domain: "finance",
      displayName: "Look Up Receipt Or Order",
      description: "Look up receipt, order, or merchant-detail information tied to a financial transaction.",
      mode: "read",
      route: { kind: "worker", targetId: "personal-assistant" },
      examples: ["Can you look up what that Amazon charge was for?"],
    },
    {
      id: "finance.receipt_catalog",
      domain: "finance",
      displayName: "Catalog Receipts",
      description: "Create or update receipt records or notes after matching transaction and merchant detail data.",
      mode: "write",
      route: { kind: "worker", targetId: "personal-assistant" },
      examples: ["Create receipt notes for those uncategorized purchases."],
    },
    {
      id: "finance.reimbursement_submit",
      domain: "finance",
      displayName: "Submit Reimbursement",
      description: "Submit a reimbursement or expense repayment request in an external finance system and record submission state.",
      mode: "write",
      route: { kind: "worker", targetId: "personal-assistant" },
      examples: ["Submit the Walmart delivery-tip reimbursements to Ramp."],
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
      id: "planning.morning_review",
      domain: "planning",
      displayName: "Morning Review",
      description: "Run a morning planning review that gathers calendar, email, notes, and health context.",
      mode: "mixed",
      route: { kind: "worker", targetId: "personal-assistant" },
      examples: ["Run morning planning."],
    },
    {
      id: "planning.evening_review",
      domain: "planning",
      displayName: "Evening Review",
      description: "Run an end-of-day review that closes out today and prepares tomorrow.",
      mode: "mixed",
      route: { kind: "worker", targetId: "personal-assistant" },
      examples: ["Run evening review."],
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
      id: "email.subscription_review",
      domain: "email",
      displayName: "Subscription Review",
      description: "Review subscription or newsletter patterns and recommend cleanup.",
      mode: "mixed",
      route: { kind: "worker", targetId: "personal-assistant" },
      examples: ["Review new subscriptions and recommend unsubscribes."],
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
      id: "docs.google_doc_read_or_update",
      domain: "docs",
      displayName: "Read Or Update Google Doc",
      description: "Read, summarize, or update a Google Doc with a clear document target.",
      mode: "mixed",
      route: { kind: "worker", targetId: "personal-assistant" },
      slots: [{ name: "doc_query", required: true }],
      examples: ["Read the shared Google Doc and summarize it."],
    },
    {
      id: "slack.channel_review",
      domain: "slack",
      displayName: "Review Slack Channel",
      description: "Read and summarize a Slack channel or thread with a targeted catch-up objective.",
      mode: "read",
      route: { kind: "worker", targetId: "personal-assistant" },
      examples: ["Catch me up on Slack."],
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

function makeEnvelope(input: Partial<IntentEnvelope> & Pick<IntentEnvelope, "intentId" | "mode">): IntentEnvelope {
  return {
    id: input.id ?? `intent-${input.intentId}`,
    domain: input.domain ?? "wellness",
    intentId: input.intentId,
    mode: input.mode,
    confidence: input.confidence ?? 0.95,
    entities: input.entities ?? {},
    rawEntities: input.rawEntities ?? [],
    missingSlots: input.missingSlots ?? [],
    canRunInParallel: input.canRunInParallel ?? true,
    routeHint: input.routeHint,
  };
}

describe("deterministic router", () => {
  it("builds executable steps for the initial wellness intent surface", () => {
    const registry = createRegistry();
    const catalog = getDeterministicIntentCatalog({
      registry,
      agentId: "malibu",
      projectId: "wellness",
      domain: "wellness",
    });

    const cases = [
      {
        envelope: makeEnvelope({
          intentId: "nutrition.log_food",
          mode: "write",
          entities: { items: ["two eggs", "toast"], meal: "breakfast" },
        }),
        expected: {
          kind: "workflow",
          targetId: "wellness.log_food_items",
          workerId: "nutrition-logger",
        },
      },
      {
        envelope: makeEnvelope({
          intentId: "nutrition.log_recipe",
          mode: "write",
          entities: { recipe_query: "protein yogurt bowl", meal: "lunch" },
        }),
        expected: {
          kind: "workflow",
          targetId: "wellness.log_recipe_meal",
          workerId: "nutrition-logger",
        },
      },
      {
        envelope: makeEnvelope({
          intentId: "health.sleep_recovery",
          mode: "read",
          entities: { date_scope: "last_night" },
        }),
        expected: {
          kind: "workflow",
          targetId: "wellness.analyze_sleep_recovery",
          workerId: "health-analyst",
        },
      },
      {
        envelope: makeEnvelope({
          intentId: "nutrition.day_summary",
          mode: "read",
          entities: { date_scope: "today" },
        }),
        expected: {
          kind: "workflow",
          targetId: "wellness.analyze_nutrition_day",
          workerId: "nutrition-logger",
        },
      },
      {
        envelope: makeEnvelope({
          intentId: "health.trend_analysis",
          mode: "read",
          entities: { days: 28, focus: "tdee" },
        }),
        expected: {
          kind: "workflow",
          targetId: "wellness.analyze_health_trends",
          workerId: "health-analyst",
        },
      },
      {
        envelope: makeEnvelope({
          intentId: "health.metric_lookup_or_question",
          mode: "read",
          entities: { metric_focus: "resting heart rate", date_scope: "yesterday" },
        }),
        expected: {
          kind: "worker",
          targetId: "health-analyst",
          workerId: "health-analyst",
        },
      },
      {
        envelope: makeEnvelope({
          intentId: "nutrition.check_budget",
          mode: "read",
          entities: { date_scope: "today", planned_item: "yogurt tonight" },
        }),
        expected: {
          kind: "workflow",
          targetId: "wellness.check_nutrition_budget",
          workerId: "nutrition-logger",
        },
      },
      {
        envelope: makeEnvelope({
          intentId: "nutrition.log_repair",
          mode: "write",
          entities: { repair_scope: "lunch entry" },
        }),
        expected: {
          kind: "worker",
          targetId: "nutrition-logger",
          workerId: "nutrition-logger",
        },
      },
      {
        envelope: makeEnvelope({
          intentId: "nutrition.ingredient_catalog_update",
          mode: "write",
          entities: { ingredient_query: "pulled pork" },
        }),
        expected: {
          kind: "worker",
          targetId: "nutrition-logger",
          workerId: "nutrition-logger",
        },
      },
      {
        envelope: makeEnvelope({
          intentId: "workout.log",
          mode: "write",
          entities: { exercise: "bench", reps: 8, weight: 185 },
        }),
        expected: {
          kind: "worker",
          targetId: "workout-recorder",
          workerId: "workout-recorder",
        },
      },
      {
        envelope: makeEnvelope({
          intentId: "workout.history",
          mode: "read",
          entities: { exercise: "bench" },
        }),
        expected: {
          kind: "worker",
          targetId: "workout-recorder",
          workerId: "workout-recorder",
        },
      },
      {
        envelope: makeEnvelope({
          intentId: "recipe.read",
          mode: "read",
          entities: { recipe_query: "egg hash" },
        }),
        expected: {
          kind: "worker",
          targetId: "recipe-librarian",
          workerId: "recipe-librarian",
        },
      },
      {
        envelope: makeEnvelope({
          intentId: "recipe.update",
          mode: "write",
          entities: { recipe_query: "egg hash", change_request: "use 200g chicken" },
        }),
        expected: {
          kind: "worker",
          targetId: "recipe-librarian",
          workerId: "recipe-librarian",
        },
      },
    ] as const;

    for (const testCase of cases) {
      const result = buildDeterministicExecutionPlan({
        userMessage: "test",
        envelopes: [testCase.envelope],
        catalog,
        registry,
      });

      expect(result.outcome).toBe("executed");
      expect(result.plan?.steps).toHaveLength(1);
      expect(result.plan?.steps[0]).toMatchObject({
        intentId: testCase.envelope.intentId,
        mode: testCase.envelope.mode,
        kind: testCase.expected.kind,
        targetId: testCase.expected.targetId,
        workerId: testCase.expected.workerId,
        dependsOn: [],
      });
    }
  });

  it("asks for clarification when a required slot is missing", () => {
    const registry = createRegistry();
    const catalog = getDeterministicIntentCatalog({
      registry,
      agentId: "malibu",
      projectId: "wellness",
      domain: "wellness",
    });

    const result = buildDeterministicExecutionPlan({
      userMessage: "Log that recipe again",
      envelopes: [
        makeEnvelope({
          intentId: "nutrition.log_recipe",
          mode: "write",
          missingSlots: ["recipe_query"],
        }),
      ],
      catalog,
      registry,
    });

    expect(result).toEqual({
      outcome: "clarification",
      clarificationQuestion: "Which recipe or recurring meal do you want me to use?",
    });
  });

  it("falls back cleanly when no deterministic catalog entry exists", () => {
    const registry = createRegistry();
    const catalog = getDeterministicIntentCatalog({
      registry,
      agentId: "malibu",
      projectId: "wellness",
      domain: "wellness",
    });

    const result = buildDeterministicExecutionPlan({
      userMessage: "Do something unknown",
      envelopes: [
        makeEnvelope({
          intentId: "finance.reconcile",
          mode: "write",
        }),
      ],
      catalog,
      registry,
    });

    expect(result).toEqual({
      outcome: "fallback",
      reason: "No deterministic catalog entry for intent 'finance.reconcile'.",
    });
  });

  it("preserves multiple executable steps for mixed-intent turns", () => {
    const registry = createRegistry();
    const catalog = getDeterministicIntentCatalog({
      registry,
      agentId: "malibu",
      projectId: "wellness",
      domain: "wellness",
    });

    const result = buildDeterministicExecutionPlan({
      userMessage: "Log a protein bar and tell me how I slept",
      envelopes: [
        makeEnvelope({
          intentId: "nutrition.log_food",
          mode: "write",
          entities: { items: ["protein bar"], meal: "snack" },
        }),
        makeEnvelope({
          intentId: "health.sleep_recovery",
          mode: "read",
          entities: { date_scope: "last_night" },
        }),
      ],
      catalog,
      registry,
    });

    expect(result.outcome).toBe("executed");
    expect(result.plan?.steps).toHaveLength(2);
    expect(result.plan?.steps.map((step) => step.workerId)).toEqual([
      "nutrition-logger",
      "health-analyst",
    ]);
    expect(result.plan?.steps.map((step) => step.dependsOn)).toEqual([[], []]);
  });

  it("allows cross-worker Malibu analysis fan-out for health trends plus nutrition budget", () => {
    const registry = createRegistry();
    const catalog = getDeterministicIntentCatalog({
      registry,
      agentId: "malibu",
      projectId: "wellness",
      domain: "wellness",
    });

    const result = buildDeterministicExecutionPlan({
      userMessage: "Take a look at my TDEE over the last few weeks and tell me if I still have room for yogurt tonight.",
      envelopes: [
        makeEnvelope({
          intentId: "health.trend_analysis",
          mode: "read",
          entities: { days: 28, focus: "tdee" },
        }),
        makeEnvelope({
          intentId: "nutrition.check_budget",
          mode: "read",
          entities: { date_scope: "today", planned_item: "yogurt tonight", focus: "room_left" },
        }),
      ],
      catalog,
      registry,
    });

    expect(result.outcome).toBe("executed");
    expect(result.plan?.steps).toHaveLength(2);
    expect(result.plan?.steps.map((step) => step.workerId)).toEqual([
      "health-analyst",
      "nutrition-logger",
    ]);
    expect(result.plan?.steps.map((step) => step.dependsOn)).toEqual([[], []]);
    expect(result.plan?.steps[0]?.task).toContain("health.trend_analysis");
    expect(result.plan?.steps[1]?.task).toContain("nutrition.check_budget");
  });

  it("serializes same-worker nutrition summary and budget checks after a write", () => {
    const registry = createRegistry();
    const catalog = getDeterministicIntentCatalog({
      registry,
      agentId: "malibu",
      projectId: "wellness",
      domain: "wellness",
    });

    const result = buildDeterministicExecutionPlan({
      userMessage: "Log my protein yogurt bowl for lunch and tell me what I've eaten today and whether I still have room for yogurt tonight.",
      envelopes: [
        makeEnvelope({
          intentId: "nutrition.log_recipe",
          mode: "write",
          entities: { recipe_query: "protein yogurt bowl", meal: "lunch" },
        }),
        makeEnvelope({
          intentId: "nutrition.day_summary",
          mode: "read",
          entities: { date_scope: "today" },
        }),
        makeEnvelope({
          intentId: "nutrition.check_budget",
          mode: "read",
          entities: { date_scope: "today", planned_item: "yogurt tonight", focus: "room_left" },
        }),
      ],
      catalog,
      registry,
    });

    expect(result.outcome).toBe("executed");
    expect(result.plan?.steps).toHaveLength(3);
    expect(result.plan?.steps[0]).toMatchObject({
      intentId: "nutrition.log_recipe",
      workerId: "nutrition-logger",
      dependsOn: [],
    });
    expect(result.plan?.steps[1]).toMatchObject({
      intentId: "nutrition.day_summary",
      workerId: "nutrition-logger",
      dependsOn: ["step-1"],
    });
    expect(result.plan?.steps[2]).toMatchObject({
      intentId: "nutrition.check_budget",
      workerId: "nutrition-logger",
      dependsOn: ["step-1"],
    });
    expect(result.plan?.steps[2]?.task).toContain("READ-ONLY step");
  });

  it("serializes same-worker write/read mixed turns so the read observes the write", () => {
    const registry = createRegistry();
    const catalog = getDeterministicIntentCatalog({
      registry,
      agentId: "malibu",
      projectId: "wellness",
      domain: "wellness",
    });

    const result = buildDeterministicExecutionPlan({
      userMessage: "Log my protein yogurt bowl for lunch and tell me what I've eaten today.",
      envelopes: [
        makeEnvelope({
          intentId: "nutrition.log_recipe",
          mode: "write",
          entities: { recipe_query: "protein yogurt bowl", meal: "lunch" },
        }),
        makeEnvelope({
          intentId: "nutrition.day_summary",
          mode: "read",
          entities: { date_scope: "today" },
        }),
      ],
      catalog,
      registry,
    });

    expect(result.outcome).toBe("executed");
    expect(result.plan?.steps).toHaveLength(2);
    expect(result.plan?.steps[0]).toMatchObject({
      intentId: "nutrition.log_recipe",
      workerId: "nutrition-logger",
      dependsOn: [],
    });
    expect(result.plan?.steps[1]).toMatchObject({
      intentId: "nutrition.day_summary",
      workerId: "nutrition-logger",
      dependsOn: ["step-1"],
    });
    expect(result.plan?.steps[1]?.task).toContain("READ-ONLY step");
    expect(result.plan?.steps[1]?.task).toContain("Ignore other requests");
  });

  it("threads recent conversation context into deterministic worker tasks when available", () => {
    const registry = createRegistry();
    const catalog = getDeterministicIntentCatalog({
      registry,
      agentId: "malibu",
      projectId: "wellness",
      domain: "wellness",
    });

    const result = buildDeterministicExecutionPlan({
      userMessage: "Well, there was 60g for the taco, like I said.",
      conversationContext: [
        "inbound: We are logging tacos with pulled pork for dinner.",
        "outbound: How much pulled pork was in each taco?",
        "inbound: It was 60g per taco.",
      ].join("\n"),
      envelopes: [
        makeEnvelope({
          intentId: "nutrition.log_food",
          mode: "write",
          entities: { items: ["pulled pork tacos"], meal: "dinner" },
        }),
      ],
      catalog,
      registry,
    });

    expect(result.outcome).toBe("executed");
    expect(result.plan?.steps[0]?.task).toContain("Recent conversation:");
    expect(result.plan?.steps[0]?.task).toContain("How much pulled pork was in each taco?");
    expect(result.plan?.steps[0]?.task).toContain("It was 60g per taco.");
  });

  it("preserves worker autonomy inside both workflow-scoped and worker-scoped tasks", () => {
    const registry = createRegistry();
    const catalog = getDeterministicIntentCatalog({
      registry,
      agentId: "malibu",
      projectId: "wellness",
      domain: "wellness",
    });

    const result = buildDeterministicExecutionPlan({
      userMessage: "How did I sleep last night and what was my last workout?",
      envelopes: [
        makeEnvelope({
          intentId: "health.sleep_recovery",
          mode: "read",
          entities: { date_scope: "last_night" },
        }),
        makeEnvelope({
          intentId: "workout.history",
          mode: "read",
          entities: { date_scope: "recent" },
        }),
      ],
      catalog,
      registry,
    });

    expect(result.outcome).toBe("executed");
    expect(result.plan?.steps).toHaveLength(2);
    expect(result.plan?.steps[0]?.kind).toBe("workflow");
    expect(result.plan?.steps[0]?.task).toContain(
      "Workflow metadata scopes the objective, but it does not prescribe fixed queries or a hardcoded tool sequence.",
    );
    expect(result.plan?.steps[0]?.task).toContain(
      "The owning worker must decide which tools, lookups, windows, comparisons, and reasoning steps are appropriate",
    );
    expect(result.plan?.steps[1]?.kind).toBe("worker");
    expect(result.plan?.steps[1]?.task).toContain(
      "You own the reasoning inside this domain. Choose the exact tools, queries, windows, comparisons, and analysis needed",
    );
  });

  it("builds Sierra research plans and allows parallel read fan-out on the same worker", () => {
    const registry = createRegistry();
    const catalog = getDeterministicIntentCatalog({
      registry,
      agentId: "sierra",
      domain: "research",
    });

    expect(catalog.map((entry) => entry.id)).toEqual([
      "research.note_read",
      "research.product_selection",
      "research.video_read",
      "research.web_lookup",
    ]);

    const result = buildDeterministicExecutionPlan({
      userMessage: "Read the Large Desk OpenGrid and Underware Project note and look up the official Prusa MK4S product page.",
      envelopes: [
        makeEnvelope({
          intentId: "research.note_read",
          mode: "read",
          domain: "research",
          entities: { note_query: "Large Desk OpenGrid and Underware Project" },
        }),
        makeEnvelope({
          intentId: "research.web_lookup",
          mode: "read",
          domain: "research",
          entities: { query: "official Prusa MK4S product page" },
        }),
      ],
      catalog,
      registry,
    });

    expect(result.outcome).toBe("executed");
    expect(result.plan?.steps).toHaveLength(2);
    expect(result.plan?.steps.map((step) => step.workerId)).toEqual([
      "research-assistant",
      "research-assistant",
    ]);
    expect(result.plan?.steps.map((step) => step.dependsOn)).toEqual([[], []]);
  });

  it("builds Sierra file, printer, location, diesel, and Walmart queue plans through the research-assistant worker", () => {
    const registry = createRegistry();

    const filesCatalog = getDeterministicIntentCatalog({
      registry,
      agentId: "sierra",
      domain: "files",
    });
    expect(filesCatalog.map((entry) => entry.id)).toEqual([
      "files.local_read",
      "files.local_write",
    ]);

    const printingCatalog = getDeterministicIntentCatalog({
      registry,
      agentId: "sierra",
      domain: "printing",
    });
    expect(printingCatalog.map((entry) => entry.id)).toEqual([
      "printing.job_prepare_or_start",
      "printing.printer_status",
    ]);

    const travelCatalog = getDeterministicIntentCatalog({
      registry,
      agentId: "sierra",
      domain: "travel",
    });
    expect(travelCatalog.map((entry) => entry.id)).toEqual([
      "travel.diesel_lookup",
      "travel.location_read",
      "travel.route_plan",
      "travel.weather_read",
    ]);

    const shoppingCatalog = getDeterministicIntentCatalog({
      registry,
      agentId: "sierra",
      domain: "shopping",
    });
    expect(shoppingCatalog.map((entry) => entry.id)).toEqual([
      "shopping.browser_order_action",
      "shopping.browser_order_lookup",
      "shopping.walmart_queue_review",
    ]);

    const notesCatalog = getDeterministicIntentCatalog({
      registry,
      agentId: "sierra",
      domain: "notes",
    });
    expect(notesCatalog.map((entry) => entry.id)).toEqual(["notes.note_update"]);

    const accountsCatalog = getDeterministicIntentCatalog({
      registry,
      agentId: "sierra",
      domain: "accounts",
    });
    expect(accountsCatalog.map((entry) => entry.id)).toEqual(["accounts.identity_read"]);

    const mixedCatalog = getDeterministicIntentCatalog({
      registry,
      agentId: "sierra",
    });

    const result = buildDeterministicExecutionPlan({
      userMessage: "Where am I right now and what's the current printer status?",
      envelopes: [
        makeEnvelope({
          intentId: "travel.location_read",
          mode: "read",
          domain: "travel",
          entities: { focus: "current_location" },
        }),
        makeEnvelope({
          intentId: "printing.printer_status",
          mode: "read",
          domain: "printing",
          entities: { focus: "status" },
        }),
      ],
      catalog: mixedCatalog,
      registry,
    });

    expect(result.outcome).toBe("executed");
    expect(result.plan?.steps).toHaveLength(2);
    expect(result.plan?.steps.map((step) => step.workerId)).toEqual([
      "research-assistant",
      "research-assistant",
    ]);
    expect(result.plan?.steps.map((step) => step.dependsOn)).toEqual([[], []]);
    expect(result.plan?.steps[0]?.task).toContain("travel.location_read");
    expect(result.plan?.steps[1]?.task).toContain("printing.printer_status");
  });

  it("builds Sierra 1Password identity reads through the research-assistant worker", () => {
    const registry = createRegistry();
    const mixedCatalog = getDeterministicIntentCatalog({
      registry,
      agentId: "sierra",
    });

    const result = buildDeterministicExecutionPlan({
      userMessage: "Use the worker to run 1Password whoami and summarize only the account URL.",
      envelopes: [
        makeEnvelope({
          intentId: "accounts.identity_read",
          mode: "read",
          domain: "accounts",
          entities: { focus: "account_url" },
          rawEntities: ["1Password", "whoami", "account URL"],
        }),
      ],
      catalog: mixedCatalog,
      registry,
    });

    expect(result.outcome).toBe("executed");
    expect(result.plan?.steps).toHaveLength(1);
    expect(result.plan?.steps[0]).toMatchObject({
      kind: "worker",
      targetId: "research-assistant",
      workerId: "research-assistant",
      mode: "read",
    });
    expect(result.plan?.steps[0]?.task).toContain("accounts.identity_read");
    expect(result.plan?.steps[0]?.task).toContain("1Password whoami");
  });

  it("builds Sierra local file review and printer-start plans through the research-assistant worker", () => {
    const registry = createRegistry();
    const mixedCatalog = getDeterministicIntentCatalog({
      registry,
      agentId: "sierra",
    });

    const result = buildDeterministicExecutionPlan({
      userMessage:
        "Use the worker to list the most recent files in ~/Downloads and summarize what kinds of files are there. Then get a 7x7 grid print ready with no brim.",
      envelopes: [
        makeEnvelope({
          intentId: "files.local_read",
          mode: "read",
          domain: "files",
          entities: { path_query: "~/Downloads", focus: "recent files" },
        }),
        makeEnvelope({
          intentId: "printing.job_prepare_or_start",
          mode: "write",
          domain: "printing",
          entities: { print_request: "7x7 grid", print_constraints: ["no brim"] },
          canRunInParallel: false,
        }),
      ],
      catalog: mixedCatalog,
      registry,
    });

    expect(result.outcome).toBe("executed");
    expect(result.plan?.steps).toHaveLength(2);
    expect(result.plan?.steps.map((step) => step.workerId)).toEqual([
      "research-assistant",
      "research-assistant",
    ]);
    expect(result.plan?.steps[0]?.dependsOn).toEqual([]);
    expect(result.plan?.steps[1]?.dependsOn).toEqual(["step-1"]);
    expect(result.plan?.steps[0]?.task).toContain("files.local_read");
    expect(result.plan?.steps[1]?.task).toContain("printing.job_prepare_or_start");
  });

  it("marks preview-only Sierra printer prep tasks as no-side-effect runs", () => {
    const registry = createRegistry();
    const mixedCatalog = getDeterministicIntentCatalog({
      registry,
      agentId: "sierra",
    });

    const result = buildDeterministicExecutionPlan({
      userMessage: "Get the 7x7 OpenGrid print ready for the MK4, but preview only. Do not upload or start it.",
      envelopes: [
        makeEnvelope({
          intentId: "printing.job_prepare_or_start",
          mode: "write",
          domain: "printing",
          entities: {
            print_request: "7x7 OpenGrid",
            print_constraints: ["preview only", "do not upload", "do not start"],
            printer_target: "MK4",
          },
          canRunInParallel: false,
        }),
      ],
      catalog: mixedCatalog,
      registry,
    });

    expect(result.outcome).toBe("executed");
    expect(result.plan?.steps).toHaveLength(1);
    expect(result.plan?.steps[0]?.task).toContain("PREVIEW-ONLY step");
    expect(result.plan?.steps[0]?.task).toContain("dry_run: true");
    expect(result.plan?.steps[0]?.task).toContain("do not upload, start, or stop printer jobs");
    expect(result.plan?.steps[0]?.safeNoopAllowed).toBe(true);
  });

  it("builds Sierra diesel and Walmart queue plans through the research-assistant worker", () => {
    const registry = createRegistry();
    const mixedCatalog = getDeterministicIntentCatalog({
      registry,
      agentId: "sierra",
    });

    const result = buildDeterministicExecutionPlan({
      userMessage: "Find the best diesel stops on the route to Tonopah, Nevada and show the Walmart queue.",
      envelopes: [
        makeEnvelope({
          intentId: "travel.diesel_lookup",
          mode: "read",
          domain: "travel",
          entities: { destination: "Tonopah, Nevada", top: 3 },
        }),
        makeEnvelope({
          intentId: "shopping.walmart_queue_review",
          mode: "read",
          domain: "shopping",
          entities: { focus: "queue" },
        }),
      ],
      catalog: mixedCatalog,
      registry,
    });

    expect(result.outcome).toBe("executed");
    expect(result.plan?.steps).toHaveLength(2);
    expect(result.plan?.steps.map((step) => step.workerId)).toEqual([
      "research-assistant",
      "research-assistant",
    ]);
    expect(result.plan?.steps.map((step) => step.dependsOn)).toEqual([[], []]);
    expect(result.plan?.steps[0]?.task).toContain("travel.diesel_lookup");
    expect(result.plan?.steps[1]?.task).toContain("shopping.walmart_queue_review");
  });

  it("narrows Sierra browser shopping actions to shopping-specific tools", () => {
    const registry = createRegistry();
    const catalog = getDeterministicIntentCatalog({
      registry,
      agentId: "sierra",
      domain: "shopping",
    });

    const result = buildDeterministicExecutionPlan({
      userMessage: "Add 6 of my usual light greek vanilla yogurt to my Walmart cart.",
      envelopes: [
        makeEnvelope({
          intentId: "shopping.browser_order_action",
          mode: "write",
          domain: "shopping",
          entities: {
            retailer: "Walmart",
            action_request: "Add 6 of my usual light greek vanilla yogurt to my Walmart cart.",
          },
        }),
      ],
      catalog,
      registry,
    });

    expect(result.outcome).toBe("executed");
    expect(result.plan?.steps).toHaveLength(1);
    expect(result.plan?.steps[0]?.allowedToolIds).toEqual(["walmart", "browser", "onepassword"]);
    expect(result.plan?.steps[0]?.reasoningEffort).toBe("medium");
    expect(result.plan?.steps[0]?.task).toContain("Tool surface for this intent is intentionally narrowed to: walmart, browser, onepassword.");
  });

  it("builds Watson finance read plans through the personal-assistant worker", () => {
    const registry = createRegistry();
    const catalog = getDeterministicIntentCatalog({
      registry,
      agentId: "watson",
      domain: "finance",
    });

    expect(catalog.map((entry) => entry.id)).toEqual([
      "finance.budget_review",
      "finance.receipt_catalog",
      "finance.receipt_lookup",
      "finance.reimbursement_submit",
      "finance.transaction_categorization",
      "finance.transaction_lookup",
      "finance.unreviewed_transactions",
    ]);

    const result = buildDeterministicExecutionPlan({
      userMessage: "Can you summarize our unconfirmed transactions for me please so we can go through them?",
      envelopes: [
        makeEnvelope({
          intentId: "finance.unreviewed_transactions",
          mode: "read",
          domain: "finance",
          entities: { date_scope: "recent", focus: "review" },
        }),
      ],
      catalog,
      registry,
    });

    expect(result.outcome).toBe("executed");
    expect(result.plan?.steps[0]).toMatchObject({
      workerId: "personal-assistant",
      kind: "worker",
      dependsOn: [],
      mode: "read",
    });
    expect(result.plan?.steps[0]?.task).toContain("READ-ONLY step");
  });

  it("builds Watson health, calendar, email, and note read plans through the personal-assistant worker", () => {
    const registry = createRegistry();

    const healthCatalog = getDeterministicIntentCatalog({
      registry,
      agentId: "watson",
      domain: "health",
    });
    expect(healthCatalog.map((entry) => entry.id)).toEqual(["health.morning_brief"]);

    const calendarCatalog = getDeterministicIntentCatalog({
      registry,
      agentId: "watson",
      domain: "planning",
    });
    expect(calendarCatalog.map((entry) => entry.id)).toEqual([
      "planning.calendar_review",
      "planning.evening_review",
      "planning.morning_review",
    ]);

    const emailCatalog = getDeterministicIntentCatalog({
      registry,
      agentId: "watson",
      domain: "email",
    });
    expect(emailCatalog.map((entry) => entry.id)).toEqual([
      "email.inbox_review",
      "email.subscription_review",
    ]);

    const notesCatalog = getDeterministicIntentCatalog({
      registry,
      agentId: "watson",
      domain: "notes",
    });
    expect(notesCatalog.map((entry) => entry.id)).toEqual(["notes.note_read"]);

    const mixedCatalog = getDeterministicIntentCatalog({
      registry,
      agentId: "watson",
    });

    const result = buildDeterministicExecutionPlan({
      userMessage: "What's on my calendar today and what unread emails need attention?",
      envelopes: [
        makeEnvelope({
          intentId: "planning.calendar_review",
          mode: "read",
          domain: "planning",
          entities: { date_scope: "today" },
        }),
        makeEnvelope({
          intentId: "email.inbox_review",
          mode: "read",
          domain: "email",
          entities: { date_scope: "today", focus: "actionable" },
        }),
      ],
      catalog: mixedCatalog,
      registry,
    });

    expect(result.outcome).toBe("executed");
    expect(result.plan?.steps).toHaveLength(2);
    expect(result.plan?.steps.map((step) => step.workerId)).toEqual([
      "personal-assistant",
      "personal-assistant",
    ]);
    expect(result.plan?.steps.map((step) => step.dependsOn)).toEqual([[], []]);
    expect(result.plan?.steps[0]?.task).toContain("planning.calendar_review");
    expect(result.plan?.steps[1]?.task).toContain("email.inbox_review");
  });

  it("builds Watson health and budget review plans through the personal-assistant worker", () => {
    const registry = createRegistry();
    const mixedCatalog = getDeterministicIntentCatalog({
      registry,
      agentId: "watson",
    });

    const result = buildDeterministicExecutionPlan({
      userMessage: "Give me my morning health briefing and tell me how I'm doing against budget this month.",
      envelopes: [
        makeEnvelope({
          intentId: "health.morning_brief",
          mode: "read",
          domain: "health",
          entities: { mode: "morning" },
        }),
        makeEnvelope({
          intentId: "finance.budget_review",
          mode: "read",
          domain: "finance",
          entities: { date_scope: "this_month", focus: "budget" },
        }),
      ],
      catalog: mixedCatalog,
      registry,
    });

    expect(result.outcome).toBe("executed");
    expect(result.plan?.steps).toHaveLength(2);
    expect(result.plan?.steps.map((step) => step.workerId)).toEqual([
      "personal-assistant",
      "personal-assistant",
    ]);
    expect(result.plan?.steps.map((step) => step.dependsOn)).toEqual([[], []]);
    expect(result.plan?.steps[0]?.task).toContain("health.morning_brief");
    expect(result.plan?.steps[1]?.task).toContain("finance.budget_review");
  });

  it("builds Watson categorization, receipt, planning, docs, and slack plans through the personal-assistant worker", () => {
    const registry = createRegistry();

    const financeCatalog = getDeterministicIntentCatalog({
      registry,
      agentId: "watson",
      domain: "finance",
    });
    expect(financeCatalog.map((entry) => entry.id)).toEqual([
      "finance.budget_review",
      "finance.receipt_catalog",
      "finance.receipt_lookup",
      "finance.reimbursement_submit",
      "finance.transaction_categorization",
      "finance.transaction_lookup",
      "finance.unreviewed_transactions",
    ]);

    const planningCatalog = getDeterministicIntentCatalog({
      registry,
      agentId: "watson",
      domain: "planning",
    });
    expect(planningCatalog.map((entry) => entry.id)).toEqual([
      "planning.calendar_review",
      "planning.evening_review",
      "planning.morning_review",
    ]);

    const docsCatalog = getDeterministicIntentCatalog({
      registry,
      agentId: "watson",
      domain: "docs",
    });
    expect(docsCatalog.map((entry) => entry.id)).toEqual(["docs.google_doc_read_or_update"]);

    const slackCatalog = getDeterministicIntentCatalog({
      registry,
      agentId: "watson",
      domain: "slack",
    });
    expect(slackCatalog.map((entry) => entry.id)).toEqual(["slack.channel_review"]);

    const mixedCatalog = getDeterministicIntentCatalog({
      registry,
      agentId: "watson",
    });

    const result = buildDeterministicExecutionPlan({
      userMessage: "Go through these uncategorized transactions and then create receipt notes for them.",
      envelopes: [
        makeEnvelope({
          intentId: "finance.transaction_categorization",
          mode: "write",
          domain: "finance",
          entities: { transaction_scope: "uncategorized" },
        }),
        makeEnvelope({
          intentId: "finance.receipt_catalog",
          mode: "write",
          domain: "finance",
          entities: { receipt_scope: "uncategorized purchases" },
        }),
      ],
      catalog: mixedCatalog,
      registry,
    });

    expect(result.outcome).toBe("executed");
    expect(result.plan?.steps).toHaveLength(2);
    expect(result.plan?.steps[0]).toMatchObject({
      intentId: "finance.transaction_categorization",
      workerId: "personal-assistant",
      dependsOn: [],
      allowedToolIds: ["lunch_money", "obsidian", "browser", "onepassword", "gog_email"],
    });
    expect(result.plan?.steps[1]).toMatchObject({
      intentId: "finance.receipt_catalog",
      workerId: "personal-assistant",
      dependsOn: ["step-1"],
      allowedToolIds: [
        "lunch_money",
        "browser",
        "onepassword",
        "gog_email",
        "obsidian",
        "receipt_registry",
      ],
    });
    expect(result.plan?.steps[0]?.task).toContain("WRITE step");
    expect(result.plan?.steps[1]?.task).toContain("WRITE step");
    expect(result.plan?.steps[0]?.task).toContain(
      "Tool surface for this intent is intentionally narrowed to: lunch_money, obsidian, browser, onepassword, gog_email.",
    );
    expect(result.plan?.steps[1]?.task).toContain(
      "Tool surface for this intent is intentionally narrowed to: lunch_money, browser, onepassword, gog_email, obsidian, receipt_registry.",
    );

    const docsResult = buildDeterministicExecutionPlan({
      userMessage:
        "Draft an announcement in doc A and rewrite the technical reference in doc B using the same brand guide.",
      envelopes: [
        makeEnvelope({
          intentId: "docs.google_doc_read_or_update",
          mode: "mixed",
          domain: "docs",
          entities: {
            doc_query: "Doc A",
            change_request: "Draft the announcement",
            reference_docs: ["Brand Guide", "Pricing Doc"],
          },
        }),
        makeEnvelope({
          intentId: "docs.google_doc_read_or_update",
          mode: "mixed",
          domain: "docs",
          entities: {
            doc_query: "Doc B",
            change_request: "Rewrite the technical reference",
            reference_docs: ["Brand Guide"],
          },
        }),
      ],
      catalog: mixedCatalog,
      registry,
    });

    expect(docsResult.outcome).toBe("executed");
    expect(docsResult.plan?.steps).toHaveLength(2);
    expect(docsResult.plan?.steps[0]?.task).toContain("Original user message (background only)");
    expect(docsResult.plan?.steps[0]?.task).toContain(
      "This turn produced 2 separate steps for the same intent contract.",
    );
    expect(docsResult.plan?.steps[0]?.task).toContain(
      "Treat the extracted entities for this step as the only in-scope target.",
    );
    expect(docsResult.plan?.steps[1]?.task).toContain(
      "Do not act on other documents, URLs, or change requests mentioned in the original user message unless they also appear in the extracted entities for this step.",
    );
  });

  it("builds Sierra route, weather, video, note-write, file-write, and browser-order plans through the research-assistant worker", () => {
    const registry = createRegistry();

    const researchCatalog = getDeterministicIntentCatalog({
      registry,
      agentId: "sierra",
      domain: "research",
    });
    expect(researchCatalog.map((entry) => entry.id)).toEqual([
      "research.note_read",
      "research.product_selection",
      "research.video_read",
      "research.web_lookup",
    ]);

    const mixedCatalog = getDeterministicIntentCatalog({
      registry,
      agentId: "sierra",
    });

    const productSelectionPlan = buildDeterministicExecutionPlan({
      userMessage: "Help me choose the right Keychron keyboard model for me. I want full size, Bluetooth, backlight, and Mac support.",
      envelopes: [
        makeEnvelope({
          intentId: "research.product_selection",
          mode: "read",
          domain: "research",
          entities: {
            product_family: "Keychron full-size wireless mechanical keyboard lineup",
            constraints: ["full size", "Bluetooth", "backlight", "Mac support"],
          },
        }),
      ],
      catalog: mixedCatalog,
      registry,
    });

    expect(productSelectionPlan.outcome).toBe("executed");
    expect(productSelectionPlan.plan?.steps).toHaveLength(1);
    expect(productSelectionPlan.plan?.steps[0]).toMatchObject({
      workerId: "research-assistant",
      intentId: "research.product_selection",
      reasoningEffort: "low",
    });
    expect(productSelectionPlan.plan?.steps[0]?.task).toContain("product-selection step, not an exhaustive deep-research brief");

    const deepResearchCatalog = [
      ...mixedCatalog,
      {
        id: "research.deep_research",
        domain: "research",
        description: "Investigate a topic through multiple search angles or source categories, then synthesize the findings.",
        mode: "read",
        route: { kind: "worker" as const, targetId: "research-coordinator" },
      },
    ];

    const deepResearchPlan = buildDeterministicExecutionPlan({
      userMessage: "Do a deep dive on PLA food safety for kitchen use.",
      envelopes: [
        makeEnvelope({
          intentId: "research.deep_research",
          mode: "read",
          domain: "research",
          entities: {
            topic: "PLA food safety for kitchen use",
          },
        }),
      ],
      catalog: deepResearchCatalog,
      registry,
    });

    expect(deepResearchPlan.outcome).toBe("executed");
    expect(deepResearchPlan.plan?.steps[0]?.task).toContain("Keep the first spawn_sub_agents batch modest so it fits inside the tool-call budget.");
    expect(deepResearchPlan.plan?.steps[0]?.task).toContain("When max_rounds is 1, stop and report the gap instead of attempting a second spawn_sub_agents call.");

    const result = buildDeterministicExecutionPlan({
      userMessage: "Plan the drive from Las Vegas to Tonopah, check the weather there, then summarize this YouTube video.",
      envelopes: [
        makeEnvelope({
          intentId: "travel.route_plan",
          mode: "read",
          domain: "travel",
          entities: { origin: "Las Vegas", destination: "Tonopah, Nevada" },
        }),
        makeEnvelope({
          intentId: "travel.weather_read",
          mode: "read",
          domain: "travel",
          entities: { location_query: "Tonopah, Nevada" },
        }),
        makeEnvelope({
          intentId: "research.video_read",
          mode: "read",
          domain: "research",
          entities: { video_query: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
        }),
      ],
      catalog: mixedCatalog,
      registry,
    });

    expect(result.outcome).toBe("executed");
    expect(result.plan?.steps).toHaveLength(3);
    expect(result.plan?.steps.map((step) => step.workerId)).toEqual([
      "research-assistant",
      "research-assistant",
      "research-assistant",
    ]);
    expect(result.plan?.steps.map((step) => step.dependsOn)).toEqual([[], [], []]);
    expect(result.plan?.steps[0]?.task).toContain("travel.route_plan");
    expect(result.plan?.steps[1]?.task).toContain("travel.weather_read");
    expect(result.plan?.steps[2]?.task).toContain("research.video_read");
    expect(result.plan?.steps[0]?.excludedToolIds).toEqual(["browser"]);
    expect(result.plan?.steps[1]?.excludedToolIds).toEqual(["browser"]);
    expect(result.plan?.steps[2]?.excludedToolIds).toEqual(["browser"]);
  });

  it("keeps browser only on explicit order and receipt intents", () => {
    const registry = createRegistry();
    const catalog = getDeterministicIntentCatalog({
      registry,
      agentId: "sierra",
    });
    const watsonCatalog = getDeterministicIntentCatalog({
      registry,
      agentId: "watson",
    });

    const sierraResult = buildDeterministicExecutionPlan({
      userMessage: "Check the Walmart order status.",
      envelopes: [
        makeEnvelope({
          intentId: "shopping.browser_order_lookup",
          mode: "read",
          domain: "shopping",
          entities: { merchant_scope: "Walmart" },
        }),
      ],
      catalog,
      registry,
    });
    const watsonResult = buildDeterministicExecutionPlan({
      userMessage: "Look up that Amazon receipt.",
      envelopes: [
        makeEnvelope({
          intentId: "finance.receipt_lookup",
          mode: "read",
          domain: "finance",
          entities: { merchant_scope: "Amazon" },
        }),
      ],
      catalog: watsonCatalog,
      registry,
    });
    const watsonReimbursementResult = buildDeterministicExecutionPlan({
      userMessage: "Submit the Walmart delivery-tip reimbursements to Ramp.",
      envelopes: [
        makeEnvelope({
          intentId: "finance.reimbursement_submit",
          mode: "write",
          domain: "finance",
          entities: { merchant_scope: "Walmart", reimbursement_system: "Ramp" },
        }),
      ],
      catalog: watsonCatalog,
      registry,
    });

    expect(sierraResult.outcome).toBe("executed");
    expect(sierraResult.plan?.steps[0]?.excludedToolIds).toBeUndefined();
    expect(watsonResult.outcome).toBe("executed");
    expect(watsonResult.plan?.steps[0]?.excludedToolIds).toBeUndefined();
    expect(watsonReimbursementResult.outcome).toBe("executed");
    expect(watsonReimbursementResult.plan?.steps[0]?.excludedToolIds).toBeUndefined();
    expect(watsonReimbursementResult.plan?.steps[0]?.allowedToolIds).toEqual([
      "receipt_registry",
      "ramp_reimbursement",
      "gog_email",
      "onepassword",
      "obsidian",
    ]);
    expect(watsonReimbursementResult.plan?.steps[0]?.task).toContain(
      "use ramp_reimbursement as the primary execution path",
    );
    expect(watsonReimbursementResult.plan?.steps[0]?.task).toContain(
      "Use the raw browser tool only for login, page-state inspection, or debugging",
    );
    expect(watsonReimbursementResult.plan?.steps[0]?.task).toContain(
      "If this reimbursement's invoice or receipt lives in Gmail, use gog_email",
    );

    const watsonReceiptCatalogResult = buildDeterministicExecutionPlan({
      userMessage: "Catalog the latest Amazon and Walmart receipts.",
      envelopes: [
        makeEnvelope({
          intentId: "finance.receipt_catalog",
          mode: "write",
          domain: "finance",
          entities: { merchant_scope: ["Amazon", "Walmart"] },
        }),
      ],
      catalog: watsonCatalog,
      registry,
    });

    expect(watsonReceiptCatalogResult.outcome).toBe("executed");
    expect(watsonReceiptCatalogResult.plan?.steps[0]?.excludedToolIds).toBeUndefined();
    expect(watsonReceiptCatalogResult.plan?.steps[0]?.allowedToolIds).toEqual([
      "lunch_money",
      "browser",
      "onepassword",
      "gog_email",
      "obsidian",
      "receipt_registry",
    ]);
  });

  it("narrows docs and nutrition logging intents to the high-level executors", () => {
    const registry = createRegistry();
    const malibuCatalog = getDeterministicIntentCatalog({
      registry,
      agentId: "malibu",
      projectId: "wellness",
      domain: "wellness",
    });
    const watsonCatalog = getDeterministicIntentCatalog({
      registry,
      agentId: "watson",
    });

    const nutritionResult = buildDeterministicExecutionPlan({
      userMessage: "Log 100g light vanilla greek yogurt and 12g pb powder as a snack.",
      envelopes: [
        makeEnvelope({
          intentId: "nutrition.log_food",
          mode: "write",
          entities: { items: ["light vanilla greek yogurt", "pb powder"], meal: "other" },
        }),
      ],
      catalog: malibuCatalog,
      registry,
    });

    const recipeResult = buildDeterministicExecutionPlan({
      userMessage: "Log Taco Tuesday for dinner with corn tortillas.",
      envelopes: [
        makeEnvelope({
          intentId: "nutrition.log_recipe",
          mode: "write",
          entities: { recipe_query: "Taco Tuesday", meal: "dinner" },
        }),
      ],
      catalog: malibuCatalog,
      registry,
    });

    const docsResult = buildDeterministicExecutionPlan({
      userMessage: "Update the draft tab in that Google Doc with the new headline and hero copy.",
      envelopes: [
        makeEnvelope({
          intentId: "docs.google_doc_read_or_update",
          mode: "mixed",
          domain: "docs",
          entities: {
            doc_query: "https://docs.google.com/document/d/1abcDocId/edit?tab=t.target",
            change_request: "Replace the headline and hero copy in the target tab.",
          },
        }),
      ],
      catalog: watsonCatalog,
      registry,
    });

    expect(nutritionResult.plan?.steps[0]?.allowedToolIds).toEqual([
      "recipe_read",
      "nutrition_log_items",
      "fatsecret_api",
    ]);
    expect(nutritionResult.plan?.steps[0]?.task).toContain(
      "start with nutrition_log_items",
    );
    expect(nutritionResult.plan?.steps[0]?.reasoningEffort).toBe("low");
    expect(recipeResult.plan?.steps[0]?.allowedToolIds).toEqual([
      "recipe_read",
      "nutrition_log_items",
      "fatsecret_api",
    ]);
    expect(recipeResult.plan?.steps[0]?.task).toContain(
      "use recipe_read first, expand the ingredient list, and then pass the concrete ingredient items to nutrition_log_items in one batch",
    );
    expect(recipeResult.plan?.steps[0]?.reasoningEffort).toBe("low");
    expect(docsResult.plan?.steps[0]?.allowedToolIds).toEqual([
      "gog_docs_update_tab",
      "gog_docs",
    ]);
    expect(docsResult.plan?.steps[0]?.task).toContain(
      "prefer gog_docs_update_tab",
    );
    expect(docsResult.plan?.steps[0]?.reasoningEffort).toBe("low");
  });

  it("normalizes reimbursement email-account aliases before worker execution", () => {
    const registry = createRegistry();
    const catalog = getDeterministicIntentCatalog({
      registry,
      agentId: "watson",
    });

    const result = buildDeterministicExecutionPlan({
      userMessage: "Submit that MAID reimbursement in Ramp.",
      envelopes: [
        makeEnvelope({
          intentId: "finance.reimbursement_submit",
          mode: "write",
          domain: "finance",
          entities: {
            reimbursement_system: "Ramp",
            receipt_source: "email",
            email_account: "matu.northrup",
          },
        }),
      ],
      catalog,
      registry,
    });

    expect(result.outcome).toBe("executed");
    expect(result.plan?.steps[0]?.input).toMatchObject({
      reimbursement_system: "Ramp",
      receipt_source: "email",
      email_account: "matu.dnorthrup@gmail.com",
    });
    expect(result.plan?.steps[0]?.task).toContain("matu.dnorthrup@gmail.com");
    expect(result.plan?.steps[0]?.task).toContain("capture_email_reimbursement_evidence");
  });

  it("builds Victor repo-status and codebase-read plans through the dev-assistant worker", () => {
    const registry = createRegistry();

    const engineeringCatalog = getDeterministicIntentCatalog({
      registry,
      agentId: "victor",
      domain: "engineering",
    });

    expect(engineeringCatalog.map((entry) => entry.id)).toEqual([
      "engineering.codebase_read",
      "engineering.repo_status",
    ]);

    const result = buildDeterministicExecutionPlan({
      userMessage: "What's the current git status and summarize what config/agents/victor.yaml says about deterministic routing?",
      envelopes: [
        makeEnvelope({
          intentId: "engineering.repo_status",
          mode: "read",
          domain: "engineering",
          entities: { focus: "git_status" },
        }),
        makeEnvelope({
          intentId: "engineering.codebase_read",
          mode: "read",
          domain: "engineering",
          entities: {
            target_query: "config/agents/victor.yaml",
            focus: "deterministic routing",
          },
        }),
      ],
      catalog: engineeringCatalog,
      registry,
    });

    expect(result.outcome).toBe("executed");
    expect(result.plan?.steps).toHaveLength(2);
    expect(result.plan?.steps.map((step) => step.workerId)).toEqual([
      "dev-assistant",
      "dev-assistant",
    ]);
    expect(result.plan?.steps.map((step) => step.dependsOn)).toEqual([[], []]);
    expect(result.plan?.steps[0]?.task).toContain("engineering.repo_status");
    expect(result.plan?.steps[1]?.task).toContain("engineering.codebase_read");
    expect(result.plan?.steps[0]?.task).toContain("READ-ONLY step");
    expect(result.plan?.steps[1]?.task).toContain("READ-ONLY step");
  });

  it("injects the decision-quality contract into worker tasks", () => {
    const registry = createRegistry();
    const catalog: IntentContractConfig[] = [{
      id: "research.deep_research",
      domain: "research",
      description: "Investigate a topic through multiple angles before synthesizing the result.",
      mode: "read",
      route: { kind: "worker", targetId: "research-assistant" },
      evaluation: {
        taskClass: "decision_support",
        successCriteria: ["Tie the recommendation to the user's constraints."],
        mustAnswer: ["What is the strongest option?"],
        comparisonAxes: ["price", "availability"],
        requiredFields: ["source_urls", "tradeoffs"],
        qualityGateRequired: true,
      },
    }];

    const result = buildDeterministicExecutionPlan({
      userMessage: "Find the best compact desk for floor sitting under $500.",
      envelopes: [
        makeEnvelope({
          intentId: "research.deep_research",
          mode: "read",
          domain: "research",
          entities: {
            topic: "compact floor desk",
            constraints: ["under $500", "small footprint"],
            must_answer: ["What is the strongest option?"],
            success_criteria: ["Tie the recommendation to the user's constraints."],
          },
        }),
      ],
      catalog,
      registry,
    });

    expect(result.outcome).toBe("executed");
    expect(result.plan?.steps[0]?.task).toContain("Decision-quality contract:");
    expect(result.plan?.steps[0]?.task).toContain("Task class: decision_support");
    expect(result.plan?.steps[0]?.task).toContain("Constraints to respect: under $500 | small footprint");
    expect(result.plan?.steps[0]?.task).toContain("Comparison axes: price | availability");
    expect(result.plan?.steps[0]?.task).toContain("Apply a quality gate before you finish.");
  });
});
