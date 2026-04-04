import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveConfiguredPath, resolveTangoProfileDataDir } from '@tango/core';

export type VoiceMode = 'wait' | 'queue' | 'ask';

export function normalizeVoiceMode(mode: string | null | undefined): VoiceMode {
  const normalized = (mode ?? '').trim().toLowerCase();
  if (normalized === 'wait' || normalized === 'focus') return 'wait';
  if (
    normalized === 'queue'
    || normalized === 'inbox'
    || normalized === 'background'
    || normalized === 'ask'
  ) {
    return 'queue';
  }
  return 'queue';
}

export function getVoiceModeLabel(mode: string | null | undefined): 'focus' | 'background' {
  return normalizeVoiceMode(mode) === 'wait' ? 'focus' : 'background';
}

/**
 * Legacy interface — kept for API compatibility.
 * Queue item lifecycle is now handled by the unified Discord-anchored inbox.
 * enqueue() returns a dummy item with a random UUID for correlation only.
 */
export interface QueuedResponse {
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
}

export function resolveVoiceModeStatePath(): string {
  const configured = process.env['TANGO_VOICE_MODE_STATE_PATH']?.trim();
  if (configured && configured.length > 0) {
    return resolveConfiguredPath(configured);
  }
  return join(resolveTangoProfileDataDir(), 'voice-mode.json');
}

function resolveLegacyStatePaths(): string[] {
  const configuredLegacy = process.env['VOICE_QUEUE_STATE_PATH']?.trim();
  const homeDir = process.env['HOME'];
  const candidates = [
    configuredLegacy ? resolveConfiguredPath(configuredLegacy) : null,
    homeDir ? join(homeDir, '.tango', 'voice-mode.json') : null,
    homeDir ? join(homeDir, 'clawd', 'voice-queue-state.json') : null,
  ];

  return [...new Set(candidates.filter((value): value is string => Boolean(value)))];
}

const STATE_PATH = resolveVoiceModeStatePath();

/**
 * Mode-only persistence for voice pipeline.
 *
 * Previously tracked a full queue of pending/ready/heard items alongside
 * channel snapshots. That lifecycle is now handled by the unified
 * Discord-anchored inbox (read watermarks in SQLite). This class retains
 * only the voice mode persistence.
 *
 * All queue item methods are no-ops that return empty data — callers
 * continue to compile and run safely without changes.
 */
export class QueueState {
  private mode: VoiceMode = 'queue';

  constructor() {
    this.load();
  }

  getMode(): VoiceMode {
    return this.mode;
  }

  setMode(mode: VoiceMode): void {
    this.mode = normalizeVoiceMode(mode);
    this.save();
  }

  /** Returns a dummy item with a random UUID for dispatch correlation. */
  enqueue(params: {
    channel: string;
    displayName: string;
    sessionKey: string;
    userMessage: string;
    speakerAgentId?: string | null;
  }): QueuedResponse {
    return {
      id: randomUUID(),
      channel: params.channel,
      displayName: params.displayName,
      sessionKey: params.sessionKey,
      userMessage: params.userMessage,
      speakerAgentId: params.speakerAgentId ?? null,
      summary: '',
      responseText: '',
      timestamp: Date.now(),
      status: 'pending',
    };
  }

  // --- No-op queue lifecycle methods (unified inbox handles this now) ---

  markReady(_id: string, _summary: string, _responseText: string, _speakerAgentId?: string | null): void {}
  markHeard(_id: string): void {}
  getReadyItems(): QueuedResponse[] { return []; }
  getPendingItems(): QueuedResponse[] { return []; }
  getNextReady(): QueuedResponse | null { return null; }
  getReadyByChannel(_channel: string): QueuedResponse | null { return null; }

  // --- No-op snapshot methods (InboxTracker removed) ---

  getSnapshots(): Record<string, number> { return {}; }
  setSnapshots(_snapshots: Record<string, number>): void {}
  clearSnapshots(): void {}

  private load(): void {
    try {
      const raw = readFileSync(STATE_PATH, 'utf-8');
      const data = JSON.parse(raw);
      this.mode = normalizeVoiceMode(data.mode);
    } catch {
      for (const legacyPath of resolveLegacyStatePaths()) {
        try {
          const raw = readFileSync(legacyPath, 'utf-8');
          const data = JSON.parse(raw);
          this.mode = normalizeVoiceMode(data.mode);
          this.save();
          return;
        } catch {
          // Try the next legacy path.
        }
      }
      this.mode = 'queue';
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(STATE_PATH), { recursive: true });
      writeFileSync(STATE_PATH, JSON.stringify({ mode: this.mode }, null, 2));
    } catch (err: any) {
      console.error(`Failed to save voice mode: ${err.message}`);
    }
  }
}
