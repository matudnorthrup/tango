import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Collection, type Attachment, type Snowflake } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentStore, TangoStorage } from "@tango/core";
import { cleanupAttachments, processAttachments } from "../src/attachment-processor.js";

interface Harness {
  dir: string;
  dataDir: string;
  storage: TangoStorage;
  store: AttachmentStore;
}

interface FetchResponse {
  body: Buffer;
  contentType?: string;
  status?: number;
}

const harnesses: Harness[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  while (harnesses.length > 0) {
    const harness = harnesses.pop();
    if (!harness) continue;
    harness.storage.close();
    fs.rmSync(harness.dir, { recursive: true, force: true });
  }
});

function createHarness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-discord-attachments-"));
  const storage = new TangoStorage(path.join(dir, "tango.sqlite"));
  const harness = {
    dir,
    dataDir: path.join(dir, "data"),
    storage,
    store: new AttachmentStore(storage.getDatabase()),
  };
  harnesses.push(harness);
  return harness;
}

function stubFetch(responses: Map<string, FetchResponse>) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    const response = responses.get(url);
    if (!response) {
      return new Response("missing", { status: 404 });
    }

    return new Response(new Uint8Array(response.body), {
      status: response.status ?? 200,
      headers: response.contentType ? { "content-type": response.contentType } : undefined,
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function createAttachment(input: {
  id: string;
  name: string;
  url: string;
  contentType: string | null;
  size: number;
}): Attachment {
  return {
    id: input.id,
    name: input.name,
    url: input.url,
    proxyURL: `${input.url}?proxy=1`,
    contentType: input.contentType,
    size: input.size,
  } as unknown as Attachment;
}

function createAttachments(...items: Attachment[]): Collection<Snowflake, Attachment> {
  const collection = new Collection<Snowflake, Attachment>();
  for (const item of items) {
    collection.set(item.id, item);
  }
  return collection;
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function countRows(storage: TangoStorage, sql: string): number {
  const row = storage.getDatabase().prepare(sql).get() as { count: number };
  return row.count;
}

describe("processAttachments", () => {
  it("persists durable images and points the prompt at the stored source path", async () => {
    const harness = createHarness();
    const image = Buffer.from("durable image bytes", "utf8");
    const url = "https://cdn.discord.test/receipt.png";
    const fetchMock = stubFetch(new Map([[url, { body: image, contentType: "image/png" }]]));

    const result = await processAttachments(
      createAttachments(createAttachment({
        id: "discord-attachment-image",
        name: "receipt image.png",
        url,
        contentType: "image/png",
        size: image.byteLength,
      })),
      "session-1",
      {
        attachmentStore: harness.store,
        dataDir: harness.dataDir,
        sourceRefs: {
          agentId: "agent-porter",
          localMessageId: 42,
          discordMessageId: "discord-message-1",
          channelId: "parent-channel",
          threadId: "thread-channel",
          userId: "discord-user",
          projectId: "project-1",
          metadata: { channelKey: "discord:parent-channel" },
        },
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.tempDir).toBeNull();
    expect(result.processed).toHaveLength(1);
    const processed = result.processed[0]!;
    expect(processed).toMatchObject({
      discordAttachmentId: "discord-attachment-image",
      filename: "receipt image.png",
      contentType: "image/png",
      size: image.byteLength,
      type: "image",
      durable: true,
    });
    expect(processed.localPath.startsWith(harness.dataDir)).toBe(true);
    expect(fs.readFileSync(processed.localPath)).toEqual(image);
    expect(result.promptSuffix).toContain(`Read the file at ${processed.localPath}`);

    cleanupAttachments(result.tempDir);
    expect(fs.existsSync(processed.localPath)).toBe(true);

    const file = harness.store.findSourceFileBySha256(sha256(image));
    expect(file).toMatchObject({
      role: "source",
      bytes: image.byteLength,
      contentType: "image/png",
      originalFilename: "receipt image.png",
      storagePath: processed.localPath,
      status: "available",
    });

    const logical = harness.store.findAttachmentByDiscordAttachmentId("discord-attachment-image");
    expect(result.promptSuffix).toContain(`Stored as attachment:${logical?.id}`);
    expect(logical).toMatchObject({
      projectId: "project-1",
      agentId: "agent-porter",
      sessionId: "session-1",
      messageId: "42",
      channelId: "parent-channel",
      threadId: "thread-channel",
      userId: "discord-user",
      discordAttachmentId: "discord-attachment-image",
      fileId: file?.id,
      originalFilename: "receipt image.png",
      contentType: "image/png",
      bytes: image.byteLength,
      status: "received",
    });
    expect(logical?.metadata).toMatchObject({
      source: "discord",
      discordMessageId: "discord-message-1",
      sourceUrl: url,
      storagePath: processed.localPath,
      sha256: sha256(image),
      sourceRefs: { channelKey: "discord:parent-channel" },
    });
    expect(harness.store.listJobs({ attachmentId: logical!.id })).toMatchObject([
      {
        attachmentId: logical!.id,
        kind: "classify",
        status: "pending",
        metadata: { queuedBy: "discord_attachment_intake" },
      },
    ]);
  });

  it("persists non-image attachments and points the prompt at attachment tools", async () => {
    const harness = createHarness();
    const pdf = Buffer.from("%PDF-1.7 invoice bytes", "utf8");
    const url = "https://cdn.discord.test/invoice.pdf";
    stubFetch(new Map([[url, { body: pdf, contentType: "application/pdf" }]]));

    const result = await processAttachments(
      createAttachments(createAttachment({
        id: "discord-attachment-pdf",
        name: "invoice.pdf",
        url,
        contentType: "application/pdf",
        size: pdf.byteLength,
      })),
      "session-2",
      {
        attachmentStore: harness.store,
        dataDir: harness.dataDir,
        sourceRefs: {
          agentId: "agent-porter",
          localMessageId: "message-2",
          discordMessageId: "discord-message-2",
          channelId: "channel-2",
        },
      },
    );

    expect(result.processed).toHaveLength(1);
    expect(result.processed[0]).toMatchObject({
      discordAttachmentId: "discord-attachment-pdf",
      filename: "invoice.pdf",
      contentType: "application/pdf",
      type: "file",
      durable: true,
    });
    expect(fs.readFileSync(result.processed[0]!.localPath)).toEqual(pdf);
    const logical = harness.store.findAttachmentByDiscordAttachmentId("discord-attachment-pdf");
    expect(result.promptSuffix).toContain("invoice.pdf (application/pdf");
    expect(result.promptSuffix).toContain(`Stored as attachment:${logical?.id}`);
    expect(result.promptSuffix).toContain("Use attachment_read for extracted text");
    expect(logical).toMatchObject({
      sessionId: "session-2",
      messageId: "message-2",
      contentType: "application/pdf",
      bytes: pdf.byteLength,
    });
    expect(harness.store.listJobs({ attachmentId: logical!.id })).toMatchObject([
      {
        kind: "classify",
        status: "pending",
      },
    ]);
  });

  it("dedupes duplicate bytes while creating separate logical Discord attachment rows", async () => {
    const harness = createHarness();
    const data = Buffer.from("same bytes uploaded twice", "utf8");
    const firstUrl = "https://cdn.discord.test/first.png";
    const secondUrl = "https://cdn.discord.test/renamed.jpg";
    stubFetch(new Map([
      [firstUrl, { body: data, contentType: "image/png" }],
      [secondUrl, { body: data, contentType: "image/jpeg" }],
    ]));

    const result = await processAttachments(
      createAttachments(
        createAttachment({
          id: "discord-attachment-first",
          name: "first.png",
          url: firstUrl,
          contentType: "image/png",
          size: data.byteLength,
        }),
        createAttachment({
          id: "discord-attachment-second",
          name: "renamed.jpg",
          url: secondUrl,
          contentType: "image/jpeg",
          size: data.byteLength,
        }),
      ),
      "session-3",
      {
        attachmentStore: harness.store,
        dataDir: harness.dataDir,
        sourceRefs: {
          agentId: "agent-porter",
          localMessageId: "message-3",
          discordMessageId: "discord-message-3",
          channelId: "channel-3",
        },
      },
    );

    expect(result.processed).toHaveLength(2);
    expect(countRows(
      harness.storage,
      "SELECT COUNT(*) AS count FROM attachment_files WHERE role = 'source'",
    )).toBe(1);
    expect(countRows(
      harness.storage,
      "SELECT COUNT(*) AS count FROM attachments",
    )).toBe(2);

    const first = harness.store.findAttachmentByDiscordAttachmentId("discord-attachment-first");
    const second = harness.store.findAttachmentByDiscordAttachmentId("discord-attachment-second");
    expect(first?.id).not.toBe(second?.id);
    expect(first?.fileId).toBe(second?.fileId);
    expect(first).toMatchObject({ originalFilename: "first.png", contentType: "image/png" });
    expect(second).toMatchObject({ originalFilename: "renamed.jpg", contentType: "image/jpeg" });
    expect(result.processed[0]!.localPath).toBe(result.processed[1]!.localPath);
    expect(countRows(
      harness.storage,
      "SELECT COUNT(*) AS count FROM attachment_jobs WHERE kind = 'classify'",
    )).toBe(2);
  });

  it("is idempotent when the same Discord attachment id is processed again", async () => {
    const harness = createHarness();
    const image = Buffer.from("same discord id", "utf8");
    const url = "https://cdn.discord.test/same-id.png";
    const attachment = createAttachment({
      id: "discord-attachment-repeat",
      name: "same-id.png",
      url,
      contentType: "image/png",
      size: image.byteLength,
    });
    const fetchMock = stubFetch(new Map([[url, { body: image, contentType: "image/png" }]]));
    const collection = createAttachments(attachment);

    const first = await processAttachments(collection, "session-4", {
      attachmentStore: harness.store,
      dataDir: harness.dataDir,
      sourceRefs: {
        agentId: "agent-porter",
        localMessageId: "message-4",
        discordMessageId: "discord-message-4",
        channelId: "channel-4",
      },
    });
    fetchMock.mockClear();
    const second = await processAttachments(collection, "session-4", {
      attachmentStore: harness.store,
      dataDir: harness.dataDir,
      sourceRefs: {
        agentId: "agent-porter",
        localMessageId: "message-4",
        discordMessageId: "discord-message-4",
        channelId: "channel-4",
      },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(countRows(
      harness.storage,
      "SELECT COUNT(*) AS count FROM attachment_files WHERE role = 'source'",
    )).toBe(1);
    expect(countRows(
      harness.storage,
      "SELECT COUNT(*) AS count FROM attachments",
    )).toBe(1);
    expect(second.processed).toHaveLength(1);
    expect(second.processed[0]!.localPath).toBe(first.processed[0]!.localPath);
    expect(second.promptSuffix).toContain(first.processed[0]!.localPath);
    expect(countRows(
      harness.storage,
      "SELECT COUNT(*) AS count FROM attachment_jobs WHERE kind = 'classify'",
    )).toBe(1);
  });

  it("keeps the temp-file fallback when no durable store is provided", async () => {
    const image = Buffer.from("legacy temp image", "utf8");
    const url = "https://cdn.discord.test/temp.png";
    const sessionId = `session-temp-${randomUUID()}`;
    stubFetch(new Map([[url, { body: image, contentType: "image/png" }]]));

    const result = await processAttachments(
      createAttachments(createAttachment({
        id: "discord-attachment-temp",
        name: "temp.png",
        url,
        contentType: "image/png",
        size: image.byteLength,
      })),
      sessionId,
    );

    try {
      expect(result.tempDir).toBe(path.join("/tmp/tango-attachments", sessionId));
      expect(result.processed).toHaveLength(1);
      expect(result.processed[0]).toMatchObject({
        discordAttachmentId: "discord-attachment-temp",
        filename: "temp.png",
        type: "image",
        durable: false,
      });
      expect(fs.readFileSync(result.processed[0]!.localPath)).toEqual(image);
      expect(result.promptSuffix).toContain(`Read the file at ${result.processed[0]!.localPath}`);
    } finally {
      cleanupAttachments(result.tempDir);
    }

    expect(fs.existsSync(path.join("/tmp/tango-attachments", sessionId))).toBe(false);
  });
});
