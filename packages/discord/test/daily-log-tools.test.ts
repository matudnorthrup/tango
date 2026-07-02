import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDailyLogTools } from "../src/daily-log-tools.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeProfileRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-log-tools-"));
  tempDirs.push(dir);
  return dir;
}

describe("daily_log_append tool", () => {
  it("stamps metadata and writes block to profile memory file", async () => {
    const tangoHome = fs.mkdtempSync(path.join(os.tmpdir(), "daily-log-tools-home-"));
    tempDirs.push(tangoHome);
    const profileRoot = path.join(tangoHome, "profiles", "default");
    fs.mkdirSync(path.join(profileRoot, "memory"), { recursive: true });
    process.env.TANGO_HOME = tangoHome;

    const tool = createDailyLogTools({
      agentId: "cod-e",
      channelId: "100",
      threadId: "200",
      conversationKey: "thread:200",
      capturedBy: "save_pass",
      requestedByUserId: "999",
      timeZone: "America/Denver",
    }).find((entry) => entry.name === "daily_log_append");

    const result = await tool!.handler({
      bullets: ["Gate 3 smoke block"],
    });

    expect(result.error).toBeUndefined();
    expect(result.captured_by).toBe("save_pass");
    expect(result.conversation_key).toBe("thread:200");
    expect(typeof result.path).toBe("string");
    expect(fs.readFileSync(result.path as string, "utf8")).toContain("channel:100 · thread:200");
    expect(fs.readFileSync(result.path as string, "utf8")).toContain("- Gate 3 smoke block");

    delete process.env.TANGO_HOME;
  });
});

describe("daily_log_patch tool", () => {
  it("allows Cod-E to patch an existing daily log", async () => {
    const tangoHome = fs.mkdtempSync(path.join(os.tmpdir(), "daily-log-patch-home-"));
    tempDirs.push(tangoHome);
    const profileRoot = path.join(tangoHome, "profiles", "default");
    const logPath = path.join(profileRoot, "memory", "2026-06-29.md");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, "# 2026-06-29\n\n- stale bullet\n", "utf8");
    process.env.TANGO_HOME = tangoHome;

    const tool = createDailyLogTools({ agentId: "cod-e" }).find(
      (entry) => entry.name === "daily_log_patch",
    );

    const result = await tool!.handler({
      date: "2026-06-29",
      old_string: "stale bullet",
      new_string: "corrected bullet",
    });

    expect(result.error).toBeUndefined();
    expect(result.agent_id).toBe("cod-e");
    expect(fs.readFileSync(logPath, "utf8")).toContain("corrected bullet");

    delete process.env.TANGO_HOME;
  });

  it("blocks Jules from daily_log_patch during learning phase", async () => {
    const tool = createDailyLogTools({ agentId: "jules" }).find(
      (entry) => entry.name === "daily_log_patch",
    );

    const result = await tool!.handler({
      date: "2026-06-29",
      old_string: "x",
      new_string: "y",
    });

    expect(result.error).toMatch(/Cod-E/i);
  });
});

describe("daily log provenance isolation (T-B-010)", () => {
  it("stamps append from conversation-scoped provenance under stale process env", async () => {
    const tangoHome = fs.mkdtempSync(path.join(os.tmpdir(), "daily-log-prov-home-"));
    tempDirs.push(tangoHome);
    const profileRoot = path.join(tangoHome, "profiles", "default");
    fs.mkdirSync(path.join(profileRoot, "memory"), { recursive: true });
    fs.mkdirSync(path.join(profileRoot, "runtime", "turn-provenance"), { recursive: true });
    process.env.TANGO_HOME = tangoHome;

    const julesKey = "thread:1510457828853416176";
    const julesProvPath = path.join(
      profileRoot,
      "runtime",
      "turn-provenance",
      "thread-1510457828853416176.json",
    );
    fs.writeFileSync(
      julesProvPath,
      JSON.stringify({
        TANGO_CONVERSATION_KEY: julesKey,
        TANGO_DISCORD_CHANNEL_ID: "wellness-channel",
        TANGO_DISCORD_THREAD_ID: "1510457828853416176",
        TANGO_AGENT_ID: "jules",
        TANGO_CAPTURED_BY: "save_pass",
      }),
      "utf8",
    );

    process.env.TANGO_TURN_PROVENANCE_FILE = julesProvPath;
    process.env.TANGO_CONVERSATION_KEY = "thread:1509320762287456457";
    process.env.TANGO_AGENT_ID = "cod-e";
    process.env.TANGO_DISCORD_CHANNEL_ID = "canary-channel";
    process.env.TANGO_CAPTURED_BY = "agent_save";

    const tool = createDailyLogTools().find((entry) => entry.name === "daily_log_append");
    const result = await tool!.handler({
      bullets: ["Jules save pass headline"],
    });

    expect(result.error).toBeUndefined();
    const content = fs.readFileSync(result.path as string, "utf8");
    expect(content).toContain("## jules ·");
    expect(content).toContain("wellness-channel");
    expect(content).not.toContain("canary-channel");

    delete process.env.TANGO_HOME;
    delete process.env.TANGO_TURN_PROVENANCE_FILE;
    delete process.env.TANGO_CONVERSATION_KEY;
    delete process.env.TANGO_AGENT_ID;
    delete process.env.TANGO_DISCORD_CHANNEL_ID;
    delete process.env.TANGO_CAPTURED_BY;
  });
});
