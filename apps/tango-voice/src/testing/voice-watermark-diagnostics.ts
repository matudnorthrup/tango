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

dotenv.config();

type VoiceInboxMessage = {
  messageId: string;
  channelId: string;
  channelName: string;
  agentDisplayName: string;
  agentId: string | null;
  content: string;
  timestamp: number;
  isChunked: boolean;
  chunkGroupId: string | null;
};

type VoiceInboxChannel = {
  channelId: string;
  channelName: string;
  displayName: string;
  unreadCount: number;
  messages: VoiceInboxMessage[];
};

type VoiceInboxResponse = {
  ok: true;
  channels: VoiceInboxChannel[];
  totalUnread: number;
  pendingCount: number;
};

type StoredWatermark = {
  messageId: string;
  source: string;
  updatedAt: string;
} | null;

type ThreadSession = {
  sessionId: string;
  agentId: string | null;
} | null;

function getArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

function getDbPath(): string {
  return resolveDatabasePath(process.env["TANGO_DB_PATH"]);
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

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}${text ? `: ${text}` : ""}`);
  }
  return (await response.json()) as T;
}

function loadWatermark(db: DatabaseSync, channelId: string): StoredWatermark {
  const row = db.prepare(
    `SELECT watermark_message_id AS messageId, watermark_source AS source, updated_at AS updatedAt
     FROM voice_read_watermarks WHERE channel_id = ?`
  ).get(channelId) as { messageId: string; source: string; updatedAt: string } | undefined;
  return row ? row : null;
}

function loadThreadSession(db: DatabaseSync, threadId: string): ThreadSession {
  const row = db.prepare(
    `SELECT session_id AS sessionId, agent_id AS agentId
     FROM discord_thread_sessions WHERE thread_id = ?`
  ).get(threadId) as { sessionId: string; agentId: string | null } | undefined;
  return row ? row : null;
}

function isTextChannel(value: unknown): value is TextBasedChannel & { id: string; name?: string } {
  return typeof value === "object"
    && value !== null
    && "isTextBased" in value
    && typeof (value as any).isTextBased === "function"
    && (value as any).isTextBased();
}

async function resolveTargetChannel(client: Client): Promise<TextBasedChannel & { id: string; name?: string }> {
  const explicit = getArg("--channel");
  if (!explicit) {
    throw new Error("Pass --channel <channel-id-or-name>.");
  }

  const byId = await client.channels.fetch(explicit).catch(() => null);
  if (isTextChannel(byId)) return byId;

  const needle = explicit.toLowerCase();
  for (const guild of client.guilds.cache.values()) {
    const active = await guild.channels.fetchActiveThreads();
    const threadMatch = active.threads.find((thread) => thread.name.toLowerCase() === needle);
    if (threadMatch && isTextChannel(threadMatch)) return threadMatch;

    const textMatch = guild.channels.cache.find((channel) =>
      isTextChannel(channel) && "name" in channel && channel.name?.toLowerCase() === needle
    );
    if (textMatch && isTextChannel(textMatch)) return textMatch;
  }

  throw new Error(`Could not resolve channel '${explicit}'.`);
}

function snowflakeToDate(snowflake: string): string {
  const discordEpoch = 1420070400000n;
  const unixMs = (BigInt(snowflake) >> 22n) + discordEpoch;
  return new Date(Number(unixMs)).toISOString();
}

async function main(): Promise<void> {
  const token = process.env["DISCORD_TOKEN"]?.trim();
  if (!token) {
    throw new Error("DISCORD_TOKEN is required.");
  }

  const db = new DatabaseSync(getDbPath(), { readOnly: true });
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

    const channel = await resolveTargetChannel(client);
    const channelType = "type" in channel ? channel.type : null;
    const isThread = "isThread" in channel && typeof channel.isThread === "function" && channel.isThread();
    const parentId = isThread ? (channel as AnyThreadChannel).parentId : null;
    const parentName = isThread ? (channel as AnyThreadChannel).parent?.name ?? null : null;

    let latestMessageId: string | null = null;
    let latestAuthor = "-";
    let latestContent = "-";
    if ("messages" in channel) {
      const messages = await channel.messages.fetch({ limit: 1 });
      const latest = messages.first();
      if (latest) {
        latestMessageId = latest.id;
        latestAuthor = latest.author.username;
        latestContent = latest.content.slice(0, 120).replace(/\s+/g, " ");
      }
    }

    const watermark = loadWatermark(db, channel.id);
    const threadSession = loadThreadSession(db, channel.id);
    const inbox = await fetchJson<VoiceInboxResponse>(
      `${getBridgeBaseUrl()}/voice/inbox?channels=${encodeURIComponent(channel.id)}`,
      { headers: getBridgeHeaders() }
    );
    const inboxChannel = inbox.channels.find((entry) => entry.channelId === channel.id) ?? null;

    console.log(`channel.id=${channel.id}`);
    console.log(`channel.name=${"name" in channel ? channel.name ?? channel.id : channel.id}`);
    console.log(`channel.type=${channelType ?? "unknown"} (${channelType === ChannelType.PublicThread ? "PublicThread" : channelType === ChannelType.GuildText ? "GuildText" : "other"})`);
    console.log(`channel.isThread=${isThread}`);
    console.log(`channel.parentId=${parentId ?? "-"}`);
    console.log(`channel.parentName=${parentName ?? "-"}`);
    console.log(`db.watermark.messageId=${watermark?.messageId ?? "-"}`);
    console.log(`db.watermark.source=${watermark?.source ?? "-"}`);
    console.log(`db.watermark.updatedAt=${watermark?.updatedAt ?? "-"}`);
    console.log(`db.threadSession.sessionId=${threadSession?.sessionId ?? "-"}`);
    console.log(`db.threadSession.agentId=${threadSession?.agentId ?? "-"}`);
    console.log(`discord.latestMessageId=${latestMessageId ?? "-"}`);
    console.log(`discord.latestMessageAt=${latestMessageId ? snowflakeToDate(latestMessageId) : "-"}`);
    console.log(`discord.latestAuthor=${latestAuthor}`);
    console.log(`discord.latestContent=${latestContent}`);
    console.log(`inbox.totalUnread=${inbox.totalUnread}`);
    console.log(`inbox.pendingCount=${inbox.pendingCount}`);
    console.log(`inbox.channelFound=${inboxChannel ? "yes" : "no"}`);
    console.log(`inbox.channelName=${inboxChannel?.channelName ?? "-"}`);
    console.log(`inbox.displayName=${inboxChannel?.displayName ?? "-"}`);
    console.log(`inbox.unreadCount=${inboxChannel?.unreadCount ?? 0}`);
    console.log(`inbox.latestUnreadMessageId=${inboxChannel?.messages[inboxChannel.messages.length - 1]?.messageId ?? "-"}`);
    console.log(`inbox.latestUnreadAgent=${inboxChannel?.messages[inboxChannel.messages.length - 1]?.agentDisplayName ?? "-"}`);
  } finally {
    db.close();
    await client.destroy();
  }
}

void main().catch((error) => {
  console.error(`[diagnostics] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
