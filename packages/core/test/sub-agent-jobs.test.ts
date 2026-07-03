import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentCollaborationService,
  GovernanceChecker,
  SubAgentJobService,
  TangoStorage,
  appendSubAgentJobLedgerEntry,
  createAgentCollaborationChildExecutor,
  evaluateSubAgentJobNotification,
  renderSubAgentJobLedgerEntry,
  type SubAgentChildExecution,
  type V2AgentConfig,
} from "../src/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createStorage(): TangoStorage {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-sub-agent-jobs-"));
  tempDirs.push(dir);
  return new TangoStorage(path.join(dir, "tango.sqlite"));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createAgentConfig(
  id: string,
  responsibilities: V2AgentConfig["responsibilities"],
): V2AgentConfig {
  return {
    id,
    enabled: true,
    displayName: id,
    type: "test",
    systemPromptFile: `agents/assistants/${id}/soul.md`,
    mcpServers: [
      {
        name: "memory",
        command: "node",
        args: ["packages/atlas-memory/dist/index.js"],
      },
    ],
    runtime: {
      mode: "persistent",
      provider: "claude-code-v2",
      model: "claude-sonnet-4-6",
      reasoningEffort: "medium",
      idleTimeoutHours: 24,
      contextResetThreshold: 0.8,
    },
    memory: {
      postTurnExtraction: "disabled",
      extractionModel: "claude-haiku-4-5",
      importanceThreshold: 0.4,
      scheduledReflection: "disabled",
    },
    discord: {
      defaultChannelId: "100000000000000000",
    },
    responsibilities,
  };
}

function createCollaborationConfigs(): Map<string, V2AgentConfig> {
  return new Map([
    [
      "ops",
      createAgentConfig("ops", [
        {
          id: "ops_coordination",
          description: "Coordinate bounded specialist help.",
          collaboration: {
            canRequest: [
              {
                agent: "research",
                purposes: ["source-check"],
              },
            ],
          },
        },
      ]),
    ],
    [
      "research",
      createAgentConfig("research", [
        {
          id: "research_support",
          description: "Fulfill bounded research checks.",
          collaboration: {
            canFulfill: [
              {
                purpose: "source-check",
                maxTurns: 1,
                maxDurationSeconds: 60,
                maxToolCalls: 4,
                visibilityModes: ["summary", "digest"],
              },
            ],
          },
        },
      ]),
    ],
  ]);
}

describe("SubAgentJobService", () => {
  it("seeds sub-agent job tool governance for runtime coordinators", () => {
    const storage = createStorage();
    const governance = new GovernanceChecker(storage.getDatabase());

    expect(governance.hasPermission("worker:watson-ollama", "start_sub_agent_job", "write")).toBe(true);
    expect(governance.hasPermission("worker:watson-ollama", "get_sub_agent_job", "read")).toBe(true);
    expect(governance.hasPermission("agent:victor", "cancel_sub_agent_job", "write")).toBe(true);

    storage.close();
  });

  it("starts a durable fast worker swarm and executes children in parallel under a tool ceiling", async () => {
    const storage = createStorage();
    storage.bootstrapSessions([
      {
        id: "session-1",
        type: "persistent",
        agent: "watson",
        channels: ["discord:thread-1"],
      },
    ]);
    let activeWorkers = 0;
    let maxActiveWorkers = 0;
    let releaseWorkers!: () => void;
    const workerGate = new Promise<void>((resolve) => {
      releaseWorkers = resolve;
    });

    const service = new SubAgentJobService({
      storage,
      executors: {
        worker: async ({ child }: SubAgentChildExecution) => {
          activeWorkers += 1;
          maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
          await workerGate;
          activeWorkers -= 1;
          return {
            status: "completed",
            resultSummary: `done:${child.id}`,
          };
        },
      },
    });

    await expect(service.startJob({
      coordinatorAgentId: "watson",
      objective: "Reject a worker tool outside the parent capability ceiling.",
      capabilityCeilingToolIds: ["memory_search"],
      children: [
        {
          id: "unsafe",
          kind: "worker",
          task: "Try an ungranted browser task.",
          tools: ["browser"],
        },
      ],
      autoStart: false,
    })).rejects.toThrow(/outside coordinator capability ceiling/u);

    const started = await service.startJob({
      coordinatorAgentId: "watson",
      objective: "Run a quick parallel swarm over independent note checks.",
      capabilityCeilingToolIds: ["memory_search"],
      userSurface: {
        kind: "discord",
        channel_id: "chan-1",
        thread_id: "thread-1",
        session_id: "session-1",
      },
      budget: {
        maxChildren: 4,
        maxParallel: 3,
        maxDurationMinutes: 5,
      },
      children: [
        { id: "a", kind: "worker", task: "Check note A.", tools: ["memory_search"] },
        { id: "b", kind: "worker", task: "Check note B.", tools: ["memory_search"] },
        { id: "c", kind: "worker", task: "Check note C.", tools: ["memory_search"] },
        { id: "d", kind: "worker", task: "Check note D.", tools: ["memory_search"], dependsOn: ["a"] },
      ],
    });

    expect(started.jobId).toBeTruthy();
    expect(started.childRunIds).toHaveLength(4);

    await delay(20);
    expect(maxActiveWorkers).toBe(3);

    releaseWorkers();
    const completed = await service.runJob(started.jobId);

    expect(completed.job.status).toBe("completed");
    expect(completed.children.map((child) => child.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    expect(completed.events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["job_started", "child_completed", "job_completed"]),
    );

    const update = service.recordCoordinatorUpdate(started.jobId, {
      message: "The swarm finished.",
    });
    expect(update.messageRecordId).toBeGreaterThan(0);
    expect(storage.listMessagesForSession("session-1", 10)[0]?.metadata).toMatchObject({
      subAgentJobId: started.jobId,
    });
    expect(evaluateSubAgentJobNotification(service.getJobSnapshot(started.jobId))).toMatchObject({
      shouldNotify: false,
    });

    storage.close();
  });

  it("runs a named-agent reasoning clone with a job-scoped conversation key and artifact", async () => {
    const storage = createStorage();
    const service = new SubAgentJobService({
      storage,
      autoStart: false,
      executors: {
        namedAgent: async ({ job, child }) => {
          expect(child.agentId).toBe("sierra");
          expect(child.conversationKey).toBe(`subagent-job:${job.id}:deep-reason:sierra`);
          return {
            status: "completed",
            providerName: "claude-oauth",
            model: "claude-opus-4-8",
            resultSummary: "Path B is lower risk because it reuses scheduler delivery only at the edge.",
            artifacts: [
              {
                artifactType: "obsidian_report",
                title: "Reasoning Branch Report",
                uri: "obsidian://open?vault=main&file=Research%2FSub-Agent%20Reasoning.md",
                summary: "Reasoning branch report for architecture tradeoffs.",
              },
            ],
            metadata: {
              reasoningEffort: "high",
            },
          };
        },
      },
    });

    const started = await service.startJob({
      coordinatorAgentId: "watson",
      objective: "Ask Sierra to reason through the notification architecture tradeoff.",
      children: [
        {
          id: "deep-reason",
          kind: "named_agent",
          agentId: "sierra",
          task: "Evaluate scheduler reuse versus a dedicated job monitor.",
          model: "claude-opus-4-8",
          metadata: {
            reasoningEffort: "high",
          },
        },
      ],
      autoStart: false,
    });

    const completed = await service.runJob(started.jobId);

    expect(completed.job.status).toBe("completed");
    expect(completed.children[0]).toMatchObject({
      kind: "named_agent",
      agentId: "sierra",
      conversationKey: `subagent-job:${started.jobId}:deep-reason:sierra`,
      providerName: "claude-oauth",
      model: "claude-opus-4-8",
    });
    expect(completed.artifacts).toHaveLength(1);
    expect(completed.events.map((event) => event.eventType)).toContain("artifact_ready");
    expect(evaluateSubAgentJobNotification(completed)).toMatchObject({
      shouldNotify: true,
      reason: "completed",
    });
    expect(renderSubAgentJobLedgerEntry(completed)).toContain("**Artifacts:**");
    const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tango-sub-agent-vault-"));
    tempDirs.push(vaultRoot);
    const ledgerPath = await appendSubAgentJobLedgerEntry({
      vaultRoot,
      snapshot: completed,
      timestamp: new Date("2026-07-02T09:14:00.000Z"),
    });
    expect(ledgerPath).toBe(path.join(vaultRoot, "Records", "Jobs", "SubAgents", "2026-07.md"));
    expect(fs.readFileSync(ledgerPath, "utf8")).toContain("## 2026-07-02 09:14 -- Sub-Agent Job");

    storage.close();
  });

  it("runs collaborator children through AgentCollaborationService policy", async () => {
    const storage = createStorage();
    const collaboration = new AgentCollaborationService({
      storage,
      v2Configs: createCollaborationConfigs(),
      invokeTarget: async () => ({
        text: JSON.stringify({
          status: "completed",
          answer: "The cited source supports the claim.",
          evidence: [{ source: "fixture", quote: "supports claim" }],
          actions_taken: ["checked source"],
          actions_not_taken: [],
          needs_user: false,
        }),
        durationMs: 12,
        model: "claude-sonnet-4-6",
        toolsUsed: ["fixture_source_check"],
      }),
    });
    const service = new SubAgentJobService({
      storage,
      autoStart: false,
      executors: {
        collaborator: createAgentCollaborationChildExecutor(collaboration),
      },
    });

    const started = await service.startJob({
      coordinatorAgentId: "ops",
      objective: "Have a peer research agent source-check one claim.",
      visibilityMode: "summary",
      children: [
        {
          id: "source-check",
          kind: "collaborator",
          agentId: "research",
          task: "Verify whether the cited source supports the claim.",
          metadata: {
            purpose: "source-check",
            contextSummary: "A draft mentions a source-backed claim.",
            deliverable: {
              format: "concise_result",
              requiredFields: ["answer", "evidence"],
              maxWords: 120,
            },
            constraints: ["Do not write to external systems."],
          },
        },
      ],
      autoStart: false,
    });

    const completed = await service.runJob(started.jobId);
    const child = completed.children[0]!;

    expect(completed.job.status).toBe("completed");
    expect(child.status).toBe("completed");
    expect(child.resultSummary).toBe("The cited source supports the claim.");
    expect(child.metadata).toMatchObject({
      collaborationStatus: "completed",
      needsUser: false,
    });

    const collaborationId = String(child.metadata?.collaborationId ?? "");
    expect(collaboration.getSession(collaborationId)).toMatchObject({
      requesterAgentId: "ops",
      targetAgentId: "research",
      status: "completed",
    });
    expect(storage.listAgentCollaborationTurns(collaborationId)).toHaveLength(2);

    storage.close();
  });
});
