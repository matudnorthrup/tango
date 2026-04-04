import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

describe('Voice completion routing', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env = {
      ...ORIGINAL_ENV,
      TANGO_VOICE_COMPLETION_URL: 'http://127.0.0.1:8787/voice/completion',
      TANGO_VOICE_API_KEY: 'test-api-key',
    };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sends quick completions through the Tango completion bridge', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ok: true, text: 'BEST: default', providerName: 'claude-oauth' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const { quickCompletion } = await import('../src/services/claude.js');

    const result = await quickCompletion('Match a channel.', 'general', 120);
    expect(result).toBe('BEST: default');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8787/voice/completion');

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    const body = JSON.parse(String(init.body));

    expect(headers.Authorization).toBe('Bearer test-api-key');
    expect(body.systemPrompt).toBe('Match a channel.');
    expect(body.messages).toEqual([
      { role: 'user', content: 'general' },
    ]);
    expect(body.maxTokens).toBe(120);
  });

  it('sends conversation history through the Tango completion bridge and sanitizes the reply', async () => {
    const contaminated = [
      'Looks good to me.',
      '',
      '[voice-user]',
      '',
      'repeat this please',
      '',
      '[voice-assistant]',
      '',
      'Looks good to me.',
    ].join('\n');

    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ok: true, text: contaminated, providerName: 'claude-oauth' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const { getResponse } = await import('../src/services/claude.js');
    const result = await getResponse('agent:main:discord:channel:112233', 'test sanitize', {
      systemPrompt: 'You are terse.',
      history: [
        { role: 'assistant', content: 'Previous answer.' },
      ],
    });

    expect(result.response).toBe('Looks good to me.');
    expect(result.history).toEqual([
      { role: 'assistant', content: 'Previous answer.' },
      { role: 'user', content: 'test sanitize' },
      { role: 'assistant', content: 'Looks good to me.' },
    ]);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.systemPrompt).toBe('You are terse.');
    expect(body.messages).toEqual([
      { role: 'assistant', content: 'Previous answer.' },
      { role: 'user', content: 'test sanitize' },
    ]);
  });
});
