import type { VoiceInboxChannel, VoiceInboxMessage } from '@tango/voice';
import { quickCompletion } from './claude.js';

function normalizeVoiceLabel(label: string): string {
  return label
    .replace(/\s*\(voice\)\s*$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTopicKey(label: string): string {
  return normalizeVoiceLabel(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactTopicKey(label: string): string {
  return normalizeTopicKey(label).replace(/\s+/g, '');
}

function joinVoiceLabels(labels: string[]): string {
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0]!;
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

export function getInboxChannelVoiceLabel(channel: VoiceInboxChannel, agentDisplayName?: string): string {
  const agentLabel = normalizeVoiceLabel(agentDisplayName ?? '');
  const displayLabel = normalizeVoiceLabel(channel.displayName || '');
  const channelLabel = normalizeVoiceLabel(channel.channelName || '');

  if (displayLabel && (!agentLabel || displayLabel.toLowerCase() !== agentLabel.toLowerCase())) {
    return displayLabel;
  }
  if (channelLabel) {
    return channelLabel;
  }
  if (displayLabel) {
    return displayLabel;
  }
  return agentLabel || 'that thread';
}

function buildDeterministicAgentSummary(agentDisplayName: string, channels: VoiceInboxChannel[]): string {
  const labels = [...new Set(
    channels
      .map((channel) => getInboxChannelVoiceLabel(channel, agentDisplayName))
      .filter((label) => label.length > 0),
  )];

  if (labels.length === 0) {
    return `${agentDisplayName} has messages ready.`;
  }

  if (labels.length === 1) {
    return `I have a message in ${labels[0]}.`;
  }

  if (labels.length <= 3) {
    return `I have messages in ${joinVoiceLabels(labels)}.`;
  }

  const head = labels.slice(0, 3);
  const extraCount = labels.length - head.length;
  return `I have messages in ${joinVoiceLabels(head)}, plus ${extraCount} more.`;
}

/**
 * Generate a brief agent summary of their messages for the voice inbox.
 * Uses Haiku for fast turnaround. Falls back to a simple channel-name summary on failure.
 */
export async function generateAgentSummary(
  agentDisplayName: string,
  channels: VoiceInboxChannel[],
): Promise<string> {
  const allMessages: { channelName: string; preview: string }[] = [];

  for (const ch of channels) {
    for (const msg of ch.messages) {
      allMessages.push({
        channelName: getInboxChannelVoiceLabel(ch, agentDisplayName),
        preview: msg.content.slice(0, 200),
      });
    }
  }

  if (allMessages.length === 0) {
    return `${agentDisplayName} has no messages.`;
  }

  const deterministicSummary = buildDeterministicAgentSummary(agentDisplayName, channels);
  const distinctLabels = new Set(allMessages.map((message) => message.channelName)).size;
  if (distinctLabels <= 3 && allMessages.length <= 4) {
    return deterministicSummary;
  }

  const systemPrompt = `Summarize the topics covered in these messages from ${agentDisplayName}. Write ONE short sentence in first person as ${agentDisplayName}. If a message is from a thread or post (shown in brackets like [Thread Name]), include that name so the user can ask for it. Example: "I have an update in Week 12 Planning and a response about your meeting schedule." Do NOT introduce yourself or describe your role.`;

  const messageList = allMessages
    .map((m, i) => `[${m.channelName}]: ${m.preview}`)
    .join('\n');

  const userMessage = `Messages:\n${messageList}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    try {
      console.log(`[inbox-summary] generating summary for ${agentDisplayName} (${allMessages.length} messages across ${channels.length} channels)`);
      const result = await quickCompletion(systemPrompt, userMessage, 80, controller.signal, 'haiku');
      console.log(`[inbox-summary] summary result: "${result.slice(0, 100)}"`);
      return result;
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    console.warn(`[inbox-summary] summary failed for ${agentDisplayName}: ${error instanceof Error ? error.message : error}`);
    return deterministicSummary;
  }
}

/**
 * Given a user's topic selection request and a list of messages,
 * classify which message index matches the request.
 * Returns the index or -1 if ambiguous.
 */
export async function classifyTopicSelection(
  userRequest: string,
  messages: { channelName: string; preview: string }[],
): Promise<number> {
  if (messages.length <= 1) return 0;

  const normalizedRequest = normalizeTopicKey(userRequest);
  const compactRequest = compactTopicKey(userRequest);

  if (normalizedRequest.length > 0) {
    const directMatches = messages
      .map((message, index) => ({
        index,
        normalizedLabel: normalizeTopicKey(message.channelName),
        compactLabel: compactTopicKey(message.channelName),
      }))
      .filter(({ normalizedLabel, compactLabel }) => {
        if (normalizedRequest === normalizedLabel || compactRequest === compactLabel) {
          return true;
        }
        if (compactRequest.length >= 4 && compactLabel.length >= 4) {
          return compactLabel.includes(compactRequest) || compactRequest.includes(compactLabel);
        }
        return false;
      });

    const uniqueLabels = [...new Set(directMatches.map((match) => match.compactLabel))];
    if (uniqueLabels.length === 1) {
      return directMatches[0]!.index;
    }
  }

  const systemPrompt = `You are a message classifier. Given a user's request and a numbered list of messages, return ONLY the number (0-indexed) of the message that best matches. If ambiguous, return -1.`;

  const messageList = messages
    .map((m, i) => `${i}: [${m.channelName}] ${m.preview}`)
    .join('\n');

  const userMessage = `User request: "${userRequest}"\n\nMessages:\n${messageList}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const result = await quickCompletion(systemPrompt, userMessage, 10, controller.signal, 'haiku');
      const parsed = parseInt(result.trim(), 10);
      if (Number.isInteger(parsed) && parsed >= -1 && parsed < messages.length) {
        return parsed;
      }
      return -1;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return -1;
  }
}
