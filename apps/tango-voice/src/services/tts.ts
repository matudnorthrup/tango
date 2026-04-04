import { Readable } from 'node:stream';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';

type TtsBackend = 'kokoro' | 'chatterbox' | 'elevenlabs';
interface TtsRequest {
  text: string;
  kokoroVoice?: string | null;
}

export interface TextToSpeechOptions {
  kokoroVoice?: string | null;
}

const validTtsBackends: ReadonlyArray<TtsBackend> = ['kokoro', 'chatterbox', 'elevenlabs'];
let primaryBackendUnavailableUntil = 0;
let runtimeBackendOverride: TtsBackend | null = null;
const execAsync = promisify(execCb);
const restartCooldownUntil: Partial<Record<TtsBackend, number>> = {};

export function getTtsBackend(): TtsBackend {
  return runtimeBackendOverride ?? (parseBackend(config.ttsBackend) || 'elevenlabs');
}

export function setTtsBackend(backend: TtsBackend): void {
  runtimeBackendOverride = backend;
  primaryBackendUnavailableUntil = 0; // reset failover state
}

export function getAvailableTtsBackends(): TtsBackend[] {
  const available: TtsBackend[] = [];
  if (config.elevenLabsApiKey) available.push('elevenlabs');
  if (config.kokoroUrl) available.push('kokoro');
  if (config.chatterboxUrl) available.push('chatterbox');
  return available.length > 0 ? available : ['elevenlabs'];
}
const failureSignatures = new Map<string, { count: number; firstAt: number; lastAt: number }>();

async function ttsElevenLabs(request: TtsRequest): Promise<Readable> {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${config.elevenLabsVoiceId}/stream`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': config.elevenLabsApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: request.text,
        model_id: 'eleven_multilingual_v2',
        output_format: 'mp3_44100_128',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ElevenLabs API error ${response.status}: ${body}`);
  }

  if (!response.body) {
    throw new Error('ElevenLabs returned no body');
  }

  return Readable.fromWeb(response.body as any);
}

async function ttsKokoro(request: TtsRequest): Promise<Readable> {
  const voice = request.kokoroVoice?.trim() || config.kokoroVoice;
  const response = await fetch(
    `${config.kokoroUrl}/v1/audio/speech`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: request.text,
        voice,
        response_format: 'wav',
        stream: true,
        speed: 1.0,
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Kokoro API error ${response.status}: ${body}`);
  }

  if (!response.body) {
    throw new Error('Kokoro returned no body');
  }

  return Readable.fromWeb(response.body as any);
}

async function ttsChatterbox(request: TtsRequest): Promise<Readable> {
  const response = await fetch(
    `${config.chatterboxUrl}/v1/audio/speech`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: request.text,
        voice: config.chatterboxVoice,
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Chatterbox API error ${response.status}: ${body}`);
  }

  if (!response.body) {
    throw new Error('Chatterbox returned no body');
  }

  return Readable.fromWeb(response.body as any);
}

const backends: Record<TtsBackend, (request: TtsRequest) => Promise<Readable>> = {
  kokoro: ttsKokoro,
  chatterbox: ttsChatterbox,
  elevenlabs: ttsElevenLabs,
};

function parseBackend(raw: string): TtsBackend | null {
  const value = raw.trim().toLowerCase();
  if ((validTtsBackends as readonly string[]).includes(value)) {
    return value as TtsBackend;
  }
  return null;
}

function memorySnapshot(): string {
  const m = process.memoryUsage();
  const rssMb = (m.rss / (1024 * 1024)).toFixed(1);
  const heapUsedMb = (m.heapUsed / (1024 * 1024)).toFixed(1);
  const extMb = (m.external / (1024 * 1024)).toFixed(1);
  return `rssMb=${rssMb} heapUsedMb=${heapUsedMb} externalMb=${extMb}`;
}

function errorSignature(backend: TtsBackend, err: any): string {
  const msg = `${err?.message ?? ''} ${err?.cause?.code ?? ''} ${err?.cause?.message ?? ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (!msg) return `${backend}:unknown`;
  const normalized = msg.length > 200 ? msg.slice(0, 200) : msg;
  return `${backend}:${normalized}`;
}

function logFailure(backend: TtsBackend, request: TtsRequest, err: any): void {
  const signature = errorSignature(backend, err);
  const now = Date.now();
  const prev = failureSignatures.get(signature);
  const next = prev
    ? { count: prev.count + 1, firstAt: prev.firstAt, lastAt: now }
    : { count: 1, firstAt: now, lastAt: now };
  failureSignatures.set(signature, next);

  const windowSec = ((next.lastAt - next.firstAt) / 1000).toFixed(1);
  const msg = err?.message ?? String(err);
  const voiceInfo =
    backend === 'kokoro'
      ? ` voice=${JSON.stringify(request.kokoroVoice?.trim() || config.kokoroVoice)}`
      : '';
  console.warn(
    `TTS failure backend=${backend}${voiceInfo} signature="${signature}" count=${next.count} windowSec=${windowSec} textLen=${request.text.length} ${memorySnapshot()} msg="${msg}"`,
  );
}

function getRestartCommand(backend: TtsBackend): string {
  if (backend === 'kokoro') return config.kokoroRestartCommand;
  if (backend === 'chatterbox') return config.chatterboxRestartCommand;
  return '';
}

function isRecoverableLocalBackendFailure(backend: TtsBackend, err: any): boolean {
  if (backend !== 'kokoro' && backend !== 'chatterbox') return false;
  const text = `${err?.message ?? ''} ${err?.cause?.code ?? ''} ${err?.cause?.message ?? ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return false;
  return text.includes('econnrefused')
    || text.includes('fetch failed')
    || text.includes('terminated')
    || text.includes('socket')
    || text.includes('other side closed');
}

async function maybeRestartBackend(backend: TtsBackend, err: any): Promise<boolean> {
  if (!isRecoverableLocalBackendFailure(backend, err)) return false;
  const restartCommand = getRestartCommand(backend);
  if (!restartCommand) return false;

  const now = Date.now();
  if (now < (restartCooldownUntil[backend] ?? 0)) return false;
  restartCooldownUntil[backend] = now + 30_000;

  try {
    console.warn(`TTS recovery: restarting ${backend} with ${JSON.stringify(restartCommand)}`);
    await execAsync(restartCommand, { timeout: 20_000, shell: '/bin/zsh' });
    return true;
  } catch (restartErr: any) {
    console.warn(`TTS recovery: restart failed for ${backend}: ${restartErr?.message ?? restartErr}`);
    return false;
  }
}

async function synthesize(
  backend: TtsBackend,
  request: TtsRequest,
): Promise<{ stream: Readable; backend: TtsBackend }> {
  const fn = backends[backend];
  if (!fn) {
    throw new Error(`Unknown TTS backend: ${backend}. Use: ${Object.keys(backends).join(', ')}`);
  }
  const start = Date.now();
  const stream = await fn(request);
  const elapsed = Date.now() - start;
  const voiceInfo =
    backend === 'kokoro'
      ? ` voice=${JSON.stringify(request.kokoroVoice?.trim() || config.kokoroVoice)}`
      : '';
  console.log(`TTS [${backend}]${voiceInfo}: first byte in ${elapsed}ms`);
  return { stream, backend };
}

export async function textToSpeechStream(text: string, options: TextToSpeechOptions = {}): Promise<Readable> {
  const request: TtsRequest = {
    text,
    kokoroVoice: options.kokoroVoice?.trim() || undefined,
  };
  const primary = runtimeBackendOverride ?? parseBackend(config.ttsBackend);
  if (!primary) {
    throw new Error(`Unknown TTS backend: ${config.ttsBackend}. Use: ${Object.keys(backends).join(', ')}`);
  }
  const fallback = parseBackend(config.ttsFallbackBackend);
  const useFallbackFirst =
    !!fallback &&
    fallback !== primary &&
    Date.now() < primaryBackendUnavailableUntil;

  const order: TtsBackend[] = useFallbackFirst
    ? [fallback!, primary]
    : fallback && fallback !== primary
      ? [primary, fallback]
      : [primary];

  let lastError: any = null;
  for (let i = 0; i < order.length; i++) {
    const backend = order[i];
    try {
      const out = await synthesize(backend, request);
      if (backend !== primary) {
        console.warn(`TTS fallback active: ${primary} -> ${backend}`);
      } else if (Date.now() >= primaryBackendUnavailableUntil && primaryBackendUnavailableUntil > 0) {
        console.log(`TTS primary recovered: ${primary}`);
      }
      if (backend === primary) {
        primaryBackendUnavailableUntil = 0;
      }
      return out.stream;
    } catch (err: any) {
      lastError = err;
      logFailure(backend, request, err);
      const restarted = await maybeRestartBackend(backend, err);
      if (restarted) {
        try {
          console.warn(`TTS recovery: retrying ${backend} after restart`);
          const recovered = await synthesize(backend, request);
          if (backend === primary) {
            primaryBackendUnavailableUntil = 0;
          }
          return recovered.stream;
        } catch (retryErr: any) {
          lastError = retryErr;
          logFailure(backend, request, retryErr);
          err = retryErr;
        }
      }
      if (backend === primary && order.length > 1) {
        primaryBackendUnavailableUntil = Date.now() + Math.max(3_000, config.ttsPrimaryRetryMs);
      }
      if (i < order.length - 1) {
        const next = order[i + 1];
        console.warn(`TTS failover attempt: ${backend} -> ${next}`);
      }
    }
  }

  throw lastError ?? new Error('TTS failed with unknown error');
}
