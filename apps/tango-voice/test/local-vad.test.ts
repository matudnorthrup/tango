import { describe, expect, it } from 'vitest';
import { computeLocalVadRuntimeOptions } from '../src/audio/local-vad.js';

describe('computeLocalVadRuntimeOptions', () => {
  it('derives frame counts from silence and min-speech durations', () => {
    const options = computeLocalVadRuntimeOptions({
      silenceDurationMs: 500,
      minSpeechDurationMs: 600,
      vadFrameSamples: 512,
      vadPositiveSpeechThreshold: 0.5,
      vadNegativeSpeechThreshold: 0.35,
    });

    // 512 samples @ 16kHz = 32ms/frame
    expect(options.redemptionFrames).toBe(16);
    expect(options.minSpeechFrames).toBe(19);
    expect(options.preSpeechPadFrames).toBe(1);
  });

  it('clamps invalid thresholds and keeps negative <= positive', () => {
    const options = computeLocalVadRuntimeOptions({
      silenceDurationMs: 1000,
      minSpeechDurationMs: 300,
      vadFrameSamples: 1024,
      vadPositiveSpeechThreshold: 1.5,
      vadNegativeSpeechThreshold: 2,
    });

    expect(options.positiveSpeechThreshold).toBe(1);
    expect(options.negativeSpeechThreshold).toBe(1);
  });

  it('lowers the speech floor to the rescue threshold when short-command rescue is on', () => {
    const options = computeLocalVadRuntimeOptions({
      silenceDurationMs: 200,
      minSpeechDurationMs: 400,
      vadFrameSamples: 1536,
      vadPositiveSpeechThreshold: 0.3,
      vadNegativeSpeechThreshold: 0.15,
      shortCommandRescueEnabled: true,
      shortCommandMinDurationMs: 280,
    });

    // 1536 samples @ 16kHz = 96ms/frame; ceil(280/96) = 3 frames (288ms)
    // instead of ceil(400/96) = 5 frames (480ms).
    expect(options.minSpeechFrames).toBe(3);
  });

  it('keeps the configured floor when short-command rescue is off', () => {
    const options = computeLocalVadRuntimeOptions({
      silenceDurationMs: 200,
      minSpeechDurationMs: 400,
      vadFrameSamples: 1536,
      vadPositiveSpeechThreshold: 0.3,
      vadNegativeSpeechThreshold: 0.15,
      shortCommandRescueEnabled: false,
      shortCommandMinDurationMs: 280,
    });

    expect(options.minSpeechFrames).toBe(5);
  });

  it('never raises the floor when the rescue threshold exceeds min speech', () => {
    const options = computeLocalVadRuntimeOptions({
      silenceDurationMs: 200,
      minSpeechDurationMs: 250,
      vadFrameSamples: 1536,
      vadPositiveSpeechThreshold: 0.3,
      vadNegativeSpeechThreshold: 0.15,
      shortCommandRescueEnabled: true,
      shortCommandMinDurationMs: 280,
    });

    // min(250, 280) = 250 → ceil(250/96) = 3
    expect(options.minSpeechFrames).toBe(3);
  });

  it('ensures at least one frame for silence/min-speech', () => {
    const options = computeLocalVadRuntimeOptions({
      silenceDurationMs: 1,
      minSpeechDurationMs: 1,
      vadFrameSamples: 1536,
      vadPositiveSpeechThreshold: -1,
      vadNegativeSpeechThreshold: -2,
    });

    expect(options.positiveSpeechThreshold).toBe(0);
    expect(options.negativeSpeechThreshold).toBe(0);
    expect(options.redemptionFrames).toBe(1);
    expect(options.minSpeechFrames).toBe(1);
  });
});
