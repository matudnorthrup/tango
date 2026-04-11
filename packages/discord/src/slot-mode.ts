import {
  ChannelType,
  ThreadAutoArchiveDuration,
  type Client,
} from "discord.js";

export interface SlotModeAgentTestChannel {
  agentId: string;
  channelId: string;
}

export interface InitializeSlotModeInput {
  client: Client;
  slot: string;
  agentTestChannels: SlotModeAgentTestChannel[];
  now?: Date;
  logger?: (line: string) => void;
}

export interface SlotModeCreatedThread {
  agentId: string;
  threadId: string;
  url: string;
}

export interface SlotModeFailure {
  agentId: string;
  reason: string;
}

export interface SlotModeResult {
  threadIds: Set<string>;
  created: SlotModeCreatedThread[];
  failures: SlotModeFailure[];
}

interface ThreadLike {
  id: string;
  url: string;
  send: (content: string) => Promise<unknown>;
}

interface ThreadStarterChannelLike {
  threads: {
    create: (input: {
      name: string;
      autoArchiveDuration: ThreadAutoArchiveDuration;
      type: ChannelType.PublicThread;
      reason: string;
    }) => Promise<ThreadLike>;
  };
}

export function isSlotModeActive(env: NodeJS.ProcessEnv = process.env): boolean {
  const slot = env.TANGO_SLOT?.trim();
  return Boolean(slot && slot.length > 0);
}

export function shouldInitializeSlotMode(
  env: NodeJS.ProcessEnv = process.env,
  allowlist: Set<string> | null,
): boolean {
  return isSlotModeActive(env) && allowlist === null;
}

export function buildThreadName(slot: string, now = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const hour = String(now.getUTCHours()).padStart(2, "0");
  const minute = String(now.getUTCMinutes()).padStart(2, "0");
  return `[wt-${slot}] ${year}-${month}-${day} ${hour}${minute}`;
}

function formatCreatedAt(now: Date): string {
  return now.toISOString().replace("T", " ").slice(0, 16) + "Z";
}

function resolveBranchLabel(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.TANGO_GIT_BRANCH?.trim()
    || env.GIT_BRANCH?.trim()
    || env.GITHUB_REF_NAME?.trim()
    || env.BRANCH_NAME?.trim()
    || "current-worktree"
  );
}

function isConfiguredSmokeTestChannelId(channelId: string): boolean {
  const normalized = channelId.trim();
  return normalized.length > 0 && !normalized.startsWith("1000000");
}

function isThreadStarterChannel(channel: unknown): channel is ThreadStarterChannelLike {
  return Boolean(
    channel
      && typeof channel === "object"
      && "threads" in channel
      && typeof (channel as { threads?: { create?: unknown } }).threads?.create === "function",
  );
}

function buildCharterMessage(slot: string, agentId: string, now: Date): string {
  return [
    `This is slot wt-${slot}'s smoke-test thread for agent ${agentId}.`,
    `Branch: ${resolveBranchLabel()}.`,
    `Created: ${formatCreatedAt(now)}.`,
    "Messages here route through this slot's dev code.",
  ].join(" ");
}

export async function initializeSlotMode(
  input: InitializeSlotModeInput,
): Promise<SlotModeResult> {
  const now = input.now ?? new Date();
  const logger = input.logger ?? (() => undefined);
  const result: SlotModeResult = {
    threadIds: new Set<string>(),
    created: [],
    failures: [],
  };

  for (const agentChannel of input.agentTestChannels) {
    const channelId = agentChannel.channelId.trim();
    if (!isConfiguredSmokeTestChannelId(channelId)) {
      const reason = "not configured";
      logger(`skip agent=${agentChannel.agentId} reason=${reason}`);
      result.failures.push({ agentId: agentChannel.agentId, reason });
      continue;
    }

    try {
      const channel = await input.client.channels.fetch(channelId);
      if (!channel) {
        const reason = `channel not found: ${channelId}`;
        logger(`failed agent=${agentChannel.agentId} reason=${reason}`);
        result.failures.push({ agentId: agentChannel.agentId, reason });
        continue;
      }

      if (!isThreadStarterChannel(channel)) {
        const reason = `channel does not support public threads: ${channelId}`;
        logger(`failed agent=${agentChannel.agentId} reason=${reason}`);
        result.failures.push({ agentId: agentChannel.agentId, reason });
        continue;
      }

      const thread = await channel.threads.create({
        name: buildThreadName(input.slot, now),
        autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
        type: ChannelType.PublicThread,
        reason: `Tango slot wt-${input.slot} smoke-test thread for ${agentChannel.agentId}`,
      });

      result.threadIds.add(thread.id);
      result.created.push({
        agentId: agentChannel.agentId,
        threadId: thread.id,
        url: thread.url,
      });

      logger(`created agent=${agentChannel.agentId} threadId=${thread.id} url=${thread.url}`);

      try {
        await thread.send(buildCharterMessage(input.slot, agentChannel.agentId, now));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        logger(`charter failed agent=${agentChannel.agentId} reason=${reason}`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger(`failed agent=${agentChannel.agentId} reason=${reason}`);
      result.failures.push({ agentId: agentChannel.agentId, reason });
    }
  }

  return result;
}
