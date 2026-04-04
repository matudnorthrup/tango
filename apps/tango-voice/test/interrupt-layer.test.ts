import { describe, expect, it } from 'vitest';
import { InterruptLayer } from '../src/pipeline/interrupt-layer.js';

describe('InterruptLayer', () => {
  it('detects wake-only utterances', () => {
    const layer = new InterruptLayer({ wakeNames: ['Tango'] });

    expect(layer.classifyTranscript('Hey Tango')).toEqual({
      type: 'interrupt:wake',
      transcript: 'Hey Tango',
    });
  });

  it('detects cancel commands', () => {
    const layer = new InterruptLayer({ wakeNames: ['Tango'], allowBareCancel: true });

    expect(layer.classifyTranscript('Hey Tango, cancel')).toEqual({
      type: 'interrupt:cancel',
      transcript: 'Hey Tango, cancel',
    });
    expect(layer.classifyTranscript('cancel')).toEqual({
      type: 'interrupt:cancel',
      transcript: 'cancel',
    });
  });

  it('maps inbox commands to system interrupts', () => {
    const layer = new InterruptLayer({ wakeNames: ['Tango'] });

    expect(layer.classifyTranscript('Hey Tango, check inbox')).toEqual({
      type: 'interrupt:system-command',
      transcript: 'Hey Tango, check inbox',
      command: 'check-inbox',
      sourceCommand: { type: 'inbox-check' },
    });

    expect(layer.classifyTranscript('Hey Tango, next')).toEqual({
      type: 'interrupt:system-command',
      transcript: 'Hey Tango, next',
      command: 'next-response',
      sourceCommand: { type: 'inbox-next' },
    });
  });

  it('recognizes background and focus switch phrasing', () => {
    const layer = new InterruptLayer({ wakeNames: ['Tango'] });

    expect(layer.classifyTranscript('Hey Tango, put it in the background')).toEqual({
      type: 'interrupt:system-command',
      transcript: 'Hey Tango, put it in the background',
      command: 'switch-to-background',
    });

    expect(layer.classifyTranscript('Hey Tango, switch to focus')).toEqual({
      type: 'interrupt:system-command',
      transcript: 'Hey Tango, switch to focus',
      command: 'switch-to-focus',
    });
  });

  it('returns null for non-interrupt transcripts', () => {
    const layer = new InterruptLayer({ wakeNames: ['Tango'] });

    expect(layer.classifyTranscript('Summarize the roadmap')).toBeNull();
  });
});
