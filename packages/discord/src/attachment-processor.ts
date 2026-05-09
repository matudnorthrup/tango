import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { Collection, Attachment, Snowflake } from "discord.js";

const ATTACHMENT_BASE_DIR = "/tmp/tango-attachments";
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB

const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export interface ProcessedAttachment {
  filename: string;
  localPath: string;
  contentType: string;
  size: number;
  type: "image";
}

export interface AttachmentResult {
  processed: ProcessedAttachment[];
  promptSuffix: string;
  tempDir: string | null;
}

export async function processAttachments(
  attachments: Collection<Snowflake, Attachment>,
  sessionId: string
): Promise<AttachmentResult> {
  const items = [...attachments.values()];
  if (items.length === 0) {
    return { processed: [], promptSuffix: "", tempDir: null };
  }

  // Filter to images only (Phase 1)
  const imageItems = items.filter(
    (a) => a.contentType && IMAGE_MIME_TYPES.has(a.contentType)
  );
  if (imageItems.length === 0) {
    return { processed: [], promptSuffix: "", tempDir: null };
  }

  const tempDir = join(ATTACHMENT_BASE_DIR, sessionId);
  mkdirSync(tempDir, { recursive: true });

  const processed: ProcessedAttachment[] = [];

  for (const attachment of imageItems) {
    const contentType = attachment.contentType!;
    const size = attachment.size;
    const filename = attachment.name ?? `attachment-${attachment.id}`;

    if (size > MAX_IMAGE_SIZE) {
      console.warn(
        `[attachment-processor] skipping oversized image: ${filename} (${(size / 1024 / 1024).toFixed(1)}MB > 20MB)`
      );
      continue;
    }

    try {
      const response = await fetch(attachment.url);
      if (!response.ok) {
        console.warn(
          `[attachment-processor] download failed for ${filename}: HTTP ${response.status}`
        );
        continue;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      const localPath = join(tempDir, filename);
      writeFileSync(localPath, buffer);
      processed.push({ filename, localPath, contentType, size, type: "image" });
    } catch (err) {
      console.warn(
        `[attachment-processor] download error for ${filename}: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  let promptSuffix = "";
  if (processed.length > 0) {
    const lines = processed.map((p, i) => {
      const sizeKB = (p.size / 1024).toFixed(0);
      return `${i + 1}. ${p.filename} (${p.contentType}, ${sizeKB}KB) — Read the file at ${p.localPath} to view this image.`;
    });
    promptSuffix = `\n\n[Attachments]\n${lines.join("\n")}`;
  }

  return { processed, promptSuffix, tempDir };
}

export function cleanupAttachments(tempDir: string | null): void {
  if (!tempDir) return;
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch (err) {
    console.warn(
      `[attachment-processor] cleanup failed for ${tempDir}: ${err instanceof Error ? err.message : err}`
    );
  }
}
