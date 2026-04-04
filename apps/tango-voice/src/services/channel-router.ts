import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildChannelSystemPrompt,
  channelSearchForms,
  channelSearchScore,
  collapseLatestDiscordHistoryMessages,
  convertDiscordHistoryMessages,
  createAdhocChannelDefinition,
  listChannelSessionEntries,
  normalizeForumMatchText,
  loadTangoSessionManager as createTangoSessionManager,
  resolveChannelSessionKey,
  resolveVoiceTangoRoute,
  type VoiceChannelDefinition,
  type VoiceTangoSessionManager,
  type VoiceTangoRoute,
} from '@tango/voice';
import { Guild, ChannelType, TextChannel, ForumChannel, type GuildBasedChannel } from 'discord.js';
import { VOICE_SYSTEM_PROMPT } from '../prompts/voice-system.js';
import { config } from '../config.js';
import type { Message } from './claude.js';
import { resolveSharedTangoConfigPath } from './shared-storage.js';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const SENDABLE_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
]);

const channels = JSON.parse(
  readFileSync(resolve(__dirname, '../channels.json'), 'utf-8'),
) as Record<string, VoiceChannelDefinition>;

type DbRunResult = { lastInsertRowid?: number | bigint };

type DbStmt = {
  run: (...args: unknown[]) => DbRunResult;
  all?: (...args: unknown[]) => Record<string, unknown>[];
};

type AliasDb = {
  exec: (sql: string) => void;
  prepare: (sql: string) => DbStmt;
  close: () => void;
};

export class ChannelRouter {
  private guild: Guild;
  private activeChannelName = 'default';
  private historyMap = new Map<string, Message[]>();
  private resolvedChannels = new Map<string, TextChannel>();
  private tangoSessionManager: VoiceTangoSessionManager | null = null;
  private lastAccessed = new Map<string, number>();
  private aliasDb: AliasDb | null = null;
  private aliasStmtUpsert: DbStmt | null = null;
  private aliasStmtFindExact: DbStmt | null = null;
  private aliasReady = false;

  constructor(guild: Guild) {
    this.guild = guild;
    this.tangoSessionManager = this.loadTangoSessionManager();
    this.hydrateDefaultChannelFromTangoConfig();
    this.initAliasCache();
  }

  destroy(): void {
    if (this.aliasDb) {
      try {
        this.aliasDb.close();
      } catch {
        // Best effort shutdown.
      }
      this.aliasDb = null;
    }
    this.aliasStmtUpsert = null;
    this.aliasStmtFindExact = null;
    this.aliasReady = false;
  }

  listChannels(): { name: string; displayName: string; active: boolean }[] {
    return Object.entries(channels).map(([name, def]) => ({
      name,
      displayName: def.displayName,
      active: name === this.activeChannelName,
    }));
  }

  getActiveChannel(): { name: string } & VoiceChannelDefinition {
    const def = channels[this.activeChannelName] || channels['default'];
    return { name: this.activeChannelName, ...def };
  }

  getRecentChannels(limit: number): { name: string; displayName: string }[] {
    const active = this.activeChannelName;
    const allNames = Object.keys(channels).filter((n) => n !== active);

    // Sort by last accessed (most recent first), unvisited channels keep definition order at the end
    allNames.sort((a, b) => {
      const aTime = this.lastAccessed.get(a) ?? 0;
      const bTime = this.lastAccessed.get(b) ?? 0;
      if (aTime && bTime) return bTime - aTime;
      if (aTime) return -1;
      if (bTime) return 1;
      return 0; // preserve definition order for unvisited
    });

    return allNames.slice(0, limit).map((name) => ({
      name,
      displayName: channels[name].displayName,
    }));
  }

  getLastMessage(channelName?: string): { role: string; content: string } | null {
    const name = channelName ?? this.activeChannelName;
    const history = this.historyMap.get(name);
    if (!history || history.length === 0) return null;
    return history[history.length - 1];
  }

  async getLastMessageFresh(channelName?: string): Promise<{ role: string; content: string } | null> {
    const name = channelName ?? this.activeChannelName;
    const fromDiscord = await this.getLastMessageFromDiscord(name);
    if (fromDiscord) return fromDiscord;
    return this.getLastMessage(name);
  }

  getSystemPrompt(): string {
    const active = this.getActiveChannel();
    return buildChannelSystemPrompt(VOICE_SYSTEM_PROMPT, active.topicPrompt);
  }

  getSystemPromptFor(channelName: string): string {
    const def = channels[channelName];
    return buildChannelSystemPrompt(VOICE_SYSTEM_PROMPT, def?.topicPrompt);
  }

  async getLogChannel(): Promise<TextChannel | null> {
    return this.getLogChannelFor(this.activeChannelName);
  }

  async getLogChannelFor(channelName: string): Promise<TextChannel | null> {
    const def = channels[channelName] || channels['default'];
    const channelId = def?.channelId || config.logChannelId;
    if (!channelId) return null;

    // Check our resolved cache first (handles threads/forum posts)
    const cached = this.resolvedChannels.get(channelId);
    if (cached) return cached;

    // Try guild cache, then fetch
    const resolved = await this.resolveChannel(channelId);
    if (resolved) {
      this.resolvedChannels.set(channelId, resolved);
      return resolved;
    }

    // Fall back to default log channel
    if (def?.channelId && config.logChannelId) {
      const fallback = await this.resolveChannel(config.logChannelId);
      if (fallback) return fallback;
    }

    return null;
  }

  private async resolveChannel(channelId: string): Promise<TextChannel | null> {
    // Guild channel cache
    let ch = this.guild.channels.cache.get(channelId);

    // Guild fetch (works for text channels)
    if (!ch) {
      try {
        ch = await this.guild.channels.fetch(channelId) ?? undefined;
      } catch {
        // Not a guild channel — might be a thread
      }
    }

    // Thread fetch via client (threads aren't always in guild.channels)
    if (!ch) {
      try {
        const clientCh = await this.guild.client.channels.fetch(channelId);
        if (clientCh && SENDABLE_TYPES.has(clientCh.type)) {
          return clientCh as TextChannel;
        }
      } catch {
        // Channel not accessible
      }
    }

    if (ch && SENDABLE_TYPES.has(ch.type)) {
      return ch as TextChannel;
    }

    return null;
  }

  async refreshHistory(channelName?: string): Promise<void> {
    const name = channelName ?? this.activeChannelName;
    const seeded = await this.seedHistory(name);
    if (seeded.length === 0) return;

    const existing = this.historyMap.get(name) || [];

    // Defensive: if the refreshed history returned drastically fewer messages than we
    // already have locally, the session was likely truncated by another process
    // (for example, another writer reseeding the thread). In that case, merge:
    // keep our local history and append any genuinely new tail messages.
    if (existing.length > 0 && seeded.length < existing.length * 0.5) {
      const newTail = this.findNewTailMessages(existing, seeded);
      if (newTail.length > 0) {
        console.log(`refreshHistory(${name}): reseed returned ${seeded.length} msgs (local has ${existing.length}) — appending ${newTail.length} new tail messages`);
        this.historyMap.set(name, [...existing, ...newTail]);
      } else {
        console.log(`refreshHistory(${name}): reseed returned ${seeded.length} msgs (local has ${existing.length}) — keeping local history (no new messages)`);
      }
      return;
    }

    this.historyMap.set(name, seeded);
  }

  /**
   * Given our existing local history and a possibly truncated reseed,
   * return messages that aren't already in our local copy.
   * Matches by content to handle label differences.
   */
  private findNewTailMessages(existing: Message[], seeded: Message[]): Message[] {
    if (seeded.length === 0) return [];

    // Build a set of content fingerprints from the last N existing messages
    const lookback = Math.min(existing.length, 40);
    const existingFingerprints = new Set<string>();
    for (let i = existing.length - lookback; i < existing.length; i++) {
      existingFingerprints.add(`${existing[i].role}:${existing[i].content.slice(0, 120)}`);
    }

    // Walk the seeded messages and collect any that aren't in our local history
    const newMessages: Message[] = [];
    for (const msg of seeded) {
      const fp = `${msg.role}:${msg.content.slice(0, 120)}`;
      if (!existingFingerprints.has(fp)) {
        newMessages.push(msg);
      }
    }
    return newMessages;
  }

  getHistory(channelName?: string): Message[] {
    const name = channelName ?? this.activeChannelName;
    return this.historyMap.get(name) || [];
  }

  setHistory(history: Message[], channelName?: string): void {
    const name = channelName ?? this.activeChannelName;
    this.historyMap.set(name, history);
  }

  async switchTo(name: string): Promise<{ success: boolean; error?: string; historyCount: number; displayName?: string }> {
    // Check if it's a known channel name
    if (channels[name]) {
      this.activeChannelName = name;

      // Always re-seed from Discord to pick up new text messages
      const seeded = await this.seedHistory(name);
      this.historyMap.set(name, seeded);

      this.lastAccessed.set(name, Date.now());
      const historyCount = this.historyMap.get(name)?.length || 0;
      console.log(`Switched to channel: ${name} (${historyCount} history messages)`);
      return { success: true, historyCount, displayName: channels[name].displayName };
    }

    // Try as a raw channel ID, spoken numeric ID (with commas/spaces), or <#id> mention
    const channelId = name.replace(/^<#(\d+)>$/, '$1');
    const normalizedChannelId = channelId.replace(/[,\s]/g, '');
    if (/^\d+$/.test(normalizedChannelId)) {
      return this.switchToAdhoc(normalizedChannelId);
    }

    return { success: false, error: `Unknown channel: \`${name}\`. Use \`!channels\` to see available channels, or pass a channel ID.`, historyCount: 0 };
  }

  getExplicitDiscordChannelIdForSession(sessionId: string): string | null {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) return null;

    const session = this.tangoSessionManager?.listSessions()
      .find((entry) => entry.id === normalizedSessionId);
    if (!session) return null;

    const explicitDiscordChannel = session.channels.find(
      (channel) => channel.startsWith('discord:') && channel !== 'discord:default',
    );
    if (!explicitDiscordChannel) return null;

    const channelId = explicitDiscordChannel.slice('discord:'.length).trim();
    if (!channelId || channelId === 'default') return null;
    return channelId;
  }

  async switchToSessionChannel(sessionId: string): Promise<{
    success: boolean;
    error?: string;
    historyCount: number;
    displayName?: string;
    channelId?: string;
  }> {
    const channelId = this.getExplicitDiscordChannelIdForSession(sessionId);
    if (!channelId) {
      return {
        success: false,
        error: `No explicit Discord channel configured for session \`${sessionId}\`.`,
        historyCount: 0,
      };
    }

    const result = await this.switchTo(channelId);
    return result.success ? { ...result, channelId } : result;
  }

  private async switchToAdhoc(channelId: string): Promise<{ success: boolean; error?: string; historyCount: number; displayName?: string }> {
    // Use resolveChannel which handles threads via client.channels.fetch
    const resolved = await this.resolveChannel(channelId);
    if (!resolved) {
      return { success: false, error: `Could not find sendable channel \`${channelId}\`.`, historyCount: 0 };
    }

    const displayName = 'name' in resolved ? (resolved as any).name as string : channelId;

    // For threads (forum posts), capture the parent channel ID so session
    // routing can use the parent forum's session config (same as text routing).
    const isThread = 'isThread' in resolved && typeof resolved.isThread === 'function' && resolved.isThread();

    // Refuse to route to archived threads — they represent completed conversations.
    // Without this check, the alias cache and direct-ID paths can resurrect archived
    // threads (Discord auto-unarchives on message send).
    if (isThread && (resolved as any).archived) {
      console.log(`Blocked switch to archived thread: #${displayName} (${channelId})`);
      return { success: false, error: `Thread "${displayName}" is archived.`, historyCount: 0 };
    }
    const parentChannelId = isThread ? (resolved as any).parentId as string | undefined : undefined;

    // Cache the resolved channel immediately
    this.resolvedChannels.set(channelId, resolved);

    // Register as a dynamic channel entry
    const key = `id:${channelId}`;
    channels[key] = createAdhocChannelDefinition({ channelId, displayName, parentChannelId });

    this.activeChannelName = key;

    // Always re-seed from Discord to pick up new text messages
    const seeded = await this.seedHistory(key);
    this.historyMap.set(key, seeded);

    this.lastAccessed.set(key, Date.now());
    const historyCount = this.historyMap.get(key)?.length || 0;
    console.log(`Switched to ad-hoc channel: #${displayName} / type=${resolved.type} (${historyCount} history messages)`);
    return { success: true, historyCount, displayName: `#${displayName}` };
  }

  switchToDefault(): Promise<{ success: boolean; error?: string; historyCount: number; displayName?: string }> {
    return this.switchTo('default');
  }

  async refreshAliasCache(): Promise<void> {
    if (!this.aliasReady || !this.aliasStmtUpsert) return;

    let seeded = 0;
    for (const [name, def] of Object.entries(channels)) {
      if (!def.channelId) continue;
      seeded += this.upsertAliasForms(name, def.channelId, def.displayName, 3);
      seeded += this.upsertAliasForms(def.displayName, def.channelId, def.displayName, 3);
    }

    try {
      const fetched = await this.guild.channels.fetch();
      for (const ch of fetched.values()) {
        if (!ch || !SENDABLE_TYPES.has(ch.type) || !('name' in ch) || typeof ch.name !== 'string') continue;
        const displayName = `#${ch.name}`;
        seeded += this.upsertAliasForms(ch.name, ch.id, displayName, 2);
      }
    } catch (err: any) {
      console.warn(`Alias cache guild refresh failed: ${err.message}`);
    }

    try {
      const activeThreads = await this.guild.channels.fetchActiveThreads();
      for (const thread of activeThreads.threads.values()) {
        if (thread.archived) continue;
        const displayName = `#${thread.name}`;
        seeded += this.upsertAliasForms(thread.name, thread.id, displayName, 2);
      }
    } catch {
      // Optional; some guilds may not allow this.
    }

    if (seeded > 0) {
      console.log(`Alias cache refreshed (${seeded} alias forms)`);
    }
  }

  async lookupSwitchAlias(query: string): Promise<{ channelId: string; displayName: string } | null> {
    if (!this.aliasReady || !this.aliasStmtFindExact || typeof this.aliasStmtFindExact.all !== 'function') return null;
    const forms = channelSearchForms(query).slice(0, 4);
    if (forms.length === 0) return null;
    while (forms.length < 4) {
      forms.push(forms[forms.length - 1] || '');
    }

    const rows = this.aliasStmtFindExact.all(...forms) as Array<{
      channelId?: string;
      displayName?: string;
      hits?: number;
      lastUsedAt?: string;
    }>;
    for (const row of rows) {
      const channelId = String(row.channelId ?? '').trim();
      if (!channelId) continue;
      const resolved = await this.resolveChannel(channelId);
      if (!resolved) continue;
      const displayName = row.displayName && row.displayName.trim().length > 0
        ? row.displayName
        : ('name' in resolved ? `#${(resolved as any).name as string}` : `#${channelId}`);
      return { channelId, displayName };
    }
    return null;
  }

  rememberSwitchAlias(phrase: string, channelId: string, displayName: string): void {
    if (!this.aliasReady || !this.aliasStmtUpsert) return;
    this.upsertAliasForms(phrase, channelId, displayName, 1);
  }

  async findSendableChannelByName(query: string): Promise<{ id: string; displayName: string } | null> {
    const candidates = new Map<string, { id: string; name: string; score: number }>();

    const consider = (channel: GuildBasedChannel | null | undefined): void => {
      if (!channel || !SENDABLE_TYPES.has(channel.type)) return;
      if (!('name' in channel) || typeof channel.name !== 'string') return;
      const channelName = channel.name.trim();
      if (!channelName) return;

      const score = channelSearchScore(query, channelName);
      if (score <= 0) return;

      const previous = candidates.get(channel.id);
      if (!previous || score > previous.score) {
        candidates.set(channel.id, { id: channel.id, name: channelName, score });
      }
    };

    for (const ch of this.guild.channels.cache.values()) {
      consider(ch as GuildBasedChannel);
    }

    try {
      const fetched = await this.guild.channels.fetch();
      for (const ch of fetched.values()) {
        if (ch) consider(ch as GuildBasedChannel);
      }
    } catch {
      // Best-effort fallback only; cache may still be sufficient.
    }

    try {
      const activeThreads = await this.guild.channels.fetchActiveThreads();
      for (const thread of activeThreads.threads.values()) {
        if (thread.archived) continue;
        consider(thread as unknown as GuildBasedChannel);
      }
    } catch {
      // Ignore; forum/thread listing can be permission-limited.
    }

    const best = [...candidates.values()]
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.name.length - b.name.length;
      })[0];

    if (!best) return null;
    return { id: best.id, displayName: `#${best.name}` };
  }

  private initAliasCache(): void {
    const db = this.openAliasDb();
    if (!db) return;
    this.aliasDb = db;
    this.aliasDb.exec(`
      CREATE TABLE IF NOT EXISTS voice_channel_aliases (
        normalized_alias TEXT NOT NULL,
        raw_alias TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        hits INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (normalized_alias, channel_id)
      );

      CREATE INDEX IF NOT EXISTS idx_voice_channel_aliases_channel
        ON voice_channel_aliases(channel_id);

      CREATE INDEX IF NOT EXISTS idx_voice_channel_aliases_last_used
        ON voice_channel_aliases(last_used_at DESC);
    `);
    this.aliasStmtUpsert = this.aliasDb.prepare(`
      INSERT INTO voice_channel_aliases (normalized_alias, raw_alias, channel_id, display_name, hits, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(normalized_alias, channel_id) DO UPDATE SET
        raw_alias = excluded.raw_alias,
        display_name = excluded.display_name,
        hits = voice_channel_aliases.hits + excluded.hits,
        last_used_at = datetime('now')
    `);
    this.aliasStmtFindExact = this.aliasDb.prepare(`
      SELECT channel_id AS channelId, display_name AS displayName, hits, last_used_at AS lastUsedAt
      FROM voice_channel_aliases
      WHERE normalized_alias IN (?, ?, ?, ?)
      ORDER BY hits DESC, last_used_at DESC
      LIMIT 10
    `);
    this.aliasReady = true;
  }

  private openAliasDb(): AliasDb | null {
    const home = process.env['HOME'];
    if (!home) return null;
    const dbPath = process.env['ATLAS_DB_PATH'] || `${home}/atlas/atlas.db`;
    try {
      const sqlite = require('node:sqlite') as { DatabaseSync: new (path: string) => AliasDb };
      const db = new sqlite.DatabaseSync(dbPath);
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA foreign_keys = ON;');
      return db;
    } catch {
      // Fall through to external better-sqlite3 path for older runtimes.
    }

    const modulePath = `${home}/atlas/node_modules/better-sqlite3`;
    try {
      const BetterSqlite3 = require(modulePath) as new (path: string) => AliasDb;
      const db = new BetterSqlite3(dbPath);
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA foreign_keys = ON;');
      return db;
    } catch (err: any) {
      console.warn(`Alias cache disabled: ${err.message}`);
      return null;
    }
  }

  private upsertAliasForms(
    phrase: string,
    channelId: string,
    displayName: string,
    hits: number,
  ): number {
    if (!this.aliasReady || !this.aliasStmtUpsert) return 0;
    const raw = phrase.trim();
    if (!raw || !channelId.trim()) return 0;
    const forms = channelSearchForms(raw);
    for (const normalized of forms) {
      this.aliasStmtUpsert.run(normalized, raw, channelId, displayName, hits);
    }
    return forms.length;
  }

  listForumChannels(): { name: string; id: string }[] {
    return this.guild.channels.cache
      .filter((ch): ch is ForumChannel => ch.type === ChannelType.GuildForum)
      .map((f) => ({ name: f.name, id: f.id }));
  }

  findForumChannel(query: string): { name: string; id: string } | null {
    const forums = this.listForumChannels();
    const lower = query.toLowerCase().trim();
    const normalizedQuery = normalizeForumMatchText(lower);

    const direct = forums.find((f) => f.name.toLowerCase() === lower)
      ?? forums.find((f) => f.name.toLowerCase().includes(lower))
      ?? forums.find((f) => lower.includes(f.name.toLowerCase()));
    if (direct) return direct;

    // Normalize separators and filler terms so spoken names still match
    // compact forum names like "project-forum" or "project".
    return forums.find((f) => {
      const candidate = normalizeForumMatchText(f.name);
      return candidate === normalizedQuery
        || candidate.includes(normalizedQuery)
        || normalizedQuery.includes(candidate);
    }) ?? null;
  }

  async createForumPost(forumId: string, title: string, body: string): Promise<{ success: boolean; error?: string; threadId?: string; forumName?: string }> {
    const forum = this.guild.channels.cache.get(forumId) as ForumChannel | undefined;
    if (!forum || forum.type !== ChannelType.GuildForum) {
      return { success: false, error: `Forum channel ${forumId} not found.` };
    }

    try {
      let threadName = title;
      if (threadName.length > 100) threadName = threadName.slice(0, 97) + '...';
      const content = body.charAt(0).toUpperCase() + body.slice(1);

      const thread = await forum.threads.create({
        name: threadName,
        message: { content },
      });

      await this.switchTo(thread.id);

      console.log(`Created forum post "${title}" in #${forum.name} (thread ${thread.id})`);
      return { success: true, threadId: thread.id, forumName: forum.name };
    } catch (err: any) {
      return { success: false, error: `Failed to create thread: ${err.message}` };
    }
  }

  async createChannelThread(channelId: string, title: string, body: string): Promise<{
    success: boolean; error?: string; threadId?: string; channelName?: string;
  }> {
    const resolved = await this.resolveChannel(channelId);
    if (!resolved) {
      return { success: false, error: `Channel ${channelId} not found.` };
    }

    // Only text channels can have threads created (not threads themselves)
    if (resolved.type !== ChannelType.GuildText) {
      return { success: false, error: `Channel ${channelId} is not a text channel.` };
    }

    try {
      let threadName = title;
      if (threadName.length > 100) threadName = threadName.slice(0, 97) + '...';
      const content = body.charAt(0).toUpperCase() + body.slice(1);

      const textChannel = resolved as TextChannel;
      const thread = await textChannel.threads.create({
        name: threadName,
        autoArchiveDuration: 10080,
      });
      await thread.send(content);

      await this.switchTo(thread.id);

      const channelName = textChannel.name;
      console.log(`Created thread "${title}" in #${channelName} (thread ${thread.id})`);
      return { success: true, threadId: thread.id, channelName };
    } catch (err: any) {
      return { success: false, error: `Failed to create thread: ${err.message}` };
    }
  }

  async getForumThreads(): Promise<{ name: string; displayName: string; threadId: string }[]> {
    const results: { name: string; displayName: string; threadId: string }[] = [];
    const seen = new Set<string>();

    // 1. Forum threads (posts in forum channels)
    const forums = this.guild.channels.cache.filter(
      (ch): ch is ForumChannel => ch.type === ChannelType.GuildForum,
    );
    for (const forum of forums.values()) {
      try {
        const active = await forum.threads.fetchActive();
        for (const thread of active.threads.values()) {
          if (thread.archived) continue; // belt-and-suspenders: fetchActive should exclude these
          seen.add(thread.id);
          results.push({
            name: `id:${thread.id}`,
            displayName: `${thread.name} (in ${forum.name})`,
            threadId: thread.id,
          });
        }
      } catch (err: any) {
        console.warn(`Failed to fetch threads from forum ${forum.name}: ${err.message}`);
      }
    }

    // 2. Active threads in text channels (e.g., threads under #watson)
    try {
      const activeThreads = await this.guild.channels.fetchActiveThreads();
      for (const thread of activeThreads.threads.values()) {
        if (seen.has(thread.id)) continue;
        if (thread.archived) continue;
        seen.add(thread.id);
        const parentName = thread.parent?.name ?? 'unknown';
        results.push({
          name: `id:${thread.id}`,
          displayName: `${thread.name} (in ${parentName})`,
          threadId: thread.id,
        });
      }
    } catch (err: any) {
      console.warn(`Failed to fetch active guild threads: ${err.message}`);
    }
    return results;
  }

  clearActiveHistory(): void {
    this.historyMap.delete(this.activeChannelName);
    console.log(`Cleared history for channel: ${this.activeChannelName}`);
  }

  getAllChannelSessionKeys(): { name: string; displayName: string; sessionKey: string }[] {
    return listChannelSessionEntries(config.tangoVoiceAgentId, channels);
  }

  getActiveTangoRoute(): VoiceTangoRoute {
    return this.getTangoRouteFor(this.activeChannelName);
  }

  getTangoRouteFor(channelName: string): VoiceTangoRoute {
    const def = channels[channelName];

    // Ad-hoc channels (route-classifier threads). Try the parent forum's
    // session config first so voice shares the same conversation context as
    // text messages in that thread. If there is no explicit parent route,
    // try the channel itself before falling back to a voice-specific session.
    if (channelName.startsWith('id:') && def?.channelId) {
      // Resolve via parent channel (mirrors text routing: thread → parent forum)
      if (def.parentChannelId) {
        const parentRoute = resolveVoiceTangoRoute({
          sessionManager: this.tangoSessionManager,
          channelId: def.parentChannelId,
          fallbackSessionId: resolveChannelSessionKey(config.tangoVoiceAgentId, def),
          fallbackAgentId: config.tangoVoiceAgentId,
        });
        // Only use parent route if it matched a real session config (not the
        // discord:default fallback which would lose thread context).
        if (parentRoute.source === 'tango-config' && parentRoute.matchedChannelKey !== 'discord:default') {
          return {
            ...parentRoute,
            channelKey: `discord:${def.channelId}`,
          };
        }
      }

      const directRoute = resolveVoiceTangoRoute({
        sessionManager: this.tangoSessionManager,
        channelId: def.channelId,
        fallbackSessionId: resolveChannelSessionKey(config.tangoVoiceAgentId, def),
        fallbackAgentId: config.tangoVoiceAgentId,
      });
      if (directRoute.source === 'tango-config' && directRoute.matchedChannelKey !== 'discord:default') {
        return directRoute;
      }

      return {
        sessionId: resolveChannelSessionKey(config.tangoVoiceAgentId, def),
        agentId: config.tangoVoiceAgentId,
        source: 'fallback',
        channelKey: `discord:${def.channelId}`,
      };
    }

    return resolveVoiceTangoRoute({
      sessionManager: this.tangoSessionManager,
      channelId: def?.channelId || null,
      fallbackSessionId: resolveChannelSessionKey(config.tangoVoiceAgentId, def),
      fallbackAgentId: config.tangoVoiceAgentId,
    });
  }

  getActiveSessionKey(): string {
    return resolveChannelSessionKey(config.tangoVoiceAgentId, channels[this.activeChannelName]);
  }

  getSessionKeyFor(channelName: string): string {
    return resolveChannelSessionKey(config.tangoVoiceAgentId, channels[channelName]);
  }

  private async seedHistory(name: string): Promise<Message[]> {
    return this.seedHistoryFromDiscord(name);
  }

  private async seedHistoryFromDiscord(name: string): Promise<Message[]> {
    const def = channels[name];
    if (!def || !def.channelId) return [];

    const textChannel = await this.resolveChannel(def.channelId);
    if (!textChannel) return [];

    // Cache for getLogChannel
    this.resolvedChannels.set(def.channelId, textChannel);

    try {
      const fetched = await textChannel.messages.fetch({ limit: 50 });

      // Discord returns newest first, reverse to chronological order
      const sorted = [...fetched.values()].reverse();
      const messages = convertDiscordHistoryMessages(sorted, config.botName);

      console.log(`Seeded ${messages.length} messages from #${name} Discord history`);
      return messages;
    } catch (err: any) {
      console.error(`Failed to seed history from #${name}:`, err.message);
      return [];
    }
  }

  private async getLastMessageFromDiscord(name: string): Promise<Message | null> {
    const def = channels[name];
    if (!def?.channelId) return null;

    const textChannel = await this.resolveChannel(def.channelId);
    if (!textChannel) return null;

    this.resolvedChannels.set(def.channelId, textChannel);

    try {
      const fetched = await textChannel.messages.fetch({ limit: 10 });
      return collapseLatestDiscordHistoryMessages([...fetched.values()], config.botName);
    } catch (err: any) {
      console.error(`Failed to fetch last Discord message from #${name}:`, err.message);
      return null;
    }
  }

  private loadTangoSessionManager():
    | VoiceTangoSessionManager
    | null {
    const configDir = resolveSharedTangoConfigPath();
    try {
      return createTangoSessionManager(configDir);
    } catch (err: any) {
      console.warn(`Tango session config unavailable for voice routing: ${err.message}`);
      return null;
    }
  }

  private hydrateDefaultChannelFromTangoConfig(): void {
    const defaultChannel = channels['default'];
    if (!defaultChannel || defaultChannel.channelId.trim().length > 0) return;

    const defaultSession = this.tangoSessionManager?.listSessions()
      .find((session) => session.channels.includes('discord:default'));
    if (!defaultSession) return;

    const explicitDiscordChannel = defaultSession.channels.find(
      (channel) => channel.startsWith('discord:') && channel !== 'discord:default',
    );
    if (!explicitDiscordChannel) return;

    const channelId = explicitDiscordChannel.slice('discord:'.length).trim();
    if (!channelId || channelId === 'default') return;

    defaultChannel.channelId = channelId;
    console.log(`Voice default channel mapped to Tango default Discord channel ${channelId}`);
  }
}
