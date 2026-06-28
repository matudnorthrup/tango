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
