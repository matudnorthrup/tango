import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discordTurnProvenanceToHttpHeaders,
  httpHeadersToDiscordTurnProvenanceEnv,
  pickDiscordTurnProvenanceEnv,
  resolveDiscordTurnProvenanceEnv,
  writeDiscordTurnProvenanceSnapshot,
} from "../src/discord-turn-provenance-transport.js";

describe("discord-turn-provenance-transport", () => {
  it("picks known env keys only", () => {
    expect(
      pickDiscordTurnProvenanceEnv({
        TANGO_CONVERSATION_KEY: " thread:1 ",
        TANGO_AGENT_ID: "cod-e",
        TANGO_CAPTURED_BY: "save_pass",
        UNRELATED: "ignored",
      }),
    ).toEqual({
      TANGO_CONVERSATION_KEY: "thread:1",
      TANGO_AGENT_ID: "cod-e",
      TANGO_CAPTURED_BY: "save_pass",
    });
  });

  it("round-trips env through HTTP headers", () => {
    const env = {
      TANGO_CONVERSATION_KEY: "thread:1509320762287456457",
      TANGO_DISCORD_CHANNEL_ID: "1469909960199503913",
      TANGO_DISCORD_THREAD_ID: "1509320762287456457",
      TANGO_AGENT_ID: "cod-e",
      TANGO_CAPTURED_BY: "save_pass",
      TANGO_TURN_TIMEZONE: "America/Denver",
    };
    const headers = discordTurnProvenanceToHttpHeaders(env);
    expect(httpHeadersToDiscordTurnProvenanceEnv(headers)).toEqual(env);
  });

  it("prefers provenance snapshot file over stale process env", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-prov-"));
    const filePath = path.join(dir, "current-turn-provenance.json");
    writeDiscordTurnProvenanceSnapshot(
      {
        TANGO_CONVERSATION_KEY: "thread:fresh",
        TANGO_DISCORD_CHANNEL_ID: "channel-fresh",
        TANGO_AGENT_ID: "cod-e",
        TANGO_CAPTURED_BY: "save_pass",
      },
      { filePath },
    );

    expect(
      resolveDiscordTurnProvenanceEnv({
        TANGO_TURN_PROVENANCE_FILE: filePath,
        TANGO_CONVERSATION_KEY: "thread:stale",
        TANGO_DISCORD_CHANNEL_ID: "channel-stale",
        TANGO_AGENT_ID: "cod-e",
        TANGO_CAPTURED_BY: "agent_save",
      }),
    ).toEqual({
      TANGO_CONVERSATION_KEY: "thread:fresh",
      TANGO_DISCORD_CHANNEL_ID: "channel-fresh",
      TANGO_AGENT_ID: "cod-e",
      TANGO_CAPTURED_BY: "save_pass",
    });
  });
});
