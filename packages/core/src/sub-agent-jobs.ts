import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeResponse } from "./agent-runtime.js";
import type { AgentCollaborationService } from "./agent-collaboration.js";
import type {
  MessageInsertInput,
  StoredMessageRecord,
  SubAgentArtifactInsertInput,
  SubAgentArtifactRecord,
  SubAgentChildKind,
  SubAgentChildRunRecord,
  SubAgentChildRunUpdateInput,
  SubAgentChildStatus,
  SubAgentJobEventInsertInput,
  SubAgentJobEventRecord,
  SubAgentJobInitiatorKind,
  SubAgentJobRecord,
  SubAgentJobStatus,
  SubAgentJobVisibilityMode,
  TangoStorage,
} from "./storage.js";

const DEFAULT_MAX_CHILDREN = 6;
const DEFAULT_MAX_PARALLEL = 3;
const DEFAULT_MAX_DURATION_MINUTES = 45;

const ACTIVE_JOB_STATUSES = new Set<SubAgentJobStatus>([
  "queued",
  "running",
  "waiting_on_user",
  "blocked",
  "canceling",
]);

const TERMINAL_CHILD_STATUSES = new Set<SubAgentChildStatus>([
  "completed",
  "failed",
  "waiting_on_user",
  "blocked",
  "canceled",
  "expired",
]);

export interface SubAgentJobBudget {
  maxChildren?: number;
  maxParallel?: number;
  maxDurationMinutes?: number;
  maxDurationSeconds?: number;
}

export interface SubAgentJobNotificationPolicy {
  mode?: "coordinator_mediated";
  periodicAfterMinutes?: number;
  notifyOn?: string[];
}

export interface SubAgentJobChildInput {
  id?: string;
  kind: SubAgentChildKind;
  task: string;
  agentId?: string | null;
  workerId?: string | null;
  providerName?: string | null;
  model?: string | null;
  conversationKey?: string | null;
  tools?: string[];
  toolIds?: string[];
  dependsOn?: string[];
  metadata?: Record<string, unknown> | null;
}

export interface StartSubAgentJobInput {
  id?: string;
  parentJobId?: string | null;
  coordinatorAgentId: string;
  initiatorKind?: SubAgentJobInitiatorKind;
  initiatorRef?: string | null;
  userSurface?: Record<string, unknown>;
  objective: string;
  children: SubAgentJobChildInput[];
  priority?: number;
  visibilityMode?: SubAgentJobVisibilityMode;
  notificationPolicy?: SubAgentJobNotificationPolicy & Record<string, unknown>;
  budget?: SubAgentJobBudget & Record<string, unknown>;
  policyDecision?: Record<string, unknown> | null;
  expiresAt?: string | null;
  capabilityCeilingToolIds?: string[] | null;
  autoStart?: boolean;
}

export interface SubAgentChildExecution {
  job: SubAgentJobRecord;
  child: SubAgentChildRunRecord;
  signal?: AbortSignal;
}

export interface SubAgentChildExecutionResult {
  status?: Extract<SubAgentChildStatus, "completed" | "waiting_on_user" | "blocked" | "failed">;
  resultSummary?: string | null;
  error?: string | null;
  providerName?: string | null;
  model?: string | null;
  costEstimateUsd?: number | null;
  metadata?: Record<string, unknown> | null;
  artifacts?: Array<Omit<SubAgentArtifactInsertInput, "jobId" | "childRunId">>;
  events?: Array<Omit<SubAgentJobEventInsertInput, "jobId" | "childRunId">>;
}

export type SubAgentChildExecutor = (input: SubAgentChildExecution) => Promise<SubAgentChildExecutionResult>;

export interface SubAgentChildExecutors {
  worker?: SubAgentChildExecutor;
  namedAgent?: SubAgentChildExecutor;
  collaborator?: SubAgentChildExecutor;
  externalSession?: SubAgentChildExecutor;
}

export interface SubAgentJobSnapshot {
  job: SubAgentJobRecord;
  children: SubAgentChildRunRecord[];
  events: SubAgentJobEventRecord[];
  artifacts: SubAgentArtifactRecord[];
}

export interface SubAgentJobStartResult extends SubAgentJobSnapshot {
  jobId: string;
  childRunIds: string[];
}

export interface SubAgentJobNotificationDigest {
  shouldNotify: boolean;
  reason?: "completed" | "failed" | "waiting_on_user" | "blocked" | "artifact_ready" | "periodic";
  severity: "info" | "warning" | "error";
  digest: string;
}

export interface SubAgentCoordinatorUpdateInput {
  message: string;
  visibleMessageRef?: string | null;
  discordMessageId?: string | null;
  metadata?: Record<string, unknown> | null;
  recordMessage?: boolean;
}

type SubAgentJobStorage = Pick<
  TangoStorage,
  | "insertSubAgentJob"
  | "updateSubAgentJob"
  | "getSubAgentJob"
  | "listSubAgentJobs"
  | "insertSubAgentChildRun"
  | "updateSubAgentChildRun"
  | "getSubAgentChildRun"
  | "listSubAgentChildRuns"
  | "insertSubAgentJobEvent"
  | "listSubAgentJobEvents"
  | "insertSubAgentArtifact"
  | "listSubAgentArtifacts"
> & {
  insertMessage?: (input: MessageInsertInput) => number;
};

export interface SubAgentJobServiceOptions {
  storage: SubAgentJobStorage;
  executors?: SubAgentChildExecutors;
  now?: () => Date;
  autoStart?: boolean;
}

export function normalizeSubAgentJobObjective(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ").slice(0, 500);
}

export function buildSubAgentChildConversationKey(
  jobId: string,
  childId: string,
  agentOrWorkerId: string,
): string {
  return `subagent-job:${jobId}:${childId}:${agentOrWorkerId}`;
}

function normalizeString(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringList(value: string[] | undefined): string[] {
  const output = new Set<string>();
  for (const item of value ?? []) {
    const normalized = normalizeString(item);
    if (normalized) output.add(normalized);
  }
  return [...output];
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.trunc(value as number));
}

function resolveBudget(input: StartSubAgentJobInput): Required<SubAgentJobBudget> {
  const requested = input.budget ?? {};
  const maxDurationMinutes =
    requested.maxDurationMinutes
    ?? (requested.maxDurationSeconds ? Math.ceil(requested.maxDurationSeconds / 60) : undefined)
    ?? DEFAULT_MAX_DURATION_MINUTES;

  return {
    maxChildren: positiveInteger(requested.maxChildren, DEFAULT_MAX_CHILDREN),
    maxParallel: positiveInteger(requested.maxParallel, DEFAULT_MAX_PARALLEL),
    maxDurationMinutes: positiveInteger(maxDurationMinutes, DEFAULT_MAX_DURATION_MINUTES),
    maxDurationSeconds: positiveInteger(requested.maxDurationSeconds, maxDurationMinutes * 60),
  };
}

function resolveJobExpiresAt(input: StartSubAgentJobInput, budget: Required<SubAgentJobBudget>, now: Date): string {
  if (input.expiresAt) {
    return input.expiresAt;
  }
  return new Date(now.getTime() + budget.maxDurationSeconds * 1000).toISOString();
}

function eventForChildStatus(status: SubAgentChildStatus): string {
  switch (status) {
    case "completed":
      return "child_completed";
    case "waiting_on_user":
    case "blocked":
      return "child_blocked";
    case "canceled":
      return "canceled";
    case "expired":
      return "expired";
    default:
      return "child_failed";
  }
}

function eventForJobStatus(status: SubAgentJobStatus): string {
  switch (status) {
    case "completed":
      return "job_completed";
    case "waiting_on_user":
      return "job_waiting_on_user";
    case "blocked":
      return "job_blocked";
    case "canceled":
      return "canceled";
    case "expired":
      return "expired";
    default:
      return "job_failed";
  }
}

function severityForStatus(status: SubAgentJobStatus | SubAgentChildStatus): "info" | "warning" | "error" {
  if (status === "failed" || status === "expired") return "error";
  if (status === "waiting_on_user" || status === "blocked" || status === "canceled") return "warning";
  return "info";
}

function summarizeChildren(children: SubAgentChildRunRecord[]): string {
  const completed = children.filter((child) => child.status === "completed").length;
  const failed = children.filter((child) => child.status === "failed").length;
  const waiting = children.filter((child) => child.status === "waiting_on_user").length;
  const blocked = children.filter((child) => child.status === "blocked").length;
  return `${completed}/${children.length} child runs completed`
    + (failed ? `; ${failed} failed` : "")
    + (waiting ? `; ${waiting} waiting on user` : "")
    + (blocked ? `; ${blocked} blocked` : "");
}

function deriveJobStatus(children: SubAgentChildRunRecord[]): SubAgentJobStatus {
  if (children.some((child) => child.status === "waiting_on_user")) {
    return "waiting_on_user";
  }
  if (children.some((child) => child.status === "blocked")) {
    return "blocked";
  }
  if (children.some((child) => child.status === "failed" || child.status === "expired")) {
    return "failed";
  }
  if (children.length > 0 && children.every((child) => child.status === "canceled")) {
    return "canceled";
  }
  return "completed";
}

function isTerminalChild(child: SubAgentChildRunRecord): boolean {
  return TERMINAL_CHILD_STATUSES.has(child.status);
}

function mergeMetadata(
  current: Record<string, unknown> | null,
  next: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!current && !next) {
    return null;
  }
  return {
    ...(current ?? {}),
    ...(next ?? {}),
  };
}

export class SubAgentJobService {
  private readonly storage: SubAgentJobStorage;
  private readonly executors: SubAgentChildExecutors;
  private readonly now: () => Date;
  private readonly autoStart: boolean;
  private readonly activeRuns = new Map<string, Promise<SubAgentJobSnapshot>>();

  constructor(options: SubAgentJobServiceOptions) {
    this.storage = options.storage;
    this.executors = options.executors ?? {};
    this.now = options.now ?? (() => new Date());
    this.autoStart = options.autoStart ?? true;
  }

  async startJob(input: StartSubAgentJobInput): Promise<SubAgentJobStartResult> {
    const objective = normalizeString(input.objective);
    if (!objective) {
      throw new Error("Sub-agent job objective is required.");
    }
    const coordinatorAgentId = normalizeString(input.coordinatorAgentId);
    if (!coordinatorAgentId) {
      throw new Error("Sub-agent job coordinatorAgentId is required.");
    }
    if (!Array.isArray(input.children) || input.children.length === 0) {
      throw new Error("Sub-agent job requires at least one child run.");
    }

    const budget = resolveBudget(input);
    if (input.children.length > budget.maxChildren) {
      throw new Error(
        `Sub-agent job exceeds maxChildren (${budget.maxChildren}); requested=${input.children.length}.`,
      );
    }

    const normalizedChildren = this.normalizeChildren(input.children, input.capabilityCeilingToolIds);
    const createdAt = this.now();
    const jobId = this.storage.insertSubAgentJob({
      id: input.id,
      parentJobId: input.parentJobId,
      coordinatorAgentId,
      initiatorKind: input.initiatorKind ?? "agent",
      initiatorRef: input.initiatorRef,
      userSurface: input.userSurface ?? {},
      objective,
      normalizedObjective: normalizeSubAgentJobObjective(objective),
      status: "queued",
      priority: input.priority,
      visibilityMode: input.visibilityMode ?? "summary",
      notificationPolicy: {
        mode: "coordinator_mediated",
        periodicAfterMinutes: 10,
        notifyOn: ["blocked", "failed", "artifact_ready", "completed"],
        ...(input.notificationPolicy ?? {}),
      },
      budget,
      policyDecision: input.policyDecision ?? {
        granted: true,
        reason: "granted",
        maxParallel: budget.maxParallel,
        workerCapability: input.capabilityCeilingToolIds ? "inherited_ceiling_enforced" : "not_supplied",
      },
      expiresAt: resolveJobExpiresAt(input, budget, createdAt),
    });

    const childRunIds = normalizedChildren.map((child) => this.storage.insertSubAgentChildRun({
      id: child.id,
      jobId,
      kind: child.kind,
      agentId: child.agentId,
      workerId: child.workerId,
      providerName: child.providerName,
      model: child.model,
      conversationKey: child.conversationKey
        ?? (
          child.kind === "named_agent" && (child.agentId ?? child.workerId)
            ? buildSubAgentChildConversationKey(jobId, child.id, child.agentId ?? child.workerId ?? "unknown")
            : null
        ),
      task: child.task,
      dependsOn: child.dependsOn,
      toolIds: child.toolIds,
      status: "queued",
      metadata: child.metadata,
    }));

    this.storage.insertSubAgentJobEvent({
      jobId,
      eventType: "job_queued",
      severity: "info",
      title: "Sub-agent job queued",
      structured: { childRunIds },
    });

    const shouldAutoStart = input.autoStart ?? this.autoStart;
    if (shouldAutoStart) {
      void this.runJob(jobId);
    }

    const snapshot = this.getJobSnapshot(jobId);
    return {
      ...snapshot,
      jobId,
      childRunIds,
    };
  }

  async runJob(jobId: string): Promise<SubAgentJobSnapshot> {
    const existing = this.activeRuns.get(jobId);
    if (existing) {
      return existing;
    }

    const run = this.executeJob(jobId)
      .finally(() => {
        this.activeRuns.delete(jobId);
      });
    this.activeRuns.set(jobId, run);
    return run;
  }

  getJobSnapshot(jobId: string): SubAgentJobSnapshot {
    const job = this.storage.getSubAgentJob(jobId);
    if (!job) {
      throw new Error(`Sub-agent job not found: ${jobId}`);
    }
    return {
      job,
      children: this.storage.listSubAgentChildRuns(jobId),
      events: this.storage.listSubAgentJobEvents(jobId, 500),
      artifacts: this.storage.listSubAgentArtifacts(jobId),
    };
  }

  listJobs(options?: Parameters<SubAgentJobStorage["listSubAgentJobs"]>[0]): SubAgentJobRecord[] {
    return this.storage.listSubAgentJobs(options ?? {});
  }

  cancelJob(jobId: string): SubAgentJobSnapshot {
    const job = this.storage.getSubAgentJob(jobId);
    if (!job) {
      throw new Error(`Sub-agent job not found: ${jobId}`);
    }
    if (!ACTIVE_JOB_STATUSES.has(job.status)) {
      return this.getJobSnapshot(jobId);
    }

    this.storage.updateSubAgentJob(jobId, {
      status: "canceled",
      error: "canceled",
    });
    for (const child of this.storage.listSubAgentChildRuns(jobId)) {
      if (!isTerminalChild(child)) {
        this.storage.updateSubAgentChildRun(child.id, {
          status: "canceled",
          finishedAt: this.now().toISOString(),
          error: "canceled",
        });
      }
    }
    this.storage.insertSubAgentJobEvent({
      jobId,
      eventType: "canceled",
      severity: "warning",
      title: "Sub-agent job canceled",
    });
    return this.getJobSnapshot(jobId);
  }

  recordCoordinatorUpdate(jobId: string, input: SubAgentCoordinatorUpdateInput): {
    eventId: string;
    messageRecordId?: number;
    visibleMessageRef: string | null;
  } {
    const job = this.storage.getSubAgentJob(jobId);
    if (!job) {
      throw new Error(`Sub-agent job not found: ${jobId}`);
    }

    let messageRecordId: number | undefined;
    let visibleMessageRef = input.visibleMessageRef ?? null;
    const shouldRecordMessage = input.recordMessage ?? true;
    if (shouldRecordMessage && this.storage.insertMessage && typeof job.userSurface.session_id === "string") {
      const channelId = typeof job.userSurface.thread_id === "string"
        ? job.userSurface.thread_id
        : typeof job.userSurface.channel_id === "string"
          ? job.userSurface.channel_id
          : null;
      const messageInput: MessageInsertInput = {
        sessionId: job.userSurface.session_id,
        agentId: job.coordinatorAgentId,
        direction: "outbound",
        source: "tango",
        visibility: "public",
        discordMessageId: input.discordMessageId ?? null,
        discordChannelId: channelId,
        content: input.message,
        metadata: {
          ...(input.metadata ?? {}),
          subAgentJobId: jobId,
        },
      };
      messageRecordId = this.storage.insertMessage(messageInput);
      visibleMessageRef = visibleMessageRef ?? `message:${messageRecordId}`;
    }

    const eventId = this.storage.insertSubAgentJobEvent({
      jobId,
      eventType: "notification_sent",
      severity: "info",
      title: "Coordinator update recorded",
      body: input.message,
      visibleMessageRef,
      structured: {
        ...(input.metadata ?? {}),
        messageRecordId: messageRecordId ?? null,
      },
    });

    return {
      eventId,
      messageRecordId,
      visibleMessageRef,
    };
  }

  private normalizeChildren(
    children: SubAgentJobChildInput[],
    capabilityCeilingToolIds: string[] | null | undefined,
  ): Array<Required<Pick<SubAgentJobChildInput, "kind" | "task">> & {
    id: string;
    agentId: string | null;
    workerId: string | null;
    providerName: string | null;
    model: string | null;
    conversationKey: string | null;
    dependsOn: string[];
    toolIds: string[];
    metadata: Record<string, unknown> | null;
  }> {
    const ids = new Set<string>();
    const ceiling = capabilityCeilingToolIds
      ? new Set(normalizeStringList(capabilityCeilingToolIds))
      : null;

    return children.map((child, index) => {
      const id = normalizeString(child.id) || `child-${index + 1}`;
      if (ids.has(id)) {
        throw new Error(`Duplicate sub-agent child id: ${id}`);
      }
      ids.add(id);

      const task = normalizeString(child.task);
      if (!task) {
        throw new Error(`Sub-agent child '${id}' task is required.`);
      }

      const toolIds = normalizeStringList(child.toolIds ?? child.tools);
      if (child.kind === "worker" && ceiling) {
        const denied = toolIds.filter((toolId) => !ceiling.has(toolId));
        if (denied.length > 0) {
          throw new Error(
            `Worker child '${id}' requests tools outside coordinator capability ceiling: ${denied.join(", ")}`,
          );
        }
      }

      return {
        id,
        kind: child.kind,
        task,
        agentId: normalizeString(child.agentId) || null,
        workerId: normalizeString(child.workerId) || null,
        providerName: normalizeString(child.providerName) || null,
        model: normalizeString(child.model) || null,
        conversationKey: normalizeString(child.conversationKey) || null,
        dependsOn: normalizeStringList(child.dependsOn),
        toolIds,
        metadata: child.metadata ?? null,
      };
    });
  }

  private async executeJob(jobId: string): Promise<SubAgentJobSnapshot> {
    const job = this.storage.getSubAgentJob(jobId);
    if (!job) {
      throw new Error(`Sub-agent job not found: ${jobId}`);
    }
    if (!ACTIVE_JOB_STATUSES.has(job.status)) {
      return this.getJobSnapshot(jobId);
    }

    this.storage.updateSubAgentJob(jobId, { status: "running" });
    this.storage.insertSubAgentJobEvent({
      jobId,
      eventType: "job_started",
      severity: "info",
      title: "Sub-agent job started",
    });

    try {
      await this.executeChildren(jobId);
      const finalChildren = this.storage.listSubAgentChildRuns(jobId);
      const status = deriveJobStatus(finalChildren);
      const resultSummary = summarizeChildren(finalChildren);
      this.storage.updateSubAgentJob(jobId, {
        status,
        resultSummary,
        error: status === "failed" ? resultSummary : null,
      });
      this.storage.insertSubAgentJobEvent({
        jobId,
        eventType: eventForJobStatus(status),
        severity: severityForStatus(status),
        title: `Sub-agent job ${status}`,
        body: resultSummary,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.storage.updateSubAgentJob(jobId, {
        status: "failed",
        error: message,
      });
      this.storage.insertSubAgentJobEvent({
        jobId,
        eventType: "job_failed",
        severity: "error",
        title: "Sub-agent job failed",
        body: message,
      });
    }

    return this.getJobSnapshot(jobId);
  }

  private async executeChildren(jobId: string): Promise<void> {
    const job = this.storage.getSubAgentJob(jobId);
    if (!job) {
      throw new Error(`Sub-agent job not found: ${jobId}`);
    }

    const maxParallel = positiveInteger(
      typeof job.budget.maxParallel === "number" ? job.budget.maxParallel : undefined,
      DEFAULT_MAX_PARALLEL,
    );
    const children = this.storage.listSubAgentChildRuns(jobId);
    const indexById = new Map(children.map((child, index) => [child.id, index] as const));
    const current = [...children];
    const started = new Set<string>();
    const active = new Map<string, Promise<void>>();

    const dependencyState = (child: SubAgentChildRunRecord): { ready: boolean; failure?: string } => {
      for (const dependencyId of child.dependsOn) {
        const index = indexById.get(dependencyId);
        if (index === undefined) {
          return { ready: true, failure: `Dependency '${dependencyId}' is not part of this job.` };
        }
        const dependency = current[index];
        if (!dependency || !isTerminalChild(dependency)) {
          return { ready: false };
        }
        if (dependency.status !== "completed") {
          return { ready: true, failure: `Dependency '${dependencyId}' did not complete successfully.` };
        }
      }
      return { ready: true };
    };

    const refreshChild = (childId: string): void => {
      const index = indexById.get(childId);
      const latest = this.storage.getSubAgentChildRun(childId);
      if (index !== undefined && latest) {
        current[index] = latest;
      }
    };

    const markBlockedByDependency = (): boolean => {
      let changed = false;
      for (const child of current) {
        if (started.has(child.id) || isTerminalChild(child)) continue;
        const state = dependencyState(child);
        if (!state.ready || !state.failure) continue;
        started.add(child.id);
        this.storage.updateSubAgentChildRun(child.id, {
          status: "failed",
          finishedAt: this.now().toISOString(),
          error: state.failure,
        });
        this.storage.insertSubAgentJobEvent({
          jobId,
          childRunId: child.id,
          eventType: "child_failed",
          severity: "error",
          title: `Child run ${child.id} failed`,
          body: state.failure,
        });
        refreshChild(child.id);
        changed = true;
      }
      return changed;
    };

    const nextRunnable = (): SubAgentChildRunRecord | null => {
      for (const child of current) {
        if (started.has(child.id) || isTerminalChild(child)) continue;
        const state = dependencyState(child);
        if (state.ready && !state.failure) {
          return child;
        }
      }
      return null;
    };

    while (current.some((child) => !isTerminalChild(child))) {
      markBlockedByDependency();

      while (active.size < maxParallel) {
        const child = nextRunnable();
        if (!child) break;
        started.add(child.id);
        const promise = this.executeChild(job, child)
          .then(() => {
            refreshChild(child.id);
          })
          .finally(() => {
            active.delete(child.id);
          });
        active.set(child.id, promise);
      }

      if (active.size === 0) {
        markBlockedByDependency();
        if (current.some((child) => !isTerminalChild(child))) {
          throw new Error("Sub-agent job has queued children but no runnable child; check dependency graph.");
        }
        break;
      }

      await Promise.race(active.values());
    }
  }

  private async executeChild(
    job: SubAgentJobRecord,
    child: SubAgentChildRunRecord,
  ): Promise<void> {
    const startedMs = Date.now();
    const startedAt = this.now().toISOString();
    this.storage.updateSubAgentChildRun(child.id, {
      status: "running",
      startedAt,
      heartbeatAt: startedAt,
    });
    this.storage.insertSubAgentJobEvent({
      jobId: job.id,
      childRunId: child.id,
      eventType: "child_started",
      severity: "info",
      title: `Child run ${child.id} started`,
      structured: {
        kind: child.kind,
        agentId: child.agentId,
        workerId: child.workerId,
        toolIds: child.toolIds,
      },
    });

    try {
      const executor = this.resolveExecutor(child.kind);
      const result = await executor({ job, child: this.storage.getSubAgentChildRun(child.id) ?? child });
      const status = result.status ?? "completed";
      const finishedAt = this.now().toISOString();
      const durationMs = Math.max(0, Date.now() - startedMs);
      const update: SubAgentChildRunUpdateInput = {
        status,
        providerName: result.providerName === undefined ? child.providerName : result.providerName,
        model: result.model === undefined ? child.model : result.model,
        finishedAt,
        heartbeatAt: finishedAt,
        durationMs,
        costEstimateUsd: result.costEstimateUsd ?? child.costEstimateUsd,
        resultSummary: result.resultSummary ?? null,
        error: status === "failed" ? result.error ?? result.resultSummary ?? "failed" : result.error ?? null,
        metadata: mergeMetadata(child.metadata, result.metadata),
      };
      this.storage.updateSubAgentChildRun(child.id, update);

      for (const artifact of result.artifacts ?? []) {
        this.storage.insertSubAgentArtifact({
          ...artifact,
          jobId: job.id,
          childRunId: child.id,
        });
        this.storage.insertSubAgentJobEvent({
          jobId: job.id,
          childRunId: child.id,
          eventType: "artifact_ready",
          severity: "info",
          title: artifact.title ?? `Artifact ready: ${artifact.artifactType}`,
          body: artifact.summary ?? artifact.uri,
          structured: { uri: artifact.uri, artifactType: artifact.artifactType },
        });
      }

      for (const event of result.events ?? []) {
        this.storage.insertSubAgentJobEvent({
          ...event,
          jobId: job.id,
          childRunId: child.id,
        });
      }

      this.storage.insertSubAgentJobEvent({
        jobId: job.id,
        childRunId: child.id,
        eventType: eventForChildStatus(status),
        severity: severityForStatus(status),
        title: `Child run ${child.id} ${status}`,
        body: result.resultSummary ?? result.error ?? null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const finishedAt = this.now().toISOString();
      this.storage.updateSubAgentChildRun(child.id, {
        status: "failed",
        finishedAt,
        heartbeatAt: finishedAt,
        durationMs: Math.max(0, Date.now() - startedMs),
        error: message,
      });
      this.storage.insertSubAgentJobEvent({
        jobId: job.id,
        childRunId: child.id,
        eventType: "child_failed",
        severity: "error",
        title: `Child run ${child.id} failed`,
        body: message,
      });
    }
  }

  private resolveExecutor(kind: SubAgentChildKind): SubAgentChildExecutor {
    switch (kind) {
      case "worker":
        return this.executors.worker ?? unavailableExecutor("worker");
      case "named_agent":
        return this.executors.namedAgent ?? unavailableExecutor("named_agent");
      case "collaborator":
        return this.executors.collaborator ?? unavailableExecutor("collaborator");
      case "external_session":
        return this.executors.externalSession ?? unavailableExecutor("external_session");
    }
  }
}

function unavailableExecutor(kind: SubAgentChildKind): SubAgentChildExecutor {
  return async () => ({
    status: "failed",
    error: `${kind}_executor_unavailable`,
    resultSummary: `${kind}_executor_unavailable`,
  });
}

export function createRuntimeChildExecutor(input: {
  invoke: (input: {
    agentId: string;
    message: string;
    conversationKey: string;
    timeoutMs?: number;
  }) => Promise<RuntimeResponse>;
}): SubAgentChildExecutor {
  return async ({ job, child }) => {
    const agentId = child.agentId ?? child.workerId;
    if (!agentId) {
      return {
        status: "failed",
        error: "runtime_child_agent_id_required",
      };
    }
    const conversationKey = child.conversationKey ?? `subagent-job:${job.id}:${child.id}:${agentId}`;
    const response = await input.invoke({
      agentId,
      conversationKey,
      message: child.task,
      timeoutMs: typeof job.budget.maxDurationSeconds === "number"
        ? job.budget.maxDurationSeconds * 1000
        : undefined,
    });
    return {
      status: "completed",
      resultSummary: response.text,
      providerName: response.metadata?.providerName as string | undefined,
      model: response.model,
      metadata: {
        durationMs: response.durationMs,
        toolsUsed: response.toolsUsed ?? [],
        responseMetadata: response.metadata ?? null,
      },
    };
  };
}

export function createAgentCollaborationChildExecutor(
  collaborationService: Pick<AgentCollaborationService, "collaborate">,
): SubAgentChildExecutor {
  return async ({ job, child }) => {
    const targetAgentId = child.agentId;
    const purpose = typeof child.metadata?.purpose === "string" ? child.metadata.purpose : "";
    if (!targetAgentId || !purpose) {
      return {
        status: "failed",
        error: "collaborator_child_requires_agentId_and_metadata_purpose",
      };
    }
    const result = await collaborationService.collaborate({
      requesterAgentId: job.coordinatorAgentId,
      targetAgentId,
      purpose,
      objective: child.task,
      contextSummary: typeof child.metadata?.contextSummary === "string" ? child.metadata.contextSummary : undefined,
      deliverable: (
        child.metadata?.deliverable
        && typeof child.metadata.deliverable === "object"
        && !Array.isArray(child.metadata.deliverable)
      )
        ? child.metadata.deliverable as Record<string, unknown>
        : undefined,
      constraints: Array.isArray(child.metadata?.constraints)
        ? child.metadata.constraints.filter((value): value is string => typeof value === "string")
        : undefined,
      visibility: job.visibilityMode,
      budget: (
        child.metadata?.budget
        && typeof child.metadata.budget === "object"
        && !Array.isArray(child.metadata.budget)
      )
        ? child.metadata.budget as Record<string, unknown>
        : undefined,
      initiatorKind: "agent",
      initiatorRef: job.id,
      userSurface: job.userSurface,
    });

    const status: SubAgentChildExecutionResult["status"] =
      result.status === "completed"
        ? "completed"
        : result.status === "waiting_on_user"
          ? "waiting_on_user"
          : "failed";

    return {
      status,
      resultSummary: result.answer ?? result.error ?? null,
      error: status === "failed" ? result.error ?? result.answer ?? "collaboration_failed" : null,
      metadata: {
        collaborationId: result.collaborationId,
        collaborationStatus: result.status,
        policyDecision: result.policyDecision,
        evidence: result.evidence ?? [],
        actionsTaken: result.actionsTaken ?? [],
        actionsNotTaken: result.actionsNotTaken ?? [],
        needsUser: result.needsUser ?? false,
      },
    };
  };
}

export function evaluateSubAgentJobNotification(
  snapshot: SubAgentJobSnapshot,
  now: Date = new Date(),
): SubAgentJobNotificationDigest {
  const notificationEvents = snapshot.events.filter((event) => event.eventType === "notification_sent");
  const lastNotificationAt = notificationEvents.length > 0
    ? Date.parse(notificationEvents[notificationEvents.length - 1]!.createdAt)
    : null;
  const latestStatusEvent = [...snapshot.events]
    .reverse()
    .find((event) => [
      "job_completed",
      "job_failed",
      "job_waiting_on_user",
      "job_blocked",
      "expired",
      "canceled",
    ].includes(event.eventType));
  const statusAfterNotification = latestStatusEvent
    && (!lastNotificationAt || Date.parse(latestStatusEvent.createdAt) > lastNotificationAt);
  const latestArtifactEvent = [...snapshot.events]
    .reverse()
    .find((event) => event.eventType === "artifact_ready");
  const artifactAfterNotification = latestArtifactEvent
    && (!lastNotificationAt || Date.parse(latestArtifactEvent.createdAt) > lastNotificationAt);

  if (snapshot.job.status === "completed" && statusAfterNotification) {
    return buildDigest(snapshot, "completed", "info");
  }
  if (snapshot.job.status === "failed" && statusAfterNotification) {
    return buildDigest(snapshot, "failed", "error");
  }
  if (snapshot.job.status === "waiting_on_user" && statusAfterNotification) {
    return buildDigest(snapshot, "waiting_on_user", "warning");
  }
  if (snapshot.job.status === "blocked" && statusAfterNotification) {
    return buildDigest(snapshot, "blocked", "warning");
  }
  if (artifactAfterNotification) {
    return buildDigest(snapshot, "artifact_ready", "info");
  }

  const periodicAfterMinutes = typeof snapshot.job.notificationPolicy.periodicAfterMinutes === "number"
    ? snapshot.job.notificationPolicy.periodicAfterMinutes
    : null;
  if (periodicAfterMinutes && ACTIVE_JOB_STATUSES.has(snapshot.job.status)) {
    const lastVisibleAt = lastNotificationAt ?? Date.parse(snapshot.job.createdAt);
    if (Number.isFinite(lastVisibleAt) && now.getTime() - lastVisibleAt >= periodicAfterMinutes * 60_000) {
      return buildDigest(snapshot, "periodic", "info");
    }
  }

  return {
    shouldNotify: false,
    severity: "info",
    digest: "",
  };
}

function buildDigest(
  snapshot: SubAgentJobSnapshot,
  reason: Exclude<SubAgentJobNotificationDigest["reason"], undefined>,
  severity: SubAgentJobNotificationDigest["severity"],
): SubAgentJobNotificationDigest {
  const lines = [
    `Job ${snapshot.job.id}: ${snapshot.job.objective}`,
    `Status: ${snapshot.job.status}`,
    `Reason: ${reason}`,
    `Children: ${summarizeChildren(snapshot.children)}`,
  ];
  const artifactCount = snapshot.artifacts.length;
  if (artifactCount > 0) {
    lines.push(`Artifacts: ${artifactCount}`);
  }
  return {
    shouldNotify: true,
    reason,
    severity,
    digest: lines.join("\n"),
  };
}

export function renderSubAgentJobLedgerEntry(snapshot: SubAgentJobSnapshot, timestamp = new Date()): string {
  const statusLabel = snapshot.job.status === "completed" ? "Done" : snapshot.job.status;
  const children = snapshot.children.map((child) =>
    `- ${child.id} (${child.kind}) -- ${child.status}${child.resultSummary ? `: ${child.resultSummary}` : ""}`,
  );
  const artifacts = snapshot.artifacts.map((artifact) =>
    `- ${artifact.title ?? artifact.artifactType}: ${artifact.uri}`,
  );
  const flagged = snapshot.children
    .filter((child) => child.status === "failed" || child.status === "blocked" || child.status === "waiting_on_user")
    .map((child) => `- ${child.id}: ${child.error ?? child.resultSummary ?? child.status}`);

  return [
    `## ${timestamp.toISOString().slice(0, 16).replace("T", " ")} -- Sub-Agent Job`,
    "",
    `**Status:** ${statusLabel} -- ${summarizeChildren(snapshot.children)}`,
    `**Coordinator:** ${snapshot.job.coordinatorAgentId}`,
    `**Summary:** ${snapshot.job.resultSummary ?? snapshot.job.objective}`,
    "",
    "**Children:**",
    ...(children.length > 0 ? children : ["- None"]),
    "",
    "**Artifacts:**",
    ...(artifacts.length > 0 ? artifacts : ["- None"]),
    "",
    "**Flagged:**",
    ...(flagged.length > 0 ? flagged : ["- None"]),
    "",
  ].join("\n");
}

export async function appendSubAgentJobLedgerEntry(input: {
  vaultRoot: string;
  snapshot: SubAgentJobSnapshot;
  timestamp?: Date;
}): Promise<string> {
  const timestamp = input.timestamp ?? new Date();
  const month = timestamp.toISOString().slice(0, 7);
  const dir = path.join(input.vaultRoot, "Records", "Jobs", "SubAgents");
  const filePath = path.join(dir, `${month}.md`);
  await fs.mkdir(dir, { recursive: true });
  const entry = renderSubAgentJobLedgerEntry(input.snapshot, timestamp);
  let prefix = "";
  try {
    await fs.access(filePath);
  } catch {
    prefix = `# Sub-Agent Jobs ${month}\n\n`;
  }
  await fs.appendFile(filePath, `${prefix}${entry}\n`, "utf8");
  return filePath;
}

export type RecordedMessage = StoredMessageRecord;
