import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AttachmentStore, TangoStorage, type AgentTool } from "@tango/core";
import { createAttachmentTools } from "../src/attachment-agent-tools.js";

interface Harness {
  dir: string;
  storage: TangoStorage;
  store: AttachmentStore;
}

interface SeededAttachment {
  attachmentId: number;
  extractionId: number;
  chunkId: number;
}

const harnesses: Harness[] = [];

afterEach(() => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop();
    if (!harness) continue;
    harness.storage.close();
    fs.rmSync(harness.dir, { recursive: true, force: true });
  }
});

function createHarness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-attachment-agent-tools-"));
  const storage = new TangoStorage(path.join(dir, "tango.sqlite"), { seedExampleRoster: true });
  const harness = {
    dir,
    storage,
    store: new AttachmentStore(storage.getDatabase()),
  };
  harnesses.push(harness);
  return harness;
}

function toolByName(tools: AgentTool[], name: string): AgentTool {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

function seedReadyAttachment(store: AttachmentStore): SeededAttachment {
  const file = store.upsertFile({
    sha256: "sha256-receipt",
    bytes: 2048,
    contentType: "image/png",
    originalFilename: "receipt.png",
    storagePath: "/tmp/private/tango/attachments/source/sha256-receipt.png",
    metadata: { source: "test" },
  });
  const attachment = store.createAttachment({
    projectId: "project-1",
    agentId: "agent-watson",
    sessionId: "session-1",
    messageId: "local-message-1",
    channelId: "channel-1",
    threadId: "thread-1",
    userId: "user-1",
    discordAttachmentId: "discord-attachment-1",
    fileId: file.id,
    title: "Receipt image",
    originalFilename: "receipt.png",
    contentType: "image/png",
    bytes: 2048,
    metadata: {
      discordMessageId: "discord-message-1",
      storagePath: file.storagePath,
    },
  });
  const text = "Corner Market\nTotal $12.34\nSerial BANANA-77";
  const extraction = store.addExtraction({
    attachmentId: attachment.id,
    method: "apple_vision_ocr",
    text,
    confidence: 0.96,
    quality: { lineCount: 3 },
    metadata: { engine: "apple-vision" },
  });
  const chunk = store.addChunk({
    attachmentId: attachment.id,
    extractionId: extraction.id,
    ordinal: 0,
    text,
    tokenEstimate: 10,
    metadata: { charStart: 0, charEnd: text.length },
  });

  store.addDirectory({
    attachmentId: attachment.id,
    schemaVersion: 1,
    projectId: "project-1",
    agentId: "agent-watson",
    sessionId: "session-1",
    messageId: "local-message-1",
    channelId: "channel-1",
    threadId: "thread-1",
    userId: "user-1",
    status: "ready",
    directory: {
      schema: "attachment_directory_v1",
      schema_version: 1,
      title: "receipt.png",
      status: "ready",
      summary: "Corner Market receipt. Total $12.34.",
      types: ["image/png", "image", "ocr_text"],
      tags: ["receipt", "corner-market", "apple_vision_ocr"],
      source: {
        attachment_id: attachment.id,
        attachment_ref: `attachment:${attachment.id}`,
        file_id: file.id,
        file_ref: `attachment_file:${file.id}`,
        file_sha256: file.sha256,
        discord_message_id: "discord-message-1",
        discord_attachment_id: "discord-attachment-1",
        message_ref: "discord:channel-1:thread-1:discord-message-1",
        refs: [
          `attachment:${attachment.id}`,
          `attachment_file:${file.id}`,
          "discord:channel-1:thread-1:discord-message-1",
        ],
      },
      extraction: {
        extraction_id: extraction.id,
        method: "apple_vision_ocr",
        confidence: 0.96,
        chunk_count: 1,
        source_ref: `extraction:${extraction.id}`,
      },
      content_profile: {
        text_density: "medium",
        visual_density: "low",
      },
      snippets: [
        {
          text: "Total $12.34",
          source_ref: `chunk:${chunk.id}`,
          text_ref: `text:${extraction.id}:chars:14-26`,
          chunk_ref: `chunk:${chunk.id}`,
        },
      ],
      key_facts: [
        {
          label: "total",
          value: "$12.34",
          source_ref: `chunk:${chunk.id}`,
        },
      ],
      notable_quotes: [
        {
          text: "Serial BANANA-77",
          source_ref: `chunk:${chunk.id}`,
        },
      ],
      tables: [],
      visual_notes: [
        {
          text: "Small receipt screenshot with clear text.",
          source_ref: `attachment:${attachment.id}`,
        },
      ],
      chunks: {
        count: 1,
        items: [
          {
            chunk_id: chunk.id,
            ordinal: 0,
            text_preview: "Corner Market Total $12.34",
            source_ref: `text:${extraction.id}:chars:0-${text.length}`,
          },
        ],
      },
      available_reads: ["summary", "directory", "source_file", "extracted_text", "chunks", "quotes"],
      warnings: [],
    },
    metadata: { generatedBy: "test" },
  });
  store.updateAttachmentStatus(attachment.id, "ready");

  return {
    attachmentId: attachment.id,
    extractionId: extraction.id,
    chunkId: chunk.id,
  };
}

function seedFailedAttachment(store: AttachmentStore) {
  const file = store.upsertFile({
    sha256: "sha256-failed",
    bytes: 64,
    contentType: "application/pdf",
    originalFilename: "failed.pdf",
    storagePath: "/tmp/private/tango/attachments/source/sha256-failed.pdf",
  });
  return store.createAttachment({
    projectId: "project-1",
    agentId: "agent-watson",
    sessionId: "session-1",
    channelId: "channel-1",
    userId: "user-1",
    discordAttachmentId: "discord-attachment-failed",
    fileId: file.id,
    originalFilename: "failed.pdf",
    contentType: "application/pdf",
    bytes: 64,
    status: "failed",
  });
}

describe("attachment agent tools", () => {
  it("uses Claude-compatible top-level JSON schemas", () => {
    const harness = createHarness();
    const tools = createAttachmentTools({ storage: harness.storage, store: harness.store });

    for (const tool of tools) {
      expect(tool.inputSchema).not.toHaveProperty("anyOf");
      expect(tool.inputSchema).not.toHaveProperty("oneOf");
      expect(tool.inputSchema).not.toHaveProperty("allOf");
    }
  });

  it("searches directory summaries and chunk text without exposing local source paths", async () => {
    const harness = createHarness();
    const seeded = seedReadyAttachment(harness.store);
    const tools = createAttachmentTools({ storage: harness.storage, store: harness.store });
    const search = toolByName(tools, "attachment_search");

    const totalResult = await search.handler({
      query: "total",
      project_id: "project-1",
      limit: 5,
    }) as {
      result_count: number;
      results: Array<{
        attachment_id: number;
        summary: string;
        source: { attachment_ref: string; message_ref: string };
      }>;
    };

    expect(totalResult.result_count).toBe(1);
    expect(totalResult.results[0]).toMatchObject({
      attachment_id: seeded.attachmentId,
      summary: "Corner Market receipt. Total $12.34.",
      source: {
        attachment_ref: `attachment:${seeded.attachmentId}`,
        message_ref: "discord:channel-1:thread-1:discord-message-1",
      },
    });
    expect(JSON.stringify(totalResult)).not.toContain("/tmp/private");
    expect(JSON.stringify(totalResult)).not.toContain("storagePath");

    const chunkResult = await search.handler({
      query: "BANANA-77",
      project_id: "project-1",
    }) as {
      result_count: number;
      results: Array<{
        matching_chunks: Array<{ chunk_id: number; snippet: string; source_ref: string }>;
      }>;
    };

    expect(chunkResult.result_count).toBe(1);
    expect(chunkResult.results[0]?.matching_chunks[0]).toMatchObject({
      chunk_id: seeded.chunkId,
      snippet: expect.stringContaining("BANANA-77"),
      source_ref: `text:${seeded.extractionId}:chars:0-43`,
    });
  });

  it("reads bounded summaries, chunks, and extracted text with source refs", async () => {
    const harness = createHarness();
    const seeded = seedReadyAttachment(harness.store);
    const tools = createAttachmentTools({ storage: harness.storage, store: harness.store });
    const read = toolByName(tools, "attachment_read");

    const summary = await read.handler({
      id: `attachment:${seeded.attachmentId}`,
      mode: "summary",
    }) as {
      summary: string;
      source: { attachment_ref: string };
      snippets: Array<{ text: string; text_ref: string }>;
    };
    expect(summary).toMatchObject({
      summary: "Corner Market receipt. Total $12.34.",
      source: { attachment_ref: `attachment:${seeded.attachmentId}` },
    });
    expect(summary.snippets[0]).toMatchObject({
      text: "Total $12.34",
      text_ref: `text:${seeded.extractionId}:chars:14-26`,
    });

    const chunks = await read.handler({
      attachment_id: seeded.attachmentId,
      mode: "chunks",
      query: "serial",
      max_chars: 200,
    }) as {
      result_count: number;
      chunks: Array<{ text: string; source_ref: string; chunk_ref: string }>;
    };
    expect(chunks.result_count).toBe(1);
    expect(chunks.chunks[0]).toMatchObject({
      text: expect.stringContaining("Serial BANANA-77"),
      source_ref: `text:${seeded.extractionId}:chars:0-43`,
      chunk_ref: `chunk:${seeded.chunkId}`,
    });

    const exactText = await read.handler({
      attachment_id: seeded.attachmentId,
      mode: "extracted_text",
      offset: 14,
      max_chars: 5,
    }) as {
      text: string;
      source_ref: string;
      truncated: boolean;
      total_chars: number;
    };
    expect(exactText).toMatchObject({
      text: "Total",
      source_ref: `text:${seeded.extractionId}:chars:14-19`,
      truncated: true,
      total_chars: 43,
    });
  });

  it("reports scoped status counts and recent job summaries", async () => {
    const harness = createHarness();
    const seeded = seedReadyAttachment(harness.store);
    seedFailedAttachment(harness.store);
    harness.store.enqueueJob({ attachmentId: seeded.attachmentId, kind: "directory" });
    const tools = createAttachmentTools({ storage: harness.storage, store: harness.store });
    const status = toolByName(tools, "attachment_status");

    const result = await status.handler({
      project_id: "project-1",
      limit: 10,
    }) as {
      counts: { total: number; ready: number; failed: number };
      recent: Array<{ attachment_id: number; job_summary: { pending: number } }>;
    };

    expect(result.counts).toMatchObject({
      total: 2,
      ready: 1,
      failed: 1,
    });
    expect(result.recent.find((entry) => entry.attachment_id === seeded.attachmentId)).toMatchObject({
      job_summary: { pending: 1 },
    });
  });

  it("queues reprocessing idempotently for an attachment", async () => {
    const harness = createHarness();
    const seeded = seedReadyAttachment(harness.store);
    const tools = createAttachmentTools({ storage: harness.storage, store: harness.store });
    const reprocess = toolByName(tools, "attachment_reprocess");

    const queued = await reprocess.handler({
      id: `attachment:${seeded.attachmentId}`,
      strategy: "apple_ocr",
      reason: "test retry",
    }) as {
      queued: boolean;
      job: { job_id: number; kind: string; status: string };
    };
    expect(queued).toMatchObject({
      queued: true,
      job: {
        kind: "apple_ocr",
        status: "pending",
      },
    });
    expect(harness.store.getAttachment(seeded.attachmentId)?.status).toBe("processing");

    const second = await reprocess.handler({
      attachment_id: seeded.attachmentId,
      strategy: "apple_ocr",
    }) as {
      queued: boolean;
      existing_job: { job_id: number; kind: string; status: string };
    };
    expect(second).toMatchObject({
      queued: false,
      existing_job: {
        job_id: queued.job.job_id,
        kind: "apple_ocr",
        status: "pending",
      },
    });
  });
});
