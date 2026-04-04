#!/usr/bin/env tsx

import {
  createVoyageEmbeddingProviderFromEnv,
  resolveDatabasePath,
  runMemoryReflectionCycle,
  TangoStorage,
} from "../packages/core/src/index.ts";

interface CliOptions {
  dbPath?: string;
  lookbackHours?: number;
  maxReflections?: number;
  minimumImportance?: number;
  scanLimit?: number;
  sessionId?: string;
  agentId?: string;
  useEmbeddings: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const dbPath = resolveDatabasePath(options.dbPath);
  const storage = new TangoStorage(dbPath);
  const embeddingProvider = options.useEmbeddings ? createVoyageEmbeddingProviderFromEnv() : null;

  try {
    const result = await runMemoryReflectionCycle({
      storage,
      embeddingProvider,
      lookbackHours: options.lookbackHours,
      maxReflections: options.maxReflections,
      minimumImportance: options.minimumImportance,
      scanLimit: options.scanLimit,
      sessionId: options.sessionId,
      agentId: options.agentId,
    });

    console.log(JSON.stringify({
      dbPath,
      result,
    }, null, 2));
  } finally {
    storage.close();
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
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
      case "--lookback-hours":
        if (!next) throw new Error("--lookback-hours requires a value");
        options.lookbackHours = parseNumber(next, "--lookback-hours");
        index += 1;
        break;
      case "--max-reflections":
        if (!next) throw new Error("--max-reflections requires a value");
        options.maxReflections = parseInteger(next, "--max-reflections");
        index += 1;
        break;
      case "--minimum-importance":
        if (!next) throw new Error("--minimum-importance requires a value");
        options.minimumImportance = parseNumber(next, "--minimum-importance");
        index += 1;
        break;
      case "--scan-limit":
        if (!next) throw new Error("--scan-limit requires a value");
        options.scanLimit = parseInteger(next, "--scan-limit");
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

function parseInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return parsed;
}

function printUsage(): void {
  console.log(`
Usage:
  node --import tsx ./scripts/memory-reflect.ts [options]

Options:
  --db-path <path>              Override Tango SQLite path
  --lookback-hours <n>          How far back to scan for source memories
  --max-reflections <n>         Max reflections to create
  --minimum-importance <n>      Minimum source-memory importance threshold
  --scan-limit <n>              Max memories to inspect
  --session-id <id>             Restrict reflections to one session
  --agent-id <id>               Restrict reflections to one agent
  --embed                       Try to embed created reflections with Voyage
`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
