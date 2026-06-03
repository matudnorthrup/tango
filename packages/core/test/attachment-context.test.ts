import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAttachmentDirectoryContext } from "../src/attachment-context.js";
import { AttachmentStore } from "../src/attachments-store.js";
import { TangoStorage } from "../src/storage.js";

interface Harness {
  open: () => {
    storage: TangoStorage;
    store: AttachmentStore;
  };
}

interface SeedOptions {
  suffix: string;
  title: string;
  summary: string;
  agentId?: string;
  channelId?: string | null;
  threadId?: string | null;
  messageId?: string;
  snippet?: string;
}

const cleanups: Array<{ dir: string; storages: Set<TangoStorage> }> = [];

function createHarness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-attachment-context-"));
  const cleanup = { dir, storages: new Set<TangoStorage>() };
  cleanups.push(cleanup);
  const dbPath = path.join(dir, "tango.sqlite");

  return {
    open: () => {
      const storage = new TangoStorage(dbPath);
      cleanup.storages.add(storage);
      return {
        storage,
        store: new AttachmentStore(storage.getDatabase()),
      };
    },
  };
}

afterEach(() => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (!cleanup) continue;
    for (const storage of cleanup.storages) {
      storage.close();
    }
    fs.rmSync(cleanup.dir, { recursive: true, force: true });
  }
});

function seedDirectory(store: AttachmentStore, options: SeedOptions) {
  const agentId = options.agentId ?? "watson";
  const channelId = options.channelId ?? "channel-1";
  const threadId = options.threadId ?? "thread-1";
  const messageId = options.messageId ?? `message-${options.suffix}`;
  const discordAttachmentId = `discord-attachment-${options.suffix}`;
  const file = store.upsertFile({
    role: "source",
    sha256: `sha-${options.suffix}`,
    bytes: 2048,
    contentType: "image/png",
    originalFilename: `${options.suffix}.png`,
    storagePath: `attachments/source/sha-${options.suffix}.png`,
  });
  const attachment = store.createAttachment({
    agentId,
    sessionId: "session-1",
    messageId,
    channelId,
    threadId,
    userId: "user-1",
    discordAttachmentId,
    fileId: file.id,
    title: options.title,
    originalFilename: `${options.suffix}.png`,
    contentType: "image/png",
    bytes: 2048,
    status: "ready",
  });
  const directory = store.addDirectory({
    attachmentId: attachment.id,
    schemaVersion: 1,
    agentId,
    sessionId: "session-1",
    messageId,
    channelId,
    threadId,
    userId: "user-1",
    status: "ready",
    directory: {
      title: options.title,
      summary: options.summary,
      tags: ["test", options.suffix],
      source: {
        attachment_ref: `attachment:${attachment.id}`,
        message_ref: `discord:${channelId ?? "unknown"}:${messageId}:${discordAttachmentId}`,
      },
      snippets: [
        {
          text: options.snippet ?? options.summary,
          text_ref: `chunk:${attachment.id}:0`,
        },
      ],
      available_reads: ["attachment_search", "attachment_read"],
    },
  });

  return { attachment, directory };
}

describe("buildAttachmentDirectoryContext", () => {
  it("selects thread and parent-channel directories without leaking source paths", () => {
    const { store } = createHarness().open();
    const threadScoped = seedDirectory(store, {
      suffix: "thread-launch",
      title: "Launch Screenshot",
      summary: "Thread image with launch checklist annotations.",
      channelId: "channel-1",
      threadId: "thread-1",
    });
    const channelScoped = seedDirectory(store, {
      suffix: "channel-runbook",
      title: "Channel Runbook",
      summary: "Parent-channel document with launch review notes.",
      channelId: "channel-1",
      threadId: null,
    });
    seedDirectory(store, {
      suffix: "other-channel",
      title: "Other Channel Notes",
      summary: "Unrelated attachment in another channel.",
      channelId: "channel-2",
      threadId: null,
    });

    const result = buildAttachmentDirectoryContext({
      store,
      conversationKey: "thread:thread-1",
      discordChannelId: "channel-1",
      agentId: "watson",
      currentUserPrompt: "Review the launch screenshot documents",
      maxEntries: 2,
    });

    expect(result.prompt).toContain("Relevant attachment directories:");
    expect(result.prompt).toContain("Launch Screenshot");
    expect(result.prompt).toContain("Channel Runbook");
    expect(result.prompt).toContain("source_ref: discord:");
    expect(result.prompt).not.toContain("attachments/source");
    expect(result.trace.selected.map((entry) => entry.attachmentId)).toEqual(
      expect.arrayContaining([threadScoped.attachment.id, channelScoped.attachment.id]),
    );
    expect(result.trace.selected.find((entry) => entry.attachmentId === threadScoped.attachment.id)?.reasons)
      .toContain("thread_scope");
    expect(result.trace.selected.find((entry) => entry.attachmentId === channelScoped.attachment.id)?.reasons)
      .toContain("channel_scope");
  });

  it("suppresses recently referenced directories unless the user explicitly asks about attachments", () => {
    const { store } = createHarness().open();
    const seeded = seedDirectory(store, {
      suffix: "recent",
      title: "Recent Attachment",
      summary: "A compact directory that was already shown.",
      channelId: "channel-1",
      threadId: "thread-1",
    });
    const recentMessages = [
      {
        content: `Already discussed attachment:${seeded.attachment.id}.`,
        metadata: null,
        discordMessageId: "discord-message-recent",
      },
    ];

    const quietResult = buildAttachmentDirectoryContext({
      store,
      conversationKey: "thread:thread-1",
      discordChannelId: "channel-1",
      agentId: "watson",
      currentUserPrompt: "continue",
      recentMessages,
    });

    expect(quietResult.prompt).toBe("");
    expect(quietResult.trace.selected).toEqual([]);
    expect(quietResult.trace.suppressed[0]?.attachmentId).toBe(seeded.attachment.id);

    const explicitResult = buildAttachmentDirectoryContext({
      store,
      conversationKey: "thread:thread-1",
      discordChannelId: "channel-1",
      agentId: "watson",
      currentUserPrompt: "Summarize that attachment again",
      recentMessages,
    });

    expect(explicitResult.prompt).toContain(`attachment:${seeded.attachment.id}`);
    expect(explicitResult.trace.selected[0]?.attachmentId).toBe(seeded.attachment.id);
  });

  it("traces only directory entries that fit inside the prompt budget", () => {
    const { store } = createHarness().open();
    seedDirectory(store, {
      suffix: "budget-1",
      title: "Budget Directory One",
      summary: "First summary with enough detail to consume part of the compact context budget.",
      channelId: "channel-1",
      threadId: "thread-1",
    });
    seedDirectory(store, {
      suffix: "budget-2",
      title: "Budget Directory Two",
      summary: "Second summary with enough detail to consume part of the compact context budget.",
      channelId: "channel-1",
      threadId: "thread-1",
    });
    seedDirectory(store, {
      suffix: "budget-3",
      title: "Budget Directory Three",
      summary: "Third summary with enough detail to consume part of the compact context budget.",
      channelId: "channel-1",
      threadId: "thread-1",
    });

    const result = buildAttachmentDirectoryContext({
      store,
      conversationKey: "thread:thread-1",
      discordChannelId: "channel-1",
      agentId: "watson",
      currentUserPrompt: "attachment budget validation",
      maxEntries: 3,
      maxChars: 1200,
    });

    expect(result.trace.selected.length).toBeGreaterThan(0);
    expect(result.trace.selected.length).toBeLessThan(3);
    expect(result.trace.omittedCount).toBe(3 - result.trace.selected.length);
    for (const entry of result.trace.selected) {
      expect(result.prompt).toContain(`attachment:${entry.attachmentId}`);
    }
  });
});
