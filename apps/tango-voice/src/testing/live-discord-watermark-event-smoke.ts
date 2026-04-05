import dotenv from "dotenv";
import { DatabaseSync } from "node:sqlite";
import { resolveDatabasePath } from "@tango/core";
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  type AnyThreadChannel,
  type TextBasedChannel,
} from "discord.js";
import { ensureSmokeThread } from "./discord-smoke-thread.js";

dotenv.config();

type StoredWatermark = {
  messageId: string;
  source: string;
} | null;

function getArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

function getDbPath(): string {
  return resolveDatabasePath(process.env["TANGO_DB_PATH"]);
}

function loadWatermark(db: DatabaseSync, channelId: string): StoredWatermark {
  const row = db.prepare(
    `SELECT watermark_message_id AS messageId, watermark_source AS source
     FROM voice_read_watermarks WHERE channel_id = ?`
  ).get(channelId) as { messageId: string; source: string } | undefined;
  return row ? { messageId: row.messageId, source: row.source } : null;
}

function restoreWatermark(db: DatabaseSync, channelId: string, watermark: StoredWatermark): void {
  if (!watermark) {
    db.prepare(`DELETE FROM voice_read_watermarks WHERE channel_id = ?`).run(channelId);
    return;
  }

  db.prepare(
    `INSERT INTO voice_read_watermarks (channel_id, watermark_message_id, watermark_source, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(channel_id) DO UPDATE SET
       watermark_message_id = excluded.watermark_message_id,
       watermark_source = excluded.watermark_source,
       updated_at = datetime('now')`
  ).run(channelId, watermark.messageId, watermark.source);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isTextSendableChannel(value: unknown): value is TextBasedChannel & { send: Function; id: string; name?: string } {
  return typeof value === "object"
    && value !== null
    && "isTextBased" in value
    && typeof (value as any).isTextBased === "function"
    && (value as any).isTextBased()
    && typeof (value as any).send === "function";
}

async function resolveTargetChannel(
  client: Client,
  token: string,
): Promise<TextBasedChannel & { send: Function; id: string; name?: string }> {
  const explicit = getArg("--channel");
  if (explicit) {
    const byId = await client.channels.fetch(explicit).catch(() => null);
    if (isTextSendableChannel(byId)) return byId;

    const needle = explicit.toLowerCase();
    for (const guild of client.guilds.cache.values()) {
      const active = await guild.channels.fetchActiveThreads();
      const match = active.threads.find((thread) => thread.name.toLowerCase() === needle);
      if (match && isTextSendableChannel(match)) return match;
    }
    throw new Error(`Could not resolve channel/thread '${explicit}'.`);
  }

  const fallbackAgentId = process.env["TANGO_VOICE_DEFAULT_AGENT_ID"]?.trim() || "watson";
  const ensuredThreadId = await ensureSmokeThread({
    token,
    agentId: fallbackAgentId,
    explicitThreadName: "codex-voice-watermark-live",
  });
  if (ensuredThreadId) {
    const ensuredChannel = await client.channels.fetch(ensuredThreadId).catch(() => null);
    if (isTextSendableChannel(ensuredChannel)) {
      return ensuredChannel;
    }
  }

  const configuredChannelId = process.env["DISCORD_TEST_CHANNEL_ID"]?.trim();
  if (configuredChannelId) {
    const configuredChannel = await client.channels.fetch(configuredChannelId).catch(() => null);
    if (isTextSendableChannel(configuredChannel)) {
      return configuredChannel;
    }
  }

  for (const guild of client.guilds.cache.values()) {
    const active = await guild.channels.fetchActiveThreads();
    const testThread = active.threads.find((thread) => thread.name.toLowerCase() === "test thread");
    if (testThread && isTextSendableChannel(testThread)) {
      return testThread;
    }
  }

  throw new Error("No default smoke target found. Pass --channel <thread-id-or-name>.");
}

async function waitForWatermark(db: DatabaseSync, channelId: string, expectedMessageId: string, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while ((Date.now() - startedAt) < timeoutMs) {
    const watermark = loadWatermark(db, channelId);
    if (watermark?.messageId === expectedMessageId) {
      return;
    }
    await sleep(250);
  }
  const actual = loadWatermark(db, channelId);
  throw new Error(`Timed out waiting for watermark=${expectedMessageId}; actual=${actual?.messageId ?? "(none)"}`);
}

async function main(): Promise<void> {
  const token = process.env["DISCORD_TOKEN"]?.trim();
  if (!token) {
    throw new Error("DISCORD_TOKEN is required.");
  }

  const db = new DatabaseSync(getDbPath());
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  });

  try {
    await client.login(token);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Discord login timeout")), 15_000);
      client.once("clientReady", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    const channel = await resolveTargetChannel(client, token);
    const originalWatermark = loadWatermark(db, channel.id);
    const smokeBody = `\u200Bsmoke voice-user-sync ${new Date().toISOString()}`;

    const channelType = "type" in channel ? channel.type : null;
    const parentName = "parent" in channel && (channel as AnyThreadChannel).parent?.name
      ? (channel as AnyThreadChannel).parent?.name
      : null;
    console.log(
      `[event-smoke] target id=${channel.id} name=${"name" in channel ? channel.name ?? channel.id : channel.id} type=${channelType ?? "unknown"} parent=${parentName ?? "-"}`
    );
    console.log(
      `[event-smoke] original watermark=${originalWatermark?.messageId ?? "(none)"} source=${originalWatermark?.source ?? "-"}`
    );

    const sent = await channel.send(smokeBody);
    console.log(`[event-smoke] sent message id=${sent.id}`);

    try {
      await waitForWatermark(db, channel.id, sent.id);
      const updated = loadWatermark(db, channel.id);
      console.log(`[event-smoke] watermark advanced to=${updated?.messageId ?? "(none)"} source=${updated?.source ?? "-"}`);
      if (updated?.source !== "voice-user-sync") {
        throw new Error(`Expected watermark source=voice-user-sync, got ${updated?.source ?? "(none)"}`);
      }
    } finally {
      restoreWatermark(db, channel.id, originalWatermark);
      await sent.delete().catch(() => undefined);
    }

    const restored = loadWatermark(db, channel.id);
    console.log(`[event-smoke] restored watermark=${restored?.messageId ?? "(none)"} source=${restored?.source ?? "-"}`);
    console.log("[event-smoke] live Discord event watermark validation passed");
  } finally {
    db.close();
    await client.destroy();
  }
}

void main().catch((error) => {
  console.error(`[event-smoke] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
