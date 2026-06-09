import {
  buildDefaultSessionKey,
  buildDiscordChannelSessionKey,
  normalizeCompletionSessionKey,
  requestVoiceCompletion,
  sanitizeAssistantResponse,
} from '@tango/voice';
import { config } from '../config.js';
import { VOICE_SYSTEM_PROMPT } from '../prompts/voice-system.js';

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface GetResponseOptions {
  systemPrompt?: string;
  history?: Message[];
}

export interface GetResponseResult {
  response: string;
  history: Message[];
}

const MAX_HISTORY = 20;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1500;
const conversations = new Map<string, Message[]>();

// ---------------------------------------------------------------------------
// Model name mapping for Anthropic API
// ---------------------------------------------------------------------------

const MODEL_ALIASES: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-8',
};

function resolveModelId(shortName: string): string {
  return MODEL_ALIASES[shortName] ?? shortName;
}

// ---------------------------------------------------------------------------
// Direct Anthropic API path (fast, no CLI startup overhead)
// ---------------------------------------------------------------------------

async function requestAnthropicApi(params: {
  systemPrompt?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens: number;
  model: string;
  signal?: AbortSignal;
}): Promise<string> {
  const modelId = resolveModelId(params.model);
  const body: Record<string, unknown> = {
    model: modelId,
    max_tokens: params.maxTokens,
    messages: params.messages,
  };
  if (params.systemPrompt) {
    body.system = params.systemPrompt;
  }

  const init: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.anthropicApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  };
  if (params.signal) {
    init.signal = params.signal;
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', init);
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`Anthropic API ${response.status}: ${errorBody || response.statusText}`);
  }

  const result = await response.json() as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text = result.content
    ?.filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('') ?? '';
  return text;
}

/**
 * Whether the direct Anthropic API path is available for utility completions.
 */
function hasAnthropicApi(): boolean {
  return config.anthropicApiKey.trim().length > 0;
}

/**
 * Whether a fast Ollama-served classifier model is configured. Preferred over the
 * Anthropic path so utility classifiers don't bill Anthropic on every utterance.
 */
function hasOllamaClassifier(): boolean {
  return config.ollamaApiKey.trim().length > 0 && config.voiceClassifierModel.trim().length > 0;
}

async function requestOllamaApi(params: {
  systemPrompt?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens: number;
  model: string;
  signal?: AbortSignal;
}): Promise<string> {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  if (params.systemPrompt) {
    messages.push({ role: 'system', content: params.systemPrompt });
  }
  messages.push(...params.messages);

  const init: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.ollamaApiKey}`,
    },
    body: JSON.stringify({
      model: params.model,
      max_tokens: params.maxTokens,
      messages,
      stream: false,
    }),
  };
  if (params.signal) {
    init.signal = params.signal;
  }

  const response = await fetch(`${config.ollamaBaseUrl}/chat/completions`, init);
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`Ollama API ${response.status}: ${errorBody || response.statusText}`);
  }

  const result = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  let content = result.choices?.[0]?.message?.content ?? '';
  // Strip markdown code fences that small models sometimes wrap JSON in.
  content = content.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  return content;
}

// ---------------------------------------------------------------------------
// Tango bridge helpers
// ---------------------------------------------------------------------------

function hasTangoCompletionBridge(): boolean {
  return config.tangoVoiceCompletionUrl.trim().length > 0;
}

function resolveNormalizedSessionId(sessionId: string): string {
  return normalizeCompletionSessionKey(config.tangoVoiceAgentId, sessionId);
}

function resolveUtilitySessionId(): string {
  const channelId = config.utilityChannelId.trim();
  return channelId
    ? buildDiscordChannelSessionKey(config.tangoVoiceAgentId, channelId)
    : buildDefaultSessionKey(config.tangoVoiceAgentId);
}

async function fetchWithRetry(url: string, init: RequestInit, label: string, signal?: AbortSignal): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) break;
    try {
      const fetchInit = signal ? { ...init, signal } : init;
      return await fetch(url, fetchInit);
    } catch (err: any) {
      lastError = err;
      if (signal?.aborted) break;
      if (attempt < MAX_RETRIES) {
        console.warn(`${label} fetch failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${err.message} — retrying in ${RETRY_DELAY_MS}ms`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }
  throw lastError ?? new Error(`${label} failed before a response was received.`);
}

async function requestTangoCompletion(params: {
  messages: Message[];
  maxTokens: number;
  sessionId: string;
  label: string;
  signal?: AbortSignal;
  model?: string;
}): Promise<string> {
  const systemMessage = params.messages[0]?.role === 'system'
    ? params.messages[0]
    : null;
  const messages = systemMessage
    ? params.messages.slice(1)
    : params.messages;
  const result = await requestVoiceCompletion(
    {
      sessionId: params.sessionId,
      agentId: config.tangoVoiceAgentId,
      systemPrompt: systemMessage?.content,
      maxTokens: params.maxTokens,
      messages,
      model: params.model,
    },
    {
      endpoint: config.tangoVoiceCompletionUrl,
      apiKey: config.tangoVoiceApiKey || undefined,
      signal: params.signal,
    },
  );

  const provider = result.providerName ? ` via ${result.providerName}` : '';
  console.log(`${params.label}${provider}: completion returned ${result.text.length} chars`);
  return result.text;
}

async function requestCompletion(params: {
  messages: Message[];
  maxTokens: number;
  sessionId: string;
  label: string;
  signal?: AbortSignal;
  model?: string;
}): Promise<string> {
  if (hasTangoCompletionBridge()) {
    return requestTangoCompletion(params);
  }

  throw new Error('No Tango completion bridge is configured.');
}

export async function getResponse(
  userId: string,
  text: string,
  options?: GetResponseOptions,
): Promise<GetResponseResult> {
  const start = Date.now();
  const normalizedUserId = resolveNormalizedSessionId(userId);
  if (normalizedUserId !== userId) {
    console.warn(`Normalized completion user "${userId}" -> "${normalizedUserId}"`);
  }

  const systemPrompt = options?.systemPrompt ?? VOICE_SYSTEM_PROMPT;
  const externalHistory = options?.history !== undefined;

  let history = externalHistory ? options!.history! : (conversations.get(normalizedUserId) || []);
  history.push({ role: 'user', content: text });

  if (history.length > MAX_HISTORY) {
    history = history.slice(-MAX_HISTORY);
  }

  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    ...history,
  ];

  const rawText = await requestCompletion({
    messages,
    maxTokens: 300,
    sessionId: normalizedUserId,
    label: 'Voice completion',
  });

  const assistantText = sanitizeAssistantPayload(rawText);

  history.push({ role: 'assistant', content: assistantText });

  if (!externalHistory) {
    conversations.set(normalizedUserId, history);
  }

  const elapsed = Date.now() - start;
  console.log(`Voice completion: "${assistantText.slice(0, 80)}..." (${elapsed}ms)`);

  return { response: assistantText, history };
}

/**
 * Fast utility completion. When an Anthropic API key is configured and a model
 * is specified, calls the Anthropic Messages API directly — bypassing the Tango
 * bridge and Claude CLI startup overhead. Falls back to the bridge otherwise.
 */
export async function quickCompletion(systemPrompt: string, userMessage: string, maxTokens = 50, signal?: AbortSignal, model?: string, assistantPrefill?: string): Promise<string> {
  const start = Date.now();

  // Preferred path: a fast Ollama-served classifier model (off Anthropic, no API
  // cost). Applies to model-tagged utility completions (route/command/inbox
  // classifiers). The no-model summary/matcher calls still use the bridge below.
  if (model && hasOllamaClassifier()) {
    // Note: unlike Anthropic, the Ollama OpenAI endpoint rejects a trailing
    // assistant "prefill" message, and these small models return clean JSON
    // without it. Send only the user turn; prepend the prefill to the result
    // below if the model omitted it.
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: userMessage },
    ];
    const result = await requestOllamaApi({
      systemPrompt,
      messages,
      maxTokens,
      model: config.voiceClassifierModel,
      signal,
    });
    const finalResult =
      assistantPrefill && !result.trimStart().startsWith(assistantPrefill)
        ? assistantPrefill + result
        : result;
    const elapsed = Date.now() - start;
    console.log(`Quick completion via Ollama/${config.voiceClassifierModel} (${elapsed}ms): "${finalResult}"`);
    return finalResult.trim();
  }

  // Fast path: direct Anthropic API (sub-second vs 5-7s through CLI)
  if (model && hasAnthropicApi()) {
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: userMessage },
    ];
    if (assistantPrefill) {
      messages.push({ role: 'assistant', content: assistantPrefill });
    }
    const result = await requestAnthropicApi({
      systemPrompt,
      messages,
      maxTokens,
      model,
      signal,
    });
    const finalResult = assistantPrefill ? assistantPrefill + result : result;
    const elapsed = Date.now() - start;
    console.log(`Quick completion via API/${model} (${elapsed}ms): "${finalResult}"`);
    return finalResult.trim();
  }

  // Slow path: through Tango bridge → Claude CLI
  const result = await requestCompletion({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    maxTokens,
    sessionId: resolveUtilitySessionId(),
    label: 'Quick completion',
    signal,
    model,
  });

  const elapsed = Date.now() - start;
  console.log(`Quick completion (${elapsed}ms): "${result}"`);

  return result.trim();
}

export function clearConversation(userId: string): void {
  const normalizedUserId = resolveNormalizedSessionId(userId);
  conversations.delete(normalizedUserId);
  console.log(`Cleared conversation for ${normalizedUserId}`);
}

function sanitizeAssistantPayload(text: string): string {
  const cleaned = sanitizeAssistantResponse(text);
  if (cleaned !== text.trim()) {
    console.warn(`Sanitized assistant payload (removed ${Math.max(0, text.trim().length - cleaned.length)} chars)`);
  }
  return cleaned;
}
