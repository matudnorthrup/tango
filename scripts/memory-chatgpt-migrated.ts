#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";
import {
  createVoyageEmbeddingProviderFromEnv,
  importMigratedChatGptExports,
  resolveDatabasePath,
  TangoStorage,
  triageMigratedChatGptExports,
  type MemorySource,
} from "../packages/core/src/index.ts";

interface CliOptions {
  dbPath?: string;
  paths: string[];
  sessionId?: string;
  agentId?: string;
  memorySource: MemorySource;
  limitFiles?: number;
  maxConversationsPerFile?: number;
  minConversationScore?: number;
  maxDurableMemoriesPerConversation?: number;
  reportLimit: number;
  dryRun: boolean;
  triageOnly: boolean;
  useEmbeddings: boolean;
  outputPath?: string;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const triage = triageMigratedChatGptExports({
    paths: options.paths.length > 0 ? options.paths : undefined,
    maxDurableMemoriesPerConversation: options.maxDurableMemoriesPerConversation,
  });

  if (options.triageOnly) {
    const output = {
      triage: summarizeTriage(triage, options.reportLimit),
    };
    writeOutput(output, options.outputPath);
    return;
  }

  const dbPath = resolveDatabasePath(options.dbPath);
  const storage = new TangoStorage(dbPath);
  const embeddingProvider = options.useEmbeddings ? createVoyageEmbeddingProviderFromEnv() : null;

  try {
    const result = await importMigratedChatGptExports({
      storage,
      paths: options.paths.length > 0 ? options.paths : undefined,
      sessionId: options.sessionId ?? null,
      agentId: options.agentId ?? null,
      memorySource: options.memorySource,
      embeddingProvider,
      limitFiles: options.limitFiles,
      maxConversationsPerFile: options.maxConversationsPerFile,
      minConversationScore: options.minConversationScore,
      maxDurableMemoriesPerConversation: options.maxDurableMemoriesPerConversation,
      dryRun: options.dryRun,
    });

    const output = {
      dbPath,
      dryRun: options.dryRun,
      triage: summarizeTriage(result.triage, options.reportLimit),
      import: {
        selectedFileCount: result.selectedFileCount,
        selectedConversationCount: result.selectedConversationCount,
        candidateCount: result.candidateCount,
        insertedCount: result.insertedCount,
        skippedCount: result.skippedCount,
        selectedFiles: result.selectedFiles,
      },
    };

    writeOutput(output, options.outputPath);
  } finally {
    storage.close();
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    paths: [],
    memorySource: "backfill",
    reportLimit: 12,
    dryRun: false,
    triageOnly: false,
    useEmbeddings: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    switch (arg) {
      case "--db":
      case "--db-path":
        if (!next) throw new Error(`${arg} requires a value`);
        options.dbPath = next;
        index += 1;
        break;
      case "--path":
        if (!next) throw new Error("--path requires a value");
        options.paths.push(next);
        index += 1;
        break;
      case "--session-id":
        if (!next) throw new Error("--session-id requires a value");
        options.sessionId = next;
        index += 1;
        break;
      case "--agent-id":
        if (!next) throw new Error("--agent-id requires a value");
        options.agentId = next;
        index += 1;
        break;
      case "--memory-source":
        if (!next || !isMemorySource(next)) {
          throw new Error("--memory-source must be one of: backfill, manual, obsidian, conversation, reflection");
        }
        options.memorySource = next;
        index += 1;
        break;
      case "--limit-files":
        if (!next) throw new Error("--limit-files requires a value");
        options.limitFiles = parseInteger(next, "--limit-files");
        index += 1;
        break;
      case "--max-conversations-per-file":
        if (!next) throw new Error("--max-conversations-per-file requires a value");
        options.maxConversationsPerFile = parseInteger(next, "--max-conversations-per-file");
        index += 1;
        break;
      case "--min-conversation-score":
        if (!next) throw new Error("--min-conversation-score requires a value");
        options.minConversationScore = parseNumber(next, "--min-conversation-score");
        index += 1;
        break;
      case "--max-durable-per-conversation":
        if (!next) throw new Error("--max-durable-per-conversation requires a value");
        options.maxDurableMemoriesPerConversation = parseInteger(next, "--max-durable-per-conversation");
        index += 1;
        break;
      case "--report-limit":
        if (!next) throw new Error("--report-limit requires a value");
        options.reportLimit = parseInteger(next, "--report-limit");
        index += 1;
        break;
      case "--output":
        if (!next) throw new Error("--output requires a value");
        options.outputPath = next;
        index += 1;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--triage-only":
        options.triageOnly = true;
        break;
      case "--embed":
        options.useEmbeddings = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function summarizeTriage(
  triage: ReturnType<typeof triageMigratedChatGptExports>,
  reportLimit: number
): {
  rootPaths: string[];
  fileCount: number;
  conversationCount: number;
  predictedMemoryCount: number;
  topFiles: Array<{
    filePath: string;
    score: number;
    conversationCount: number;
    highSignalConversationCount: number;
    predictedMemoryCount: number;
    topTags: string[];
    topConversationTitles: string[];
  }>;
} {
  return {
    rootPaths: triage.rootPaths,
    fileCount: triage.fileCount,
    conversationCount: triage.conversationCount,
    predictedMemoryCount: triage.predictedMemoryCount,
    topFiles: triage.files.slice(0, reportLimit).map((file) => ({
      filePath: file.filePath,
      score: file.score,
      conversationCount: file.conversationCount,
      highSignalConversationCount: file.highSignalConversationCount,
      predictedMemoryCount: file.predictedMemoryCount,
      topTags: file.topTags,
      topConversationTitles: file.topConversations.slice(0, 5).map((conversation) => conversation.title),
    })),
  };
}

function writeOutput(value: unknown, outputPath?: string): void {
  const serialized = JSON.stringify(value, null, 2);
  console.log(serialized);

  if (!outputPath) return;
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${serialized}\n`, "utf8");
}

function isMemorySource(value: string): value is MemorySource {
  return (
    value === "backfill" ||
    value === "manual" ||
    value === "obsidian" ||
    value === "conversation" ||
    value === "reflection"
  );
}

function parseInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${label} must be a number between 0 and 1`);
  }
  return parsed;
}

function printUsage(): void {
  console.log(`
Usage:
  node --env-file=.env --import tsx ./scripts/memory-chatgpt-migrated.ts [options]

Options:
  --db-path <path>                    Override Tango SQLite path
  --path <file-or-dir>                File or directory to scan (repeatable)
  --session-id <id>                   Scope imported memories to a session
  --agent-id <id>                     Scope imported memories to an agent
  --memory-source <kind>              backfill | manual | obsidian | conversation | reflection
  --limit-files <n>                   Import only the top-scored files
  --max-conversations-per-file <n>    Cap imported conversations per selected file
  --min-conversation-score <0..1>     Skip low-signal conversations
  --max-durable-per-conversation <n>  Cap durable memories per conversation
  --report-limit <n>                  Number of top files to include in output
  --output <path>                     Write the JSON report to a file
  --triage-only                       Report likely signal without importing
  --dry-run                           Build candidates without writing to SQLite
  --embed                             Embed inserted memories with Voyage
`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
