import { describe, expect, it } from "vitest";
import {
  CANCEL_SUB_AGENT_JOB_TOOL_NAME,
  GET_SUB_AGENT_JOB_TOOL_NAME,
  LIST_SUB_AGENT_JOBS_TOOL_NAME,
  SEND_SUB_AGENT_JOB_UPDATE_TOOL_NAME,
  START_SUB_AGENT_JOB_TOOL_NAME,
  createSubAgentJobTools,
} from "../src/sub-agent-job-tools.js";

describe("sub-agent job MCP tools", () => {
  it("normalizes start_sub_agent_job input and forwards hidden coordinator policy to the bridge", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const tools = createSubAgentJobTools({
      bridgeUrl: "http://bridge/sub-agent-jobs",
      bridgeToken: "token",
      fetchImpl: (async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ jobId: "job-1" }), { status: 200 });
      }) as typeof fetch,
    });

    const start = tools.find((tool) => tool.name === START_SUB_AGENT_JOB_TOOL_NAME);
    expect(start).toBeTruthy();

    await start!.handler({
      _coordinator_agent_id: "watson-ollama",
      _coordinator_capability_tool_ids: ["memory_search", "browser"],
      objective: "Compare implementation paths.",
      user_surface: {
        kind: "discord",
        channel_id: "chan-1",
        thread_id: "thread-1",
        session_id: "session-1",
      },
      budget: {
        max_children: 3,
        max_parallel: 2,
      },
      notification_policy: {
        periodic_after_minutes: 10,
        notify_on: ["completed", "failed"],
      },
      children: [
        {
          id: "fast-a",
          kind: "worker",
          task: "Check A.",
          tools: ["memory_search"],
        },
        {
          id: "peer",
          kind: "collaborator",
          agent_id: "sierra",
          task: "Source-check the claim.",
          purpose: "source-check",
          context_summary: "Draft claim needs verification.",
        },
      ],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://bridge/sub-agent-jobs/start");
    expect(calls[0]!.init.headers).toMatchObject({
      "X-Tango-Collaboration-Token": "token",
    });
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      coordinatorAgentId: "watson-ollama",
      objective: "Compare implementation paths.",
      capabilityCeilingToolIds: ["memory_search", "browser"],
      budget: {
        maxChildren: 3,
        maxParallel: 2,
      },
      notificationPolicy: {
        periodicAfterMinutes: 10,
        notifyOn: ["completed", "failed"],
      },
      children: [
        {
          id: "fast-a",
          kind: "worker",
          tools: ["memory_search"],
        },
        {
          id: "peer",
          kind: "collaborator",
          agentId: "sierra",
          metadata: {
            purpose: "source-check",
            contextSummary: "Draft claim needs verification.",
          },
        },
      ],
    });
  });

  it("forwards get, list, cancel, and update requests to stable bridge paths", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const tools = createSubAgentJobTools({
      bridgeUrl: "http://bridge/sub-agent-jobs/",
      fetchImpl: (async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch,
    });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    await byName.get(GET_SUB_AGENT_JOB_TOOL_NAME)!.handler({ job_id: "job-1" });
    await byName.get(LIST_SUB_AGENT_JOBS_TOOL_NAME)!.handler({
      _coordinator_agent_id: "watson-ollama",
      status: "active",
      limit: 5,
    });
    await byName.get(CANCEL_SUB_AGENT_JOB_TOOL_NAME)!.handler({ job_id: "job-1" });
    await byName.get(SEND_SUB_AGENT_JOB_UPDATE_TOOL_NAME)!.handler({
      job_id: "job-1",
      message: "The background job is done.",
      metadata: { reason: "completed" },
    });

    expect(calls.map((call) => [call.url, call.init.method])).toEqual([
      ["http://bridge/sub-agent-jobs/job-1", "GET"],
      ["http://bridge/sub-agent-jobs?coordinator_agent_id=watson-ollama&status=active&limit=5", "GET"],
      ["http://bridge/sub-agent-jobs/job-1/cancel", "POST"],
      ["http://bridge/sub-agent-jobs/job-1/update", "POST"],
    ]);
    expect(JSON.parse(String(calls[3]!.init.body))).toMatchObject({
      message: "The background job is done.",
      metadata: {
        reason: "completed",
      },
    });
  });
});
