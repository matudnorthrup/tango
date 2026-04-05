import dotenv from "dotenv";
import { DatabaseSync } from "node:sqlite";
import { resolveDatabasePath } from "@tango/core";

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

type VoiceInboxAgentGroup = {
  agentId: string;
  agentDisplayName: string;
  totalUnread: number;
  channels: VoiceInboxChannel[];
};

type VoiceInboxAgentResponse = {
  ok: true;
  agents: VoiceInboxAgentGroup[];
  totalUnread: number;
  pendingCount: number;
};

type StoredWatermark = {
  messageId: string;
  source: string;
} | null;

const INBOX_CACHE_TTL_MS = 5_000;

function getArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
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
  return resolveDatabasePath(process.env["TANGO_DB_PATH"]);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}${text ? `: ${text}` : ""}`);
  }
  return (await response.json()) as T;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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

async function main(): Promise<void> {
  const baseUrl = getBridgeBaseUrl();
  const headers = getBridgeHeaders();
  const channelSelector = getArg("--channel");

  console.log(`[smoke] bridge=${baseUrl}`);
  console.log(`[smoke] db=${getDbPath()}`);

  const health = await fetchJson<{ ok: boolean; status: string }>(`${baseUrl}/health`, {
    headers,
  });
  console.log(`[smoke] health ok=${health.ok} status=${health.status}`);

  const inbox = await fetchJson<VoiceInboxResponse>(`${baseUrl}/voice/inbox`, {
    headers,
  });
  const agentInbox = await fetchJson<VoiceInboxAgentResponse>(`${baseUrl}/voice/inbox?groupBy=agent`, {
    headers,
  });
  console.log(`[smoke] inbox totalUnread=${inbox.totalUnread} pending=${inbox.pendingCount} channels=${inbox.channels.length}`);
  console.log(`[smoke] agentInbox agents=${agentInbox.agents.length} totalUnread=${agentInbox.totalUnread}`);

  if (inbox.totalUnread !== agentInbox.totalUnread) {
    throw new Error(`Inbox total mismatch: channels=${inbox.totalUnread} agents=${agentInbox.totalUnread}`);
  }

  const target = channelSelector
    ? inbox.channels.find((channel) =>
        channel.channelId === channelSelector
        || channel.channelName.toLowerCase() === channelSelector.toLowerCase()
        || channel.displayName.toLowerCase() === channelSelector.toLowerCase()
      ) ?? null
    : inbox.channels.find((channel) => channel.messages.length > 0) ?? null;

  if (!target) {
    console.log("[smoke] no unread inbox channel found; verified endpoint health and aggregate consistency only");
    return;
  }

  const latestMessage = target.messages[target.messages.length - 1];
  if (!latestMessage) {
    console.log(`[smoke] target channel=${target.channelId} has no messages; nothing to advance`);
    return;
  }

  console.log(
    `[smoke] target channelId=${target.channelId} channelName=${target.channelName} displayName=${target.displayName} unread=${target.unreadCount} latest=${latestMessage.messageId}`
  );

  const db = new DatabaseSync(getDbPath());
  const originalWatermark = loadWatermark(db, target.channelId);
  console.log(
    `[smoke] original watermark=${originalWatermark?.messageId ?? "(none)"} source=${originalWatermark?.source ?? "-"}`
  );

  try {
    const advanceResult = await fetchJson<{ ok: boolean; advanced: boolean }>(
      `${baseUrl}/voice/inbox/watermark`,
      {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channelId: latestMessage.channelId,
          messageId: latestMessage.messageId,
          source: "smoke-test",
        }),
      }
    );
    console.log(`[smoke] advance ok=${advanceResult.ok} advanced=${advanceResult.advanced}`);

    const filteredAfterAdvance = await fetchJson<VoiceInboxResponse>(
      `${baseUrl}/voice/inbox?channels=${encodeURIComponent(target.channelId)}`,
      { headers }
    );
    const remaining = filteredAfterAdvance.channels.find((channel) => channel.channelId === target.channelId);
    const remainingUnread = remaining?.unreadCount ?? 0;
    console.log(`[smoke] after advance remainingUnread=${remainingUnread}`);
    if (remainingUnread !== 0) {
      throw new Error(`Expected target channel to clear after advance, but remainingUnread=${remainingUnread}`);
    }
  } finally {
    restoreWatermark(db, target.channelId, originalWatermark);
    db.close();
  }

  // The Discord runtime caches inbox scans for 5 seconds.
  await sleep(INBOX_CACHE_TTL_MS + 250);

  const filteredAfterRestore = await fetchJson<VoiceInboxResponse>(
    `${baseUrl}/voice/inbox?channels=${encodeURIComponent(target.channelId)}`,
    { headers }
  );
  const restored = filteredAfterRestore.channels.find((channel) => channel.channelId === target.channelId);
  const restoredUnread = restored?.unreadCount ?? 0;
  console.log(`[smoke] after restore unread=${restoredUnread}`);
  if (restoredUnread !== target.unreadCount) {
    throw new Error(`Restore mismatch: expected unread=${target.unreadCount}, got ${restoredUnread}`);
  }

  console.log("[smoke] live inbox watermark validation passed");
}

void main().catch((error) => {
  console.error(`[smoke] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
