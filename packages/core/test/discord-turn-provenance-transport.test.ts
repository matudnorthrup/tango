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
import {
  encodeConversationKeyForProvenanceFilename,
  resolveTangoTurnProvenancePath,
} from "../src/runtime-paths.js";

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

  it("encodes conversation keys for provenance filenames", () => {
    expect(encodeConversationKeyForProvenanceFilename("thread:1509320762287456457")).toBe(
      "thread-1509320762287456457",
    );
  });

  it("isolates concurrent conversation provenance snapshots", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-prov-"));
    const julesKey = "thread:1510457828853416176";
    const codEKey = "thread:1509320762287456457";
    const julesPath = path.join(dir, "turn-provenance", "thread-1510457828853416176.json");
    const codEPath = path.join(dir, "turn-provenance", "thread-1509320762287456457.json");

    writeDiscordTurnProvenanceSnapshot(
      {
        TANGO_CONVERSATION_KEY: julesKey,
        TANGO_DISCORD_CHANNEL_ID: "wellness-channel",
        TANGO_AGENT_ID: "jules",
        TANGO_CAPTURED_BY: "save_pass",
      },
      { filePath: julesPath, conversationKey: julesKey },
    );

    writeDiscordTurnProvenanceSnapshot(
      {
        TANGO_CONVERSATION_KEY: codEKey,
        TANGO_DISCORD_CHANNEL_ID: "canary-channel",
        TANGO_AGENT_ID: "cod-e",
        TANGO_CAPTURED_BY: "agent_save",
      },
      { filePath: codEPath, conversationKey: codEKey },
    );

    expect(
      resolveDiscordTurnProvenanceEnv({
        TANGO_TURN_PROVENANCE_FILE: julesPath,
        TANGO_CONVERSATION_KEY: codEKey,
        TANGO_AGENT_ID: "cod-e",
      }),
    ).toEqual({
      TANGO_CONVERSATION_KEY: julesKey,
      TANGO_DISCORD_CHANNEL_ID: "wellness-channel",
      TANGO_AGENT_ID: "jules",
      TANGO_CAPTURED_BY: "save_pass",
    });

    expect(
      resolveDiscordTurnProvenanceEnv({
        TANGO_TURN_PROVENANCE_FILE: codEPath,
        TANGO_CONVERSATION_KEY: julesKey,
        TANGO_AGENT_ID: "jules",
      }),
    ).toEqual({
      TANGO_CONVERSATION_KEY: codEKey,
      TANGO_DISCORD_CHANNEL_ID: "canary-channel",
      TANGO_AGENT_ID: "cod-e",
      TANGO_CAPTURED_BY: "agent_save",
    });
  });

  it("resolves per-conversation path from conversation key env", () => {
    process.env.TANGO_PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tango-profile-"));
    try {
      expect(resolveTangoTurnProvenancePath("thread:abc")).toMatch(
        /turn-provenance\/thread-abc\.json$/,
      );
      writeDiscordTurnProvenanceSnapshot(
        {
          TANGO_CONVERSATION_KEY: "thread:abc",
          TANGO_AGENT_ID: "jules",
          TANGO_DISCORD_CHANNEL_ID: "1",
          TANGO_CAPTURED_BY: "save_pass",
        },
        { conversationKey: "thread:abc" },
      );
      expect(
        resolveDiscordTurnProvenanceEnv({
          TANGO_CONVERSATION_KEY: "thread:abc",
        }),
      ).toMatchObject({
        TANGO_AGENT_ID: "jules",
        TANGO_CAPTURED_BY: "save_pass",
      });
    } finally {
      delete process.env.TANGO_PROFILE_DIR;
    }
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
