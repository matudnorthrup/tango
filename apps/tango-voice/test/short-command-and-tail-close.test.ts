import { describe, expect, it, vi } from 'vitest';

// Controllable command-lane transcription for tryShortCommandRescue tests.
let commandTailImpl: () => Promise<{ text: string; durationMs: number; elapsedMs: number; usedTail: boolean } | null> =
  async () => null;

vi.mock('../src/services/whisper.js', () => ({
  transcribe: vi.fn(async () => ''),
  transcribeCommandTail: vi.fn(async () => commandTailImpl()),
}));

import { VoicePipeline } from '../src/pipeline/voice-pipeline.js';
import { pcmToWav } from '../src/audio/wav-utils.js';

/**
 * These suites exercise private pipeline matchers without constructing a full
 * pipeline (which needs a live VoiceConnection). A prototype-backed object
 * with a stubbed voice-target directory is enough for the pure logic.
 */
function makeMatcherHost(callSigns: string[] = ['Malibu', 'Bravo Malibu']) {
  const host = Object.create(VoicePipeline.prototype);
  host.voiceTargets = {
    listAgents: () => [
      {
        id: 'malibu',
        type: 'personal',
        displayName: 'Malibu',
        callSigns,
      },
    ],
    getAllCallSigns: () => callSigns,
    resolveExplicitAddress: () => null,
    resolveAgentQuery: () => null,
    getAgent: () => null,
  };
  host.stateMachine = { getState: () => ({ type: 'IDLE' }), getStateType: () => 'IDLE' };
  return host;
}

function loudWav(durationMs: number): Buffer {
  const samples = Math.round((durationMs / 1000) * 16000);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    pcm.writeInt16LE(i % 2 === 0 ? 8000 : -8000, i * 2);
  }
  return pcmToWav(pcm, 16000);
}

function quietWav(durationMs: number): Buffer {
  const samples = Math.round((durationMs / 1000) * 16000);
  return pcmToWav(Buffer.alloc(samples * 2), 16000);
}

describe('matchesShortCommandPhrase', () => {
  const host = makeMatcherHost();
  const matches = (text: string): boolean => host.matchesShortCommandPhrase(text);

  it('accepts close, dismiss, and bare queue phrases', () => {
    expect(matches('go ahead')).toBe(true);
    expect(matches('Thank you.')).toBe(true);
    expect(matches('thanks')).toBe(true);
    expect(matches("that's all")).toBe(true);
    expect(matches('next')).toBe(true);
    expect(matches('skip')).toBe(true);
    expect(matches('go ahead Malibu')).toBe(true);
  });

  it('accepts whole-utterance cancel words', () => {
    expect(matches('stop')).toBe(true);
    expect(matches('cancel')).toBe(true);
    expect(matches('never mind')).toBe(true);
  });

  it('rejects ordinary speech fragments', () => {
    expect(matches('hello there')).toBe(false);
    expect(matches('what')).toBe(false);
    expect(matches('the weather')).toBe(false);
    expect(matches('')).toBe(false);
  });
});

describe('tryShortCommandRescue', () => {
  function makeRescueHost() {
    const host = makeMatcherHost();
    host.shortCommandRescue = null;
    return host;
  }

  it('accepts a loud strict-match clip and caches its transcript', async () => {
    const host = makeRescueHost();
    commandTailImpl = async () => ({ text: ' go ahead\n', durationMs: 350, elapsedMs: 40, usedTail: false });
    const wav = loudWav(350);

    await expect(host.tryShortCommandRescue(wav, 350)).resolves.toBe(true);
    expect(host.shortCommandRescue).toEqual({ wavBuffer: wav, transcript: 'go ahead' });
  });

  it('rejects non-matching speech', async () => {
    const host = makeRescueHost();
    commandTailImpl = async () => ({ text: 'random words', durationMs: 350, elapsedMs: 40, usedTail: false });

    await expect(host.tryShortCommandRescue(loudWav(350), 350)).resolves.toBe(false);
    expect(host.shortCommandRescue).toBeNull();
  });

  it('skips near-silent clips before transcribing (hallucination guard)', async () => {
    const host = makeRescueHost();
    let transcribed = false;
    commandTailImpl = async () => {
      transcribed = true;
      return { text: 'Thank you.', durationMs: 350, elapsedMs: 40, usedTail: false };
    };

    await expect(host.tryShortCommandRescue(quietWav(350), 350)).resolves.toBe(false);
    expect(transcribed).toBe(false);
  });

  it('treats transcription failure as a rejection', async () => {
    const host = makeRescueHost();
    commandTailImpl = async () => {
      throw new Error('stt offline');
    };

    await expect(host.tryShortCommandRescue(loudWav(350), 350)).resolves.toBe(false);
  });
});

describe('extractTailClose binding-predecessor guard', () => {
  const host = makeMatcherHost();
  const extract = (text: string): { content: string; type: string } | null => host.extractTailClose(text);

  it('finalizes deliberate tail closes', () => {
    expect(extract('book the table, go ahead')).toEqual({ content: 'book the table,', type: 'conversational' });
    expect(extract("I finished the draft. That's all.")).toEqual({ content: 'I finished the draft.', type: 'dismiss' });
    expect(extract('log eggs for breakfast, thanks Malibu')).toEqual({
      content: 'log eggs for breakfast,',
      type: 'dismiss',
    });
    // Same-breath prompt + close without punctuation stays supported.
    expect(extract('what is on my calendar tomorrow go ahead')).toEqual({
      content: 'what is on my calendar tomorrow',
      type: 'conversational',
    });
  });

  it('keeps syntactically bound phrases as dictation content', () => {
    expect(extract('we should just go ahead')).toBeNull();
    expect(extract("let me know if that's all")).toBeNull();
    expect(extract('tell him I said thanks Malibu')).toBeNull();
    expect(extract("I think we should go ahead")).toBeNull();
  });

  it('punctuated pause overrides a binding predecessor', () => {
    expect(extract('do it just, go ahead')).toEqual({ content: 'do it just,', type: 'conversational' });
  });

  it('still ignores phrases that are the entire utterance (handled elsewhere)', () => {
    expect(extract('go ahead')).toBeNull();
    expect(extract("that's all")).toBeNull();
  });
});
