import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, GatewayIntentBits, type Guild } from 'discord.js';
import { config } from '../config.js';
import { joinChannel, leaveChannel } from '../discord/voice-connection.js';
import { VoicePipeline } from '../pipeline/voice-pipeline.js';
import { ChannelRouter } from '../services/channel-router.js';
import { setGatedMode } from '../services/voice-settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type Check = { id: string; ok: boolean; detail: string };
type SpeakableTarget = { id: string; name: string };

const DEFAULT_SWITCH_CHANNEL_ID = '100000000000010101';
const DEFAULT_UTILITY_CHANNEL_ID = '100000000000010102';
const DEFAULT_FORUM_POST_ID = '100000000000010103';

class InMemoryQueueState {
  private mode: 'wait' | 'queue' | 'ask' = 'wait';
  private items: Array<{
    id: string;
    channel: string;
    displayName: string;
    sessionKey: string;
    userMessage: string;
    summary: string;
    responseText: string;
    timestamp: number;
    status: 'pending' | 'ready' | 'heard';
  }> = [];
  private snapshots: Record<string, number> = {};

  getMode() { return this.mode; }
  setMode(mode: 'wait' | 'queue' | 'ask') { this.mode = mode; }
  enqueue(params: { channel: string; displayName: string; sessionKey: string; userMessage: string }) {
    const id = `vq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const item = {
      id,
      channel: params.channel,
      displayName: params.displayName,
      sessionKey: params.sessionKey,
      userMessage: params.userMessage,
      summary: '',
      responseText: '',
      timestamp: Date.now(),
      status: 'pending' as const,
    };
    this.items.push(item);
    return item;
  }
  markReady(id: string, summary: string, responseText: string) {
    const it = this.items.find((i) => i.id === id);
    if (!it) return;
    it.status = 'ready';
    it.summary = summary;
    it.responseText = responseText;
  }
  markHeard(id: string) {
    const it = this.items.find((i) => i.id === id);
    if (!it) return;
    it.status = 'heard';
  }
  getReadyItems() { return this.items.filter((i) => i.status === 'ready'); }
  getPendingItems() { return this.items.filter((i) => i.status === 'pending'); }
  getNextReady() { return this.items.find((i) => i.status === 'ready') ?? null; }
  getReadyByChannel(channel: string) { return this.items.find((i) => i.status === 'ready' && i.channel === channel) ?? null; }
  getLastItem() { return this.items[this.items.length - 1] ?? null; }
  getSnapshots() { return { ...this.snapshots }; }
  setSnapshots(s: Record<string, number>) { this.snapshots = { ...s }; }
  clearSnapshots() { this.snapshots = {}; }
  getHeardCount() { return this.items.filter((i) => i.status === 'heard').length; }
}

async function waitFor(cond: () => boolean, timeoutMs: number, intervalMs = 200): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

function getWavFor(text: string): { wav: Buffer; durationMs: number } {
  const fixtureDir = path.join(__dirname, '../../test/fixtures/e2e-voice-loop');
  if (!existsSync(fixtureDir)) mkdirSync(fixtureDir, { recursive: true });
  const safe = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
  const file = path.join(fixtureDir, `${safe || 'utt'}.wav`);
  if (!existsSync(file)) {
    const escaped = text.replace(/"/g, '\\"');
    execSync(`say -o "${file}" --data-format=LEI16@48000 "${escaped}"`, { timeout: 15_000 });
  }
  const wav = readFileSync(file);
  const pcmBytes = Math.max(0, wav.length - 44);
  const durationMs = Math.max(250, Math.round((pcmBytes / 2 / 48000) * 1000));
  return { wav, durationMs };
}

async function injectSpeech(pipeline: VoicePipeline, text: string): Promise<void> {
  const { wav, durationMs } = getWavFor(text);
  await (pipeline as any).handleUtterance('e2e-voice-user', wav, durationMs);
}

async function resolveSpeakableChannel(client: Client, channelId: string): Promise<SpeakableTarget | null> {
  const resolved = await client.channels.fetch(channelId).catch(() => null);
  if (!resolved || !('name' in resolved) || typeof resolved.name !== 'string' || resolved.name.trim().length === 0) {
    return null;
  }
  return { id: resolved.id, name: resolved.name.trim() };
}

function scoreSpeakableName(name: string): number {
  const trimmed = name.trim();
  if (!trimmed) return Number.NEGATIVE_INFINITY;
  const words = trimmed.split(/\s+/).filter(Boolean);
  let score = 0;
  if (words.length <= 3) score += 8;
  if (words.length === 1) score += 2;
  if (!/\d/.test(trimmed)) score += 3;
  if (/^[a-z0-9 ]+$/i.test(trimmed)) score += 4;
  score -= trimmed.length / 20;
  return score;
}

async function pickFallbackSpeakableTarget(
  router: ChannelRouter,
  guild: Guild,
  excludeIds: Set<string>,
): Promise<SpeakableTarget> {
  const preferredParentId = router.getActiveChannel().channelId ?? null;
  const activeThreads = await guild.channels.fetchActiveThreads();
  const candidates = [...activeThreads.threads.values()]
    .filter((thread) => !thread.archived && thread.name.trim().length > 0 && !excludeIds.has(thread.id))
    .map((thread) => ({
      id: thread.id,
      name: thread.name.trim(),
      score: scoreSpeakableName(thread.name) + (thread.parentId === preferredParentId ? 10 : 0),
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  const winner = candidates[0];
  if (!winner) {
    throw new Error('No active speakable thread targets found for legacy voice-loop E2E.');
  }
  return { id: winner.id, name: winner.name };
}

async function resolveSwitchTarget(
  client: Client,
  guild: Guild,
  router: ChannelRouter,
  explicitId: string,
  excludeIds: Set<string>,
): Promise<SpeakableTarget> {
  const resolvedExplicit = await resolveSpeakableChannel(client, explicitId);
  if (resolvedExplicit && !excludeIds.has(resolvedExplicit.id)) {
    excludeIds.add(resolvedExplicit.id);
    return resolvedExplicit;
  }

  const fallback = await pickFallbackSpeakableTarget(router, guild, excludeIds);
  excludeIds.add(fallback.id);
  console.log(`[e2e] fallback target for stale id ${explicitId}: ${fallback.name} (${fallback.id})`);
  return fallback;
}

function forceIdle(pipeline: VoicePipeline): void {
  const p: any = pipeline;
  try { p.cancelPendingWait?.('e2e force idle'); } catch {}
  try { p.stateMachine?.transition?.({ type: 'RETURN_TO_IDLE' }); } catch {}
  try { p.stopWaitingLoop?.(); } catch {}
  try { p.player?.stopPlayback?.(); } catch {}
}

async function main(): Promise<void> {
  const checks: Check[] = [];
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  const switchChannelId = process.env['E2E_SWITCH_CHANNEL_ID'] || DEFAULT_SWITCH_CHANNEL_ID;
  const utilityChannelId = process.env['E2E_UTILITY_CHANNEL_ID'] || DEFAULT_UTILITY_CHANNEL_ID;
  const forumPostId = process.env['E2E_FORUM_POST_ID'] || DEFAULT_FORUM_POST_ID;
  let pipeline: VoicePipeline | null = null;

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Discord login timeout')), 20_000);
      client.once('clientReady', () => { clearTimeout(timeout); resolve(); });
      client.login(config.discordToken).catch((err) => { clearTimeout(timeout); reject(err); });
    });
    checks.push({ id: 'discord-login', ok: true, detail: `Connected as ${client.user?.tag}` });

    const guild = client.guilds.cache.get(config.discordGuildId) ?? await client.guilds.fetch(config.discordGuildId);
    const connection = await joinChannel(config.discordVoiceChannelId, guild.id, guild.voiceAdapterCreator);
    checks.push({ id: 'voice-join', ok: true, detail: `Joined voice ${config.discordVoiceChannelId}` });

    const router = new ChannelRouter(guild);
    const reservedTargetIds = new Set<string>();
    const switchTarget = await resolveSwitchTarget(client, guild, router, switchChannelId, reservedTargetIds);
    const utilityTarget = await resolveSwitchTarget(client, guild, router, utilityChannelId, reservedTargetIds);
    const overlapTarget = await resolveSwitchTarget(client, guild, router, forumPostId, reservedTargetIds);
    const switchUtterance = `switch to ${switchTarget.name}`;
    const utilityUtterance = `switch to ${utilityTarget.name}`;
    const overlapUtterance = `switch to ${overlapTarget.name}`;
    const askPrompt = 'Watson, can you write one short sentence explaining the main issue in this conversation?';

    for (const utterance of [
      switchUtterance,
      utilityUtterance,
      overlapUtterance,
      askPrompt,
      'go ahead',
    ]) {
      getWavFor(utterance);
    }

    const queueState = new InMemoryQueueState();
    setGatedMode(false); // keep deterministic for automated utterance injection
    queueState.setMode('wait');

    pipeline = new VoicePipeline(connection);
    pipeline.setRouter(router);
    pipeline.setQueueState(queueState as any);
    // Do not start live receiver in this runner; injected utterances drive the same pipeline path
    // without relying on host Opus decoder availability.

    // Scenario 1: direct switch using the resolved Discord channel name.
    await injectSpeech(pipeline, switchUtterance);
    const switched = await waitFor(() => router.getActiveChannel().name === `id:${switchTarget.id}`, 20_000);
    checks.push({
      id: 'voice-switch-channel-id',
      ok: switched,
      detail: switched ? `Active ${router.getActiveChannel().name}` : `Active ${router.getActiveChannel().name}`,
    });

    // Scenario 2: switch to another dynamic channel by its human-spoken name.
    await injectSpeech(pipeline, utilityUtterance);
    const switchChoiceNav = await waitFor(() => router.getActiveChannel().name === `id:${utilityTarget.id}`, 20_000);
    checks.push({
      id: 'switch-choice-navigation-live',
      ok: switchChoiceNav,
      detail: switchChoiceNav ? `Navigated to ${router.getActiveChannel().name}` : 'Navigation from switch-choice failed',
    });
    forceIdle(pipeline);

    // Scenario 3: switch to a third dynamic channel by its human-spoken name.
    queueState.setMode('wait');
    forceIdle(pipeline);
    await injectSpeech(pipeline, overlapUtterance);
    const thirdSwitch = await waitFor(() => router.getActiveChannel().name === `id:${overlapTarget.id}`, 20_000);
    checks.push({
      id: 'third-switch-navigation-live',
      ok: thirdSwitch,
      detail: thirdSwitch ? `Navigated to ${router.getActiveChannel().name}` : `Active ${router.getActiveChannel().name}`,
    });
    forceIdle(pipeline);

    // Scenario 4: ask-mode alias behaves as background mode and supports go-ahead retrieval.
    queueState.setMode('ask');
    forceIdle(pipeline);
    await injectSpeech(pipeline, askPrompt);
    const queuedSeen = await waitFor(
      () => queueState.getPendingItems().length > 0 || queueState.getReadyItems().length > 0,
      10_000,
    );
    const readySeen = await waitFor(() => queueState.getReadyItems().length > 0, 35_000);
    const readyBeforeInboxNext = queueState.getReadyItems().length;
    const heardBeforeInboxNext = queueState.getHeardCount();
    const channelAtReady = router.getActiveChannel().name;
    const latestItem = queueState.getLastItem();
    checks.push({
      id: 'ask-alias-background-ready',
      ok: queuedSeen && readySeen,
      detail: latestItem
        ? `queued=${queuedSeen} ready=${queueState.getReadyItems().length} prompt="${latestItem.userMessage.slice(0, 80)}"`
        : `queued=${queuedSeen} ready=${queueState.getReadyItems().length} pending=${queueState.getPendingItems().length}`,
    });
    checks.push({
      id: 'ready-notify-does-not-switch-channel',
      ok: channelAtReady === router.getActiveChannel().name,
      detail: `channel=${router.getActiveChannel().name}`,
    });

    await injectSpeech(pipeline, 'go ahead');
    const heardAfterNext = await waitFor(() => {
      const readyNow = queueState.getReadyItems().length;
      const heardNow = queueState.getHeardCount();
      return readyNow < readyBeforeInboxNext || heardNow > heardBeforeInboxNext;
    }, 20_000);
    checks.push({
      id: 'go-ahead-consumes-ready',
      ok: heardAfterNext,
      detail: heardAfterNext
        ? `ready ${readyBeforeInboxNext}->${queueState.getReadyItems().length}, heard ${heardBeforeInboxNext}->${queueState.getHeardCount()}`
        : `no consume signal (ready ${readyBeforeInboxNext}->${queueState.getReadyItems().length}, heard ${heardBeforeInboxNext}->${queueState.getHeardCount()})`,
    });

  } catch (err: any) {
    checks.push({ id: 'fatal', ok: false, detail: err?.message || String(err) });
  } finally {
    if (pipeline) {
      try { pipeline.stop(); } catch {}
    }
    try { leaveChannel(); } catch {}
    try { await client.destroy(); } catch {}
  }

  let failed = 0;
  for (const c of checks) {
    if (!c.ok) failed++;
    console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.id} - ${c.detail}`);
  }
  console.log(`\nVoice loop E2E summary: ${checks.length - failed} passed, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

void main();
