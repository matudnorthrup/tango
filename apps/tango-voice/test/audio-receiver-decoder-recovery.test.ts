import { EventEmitter } from 'node:events';
import prism from 'prism-media';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalVadProcessor } from '../src/audio/local-vad.js';
import { AudioReceiver } from '../src/discord/audio-receiver.js';
import { setAudioProcessingMode } from '../src/services/voice-settings.js';

type DecoderErrorProbe = {
  handleDecoderError(userId: string, label: string, err: Error): boolean;
};

class FakeOpusStream extends EventEmitter {
  pipe = vi.fn((destination: EventEmitter) => destination);
  unpipe = vi.fn();
  destroy = vi.fn();
}

function createReceiver(onDecoderCorruption = vi.fn()): AudioReceiver {
  const speaking = new EventEmitter();
  const connection = {
    receiver: {
      speaking,
    },
  };

  return new AudioReceiver(
    connection as any,
    vi.fn(),
    undefined,
    onDecoderCorruption,
  );
}

describe('AudioReceiver decoder recovery', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  let consoleWarn: ReturnType<typeof vi.spyOn>;
  let consoleLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-19T12:00:00Z'));
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    setAudioProcessingMode('discord');
    consoleError.mockRestore();
    consoleWarn.mockRestore();
    consoleLog.mockRestore();
    vi.useRealTimers();
  });

  it('triggers recovery for intermittent decoder errors from one user inside the rolling window', () => {
    const onDecoderCorruption = vi.fn();
    const receiver = createReceiver(onDecoderCorruption);
    receiver.start();
    const probe = receiver as unknown as DecoderErrorProbe;

    for (let i = 0; i < AudioReceiver.DECODER_ERROR_THRESHOLD - 1; i += 1) {
      expect(
        probe.handleDecoderError('user-a', 'Decoder error for user-a', new Error('bad packet')),
      ).toBe(false);
      vi.advanceTimersByTime(5_000);
    }

    expect(
      probe.handleDecoderError('user-a', 'Decoder error for user-a', new Error('bad packet')),
    ).toBe(true);
    expect(onDecoderCorruption).toHaveBeenCalledTimes(1);
  });

  it('expires old decoder errors outside the rolling window', () => {
    const onDecoderCorruption = vi.fn();
    const receiver = createReceiver(onDecoderCorruption);
    receiver.start();
    const probe = receiver as unknown as DecoderErrorProbe;

    for (let i = 0; i < AudioReceiver.DECODER_ERROR_THRESHOLD - 1; i += 1) {
      expect(
        probe.handleDecoderError('user-a', 'Decoder error for user-a', new Error('bad packet')),
      ).toBe(false);
    }

    vi.advanceTimersByTime(AudioReceiver.DECODER_ERROR_WINDOW_MS + 1);

    for (let i = 0; i < AudioReceiver.DECODER_ERROR_THRESHOLD - 1; i += 1) {
      expect(
        probe.handleDecoderError('user-a', 'Decoder error for user-a', new Error('bad packet')),
      ).toBe(false);
    }

    expect(onDecoderCorruption).not.toHaveBeenCalled();
  });

  it('triggers recovery for receiver-wide decoder errors across users', () => {
    const onDecoderCorruption = vi.fn();
    const receiver = createReceiver(onDecoderCorruption);
    receiver.start();
    const probe = receiver as unknown as DecoderErrorProbe;

    for (let i = 0; i < AudioReceiver.DECODER_ERROR_THRESHOLD - 1; i += 1) {
      expect(
        probe.handleDecoderError(`user-${i}`, `Decoder error for user-${i}`, new Error('bad packet')),
      ).toBe(false);
    }

    expect(
      probe.handleDecoderError(
        `user-${AudioReceiver.DECODER_ERROR_THRESHOLD}`,
        `Decoder error for user-${AudioReceiver.DECODER_ERROR_THRESHOLD}`,
        new Error('bad packet'),
      ),
    ).toBe(true);
    expect(onDecoderCorruption).toHaveBeenCalledTimes(1);
  });

  it('does not reset rolling decoder errors after decoded data arrives', () => {
    const originalDecoder = (prism.opus as any).Decoder;
    const decoders: EventEmitter[] = [];
    class FakeDecoder extends EventEmitter {
      destroy = vi.fn();

      constructor() {
        super();
        decoders.push(this);
      }
    }
    (prism.opus as any).Decoder = FakeDecoder;

    try {
      const onDecoderCorruption = vi.fn();
      const speaking = new EventEmitter();
      const opusStream = new FakeOpusStream();
      const connection = {
        receiver: {
          speaking,
          subscribe: vi.fn(() => opusStream),
        },
      };
      const receiver = new AudioReceiver(
        connection as any,
        vi.fn(),
        undefined,
        onDecoderCorruption,
      );

      receiver.start();
      speaking.emit('start', 'user-a');

      const decoder = decoders[0];
      for (let i = 0; i < AudioReceiver.DECODER_ERROR_THRESHOLD - 1; i += 1) {
        decoder.emit('error', new Error('bad packet'));
        decoder.emit('data', Buffer.alloc(4));
        vi.advanceTimersByTime(1_000);
      }

      decoder.emit('error', new Error('bad packet'));
      expect(onDecoderCorruption).toHaveBeenCalledTimes(1);
    } finally {
      (prism.opus as any).Decoder = originalDecoder;
    }
  });

  it('counts local opus decrypt stream errors toward recovery across resubscriptions', () => {
    const originalDecoder = (prism.opus as any).Decoder;
    const createVad = vi.spyOn(LocalVadProcessor, 'create').mockResolvedValue(null);
    class FakeDecoder extends EventEmitter {
      destroy = vi.fn();
    }
    (prism.opus as any).Decoder = FakeDecoder;

    try {
      setAudioProcessingMode('local');
      const onDecoderCorruption = vi.fn();
      const speaking = new EventEmitter();
      const opusStreams: FakeOpusStream[] = [];
      const connection = {
        receiver: {
          speaking,
          subscribe: vi.fn(() => {
            const stream = new FakeOpusStream();
            opusStreams.push(stream);
            return stream;
          }),
        },
      };
      const receiver = new AudioReceiver(
        connection as any,
        vi.fn(),
        undefined,
        onDecoderCorruption,
      );

      receiver.start();

      for (let i = 0; i < AudioReceiver.DECODER_ERROR_THRESHOLD; i += 1) {
        speaking.emit('start', 'user-a');
        opusStreams[i]?.emit(
          'error',
          new Error('Failed to decrypt: DecryptionFailed(UnencryptedWhenPassthroughDisabled)'),
        );
      }

      expect(onDecoderCorruption).toHaveBeenCalledTimes(1);
      expect(createVad).toHaveBeenCalledTimes(AudioReceiver.DECODER_ERROR_THRESHOLD);
    } finally {
      createVad.mockRestore();
      (prism.opus as any).Decoder = originalDecoder;
    }
  });
});
