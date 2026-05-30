import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

describe('voice config defaults', () => {
  it('defaults to Kokoro so agent-specific voices are honored after restart', async () => {
    delete process.env['TTS_BACKEND'];
    vi.resetModules();

    const { config } = await import('../src/config.js');

    expect(config.ttsBackend).toBe('kokoro');
  });

  it('allows an explicit TTS_BACKEND override', async () => {
    process.env['TTS_BACKEND'] = 'elevenlabs';
    vi.resetModules();

    const { config } = await import('../src/config.js');

    expect(config.ttsBackend).toBe('elevenlabs');
  });

  it('keeps the runtime backend fallback aligned with the Kokoro default', async () => {
    process.env['TTS_BACKEND'] = 'invalid-backend';
    vi.resetModules();

    const { getTtsBackend } = await import('../src/services/tts.js');

    expect(getTtsBackend()).toBe('kokoro');
  });
});
