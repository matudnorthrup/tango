import type { AgentConfig } from "@tango/core";

const DEFAULT_WEBHOOK_NAME = "Tango Replies";

interface ReplyWebhook {
  id: string;
  name?: string | null;
  token?: string | null;
  send(options: {
    content: string;
    username?: string;
    avatarURL?: string;
    threadId?: string;
  }): Promise<unknown>;
}

interface ReplyWebhookCollectionLike {
  values(): Iterable<ReplyWebhook>;
}

interface ReplyWebhookCapableChannel {
  id: string;
  fetchWebhooks(): Promise<ReplyWebhookCollectionLike | ReplyWebhook[]>;
  createWebhook(options: { name: string }): Promise<ReplyWebhook>;
}

interface ReplyThreadLike {
  id: string;
  isThread(): boolean;
  parent?: unknown;
}

export interface ReplyChannelLike {
  id: string;
  isSendable(): boolean;
  send?(content: string): Promise<unknown>;
  isThread?(): boolean;
  parent?: unknown;
  fetchWebhooks?(): Promise<ReplyWebhookCollectionLike | ReplyWebhook[]>;
  createWebhook?(options: { name: string }): Promise<ReplyWebhook>;
}

export interface PresentedReplyResult {
  sentChunks: number;
  delivery: "webhook" | "bot" | "mixed";
  intendedDisplayName: string;
  actualDisplayName: string;
  lastMessageId?: string;
}

interface WebhookTarget {
  cacheKey: string;
  sourceChannel: ReplyWebhookCapableChannel;
  threadId?: string;
}

interface ReplyPresentationLogger {
  warn(message: string): void;
}

export interface PresentedReplyOptions {
  speaker?: AgentConfig | null;
  botDisplayName?: string;
  avatarURL?: string;
}

export interface ReplyPresenter {
  sendChunked(
    channel: ReplyChannelLike | null | undefined,
    text: string,
    options?: PresentedReplyOptions
  ): Promise<PresentedReplyResult>;
}

function titleCaseAgentId(agentId: string): string {
  return agentId
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function resolveSpeakerAvatarURL(
  speaker: Pick<AgentConfig, "id" | "avatarURL"> | null | undefined,
  fallbackAvatarURL?: string
): string | undefined {
  if (speaker && speaker.id !== "dispatch" && speaker.avatarURL) {
    return speaker.avatarURL;
  }
  return fallbackAvatarURL;
}

export function resolveSpeakerDisplayName(
  speaker: Pick<AgentConfig, "id" | "displayName"> | null | undefined,
  systemDisplayName = "Tango"
): string {
  if (!speaker || speaker.id === "dispatch") {
    return systemDisplayName;
  }

  const explicit = speaker.displayName?.trim();
  if (explicit) return explicit;
  return titleCaseAgentId(speaker.id);
}

export function splitForDiscord(text: string, maxLength = 1900): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex < 1200) {
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIndex < 800) {
      splitIndex = maxLength;
    }

    const chunk = remaining.slice(0, splitIndex).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(splitIndex).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function isWebhookCapableChannel(channel: unknown): channel is ReplyWebhookCapableChannel {
  return (
    typeof channel === "object" &&
    channel !== null &&
    "id" in channel &&
    typeof (channel as ReplyWebhookCapableChannel).fetchWebhooks === "function" &&
    typeof (channel as ReplyWebhookCapableChannel).createWebhook === "function"
  );
}

function isThreadLike(channel: unknown): channel is ReplyThreadLike {
  return (
    typeof channel === "object" &&
    channel !== null &&
    typeof (channel as ReplyThreadLike).isThread === "function" &&
    (channel as ReplyThreadLike).isThread()
  );
}

function listWebhooks(webhooks: ReplyWebhookCollectionLike | ReplyWebhook[]): ReplyWebhook[] {
  if (Array.isArray(webhooks)) return webhooks;
  return Array.from(webhooks.values());
}

function resolveWebhookTarget(channel: ReplyChannelLike): WebhookTarget | null {
  if (isThreadLike(channel)) {
    const parent = channel.parent;
    if (parent && isWebhookCapableChannel(parent)) {
      return {
        cacheKey: parent.id,
        sourceChannel: parent,
        threadId: channel.id
      };
    }
    return null;
  }

  if (isWebhookCapableChannel(channel)) {
    return {
      cacheKey: channel.id,
      sourceChannel: channel
    };
  }

  return null;
}

export function createReplyPresenter(options?: {
  systemDisplayName?: string;
  webhookName?: string;
  logger?: ReplyPresentationLogger;
}): ReplyPresenter {
  const systemDisplayName = options?.systemDisplayName?.trim() || "Tango";
  const webhookName = options?.webhookName?.trim() || DEFAULT_WEBHOOK_NAME;
  const logger = options?.logger ?? {
    warn(message: string): void {
      console.warn(message);
    }
  };
  const webhookCache = new Map<string, Promise<ReplyWebhook | null>>();

  async function getOrCreateWebhook(target: WebhookTarget): Promise<ReplyWebhook | null> {
    const cached = webhookCache.get(target.cacheKey);
    if (cached) {
      return cached;
    }

    const loading = (async () => {
      try {
        const existing = listWebhooks(await target.sourceChannel.fetchWebhooks());
        const reusable = existing.find((webhook) => webhook.name === webhookName && webhook.token);
        if (reusable) {
          return reusable;
        }

        return await target.sourceChannel.createWebhook({ name: webhookName });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(
          `[tango-discord] reply presentation falling back to bot send channel=${target.cacheKey}: ${message}`
        );
        return null;
      }
    })();

    webhookCache.set(target.cacheKey, loading);
    const resolved = await loading;
    if (!resolved) {
      webhookCache.delete(target.cacheKey);
    }
    return resolved;
  }

  return {
    async sendChunked(channel, text, replyOptions) {
      const speaker = replyOptions?.speaker ?? null;
      const intendedDisplayName = resolveSpeakerDisplayName(speaker, systemDisplayName);
      const botDisplayName = replyOptions?.botDisplayName?.trim() || systemDisplayName;
      if (!channel?.isSendable() || typeof channel.send !== "function") {
        return {
          sentChunks: 0,
          delivery: "bot",
          intendedDisplayName,
          actualDisplayName: botDisplayName
        };
      }

      const normalized = text.trim().length > 0 ? text.trim() : "[empty response]";
      const chunks = splitForDiscord(normalized);
      const target = resolveWebhookTarget(channel);
      if (target) {
        const webhook = await getOrCreateWebhook(target);
        if (webhook) {
          let sentViaWebhook = 0;
          let lastMsgId: string | undefined;
          for (const chunk of chunks) {
            try {
              const sent = await webhook.send({
                content: chunk,
                username: intendedDisplayName,
                avatarURL: replyOptions?.avatarURL,
                ...(target.threadId ? { threadId: target.threadId } : {})
              });
              const sentObj = sent as { id?: string } | null | undefined;
              if (sentObj && typeof sentObj.id === "string") lastMsgId = sentObj.id;
              sentViaWebhook += 1;
            } catch (error) {
              webhookCache.delete(target.cacheKey);
              const message = error instanceof Error ? error.message : String(error);
              logger.warn(
                `[tango-discord] webhook reply failed channel=${target.cacheKey} speaker=${intendedDisplayName}: ${message}`
              );
              break;
            }
          }

          if (sentViaWebhook === chunks.length) {
            return {
              sentChunks: chunks.length,
              delivery: "webhook",
              intendedDisplayName,
              actualDisplayName: intendedDisplayName,
              lastMessageId: lastMsgId
            };
          }

          for (const chunk of chunks.slice(sentViaWebhook)) {
            const sent = await channel.send(chunk);
            const sentObj = sent as { id?: string } | null | undefined;
            if (sentObj && typeof sentObj.id === "string") lastMsgId = sentObj.id;
          }

          return {
            sentChunks: chunks.length,
            delivery: sentViaWebhook > 0 ? "mixed" : "bot",
            intendedDisplayName,
            actualDisplayName: sentViaWebhook > 0 ? intendedDisplayName : botDisplayName,
            lastMessageId: lastMsgId
          };
        }
      }

      let lastMsgId: string | undefined;
      for (const chunk of chunks) {
        const sent = await channel.send(chunk);
        const sentObj = sent as { id?: string } | null | undefined;
        if (sentObj && typeof sentObj.id === "string") lastMsgId = sentObj.id;
      }

      return {
        sentChunks: chunks.length,
        delivery: "bot",
        intendedDisplayName,
        actualDisplayName: botDisplayName,
        lastMessageId: lastMsgId
      };
    }
  };
}
