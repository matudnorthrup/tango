import type { AgentConfig } from "@tango/core";
import { describe, expect, it } from "vitest";
import { resolveTargetAgent } from "../src/target-agent.js";

function createAgent(overrides: Partial<AgentConfig> & Pick<AgentConfig, "id" | "type">): AgentConfig {
  return {
    provider: { default: "codex" },
    ...overrides
  };
}

function createLookup(agents: AgentConfig[]) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return {
    get(id: string): AgentConfig | undefined {
      return byId.get(id);
    }
  };
}

describe("resolveTargetAgent", () => {
  it("returns non-dispatch route agents directly", () => {
    const watson = createAgent({
      id: "watson",
      type: "personal",
      displayName: "Watson"
    });

    const resolved = resolveTargetAgent(createLookup([watson]), "watson", null);
    expect(resolved).toBe(watson);
  });

  it("honors explicit agent overrides even on non-dispatch routes", () => {
    const watson = createAgent({
      id: "watson",
      type: "personal",
      displayName: "Watson"
    });
    const malibu = createAgent({
      id: "malibu",
      type: "fitness",
      displayName: "Malibu"
    });

    const resolved = resolveTargetAgent(createLookup([watson, malibu]), "watson", "malibu");
    expect(resolved).toBe(malibu);
  });

  it("prefers an explicit agent override on dispatch routes", () => {
    const dispatch = createAgent({
      id: "dispatch",
      type: "router",
      voice: {
        defaultPromptAgent: "watson"
      }
    });
    const watson = createAgent({
      id: "watson",
      type: "personal",
      displayName: "Watson"
    });
    const malibu = createAgent({
      id: "malibu",
      type: "fitness",
      displayName: "Malibu"
    });

    const resolved = resolveTargetAgent(createLookup([dispatch, watson, malibu]), "dispatch", "malibu");
    expect(resolved).toBe(malibu);
  });

  it("uses the configured dispatch default prompt agent", () => {
    const dispatch = createAgent({
      id: "dispatch",
      type: "router",
      voice: {
        defaultPromptAgent: "watson"
      }
    });
    const watson = createAgent({
      id: "watson",
      type: "personal",
      displayName: "Watson"
    });

    const resolved = resolveTargetAgent(createLookup([dispatch, watson]), "dispatch", null);
    expect(resolved).toBe(watson);
  });

  it("falls back to dispatch if the configured default agent is missing", () => {
    const dispatch = createAgent({
      id: "dispatch",
      type: "router",
      voice: {
        defaultPromptAgent: "watson"
      }
    });

    const resolved = resolveTargetAgent(createLookup([dispatch]), "dispatch", null);
    expect(resolved).toBe(dispatch);
  });
});
