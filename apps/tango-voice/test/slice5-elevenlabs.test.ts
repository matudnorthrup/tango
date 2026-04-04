import { describe, it, expect } from 'vitest';

describe('ElevenLabs TTS', () => {
  it('should return a valid MP3 audio stream', async () => {
    if (process.env['RUN_LIVE_ELEVENLABS_TESTS'] !== '1') {
      console.log('RUN_LIVE_ELEVENLABS_TESTS not enabled, skipping live ElevenLabs API test');
      return;
    }
    if (!process.env['ELEVENLABS_API_KEY'] || process.env['ELEVENLABS_API_KEY'] === 'your_elevenlabs_api_key_here') {
      console.log('ELEVENLABS_API_KEY not set, skipping API test');
      return;
    }
    if (!process.env['ELEVENLABS_VOICE_ID']) {
      console.log('ELEVENLABS_VOICE_ID not set, skipping live ElevenLabs API test');
      return;
    }

    const { textToSpeechStream } = await import('../src/services/elevenlabs.js');

    const stream = await textToSpeechStream('Hello, this is a test.');
    const chunks: Buffer[] = [];

    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }

    const audio = Buffer.concat(chunks);
    expect(audio.length).toBeGreaterThan(100);

    // Check for MP3 sync word (0xFF 0xFB or 0xFF 0xFA) or ID3 header
    const firstByte = audio[0];
    const hasId3 = audio.toString('ascii', 0, 3) === 'ID3';
    const hasMp3Sync = firstByte === 0xFF;

    expect(hasId3 || hasMp3Sync).toBe(true);
  });
});
