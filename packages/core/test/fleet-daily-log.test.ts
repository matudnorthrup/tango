import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendFleetDailyLogBlock,
  ensureFleetDailyLog,
  formatFleetDailyLogBlock,
  normalizeFleetDailyLogBullets,
} from "../src/fleet-daily-log.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeProfileRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-daily-log-"));
  tempDirs.push(dir);
  return dir;
}

describe("fleet-daily-log", () => {
  it("creates daily log with date header when missing", () => {
    const profileRoot = makeProfileRoot();
    const result = ensureFleetDailyLog({
      profileRoot,
      now: new Date("2026-06-27T12:00:00-06:00"),
      timeZone: "America/Denver",
    });

    expect(result.created).toBe(true);
    expect(result.date).toBe("2026-06-27");
    expect(fs.readFileSync(result.path, "utf8")).toBe("# 2026-06-27\n");
  });

  it("formats stamped block with channel and thread", () => {
    const block = formatFleetDailyLogBlock(
      {
        agent_id: "cod-e",
        date: "2026-06-27",
        time: "2026-06-27 14:05 MDT",
        channel_id: "100",
        thread_id: "200",
        conversation_key: "thread:200",
        captured_by: "save_pass",
        requested_by_user_id: "999",
      },
      ["- Phase 1b smoke complete", "second line"],
    );

    expect(block).toContain("## cod-e · 2026-06-27 14:05 MDT · channel:100 · thread:200");
    expect(block).toContain("- Phase 1b smoke complete");
    expect(block).toContain("- second line");
  });

  it("appends blocks sequentially under lock", async () => {
    const profileRoot = makeProfileRoot();
    const metadata = {
      agent_id: "cod-e",
      date: "2026-06-27",
      time: "2026-06-27 14:05 MDT",
      channel_id: "100",
      conversation_key: "channel:100",
      captured_by: "agent_save" as const,
    };

    await Promise.all([
      appendFleetDailyLogBlock({
        profileRoot,
        metadata,
        bullets: ["first"],
        now: new Date("2026-06-27T12:00:00-06:00"),
        timeZone: "America/Denver",
      }),
      appendFleetDailyLogBlock({
        profileRoot,
        metadata: { ...metadata, time: "2026-06-27 14:06 MDT" },
        bullets: ["second"],
        now: new Date("2026-06-27T12:01:00-06:00"),
        timeZone: "America/Denver",
      }),
    ]);

    const content = fs.readFileSync(
      path.join(profileRoot, "memory", "2026-06-27.md"),
      "utf8",
    );
    expect(content).toContain("- first");
    expect(content).toContain("- second");
  });

  it("normalizes bullet prefixes", () => {
    expect(normalizeFleetDailyLogBullets(["* item", "- other"])).toEqual(["item", "other"]);
  });
});
