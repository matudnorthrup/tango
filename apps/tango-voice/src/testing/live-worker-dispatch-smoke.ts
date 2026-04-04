import dotenv from "dotenv";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureSmokeThread } from "./discord-smoke-thread.js";

dotenv.config();

type VoiceTurnHttpResponse = {
  ok: boolean;
  error?: string;
  message?: string;
  responseText?: string;
  providerName?: string;
  providerUsedFailover?: boolean;
  warmStartUsed?: boolean;
};

type StoredModelRun = {
  id: number;
  metadata: Record<string, unknown> | null;
  errorMessage: string | null;
  createdAt: string;
  responseMode: string | null;
} | null;

function getArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

function getNumberArg(flag: string, fallback: number): number {
  const value = getArg(flag);
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getBridgeBaseUrl(): string {
  const host = process.env["TANGO_VOICE_BRIDGE_HOST"]?.trim() || "127.0.0.1";
  const port = process.env["TANGO_VOICE_BRIDGE_PORT"]?.trim() || "8787";
  return `http://${host}:${port}`;
}

function getBridgeHeaders(): Record<string, string> {
  const apiKey = process.env["TANGO_VOICE_BRIDGE_API_KEY"]?.trim();
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function getDbPath(): string {
  const configured = process.env["TANGO_DB_PATH"]?.trim() || "./data/tango.sqlite";
  return path.resolve(configured);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}${text ? `: ${text}` : ""}`);
  }
  return JSON.parse(text) as T;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function safeParseJson(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function loadLatestModelRun(
  db: DatabaseSync,
  sessionId: string,
  agentId: string,
  excludedResponseModes: readonly string[] = []
): StoredModelRun {
  const rows = db.prepare(
    `SELECT
       id,
       response_mode AS responseMode,
       metadata_json AS metadataJson,
       error_message AS errorMessage,
       created_at AS createdAt
     FROM model_runs
     WHERE session_id = ? AND agent_id = ?
     ORDER BY id DESC
     LIMIT 10`
  ).all(sessionId, agentId) as Array<{
    id: number;
    responseMode: string | null;
    metadataJson: string | null;
    errorMessage: string | null;
    createdAt: string;
  }>;

  const row = rows.find((candidate) => (
    !candidate.responseMode
    || !excludedResponseModes.includes(candidate.responseMode)
  ));
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    metadata: safeParseJson(row.metadataJson),
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    responseMode: row.responseMode,
  };
}

async function waitForNewModelRun(input: {
  db: DatabaseSync;
  sessionId: string;
  agentId: string;
  previousId: number | null;
  timeoutMs?: number;
  excludedResponseModes?: readonly string[];
}): Promise<StoredModelRun> {
  const startedAt = Date.now();
  const timeoutMs = input.timeoutMs ?? 30_000;
  while ((Date.now() - startedAt) < timeoutMs) {
    const latest = loadLatestModelRun(
      input.db,
      input.sessionId,
      input.agentId,
      input.excludedResponseModes ?? []
    );
    if (latest && latest.id !== input.previousId) {
      return latest;
    }
    await sleep(250);
  }
  return null;
}

function getNumberMetadata(metadata: Record<string, unknown> | null, key: string): number | null {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getStringArrayMetadata(metadata: Record<string, unknown> | null, key: string): string[] {
  const value = metadata?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

async function main(): Promise<void> {
  const baseUrl = getBridgeBaseUrl();
  const headers = getBridgeHeaders();
  const sessionId = getArg("--session") ?? "sierra-live-smoke";
  const agentId = getArg("--agent") ?? "sierra";
  const transcript =
    getArg("--transcript")
    ?? "Use the worker to tell me your worker id and one short sentence about what domains you can help with.";
  const requestedChannelId = getArg("--channel");
  const threadName = getArg("--thread-name");
  const discordUserId = getArg("--user") ?? "live-smoke";
  const expectedWorker = getArg("--expect-worker") ?? "research-assistant";
  const expectedDispatchCount = Number.parseInt(getArg("--expect-dispatch-count") ?? "1", 10);
  const maxAttempts = getNumberArg("--max-attempts", 3);
  const excludedResponseModes = ["deterministic-intent-classifier"];
  const token = process.env["DISCORD_TOKEN"]?.trim();
  const channelId = token
    ? await ensureSmokeThread({
        token,
        agentId,
        explicitChannelId: requestedChannelId,
        explicitThreadName: threadName,
      })
    : requestedChannelId;

  console.log(`[worker-smoke] bridge=${baseUrl}`);
  console.log(`[worker-smoke] db=${getDbPath()}`);
  console.log(`[worker-smoke] session=${sessionId} agent=${agentId}`);
  console.log(`[worker-smoke] channel=${channelId ?? "(none)"}`);
  console.log(`[worker-smoke] transcript=${JSON.stringify(transcript)}`);

  const health = await fetchJson<{ ok: boolean; status: string }>(`${baseUrl}/health`, {
    headers,
  });
  console.log(`[worker-smoke] health ok=${health.ok} status=${health.status}`);

  const db = new DatabaseSync(getDbPath());
  try {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const before = loadLatestModelRun(db, sessionId, agentId, excludedResponseModes);
      console.log(`[worker-smoke] attempt=${attempt}/${maxAttempts} previous model run=${before?.id ?? "(none)"}`);

      try {
        const result = await fetchJson<VoiceTurnHttpResponse>(`${baseUrl}/voice/turn`, {
          method: "POST",
          headers: {
            ...headers,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            sessionId,
            agentId,
            transcript,
            channelId,
            discordUserId,
          }),
        });

        console.log(
          `[worker-smoke] response ok=${result.ok} provider=${result.providerName ?? "-"} failover=${result.providerUsedFailover ? "yes" : "no"} warmStart=${result.warmStartUsed ? "yes" : "no"}`
        );
        console.log(`[worker-smoke] responseText=${JSON.stringify(result.responseText ?? "")}`);

        const latest = await waitForNewModelRun({
          db,
          sessionId,
          agentId,
          previousId: before?.id ?? null,
          excludedResponseModes,
        });
        if (!latest) {
          throw new Error("Timed out waiting for a new model_runs row.");
        }

        const dispatchCount = getNumberMetadata(latest.metadata, "workerDispatchCount");
        const completedCount = getNumberMetadata(latest.metadata, "workerDispatchCompletedCount");
        const failedCount = getNumberMetadata(latest.metadata, "workerDispatchFailedCount");
        const workerIds = getStringArrayMetadata(latest.metadata, "workerDispatchWorkerIds");
        const dispatchSource = typeof latest.metadata?.["workerDispatchSource"] === "string"
          ? String(latest.metadata?.["workerDispatchSource"])
          : null;

        console.log(
          `[worker-smoke] modelRun=${latest.id} responseMode=${latest.responseMode ?? "-"} dispatchSource=${dispatchSource ?? "-"} dispatchCount=${dispatchCount ?? 0} completed=${completedCount ?? 0} failed=${failedCount ?? 0} workers=${workerIds.join(",") || "-"}`
        );

        if (latest.errorMessage) {
          throw new Error(`Latest model run recorded an error: ${latest.errorMessage}`);
        }
        if ((dispatchCount ?? 0) < expectedDispatchCount) {
          throw new Error(`Expected workerDispatchCount>=${expectedDispatchCount}, got ${dispatchCount ?? 0}`);
        }
        if ((completedCount ?? 0) < expectedDispatchCount) {
          throw new Error(`Expected completed worker dispatches >= ${expectedDispatchCount}, got ${completedCount ?? 0}`);
        }
        if ((failedCount ?? 0) !== 0) {
          throw new Error(`Expected no failed worker dispatches, got ${failedCount ?? 0}`);
        }
        if (!workerIds.includes(expectedWorker)) {
          throw new Error(`Expected worker ${expectedWorker}, got ${workerIds.join(",") || "(none)"}`);
        }

        console.log("[worker-smoke] live worker dispatch validation passed");
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt >= maxAttempts) {
          break;
        }
        console.warn(`[worker-smoke] attempt ${attempt} failed: ${lastError.message}`);
        await sleep(1_000);
      }
    }

    throw lastError ?? new Error("Worker smoke failed without a captured error.");
  } finally {
    db.close();
  }
}

void main().catch((error) => {
  console.error(`[worker-smoke] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
