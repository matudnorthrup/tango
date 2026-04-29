import {
  appendProjectContextToSystemPrompt,
  appendTopicContextToSystemPrompt,
  buildProjectSessionId,
  coerceSpokenText,
  extractChannelIdFromSessionKey as extractDiscordChannelIdFromSessionKey,
  extractInlineTopicReference,
  formatCurrentTopicMessage,
  formatOpenedTopicMessage,
  sanitizeAssistantResponse,
  type VoiceAddressAgent,
} from '@tango/voice';
import { VoiceConnection } from '@discordjs/voice';
import { TextChannel } from 'discord.js';
import { AudioReceiver } from '../discord/audio-receiver.js';
import { DiscordAudioPlayer } from '../discord/audio-player.js';
import { transcribe, type StreamingPartialEvent } from '../services/whisper.js';
import { getResponse, quickCompletion, type Message } from '../services/claude.js';
import { textToSpeechStream } from '../services/tts.js';
import { SessionTranscript } from '../services/session-transcript.js';
import { config } from '../config.js';
import { requestTangoVoiceTurn, shouldUseTangoVoiceBridge } from '../services/tango-voice.js';
import { parseVoiceCommand, matchesWakeWord, mentionsWakeName, extractFromWakeWord, matchChannelSelection, matchQueueChoice, matchSwitchChoice, matchYesNo, type VoiceCommand, type ChannelOption } from '../services/voice-commands.js';
import { getVoiceSettings, setSilenceDuration, setSpeechThreshold, setGatedMode, setEndpointingMode, setIndicateTimeoutMs, resolveNoiseLevel, getNoisePresetNames, type EndpointingMode, type IndicateCloseType } from '../services/voice-settings.js';
import { getDefaultVoiceTargetDirectory, getPreferredSystemWakeName, type ResolvedVoiceAddress, type VoiceTargetDirectory } from '../services/voice-targets.js';
import { PipelineStateMachine, type TransitionEffect, type PipelineEvent } from './pipeline-state.js';
import { checkPipelineInvariants, type InvariantContext } from './pipeline-invariants.js';
import { createTransientContext, resetTransientContext, type TransientContext } from './transient-context.js';
import { createHealthCounters, type HealthCounters, type HealthSnapshot } from '../services/health-snapshot.js';
import { initEarcons, type EarconName } from '../audio/earcons.js';
import type { ChannelRouter } from '../services/channel-router.js';
import { getVoiceModeLabel, normalizeVoiceMode, type QueueState, type QueuedResponse, type VoiceMode } from '../services/queue-state.js';
import type { InboxClient } from '../services/inbox-client.js';
import type { VoiceInboxChannel, VoiceInboxMessage, VoiceInboxAgentGroup, VoiceInboxAgentResponse } from '@tango/voice';
import { generateAgentSummary, classifyTopicSelection, getInboxChannelVoiceLabel } from '../services/inbox-summary.js';
import type { InboxAgentItem, AwaitingRouteConfirmationState } from './pipeline-state.js';
import { VoiceTopicManager } from '../services/voice-topics.js';
import { VoiceProjectManager } from '../services/voice-projects.js';
import { inferRouteTarget, isHighCreateConfidence, isMediumCreateConfidence, invalidateRouteTargetCache, type RouteClassifierResult } from '../services/route-classifier.js';

type ChannelActivity = {
  channelName: string;
  displayName: string;
  sessionKey: string;
  newMessageCount: number;
  queuedReadyCount: number;
  newMessages: Array<{ content: unknown }>;
  earliestTimestamp: number;
};

type IdleNotificationKind = 'generic' | 'response-ready' | 'text-activity';
type NotificationTier = 'ambient' | 'nudge' | 'tap' | 'interrupt';

interface IdleNotificationOptions {
  kind?: IdleNotificationKind;
  sessionKey?: string;
  stamp?: number;
  dedupeKey?: string;
  speakerAgentId?: string | null;
  tier?: NotificationTier;
  agentDisplayName?: string | null;
}

interface QueuedIdleNotification {
  key: string;
  message: string;
  kind: IdleNotificationKind;
  sessionKey: string | null;
  stamp: number | null;
  retries: number;
  speakerAgentId: string | null;
  tier: NotificationTier;
  agentDisplayName: string | null;
}

type IdleNotificationStage = 'enqueued' | 'deduped' | 'deferred' | 'dropped' | 'delivered';

export interface IdleNotificationEvent {
  at: number;
  stage: IdleNotificationStage;
  kind: IdleNotificationKind;
  key: string;
  sessionKey: string | null;
  reason: string | null;
  retries: number;
  message: string;
  queueDepth: number;
}

export interface IdleNotificationDiagnostics {
  queueDepth: number;
  processing: boolean;
  inFlight: boolean;
  recentEvents: IdleNotificationEvent[];
}

const DEFAULT_ROUTE_HIGH_THRESHOLD = 0.85;
const DEFAULT_ROUTE_MEDIUM_THRESHOLD = 0.60;
const SHORT_INPUT_ROUTE_HIGH_THRESHOLD = 0.92;
const SHORT_INPUT_ROUTE_MEDIUM_THRESHOLD = 0.80;
const CALLSIGN_ROUTE_HIGH_THRESHOLD = 0.95;
const CALLSIGN_ROUTE_MEDIUM_THRESHOLD = 0.90;

function countRoutingWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function normalizeRouteTargetTranscriptMatch(targetName: string | null | undefined): string {
  return targetName?.toLowerCase().replace(/\s*\(.*\)$/, '').trim() ?? '';
}

function transcriptMentionsRouteTargetName(
  transcript: string,
  targetName: string | null | undefined,
): boolean {
  const normalizedTargetName = normalizeRouteTargetTranscriptMatch(targetName);
  if (!normalizedTargetName) return false;
  return transcript.toLowerCase().includes(normalizedTargetName);
}

export interface EffectiveRouteThresholds {
  highThreshold: number;
  mediumThreshold: number;
  blocked: boolean;
}

/**
 * Determines whether a create action should be blocked based on the same
 * gate logic that applies to route actions (callsign priority, short-input bias).
 */
export function shouldBlockCreateAction(
  explicitAddress: ResolvedVoiceAddress | null,
  transcript: string,
  routeResult: RouteClassifierResult | null,
  wordCount: number,
): boolean {
  if (!routeResult || routeResult.action !== 'create') return false;

  const targetMentioned = routeResult.targetName
    ? transcriptMentionsRouteTargetName(transcript, routeResult.targetName)
    : false;

  // Gate 1: Callsign priority — if user addressed an agent and didn't mention
  // the creation target by name, block the create action
  if (explicitAddress?.kind === 'agent' && !targetMentioned) {
    return true;
  }

  // Gate 2: Short/ambiguous input — if input is short and doesn't mention
  // any target, block create (it's almost certainly not intentional)
  if (wordCount < 10 && !targetMentioned) {
    return true;
  }

  return false;
}

export function computeEffectiveThresholds(
  explicitAddress: ResolvedVoiceAddress | null,
  transcript: string,
  routeResult: RouteClassifierResult | null,
  wordCount: number,
): EffectiveRouteThresholds {
  let highThreshold = DEFAULT_ROUTE_HIGH_THRESHOLD;
  let mediumThreshold = DEFAULT_ROUTE_MEDIUM_THRESHOLD;
  let blocked = false;

  const mentionsAnyTargetName =
    routeResult?.mentionsAnyTargetName ??
    transcriptMentionsRouteTargetName(transcript, routeResult?.targetName);

  if (wordCount < 10 && !mentionsAnyTargetName) {
    highThreshold = Math.max(highThreshold, SHORT_INPUT_ROUTE_HIGH_THRESHOLD);
    mediumThreshold = Math.max(mediumThreshold, SHORT_INPUT_ROUTE_MEDIUM_THRESHOLD);
  }

  if (explicitAddress?.kind === 'agent') {
    const targetMentioned = routeResult?.targetName
      ? transcriptMentionsRouteTargetName(transcript, routeResult.targetName)
      : false;
    if (!targetMentioned) {
      highThreshold = Math.max(highThreshold, CALLSIGN_ROUTE_HIGH_THRESHOLD);
      mediumThreshold = Math.max(mediumThreshold, CALLSIGN_ROUTE_MEDIUM_THRESHOLD);
    }
    if (routeResult?.targetName && !targetMentioned) {
      blocked = true;
    }
  }

  return { highThreshold, mediumThreshold, blocked };
}

export class VoicePipeline {
  private static readonly MAX_LOCAL_HISTORY = 20;
  private static readonly READY_GRACE_MS = 5_000;
  private static readonly FOLLOWUP_PROMPT_GRACE_MS = 15_000;
  private static readonly REPLY_CONTEXT_DURATION_MS = 45_000;
  // Absorb Discord/VAD timing jitter at the ready->speak handoff.
  private static readonly READY_HANDOFF_TOLERANCE_MS = 600;
  // Rejected-audio reprompts are useful for brief misses, but noisy long chunks
  // create chaotic beep loops in guided flows.
  private static readonly MAX_REJECTED_REPROMPT_MS = 2200;
  private static readonly PROCESSING_LOOP_START_DELAY_MS = 350;
  private static readonly FAST_CUE_COALESCE_MS = 220;
  private static readonly COMMAND_CLASSIFIER_MAX_CHARS = 420;
  private static readonly NEW_POST_TIMEOUT_PROMPT_GUARD_MS = 8_000;
  private static readonly GATE_CLOSE_CUE_HOLDOFF_MS = 320;
  private static readonly GATE_CLOSE_RECENT_AUDIO_RETRY_MS = 260;
  private static readonly GATE_CLOSE_RECENT_AUDIO_MAX_DEFERRAL_MS = 1_500;
  private static readonly INDICATE_TIMEOUT_ACTIVE_SPEECH_GRACE_MS = 1200;
  private static readonly STANDALONE_CODE_WAKE_TOKENS = [
    'whiskeyfoxtrot',
    'whiskeydelta',
    'whiskyfoxtrot',
    'whiskydelta',
  ];
  private static readonly COMPATIBILITY_CONVERSATIONAL_CLOSES = [
    'over',
    'over and out',
    'whiskey foxtrot',
    'whiskey delta',
  ];
  private static readonly SINGLE_SHOT_PROMPT_PREFIX = /^(?:what|whats|what is|when|where|who|why|how|which|can|could|would|will|do|does|did|is|are|am|should|have|has|had|please|tell me|help me|i need|i want|id like|i would like)\b/;
  private static readonly SINGLE_SHOT_INCOMPLETE_TRAILERS = new Set([
    'a',
    'an',
    'and',
    'any',
    'as',
    'at',
    'because',
    'but',
    'by',
    'for',
    'from',
    'if',
    'into',
    'my',
    'of',
    'on',
    'or',
    'so',
    'some',
    'than',
    'that',
    'the',
    'then',
    'this',
    'to',
    'with',
    'your',
  ]);

  private receiver: AudioReceiver;
  private player: DiscordAudioPlayer;
  private stateMachine: PipelineStateMachine;
  private logChannel: TextChannel | null = null;
  private session: SessionTranscript;
  private router: ChannelRouter | null = null;
  private queueState: QueueState | null = null;
  private inboxClient: InboxClient | null = null;
  private inboxLogChannel: TextChannel | null = null;
  private legacyResponsePoller: { check: () => void } | null = null;
  private readonly voiceTargets: VoiceTargetDirectory;
  private readonly topicManager: VoiceTopicManager;
  private readonly projectManager: VoiceProjectManager;

  // Centralized transient state (reset on stop/stall)
  private ctx: TransientContext = createTransientContext();

  // Timer handles (cleared via clearAllTimers)
  private waitingLoopTimer: NodeJS.Timeout | null = null;
  private fastCueTimer: NodeJS.Timeout | null = null;
  private pendingFastCue: EarconName | null = null;
  private pendingFastCueResolvers: Array<() => void> = [];
  private graceExpiryTimer: NodeJS.Timeout | null = null;
  private gateCloseCueTimer: NodeJS.Timeout | null = null;
  private gateCloseCueRetryStartedAt = 0;
  private indicateCaptureTimer: NodeJS.Timeout | null = null;
  private deferredWaitRetryTimer: NodeJS.Timeout | null = null;
  private idleNotifyTimer: NodeJS.Timeout | null = null;
  private idleNotifyQueue: QueuedIdleNotification[] = [];
  private idleNotifyByKey = new Map<string, QueuedIdleNotification>();
  private idleNotifyProcessing = false;
  private idleNotifyEvents: IdleNotificationEvent[] = [];
  private localReadyById = new Map<string, QueuedResponse>();
  private static readonly IDLE_NOTIFY_EVENT_LIMIT = 80;

  // Classifier state
  private lastClassifierTimedOut = false;

  // Inbox background poll — detects text-originated messages in inbox mode
  private inboxPollTimer: NodeJS.Timeout | null = null;
  private static readonly INBOX_POLL_INTERVAL_MS = 60_000;
  private inboxPollInFlight = false;
  // Track last-notified stamp per channel to avoid repeat notifications
  private inboxPollNotifiedStamps = new Map<string, number>();
  // Tracks channels with recent voice dispatches — suppress inbox "new message"
  // notifications during the cool-down to avoid echo responses from the text agent.
  private recentVoiceDispatchChannels = new Map<string, number>();
  private static readonly VOICE_DISPATCH_COOLDOWN_MS = 120_000;

  // Stall watchdog
  private stallWatchdogTimer: NodeJS.Timeout | null = null;
  private lastTransitionAt = Date.now();
  private stallWatchdogFires = 0;
  private static readonly STALL_WATCHDOG_MS = 60_000;

  // Health counters
  private counters: HealthCounters = createHealthCounters();
  private readonly startedAt = Date.now();

  // When tango bridge is active, tango-discord owns Discord text channel posting
  // for voice exchanges (with proper webhook avatars/names). Voice pipeline skips
  // its own this.log() for user/agent messages to avoid duplicates.
  private readonly tangoBridgeOwnsDiscordSync: boolean;

  private stamp(): string {
    return new Date().toISOString();
  }

  private getSystemWakeNames(): string[] {
    const callSigns = this.voiceTargets.getSystemCallSigns();
    return callSigns.length > 0 ? callSigns : [getPreferredSystemWakeName()];
  }

  private getSystemWakeName(): string {
    return this.getSystemWakeNames()[0] ?? 'Tango';
  }

  private getSystemSpeakerLabel(): string {
    return this.voiceTargets.getSystemAgent()?.displayName ?? this.getSystemWakeName();
  }

  private getSpeakerKokoroVoice(agentId?: string | null): string | null {
    return this.voiceTargets.getAgent(agentId)?.kokoroVoice?.trim() || null;
  }

  private getAllWakeNames(): string[] {
    const callSigns = this.voiceTargets.getAllCallSigns();
    return callSigns.length > 0 ? callSigns : [config.botName];
  }

  private resolveExplicitAddress(transcript: string): ResolvedVoiceAddress | null {
    return this.voiceTargets.resolveExplicitAddress(transcript);
  }

  /**
   * Downgrades a bare-name agent address to null when the current channel
   * already has a different assigned agent.  "Hey Malibu, ..." and
   * "Malibu, check this" are strong addresses that override context, but
   * "Malibu says ..." is likely a subject reference and should defer to
   * the channel's own agent.
   */
  private downgradeWeakAddress(
    address: ResolvedVoiceAddress | null,
    transcript: string,
    overrideContextAgentId?: string | null,
  ): ResolvedVoiceAddress | null {
    if (!address || address.kind !== 'agent') return address;

    const contextAgentId = overrideContextAgentId
      ?? this.router?.getActiveTangoRoute?.()?.agentId
      ?? null;
    if (!contextAgentId || contextAgentId === address.agent.id) return address;

    const lower = transcript.trim().toLowerCase();
    const nameLower = address.matchedName.toLowerCase();

    // Greeting prefix — "Hey <name>" / "Hello <name>" is intentional.
    // Whisper often inserts punctuation after the greeting word ("hello, malibu").
    const greetingPrefix = new RegExp(`^(?:hey|hello)[,\\s]+${nameLower}(?:\\b|[,:])`, 'i');
    if (greetingPrefix.test(lower)) {
      return address;
    }
    // Also check the address transcript (preamble-stripped) for mid-transcript wake matches
    const addressLower = address.transcript?.trim().toLowerCase();
    if (addressLower && greetingPrefix.test(addressLower)) {
      return address;
    }

    // Comma or colon after name — "Watson, do this" / "Malibu: check this"
    const nameIdx = lower.indexOf(nameLower);
    if (nameIdx >= 0) {
      const charAfterName = lower[nameIdx + nameLower.length] ?? '';
      if (charAfterName === ',' || charAfterName === ':') {
        return address;
      }
    }

    console.log(
      `Downgrading weak address "${address.matchedName}" — context agent is ${contextAgentId}`,
    );
    return null;
  }

  private matchesAnyWakeWord(transcript: string): boolean {
    return matchesWakeWord(transcript, this.getAllWakeNames());
  }

  private mentionsAnyWakeName(transcript: string): boolean {
    return mentionsWakeName(transcript, this.getAllWakeNames());
  }

  private parseAddressedCommand(
    transcript: string,
    resolvedAddress: ResolvedVoiceAddress | null = this.resolveExplicitAddress(transcript),
  ): VoiceCommand | null {
    if (!resolvedAddress) return null;
    const command = parseVoiceCommand(transcript, resolvedAddress.agent.callSigns);
    if (!command) return null;
    if (resolvedAddress.kind === 'system' || command.type === 'wake-check') {
      return command;
    }
    if (resolvedAddress.kind === 'agent') {
      // Agent-addressed system commands should still behave like commands.
      // "Malibu, go ahead" additionally targets that agent's ready item.
      if (command.type === 'read-ready' && !command.agent) {
        command.agent = resolvedAddress.agent.displayName;
      }
      return command;
    }
    return null;
  }

  private getFocusedAgent(): VoiceAddressAgent | null {
    return this.voiceTargets.getAgent(this.ctx.focusedAgentId);
  }

  private setFocusedAgent(agent: VoiceAddressAgent | null): void {
    this.ctx.focusedAgentId = agent?.id ?? null;
    this.ctx.focusedAgentName = agent?.displayName ?? null;
  }

  private clearFocusedAgent(): void {
    this.setFocusedAgent(null);
  }

  private setReplyContext(
    agentId: string | null,
    sessionKey: string | null,
    channelName: string | null,
    durationMs: number = 45_000,
  ): void {
    if (!agentId) return;
    this.ctx.replyContextAgentId = agentId;
    this.ctx.replyContextSessionKey = sessionKey;
    this.ctx.replyContextChannelName = channelName;
    this.ctx.replyContextUntil = Date.now() + durationMs;
    console.log(`Reply context set: agent=${agentId}, channel=${channelName ?? 'null'}, expires in ${durationMs}ms`);
  }

  private clearReplyContext(): void {
    this.ctx.replyContextAgentId = null;
    this.ctx.replyContextSessionKey = null;
    this.ctx.replyContextChannelName = null;
    this.ctx.replyContextUntil = 0;
  }

  private hasActiveReplyContext(): boolean {
    return this.ctx.replyContextAgentId != null && Date.now() < this.ctx.replyContextUntil;
  }

  private resolveChannelNameFromSessionKey(sessionKey: string | null): string | null {
    if (!sessionKey || !this.router) return null;

    const allChannels = this.router.getAllChannelSessionKeys() as Array<
      { name: string; displayName: string; sessionKey: string } | string
    >;
    const match = allChannels.find((channel) => (
      typeof channel === 'string'
        ? channel === sessionKey
        : channel.sessionKey === sessionKey
    ));
    if (typeof match === 'string') {
      return match.match(/:channel:(.+)$/)?.[1] ?? null;
    }
    if (match) return match.name ?? null;

    return this.router.getActiveSessionKey() === sessionKey
      ? this.router.getActiveChannel().name
      : null;
  }

  private getRouteChannelKey(channelName: string): string | null {
    if (!this.router) return null;
    return this.router.getTangoRouteFor(channelName).channelKey;
  }

  private getFocusedTopic(channelName: string): { id: string; title: string } | null {
    const channelKey = this.getRouteChannelKey(channelName);
    if (!channelKey) return null;
    const topic = this.topicManager.getFocusedTopic(channelKey);
    if (!topic) return null;
    return {
      id: topic.id,
      title: topic.title,
    };
  }

  private getActiveProject(channelName: string): {
    id: string;
    displayName: string;
    defaultAgentId?: string;
  } | null {
    const channelKey = this.getRouteChannelKey(channelName);
    if (!channelKey) return null;
    const topic = this.topicManager.getFocusedTopic(channelKey);
    const project = this.projectManager.resolveActiveProject(channelKey, {
      topicActive: topic !== null,
      topicProjectId: topic?.projectId ?? null,
    });
    if (!project) return null;
    return {
      id: project.id,
      displayName: project.displayName,
      defaultAgentId: project.defaultAgentId,
    };
  }

  private getFocusedProject(channelName: string): {
    id: string;
    displayName: string;
    defaultAgentId?: string;
  } | null {
    const channelKey = this.getRouteChannelKey(channelName);
    if (!channelKey) return null;
    const project = this.projectManager.getFocusedProject(channelKey);
    if (!project) return null;
    return {
      id: project.id,
      displayName: project.displayName,
      defaultAgentId: project.defaultAgentId,
    };
  }

  private resolveDefaultTopicLeadAgent(
    routeAgentId: string | null | undefined,
    channelName?: string | null,
    options?: { allowFocusedProject?: boolean },
  ): VoiceAddressAgent | null {
    const focusedAgent = this.getFocusedAgent();
    if (focusedAgent) {
      return focusedAgent;
    }

    const activeProject =
      options?.allowFocusedProject === false
        ? null
        : (channelName ? this.getActiveProject(channelName) : null);
    const projectDefaultAgent = this.voiceTargets.getAgent(activeProject?.defaultAgentId);
    if (projectDefaultAgent) {
      return projectDefaultAgent;
    }

    const defaultPromptAgent = this.voiceTargets.resolveDefaultPromptAgent(routeAgentId);
    if (defaultPromptAgent) {
      return defaultPromptAgent;
    }

    return this.voiceTargets.getAgent(routeAgentId);
  }

  private resolvePromptAgent(
    routeAgentId: string | null | undefined,
    explicitAddress: ResolvedVoiceAddress | null,
    channelName?: string | null,
  ): VoiceAddressAgent | null {
    if (explicitAddress?.kind === 'agent') {
      return explicitAddress.agent;
    }
    const focusedAgent = this.getFocusedAgent();
    if (focusedAgent) {
      return focusedAgent;
    }
    const activeProject = channelName ? this.getActiveProject(channelName) : null;
    const projectDefaultAgent = this.voiceTargets.getAgent(activeProject?.defaultAgentId);
    if (projectDefaultAgent) {
      return projectDefaultAgent;
    }
    return this.voiceTargets.resolveDefaultPromptAgent(routeAgentId);
  }

  private stripExplicitAddressPrefix(
    transcript: string,
    explicitAddress: ResolvedVoiceAddress | null = this.resolveExplicitAddress(transcript),
  ): string {
    const extracted = explicitAddress?.transcript ?? extractFromWakeWord(transcript, this.getAllWakeNames());
    const source = (extracted ?? transcript).trim();
    const names = explicitAddress?.agent.callSigns ?? this.getAllWakeNames();
    for (const name of names) {
      const trigger = new RegExp(
        `^(?:(?:hey|hello),?\\s+)?${this.escapeRegex(name)}[,.]?\\s*`,
        'i',
      );
      const stripped = source.replace(trigger, '').trim();
      if (stripped !== source || trigger.test(source)) {
        return stripped;
      }
    }
    return source;
  }

  private shouldCueFailedWake(transcript: string): boolean {
    const input = transcript.trim().toLowerCase();
    if (!input) return false;
    // Explicit near-wake attempts (common STT confusion: "weak test/check")
    // should always get feedback in gated mode.
    if (/\b(?:wake|weak)\s+(?:check|test)\b/i.test(input)) return true;
    // Near-miss wake guard: mentions bot name + likely command words,
    // but does not pass strict wake-at-start matching.
    if (!this.mentionsAnyWakeName(transcript)) return false;
    if (this.matchesAnyWakeWord(transcript)) return false;
    const words = input.split(/\s+/).filter(Boolean);
    if (words.length <= 3) return true;
    return /\b(?:hello|hey|inbox|switch|go|list|status|read|next|done)\b/i.test(input);
  }

  private looksLikeBareCommandAttempt(transcript: string): boolean {
    const input = transcript.trim().toLowerCase().replace(/[.!?,]+$/g, '');
    if (!input) return false;
    if (this.matchesAnyWakeWord(transcript)) return false;
    const words = input.split(/\s+/).filter(Boolean);
    if (words.length === 0 || words.length > 20) return false;
    if (/^(?:switch|go|change|move)\s+to\s+.+$/.test(input)) return true;
    if (/\b(?:switch|go|change|move)\s+to\s+[a-z0-9#:_-]{2,}/.test(input)) return true;
    // Contextual navigation commands like "next", "done", or "read last message"
    // should be silently ignored outside grace/inbox flow rather than treated as
    // failed system commands.
    return /^(?:inbox(?:\s+list)?|clear\s+(?:the\s+)?inbox|voice\s+status|status)$/.test(input) ||
      /\b(?:inbox(?:\s+list)?|voice\s+status)\b/.test(input);
  }

  private seemsCommandLikeForMissedWakeLLM(transcript: string): boolean {
    const input = transcript.trim().toLowerCase();
    if (!input) return false;
    const words = input.split(/\s+/).filter(Boolean);
    if (words.length === 0 || words.length > 18) return false;
    return /\b(?:switch|go to|change to|move to|inbox|mode|status|replay|repeat|pause|silent)\b/.test(input);
  }

  private isBareCommandAllowedWhenGateClosed(
    command: VoiceCommand,
    options: { inGracePeriod: boolean; inInboxFlow: boolean },
  ): boolean {
    return options.inGracePeriod || options.inInboxFlow;
  }

  private shouldRunCommandClassifier(transcript: string): boolean {
    const input = transcript.trim();
    if (!input) return false;
    const words = input.split(/\s+/).filter(Boolean);
    // Long freeform utterances are overwhelmingly prompts; skip classifier to
    // avoid delaying acknowledgement on normal channel prompts.
    if (words.length >= 9 && !this.seemsCommandLikeForMissedWakeLLM(input)) {
      return false;
    }
    return true;
  }

  private async maybeCueMissedWakeFromLLM(transcript: string, mode: VoiceMode, inGracePeriod: boolean): Promise<void> {
    if (this.ctx.missedWakeAnalysisInFlight) return;
    if (!this.seemsCommandLikeForMissedWakeLLM(transcript)) return;
    if (!this.mentionsAnyWakeName(transcript)) return;
    this.ctx.missedWakeAnalysisInFlight = true;
    try {
      const inferred = await this.inferVoiceCommandLLM(transcript, mode, inGracePeriod);
      if (!inferred) return;
      const now = Date.now();
      if (now < this.ctx.failedWakeCueCooldownUntil) return;
      this.ctx.failedWakeCueCooldownUntil = now + 1500;
      console.log(`Missed wake inferred by LLM (intent=${inferred.type}) — emitting error earcon`);
      void this.playFastCue('error');
    } finally {
      this.ctx.missedWakeAnalysisInFlight = false;
    }
  }

  private cueFailedWakeIfNeeded(transcript: string): void {
    if (!this.shouldCueFailedWake(transcript)) return;
    const now = Date.now();
    if (now < this.ctx.failedWakeCueCooldownUntil) return;
    this.ctx.failedWakeCueCooldownUntil = now + 1500;
    console.log('Failed-wake guard: emitting error earcon');
    void this.playFastCue('error');
  }

  private rememberSwitchAlias(phrase: string): void {
    if (!this.router) return;
    const rememberAlias = (this.router as unknown as {
      rememberSwitchAlias?: (spoken: string, channelId: string, displayName: string) => void;
    }).rememberSwitchAlias;
    if (!rememberAlias) return;

    const active = this.router.getActiveChannel();
    const channelId = active?.channelId;
    if (!channelId) return;
    const displayName = active.displayName || active.name || channelId;
    rememberAlias.call(this.router, phrase, channelId, displayName);
  }

  private isNonLexicalTranscript(transcript: string): boolean {
    const text = transcript.trim();
    if (!text) return true;

    // Whisper markers like "[BLANK_AUDIO]" / "[SOUND]" should never route into
    // command parsing or prompt dispatch.
    if (/^(?:\s*\[[a-z0-9_ -]+\]\s*)+$/i.test(text)) return true;

    // If there's no alphabetic signal at all, treat as non-lexical noise.
    return !/[a-z]/i.test(text);
  }

  private normalizeForEcho(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private extractChannelIdFromSessionKey(sessionKey: string): string | undefined {
    return extractDiscordChannelIdFromSessionKey(sessionKey) ?? undefined;
  }

  private mergeHistoryWithAssistantTurn(
    history: Message[],
    userText: string,
    assistantText: string,
  ): Message[] {
    const nextHistory: Message[] = [
      ...history,
      { role: 'user', content: userText },
      { role: 'assistant', content: assistantText },
    ];
    if (nextHistory.length <= VoicePipeline.MAX_LOCAL_HISTORY) return nextHistory;
    return nextHistory.slice(-VoicePipeline.MAX_LOCAL_HISTORY);
  }

  private isLikelyPlaybackEcho(transcript: string): boolean {
    if (this.matchesAnyWakeWord(transcript)) return false;
    const currentState = this.stateMachine.getState() as any;
    if (currentState?.type === 'INBOX_FLOW' && currentState.topicSelectionMode) {
      return false;
    }
    const now = Date.now();
    const interactiveWindowOpen =
      this.stateMachine.isAwaitingState()
      || this.stateMachine.getStateType() === 'INBOX_FLOW'
      || now < this.ctx.gateGraceUntil
      || now < this.ctx.promptGraceUntil;
    if (!this.player.isPlaying() && interactiveWindowOpen && this.matchBareQueueCommand(transcript, { allowSwitch: true })) {
      return false;
    }
    if (!this.ctx.lastPlaybackText || !this.ctx.lastPlaybackCompletedAt) return false;
    if (now - this.ctx.lastPlaybackCompletedAt > 15_000) return false;

    const spoken = this.normalizeForEcho(this.ctx.lastPlaybackText);
    const heard = this.normalizeForEcho(transcript);
    if (!spoken || !heard) return false;
    if (heard.length < 8) return false;
    if (heard.split(' ').length < 2) return false;

    return spoken.includes(heard);
  }

  private usesIndicateEndpoint(mode: VoiceMode, gatedMode: boolean): boolean {
    const endpointingMode = getVoiceSettings().endpointingMode ?? 'silence';
    const normalizedMode = normalizeVoiceMode(mode) as 'wait' | 'queue';
    const supportedMode = normalizedMode === 'wait' || normalizedMode === 'queue';
    return endpointingMode === 'indicate' && gatedMode && supportedMode;
  }

  private getCurrentVoiceMode(defaultMode: VoiceMode = 'wait'): VoiceMode {
    if (!this.queueState) return defaultMode;
    return normalizeVoiceMode(this.queueState.getMode());
  }

  private shouldUseStreamingTranscription(): boolean {
    const s = getVoiceSettings();
    return Boolean(s.audioProcessing === 'local' && s.sttStreamingEnabled);
  }

  private onStreamingPartialTranscript(userId: string, event: StreamingPartialEvent): void {
    const text = event.text.trim();
    if (!text || this.isNonLexicalTranscript(text)) return;
    const clipped = text.length > 120 ? `${text.slice(0, 120)}...` : text;
    console.log(
      `Whisper partial ${event.chunkIndex + 1}/${event.totalChunks} from ${userId}: "${clipped}" (${event.elapsedMs}ms)`,
    );
  }

  private partialCommandKey(command: VoiceCommand): string {
    // Stable key for repeated partial evidence settlement.
    return JSON.stringify(command);
  }

  private shouldSettlePartialCommand(command: VoiceCommand, hits: number): boolean {
    if (command.type === 'pause') return true;
    switch (command.type) {
      case 'read-last-message':
      case 'hear-full-message':
      case 'voice-status':
      case 'voice-channel':
      case 'what-channel':
      case 'settings':
        return hits >= 1;
      default:
        return hits >= 2;
    }
  }

  private classifyIndicateDirectiveTranscript(
    transcript: string,
  ): { kind: 'close' | 'cancel'; reason: 'wake-close' | 'wake-empty' | 'wake-cancel' | 'standalone-code'; stripped: string } | null {
    const hasWakeWord = this.matchesAnyWakeWord(transcript);
    const stripped = hasWakeWord ? this.stripLeadingWakePhrase(transcript) : transcript.trim();
    const normalizedStripped = this.normalizeClosePhrase(stripped);
    const standaloneCodeWake = this.isStandaloneCodeWakePhrase(stripped);

    const fullTrimmed = transcript.trim();

    if (hasWakeWord && this.isCancelIntent(stripped)) {
      return { kind: 'cancel', reason: 'wake-cancel', stripped };
    }

    if (hasWakeWord && normalizedStripped.length === 0) {
      return { kind: 'close', reason: 'wake-empty', stripped };
    }

    if (hasWakeWord && (this.isIndicateCloseCommand(stripped) || this.isIndicateCloseCommand(fullTrimmed))) {
      return { kind: 'close', reason: 'wake-close', stripped };
    }

    if (!hasWakeWord && standaloneCodeWake) {
      return { kind: 'close', reason: 'standalone-code', stripped };
    }

    return null;
  }

  private isIndicateDirectiveTranscript(transcript: string): boolean {
    return this.classifyIndicateDirectiveTranscript(transcript) !== null;
  }

  private escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private normalizeClosePhrase(text: string): string {
    return text
      .toLowerCase()
      .replace(/'/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private stripLeadingWakePhrase(transcript: string): string {
    return this.stripExplicitAddressPrefix(transcript);
  }

  private getConfiguredIndicateClosePhrases(): string[] {
    const raw = getVoiceSettings().indicateCloseWords ?? [];
    const normalized = raw
      .map((word) => this.normalizeClosePhrase(word))
      .filter((word) => word.length > 0);
    return Array.from(new Set(normalized));
  }

  private getIndicateClosePhrases(): string[] {
    return Array.from(new Set([
      ...this.getConfiguredIndicateClosePhrases(),
      ...VoicePipeline.COMPATIBILITY_CONVERSATIONAL_CLOSES,
    ]));
  }

  private getStandaloneConversationalClosePhrases(): string[] {
    const configuredMultiWord = this.getConfiguredIndicateClosePhrases()
      .filter((phrase) => phrase.split(/\s+/).length > 1);
    const compatibilityMultiWord = VoicePipeline.COMPATIBILITY_CONVERSATIONAL_CLOSES
      .filter((phrase) => phrase.split(/\s+/).length > 1);
    return Array.from(new Set([
      ...configuredMultiWord,
      ...compatibilityMultiWord,
      ...VoicePipeline.BARE_SAFE_CONVERSATIONAL_CLOSES,
    ]));
  }

  private isIndicateCloseCommand(strippedWakeCommand: string): boolean {
    const normalized = this.normalizeClosePhrase(strippedWakeCommand);
    if (!normalized) return false;
    const closePhrases = this.getIndicateClosePhrases();
    return closePhrases.includes(normalized);
  }

  private getIndicateDismissPhrases(): string[] {
    const raw = getVoiceSettings().indicateDismissWords ?? [];
    const normalized = raw
      .map((word) => this.normalizeClosePhrase(word))
      .filter((word) => word.length > 0);
    return Array.from(new Set(normalized));
  }

  /**
   * Checks if a transcript (already normalized or raw) is a dismiss close.
   * Matches fixed dismiss words AND "thanks/thank you [agent_name]" patterns.
   * Does NOT require a wake word prefix — dismiss closes are standalone.
   */
  private isDismissClose(transcript: string): boolean {
    const normalized = this.normalizeClosePhrase(transcript);
    if (!normalized) return false;

    // Check fixed dismiss words
    const dismissPhrases = this.getIndicateDismissPhrases();
    if (dismissPhrases.includes(normalized)) return true;

    // Check "thanks [agent_name]" / "thank you [agent_name]" pattern
    const thanksMatch = normalized.match(/^(?:thanks|thank you)\s+(.+)$/);
    if (thanksMatch) {
      const namePart = thanksMatch[1];
      const agents = this.voiceTargets.listAgents();
      for (const agent of agents) {
        for (const callSign of agent.callSigns) {
          if (this.normalizeClosePhrase(callSign) === namePart) return true;
        }
      }
      // Whisper often hallucinates a short trailing word/name after
      // "thank you" (e.g. "Thank you, Lynn"). If the remainder is a
      // single short word, treat it as a dismiss — it's almost certainly
      // a bare "thank you" with STT noise appended.
      const remainderWords = namePart.split(/\s+/).filter(Boolean);
      if (remainderWords.length === 1 && remainderWords[0].length <= 8) {
        return true;
      }
    }

    return false;
  }

  /**
   * Standalone conversational closes accepted during active indicate capture.
   * Keep this list to multi-word phrases so the parser can distinguish a
   * deliberate close from ordinary dictation. One-word legacy aliases like
   * "over" are still supported, but only as explicit wake-prefixed closes.
   */
  private static readonly BARE_SAFE_CONVERSATIONAL_CLOSES = ['tango out'];
  private static readonly MAX_TAIL_CONVERSATIONAL_CLOSE_CONTENT_WORDS = 16;

  private isStandaloneConversationalClose(text: string): boolean {
    const normalized = this.normalizeClosePhrase(text);
    return this.getStandaloneConversationalClosePhrases().includes(normalized);
  }

  private formatRouteConfirmationQuestion(targetName: string): string {
    const shortName = targetName.replace(/\s*\(in .*\)$/, '');
    const parentMatch = targetName.match(/\(in (.+)\)$/);
    return parentMatch
      ? `Should I route to ${shortName} in ${parentMatch[1]}?`
      : `Should I route to ${shortName}?`;
  }

  /**
   * Scans the tail of a transcript for an embedded close phrase.
   * Returns the content before the close and the close type, or null.
   * Handles patterns like "log eggs for breakfast, thanks Malibu" and
   * "log eggs for breakfast. Over."
   */
  private extractTailClose(transcript: string): { content: string; type: 'dismiss' | 'conversational' } | null {
    const normalized = this.normalizeClosePhrase(transcript);
    if (!normalized) return null;

    // Build all candidate close phrases (dismiss + conversational)
    const dismissPhrases = this.getIndicateDismissPhrases();
    const closePhrases = this.getStandaloneConversationalClosePhrases();

    // Also build dynamic "thanks [agent]" patterns
    const dynamicDismiss: string[] = [];
    for (const agent of this.voiceTargets.listAgents()) {
      for (const callSign of agent.callSigns) {
        const name = this.normalizeClosePhrase(callSign);
        if (name) {
          dynamicDismiss.push(`thanks ${name}`);
          dynamicDismiss.push(`thank you ${name}`);
        }
      }
    }

    type Candidate = { phrase: string; type: 'dismiss' | 'conversational' };
    const candidates: Candidate[] = [
      ...dismissPhrases.map((p): Candidate => ({ phrase: p, type: 'dismiss' })),
      ...dynamicDismiss.map((p): Candidate => ({ phrase: p, type: 'dismiss' })),
      ...closePhrases.map((p): Candidate => ({ phrase: p, type: 'conversational' })),
    ];

    // Sort longest first so "thank you malibu" matches before "thank you"
    candidates.sort((a, b) => b.phrase.length - a.phrase.length);

    for (const candidate of candidates) {
      if (!normalized.endsWith(candidate.phrase)) continue;
      // Ensure the close phrase isn't the entire transcript (that's handled elsewhere)
      const beforeIdx = normalized.length - candidate.phrase.length;
      if (beforeIdx <= 0) continue;
      // Ensure there's a word boundary before the close phrase
      const charBefore = normalized[beforeIdx - 1];
      if (charBefore !== ' ') continue;
      // Skip single-word close phrases in tail detection — words like "over"
      // and "thanks" appear too often at the end of normal English sentences.
      // They work fine as standalone close utterances but are dangerous as
      // tail matches. Multi-word phrases ("over and out", "thanks malibu")
      // are distinctive enough to be safe.
      const phraseWordCount = candidate.phrase.split(/\s+/).length;
      if (phraseWordCount <= 1) continue;
      // Map back to original transcript: take everything before the close phrase
      const originalWords = transcript.trim().split(/\s+/);
      const closeWordCount = candidate.phrase.split(/\s+/).length;
      const contentWords = originalWords.slice(0, originalWords.length - closeWordCount);
      if (
        candidate.type === 'conversational'
        && contentWords.length > VoicePipeline.MAX_TAIL_CONVERSATIONAL_CLOSE_CONTENT_WORDS
      ) {
        continue;
      }
      const content = contentWords.join(' ');
      return { content, type: candidate.type };
    }

    return null;
  }

  /**
   * Detects standalone close utterances that have been polluted by STT noise,
   * repeated close phrases, or a trailing wake/agent name.
   *
   * Examples:
   * - "go ahead watson"
   * - "go ahead i'm finished"
   * - "go ahead i'm finished that's all that's all"
   */
  private extractCloseOnlyUtterance(transcript: string): { type: 'dismiss' | 'conversational' } | null {
    const normalized = this.normalizeClosePhrase(transcript);
    if (!normalized) return null;

    const dismissPhrases = this.getIndicateDismissPhrases();
    const closePhrases = this.getStandaloneConversationalClosePhrases();

    const dynamicDismiss: string[] = [];
    for (const agent of this.voiceTargets.listAgents()) {
      for (const callSign of agent.callSigns) {
        const name = this.normalizeClosePhrase(callSign);
        if (name) {
          dynamicDismiss.push(`thanks ${name}`);
          dynamicDismiss.push(`thank you ${name}`);
        }
      }
    }

    const wakeNames = this.getAllWakeNames()
      .map((name) => this.normalizeClosePhrase(name))
      .filter((name) => name.length > 0);

    type Candidate = { phrase: string; type: 'dismiss' | 'conversational' | 'wake' };
    const candidates: Candidate[] = [
      ...dismissPhrases.map((phrase): Candidate => ({ phrase, type: 'dismiss' })),
      ...dynamicDismiss.map((phrase): Candidate => ({ phrase, type: 'dismiss' })),
      ...closePhrases.map((phrase): Candidate => ({ phrase, type: 'conversational' })),
      ...wakeNames.map((phrase): Candidate => ({ phrase, type: 'wake' })),
    ];

    candidates.sort((a, b) => {
      const wordDelta = b.phrase.split(/\s+/).length - a.phrase.split(/\s+/).length;
      if (wordDelta !== 0) return wordDelta;
      return b.phrase.length - a.phrase.length;
    });

    let remaining = normalized;
    let firstCloseType: 'dismiss' | 'conversational' | null = null;
    let matchedCloseCount = 0;

    while (remaining.length > 0) {
      const match = candidates.find((candidate) => (
        remaining === candidate.phrase || remaining.startsWith(`${candidate.phrase} `)
      ));
      if (!match) break;
      if (match.type !== 'wake') {
        matchedCloseCount += 1;
        if (firstCloseType === null) {
          firstCloseType = match.type;
        }
      }
      remaining = remaining.slice(match.phrase.length).trim();
    }

    if (!firstCloseType) return null;
    if (!remaining) return { type: firstCloseType };

    const remainingWords = remaining.split(/\s+/).filter(Boolean);
    const remainingCompactLength = remaining.replace(/\s+/g, '').length;
    if (matchedCloseCount >= 2 && remainingWords.length <= 2 && remainingCompactLength <= 8) {
      return { type: firstCloseType };
    }

    return null;
  }

  private isStandaloneCodeWakePhrase(input: string): boolean {
    const normalized = this.normalizeClosePhrase(input);
    if (!normalized) return false;
    const token = normalized.replace(/\s+/g, '');
    if (VoicePipeline.STANDALONE_CODE_WAKE_TOKENS.includes(token)) return true;

    const words = normalized.split(' ').filter(Boolean);
    if (words.length < 2) return false;
    const last = words[words.length - 1];
    const secondLast = words.length > 1 ? words[words.length - 2] : '';
    const splitFoxtrot = secondLast === 'fox' && last === 'trot';
    const endsWithCode = last === 'foxtrot' || splitFoxtrot || last === 'delta';
    if (!endsWithCode) return false;

    const prefixWords = splitFoxtrot ? words.slice(0, -2) : words.slice(0, -1);
    if (prefixWords.length === 0) return false;
    const prefix = prefixWords.join(' ');

    // Whisper sometimes hears "whiskey" as "what is key" near phrase boundaries.
    return /^(?:what(?:s| is)?\s+)?(?:whiskey|whisky|key)$/.test(prefix);
  }

  private armIndicateCaptureTimeout(): void {
    if (!this.ctx.indicateCaptureActive) return;
    const configured = getVoiceSettings().indicateTimeoutMs;
    const timeoutMs = Number.isFinite(configured) ? Math.max(3000, configured) : 45000;
    this.clearIndicateCaptureTimer();
    this.indicateCaptureTimer = setTimeout(() => {
      void this.onIndicateCaptureTimeout();
    }, timeoutMs);
  }

  private indicateCaptureNudgeCount = 0;

  private async onIndicateCaptureTimeout(): Promise<void> {
    this.indicateCaptureTimer = null;
    if (!this.ctx.indicateCaptureActive) return;
    const now = Date.now();
    const recentSpeechStart = this.receiver.getLastSpeechStartedAt();
    const speechRecentlyStarted = recentSpeechStart > 0
      && now - recentSpeechStart < VoicePipeline.INDICATE_TIMEOUT_ACTIVE_SPEECH_GRACE_MS;
    if (this.receiver.hasActiveSpeech() || speechRecentlyStarted) {
      console.log('Indicate capture timeout deferred (active speech detected)');
      this.armIndicateCaptureTimeout();
      return;
    }
    const segments = this.ctx.indicateCaptureSegments
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
    const captured = segments.join(' ').trim();
    if (!captured) {
      // Nothing captured yet — clear silently
      this.clearIndicateCapture('timeout-empty');
      return;
    }
    if (segments.length === 1 && this.isLikelyAccidentalIndicateSeed(captured)) {
      console.log('Indicate capture timed out with likely accidental short seed — cleared silently');
      this.clearIndicateCapture('timeout-accidental');
      return;
    }
    // Nudge the user — never discard captured content.
    // Play a gentle earcon to remind them to say a close word.
    this.indicateCaptureNudgeCount += 1;
    console.log(`Indicate capture nudge #${this.indicateCaptureNudgeCount} (${captured.length} chars captured, waiting for close word)`);
    if (this.player.isPlayingAnyEarcon?.()) {
      console.log('Skipping still-listening earcon — another earcon already playing');
    } else {
      void this.player.playEarcon('still-listening');
    }
    // Re-arm timeout to nudge again if still no close word
    this.armIndicateCaptureTimeout();
  }

  private startIndicateCapture(initialSegment: string): void {
    const segment = initialSegment.trim();
    this.ctx.indicateCaptureActive = true;
    this.ctx.indicateCaptureSegments = segment ? [segment] : [];
    this.ctx.indicateCaptureStartedAt = Date.now();
    this.ctx.indicateCaptureLastSegmentAt = this.ctx.indicateCaptureStartedAt;
    this.indicateCaptureNudgeCount = 0;
    this.armIndicateCaptureTimeout();
    console.log(`Indicate capture started${segment ? ` (seed=${segment.length} chars)` : ''}`);
  }

  private appendIndicateCaptureSegment(segment: string): void {
    const cleaned = segment.trim();
    if (cleaned.length > 0) {
      this.ctx.indicateCaptureSegments.push(cleaned);
      this.ctx.indicateCaptureLastSegmentAt = Date.now();
      console.log(
        `Indicate capture append (${this.ctx.indicateCaptureSegments.length} segments, +${cleaned.length} chars)`,
      );
    }
    this.armIndicateCaptureTimeout();
  }

  private isLikelyAccidentalIndicateSeed(transcript: string): boolean {
    const normalized = this.normalizeClosePhrase(transcript);
    if (!normalized) return true;
    const words = normalized.split(' ').filter(Boolean);
    // One tiny trailing fragment ("message", "okay", etc.) is usually VAD/STT
    // spillover, not an intentional indicate capture body.
    return words.length <= 1 && normalized.length <= 12;
  }

  private shouldAutoFinalizeWakeSeed(transcript: string): boolean {
    const trimmed = transcript.trim();
    const normalized = this.normalizeClosePhrase(trimmed);
    if (!normalized || this.isLikelyAccidentalIndicateSeed(trimmed)) return false;

    const words = normalized.split(' ').filter(Boolean);
    if (words.length === 0) return false;

    const lastWord = words[words.length - 1] ?? '';
    if (VoicePipeline.SINGLE_SHOT_INCOMPLETE_TRAILERS.has(lastWord)) {
      return false;
    }

    if (/[?.!]\s*$/.test(trimmed) && words.length >= 3) {
      return true;
    }

    if (VoicePipeline.SINGLE_SHOT_PROMPT_PREFIX.test(normalized) && words.length >= 3) {
      return true;
    }

    return words.length >= 7;
  }

  private isIndicateCaptureEmpty(): boolean {
    return this.ctx.indicateCaptureSegments
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0)
      .join(' ')
      .trim()
      .length === 0;
  }

  private flushIndicateCapture(reason: string): string {
    const transcript = this.ctx.indicateCaptureSegments
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0)
      .join(' ')
      .trim();
    this.clearIndicateCapture(reason);
    return transcript;
  }

  private async consumeIndicateCaptureUtterance(
    transcript: string,
  ): Promise<{
    action: 'continue' | 'finalize' | 'cancel' | 'command';
    transcript?: string;
    closeType?: IndicateCloseType;
    command?: VoiceCommand;
    commandTranscript?: string;
  }> {
    const hasWakeWord = this.matchesAnyWakeWord(transcript);
    const stripped = hasWakeWord ? this.stripLeadingWakePhrase(transcript) : transcript.trim();
    const standaloneCodeWake = this.isStandaloneCodeWakePhrase(stripped);
    const normalizedStripped = this.normalizeClosePhrase(stripped);
    const bareCommand = !hasWakeWord ? this.matchBareQueueCommand(stripped) : null;
    // Also check the full transcript for close phrases, because wake word
    // stripping can destroy multi-word close phrases that start with a
    // wake word (e.g. if a close phrase begins with an agent name).
    const fullTrimmed = transcript.trim();
    const fullMatchesDismiss = this.isDismissClose(fullTrimmed);
    const fullMatchesClose = this.isIndicateCloseCommand(fullTrimmed);

    // Command path: close/cancel only when wake-prefixed, mirroring start gate.
    if (hasWakeWord && this.isCancelIntent(stripped)) {
      this.clearIndicateCapture('cancel-intent');
      await this.speakResponse('Cancelled.', { inbox: true });
      await this.playReadyEarcon();
      return { action: 'cancel' };
    }

    // Wake-prefixed dismiss close: "Watson, thanks" / "Malibu, thank you"
    // Also matches full-transcript dismiss phrases like "Tango Tango".
    if (hasWakeWord && (this.isDismissClose(stripped) || fullMatchesDismiss)) {
      const finalized = this.flushIndicateCapture('dismiss-close');
      if (!finalized) {
        const wakeName = this.getSystemWakeName();
        await this.speakResponse(
          `I heard the dismiss but no message. Say ${wakeName} and try again.`,
          { inbox: true },
        );
        await this.playReadyEarcon();
        return { action: 'cancel' };
      }
      console.log(`Indicate capture finalized as dismiss (${finalized.length} chars)`);
      return { action: 'finalize', transcript: finalized, closeType: 'dismiss' };
    }

    if (hasWakeWord && normalizedStripped.length === 0) {
      const finalized = this.flushIndicateCapture('wake-only-close');
      if (!finalized) {
        const wakeName = this.getSystemWakeName();
        await this.speakResponse(
          `I heard the end command but no message. Say ${wakeName} and try again.`,
          { inbox: true },
        );
        await this.playReadyEarcon();
        return { action: 'cancel' };
      }
      console.log(`Indicate capture finalized via wake-only close (${finalized.length} chars)`);
      return { action: 'finalize', transcript: finalized };
    }

    if (hasWakeWord && (this.isIndicateCloseCommand(stripped) || fullMatchesClose)) {
      const finalized = this.flushIndicateCapture('close-phrase');
      if (!finalized) {
        const wakeName = this.getSystemWakeName();
        await this.speakResponse(
          `I heard the end command but no message. Say ${wakeName} and try again.`,
          { inbox: true },
        );
        await this.playReadyEarcon();
        return { action: 'cancel' };
      }
      console.log(`Indicate capture finalized (${finalized.length} chars)`);
      return { action: 'finalize', transcript: finalized, closeType: 'conversational' };
    }

    // Allow high-confidence bare playback commands to interrupt active indicate
    // capture without wake word. Keep this list narrow to avoid dictation
    // phrases being misread as navigation commands. read-ready only interrupts
    // when nothing has been dictated yet; otherwise "go ahead" should retain
    // its normal conversational-close meaning and finalize the capture.
    if (bareCommand && (
      bareCommand.type === 'read-last-message'
      || bareCommand.type === 'hear-full-message'
      || (bareCommand.type === 'read-ready' && this.isIndicateCaptureEmpty())
    )) {
      this.clearIndicateCapture(`bare-command:${bareCommand.type}`);
      console.log(`Indicate capture interrupted by bare command: ${bareCommand.type}`);
      return {
        action: 'command',
        command: bareCommand,
        commandTranscript: stripped,
      };
    }

    const closeOnlyUtterance = this.extractCloseOnlyUtterance(stripped);
    if (closeOnlyUtterance) {
      const finalized = this.flushIndicateCapture(`cluster-${closeOnlyUtterance.type}-close`);
      if (!finalized) {
        await this.speakResponse('I heard the close but no message content.', { inbox: true });
        await this.playReadyEarcon();
        return { action: 'cancel' };
      }
      console.log(
        `Indicate capture finalized via close cluster (${closeOnlyUtterance.type}, ${finalized.length} chars)`,
      );
      const closeType: IndicateCloseType = closeOnlyUtterance.type === 'dismiss' ? 'dismiss' : 'conversational';
      return { action: 'finalize', transcript: finalized, closeType };
    }

    // Command precedence while indicate capture is active:
    // wake-prefixed commands should interrupt capture and execute now
    // instead of being appended into dictation.
    if (hasWakeWord) {
      const wakeCommand = this.parseAddressedCommand(transcript);
      if (wakeCommand && wakeCommand.type !== 'wake-check') {
        this.clearIndicateCapture(`wake-command:${wakeCommand.type}`);
        console.log(`Indicate capture interrupted by wake command: ${wakeCommand.type}`);
        return {
          action: 'command',
          command: wakeCommand,
          commandTranscript: transcript,
        };
      }
    }

    // Bare dismiss close: "thanks", "thanks Malibu", "Tango Tango" — no wake word needed.
    // These are high-confidence dismiss patterns that don't appear in normal dictation.
    if (!hasWakeWord && this.isDismissClose(stripped)) {
      const finalized = this.flushIndicateCapture('bare-dismiss-close');
      if (!finalized) {
        await this.speakResponse('I heard the dismiss but no message content.', { inbox: true });
        await this.playReadyEarcon();
        return { action: 'cancel' };
      }
      console.log(`Indicate capture finalized via bare dismiss (${finalized.length} chars)`);
      return { action: 'finalize', transcript: finalized, closeType: 'dismiss' };
    }

    // Bare multi-word conversational close during active capture:
    // "go ahead", "i'm done", "tango out", etc.
    if (!hasWakeWord && this.isStandaloneConversationalClose(stripped)) {
      const finalized = this.flushIndicateCapture('bare-conversational-close');
      if (!finalized) {
        await this.speakResponse('I heard the close phrase but no message content.', { inbox: true });
        await this.playReadyEarcon();
        return { action: 'cancel' };
      }
      console.log(`Indicate capture finalized via bare conversational close (${finalized.length} chars)`);
      return { action: 'finalize', transcript: finalized, closeType: 'conversational' };
    }

    // Radio-code override for experimentation: allow specific standalone codes
    // to close indicate capture without a wake prefix.
    if (!hasWakeWord && standaloneCodeWake) {
      const finalized = this.flushIndicateCapture('standalone-code-close');
      if (!finalized) {
        await this.speakResponse('I heard the close code but no message content.', { inbox: true });
        await this.playReadyEarcon();
        return { action: 'cancel' };
      }
      console.log(`Indicate capture finalized via standalone code (${finalized.length} chars)`);
      return { action: 'finalize', transcript: finalized, closeType: 'conversational' };
    }

    // If user says a close/cancel phrase without wake word, ignore it so we
    // don't accidentally append command words into the prompt body.
    if (!hasWakeWord && !standaloneCodeWake && !this.isDismissClose(stripped) && (this.isIndicateCloseCommand(stripped) || this.isCancelIntent(stripped))) {
      console.log('Indicate capture: ignoring non-wake close/cancel phrase');
      return { action: 'continue' };
    }

    // Tail-close detection: scan the end of the utterance for a close phrase.
    // Handles the natural pattern of "log eggs for breakfast, thanks Malibu"
    // where the close word is appended to the content in a single breath.
    const tailClose = this.extractTailClose(stripped);
    if (tailClose) {
      const hasExistingCapture = this.ctx.indicateCaptureSegments.length > 0;
      if (hasExistingCapture && tailClose.type === 'conversational') {
        this.appendIndicateCaptureSegment(stripped);
        return { action: 'continue' };
      }
      const contentPart = tailClose.content.trim();
      if (contentPart) {
        this.appendIndicateCaptureSegment(contentPart);
      }
      const finalized = this.flushIndicateCapture(`tail-${tailClose.type}-close`);
      if (!finalized) {
        await this.speakResponse('I heard the close but no message content.', { inbox: true });
        await this.playReadyEarcon();
        return { action: 'cancel' };
      }
      const closeType: IndicateCloseType = tailClose.type === 'dismiss' ? 'dismiss' : 'conversational';
      console.log(`Indicate capture finalized via tail ${closeType} close (${finalized.length} chars)`);
      return { action: 'finalize', transcript: finalized, closeType };
    }

    // Content path: anything else is treated as dictation, including wake-prefixed text.
    this.appendIndicateCaptureSegment(stripped);
    return { action: 'continue' };
  }

  constructor(
    connection: VoiceConnection,
    logChannel?: TextChannel,
    options?: {
      topicManager?: VoiceTopicManager;
      projectManager?: VoiceProjectManager;
    },
  ) {
    this.voiceTargets = getDefaultVoiceTargetDirectory();
    this.tangoBridgeOwnsDiscordSync = shouldUseTangoVoiceBridge();
    this.topicManager = options?.topicManager ?? new VoiceTopicManager();
    this.projectManager = options?.projectManager ?? new VoiceProjectManager();
    this.player = new DiscordAudioPlayer();
    this.player.attach(connection);
    this.logChannel = logChannel || null;
    this.inboxLogChannel = logChannel || null;
    this.session = new SessionTranscript();

    // Initialize earcon cache and state machine
    initEarcons();
    this.stateMachine = new PipelineStateMachine();
    this.stateMachine.setTimeoutHandler((effects, preTimeoutState) => {
      void (async () => {
        await this.applyEffects(effects);
        // Preserve transcript on timeout: dispatch to fallback instead of losing it
        if (preTimeoutState?.type === 'AWAITING_ROUTE_CONFIRMATION') {
          const cs = preTimeoutState as AwaitingRouteConfirmationState;
          if (this.router && cs.fallbackChannelId) {
            await this.router.switchTo(cs.fallbackChannelId);
          }
          console.log('Route confirmation timed out — dispatching transcript to fallback');
          try {
            await this.dispatchPromptWithIntent(cs.userId, cs.transcript, cs.deliveryMode, cs.closeType);
          } finally {
            // dispatchPromptWithIntent sets PROCESSING but relies on
            // handleUtterance's finally block to transition back to IDLE.
            // From the timeout handler there is no wrapping handleUtterance,
            // so we must clean up ourselves to avoid a stuck PROCESSING state.
            const st = this.stateMachine.getStateType();
            if (st === 'PROCESSING') {
              this.transitionAndResetWatchdog({ type: 'PROCESSING_COMPLETE' });
            }
          }
        }
      })();
    });

    this.receiver = new AudioReceiver(
      connection,
      (userId, wavBuffer, durationMs) => this.handleUtterance(userId, wavBuffer, durationMs),
      (userId, durationMs) => this.handleRejectedAudio(userId, durationMs),
    );
    this.resetStallWatchdog();
  }

  setRouter(router: ChannelRouter): void {
    this.router = router;
  }

  async restoreProjectChannelSurface(): Promise<void> {
    if (!this.router) return;

    const activeChannel = this.router.getActiveChannel();
    const channelKey = this.getRouteChannelKey(activeChannel.name);
    if (!channelKey) return;

    const focusedProject = this.projectManager.getFocusedProject(channelKey);
    if (!focusedProject) return;

    const projectSessionId = buildProjectSessionId(focusedProject.id);
    const targetChannelId = this.router.getExplicitDiscordChannelIdForSession?.(projectSessionId);
    if (!targetChannelId) return;
    if (activeChannel.channelId === targetChannelId) return;

    const switchResult = await this.router.switchToSessionChannel?.(projectSessionId);
    if (!switchResult?.success) {
      if (switchResult?.error) {
        console.warn(`Failed to restore project channel surface for ${projectSessionId}: ${switchResult.error}`);
      }
      return;
    }

    const switchedChannel = this.router.getActiveChannel();
    const switchedChannelKey = this.getRouteChannelKey(switchedChannel.name);
    if (switchedChannelKey) {
      this.projectManager.setFocusedProjectId(switchedChannelKey, focusedProject.id);
    }

    await this.onChannelSwitch();
    console.log(`Restored project channel surface: ${focusedProject.displayName} -> ${switchResult.displayName ?? targetChannelId}`);
  }

  // Legacy compatibility for older tests and diagnostics.
  setResponsePoller(poller: { check: () => void }): void {
    this.legacyResponsePoller = poller;
  }

  // Legacy compatibility for older tests and diagnostics.
  setInboxTracker(_tracker: unknown): void {
    return;
  }

  setQueueState(state: QueueState): void {
    this.queueState = state;
  }

  setInboxClient(client: InboxClient): void {
    this.inboxClient = client;

    // If mode is already background (persisted from previous session), start the
    // background inbox poll immediately so text-originated messages get detected.
    if (this.queueState && this.getCurrentVoiceMode() === 'queue') {
      this.startInboxPoll();
    }
  }

  async onChannelSwitch(): Promise<void> {
    // Discard any deferred wait response from the previous channel — it belongs
    // to the old context and would be confusing if delivered after the switch.
    this.clearDeferredWaitRetry();

    if (this.router) {
      const routerLogChannel = await this.router.getLogChannel();
      if (routerLogChannel) {
        this.logChannel = routerLogChannel;
      }
      const activeSessionKey = this.router.getActiveSessionKey();
      this.dropIdleNotifications(
        (item) => item.kind === 'text-activity' && item.sessionKey === activeSessionKey,
        'channel-switch',
      );
    }
  }

  start(): void {
    this.receiver.start();
    const sttMain = config.whisperUrl || 'openai-cloud';
    const sttPartials = config.whisperPartialsUrl || sttMain;
    const sttLabel = sttPartials !== sttMain
      ? `stt=${sttMain} stt-partials=${sttPartials} (split)`
      : `stt=${sttMain} (shared)`;
    console.log(`Voice pipeline started ${sttLabel}`);
  }

  stop(): void {
    this.receiver.stop();
    this.clearAllTimers();
    this.player.stopPlayback('pipeline-stop');
    resetTransientContext(this.ctx);
    this.topicManager.destroy();
    this.projectManager.destroy();
    this.stateMachine.destroy();
    console.log('Voice pipeline stopped');
  }

  private clearAllTimers(): void {
    this.clearFastCueQueue();
    this.clearGraceTimer();
    this.clearIndicateCapture('clear-all-timers');
    this.clearDeferredWaitRetry();
    if (this.waitingLoopTimer) {
      clearTimeout(this.waitingLoopTimer);
      this.waitingLoopTimer = null;
    }
    this.player.stopWaitingLoop();
    if (this.stallWatchdogTimer) {
      clearTimeout(this.stallWatchdogTimer);
      this.stallWatchdogTimer = null;
    }
    this.clearIdleNotificationQueue();
    this.stopInboxPoll();
  }

  private clearIndicateCaptureTimer(): void {
    if (this.indicateCaptureTimer) {
      clearTimeout(this.indicateCaptureTimer);
      this.indicateCaptureTimer = null;
    }
  }

  private clearIndicateCapture(reason: string): void {
    this.clearIndicateCaptureTimer();
    if (!this.ctx.indicateCaptureActive && this.ctx.indicateCaptureSegments.length === 0) return;
    console.log(`Indicate capture cleared (${reason})`);
    this.ctx.indicateCaptureActive = false;
    this.ctx.indicateCaptureSegments = [];
    this.ctx.indicateCaptureStartedAt = 0;
    this.ctx.indicateCaptureLastSegmentAt = 0;
  }

  private transitionAndResetWatchdog(event: PipelineEvent): TransitionEffect[] {
    const effects = this.stateMachine.transition(event);
    this.resetStallWatchdog();
    return effects;
  }

  private resetStallWatchdog(): void {
    this.lastTransitionAt = Date.now();
    if (this.stallWatchdogTimer) {
      clearTimeout(this.stallWatchdogTimer);
    }
    this.stallWatchdogTimer = setTimeout(
      () => this.onStallWatchdogFired(),
      VoicePipeline.STALL_WATCHDOG_MS,
    );
  }

  private onStallWatchdogFired(): void {
    this.stallWatchdogTimer = null;
    const stateType = this.stateMachine.getStateType();
    if (stateType === 'IDLE') {
      // Re-arm for next cycle
      this.resetStallWatchdog();
      return;
    }

    // Active playback is not a stall — long TTS responses are legitimate
    // regardless of state (voice commands speak while in PROCESSING).
    if (this.player.isPlaying() || this.player.isWaiting()) {
      this.resetStallWatchdog();
      return;
    }

    this.stallWatchdogFires++;
    this.counters.stallWatchdogFires++;
    const ageMs = Date.now() - this.lastTransitionAt;
    console.warn(
      `Stall watchdog fired: state=${stateType} age=${ageMs}ms fires=${this.stallWatchdogFires} — force-resetting to IDLE`,
    );

    this.clearAllTimers();
    resetTransientContext(this.ctx);
    this.player.stopPlayback('stall-watchdog');
    this.stateMachine.transition({ type: 'RETURN_TO_IDLE' });
    void this.player.playEarcon('error');
    this.resetStallWatchdog();
  }

  private getInvariantContext(): InvariantContext {
    return {
      stateType: this.stateMachine.getStateType(),
      hasStateMachineTimers: this.stateMachine.hasActiveTimers(),
      isPlayerPlaying: this.player.isPlaying(),
      isPlayerWaiting: this.player.isWaiting(),
      waitingLoopTimerActive: this.waitingLoopTimer !== null,
      deferredWaitRetryTimerActive: this.deferredWaitRetryTimer !== null,
      pendingWaitCallback: this.ctx.pendingWaitCallback !== null,
    };
  }

  isPlaying(): boolean {
    return this.player.isPlaying();
  }

  getHealthSnapshot(): HealthSnapshot {
    const stateType = this.stateMachine.getStateType();
    const readyItems = this.getMergedReadyItems();
    return {
      pipelineState: stateType,
      pipelineStateAge: Date.now() - this.lastTransitionAt,
      uptime: Date.now() - this.startedAt,
      mode: this.getCurrentVoiceMode(),
      activeChannel: this.router?.getActiveChannel()?.name ?? null,
      queueReady: readyItems.length,
      queuePending: this.queueState?.getPendingItems().length ?? 0,
      tangoBridgeConfigured: shouldUseTangoVoiceBridge(),
      tangoQueueDepth: 0,
      idleNotificationQueueDepth: this.idleNotifyQueue.length,
      idleNotificationProcessing: this.idleNotifyProcessing,
      idleNotificationInFlight: this.ctx.idleNotifyInFlight,
      dependencies: { whisper: 'unknown', tts: 'unknown' },
      counters: { ...this.counters },
    };
  }

  getCounters(): HealthCounters {
    return this.counters;
  }

  // Legacy compatibility for tests that still query ready items by channel/session.
  getReadyItemsForSession(sessionKey: string, channelName: string): Array<{ sessionKey?: string; channel?: string }> {
    const readyItems = this.getMergedReadyItems();
    return readyItems.filter((item: any) => item.sessionKey === sessionKey || item.channel === channelName);
  }

  private getMergedReadyItems(): QueuedResponse[] {
    const merged = new Map<string, QueuedResponse>();

    for (const item of this.localReadyById.values()) {
      merged.set(item.id, item);
    }

    const queueItems = this.queueState?.getReadyItems() ?? [];
    for (const item of queueItems) {
      merged.set(item.id, item);
    }

    return [...merged.values()].sort((a, b) => a.timestamp - b.timestamp);
  }

  private getReadyItemByChannel(channel: string): QueuedResponse | null {
    const normalizedChannel = this.normalizeChannelLabel(channel);
    return this.getMergedReadyItems().find((item) => this.normalizeChannelLabel(item.channel) === normalizedChannel) ?? null;
  }

  private getNextReadyItem(): QueuedResponse | null {
    return this.getMergedReadyItems()[0] ?? null;
  }

  private markReadyItemHeard(itemId: string): void {
    this.queueState?.markHeard(itemId);
    this.localReadyById.delete(itemId);
  }

  private storeLocalReadyItem(item: QueuedResponse): void {
    this.localReadyById.set(item.id, { ...item, status: 'ready' });
  }

  private getReadyItemKeys(item: QueuedResponse): Set<string> {
    const keys = new Set<string>();
    const sessionChannelMatch = item.sessionKey.match(/(?:^|:)channel:([^:]+)$/);
    const channelId = this.extractChannelIdFromSessionKey(item.sessionKey);
    if (channelId) keys.add(`id:${channelId}`);
    if (sessionChannelMatch?.[1]) keys.add(`name:${this.normalizeChannelLabel(sessionChannelMatch[1])}`);
    if (item.channel) keys.add(`name:${this.normalizeChannelLabel(item.channel)}`);
    if (item.displayName) keys.add(`display:${this.normalizeChannelLabel(item.displayName)}`);
    return keys;
  }

  private getInboxChannelKeys(channel: VoiceInboxChannel): Set<string> {
    const keys = new Set<string>();
    if (channel.channelId) keys.add(`id:${channel.channelId}`);
    if (channel.channelName) keys.add(`name:${this.normalizeChannelLabel(channel.channelName)}`);
    if (channel.displayName) keys.add(`display:${this.normalizeChannelLabel(channel.displayName)}`);
    return keys;
  }

  private clearLocalReadyItemsForDispatch(channelName: string, sessionKey: string): void {
    const dispatchKeys = new Set<string>([
      `name:${this.normalizeChannelLabel(channelName)}`,
      ...[...this.getReadyItemKeys({
        id: '',
        channel: channelName,
        displayName: '',
        sessionKey,
        userMessage: '',
        speakerAgentId: null,
        summary: '',
        responseText: '',
        timestamp: 0,
        status: 'pending',
      })],
    ]);

    for (const [itemId, item] of this.localReadyById.entries()) {
      const itemKeys = this.getReadyItemKeys(item);
      const overlaps = [...itemKeys].some((key) => dispatchKeys.has(key));
      if (overlaps) {
        this.localReadyById.delete(itemId);
      }
    }
  }

  private clearLocalReadyItemsForInboxChannel(channel: VoiceInboxChannel): void {
    const channelKeys = this.getInboxChannelKeys(channel);
    for (const [itemId, item] of this.localReadyById.entries()) {
      const itemKeys = this.getReadyItemKeys(item);
      const overlaps = [...itemKeys].some((key) => channelKeys.has(key));
      if (overlaps) {
        this.localReadyById.delete(itemId);
      }
    }
  }

  private formatAgentMessageSummary(agentItems: Array<{ agentDisplayName: string; totalUnread: number }>): string {
    if (agentItems.length === 0) return '';
    const parts = agentItems.map((item) => {
      const count = item.totalUnread;
      return `${item.agentDisplayName} has ${count} message${count === 1 ? '' : 's'}`;
    });
    if (parts.length === 1) return `${parts[0]}.`;
    if (parts.length === 2) return `${parts[0]} and ${parts[1]}.`;
    return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}.`;
  }

  private mergeSpokenInboxAgents(
    agentInbox?: VoiceInboxAgentResponse | null,
  ): Array<{ agentId: string | null; agentDisplayName: string; totalUnread: number }> {
    const merged = new Map<string, { agentId: string | null; agentDisplayName: string; totalUnread: number; channelKeys: Set<string> }>();
    const keyFor = (agentId: string | null | undefined, agentDisplayName: string) =>
      (agentId?.trim().toLowerCase() || `name:${this.normalizeChannelLabel(agentDisplayName)}`);

    for (const agent of agentInbox?.agents ?? []) {
      const key = keyFor(agent.agentId, agent.agentDisplayName);
      const channelKeys = new Set<string>();
      for (const channel of agent.channels as VoiceInboxChannel[]) {
        for (const value of this.getInboxChannelKeys(channel)) {
          channelKeys.add(value);
        }
      }
      merged.set(key, {
        agentId: agent.agentId,
        agentDisplayName: agent.agentDisplayName,
        totalUnread: agent.totalUnread,
        channelKeys,
      });
    }

    for (const item of this.getMergedReadyItems()) {
      const key = keyFor(item.speakerAgentId, item.displayName || item.channel);
      const entry = merged.get(key);
      const itemKeys = this.getReadyItemKeys(item);
      const representedRemotely = entry
        ? [...itemKeys].some((value) => entry.channelKeys.has(value))
        : false;
      if (representedRemotely) continue;

      if (entry) {
        entry.totalUnread += 1;
        continue;
      }

      merged.set(key, {
        agentId: item.speakerAgentId,
        agentDisplayName: item.displayName || item.channel,
        totalUnread: 1,
        channelKeys: itemKeys,
      });
    }

    return [...merged.values()].map(({ agentId, agentDisplayName, totalUnread }) => ({
      agentId,
      agentDisplayName,
      totalUnread,
    }));
  }

  private notifyLegacyResponsePoller(): void {
    try {
      this.legacyResponsePoller?.check();
    } catch {
      // Best effort compatibility hook only.
    }
  }

  getIdleNotificationDiagnostics(limit = 8): IdleNotificationDiagnostics {
    const max = Math.max(1, Math.min(limit, VoicePipeline.IDLE_NOTIFY_EVENT_LIMIT));
    const recentEvents = this.idleNotifyEvents.slice(-max).map((event) => ({ ...event }));
    return {
      queueDepth: this.idleNotifyQueue.length,
      processing: this.idleNotifyProcessing,
      inFlight: this.ctx.idleNotifyInFlight,
      recentEvents,
    };
  }

  interrupt(): void {
    if (this.player.isPlaying()) {
      console.log('Interrupting playback');
      this.player.stopPlayback('external-interrupt');
    }
  }

  /**
   * Whether the assistant is actively doing work (STT, LLM, TTS).
   * AWAITING states are NOT "processing" — the assistant is waiting for user input.
   */
  private isProcessing(): boolean {
    const st = this.stateMachine.getStateType();
    return st === 'PROCESSING' || st === 'TRANSCRIBING' || st === 'SPEAKING';
  }

  /**
   * Whether the assistant is busy in any non-IDLE state.
   * Used by notifyIfIdle to prevent notifications during AWAITING prompts.
   */
  private isBusy(): boolean {
    return this.stateMachine.getStateType() !== 'IDLE';
  }

  /**
   * Apply a list of transition effects produced by the state machine.
   */
  private async applyEffects(effects: TransitionEffect[]): Promise<void> {
    // When guided new-post flow times out, prevent immediate follow-on dictation
    // from being treated as a normal channel prompt.
    const newPostTimedOut = effects.some(
      (effect) =>
        effect.type === 'speak' &&
        effect.text.toLowerCase().includes('new post flow timed out'),
    );
    if (newPostTimedOut) {
      this.ctx.newPostTimeoutPromptGuardUntil = Date.now() + VoicePipeline.NEW_POST_TIMEOUT_PROMPT_GUARD_MS;
      console.log(
        `New-post timeout guard enabled for ${VoicePipeline.NEW_POST_TIMEOUT_PROMPT_GUARD_MS}ms`,
      );
    }

    for (const effect of effects) {
      switch (effect.type) {
        case 'earcon':
          await this.player.playEarcon(effect.name);
          break;
        case 'speak':
          await this.speakResponse(effect.text);
          break;
        case 'stop-playback':
          this.player.stopPlayback('state-machine-effect');
          break;
        case 'start-waiting-loop':
          this.startWaitingLoop();
          break;
        case 'stop-waiting-loop':
          this.stopWaitingLoop();
          break;
      }
    }
  }

  private async handleUtterance(userId: string, wavBuffer: Buffer, durationMs: number): Promise<void> {
    this.counters.utterancesProcessed++;
    // Clear stale speculative queue item (safety net for timeout edge case)
    if (this.ctx.speculativeQueueItemId && !this.stateMachine.getQueueChoiceState()) {
      this.ctx.speculativeQueueItemId = null;
    }

    const stateAtStart = this.stateMachine.getStateType();
    const isSpeakingAtStart = stateAtStart === 'SPEAKING';
    const gatedMode = getVoiceSettings().gated;
    const modeAtCapture = this.getCurrentVoiceMode('wait');
    const indicateEndpointAtCapture = this.usesIndicateEndpoint(modeAtCapture, gatedMode);
    const nowAtCapture = Date.now();
    const utteranceStartEstimate = nowAtCapture - Math.max(0, durationMs);
    const graceFromGateAtCapture =
      nowAtCapture < this.ctx.gateGraceUntil ||
      utteranceStartEstimate < (this.ctx.gateGraceUntil + VoicePipeline.READY_HANDOFF_TOLERANCE_MS);
    const graceFromPromptAtCapture =
      nowAtCapture < this.ctx.promptGraceUntil ||
      utteranceStartEstimate < (this.ctx.promptGraceUntil + VoicePipeline.READY_HANDOFF_TOLERANCE_MS);

    // Interrupt TTS playback if user speaks — but don't kill the waiting tone
    const wasPlayingResponse = this.player.isPlaying() && !this.player.isWaiting();

    // Open mode: interrupt immediately. Gated mode: defer until after transcription.
    if (wasPlayingResponse && !gatedMode) {
      console.log('User spoke during playback — interrupting');
      this.player.stopPlayback('speech-during-playback-open-mode');
    }

    const gatedInterrupt = wasPlayingResponse && gatedMode;
    // Allow gated interrupts during PROCESSING too — inbox item readback and
    // voice command responses play TTS while in PROCESSING state, not SPEAKING.
    const gatedSpeakingProbe = gatedInterrupt && (isSpeakingAtStart || stateAtStart === 'PROCESSING');
    const gateClosedCueInterrupt = gatedInterrupt && this.player.isPlayingEarcon('gate-closed');
    let keepCurrentState = false;
    let playedListeningEarly = false;
    let partialWakeWordDetected = false;
    let partialPlaybackStoppedByPartial = false;
    let partialWakeCommandDetected: VoiceCommand | null = null;
    let partialWakeCommandTranscript = '';
    const partialCommandEvidence = new Map<string, number>();
    let partialIndicateDirective:
      { kind: 'close' | 'cancel'; reason: 'wake-close' | 'wake-empty' | 'wake-cancel' | 'standalone-code'; transcript: string } | null | undefined;
    let partialIndicateDirectiveHits = 0;
    let partialIndicateDirectiveKey = '';

    // Check if busy — buffer utterance instead of silently dropping
    if (this.isProcessing() && !gatedSpeakingProbe) {
      if (Date.now() < this.ctx.ignoreProcessingUtterancesUntil) {
        console.log('Ignoring utterance during short post-choice debounce window');
        return;
      }
      // If TTS is actively playing during PROCESSING (e.g. voice command
      // response, speakResponse), any captured audio is speaker bleed or
      // ambient noise — not intentional user input.  Discard it rather than
      // buffering, because replaying it after grace opens produces gibberish
      // prompts.
      if (this.player.isPlaying()) {
        console.log('Discarding utterance captured during active TTS playback (PROCESSING)');
        return;
      }
      console.log('Already processing — buffering utterance');
      const effects = this.transitionAndResetWatchdog({ type: 'UTTERANCE_RECEIVED' });
      this.stateMachine.bufferUtterance(userId, wavBuffer, durationMs);
      await this.applyEffects(effects);
      return;
    }

    // Transition to TRANSCRIBING
    if (!gatedSpeakingProbe) {
      this.transitionAndResetWatchdog({ type: 'UTTERANCE_RECEIVED' });
    }

    // For AWAITING states, play listening earcon immediately — no wake word needed,
    // so we know this is a valid interaction before STT even runs
    const stateType = this.stateMachine.getStateType();
    if (this.stateMachine.isAwaitingState() && !indicateEndpointAtCapture) {
      // Play immediately here (no fast-cue coalescing) so it can't fire late and
      // preempt a near-immediate spoken command response.
      void this.player.playEarcon('listening');
      playedListeningEarly = true;
    } else if (
      gatedMode
      && (graceFromGateAtCapture || graceFromPromptAtCapture)
      && !indicateEndpointAtCapture
    ) {
      // In grace, speech should feel accepted immediately even for non-awaiting turns.
      // Play immediately here (no fast-cue coalescing) so it can't fire late and
      // preempt a near-immediate spoken command response.
      void this.player.playEarcon('listening');
      playedListeningEarly = true;
    }

    const pipelineStart = Date.now();

    try {
      // Start waiting indicator sound
      // Skip for: gated mode (deferred until wake word), AWAITING states (no processing needed),
      // and background capture where a queue acknowledgement is expected instead of "processing".
      const isAwaiting = this.stateMachine.isAwaitingState() || this.stateMachine.getStateType() === 'INBOX_FLOW';
      if (!gatedMode && !isAwaiting && modeAtCapture === 'wait') {
        this.startWaitingLoop();
      }

      // Step 1: Speech-to-text
      const settings = getVoiceSettings();
      let transcript = await transcribe(
        wavBuffer,
        this.shouldUseStreamingTranscription()
          ? {
            enablePartials: true,
            chunkMs: settings.sttStreamingChunkMs,
            minChunkMs: settings.sttStreamingMinChunkMs,
            overlapMs: settings.sttStreamingOverlapMs,
            maxChunks: settings.sttStreamingMaxChunks,
            onPartial: (event) => {
              this.onStreamingPartialTranscript(userId, event);
              const partialText = event.text.trim();
              if (!partialText) return;

              const partialCmd = this.parseAddressedCommand(partialText);
              const partialHasWake = partialCmd !== null || this.matchesAnyWakeWord(partialText);
              if (partialHasWake) {
                partialWakeWordDetected = true;
              }
              if (partialCmd && partialCmd.type !== 'wake-check') {
                const key = this.partialCommandKey(partialCmd);
                const hits = (partialCommandEvidence.get(key) ?? 0) + 1;
                partialCommandEvidence.set(key, hits);
                if (this.shouldSettlePartialCommand(partialCmd, hits)) {
                  partialWakeCommandDetected = partialCmd;
                  partialWakeCommandTranscript = partialText;
                }
              }

              if (indicateEndpointAtCapture && this.ctx.indicateCaptureActive) {
                const directive = this.classifyIndicateDirectiveTranscript(partialText);
                if (directive) {
                  const directiveKey = `${directive.kind}:${directive.reason}:${this.normalizeClosePhrase(directive.stripped)}`;
                  if (directiveKey === partialIndicateDirectiveKey) {
                    partialIndicateDirectiveHits += 1;
                  } else {
                    partialIndicateDirectiveKey = directiveKey;
                    partialIndicateDirectiveHits = 1;
                  }
                  const settleHits = directive.reason === 'wake-empty' ? 2 : 1;
                  if (partialIndicateDirectiveHits >= settleHits) {
                    partialIndicateDirective = {
                      kind: directive.kind,
                      reason: directive.reason,
                      transcript: partialText,
                    };
                  }
                }
              }

              // During active playback, partials should only preempt on an explicit
              // wake-word command, not wake-check alone.
              const partialInterruptCommand =
                partialCmd && partialCmd.type !== 'wake-check'
                  ? partialCmd
                  : null;
              if (!gatedMode || !wasPlayingResponse || !partialInterruptCommand || partialPlaybackStoppedByPartial) return;
              if (this.player.isPlaying() && !this.player.isWaiting()) {
                console.log(`Gated interrupt: command confirmed by streaming partial (${partialInterruptCommand.type})`);
                this.player.stopPlayback('speech-during-playback-gated-partial-command');
                partialPlaybackStoppedByPartial = true;
              }
            },
          }
          : undefined,
      );
      if (!transcript || transcript.trim().length === 0) {
        if (partialWakeCommandDetected && partialWakeCommandTranscript) {
          transcript = partialWakeCommandTranscript;
          const clipped = transcript.length > 120 ? `${transcript.slice(0, 120)}...` : transcript;
          console.log(`Using streaming partial command transcript fallback: "${clipped}"`);
        } else {
          console.log('Empty transcript, skipping');
          if (!this.ctx.pendingWaitCallback) {
            this.stopWaitingLoop();
          }
          if (this.stateMachine.isAwaitingState()) {
            await this.playReadyEarcon();
            return;
          }
          if (gatedSpeakingProbe) {
            keepCurrentState = true;
            return;
          }
          this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
          return;
        }
      }

      if (this.isNonLexicalTranscript(transcript)) {
        console.log(`Non-lexical transcript ignored: "${transcript}"`);
        if (!this.ctx.pendingWaitCallback) {
          this.stopWaitingLoop();
        }
        if (this.stateMachine.isAwaitingState()) {
          await this.playReadyEarcon();
        } else if (gatedSpeakingProbe) {
          keepCurrentState = true;
        } else {
          this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
        }
        return;
      }

      if (this.isLikelyPlaybackEcho(transcript)) {
        console.log(`Playback echo suppressed: "${transcript}"`);
        if (!this.ctx.pendingWaitCallback) {
          this.stopWaitingLoop();
        }
        if (this.stateMachine.isAwaitingState()) {
          await this.playReadyEarcon();
        } else if (gatedSpeakingProbe) {
          keepCurrentState = true;
        } else {
          this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
        }
        return;
      }

      this.transitionAndResetWatchdog({ type: 'TRANSCRIPT_READY', transcript });

      // Step 1.5: Check for awaiting responses (bypass LLM)
      // These are valid interactions that don't need a wake word
      if (this.stateMachine.getStateType() === 'AWAITING_CHANNEL_SELECTION' ||
          this.stateMachine.getChannelSelectionState()) {
        console.log(`Channel selection input: "${transcript}"`);
        await this.handleChannelSelection(transcript);
        const totalMs = Date.now() - pipelineStart;
        console.log(`Voice command (selection) complete: ${totalMs}ms total`);
        return;
      }

      if (this.stateMachine.getQueueChoiceState()) {
        console.log(`Queue choice input: "${transcript}"`);
        await this.handleQueueChoiceResponse(transcript);
        const totalMs = Date.now() - pipelineStart;
        console.log(`Voice command (queue choice) complete: ${totalMs}ms total`);
        return;
      }

      if (this.stateMachine.getSwitchChoiceState()) {
        console.log(`Switch choice input: "${transcript}"`);
        await this.handleSwitchChoiceResponse(transcript);
        const totalMs = Date.now() - pipelineStart;
        console.log(`Voice command (switch choice) complete: ${totalMs}ms total`);
        return;
      }

      if (this.stateMachine.getRouteConfirmationState()) {
        console.log(`Route confirmation input: "${transcript}"`);
        await this.handleRouteConfirmationResponse(transcript, userId);
        const totalMs = Date.now() - pipelineStart;
        console.log(`Voice command (route confirmation) complete: ${totalMs}ms total`);
        return;
      }

      if (this.stateMachine.getNewPostFlowState()) {
        const flowState = this.stateMachine.getNewPostFlowState()!;
        console.log(`New-post flow (${flowState.step}): "${transcript}"`);
        await this.handleNewPostStep(transcript);
        const totalMs = Date.now() - pipelineStart;
        console.log(`Voice command (new-post flow) complete: ${totalMs}ms total`);
        return;
      }

      // INBOX_FLOW: intercept transcripts before indicate capture to handle
      // navigation commands and topic selection without requiring a wake word.
      if (this.stateMachine.getStateType() === 'INBOX_FLOW') {
        const inboxCommand = this.matchBareQueueCommand(transcript, { allowSwitch: true });
        if (inboxCommand) {
          const resolved = this.resolveDoneCommandForContext(inboxCommand, transcript);
          console.log(`Inbox flow navigation: ${resolved.type}`);
          await this.playFastCue('listening');
          await this.handleVoiceCommand(resolved, userId);
          const totalMs = Date.now() - pipelineStart;
          console.log(`Voice command (inbox navigation) complete: ${totalMs}ms total`);
          return;
        }
        // In topic selection mode, treat any unrecognized utterance as a topic query
        const inboxState = this.stateMachine.getState() as any;
        if (inboxState.topicSelectionMode) {
          const query = transcript.trim().toLowerCase().replace(/[.!?,]+$/, '').trim();
          if (query) {
            console.log(`Inbox topic selection (freeform): "${query}"`);
            await this.playFastCue('listening');
            await this.handleInboxTopicSelect(query);
            const totalMs = Date.now() - pipelineStart;
            console.log(`Voice command (inbox topic select) complete: ${totalMs}ms total`);
            return;
          }
        }
      }

      // Gate check: in gated mode, discard utterances that don't start with the wake word
      // Grace period: skip gate for 5s after the assistant finishes speaking
      // While a wait callback is pending, require wake word in gated mode.
      // Grace windows are intended for explicit "your turn" handoffs, not
      // background processing where accidental noises can cause interruptions.
      const mode = modeAtCapture;
      const indicateEnabled = this.usesIndicateEndpoint(mode, gatedMode);
      const inInboxFlow = this.stateMachine.getStateType() === 'INBOX_FLOW';
      if (!indicateEnabled && this.ctx.indicateCaptureActive) {
        this.clearIndicateCapture('mode-disabled');
      }

      let indicateFinalized = false;
      let indicateCloseType: IndicateCloseType | undefined;
      if (indicateEnabled && this.ctx.indicateCaptureActive) {
        if (
          partialIndicateDirective
          && !this.isIndicateDirectiveTranscript(transcript)
        ) {
          transcript = partialIndicateDirective.transcript;
          const clipped = transcript.length > 120 ? `${transcript.slice(0, 120)}...` : transcript;
          console.log(
            `Using streaming partial indicate ${partialIndicateDirective.kind} fallback (${partialIndicateDirective.reason}): "${clipped}"`,
          );
        }

        const indicateResult = await this.consumeIndicateCaptureUtterance(transcript);
        if (indicateResult.action === 'continue') {
          this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
          return;
        }
        if (indicateResult.action === 'cancel') {
          this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
          return;
        }
        if (indicateResult.action === 'command' && indicateResult.command) {
          await this.playFastCue('listening');
          const resolvedCommand = this.resolveDoneCommandForContext(
            indicateResult.command,
            indicateResult.commandTranscript ?? transcript,
          );
          await this.handleVoiceCommand(resolvedCommand, userId);
          const totalMs = Date.now() - pipelineStart;
          console.log(`Voice command (indicate capture) complete: ${totalMs}ms total`);
          return;
        }
        transcript = indicateResult.transcript ?? '';
        indicateFinalized = true;
        indicateCloseType = indicateResult.closeType;
      }

      const allowGraceBypass = this.ctx.pendingWaitCallback === null;
      // When indicate capture finalizes, the original wake word is no longer in
      // the transcript. Restore the addressed agent captured at indicate start.
      let explicitAddress: ResolvedVoiceAddress | null;
      if (indicateFinalized && this.ctx.indicateCaptureAddressedAgentId) {
        const agent = this.voiceTargets.getAgent(this.ctx.indicateCaptureAddressedAgentId);
        explicitAddress = agent
          ? { kind: 'agent', agent, matchedName: agent.displayName, transcript }
          : null;
      } else if (indicateFinalized) {
        explicitAddress = null;
      } else {
        explicitAddress = this.resolveExplicitAddress(transcript);
        // Context-aware address: if the current channel already has a different
        // assigned agent, only honor a bare-name match when it has a greeting
        // prefix ("Hey Malibu").  Bare names at the start of a transcript
        // ("Malibu says he can't...") are likely subject references, not addresses.
        explicitAddress = this.downgradeWeakAddress(explicitAddress, transcript);
      }
      const standaloneCodeWake = indicateFinalized ? false : this.isStandaloneCodeWakePhrase(transcript);
      const hasWakeWord = indicateFinalized
        ? true
        : (explicitAddress !== null || standaloneCodeWake);
      const effectiveWakeWord = hasWakeWord || partialWakeWordDetected;
      const focusedPromptBypass = !explicitAddress && this.getFocusedAgent() !== null;
      const inGracePeriod = indicateFinalized
        ? true
        : (
          allowGraceBypass &&
          (
            graceFromGateAtCapture ||
            graceFromPromptAtCapture ||
            Date.now() < (this.ctx.gateGraceUntil + VoicePipeline.READY_HANDOFF_TOLERANCE_MS) ||
            Date.now() < (this.ctx.promptGraceUntil + VoicePipeline.READY_HANDOFF_TOLERANCE_MS)
          )
        );
      const interruptGraceEligible = indicateFinalized || (allowGraceBypass && (graceFromGateAtCapture || graceFromPromptAtCapture));

      // By design in gated mode, interrupting active playback must include wake word.
      if (gatedInterrupt && !effectiveWakeWord && !focusedPromptBypass && !gateClosedCueInterrupt && !interruptGraceEligible) {
        console.log(`Gated interrupt rejected (wake word required): "${transcript}"`);
        if (gatedSpeakingProbe) {
          keepCurrentState = true;
        } else {
          this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
        }
        return;
      }
      if (gatedMode && !inGracePeriod && !effectiveWakeWord && !focusedPromptBypass) {
        if (gatedInterrupt) {
          console.log(`Gated: discarded interrupt "${transcript}"`);
          // Don't stop playback — the assistant keeps talking
          if (gatedSpeakingProbe) {
            keepCurrentState = true;
          } else {
            this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
          }
          this.cueFailedWakeIfNeeded(transcript);
        } else if (this.ctx.pendingWaitCallback) {
          console.log(`Gated: discarded "${transcript}" (wait processing continues)`);
          this.cueFailedWakeIfNeeded(transcript);
          void this.maybeCueMissedWakeFromLLM(transcript, mode, inGracePeriod);
          // Don't stop waiting loop — pending wait callback is active
          this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
        } else if (mode !== 'wait' || inInboxFlow) {
          // In background mode, allow bare navigation commands (next, inbox check,
          // etc.) through the gate without requiring the wake word. In INBOX_FLOW
          // this also applies while mode is focus, so navigation stays hands-free.
          const bareCommand = this.matchBareQueueCommand(transcript, { allowSwitch: inGracePeriod || inInboxFlow });
          if (bareCommand) {
            const resolved = this.resolveDoneCommandForContext(bareCommand, transcript);
            if (!this.isBareCommandAllowedWhenGateClosed(resolved, { inGracePeriod, inInboxFlow })) {
              console.log(`Gated: discarded "${transcript}" (bare ${resolved.type} requires grace or wake word)`);
              this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
              return;
            }
            const bypassLabel = inInboxFlow && mode === 'wait' ? 'inbox-flow bare command' : `${mode} mode bare command`;
            console.log(`Gate bypass (${bypassLabel}): ${resolved.type}`);
            await this.playFastCue('listening');
            await this.handleVoiceCommand(resolved, userId);
            return;
          } else {
            const contextLabel = inInboxFlow && mode === 'wait' ? 'inbox-flow' : `${mode} mode`;
            console.log(`Gated: discarded "${transcript}" (no bare command match in ${contextLabel})`);
            this.cueFailedWakeIfNeeded(transcript);
            void this.maybeCueMissedWakeFromLLM(transcript, mode, inGracePeriod);
            this.stopWaitingLoop();
            this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
            return;
          }
        } else {
          console.log(`Gated: discarded "${transcript}"`);
          this.cueFailedWakeIfNeeded(transcript);
          void this.maybeCueMissedWakeFromLLM(transcript, mode, inGracePeriod);
          this.stopWaitingLoop();
          this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
        }
        return;
      }

      // Strip preamble when wake word was found mid-transcript (Whisper artifact)
      if (explicitAddress) {
        const extracted = explicitAddress.transcript;
        if (extracted && extracted.length < transcript.trim().length) {
          console.log(`Wake word found mid-transcript, stripped preamble: "${extracted.slice(0, 100)}${extracted.length > 100 ? '...' : ''}"`);
          transcript = extracted;
        }
      }

      const parsedCommand = this.parseAddressedCommand(transcript, explicitAddress);
      const preParsedCommand: VoiceCommand | null = parsedCommand
        ?? partialWakeCommandDetected
        ?? (standaloneCodeWake ? { type: 'wake-check' } : null);
      const bareCommandInGrace = !effectiveWakeWord && inGracePeriod
        ? this.matchBareQueueCommand(transcript, { allowSwitch: true })
        : null;
      const indicateStartEligible = hasWakeWord || inGracePeriod;
      if (indicateEnabled && !indicateFinalized && indicateStartEligible && !this.ctx.indicateCaptureActive) {
        const shouldStartFromWake = hasWakeWord && (!preParsedCommand || preParsedCommand.type === 'wake-check');
        const shouldStartFromGrace = !hasWakeWord && inGracePeriod && !bareCommandInGrace;
        if (shouldStartFromWake || shouldStartFromGrace) {
          const seed = shouldStartFromWake
            ? (
              preParsedCommand?.type === 'wake-check'
                ? ''
                : this.stripLeadingWakePhrase(transcript)
            )
            : transcript.trim();

          // If the seed (content after wake word) is itself a bare queue command
          // like "go ahead" (read-ready), execute it as a command instead of
          // starting indicate capture with it as prompt content.
          const seedAsCommand = seed ? this.matchBareQueueCommand(seed) : null;
          if (seedAsCommand) {
            const resolvedSeedCommand = this.resolveDoneCommandForContext(seedAsCommand, transcript);
            // "Malibu, go ahead" → use the wake-word agent for agent-targeted read-ready
            if (resolvedSeedCommand.type === 'read-ready' && !resolvedSeedCommand.agent && explicitAddress?.kind === 'agent') {
              resolvedSeedCommand.agent = explicitAddress.agent.displayName;
            }
            console.log(`Indicate start bypassed — seed matched bare command: ${resolvedSeedCommand.type}`);
            await this.playFastCue('listening');
            await this.handleVoiceCommand(resolvedSeedCommand, userId);
            const totalMs = Date.now() - pipelineStart;
            console.log(`Voice command complete: ${totalMs}ms total`);
            return;
          }

          // Rapid-fire: wake word + content in the same segment can finalize
          // immediately when the user either included an explicit close or
          // spoke a complete one-shot prompt in the same breath.
          // V2 quick-mode default: a complete same-breath prompt with no
          // explicit conversational close is treated as background dispatch.
          // Grace-period entries (no wake word) should NOT rapid-fire — the
          // first segment is just the start of the user's thought, not a
          // complete utterance. Start indicate capture and wait for more speech.
          if (seed && shouldStartFromWake) {
            // Strip any trailing close/dismiss words the user might have
            // appended out of habit — use the content portion only.
            const seedTailClose = this.extractTailClose(seed);
            const seedContent = seedTailClose
              ? seedTailClose.content.trim()
              : seed.trim();
            const seedCloseType: IndicateCloseType | null = seedTailClose
              ? (seedTailClose.type === 'dismiss' ? 'dismiss' : 'conversational')
              : 'dismiss';
            const shouldAutoFinalize = !seedTailClose && this.shouldAutoFinalizeWakeSeed(seedContent);

            if ((seedTailClose || shouldAutoFinalize) && seedContent) {
              const finalizeReason = seedTailClose ? 'Rapid-fire finalized' : 'Single-shot finalized';
              console.log(`${finalizeReason} (${seedContent.length} chars)`);
              this.startIndicateCapture(seedContent);
              if (explicitAddress?.kind === 'agent') {
                this.ctx.indicateCaptureAddressedAgentId = explicitAddress.agent.id;
              }
              const finalized = this.flushIndicateCapture(seedTailClose ? 'rapid-fire' : 'single-shot');
              if (finalized) {
                this.stopWaitingLoop();
                await this.playFastCue('listening');
                transcript = finalized;
                indicateFinalized = true;
                if (seedCloseType) {
                  indicateCloseType = seedCloseType;
                }
                // Fall through to normal finalized-indicate dispatch below
              } else {
                this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
                return;
              }
            }
          }

          if (!indicateFinalized) {
            this.startIndicateCapture(seed);
            // Preserve the addressed agent so it can be used when the capture
            // finalizes — the wake word won't be present in the finalized
            // transcript, so resolveExplicitAddress would return null.
            if (explicitAddress?.kind === 'agent') {
              this.ctx.indicateCaptureAddressedAgentId = explicitAddress.agent.id;
            }
            if (preParsedCommand?.type === 'wake-check') {
              this.stopWaitingLoop();
              this.playReadyEarconSync();
            }
            this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
            return;
          }
        }
      }
      const suppressListeningCue = preParsedCommand?.type === 'wake-check';

      // Valid interaction confirmed — play listening earcon and wait for it to finish
      this.clearGraceTimer();
      if (!playedListeningEarly && !suppressListeningCue) {
        await this.playFastCue('listening');
      }
      if (graceFromPromptAtCapture || Date.now() < this.ctx.promptGraceUntil) {
        this.ctx.promptGraceUntil = 0;
      }

      // Gated mode: passed gate check — start waiting loop now
      if (gatedMode) {
        if (inGracePeriod && !effectiveWakeWord) {
          console.log('Gate grace period: processing without wake word');
        }
        if (gatedInterrupt) {
          if (partialPlaybackStoppedByPartial) {
            // Playback was already stopped by partial STT; preserve the
            // interrupt semantics without issuing another stop.
          } else if (gateClosedCueInterrupt && !effectiveWakeWord) {
            console.log('Gated interrupt: allowing speech over gate-closed cue');
            this.player.stopPlayback('speech-over-gate-closed-cue');
          } else if (!effectiveWakeWord && interruptGraceEligible) {
            console.log('Gated interrupt: accepted during ready handoff grace');
            this.player.stopPlayback('speech-during-playback-gated-grace');
          } else {
            console.log('Gated interrupt: wake word confirmed, interrupting playback');
            this.player.stopPlayback('speech-during-playback-gated-wake');
          }
          this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
        }
      }

      const command = preParsedCommand;
      if (command) {
        const resolvedCommand = this.resolveDoneCommandForContext(command, transcript);
        if (command.type === 'new-post') {
          // TODO: Remove once classifier creation is stable
          console.log('NEW_POST_FLOW (deprecated): use natural creation via route classifier');
          await this.startNewPostFlow();
          const totalMs = Date.now() - pipelineStart;
          console.log(`Voice command complete: ${totalMs}ms total`);
          return;
        } else {
          console.log(`Voice command detected: ${resolvedCommand.type}`);
          await this.handleVoiceCommand(resolvedCommand, userId);
          const totalMs = Date.now() - pipelineStart;
          console.log(`Voice command complete: ${totalMs}ms total`);
          return;
        }
      }

      // In background mode, or during grace windows, match bare navigation commands
      // without requiring the wake word.
      if (!indicateFinalized && (mode !== 'wait' || inGracePeriod)) {
        const bareCommand = this.matchBareQueueCommand(transcript, { allowSwitch: inGracePeriod });
        if (bareCommand) {
          const resolvedBareCommand = this.resolveDoneCommandForContext(bareCommand, transcript);
          console.log(`Bare queue command detected: ${resolvedBareCommand.type}`);
          await this.handleVoiceCommand(resolvedBareCommand, userId);
          const totalMs = Date.now() - pipelineStart;
          console.log(`Voice command complete: ${totalMs}ms total`);
          return;
        }
      }

      // Fallback command classifier (LLM): catches STT variations that regex misses.
      // During gated playback interrupts without wake word, avoid LLM command
      // inference to reduce false positives from cough/noise transcripts.
      const allowLlmInference = !(gatedInterrupt && !effectiveWakeWord)
        && explicitAddress?.kind !== 'agent'
        && !focusedPromptBypass;
      const runClassifier = allowLlmInference && this.shouldRunCommandClassifier(transcript);
      if (allowLlmInference && !runClassifier) {
        console.log('Skipping LLM command classifier for likely prompt utterance');
      }
      this.lastClassifierTimedOut = false;
      const preserveCurrentChannelForFollowup = this.shouldPreserveCurrentChannelForFollowupPrompt(explicitAddress);
      if (preserveCurrentChannelForFollowup) {
        console.log(`Follow-up prompt: preserving active channel "${this.router?.getActiveChannel().name ?? 'current'}"`);
      }

      let replyContextApplied = false;
      if (!preserveCurrentChannelForFollowup && this.hasActiveReplyContext()) {
        const replyAgentId = this.ctx.replyContextAgentId!;
        const replyChannelName = this.ctx.replyContextChannelName;
        const addressedDifferentAgent = explicitAddress?.kind === 'agent'
          && explicitAddress.agent.id !== replyAgentId;

        if (addressedDifferentAgent) {
          console.log(`Reply context overridden: user addressed ${explicitAddress!.agent.id}, reply context was ${replyAgentId}`);
          this.clearReplyContext();
        } else {
          if (replyChannelName && this.router) {
            const currentChannel = this.router.getActiveChannel().name;
            if (currentChannel !== replyChannelName) {
              const switchResult = await this.router.switchTo(replyChannelName);
              if (switchResult.success) {
                console.log(`Reply context: auto-switched to "${replyChannelName}" (agent=${replyAgentId})`);
              }
            }
          }

          const replyAgent = this.voiceTargets.getAgent(replyAgentId);
          if (replyAgent) {
            this.setFocusedAgent(replyAgent);
            console.log(`Reply context: focused agent set to ${replyAgent.displayName ?? replyAgentId}`);
          }

          replyContextApplied = true;
          this.clearReplyContext();
        }
      }

      // Run route classifier in parallel with command classifier.
      // The route result is only used when the command classifier returns "prompt"
      // (i.e., no command detected). Running in parallel adds zero latency.
      const strippedForRouting = explicitAddress
        ? this.stripExplicitAddressPrefix(transcript, explicitAddress)
        : transcript.trim();
      const routingWordCount = countRoutingWords(strippedForRouting);
      const routeClassifierPromise: Promise<RouteClassifierResult | null> =
        !preserveCurrentChannelForFollowup && !replyContextApplied && this.router && this.topicManager && this.projectManager
          ? inferRouteTarget(
              strippedForRouting,
              this.router,
              this.topicManager,
              this.projectManager,
              this.voiceTargets.listAgents(),
            ).catch((err: any) => {
              console.warn(`Route classifier error: ${err.message}`);
              return null;
            })
          : Promise.resolve(null);

      const [inferredCommand, routeResult] = await Promise.all([
        runClassifier
          ? this.inferVoiceCommandLLM(transcript, mode, inGracePeriod)
          : null,
        routeClassifierPromise,
      ]);
      if (inferredCommand) {
        const resolvedInferred = this.resolveDoneCommandForContext(inferredCommand, transcript);
        console.log(`Voice command detected (LLM): ${resolvedInferred.type}`);
        await this.handleVoiceCommand(resolvedInferred, userId);
        const totalMs = Date.now() - pipelineStart;
        console.log(`Voice command complete: ${totalMs}ms total`);
        return;
      }

      // Guard: discard likely-noise utterances that reached the prompt handler
      // without wake word.  When the classifier timed out we have zero signal —
      // short fragments are almost certainly filler ("Bye", "Mm", half-sentences).
      // Even without a timeout, single-word non-commands are never useful prompts.
      if (!effectiveWakeWord && !focusedPromptBypass) {
        const wordCount = transcript.trim().split(/\s+/).filter(Boolean).length;
        const threshold = this.lastClassifierTimedOut ? 5 : 2;
        if (wordCount < threshold) {
          console.log(
            `Discarding short non-command utterance (${wordCount} words, classifierTimeout=${this.lastClassifierTimedOut}): "${transcript.trim()}"`,
          );
          void this.playFastCue('error');
          this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
          return;
        }
      }

      if (Date.now() < this.ctx.newPostTimeoutPromptGuardUntil) {
        const remainingMs = this.ctx.newPostTimeoutPromptGuardUntil - Date.now();
        console.log(
          `Prompt dispatch suppressed by new-post timeout guard (${Math.max(0, remainingMs)}ms remaining)`,
        );
        await this.player.playEarcon('error');
        await this.speakResponse(
          'Post creation timed out. I did not send that message. Say create post to try again.',
          { inbox: true },
        );
        await this.playReadyEarcon();
        return;
      }

      this.cancelPendingWait('new prompt dispatch');
      // Auto-clear paused state — the user is actively talking to an agent.
      if (this.ctx.paused) {
        console.log('Auto-clearing paused state (new prompt dispatch)');
        this.ctx.paused = false;
        this.ctx.pausedFromText = '';
      }

      // Intelligent voice routing: decide WHERE this prompt should go.
      // The route classifier (run in parallel above) may override the default
      // agent-channel auto-switch when the transcript content matches an
      // existing thread, topic, or non-default channel.
      if (preserveCurrentChannelForFollowup) {
        this.consumeFollowupPromptGrace();
      }
      let routeApplied = false;
      const effectiveThresholds = computeEffectiveThresholds(
        explicitAddress,
        strippedForRouting,
        routeResult,
        routingWordCount,
      );
      const createBlocked = shouldBlockCreateAction(
        explicitAddress,
        strippedForRouting,
        routeResult,
        routingWordCount,
      );
      const targetMentionedInTranscript = routeResult?.targetMentionedInTranscript
        ?? transcriptMentionsRouteTargetName(strippedForRouting, routeResult?.targetName);
      const meetsHighConfidenceThreshold = Boolean(
        routeResult
          && routeResult.action === 'route'
          && routeResult.confidence > effectiveThresholds.highThreshold,
      );
      const meetsMediumConfidenceThreshold = Boolean(
        routeResult
          && routeResult.action === 'route'
          && routeResult.confidence >= effectiveThresholds.mediumThreshold
          && routeResult.confidence <= effectiveThresholds.highThreshold,
      );

      let allowAutoRoute = meetsHighConfidenceThreshold;
      let allowRouteConfirmation = meetsMediumConfidenceThreshold;
      if (routeResult?.action === 'route') {
        if (effectiveThresholds.blocked) {
          if (allowAutoRoute || allowRouteConfirmation) {
            console.log(
              `Route classifier: skipped "${routeResult.targetName ?? routeResult.target ?? 'target'}" because the addressed-agent prompt did not mention the target by name`,
            );
          }
          allowAutoRoute = false;
          allowRouteConfirmation = false;
        } else if (routeResult.recencyLabel === 'very-stale' && !targetMentionedInTranscript) {
          if (allowAutoRoute || allowRouteConfirmation) {
            console.log(
              `Route classifier: blocked very stale target "${routeResult.targetName ?? routeResult.target ?? 'target'}" because it was not explicitly named in the transcript`,
            );
          }
          allowAutoRoute = false;
          allowRouteConfirmation = false;
        } else if (routeResult.recencyLabel === 'stale' && allowRouteConfirmation) {
          console.log(
            `Route classifier: skipped medium-confidence confirmation for stale target "${routeResult.targetName ?? routeResult.target ?? 'target'}"`,
          );
          allowRouteConfirmation = false;
        }
      }

      if (createBlocked && routeResult?.action === 'create') {
        console.log(
          `Route classifier: blocked create action "${routeResult.createTitle}" — ${
            explicitAddress?.kind === 'agent' ? 'callsign priority' : 'short/ambiguous input'
          } gate applied`,
        );
      }

      if (routeResult && allowAutoRoute && routeResult.target && this.router) {
        // High confidence: auto-route to the matched target
        const switchResult = await this.router.switchTo(routeResult.target);
        if (switchResult.success) {
          routeApplied = true;
          console.log(`Route classifier: auto-switched to "${routeResult.targetName}" (${switchResult.displayName ?? routeResult.target}, confidence: ${routeResult.confidence.toFixed(2)})`);
          // Brief spoken confirmation
          void this.speakResponse(`Routed to ${routeResult.targetName?.replace(/\s*\(in .*\)$/, '') ?? switchResult.displayName ?? 'target'}.`, { inbox: true });
        }
      } else if (routeResult && !createBlocked && isHighCreateConfidence(routeResult) && routeResult.createTitle && routeResult.target && this.router) {
        // High-confidence creation: auto-create thread/post
        const targetType = routeResult.targetType;
        let createResult;
        if (targetType === 'forum') {
          createResult = await this.router.createForumPost(routeResult.target, routeResult.createTitle, 'New voice thread.');
        } else {
          createResult = await this.router.createChannelThread(routeResult.target, routeResult.createTitle, 'New voice thread.');
        }
        if (createResult.success) {
          routeApplied = true;
          invalidateRouteTargetCache();
          this.setPromptGrace(15_000);
          console.log(`Route classifier: auto-created "${routeResult.createTitle}" (confidence: ${routeResult.confidence.toFixed(2)})`);
          void this.speakResponse(`Created ${routeResult.createTitle}.`, { inbox: true });
          // Dispatch full transcript to the new thread
          await this.dispatchPromptWithIntent(userId, transcript, mode, indicateCloseType ?? null);
          return;
        }
        // On failure, fall through to normal dispatch
        console.warn(`Route classifier: creation failed: ${createResult.error}`);
      } else if (routeResult && !createBlocked && isMediumCreateConfidence(routeResult) && routeResult.createTitle && routeResult.target && routeResult.targetName) {
        // Medium-confidence creation: ask user to confirm
        const question = `Create ${routeResult.createTitle} in ${routeResult.targetName?.replace(/\s*\(.*\)$/, '') ?? 'channel'}?`;
        const currentChannel = this.router?.getActiveChannel() as any;
        const currentChannelId = currentChannel?.channelId || '';
        const fallbackChannelId = explicitAddress?.kind === 'agent'
          && explicitAddress.agent.defaultChannelId
          && explicitAddress.agent.defaultChannelId !== currentChannelId
          ? explicitAddress.agent.defaultChannelId
          : null;
        console.log(`Route classifier: asking create confirmation — "${question}" (confidence: ${routeResult.confidence.toFixed(2)})`);

        this.transitionAndResetWatchdog({
          type: 'ENTER_ROUTE_CONFIRMATION',
          userId,
          transcript,
          targetId: routeResult.target,
          targetName: routeResult.targetName,
          confirmAction: 'create',
          createTitle: routeResult.createTitle,
          createTargetType: routeResult.targetType === 'forum' ? 'forum' : 'channel',
          deliveryMode: mode,
          closeType: indicateCloseType ?? null,
          fallbackChannelId,
        });
        await this.speakResponse(question, { inbox: true });
        await this.player.playEarcon('question');
        this.transitionAndResetWatchdog({ type: 'REFRESH_AWAITING_TIMEOUT' });
        return;
      } else if (routeResult && allowRouteConfirmation && routeResult.target && routeResult.targetName) {
        // Medium confidence: ask user to confirm before routing
        const question = this.formatRouteConfirmationQuestion(routeResult.targetName);
        const currentChannel = this.router?.getActiveChannel() as any;
        const currentChannelId = currentChannel?.channelId || '';
        const fallbackChannelId = explicitAddress?.kind === 'agent'
          && explicitAddress.agent.defaultChannelId
          && explicitAddress.agent.defaultChannelId !== currentChannelId
          ? explicitAddress.agent.defaultChannelId
          : null;
        console.log(`Route classifier: asking confirmation — "${question}" (confidence: ${routeResult.confidence.toFixed(2)})`);

        this.transitionAndResetWatchdog({
          type: 'ENTER_ROUTE_CONFIRMATION',
          userId,
          transcript,
          targetId: routeResult.target,
          targetName: routeResult.targetName,
          deliveryMode: mode,
          closeType: indicateCloseType ?? null,
          fallbackChannelId,
        });
        await this.speakResponse(question, { inbox: true });
        await this.player.playEarcon('question');
        this.transitionAndResetWatchdog({ type: 'REFRESH_AWAITING_TIMEOUT' });
        return;
      }

      // Fall back to agent's default channel if route classifier didn't override.
      // This is the existing behavior: addressing an agent auto-switches to their channel.
      if (!preserveCurrentChannelForFollowup && !replyContextApplied && !routeApplied && explicitAddress?.kind === 'agent' && explicitAddress.agent.defaultChannelId && this.router) {
        const agentChannelId = explicitAddress.agent.defaultChannelId;
        const currentChannel = this.router.getActiveChannel();
        const currentDef = currentChannel as any;
        const currentChannelId = currentDef?.channelId || '';
        if (currentChannelId !== agentChannelId) {
          const switchResult = await this.router.switchTo(agentChannelId);
          if (switchResult.success) {
            console.log(`Auto-switched to ${explicitAddress.agent.displayName}'s channel (${switchResult.displayName ?? agentChannelId})`);
          }
        }
      }

      await this.dispatchPromptWithIntent(userId, transcript, mode, indicateCloseType ?? null);

      const totalMs = Date.now() - pipelineStart;
      console.log(`Pipeline complete: ${totalMs}ms total`);
    } catch (error) {
      console.error('Pipeline error:', error);
      this.counters.errors++;
      const dependencyIssue = this.classifyDependencyIssue(error);
      if (dependencyIssue) {
        if (dependencyIssue.type === 'stt') this.counters.sttFailures++;
        if (dependencyIssue.type === 'tts') this.counters.ttsFailures++;
        this.notifyDependencyIssue(dependencyIssue.type, dependencyIssue.message);
      } else {
        void this.playFastCue('error');
      }
      this.stopWaitingLoop();
      this.player.stopPlayback('pipeline-error');
    } finally {
      // Don't overwrite AWAITING/flow states — they were set intentionally by handlers
      const st = this.stateMachine.getStateType();
      if (!keepCurrentState && !this.stateMachine.isAwaitingState() && st !== 'INBOX_FLOW') {
        this.transitionAndResetWatchdog({ type: 'PROCESSING_COMPLETE' });
      }

      // Run invariant checks
      const violations = checkPipelineInvariants(this.getInvariantContext());
      this.counters.invariantViolations += violations.length;

      // Re-process buffered utterance if any
      const buffered = this.stateMachine.getBufferedUtterance();
      if (buffered) {
        console.log('Re-processing buffered utterance');
        // Use setImmediate to avoid deep recursion
        setImmediate(() => {
          this.handleUtterance(buffered.userId, buffered.wavBuffer, buffered.durationMs);
        });
      }
    }
  }

  private handleRejectedAudio(userId: string, durationMs: number): void {
    if (!this.stateMachine.isAwaitingState()) return;
    const st = this.stateMachine.getStateType();
    // Avoid noisy reprompt loops in command-selection states.
    // Keep this only for guided new-post flow where users benefit from correction.
    if (st !== 'NEW_POST_FLOW') return;
    if (this.player.isPlaying() || this.isProcessing()) {
      console.log(`Rejected audio ignored during active playback/processing from ${userId} (${durationMs}ms)`);
      return;
    }
    // Suppress noise-triggered reprompts during the grace window after a ready cue.
    // The earcon itself can cause echo/noise that gets picked up as a short utterance,
    // leading to confusing error + reprompt sequences before the user has a chance to speak.
    const now = Date.now();
    if (now < this.ctx.gateGraceUntil || now < this.ctx.promptGraceUntil) {
      console.log(`Rejected audio ignored during grace window from ${userId} (${durationMs}ms) [gateGrace=${this.ctx.gateGraceUntil - now}ms promptGrace=${this.ctx.promptGraceUntil - now}ms]`);
      return;
    }
    // Secondary guard: suppress noise that arrives shortly after any playback
    // finishes. Earcon echo and ambient noise from TTS can trigger false
    // rejections before the user has had time to speak. The grace window
    // above handles the normal case, but edge-case timing (noise captured
    // during TTS when grace was cleared, callback arriving just after grace
    // is re-set) can slip through. A 2-second post-playback cooldown
    // catches these stragglers.
    const POST_PLAYBACK_REJECT_COOLDOWN_MS = 2_000;
    if (this.ctx.lastPlaybackCompletedAt > 0 && now - this.ctx.lastPlaybackCompletedAt < POST_PLAYBACK_REJECT_COOLDOWN_MS) {
      console.log(`Rejected audio ignored (post-playback cooldown, ${now - this.ctx.lastPlaybackCompletedAt}ms since playback) from ${userId} (${durationMs}ms)`);
      return;
    }
    if (durationMs > VoicePipeline.MAX_REJECTED_REPROMPT_MS) {
      console.log(`Rejected audio ignored (too long for reprompt) from ${userId} (${durationMs}ms)`);
      return;
    }
    if (this.ctx.rejectRepromptInFlight) return;
    if (Date.now() < this.ctx.rejectRepromptCooldownUntil) return;

    this.ctx.rejectRepromptInFlight = true;
    this.ctx.rejectRepromptCooldownUntil = Date.now() + 5000;
    console.log(`Rejected low-confidence audio during ${st} from ${userId} (${durationMs}ms)`);

    void (async () => {
      try {
        const effects = this.transitionAndResetWatchdog({ type: 'AWAITING_INPUT_RECEIVED', recognized: false });
        await this.applyEffects(effects);
        await this.playReadyEarcon();
      } finally {
        this.ctx.rejectRepromptInFlight = false;
      }
    })();
  }

  private async handleVoiceCommand(command: VoiceCommand, userId = 'voice-user'): Promise<void> {
    this.counters.commandsRecognized++;
    // Any explicit command means user intent is clear; clear transient post-timeout guard.
    this.ctx.newPostTimeoutPromptGuardUntil = 0;
    this.consumeFollowupPromptGrace();
    // Auto-clear paused state when the user issues a new command (except pause/resume).
    // Pause was only meant to stop current playback, not block the system indefinitely.
    if (this.ctx.paused && command.type !== 'pause' && command.type !== 'resume') {
      console.log(`Auto-clearing paused state (voice command: ${command.type})`);
      this.ctx.paused = false;
      this.ctx.pausedFromText = '';
    }
    if (command.type !== 'silent-wait') {
      this.cancelPendingWait(`voice command: ${command.type}`);
    }
    if (command.type === 'switch' || command.type === 'list' || command.type === 'default') {
      this.clearInboxFlowIfActive(`voice command: ${command.type}`);
    }
    switch (command.type) {
      case 'switch':
        await this.handleDirectSwitch(command.channel);
        break;
      case 'focus-agent':
        await this.handleFocusAgent(command.agent);
        break;
      case 'open-topic':
        await this.handleOpenTopic(command);
        break;
      case 'move-topic-to-project':
        await this.handleMoveTopicToProject(command);
        break;
      case 'detach-topic-from-project':
        await this.handleDetachTopicFromProject(command);
        break;
      case 'current-topic':
        await this.handleCurrentTopic();
        break;
      case 'clear-topic':
        await this.handleClearTopic();
        break;
      case 'open-project':
        await this.handleOpenProject(command.projectName);
        break;
      case 'current-project':
        await this.handleCurrentProject();
        break;
      case 'clear-project':
        await this.handleClearProject();
        break;
      case 'clear-focus':
        await this.handleClearFocus();
        break;
      case 'current-agent':
        await this.handleCurrentAgent();
        break;
      case 'list':
        await this.handleListChannels();
        break;
      case 'default':
        await this.handleDefaultSwitch();
        break;
      case 'noise':
        await this.handleNoise(command.level);
        break;
      case 'delay':
        await this.handleDelay(command.value);
        break;
      case 'delay-adjust':
        await this.handleDelayAdjust(command.direction);
        break;
      case 'indicate-timeout':
        await this.handleIndicateTimeout(command.valueMs);
        break;
      case 'settings':
        await this.handleReadSettings();
        break;
      case 'mode':
        await this.handleModeSwitch(command.mode);
        break;
      case 'inbox-check':
        await this.handleInboxCheck();
        break;
      case 'inbox-next':
        await this.handleInboxNext();
        break;
      case 'inbox-clear':
        await this.handleInboxClear();
        break;
      case 'read-last-message':
        await this.handleReadLastMessage();
        break;
      case 'what-channel':
        await this.handleWhatChannel();
        break;
      case 'voice-status':
        await this.handleVoiceStatus();
        break;
      case 'voice-channel':
        await this.handleVoiceChannel();
        break;
      case 'gated-mode':
        await this.handleGatedMode(command.enabled);
        break;
      case 'endpoint-mode':
        await this.handleEndpointMode(command.mode);
        break;
      case 'wake-check':
        await this.handleWakeCheck();
        break;
      case 'silent-wait':
        await this.handleSilentWait();
        break;
      case 'hear-full-message':
        await this.handleHearFullMessage();
        break;
      case 'inbox-respond':
        await this.handleInboxRespond();
        break;
      case 'inbox-summarize':
        await this.handleInboxSummarize();
        break;
      case 'pause':
        await this.handlePause();
        break;
      case 'resume':
        await this.handleResume();
        break;
      case 'replay':
        await this.handleReplay();
        break;
      case 'earcon-tour':
        await this.handleEarconTour();
        break;
      case 'whats-up':
        await this.handleWhatsUp();
        break;
      case 'read-ready':
        await this.handleReadReady(command.agent);
        break;
      case 'inbox-topic-select':
        await this.handleInboxTopicSelect(command.query);
        break;
      case 'inbox-read-all':
        await this.handleInboxReadAll();
        break;
    }
  }

  private async startNewPostFlow(): Promise<void> {
    if (!this.router) return;

    const forums = this.router.listForumChannels();
    if (forums.length === 0) {
      await this.speakResponse('There are no forum channels available.');
      return;
    }

    this.transitionAndResetWatchdog({
      type: 'ENTER_NEW_POST_FLOW',
      step: 'forum',
    });

    await this.speakResponse('Which forum?');
    await this.playReadyEarcon();
  }

  private async handleNewPostStep(transcript: string): Promise<void> {
    const flowState = this.stateMachine.getNewPostFlowState();
    if (!flowState || !this.router) return;

    const { step } = flowState;

    if (step === 'forum') {
      const input = transcript.trim().toLowerCase().replace(/[.!?,]+$/, '');

      // Check for cancel
      if (this.isCancelIntent(input)) {
        const effects = this.transitionAndResetWatchdog({ type: 'CANCEL_FLOW' });
        await this.applyEffects(effects);
        await this.speakResponse('Cancelled.');
        return;
      }

      // Check for list channels request
      if (/\b(?:list|show|what are|which)\b.*\b(?:channel|channels|forum|forums|options)\b/.test(input) || /\b(?:list)\b/.test(input)) {
        const forums = this.router.listForumChannels();
        const names = forums.map((f) => f.name).join(', ');
        await this.repromptAwaiting();
        await this.speakResponse(`Available forums: ${names}. Which one?`);
        await this.playReadyEarcon();
        return;
      }

      const match = this.router.findForumChannel(input);
      if (!match) {
        await this.repromptAwaiting();
        await this.speakResponse(`I couldn't find a forum matching "${transcript}". Try again, or say cancel.`);
        await this.playReadyEarcon();
        return;
      }

      this.transitionAndResetWatchdog({
        type: 'NEW_POST_ADVANCE',
        step: 'title',
        forumId: match.id,
        forumName: match.name,
      });

      await this.player.playEarcon('acknowledged');
      await this.speakResponse(`Got it, ${match.name}. What should the post be called?`);
      await this.playReadyEarcon();
      return;
    }

    if (step === 'title') {
      const input = transcript.trim().replace(/[.!?]+$/, '');

      if (this.isCancelIntent(input)) {
        const effects = this.transitionAndResetWatchdog({ type: 'CANCEL_FLOW' });
        await this.applyEffects(effects);
        await this.speakResponse('Cancelled.');
        return;
      }

      const { forumId, forumName } = flowState;

      // Use a generic activation body that invites the agent to respond
      // quickly, bootstrapping the thread context. The natural latency of
      // TTS confirmation + the user formulating their prompt gives the agent
      // time to reply before the first real voice interaction arrives.
      const activationBody = 'New voice thread. Let me know when you\'re ready.';
      const result = await this.router.createForumPost(forumId!, input, activationBody);
      if (result.success) {
        await this.onChannelSwitch();
        console.log(`Created forum post "${input}" in ${result.forumName}, switched to thread ${result.threadId}`);
        // Suppress notifications BEFORE any playback so the activation
        // body response can't slip through during the TTS await gap.
        this.setPromptGrace(15_000);
        await this.player.playEarcon('acknowledged');
        await this.speakResponse(`Created ${input} in ${forumName}. Go ahead.`);
        // Return to IDLE only after all confirmation audio is queued so
        // deferred notifications can't sneak in during post creation.
        this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
        await this.playReadyEarcon();
      } else {
        this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
        console.warn(`Forum post creation failed: ${result.error}`);
        await this.speakResponse(`Sorry, I couldn't create the post. ${result.error}`);
      }
    }
  }

  private isCancelIntent(text: string): boolean {
    const normalized = text
      .toLowerCase()
      .replace(/[.!?,]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return /\b(?:cancel|nevermind|never mind|forget it|stop)\b/.test(normalized);
  }

  private async handleDirectSwitch(channelName: string): Promise<void> {
    if (!this.router) return;

    const mode = this.getCurrentVoiceMode('wait');
    if (mode === 'wait') {
      this.startWaitingLoop();
    }
    try {
      // Channel resolution can take a moment (fuzzy + LLM fallback).
      // Confirm acceptance immediately so long silences feel intentional.
      await this.playFastCue('acknowledged');

      // Try to find the channel by fuzzy matching against known channels
      const allChannels = this.router.listChannels();
      const fuzzyMatches = allChannels.filter((c) => this.channelNamesMatch(channelName, c.name, c.displayName));

      // If multiple fuzzy matches, prefer an exact name match
      let match: typeof allChannels[number] | undefined;
      if (fuzzyMatches.length === 1) {
        match = fuzzyMatches[0];
      } else if (fuzzyMatches.length > 1) {
        const inputNorm = channelName.trim().toLowerCase();
        match = fuzzyMatches.find(
          (c) => c.name.toLowerCase() === inputNorm || c.displayName.toLowerCase() === inputNorm,
        );
        // No exact match among multiple fuzzy hits → fall through to LLM disambiguation
      }

      // Atlas-backed phrase memory: resolve previously successful spoken aliases
      // before invoking slower dynamic/LLM matching.
      if (!match) {
        const lookupAlias = (this.router as unknown as {
          lookupSwitchAlias?: (query: string) => Promise<{ channelId: string; displayName: string } | null>;
        }).lookupSwitchAlias;
        const cachedAlias = lookupAlias
          ? await lookupAlias.call(this.router, channelName)
          : null;
        if (cachedAlias) {
          console.log(`Alias cache match: "${channelName}" → ${cachedAlias.channelId}`);
          const aliasResult = await this.router.switchTo(cachedAlias.channelId);
          if (aliasResult.success) {
            await this.onChannelSwitch();
            this.rememberSwitchAlias(channelName);
            const displayName = aliasResult.displayName || cachedAlias.displayName || channelName;
            await this.speakResponse(`Switched to ${displayName}.`, { inbox: true });
            await this.playReadyEarcon();
            this.allowFollowupPromptGrace(VoicePipeline.FOLLOWUP_PROMPT_GRACE_MS);
            return;
          }
        }
      }

      // Fallback: scan guild sendable channels/threads directly by name so
      // non-static channels can resolve without waiting on LLM matching.
      if (!match) {
        const findDirectChannel = (this.router as unknown as {
          findSendableChannelByName?: (query: string) => Promise<{ id: string; displayName: string } | null>;
        }).findSendableChannelByName;
        const directMatch = findDirectChannel
          ? await findDirectChannel.call(this.router, channelName)
          : null;
        if (directMatch) {
          console.log(`Direct guild channel match: "${channelName}" → ${directMatch.id}`);
          const directResult = await this.router.switchTo(directMatch.id);
          if (directResult.success) {
            await this.onChannelSwitch();
            this.rememberSwitchAlias(channelName);
            const displayName = directResult.displayName || directMatch.displayName || channelName;
            await this.speakResponse(`Switched to ${displayName}.`, { inbox: true });
            await this.playReadyEarcon();
            this.allowFollowupPromptGrace(VoicePipeline.FOLLOWUP_PROMPT_GRACE_MS);
            return;
          }
        }
      }

      // LLM fallback: if string matching failed or was ambiguous, ask the utility model (include forum threads)
      if (!match) {
        const forumThreads = await this.router.getForumThreads();
        const allCandidates = [
          ...allChannels.map((c) => ({ name: c.name, displayName: c.displayName })),
          ...forumThreads.map((t) => ({ name: t.name, displayName: t.displayName })),
        ];
        const llmResult = await this.matchChannelWithLLM(channelName, allCandidates);
        if (llmResult) {
          if ('best' in llmResult) {
            match = allChannels.find((c) => c.name === llmResult.best.name) ?? undefined;
            // If not a static channel, it might be a forum thread — switch by numeric ID
            if (!match && llmResult.best.name.startsWith('id:')) {
              const threadId = llmResult.best.name.slice(3);
              const threadResult = await this.router.switchTo(threadId);
              if (threadResult.success) {
                await this.onChannelSwitch();
                this.rememberSwitchAlias(channelName);
                const displayName = threadResult.displayName || llmResult.best.displayName;
                await this.speakResponse(`Switched to ${displayName}.`, { inbox: true });
                await this.playReadyEarcon();
                this.allowFollowupPromptGrace(VoicePipeline.FOLLOWUP_PROMPT_GRACE_MS);
                return;
              }
            }
          } else if ('options' in llmResult && llmResult.options.length > 0) {
            // Ambiguous — present options using the selection flow
            const options: ChannelOption[] = llmResult.options.map((ch, i) => ({
              index: i + 1,
              name: ch.name,
              displayName: ch.displayName,
            }));

            const lines = options.map((o) => `${o.index}: ${o.displayName}`);
            const responseText = `No exact match for ${channelName}. Did you mean: ${lines.join('. ')}? Say a number or channel name.`;

            this.transitionAndResetWatchdog({
              type: 'ENTER_CHANNEL_SELECTION',
              options,
            });

            await this.speakResponse(responseText, { inbox: true });
            await this.playReadyEarcon();
            return;
          }
        }
      }

      const target = match ? match.name : channelName;
      const result = await this.router.switchTo(target);

      let responseText: string;
      if (result.success) {
        await this.onChannelSwitch();
        this.rememberSwitchAlias(channelName);
        const activeSessionKey = this.router.getActiveSessionKey();

        responseText = `Switched to ${result.displayName || target}.`;
      } else {
        responseText = `I couldn't find a channel called ${channelName}.`;
      }

      await this.speakResponse(responseText, { inbox: true });
      await this.playReadyEarcon();
      if (result.success) {
        this.allowFollowupPromptGrace(VoicePipeline.FOLLOWUP_PROMPT_GRACE_MS);
      }
    } finally {
      this.stopWaitingLoop();
    }
  }

  private async matchChannelWithLLM(
    userPhrase: string,
    channels: { name: string; displayName: string }[],
  ): Promise<{ best: { name: string; displayName: string }; confident: boolean } | { options: { name: string; displayName: string }[] } | null> {
    try {
      const channelList = channels.map((c) => `${c.name}: ${c.displayName}`).join('\n');

      const signal = AbortSignal.timeout(3000);
      const result = await quickCompletion(
        `You are a channel matcher. Given a list of channels and a user description, rank the top matches.
Reply in this exact format:
- If one channel is a clear match: BEST: channel_name
- If 2-3 channels could match: OPTIONS: channel1, channel2, channel3
- If nothing matches: NONE
Use channel names (the part before the colon). Do not explain.`,
        `Channels:\n${channelList}\n\nUser wants: "${userPhrase}"`,
        120,
        signal,
      );

      const cleaned = result.trim();
      console.log(`LLM channel match result: "${cleaned}"`);

      const findChannel = (query: string) =>
        channels.find((c) => this.channelNamesMatch(query, c.name, c.displayName));

      // Parse BEST: single confident match
      const bestMatch = cleaned.match(/^BEST:\s*(.+)$/i);
      if (bestMatch) {
        const name = bestMatch[1].trim().toLowerCase();
        const matched = findChannel(name);
        if (matched) {
          console.log(`LLM channel match: "${userPhrase}" → ${matched.name} (confident)`);
          return { best: matched, confident: true };
        }
      }

      // Parse OPTIONS: multiple candidates
      const optionsMatch = cleaned.match(/^OPTIONS:\s*(.+)$/i);
      if (optionsMatch) {
        const names = optionsMatch[1].split(',').map((n) => n.trim().toLowerCase());
        const resolved = names
          .map((n) => findChannel(n))
          .filter((c): c is { name: string; displayName: string; active: boolean } => c != null);
        if (resolved.length > 0) {
          console.log(`LLM channel match: "${userPhrase}" → ${resolved.length} options`);
          return { options: resolved };
        }
      }

      // Single name without prefix (backwards compat / fallback)
      const fallback = findChannel(cleaned.toLowerCase());
      if (fallback) {
        return { best: fallback, confident: true };
      }

      return null;
    } catch (err: any) {
      console.warn(`LLM channel match failed: ${err.message}`);
      return null;
    }
  }

  private async handleListChannels(): Promise<void> {
    if (!this.router) return;

    const recent = this.router.getRecentChannels(5);
    if (recent.length === 0) {
      await this.speakResponse('There are no other channels available.');
      return;
    }

    const options: ChannelOption[] = recent.map((ch, i) => ({
      index: i + 1,
      name: ch.name,
      displayName: ch.displayName,
    }));

    const lines = options.map((o) => `${o.index}: ${o.displayName}`);
    const responseText = `Here are your recent channels. ${lines.join('. ')}. Say a number or channel name.`;

    // Enter selection mode via state machine
    this.transitionAndResetWatchdog({
      type: 'ENTER_CHANNEL_SELECTION',
      options,
    });

    await this.speakResponse(responseText);
    await this.playReadyEarcon();
  }

  private async handleChannelSelection(transcript: string): Promise<void> {
    const selState = this.stateMachine.getChannelSelectionState();
    if (!selState || !this.router) return;

    const { options } = selState;
    const selected = matchChannelSelection(transcript, options);

    if (!selected) {
      // Unrecognized — reprompt with error earcon
      await this.repromptAwaiting();
      await this.playReadyEarcon();
      return;
    }

    // Recognized — clear the awaiting state
    this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
    await this.acknowledgeAwaitingChoice();

    const result = await this.router.switchTo(selected.name);
    if (result.success) {
      await this.onChannelSwitch();
      await this.speakResponse(this.buildSwitchConfirmation(result.displayName || selected.displayName));
      await this.playReadyEarcon();
      this.allowFollowupPromptGrace(VoicePipeline.FOLLOWUP_PROMPT_GRACE_MS);
    } else {
      await this.speakResponse(`I couldn't switch to ${selected.displayName}.`);
      await this.playReadyEarcon();
    }
  }

  private async handleDefaultSwitch(): Promise<void> {
    if (!this.router) return;

    const result = await this.router.switchToDefault();
    if (result.success) {
      await this.onChannelSwitch();
      await this.speakResponse(`Switched back to ${result.displayName || 'default'}.`);
      await this.playReadyEarcon();
      this.allowFollowupPromptGrace(VoicePipeline.FOLLOWUP_PROMPT_GRACE_MS);
    } else {
      await this.speakResponse("I couldn't switch to the default channel.");
      await this.playReadyEarcon();
    }
  }

  private async handleNoise(level: string): Promise<void> {
    const resolved = resolveNoiseLevel(level);
    if (!resolved) {
      await this.speakResponse("I didn't recognize that noise level. Try low, medium, or high.");
      await this.playReadyEarcon();
      return;
    }
    setSpeechThreshold(resolved.threshold);
    await this.speakResponse(`Noise threshold set to ${resolved.label}.`);
    await this.playReadyEarcon();
  }

  private async handleDelay(value: number): Promise<void> {
    const clamped = Math.max(500, Math.min(10000, value));
    setSilenceDuration(clamped);
    await this.speakResponse(`Silence delay set to ${clamped} milliseconds.`);
    await this.playReadyEarcon();
  }

  private async handleIndicateTimeout(valueMs: number): Promise<void> {
    const clamped = Math.max(10_000, Math.min(60 * 60 * 1000, valueMs));
    setIndicateTimeoutMs(clamped);
    if (this.ctx.indicateCaptureActive) {
      this.armIndicateCaptureTimeout();
    }
    const timeoutLabel = clamped % 60_000 === 0
      ? `${clamped / 60_000} minute${clamped === 60_000 ? '' : 's'}`
      : `${Math.round(clamped / 1000)} seconds`;
    await this.speakResponse(`Indicate timeout set to ${timeoutLabel}.`);
    await this.playReadyEarcon();
  }

  private async handleDelayAdjust(direction: 'longer' | 'shorter'): Promise<void> {
    const current = getVoiceSettings().silenceDurationMs;
    const delta = direction === 'longer' ? 500 : -500;
    const updated = Math.max(500, Math.min(10000, current + delta));
    setSilenceDuration(updated);
    const verb = direction === 'longer' ? 'increased' : 'decreased';
    await this.speakResponse(`Silence delay ${verb} to ${updated} milliseconds.`);
    await this.playReadyEarcon();
  }

  private async handleReadSettings(): Promise<void> {
    const s = getVoiceSettings();
    const closeCommands = s.indicateCloseWords ?? [];
    const wakeName = this.getSystemWakeName();
    const streamingText = s.sttStreamingEnabled
      ? `Streaming transcription: on, ${s.sttStreamingChunkMs} millisecond chunks.`
      : 'Streaming transcription: off.';
    const endpointText = s.endpointingMode === 'indicate'
      ? `Endpointing: indicate. End command examples: ${
        closeCommands.length > 0
          ? closeCommands.slice(0, 2).map((c) => `${wakeName}, ${c}`).join(' or ')
          : `${wakeName}, I'm done`
      }, or just ${wakeName}. Timeout: ${Math.round(s.indicateTimeoutMs / 1000)} seconds.`
      : 'Endpointing: silence.';
    await this.speakResponse(
      `Audio processing: ${s.audioProcessing}. ` +
      `${endpointText} ` +
      `${streamingText} ` +
      `Silence delay: ${s.silenceDurationMs} milliseconds. ` +
      `Noise threshold: ${s.speechThreshold}. ` +
      `Minimum speech duration: ${s.minSpeechDurationMs} milliseconds.`,
    );
    await this.playReadyEarcon();
  }

  private async handleVoiceChannel(): Promise<void> {
    if (this.router) {
      const active = this.router.getActiveChannel();
      const displayName = (active as any).displayName || active.name;
      await this.speakResponse(displayName, { inbox: true });
    } else {
      await this.speakResponse('No channel active.', { inbox: true });
    }
    await this.playReadyEarcon();
  }

  private async handleWhatChannel(): Promise<void> {
    if (!this.router) {
      await this.speakResponse('Channel routing is not available right now.', { inbox: true });
      await this.playReadyEarcon();
      return;
    }
    const active = this.router.getActiveChannel();
    const displayName = (active as any).displayName || active.name;
    await this.speakResponse(displayName, { inbox: true });
    await this.playReadyEarcon();
  }

  private async handleVoiceStatus(): Promise<void> {
    const parts: string[] = [];

    // Mode
    const modeLabel = getVoiceModeLabel(this.getCurrentVoiceMode('wait'));
    const gateLabel = getVoiceSettings().gated ? 'gated' : 'open';
    parts.push(`Mode: ${modeLabel}, ${gateLabel}.`);

    // Active channel
    if (this.router) {
      const active = this.router.getActiveChannel();
      const displayName = (active as any).displayName || active.name;
      parts.push(`Channel: ${displayName}.`);
    }

    const focusedAgent = this.getFocusedAgent();
    if (focusedAgent) {
      parts.push(`Focused agent: ${focusedAgent.displayName}.`);
    } else {
      parts.push('Focused agent: none.');
    }

    if (this.router) {
      const active = this.router.getActiveChannel();
      const topic = this.getFocusedTopic(active.name);
      if (topic) {
        parts.push(`Topic: ${topic.title}.`);
      } else {
        parts.push('Topic: none.');
      }
    }

    // Queue items
    if (this.queueState) {
      const ready = this.queueState.getReadyItems().length;
      const pending = this.queueState.getPendingItems().length;
      if (ready > 0 || pending > 0) {
        const qParts: string[] = [];
        if (ready > 0) qParts.push(`${ready} ready`);
        if (pending > 0) qParts.push(`${pending} processing`);
        parts.push(`Queue: ${qParts.join(', ')}.`);
      }
    }

    // Notification diagnostics
    const notifyQueue = this.idleNotifyQueue.length;
    if (
      notifyQueue > 0
      || this.counters.idleNotificationsDelivered > 0
      || this.counters.idleNotificationsDropped > 0
    ) {
      parts.push(
        `Notifications: ${notifyQueue} queued, ${this.counters.idleNotificationsDelivered} delivered, ${this.counters.idleNotificationsDropped} dropped.`,
      );
    }

    const activeChannel = this.router?.getActiveChannel().name ?? null;
    if (activeChannel) {
      const currentProject = this.getActiveProject(activeChannel);
      if (currentProject) {
        parts.push(`Project: ${currentProject.displayName}.`);
      }
      const currentTopic = this.getFocusedTopic(activeChannel);
      if (currentTopic) {
        parts.push(`Topic: ${currentTopic.title}.`);
      }
    }

    // Voice settings
    const s = getVoiceSettings();
    const presetMap: Record<number, string> = { 300: 'low', 500: 'medium', 800: 'high' };
    const noiseLabel = presetMap[s.speechThreshold] ?? String(s.speechThreshold);
    parts.push(`Noise: ${noiseLabel}. Delay: ${s.silenceDurationMs} milliseconds.`);
    parts.push(`Audio: ${s.audioProcessing}.`);
    if (s.endpointingMode === 'indicate') {
      parts.push(`Endpointing: indicate (${Math.round(s.indicateTimeoutMs / 1000)} second timeout).`);
    } else {
      parts.push('Endpointing: silence.');
    }
    if (s.sttStreamingEnabled) {
      parts.push(`Streaming STT: on (${s.sttStreamingChunkMs} millisecond chunks).`);
    } else {
      parts.push('Streaming STT: off.');
    }

    parts.push(`Tango bridge: ${shouldUseTangoVoiceBridge() ? 'configured' : 'disabled'}.`);

    // Error count
    if (this.counters.errors > 0) {
      parts.push(`${this.counters.errors} errors since start.`);
    }

    await this.speakResponse(parts.join(' '), { inbox: true });
    await this.playReadyEarcon();
  }

  private async handleFocusAgent(agentQuery: string): Promise<void> {
    const agent = this.voiceTargets.resolveAgentQuery(agentQuery);
    if (!agent) {
      await this.speakResponse(`I couldn't find an agent named ${agentQuery}.`, { inbox: true });
      await this.playReadyEarcon();
      return;
    }

    this.setFocusedAgent(agent);
    await this.speakResponse(`Focused on ${agent.displayName}. You can keep talking.`, { inbox: true });
    await this.playReadyEarcon();
  }

  private async handleClearFocus(): Promise<void> {
    const focusedAgent = this.getFocusedAgent();
    if (!focusedAgent) {
      await this.speakResponse('No agent focus is active right now.', { inbox: true });
      await this.playReadyEarcon();
      return;
    }

    this.clearFocusedAgent();
    await this.speakResponse(`Back to ${this.getSystemWakeName()}.`, { inbox: true });
    await this.playReadyEarcon();
  }

  private async handleOpenTopic(command: Extract<VoiceCommand, { type: 'open-topic' }>): Promise<void> {
    if (!this.router) {
      await this.speakResponse('Topic routing is not available right now.', { inbox: true });
      await this.playReadyEarcon();
      return;
    }

    try {
      const activeChannel = this.router.getActiveChannel();
      const route = this.router.getTangoRouteFor(activeChannel.name);
      let topicProject: ReturnType<typeof this.getFocusedProject> = null;
      if (command.projectName) {
        const explicitProject = this.projectManager.resolveProjectQuery(command.projectName);
        if (!explicitProject) {
          await this.speakResponse(`I couldn't find a project named ${command.projectName}.`, { inbox: true });
          await this.playReadyEarcon();
          return;
        }
        this.projectManager.setFocusedProjectId(route.channelKey, explicitProject.id);
        topicProject = {
          id: explicitProject.id,
          displayName: explicitProject.displayName,
          defaultAgentId: explicitProject.defaultAgentId,
        };
      }
      const leadAgent = topicProject?.defaultAgentId
        ? this.voiceTargets.getAgent(topicProject.defaultAgentId) ?? this.resolveDefaultTopicLeadAgent(route.agentId, activeChannel.name)
        : this.resolveDefaultTopicLeadAgent(route.agentId, activeChannel.name, { allowFocusedProject: false });
      const topic = this.topicManager.upsertTopic({
        channelKey: route.channelKey,
        topicName: command.topicName,
        leadAgent,
        projectId: topicProject?.id ?? null,
        preserveProjectId: false,
      });
      this.topicManager.setFocusedTopicId(route.channelKey, topic.id);
      await this.speakResponse(formatOpenedTopicMessage(topic.title, topicProject?.displayName), { inbox: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.speakResponse(message, { inbox: true });
    }
    await this.playReadyEarcon();
  }

  private async handleMoveTopicToProject(
    command: Extract<VoiceCommand, { type: 'move-topic-to-project' }>
  ): Promise<void> {
    if (!this.router) {
      await this.speakResponse('Topic routing is not available right now.', { inbox: true });
      await this.playReadyEarcon();
      return;
    }

    const project = this.projectManager.resolveProjectQuery(command.projectName);
    if (!project) {
      await this.speakResponse(`I couldn't find a project named ${command.projectName}.`, { inbox: true });
      await this.playReadyEarcon();
      return;
    }

    const activeChannel = this.router.getActiveChannel();
    const route = this.router.getTangoRouteFor(activeChannel.name);
    const existingTopic = command.topicName
      ? this.topicManager.getTopicByName(route.channelKey, command.topicName)
      : this.topicManager.getFocusedTopic(route.channelKey);
    if (!existingTopic) {
      await this.speakResponse(
        command.topicName
          ? `I couldn't find a topic named ${command.topicName}.`
          : 'No topic is active right now.',
        { inbox: true }
      );
      await this.playReadyEarcon();
      return;
    }

    this.projectManager.setFocusedProjectId(route.channelKey, project.id);
    const leadAgent = this.voiceTargets.getAgent(existingTopic.leadAgentId)
      ?? this.voiceTargets.getAgent(project.defaultAgentId)
      ?? this.resolveDefaultTopicLeadAgent(route.agentId, activeChannel.name);
    const movedTopic = this.topicManager.upsertTopic({
      channelKey: route.channelKey,
      topicName: existingTopic.title,
      leadAgent,
      projectId: project.id,
      preserveProjectId: false,
    });
    this.topicManager.setFocusedTopicId(route.channelKey, movedTopic.id);
    await this.speakResponse(`Moved topic ${movedTopic.title} to project ${project.displayName}.`, { inbox: true });
    await this.playReadyEarcon();
  }

  private async handleDetachTopicFromProject(
    command: Extract<VoiceCommand, { type: 'detach-topic-from-project' }>
  ): Promise<void> {
    if (!this.router) {
      await this.speakResponse('Topic routing is not available right now.', { inbox: true });
      await this.playReadyEarcon();
      return;
    }

    const activeChannel = this.router.getActiveChannel();
    const route = this.router.getTangoRouteFor(activeChannel.name);
    const existingTopic = command.topicName
      ? this.topicManager.getTopicByName(route.channelKey, command.topicName)
      : this.topicManager.getFocusedTopic(route.channelKey);
    if (!existingTopic) {
      await this.speakResponse(
        command.topicName
          ? `I couldn't find a topic named ${command.topicName}.`
          : 'No topic is active right now.',
        { inbox: true }
      );
      await this.playReadyEarcon();
      return;
    }

    const previousProject = existingTopic.projectId
      ? this.projectManager.resolveProjectQuery(existingTopic.projectId)
      : null;
    if (!previousProject && !existingTopic.projectId) {
      this.topicManager.setFocusedTopicId(route.channelKey, existingTopic.id);
      await this.speakResponse(`Topic ${existingTopic.title} is already standalone.`, { inbox: true });
      await this.playReadyEarcon();
      return;
    }

    if (existingTopic.projectId) {
      this.projectManager.setFocusedProjectId(route.channelKey, existingTopic.projectId);
    }
    const leadAgent = this.voiceTargets.getAgent(existingTopic.leadAgentId)
      ?? this.resolveDefaultTopicLeadAgent(route.agentId, activeChannel.name, { allowFocusedProject: false });
    const detachedTopic = this.topicManager.upsertTopic({
      channelKey: route.channelKey,
      topicName: existingTopic.title,
      leadAgent,
      projectId: null,
      preserveProjectId: false,
    });
    this.topicManager.setFocusedTopicId(route.channelKey, detachedTopic.id);
    await this.speakResponse(
      `Detached topic ${detachedTopic.title} from project ${previousProject?.displayName ?? existingTopic.projectId}. It is now standalone.`,
      { inbox: true }
    );
    await this.playReadyEarcon();
  }

  private async handleCurrentTopic(): Promise<void> {
    if (!this.router) {
      await this.speakResponse('Topic routing is not available right now.', { inbox: true });
      await this.playReadyEarcon();
      return;
    }

    const activeChannel = this.router.getActiveChannel();
    const topic = this.getFocusedTopic(activeChannel.name);
    if (topic) {
      await this.speakResponse(formatCurrentTopicMessage(topic.title, this.getActiveProject(activeChannel.name)?.displayName), { inbox: true });
    } else {
      await this.speakResponse('No topic is active right now.', { inbox: true });
    }
    await this.playReadyEarcon();
  }

  private async handleClearTopic(): Promise<void> {
    if (!this.router) {
      await this.speakResponse('Topic routing is not available right now.', { inbox: true });
      await this.playReadyEarcon();
      return;
    }

    const activeChannel = this.router.getActiveChannel();
    const channelKey = this.getRouteChannelKey(activeChannel.name);
    if (!channelKey) {
      await this.speakResponse('Topic routing is not available right now.', { inbox: true });
      await this.playReadyEarcon();
      return;
    }

    const topic = this.topicManager.clearFocusedTopic(channelKey);
    if (!topic) {
      await this.speakResponse('No topic is active right now.', { inbox: true });
      await this.playReadyEarcon();
      return;
    }

    const focusedProject = this.projectManager.getFocusedProject(channelKey);
    const reply = focusedProject
      ? `Left ${topic.projectId ? `topic ${topic.title}` : `standalone topic ${topic.title}`}. Project ${focusedProject.displayName} is still active.`
      : `Left ${topic.projectId ? `topic ${topic.title}` : `standalone topic ${topic.title}`}.`;
    await this.speakResponse(reply, { inbox: true });
    await this.playReadyEarcon();
  }

  private async handleOpenProject(projectQuery: string): Promise<void> {
    if (!this.router) {
      await this.speakResponse('Project routing is not available right now.', { inbox: true });
      await this.playReadyEarcon();
      return;
    }

    const project = this.projectManager.resolveProjectQuery(projectQuery);
    if (!project) {
      await this.speakResponse(`I couldn't find a project named ${projectQuery}.`, { inbox: true });
      await this.playReadyEarcon();
      return;
    }

    const activeChannel = this.router.getActiveChannel();
    const channelKey = this.getRouteChannelKey(activeChannel.name);
    if (!channelKey) {
      await this.speakResponse('Project routing is not available right now.', { inbox: true });
      await this.playReadyEarcon();
      return;
    }

    const projectSessionId = buildProjectSessionId(project.id);
    const targetChannelKeys = new Set<string>([channelKey]);

    const projectChannelId = this.router.getExplicitDiscordChannelIdForSession?.(projectSessionId) ?? null;
    if (projectChannelId) {
      const switchResult = await this.router.switchToSessionChannel?.(projectSessionId);
      if (switchResult?.success) {
        await this.onChannelSwitch();
        const switchedChannel = this.router.getActiveChannel();
        const switchedChannelKey = this.getRouteChannelKey(switchedChannel.name);
        if (switchedChannelKey) {
          targetChannelKeys.add(switchedChannelKey);
        }
      } else if (switchResult && switchResult.error) {
        console.warn(`Failed to switch voice surface for ${projectSessionId}: ${switchResult.error}`);
      }
    }

    let clearedTopicTitle: string | null = null;
    for (const targetChannelKey of targetChannelKeys) {
      const clearedTopic = this.topicManager.clearFocusedTopic(targetChannelKey);
      if (!clearedTopicTitle && clearedTopic) {
        clearedTopicTitle = clearedTopic.title;
      }
      this.projectManager.setFocusedProjectId(targetChannelKey, project.id);
    }

    const responseParts = [`Opened ${project.displayName}.`];
    if (clearedTopicTitle) {
      responseParts.push(`Cleared topic ${clearedTopicTitle}.`);
    }
    const response = responseParts.join(' ');
    await this.speakResponse(response, { inbox: true });
    await this.playReadyEarcon();
  }

  private async handleCurrentProject(): Promise<void> {
    if (!this.router) {
      await this.speakResponse('Project routing is not available right now.', { inbox: true });
      await this.playReadyEarcon();
      return;
    }

    const activeChannel = this.router.getActiveChannel();
    const project = this.getActiveProject(activeChannel.name);
    if (!project) {
      const topic = this.getFocusedTopic(activeChannel.name);
      const focusedProject = this.getFocusedProject(activeChannel.name);
      if (topic && focusedProject) {
        await this.speakResponse(`Current topic ${topic.title} is standalone. Focused project ${focusedProject.displayName} will resume when you leave this topic.`, { inbox: true });
      } else {
        await this.speakResponse('No project is active right now.', { inbox: true });
      }
      await this.playReadyEarcon();
      return;
    }

    await this.speakResponse(`You are in project ${project.displayName}.`, { inbox: true });
    await this.playReadyEarcon();
  }

  private async handleClearProject(): Promise<void> {
    if (!this.router) {
      await this.speakResponse('Project routing is not available right now.', { inbox: true });
      await this.playReadyEarcon();
      return;
    }

    const activeChannel = this.router.getActiveChannel();
    const channelKey = this.getRouteChannelKey(activeChannel.name);
    if (!channelKey) {
      await this.speakResponse('Project routing is not available right now.', { inbox: true });
      await this.playReadyEarcon();
      return;
    }

    const topic = this.topicManager.getFocusedTopic(channelKey);
    const topicProject = this.projectManager.resolveActiveProject(channelKey, {
      topicActive: topic !== null,
      topicProjectId: topic?.projectId ?? null,
    });
    const focusedProject = this.projectManager.getFocusedProject(channelKey);
    const activeProject = topicProject ?? focusedProject;
    if (!activeProject) {
      await this.speakResponse('No project is active right now.', { inbox: true });
      await this.playReadyEarcon();
      return;
    }

    this.projectManager.setFocusedProjectId(channelKey, null);
    let clearedTopic: { title: string } | null = null;
    if (topic?.projectId === activeProject.id) {
      clearedTopic = this.topicManager.clearFocusedTopic(channelKey);
    }

    const response = clearedTopic
      ? `Left project ${activeProject.displayName}. Cleared topic ${clearedTopic.title}.`
      : topic
        ? `Cleared focused project ${activeProject.displayName}. Current topic ${topic.title} remains ${topic.projectId ? 'attached to that project until you move it' : 'standalone'}.`
        : `Left project ${activeProject.displayName}.`;
    await this.speakResponse(response, { inbox: true });
    await this.playReadyEarcon();
  }

  private async handleCurrentAgent(): Promise<void> {
    const focusedAgent = this.getFocusedAgent();
    if (focusedAgent) {
      await this.speakResponse(`You are focused on ${focusedAgent.displayName}.`, { inbox: true });
    } else {
      await this.speakResponse(`No focused agent. Say ${this.getSystemWakeName()}, talk to an agent name.`, { inbox: true });
    }
    await this.playReadyEarcon();
  }

  private async handleReadLastMessage(): Promise<void> {
    if (!this.router) {
      await this.speakResponse('Channel routing is not available right now.', { inbox: true });
      await this.playReadyEarcon();
      return;
    }

    const active = this.router.getActiveChannel();
    const displayName = (active as any).displayName || active.name;
    const lastMsg = await this.router.getLastMessageFresh();
    if (!lastMsg) {
      await this.speakResponse(`I don't see a recent message in ${displayName}.`, { inbox: true });
      await this.playReadyEarcon();
      return;
    }

    const normalized = this.toSpokenText(lastMsg.content, '').trim();
    const isVeryShort = normalized.length > 0 && normalized.length < 24;
    const raw = lastMsg.role === 'user'
      ? (
        isVeryShort
          ? `The last message is short. You said: ${normalized}`
          : `You last said: ${lastMsg.content}`
      )
      : (
        isVeryShort
          ? `The last message is short. ${normalized}`
          : this.toSpokenText(lastMsg.content, 'Message available.')
      );
    await this.speakResponse(raw, { inbox: true, allowSummary: true, isChannelMessage: true });
    await this.playReadyEarcon();
    // Start follow-up grace after the ready cue so long readbacks don't
    // consume the entire window before the user can respond.
    this.allowFollowupPromptGrace(VoicePipeline.FOLLOWUP_PROMPT_GRACE_MS);
  }

  private resolveDoneCommandForContext(command: VoiceCommand, transcript: string): VoiceCommand {
    if (command.type !== 'inbox-next') return command;
    if (this.stateMachine.getInboxFlowState()) return command;

    const input = transcript.trim().toLowerCase().replace(/[.!?,]+$/, '');
    const wakeAlternation = this.getAllWakeNames()
      .map((name) => name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    const donePattern = new RegExp(
      `^(?:(?:hey|hello),?\\s+)?(?:${wakeAlternation})[,.]?\\s*(?:done|(?:i'?m|i\\s+am)\\s+done)$|^(?:done|(?:i'?m|i\\s+am)\\s+done)$`,
      'i',
    );
    if (donePattern.test(input)) {
      return { type: 'default' };
    }
    return command;
  }

  private cancelPendingWait(reason: string): void {
    if (this.ctx.pendingWaitCallback) {
      console.log(`Cancelling pending wait (${reason})`);
      this.ctx.pendingWaitCallback = null;
      this.ctx.activeWaitQueueItemId = null;
      this.ctx.quietPendingWait = false;
      this.stopWaitingLoop();
      // Queue item stays as pending/ready — shows up in inbox
    }
  }

  private async handleSilentWait(): Promise<void> {
    if (!this.ctx.pendingWaitCallback) {
      await this.speakResponse('Nothing is processing right now.', { inbox: true });
      await this.playReadyEarcon();
      return;
    }

    this.ctx.quietPendingWait = true;
    this.stopWaitingLoop();
    console.log('Silent wait enabled for active processing item');
  }

  private deliverWaitResponse(responseText: string, speakerAgentId?: string | null): void {
    void (async () => {
      try {
        this.stopWaitingLoop();
        this.player.stopPlayback('wait-response-delivery');
        if (!this.isBusy() || this.player.isWaiting()) {
          this.transitionAndResetWatchdog({ type: 'SPEAKING_STARTED' });
          await this.speakResponse(responseText, {
            allowSummary: true,
            forceFull: false,
            isChannelMessage: true,
            speakerAgentId,
          });
          this.transitionAndResetWatchdog({ type: 'SPEAKING_COMPLETE' });
          await this.playReadyEarcon();
          this.allowFollowupPromptGrace(VoicePipeline.FOLLOWUP_PROMPT_GRACE_MS);
        } else {
          // Pipeline got busy (often due to an overlapping command like "silent").
          // Retry delivery once we return to idle instead of dropping it.
          console.log('Wait response delivery deferred (pipeline busy)');
          this.deferWaitResponse(responseText, speakerAgentId);
        }
      } catch (err: any) {
        console.error(`Wait response delivery failed: ${err.message}`);
      }
    })();
  }

  private deferWaitResponse(responseText: string, speakerAgentId?: string | null): void {
    this.ctx.deferredWaitResponseText = responseText;
    this.ctx.deferredWaitSpeakerAgentId = speakerAgentId ?? null;
    if (this.deferredWaitRetryTimer) return;
    this.deferredWaitRetryTimer = setInterval(() => {
      if (!this.ctx.deferredWaitResponseText) {
        this.clearDeferredWaitRetry();
        return;
      }
      if (this.isBusy() || this.player.isPlaying()) {
        return;
      }
      const text = this.ctx.deferredWaitResponseText;
      const deferredSpeakerAgentId = this.ctx.deferredWaitSpeakerAgentId;
      this.ctx.deferredWaitResponseText = null;
      this.ctx.deferredWaitSpeakerAgentId = null;
      this.clearDeferredWaitRetry();
      this.deliverWaitResponse(text, deferredSpeakerAgentId);
    }, 700);
  }

  private clearDeferredWaitRetry(): void {
    if (this.deferredWaitRetryTimer) {
      clearInterval(this.deferredWaitRetryTimer);
      this.deferredWaitRetryTimer = null;
    }
    this.ctx.deferredWaitResponseText = null;
    this.ctx.deferredWaitSpeakerAgentId = null;
  }

  private sawRecentSpeechStart(): boolean {
    const lastStartAt = this.receiver.getLastSpeechStartedAt();
    if (lastStartAt <= 0) return false;
    return Date.now() - lastStartAt <= VoicePipeline.READY_HANDOFF_TOLERANCE_MS;
  }

  private getGateClosedCueSuppression(): 'none' | 'active-speech' | 'recent-audio' {
    if (this.receiver.hasActiveSpeech()) return 'active-speech';
    if (this.sawRecentSpeechStart()) return 'recent-audio';
    return 'none';
  }

  private resetGateCloseCueState(): void {
    this.clearGateCloseCueTimer();
    this.gateCloseCueRetryStartedAt = 0;
  }

  private shouldAttemptGateClosedCue(): boolean {
    if (!getVoiceSettings().gated) return false;
    if (this.ctx.pendingWaitCallback) return false;
    if (this.ctx.indicateCaptureActive) return false;
    if (this.isBusy() || this.player.isPlaying()) return false;
    const latestGrace = Math.max(this.ctx.gateGraceUntil, this.ctx.promptGraceUntil);
    return latestGrace <= Date.now();
  }

  private scheduleGateClosedCueAttempt(
    delayMs: number,
    phase: 'preclose' | 'holdoff',
  ): void {
    this.clearGateCloseCueTimer();
    this.gateCloseCueTimer = setTimeout(() => {
      this.gateCloseCueTimer = null;
      this.runGateClosedCueAttempt(phase);
    }, delayMs);
  }

  private runGateClosedCueAttempt(phase: 'preclose' | 'holdoff'): void {
    if (!this.shouldAttemptGateClosedCue()) {
      this.gateCloseCueRetryStartedAt = 0;
      return;
    }

    const suppression = this.getGateClosedCueSuppression();
    if (suppression === 'active-speech') {
      const suffix = phase === 'holdoff' ? ' (holdoff)' : '';
      console.log(`${this.stamp()} Grace period expired during active speech${suffix} — suppressing gate-closed cue`);
      this.gateCloseCueRetryStartedAt = 0;
      return;
    }

    if (suppression === 'recent-audio') {
      const now = Date.now();
      if (!this.gateCloseCueRetryStartedAt) {
        this.gateCloseCueRetryStartedAt = now;
      }
      const deferralMs = now - this.gateCloseCueRetryStartedAt;
      if (deferralMs < VoicePipeline.GATE_CLOSE_RECENT_AUDIO_MAX_DEFERRAL_MS) {
        console.log(`${this.stamp()} Grace period expired during recent audio — deferring gate-closed cue (${deferralMs}ms)`);
        this.scheduleGateClosedCueAttempt(VoicePipeline.GATE_CLOSE_RECENT_AUDIO_RETRY_MS, phase);
        return;
      }
      console.log(`${this.stamp()} Grace period expired during recent audio without confirmed speech — proceeding with gate-closed cue`);
    }

    this.gateCloseCueRetryStartedAt = 0;
    if (phase === 'preclose') {
      this.scheduleGateClosedCueAttempt(VoicePipeline.GATE_CLOSE_CUE_HOLDOFF_MS, 'holdoff');
      return;
    }

    console.log(`${this.stamp()} Grace period expired — gate closed`);
    void this.playFastCue('gate-closed');
  }

  private setGateGrace(ms: number): void {
    this.resetGateCloseCueState();
    this.ctx.gateGraceUntil = Date.now() + ms;
    this.scheduleGraceExpiry();
  }

  private setPromptGrace(ms: number): void {
    this.resetGateCloseCueState();
    this.ctx.promptGraceUntil = Date.now() + ms;
    this.scheduleGraceExpiry();
  }

  private allowFollowupPromptGrace(ms: number): void {
    this.ctx.followupPromptGraceUntil = Date.now() + Math.max(0, ms);
    this.ctx.followupPromptChannelName = this.router?.getActiveChannel().name ?? null;
  }

  private shouldPreserveCurrentChannelForFollowupPrompt(
    explicitAddress: ResolvedVoiceAddress | null,
  ): boolean {
    if (!this.router) return false;
    if (Date.now() >= this.ctx.followupPromptGraceUntil) return false;
    if (!this.ctx.lastSpokenIsChannelMessage) return false;

    const lockedChannel = this.ctx.followupPromptChannelName;
    if (!lockedChannel) return false;

    const activeChannel = this.router.getActiveChannel();
    if (activeChannel.name !== lockedChannel) return false;

    if (explicitAddress?.kind !== 'agent') return true;

    const activeRouteAgentId = this.router.getTangoRouteFor(activeChannel.name)?.agentId ?? null;
    if (activeRouteAgentId === null || explicitAddress.agent.id === activeRouteAgentId) {
      return true;
    }

    const lastSpeakerAgentId = this.ctx.lastSpokenSpeakerAgentId;
    return lastSpeakerAgentId != null && explicitAddress.agent.id === lastSpeakerAgentId;
  }

  private consumeFollowupPromptGrace(): void {
    this.ctx.followupPromptGraceUntil = 0;
    this.ctx.followupPromptChannelName = null;
  }

  private scheduleGraceExpiry(): void {
    if (this.graceExpiryTimer) {
      clearTimeout(this.graceExpiryTimer);
      this.graceExpiryTimer = null;
    }
    if (!getVoiceSettings().gated) return;
    const latestGrace = Math.max(this.ctx.gateGraceUntil, this.ctx.promptGraceUntil);
    const remaining = latestGrace - Date.now();
    if (remaining <= 0) return;
    this.graceExpiryTimer = setTimeout(() => {
      this.graceExpiryTimer = null;
      this.onGraceExpired();
    }, remaining);
  }

  private clearGraceTimer(): void {
    if (this.graceExpiryTimer) {
      clearTimeout(this.graceExpiryTimer);
      this.graceExpiryTimer = null;
    }
    this.resetGateCloseCueState();
  }

  private clearGateCloseCueTimer(): void {
    if (this.gateCloseCueTimer) {
      clearTimeout(this.gateCloseCueTimer);
      this.gateCloseCueTimer = null;
    }
  }

  private onGraceExpired(): void {
    this.runGateClosedCueAttempt('preclose');
  }

  private resolvePromptDispatchContext(
    channelName: string,
    transcript: string,
  ): {
    dispatchTranscript: string;
    targetAgentId: string | null;
    targetAgentDisplayName: string | null;
    targetSessionId: string | null;
    topicId: string | null;
    topicTitle: string | null;
    projectId: string | null;
    projectTitle: string | null;
  } {
    const tangoRoute = this.router?.getTangoRouteFor(channelName) ?? null;
    const routeAgentId = tangoRoute?.agentId ?? null;
    const explicitAddress = this.downgradeWeakAddress(this.resolveExplicitAddress(transcript), transcript, routeAgentId);
    const targetAgent = this.resolvePromptAgent(routeAgentId, explicitAddress, channelName);
    const strippedTranscript = explicitAddress
      ? this.stripExplicitAddressPrefix(transcript, explicitAddress)
      : transcript.trim();
    const inlineTopic = extractInlineTopicReference(strippedTranscript);
    const dispatchTranscript = inlineTopic?.promptText?.trim() || strippedTranscript.trim();
    const baseSessionId = tangoRoute?.sessionId ?? this.router?.getSessionKeyFor(channelName) ?? null;
    const channelKey = tangoRoute?.channelKey ?? null;
    let routedAgent = targetAgent;
    let routedSessionId = baseSessionId;
    let topicId: string | null = null;
    let topicTitle: string | null = null;
    let projectId: string | null = null;
    let projectTitle: string | null = null;

    if (baseSessionId && channelKey) {
      const focusedTopic = this.topicManager.getFocusedTopic(channelKey);
      const activeProject = this.projectManager.resolveActiveProject(
        channelKey,
        {
          topicActive: focusedTopic !== null,
          topicProjectId: focusedTopic?.projectId ?? null,
        },
      );
      const route = this.topicManager.resolvePromptRoute({
        baseSessionId,
        baseAgentId: targetAgent?.id ?? activeProject?.defaultAgentId ?? routeAgentId ?? 'dispatch',
        channelKey,
        targetAgent,
        topicName: inlineTopic?.topicName ?? null,
        projectId: undefined,
        preserveProjectId: true,
      });
      routedSessionId = route.sessionId;
      topicId = route.topic?.id ?? null;
      topicTitle = route.topic?.title ?? null;
      const routedProject = this.projectManager.resolveActiveProject(
        channelKey,
        {
          topicActive: route.topic !== null,
          topicProjectId: route.topic?.projectId ?? null,
        },
      );
      projectId = routedProject?.id ?? null;
      projectTitle = routedProject?.displayName ?? null;
      if (!route.topic && routedProject) {
        routedSessionId = buildProjectSessionId(routedProject.id);
      }
      const routeAgent = this.voiceTargets.getAgent(route.agentId);
      if (routeAgent) {
        routedAgent = routeAgent;
      }
    }

    return {
      dispatchTranscript: dispatchTranscript || transcript.trim(),
      targetAgentId: routedAgent?.id ?? targetAgent?.id ?? null,
      targetAgentDisplayName: routedAgent?.displayName ?? targetAgent?.displayName ?? null,
      targetSessionId: routedSessionId,
      topicId,
      topicTitle,
      projectId,
      projectTitle,
    };
  }

  private async handleWaitMode(userId: string, transcript: string): Promise<void> {
    const channelName = this.router?.getActiveChannel().name;

    // Non-blocking path: dispatch fire-and-forget with a wait callback
    if (this.router && this.queueState) {
      const activeChannel = this.router.getActiveChannel();
      const displayName = (activeChannel as any).displayName || activeChannel.name;
      const sessionKey = this.router.getActiveSessionKey();
      const dispatch = this.resolvePromptDispatchContext(activeChannel.name, transcript);
      this.clearLocalReadyItemsForDispatch(activeChannel.name, sessionKey);

      if (!this.tangoBridgeOwnsDiscordSync) {
        this.log(`**You:** ${transcript}`, channelName);
      }
      this.session.appendUserMessage(userId, transcript, channelName);

      const item = this.queueState.enqueue({
        channel: activeChannel.name,
        displayName,
        sessionKey,
        userMessage: transcript,
        speakerAgentId: dispatch.targetAgentId,
      });

      // Register wait callback — will be invoked when LLM finishes
      this.ctx.activeWaitQueueItemId = item.id;
      this.ctx.quietPendingWait = false;
      this.ctx.pendingWaitCallback = (responseText: string, speakerAgentId?: string | null) => {
        this.deliverWaitResponse(responseText, speakerAgentId);
      };

      this.dispatchToLLMFireAndForget(userId, transcript, item.id, {
        channelName: activeChannel.name,
        displayName,
        sessionKey,
        systemPrompt: this.router.getSystemPrompt(),
        agentId: dispatch.targetAgentId,
        agentDisplayName: dispatch.targetAgentDisplayName,
        dispatchTranscript: dispatch.dispatchTranscript,
        sessionId: dispatch.targetSessionId,
        topicId: dispatch.topicId,
        topicTitle: dispatch.topicTitle,
        projectId: dispatch.projectId,
        projectTitle: dispatch.projectTitle,
      });

      // Return immediately — waiting loop keeps running, pipeline goes to IDLE via finally block.
      return;
    }

    // Synchronous fallback when queueState is not available
    const fallbackDispatch = channelName
      ? this.resolvePromptDispatchContext(channelName, transcript)
      : {
        dispatchTranscript: transcript,
        targetAgentId: null,
        targetAgentDisplayName: null,
        targetSessionId: null,
        topicId: null,
        topicTitle: null,
        projectId: null,
        projectTitle: null,
      };
    this.log(`**You:** ${transcript}`, channelName);
    this.session.appendUserMessage(userId, transcript, channelName);

    const sessionScopedUser = fallbackDispatch.targetSessionId ?? this.router?.getActiveSessionKey() ?? userId;
    const fallbackSystemPrompt = appendTopicContextToSystemPrompt(
      appendProjectContextToSystemPrompt(
        this.router?.getSystemPrompt() ?? '',
        fallbackDispatch.projectTitle ?? null,
      ),
      fallbackDispatch.topicTitle ?? null,
    );
    const { response } = await getResponse(sessionScopedUser, fallbackDispatch.dispatchTranscript, {
      systemPrompt: fallbackSystemPrompt,
    });
    const responseText = this.sanitizeAssistantOutput(response, `wait-fallback:${channelName ?? 'default'}`);

    this.log(`**${fallbackDispatch.targetAgentDisplayName ?? this.getSystemSpeakerLabel()}:** ${responseText}`, channelName);
    this.session.appendAssistantMessage(responseText, channelName);

    this.stopWaitingLoop();
    this.transitionAndResetWatchdog({ type: 'SPEAKING_STARTED' });
    await this.speakResponse(responseText, {
      allowSummary: true,
      forceFull: false,
      isChannelMessage: true,
      speakerAgentId: fallbackDispatch.targetAgentId,
    });
    this.transitionAndResetWatchdog({ type: 'SPEAKING_COMPLETE' });
    await this.playReadyEarcon();
    this.allowFollowupPromptGrace(VoicePipeline.FOLLOWUP_PROMPT_GRACE_MS);
  }

  private async handleQueueMode(userId: string, transcript: string): Promise<void> {
    if (!this.router || !this.queueState) {
      // Fall back to wait mode if queue state not available
      await this.handleWaitMode(userId, transcript);
      return;
    }

    const activeChannel = this.router.getActiveChannel();
    const channelName = activeChannel.name;
    const displayName = (activeChannel as any).displayName || channelName;
    const sessionKey = this.router.getActiveSessionKey();
    const dispatch = this.resolvePromptDispatchContext(channelName, transcript);
    this.clearLocalReadyItemsForDispatch(channelName, sessionKey);

    if (!this.tangoBridgeOwnsDiscordSync) {
      this.log(`**You:** ${transcript}`, channelName);
    }
    this.session.appendUserMessage(userId, transcript, channelName);

    // Enqueue and dispatch fire-and-forget
    const item = this.queueState.enqueue({
      channel: channelName,
      displayName,
      sessionKey,
      userMessage: transcript,
      speakerAgentId: dispatch.targetAgentId,
    });

    this.dispatchToLLMFireAndForget(userId, transcript, item.id, {
      channelName,
      displayName,
      sessionKey,
      systemPrompt: this.router.getSystemPrompt(),
      agentId: dispatch.targetAgentId,
      agentDisplayName: dispatch.targetAgentDisplayName,
      dispatchTranscript: dispatch.dispatchTranscript,
      sessionId: dispatch.targetSessionId,
      topicId: dispatch.topicId,
      topicTitle: dispatch.topicTitle,
      projectId: dispatch.projectId,
      projectTitle: dispatch.projectTitle,
    });

    // Brief confirmation, then immediate inbox status so the user has
    // deterministic post-queue context before the ready handoff.
    await this.player.playEarcon('acknowledged');
    await this.speakResponse(`Queued to ${displayName}.`, { inbox: true });
    await this.speakInboxQueueStatus();
    await this.playReadyEarcon();
  }

  /**
   * Dismiss dispatch: fire-and-forget with acknowledged earcon, return to table.
   * Used when the user closes with a dismiss word ("thanks", "Tango Tango").
   * No spoken confirmation — just the earcon. Agent works in background,
   * response arrives later as a notification.
   */
  private async handleDismissDispatch(userId: string, transcript: string): Promise<void> {
    if (!this.router || !this.queueState) {
      // Fall back to wait mode if queue state not available
      await this.handleWaitMode(userId, transcript);
      return;
    }

    const activeChannel = this.router.getActiveChannel();
    const channelName = activeChannel.name;
    const displayName = (activeChannel as any).displayName || channelName;
    const sessionKey = this.router.getActiveSessionKey();
    const dispatch = this.resolvePromptDispatchContext(channelName, transcript);
    this.clearLocalReadyItemsForDispatch(channelName, sessionKey);

    if (!this.tangoBridgeOwnsDiscordSync) {
      this.log(`**You:** ${transcript}`, channelName);
    }
    this.session.appendUserMessage(userId, transcript, channelName);

    const item = this.queueState.enqueue({
      channel: channelName,
      displayName,
      sessionKey,
      userMessage: transcript,
      speakerAgentId: dispatch.targetAgentId,
    });

    this.dispatchToLLMFireAndForget(userId, transcript, item.id, {
      channelName,
      displayName,
      sessionKey,
      systemPrompt: this.router.getSystemPrompt(),
      agentId: dispatch.targetAgentId,
      agentDisplayName: dispatch.targetAgentDisplayName,
      dispatchTranscript: dispatch.dispatchTranscript,
      sessionId: dispatch.targetSessionId,
      topicId: dispatch.topicId,
      topicTitle: dispatch.topicTitle,
      projectId: dispatch.projectId,
      projectTitle: dispatch.projectTitle,
    });

    // Dismiss: just the acknowledged earcon. No spoken confirmation, no grace window.
    // The agent works in the background and the response will arrive as a nudge notification.
    console.log(`Dismiss dispatch to ${displayName}: "${transcript.slice(0, 80)}${transcript.length > 80 ? '...' : ''}"`);
    await this.player.playEarcon('acknowledged');
  }

  private async handleAskMode(userId: string, transcript: string): Promise<void> {
    if (!this.router || !this.queueState) {
      // Fall back to old behavior if no queue state
      this.transitionAndResetWatchdog({
        type: 'ENTER_QUEUE_CHOICE',
        userId,
        transcript,
      });
      await this.speakResponse('Send to inbox, or wait here?', { inbox: true });
      await this.playReadyEarcon();
      return;
    }

    const activeChannel = this.router.getActiveChannel();
    const channelName = activeChannel.name;
    const displayName = (activeChannel as any).displayName || channelName;
    const sessionKey = this.router.getActiveSessionKey();
    const dispatch = this.resolvePromptDispatchContext(channelName, transcript);
    this.clearLocalReadyItemsForDispatch(channelName, sessionKey);

    if (!this.tangoBridgeOwnsDiscordSync) {
      this.log(`**You:** ${transcript}`, channelName);
    }
    this.session.appendUserMessage(userId, transcript, channelName);

    // Enqueue and dispatch speculatively — LLM starts immediately
    const item = this.queueState.enqueue({
      channel: channelName,
      displayName,
      sessionKey,
      userMessage: transcript,
      speakerAgentId: dispatch.targetAgentId,
    });

    this.ctx.speculativeQueueItemId = item.id;
    this.dispatchToLLMFireAndForget(userId, transcript, item.id, {
      channelName,
      displayName,
      sessionKey,
      systemPrompt: this.router.getSystemPrompt(),
      agentId: dispatch.targetAgentId,
      agentDisplayName: dispatch.targetAgentDisplayName,
      dispatchTranscript: dispatch.dispatchTranscript,
      sessionId: dispatch.targetSessionId,
      topicId: dispatch.topicId,
      topicTitle: dispatch.topicTitle,
      projectId: dispatch.projectId,
      projectTitle: dispatch.projectTitle,
    });

    // Enter choice state and prompt user — LLM works in parallel.
    this.transitionAndResetWatchdog({
      type: 'ENTER_QUEUE_CHOICE',
      userId,
      transcript,
    });

    this.stopWaitingLoop();
    await this.speakResponse('Send to inbox, or wait here?', { inbox: true });
    await this.playReadyEarcon();
  }

  private async handleQueueChoiceResponse(transcript: string): Promise<void> {
    const choiceState = this.stateMachine.getQueueChoiceState();
    if (!choiceState) return;

    const { userId, transcript: originalTranscript } = choiceState;
    const specId = this.ctx.speculativeQueueItemId;

    const choice = matchQueueChoice(transcript);
    if (choice === 'queue') {
      // Already dispatched speculatively — just confirm
      this.ctx.ignoreProcessingUtterancesUntil = Date.now() + 2500;
      this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
      this.ctx.speculativeQueueItemId = null;

      if (specId) {
        // Already dispatched — play confirmation
        const activeChannel = this.router?.getActiveChannel();
        const displayName = activeChannel ? ((activeChannel as any).displayName || activeChannel.name) : 'inbox';
        await this.player.playEarcon('acknowledged');
        await this.speakResponse(`Queued to ${displayName}.`, { inbox: true });
        await this.speakInboxQueueStatus();
        await this.playReadyEarcon();
      } else {
        // No speculative dispatch (fallback) — dispatch now
        await this.handleQueueMode(userId, originalTranscript);
      }
    } else if (choice === 'silent') {
      // Already dispatched — set silentWait for auto-read
      this.ctx.ignoreProcessingUtterancesUntil = Date.now() + 2500;
      this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
      this.ctx.silentWait = true;
      this.ctx.speculativeQueueItemId = null;

      if (specId) {
        await this.player.playEarcon('acknowledged');
      } else {
        await this.handleSilentQueue(userId, originalTranscript);
      }
    } else if (choice === 'wait') {
      this.ctx.ignoreProcessingUtterancesUntil = Date.now() + 2500;
      this.ctx.speculativeQueueItemId = null;

      if (specId && this.queueState) {
        // Check if speculative response is already ready
        const readyItem = this.getMergedReadyItems().find((i) => i.id === specId);
        if (readyItem) {
          // Instant response — already done
          this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
          this.markReadyItemHeard(specId);
          this.stopWaitingLoop();
          this.transitionAndResetWatchdog({ type: 'SPEAKING_STARTED' });
          await this.speakResponse(readyItem.responseText, {
            allowSummary: true,
            forceFull: false,
            isChannelMessage: true,
            speakerAgentId: readyItem.speakerAgentId,
          });
          this.transitionAndResetWatchdog({ type: 'SPEAKING_COMPLETE' });
          await this.playReadyEarcon();
        } else {
          // Not ready yet — register callback and start waiting loop
          this.transitionAndResetWatchdog({ type: 'PROCESSING_STARTED' });
          this.ctx.activeWaitQueueItemId = specId;
          this.ctx.pendingWaitCallback = (responseText: string, speakerAgentId?: string | null) => {
            this.deliverWaitResponse(responseText, speakerAgentId);
          };
          await this.sleep(150);
          this.startWaitingLoop();
          // Return — callback will deliver response when ready
        }
      } else {
        // No speculative dispatch — fall back to synchronous wait
        this.transitionAndResetWatchdog({ type: 'PROCESSING_STARTED' });
        await this.sleep(150);
        this.startWaitingLoop();
        await this.handleWaitMode(userId, originalTranscript);
      }
    } else {
      // Try navigation commands — with or without wake word
      const navCommand = this.parseAddressedCommand(transcript)
        ?? this.matchBareQueueCommand(transcript, { allowSwitch: true });
      if (navCommand && (navCommand.type === 'switch' || navCommand.type === 'list' || navCommand.type === 'default')) {
        this.ctx.ignoreProcessingUtterancesUntil = Date.now() + 2500;
        console.log(`Queue choice: navigation (${navCommand.type}), already dispatched speculatively`);
        this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
        this.ctx.speculativeQueueItemId = null;

        if (!specId) {
          // No speculative dispatch — dispatch now before navigating
          await this.handleSilentQueue(userId, originalTranscript);
        }
        await this.handleVoiceCommand(navCommand, userId);
      } else {
        // Unrecognized — reprompt with error earcon (LLM continues in background)
        await this.repromptAwaiting();
        await this.playReadyEarcon();
      }
    }
  }

  private async handleSilentQueue(userId: string, transcript: string): Promise<void> {
    if (!this.router || !this.queueState) {
      await this.handleWaitMode(userId, transcript);
      return;
    }

    const activeChannel = this.router.getActiveChannel();
    const channelName = activeChannel.name;
    const displayName = (activeChannel as any).displayName || channelName;
    const sessionKey = this.router.getActiveSessionKey();
    const dispatch = this.resolvePromptDispatchContext(channelName, transcript);
    this.clearLocalReadyItemsForDispatch(channelName, sessionKey);

    if (!this.tangoBridgeOwnsDiscordSync) {
      this.log(`**You:** ${transcript}`, channelName);
    }
    this.session.appendUserMessage(userId, transcript, channelName);

    const item = this.queueState.enqueue({
      channel: channelName,
      displayName,
      sessionKey,
      userMessage: transcript,
      speakerAgentId: dispatch.targetAgentId,
    });

    this.dispatchToLLMFireAndForget(userId, transcript, item.id, {
      channelName,
      displayName,
      sessionKey,
      systemPrompt: this.router.getSystemPrompt(),
      agentId: dispatch.targetAgentId,
      agentDisplayName: dispatch.targetAgentDisplayName,
      dispatchTranscript: dispatch.dispatchTranscript,
      sessionId: dispatch.targetSessionId,
      topicId: dispatch.topicId,
      topicTitle: dispatch.topicTitle,
      projectId: dispatch.projectId,
      projectTitle: dispatch.projectTitle,
    });

    // One confirmation tone, then silence
    console.log('Silent queue: dispatched, playing single tone');
    this.stopWaitingLoop();
    void this.playFastCue('acknowledged');
  }

  private async speakInboxQueueStatus(): Promise<void> {
    if (this.inboxClient) {
      try {
        const inbox = await this.inboxClient.getInbox();
        const parts: string[] = [];
        if (inbox.totalUnread > 0) {
          const channelNames = inbox.channels.map((ch) => ch.displayName);
          parts.push(`${inbox.totalUnread} unread in ${channelNames.join(', ')}`);
        } else {
          parts.push('Zero ready');
        }
        if (inbox.pendingCount > 0) {
          parts.push(`${inbox.pendingCount} processing`);
        }
        await this.speakResponse(parts.join('. ') + '.', { inbox: true });
        return;
      } catch {
        // Fall through to simple message
      }
    }
    await this.speakResponse('Dispatched.', { inbox: true });
  }

  private async handleSwitchChoiceResponse(transcript: string): Promise<void> {
    const switchState = this.stateMachine.getSwitchChoiceState();
    if (!switchState) return;

    const { lastMessage } = switchState;

    const choice = matchSwitchChoice(transcript);
    if (choice === 'read') {
      this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
      await this.acknowledgeAwaitingChoice();
      // Read the full last message
      await this.speakResponse(lastMessage, { inbox: true });
      await this.playReadyEarcon();
    } else if (choice === 'prompt') {
      this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
      // Confirm with a ready earcon so the user knows the assistant is ready
      console.log('Switch choice: prompt');
      this.stopWaitingLoop();
      this.setPromptGrace(15_000);
      this.playReadyEarconSync();
    } else if (choice === 'cancel') {
      const effects = this.transitionAndResetWatchdog({ type: 'CANCEL_FLOW' });
      await this.applyEffects(effects);
      console.log('Switch choice: cancel');
      this.stopWaitingLoop();
    } else {
      // Allow navigation commands from switch-choice, with or without wake word.
      const navCommand = this.parseAddressedCommand(transcript)
        ?? this.matchBareQueueCommand(transcript, { allowSwitch: true });
      if (
        navCommand &&
        (
          navCommand.type === 'switch' ||
          navCommand.type === 'list' ||
          navCommand.type === 'default' ||
          navCommand.type === 'inbox-check'
        )
      ) {
        console.log(`Switch choice: navigation (${navCommand.type})`);
        this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
        await this.handleVoiceCommand(navCommand);
        return;
      }

      // Unrecognized — reprompt with error earcon
      await this.repromptAwaiting();
      await this.playReadyEarcon();
    }
  }

  private async handleRouteConfirmationResponse(transcript: string, userId?: string): Promise<void> {
    const confirmState = this.stateMachine.getRouteConfirmationState();
    if (!confirmState) return;

    const choice = matchYesNo(transcript);
    if (choice === 'yes') {
      // User confirmed
      this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
      await this.acknowledgeAwaitingChoice();

      if (confirmState.confirmAction === 'create' && this.router) {
        // Create flow: make the thread/post then dispatch
        const title = confirmState.createTitle ?? 'Untitled';
        let createResult;
        if (confirmState.createTargetType === 'forum') {
          createResult = await this.router.createForumPost(confirmState.targetId, title, 'New voice thread.');
        } else {
          createResult = await this.router.createChannelThread(confirmState.targetId, title, 'New voice thread.');
        }
        if (createResult.success) {
          invalidateRouteTargetCache();
          this.setPromptGrace(15_000);
          console.log(`Route confirmation: created "${title}"`);
          void this.speakResponse(`Created ${title}.`, { inbox: true });
        } else {
          console.warn(`Route confirmation: creation failed: ${createResult.error}`);
        }
      } else if (this.router) {
        // Route flow: switch to target
        const switchResult = await this.router.switchTo(confirmState.targetId);
        if (switchResult.success) {
          const shortName = confirmState.targetName.replace(/\s*\(in .*\)$/, '');
          console.log(`Route confirmed: switched to "${confirmState.targetName}" (${switchResult.displayName ?? confirmState.targetId})`);
          void this.speakResponse(`Routed to ${shortName}.`, { inbox: true });
        }
      }

      // Dispatch the original prompt in the new context
      await this.dispatchPromptWithIntent(
        confirmState.userId,
        confirmState.transcript,
        confirmState.deliveryMode,
        confirmState.closeType,
      );
    } else if (choice === 'no' || choice === 'cancel') {
      if (confirmState.confirmAction === 'redirect') {
        // Already in redirect phase — user declined again, just dispatch to fallback
        this.transitionAndResetWatchdog({ type: 'CANCEL_FLOW' });
        console.log('Route redirect: declined — dispatching to current channel');
        await this.dispatchPromptWithIntent(
          confirmState.userId,
          confirmState.transcript,
          confirmState.deliveryMode,
          confirmState.closeType,
        );
      } else {
        // First decline — enter redirect phase: offer chance to reroute
        const currentChannel = this.router?.getActiveChannel();
        const channelLabel = currentChannel?.displayName ?? currentChannel?.name ?? 'current channel';
        console.log('Route confirmation: declined — entering redirect phase');
        this.transitionAndResetWatchdog({
          type: 'ENTER_ROUTE_CONFIRMATION',
          userId: confirmState.userId,
          transcript: confirmState.transcript,
          targetId: confirmState.targetId,
          targetName: confirmState.targetName,
          confirmAction: 'redirect',
          deliveryMode: confirmState.deliveryMode,
          closeType: confirmState.closeType,
          fallbackChannelId: confirmState.fallbackChannelId,
          timeoutMs: 8_000,
        });
        await this.speakResponse(`Sending to ${channelLabel}. Say route-to to redirect.`, { inbox: true });
        await this.playReadyEarcon();
        this.transitionAndResetWatchdog({ type: 'REFRESH_AWAITING_TIMEOUT' });
      }
    } else {
      // Unrecognized input during confirmation
      // Try parsing as a voice command (e.g., "route to X" overrides confirmation)
      const cmd = parseVoiceCommand(transcript, this.getAllWakeNames());
      const bareRedirectMatch = cmd
        ? null
        : transcript
            .trim()
            .toLowerCase()
            .replace(/[.!?,]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .match(/^(?:route|root|rout|switch|go|send|move)\s+to\s+(.+)$/);
      const redirectTarget = cmd?.type === 'switch'
        ? cmd.channel
        : bareRedirectMatch?.[1]?.trim().replace(/\s+channel$/, '').trim();
      if (redirectTarget && this.router) {
        this.transitionAndResetWatchdog({ type: 'CANCEL_FLOW' });
        console.log(`Route confirmation: redirected via ${cmd?.type === 'switch' ? 'switch command' : 'bare command'} to "${redirectTarget}"`);
        await this.router.switchTo(redirectTarget);
        await this.dispatchPromptWithIntent(
          confirmState.userId,
          confirmState.transcript,
          confirmState.deliveryMode,
          confirmState.closeType,
        );
        return;
      }

      if (confirmState.confirmAction === 'redirect') {
        // In redirect phase, any non-command input means "just send it"
        this.transitionAndResetWatchdog({ type: 'CANCEL_FLOW' });
        console.log('Route redirect: unrecognized input — dispatching to current channel');
        void this.speakResponse('Sending to current channel.', { inbox: true });
        await this.dispatchPromptWithIntent(
          confirmState.userId,
          confirmState.transcript,
          confirmState.deliveryMode,
          confirmState.closeType,
        );
        return;
      }

      // Confirm phase: reprompt, but auto-dispatch after 2 failures
      confirmState.repromptCount = (confirmState.repromptCount ?? 0) + 1;
      if (confirmState.repromptCount >= 2) {
        this.transitionAndResetWatchdog({ type: 'CANCEL_FLOW' });
        console.log('Route confirmation: max reprompts reached — dispatching to fallback');
        if (this.router && confirmState.fallbackChannelId) {
          await this.router.switchTo(confirmState.fallbackChannelId);
        }
        void this.speakResponse('Delivering your message to the current channel.', { inbox: true });
        await this.dispatchPromptWithIntent(
          confirmState.userId,
          confirmState.transcript,
          confirmState.deliveryMode,
          confirmState.closeType,
        );
        return;
      }

      await this.repromptAwaiting();
      await this.playReadyEarcon();
      this.transitionAndResetWatchdog({ type: 'REFRESH_AWAITING_TIMEOUT' });
    }
  }

  private async dispatchPromptWithIntent(
    userId: string,
    transcript: string,
    deliveryMode: VoiceMode,
    closeType: IndicateCloseType | null,
  ): Promise<void> {
    this.transitionAndResetWatchdog({ type: 'PROCESSING_STARTED' });

    const requestedMode = normalizeVoiceMode(deliveryMode);
    const effectiveMode = closeType === 'dismiss'
      ? 'queue' as VoiceMode
      : closeType === 'conversational'
        ? 'wait' as VoiceMode
        : requestedMode;

    if (effectiveMode === 'wait') {
      this.startWaitingLoop(VoicePipeline.PROCESSING_LOOP_START_DELAY_MS);
    }

    if (closeType === 'dismiss') {
      await this.handleDismissDispatch(userId, transcript);
    } else if (effectiveMode === 'queue') {
      await this.handleQueueMode(userId, transcript);
    } else {
      await this.handleWaitMode(userId, transcript);
    }
  }

  private dispatchToLLMFireAndForget(
    userId: string,
    transcript: string,
    queueItemId: string,
    target: {
      channelName: string;
      displayName: string;
      sessionKey: string;
      systemPrompt: string;
      agentId?: string | null;
      agentDisplayName?: string | null;
      dispatchTranscript?: string;
      sessionId?: string | null;
      topicId?: string | null;
      topicTitle?: string | null;
      projectId?: string | null;
      projectTitle?: string | null;
    },
  ): void {
    if (!this.router || !this.queueState) return;
    this.counters.llmDispatches++;

    const channelName = target.channelName;
    const displayName = target.displayName;
    const sessionKey = target.sessionKey;
    const systemPrompt = target.systemPrompt;
    const requestedTranscript = target.dispatchTranscript?.trim() || transcript;
    const requestedSessionId = target.sessionId?.trim() || sessionKey;
    const useTangoTurnBridge = shouldUseTangoVoiceBridge();
    const channelId = this.extractChannelIdFromSessionKey(sessionKey);

    // Capture state we need before the async work
    const routerRef = this.router;
    const queueRef = this.queueState;
    const session = this.session;

    // Set cool-down BEFORE dispatch so inbox poll ignores near-term echoes.
    this.recentVoiceDispatchChannels.set(sessionKey, Date.now());

    void (async () => {
      try {
        // Use the originating channel snapshot for history so switches that
        // happen while this item is processing do not cross-contaminate context.
        await routerRef.refreshHistory(channelName);
        const history = routerRef.getHistory(channelName);
        let safeResponse = '';
        let updatedHistory = history;
        const responseDisplayName = target.agentDisplayName ?? this.getSystemSpeakerLabel();
        let responseSpeakerAgentId = target.agentId ?? null;

        if (useTangoTurnBridge) {
          const tangoRoute = routerRef.getTangoRouteFor(channelName);
          const requestedAgentId = target.agentId
            ?? this.resolvePromptAgent(tangoRoute.agentId, null, channelName)?.id
            ?? tangoRoute.agentId;
          responseSpeakerAgentId = requestedAgentId;
          const tangoResult = await requestTangoVoiceTurn({
            sessionId: requestedSessionId,
            agentId: requestedAgentId,
            transcript: requestedTranscript,
            utteranceId: queueItemId,
            guildId: config.discordGuildId,
            voiceChannelId: config.discordVoiceChannelId,
            channelId,
            discordUserId: userId,
          });

          safeResponse = this.sanitizeAssistantOutput(
            tangoResult.responseText,
            `queue-item:${queueItemId}:${channelName}:tango`,
          );
          updatedHistory = this.mergeHistoryWithAssistantTurn(history, requestedTranscript, safeResponse);
          console.log(
            `Queue item ${queueItemId} tango turn complete (session=${requestedSessionId}, routeSession=${tangoRoute.sessionId}, routeAgent=${tangoRoute.agentId}, requestedAgent=${requestedAgentId}, project=${target.projectTitle ?? '-'}, topic=${target.topicTitle ?? '-'}, source=${tangoRoute.source}, provider=${tangoResult.providerName ?? 'unknown'}, deduped=${tangoResult.deduplicated ? 'yes' : 'no'}, turn=${tangoResult.turnId ?? 'n/a'})`,
          );
        } else {
          // When the full turn bridge is unavailable, fall back to the
          // Tango completion bridge for a best-effort response.
          const projectAwareSystemPrompt = appendProjectContextToSystemPrompt(
            systemPrompt,
            target.projectTitle ?? null,
          );
          const topicAwareSystemPrompt = appendTopicContextToSystemPrompt(
            projectAwareSystemPrompt,
            target.topicTitle ?? null,
          );
          const completionResult = await getResponse(requestedSessionId, requestedTranscript, {
            systemPrompt: topicAwareSystemPrompt,
            history,
          });
          safeResponse = this.sanitizeAssistantOutput(
            completionResult.response,
            `queue-item:${queueItemId}:${channelName}:completion`,
          );
          updatedHistory = completionResult.history;
          if (updatedHistory.length > 0 && updatedHistory[updatedHistory.length - 1]?.role === 'assistant') {
            updatedHistory[updatedHistory.length - 1] = {
              role: 'assistant',
              content: safeResponse,
            };
          }
        }
        routerRef.setHistory(updatedHistory, channelName);

        // Generate summary (first sentence or first 100 chars)
        const summary = safeResponse.length > 100
          ? safeResponse.slice(0, 100) + '...'
          : safeResponse;

        queueRef.markReady(queueItemId, summary, safeResponse, responseSpeakerAgentId);
        this.storeLocalReadyItem({
          id: queueItemId,
          channel: channelName,
          displayName: target.agentDisplayName || displayName,
          sessionKey,
          userMessage: requestedTranscript,
          speakerAgentId: responseSpeakerAgentId,
          summary,
          responseText: safeResponse,
          timestamp: Date.now(),
          status: 'ready',
        });
        this.notifyLegacyResponsePoller();
        console.log(`Queue item ${queueItemId} ready (channel: ${channelName})`);

        // Check for pending wait callback — deliver response directly
        if (this.ctx.pendingWaitCallback && this.ctx.activeWaitQueueItemId === queueItemId) {
          const cb = this.ctx.pendingWaitCallback;
          this.ctx.pendingWaitCallback = null;
          this.ctx.activeWaitQueueItemId = null;
          this.ctx.quietPendingWait = false;
          this.markReadyItemHeard(queueItemId);

          if (!this.tangoBridgeOwnsDiscordSync) {
            this.log(`**${responseDisplayName}:** ${safeResponse}`, channelName);
          }
          session.appendAssistantMessage(safeResponse, channelName);

          // Prime reply-here continuity as soon as an inline focus response is ready.
          // deliverWaitResponse refreshes this again after playback completes so the
          // effective window still begins at the normal ready handoff.
          this.allowFollowupPromptGrace(VoicePipeline.FOLLOWUP_PROMPT_GRACE_MS);
          cb(safeResponse, responseSpeakerAgentId);

          // Advance Discord watermark so this response doesn't reappear in the inbox.
          // Small delay to let the Discord sync post the agent response first.
          const inboxRef = this.inboxClient;
          if (inboxRef && channelId) {
            setTimeout(() => void inboxRef.markChannelReadById(channelId, 'voice-wait'), 3000);
          }
          return;
        }

        if (!this.tangoBridgeOwnsDiscordSync) {
          this.log(`**${responseDisplayName}:** ${safeResponse}`, channelName);
        }
        session.appendAssistantMessage(safeResponse, channelName);

        // Silent wait: auto-read the full response instead of a brief notification
        if (this.ctx.silentWait) {
          this.ctx.silentWait = false;
          this.markReadyItemHeard(queueItemId);
          this.notifyIfIdle(safeResponse, {
            speakerAgentId: responseSpeakerAgentId,
          });
          // Advance Discord watermark so this response doesn't reappear in the inbox.
          const inboxRef = this.inboxClient;
          if (inboxRef && channelId) {
            setTimeout(() => void inboxRef.markChannelReadById(channelId, 'voice-silent-wait'), 3000);
          }
        } else {
          // Notify user if idle
          const agentLabel = target.agentDisplayName || displayName;
          this.notifyIfIdle(`${agentLabel} has a response.`, {
            kind: 'response-ready',
            sessionKey,
            tier: 'nudge',
            agentDisplayName: agentLabel,
          });
        }
      } catch (err: any) {
        console.error(`Fire-and-forget LLM dispatch failed for ${queueItemId}: ${err.message}`);
        // Clear pending wait state so the pipeline doesn't get stuck forever
        this.cancelPendingWait(`dispatch failed: ${err.message}`);

        // Classify the error for a useful spoken message
        const msg = err.message?.toLowerCase() ?? '';
        const isNetwork = msg.includes('fetch failed') || msg.includes('econnrefused')
          || msg.includes('timeout') || msg.includes('enotfound');

        // Mark the queue item ready with an explicit failure message so the user
        // can discover the error via inbox flow or next-item navigation.
        const serviceLabel = useTangoTurnBridge ? 'tango voice bridge' : 'tango completion bridge';
        const failureSummary = isNetwork
          ? `Dispatch failed: ${serviceLabel} connection error.`
          : `Dispatch failed: ${serviceLabel} error.`;
        const failureText = isNetwork
          ? `I could not complete that request because the ${serviceLabel} connection failed. Please try again.`
          : `I could not complete that request because the ${serviceLabel} returned an error. Please try again.`;
        queueRef.markReady(queueItemId, failureSummary, failureText, null);
        this.storeLocalReadyItem({
          id: queueItemId,
          channel: channelName,
          displayName,
          sessionKey,
          userMessage: requestedTranscript,
          speakerAgentId: null,
          summary: failureSummary,
          responseText: failureText,
          timestamp: Date.now(),
          status: 'ready',
        });
        this.notifyLegacyResponsePoller();

        const reason = isNetwork
          ? 'A network error occurred.'
          : `The ${serviceLabel} returned an error.`;
        const spokenError = `Sorry, that didn't go through. ${reason} You may need to repeat that.`;

        // Speak the failure directly — the user is actively waiting
        this.stopWaitingLoop();
        this.player.stopPlayback('dispatch-failure');
        try {
          this.transitionAndResetWatchdog({ type: 'SPEAKING_STARTED' });
          await this.speakResponse(spokenError);
          this.transitionAndResetWatchdog({ type: 'SPEAKING_COMPLETE' });
          await this.playReadyEarcon();
        } catch {
          // Last resort: fall back to idle notify
          this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
        }
      }
    })();

  }

  private async handleModeSwitch(mode: VoiceMode): Promise<void> {
    if (!this.queueState) {
      await this.speakResponse('Background mode is not available.');
      return;
    }

    const normalizedMode = normalizeVoiceMode(mode) as 'wait' | 'queue';
    this.cancelPendingWait(`mode switch to ${normalizedMode}`);
    this.queueState.setMode(normalizedMode);

    // Clear inbox flow if active when mode changes.
    if (this.stateMachine.getInboxFlowState()) {
      this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
    }

    const labels: Record<'wait' | 'queue', string> = {
      wait: 'Focus mode. I will answer inline and keep your follow-ups in this conversation.',
      queue: 'Background mode. Your messages will be dispatched and you can keep talking.',
    };
    await this.speakResponse(labels[normalizedMode], { inbox: true });
    await this.playReadyEarcon();

    // Start/stop background inbox poll based on mode
    if (normalizedMode === 'queue') {
      this.startInboxPoll();
    } else {
      this.stopInboxPoll();
    }
  }

  private startInboxPoll(): void {
    if (this.inboxPollTimer) return;
    this.inboxPollTimer = setInterval(() => void this.pollInboxForTextActivity(), VoicePipeline.INBOX_POLL_INTERVAL_MS);
    console.log(`Inbox background poll started (every ${VoicePipeline.INBOX_POLL_INTERVAL_MS / 1000}s)`);
  }

  private stopInboxPoll(): void {
    let stopped = false;
    if (this.inboxPollTimer) {
      clearInterval(this.inboxPollTimer);
      this.inboxPollTimer = null;
      stopped = true;
    }
    this.inboxPollInFlight = false;
    this.inboxPollNotifiedStamps.clear();
    this.dropIdleNotifications((item) => item.kind === 'text-activity', 'poll-stop');
    if (stopped) console.log('Inbox background poll stopped');
  }

  private async pollInboxForTextActivity(): Promise<void> {
    if (!this.inboxClient) return;
    if (this.inboxPollInFlight) return;
    this.inboxPollInFlight = true;

    try {
      const inboxResult = await this.inboxClient.getInbox();
      const now = Date.now();

      for (const channel of inboxResult.channels) {
        if (channel.unreadCount === 0) continue;

        const sessionKey = `channel:${channel.channelId}`;

        // Skip channels with recent voice dispatches — the text agent often
        // generates echo responses to voice-injected messages, which look like
        // "new" text messages but aren't useful to the user.
        const lastDispatch = this.recentVoiceDispatchChannels.get(sessionKey) ?? 0;
        if (now - lastDispatch < VoicePipeline.VOICE_DISPATCH_COOLDOWN_MS) continue;

        // Deduplicate: only notify once per channel until a genuinely NEW message
        // arrives. Use the latest message timestamp as the stamp.
        const lastNotified = this.inboxPollNotifiedStamps.get(sessionKey) ?? 0;
        const latestMsg = channel.messages[channel.messages.length - 1];
        const effectiveStamp = latestMsg?.timestamp ?? now;
        if (effectiveStamp <= lastNotified) continue;

        this.inboxPollNotifiedStamps.set(sessionKey, effectiveStamp);
        const channelLabel = getInboxChannelVoiceLabel(channel, channel.messages[0]?.agentDisplayName);
        this.notifyIfIdle(`New message in ${channelLabel}.`, {
          kind: 'text-activity',
          sessionKey,
          stamp: effectiveStamp,
        });
      }
    } catch (err: any) {
      console.warn(`Inbox background poll error: ${err.message}`);
    } finally {
      this.inboxPollInFlight = false;
    }
  }

  private async handleGatedMode(enabled: boolean): Promise<void> {
    setGatedMode(enabled);
    if (!enabled) {
      this.clearIndicateCapture('gated-disabled');
    }
    const message = enabled
      ? `Gated mode. I'll only respond when you say ${this.getSystemWakeName()}.`
      : "Open mode. I'll respond to everything.";
    await this.speakResponse(message, { inbox: true });
    await this.playReadyEarcon();
  }

  private async handleEndpointMode(mode: EndpointingMode): Promise<void> {
    setEndpointingMode(mode);
    if (mode !== 'indicate') {
      this.clearIndicateCapture('endpoint-mode-silence');
    }

    if (mode === 'indicate') {
      await this.speakResponse('Indicate mode ready.', { inbox: true });
    } else {
      await this.speakResponse('Silence endpointing mode enabled.', { inbox: true });
    }
    await this.playReadyEarcon();
  }

  private async handleWakeCheck(): Promise<void> {
    // Simple "I'm here" handshake:
    // listening (already played upstream) -> ready, then allow one
    // immediate no-wake follow-up utterance.
    this.stopWaitingLoop();
    this.setPromptGrace(15_000);
    this.playReadyEarconSync();
  }

  private async handlePause(): Promise<void> {
    console.log('Pause command: stopping playback');
    this.ctx.paused = true;
    this.ctx.pausedFromText = this.ctx.lastSpokenText || '';
    this.player.stopPlayback('pause-command');
    this.stopWaitingLoop();
    await this.player.playEarcon('paused');
    console.log(`Paused (saved ${this.ctx.pausedFromText.length} chars for resume)`);
  }

  private async handleResume(): Promise<void> {
    if (!this.ctx.paused) {
      await this.speakResponse("Nothing is paused.");
      await this.playReadyEarcon();
      return;
    }
    this.ctx.paused = false;
    const text = this.ctx.pausedFromText;
    this.ctx.pausedFromText = '';
    await this.player.playEarcon('resumed');
    if (text) {
      console.log(`Resuming: "${text.slice(0, 60)}..."`);
      await this.speakResponse(text, { isReplay: true });
      await this.playReadyEarcon();
    } else {
      console.log('Resume: no saved text to replay');
      await this.playReadyEarcon();
    }
  }

  private async handleReplay(): Promise<void> {
    if (!this.ctx.lastSpokenText) {
      await this.speakResponse("I haven't said anything yet.");
      await this.playReadyEarcon();
      return;
    }
    console.log(`Replay: "${this.ctx.lastSpokenText.slice(0, 60)}..."`);
    await this.speakResponse(this.ctx.lastSpokenText, { isReplay: true });
    await this.playReadyEarcon();
  }

  /**
   * "What's up?" — Agent-centric status summary.
   * Reports messages grouped by agent: "Malibu has 2 messages and Watson has 1."
   */
  private async handleWhatsUp(): Promise<void> {
    const parts: string[] = [];
    let agentInbox: VoiceInboxAgentResponse | null = null;

    // Check unified inbox for unread messages, grouped by agent
    if (this.inboxClient) {
      try {
        agentInbox = await this.inboxClient.getAgentInbox();
        if (agentInbox.pendingCount > 0) {
          parts.push(`${agentInbox.pendingCount} still processing.`);
        }
      } catch {
        // Ignore — will fall through to notification check
      }
    }

    const spokenAgents = this.mergeSpokenInboxAgents(agentInbox);
    const agentSummary = this.formatAgentMessageSummary(spokenAgents);
    if (agentSummary) {
      parts.unshift(agentSummary);
    }

    // Check idle notification queue
    const queuedNotifications = this.getQueuedNotificationCount();
    if (queuedNotifications > 0) {
      parts.push(`${queuedNotifications} notification${queuedNotifications === 1 ? '' : 's'} queued.`);
    }

    if (parts.length === 0) {
      parts.push('Nothing pending. All clear.');
    }

    await this.speakResponse(parts.join(' '), { inbox: true });
    await this.playReadyEarcon();
  }

  /**
   * Read the next ready response from the queue — natural follow-up
   * after hearing a nudge notification ("Watson has a response").
   *
   * If addressed ("go ahead malibu", "let's hear it watson"), reads that
   * agent's ready item by jumping to it in the inbox flow.
   * If bare ("go ahead"), reads the oldest ready item.
   */
  private async handleReadReady(agent?: string): Promise<void> {
    const localReadyItem = this.findLocalReadyItem(agent);
    if (localReadyItem) {
      await this.readQueuedReadyItem(localReadyItem, { bypassBusyCheck: true });
      return;
    }

    if (!agent) {
      await this.handleInboxNext();
      return;
    }

    // Agent-targeted: find matching agent item in the current inbox flow or fetch fresh
    const needle = agent.toLowerCase();
    const flowState = this.stateMachine.getInboxFlowState();

    if (flowState) {
      // Search remaining items for a matching agent
      const matchIndex = flowState.items.findIndex((item, i) => {
        if (i < flowState.index) return false;
        const agentItem = item as InboxAgentItem;
        if (agentItem.agentId && agentItem.agentDisplayName) {
          return agentItem.agentDisplayName.toLowerCase().includes(needle)
            || agentItem.agentId.toLowerCase().includes(needle);
        }
        // Legacy ChannelActivity fallback
        const act = item as ChannelActivity;
        return act.displayName.toLowerCase().includes(needle)
          || act.channelName.toLowerCase().includes(needle);
      });
      if (matchIndex >= 0) {
        this.ctx.inboxConversationAgentId = null;
        this.transitionAndResetWatchdog({ type: 'INBOX_JUMP', index: matchIndex });
        await this.handleInboxNext();
        return;
      }
    }

    // No active flow or no match — fetch fresh agent inbox and look for the agent
    if (this.inboxClient && this.router) {
      try {
        const agentInbox = await this.inboxClient.getAgentInbox();
        const match = agentInbox.agents.find(
          (a) => a.agentDisplayName.toLowerCase().includes(needle)
            || a.agentId.toLowerCase().includes(needle),
        );
        if (match) {
          const agentItems: InboxAgentItem[] = agentInbox.agents.map((inboxAgent) => this.mapInboxAgentItem(inboxAgent));

          const targetIndex = agentItems.findIndex(
            (a) => a.agentDisplayName.toLowerCase().includes(needle)
              || a.agentId.toLowerCase().includes(needle),
          );

          this.ctx.inboxConversationAgentId = null;
          this.transitionAndResetWatchdog({
            type: 'ENTER_INBOX_FLOW',
            items: agentItems,
            returnChannel: this.router.getActiveChannel().name,
          });
          if (targetIndex > 0) {
            this.transitionAndResetWatchdog({ type: 'INBOX_JUMP', index: targetIndex });
          }
          await this.handleInboxNext();
          return;
        }
      } catch (error) {
        console.warn(`[voice-inbox] agent-targeted read failed: ${error instanceof Error ? error.message : error}`);
      }
    }

    await this.speakResponse(`Nothing from ${agent} in the inbox.`);
    await this.playReadyEarcon();
  }

  private async handleHearFullMessage(): Promise<void> {
    // If we have a stored channel message, read its full version
    if (this.ctx.lastSpokenIsChannelMessage) {
      const full = this.ctx.lastSpokenFullText || this.ctx.lastSpokenText;
      if (full) {
        console.log(`Hear full message (stored): "${full.slice(0, 60)}..."`);
        await this.speakResponse(full, { isReplay: true, forceFull: true, speakerAgentId: this.ctx.lastSpokenSpeakerAgentId });
        await this.playReadyEarcon();
        this.allowFollowupPromptGrace(VoicePipeline.FOLLOWUP_PROMPT_GRACE_MS);
        return;
      }
    }

    // No channel message stored (e.g. after a channel switch) — fetch the last
    // message from the active channel and read it in full.
    if (this.router) {
      const lastMsg = await this.router.getLastMessageFresh();
      if (lastMsg) {
        const content = lastMsg.role === 'user'
          ? `You last said: ${lastMsg.content}`
          : this.toSpokenText(lastMsg.content, 'Message available.');
        console.log(`Hear full message (fetched): "${content.slice(0, 60)}..."`);
        await this.speakResponse(content, { inbox: true, forceFull: true, isChannelMessage: true, speakerAgentId: this.router.getActiveTangoRoute?.()?.agentId ?? null });
        await this.playReadyEarcon();
        this.allowFollowupPromptGrace(VoicePipeline.FOLLOWUP_PROMPT_GRACE_MS);
        return;
      }
    }

    await this.speakResponse("I don't have a full message to read yet.");
    await this.playReadyEarcon();
  }

  private async handleInboxRespond(): Promise<void> {
    if (!this.ctx.lastSpokenIsChannelMessage || !this.router) {
      await this.speakResponse("I don't have a message open to reply to.", { inbox: true });
      await this.playReadyEarcon();
      return;
    }

    this.clearInboxFlowIfActive('voice command: inbox-respond');
    await this.speakResponse('Okay. Reply when ready.', { inbox: true, isReplay: true });
    await this.playReadyEarcon();
    this.setPromptGrace(VoicePipeline.FOLLOWUP_PROMPT_GRACE_MS);
    this.allowFollowupPromptGrace(VoicePipeline.FOLLOWUP_PROMPT_GRACE_MS);
  }

  private async handleEarconTour(): Promise<void> {
    const tour: Array<{ name: EarconName; label: string }> = [
      { name: 'listening', label: 'listening' },
      { name: 'acknowledged', label: 'acknowledged' },
      { name: 'error', label: 'error' },
      { name: 'timeout-warning', label: 'timeout warning' },
      { name: 'cancelled', label: 'cancelled' },
      { name: 'ready', label: 'ready' },
      { name: 'busy', label: 'busy' },
      { name: 'gate-closed', label: 'gate closed' },
    ];

    await this.speakResponse('Starting earcon tour.', { inbox: true });
    for (const item of tour) {
      await this.speakResponse(`Earcon: ${item.label}.`, { inbox: true });
      await this.player.playEarcon(item.name);
      await this.sleep(120);
    }
    await this.speakResponse('Processing loop tone.', { inbox: true });
    this.player.playSingleTone();
    await this.sleep(3200);
    await this.speakResponse('Earcon tour complete.', { inbox: true });
  }

  private async handleInboxCheck(): Promise<void> {
    this.ctx.inboxConversationAgentId = null;

    // Unified voice inbox: use Discord-anchored watermark system, grouped by agent
    if (this.inboxClient && this.router) {
      try {
        const agentInbox = await this.inboxClient.getAgentInbox();
        const spokenAgents = this.mergeSpokenInboxAgents(agentInbox);
        if (spokenAgents.length === 0) {
          const pendingSuffix = agentInbox.pendingCount > 0
            ? ` ${agentInbox.pendingCount} processing.`
            : '';
          await this.speakResponse(`Zero ready.${pendingSuffix}`, { inbox: true });
          await this.playReadyEarcon();
          return;
        }

        // Convert agent groups to InboxAgentItem for the state machine flow
        const agentItems: InboxAgentItem[] = agentInbox.agents.map((a) => ({
          agentId: a.agentId,
          agentDisplayName: a.agentDisplayName,
          channels: a.channels,
          totalUnread: a.totalUnread,
        }));

        const announcement = this.formatAgentMessageSummary(spokenAgents);
        const pendingSuffix = agentInbox.pendingCount > 0
          ? ` ${agentInbox.pendingCount} still processing.`
          : '';

        if (agentItems.length === 0) {
          await this.speakResponse(
            `${announcement}${pendingSuffix} Say go ahead and an agent name, or next.`,
            { inbox: true },
          );
          await this.playReadyEarcon();
          return;
        }

        this.transitionAndResetWatchdog({
          type: 'ENTER_INBOX_FLOW',
          items: agentItems,
          returnChannel: this.router.getActiveChannel().name,
        });

        await this.speakResponse(
          `${announcement}${pendingSuffix} Say go ahead and an agent name, or next.`,
          { inbox: true },
        );
        await this.playReadyEarcon();
        return;
      } catch (error) {
        console.warn(`[voice-inbox] inbox client check failed: ${error instanceof Error ? error.message : error}`);
        await this.speakResponse('Inbox is temporarily unavailable.');
        await this.playReadyEarcon();
        return;
      }
    }

    // No inbox client configured
    await this.speakResponse('Nothing new.');
    await this.playReadyEarcon();
  }

  private mapInboxAgentItem(agent: VoiceInboxAgentGroup): InboxAgentItem {
    return {
      agentId: agent.agentId,
      agentDisplayName: agent.agentDisplayName,
      channels: agent.channels,
      totalUnread: agent.totalUnread,
    };
  }

  private async getFreshInboxAgent(agentId: string): Promise<{ agentItem: InboxAgentItem | null; otherAgentCount: number }> {
    if (!this.inboxClient) {
      return { agentItem: null, otherAgentCount: 0 };
    }

    try {
      const agentInbox = await this.inboxClient.getAgentInbox();
      const agentItems = agentInbox.agents.map((agent) => this.mapInboxAgentItem(agent));
      const agentItem = agentItems.find((item) => item.agentId === agentId) ?? null;
      const otherAgentCount = agentItems.filter((item) => item.agentId !== agentId).length;
      return { agentItem, otherAgentCount };
    } catch (error) {
      console.warn(`[voice-inbox] pinned agent refresh failed: ${error instanceof Error ? error.message : error}`);
      return { agentItem: null, otherAgentCount: 0 };
    }
  }

  private async readPinnedInboxAgentNext(agentItem: InboxAgentItem): Promise<void> {
    const channels = agentItem.channels as VoiceInboxChannel[];
    const nextChannel = channels[0];

    if (!nextChannel) {
      this.ctx.inboxConversationAgentId = null;
      await this.handleInboxNext();
      return;
    }

    const result = await this.readUnifiedInboxItem(nextChannel, { maxGroups: 1 });
    const { agentItem: refreshedAgentItem, otherAgentCount } = await this.getFreshInboxAgent(agentItem.agentId);
    const remainingForAgent = refreshedAgentItem?.totalUnread ?? 0;
    const parts = result.parts;

    if (remainingForAgent > 0) {
      this.ctx.inboxConversationAgentId = agentItem.agentId;
      parts.push(`${remainingForAgent} more from ${agentItem.agentDisplayName}. Say next, done, or respond.`);
    } else if (otherAgentCount > 0) {
      this.ctx.inboxConversationAgentId = null;
      const waitingLabel = otherAgentCount === 1
        ? '1 other agent is waiting. Say next, done, or respond.'
        : `${otherAgentCount} other agents are waiting. Say next, done, or respond.`;
      parts.push(waitingLabel);
    } else {
      this.ctx.inboxConversationAgentId = null;
      this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
      parts.push("That's everything. Say respond to reply here.");
    }

    const fullText = this.toSpokenText(parts.join(' '), 'Nothing new in the inbox.');
    await this.speakResponse(fullText, { inbox: true, allowSummary: true, forceFull: false, isChannelMessage: true, speakerAgentId: agentItem.agentId });
    await this.playReadyEarcon();
    this.allowFollowupPromptGrace(VoicePipeline.FOLLOWUP_PROMPT_GRACE_MS);
  }

  private async handleInboxNext(): Promise<void> {
    let agentItem: InboxAgentItem | null = null;
    const flowState = this.stateMachine.getInboxFlowState();

    if (!flowState || flowState.index >= flowState.items.length) {
      const localReadyItem = this.findLocalReadyItem();
      if (localReadyItem) {
        await this.readQueuedReadyItem(localReadyItem, { bypassBusyCheck: true });
        return;
      }
    }

    if (flowState && this.ctx.inboxConversationAgentId) {
      const pinnedAgentId = this.ctx.inboxConversationAgentId;
      const { agentItem: pinnedAgentItem } = await this.getFreshInboxAgent(pinnedAgentId);
      if (pinnedAgentItem) {
        console.log(`[inbox-next] continuing with pinned agent=${pinnedAgentItem.agentDisplayName} (${pinnedAgentItem.agentId}) unread=${pinnedAgentItem.totalUnread}`);
        await this.readPinnedInboxAgentNext(pinnedAgentItem);
        return;
      }

      this.ctx.inboxConversationAgentId = null;
    }

    if (flowState && flowState.index < flowState.items.length) {
      const item = flowState.items[flowState.index];
      // Check if this is an agent-grouped item (has agentId + channels)
      if (item && item.agentId && item.channels) {
        agentItem = item as InboxAgentItem;
      } else {
        // Legacy ChannelActivity fallback — read as before
        const activity = item as ChannelActivity;
        this.transitionAndResetWatchdog({ type: 'INBOX_ADVANCE' });
        const inboxChannel = (activity as any)._inboxChannel as VoiceInboxChannel | undefined;
        const inboxResult = inboxChannel && this.inboxClient
          ? await this.readUnifiedInboxItem(inboxChannel)
          : null;
        const parts = inboxResult ? inboxResult.parts : [this.buildSwitchConfirmation(activity.displayName)];
        const speakerAgentId = inboxResult?.agentId ?? null;

        const updatedFlow = this.stateMachine.getInboxFlowState();
        const remaining = updatedFlow ? updatedFlow.items.length - updatedFlow.index : 0;
        if (remaining > 0) {
          parts.push(`${remaining} more. Say next, done, or respond.`);
        } else {
          this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
          parts.push("That's everything. Say respond to reply here.");
        }

        const fullText = this.toSpokenText(parts.join(' '), 'Nothing new in the inbox.');
        await this.speakResponse(fullText, { inbox: true, allowSummary: true, forceFull: false, isChannelMessage: true, speakerAgentId });
        await this.playReadyEarcon();
        this.allowFollowupPromptGrace(VoicePipeline.FOLLOWUP_PROMPT_GRACE_MS);
        return;
      }
    } else if (this.inboxClient && this.router) {
      // Fresh check via agent inbox if flow is exhausted
      try {
        const agentInbox = await this.inboxClient.getAgentInbox();
        if (agentInbox.agents.length > 0) {
          const agentItems: InboxAgentItem[] = agentInbox.agents.map((agent) => this.mapInboxAgentItem(agent));

          this.transitionAndResetWatchdog({
            type: 'ENTER_INBOX_FLOW',
            items: agentItems,
            returnChannel: this.router.getActiveChannel().name,
          });
          agentItem = agentItems[0]!;
        }
      } catch (error) {
        console.warn(`[voice-inbox] inbox client next failed: ${error instanceof Error ? error.message : error}`);
      }
    }

    if (agentItem) {
      this.transitionAndResetWatchdog({ type: 'INBOX_ADVANCE' });
      const speakerAgentId = agentItem.agentId;
      console.log(`[inbox-next] agent=${agentItem.agentDisplayName} (${agentItem.agentId}) unread=${agentItem.totalUnread} channels=${agentItem.channels?.length} speakerAgentId=${speakerAgentId}`);

      // Single-message agents and single-channel multi-message agents should
      // read directly one message-group at a time. Topic-selection only helps
      // when there are multiple unread channels to choose between.
      if (agentItem.totalUnread === 1 || (agentItem.channels?.length ?? 0) <= 1) {
        await this.readPinnedInboxAgentNext(agentItem);
        return;
      }

      // Multi-message agent: generate summary, enter topic selection mode
      const summary = await generateAgentSummary(agentItem.agentDisplayName, agentItem.channels as VoiceInboxChannel[]);

      // Update flow state to indicate topic selection mode
      const currentFlow = this.stateMachine.getInboxFlowState();
      if (currentFlow && this.stateMachine.getState().type === 'INBOX_FLOW') {
        const state = this.stateMachine.getState() as any;
        state.topicSelectionMode = true;
        state.currentAgentIndex = currentFlow.index - 1; // we already advanced
      }

      const suffix = ' Say tell me about a topic, summarize, read all, or next.';

      await this.speakResponse(summary + suffix, { inbox: true, speakerAgentId });
      await this.playReadyEarcon();
      this.allowFollowupPromptGrace(VoicePipeline.FOLLOWUP_PROMPT_GRACE_MS);
      return;
    }

    // No items found
    await this.speakResponse(await this.switchHomeWithMessage("Nothing new in the inbox."), { inbox: true });
    await this.playReadyEarcon();
  }

  /**
   * Read all messages from an agent's inbox channels.
   * Switches to each channel, reads messages, and advances watermarks.
   */
  private async readAgentInboxMessages(agentItem: InboxAgentItem): Promise<string[]> {
    const parts: string[] = [];
    const channels = agentItem.channels as VoiceInboxChannel[];

    for (const channel of channels) {
      const result = await this.readUnifiedInboxItem(channel);
      parts.push(...result.parts);
    }

    if (parts.length === 0) {
      parts.push(`${agentItem.agentDisplayName} has no new messages.`);
    }

    return parts;
  }

  /**
   * Handle "tell me about X" — topic selection within the current agent's messages.
   */
  private async handleInboxTopicSelect(query: string): Promise<void> {
    const flowState = this.stateMachine.getInboxFlowState();
    if (!flowState) {
      await this.speakResponse("No inbox flow active.");
      await this.playReadyEarcon();
      return;
    }

    const state = this.stateMachine.getState() as any;
    const agentIndex = state.currentAgentIndex ?? (flowState.index - 1);
    const agentItem = flowState.items[agentIndex] as InboxAgentItem | undefined;

    if (!agentItem || !agentItem.channels) {
      await this.speakResponse("No agent selected for topic selection.");
      await this.playReadyEarcon();
      return;
    }

    const channels = agentItem.channels as VoiceInboxChannel[];
    const allMessages: { channelName: string; preview: string; channel: VoiceInboxChannel; msgIndex: number }[] = [];

    for (const ch of channels) {
      for (let i = 0; i < ch.messages.length; i++) {
        allMessages.push({
          channelName: getInboxChannelVoiceLabel(ch, agentItem.agentDisplayName),
          preview: ch.messages[i].content.slice(0, 200),
          channel: ch,
          msgIndex: i,
        });
      }
    }

    const matchIndex = await classifyTopicSelection(
      query,
      allMessages.map((m) => ({ channelName: m.channelName, preview: m.preview })),
    );

    if (matchIndex >= 0 && matchIndex < allMessages.length) {
      // Clear topic selection mode once we have a concrete match.
      state.topicSelectionMode = false;

      // Read the matched message's channel
      const matched = allMessages[matchIndex];
      const result = await this.readUnifiedInboxItem(matched.channel);

      const updatedFlow = this.stateMachine.getInboxFlowState();
      const remaining = updatedFlow ? updatedFlow.items.length - updatedFlow.index : 0;
      const parts = result.parts;

      if (remaining > 0) {
        parts.push(`${remaining} more. Say next, done, or respond.`);
      } else {
        this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
        parts.push("That's everything. Say respond to reply here.");
      }

      const fullText = this.toSpokenText(parts.join(' '), 'Nothing matched.');
      await this.speakResponse(fullText, { inbox: true, allowSummary: true, forceFull: false, isChannelMessage: true, speakerAgentId: agentItem.agentId });
      await this.playReadyEarcon();
      this.allowFollowupPromptGrace(VoicePipeline.FOLLOWUP_PROMPT_GRACE_MS);
    } else {
      const topicLabels = [...new Set(
        channels
          .map((channel) => getInboxChannelVoiceLabel(channel, agentItem.agentDisplayName))
          .filter((label) => label.length > 0),
      )];
      const labelList = topicLabels.length <= 1
        ? (topicLabels[0] ?? 'that topic')
        : topicLabels.length === 2
          ? `${topicLabels[0]} or ${topicLabels[1]}`
          : `${topicLabels.slice(0, -1).join(', ')}, or ${topicLabels[topicLabels.length - 1]}`;
      const heard = query.trim().replace(/[.!?]+$/g, '').trim();
      const retryPrompt = heard.length > 0
        ? `I didn't match "${heard}" to a ${agentItem.agentDisplayName} topic. Say ${labelList}. You can also say summarize, read all, or next.`
        : `I didn't catch the topic. Say ${labelList}. You can also say summarize, read all, or next.`;

      await this.speakResponse(retryPrompt, { inbox: true, speakerAgentId: agentItem.agentId });
      await this.playReadyEarcon();
      this.allowFollowupPromptGrace(VoicePipeline.FOLLOWUP_PROMPT_GRACE_MS);
    }
  }

  /**
   * Handle "read all" — start sequential playback for the current agent.
   * The first unread message-group is read now; subsequent "next" commands
   * keep stepping through the same agent until exhausted.
   */
  private async handleInboxReadAll(): Promise<void> {
    const flowState = this.stateMachine.getInboxFlowState();
    if (!flowState) {
      await this.speakResponse("No inbox flow active.");
      await this.playReadyEarcon();
      return;
    }

    const state = this.stateMachine.getState() as any;
    const agentIndex = state.currentAgentIndex ?? (flowState.index - 1);
    const agentItem = flowState.items[agentIndex] as InboxAgentItem | undefined;

    if (!agentItem || !agentItem.channels) {
      // Fallback: just advance to next
      await this.handleInboxNext();
      return;
    }

    // Clear topic selection mode
    state.topicSelectionMode = false;

    await this.readPinnedInboxAgentNext(agentItem);
  }

  /**
   * Handle "summarize" — compress all unread items for the current agent into
   * a catch-up summary, preserving the old accidental-but-useful behavior.
   */
  private async handleInboxSummarize(): Promise<void> {
    const flowState = this.stateMachine.getInboxFlowState();
    if (!flowState) {
      await this.speakResponse('No inbox flow active.');
      await this.playReadyEarcon();
      return;
    }

    const state = this.stateMachine.getState() as any;
    const agentIndex = state.currentAgentIndex ?? (flowState.index - 1);
    const agentItem = flowState.items[agentIndex] as InboxAgentItem | undefined;

    if (!agentItem || !agentItem.channels) {
      await this.handleInboxNext();
      return;
    }

    state.topicSelectionMode = false;

    const parts = await this.readAgentInboxMessages(agentItem);
    const speakerAgentId = agentItem.agentId;
    const updatedFlow = this.stateMachine.getInboxFlowState();
    const remaining = updatedFlow ? updatedFlow.items.length - updatedFlow.index : 0;

    if (remaining > 0) {
      const otherWord = remaining === 1 ? 'agent' : 'agents';
      parts.push(`${remaining} other ${otherWord} waiting. Say next or done.`);
    } else {
      this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
      parts.push("That's everything.");
    }

    const fullText = this.toSpokenText(parts.join(' '), 'Nothing new in the inbox.');
    const spokenText = await this.buildInboxCatchUpSpeechText(fullText);
    await this.speakResponse(fullText, {
      inbox: true,
      allowSummary: false,
      forceFull: true,
      isChannelMessage: true,
      speakerAgentId,
      spokenTextOverride: spokenText,
    });
    await this.playReadyEarcon();
  }

  private async handleInboxClear(): Promise<void> {
    const flowState = this.stateMachine.getInboxFlowState();
    if (!flowState || flowState.index >= flowState.items.length) {
      // No active inbox flow — fetch and clear all unread directly
      let localCleared = 0;
      if (this.inboxClient) {
        try {
          const inboxResult = await this.inboxClient.getInbox();
          if (inboxResult.totalUnread > 0) {
            let cleared = 0;
            for (const ch of inboxResult.channels) {
              if (ch.messages.length > 0) {
                const lastMsg = ch.messages[ch.messages.length - 1];
                try {
                  await this.inboxClient.advanceWatermark(lastMsg.channelId, lastMsg.messageId, 'voice-dismiss');
                  this.clearLocalReadyItemsForInboxChannel(ch);
                  cleared++;
                } catch (error) {
                  console.warn(`[voice-inbox] dismiss watermark failed: ${error instanceof Error ? error.message : error}`);
                }
              }
            }
            const channelWord = cleared === 1 ? 'channel' : 'channels';
            await this.speakResponse(`Cleared ${cleared} ${channelWord} from the inbox.`, { inbox: true });
            await this.playReadyEarcon();
            return;
          }
        } catch (error) {
          console.warn(`[voice-inbox] standalone clear failed: ${error instanceof Error ? error.message : error}`);
        }
      }
      if (this.localReadyById.size > 0) {
        localCleared = this.localReadyById.size;
        for (const item of this.localReadyById.values()) {
          this.queueState?.markHeard(item.id);
        }
        this.localReadyById.clear();
        const responseWord = localCleared === 1 ? 'response' : 'responses';
        await this.speakResponse(`Cleared ${localCleared} ${responseWord} from the inbox.`, { inbox: true });
        await this.playReadyEarcon();
        return;
      }
      await this.speakResponse('Nothing to clear in the inbox.', { inbox: true });
      await this.playReadyEarcon();
      return;
    }

    const remaining = flowState.items.slice(flowState.index) as Array<ChannelActivity | InboxAgentItem>;

    // Advance watermarks for remaining unified inbox channels (dismiss = mark all as read)
    if (this.inboxClient) {
      for (const activity of remaining) {
        const inboxChannels = "channels" in activity && Array.isArray(activity.channels)
          ? activity.channels as VoiceInboxChannel[]
          : ((activity as any)._inboxChannel ? [(activity as any)._inboxChannel as VoiceInboxChannel] : []);

        for (const inboxChannel of inboxChannels) {
          if (inboxChannel.messages.length === 0) continue;
          const lastMsg = inboxChannel.messages[inboxChannel.messages.length - 1];
          try {
            await this.inboxClient.advanceWatermark(lastMsg.channelId, lastMsg.messageId, 'voice-dismiss');
            this.clearLocalReadyItemsForInboxChannel(inboxChannel);
          } catch (error) {
            console.warn(`[voice-inbox] dismiss watermark failed: ${error instanceof Error ? error.message : error}`);
          }
        }
      }
    }

    const returnChannel = flowState.returnChannel;
    this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
    await this.restoreChannel(returnChannel);
    const channelWord = remaining.length === 1 ? 'channel' : 'channels';
    await this.speakResponse(`Cleared ${remaining.length} ${channelWord} from the inbox.`, { inbox: true });
    await this.playReadyEarcon();
  }

  private async restoreChannel(channelName: string | null | undefined): Promise<void> {
    if (!channelName || !this.router) return;
    const active = this.router.getActiveChannel();
    if (active.name === channelName) return; // already there
    const result = await this.router.switchTo(channelName);
    if (result.success) {
      await this.onChannelSwitch();
      console.log(`Inbox flow: restored to ${result.displayName || channelName}`);
    }
  }

  private async switchHomeWithMessage(prefix: string): Promise<string> {
    if (this.router) {
      const result = await this.router.switchToDefault();
      if (result.success) {
        await this.onChannelSwitch();
        return `${prefix} Switching to ${result.displayName || 'General'}.`;
      }
    }
    return prefix;
  }

  private clearInboxFlowIfActive(reason: string): void {
    if (this.stateMachine.getStateType() !== 'INBOX_FLOW') return;
    console.log(`Clearing inbox flow (${reason})`);
    this.ctx.inboxConversationAgentId = null;
    this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
  }

  /**
   * Read messages from a unified inbox channel (Discord-anchored watermark system).
   * Reads all unread messages, advances the watermark after each one.
   */
  private async readUnifiedInboxItem(
    channel: VoiceInboxChannel,
    options?: { maxGroups?: number },
  ): Promise<{ parts: string[]; agentId: string | null }> {
    const parts: string[] = [];
    // Extract the agent ID from the first message (all messages in a channel share the same agent)
    const agentId = channel.messages[0]?.agentId ?? null;
    this.ctx.inboxConversationAgentId = agentId;
    this.clearLocalReadyItemsForInboxChannel(channel);

    // Try to switch to the channel by name
    if (this.router) {
      const result = await this.router.switchTo(channel.channelName);
      if (result.success) {
        await this.onChannelSwitch();
      }
    }

    const channelLabel = getInboxChannelVoiceLabel(channel, channel.messages[0]?.agentDisplayName);
    parts.push(`Switched to ${channelLabel}.`);

    // Group chunked messages and build readable text
    const grouped = this.groupChunkedMessages(channel.messages);
    const maxGroups = Math.max(1, options?.maxGroups ?? grouped.length);
    const selectedGroups = grouped.slice(0, maxGroups);

    for (const group of selectedGroups) {
      const combinedText = group.map((m) => m.content).join('\n');
      const speakable = this.toSpokenText(combinedText, 'A response is available.');
      parts.push(speakable);

      // Advance watermark to the last message in this group
      const lastMessage = group[group.length - 1];
      if (lastMessage && this.inboxClient) {
        try {
          await this.inboxClient.advanceWatermark(
            lastMessage.channelId,
            lastMessage.messageId,
            'voice-playback',
          );
        } catch (error) {
          console.warn(`[voice-inbox] watermark advance failed: ${error instanceof Error ? error.message : error}`);
        }
      }
    }

    return { parts, agentId };
  }

  /**
   * Group consecutive chunked messages into logical response groups.
   * Messages with isChunked=true and matching chunkGroupId are grouped together.
   * Non-chunked messages each form their own group.
   */
  private groupChunkedMessages(messages: VoiceInboxMessage[]): VoiceInboxMessage[][] {
    const groups: VoiceInboxMessage[][] = [];
    let currentGroup: VoiceInboxMessage[] = [];

    for (const msg of messages) {
      if (msg.isChunked && currentGroup.length > 0) {
        // Continue the current chunk group
        currentGroup.push(msg);
      } else {
        // Start a new group
        if (currentGroup.length > 0) {
          groups.push(currentGroup);
        }
        currentGroup = [msg];
      }
    }

    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }

    return groups;
  }

  private matchBareQueueCommand(
    transcript: string,
    options?: { allowSwitch?: boolean },
  ): VoiceCommand | null {
    const input = transcript.trim().toLowerCase().replace(/[.!?,]+$/, '');
    const normalized = input
      .replace(/[,.!?;:]+/g, ' ')
      .replace(/\bin-?box\b/g, 'inbox')
      .replace(/\bin\s+box\b/g, 'inbox')
      .replace(/\s+/g, ' ')
      .trim();
    const politeStripped = normalized
      .replace(/^(?:please\s+)?(?:can|could|would)\s+you\s+/, '')
      .replace(/^please\s+/, '')
      .trim();
    const navInput = politeStripped || normalized;

    // "next", "next one", "next response", "next message", "next channel", "done", "I'm done", "move on", "skip", "skip it", "skip this"
    if (/^(?:next(?:\s+(?:response|one|message|channel))?|(?:i'?m\s+)?done|i\s+am\s+done|move\s+on|skip(?:\s+(?:it|this(?:\s+one)?))?)$/.test(normalized)) {
      return { type: 'inbox-next' };
    }

    // "clear inbox", "clear the inbox", "mark inbox read", "clear all"
    if (/^(?:clear\s+(?:the\s+)?inbox|mark\s+(?:the\s+)?inbox\s+(?:as\s+)?read|mark\s+all\s+read|clear\s+all)$/.test(normalized)) {
      return { type: 'inbox-clear' };
    }

    // "read last message", "read the/my last message", "last message", "my last message"
    if (/^(?:read\s+(?:(?:the|my)\s+)?last\s+message|(?:(?:the|my)\s+)?last\s+message)$/.test(normalized)) {
      return { type: 'read-last-message' };
    }

    // "hear full message", "here full message" (STT homophone), "read full message", "full message"
    // "hear full message", "here full message" (STT homophone), "hear fullness" (STT misheard), "read full message", "full message"
    if (/^(?:hear|here|read|play)\s+(?:(?:the|a|an)\s+)?full(?:ness|\s+message)$|^full\s+message$/.test(normalized)) {
      return { type: 'hear-full-message' };
    }

    // "switch channels", "change channels", "list channels", "show channels"
    // Voice UX: map to inbox status instead of channel enumeration.
    if (/^(?:change|switch|list|show)\s+channels?$/.test(navInput)) {
      return { type: 'inbox-check' };
    }

    if (options?.allowSwitch) {
      // Bare no-wake switching is only allowed during explicit interactive windows
      // like grace or inbox flow, never during ordinary background listening.
      const switchMatch = navInput.match(/^(?:(?:we|let'?s)\s+)?(?:go|switch|change|move)(?:\s+channels?)?\s+to\s+(.+)$/);
      if (switchMatch) {
        const target = switchMatch[1].trim().replace(/\s+channel$/, '').trim();
        if (/^(?:inbox|the\s+inbox|my\s+inbox)$/.test(target)) {
          return { type: 'inbox-check' };
        }
        if (/^(?:default|home|back)$/.test(target)) {
          return { type: 'default' };
        }
        if (!/^(?:inbox|queue|background|wait|focus|ask)\s+mode$/.test(target)) {
          return { type: 'switch', channel: target };
        }
      }
    }

    // "go back", "go home", "default", "back to inbox"
    if (/^(?:go\s+back|go\s+home|default|back\s+to\s+inbox|go\s+to\s+inbox)$/.test(navInput)) {
      return { type: 'default' };
    }

    // "inbox list", "inbox", "what do I have", "check inbox", "what's new", etc.
    if (
      /^(?:inbox(?:\s+(?:list|status|check))?|what\s+do\s+(?:i|you)\s+have(?:\s+for\s+me)?|check\s+(?:the\s+)?(?:queue|inbox)|what'?s\s+(?:waiting|ready|new)|queue\s+status)$/.test(navInput) ||
      /\binbox\s+(?:list|status|check)\b/.test(navInput)
    ) {
      return { type: 'inbox-check' };
    }

    // "what's up?", "any updates?", "anything new?" — table status
    if (/^(?:what'?s\s+up|any\s+updates?|anything\s+(?:new|going\s+on)|status\s+update|what(?:\s+do\s+you)?\s+have\s+for\s+me|what'?s\s+(?:going\s+on|happening|the\s+situation))$/.test(navInput)) {
      return { type: 'whats-up' };
    }

    // "go ahead [agent]", "let's hear it [agent]", "what do you have [agent]"
    // Also bare: "read it", "play it", "tell me", "what did they say", etc.
    // Natural follow-up after hearing a nudge notification.
    // Patterns that support optional trailing agent name | patterns that don't
    const readReadyMatch = navInput.match(
      /^(?:go\s+ahead|let'?s?\s+hear\s+it|let\s+me\s+hear\s+it|what\s+(?:do|does)\s+(?:they|he|she|it|you)\s+have)(?:\s+(.+?))?$|^(?:read\s+it|play\s+it|tell\s+me|what\s+did\s+(?:they|he|she|it|you)\s+say|what(?:'?d|\s+did)\s+(?:they|he|she|it|you)\s+have|what\s+(?:is|was)\s+(?:the|that)\s+(?:response|answer|message|reply))$/,
    );
    if (readReadyMatch) {
      return { type: 'read-ready', agent: readReadyMatch[1]?.trim() || undefined };
    }

    // "read all", "read everything", "all of them" — read all messages for current agent
    if (/^(?:read\s+(?:all|everything|them\s+all)|all\s+of\s+them|(?:play|hear)\s+(?:all|everything|them\s+all))$/.test(navInput)) {
      return { type: 'inbox-read-all' };
    }

    // "summarize", "summary", "catch me up" — summarize current agent's unread messages
    if (/^(?:summari[sz]e(?:\s+(?:all|them|everything))?|summary|give\s+me\s+(?:a\s+)?summary|catch\s+me\s+up)$/.test(navInput)) {
      return { type: 'inbox-summarize' };
    }

    // "respond", "reply", "respond to that", "reply here"
    if (/^(?:respond|reply|respond\s+here|reply\s+here|respond\s+to\s+(?:that|this|the\s+message)|reply\s+to\s+(?:that|this|the\s+message))$/.test(navInput)) {
      return { type: 'inbox-respond' };
    }

    // Topic selection — "tell me about X", "what about X", "the X one", "do the X", "read the X"
    // "the X one" captures X in group 1; all other prefixes capture the remainder in group 2.
    const currentState = this.stateMachine.getState() as any;
    const topicSelectionActive = currentState?.type === 'INBOX_FLOW' && currentState.topicSelectionMode;
    if (topicSelectionActive) {
      const topicMatch = navInput.match(
        /^(?:tell\s+me\s+about|what\s+about|more\s+about|details\s+(?:on|about)|do\s+(?:the\s+)?|read\s+(?:me\s+)?(?:the\s+)?|play\s+(?:the\s+)?|hear\s+(?:the\s+)?|(?:let'?s?\s+)(?:hear|do)\s+(?:the\s+)?)\s*(.+)$/,
      ) ?? navInput.match(
        /^the\s+(.+?)\s+one$/,
      );
      if (topicMatch) {
        const query = (topicMatch[1] || '').trim();
        if (query) {
          return { type: 'inbox-topic-select', query };
        }
      }
    }

    return null;
  }

  private buildSwitchConfirmation(displayName: string): string {
    const lastMsg = this.router?.getLastMessage();
    let text = `Switched to ${displayName}.`;
    if (lastMsg) {
      // Truncate long messages for TTS and guard non-string payloads
      const raw = this.toSpokenText((lastMsg as any).content, 'Message available.');
      const content = raw.length > 200 ? raw.slice(0, 200) + '...' : raw;
      if (lastMsg.role === 'user') {
        text += ` You last said: ${content}`;
      } else {
        text += ` ${content}`;
      }
    }
    return text;
  }

  private async speakResponse(
    text: string,
    options?: {
      inbox?: boolean;
      isReplay?: boolean;
      allowSummary?: boolean;
      forceFull?: boolean;
      isChannelMessage?: boolean;
      speakerAgentId?: string | null;
      spokenTextOverride?: string;
    },
  ): Promise<void> {
    const fullText = this.toSpokenText(text, '');
    const spokenTextOverride = options?.spokenTextOverride?.trim();
    const shouldSummarize = !spokenTextOverride && !!options?.allowSummary && !options?.forceFull;
    const spokenText = spokenTextOverride
      ? this.toSpokenText(spokenTextOverride, fullText)
      : shouldSummarize
        ? await this.buildSummarySpeechText(fullText)
        : fullText;

    // Keep spoken summaries/prompts out of channel transcripts to avoid
    // duplicating content and to keep "read last message" aligned to real
    // channel messages.
    if (options?.inbox) {
      this.logToInbox(`**${this.getSystemSpeakerLabel()}:** ${spokenText}`);
    }
    if (!options?.isReplay) {
      this.ctx.lastSpokenText = spokenText;
      this.ctx.lastSpokenFullText = fullText;
      this.ctx.lastSpokenWasSummary = spokenText !== fullText;
      this.ctx.lastSpokenIsChannelMessage = !!options?.isChannelMessage;
      this.ctx.lastSpokenSpeakerAgentId = options?.speakerAgentId ?? null;
      if (options?.isChannelMessage && options?.speakerAgentId) {
        const activeChannelName = this.router?.getActiveChannel().name ?? null;
        const activeSessionKey = this.router?.getActiveSessionKey() ?? null;
        this.setReplyContext(
          options.speakerAgentId,
          activeSessionKey,
          activeChannelName,
          VoicePipeline.REPLY_CONTEXT_DURATION_MS,
        );
      }
    }
    const wasSummarized = spokenText !== fullText;
    console.log(`[speakResponse] fullLen=${fullText.length} spokenLen=${spokenText.length} summarized=${wasSummarized} allowSummary=${!!options?.allowSummary} forceFull=${!!options?.forceFull} text="${spokenText.slice(0, 120)}${spokenText.length > 120 ? '...' : ''}"`);
    this.stopWaitingLoop();
    this.player.stopPlayback('speak-response-preempt');
    // Close any stale grace windows so the gate is closed during playback.
    // Only wake-word interrupts should stop active TTS; grace reopens after.
    this.ctx.gateGraceUntil = 0;
    this.ctx.promptGraceUntil = 0;
    this.clearGraceTimer();
    await this.player.waitForPlaybackSettled?.(300);
    const ttsStream = await textToSpeechStream(spokenText, {
      kokoroVoice: this.getSpeakerKokoroVoice(options?.speakerAgentId),
    });
    await this.player.playStream(ttsStream);
    this.ctx.lastPlaybackText = spokenText;
    this.ctx.lastPlaybackCompletedAt = Date.now();
    this.setGateGrace(5_000);
  }

  private shouldSummarizeForVoice(text: string): boolean {
    if (!text) return false;
    const normalized = text.trim();
    if (normalized.length < 450) return false;

    const lineCount = normalized.split('\n').filter((l) => l.trim().length > 0).length;
    const toolChatterHits = (normalized.match(
      /\b(?:let me|i(?:'m| am)\s+(?:going to|checking|looking|opening|searching|trying)|opening up the browser|found (?:the|an) item|adding it now|working on it)\b/gi,
    ) ?? []).length;

    const shouldSummarize = normalized.length >= 1800 || lineCount >= 20 || toolChatterHits >= 4;
    console.log(`[summary-check] len=${normalized.length} lines=${lineCount} chatter=${toolChatterHits} → ${shouldSummarize ? 'SUMMARIZE' : 'FULL'}`);
    return shouldSummarize;
  }

  private async summarizeForVoice(fullText: string): Promise<string | null> {
    const clipped = fullText.slice(0, 7000);
    const system = [
      'You summarize assistant output for spoken voice UX.',
      'Return plain text only, 2 to 4 short sentences.',
      'Include outcome first, key facts second, and any required next action.',
      'Exclude tool narration, thinking steps, and process chatter.',
      'Do not use markdown or bullets.',
    ].join(' ');

    try {
      const out = await quickCompletion(system, `Original response:\n${clipped}`, 140);
      const text = this.toSpokenText(out, '').replace(/\s+/g, ' ').trim();
      if (!text) return null;
      return text;
    } catch (err: any) {
      console.warn(`Voice summary failed: ${err.message}`);
      return null;
    }
  }

  private async buildSummarySpeechText(fullText: string): Promise<string> {
    // DISABLED: summary feature — re-enable when needed
    return fullText;
    // if (!this.shouldSummarizeForVoice(fullText)) return fullText;
    // const summary = await this.summarizeForVoice(fullText);
    // if (!summary) {
    //   const fallback = fullText.length > 360 ? `${fullText.slice(0, 360)}...` : fullText;
    //   return `Summary. ${fallback} Say "hear full message" for full details.`;
    // }
    // return `Summary. ${summary} Say "hear full message" for full details.`;
  }

  private async buildInboxCatchUpSpeechText(fullText: string): Promise<string> {
    const summary = await this.summarizeForVoice(fullText);
    if (!summary) {
      const fallback = fullText.length > 360 ? `${fullText.slice(0, 360)}...` : fullText;
      return `Summary. ${fallback} Say hear full message for full details.`;
    }
    return `Summary. ${summary} Say hear full message for full details.`;
  }

  private logToInbox(message: string): void {
    if (!this.inboxLogChannel) return;
    this.sendChunked(this.inboxLogChannel, message).catch((err) => {
      console.error('Failed to log to inbox channel:', err.message);
    });
  }

  private trackIdleNotificationEvent(
    stage: IdleNotificationStage,
    item: Pick<QueuedIdleNotification, 'key' | 'kind' | 'sessionKey' | 'retries' | 'message'>,
    reason?: string,
  ): void {
    switch (stage) {
      case 'enqueued':
        this.counters.idleNotificationsEnqueued += 1;
        break;
      case 'deduped':
        this.counters.idleNotificationsDeduped += 1;
        break;
      case 'deferred':
        this.counters.idleNotificationsDeferred += 1;
        break;
      case 'dropped':
        this.counters.idleNotificationsDropped += 1;
        break;
      case 'delivered':
        this.counters.idleNotificationsDelivered += 1;
        break;
      default:
        break;
    }

    const preview = item.message.replace(/\s+/g, ' ').trim().slice(0, 160);
    this.idleNotifyEvents.push({
      at: Date.now(),
      stage,
      kind: item.kind,
      key: item.key,
      sessionKey: item.sessionKey,
      reason: reason ?? null,
      retries: item.retries,
      message: preview,
      queueDepth: this.idleNotifyQueue.length,
    });

    if (this.idleNotifyEvents.length > VoicePipeline.IDLE_NOTIFY_EVENT_LIMIT) {
      this.idleNotifyEvents.splice(0, this.idleNotifyEvents.length - VoicePipeline.IDLE_NOTIFY_EVENT_LIMIT);
    }
  }

  notifyIfIdle(message: string, options: IdleNotificationOptions = {}): void {
    const kind = options.kind ?? 'generic';
    const key = this.buildIdleNotificationKey(message, kind, options);
    const existing = this.idleNotifyByKey.get(key);

    if (existing) {
      existing.message = message;
      existing.kind = kind;
      if (options.sessionKey) existing.sessionKey = options.sessionKey;
      if (typeof options.stamp === 'number' && Number.isFinite(options.stamp)) {
        existing.stamp = existing.stamp == null ? options.stamp : Math.max(existing.stamp, options.stamp);
      }
      if (options.speakerAgentId !== undefined) {
        existing.speakerAgentId = options.speakerAgentId;
      }
      if (options.tier) existing.tier = options.tier;
      if (options.agentDisplayName !== undefined) existing.agentDisplayName = options.agentDisplayName;
      this.trackIdleNotificationEvent('deduped', existing, 'merged-with-existing-key');
    } else {
      const item: QueuedIdleNotification = {
        key,
        message,
        kind,
        sessionKey: options.sessionKey ?? null,
        stamp: typeof options.stamp === 'number' && Number.isFinite(options.stamp) ? options.stamp : null,
        retries: 0,
        speakerAgentId: options.speakerAgentId ?? null,
        tier: options.tier ?? 'nudge',
        agentDisplayName: options.agentDisplayName ?? null,
      };
      this.idleNotifyQueue.push(item);
      this.idleNotifyByKey.set(key, item);
      this.trackIdleNotificationEvent('enqueued', item);
    }

    this.scheduleIdleNotificationProcessing(0);
  }

  private buildIdleNotificationKey(message: string, kind: IdleNotificationKind, options: IdleNotificationOptions): string {
    if (options.dedupeKey) return options.dedupeKey;
    if ((kind === 'response-ready' || kind === 'text-activity') && options.sessionKey) {
      return `${kind}:${options.sessionKey}`;
    }
    return `${kind}:${message}`;
  }

  private clearIdleNotificationQueue(): void {
    if (this.idleNotifyTimer) {
      clearTimeout(this.idleNotifyTimer);
      this.idleNotifyTimer = null;
    }
    this.idleNotifyQueue = [];
    this.idleNotifyByKey.clear();
  }

  private getQueuedNotificationCount(): number {
    return this.idleNotifyQueue.length;
  }

  private dropIdleNotifications(predicate: (item: QueuedIdleNotification) => boolean, reason = 'filtered'): void {
    const headBefore = this.idleNotifyQueue[0]?.key ?? null;
    const droppedItems: QueuedIdleNotification[] = [];
    this.idleNotifyQueue = this.idleNotifyQueue.filter((item) => {
      if (predicate(item)) {
        droppedItems.push(item);
        return false;
      }
      return true;
    });
    for (const item of droppedItems) {
      this.idleNotifyByKey.delete(item.key);
      this.trackIdleNotificationEvent('dropped', item, reason);
    }
    if (droppedItems.length === 0) return;

    if (this.idleNotifyQueue.length === 0) {
      if (this.idleNotifyTimer) {
        clearTimeout(this.idleNotifyTimer);
        this.idleNotifyTimer = null;
      }
      return;
    }

    // If the queue head changed while a deferred timer was pending, reschedule
    // immediately so the next item isn't blocked by the old head's backoff.
    const headAfter = this.idleNotifyQueue[0]?.key ?? null;
    if (this.idleNotifyTimer && headBefore !== headAfter) {
      clearTimeout(this.idleNotifyTimer);
      this.idleNotifyTimer = null;
      this.scheduleIdleNotificationProcessing(0);
    }
  }

  private scheduleIdleNotificationProcessing(delayMs: number): void {
    if (this.idleNotifyTimer) clearTimeout(this.idleNotifyTimer);
    this.idleNotifyTimer = setTimeout(() => {
      this.idleNotifyTimer = null;
      void this.processIdleNotificationQueue();
    }, Math.max(120, delayMs));
  }

  private dequeueIdleNotification(key: string): void {
    this.idleNotifyByKey.delete(key);
    this.idleNotifyQueue = this.idleNotifyQueue.filter((item) => item.key !== key);
  }

  private recordIdleNotificationDeferral(item: QueuedIdleNotification, reason: string): void {
    this.trackIdleNotificationEvent('deferred', item, reason);
    if (item.retries <= 1 || item.retries % 10 === 0) {
      console.log(`Idle notify deferred (${reason}, attempt ${item.retries}): "${item.message}"`);
    }
  }

  /**
   * Batch multiple response-ready notifications into a single spoken message.
   * "Malibu and Sierra have responses." instead of two separate announcements.
   */
  private batchResponseReadyNotifications(): void {
    const responseReady = this.idleNotifyQueue.filter(
      (item) => item.kind === 'response-ready' && !this.isIdleNotificationStale(item),
    );
    if (responseReady.length < 2) return;

    // Collect unique agent display names
    const names: string[] = [];
    for (const item of responseReady) {
      const name = item.agentDisplayName || 'An agent';
      if (!names.includes(name)) names.push(name);
    }

    let batchMessage: string;
    if (names.length === 1) {
      batchMessage = `${names[0]} has ${responseReady.length} responses.`;
    } else if (names.length === 2) {
      batchMessage = `${names[0]} and ${names[1]} have responses.`;
    } else {
      const last = names[names.length - 1];
      batchMessage = `${names.slice(0, -1).join(', ')}, and ${last} have responses.`;
    }

    // Remove individual items
    for (const item of responseReady) {
      this.idleNotifyByKey.delete(item.key);
      this.trackIdleNotificationEvent('dropped', item, 'batched');
    }
    this.idleNotifyQueue = this.idleNotifyQueue.filter(
      (item) => item.kind !== 'response-ready' || this.isIdleNotificationStale(item) || !responseReady.includes(item),
    );

    // Add single batch item at the front
    const batchItem: QueuedIdleNotification = {
      key: `batch:response-ready:${Date.now()}`,
      message: batchMessage,
      kind: 'response-ready',
      sessionKey: null,
      stamp: null,
      retries: 0,
      speakerAgentId: null,
      tier: 'nudge',
      agentDisplayName: null,
    };
    this.idleNotifyQueue.unshift(batchItem);
    this.idleNotifyByKey.set(batchItem.key, batchItem);
    this.trackIdleNotificationEvent('enqueued', batchItem, 'batched');
    console.log(`Batched ${responseReady.length} response-ready notifications: "${batchMessage}"`);
  }

  private async processIdleNotificationQueue(): Promise<void> {
    if (this.idleNotifyProcessing) return;
    this.idleNotifyProcessing = true;

    try {
      // Batch multiple response-ready notifications before processing
      this.batchResponseReadyNotifications();

      while (true) {
        while (this.idleNotifyQueue.length > 0 && !this.idleNotifyByKey.has(this.idleNotifyQueue[0]!.key)) {
          this.idleNotifyQueue.shift();
        }
        const next = this.idleNotifyQueue[0];
        if (!next) return;

        if (this.isIdleNotificationStale(next)) {
          console.log(`Idle notify dropped (stale): "${next.message}"`);
          this.trackIdleNotificationEvent('dropped', next, 'stale-before-delivery');
          this.dequeueIdleNotification(next.key);
          continue;
        }

        const deferral = this.idleNotificationDeferral();
        if (deferral) {
          if ('drop' in deferral) {
            console.log(`Idle notify skipped (${deferral.reason}): "${next.message.slice(0, 60)}..."`);
            this.trackIdleNotificationEvent('dropped', next, deferral.reason);
            this.dequeueIdleNotification(next.key);
            continue;
          }
          next.retries += 1;
          this.recordIdleNotificationDeferral(next, deferral.reason);
          this.scheduleIdleNotificationProcessing(deferral.delayMs);
          return;
        }

        const result = await this.deliverIdleNotification(next);
        if (result.status === 'delivered') {
          this.trackIdleNotificationEvent('delivered', next, result.reason);
          this.dequeueIdleNotification(next.key);
          continue;
        }
        if (result.status === 'dropped') {
          this.trackIdleNotificationEvent('dropped', next, result.reason);
          this.dequeueIdleNotification(next.key);
          continue;
        }

        next.retries += 1;
        this.recordIdleNotificationDeferral(next, result.reason);
        this.scheduleIdleNotificationProcessing(result.delayMs);
        return;
      }
    } finally {
      this.idleNotifyProcessing = false;
    }
  }

  private idleNotificationDeferral():
    { delayMs: number; reason: string } | { drop: true; reason: string } | null {
    if (this.ctx.silentWait) {
      return { drop: true, reason: 'silent wait' };
    }

    if (this.ctx.paused) {
      return { delayMs: 5000, reason: 'paused' };
    }

    if (this.ctx.indicateCaptureActive) {
      return { delayMs: 1200, reason: 'indicate capture active' };
    }

    if (Date.now() < this.ctx.promptGraceUntil || Date.now() < this.ctx.gateGraceUntil) {
      const until = Math.max(this.ctx.promptGraceUntil, this.ctx.gateGraceUntil);
      return {
        delayMs: Math.max(120, until - Date.now() + 120),
        reason: 'grace window',
      };
    }

    // Wait-mode dispatches are fire-and-forget — the state machine goes back
    // to IDLE while the LLM is still processing. Treat this as busy so
    // notifications don't play on top of pending response delivery.
    if (this.ctx.pendingWaitCallback) {
      return { delayMs: 2000, reason: 'pending wait' };
    }

    // INBOX_FLOW is user-interactive and should not be interrupted by background notifications.
    const stateType = this.stateMachine.getStateType();
    const blockOnBusy = stateType !== 'IDLE';
    if (blockOnBusy || this.player.isPlaying()) {
      return {
        delayMs: this.player.isPlaying() ? 5000 : 900,
        reason: this.player.isPlaying() ? 'active playback' : `busy state ${stateType}`,
      };
    }
    if (this.ctx.idleNotifyInFlight) {
      return { delayMs: 900, reason: 'in-flight' };
    }
    if (this.receiver.hasActiveSpeech()) {
      return { delayMs: 1500, reason: 'active speech' };
    }
    return null;
  }

  private isIdleNotificationStale(item: QueuedIdleNotification): boolean {
    // Text-activity notifications are stale if already notified for this stamp
    if (item.kind === 'text-activity') {
      if (!item.sessionKey || item.stamp == null) return false;
      const lastNotified = this.inboxPollNotifiedStamps.get(item.sessionKey) ?? 0;
      return item.stamp <= lastNotified;
    }

    // Response-ready notifications are never stale — they come from dispatch completion
    // and are inherently one-shot. The unified inbox handles staleness via watermarks.
    return false;
  }

  private typeSafeIdleDeliveryResult(
    status: 'delivered' | 'dropped' | 'deferred',
    reason: string,
    delayMs?: number,
  ): { status: 'delivered'; reason: string } | { status: 'dropped'; reason: string } | { status: 'deferred'; reason: string; delayMs: number } {
    if (status === 'deferred') {
      return { status, reason, delayMs: Math.max(120, delayMs ?? 900) };
    }
    return { status, reason };
  }

  private async deliverIdleNotification(item: QueuedIdleNotification):
    Promise<{ status: 'delivered'; reason: string } | { status: 'dropped'; reason: string } | { status: 'deferred'; reason: string; delayMs: number }> {
    const message = item.message;

    if (this.isIdleNotificationStale(item)) {
      return this.typeSafeIdleDeliveryResult('dropped', 'stale-before-delivery');
    }

    if (this.ctx.indicateCaptureActive) {
      return this.typeSafeIdleDeliveryResult('deferred', 'indicate capture active before delivery', 1200);
    }

    // If a ready item belongs to the currently active channel and we're idle,
    // read it directly instead of announcing a notification.
    if (this.shouldAutoReadReadyForActiveChannel(item)) {
      await this.readReadyForActiveChannel();
      return this.typeSafeIdleDeliveryResult('delivered', 'auto-read-active-channel');
    }

    if (item.retries > 0) {
      console.log(`Idle notify [${item.tier}]: "${message}" (after ${item.retries} retries)`);
    } else {
      console.log(`Idle notify [${item.tier}]: "${message}"`);
    }
    this.logToInbox(`**${this.getSystemSpeakerLabel()}:** ${message}`);
    this.ctx.idleNotifyInFlight = true;

    try {
      // All idle notifications: nudge earcon only, no TTS, no grace window.
      // The user can say "[agent name], go ahead" to hear the queued response.
      // Skip if another earcon (e.g. still-listening) is already playing — user already has an audio cue.
      if (this.player.isPlayingAnyEarcon?.()) {
        console.log('Skipping nudge earcon — another earcon already playing');
        return this.typeSafeIdleDeliveryResult('delivered', 'nudge-skipped-earcon-active');
      }
      await this.player.playEarcon('nudge');
      const notifyChannelName = this.resolveChannelNameFromSessionKey(item.sessionKey);
      this.setReplyContext(
        item.speakerAgentId,
        item.sessionKey,
        notifyChannelName,
        VoicePipeline.REPLY_CONTEXT_DURATION_MS,
      );
      this.ctx.lastPlaybackCompletedAt = Date.now();
      return this.typeSafeIdleDeliveryResult('delivered', 'nudge-chime');
    } finally {
      this.ctx.idleNotifyInFlight = false;
    }
  }

  notifyDependencyIssue(type: 'stt' | 'tts', message: string): void {
    const now = Date.now();
    if (now < this.ctx.dependencyAlertCooldownUntil[type]) return;
    this.ctx.dependencyAlertCooldownUntil[type] = now + 10_000;
    console.warn(`Dependency issue [${type}]: ${message}`);
    this.logToInbox(`**${this.getSystemSpeakerLabel()}:** ${message}`);
    void this.playFastCue('error');
  }

  private shouldAutoReadReadyForActiveChannel(item: QueuedIdleNotification): boolean {
    if (item.kind !== 'response-ready') return false;
    if (!this.router || !this.queueState) return false;
    // Auto-read is a focus-mode behavior. In background flows,
    // ready items should remain in inbox until the user explicitly pulls them.
    const modeGetter = (this.queueState as any)?.getMode;
    if (typeof modeGetter === 'function' && normalizeVoiceMode(modeGetter.call(this.queueState)) !== 'wait') return false;

    // Use sessionKey to match against active channel directly
    if (item.sessionKey) {
      const active = this.router.getActiveChannel();
      if (item.sessionKey !== active.name) return false;
      return this.getReadyItemByChannel(active.name) != null;
    }

    // Fallback: try matching agent display name from message
    const m = item.message.match(/^(.+) has a response\.$/i)
      || item.message.match(/^Response ready from (.+)\.$/i);
    if (!m) return false;

    const announced = this.normalizeChannelLabel(m[1] || '');
    const active = this.router.getActiveChannel();
    const activeDisplay = this.normalizeChannelLabel((active as any).displayName || active.name);

    if (announced !== activeDisplay) return false;

    return this.getReadyItemByChannel(active.name) != null;
  }

  private async readReadyForActiveChannel(options?: { bypassBusyCheck?: boolean }): Promise<void> {
    if (!this.router) return;
    const active = this.router.getActiveChannel();
    const item = this.getReadyItemByChannel(active.name);
    if (!item) return;

    await this.readQueuedReadyItem(item, options);
    if (item.speakerAgentId) {
      const activeChannelName = this.router?.getActiveChannel().name ?? null;
      const activeSessionKey = this.router?.getActiveSessionKey() ?? null;
      this.setReplyContext(
        item.speakerAgentId,
        activeSessionKey,
        activeChannelName,
        VoicePipeline.REPLY_CONTEXT_DURATION_MS,
      );
    }
  }

  private findLocalReadyItem(agent?: string): QueuedResponse | null {
    const activeReady = this.router
      ? this.getReadyItemByChannel(this.router.getActiveChannel().name)
      : null;

    if (!agent) {
      return activeReady ?? this.getNextReadyItem();
    }

    const needle = agent.toLowerCase();
    const matchesAgent = (item: QueuedResponse) => {
      const speakerAgentId = item.speakerAgentId?.toLowerCase() ?? '';
      const displayName = item.displayName.toLowerCase();
      return speakerAgentId.includes(needle) || displayName.includes(needle);
    };

    if (activeReady && matchesAgent(activeReady)) {
      return activeReady;
    }

    return this.getMergedReadyItems().find((item) => matchesAgent(item)) ?? null;
  }

  private async readQueuedReadyItem(
    item: QueuedResponse,
    options?: { bypassBusyCheck?: boolean },
  ): Promise<void> {
    const queueState = this.queueState;
    if (!queueState) return;

    console.log(`Idle auto-read: consuming ready item from active channel ${item.displayName}`);

    try {
      if (!options?.bypassBusyCheck && (this.isBusy() || this.player.isPlaying())) {
        console.log('Idle auto-read aborted (became busy before playback)');
        return;
      }
      this.markReadyItemHeard(item.id);
      this.transitionAndResetWatchdog({ type: 'SPEAKING_STARTED' });
      await this.speakResponse(item.responseText, {
        allowSummary: true,
        forceFull: false,
        isChannelMessage: true,
        speakerAgentId: item.speakerAgentId,
      });
      this.transitionAndResetWatchdog({ type: 'SPEAKING_COMPLETE' });
      await this.playReadyEarcon();
      this.allowFollowupPromptGrace(VoicePipeline.FOLLOWUP_PROMPT_GRACE_MS);

      // Advance Discord watermark so this response doesn't reappear in the inbox.
      const inboxRef = this.inboxClient;
      const channelId = this.extractChannelIdFromSessionKey(item.sessionKey);
      if (inboxRef && channelId) {
        setTimeout(() => void inboxRef.markChannelReadById(channelId, 'voice-auto-read'), 3000);
      }
    } catch (err: any) {
      console.warn(`Idle auto-read failed: ${err.message}`);
    }
  }

  private normalizeChannelLabel(value: string): string {
    return value.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, ' ');
  }

  private classifyDependencyIssue(error: any): { type: 'stt' | 'tts'; message: string } | null {
    const full = `${error?.message ?? ''} ${error?.cause?.message ?? ''}`.toLowerCase();
    if (!full.trim()) return null;

    if (full.includes('whisper local error') || full.includes('/inference') || full.includes('stt')) {
      return { type: 'stt', message: 'Speech recognition is unavailable right now.' };
    }
    if (full.includes('kokoro') || full.includes('tts') || full.includes('text-to-speech') || full.includes(':8880')) {
      return { type: 'tts', message: 'Voice output is unavailable right now.' };
    }
    if (full.includes('econnrefused') && config.whisperUrl) {
      return { type: 'stt', message: 'Speech recognition is unavailable right now.' };
    }
    return null;
  }

  private async inferVoiceCommandLLM(
    transcript: string,
    mode: VoiceMode,
    inGracePeriod: boolean,
  ): Promise<VoiceCommand | null> {
    const clipped = transcript.trim().slice(0, VoicePipeline.COMMAND_CLASSIFIER_MAX_CHARS);
    if (!clipped) return null;

    const system = [
      'Classify spoken assistant input as either a voice command or normal prompt.',
      'Return ONLY minified JSON with keys: intent, confidence, and optional fields channel, body, mode, enabled.',
      'intent must be one of:',
      'prompt,switch,list,default,noise,delay,delay-adjust,settings,new-post,mode,inbox-check,inbox-next,inbox-clear,read-last-message,voice-status,voice-channel,gated-mode,endpoint-mode,wake-check,silent-wait,hear-full-message,inbox-respond,inbox-summarize,pause,replay,earcon-tour,whats-up,read-ready',
      'confidence must be 0 to 1.',
      'Use prompt if uncertain.',
      'No markdown, no prose.',
    ].join(' ');

    const user = JSON.stringify({
      transcript: clipped,
      context: {
        mode,
        inGracePeriod,
        gated: getVoiceSettings().gated,
      },
      hints: [
        '"in box" means "inbox"',
        '"here full message" or "hear fullness" means "hear full message"',
      ],
    });

    let raw = '';
    try {
      // AbortSignal.timeout cancels the actual HTTP fetch after 1400ms instead
      // of leaving an orphaned connection hanging (the old Promise.race approach).
      const signal = AbortSignal.timeout(1400);
      raw = await quickCompletion(system, user, 120, signal, 'haiku');
    } catch (err: any) {
      const msg = err.message ?? '';
      const isTimeout = msg.includes('timeout') || msg.includes('aborted') || err.name === 'TimeoutError';
      console.warn(`LLM command classifier failed: ${msg}`);
      if (isTimeout) {
        this.lastClassifierTimedOut = true;
      }
      return null;
    }

    const parsed = this.extractJsonObject(raw);
    if (!parsed || typeof parsed !== 'object') return null;

    const intentRaw = String((parsed as any).intent || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
    const confidence = Number((parsed as any).confidence);
    if (!Number.isFinite(confidence)) return null;

    const wordCount = clipped.split(/\s+/).filter(Boolean).length;
    const threshold = wordCount <= 8 ? 0.72 : 0.88;
    if (confidence < threshold) return null;
    if (intentRaw === 'prompt' || intentRaw === '') return null;

    const channel = String((parsed as any).channel ?? (parsed as any).target ?? '').trim();
    const body = String((parsed as any).body ?? (parsed as any).message ?? (parsed as any).text ?? '').trim();
    const level = String((parsed as any).level ?? '').trim();
    const modeValue = String((parsed as any).mode ?? '').trim().toLowerCase();
    const enabledValue = (parsed as any).enabled;

    switch (intentRaw) {
      case 'switch':
        return channel ? { type: 'switch', channel } : null;
      case 'list':
        // Voice UX: deprecate channel-list intent; treat as inbox status.
        return { type: 'inbox-check' };
      case 'default':
        return { type: 'default' };
      case 'noise':
        return (level || body) ? { type: 'noise', level: (level || body) } : null;
      case 'delay': {
        const digits = body.match(/\d+/)?.[0];
        if (!digits) return null;
        return { type: 'delay', value: parseInt(digits, 10) };
      }
      case 'delay-adjust':
        // Classifier may emit delay-adjust with a numeric body for phrases like
        // "set delay 500 milliseconds". Treat that as absolute delay.
        if (/\d/.test(body)) {
          const digits = body.match(/\d+/)?.[0];
          if (!digits) return null;
          return { type: 'delay', value: parseInt(digits, 10) };
        }
        if (/\blonger\b/.test(body)) return { type: 'delay-adjust', direction: 'longer' };
        if (/\bshorter\b/.test(body)) return { type: 'delay-adjust', direction: 'shorter' };
        return null;
      case 'settings':
        return { type: 'settings' };
      case 'new-post':
        return { type: 'new-post' };
      case 'mode': {
        const normalized = normalizeVoiceMode(modeValue);
        if (normalized === 'wait' || normalized === 'queue') {
          return { type: 'mode', mode: normalized };
        }
        return null;
      }
      case 'inbox-check':
        return { type: 'inbox-check' };
      case 'inbox-next':
        return { type: 'inbox-next' };
      case 'inbox-clear':
        return { type: 'inbox-clear' };
      case 'read-last-message':
        return { type: 'read-last-message' };
      case 'voice-status':
        return { type: 'voice-status' };
      case 'voice-channel':
        return { type: 'voice-channel' };
      case 'gated-mode': {
        if (typeof enabledValue === 'boolean') return { type: 'gated-mode', enabled: enabledValue };
        if (modeValue === 'on' || modeValue === 'enabled' || modeValue === 'gated') {
          return { type: 'gated-mode', enabled: true };
        }
        if (modeValue === 'off' || modeValue === 'disabled' || modeValue === 'open' || modeValue === 'ungated') {
          return { type: 'gated-mode', enabled: false };
        }
        return null;
      }
      case 'endpoint-mode': {
        if (modeValue === 'indicate' || modeValue === 'manual') {
          return { type: 'endpoint-mode', mode: 'indicate' };
        }
        if (modeValue === 'silence' || modeValue === 'auto' || modeValue === 'automatic') {
          return { type: 'endpoint-mode', mode: 'silence' };
        }
        return null;
      }
      case 'wake-check':
        return { type: 'wake-check' };
      case 'silent-wait':
        // Guard against noise/garbage transcripts being misclassified as silent-wait.
        if (!/\b(?:silent|quiet|silence|quietly|no tones?|stop tones?|wait quietly)\b/i.test(clipped)) {
          return null;
        }
        return { type: 'silent-wait' };
      case 'hear-full-message':
        return { type: 'hear-full-message' };
      case 'inbox-respond':
        return { type: 'inbox-respond' };
      case 'inbox-summarize':
        return { type: 'inbox-summarize' };
      case 'pause':
        return { type: 'pause' };
      case 'replay':
        return { type: 'replay' };
      case 'earcon-tour':
        return { type: 'earcon-tour' };
      case 'whats-up':
        return { type: 'whats-up' };
      case 'read-ready':
        return { type: 'read-ready' };
      default:
        return null;
    }
  }

  private extractJsonObject(raw: string): any | null {
    const text = raw.trim();
    if (!text) return null;
    const tryParse = (s: string): any | null => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    };

    const direct = tryParse(text);
    if (direct) return direct;

    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return tryParse(text.slice(start, end + 1));
    }
    return null;
  }

  private async sendChunked(channel: TextChannel, message: string): Promise<void> {
    const MAX_LEN = 2000;
    for (let i = 0; i < message.length; i += MAX_LEN) {
      await channel.send(message.slice(i, i + MAX_LEN));
    }
  }

  private async playReadyEarcon(): Promise<void> {
    console.log(`${this.stamp()} Ready cue emitted (async) — opening grace window`);
    this.setGateGrace(VoicePipeline.READY_GRACE_MS);
    await this.playFastCue('ready');
  }

  private playReadyEarconSync(): void {
    console.log(`${this.stamp()} Ready cue emitted (sync) — opening grace window`);
    this.setGateGrace(VoicePipeline.READY_GRACE_MS);
    void this.playFastCue('ready');
  }

  private startWaitingLoop(delayMs = 0): void {
    if (this.player.isWaiting() && delayMs <= 0) return;
    if (this.waitingLoopTimer) {
      clearTimeout(this.waitingLoopTimer);
      this.waitingLoopTimer = null;
    }
    if (delayMs <= 0) {
      this.player.startWaitingLoop();
      return;
    }
    this.waitingLoopTimer = setTimeout(() => {
      this.waitingLoopTimer = null;
      this.player.startWaitingLoop();
    }, delayMs);
  }

  private stopWaitingLoop(): void {
    if (this.waitingLoopTimer) {
      clearTimeout(this.waitingLoopTimer);
      this.waitingLoopTimer = null;
    }
    this.player.stopWaitingLoop();
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private async repromptAwaiting(): Promise<void> {
    const effects = this.transitionAndResetWatchdog({ type: 'AWAITING_INPUT_RECEIVED', recognized: false });
    await this.applyEffects(effects);
  }

  private async acknowledgeAwaitingChoice(): Promise<void> {
    await this.playFastCue('acknowledged');
  }

  private fastCuePriority(name: EarconName): number {
    switch (name) {
      case 'listening':
        return 1;
      case 'acknowledged':
        return 2;
      case 'ready':
        return 3;
      default:
        return 4;
    }
  }

  private async playFastCue(name: EarconName): Promise<void> {
    const isFast = name === 'listening' || name === 'acknowledged' || name === 'ready' || name === 'nudge';
    if (!isFast) {
      await this.player.playEarcon(name);
      return;
    }

    return await new Promise<void>((resolve) => {
      if (!this.fastCueTimer) {
        this.pendingFastCue = name;
        this.pendingFastCueResolvers = [resolve];
        this.fastCueTimer = setTimeout(() => {
          void this.flushFastCue();
        }, VoicePipeline.FAST_CUE_COALESCE_MS);
        return;
      }

      if (!this.pendingFastCue || this.fastCuePriority(name) >= this.fastCuePriority(this.pendingFastCue)) {
        this.pendingFastCue = name;
      }
      this.pendingFastCueResolvers.push(resolve);
    });
  }

  private async flushFastCue(): Promise<void> {
    const name = this.pendingFastCue;
    const resolvers = this.pendingFastCueResolvers;

    this.fastCueTimer = null;
    this.pendingFastCue = null;
    this.pendingFastCueResolvers = [];

    if (name) {
      await this.player.playEarcon(name);
    }
    for (const resolve of resolvers) {
      resolve();
    }
  }

  private clearFastCueQueue(): void {
    if (this.fastCueTimer) {
      clearTimeout(this.fastCueTimer);
      this.fastCueTimer = null;
    }
    const resolvers = this.pendingFastCueResolvers;
    this.pendingFastCue = null;
    this.pendingFastCueResolvers = [];
    for (const resolve of resolvers) {
      resolve();
    }
  }

  private channelNamesMatch(input: string, name: string, displayName: string): boolean {
    const candidates = [name, displayName];
    const inputForms = this.channelMatchForms(input);

    for (const candidate of candidates) {
      const candidateForms = this.channelMatchForms(candidate);
      for (const q of inputForms) {
        for (const c of candidateForms) {
          if (!q || !c) continue;
          if (q === c) return true;
          if (q.includes(c) || c.includes(q)) return true;
        }
      }
    }

    return false;
  }

  private channelMatchForms(text: string): string[] {
    const base = text
      .toLowerCase()
      .replace(/[’']/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
    if (!base) return [''];

    // Possessive/plural tolerant form: "dollys chats" -> "dolly chat"
    const singularish = base
      .split(' ')
      .map((token) => {
        if (token.length <= 3) return token;
        if (token.endsWith('ss')) return token;
        if (token.endsWith('s')) return token.slice(0, -1);
        return token;
      })
      .join(' ');

    const compactBase = base.replace(/\s+/g, '');
    const compactSingularish = singularish.replace(/\s+/g, '');

    const forms = new Set<string>([base, singularish, compactBase, compactSingularish].filter(Boolean));
    return Array.from(forms);
  }

  private sanitizeAssistantOutput(text: string, context: string): string {
    const cleaned = sanitizeAssistantResponse(text);
    if (cleaned !== text.trim()) {
      console.warn(`Sanitized assistant output (${context}) removed=${Math.max(0, text.trim().length - cleaned.length)}`);
    }
    if (cleaned.length > 0) return cleaned;
    console.warn(`Assistant output empty after sanitization (${context})`);
    return 'I had trouble formatting that response. Please ask again.';
  }

  private toSpokenText(value: unknown, fallback = ''): string {
    return coerceSpokenText(value, fallback);
  }

  private log(message: string, channelName?: string): void {
    const send = (channel: TextChannel) => {
      this.sendChunked(channel, message).catch((err) => {
        console.error('Failed to log to text channel:', err.message);
      });
    };

    if (this.router) {
      const target = channelName
        ? this.router.getLogChannelFor(channelName)
        : this.router.getLogChannel();
      target.then((channel) => {
        if (channel) send(channel);
      });
    } else if (this.logChannel) {
      send(this.logChannel);
    }
  }
}
