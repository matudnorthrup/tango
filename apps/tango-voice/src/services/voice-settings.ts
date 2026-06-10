import fs from 'node:fs';
import path from 'node:path';

export type AudioProcessingMode = 'discord' | 'local';
export type EndpointingMode = 'silence' | 'indicate';
export type VadFrameSamples = 512 | 1024 | 1536;

export type IndicateCloseType = 'conversational' | 'dismiss';

export interface VoiceSettingsValues {
  silenceDurationMs: number;
  speechThreshold: number;
  minSpeechDurationMs: number;
  gated: boolean;
  audioProcessing: AudioProcessingMode;
  endpointingMode: EndpointingMode;
  indicateCloseWords: string[];
  indicateDismissWords: string[];
  indicateTimeoutMs: number;
  sttStreamingEnabled: boolean;
  sttStreamingChunkMs: number;
  sttStreamingMinChunkMs: number;
  sttStreamingOverlapMs: number;
  sttStreamingMaxChunks: number;
  sttCommandTailProbeEnabled: boolean;
  sttCommandTailMs: number;
  sttCommandTailMinDurationMs: number;
  vadPositiveSpeechThreshold: number;
  vadNegativeSpeechThreshold: number;
  vadFrameSamples: VadFrameSamples;
  localStreamIdleMs: number;
  shortCommandRescueEnabled: boolean;
  shortCommandMinDurationMs: number;
}

const NOISE_PRESETS: Record<string, number> = {
  low: 300,
  medium: 500,
  high: 800,
};

const settings: VoiceSettingsValues = {
  silenceDurationMs: 500,
  speechThreshold: 500,
  minSpeechDurationMs: 600,
  gated: true,
  audioProcessing: 'discord',
  endpointingMode: 'indicate',
  indicateCloseWords: ['go ahead', "i'm done", "i'm finished"],
  indicateDismissWords: ['thanks', 'thank you', 'delta tango', "that's all", "thats all", "that'll do"],
  indicateTimeoutMs: 20000,
  sttStreamingEnabled: false,
  sttStreamingChunkMs: 900,
  sttStreamingMinChunkMs: 450,
  sttStreamingOverlapMs: 180,
  sttStreamingMaxChunks: 8,
  sttCommandTailProbeEnabled: true,
  sttCommandTailMs: 2200,
  sttCommandTailMinDurationMs: 1200,
  vadPositiveSpeechThreshold: 0.5,
  vadNegativeSpeechThreshold: 0.35,
  vadFrameSamples: 512,
  localStreamIdleMs: 4000,
  shortCommandRescueEnabled: true,
  shortCommandMinDurationMs: 280,
};

let initialized = false;

export function initVoiceSettings(values: Partial<VoiceSettingsValues>): void {
  if (values.silenceDurationMs !== undefined) settings.silenceDurationMs = values.silenceDurationMs;
  if (values.speechThreshold !== undefined) settings.speechThreshold = values.speechThreshold;
  if (values.minSpeechDurationMs !== undefined) settings.minSpeechDurationMs = values.minSpeechDurationMs;
  if (values.gated !== undefined) settings.gated = values.gated;
  if (values.audioProcessing !== undefined) settings.audioProcessing = values.audioProcessing;
  if (values.endpointingMode !== undefined) settings.endpointingMode = values.endpointingMode;
  if (values.indicateCloseWords !== undefined) settings.indicateCloseWords = values.indicateCloseWords;
  if (values.indicateDismissWords !== undefined) settings.indicateDismissWords = values.indicateDismissWords;
  if (values.indicateTimeoutMs !== undefined) settings.indicateTimeoutMs = values.indicateTimeoutMs;
  if (values.sttStreamingEnabled !== undefined) settings.sttStreamingEnabled = values.sttStreamingEnabled;
  if (values.sttStreamingChunkMs !== undefined) settings.sttStreamingChunkMs = Math.max(250, values.sttStreamingChunkMs);
  if (values.sttStreamingMinChunkMs !== undefined) settings.sttStreamingMinChunkMs = Math.max(200, values.sttStreamingMinChunkMs);
  if (values.sttStreamingOverlapMs !== undefined) settings.sttStreamingOverlapMs = Math.max(0, values.sttStreamingOverlapMs);
  if (values.sttStreamingMaxChunks !== undefined) settings.sttStreamingMaxChunks = Math.max(1, values.sttStreamingMaxChunks);
  if (values.sttCommandTailProbeEnabled !== undefined) settings.sttCommandTailProbeEnabled = values.sttCommandTailProbeEnabled;
  if (values.sttCommandTailMs !== undefined) settings.sttCommandTailMs = Math.max(750, values.sttCommandTailMs);
  if (values.sttCommandTailMinDurationMs !== undefined) settings.sttCommandTailMinDurationMs = Math.max(500, values.sttCommandTailMinDurationMs);
  if (values.vadPositiveSpeechThreshold !== undefined) settings.vadPositiveSpeechThreshold = values.vadPositiveSpeechThreshold;
  if (values.vadNegativeSpeechThreshold !== undefined) settings.vadNegativeSpeechThreshold = values.vadNegativeSpeechThreshold;
  if (values.vadFrameSamples !== undefined) settings.vadFrameSamples = values.vadFrameSamples;
  if (values.localStreamIdleMs !== undefined) settings.localStreamIdleMs = values.localStreamIdleMs;
  if (values.shortCommandRescueEnabled !== undefined) settings.shortCommandRescueEnabled = values.shortCommandRescueEnabled;
  if (values.shortCommandMinDurationMs !== undefined) settings.shortCommandMinDurationMs = Math.max(200, values.shortCommandMinDurationMs);
  initialized = true;
}

export function getVoiceSettings(): Readonly<VoiceSettingsValues> {
  return settings;
}

// --- Persistence -----------------------------------------------------------
// Runtime tuning (Discord settings UI, voice commands) is recorded as a sparse
// overlay and written to disk, then re-applied over env/config at boot. Only
// keys explicitly changed through setters persist; delete the overlay file to
// fall back to .env values.

let persistFilePath: string | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
const overlay: Partial<VoiceSettingsValues> = {};

function recordOverlay(...keys: (keyof VoiceSettingsValues)[]): void {
  for (const key of keys) {
    (overlay as Record<string, unknown>)[key] = settings[key];
  }
  schedulePersist();
}

function schedulePersist(): void {
  if (!persistFilePath) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistVoiceSettingsNow();
  }, 500);
}

export function persistVoiceSettingsNow(): void {
  if (!persistFilePath) return;
  try {
    fs.mkdirSync(path.dirname(persistFilePath), { recursive: true });
    fs.writeFileSync(persistFilePath, `${JSON.stringify(overlay, null, 2)}\n`);
  } catch (err: any) {
    console.warn(`Voice settings persist failed: ${err?.message ?? err}`);
  }
}

export function enableVoiceSettingsPersistence(filePath: string): void {
  persistFilePath = filePath;
  if (!fs.existsSync(filePath)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    const subset: Partial<VoiceSettingsValues> = {};
    const knownKeys = Object.keys(settings) as (keyof VoiceSettingsValues)[];
    for (const key of knownKeys) {
      if (!(key in raw)) continue;
      const value = raw[key];
      const expected = settings[key];
      if (Array.isArray(expected) ? !Array.isArray(value) : typeof value !== typeof expected) continue;
      if (key === 'vadFrameSamples' && ![512, 1024, 1536].includes(value as number)) continue;
      (subset as Record<string, unknown>)[key] = value;
      (overlay as Record<string, unknown>)[key] = value;
    }
    const applied = Object.keys(subset);
    if (applied.length > 0) {
      initVoiceSettings(subset);
      console.log(`Voice settings overlay applied (${applied.join(', ')}) from ${filePath}`);
    }
  } catch (err: any) {
    console.warn(`Voice settings overlay load failed (${filePath}): ${err?.message ?? err}`);
  }
}

export function resetVoiceSettingsPersistenceForTest(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  persistFilePath = null;
  for (const key of Object.keys(overlay)) {
    delete (overlay as Record<string, unknown>)[key];
  }
}
// ---------------------------------------------------------------------------

export function setSilenceDuration(ms: number): void {
  settings.silenceDurationMs = ms;
  recordOverlay('silenceDurationMs');
}

export function setSpeechThreshold(value: number): void {
  settings.speechThreshold = value;
  recordOverlay('speechThreshold');
}

export function setMinSpeechDuration(ms: number): void {
  settings.minSpeechDurationMs = ms;
  recordOverlay('minSpeechDurationMs');
}

export function setGatedMode(on: boolean): void {
  settings.gated = on;
  recordOverlay('gated');
}

export function setAudioProcessingMode(mode: AudioProcessingMode): void {
  settings.audioProcessing = mode;
  recordOverlay('audioProcessing');
}

export function setEndpointingMode(mode: EndpointingMode): void {
  settings.endpointingMode = mode;
  recordOverlay('endpointingMode');
}

export function setIndicateCloseWords(words: string[]): void {
  settings.indicateCloseWords = words
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
  recordOverlay('indicateCloseWords');
}

export function setIndicateTimeoutMs(ms: number): void {
  settings.indicateTimeoutMs = Math.max(1000, ms);
  recordOverlay('indicateTimeoutMs');
}

export function setSttStreamingEnabled(enabled: boolean): void {
  settings.sttStreamingEnabled = enabled;
  recordOverlay('sttStreamingEnabled');
}

export function setSttStreamingChunkMs(ms: number): void {
  settings.sttStreamingChunkMs = Math.max(250, ms);
  recordOverlay('sttStreamingChunkMs');
}

export function setSttStreamingMinChunkMs(ms: number): void {
  settings.sttStreamingMinChunkMs = Math.max(200, ms);
  recordOverlay('sttStreamingMinChunkMs');
}

export function setSttStreamingOverlapMs(ms: number): void {
  settings.sttStreamingOverlapMs = Math.max(0, ms);
  recordOverlay('sttStreamingOverlapMs');
}

export function setSttStreamingMaxChunks(maxChunks: number): void {
  settings.sttStreamingMaxChunks = Math.max(1, Math.floor(maxChunks));
  recordOverlay('sttStreamingMaxChunks');
}

export function setSttCommandTailProbeEnabled(enabled: boolean): void {
  settings.sttCommandTailProbeEnabled = enabled;
  recordOverlay('sttCommandTailProbeEnabled');
}

export function setSttCommandTailMs(ms: number): void {
  settings.sttCommandTailMs = Math.max(750, ms);
  recordOverlay('sttCommandTailMs');
}

export function setSttCommandTailMinDurationMs(ms: number): void {
  settings.sttCommandTailMinDurationMs = Math.max(500, ms);
  recordOverlay('sttCommandTailMinDurationMs');
}

export function setLocalVadThresholds(positive: number, negative: number): void {
  settings.vadPositiveSpeechThreshold = positive;
  settings.vadNegativeSpeechThreshold = negative;
  recordOverlay('vadPositiveSpeechThreshold', 'vadNegativeSpeechThreshold');
}

export function setLocalVadFrameSamples(samples: VadFrameSamples): void {
  settings.vadFrameSamples = samples;
  recordOverlay('vadFrameSamples');
}

export function setLocalStreamIdleMs(ms: number): void {
  settings.localStreamIdleMs = ms;
  recordOverlay('localStreamIdleMs');
}

export function setShortCommandRescueEnabled(enabled: boolean): void {
  settings.shortCommandRescueEnabled = enabled;
  recordOverlay('shortCommandRescueEnabled');
}

export function setShortCommandMinDurationMs(ms: number): void {
  settings.shortCommandMinDurationMs = Math.max(200, ms);
  recordOverlay('shortCommandMinDurationMs');
}

export function resolveNoiseLevel(input: string): { threshold: number; label: string } | null {
  const preset = NOISE_PRESETS[input.toLowerCase()];
  if (preset !== undefined) {
    return { threshold: preset, label: input.toLowerCase() };
  }

  const numeric = parseInt(input, 10);
  if (!isNaN(numeric) && numeric > 0) {
    return { threshold: numeric, label: String(numeric) };
  }

  return null;
}

export function getNoisePresetNames(): string[] {
  return Object.keys(NOISE_PRESETS);
}
