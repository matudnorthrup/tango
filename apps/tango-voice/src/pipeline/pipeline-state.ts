import type { EarconName } from '../audio/earcons.js';
import type { ChannelOption } from '../services/voice-commands.js';
import type { VoiceMode } from '../services/queue-state.js';
import type { IndicateCloseType } from '../services/voice-settings.js';
import { getInteractionContractById, getInteractionContractForState } from './interaction-contract.js';

// ─── State types ────────────────────────────────────────────────────────────

export type PipelineStateType =
  | 'IDLE'
  | 'TRANSCRIBING'
  | 'PROCESSING'
  | 'SPEAKING'
  | 'AWAITING_CHANNEL_SELECTION'
  | 'AWAITING_QUEUE_CHOICE'
  | 'AWAITING_SWITCH_CHOICE'
  | 'AWAITING_ROUTE_CONFIRMATION'
  | 'NEW_POST_FLOW'
  | 'INBOX_FLOW';

export interface IdleState {
  type: 'IDLE';
}

export interface TranscribingState {
  type: 'TRANSCRIBING';
}

export interface ProcessingState {
  type: 'PROCESSING';
}

export interface SpeakingState {
  type: 'SPEAKING';
}

export interface AwaitingChannelSelectionState {
  type: 'AWAITING_CHANNEL_SELECTION';
  options: ChannelOption[];
  enteredAt: number;
  timeoutMs: number;
  warningFired: boolean;
}

export interface AwaitingQueueChoiceState {
  type: 'AWAITING_QUEUE_CHOICE';
  userId: string;
  transcript: string;
  enteredAt: number;
  timeoutMs: number;
  warningFired: boolean;
}

export interface AwaitingSwitchChoiceState {
  type: 'AWAITING_SWITCH_CHOICE';
  lastMessage: string;
  enteredAt: number;
  timeoutMs: number;
  warningFired: boolean;
}

export interface AwaitingRouteConfirmationState {
  type: 'AWAITING_ROUTE_CONFIRMATION';
  userId: string;
  transcript: string;
  targetId: string;
  targetName: string;
  confirmAction: 'route' | 'create' | 'redirect';
  createTitle?: string;
  createTargetType?: 'forum' | 'channel';
  deliveryMode: VoiceMode;
  closeType: IndicateCloseType | null;
  fallbackChannelId: string | null;
  enteredAt: number;
  timeoutMs: number;
  warningFired: boolean;
  repromptCount: number;
}

export interface NewPostFlowState {
  type: 'NEW_POST_FLOW';
  step: 'forum' | 'title';
  forumId?: string;
  forumName?: string;
  title?: string;
  enteredAt: number;
  timeoutMs: number;
  warningFired: boolean;
}

export interface InboxAgentItem {
  agentId: string;
  agentDisplayName: string;
  channels: any[]; // VoiceInboxChannel[]
  totalUnread: number;
}

export interface InboxFlowState {
  type: 'INBOX_FLOW';
  items: any[]; // InboxAgentItem[] (agent-grouped) or legacy ChannelActivity[]
  index: number;
  returnChannel: string | null; // channel name to restore when flow ends
  topicSelectionMode?: boolean; // true when awaiting topic selection after agent summary
  currentAgentIndex?: number; // which agent we're doing topic selection for
}

export type PipelineState =
  | IdleState
  | TranscribingState
  | ProcessingState
  | SpeakingState
  | AwaitingChannelSelectionState
  | AwaitingQueueChoiceState
  | AwaitingSwitchChoiceState
  | AwaitingRouteConfirmationState
  | NewPostFlowState
  | InboxFlowState;

// ─── Transition effects ─────────────────────────────────────────────────────

export type TransitionEffect =
  | { type: 'earcon'; name: EarconName }
  | { type: 'speak'; text: string }
  | { type: 'stop-playback' }
  | { type: 'start-waiting-loop' }
  | { type: 'stop-waiting-loop' };

// ─── Events the pipeline sends to the state machine ────────────────────────

export type PipelineEvent =
  | { type: 'UTTERANCE_RECEIVED' }
  | { type: 'TRANSCRIPT_READY'; transcript: string }
  | { type: 'PROCESSING_STARTED' }
  | { type: 'PROCESSING_COMPLETE' }
  | { type: 'SPEAKING_STARTED' }
  | { type: 'SPEAKING_COMPLETE' }
  | { type: 'ENTER_CHANNEL_SELECTION'; options: ChannelOption[]; timeoutMs?: number }
  | { type: 'ENTER_QUEUE_CHOICE'; userId: string; transcript: string; timeoutMs?: number }
  | { type: 'ENTER_SWITCH_CHOICE'; lastMessage: string; timeoutMs?: number }
  | {
    type: 'ENTER_ROUTE_CONFIRMATION';
    userId: string;
    transcript: string;
    targetId: string;
    targetName: string;
    confirmAction?: 'route' | 'create' | 'redirect';
    createTitle?: string;
    createTargetType?: 'forum' | 'channel';
    deliveryMode?: VoiceMode;
    closeType?: IndicateCloseType | null;
    fallbackChannelId?: string | null;
    timeoutMs?: number;
  }
  | { type: 'ENTER_NEW_POST_FLOW'; step: 'forum' | 'title'; forumId?: string; forumName?: string; title?: string; timeoutMs?: number }
  | { type: 'NEW_POST_ADVANCE'; step: 'forum' | 'title'; forumId?: string; forumName?: string; title?: string; timeoutMs?: number }
  | { type: 'ENTER_INBOX_FLOW'; items: any[]; returnChannel?: string | null }
  | { type: 'INBOX_ADVANCE' }
  | { type: 'INBOX_JUMP'; index: number }
  | { type: 'AWAITING_INPUT_RECEIVED'; recognized: boolean }
  | { type: 'REFRESH_AWAITING_TIMEOUT' }
  | { type: 'TIMEOUT_CHECK' }
  | { type: 'CANCEL_FLOW' }
  | { type: 'RETURN_TO_IDLE' };

// ─── Timeout configuration ─────────────────────────────────────────────────

const DEFAULT_WARNING_BEFORE_MS = 5_000;

// ─── State machine ─────────────────────────────────────────────────────────

export class PipelineStateMachine {
  private state: PipelineState = { type: 'IDLE' };
  private bufferedUtterances: { userId: string; wavBuffer: Buffer; durationMs: number }[] = [];
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private warningTimer: ReturnType<typeof setTimeout> | null = null;
  private onTimeout: ((effects: TransitionEffect[], preTimeoutState?: PipelineState) => void) | null = null;
  private static readonly MAX_BUFFERED_UTTERANCES = 3;

  getState(): PipelineState {
    return this.state;
  }

  getStateType(): PipelineStateType {
    return this.state.type;
  }

  hasActiveTimers(): boolean {
    return this.timeoutTimer !== null || this.warningTimer !== null;
  }

  /**
   * Buffer an utterance that arrived during PROCESSING or SPEAKING.
   * The pipeline should re-process it when returning to IDLE.
   */
  bufferUtterance(userId: string, wavBuffer: Buffer, durationMs: number): void {
    if (this.bufferedUtterances.length >= PipelineStateMachine.MAX_BUFFERED_UTTERANCES) {
      this.bufferedUtterances.shift();
    }
    this.bufferedUtterances.push({ userId, wavBuffer, durationMs });
  }

  getBufferedUtterance(): { userId: string; wavBuffer: Buffer; durationMs: number } | null {
    return this.bufferedUtterances.shift() ?? null;
  }

  hasBufferedUtterance(): boolean {
    return this.bufferedUtterances.length > 0;
  }

  /**
   * Register a callback for timeout/warning effects (earcons + speech).
   * Called when an AWAITING state times out or needs a warning.
   * The second argument provides the state that was active before the timeout reset it to IDLE.
   */
  setTimeoutHandler(handler: (effects: TransitionEffect[], preTimeoutState?: PipelineState) => void): void {
    this.onTimeout = handler;
  }

  /**
   * Process an event and return the effects the pipeline should apply.
   */
  transition(event: PipelineEvent): TransitionEffect[] {
    const effects: TransitionEffect[] = [];

    switch (event.type) {
      case 'UTTERANCE_RECEIVED':
        return this.handleUtteranceReceived(effects);

      case 'TRANSCRIPT_READY':
        // Only transition from TRANSCRIBING — don't overwrite AWAITING states
        if (this.state.type === 'TRANSCRIBING') {
          this.state = { type: 'PROCESSING' };
        } else {
          console.warn(`TRANSCRIPT_READY arrived in non-TRANSCRIBING state: ${this.state.type}`);
        }
        return effects;

      case 'PROCESSING_STARTED':
        this.clearTimers(); // Clear any AWAITING state timers
        this.state = { type: 'PROCESSING' };
        return effects;

      case 'PROCESSING_COMPLETE':
        this.state = { type: 'IDLE' };
        return effects;

      case 'SPEAKING_STARTED':
        this.state = { type: 'SPEAKING' };
        return effects;

      case 'SPEAKING_COMPLETE':
        this.state = { type: 'IDLE' };
        return effects;

      case 'ENTER_CHANNEL_SELECTION': {
        this.clearTimers();
        const contract = getInteractionContractById('channel-selection');
        const timeoutMs = event.timeoutMs ?? contract.defaultTimeoutMs;
        this.state = {
          type: 'AWAITING_CHANNEL_SELECTION',
          options: event.options,
          enteredAt: Date.now(),
          timeoutMs,
          warningFired: false,
        };
        this.scheduleTimers(timeoutMs, contract.timeoutText);
        return effects;
      }

      case 'ENTER_QUEUE_CHOICE': {
        this.clearTimers();
        const contract = getInteractionContractById('queue-choice');
        const timeoutMs = event.timeoutMs ?? contract.defaultTimeoutMs;
        this.state = {
          type: 'AWAITING_QUEUE_CHOICE',
          userId: event.userId,
          transcript: event.transcript,
          enteredAt: Date.now(),
          timeoutMs,
          warningFired: false,
        };
        this.scheduleTimers(timeoutMs, contract.timeoutText);
        return effects;
      }

      case 'ENTER_SWITCH_CHOICE': {
        this.clearTimers();
        const contract = getInteractionContractById('switch-choice');
        const timeoutMs = event.timeoutMs ?? contract.defaultTimeoutMs;
        this.state = {
          type: 'AWAITING_SWITCH_CHOICE',
          lastMessage: event.lastMessage,
          enteredAt: Date.now(),
          timeoutMs,
          warningFired: false,
        };
        this.scheduleTimers(timeoutMs, contract.timeoutText);
        return effects;
      }

      case 'ENTER_ROUTE_CONFIRMATION': {
        this.clearTimers();
        const contract = getInteractionContractById('route-confirmation');
        const timeoutMs = event.timeoutMs ?? contract.defaultTimeoutMs;
        this.state = {
          type: 'AWAITING_ROUTE_CONFIRMATION',
          userId: event.userId,
          transcript: event.transcript,
          targetId: event.targetId,
          targetName: event.targetName,
          confirmAction: event.confirmAction ?? 'route',
          createTitle: event.createTitle,
          createTargetType: event.createTargetType,
          deliveryMode: event.deliveryMode ?? 'wait',
          closeType: event.closeType ?? null,
          fallbackChannelId: event.fallbackChannelId ?? null,
          enteredAt: Date.now(),
          timeoutMs,
          warningFired: false,
          repromptCount: 0,
        };
        this.scheduleTimers(timeoutMs, contract.timeoutText);
        return effects;
      }

      case 'ENTER_NEW_POST_FLOW': {
        this.clearTimers();
        const contract = getInteractionContractById(
          event.step === 'forum' ? 'new-post-forum' : 'new-post-title',
        );
        const timeoutMs = event.timeoutMs ?? contract.defaultTimeoutMs;
        this.state = {
          type: 'NEW_POST_FLOW',
          step: event.step,
          forumId: event.forumId,
          forumName: event.forumName,
          title: event.title,
          enteredAt: Date.now(),
          timeoutMs,
          warningFired: false,
        };
        this.scheduleTimers(timeoutMs, contract.timeoutText);
        return effects;
      }

      case 'NEW_POST_ADVANCE': {
        this.clearTimers();
        const contract = getInteractionContractById(
          event.step === 'forum' ? 'new-post-forum' : 'new-post-title',
        );
        const timeoutMs = event.timeoutMs ?? contract.defaultTimeoutMs;
        this.state = {
          type: 'NEW_POST_FLOW',
          step: event.step,
          forumId: event.forumId,
          forumName: event.forumName,
          title: event.title,
          enteredAt: Date.now(),
          timeoutMs,
          warningFired: false,
        };
        this.scheduleTimers(timeoutMs, contract.timeoutText);
        return effects;
      }

      case 'ENTER_INBOX_FLOW':
        this.clearTimers();
        this.state = {
          type: 'INBOX_FLOW',
          items: event.items,
          index: 0,
          returnChannel: event.returnChannel ?? null,
        };
        return effects;

      case 'INBOX_ADVANCE':
        if (this.state.type === 'INBOX_FLOW') {
          this.state = {
            ...this.state,
            index: this.state.index + 1,
          };
        } else {
          console.warn(`INBOX_ADVANCE arrived in non-INBOX_FLOW state: ${this.state.type}`);
        }
        return effects;

      case 'INBOX_JUMP':
        if (this.state.type === 'INBOX_FLOW') {
          this.state = {
            ...this.state,
            index: event.index, // handleInboxNext reads items[index] then advances
          };
        } else {
          console.warn(`INBOX_JUMP arrived in non-INBOX_FLOW state: ${this.state.type}`);
        }
        return effects;

      case 'AWAITING_INPUT_RECEIVED':
        if (!event.recognized && this.isAwaitingState()) {
          effects.push({ type: 'earcon', name: 'error' });
          effects.push({ type: 'speak', text: this.getRepromptText() });
          this.resetAwaitingTimers();
        }
        return effects;

      case 'REFRESH_AWAITING_TIMEOUT':
        this.resetAwaitingTimers();
        return effects;

      case 'TIMEOUT_CHECK':
        return this.checkTimeouts();

      case 'CANCEL_FLOW':
        this.clearTimers();
        effects.push({ type: 'earcon', name: 'cancelled' });
        this.state = { type: 'IDLE' };
        return effects;

      case 'RETURN_TO_IDLE':
        this.clearTimers();
        this.state = { type: 'IDLE' };
        return effects;
    }

    return effects;
  }

  /**
   * Handle an utterance arriving: if busy, buffer and produce busy earcon.
   */
  private handleUtteranceReceived(effects: TransitionEffect[]): TransitionEffect[] {
    if (this.isAwaitingState()) {
      // User is responding to a prompt; pause timeout timers while capture/STT runs.
      this.clearTimers();
      return effects;
    }

    if (this.state.type === 'PROCESSING') {
      effects.push({ type: 'earcon', name: 'busy' });
      return effects;
    }

    if (this.state.type === 'SPEAKING') {
      effects.push({ type: 'stop-playback' });
      effects.push({ type: 'earcon', name: 'busy' });
      return effects;
    }

    if (this.state.type === 'IDLE') {
      this.state = { type: 'TRANSCRIBING' };
    }

    return effects;
  }

  /**
   * Check if any AWAITING state has timed out or needs a warning.
   * Returns effects to apply. Called periodically by the pipeline or by internal timers.
   */
  private checkTimeouts(): TransitionEffect[] {
    const effects: TransitionEffect[] = [];
    const s = this.state;

    if (!this.isAwaitingState()) return effects;

    const awaiting = s as AwaitingChannelSelectionState | AwaitingQueueChoiceState | AwaitingSwitchChoiceState | AwaitingRouteConfirmationState | NewPostFlowState;
    const elapsed = Date.now() - awaiting.enteredAt;
    const remaining = awaiting.timeoutMs - elapsed;

    if (remaining <= 0) {
      // Timed out
      effects.push({ type: 'earcon', name: 'cancelled' });
      this.state = { type: 'IDLE' };
      this.clearTimers();
    } else if (remaining <= DEFAULT_WARNING_BEFORE_MS && !awaiting.warningFired) {
      // Warning
      effects.push({ type: 'earcon', name: 'timeout-warning' });
      awaiting.warningFired = true;
    }

    return effects;
  }

  /**
   * Whether the current state is an AWAITING state with timeout tracking.
   */
  isAwaitingState(): boolean {
    return (
      this.state.type === 'AWAITING_CHANNEL_SELECTION' ||
      this.state.type === 'AWAITING_QUEUE_CHOICE' ||
      this.state.type === 'AWAITING_SWITCH_CHOICE' ||
      this.state.type === 'AWAITING_ROUTE_CONFIRMATION' ||
      this.state.type === 'NEW_POST_FLOW'
    );
  }

  /**
   * Get the reprompt text for the current AWAITING state.
   */
  getRepromptText(): string {
    const contract = getInteractionContractForState(this.state);
    return contract?.repromptText ?? '';
  }

  /**
   * Get inbox flow state for the pipeline to use.
   */
  getInboxFlowState(): { items: any[]; index: number; returnChannel: string | null } | null {
    if (this.state.type !== 'INBOX_FLOW') return null;
    return { items: this.state.items, index: this.state.index, returnChannel: this.state.returnChannel };
  }

  /**
   * Get the new-post flow data.
   */
  getNewPostFlowState(): NewPostFlowState | null {
    if (this.state.type !== 'NEW_POST_FLOW') return null;
    return this.state;
  }

  /**
   * Get queue choice state data.
   */
  getQueueChoiceState(): AwaitingQueueChoiceState | null {
    if (this.state.type !== 'AWAITING_QUEUE_CHOICE') return null;
    return this.state;
  }

  /**
   * Get switch choice state data.
   */
  getSwitchChoiceState(): AwaitingSwitchChoiceState | null {
    if (this.state.type !== 'AWAITING_SWITCH_CHOICE') return null;
    return this.state;
  }

  /**
   * Get channel selection state data.
   */
  getChannelSelectionState(): AwaitingChannelSelectionState | null {
    if (this.state.type !== 'AWAITING_CHANNEL_SELECTION') return null;
    return this.state;
  }

  getRouteConfirmationState(): AwaitingRouteConfirmationState | null {
    if (this.state.type !== 'AWAITING_ROUTE_CONFIRMATION') return null;
    return this.state;
  }

  /**
   * Schedule warning and timeout timers for the current AWAITING state.
   */
  private scheduleTimers(timeoutMs: number, timeoutMessage: string): void {
    this.clearTimers();

    const warningMs = Math.max(0, timeoutMs - DEFAULT_WARNING_BEFORE_MS);

    this.warningTimer = setTimeout(() => {
      const effects: TransitionEffect[] = [];
      if (this.isAwaitingState()) {
        effects.push({ type: 'earcon', name: 'timeout-warning' });
        const s = this.state as any;
        if ('warningFired' in s) s.warningFired = true;
      }
      if (effects.length > 0) {
        this.onTimeout?.(effects);
      }
    }, warningMs);

    this.timeoutTimer = setTimeout(() => {
      const effects: TransitionEffect[] = [];
      effects.push({ type: 'earcon', name: 'cancelled' });
      effects.push({ type: 'speak', text: timeoutMessage });
      const preTimeoutState = this.state;
      this.state = { type: 'IDLE' };
      this.clearTimers();
      this.onTimeout?.(effects, preTimeoutState);
    }, timeoutMs);
  }

  /**
   * Clear all active timers.
   */
  clearTimers(): void {
    if (this.warningTimer) {
      clearTimeout(this.warningTimer);
      this.warningTimer = null;
    }
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  private getTimeoutMessageForCurrentState(): string {
    const contract = getInteractionContractForState(this.state);
    return contract?.timeoutText ?? 'Choice timed out.';
  }

  private resetAwaitingTimers(): void {
    if (!this.isAwaitingState()) return;
    this.clearTimers();
    const awaitingState = this.state as AwaitingChannelSelectionState | AwaitingQueueChoiceState | AwaitingSwitchChoiceState | AwaitingRouteConfirmationState | NewPostFlowState;
    const timeoutMs = awaitingState.timeoutMs;
    awaitingState.enteredAt = Date.now();
    awaitingState.warningFired = false;
    this.scheduleTimers(timeoutMs, this.getTimeoutMessageForCurrentState());
  }

  /**
   * Clean up when pipeline is stopped.
   */
  destroy(): void {
    this.clearTimers();
    this.bufferedUtterances = [];
    this.state = { type: 'IDLE' };
  }
}

// ─── V2 state machine ──────────────────────────────────────────────────────

export type V2PipelineStateType =
  | 'CLOSED'
  | 'LISTENING'
  | 'DISPATCHING'
  | 'CLARIFYING'
  | 'FOCUS'
  | 'BACKGROUND'
  | 'SPEAKING';

export interface ClosedState {
  type: 'CLOSED';
}

export interface ListeningState {
  type: 'LISTENING';
  mode: 'quick' | 'indicate';
  startedAt: number;
  timeoutMs: number;
}

export interface DispatchingState {
  type: 'DISPATCHING';
}

export interface ClarifyingState {
  type: 'CLARIFYING';
  question: string;
  enteredAt: number;
  timeoutMs: number;
}

export interface FocusState {
  type: 'FOCUS';
  taskId: string;
}

export interface BackgroundTask {
  taskId: string;
  status: 'pending' | 'ready';
  response?: string;
}

export interface BackgroundState {
  type: 'BACKGROUND';
  tasks: BackgroundTask[];
}

export interface SpeakingV2State {
  type: 'SPEAKING';
}

export type V2PipelineState =
  | ClosedState
  | ListeningState
  | DispatchingState
  | ClarifyingState
  | FocusState
  | BackgroundState
  | SpeakingV2State;

export type V2PipelineEvent =
  | { type: 'INTERRUPT_WAKE'; mode?: 'quick' | 'indicate'; timeoutMs?: number }
  | { type: 'LISTENING_ACTIVITY'; transcript?: string }
  | { type: 'LISTENING_FINALIZED'; transcript?: string }
  | { type: 'LISTENING_TIMED_OUT' }
  | { type: 'DISPATCH_RESOLVED'; disposition: 'focus' | 'background'; taskId: string }
  | { type: 'DISPATCH_NEEDS_CLARIFICATION'; question: string; timeoutMs?: number }
  | { type: 'CLARIFICATION_RECEIVED'; transcript?: string }
  | { type: 'CLARIFICATION_TIMED_OUT' }
  | { type: 'DISPATCH_FAILED' }
  | { type: 'FOCUS_RESPONSE_READY'; taskId: string; response?: string }
  | { type: 'BACKGROUND_TASK_READY'; taskId: string; response: string }
  | { type: 'BACKGROUND_RESPONSE_ACKNOWLEDGED'; taskId?: string }
  | { type: 'INTERRUPT_SWITCH_TO_BACKGROUND' }
  | { type: 'INTERRUPT_SWITCH_TO_FOCUS'; taskId?: string }
  | { type: 'INTERRUPT_CANCEL' }
  | { type: 'SPEAKING_COMPLETE' }
  | { type: 'RESET_TO_CLOSED' };

export class V2PipelineStateMachine {
  private static readonly DEFAULT_LISTENING_TIMEOUT_MS = 60_000;
  private static readonly DEFAULT_CLARIFYING_TIMEOUT_MS = 15_000;

  private state: V2PipelineState = { type: 'CLOSED' };
  private backgroundTasks: BackgroundTask[] = [];
  private focusTaskId: string | null = null;
  private listeningTimer: ReturnType<typeof setTimeout> | null = null;
  private clarifyingTimer: ReturnType<typeof setTimeout> | null = null;
  private onTimeout: ((effects: TransitionEffect[]) => void) | null = null;
  private listeningHasSpeech = false;

  getState(): V2PipelineState {
    if (this.state.type === 'BACKGROUND') {
      return {
        type: 'BACKGROUND',
        tasks: this.backgroundTasks.map((task) => ({ ...task })),
      };
    }

    return this.state;
  }

  getStateType(): V2PipelineStateType {
    return this.state.type;
  }

  getBackgroundTasks(): BackgroundTask[] {
    return this.backgroundTasks.map((task) => ({ ...task }));
  }

  getBackgroundState(): BackgroundState | null {
    if (this.state.type !== 'BACKGROUND') return null;
    return {
      type: 'BACKGROUND',
      tasks: this.getBackgroundTasks(),
    };
  }

  getClarifyingState(): ClarifyingState | null {
    if (this.state.type !== 'CLARIFYING') return null;
    return this.state;
  }

  getFocusState(): FocusState | null {
    if (this.state.type !== 'FOCUS') return null;
    return this.state;
  }

  hasActiveTimers(): boolean {
    return this.listeningTimer !== null || this.clarifyingTimer !== null;
  }

  setTimeoutHandler(handler: (effects: TransitionEffect[]) => void): void {
    this.onTimeout = handler;
  }

  transition(event: V2PipelineEvent): TransitionEffect[] {
    const effects: TransitionEffect[] = [];

    switch (event.type) {
      case 'INTERRUPT_WAKE': {
        if (this.state.type === 'SPEAKING') {
          effects.push({ type: 'stop-playback' });
        }
        if (this.state.type === 'FOCUS') {
          effects.push({ type: 'stop-waiting-loop' });
        }
        this.enterListening(event.mode ?? 'quick', event.timeoutMs);
        if (this.state.type === 'LISTENING' && this.state.mode === 'indicate') {
          effects.push({ type: 'earcon', name: 'ready' });
        }
        return effects;
      }

      case 'LISTENING_ACTIVITY':
        if (this.state.type === 'LISTENING') {
          this.listeningHasSpeech = true;
        }
        return effects;

      case 'LISTENING_FINALIZED':
        if (this.state.type === 'LISTENING') {
          this.listeningHasSpeech = true;
          this.clearListeningTimer();
          this.state = { type: 'DISPATCHING' };
          effects.push({ type: 'earcon', name: 'acknowledged' });
        }
        return effects;

      case 'LISTENING_TIMED_OUT':
        return this.handleListeningTimeout(effects);

      case 'DISPATCH_RESOLVED':
        this.clearClarifyingTimer();
        if (event.disposition === 'focus') {
          this.focusTaskId = event.taskId;
          this.state = { type: 'FOCUS', taskId: event.taskId };
          effects.push({ type: 'start-waiting-loop' });
        } else {
          this.focusTaskId = null;
          this.upsertBackgroundTask({ taskId: event.taskId, status: 'pending' });
          this.state = this.createBackgroundState();
        }
        return effects;

      case 'DISPATCH_NEEDS_CLARIFICATION': {
        this.clearClarifyingTimer();
        const timeoutMs = event.timeoutMs ?? V2PipelineStateMachine.DEFAULT_CLARIFYING_TIMEOUT_MS;
        this.state = {
          type: 'CLARIFYING',
          question: event.question,
          enteredAt: Date.now(),
          timeoutMs,
        };
        this.scheduleClarifyingTimer(timeoutMs);
        effects.push({ type: 'speak', text: event.question });
        return effects;
      }

      case 'CLARIFICATION_RECEIVED':
        if (this.state.type === 'CLARIFYING') {
          this.clearClarifyingTimer();
          this.state = { type: 'DISPATCHING' };
          effects.push({ type: 'earcon', name: 'acknowledged' });
        }
        return effects;

      case 'CLARIFICATION_TIMED_OUT':
        return this.handleClarifyingTimeout(effects);

      case 'DISPATCH_FAILED':
        this.clearClarifyingTimer();
        this.state = this.resolvePassiveState();
        effects.push({ type: 'earcon', name: 'error' });
        if (this.state.type === 'FOCUS') {
          effects.push({ type: 'start-waiting-loop' });
        }
        return effects;

      case 'FOCUS_RESPONSE_READY':
        if (this.focusTaskId === event.taskId) {
          this.focusTaskId = null;
          this.state = { type: 'SPEAKING' };
          effects.push({ type: 'stop-waiting-loop' });
        }
        return effects;

      case 'BACKGROUND_TASK_READY': {
        const task = this.backgroundTasks.find((candidate) => candidate.taskId === event.taskId);
        if (task) {
          task.status = 'ready';
          task.response = event.response;
        } else {
          this.backgroundTasks.push({
            taskId: event.taskId,
            status: 'ready',
            response: event.response,
          });
        }
        if (this.state.type === 'BACKGROUND') {
          this.state = this.createBackgroundState();
          effects.push({ type: 'earcon', name: 'nudge' });
        }
        return effects;
      }

      case 'BACKGROUND_RESPONSE_ACKNOWLEDGED': {
        const task = this.takeReadyBackgroundTask(event.taskId);
        if (!task) return effects;
        this.state = { type: 'SPEAKING' };
        return effects;
      }

      case 'INTERRUPT_SWITCH_TO_BACKGROUND':
        if (this.focusTaskId) {
          this.upsertBackgroundTask({
            taskId: this.focusTaskId,
            status: 'pending',
          });
          this.focusTaskId = null;
          this.state = this.createBackgroundState();
          effects.push({ type: 'stop-waiting-loop' });
        }
        return effects;

      case 'INTERRUPT_SWITCH_TO_FOCUS': {
        if (this.focusTaskId) {
          this.state = { type: 'FOCUS', taskId: this.focusTaskId };
          return effects;
        }
        const task = this.takeBackgroundTask(event.taskId);
        if (!task) return effects;
        if (task.status === 'ready') {
          this.state = { type: 'SPEAKING' };
          return effects;
        }
        this.focusTaskId = task.taskId;
        this.state = { type: 'FOCUS', taskId: task.taskId };
        effects.push({ type: 'start-waiting-loop' });
        return effects;
      }

      case 'INTERRUPT_CANCEL':
        this.clearTimers();
        if (this.state.type === 'SPEAKING') {
          effects.push({ type: 'stop-playback' });
        }
        if (this.state.type === 'FOCUS') {
          effects.push({ type: 'stop-waiting-loop' });
        }
        this.backgroundTasks = [];
        this.focusTaskId = null;
        this.state = { type: 'CLOSED' };
        effects.push({ type: 'earcon', name: 'cancelled' });
        return effects;

      case 'SPEAKING_COMPLETE':
        this.state = this.resolvePassiveState();
        if (this.state.type === 'FOCUS') {
          effects.push({ type: 'start-waiting-loop' });
        }
        return effects;

      case 'RESET_TO_CLOSED':
        this.clearTimers();
        this.backgroundTasks = [];
        this.focusTaskId = null;
        this.state = { type: 'CLOSED' };
        this.listeningHasSpeech = false;
        return effects;
    }

    return effects;
  }

  destroy(): void {
    this.clearTimers();
    this.backgroundTasks = [];
    this.focusTaskId = null;
    this.listeningHasSpeech = false;
    this.state = { type: 'CLOSED' };
  }

  private enterListening(mode: 'quick' | 'indicate', timeoutMs?: number): void {
    this.clearListeningTimer();
    const listeningTimeoutMs = timeoutMs ?? V2PipelineStateMachine.DEFAULT_LISTENING_TIMEOUT_MS;
    this.listeningHasSpeech = false;
    this.state = {
      type: 'LISTENING',
      mode,
      startedAt: Date.now(),
      timeoutMs: listeningTimeoutMs,
    };
    this.listeningTimer = setTimeout(() => {
      const effects = this.transition({ type: 'LISTENING_TIMED_OUT' });
      this.onTimeout?.(effects);
    }, listeningTimeoutMs);
  }

  private handleListeningTimeout(effects: TransitionEffect[]): TransitionEffect[] {
    if (this.state.type !== 'LISTENING') return effects;

    const shouldResumeFocus = this.focusTaskId !== null && !this.listeningHasSpeech;
    this.clearListeningTimer();
    if (this.listeningHasSpeech) {
      this.state = { type: 'DISPATCHING' };
      effects.push({ type: 'earcon', name: 'acknowledged' });
      return effects;
    }

    this.state = this.resolvePassiveState();
    if (shouldResumeFocus && this.state.type === 'FOCUS') {
      effects.push({ type: 'start-waiting-loop' });
    }
    return effects;
  }

  private handleClarifyingTimeout(effects: TransitionEffect[]): TransitionEffect[] {
    if (this.state.type !== 'CLARIFYING') return effects;
    this.clearClarifyingTimer();
    this.state = this.resolvePassiveState();
    effects.push({ type: 'earcon', name: 'cancelled' });
    if (this.state.type === 'FOCUS') {
      effects.push({ type: 'start-waiting-loop' });
    }
    return effects;
  }

  private scheduleClarifyingTimer(timeoutMs: number): void {
    this.clearClarifyingTimer();
    this.clarifyingTimer = setTimeout(() => {
      const effects = this.transition({ type: 'CLARIFICATION_TIMED_OUT' });
      this.onTimeout?.(effects);
    }, timeoutMs);
  }

  private resolvePassiveState(): V2PipelineState {
    if (this.focusTaskId) {
      return {
        type: 'FOCUS',
        taskId: this.focusTaskId,
      };
    }
    if (this.backgroundTasks.length > 0) {
      return this.createBackgroundState();
    }
    return { type: 'CLOSED' };
  }

  private createBackgroundState(): BackgroundState {
    return {
      type: 'BACKGROUND',
      tasks: this.getBackgroundTasks(),
    };
  }

  private upsertBackgroundTask(task: BackgroundTask): void {
    const existing = this.backgroundTasks.find((candidate) => candidate.taskId === task.taskId);
    if (existing) {
      existing.status = task.status;
      existing.response = task.response;
      return;
    }
    this.backgroundTasks.push({ ...task });
  }

  private takeReadyBackgroundTask(taskId?: string): BackgroundTask | null {
    const index = taskId
      ? this.backgroundTasks.findIndex((task) => task.taskId === taskId && task.status === 'ready')
      : this.backgroundTasks.findIndex((task) => task.status === 'ready');
    if (index < 0) return null;
    const [task] = this.backgroundTasks.splice(index, 1);
    return task ?? null;
  }

  private takeBackgroundTask(taskId?: string): BackgroundTask | null {
    if (this.backgroundTasks.length === 0) return null;
    const index = taskId
      ? this.backgroundTasks.findIndex((task) => task.taskId === taskId)
      : this.backgroundTasks.length - 1;
    if (index < 0) return null;
    const [task] = this.backgroundTasks.splice(index, 1);
    return task ?? null;
  }

  private clearListeningTimer(): void {
    if (this.listeningTimer) {
      clearTimeout(this.listeningTimer);
      this.listeningTimer = null;
    }
  }

  private clearClarifyingTimer(): void {
    if (this.clarifyingTimer) {
      clearTimeout(this.clarifyingTimer);
      this.clarifyingTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearListeningTimer();
    this.clearClarifyingTimer();
  }
}
