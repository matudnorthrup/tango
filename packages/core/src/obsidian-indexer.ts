import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { EmbeddingProvider } from "./embeddings.js";
import { backfillMarkdownFiles } from "./memory-backfill.js";
import { resolveTangoProfileDir } from "./runtime-paths.js";
import { TangoStorage } from "./storage.js";

const LEGACY_VAULT_PATH = "~/Documents/main";
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const DEFAULT_EXCLUDED_PREFIXES = [
  ".obsidian/",
  "_Schema/",
  "Attachments/",
  "AI/Conversations/",
  "AI/Digests/",
  "AI/Insights/",
  "AI/Threads/",
  "Clippings/",
];

export interface ObsidianIndexInput {
  storage: TangoStorage;
  paths?: string[];
  chunkChars?: number;
  dryRun?: boolean;
  includeClippings?: boolean;
  includeAiTranscripts?: boolean;
  excludePrefixes?: string[];
  embeddingProvider?: EmbeddingProvider | null;
  now?: Date;
}

export interface IndexedObsidianFile {
  filePath: string;
  status: "new" | "updated";
  chunkCount: number;
  deletedMemoryCount: number;
}

export interface RemovedObsidianFile {
  filePath: string;
  deletedMemoryCount: number;
}

export interface ObsidianIndexResult {
  scannedFileCount: number;
  indexedFileCount: number;
  unchangedFileCount: number;
  removedFileCount: number;
  insertedMemoryCount: number;
  deletedMemoryCount: number;
  indexedFiles: IndexedObsidianFile[];
  removedFiles: RemovedObsidianFile[];
}

function resolveDefaultVaultPath(): string {
  const configured = process.env.TANGO_OBSIDIAN_VAULT?.trim();
  if (configured && configured.length > 0) {
    return configured;
  }

  const profileNotesPath = path.join(resolveTangoProfileDir(), "notes");
  if (fs.existsSync(profileNotesPath)) {
    return profileNotesPath;
  }

  const legacyVaultPath = expandHome(LEGACY_VAULT_PATH);
  if (fs.existsSync(legacyVaultPath)) {
    return LEGACY_VAULT_PATH;
  }

  return profileNotesPath;
}

export async function indexObsidianVault(
  input: ObsidianIndexInput
): Promise<ObsidianIndexResult> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const files = collectEligibleFiles(input.paths ?? [resolveDefaultVaultPath()], {
    includeClippings: input.includeClippings === true,
    includeAiTranscripts: input.includeAiTranscripts === true,
    excludePrefixes: input.excludePrefixes ?? [],
  });
  const indexedEntries = input.storage.listObsidianIndexEntries(50_000);
  const indexedByPath = new Map(indexedEntries.map((entry) => [entry.filePath, entry]));
  const liveFiles = new Set(files);
  const result: ObsidianIndexResult = {
    scannedFileCount: files.length,
    indexedFileCount: 0,
    unchangedFileCount: 0,
    removedFileCount: 0,
    insertedMemoryCount: 0,
    deletedMemoryCount: 0,
    indexedFiles: [],
    removedFiles: [],
  };

  for (const filePath of files) {
    const fileHash = hashFile(filePath);
    const existing = indexedByPath.get(filePath);
    if (existing?.fileHash === fileHash) {
      result.unchangedFileCount += 1;
      continue;
    }

    const status: "new" | "updated" = existing ? "updated" : "new";
    const sourceRefPrefix = buildSourceRefPrefix(filePath);

    if (input.dryRun) {
      result.indexedFileCount += 1;
      result.indexedFiles.push({
        filePath,
        status,
        chunkCount: existing?.chunkCount ?? 0,
        deletedMemoryCount: existing?.chunkCount ?? 0,
      });
      continue;
    }

    const deletedMemoryCount = input.storage.deleteMemoriesBySourceRefPrefix("obsidian", sourceRefPrefix);
    const backfillResult = await backfillMarkdownFiles({
      storage: input.storage,
      paths: [filePath],
      memorySource: "obsidian",
      chunkChars: input.chunkChars,
      embeddingProvider: input.embeddingProvider,
    });
    const chunkCount = backfillResult.insertedSourceRefs.filter((sourceRef) =>
      sourceRef.startsWith(sourceRefPrefix)
    ).length;

    input.storage.upsertObsidianIndexEntry({
      filePath,
      fileHash,
      chunkCount,
      lastIndexedAt: nowIso,
    });

    result.indexedFileCount += 1;
    result.insertedMemoryCount += backfillResult.insertedCount;
    result.deletedMemoryCount += deletedMemoryCount;
    result.indexedFiles.push({
      filePath,
      status,
      chunkCount,
      deletedMemoryCount,
    });
  }

  for (const entry of indexedEntries) {
    if (liveFiles.has(entry.filePath)) continue;

    if (input.dryRun) {
      result.removedFileCount += 1;
      result.removedFiles.push({
        filePath: entry.filePath,
        deletedMemoryCount: entry.chunkCount,
      });
      continue;
    }

    const deletedMemoryCount = input.storage.deleteMemoriesBySourceRefPrefix(
      "obsidian",
      buildSourceRefPrefix(entry.filePath)
    );
    input.storage.deleteObsidianIndexEntry(entry.filePath);

    result.removedFileCount += 1;
    result.deletedMemoryCount += deletedMemoryCount;
    result.removedFiles.push({
      filePath: entry.filePath,
      deletedMemoryCount,
    });
  }

  return result;
}

function collectEligibleFiles(
  inputs: string[],
  options: {
    includeClippings: boolean;
    includeAiTranscripts: boolean;
    excludePrefixes: string[];
  }
): string[] {
  const results = new Set<string>();

  for (const inputPath of inputs) {
    const resolved = path.resolve(expandHome(inputPath));
    if (!fs.existsSync(resolved)) continue;

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      walkDirectory(resolved, resolved, options, (filePath) => {
        results.add(filePath);
      });
      continue;
    }

    if (isMarkdownFile(resolved) && !path.basename(resolved).startsWith(".")) {
      results.add(resolved);
    }
  }

  return [...results].sort((left, right) => left.localeCompare(right));
}

function walkDirectory(
  rootPath: string,
  currentPath: string,
  options: {
    includeClippings: boolean;
    includeAiTranscripts: boolean;
    excludePrefixes: string[];
  },
  visit: (filePath: string) => void
): void {
  for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;

    const entryPath = path.join(currentPath, entry.name);
    const relativePath = toRelativePath(rootPath, entryPath);
    if (!shouldIncludeRelativePath(relativePath, options)) continue;

    if (entry.isDirectory()) {
      walkDirectory(rootPath, entryPath, options, visit);
      continue;
    }

    if (entry.isFile() && isMarkdownFile(entryPath)) {
      visit(entryPath);
    }
  }
}

function shouldIncludeRelativePath(
  relativePath: string,
  options: {
    includeClippings: boolean;
    includeAiTranscripts: boolean;
    excludePrefixes: string[];
  }
): boolean {
  const normalized = relativePath.replace(/\\/gu, "/");
  if (normalized.length === 0) return false;
  if (normalized.split("/").some((segment) => segment.startsWith(".") || segment.startsWith(".!"))) {
    return false;
  }

  const excludedPrefixes = [...DEFAULT_EXCLUDED_PREFIXES, ...options.excludePrefixes]
    .filter((prefix) => prefix.length > 0)
    .map((prefix) => prefix.replace(/\\/gu, "/").replace(/^\/+/u, ""));

  for (const prefix of excludedPrefixes) {
    if (prefix === "Clippings/" && options.includeClippings) continue;
    if (
      (prefix === "AI/Conversations/" ||
        prefix === "AI/Digests/" ||
        prefix === "AI/Insights/" ||
        prefix === "AI/Threads/") &&
      options.includeAiTranscripts
    ) {
      continue;
    }

    if (normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)) {
      return false;
    }
  }

  return true;
}

function hashFile(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function isMarkdownFile(filePath: string): boolean {
  return MARKDOWN_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function buildSourceRefPrefix(filePath: string): string {
  return `obsidian:${filePath}#`;
}

function toRelativePath(rootPath: string, targetPath: string): string {
  return path.relative(rootPath, targetPath).split(path.sep).join("/");
}

function expandHome(inputPath: string): string {
  if (inputPath === "~") return process.env.HOME ?? inputPath;
  if (inputPath.startsWith("~/")) {
    return path.join(process.env.HOME ?? "", inputPath.slice(2));
  }
  return inputPath;
}
