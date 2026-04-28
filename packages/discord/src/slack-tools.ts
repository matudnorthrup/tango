/**
 * Slack Tools — Universal read-only Slack Web API tool.
 *
 * Provides a single `slack` tool that wraps the Slack Web API, letting agents
 * list channels, read history, resolve users, and search — without embedding
 * workflow logic in the handler.
 *
 * Auth: Bot token fetched from 1Password (Watson vault, "Watson Slack Bot Token").
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

async function slackApi(
  method: string,
  params: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const token = await getSlackToken();
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

export function createSlackTools(): AgentTool[] {
  return [
    {
      name: "slack",
      description: [
        "Read-only Slack Web API access for the Watson bot.",
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
        "  bookmarked_messages — Find messages a user reacted to with a specific emoji.",
        "    Params: emoji (default 'bookmark'), user_id (default Devin's ID), hours (default 24)",
        "    Returns: array of { channel_id, channel_name, text, user, ts, permalink }",
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
            enum: ["list_channels", "channel_history", "user_info", "thread_replies", "bookmarked_messages"],
            description: "The Slack operation to perform",
          },
          channel_id: {
            type: "string",
            description: "Channel ID (for channel_history, thread_replies)",
          },
          user_id: {
            type: "string",
            description: "User ID (for user_info, bookmarked_messages)",
          },
          emoji: {
            type: "string",
            description: "Emoji name to search for (default 'bookmark', for bookmarked_messages)",
          },
          thread_ts: {
            type: "string",
            description: "Thread timestamp (for thread_replies)",
          },
          hours: {
            type: "number",
            description: "How many hours of history to fetch (default 24)",
          },
          limit: {
            type: "number",
            description: "Max messages to return (default 200)",
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

          case "bookmarked_messages": {
            const emoji = String(input.emoji || "bookmark");
            const userId = String(input.user_id || "U02SLAKMMT6");
            const hours = Number(input.hours) || 24;
            const oldest = String((Date.now() - hours * 3600_000) / 1000);

            const chBody = await slackApi("users.conversations", {
              types: "public_channel,private_channel",
              limit: "200",
            });
            const channels = (chBody.channels as Array<Record<string, unknown>>) ?? [];

            const results: Array<Record<string, unknown>> = [];

            for (const ch of channels) {
              const histBody = await slackApi("conversations.history", {
                channel: String(ch.id),
                oldest,
                limit: "200",
              });
              const messages = (histBody.messages as Array<Record<string, unknown>>) ?? [];

              for (const msg of messages) {
                const reactions = (msg.reactions as Array<Record<string, unknown>>) ?? [];
                const match = reactions.find(
                  (reaction) =>
                    String(reaction.name) === emoji
                    && ((reaction.users as string[]) ?? []).includes(userId),
                );

                if (!match) continue;

                let permalink = "";
                try {
                  const linkBody = await slackApi("chat.getPermalink", {
                    channel: String(ch.id),
                    message_ts: String(msg.ts),
                  });
                  permalink = String(linkBody.permalink || "");
                } catch {
                  // Permalinks are best-effort only.
                }

                results.push({
                  channel_id: ch.id,
                  channel_name: ch.name,
                  text: msg.text,
                  user: msg.user,
                  ts: msg.ts,
                  permalink,
                });
              }
            }

            return {
              emoji,
              user_id: userId,
              count: results.length,
              items: results,
            };
          }

          default:
            return { error: `Unknown action: ${action}. Use list_channels, channel_history, user_info, thread_replies, or bookmarked_messages.` };
        }
      },
    },
  ];
}
