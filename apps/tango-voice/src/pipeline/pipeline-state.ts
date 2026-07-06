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

/**
 * States that wait on user input under a timeout contract. They all carry the
 * same timer bookkeeping fields; the type guard keeps the machine's timer
 * code free of casts.
 */
export type AwaitingPipelineState =
  | AwaitingChannelSelectionState
  | AwaitingQueueChoiceState
  | AwaitingSwitchChoiceState
  | AwaitingRouteConfirmationState
  | NewPostFlowState;

export function isAwaitingPipelineState(state: PipelineState): state is AwaitingPipelineState {
  return (
    state.type === 'AWAITING_CHANNEL_SELECTION' ||
    state.type === 'AWAITING_QUEUE_CHOICE' ||
    state.type === 'AWAITING_SWITCH_CHOICE' ||
    state.type === 'AWAITING_ROUTE_CONFIRMATION' ||
    state.type === 'NEW_POST_FLOW'
  );
}

// ─── Transition effects ─────────────────────────────────────────────────────

export type TransitionEffect =
  | { type: 'earcon'; name: EarconName }
  | { type: 'speak'; text: string }
  | { type: 'stop-playback' };

// ─── Events the pipeline sends to the state machine ────────────────────────

export type PipelineEvent =
  | { type: 'UTTERANCE_RECEIVED' }
  | { type: 'TRANSCRIPT_READY' }
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
  | { type: 'CANCEL_FLOW' }
  | { type: 'RETURN_TO_IDLE' };

// ─── Timeout configuration ─────────────────────────────────────────────────

const DEFAULT_WARNING_BEFORE_MS = 5_000;

// ─── State machine ─────────────────────────────────────────────────────────

export interface BufferedUtterance {
  userId: string;
  wavBuffer: Buffer;
  durationMs: number;
  /** Gate/prompt grace state at the moment the utterance was captured.
   * Replay must evaluate grace against this snapshot, not the clock at
   * re-process time — a fresh grace window is usually open by then and
   * would let stale wake-less speech through the gate (TGO-751). */
  graceAtCapture: { gate: boolean; prompt: boolean } | null;
}

export class PipelineStateMachine {
  private state: PipelineState = { type: 'IDLE' };
  private bufferedUtterances: BufferedUtterance[] = [];
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
  bufferUtterance(
    userId: string,
    wavBuffer: Buffer,
    durationMs: number,
    graceAtCapture: { gate: boolean; prompt: boolean } | null = null,
  ): void {
    if (this.bufferedUtterances.length >= PipelineStateMachine.MAX_BUFFERED_UTTERANCES) {
      this.bufferedUtterances.shift();
    }
    this.bufferedUtterances.push({ userId, wavBuffer, durationMs, graceAtCapture });
  }

  getBufferedUtterance(): BufferedUtterance | null {
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
   * Whether the current state is an AWAITING state with timeout tracking.
   */
  isAwaitingState(): boolean {
    return isAwaitingPipelineState(this.state);
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

    // A warning only makes sense when there is time left after it fires;
    // short windows (≤ the warning lead) skip straight to the timeout.
    if (timeoutMs > DEFAULT_WARNING_BEFORE_MS) {
      const warningMs = timeoutMs - DEFAULT_WARNING_BEFORE_MS;
      this.warningTimer = setTimeout(() => {
        this.warningTimer = null;
        const state = this.state;
        if (!isAwaitingPipelineState(state)) return;
        state.warningFired = true;
        this.onTimeout?.([{ type: 'earcon', name: 'timeout-warning' }]);
      }, warningMs);
    }

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
    const state = this.state;
    if (!isAwaitingPipelineState(state)) return;
    this.clearTimers();
    state.enteredAt = Date.now();
    state.warningFired = false;
    this.scheduleTimers(state.timeoutMs, this.getTimeoutMessageForCurrentState());
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
