import type { ChatProvider, ProviderRequest, ProviderResponse } from "@tango/core";

const CLAUDE_FAST_FAIL_WINDOW_MS = 15_000;
const CLAUDE_CIRCUIT_OPEN_MS = 2 * 60 * 1000;

interface ProviderCircuitState {
  openUntilMs: number;
  lastError: string;
}

const providerCircuitByName = new Map<string, ProviderCircuitState>();

export class ProviderRetryError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly attemptErrors: string[]
  ) {
    super(message);
    this.name = "ProviderRetryError";
  }
}

export interface ProviderFailoverFailure {
  providerName: string;
  attempts: number;
  attemptErrors: string[];
  lastError: string;
}

export interface ProviderRequestAttempt {
  providerName: string;
  providerSessionId: string | null;
  warmStartUsed: boolean;
  promptText: string;
}

export class ProviderFailoverError extends Error {
  constructor(
    message: string,
    readonly failures: ProviderFailoverFailure[],
    readonly attemptedRequests: ProviderRequestAttempt[]
  ) {
    super(message);
    this.name = "ProviderFailoverError";
  }

  get totalAttempts(): number {
    return this.failures.reduce((sum, failure) => sum + failure.attempts, 0);
  }
}

export interface ProviderFailoverOptions {
  warmStartPrompt?: string;
}

export type ProviderContinuityMap = Record<string, string>;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getProviderCircuitState(providerName: string, nowMs: number): ProviderCircuitState | null {
  const state = providerCircuitByName.get(providerName);
  if (!state) {
    return null;
  }
  if (state.openUntilMs <= nowMs) {
    providerCircuitByName.delete(providerName);
    return null;
  }
  return state;
}

function clearProviderCircuit(providerName: string): void {
  providerCircuitByName.delete(providerName);
}

function shouldOpenClaudeCircuit(providerName: string, errorMessage: string, durationMs: number): boolean {
  if (!providerName.startsWith("claude")) {
    return false;
  }
  if (
    /Claude CLI request failed: (?:Claude CLI returned an empty response|Failed to parse Claude CLI JSON output|Claude CLI returned an error result)/u.test(errorMessage)
  ) {
    return true;
  }
  if (durationMs > CLAUDE_FAST_FAIL_WINDOW_MS) {
    return false;
  }
  if (/timedOut=true|bufferOverflow=true/u.test(errorMessage)) {
    return false;
  }
  return /Claude CLI request failed: .*code=1\b/u.test(errorMessage);
}

function openProviderCircuit(providerName: string, errorMessage: string, nowMs: number): void {
  providerCircuitByName.set(providerName, {
    openUntilMs: nowMs + CLAUDE_CIRCUIT_OPEN_MS,
    lastError: errorMessage,
  });
}

function buildOpenCircuitMessage(providerName: string, state: ProviderCircuitState, nowMs: number): string {
  const remainingMs = Math.max(0, state.openUntilMs - nowMs);
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  return `circuit-open ${providerName} ${remainingSeconds}s remaining after recent hard failure: ${state.lastError}`;
}

export function resetProviderCircuitStateForTests(): void {
  providerCircuitByName.clear();
}

export async function generateWithRetry(
  providerName: string,
  provider: ChatProvider,
  request: ProviderRequest,
  retryLimit: number
): Promise<{ response: ProviderResponse; attempts: number; attemptErrors: string[] }> {
  const attemptErrors: string[] = [];
  let attempts = 0;

  for (let attempt = 1; attempt <= retryLimit + 1; attempt += 1) {
    attempts = attempt;
    const attemptStartedAt = Date.now();
    try {
      const response = await provider.generate(request);
      clearProviderCircuit(providerName);
      return { response, attempts, attemptErrors };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attemptErrors.push(message);
      const durationMs = Date.now() - attemptStartedAt;

      if (shouldOpenClaudeCircuit(providerName, message, durationMs)) {
        // Allow at least one retry before opening the circuit — transient
        // failures (e.g. a single empty response) should not immediately
        // block the provider for 2 minutes.
        if (attempt <= retryLimit) {
          await wait(Math.min(250 * attempt, 750));
          continue;
        }
        openProviderCircuit(providerName, message, Date.now());
        throw new ProviderRetryError(message, attempts, attemptErrors);
      }

      if (attempt <= retryLimit) {
        await wait(Math.min(250 * attempt, 750));
        continue;
      }

      throw new ProviderRetryError(message, attempts, attemptErrors);
    }
  }

  throw new ProviderRetryError("Provider request failed", attempts, attemptErrors);
}

export async function generateWithFailover(
  providerChain: Array<{ providerName: string; provider: ChatProvider }>,
  request: Omit<ProviderRequest, "providerSessionId">,
  retryLimit: number,
  persistedSessionsByProvider: ProviderContinuityMap = {},
  options: ProviderFailoverOptions = {}
): Promise<{
  providerName: string;
  retryResult: { response: ProviderResponse; attempts: number; attemptErrors: string[] };
  failures: ProviderFailoverFailure[];
  usedFailover: boolean;
  warmStartUsed: boolean;
  requestPrompt: string;
}> {
  const failures: ProviderFailoverFailure[] = [];
  const attemptedRequests: ProviderRequestAttempt[] = [];
  const warmStartPrompt = options.warmStartPrompt?.trim();

  for (const [index, candidate] of providerChain.entries()) {
    const providerSessionId = persistedSessionsByProvider[candidate.providerName];

    const shouldWarmStart =
      !!warmStartPrompt &&
      warmStartPrompt.length > 0 &&
      !providerSessionId;

    const candidatePrompt = shouldWarmStart
      ? `${warmStartPrompt}\n\nCurrent user message:\n${request.prompt}`
      : request.prompt;
    const attemptedRequest: ProviderRequestAttempt = {
      providerName: candidate.providerName,
      providerSessionId: providerSessionId ?? null,
      warmStartUsed: shouldWarmStart,
      promptText: candidatePrompt,
    };

    const nowMs = Date.now();
    const circuitState = getProviderCircuitState(candidate.providerName, nowMs);
    if (circuitState) {
      const message = buildOpenCircuitMessage(candidate.providerName, circuitState, nowMs);
      attemptedRequests.push(attemptedRequest);
      failures.push({
        providerName: candidate.providerName,
        attempts: 0,
        attemptErrors: [message],
        lastError: message,
      });
      continue;
    }

    try {
      const retryResult = await generateWithRetry(
        candidate.providerName,
        candidate.provider,
        {
          ...request,
          prompt: candidatePrompt,
          providerSessionId
        },
        retryLimit
      );

      return {
        providerName: candidate.providerName,
        retryResult,
        failures,
        usedFailover: index > 0,
        warmStartUsed: shouldWarmStart,
        requestPrompt: candidatePrompt,
      };
    } catch (error) {
      attemptedRequests.push(attemptedRequest);
      const message = error instanceof Error ? error.message : String(error);
      const retryError = error instanceof ProviderRetryError ? error : null;
      const attemptErrors = retryError?.attemptErrors ?? [message];
      failures.push({
        providerName: candidate.providerName,
        attempts: retryError?.attempts ?? 1,
        attemptErrors,
        lastError: message
      });
    }
  }

  const summary = failures.map((failure) => `${failure.providerName}:${failure.lastError}`).join(" | ");
  throw new ProviderFailoverError(`All providers failed: ${summary}`, failures, attemptedRequests);
}
