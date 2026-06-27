import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mergeDiscordProvenanceIntoMemoryAddArgs,
  readDiscordProvenanceFromEnv,
} from "../src/discord-provenance.js";

describe("discord provenance for memory_add", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads discord location env vars", () => {
    vi.stubEnv("TANGO_CONVERSATION_KEY", "thread:1509320762287456457");
    vi.stubEnv("TANGO_DISCORD_CHANNEL_ID", "1469909960199503913");
    vi.stubEnv("TANGO_DISCORD_THREAD_ID", "1509320762287456457");

    expect(readDiscordProvenanceFromEnv()).toEqual({
      conversation_key: "thread:1509320762287456457",
      channel_id: "1469909960199503913",
      thread_id: "1509320762287456457",
    });
  });

  it("merges env provenance into memory_add args and session_id", () => {
    vi.stubEnv("TANGO_CONVERSATION_KEY", "thread:thread-9");
    vi.stubEnv("TANGO_DISCORD_CHANNEL_ID", "forum-1");
    vi.stubEnv("TANGO_DISCORD_THREAD_ID", "thread-9");

    const merged = mergeDiscordProvenanceIntoMemoryAddArgs(
      {
        content: "Operator prefers agent saves with context.",
        source: "manual",
        agent_id: "cod-e",
        metadata: {
          captured_by: "agent_save",
        },
      },
      "cod-e",
    );

    expect(merged).toMatchObject({
      session_id: "thread:thread-9",
      metadata: {
        conversation_key: "thread:thread-9",
        channel_id: "forum-1",
        thread_id: "thread-9",
        captured_by: "agent_save",
      },
    });
  });

  it("preserves agent metadata over env defaults on key collision", () => {
    vi.stubEnv("TANGO_DISCORD_CHANNEL_ID", "forum-1");

    const merged = mergeDiscordProvenanceIntoMemoryAddArgs({
      content: "Override channel",
      source: "manual",
      metadata: {
        channel_id: "explicit-channel",
      },
    });

    expect(merged.metadata).toMatchObject({
      channel_id: "explicit-channel",
    });
  });
});
