/**
 * Centralized transient state for the voice pipeline.
 *
 * Groups ~20 scattered mutable value fields that should be reset together
 * when the pipeline stops, stall-watchdog fires, or a hard reset occurs.
 *
 * Timer handles are NOT included here — they live on VoicePipeline and are
 * cleared via clearAllTimers().
 */
export interface TransientContext {
  // Playback tracking
  lastSpokenText: string;
  lastSpokenFullText: string;
  lastSpokenWasSummary: boolean;
  lastSpokenIsChannelMessage: boolean;
  lastSpokenSpeakerAgentId: string | null;
  lastPlaybackText: string;
  lastPlaybackCompletedAt: number;

  // Wait state
  silentWait: boolean;
  pendingWaitCallback: ((responseText: string, speakerAgentId?: string | null) => void) | null;
  activeWaitQueueItemId: string | null;
  speculativeQueueItemId: string | null;
  quietPendingWait: boolean;
  deferredWaitResponseText: string | null;
  deferredWaitSpeakerAgentId: string | null;

  // Grace periods
  gateGraceUntil: number;
  promptGraceUntil: number;
  followupPromptGraceUntil: number;
  followupPromptChannelName: string | null;
  inboxConversationAgentId: string | null;
  replyContextAgentId: string | null;
  replyContextSessionKey: string | null;
  replyContextChannelName: string | null;
  replyContextUntil: number;

  // Cooldowns / flags
  rejectRepromptInFlight: boolean;
  rejectRepromptCooldownUntil: number;
  ignoreProcessingUtterancesUntil: number;
  failedWakeCueCooldownUntil: number;
  missedWakeAnalysisInFlight: boolean;
  newPostTimeoutPromptGuardUntil: number;
  dependencyAlertCooldownUntil: Record<'stt' | 'tts', number>;
  idleNotifyInFlight: boolean;
  indicateCaptureActive: boolean;
  indicateCaptureSegments: string[];
  indicateCaptureStartedAt: number;
  indicateCaptureLastSegmentAt: number;
  indicateCaptureAddressedAgentId: string | null;
  focusedAgentId: string | null;
  focusedAgentName: string | null;

  // Pause state
  paused: boolean;
  pausedFromText: string;
}

export function createTransientContext(): TransientContext {
  return {
    lastSpokenText: '',
    lastSpokenFullText: '',
    lastSpokenWasSummary: false,
    lastSpokenIsChannelMessage: false,
    lastSpokenSpeakerAgentId: null,
    lastPlaybackText: '',
    lastPlaybackCompletedAt: 0,
    silentWait: false,
    pendingWaitCallback: null,
    activeWaitQueueItemId: null,
    speculativeQueueItemId: null,
    quietPendingWait: false,
    deferredWaitResponseText: null,
    deferredWaitSpeakerAgentId: null,
    gateGraceUntil: 0,
    promptGraceUntil: 0,
    followupPromptGraceUntil: 0,
    followupPromptChannelName: null,
    inboxConversationAgentId: null,
    replyContextAgentId: null,
    replyContextSessionKey: null,
    replyContextChannelName: null,
    replyContextUntil: 0,
    rejectRepromptInFlight: false,
    rejectRepromptCooldownUntil: 0,
    ignoreProcessingUtterancesUntil: 0,
    failedWakeCueCooldownUntil: 0,
    missedWakeAnalysisInFlight: false,
    newPostTimeoutPromptGuardUntil: 0,
    dependencyAlertCooldownUntil: { stt: 0, tts: 0 },
    idleNotifyInFlight: false,
    indicateCaptureActive: false,
    indicateCaptureSegments: [],
    indicateCaptureStartedAt: 0,
    indicateCaptureLastSegmentAt: 0,
    indicateCaptureAddressedAgentId: null,
    focusedAgentId: null,
    focusedAgentName: null,
    paused: false,
    pausedFromText: '',
  };
}

export function resetTransientContext(ctx: TransientContext): void {
  ctx.lastSpokenText = '';
  ctx.lastSpokenFullText = '';
  ctx.lastSpokenWasSummary = false;
  ctx.lastSpokenIsChannelMessage = false;
  ctx.lastSpokenSpeakerAgentId = null;
  ctx.lastPlaybackText = '';
  ctx.lastPlaybackCompletedAt = 0;
  ctx.silentWait = false;
  ctx.pendingWaitCallback = null;
  ctx.activeWaitQueueItemId = null;
  ctx.speculativeQueueItemId = null;
  ctx.quietPendingWait = false;
  ctx.deferredWaitResponseText = null;
  ctx.deferredWaitSpeakerAgentId = null;
  ctx.gateGraceUntil = 0;
  ctx.promptGraceUntil = 0;
  ctx.followupPromptGraceUntil = 0;
  ctx.followupPromptChannelName = null;
  ctx.inboxConversationAgentId = null;
  ctx.replyContextAgentId = null;
  ctx.replyContextSessionKey = null;
  ctx.replyContextChannelName = null;
  ctx.replyContextUntil = 0;
  ctx.rejectRepromptInFlight = false;
  ctx.rejectRepromptCooldownUntil = 0;
  ctx.ignoreProcessingUtterancesUntil = 0;
  ctx.failedWakeCueCooldownUntil = 0;
  ctx.missedWakeAnalysisInFlight = false;
  ctx.newPostTimeoutPromptGuardUntil = 0;
  ctx.dependencyAlertCooldownUntil = { stt: 0, tts: 0 };
  ctx.idleNotifyInFlight = false;
  ctx.indicateCaptureActive = false;
  ctx.indicateCaptureSegments = [];
  ctx.indicateCaptureStartedAt = 0;
  ctx.indicateCaptureLastSegmentAt = 0;
  ctx.indicateCaptureAddressedAgentId = null;
  ctx.focusedAgentId = null;
  ctx.focusedAgentName = null;
  ctx.paused = false;
  ctx.pausedFromText = '';
}
