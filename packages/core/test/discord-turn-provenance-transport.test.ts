import { describe, expect, it } from "vitest";
import {
  discordTurnProvenanceToHttpHeaders,
  httpHeadersToDiscordTurnProvenanceEnv,
  pickDiscordTurnProvenanceEnv,
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
});
