import type { VoiceInboxResponse, VoiceInboxAgentResponse, VoiceInboxAgentGroup } from '@tango/voice';

export interface InboxClientOptions {
  baseUrl: string;
  apiKey?: string;
}

export class InboxClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(options: InboxClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey?.trim() || undefined;
  }

  async getInbox(channels?: string[]): Promise<VoiceInboxResponse> {
    const url = new URL(`${this.baseUrl}/voice/inbox`);
    if (channels && channels.length > 0) {
      url.searchParams.set('channels', channels.join(','));
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: this.buildHeaders(),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Inbox fetch failed: HTTP ${response.status} ${text}`);
    }

    return (await response.json()) as VoiceInboxResponse;
  }

  async getAgentInbox(): Promise<VoiceInboxAgentResponse> {
    const url = new URL(`${this.baseUrl}/voice/inbox`);
    url.searchParams.set('groupBy', 'agent');

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: this.buildHeaders(),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Agent inbox fetch failed: HTTP ${response.status} ${text}`);
    }

    return (await response.json()) as VoiceInboxAgentResponse;
  }

  async advanceWatermark(channelId: string, messageId: string, source: string): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/voice/inbox/watermark`, {
      method: 'POST',
      headers: { ...this.buildHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId, messageId, source }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Watermark advance failed: HTTP ${response.status} ${text}`);
    }

    const result = (await response.json()) as { ok: boolean; advanced: boolean };
    return result.advanced;
  }

  async markChannelReadById(channelId: string, source: string): Promise<void> {
    try {
      const inbox = await this.getInbox([channelId]);
      for (const channel of inbox.channels) {
        if (channel.messages.length > 0) {
          const lastMsg = channel.messages[channel.messages.length - 1];
          await this.advanceWatermark(lastMsg.channelId, lastMsg.messageId, source);
        }
      }
    } catch (error) {
      console.warn(`[inbox-client] markChannelReadById failed for "${channelId}": ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * Mark a channel as fully read by advancing the watermark to the latest message.
   * Uses display name or channel ID to identify the channel.
   * Fire-and-forget safe — logs warnings but does not throw.
   */
  async markChannelRead(channelDisplayName: string, source: string): Promise<void> {
    try {
      const inbox = await this.getInbox([channelDisplayName]);
      for (const channel of inbox.channels) {
        if (channel.messages.length > 0) {
          const lastMsg = channel.messages[channel.messages.length - 1];
          await this.advanceWatermark(lastMsg.channelId, lastMsg.messageId, source);
        }
      }
    } catch (error) {
      console.warn(`[inbox-client] markChannelRead failed for "${channelDisplayName}": ${error instanceof Error ? error.message : error}`);
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }
}
