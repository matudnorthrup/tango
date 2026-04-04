import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScenarioRunner } from "../src/scenario-runner.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createFixtureDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-scenario-runner-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  fs.mkdirSync(path.join(dir, "projects"), { recursive: true });
  return dir;
}

function writeAgent(dir: string, fileName: string, lines: string[]): void {
  fs.writeFileSync(path.join(dir, "agents", fileName), `${lines.join("\n")}\n`);
}

function writeProject(dir: string, fileName: string, lines: string[]): void {
  fs.writeFileSync(path.join(dir, "projects", fileName), `${lines.join("\n")}\n`);
}

function createRunner(
  options?: Partial<{
    channelKey: string;
    baseSessionId: string;
    routeAgentId: string;
  }>,
): ScenarioRunner {
  const dir = createFixtureDir();
  writeAgent(dir, "dispatch.yaml", [
    "id: dispatch",
    "type: router",
    "display_name: Tango",
    "provider:",
    "  default: claude-oauth",
    "voice:",
    "  call_signs:",
    "    - Tango",
    "  default_prompt_agent: watson",
  ]);
  writeAgent(dir, "watson.yaml", [
    "id: watson",
    "type: personal",
    "display_name: Watson",
    "provider:",
    "  default: claude-oauth",
    "voice:",
    "  call_signs:",
    "    - Watson",
  ]);
  writeAgent(dir, "malibu.yaml", [
    "id: malibu",
    "type: fitness",
    "display_name: Malibu",
    "provider:",
    "  default: claude-oauth",
    "voice:",
    "  call_signs:",
    "    - Malibu",
  ]);
  writeProject(dir, "tango.yaml", [
    "id: tango",
    "display_name: Tango MVP",
    "aliases:",
    "  - tango mvp",
    "default_agent: watson",
    "provider:",
    "  default: claude-harness",
  ]);
  return new ScenarioRunner({
    configDir: dir,
    dbPath: path.join(dir, "scenario.sqlite"),
    channelKey: options?.channelKey ?? "discord:test",
    baseSessionId: options?.baseSessionId,
    routeAgentId: options?.routeAgentId,
  });
}

describe("ScenarioRunner", () => {
  it("replays text and voice turns through the same topic session", () => {
    const runner = createRunner();

    runner.runTurn("text", "Tango, open project tango");
    const openedTopic = runner.runTurn("text", "Tango, open topic auth redesign");
    const textPrompt = runner.runTurn("text", "Watson, draft three bullets for this topic");
    const voicePrompt = runner.runTurn("voice", "Watson, continue from the last reply");

    expect(openedTopic.replyText).toContain("Opened standalone topic auth redesign");
    expect(textPrompt.sessionId).toBe(voicePrompt.sessionId);
    expect(textPrompt.sessionId).toMatch(/^topic:/);
    expect(textPrompt.targetAgentId).toBe("watson");
    expect(voicePrompt.targetAgentId).toBe("watson");

    const state = runner.getState();
    expect(state.focusedTopic).toMatchObject({
      title: "auth redesign",
      projectId: null,
    });
    expect(state.focusedProject?.id).toBe("tango");

    const messages = runner.getMessages(textPrompt.sessionId);
    expect(messages.map((message) => message.content)).toEqual(
      expect.arrayContaining([
        "Watson, draft three bullets for this topic",
        "Watson, continue from the last reply",
      ]),
    );

    runner.destroy();
  });

  it("detaches an attached topic without changing its identity", () => {
    const runner = createRunner();

    runner.runTurn("text", "Tango, open project tango");
    runner.runTurn("text", "Tango, open topic auth redesign in project tango");
    const attachedTopicId = runner.getState().focusedTopic?.id;

    const detach = runner.runTurn("text", "Tango, detach this topic from project");
    const currentTopic = runner.runTurn("text", "Tango, current topic");
    const currentProject = runner.runTurn("text", "Tango, current project");

    expect(detach.replyText).toContain("It is now standalone");
    expect(runner.getState().focusedTopic?.id).toBe(attachedTopicId);
    expect(runner.getState().focusedTopic?.projectId).toBeNull();
    expect(runner.getState().focusedProject?.id).toBe("tango");
    expect(currentTopic.replyText).toBe("You are in standalone topic auth redesign.");
    expect(currentProject.replyText).toContain("Focused project Tango MVP will resume");

    runner.destroy();
  });

  it("keeps agent focus surface-local while sharing topic and project state", () => {
    const runner = createRunner();

    runner.runTurn("text", "Tango, talk to Malibu");
    const textPrompt = runner.runTurn("text", "keep going");
    const voiceCurrentAgent = runner.runTurn("voice", "Tango, who am I talking to");
    const voicePrompt = runner.runTurn("voice", "keep going");

    runner.runTurn("text", "Tango, open topic auth redesign");
    const voiceCurrentTopic = runner.runTurn("voice", "Tango, current topic");

    expect(textPrompt.targetAgentId).toBe("malibu");
    expect(voiceCurrentAgent.replyText).toContain("No focused agent");
    expect(voicePrompt.targetAgentId).toBe("watson");
    expect(voiceCurrentTopic.replyText).toBe("You are in standalone topic auth redesign.");

    runner.destroy();
  });

  it("routes prompts through the active project session when no topic is focused", () => {
    const runner = createRunner();

    runner.runTurn("text", "Tango, open project tango");
    const projectPrompt = runner.runTurn("voice", "keep going");

    expect(projectPrompt.sessionId).toBe("project:tango");
    expect(projectPrompt.targetAgentId).toBe("watson");
    expect(projectPrompt.projectId).toBe("tango");
    expect(projectPrompt.topicId).toBeNull();

    runner.destroy();
  });

  it("treats a route-backed project channel as project-active without an explicit open command", () => {
    const runner = createRunner({
      baseSessionId: "project:tango",
      routeAgentId: "watson",
    });

    const currentProject = runner.runTurn("text", "Tango, current project");
    const followUp = runner.runTurn("voice", "keep going");
    const clearProject = runner.runTurn("text", "Tango, clear project");

    expect(currentProject.replyText).toBe("You are in project Tango MVP.");
    expect(followUp.sessionId).toBe("project:tango");
    expect(followUp.projectId).toBe("tango");
    expect(clearProject.replyText).toBe(
      "Channel is routed to project Tango MVP. Open another project to override it.",
    );

    runner.destroy();
  });

  it("returns to the parked project session after clearing a standalone topic", () => {
    const runner = createRunner();

    runner.runTurn("text", "Tango, open project tango");
    const openedTopic = runner.runTurn("text", "Tango, open topic auth redesign");
    const clearTopic = runner.runTurn("voice", "Tango, clear topic");
    const followUp = runner.runTurn("voice", "keep going");

    expect(openedTopic.sessionId).toMatch(/^topic:/);
    expect(clearTopic.replyText).toContain("Project Tango MVP is still active");
    expect(followUp.sessionId).toBe("project:tango");
    expect(followUp.projectId).toBe("tango");
    expect(followUp.topicId).toBeNull();

    runner.destroy();
  });

  it("returns a dedicated project channel to its routed project after a standalone topic", () => {
    const runner = createRunner({
      baseSessionId: "project:tango",
      routeAgentId: "watson",
    });

    runner.runTurn("text", "Tango, open topic auth redesign");
    const currentProject = runner.runTurn("voice", "Tango, current project");
    const clearTopic = runner.runTurn("voice", "Tango, clear topic");
    const followUp = runner.runTurn("text", "keep going");

    expect(currentProject.replyText).toBe(
      "Current topic auth redesign is standalone. Project Tango MVP will resume when you leave this topic.",
    );
    expect(clearTopic.replyText).toBe(
      "Left standalone topic auth redesign. Project Tango MVP is still active.",
    );
    expect(followUp.sessionId).toBe("project:tango");
    expect(followUp.projectId).toBe("tango");

    runner.destroy();
  });

  it("clears an attached topic when clearing its active project", () => {
    const runner = createRunner();

    runner.runTurn("text", "Tango, open project tango");
    const topicOpen = runner.runTurn("text", "Tango, open topic auth redesign in project tango");
    const clearProject = runner.runTurn("text", "Tango, clear project");
    const currentTopic = runner.runTurn("text", "Tango, current topic");
    const followUp = runner.runTurn("text", "keep going");

    expect(topicOpen.sessionId).toMatch(/^topic:/);
    expect(clearProject.replyText).toBe("Left project Tango MVP. Cleared topic auth redesign.");
    expect(runner.getState().focusedTopic).toBeNull();
    expect(runner.getState().focusedProject).toBeNull();
    expect(currentTopic.replyText).toBe("No topic is active right now.");
    expect(followUp.sessionId).toBe("tango-default");

    runner.destroy();
  });

  it("clears only the parked project when the current topic is standalone", () => {
    const runner = createRunner();

    runner.runTurn("text", "Tango, open project tango");
    const topicOpen = runner.runTurn("text", "Tango, open topic auth redesign");
    const clearProject = runner.runTurn("voice", "Tango, clear project");
    const currentTopic = runner.runTurn("voice", "Tango, current topic");
    const currentProject = runner.runTurn("voice", "Tango, current project");

    expect(topicOpen.sessionId).toMatch(/^topic:/);
    expect(clearProject.replyText).toBe(
      "Cleared focused project Tango MVP. Current topic auth redesign remains standalone.",
    );
    expect(runner.getState().focusedTopic?.title).toBe("auth redesign");
    expect(runner.getState().focusedProject).toBeNull();
    expect(currentTopic.replyText).toBe("You are in standalone topic auth redesign.");
    expect(currentProject.replyText).toBe("No project is active right now.");

    runner.destroy();
  });

  it("covers focused-agent lifecycle on a single surface", () => {
    const runner = createRunner();

    const focus = runner.runTurn("voice", "Tango, talk to Malibu");
    const currentAgent = runner.runTurn("voice", "Tango, who am I talking to");
    const prompt = runner.runTurn("voice", "keep going");
    const clearFocus = runner.runTurn("voice", "Tango, back to Tango");
    const currentAfterClear = runner.runTurn("voice", "Tango, who am I talking to");

    expect(focus.replyText).toBe("Focused on Malibu. You can keep talking.");
    expect(currentAgent.replyText).toBe("You are focused on Malibu.");
    expect(prompt.targetAgentId).toBe("malibu");
    expect(clearFocus.replyText).toBe("Back to Tango.");
    expect(currentAfterClear.replyText).toContain("No focused agent");

    runner.destroy();
  });
});
