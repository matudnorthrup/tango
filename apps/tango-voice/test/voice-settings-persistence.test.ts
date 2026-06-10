import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  enableVoiceSettingsPersistence,
  getVoiceSettings,
  initVoiceSettings,
  persistVoiceSettingsNow,
  resetVoiceSettingsPersistenceForTest,
  setIndicateTimeoutMs,
  setMinSpeechDuration,
} from '../src/services/voice-settings.js';

const tempDirs: string[] = [];

function tempOverlayPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tango-voice-settings-'));
  tempDirs.push(dir);
  return path.join(dir, 'settings-overrides.json');
}

describe('voice settings persistence', () => {
  afterEach(() => {
    resetVoiceSettingsPersistenceForTest();
    // Restore values mutated by tests (module-global settings object).
    initVoiceSettings({ minSpeechDurationMs: 600, indicateTimeoutMs: 20000 });
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes only setter-changed keys to the overlay file', () => {
    const overlayPath = tempOverlayPath();
    enableVoiceSettingsPersistence(overlayPath);

    setMinSpeechDuration(350);
    persistVoiceSettingsNow();

    const written = JSON.parse(fs.readFileSync(overlayPath, 'utf8'));
    expect(written).toEqual({ minSpeechDurationMs: 350 });
  });

  it('applies a valid overlay over current settings on enable', () => {
    const overlayPath = tempOverlayPath();
    fs.writeFileSync(overlayPath, JSON.stringify({ indicateTimeoutMs: 90000 }));

    initVoiceSettings({ indicateTimeoutMs: 45000 });
    enableVoiceSettingsPersistence(overlayPath);

    expect(getVoiceSettings().indicateTimeoutMs).toBe(90000);
  });

  it('ignores unknown keys and type-mismatched values in the overlay', () => {
    const overlayPath = tempOverlayPath();
    fs.writeFileSync(
      overlayPath,
      JSON.stringify({
        bogusKey: true,
        minSpeechDurationMs: 'fast',
        vadFrameSamples: 999,
        indicateTimeoutMs: 60000,
      }),
    );

    initVoiceSettings({ minSpeechDurationMs: 600, indicateTimeoutMs: 45000 });
    enableVoiceSettingsPersistence(overlayPath);

    const settings = getVoiceSettings();
    expect(settings.minSpeechDurationMs).toBe(600);
    expect(settings.vadFrameSamples).not.toBe(999);
    expect(settings.indicateTimeoutMs).toBe(60000);
  });

  it('round-trips runtime tuning across a simulated restart', () => {
    const overlayPath = tempOverlayPath();
    enableVoiceSettingsPersistence(overlayPath);
    setIndicateTimeoutMs(120000);
    persistVoiceSettingsNow();

    // Simulate restart: env init resets the value, overlay re-applies it.
    resetVoiceSettingsPersistenceForTest();
    initVoiceSettings({ indicateTimeoutMs: 45000 });
    enableVoiceSettingsPersistence(overlayPath);

    expect(getVoiceSettings().indicateTimeoutMs).toBe(120000);
  });
});
