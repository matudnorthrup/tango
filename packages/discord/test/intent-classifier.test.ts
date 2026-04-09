import { describe, expect, it } from "vitest";
import type { ChatProvider, ProviderRequest, ProviderResponse } from "@tango/core";
import {
  classifyDeterministicIntents,
  type DeterministicIntentCatalogEntry,
} from "../src/intent-classifier.js";

class ScriptedProvider implements ChatProvider {
  readonly calls: ProviderRequest[] = [];

  constructor(
    private readonly impl: (callNumber: number, request: ProviderRequest) => ProviderResponse | Error,
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

const catalog: DeterministicIntentCatalogEntry[] = [
  {
    id: "health.sleep_recovery",
    domain: "wellness",
    displayName: "Sleep Recovery",
    description: "Read sleep and recovery data.",
    mode: "read",
    route: { kind: "workflow", targetId: "wellness.analyze_sleep_recovery" },
    examples: ["How did I sleep last night?"],
  },
  {
    id: "health.trend_analysis",
    domain: "wellness",
    displayName: "Health Trend Analysis",
    description: "Read and analyze multi-day or multi-week health, recovery, activity, or TDEE trends.",
    mode: "read",
    route: { kind: "workflow", targetId: "wellness.analyze_health_trends" },
    examples: ["Take a look at my TDEE over the last few weeks"],
  },
  {
    id: "health.metric_lookup_or_question",
    domain: "wellness",
    displayName: "Health Metric Lookup Or Question",
    description: "Read and answer concrete questions grounded in recent health, recovery, activity, weight, or physiology-related metrics.",
    mode: "read",
    route: { kind: "worker", targetId: "health-analyst" },
    examples: ["What was my resting heart rate yesterday?"],
  },
  {
    id: "nutrition.day_summary",
    domain: "wellness",
    displayName: "Nutrition Day Summary",
    description: "Read logged food totals for one or more days.",
    mode: "read",
    route: { kind: "workflow", targetId: "wellness.analyze_nutrition_day" },
    examples: ["What have I eaten today?"],
  },
  {
    id: "nutrition.check_budget",
    domain: "wellness",
    displayName: "Nutrition Budget Check",
    description: "Read current diary and activity context to answer room-left or calorie budget questions.",
    mode: "read",
    route: { kind: "workflow", targetId: "wellness.check_nutrition_budget" },
    examples: ["Do I still have room for yogurt tonight?"],
  },
  {
    id: "nutrition.log_food",
    domain: "wellness",
    displayName: "Log Food Items",
    description: "Log individual food items into the nutrition diary.",
    mode: "write",
    route: { kind: "workflow", targetId: "wellness.log_food_items" },
    examples: ["Log two eggs and toast for breakfast"],
    slots: [{ name: "items", required: true }],
  },
  {
    id: "nutrition.log_recipe",
    domain: "wellness",
    displayName: "Log Recipe Meal",
    description: "Log a named recurring meal.",
    mode: "write",
    route: { kind: "workflow", targetId: "wellness.log_recipe_meal" },
    examples: ["Log my protein yogurt bowl for lunch"],
    slots: [{ name: "recipe_query", required: true }],
  },
  {
    id: "nutrition.log_repair",
    domain: "wellness",
    displayName: "Repair Nutrition Log",
    description: "Repair, reconcile, or deduplicate existing nutrition diary entries.",
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
    examples: ["Find a pulled pork in FatSecret and add it to Atlas for future use."],
    slots: [{ name: "ingredient_query", required: true }],
  },
  {
    id: "workout.log",
    domain: "wellness",
    displayName: "Log Workout",
    description: "Log sets, reps, weights, or workout progress.",
    mode: "write",
    route: { kind: "worker", targetId: "workout-recorder" },
    examples: ["I did 3 sets of bench at 185 for 8"],
  },
  {
    id: "workout.history",
    domain: "wellness",
    displayName: "Workout History",
    description: "Read prior workout data.",
    mode: "read",
    route: { kind: "worker", targetId: "workout-recorder" },
    examples: ["What was my last bench workout?"],
  },
  {
    id: "recipe.read",
    domain: "wellness",
    displayName: "Read Recipe",
    description: "Read and explain an existing recipe.",
    mode: "read",
    route: { kind: "worker", targetId: "recipe-librarian" },
    examples: [
      "What's in my egg hash recipe?",
      "obsidian://open?vault=main&file=Records%2FNutrition%2FRecipes%2FEgg%20%26%20Fries%20Hash here's the recipe link",
    ],
  },
  {
    id: "recipe.update",
    domain: "wellness",
    displayName: "Update Recipe",
    description: "Modify an existing recipe.",
    mode: "write",
    route: { kind: "worker", targetId: "recipe-librarian" },
    examples: ["Update the recipe with the new macros"],
  },
  {
    id: "research.note_read",
    domain: "research",
    displayName: "Read Research Note",
    description: "Read or summarize an existing note or local project document.",
    mode: "read",
    route: { kind: "worker", targetId: "research-assistant" },
    examples: ["Read the Obsidian note titled Large Desk OpenGrid and Underware Project"],
    slots: [{ name: "note_query", required: true }],
  },
  {
    id: "research.web_lookup",
    domain: "research",
    displayName: "Web Research Lookup",
    description: "Look up current or external information on the web.",
    mode: "read",
    route: { kind: "worker", targetId: "research-assistant" },
    examples: ["Look up the official Prusa MK4S product page"],
    slots: [{ name: "query", required: true }],
  },
  {
    id: "research.product_selection",
    domain: "research",
    displayName: "Product Selection",
    description: "Research a product category or lineup and recommend the best fit for the user's constraints.",
    mode: "read",
    route: { kind: "worker", targetId: "research-assistant" },
    examples: ["Help me choose the right Keychron keyboard model for me"],
    slots: [{ name: "product_family", required: true }],
  },
  {
    id: "research.video_read",
    domain: "research",
    displayName: "Read Video",
    description: "Read, transcribe, analyze, or summarize a specific video or YouTube link.",
    mode: "read",
    route: { kind: "worker", targetId: "research-assistant" },
    examples: ["Summarize this YouTube video for me."],
    slots: [{ name: "video_query", required: true }],
  },
  {
    id: "files.local_read",
    domain: "files",
    displayName: "Local File Review",
    description: "Read and summarize local non-repo files or directories like Downloads or Desktop.",
    mode: "read",
    route: { kind: "worker", targetId: "research-assistant" },
    examples: ["Use the worker to list the most recent files in ~/Downloads and summarize what kinds of files are there."],
    slots: [{ name: "path_query", required: false }],
  },
  {
    id: "files.local_write",
    domain: "files",
    displayName: "Local File Write",
    description: "Copy, move, rename, or organize non-repo local files.",
    mode: "write",
    route: { kind: "worker", targetId: "research-assistant" },
    examples: ["Move the newest STL from Downloads into the 3d-printing folder."],
    slots: [
      { name: "path_query", required: true },
      { name: "change_request", required: true },
    ],
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
    examples: ["Can you do a 7x7 grid print please? No brim needed. Printer is ready."],
    slots: [{ name: "print_request", required: false }],
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
    examples: ["Plan the drive from Las Vegas to Tonopah, Nevada."],
    slots: [{ name: "destination", required: true }],
  },
  {
    id: "travel.weather_read",
    domain: "travel",
    displayName: "Weather Read",
    description: "Read and summarize current weather or forecast conditions for a destination or route.",
    mode: "read",
    route: { kind: "worker", targetId: "research-assistant" },
    examples: ["What's the weather in Tonopah, Nevada right now?"],
    slots: [{ name: "location_query", required: true }],
  },
  {
    id: "travel.diesel_lookup",
    domain: "travel",
    displayName: "Diesel Lookup",
    description: "Find diesel stations along a route or near a destination.",
    mode: "read",
    route: { kind: "worker", targetId: "research-assistant" },
    examples: ["Find the best diesel stops on the route to Tonopah, Nevada"],
    slots: [{ name: "destination", required: true }],
  },
  {
    id: "shopping.walmart_queue_review",
    domain: "shopping",
    displayName: "Review Walmart Queue",
    description: "Read and summarize the Walmart queue, restock suggestions, or preferences.",
    mode: "read",
    route: { kind: "worker", targetId: "research-assistant" },
    examples: ["What's currently in the Walmart queue?"],
  },
  {
    id: "shopping.browser_order_lookup",
    domain: "shopping",
    displayName: "Browser Order Lookup",
    description: "Look up order, cart, retailer, or browser-backed shopping details without making changes.",
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
    examples: ["Add those items to my Walmart cart."],
    slots: [{ name: "action_request", required: true }],
  },
  {
    id: "notes.note_update",
    domain: "notes",
    displayName: "Update Note",
    description: "Update or append to an existing local or Obsidian note.",
    mode: "write",
    route: { kind: "worker", targetId: "personal-assistant" },
    examples: ["Update the desk project note with today's measurements."],
    slots: [
      { name: "note_query", required: true },
      { name: "change_request", required: true },
    ],
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
    examples: ["Read the Obsidian note titled Large Desk OpenGrid and Underware Project"],
    slots: [{ name: "note_query", required: true }],
  },
  {
    id: "docs.google_doc_read_or_update",
    domain: "docs",
    displayName: "Read Or Update Google Doc",
    description: "Read, summarize, or update a Google Doc with a clear document target.",
    mode: "mixed",
    route: { kind: "worker", targetId: "personal-assistant" },
    examples: ["Read the shared Google Doc and summarize it."],
    slots: [{ name: "doc_query", required: true }],
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
    examples: ["Read packages/discord/src/turn-executor.ts and explain deterministic routing"],
    slots: [{ name: "target_query", required: true }],
  },
];

function responseWithIntents(intents: unknown[]): ProviderResponse {
  return {
    text: JSON.stringify({ intents }),
    metadata: { model: "test-model" },
  };
}

describe("classifyDeterministicIntents", () => {
  it("fails over to a later provider when the first provider returns malformed JSON", async () => {
    const malformed = new ScriptedProvider(() => ({
      text: "not valid json",
      metadata: { model: "claude-test" },
    }));
    const valid = new ScriptedProvider(() =>
      responseWithIntents([
        {
          intentId: "nutrition.log_food",
          confidence: 0.93,
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
      ]),
    );

    const result = await classifyDeterministicIntents({
      userMessage: "Log two eggs and toast for breakfast",
      catalog,
      providerChain: [
        { providerName: "claude-oauth", provider: malformed },
        { providerName: "codex", provider: valid },
      ],
      retryLimit: 0,
      confidenceThreshold: 0.8,
      reasoningEffort: "low",
    });

    expect(result.providerName).toBe("codex");
    expect(result.usedFailover).toBe(true);
    expect(result.meetsThreshold).toBe(true);
    expect(result.envelopes).toHaveLength(1);
    expect(result.envelopes[0]).toMatchObject({
      intentId: "nutrition.log_food",
      mode: "write",
      confidence: 0.93,
      entities: {
        items: ["two eggs", "toast"],
        meal: "breakfast",
      },
      routeHint: {
        kind: "workflow",
        targetId: "wellness.log_food_items",
      },
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.providerName).toBe("claude-oauth");
    expect(malformed.calls[0]?.tools).toEqual({ mode: "off" });
    expect(valid.calls[0]?.systemPrompt).toContain("Return strict JSON only");
  });

  it("normalizes object-shaped rawEntities from fallback providers", async () => {
    const malformed = new ScriptedProvider(() => ({
      text: "{\"intents\":[",
      metadata: { model: "claude-test" },
    }));
    const codex = new ScriptedProvider(() =>
      responseWithIntents([
        {
          intentId: "email.inbox_review",
          confidence: 0.91,
          entities: { date_scope: "today", focus: "actionable" },
          rawEntities: [
            { text: "unread emails" },
            { label: "today" },
            { kind: "mailbox", value: "attention" },
          ],
          missingSlots: [],
          canRunInParallel: true,
        },
      ]),
    );

    const result = await classifyDeterministicIntents({
      userMessage: "What unread emails need attention today?",
      catalog,
      providerChain: [
        { providerName: "claude-oauth", provider: malformed },
        { providerName: "codex", provider: codex },
      ],
      retryLimit: 0,
      confidenceThreshold: 0.8,
      reasoningEffort: "low",
    });

    expect(result.providerName).toBe("codex");
    expect(result.usedFailover).toBe(true);
    expect(result.meetsThreshold).toBe(true);
    expect(result.envelopes[0]).toMatchObject({
      intentId: "email.inbox_review",
      rawEntities: ["unread emails", "today", "attention"],
    });
  });

  it("handles the benchmark wellness cases for covered read and write intents", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      const cases = [
        responseWithIntents([
          {
            intentId: "nutrition.log_food",
            confidence: 0.95,
            entities: { items: ["2 eggs", "toast"], meal: "breakfast" },
            rawEntities: ["2 eggs", "toast"],
            missingSlots: [],
          },
        ]),
        responseWithIntents([
          {
            intentId: "nutrition.log_recipe",
            confidence: 0.94,
            entities: { recipe_query: "protein yogurt bowl", meal: "lunch" },
            rawEntities: ["protein yogurt bowl"],
            missingSlots: [],
          },
        ]),
        responseWithIntents([
          {
            intentId: "workout.log",
            confidence: 0.92,
            entities: { exercise: "bench", sets: [{ weight: 185, reps: 8, count: 3 }] },
            rawEntities: ["bench", "185", "8"],
            missingSlots: [],
          },
        ]),
        responseWithIntents([
          {
            intentId: "health.sleep_recovery",
            confidence: 0.97,
            entities: { date_scope: "last_night" },
            rawEntities: ["last night"],
            missingSlots: [],
          },
        ]),
        responseWithIntents([
          {
            intentId: "recipe.read",
            confidence: 0.9,
            entities: { recipe_query: "egg hash" },
            rawEntities: ["egg hash"],
            missingSlots: [],
          },
        ]),
        responseWithIntents([
          {
            intentId: "nutrition.day_summary",
            confidence: 0.91,
            entities: { date_scope: "today" },
            rawEntities: ["today"],
            missingSlots: [],
          },
        ]),
        responseWithIntents([
          {
            intentId: "health.trend_analysis",
            confidence: 0.93,
            entities: { days: 28, focus: "tdee" },
            rawEntities: ["TDEE", "last few weeks"],
            missingSlots: [],
          },
        ]),
        responseWithIntents([
          {
            intentId: "nutrition.check_budget",
            confidence: 0.92,
            entities: { date_scope: "today", planned_item: "yogurt tonight", focus: "room_left" },
            rawEntities: ["room", "yogurt tonight"],
            missingSlots: [],
          },
        ]),
        responseWithIntents([
          {
            intentId: "recipe.read",
            confidence: 0.92,
            entities: { recipe_query: "Egg & Fries Hash" },
            rawEntities: ["Egg & Fries Hash", "obsidian recipe link"],
            missingSlots: [],
          },
        ]),
      ];
      return cases[callNumber - 1] ?? new Error(`Unexpected classifier call ${callNumber}`);
    });

    const benchmarkCases = [
      {
        input: "Log 2 eggs and toast for breakfast",
        expectedIntents: ["nutrition.log_food"],
        expectedMode: "write",
      },
      {
        input: "Log my protein yogurt bowl for lunch",
        expectedIntents: ["nutrition.log_recipe"],
        expectedMode: "write",
      },
      {
        input: "I did 3 sets of bench at 185 for 8",
        expectedIntents: ["workout.log"],
        expectedMode: "write",
      },
      {
        input: "How did I sleep last night?",
        expectedIntents: ["health.sleep_recovery"],
        expectedMode: "read",
      },
      {
        input: "What's in my egg hash recipe?",
        expectedIntents: ["recipe.read"],
        expectedMode: "read",
      },
      {
        input: "What have I eaten today?",
        expectedIntents: ["nutrition.day_summary"],
        expectedMode: "read",
      },
      {
        input: "Take a look at my TDEE over the last few weeks",
        expectedIntents: ["health.trend_analysis"],
        expectedMode: "read",
      },
      {
        input: "Do I still have room for yogurt tonight?",
        expectedIntents: ["nutrition.check_budget"],
        expectedMode: "read",
      },
      {
        input:
          "obsidian://open?vault=main&file=Records%2FNutrition%2FRecipes%2FEgg%20%26%20Fries%20Hash here's the recipe link",
        expectedIntents: ["recipe.read"],
        expectedMode: "read",
      },
    ] as const;

    for (const benchmark of benchmarkCases) {
      const result = await classifyDeterministicIntents({
        userMessage: benchmark.input,
        catalog,
        providerChain: [{ providerName: "codex", provider }],
        retryLimit: 0,
        confidenceThreshold: 0.8,
        reasoningEffort: "low",
      });

      expect(result.envelopes.map((envelope) => envelope.intentId)).toEqual(benchmark.expectedIntents);
      expect(result.envelopes[0]?.mode).toBe(benchmark.expectedMode);
      expect(result.meetsThreshold).toBe(true);
    }
  });

  it("returns no intents for conversational or out-of-domain turns", async () => {
    const provider = new ScriptedProvider(() => responseWithIntents([]));

    const inputs = [
      "Hey, how's it going?",
      "I'm feeling really anxious today",
      "What time is my meeting tomorrow?",
    ];

    for (const input of inputs) {
      const result = await classifyDeterministicIntents({
        userMessage: input,
        catalog,
        providerChain: [{ providerName: "codex", provider }],
        retryLimit: 0,
        confidenceThreshold: 0.8,
        reasoningEffort: "low",
      });

      expect(result.envelopes).toEqual([]);
      expect(result.meetsThreshold).toBe(false);
    }
  });

  it("supports multi-intent classification and preserves parallel hints", async () => {
    const provider = new ScriptedProvider(() =>
      responseWithIntents([
        {
          intentId: "nutrition.log_food",
          confidence: 0.94,
          entities: { items: ["protein bar"], meal: "snack" },
          rawEntities: ["protein bar"],
          missingSlots: [],
          canRunInParallel: true,
        },
        {
          intentId: "health.sleep_recovery",
          confidence: 0.9,
          entities: { date_scope: "today" },
          rawEntities: ["today"],
          missingSlots: [],
          canRunInParallel: true,
        },
      ]),
    );

    const result = await classifyDeterministicIntents({
      userMessage: "Log a protein bar and tell me how my recovery looks today",
      catalog,
      providerChain: [{ providerName: "codex", provider }],
      retryLimit: 0,
      confidenceThreshold: 0.8,
      reasoningEffort: "low",
    });

    expect(result.meetsThreshold).toBe(true);
    expect(result.envelopes.map((envelope) => envelope.intentId)).toEqual([
      "nutrition.log_food",
      "health.sleep_recovery",
    ]);
    expect(result.envelopes.every((envelope) => envelope.canRunInParallel)).toBe(true);
  });

  it("classifies Malibu trend-analysis and nutrition-budget requests", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      const cases = [
        responseWithIntents([
          {
            intentId: "health.trend_analysis",
            confidence: 0.95,
            entities: { days: 28, focus: "tdee", goal: "cut" },
            rawEntities: ["TDEE", "last few weeks", "cut"],
            missingSlots: [],
            canRunInParallel: true,
          },
        ]),
        responseWithIntents([
          {
            intentId: "nutrition.check_budget",
            confidence: 0.93,
            entities: { date_scope: "today", planned_item: "yogurt tonight", focus: "room_left" },
            rawEntities: ["room", "yogurt tonight"],
            missingSlots: [],
            canRunInParallel: true,
          },
        ]),
        responseWithIntents([
          {
            intentId: "health.trend_analysis",
            confidence: 0.94,
            entities: { days: 21, focus: "tdee" },
            rawEntities: ["TDEE", "last few weeks"],
            missingSlots: [],
            canRunInParallel: true,
          },
          {
            intentId: "nutrition.check_budget",
            confidence: 0.92,
            entities: { date_scope: "today", planned_item: "yogurt tonight", focus: "room_left" },
            rawEntities: ["room", "yogurt tonight"],
            missingSlots: [],
            canRunInParallel: true,
          },
        ]),
      ];
      return cases[callNumber - 1] ?? new Error(`Unexpected classifier call ${callNumber}`);
    });

    const benchmarkCases = [
      {
        input: "Take a look at my TDEE over the last few weeks.",
        expectedIntents: ["health.trend_analysis"],
      },
      {
        input: "Do I still have room for yogurt tonight?",
        expectedIntents: ["nutrition.check_budget"],
      },
      {
        input: "Take a look at my TDEE over the last few weeks and tell me if I still have room for yogurt tonight.",
        expectedIntents: ["health.trend_analysis", "nutrition.check_budget"],
      },
    ] as const;

    for (const benchmark of benchmarkCases) {
      const result = await classifyDeterministicIntents({
        userMessage: benchmark.input,
        catalog,
        providerChain: [{ providerName: "claude-oauth", provider }],
        retryLimit: 0,
        confidenceThreshold: 0.8,
        reasoningEffort: "low",
      });

      expect(result.meetsThreshold).toBe(true);
      expect(result.envelopes.map((envelope) => envelope.intentId)).toEqual(benchmark.expectedIntents);
      expect(result.envelopes.every((envelope) => envelope.domain === "wellness")).toBe(true);
    }
  });

  it("classifies Malibu repair, ingredient-catalog, and metric-question requests", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      const cases = [
        responseWithIntents([
          {
            intentId: "nutrition.log_repair",
            confidence: 0.94,
            entities: { repair_scope: "lunch entry", date_scope: "today" },
            rawEntities: ["lunch", "repair", "today"],
            missingSlots: [],
            canRunInParallel: true,
          },
        ]),
        responseWithIntents([
          {
            intentId: "nutrition.ingredient_catalog_update",
            confidence: 0.95,
            entities: { ingredient_query: "pulled pork", source_hint: "FatSecret", change_request: "add to Atlas" },
            rawEntities: ["pulled pork", "FatSecret", "Atlas"],
            missingSlots: [],
            canRunInParallel: true,
          },
        ]),
        responseWithIntents([
          {
            intentId: "health.metric_lookup_or_question",
            confidence: 0.93,
            entities: { metric_focus: "resting heart rate", date_scope: "yesterday" },
            rawEntities: ["resting heart rate", "yesterday"],
            missingSlots: [],
            canRunInParallel: true,
          },
        ]),
      ];
      return cases[callNumber - 1] ?? new Error(`Unexpected classifier call ${callNumber}`);
    });

    const benchmarkCases = [
      {
        input: "That lunch didn't log. Please repair it.",
        expectedIntents: ["nutrition.log_repair"],
      },
      {
        input: "Find a pulled pork in FatSecret and add it to Atlas for future use.",
        expectedIntents: ["nutrition.ingredient_catalog_update"],
      },
      {
        input: "What was my resting heart rate yesterday?",
        expectedIntents: ["health.metric_lookup_or_question"],
      },
    ] as const;

    for (const benchmark of benchmarkCases) {
      const result = await classifyDeterministicIntents({
        userMessage: benchmark.input,
        catalog,
        providerChain: [{ providerName: "claude-oauth", provider }],
        retryLimit: 0,
        confidenceThreshold: 0.8,
        reasoningEffort: "low",
      });

      expect(result.meetsThreshold).toBe(true);
      expect(result.envelopes.map((envelope) => envelope.intentId)).toEqual(benchmark.expectedIntents);
      expect(result.envelopes.every((envelope) => envelope.domain === "wellness")).toBe(true);
    }
  });

  it("preserves ordered same-worker mixed intents for write-then-read turns", async () => {
    const provider = new ScriptedProvider(() =>
      responseWithIntents([
        {
          intentId: "nutrition.log_recipe",
          confidence: 0.95,
          entities: { recipe_query: "protein yogurt bowl", meal: "breakfast" },
          rawEntities: ["protein yogurt bowl"],
          missingSlots: [],
          canRunInParallel: true,
        },
        {
          intentId: "nutrition.day_summary",
          confidence: 0.91,
          entities: { date_scope: "today" },
          rawEntities: ["today"],
          missingSlots: [],
          canRunInParallel: true,
        },
      ]),
    );

    const result = await classifyDeterministicIntents({
      userMessage: "Log my protein yogurt bowl for breakfast and tell me what I've eaten today.",
      catalog,
      providerChain: [{ providerName: "claude-oauth", provider }],
      retryLimit: 0,
      confidenceThreshold: 0.8,
      reasoningEffort: "low",
    });

    expect(result.meetsThreshold).toBe(true);
    expect(result.envelopes.map((envelope) => envelope.intentId)).toEqual([
      "nutrition.log_recipe",
      "nutrition.day_summary",
    ]);
    expect(result.envelopes.map((envelope) => envelope.mode)).toEqual(["write", "read"]);
    expect(provider.calls[0]?.systemPrompt).toContain("return multiple intents in the same order they should execute");
  });

  it("classifies research note and web lookup intents outside wellness", async () => {
    const provider = new ScriptedProvider(() =>
      responseWithIntents([
        {
          intentId: "research.note_read",
          confidence: 0.96,
          entities: { note_query: "Large Desk OpenGrid and Underware Project", focus: "Print Summary" },
          rawEntities: ["Large Desk OpenGrid and Underware Project", "Print Summary"],
          missingSlots: [],
          canRunInParallel: true,
        },
        {
          intentId: "research.web_lookup",
          confidence: 0.9,
          entities: { query: "official Prusa MK4S product page" },
          rawEntities: ["official Prusa MK4S product page"],
          missingSlots: [],
          canRunInParallel: true,
        },
      ]),
    );

    const result = await classifyDeterministicIntents({
      userMessage: "Read the Large Desk OpenGrid and Underware Project note and also look up the official Prusa MK4S product page.",
      catalog,
      providerChain: [{ providerName: "claude-oauth", provider }],
      retryLimit: 0,
      confidenceThreshold: 0.8,
      reasoningEffort: "low",
    });

    expect(result.envelopes.map((envelope) => envelope.domain)).toEqual(["research", "research"]);
    expect(result.envelopes.map((envelope) => envelope.intentId)).toEqual([
      "research.note_read",
      "research.web_lookup",
    ]);
    expect(provider.calls[0]?.systemPrompt).toContain("Supported domains:");
    expect(provider.calls[0]?.systemPrompt).toContain("wellness");
    expect(provider.calls[0]?.systemPrompt).toContain("research");
    expect(provider.calls[0]?.systemPrompt).toContain("printing");
    expect(provider.calls[0]?.systemPrompt).toContain("travel");
    expect(provider.calls[0]?.systemPrompt).toContain("shopping");
    expect(provider.calls[0]?.systemPrompt).toContain("finance");
    expect(provider.calls[0]?.systemPrompt).toContain("planning");
    expect(provider.calls[0]?.systemPrompt).toContain("email");
    expect(provider.calls[0]?.systemPrompt).toContain("health");
    expect(provider.calls[0]?.systemPrompt).toContain("notes");
    expect(provider.calls[0]?.systemPrompt).toContain("docs");
    expect(provider.calls[0]?.systemPrompt).toContain("slack");
  });

  it("classifies Watson finance inbox review requests", async () => {
    const provider = new ScriptedProvider(() =>
      responseWithIntents([
        {
          intentId: "finance.unreviewed_transactions",
          confidence: 0.95,
          entities: { date_scope: "recent", focus: "review" },
          rawEntities: ["unconfirmed transactions"],
          missingSlots: [],
          canRunInParallel: true,
        },
      ]),
    );

    const result = await classifyDeterministicIntents({
      userMessage: "Can you summarize our unconfirmed transactions for me please so we can go through them?",
      catalog,
      providerChain: [{ providerName: "claude-oauth", provider }],
      retryLimit: 0,
      confidenceThreshold: 0.8,
      reasoningEffort: "low",
    });

    expect(result.meetsThreshold).toBe(true);
    expect(result.envelopes[0]).toMatchObject({
      domain: "finance",
      intentId: "finance.unreviewed_transactions",
      mode: "read",
    });
  });

  it("includes matched continuation context to bias classification toward the open task intent", async () => {
    const provider = new ScriptedProvider(() =>
      responseWithIntents([
        {
          intentId: "finance.transaction_lookup",
          confidence: 0.93,
          entities: { merchant: "Amazon", focus: "recent charges" },
          rawEntities: ["Amazon transactions"],
          missingSlots: [],
          canRunInParallel: true,
        },
      ]),
    );

    await classifyDeterministicIntents({
      userMessage: "yeah, check those transactions",
      catalog,
      providerChain: [{ providerName: "claude-oauth", provider }],
      retryLimit: 0,
      confidenceThreshold: 0.8,
      reasoningEffort: "low",
      continuation: {
        title: "Review recent Amazon transactions",
        objective: "Look up the most recent Amazon transactions and summarize the latest charges.",
        expectedIntentIds: ["finance.transaction_lookup"],
        structuredContext: {
          merchant: "Amazon",
          system: "Lunch Money",
        },
      },
    });

    expect(provider.calls[0]?.prompt).toContain("Open task continuation context:");
    expect(provider.calls[0]?.prompt).toContain("Expected intents: finance.transaction_lookup");
    expect(provider.calls[0]?.prompt).toContain("Look up the most recent Amazon transactions");
    expect(provider.calls[0]?.prompt).toContain("Prefer continuing the open task above unless the new user message clearly changes direction or contradicts it.");
  });

  it("backfills a missing Google Doc target from unambiguous recent conversation context", async () => {
    const provider = new ScriptedProvider(() =>
      responseWithIntents([
        {
          intentId: "docs.google_doc_read_or_update",
          confidence: 0.95,
          entities: { change_request: "Add headers back in" },
          rawEntities: ["same Google Doc"],
          missingSlots: ["doc_query"],
          canRunInParallel: false,
        },
      ]),
    );

    const result = await classifyDeterministicIntents({
      userMessage: "Please keep using the same Google Doc and add the markdown headers back in.",
      catalog,
      providerChain: [{ providerName: "claude-oauth", provider }],
      retryLimit: 0,
      confidenceThreshold: 0.8,
      reasoningEffort: "low",
      continuation: {
        title: "Complete docs.google_doc_read_or_update",
        objective: "Finish the existing Google Doc update.",
        expectedIntentIds: ["docs.google_doc_read_or_update"],
        structuredContext: {
          change_request: "Add back markdown sections/headers to improve scannability",
        },
      },
      conversationContext: [
        "- [user] Here's the doc: https://docs.google.com/document/d/abc123/edit?usp=sharing",
        "- [assistant] I updated the draft and cleaned up the phrasing.",
      ].join("\n"),
    });

    expect(result.meetsThreshold).toBe(true);
    expect(result.envelopes[0]).toMatchObject({
      intentId: "docs.google_doc_read_or_update",
      missingSlots: [],
      entities: {
        doc_query: "https://docs.google.com/document/d/abc123/edit?usp=sharing",
        change_request: "Add headers back in",
      },
    });
  });

  it("classifies Watson health, finance, calendar, email, and note requests", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      const cases = [
        responseWithIntents([
          {
            intentId: "health.morning_brief",
            confidence: 0.95,
            entities: { mode: "morning" },
            rawEntities: ["morning health briefing"],
            missingSlots: [],
            canRunInParallel: true,
          },
        ]),
        responseWithIntents([
          {
            intentId: "finance.budget_review",
            confidence: 0.94,
            entities: { date_scope: "this_month", focus: "budget" },
            rawEntities: ["budget", "this month"],
            missingSlots: [],
            canRunInParallel: true,
          },
        ]),
        responseWithIntents([
          {
            intentId: "planning.calendar_review",
            confidence: 0.94,
            entities: { date_scope: "today" },
            rawEntities: ["today"],
            missingSlots: [],
            canRunInParallel: true,
          },
        ]),
        responseWithIntents([
          {
            intentId: "email.inbox_review",
            confidence: 0.93,
            entities: { date_scope: "today", focus: "actionable" },
            rawEntities: ["unread emails"],
            missingSlots: [],
            canRunInParallel: true,
          },
        ]),
        responseWithIntents([
          {
            intentId: "notes.note_read",
            confidence: 0.95,
            entities: {
              note_query: "Large Desk OpenGrid and Underware Project",
              focus: "Print Summary",
            },
            rawEntities: ["Large Desk OpenGrid and Underware Project", "Print Summary"],
            missingSlots: [],
            canRunInParallel: true,
          },
        ]),
        responseWithIntents([
          {
            intentId: "notes.note_update",
            mode: "write",
            confidence: 0.95,
            entities: {
              note_query: "Planning/Daily/2026-04-07",
              change_request: "mark meal prep complete and keep website copy in progress",
            },
            rawEntities: ["Planning/Daily/2026-04-07", "meal prep complete", "website copy in progress"],
            missingSlots: [],
            canRunInParallel: false,
          },
        ]),
        responseWithIntents([
          {
            intentId: "finance.transaction_lookup",
            confidence: 0.94,
            entities: { merchant: "Amazon", date_scope: "recent" },
            rawEntities: ["Amazon", "recent"],
            missingSlots: [],
            canRunInParallel: true,
          },
        ]),
        responseWithIntents([
          {
            intentId: "planning.calendar_review",
            confidence: 0.92,
            entities: { date_scope: "today" },
            rawEntities: ["today"],
            missingSlots: [],
            canRunInParallel: true,
          },
          {
            intentId: "email.inbox_review",
            confidence: 0.91,
            entities: { date_scope: "today", focus: "actionable" },
            rawEntities: ["unread emails"],
            missingSlots: [],
            canRunInParallel: true,
          },
        ]),
      ];
      return cases[callNumber - 1] ?? new Error(`Unexpected classifier call ${callNumber}`);
    });

    const benchmarkCases = [
      {
        input: "Give me my morning health briefing",
        expectedIntents: ["health.morning_brief"],
      },
      {
        input: "How am I doing against budget this month?",
        expectedIntents: ["finance.budget_review"],
      },
      {
        input: "What's on my calendar today?",
        expectedIntents: ["planning.calendar_review"],
      },
      {
        input: "What unread emails need attention today?",
        expectedIntents: ["email.inbox_review"],
      },
      {
        input: "Read the Obsidian note titled Large Desk OpenGrid and Underware Project and summarize the Print Summary section.",
        expectedIntents: ["notes.note_read"],
      },
      {
        input: "Update today's daily note to mark meal prep complete and keep website copy in progress.",
        expectedIntents: ["notes.note_update"],
      },
      {
        input: "What were my most recent Amazon transactions?",
        expectedIntents: ["finance.transaction_lookup"],
      },
      {
        input: "What's on my calendar today and what unread emails need attention?",
        expectedIntents: ["planning.calendar_review", "email.inbox_review"],
      },
    ] as const;

    for (const benchmark of benchmarkCases) {
      const result = await classifyDeterministicIntents({
        userMessage: benchmark.input,
        catalog,
        providerChain: [{ providerName: "codex", provider }],
        retryLimit: 0,
        confidenceThreshold: 0.8,
        reasoningEffort: "low",
      });

      expect(result.meetsThreshold).toBe(true);
      expect(result.envelopes.map((envelope) => envelope.intentId)).toEqual(benchmark.expectedIntents);
      expect(
        result.envelopes.every((envelope) =>
          envelope.domain === "planning" ||
          envelope.domain === "email" ||
          envelope.domain === "notes" ||
          envelope.domain === "finance" ||
          envelope.domain === "health"
        )
      ).toBe(true);
    }
  });

  it("classifies Watson transaction-categorization, receipt, planning, doc, subscription, and slack operations", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      const cases = [
        responseWithIntents([
          {
            intentId: "finance.transaction_categorization",
            confidence: 0.94,
            entities: { transaction_scope: "uncategorized", merchant_scope: "Amazon" },
            rawEntities: ["uncategorized", "Amazon"],
            missingSlots: [],
            canRunInParallel: true,
          },
        ]),
        responseWithIntents([
          {
            intentId: "finance.receipt_lookup",
            confidence: 0.93,
            entities: { merchant_scope: "Amazon", receipt_query: "recent charge" },
            rawEntities: ["Amazon charge"],
            missingSlots: [],
            canRunInParallel: true,
          },
        ]),
        responseWithIntents([
          {
            intentId: "finance.receipt_catalog",
            confidence: 0.92,
            entities: { receipt_scope: "uncategorized purchases" },
            rawEntities: ["receipt notes", "uncategorized purchases"],
            missingSlots: [],
            canRunInParallel: true,
          },
        ]),
        responseWithIntents([
          {
            intentId: "finance.reimbursement_submit",
            confidence: 0.93,
            entities: {
              merchant_scope: "Walmart",
              reimbursement_system: "Ramp",
              reimbursement_scope: "delivery tip reimbursements",
            },
            rawEntities: ["Walmart", "Ramp", "delivery tip reimbursements"],
            missingSlots: [],
            canRunInParallel: false,
          },
        ]),
        responseWithIntents([
          {
            intentId: "planning.morning_review",
            mode: "mixed",
            confidence: 0.95,
            entities: { date_scope: "today", focus: "morning planning" },
            rawEntities: ["morning planning", "today"],
            missingSlots: [],
            canRunInParallel: false,
          },
        ]),
        responseWithIntents([
          {
            intentId: "planning.evening_review",
            mode: "mixed",
            confidence: 0.95,
            entities: { date_scope: "today", focus: "close out today" },
            rawEntities: ["evening review", "today"],
            missingSlots: [],
            canRunInParallel: false,
          },
        ]),
        responseWithIntents([
          {
            intentId: "email.subscription_review",
            mode: "mixed",
            confidence: 0.93,
            entities: { mailbox_scope: "subscriptions" },
            rawEntities: ["subscriptions", "unsubscribes"],
            missingSlots: [],
            canRunInParallel: false,
          },
        ]),
        responseWithIntents([
          {
            intentId: "docs.google_doc_read_or_update",
            mode: "mixed",
            confidence: 0.94,
            entities: { doc_query: "shared planning doc", change_request: "summarize" },
            rawEntities: ["shared Google Doc"],
            missingSlots: [],
            canRunInParallel: false,
          },
        ]),
        responseWithIntents([
          {
            intentId: "slack.channel_review",
            confidence: 0.91,
            entities: { channel_query: "ai-productivity", date_scope: "today" },
            rawEntities: ["Slack", "ai-productivity", "today"],
            missingSlots: [],
            canRunInParallel: true,
          },
        ]),
      ];
      return cases[callNumber - 1] ?? new Error(`Unexpected classifier call ${callNumber}`);
    });

    const benchmarkCases = [
      {
        input: "Go through these uncategorized transactions.",
        expectedIntents: ["finance.transaction_categorization"],
      },
      {
        input: "Can you look up what that Amazon charge was for?",
        expectedIntents: ["finance.receipt_lookup"],
      },
      {
        input: "Create receipt notes for those uncategorized purchases.",
        expectedIntents: ["finance.receipt_catalog"],
      },
      {
        input: "Submit the Walmart delivery-tip reimbursements to Ramp.",
        expectedIntents: ["finance.reimbursement_submit"],
      },
      {
        input: "Run morning planning.",
        expectedIntents: ["planning.morning_review"],
      },
      {
        input: "Run evening review.",
        expectedIntents: ["planning.evening_review"],
      },
      {
        input: "Review new subscriptions and recommend unsubscribes.",
        expectedIntents: ["email.subscription_review"],
      },
      {
        input: "Read the shared Google Doc and summarize it.",
        expectedIntents: ["docs.google_doc_read_or_update"],
      },
      {
        input: "Catch me up on Slack.",
        expectedIntents: ["slack.channel_review"],
      },
    ] as const;

    for (const benchmark of benchmarkCases) {
      const result = await classifyDeterministicIntents({
        userMessage: benchmark.input,
        catalog,
        providerChain: [{ providerName: "codex", provider }],
        retryLimit: 0,
        confidenceThreshold: 0.8,
        reasoningEffort: "low",
      });

      expect(result.meetsThreshold).toBe(true);
      expect(result.envelopes.map((envelope) => envelope.intentId)).toEqual(benchmark.expectedIntents);
      expect(
        result.envelopes.every((envelope) =>
          envelope.domain === "finance" ||
          envelope.domain === "planning" ||
          envelope.domain === "email" ||
          envelope.domain === "docs" ||
          envelope.domain === "slack"
        ),
      ).toBe(true);
    }
  });

  it("classifies Sierra file, printer, live-location, diesel, and Walmart queue requests", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      const cases = [
        responseWithIntents([
          {
            intentId: "files.local_read",
            confidence: 0.95,
            entities: { path_query: "~/Downloads", focus: "recent files" },
            rawEntities: ["~/Downloads", "recent files"],
            missingSlots: [],
            canRunInParallel: true,
          },
        ]),
        responseWithIntents([
          {
            intentId: "accounts.identity_read",
            confidence: 0.95,
            entities: { focus: "account_url" },
            rawEntities: ["1Password", "whoami", "account URL"],
            missingSlots: [],
            canRunInParallel: true,
          },
        ]),
        responseWithIntents([
          {
            intentId: "printing.printer_status",
            confidence: 0.95,
            entities: { focus: "status" },
            rawEntities: ["printer status"],
            missingSlots: [],
            canRunInParallel: true,
          },
        ]),
        responseWithIntents([
          {
            intentId: "printing.job_prepare_or_start",
            mode: "write",
            confidence: 0.94,
            entities: {
              print_request: "7x7 grid",
              print_constraints: ["no brim"],
              printer_target: "ready printer",
            },
            rawEntities: ["7x7 grid", "no brim", "printer is ready"],
            missingSlots: [],
            canRunInParallel: false,
          },
        ]),
        responseWithIntents([
          {
            intentId: "printing.job_prepare_or_start",
            mode: "write",
            confidence: 0.95,
            entities: {
              print_request: "7x7 OpenGrid",
              print_constraints: ["preview only", "do not upload", "do not start"],
              printer_target: "MK4",
            },
            rawEntities: ["7x7 OpenGrid", "preview only", "do not upload", "do not start", "MK4"],
            missingSlots: [],
            canRunInParallel: false,
          },
        ]),
        responseWithIntents([
          {
            intentId: "travel.location_read",
            confidence: 0.94,
            entities: { focus: "current_location" },
            rawEntities: ["right now"],
            missingSlots: [],
            canRunInParallel: true,
          },
        ]),
        responseWithIntents([
          {
            intentId: "travel.diesel_lookup",
            confidence: 0.95,
            entities: { destination: "Tonopah, Nevada", top: 3 },
            rawEntities: ["Tonopah, Nevada"],
            missingSlots: [],
            canRunInParallel: true,
          },
        ]),
        responseWithIntents([
          {
            intentId: "shopping.walmart_queue_review",
            confidence: 0.94,
            entities: { focus: "queue" },
            rawEntities: ["Walmart queue"],
            missingSlots: [],
            canRunInParallel: true,
          },
        ]),
        responseWithIntents([
          {
            intentId: "travel.location_read",
            confidence: 0.93,
            entities: { focus: "current_location" },
            rawEntities: ["right now"],
            missingSlots: [],
            canRunInParallel: true,
          },
          {
            intentId: "printing.printer_status",
            confidence: 0.91,
            entities: { focus: "status" },
            rawEntities: ["printer status"],
            missingSlots: [],
            canRunInParallel: true,
          },
        ]),
      ];
      return cases[callNumber - 1] ?? new Error(`Unexpected classifier call ${callNumber}`);
    });

    const benchmarkCases = [
      {
        input: "Use the worker to list the most recent files in ~/Downloads and summarize what kinds of files are there.",
        expectedIntents: ["files.local_read"],
      },
      {
        input: "Use the worker to run 1Password whoami and summarize only the account URL.",
        expectedIntents: ["accounts.identity_read"],
      },
      {
        input: "What's the current printer status?",
        expectedIntents: ["printing.printer_status"],
      },
      {
        input: "Ok. Can you do a 7x7 grid print please? No brim needed. Printer is ready.",
        expectedIntents: ["printing.job_prepare_or_start"],
      },
      {
        input: "Get the 7x7 OpenGrid print ready for the MK4, but preview only. Do not upload or start it.",
        expectedIntents: ["printing.job_prepare_or_start"],
      },
      {
        input: "Where am I right now?",
        expectedIntents: ["travel.location_read"],
      },
      {
        input: "Find the best diesel stops on the route to Tonopah, Nevada",
        expectedIntents: ["travel.diesel_lookup"],
      },
      {
        input: "What's currently in the Walmart queue?",
        expectedIntents: ["shopping.walmart_queue_review"],
      },
      {
        input: "Where am I right now and what's the current printer status?",
        expectedIntents: ["travel.location_read", "printing.printer_status"],
      },
    ] as const;

    for (const benchmark of benchmarkCases) {
      const result = await classifyDeterministicIntents({
        userMessage: benchmark.input,
        catalog,
        providerChain: [{ providerName: "codex", provider }],
        retryLimit: 0,
        confidenceThreshold: 0.8,
        reasoningEffort: "low",
      });

      expect(result.meetsThreshold).toBe(true);
      expect(result.envelopes.map((envelope) => envelope.intentId)).toEqual(benchmark.expectedIntents);
      expect(
        result.envelopes.every((envelope) =>
          envelope.domain === "accounts" ||
          envelope.domain === "files" ||
          envelope.domain === "printing" ||
          envelope.domain === "travel" ||
          envelope.domain === "shopping"
        )
      ).toBe(true);
    }
  });

  it("classifies Sierra route, weather, video, file-write, and browser-order requests", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      const cases = [
        responseWithIntents([
          {
            intentId: "travel.route_plan",
            confidence: 0.93,
            entities: { origin: "Las Vegas", destination: "Tonopah, Nevada" },
            rawEntities: ["Las Vegas", "Tonopah, Nevada"],
            missingSlots: [],
            canRunInParallel: true,
          },
        ]),
        responseWithIntents([
          {
            intentId: "travel.weather_read",
            confidence: 0.92,
            entities: { location_query: "Tonopah, Nevada", date_scope: "today" },
            rawEntities: ["Tonopah, Nevada", "weather"],
            missingSlots: [],
            canRunInParallel: true,
          },
        ]),
        responseWithIntents([
          {
            intentId: "research.video_read",
            confidence: 0.95,
            entities: {
              video_query: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
              focus: "summary",
            },
            rawEntities: ["YouTube video"],
            missingSlots: [],
            canRunInParallel: true,
          },
        ]),
        responseWithIntents([
          {
            intentId: "files.local_write",
            mode: "write",
            confidence: 0.94,
            entities: {
              path_query: "~/Downloads/latest.stl",
              change_request: "move into 3d-printing/gridfinity/stl",
            },
            rawEntities: ["~/Downloads/latest.stl", "move"],
            missingSlots: [],
            canRunInParallel: false,
          },
        ]),
        responseWithIntents([
          {
            intentId: "shopping.browser_order_lookup",
            confidence: 0.93,
            entities: { retailer: "Walmart", order_query: "recent order status" },
            rawEntities: ["Walmart order status"],
            missingSlots: [],
            canRunInParallel: true,
          },
        ]),
        responseWithIntents([
          {
            intentId: "shopping.browser_order_action",
            mode: "write",
            confidence: 0.92,
            entities: { retailer: "Walmart", action_request: "add those items to cart" },
            rawEntities: ["Walmart", "add to cart"],
            missingSlots: [],
            canRunInParallel: false,
          },
        ]),
        responseWithIntents([
          {
            intentId: "research.product_selection",
            mode: "read",
            confidence: 0.94,
            entities: {
              product_family: "Keychron full-size wireless mechanical keyboard lineup",
              constraints: ["full number pad", "USB and Bluetooth", "backlights", "Mac support"],
            },
            rawEntities: ["Keychron", "full layout", "Bluetooth", "Mac"],
            missingSlots: [],
            canRunInParallel: true,
          },
        ]),
      ];
      return cases[callNumber - 1] ?? new Error(`Unexpected classifier call ${callNumber}`);
    });

    const benchmarkCases = [
      {
        input: "Plan the drive from Las Vegas to Tonopah, Nevada.",
        expectedIntents: ["travel.route_plan"],
      },
      {
        input: "What's the weather in Tonopah, Nevada right now?",
        expectedIntents: ["travel.weather_read"],
      },
      {
        input: "Summarize this YouTube video for me: https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        expectedIntents: ["research.video_read"],
      },
      {
        input: "Move the newest STL from Downloads into the 3d-printing folder.",
        expectedIntents: ["files.local_write"],
      },
      {
        input: "Check my Walmart order status.",
        expectedIntents: ["shopping.browser_order_lookup"],
      },
      {
        input: "Add those items to my Walmart cart.",
        expectedIntents: ["shopping.browser_order_action"],
      },
      {
        input: "Help me figure out which Keychron keyboard model is right for me. I want full size, Bluetooth, backlight, and Mac support.",
        expectedIntents: ["research.product_selection"],
      },
    ] as const;

    for (const benchmark of benchmarkCases) {
      const result = await classifyDeterministicIntents({
        userMessage: benchmark.input,
        catalog,
        providerChain: [{ providerName: "codex", provider }],
        retryLimit: 0,
        confidenceThreshold: 0.8,
        reasoningEffort: "low",
      });

      expect(result.meetsThreshold).toBe(true);
      expect(result.envelopes.map((envelope) => envelope.intentId)).toEqual(benchmark.expectedIntents);
      expect(
        result.envelopes.every((envelope) =>
          envelope.domain === "travel" ||
          envelope.domain === "research" ||
          envelope.domain === "notes" ||
          envelope.domain === "files" ||
          envelope.domain === "shopping",
        ),
      ).toBe(true);
    }
  });

  it("marks missing slots and below-threshold classifications without throwing", async () => {
    const provider = new ScriptedProvider(() =>
      responseWithIntents([
        {
          intentId: "nutrition.log_food",
          confidence: 0.72,
          entities: {},
          rawEntities: [],
          missingSlots: ["items"],
        },
      ]),
    );

    const result = await classifyDeterministicIntents({
      userMessage: "Log some food",
      catalog,
      providerChain: [{ providerName: "codex", provider }],
      retryLimit: 0,
      confidenceThreshold: 0.8,
      reasoningEffort: "low",
    });

    expect(result.meetsThreshold).toBe(false);
    expect(result.envelopes).toHaveLength(1);
    expect(result.envelopes[0]).toMatchObject({
      intentId: "nutrition.log_food",
      missingSlots: ["items"],
    });
  });

  it("classifies Victor repo-status and codebase-read requests", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      const cases = [
        responseWithIntents([
          {
            intentId: "engineering.repo_status",
            confidence: 0.95,
            entities: { focus: "git_status" },
            rawEntities: ["git status", "repo"],
            missingSlots: [],
            canRunInParallel: true,
          },
        ]),
        responseWithIntents([
          {
            intentId: "engineering.codebase_read",
            confidence: 0.94,
            entities: {
              target_query: "config/agents/victor.yaml",
              focus: "deterministic routing",
            },
            rawEntities: ["config/agents/victor.yaml", "deterministic routing"],
            missingSlots: [],
            canRunInParallel: true,
          },
        ]),
        responseWithIntents([
          {
            intentId: "engineering.repo_status",
            confidence: 0.93,
            entities: { focus: "git_status" },
            rawEntities: ["git status"],
            missingSlots: [],
            canRunInParallel: true,
          },
          {
            intentId: "engineering.codebase_read",
            confidence: 0.92,
            entities: {
              target_query: "config/agents/victor.yaml",
              focus: "deterministic routing",
            },
            rawEntities: ["config/agents/victor.yaml", "deterministic routing"],
            missingSlots: [],
            canRunInParallel: true,
          },
        ]),
      ];
      return cases[callNumber - 1] ?? new Error(`Unexpected classifier call ${callNumber}`);
    });

    const benchmarkCases = [
      {
        input: "What's the current git status for the repo?",
        expectedIntents: ["engineering.repo_status"],
      },
      {
        input: "Summarize what config/agents/victor.yaml says about deterministic routing.",
        expectedIntents: ["engineering.codebase_read"],
      },
      {
        input: "What's the current git status and summarize what config/agents/victor.yaml says about deterministic routing?",
        expectedIntents: ["engineering.repo_status", "engineering.codebase_read"],
      },
    ] as const;

    for (const benchmark of benchmarkCases) {
      const result = await classifyDeterministicIntents({
        userMessage: benchmark.input,
        catalog,
        providerChain: [{ providerName: "codex", provider }],
        retryLimit: 0,
        confidenceThreshold: 0.8,
        reasoningEffort: "low",
      });

      expect(result.meetsThreshold).toBe(true);
      expect(result.envelopes.map((envelope) => envelope.intentId)).toEqual(benchmark.expectedIntents);
      expect(result.envelopes.every((envelope) => envelope.domain === "engineering")).toBe(true);
    }
  });

  it("includes slot descriptions and evaluation metadata in the classifier system prompt", async () => {
    const provider = new ScriptedProvider(() =>
      responseWithIntents([
        {
          intentId: "research.deep_research",
          confidence: 0.95,
          entities: {
            topic: "floor-sitting desk",
            constraints: ["under $500"],
          },
          rawEntities: ["floor-sitting desk", "under $500"],
          missingSlots: [],
          canRunInParallel: true,
        },
      ]),
    );

    await classifyDeterministicIntents({
      userMessage: "Research the best compact floor desk under $500.",
      catalog: [{
        id: "research.deep_research",
        domain: "research",
        displayName: "Deep Research",
        description: "Investigate a topic through multiple angles before synthesizing the result.",
        mode: "read",
        route: { kind: "worker", targetId: "research-coordinator" },
        slots: [
          { name: "topic", required: true, description: "Primary topic to investigate." },
          { name: "constraints", inferable: true, description: "Decision filters that should change the answer." },
        ],
        evaluation: {
          taskClass: "decision_support",
          successCriteria: ["Tie the recommendation to the user's constraints."],
          mustAnswer: ["What is the strongest option?"],
          comparisonAxes: ["price", "availability"],
          requiredFields: ["source_urls", "tradeoffs"],
          qualityGateRequired: true,
        },
      }],
      providerChain: [{ providerName: "codex", provider }],
      retryLimit: 0,
      confidenceThreshold: 0.8,
      reasoningEffort: "low",
    });

    expect(provider.calls[0]?.systemPrompt).toContain("slots: topic (required): Primary topic to investigate.");
    expect(provider.calls[0]?.systemPrompt).toContain("constraints (inferable): Decision filters that should change the answer.");
    expect(provider.calls[0]?.systemPrompt).toContain("taskClass: decision_support");
    expect(provider.calls[0]?.systemPrompt).toContain("requiredFields: source_urls | tradeoffs");
  });
});
