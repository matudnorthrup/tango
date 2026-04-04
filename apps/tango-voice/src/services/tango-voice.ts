import {
  requestVoiceTurn,
  type VoiceTurnInput as TangoVoiceTurnInput,
  type VoiceTurnResult as TangoVoiceTurnResult,
} from '@tango/voice';
import { config } from '../config.js';

export function shouldUseTangoVoiceBridge(): boolean {
  return config.tangoVoiceTurnUrl.trim().length > 0;
}

export async function requestTangoVoiceTurn(
  input: TangoVoiceTurnInput,
): Promise<TangoVoiceTurnResult> {
  return requestVoiceTurn(input, {
    endpoint: config.tangoVoiceTurnUrl,
    apiKey: config.tangoVoiceApiKey,
    timeoutMs: config.tangoVoiceTimeoutMs,
    maxRetries: config.tangoVoiceMaxRetries,
    onRetry: ({ attempt, maxRetries, delayMs, error }) => {
      console.warn(
        `Tango voice turn failed (attempt ${attempt}/${maxRetries + 1}): ${error.message} — retrying in ${delayMs}ms`,
      );
    },
  });
}
