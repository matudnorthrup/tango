import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { V2PipelineStateMachine, type TransitionEffect } from '../src/pipeline/pipeline-state.js';

describe('V2PipelineStateMachine', () => {
  let sm: V2PipelineStateMachine;

  beforeEach(() => {
    vi.useFakeTimers();
    sm = new V2PipelineStateMachine();
  });

  afterEach(() => {
    sm.destroy();
    vi.useRealTimers();
  });

  it('starts closed', () => {
    expect(sm.getStateType()).toBe('CLOSED');
    expect(sm.getBackgroundTasks()).toEqual([]);
  });

  it('enters indicate listening with a ready cue', () => {
    const effects = sm.transition({ type: 'INTERRUPT_WAKE', mode: 'indicate' });

    expect(sm.getStateType()).toBe('LISTENING');
    expect(effects).toEqual([{ type: 'earcon', name: 'ready' }]);
  });

  it('returns to closed when listening times out without speech', async () => {
    const timeoutEffects: TransitionEffect[][] = [];
    sm.setTimeoutHandler((effects) => timeoutEffects.push(effects));

    sm.transition({ type: 'INTERRUPT_WAKE', mode: 'quick', timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sm.getStateType()).toBe('CLOSED');
    expect(timeoutEffects).toEqual([[]]);
  });

  it('dispatches when listening times out after speech activity', async () => {
    const timeoutEffects: TransitionEffect[][] = [];
    sm.setTimeoutHandler((effects) => timeoutEffects.push(effects));

    sm.transition({ type: 'INTERRUPT_WAKE', mode: 'indicate', timeoutMs: 1_000 });
    sm.transition({ type: 'LISTENING_ACTIVITY', transcript: 'Long response' });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sm.getStateType()).toBe('DISPATCHING');
    expect(timeoutEffects).toEqual([[{ type: 'earcon', name: 'acknowledged' }]]);
  });

  it('tracks a background task through ready and playback', () => {
    sm.transition({ type: 'INTERRUPT_WAKE', mode: 'quick' });
    sm.transition({ type: 'LISTENING_FINALIZED', transcript: 'Do this later.' });
    sm.transition({ type: 'DISPATCH_RESOLVED', disposition: 'background', taskId: 'bg-1' });

    expect(sm.getStateType()).toBe('BACKGROUND');
    expect(sm.getBackgroundTasks()).toEqual([{ taskId: 'bg-1', status: 'pending' }]);

    const readyEffects = sm.transition({
      type: 'BACKGROUND_TASK_READY',
      taskId: 'bg-1',
      response: 'Done.',
    });
    expect(readyEffects).toEqual([{ type: 'earcon', name: 'nudge' }]);

    sm.transition({ type: 'BACKGROUND_RESPONSE_ACKNOWLEDGED', taskId: 'bg-1' });
    expect(sm.getStateType()).toBe('SPEAKING');

    sm.transition({ type: 'SPEAKING_COMPLETE' });
    expect(sm.getStateType()).toBe('CLOSED');
  });

  it('times out clarifying back to closed with a cancel cue', async () => {
    const timeoutEffects: TransitionEffect[][] = [];
    sm.setTimeoutHandler((effects) => timeoutEffects.push(effects));

    sm.transition({ type: 'INTERRUPT_WAKE', mode: 'quick' });
    sm.transition({ type: 'LISTENING_FINALIZED', transcript: 'Route this.' });
    sm.transition({
      type: 'DISPATCH_NEEDS_CLARIFICATION',
      question: 'Which agent should I use?',
      timeoutMs: 1_000,
    });

    expect(sm.getStateType()).toBe('CLARIFYING');

    await vi.advanceTimersByTimeAsync(1_000);

    expect(sm.getStateType()).toBe('CLOSED');
    expect(timeoutEffects).toEqual([[{ type: 'earcon', name: 'cancelled' }]]);
  });

  it('switches a focus task into background mode', () => {
    sm.transition({ type: 'INTERRUPT_WAKE', mode: 'quick' });
    sm.transition({ type: 'LISTENING_FINALIZED', transcript: 'Stay on this.' });
    sm.transition({ type: 'DISPATCH_RESOLVED', disposition: 'focus', taskId: 'focus-1' });

    const effects = sm.transition({ type: 'INTERRUPT_SWITCH_TO_BACKGROUND' });

    expect(sm.getStateType()).toBe('BACKGROUND');
    expect(sm.getBackgroundTasks()).toEqual([{ taskId: 'focus-1', status: 'pending' }]);
    expect(effects).toEqual([{ type: 'stop-waiting-loop' }]);
  });

  it('interrupts speaking with wake and cancel', () => {
    sm.transition({ type: 'INTERRUPT_WAKE', mode: 'quick' });
    sm.transition({ type: 'LISTENING_FINALIZED', transcript: 'Wait here.' });
    sm.transition({ type: 'DISPATCH_RESOLVED', disposition: 'focus', taskId: 'focus-2' });
    sm.transition({ type: 'FOCUS_RESPONSE_READY', taskId: 'focus-2', response: 'Done.' });

    const wakeEffects = sm.transition({ type: 'INTERRUPT_WAKE', mode: 'quick' });
    expect(sm.getStateType()).toBe('LISTENING');
    expect(wakeEffects).toEqual([{ type: 'stop-playback' }]);

    sm.transition({ type: 'LISTENING_FINALIZED', transcript: 'New request.' });
    sm.transition({ type: 'DISPATCH_RESOLVED', disposition: 'focus', taskId: 'focus-3' });
    sm.transition({ type: 'FOCUS_RESPONSE_READY', taskId: 'focus-3', response: 'Done.' });

    const cancelEffects = sm.transition({ type: 'INTERRUPT_CANCEL' });
    expect(sm.getStateType()).toBe('CLOSED');
    expect(cancelEffects).toEqual([
      { type: 'stop-playback' },
      { type: 'earcon', name: 'cancelled' },
    ]);
  });
});
