/**
 * Slack Tools — Universal read-only Slack Web API tool.
 *
 * Provides a single `slack` tool that wraps the Slack Web API, letting agents
 * list channels, read history, resolve users, and search — without embedding
 * workflow logic in the handler.
 *
 * Auth: Bot token fetched from 1Password (Watson vault, "Watson Slack Bot Token").
 * `saved_items` uses a Slack user token only for `stars.list`.
 */

import type { AgentTool } from "@tango/core";
import { getSecret } from "./op-secret.js";

const SLACK_API = "https://slack.com/api";

let cachedToken: string | null = null;
async function getSlackToken(): Promise<string> {
  if (!cachedToken) {
    const token = await getSecret("Watson", "Watson Slack Bot Token");
    if (!token) throw new Error("Slack bot token not found in 1Password (Watson vault, item 'Watson Slack Bot Token')");
    cachedToken = token;
  }
  return cachedToken;
}

let cachedUserToken: string | null = null;
async function getSlackUserToken(): Promise<string> {
  if (!cachedUserToken) {
    const token = await getSecret("Watson", "Watson Slack User Token");
    if (!token) throw new Error("Slack user token not found in 1Password (Watson vault, item 'Watson Slack User Token')");
    cachedUserToken = token;
  }
  return cachedUserToken;
}

async function slackApiWithToken(
  token: string,
  method: string,
  params: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const url = new URL(`${SLACK_API}/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Slack ${method} HTTP ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  if (!body.ok) throw new Error(`Slack ${method}: ${body.error}`);
  return body;
}

async function slackApi(
  method: string,
  params: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const token = await getSlackToken();
  return slackApiWithToken(token, method, params);
}

export function createSlackTools(): AgentTool[] {
  return [
    {
      name: "slack",
      description: [
        "Read-only Slack Web API access for Watson, including native saved items.",
        "",
        "Actions:",
        "",
        "  list_channels — List all channels the bot is in.",
        "    Returns: array of { id, name, is_private, num_members }",
        "",
        "  channel_history — Get recent messages from a channel.",
        "    Params: channel_id (required), hours (default 24), limit (default 200)",
        "    Returns: array of messages with user, text, ts, reply_count, reactions",
        "",
        "  user_info — Resolve a user ID to profile info.",
        "    Params: user_id (required)",
        "    Returns: { id, display_name, real_name, title }",
        "",
        "  thread_replies — Get replies in a message thread.",
        "    Params: channel_id (required), thread_ts (required)",
        "    Returns: array of reply messages",
        "",
        "  saved_items — List Slack saved messages via the native stars.list API.",
        "    Params: limit (default 100)",
        "    Returns: { count, items: [{ type, channel_id, text, user, ts, permalink, date_create }] }",
        "",
        "Tips:",
        "- Call list_channels first to discover what's available.",
        "- For digests, fetch channel_history for each channel, then synthesize.",
        "- reply_count >= 2 and reaction counts indicate engaged discussions.",
        "- Filter out messages with subtype (joins/leaves) or bot_id (bot noise).",
        "- User IDs look like U024EEJ59J8 — resolve with user_info for display names.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list_channels", "channel_history", "user_info", "thread_replies", "saved_items"],
            description: "The Slack operation to perform",
          },
          channel_id: {
            type: "string",
            description: "Channel ID (for channel_history, thread_replies)",
          },
          user_id: {
            type: "string",
            description: "User ID (for user_info)",
          },
          thread_ts: {
            type: "string",
            description: "Thread timestamp (for thread_replies)",
          },
          hours: {
            type: "number",
            description: "How many hours of history to fetch (default 24, for channel_history)",
          },
          limit: {
            type: "number",
            description: "Max items to return (default 200 for channel_history, 100 for saved_items)",
          },
        },
        required: ["action"],
      },
      handler: async (input) => {
        const action = String(input.action);

        switch (action) {
          case "list_channels": {
            const body = await slackApi("users.conversations", {
              types: "public_channel,private_channel",
              limit: "200",
            });
            const channels = (body.channels as Array<Record<string, unknown>>) ?? [];
            return {
              channels: channels.map((ch) => ({
                id: ch.id,
                name: ch.name,
                is_private: ch.is_private,
                num_members: ch.num_members,
              })),
            };
          }

          case "channel_history": {
            const channelId = String(input.channel_id || "");
            if (!channelId) return { error: "channel_id is required" };
            const hours = Number(input.hours) || 24;
            const limit = Number(input.limit) || 200;
            const oldest = String((Date.now() - hours * 3600_000) / 1000);

            const body = await slackApi("conversations.history", {
              channel: channelId,
              oldest,
              limit: String(limit),
            });
            const messages = (body.messages as Array<Record<string, unknown>>) ?? [];
            return {
              channel_id: channelId,
              message_count: messages.length,
              messages: messages.map((m) => ({
                user: m.user,
                text: m.text,
                ts: m.ts,
                subtype: m.subtype,
                bot_id: m.bot_id,
                reply_count: m.reply_count,
                reactions: m.reactions,
              })),
            };
          }

          case "user_info": {
            const userId = String(input.user_id || "");
            if (!userId) return { error: "user_id is required" };

            const body = await slackApi("users.info", { user: userId });
            const user = body.user as Record<string, unknown> | undefined;
            const profile = user?.profile as Record<string, string> | undefined;
            return {
              id: user?.id,
              display_name: profile?.display_name || profile?.real_name || userId,
              real_name: profile?.real_name,
              title: profile?.title,
            };
          }

          case "thread_replies": {
            const channelId = String(input.channel_id || "");
            const threadTs = String(input.thread_ts || "");
            if (!channelId || !threadTs) return { error: "channel_id and thread_ts are required" };

            const body = await slackApi("conversations.replies", {
              channel: channelId,
              ts: threadTs,
              limit: "100",
            });
            const messages = (body.messages as Array<Record<string, unknown>>) ?? [];
            return {
              channel_id: channelId,
              thread_ts: threadTs,
              reply_count: messages.length,
              messages: messages.map((m) => ({
                user: m.user,
                text: m.text,
                ts: m.ts,
              })),
            };
          }

          case "saved_items": {
            const limit = Number(input.limit) || 100;
            const userToken = await getSlackUserToken();
            const body = await slackApiWithToken(userToken, "stars.list", {
              count: String(limit),
            });
            const items = (body.items as Array<Record<string, unknown>>) ?? [];

            const messageItems: Array<Record<string, unknown>> = [];

            for (const item of items) {
              if (String(item.type) !== "message") continue;

              const channelId = String(item.channel || "");
              const message = item.message as Record<string, unknown> | undefined;
              const ts = String(message?.ts || "");

              if (!channelId || !message || !ts) continue;

              let permalink = "";
              try {
                const linkBody = await slackApi("chat.getPermalink", {
                  channel: channelId,
                  message_ts: ts,
                });
                permalink = String(linkBody.permalink || "");
              } catch {
                // Permalinks are best-effort only.
              }

              messageItems.push({
                type: "message",
                channel_id: channelId,
                text: message.text,
                user: message.user,
                ts,
                permalink,
                date_create: item.date_create,
              });
            }

            return {
              count: messageItems.length,
              items: messageItems,
            };
          }

          default:
            return { error: `Unknown action: ${action}. Use list_channels, channel_history, user_info, thread_replies, or saved_items.` };
        }
      },
    },
  ];
}
