import { describe, expect, it, vi } from "vitest";
import { createCollaborationTools } from "../src/collaboration-agent-tools.js";

describe("collaboration-agent-tools", () => {
  it("posts bounded collaboration requests to the bridge with the governed requester id", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({
      collaborationId: "collab-1",
      status: "completed",
      answer: "Done",
    }), { status: 200 }));
    const [tool] = createCollaborationTools({
      bridgeUrl: "http://127.0.0.1:9200/collaboration/request",
      bridgeToken: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await tool!.handler({
      _requester_agent_id: "ops",
      requester_agent_id: "spoofed",
      target_agent_id: "research",
      purpose: "source-check",
      objective: "Check a source.",
      context_summary: "A draft has a claim.",
      visibility: "summary",
    });

    expect(result).toEqual({
      collaborationId: "collab-1",
      status: "completed",
      answer: "Done",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:9200/collaboration/request");
    expect((init as RequestInit).headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Tango-Collaboration-Token": "secret",
    });
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      requester_agent_id: "ops",
      target_agent_id: "research",
      purpose: "source-check",
      objective: "Check a source.",
      initiator_kind: "agent",
    });
    expect(JSON.parse(String((init as RequestInit).body))).not.toHaveProperty("_requester_agent_id");
  });

  it("fails before bridge calls when requester identity is unavailable", async () => {
    const fetchImpl = vi.fn();
    const [tool] = createCollaborationTools({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await tool!.handler({
      target_agent_id: "research",
      purpose: "source-check",
      objective: "Check a source.",
    });

    expect(result).toMatchObject({
      status: "failed",
      error: "requester_agent_id unavailable; collaboration tool must run inside a governed agent runtime",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not accept a caller-supplied requester identity", async () => {
    const fetchImpl = vi.fn();
    const [tool] = createCollaborationTools({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await tool!.handler({
      requester_agent_id: "spoofed",
      target_agent_id: "research",
      purpose: "source-check",
      objective: "Check a source.",
    });

    expect(result).toMatchObject({
      status: "failed",
      error: "requester_agent_id unavailable; collaboration tool must run inside a governed agent runtime",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports bridge HTTP failures without throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "denied" }), { status: 403 }));
    const [tool] = createCollaborationTools({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await tool!.handler({
      _requester_agent_id: "ops",
      target_agent_id: "research",
      purpose: "source-check",
      objective: "Check a source.",
    });

    expect(result).toMatchObject({
      status: "failed",
      error: "collaboration bridge HTTP 403",
      detail: {
        error: "denied",
      },
    });
  });
});
