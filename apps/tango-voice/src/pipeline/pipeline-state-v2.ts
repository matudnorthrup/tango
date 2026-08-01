import type { EarconName } from '../audio/earcons.js';

// ─── V2 state machine ──────────────────────────────────────────────────────
//
// Scaffolding for the V2 interrupt-lifecycle pipeline (state machine +
// interrupt layer + transition tests). Nothing in the production pipeline
// consumes this module yet — the live pipeline remains the V1 machine in
// ./pipeline-state.ts. See docs/specs/voice-state-machine-v2-design.md.

/**
 * Effects the V2 machine asks the (future) pipeline to apply. Deliberately a
 * separate union from the V1 `TransitionEffect` so the V2 scaffolding can
 * grow effect kinds (waiting-loop control) without touching the V1 machine
 * or its consumers.
 */
export type V2TransitionEffect =
  | { type: 'earcon'; name: EarconName }
  | { type: 'speak'; text: string }
  | { type: 'stop-playback' }
  | { type: 'start-waiting-loop' }
  | { type: 'stop-waiting-loop' };

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
  private onTimeout: ((effects: V2TransitionEffect[]) => void) | null = null;
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

  setTimeoutHandler(handler: (effects: V2TransitionEffect[]) => void): void {
    this.onTimeout = handler;
  }

  transition(event: V2PipelineEvent): V2TransitionEffect[] {
    const effects: V2TransitionEffect[] = [];

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

  private handleListeningTimeout(effects: V2TransitionEffect[]): V2TransitionEffect[] {
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

  private handleClarifyingTimeout(effects: V2TransitionEffect[]): V2TransitionEffect[] {
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
