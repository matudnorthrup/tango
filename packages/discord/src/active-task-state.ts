import type {
  ActiveTaskRecord,
  ActiveTaskStatus,
  ActiveTaskStatusUpdateInput,
  ActiveTaskUpsertInput,
} from "@tango/core";
import { receiptHasConfirmedWriteOutcome, type ExecutionReceipt, type DeterministicTurnState } from "./deterministic-runtime.js";

const OPEN_TASK_STATUSES = new Set<ActiveTaskStatus>([
  "proposed",
  "awaiting_user",
  "ready",
  "running",
  "blocked",
]);

const AFFIRMATION_PATTERN =
  /^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|please do|go ahead|do that|sounds good|let'?s do it|take a look|check it|try it|run it|continue|go for it|proceed)\b/iu;
const CANCELLATION_PATTERN =
  /^(?:no|nah|don'?t|do not|stop|cancel|never mind|nm|scratch that)\b/iu;
const CORRECTION_PATTERN =
  /(?:^|\b)(?:that(?:'s| is) not what i asked|that(?:'s| is) not what i meant|not what i asked|not what i meant|no(?:\s*,)?\s+i\s+meant|i meant|i was asking|i asked for|that's wrong|that is wrong|wrong answer|wrong question)\b/iu;
const DEICTIC_PATTERN =
  /\b(?:that|it|this|same|again|the one|like i said|as i said|earlier|previous|before)\b/iu;
const CLARIFICATION_PATTERN =
  /^(?:which|what|how much|how many|when|where|who|do you want|would you like|want me|should i|need me)\b/iu;

export interface ActiveTaskContinuationResolution {
  kind: "none" | "continue" | "cancel";
  matchedTask: ActiveTaskRecord | null;
  effectiveUserMessage: string;
  promptContext?: string;
  reason?: string;
}

export interface ActiveTaskPersistencePlan {
  upserts: ActiveTaskUpsertInput[];
  statusUpdates: ActiveTaskStatusUpdateInput[];
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/gu, " ").toLowerCase();
}

function tokenize(text: string): string[] {
  return normalize(text)
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length >= 3);
}

function truncate(text: string, maxChars: number): string {
  const normalized = text.trim().replace(/\s+/gu, " ");
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function futureIso(hoursFromNow: number): string {
  return new Date(Date.now() + hoursFromNow * 60 * 60 * 1000).toISOString();
}

function formatTaskTitle(task: Pick<ActiveTaskRecord, "title" | "objective">): string {
  return truncate(task.title || task.objective || "Open task", 80);
}

function renderStructuredContext(context: Record<string, unknown> | null | undefined): string | null {
  if (!context || Object.keys(context).length === 0) {
    return null;
  }
  try {
    return JSON.stringify(context);
  } catch {
    return null;
  }
}

function describeTask(task: ActiveTaskRecord): string {
  const parts = [
    `[${task.status}] ${formatTaskTitle(task)}`,
    `Objective: ${truncate(task.objective, 220)}`,
  ];
  if (task.clarificationQuestion) {
    parts.push(`Waiting on: ${truncate(task.clarificationQuestion, 220)}`);
  }
  if (task.suggestedNextAction) {
    parts.push(`Next action: ${truncate(task.suggestedNextAction, 180)}`);
  }
  if (task.intentIds.length > 0) {
    parts.push(`Intent IDs: ${task.intentIds.join(", ")}`);
  }
  const structuredContext = renderStructuredContext(task.structuredContext);
  if (structuredContext) {
    parts.push(`Structured context: ${truncate(structuredContext, 220)}`);
  }
  return parts.join("\n");
}

export function renderActiveTasksContext(
  tasks: readonly ActiveTaskRecord[],
  options?: { matchedTaskId?: string | null; limit?: number },
): string | undefined {
  const openTasks = tasks.filter((task) => OPEN_TASK_STATUSES.has(task.status));
  if (openTasks.length === 0) {
    return undefined;
  }

  const limit = Number.isFinite(options?.limit) ? Math.max(options?.limit ?? 3, 1) : 3;
  const lines = ["active_tasks:"];
  for (const task of openTasks.slice(0, limit)) {
    const prefix = options?.matchedTaskId === task.id ? "*" : "-";
    lines.push(`${prefix} ${describeTask(task)}`);
  }
  return lines.join("\n");
}

function scoreTask(task: ActiveTaskRecord, userMessage: string, rank: number): number {
  const normalizedMessage = normalize(userMessage);
  const messageTokens = new Set(tokenize(userMessage));
  const taskTokens = new Set(
    tokenize(
      [
        task.title,
        task.objective,
        task.clarificationQuestion,
        task.suggestedNextAction,
        ...task.intentIds,
        task.ownerWorkerId ?? "",
        renderStructuredContext(task.structuredContext) ?? "",
      ]
        .filter(Boolean)
        .join(" "),
    ),
  );

  let score = Math.max(0, 20 - rank);
  if (task.status === "awaiting_user" || task.status === "blocked") {
    score += 6;
  } else if (task.status === "proposed") {
    score += 4;
  }

  if (AFFIRMATION_PATTERN.test(userMessage)) {
    score += 4;
  }
  if (CANCELLATION_PATTERN.test(userMessage)) {
    score += 4;
  }
  if (DEICTIC_PATTERN.test(userMessage)) {
    score += 4;
  }

  for (const token of messageTokens) {
    if (taskTokens.has(token)) {
      score += 3;
    }
  }

  if (task.clarificationQuestion && normalize(task.clarificationQuestion).includes(normalizedMessage)) {
    score += 3;
  }

  if (normalizedMessage.length <= 24) {
    score += 2;
  }

  return score;
}

function isContinuationLike(userMessage: string): boolean {
  const normalized = normalize(userMessage);
  if (!normalized) {
    return false;
  }
  if (CORRECTION_PATTERN.test(userMessage)) {
    return false;
  }
  if (AFFIRMATION_PATTERN.test(userMessage) || CANCELLATION_PATTERN.test(userMessage) || DEICTIC_PATTERN.test(userMessage)) {
    return true;
  }
  if (normalized.length <= 48 && !normalized.includes("?")) {
    return true;
  }
  return /\b(?:per|for|with|without|same|again|weeks?|days?|lbs?|grams?|g|calories?|protein)\b/iu.test(userMessage);
}

function buildContinuationPrompt(task: ActiveTaskRecord, userMessage: string, kind: "continue" | "cancel"): string {
  const lines = [
    "The user is continuing an existing open task from this conversation.",
    `Open task title: ${formatTaskTitle(task)}`,
    `Open task objective: ${task.objective}`,
    `Open task status: ${task.status}`,
  ];
  if (task.clarificationQuestion) {
    lines.push(`Pending clarification: ${task.clarificationQuestion}`);
  }
  if (task.intentIds.length > 0) {
    lines.push(`Expected intents: ${task.intentIds.join(", ")}`);
  }
  const structuredContext = renderStructuredContext(task.structuredContext);
  if (structuredContext) {
    lines.push(`Structured task context: ${structuredContext}`);
  }
  lines.push(
    kind === "cancel"
      ? `User cancellation message: ${userMessage}`
      : `User follow-up message: ${userMessage}`,
  );
  return lines.join("\n");
}

export function resolveActiveTaskContinuation(input: {
  tasks: readonly ActiveTaskRecord[];
  userMessage: string;
}): ActiveTaskContinuationResolution {
  const openTasks = input.tasks.filter((task) => OPEN_TASK_STATUSES.has(task.status));
  if (openTasks.length === 0) {
    return {
      kind: "none",
      matchedTask: null,
      effectiveUserMessage: input.userMessage,
    };
  }

  if (CORRECTION_PATTERN.test(input.userMessage)) {
    return {
      kind: "none",
      matchedTask: null,
      effectiveUserMessage: input.userMessage,
      promptContext: renderActiveTasksContext(openTasks),
      reason: "correction-like follow-up should stay conversational",
    };
  }

  const candidateTasks = [...openTasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const matchedTask =
    candidateTasks
      .map((task, index) => ({ task, score: scoreTask(task, input.userMessage, index) }))
      .sort((a, b) => b.score - a.score)[0];

  if (!matchedTask || matchedTask.score < 8 || !isContinuationLike(input.userMessage)) {
    return {
      kind: "none",
      matchedTask: null,
      effectiveUserMessage: input.userMessage,
      promptContext: renderActiveTasksContext(openTasks),
    };
  }

  const kind = CANCELLATION_PATTERN.test(input.userMessage) ? "cancel" : "continue";
  return {
    kind,
    matchedTask: matchedTask.task,
    effectiveUserMessage: buildContinuationPrompt(matchedTask.task, input.userMessage, kind),
    promptContext: renderActiveTasksContext(openTasks, { matchedTaskId: matchedTask.task.id }),
    reason: `${kind === "cancel" ? "cancellation" : "continuation"} matched open task '${matchedTask.task.id}'`,
  };
}

function extractOfferObjective(responseText: string): string | null {
  const patterns = [
    /\bdo you want me to ([^?.!]+)\??/iu,
    /\bwould you like me to ([^?.!]+)\??/iu,
    /\bwant me to ([^?.!]+)\??/iu,
    /\bneed me to ([^?.!]+)\??/iu,
    /\bshould i ([^?.!]+)\??/iu,
  ];

  for (const pattern of patterns) {
    const match = responseText.match(pattern);
    const objective = match?.[1]?.trim();
    if (objective) {
      return objective.charAt(0).toUpperCase() + objective.slice(1);
    }
  }
  return null;
}

function extractClarificationQuestion(responseText: string): string | null {
  const trimmed = responseText.trim();
  const lines = trimmed
    .split("\n")
    .map((line) => line.trim().replace(/^[-*]\s+/u, "").trim())
    .filter((line) => line.length > 0);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines[index];
    if (!candidate) {
      continue;
    }
    if (!candidate.endsWith("?")) {
      continue;
    }
    if (CLARIFICATION_PATTERN.test(candidate)) {
      return candidate;
    }
  }

  return null;
}

function buildTaskTitleFromQuestion(question: string): string {
  return truncate(question.replace(/\?+$/u, ""), 80);
}

function buildTaskTitleFromObjective(objective: string): string {
  return truncate(objective, 80);
}

function responseSuggestsUnverifiedWrite(responseText: string): boolean {
  return /\bcould(?: not|n't) verify\b|\bcan(?:not|'t) honestly say\b|\bdid(?: not|n't) stick\b|\bgot cancel(?:ed|led)\b|\bcancel(?:ed|led) again\b|\bdid(?: not|n't) go through\b|\bwrite could not be verified\b/iu
    .test(responseText);
}

function receiptNeedsFollowUp(receipt: ExecutionReceipt): boolean {
  if (receipt.status !== "completed") {
    return true;
  }
  if (receipt.clarification) {
    return true;
  }
  if (receipt.mode === "write" || receipt.mode === "mixed") {
    if (!receiptHasConfirmedWriteOutcome(receipt)) {
      return true;
    }
  } else if (!receipt.hasWriteOperations) {
    return false;
  }
  if (receipt.warnings.length > 0) {
    return true;
  }
  return receipt.data?.["partial"] === true;
}

function deriveExecutionBlockedTitle(
  deterministicTurn: { state: DeterministicTurnState; receipts: ExecutionReceipt[] },
  matchedTask: ActiveTaskRecord | null,
): string {
  const firstIntent = deterministicTurn.state.intent.envelopes[0];
  const recipeQuery =
    typeof firstIntent?.entities?.["recipe_query"] === "string"
      ? firstIntent.entities["recipe_query"].trim()
      : "";
  if (recipeQuery.length > 0) {
    return buildTaskTitleFromObjective(`Finish ${recipeQuery}`);
  }
  if (matchedTask?.title?.trim()) {
    return matchedTask.title.trim();
  }
  if (firstIntent?.intentId) {
    return buildTaskTitleFromObjective(`Complete ${firstIntent.intentId}`);
  }
  return "Finish requested task";
}

function deriveExecutionBlockedObjective(
  deterministicTurn: { state: DeterministicTurnState; receipts: ExecutionReceipt[] },
  matchedTask: ActiveTaskRecord | null,
): string {
  const firstIntent = deterministicTurn.state.intent.envelopes[0];
  if (firstIntent) {
    const serializedEntities = JSON.stringify(firstIntent.entities ?? {});
    return truncate(
      `Complete ${firstIntent.intentId} using the established details: ${serializedEntities}`,
      200,
    );
  }
  if (matchedTask?.objective?.trim()) {
    return matchedTask.objective.trim();
  }
  return "Retry the blocked task using the established details from the conversation.";
}

function tasksLookEquivalent(left: ActiveTaskRecord, right: ActiveTaskRecord): boolean {
  const leftTitle = normalize(left.title);
  const rightTitle = normalize(right.title);
  const leftObjective = normalize(left.objective);
  const rightObjective = normalize(right.objective);

  if (leftTitle && rightTitle && (leftTitle === rightTitle || leftTitle.includes(rightTitle) || rightTitle.includes(leftTitle))) {
    return true;
  }
  if (
    leftObjective
    && rightObjective
    && (leftObjective === rightObjective || leftObjective.includes(rightObjective) || rightObjective.includes(leftObjective))
  ) {
    return true;
  }

  const leftTokens = new Set(tokenize(`${left.title} ${left.objective}`));
  const rightTokens = new Set(tokenize(`${right.title} ${right.objective}`));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return false;
  }
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap >= 4;
}

function findSupersededExecutionBlockedTasks(
  existingTasks: readonly ActiveTaskRecord[],
  resolvedTask: ActiveTaskRecord,
  deterministicTurn: { state: DeterministicTurnState; receipts: ExecutionReceipt[] },
): ActiveTaskRecord[] {
  const intentIds = new Set(deterministicTurn.state.intent.envelopes.map((intent) => intent.intentId));
  const workerIds = new Set(
    deterministicTurn.receipts
      .map((receipt) => receipt.workerId)
      .filter((workerId): workerId is string => typeof workerId === "string" && workerId.trim().length > 0),
  );

  return existingTasks.filter((task) => {
    if (task.id === resolvedTask.id) {
      return false;
    }
    if (task.status !== "blocked" || task.sourceKind !== "execution-blocked") {
      return false;
    }
    if (task.intentIds.length > 0 && !task.intentIds.some((intentId) => intentIds.has(intentId))) {
      return false;
    }
    if (task.ownerWorkerId && workerIds.size > 0 && !workerIds.has(task.ownerWorkerId) && task.ownerWorkerId !== resolvedTask.ownerWorkerId) {
      return false;
    }
    return tasksLookEquivalent(task, resolvedTask);
  });
}

function findDeterministicTaskCandidate(
  existingTasks: readonly ActiveTaskRecord[],
  deterministicTurn: { state: DeterministicTurnState; receipts: ExecutionReceipt[] },
): ActiveTaskRecord | null {
  const intentIds = new Set(deterministicTurn.state.intent.envelopes.map((intent) => intent.intentId));
  const workerIds = new Set(
    deterministicTurn.receipts
      .map((receipt) => receipt.workerId)
      .filter((workerId): workerId is string => typeof workerId === "string" && workerId.trim().length > 0),
  );

  const candidates = existingTasks
    .filter((task) => OPEN_TASK_STATUSES.has(task.status))
    .map((task) => {
      let score = 0;
      if (task.status === "blocked") {
        score += 4;
      }
      if (task.sourceKind === "execution-blocked") {
        score += 4;
      }
      if (task.intentIds.some((intentId) => intentIds.has(intentId))) {
        score += 6;
      }
      if (task.ownerWorkerId && workerIds.has(task.ownerWorkerId)) {
        score += 4;
      }
      return { task, score };
    })
    .filter((candidate) => candidate.score >= 8)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return right.task.updatedAt.localeCompare(left.task.updatedAt);
    });

  return candidates[0]?.task ?? null;
}

function buildExecutionBlockedUpsert(input: {
  sessionId: string;
  agentId: string;
  requestMessageId?: number | null;
  responseMessageId?: number | null;
  matchedTask?: ActiveTaskRecord | null;
  userMessage: string;
  responseText: string;
  deterministicTurn: {
    state: DeterministicTurnState;
    receipts: ExecutionReceipt[];
  };
}): ActiveTaskUpsertInput {
  const firstIntent = input.deterministicTurn.state.intent.envelopes[0];
  const blockingReceipt =
    input.deterministicTurn.receipts.find((receipt) => receiptNeedsFollowUp(receipt)) ??
    input.deterministicTurn.receipts[0];

  return {
    id: input.matchedTask?.id,
    sessionId: input.sessionId,
    agentId: input.agentId,
    status: "blocked",
    title: deriveExecutionBlockedTitle(input.deterministicTurn, input.matchedTask ?? null),
    objective: deriveExecutionBlockedObjective(input.deterministicTurn, input.matchedTask ?? null),
    ownerWorkerId:
      blockingReceipt?.workerId ??
      input.matchedTask?.ownerWorkerId ??
      null,
    intentIds:
      input.deterministicTurn.state.intent.envelopes.map((intent) => intent.intentId) ??
      input.matchedTask?.intentIds ??
      [],
    missingSlots: [],
    clarificationQuestion: null,
    suggestedNextAction: "Retry or repair the blocked work using the established details from this conversation.",
    structuredContext: {
      ...(input.matchedTask?.structuredContext ?? {}),
      source: "execution-blocked",
      routeOutcome: input.deterministicTurn.state.routing.routeOutcome,
      latestUserMessage: input.userMessage,
      latestAssistantResponse: truncate(input.responseText, 320),
      latestResolvedEntities: firstIntent?.entities ?? {},
      blockingWarnings: blockingReceipt?.warnings ?? [],
      blockingIntentId: blockingReceipt?.intentId ?? firstIntent?.intentId ?? null,
      blockingStepId: blockingReceipt?.stepId ?? null,
    },
    sourceKind: "execution-blocked",
    createdByMessageId: input.matchedTask?.createdByMessageId ?? input.responseMessageId ?? null,
    updatedByMessageId: input.responseMessageId ?? null,
    resolvedAt: null,
    expiresAt: futureIso(72),
  };
}

function buildClarificationUpsert(input: {
  sessionId: string;
  agentId: string;
  requestMessageId?: number | null;
  responseMessageId?: number | null;
  matchedTask?: ActiveTaskRecord | null;
  userMessage: string;
  question: string;
  intentIds?: string[];
  missingSlots?: string[];
  ownerWorkerId?: string | null;
  structuredContext?: Record<string, unknown>;
  sourceKind?: string;
}): ActiveTaskUpsertInput {
  return {
    id: input.matchedTask?.id,
    sessionId: input.sessionId,
    agentId: input.agentId,
    status: "awaiting_user",
    title: buildTaskTitleFromQuestion(input.question),
    objective: input.matchedTask?.objective ?? truncate(input.userMessage, 200),
    ownerWorkerId: input.ownerWorkerId ?? input.matchedTask?.ownerWorkerId ?? null,
    intentIds: input.intentIds ?? input.matchedTask?.intentIds ?? [],
    missingSlots: input.missingSlots ?? input.matchedTask?.missingSlots ?? [],
    clarificationQuestion: input.question,
    suggestedNextAction: input.question,
    structuredContext: {
      ...(input.matchedTask?.structuredContext ?? {}),
      ...(input.structuredContext ?? {}),
      latestUserMessage: input.userMessage,
      latestClarificationQuestion: input.question,
    },
    sourceKind: input.sourceKind ?? "clarification",
    createdByMessageId: input.matchedTask?.createdByMessageId ?? input.responseMessageId ?? null,
    updatedByMessageId: input.responseMessageId ?? null,
    expiresAt: futureIso(72),
  };
}

function buildOfferUpsert(input: {
  sessionId: string;
  agentId: string;
  responseMessageId?: number | null;
  userMessage: string;
  responseText: string;
  objective: string;
  structuredContext?: Record<string, unknown>;
}): ActiveTaskUpsertInput {
  return {
    sessionId: input.sessionId,
    agentId: input.agentId,
    status: "awaiting_user",
    title: buildTaskTitleFromObjective(input.objective),
    objective: input.objective,
    intentIds: [],
    missingSlots: [],
    clarificationQuestion: input.responseText.trim().endsWith("?") ? truncate(input.responseText.trim(), 240) : null,
    suggestedNextAction: `Confirm whether to proceed: ${truncate(input.objective, 120)}`,
    structuredContext: {
      source: "assistant-offer",
      latestUserMessage: input.userMessage,
      assistantOffer: input.responseText,
      ...(input.structuredContext ?? {}),
    },
    sourceKind: "assistant-offer",
    createdByMessageId: input.responseMessageId ?? null,
    updatedByMessageId: input.responseMessageId ?? null,
    expiresAt: futureIso(72),
  };
}

export function buildActiveTaskPersistencePlan(input: {
  sessionId: string;
  agentId: string;
  userMessage: string;
  responseText: string;
  existingTasks: readonly ActiveTaskRecord[];
  continuation: ActiveTaskContinuationResolution;
  deterministicTurn?: {
    state: DeterministicTurnState;
    receipts: ExecutionReceipt[];
  };
  requestMessageId?: number | null;
  responseMessageId?: number | null;
}): ActiveTaskPersistencePlan {
  const upserts: ActiveTaskUpsertInput[] = [];
  const statusUpdates: ActiveTaskStatusUpdateInput[] = [];
  const matchedTask = input.continuation.matchedTask;

  if (input.continuation.kind === "cancel" && matchedTask) {
    statusUpdates.push({
      id: matchedTask.id,
      status: "canceled",
      updatedByMessageId: input.requestMessageId ?? null,
      resolvedAt: new Date().toISOString(),
    });
    return { upserts, statusUpdates };
  }

  const deterministicTurn = input.deterministicTurn;
  if (deterministicTurn) {
    const resolvedTask = matchedTask ?? findDeterministicTaskCandidate(input.existingTasks, deterministicTurn);
    const intentIds = deterministicTurn.state.intent.envelopes.map((intent) => intent.intentId);
    const ownerWorkerId =
      deterministicTurn.receipts[0]?.workerId ??
      resolvedTask?.ownerWorkerId ??
      null;

    if (deterministicTurn.state.routing.routeOutcome === "clarification") {
      const question =
        deterministicTurn.receipts.find((receipt) => receipt.clarification)?.clarification ??
        input.responseText.trim();
      upserts.push(
        buildClarificationUpsert({
          sessionId: input.sessionId,
          agentId: input.agentId,
          requestMessageId: input.requestMessageId,
          responseMessageId: input.responseMessageId,
          matchedTask: resolvedTask,
          userMessage: input.userMessage,
          question,
          intentIds,
          missingSlots: [...new Set(deterministicTurn.state.intent.envelopes.flatMap((intent) => intent.missingSlots))],
          ownerWorkerId,
          structuredContext: {
            routeOutcome: deterministicTurn.state.routing.routeOutcome,
          },
        }),
      );
      return { upserts, statusUpdates };
    }

    const receiptClarification = deterministicTurn.receipts.find((receipt) => typeof receipt.clarification === "string");
    if (receiptClarification?.clarification) {
      upserts.push(
        buildClarificationUpsert({
          sessionId: input.sessionId,
          agentId: input.agentId,
          requestMessageId: input.requestMessageId,
          responseMessageId: input.responseMessageId,
          matchedTask: resolvedTask,
          userMessage: input.userMessage,
          question: receiptClarification.clarification,
          intentIds: [receiptClarification.intentId],
          ownerWorkerId: receiptClarification.workerId,
          structuredContext: {
            routeOutcome: deterministicTurn.state.routing.routeOutcome,
            stepId: receiptClarification.stepId,
          },
          sourceKind: "worker-clarification",
        }),
      );
      return { upserts, statusUpdates };
    }

    const executionNeedsFollowUp =
      deterministicTurn.state.routing.routeOutcome === "executed"
      && deterministicTurn.receipts.some((receipt) => receiptNeedsFollowUp(receipt))
      && (
        deterministicTurn.receipts.some((receipt) => receipt.hasWriteOperations || receipt.mode !== "read")
        || responseSuggestsUnverifiedWrite(input.responseText)
      )
      && !(
        resolvedTask
        && deterministicTurn.receipts.some((receipt) => receiptHasConfirmedWriteOutcome(receipt))
        && !responseSuggestsUnverifiedWrite(input.responseText)
      );

    if (executionNeedsFollowUp) {
      upserts.push(
        buildExecutionBlockedUpsert({
          sessionId: input.sessionId,
          agentId: input.agentId,
          requestMessageId: input.requestMessageId,
          responseMessageId: input.responseMessageId,
          matchedTask: resolvedTask,
          userMessage: input.userMessage,
          responseText: input.responseText,
          deterministicTurn,
        }),
      );
      return { upserts, statusUpdates };
    }

    if (
      resolvedTask &&
      deterministicTurn.state.routing.routeOutcome === "executed" &&
      deterministicTurn.receipts.some((receipt) => receipt.status === "completed")
    ) {
      statusUpdates.push({
        id: resolvedTask.id,
        status: "completed",
        updatedByMessageId: input.responseMessageId ?? null,
        structuredContext: {
          ...(resolvedTask.structuredContext ?? {}),
          completedByResponseMessageId: input.responseMessageId ?? null,
          completionRouteOutcome: deterministicTurn.state.routing.routeOutcome,
        },
        resolvedAt: new Date().toISOString(),
      });
      for (const supersededTask of findSupersededExecutionBlockedTasks(input.existingTasks, resolvedTask, deterministicTurn)) {
        statusUpdates.push({
          id: supersededTask.id,
          status: "superseded",
          updatedByMessageId: input.responseMessageId ?? null,
          structuredContext: {
            ...(supersededTask.structuredContext ?? {}),
            supersededByTaskId: resolvedTask.id,
            supersededByResponseMessageId: input.responseMessageId ?? null,
            supersededReason: "A later deterministic repair completed the same blocked task lineage.",
          },
          resolvedAt: new Date().toISOString(),
        });
      }
      return { upserts, statusUpdates };
    }
  }

  if (matchedTask) {
    const clarificationQuestion = extractClarificationQuestion(input.responseText);
    if (clarificationQuestion) {
      upserts.push(
        buildClarificationUpsert({
          sessionId: input.sessionId,
          agentId: input.agentId,
          requestMessageId: input.requestMessageId,
          responseMessageId: input.responseMessageId,
          matchedTask,
          userMessage: input.userMessage,
          question: clarificationQuestion,
          structuredContext: {
            source: "assistant-followup-question",
          },
        }),
      );
      return { upserts, statusUpdates };
    }

    statusUpdates.push({
      id: matchedTask.id,
      status: "completed",
      updatedByMessageId: input.responseMessageId ?? null,
      structuredContext: {
        ...(matchedTask.structuredContext ?? {}),
        completedByResponseMessageId: input.responseMessageId ?? null,
        completionSource: "assistant-response",
      },
      resolvedAt: new Date().toISOString(),
    });
    return { upserts, statusUpdates };
  }

  const assistantOfferObjective = extractOfferObjective(input.responseText);
  if (assistantOfferObjective) {
    const latestResolvedEntities = deterministicTurn?.state.intent.envelopes[0]?.entities;
    upserts.push(
      buildOfferUpsert({
        sessionId: input.sessionId,
        agentId: input.agentId,
        responseMessageId: input.responseMessageId,
        userMessage: input.userMessage,
        responseText: input.responseText,
        objective: assistantOfferObjective,
        structuredContext: deterministicTurn
          ? {
              routeOutcome: deterministicTurn.state.routing.routeOutcome,
              latestResolvedEntities: latestResolvedEntities ?? {},
            }
          : undefined,
      }),
    );
    return { upserts, statusUpdates };
  }

  const clarificationQuestion = extractClarificationQuestion(input.responseText);
  if (clarificationQuestion) {
    upserts.push(
      buildClarificationUpsert({
        sessionId: input.sessionId,
        agentId: input.agentId,
        requestMessageId: input.requestMessageId,
        responseMessageId: input.responseMessageId,
        userMessage: input.userMessage,
        question: clarificationQuestion,
        intentIds: deterministicTurn?.state.intent.envelopes.map((intent) => intent.intentId) ?? [],
        ownerWorkerId:
          deterministicTurn?.receipts.find((receipt) => receipt.status === "completed")?.workerId ?? null,
        structuredContext: {
          source: deterministicTurn ? "assistant-deterministic-clarification" : "assistant-clarification",
          routeOutcome: deterministicTurn?.state.routing.routeOutcome,
          latestResolvedEntities: deterministicTurn?.state.intent.envelopes[0]?.entities ?? {},
          latestAssistantResponse: truncate(input.responseText, 320),
        },
        sourceKind: deterministicTurn
          ? "assistant-deterministic-clarification"
          : "assistant-clarification",
      }),
    );
  }

  return { upserts, statusUpdates };
}
