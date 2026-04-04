import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let QueueState: typeof import('../src/services/queue-state.js').QueueState;
let resolveVoiceModeStatePath: typeof import('../src/services/queue-state.js').resolveVoiceModeStatePath;

const originalTangoHome = process.env['TANGO_HOME'];
const originalTangoProfile = process.env['TANGO_PROFILE'];
const originalVoiceQueueStatePath = process.env['VOICE_QUEUE_STATE_PATH'];
const isolatedTangoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tango-voice-mode-test-'));

describe('QueueState', () => {
  beforeAll(async () => {
    process.env['TANGO_HOME'] = isolatedTangoHome;
    process.env['TANGO_PROFILE'] = 'test';
    process.env['VOICE_QUEUE_STATE_PATH'] = path.join(isolatedTangoHome, 'legacy-voice-mode.json');
    vi.resetModules();
    ({ QueueState, resolveVoiceModeStatePath } = await import('../src/services/queue-state.js'));
  });

  beforeEach(() => {
    try {
      fs.rmSync(resolveVoiceModeStatePath(), { force: true });
    } catch {
      // Best-effort cleanup.
    }
    try {
      fs.rmSync(process.env['VOICE_QUEUE_STATE_PATH']!, { force: true });
    } catch {
      // Best-effort cleanup.
    }
  });

  afterAll(() => {
    if (originalTangoHome === undefined) {
      delete process.env['TANGO_HOME'];
    } else {
      process.env['TANGO_HOME'] = originalTangoHome;
    }
    if (originalTangoProfile === undefined) {
      delete process.env['TANGO_PROFILE'];
    } else {
      process.env['TANGO_PROFILE'] = originalTangoProfile;
    }
    if (originalVoiceQueueStatePath === undefined) {
      delete process.env['VOICE_QUEUE_STATE_PATH'];
    } else {
      process.env['VOICE_QUEUE_STATE_PATH'] = originalVoiceQueueStatePath;
    }
    vi.resetModules();
    fs.rmSync(isolatedTangoHome, { recursive: true, force: true });
  });

  it('defaults to background mode', () => {
    const state = new QueueState();
    expect(state.getMode()).toBe('queue');
  });

  it('sets and persists mode', () => {
    const state = new QueueState();
    state.setMode('queue');
    expect(state.getMode()).toBe('queue');

    const state2 = new QueueState();
    expect(state2.getMode()).toBe('queue');
  });

  it('normalizes ask mode into background mode', () => {
    const state = new QueueState();
    state.setMode('ask');
    expect(state.getMode()).toBe('queue');
  });

  it('keeps queue lifecycle methods as no-ops', () => {
    const state = new QueueState();
    const item = state.enqueue({
      channel: 'nutrition',
      displayName: 'Nutrition',
      sessionKey: 'agent:main:discord:channel:123',
      userMessage: 'How many calories in an avocado?',
      speakerAgentId: 'malibu',
    });

    expect(item.status).toBe('pending');
    expect(item.id).toBeTruthy();
    expect(item.speakerAgentId).toBe('malibu');

    state.markReady(item.id, 'summary', 'response');
    state.markHeard(item.id);

    expect(state.getPendingItems()).toEqual([]);
    expect(state.getReadyItems()).toEqual([]);
    expect(state.getNextReady()).toBeNull();
    expect(state.getReadyByChannel('nutrition')).toBeNull();
  });
});
