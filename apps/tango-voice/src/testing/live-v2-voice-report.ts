import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, GatewayIntentBits } from 'discord.js';
import { config } from '../config.js';
import { joinChannel, leaveChannel } from '../discord/voice-connection.js';
import { VoicePipeline } from '../pipeline/voice-pipeline.js';
import { ChannelRouter } from '../services/channel-router.js';
import { setEndpointingMode, setGatedMode, setIndicateTimeoutMs } from '../services/voice-settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type Check = { id: string; ok: boolean; detail: string };

class InMemoryQueueState {
  private mode: 'wait' | 'queue' | 'ask' = 'queue';
  private items: Array<{
    id: string;
    channel: string;
    displayName: string;
    sessionKey: string;
    userMessage: string;
    speakerAgentId: string | null;
    summary: string;
    responseText: string;
    timestamp: number;
    status: 'pending' | 'ready' | 'heard';
  }> = [];
  private snapshots: Record<string, number> = {};

  getMode() { return this.mode; }
  setMode(mode: 'wait' | 'queue' | 'ask') { this.mode = mode; }
  enqueue(params: {
    channel: string;
    displayName: string;
    sessionKey: string;
    userMessage: string;
    speakerAgentId?: string | null;
  }) {
    const id = `vq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const item = {
      id,
      channel: params.channel,
      displayName: params.displayName,
      sessionKey: params.sessionKey,
      userMessage: params.userMessage,
      speakerAgentId: params.speakerAgentId ?? null,
      summary: '',
      responseText: '',
      timestamp: Date.now(),
      status: 'pending' as const,
    };
    this.items.push(item);
    return item;
  }
  markReady(id: string, summary: string, responseText: string, speakerAgentId?: string | null) {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) return;
    item.status = 'ready';
    item.summary = summary;
    item.responseText = responseText;
    item.speakerAgentId = speakerAgentId ?? item.speakerAgentId;
  }
  markHeard(id: string) {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) return;
    item.status = 'heard';
  }
  getReadyItems() { return this.items.filter((item) => item.status === 'ready'); }
  getPendingItems() { return this.items.filter((item) => item.status === 'pending'); }
  getNextReady() { return this.items.find((item) => item.status === 'ready') ?? null; }
  getReadyByChannel(channel: string) {
    return this.items.find((item) => item.status === 'ready' && item.channel === channel) ?? null;
  }
  getLastItem() { return this.items[this.items.length - 1] ?? null; }
  getSnapshots() { return { ...this.snapshots }; }
  setSnapshots(snapshots: Record<string, number>) { this.snapshots = { ...snapshots }; }
  clearSnapshots() { this.snapshots = {}; }
  getHeardCount() { return this.items.filter((item) => item.status === 'heard').length; }
}

async function waitFor(cond: () => boolean, timeoutMs: number, intervalMs = 200): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function checkEndpoint(rawUrl: string): Promise<boolean> {
  try {
    const parsed = new URL(rawUrl);
    const port = parsed.port
      ? parseInt(parsed.port, 10)
      : parsed.protocol === 'https:'
        ? 443
        : 80;
    return await new Promise<boolean>((resolve) => {
      const socket = new net.Socket();
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(1200);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
      socket.connect(port, parsed.hostname);
    });
  } catch {
    return false;
  }
}

async function isPrimaryTtsReachable(): Promise<boolean> {
  const backend = config.ttsBackend.trim().toLowerCase();
  if (backend === 'kokoro') return checkEndpoint(config.kokoroUrl);
  if (backend === 'chatterbox') return checkEndpoint(config.chatterboxUrl);
  return true;
}

function getWavFor(text: string): { wav: Buffer; durationMs: number } {
  const fixtureDir = path.join(__dirname, '../../test/fixtures/e2e-v2-voice-loop');
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
  await (pipeline as any).handleUtterance('e2e-v2-user', wav, durationMs);
}

function forceIdle(pipeline: VoicePipeline): void {
  const runtime = pipeline as any;
  try { runtime.cancelPendingWait?.('e2e-v2 force idle'); } catch {}
  try { runtime.stateMachine?.transition?.({ type: 'RETURN_TO_IDLE' }); } catch {}
  try { runtime.stopWaitingLoop?.(); } catch {}
  try { runtime.player?.stopPlayback?.('e2e-v2-force-idle'); } catch {}
}

async function waitForAudioIdle(pipeline: VoicePipeline, timeoutMs = 20_000): Promise<boolean> {
  const runtime = pipeline as any;
  return waitFor(
    () => !runtime.player?.isPlaying?.() && !runtime.player?.isWaiting?.(),
    timeoutMs,
    200,
  );
}

function getLastSpokenText(pipeline: VoicePipeline): string {
  return String((pipeline as any).ctx?.lastSpokenText ?? '');
}

function isIndicateCaptureActive(pipeline: VoicePipeline): boolean {
  return Boolean((pipeline as any).ctx?.indicateCaptureActive);
}

function hasThreadSummaryPrompt(text: string | null | undefined): boolean {
  const normalized = String(text ?? '').toLowerCase();
  return /summariz(?:e|ed)\b/.test(normalized)
    && normalized.includes('this thread')
    && normalized.includes('one short sentence');
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
    const queueState = new InMemoryQueueState();
    setGatedMode(true);
    setEndpointingMode('indicate');
    setIndicateTimeoutMs(10_000);
    queueState.setMode('queue');

    pipeline = new VoicePipeline(connection);
    pipeline.setRouter(router);
    pipeline.setQueueState(queueState as any);
    const baselineCounters = { ...pipeline.getCounters() };

    // Scenario 1: quick mode should dispatch to background and preserve the full prompt.
    const readyBeforeQuick = queueState.getReadyItems().length;
    await injectSpeech(pipeline, 'Hey Watson summarize this thread in one short sentence.');
    const quickReady = await waitFor(() => queueState.getReadyItems().length > readyBeforeQuick, 60_000);
    const quickItem = queueState.getLastItem();
    checks.push({
      id: 'v2-quick-background-dispatch',
      ok: quickReady && hasThreadSummaryPrompt(quickItem?.userMessage),
      detail: quickItem
        ? `ready=${queueState.getReadyItems().length} prompt="${quickItem.userMessage}"`
        : `ready=${queueState.getReadyItems().length}`,
    });
    await waitForAudioIdle(pipeline, 20_000);

    // Scenario 2: indicate mode should keep capture open across separate speech turns.
    const readyBeforeIndicate = queueState.getReadyItems().length;
    await injectSpeech(pipeline, 'Hey Watson');
    const indicateOpened = await waitFor(() => isIndicateCaptureActive(pipeline!), 10_000);
    await waitForAudioIdle(pipeline, 20_000);
    await injectSpeech(pipeline, 'Summarize this thread in one short sentence');
    const stillCapturing = isIndicateCaptureActive(pipeline);
    await injectSpeech(pipeline, 'Hey Watson');
    const indicateReady = await waitFor(() => queueState.getReadyItems().length > readyBeforeIndicate, 60_000);
    const indicateItem = queueState.getLastItem();
    checks.push({
      id: 'v2-indicate-capture-dispatch',
      ok: indicateOpened && stillCapturing && indicateReady
        && Boolean(indicateItem?.userMessage.toLowerCase().includes('summarize this thread in one short sentence')),
      detail: indicateItem
        ? `opened=${indicateOpened} stillCapturing=${stillCapturing} ready=${readyBeforeIndicate}->${queueState.getReadyItems().length} indicateReady=${indicateReady} prompt="${indicateItem.userMessage}"`
        : `opened=${indicateOpened} stillCapturing=${stillCapturing} ready=${queueState.getReadyItems().length}`,
    });
    await waitForAudioIdle(pipeline, 20_000);

    // Scenario 3: cancel should close indicate capture without dispatching.
    const readyBeforeCancel = queueState.getReadyItems().length;
    await injectSpeech(pipeline, 'Hey Watson');
    const cancelOpened = await waitFor(() => isIndicateCaptureActive(pipeline!), 10_000);
    await waitForAudioIdle(pipeline, 20_000);
    await injectSpeech(pipeline, 'Watson cancel');
    const cancelClosed = await waitFor(() => !isIndicateCaptureActive(pipeline!), 10_000);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    checks.push({
      id: 'v2-cancel-closes-listening',
      ok: cancelOpened && cancelClosed && queueState.getReadyItems().length === readyBeforeCancel,
      detail: `opened=${cancelOpened} closed=${cancelClosed} ready=${queueState.getReadyItems().length}`,
    });
    await waitForAudioIdle(pipeline, 20_000);

    // Scenario 4: background response should be readable via next.
    const readyBeforeNext = queueState.getReadyItems().length;
    const heardBeforeNext = queueState.getHeardCount();
    await injectSpeech(pipeline, 'Hey Watson go ahead');
    const nextMisparsedAsIndicate = isIndicateCaptureActive(pipeline);
    const nextConsumed = !nextMisparsedAsIndicate && await waitFor(() => {
      const readyNow = queueState.getReadyItems().length;
      const heardNow = queueState.getHeardCount();
      return readyNow < readyBeforeNext || heardNow > heardBeforeNext;
    }, 20_000);
    checks.push({
      id: 'v2-next-reads-background-response',
      ok: nextConsumed,
      detail: nextMisparsedAsIndicate
        ? 'read-ready command reopened indicate capture instead of consuming a response'
        : `ready ${readyBeforeNext}->${queueState.getReadyItems().length}, heard ${heardBeforeNext}->${queueState.getHeardCount()}`,
    });
    if (nextMisparsedAsIndicate) {
      forceIdle(pipeline);
    }
    await waitForAudioIdle(pipeline, 20_000);

    // Scenario 5: wake-word command during speaking should interrupt the current reply.
    queueState.setMode('wait');
    forceIdle(pipeline);
    await injectSpeech(pipeline, 'Hey Watson');
    const waitOpened = await waitFor(() => isIndicateCaptureActive(pipeline!), 10_000);
    await waitForAudioIdle(pipeline, 20_000);
    await injectSpeech(pipeline, 'Give me a detailed status update for this thread.');
    await injectSpeech(pipeline, 'Hey Watson');
    const speakingStarted = await waitFor(() => {
      const runtime = pipeline as any;
      return runtime.player?.isPlaying?.() && !runtime.player?.isWaiting?.();
    }, 60_000);
    if (speakingStarted) {
      await injectSpeech(pipeline, 'Tango voice status');
    }
    const speakingInterrupted = speakingStarted
      ? await waitForAudioIdle(pipeline, 60_000)
      : false;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const lastSpoken = getLastSpokenText(pipeline);
    const finalCounters = pipeline.getCounters();
    const runtimeErrors = finalCounters.errors - baselineCounters.errors;
    const ttsFailures = finalCounters.ttsFailures - baselineCounters.ttsFailures;
    const ttsHealthy = await isPrimaryTtsReachable();
    checks.push({
      id: 'v2-wake-interrupts-speaking',
      ok: speakingStarted
        && speakingInterrupted
        && /mode:|channel:/i.test(lastSpoken)
        && runtimeErrors === 0
        && ttsFailures === 0
        && ttsHealthy,
      detail: speakingStarted
        ? `lastSpoken="${lastSpoken.slice(0, 160)}" errors=${runtimeErrors} ttsFailures=${ttsFailures} ttsHealthy=${ttsHealthy}`
        : `opened=${waitOpened} never observed speaking playback start`,
    });

    checks.push({
      id: 'v2-runtime-clean',
      ok: runtimeErrors === 0 && ttsFailures === 0 && ttsHealthy,
      detail: `errors=${runtimeErrors} ttsFailures=${ttsFailures} ttsHealthy=${ttsHealthy}`,
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
  for (const check of checks) {
    if (!check.ok) failed++;
    console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.id} - ${check.detail}`);
  }
  console.log(`\nV2 voice loop summary: ${checks.length - failed} passed, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

void main();
