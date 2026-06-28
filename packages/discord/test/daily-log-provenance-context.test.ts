import { describe, expect, it } from "vitest";
import { readDailyLogToolEnv } from "../src/daily-log-tools.js";
import { discordTurnProvenanceContext } from "../src/discord-turn-provenance-context.js";

describe("readDailyLogToolEnv with HTTP provenance context", () => {
  it("prefers AsyncLocalStorage context over process.env", async () => {
    await discordTurnProvenanceContext.run(
      {
        TANGO_CONVERSATION_KEY: "thread:ctx",
        TANGO_DISCORD_CHANNEL_ID: "111",
        TANGO_AGENT_ID: "cod-e",
        TANGO_CAPTURED_BY: "save_pass",
      },
      async () => {
        const env = readDailyLogToolEnv({
          TANGO_CONVERSATION_KEY: "thread:stale",
          TANGO_DISCORD_CHANNEL_ID: "999",
        });
        expect(env.conversationKey).toBe("thread:ctx");
        expect(env.channelId).toBe("111");
        expect(env.agentId).toBe("cod-e");
        expect(env.capturedBy).toBe("save_pass");
      },
    );
  });
});
