import { describe, expect, it } from "vitest";
import {
  parseVoiceCompletionInput,
  parseVoiceTurnInput,
  resolveVoiceApiKey
} from "../src/index.js";

describe("parseVoiceTurnInput", () => {
  it("parses required fields and optional metadata", () => {
    const result = parseVoiceTurnInput(
      {
        sessionId: "voice-main",
        agentId: "watson",
        transcript: "hello",
        utteranceId: "utt-001",
        guildId: "guild-1",
        voiceChannelId: "voice-channel-1",
        channelId: "call-main",
        discordUserId: "caller-1"
      },
      {}
    );

    expect(result).toEqual({
      sessionId: "voice-main",
      agentId: "watson",
      transcript: "hello",
      utteranceId: "utt-001",
      guildId: "guild-1",
      voiceChannelId: "voice-channel-1",
      channelId: "call-main",
      discordUserId: "caller-1"
    });
  });

  it("uses defaults when session/agent are omitted", () => {
    const result = parseVoiceTurnInput(
      {
        transcript: "what changed?"
      },
      {
        sessionId: "voice-default",
        agentId: "watson"
      }
    );

    expect(result.sessionId).toBe("voice-default");
    expect(result.agentId).toBe("watson");
    expect(result.transcript).toBe("what changed?");
  });

  it("throws validation errors for missing required fields", () => {
    expect(() => parseVoiceTurnInput({}, {})).toThrow(/sessionId/u);
    expect(() =>
      parseVoiceTurnInput(
        {
          sessionId: "voice-main"
        },
        {}
      )
    ).toThrow(/agentId/u);
    expect(() =>
      parseVoiceTurnInput(
        {
          sessionId: "voice-main",
          agentId: "watson"
        },
        {}
      )
    ).toThrow(/transcript/u);
  });
});

describe("resolveVoiceApiKey", () => {
  it("prefers bearer authorization header", () => {
    expect(
      resolveVoiceApiKey({
        authorization: "Bearer secret-token"
      })
    ).toBe("secret-token");
  });

  it("falls back to x-tango-api-key header", () => {
    expect(
      resolveVoiceApiKey({
        "x-tango-api-key": "secret-token"
      })
    ).toBe("secret-token");
  });
});

describe("parseVoiceCompletionInput", () => {
  it("parses completion payloads with defaults", () => {
    const result = parseVoiceCompletionInput(
      {
        systemPrompt: "Be terse.",
        maxTokens: 42,
        messages: [
          { role: "assistant", content: "Previous reply" },
          { role: "user", content: "Summarize this" }
        ]
      },
      {
        sessionId: "voice-default",
        agentId: "watson"
      }
    );

    expect(result).toEqual({
      systemPrompt: "Be terse.",
      maxTokens: 42,
      sessionId: "voice-default",
      agentId: "watson",
      messages: [
        { role: "assistant", content: "Previous reply" },
        { role: "user", content: "Summarize this" }
      ]
    });
  });

  it("throws validation errors for malformed completion payloads", () => {
    expect(() =>
      parseVoiceCompletionInput(
        {
          systemPrompt: "Be terse."
        },
        {}
      )
    ).toThrow(/messages/u);

    expect(() =>
      parseVoiceCompletionInput(
        {
          messages: [{ role: "narrator", content: "hello" }]
        },
        {}
      )
    ).toThrow(/messages\[0\]\.role/u);

    expect(() =>
      parseVoiceCompletionInput(
        {
          messages: [{ role: "user", content: "hello" }],
          maxTokens: 0
        },
        {}
      )
    ).toThrow(/maxTokens/u);
  });
});
