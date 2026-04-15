import type { CapabilityRegistry, ProviderReasoningEffort } from "@tango/core";
import type { IntentEnvelope, DeterministicIntentCatalogEntry } from "./intent-classifier.js";

export interface DeterministicExecutionStep {
  id: string;
  intentId: string;
  mode: "read" | "write" | "mixed";
  kind: "workflow" | "worker";
  targetId: string;
  workerId: string;
  task: string;
  dependsOn: string[];
  parallelGroup?: string;
  input: Record<string, unknown>;
  allowedToolIds?: string[];
  excludedToolIds?: string[];
  reasoningEffort?: ProviderReasoningEffort;
  safeNoopAllowed?: boolean;
}

export interface DeterministicExecutionPlan {
  steps: DeterministicExecutionStep[];
}

export interface DeterministicRoutingResult {
  outcome: "executed" | "clarification" | "fallback";
  plan?: DeterministicExecutionPlan;
  clarificationQuestion?: string;
  reason?: string;
}

const REIMBURSEMENT_EMAIL_ACCOUNT_ALIASES = new Map<string, string>([
  ["matu.northrup", "matu.dnorthrup@gmail.com"],
  ["matu.northrup@gmail.com", "matu.dnorthrup@gmail.com"],
  ["matu.dnorthrup", "matu.dnorthrup@gmail.com"],
]);

export function getDeterministicIntentCatalog(input: {
  registry: CapabilityRegistry;
  agentId: string;
  projectId?: string | null;
  domain?: string;
}): DeterministicIntentCatalogEntry[] {
  return input.registry.getIntentCatalog(input.agentId, input.projectId, {
    domain: input.domain,
  });
}

function buildClarificationQuestion(missingSlots: string[]): string {
  if (missingSlots.includes("meal")) {
    return "Which meal should I use for that?";
  }
  if (missingSlots.includes("items")) {
    return "What foods should I log?";
  }
  if (missingSlots.includes("recipe_query")) {
    return "Which recipe or recurring meal do you want me to use?";
  }
  if (missingSlots.includes("change_request")) {
    return "What change do you want me to make to that recipe?";
  }
  const [first] = missingSlots;
  return first ? `I need one detail before I do that: ${first}.` : "I need one detail before I do that.";
}

function isPreviewOnlyRequest(userMessage: string, envelope: IntentEnvelope): boolean {
  const text = `${userMessage}\n${JSON.stringify(envelope.entities ?? {})}`;
  return /\bdry[- ]?run\b|\bpreview only\b|\bpreview\b|\bno side effects\b|\bdo not upload\b|\bdon't upload\b|\bdo not start\b|\bdon't start\b|\bwithout actually (?:uploading|starting)\b/iu
    .test(text);
}

function buildExecutionConstraintLines(
  entry: DeterministicIntentCatalogEntry,
  envelope: IntentEnvelope,
  userMessage: string,
  excludedToolIds?: readonly string[],
  allowedToolIds?: readonly string[],
): string[] {
  const productSelectionLines =
    entry.id === "research.product_selection"
      ? [
          "This is a product-selection step, not an exhaustive deep-research brief.",
          "Keep it to one strong research pass: narrow the lineup, compare the most relevant candidates, and recommend the best fit or a compact shortlist.",
          "Avoid many near-duplicate searches or broad source sweeps once you have enough evidence to recommend confidently.",
        ]
      : [];
  const deepResearchLines =
    entry.id === "research.deep_research"
      ? [
          "Keep the first spawn_sub_agents batch modest so it fits inside the tool-call budget.",
          "Prefer 2 complementary sub-tasks in the first round, not a broad spray of overlapping search angles.",
          "Only add a third sub-task in the first round if the user explicitly asked for broader coverage or one critical angle would otherwise be missing.",
          "For the first batch, keep concurrency modest and keep timeout_seconds at 75 or below unless there is a concrete reason to widen it.",
          "If spawn_sub_agents times out or fails before any sub-agent results complete, do not immediately call it again with another broad batch.",
          "When max_rounds is 1, stop and report the gap instead of attempting a second spawn_sub_agents call.",
          "Do not present a confident final synthesis unless you actually received completed sub-agent results or you explicitly say the sub-agent batch did not finish.",
        ]
      : [];
  const reimbursementLines =
    entry.id === "finance.reimbursement_submit"
      ? [
          "If this is a Walmart delivery-tip reimbursement, start by using receipt_registry to find outstanding candidates unless the user already pinned a specific order.",
          "If the requested Walmart history window is not fully cataloged yet, use receipt_registry backfill_walmart_delivery_candidates before filing reimbursements.",
          "If the user already pinned a specific Walmart order or receipt note, do not browse general Walmart order history first.",
          "If this reimbursement's invoice or receipt lives in Gmail, use gog_email to search the specified account, inspect the matching message, and download the attachment before filing in Ramp.",
          "If the Gmail evidence is an HTML receipt email rather than a downloadable attachment, use ramp_reimbursement capture_email_reimbursement_evidence on the raw gog_email full-message output before submitting the reimbursement.",
          "Use receipt_registry and capture_walmart_tip_evidence only for Walmart delivery-tip reimbursements, not for generic vendor invoices or Venmo receipts.",
          "For each submission, use ramp_reimbursement as the primary execution path once you have the right evidence file.",
          "Use the raw browser tool only for login, page-state inspection, or debugging when ramp_reimbursement cannot complete the step.",
          "Do not try to recreate the screenshot or Ramp form flow by hand with generic browser snapshot/click heuristics if ramp_reimbursement is available.",
          "For Walmart order pages, capture screenshot evidence before opening or updating the Ramp reimbursement form.",
          "On Walmart order pages, prefer the order payment summary block that contains Driver tip instead of screenshotting the inline Driver tip label itself.",
          "When filling Ramp reimbursement drafts, use transaction dates in MM/DD/YYYY format.",
          "Use the exact reimbursement memo text the user requested. If they did not specify one, fall back to the installation default.",
          "Only mark the receipt note submitted after the Ramp reimbursement was actually filed.",
          "If Walmart or Ramp requires login or MFA, pause cleanly and report that the managed Brave session needs user authentication.",
        ]
      : [];
  const nutritionLines =
    entry.id === "nutrition.log_food" || entry.id === "nutrition.log_recipe"
      ? [
          "For straightforward meal logs with concrete foods and quantities, start with nutrition_log_items.",
          "If this is a recipe or recurring meal, use recipe_read first, expand the ingredient list, and then pass the concrete ingredient items to nutrition_log_items in one batch.",
          "Use fatsecret_api only when nutrition_log_items returns unresolved items or when the task is explicitly a repair/debug flow.",
          "If the user named a recipe or dish, resolve it with recipe_read before logging ingredient items.",
        ]
      : [];
  const docsLines =
    entry.id === "docs.google_doc_read_or_update"
      ? [
          "When the target doc, tab, and edits are already clear, prefer gog_docs_update_tab over many separate Google Docs calls.",
          "Use raw gog_docs for tab discovery, exploratory reads, exports, copies, or uncommon document operations.",
          "Do not claim the write landed unless the target tab was verified after the edit.",
        ]
      : [];

  if (allowedToolIds && allowedToolIds.length > 0) {
    return [
      `Tool surface for this intent is intentionally narrowed to: ${allowedToolIds.join(", ")}.`,
      "Stay inside those tools unless the runtime reruns you with additional recovered bootstrap context.",
      ...productSelectionLines,
      ...deepResearchLines,
      ...nutritionLines,
      ...docsLines,
      ...reimbursementLines,
      ...(
        entry.id === "printing.job_prepare_or_start" && isPreviewOnlyRequest(userMessage, envelope)
          ? [
              "PREVIEW-ONLY step: do not upload, start, or stop printer jobs in this run.",
              "You may inspect printer state and prepare local artifacts, but any mutating `printer_command` action must be invoked with `dry_run: true`.",
              "Summarize what is ready or what would happen next without causing printer-side effects.",
            ]
          : []
      ),
      ...(
        excludedToolIds?.includes("browser")
          ? ["The browser tool is intentionally unavailable for this intent. Use non-browser tools only."]
          : []
      ),
    ];
  }

  if (excludedToolIds?.includes("browser")) {
    return [
      "The browser tool is intentionally unavailable for this intent. Use non-browser tools only.",
      ...productSelectionLines,
      ...deepResearchLines,
      ...nutritionLines,
      ...docsLines,
      ...reimbursementLines,
      ...(
        entry.id === "printing.job_prepare_or_start" && isPreviewOnlyRequest(userMessage, envelope)
          ? [
              "PREVIEW-ONLY step: do not upload, start, or stop printer jobs in this run.",
              "You may inspect printer state and prepare local artifacts, but any mutating `printer_command` action must be invoked with `dry_run: true`.",
              "Summarize what is ready or what would happen next without causing printer-side effects.",
            ]
          : []
      ),
    ];
  }

  if (entry.id === "printing.job_prepare_or_start" && isPreviewOnlyRequest(userMessage, envelope)) {
    return [
      "PREVIEW-ONLY step: do not upload, start, or stop printer jobs in this run.",
      "You may inspect printer state and prepare local artifacts, but any mutating `printer_command` action must be invoked with `dry_run: true`.",
      "Summarize what is ready or what would happen next without causing printer-side effects.",
      ...deepResearchLines,
      ...nutritionLines,
      ...docsLines,
      ...reimbursementLines,
    ];
  }

  return [...productSelectionLines, ...deepResearchLines, ...nutritionLines, ...docsLines, ...reimbursementLines];
}

function normalizeEntityString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeEntityStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    const collected: string[] = [];
    for (const item of value) {
      const normalized = normalizeEntityString(item);
      if (!normalized || collected.includes(normalized)) {
        continue;
      }
      collected.push(normalized);
    }
    return collected;
  }

  const single = normalizeEntityString(value);
  return single ? [single] : [];
}

function extractEntityValues(
  entities: Record<string, unknown> | undefined,
  keys: readonly string[],
): string[] {
  const collected: string[] = [];

  for (const key of keys) {
    const values = normalizeEntityStringList(entities?.[key]);
    for (const value of values) {
      if (!collected.includes(value)) {
        collected.push(value);
      }
    }
  }

  return collected;
}

function normalizeReimbursementEmailAccount(value: unknown): string | null {
  const normalized = normalizeEntityString(value);
  if (!normalized) {
    return null;
  }
  const canonical = REIMBURSEMENT_EMAIL_ACCOUNT_ALIASES.get(normalized.toLowerCase());
  if (canonical) {
    return canonical;
  }
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(normalized)) {
    return normalized;
  }
  return normalized;
}

function normalizeExecutionEntities(
  intentId: string,
  entities: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!entities) {
    return {};
  }
  if (intentId !== "finance.reimbursement_submit") {
    return entities;
  }

  const normalized = { ...entities };
  const canonicalEmail =
    normalizeReimbursementEmailAccount(normalized["email_account"])
    ?? normalizeReimbursementEmailAccount(normalized["emailAccount"]);
  if (canonicalEmail) {
    normalized["email_account"] = canonicalEmail;
  }
  return normalized;
}

function buildEvaluationContractLines(
  entry: DeterministicIntentCatalogEntry,
  envelope: IntentEnvelope,
): string[] {
  const lines: string[] = [];
  const entities = envelope.entities ?? {};
  const taskClass =
    normalizeEntityString(entities.task_class)
    ?? normalizeEntityString(entities.taskClass)
    ?? entry.evaluation?.taskClass
    ?? null;
  const constraints = extractEntityValues(entities, ["constraints", "constraint"]);
  const successCriteria = [
    ...(entry.evaluation?.successCriteria ?? []),
    ...extractEntityValues(entities, ["success_criteria", "successCriteria"]),
  ].filter((value, index, values) => values.indexOf(value) === index);
  const mustAnswer = [
    ...(entry.evaluation?.mustAnswer ?? []),
    ...extractEntityValues(entities, ["must_answer", "mustAnswer"]),
  ].filter((value, index, values) => values.indexOf(value) === index);
  const comparisonAxes = [
    ...(entry.evaluation?.comparisonAxes ?? []),
    ...extractEntityValues(entities, ["comparison_axes", "comparisonAxes"]),
  ].filter((value, index, values) => values.indexOf(value) === index);
  const requiredFields = [
    ...(entry.evaluation?.requiredFields ?? []),
    ...extractEntityValues(entities, ["required_fields", "requiredFields"]),
  ].filter((value, index, values) => values.indexOf(value) === index);

  if (!taskClass && constraints.length === 0 && successCriteria.length === 0 && mustAnswer.length === 0 && comparisonAxes.length === 0 && requiredFields.length === 0 && entry.evaluation?.qualityGateRequired !== true) {
    return lines;
  }

  lines.push("Decision-quality contract:");
  if (taskClass) {
    lines.push(`Task class: ${taskClass}`);
  }
  if (constraints.length > 0) {
    lines.push(`Constraints to respect: ${constraints.join(" | ")}`);
  }
  if (successCriteria.length > 0) {
    lines.push(`Success criteria: ${successCriteria.join(" | ")}`);
  }
  if (mustAnswer.length > 0) {
    lines.push(`Must answer: ${mustAnswer.join(" | ")}`);
  }
  if (comparisonAxes.length > 0) {
    lines.push(`Comparison axes: ${comparisonAxes.join(" | ")}`);
  }
  if (requiredFields.length > 0) {
    lines.push(`Required evidence fields: ${requiredFields.join(" | ")}`);
  }
  if (entry.evaluation?.qualityGateRequired) {
    lines.push("Apply a quality gate before you finish. If the evidence is missing key fields, unresolved contradictions remain, or the recommendation is not traceable, do another targeted pass instead of narrating early.");
  }

  return lines;
}

function buildWorkflowTask(
  entry: DeterministicIntentCatalogEntry,
  envelope: IntentEnvelope,
  userMessage: string,
  conversationContext?: string | null,
  excludedToolIds?: readonly string[],
  allowedToolIds?: readonly string[],
  sameIntentSiblingCount = 1,
): string {
  const extracted = JSON.stringify(envelope.entities ?? {});
  const missing = envelope.missingSlots.length > 0 ? envelope.missingSlots.join(", ") : "none";
  const userMessageLabel =
    sameIntentSiblingCount > 1
      ? "Original user message (background only)"
      : "User message";
  const lines = [
    `Execute workflow '${entry.route.targetId}' for the owning worker now.`,
    `Intent contract: ${entry.id}`,
    `Intent mode: ${entry.mode}`,
    `${userMessageLabel}: ${userMessage}`,
  ];
  if (conversationContext?.trim()) {
    lines.push("Recent conversation:");
    lines.push(conversationContext.trim());
  }
  lines.push(
    `Extracted inputs: ${extracted}`,
    `Missing slots: ${missing}`,
    ...(sameIntentSiblingCount > 1
      ? [
          `This turn produced ${sameIntentSiblingCount} separate steps for the same intent contract.`,
          "Treat the extracted inputs for this step as the only in-scope target.",
          "Do not act on other documents, URLs, or change requests mentioned in the original user message unless they also appear in the extracted inputs for this step.",
        ]
      : []),
    "Workflow metadata scopes the objective, but it does not prescribe fixed queries or a hardcoded tool sequence.",
    "The owning worker must decide which tools, lookups, windows, comparisons, and reasoning steps are appropriate for this specific request.",
    "This step is intent-scoped. Ignore other requests in the original user message that belong to different intents.",
    envelope.mode === "read"
      ? "READ-ONLY step: do not create, edit, delete, or log anything. If prior steps already mutated state, only read the current resulting state."
      : envelope.mode === "write"
        ? "WRITE step: perform only the mutation required for this intent. Do not also answer separate summary, comparison, or history requests from the original message."
        : "MIXED step: stay within this intent contract only, and avoid unrelated side effects from other intents in the original message.",
    "If required information is still missing or ambiguous, ask a clarification question instead of guessing.",
    "Use your tools as needed and return the result for same-turn synthesis.",
  );
  lines.push(...buildEvaluationContractLines(entry, envelope));
  lines.push(...buildExecutionConstraintLines(entry, envelope, userMessage, excludedToolIds, allowedToolIds));
  return lines.join("\n");
}

function buildWorkerTask(
  entry: DeterministicIntentCatalogEntry,
  envelope: IntentEnvelope,
  userMessage: string,
  conversationContext?: string | null,
  excludedToolIds?: readonly string[],
  allowedToolIds?: readonly string[],
  sameIntentSiblingCount = 1,
): string {
  const extracted = JSON.stringify(envelope.entities ?? {});
  const missing = envelope.missingSlots.length > 0 ? envelope.missingSlots.join(", ") : "none";
  const userMessageLabel =
    sameIntentSiblingCount > 1
      ? "Original user message (background only)"
      : "User message";
  const lines = [
    "Handle this request in your domain now.",
    `Intent contract: ${entry.id}`,
    `Intent mode: ${entry.mode}`,
    `${userMessageLabel}: ${userMessage}`,
  ];
  if (conversationContext?.trim()) {
    lines.push("Recent conversation:");
    lines.push(conversationContext.trim());
  }
  lines.push(
    `Extracted entities: ${extracted}`,
    `Missing slots: ${missing}`,
    ...(sameIntentSiblingCount > 1
      ? [
          `This turn produced ${sameIntentSiblingCount} separate steps for the same intent contract.`,
          "Treat the extracted entities for this step as the only in-scope target.",
          "Do not act on other documents, URLs, or change requests mentioned in the original user message unless they also appear in the extracted entities for this step.",
        ]
      : []),
    `Your worker id: ${entry.route.targetId}`,
    "You own the reasoning inside this domain. Choose the exact tools, queries, windows, comparisons, and analysis needed for this request.",
    "This step is intent-scoped. Ignore other requests in the original user message that belong to different intents.",
    envelope.mode === "read"
      ? "READ-ONLY step: do not create, edit, delete, or log anything. If prior steps already mutated state, only read the current resulting state."
      : envelope.mode === "write"
        ? "WRITE step: perform only the mutation required for this intent. Do not also answer separate summary, comparison, or history requests from the original message."
        : "MIXED step: stay within this intent contract only, and avoid unrelated side effects from other intents in the original message.",
    "If clarification is needed, ask for it explicitly instead of guessing.",
    "Do the actual work now and return a same-turn result for narration.",
  );
  lines.push(...buildEvaluationContractLines(entry, envelope));
  lines.push(...buildExecutionConstraintLines(entry, envelope, userMessage, excludedToolIds, allowedToolIds));
  return lines.join("\n");
}

const BROWSER_ALLOWED_INTENTS = new Set([
  "shopping.browser_order_lookup",
  "shopping.browser_order_action",
  "finance.receipt_lookup",
  "finance.receipt_catalog",
  "finance.reimbursement_submit",
  "finance.transaction_categorization",
]);

const FINANCE_TRANSACTION_CATEGORIZATION_ALLOWED_TOOL_IDS = [
  "lunch_money",
  "obsidian",
  "browser",
  "onepassword",
  "gog_email",
];

const EMAIL_INBOX_MAINTENANCE_ALLOWED_TOOL_IDS = [
  "gog_email",
  "gog_calendar",
];

const EMAIL_SUBSCRIPTION_REVIEW_ALLOWED_TOOL_IDS = [
  "gog_email",
  "obsidian",
];

const FINANCE_RECEIPT_CATALOG_ALLOWED_TOOL_IDS = [
  "lunch_money",
  "browser",
  "onepassword",
  "gog_email",
  "obsidian",
  "receipt_registry",
];

const FINANCE_RECEIPT_LOOKUP_ALLOWED_TOOL_IDS = [
  "lunch_money",
  "browser",
  "onepassword",
  "gog_email",
  "obsidian",
];

const NUTRITION_LOG_ALLOWED_TOOL_IDS = [
  "recipe_read",
  "nutrition_log_items",
  "fatsecret_api",
];

const NUTRITION_LOG_REPAIR_ALLOWED_TOOL_IDS = [
  "recipe_read",
  "nutrition_log_items",
  "fatsecret_api",
  "atlas_sql",
];

const PLANNING_MORNING_REVIEW_ALLOWED_TOOL_IDS = [
  "gog_calendar",
  "gog_email",
  "obsidian",
  "health_morning",
  "linear",
];

const PLANNING_EVENING_REVIEW_ALLOWED_TOOL_IDS = [
  "gog_calendar",
  "gog_email",
  "obsidian",
  "linear",
];

const PRINTING_JOB_PREP_ALLOWED_TOOL_IDS = [
  "file_ops",
  "openscad_render",
  "prusa_slice",
  "printer_command",
];

const RECIPE_READ_ALLOWED_TOOL_IDS = [
  "recipe_list",
  "recipe_read",
];

const RECIPE_UPDATE_ALLOWED_TOOL_IDS = [
  "recipe_list",
  "recipe_read",
  "recipe_write",
  "atlas_sql",
  "fatsecret_api",
];

const RESEARCH_WEB_ALLOWED_TOOL_IDS = [
  "exa_search",
  "exa_answer",
];

const RESEARCH_MULTI_DOCUMENT_ALLOWED_TOOL_IDS = [
  "file_ops",
  "obsidian",
  "youtube_transcript",
  "youtube_analyze",
  "exa_search",
  "exa_answer",
];

const RESEARCH_VIDEO_ALLOWED_TOOL_IDS = [
  "youtube_transcript",
  "youtube_analyze",
  "exa_search",
];

const TRAVEL_ROUTE_ALLOWED_TOOL_IDS = [
  "location_read",
  "exa_search",
  "exa_answer",
];

const TRAVEL_DIESEL_ALLOWED_TOOL_IDS = [
  "location_read",
  "find_diesel",
];

const ENGINEERING_ALLOWED_TOOL_IDS = [
  "tango_shell",
  "tango_file",
];

const ALLOWED_TOOL_IDS_BY_INTENT: Record<string, string[]> = {
  "accounts.identity_read": ["onepassword"],
  "docs.google_doc_read_or_update": ["gog_docs_update_tab", "gog_docs"],
  "email.inbox_maintenance": EMAIL_INBOX_MAINTENANCE_ALLOWED_TOOL_IDS,
  "email.inbox_review": ["gog_email"],
  "email.subscription_review": EMAIL_SUBSCRIPTION_REVIEW_ALLOWED_TOOL_IDS,
  "engineering.codebase_read": ENGINEERING_ALLOWED_TOOL_IDS,
  "engineering.repo_status": ENGINEERING_ALLOWED_TOOL_IDS,
  "files.local_read": ["file_ops"],
  "files.local_write": ["file_ops"],
  "finance.budget_review": ["lunch_money"],
  "finance.receipt_catalog": FINANCE_RECEIPT_CATALOG_ALLOWED_TOOL_IDS,
  "finance.receipt_lookup": FINANCE_RECEIPT_LOOKUP_ALLOWED_TOOL_IDS,
  "finance.reimbursement_submit": ["receipt_registry", "ramp_reimbursement", "gog_email", "onepassword", "obsidian"],
  "finance.sinking_fund_reconciliation": ["lunch_money", "obsidian"],
  "finance.transaction_categorization": FINANCE_TRANSACTION_CATEGORIZATION_ALLOWED_TOOL_IDS,
  "finance.transaction_lookup": ["lunch_money"],
  "finance.unreviewed_transactions": ["lunch_money"],
  "health.metric_lookup_or_question": ["health_query"],
  "health.morning_brief": ["health_morning"],
  "health.sleep_recovery": ["health_query"],
  "health.trend_analysis": ["health_query"],
  "notes.note_read": ["obsidian"],
  "notes.note_update": ["obsidian"],
  "notes.vault_maintenance_review": ["obsidian"],
  "nutrition.check_budget": ["fatsecret_api", "health_query"],
  "nutrition.day_summary": ["fatsecret_api"],
  "nutrition.ingredient_catalog_update": ["atlas_sql", "fatsecret_api"],
  "nutrition.log_food": NUTRITION_LOG_ALLOWED_TOOL_IDS,
  "nutrition.log_recipe": NUTRITION_LOG_ALLOWED_TOOL_IDS,
  "nutrition.log_repair": NUTRITION_LOG_REPAIR_ALLOWED_TOOL_IDS,
  "planning.calendar_review": ["gog_calendar"],
  "planning.current_time_read": ["system_clock"],
  "planning.evening_review": PLANNING_EVENING_REVIEW_ALLOWED_TOOL_IDS,
  "planning.morning_review": PLANNING_MORNING_REVIEW_ALLOWED_TOOL_IDS,
  "printing.job_prepare_or_start": PRINTING_JOB_PREP_ALLOWED_TOOL_IDS,
  "printing.printer_status": ["printer_command"],
  "recipe.read": RECIPE_READ_ALLOWED_TOOL_IDS,
  "recipe.update": RECIPE_UPDATE_ALLOWED_TOOL_IDS,
  "research.deep_research": RESEARCH_WEB_ALLOWED_TOOL_IDS,
  "research.fact_verification": RESEARCH_WEB_ALLOWED_TOOL_IDS,
  "research.multi_document_analysis": RESEARCH_MULTI_DOCUMENT_ALLOWED_TOOL_IDS,
  "research.note_read": ["obsidian", "file_ops"],
  "research.product_selection": RESEARCH_WEB_ALLOWED_TOOL_IDS,
  "research.slack_digest": ["slack"],
  "research.video_read": RESEARCH_VIDEO_ALLOWED_TOOL_IDS,
  "research.web_lookup": RESEARCH_WEB_ALLOWED_TOOL_IDS,
  "shopping.browser_order_action": ["walmart", "browser", "onepassword"],
  "shopping.browser_order_lookup": ["walmart", "browser", "onepassword"],
  "shopping.walmart_queue_review": ["walmart"],
  "slack.channel_review": ["slack"],
  "travel.diesel_lookup": TRAVEL_DIESEL_ALLOWED_TOOL_IDS,
  "travel.location_read": ["location_read"],
  "travel.route_plan": TRAVEL_ROUTE_ALLOWED_TOOL_IDS,
  "travel.weather_read": TRAVEL_ROUTE_ALLOWED_TOOL_IDS,
};

function resolveExcludedToolIds(entry: DeterministicIntentCatalogEntry): string[] {
  if (
    (entry.route.targetId === "research-assistant" || entry.route.targetId === "personal-assistant")
    && !BROWSER_ALLOWED_INTENTS.has(entry.id)
  ) {
    return ["browser"];
  }
  return [];
}

function resolveAllowedToolIds(entry: DeterministicIntentCatalogEntry): string[] | undefined {
  if (entry.id.startsWith("workout.")) {
    return ["workout_sql"];
  }
  return ALLOWED_TOOL_IDS_BY_INTENT[entry.id];
}

function resolveStepReasoningEffort(entry: DeterministicIntentCatalogEntry): ProviderReasoningEffort | undefined {
  switch (entry.id) {
    case "docs.google_doc_read_or_update":
    case "nutrition.log_food":
    case "nutrition.log_recipe":
      return "low";
    case "research.product_selection":
      return "low";
    case "shopping.browser_order_action":
    case "shopping.browser_order_lookup":
    case "finance.reimbursement_submit":
      return "medium";
    default:
      return undefined;
  }
}

function isWriteLike(mode: "read" | "write" | "mixed"): boolean {
  return mode === "write" || mode === "mixed";
}

export function buildDeterministicExecutionPlan(input: {
  userMessage: string;
  envelopes: readonly IntentEnvelope[];
  catalog: readonly DeterministicIntentCatalogEntry[];
  registry: CapabilityRegistry;
  conversationContext?: string | null;
}): DeterministicRoutingResult {
  const catalogByIntentId = new Map(input.catalog.map((entry) => [entry.id, entry] as const));
  const allMissingSlots = [...new Set(input.envelopes.flatMap((envelope) => envelope.missingSlots))];

  if (allMissingSlots.length > 0) {
    return {
      outcome: "clarification",
      clarificationQuestion: buildClarificationQuestion(allMissingSlots),
    };
  }

  const steps: DeterministicExecutionStep[] = [];
  for (const [index, envelope] of input.envelopes.entries()) {
    const entry = catalogByIntentId.get(envelope.intentId);
    if (!entry) {
      return {
        outcome: "fallback",
        reason: `No deterministic catalog entry for intent '${envelope.intentId}'.`,
      };
    }

    const workerId =
      entry.route.kind === "workflow"
        ? input.registry.getWorkflow(entry.route.targetId)?.ownerWorkerId ?? entry.route.targetId
        : entry.route.targetId;
    const mode = envelope.mode ?? entry.mode;
    const normalizedEntities = normalizeExecutionEntities(envelope.intentId, envelope.entities);
    const normalizedEnvelope =
      normalizedEntities === envelope.entities
        ? envelope
        : { ...envelope, entities: normalizedEntities };
    const excludedToolIds = resolveExcludedToolIds(entry);
    const allowedToolIds = resolveAllowedToolIds(entry);
    const dependsOn = steps
      .filter((candidate) => {
        if (!envelope.canRunInParallel) {
          return true;
        }
        if (candidate.parallelGroup === "exclusive") {
          return true;
        }
        if (candidate.workerId !== workerId) {
          return false;
        }
        return isWriteLike(candidate.mode) || isWriteLike(mode);
      })
      .map((candidate) => candidate.id);

    const sameIntentSiblingCount = input.envelopes.filter(
      (candidate) => candidate.intentId === envelope.intentId,
    ).length;
    steps.push({
      id: `step-${index + 1}`,
      intentId: envelope.intentId,
      mode,
      kind: entry.route.kind,
      targetId: entry.route.targetId,
      workerId,
      task:
        entry.route.kind === "workflow"
          ? buildWorkflowTask(
              entry,
              normalizedEnvelope,
              input.userMessage,
              input.conversationContext,
              excludedToolIds,
              allowedToolIds,
              sameIntentSiblingCount,
            )
          : buildWorkerTask(
              entry,
              normalizedEnvelope,
              input.userMessage,
              input.conversationContext,
              excludedToolIds,
              allowedToolIds,
              sameIntentSiblingCount,
            ),
      dependsOn,
      parallelGroup: envelope.canRunInParallel ? undefined : "exclusive",
      input: normalizedEntities,
      allowedToolIds,
      excludedToolIds: excludedToolIds.length > 0 ? excludedToolIds : undefined,
      reasoningEffort: resolveStepReasoningEffort(entry),
      safeNoopAllowed:
        entry.evaluation?.safeNoopAllowed === true
        || (entry.id === "printing.job_prepare_or_start" && isPreviewOnlyRequest(input.userMessage, envelope))
          ? true
          : undefined,
    });
  }

  return {
    outcome: "executed",
    plan: {
      steps,
    },
  };
}
