import {
  V2InteractionFlowHarness,
  type V2HarnessEvent,
} from './interaction-flow-harness.js';

export interface V2TransitionScenarioResult {
  id: string;
  ok: boolean;
  errors: string[];
  events: V2HarnessEvent[];
  finalState: string;
}

type Scenario = {
  id: string;
  run: (harness: V2InteractionFlowHarness) => void;
  validate: (events: V2HarnessEvent[]) => string[];
};

const scenarios: Scenario[] = [
  {
    id: 'quick-background-response-cycle',
    run: (h) => {
      h.wake('quick');
      h.listen('Summarize the latest updates.');
      h.resolveDispatchToBackground('bg-1');
      h.markBackgroundTaskReady('bg-1', 'Ready.');
      h.sendInterruptTranscript('Hey Tango, what is the response');
      h.completeSpeaking();
    },
    validate: (events) => {
      const errors: string[] = [];
      expectStatePath(
        events,
        ['CLOSED', 'LISTENING', 'DISPATCHING', 'BACKGROUND', 'SPEAKING', 'CLOSED'],
        errors,
      );
      expectEvent(events, { type: 'earcon', name: 'nudge' }, 'missing nudge earcon', errors);
      expectEvent(
        events,
        { type: 'recognized', intent: 'next-response' },
        'missing next-response recognition',
        errors,
      );
      return errors;
    },
  },
  {
    id: 'indicate-timeout-dispatches-after-speech',
    run: (h) => {
      h.wake('indicate');
      h.listen('Draft a longer roadmap update.', { finalize: false });
      h.listeningTimedOut();
      h.resolveDispatchToBackground('bg-2');
    },
    validate: (events) => {
      const errors: string[] = [];
      expectStatePath(
        events,
        ['CLOSED', 'LISTENING', 'DISPATCHING', 'BACKGROUND'],
        errors,
      );
      expectEvent(events, { type: 'earcon', name: 'ready' }, 'missing indicate ready earcon', errors);
      return errors;
    },
  },
  {
    id: 'clarifying-round-trip',
    run: (h) => {
      h.wake('quick');
      h.listen('Send this to Watson.');
      h.requestClarification('Which Watson route should I use?');
      h.listen('Use the engineering thread.');
      h.resolveDispatchToBackground('bg-3');
    },
    validate: (events) => {
      const errors: string[] = [];
      expectStatePath(
        events,
        ['CLOSED', 'LISTENING', 'DISPATCHING', 'CLARIFYING', 'DISPATCHING', 'BACKGROUND'],
        errors,
      );
      expectEvent(
        events,
        { type: 'speak', text: 'Which Watson route should I use?' },
        'missing clarifying question',
        errors,
      );
      return errors;
    },
  },
  {
    id: 'clarifying-timeout-closes',
    run: (h) => {
      h.wake('quick');
      h.listen('Route this for me.');
      h.requestClarification('Which agent should I use?');
      h.clarifyingTimedOut();
    },
    validate: (events) => {
      const errors: string[] = [];
      expectStatePath(events, ['CLOSED', 'LISTENING', 'DISPATCHING', 'CLARIFYING', 'CLOSED'], errors);
      expectEvent(events, { type: 'earcon', name: 'cancelled' }, 'missing clarifying timeout cue', errors);
      return errors;
    },
  },
  {
    id: 'focus-response-speaks-and-closes',
    run: (h) => {
      h.wake('quick');
      h.listen('Wait here for the answer.');
      h.resolveDispatchToFocus('focus-1');
      h.markFocusResponseReady('focus-1', 'Done.');
      h.completeSpeaking();
    },
    validate: (events) => {
      const errors: string[] = [];
      expectStatePath(
        events,
        ['CLOSED', 'LISTENING', 'DISPATCHING', 'FOCUS', 'SPEAKING', 'CLOSED'],
        errors,
      );
      return errors;
    },
  },
  {
    id: 'focus-switches-to-background',
    run: (h) => {
      h.wake('quick');
      h.listen('Stay with this request.');
      h.resolveDispatchToFocus('focus-2');
      h.sendInterruptTranscript('Hey Tango, put it in the background');
      h.markBackgroundTaskReady('focus-2', 'Ready.');
      h.sendInterruptTranscript('Hey Tango, next');
      h.completeSpeaking();
    },
    validate: (events) => {
      const errors: string[] = [];
      expectStatePath(
        events,
        ['CLOSED', 'LISTENING', 'DISPATCHING', 'FOCUS', 'BACKGROUND', 'SPEAKING', 'CLOSED'],
        errors,
      );
      expectEvent(
        events,
        { type: 'recognized', intent: 'switch-to-background' },
        'missing switch-to-background recognition',
        errors,
      );
      return errors;
    },
  },
  {
    id: 'wake-interrupts-speaking',
    run: (h) => {
      h.wake('quick');
      h.listen('Wait here for this.');
      h.resolveDispatchToFocus('focus-3');
      h.markFocusResponseReady('focus-3', 'Ready.');
      h.wake('quick');
    },
    validate: (events) => {
      const errors: string[] = [];
      expectStatePath(
        events,
        ['CLOSED', 'LISTENING', 'DISPATCHING', 'FOCUS', 'SPEAKING', 'LISTENING'],
        errors,
      );
      expectEvent(events, { type: 'earcon', name: 'acknowledged' }, 'missing dispatch ack', errors);
      return errors;
    },
  },
  {
    id: 'cancel-interrupts-speaking',
    run: (h) => {
      h.wake('quick');
      h.listen('Wait here for this.');
      h.resolveDispatchToFocus('focus-4');
      h.markFocusResponseReady('focus-4', 'Ready.');
      h.sendInterruptTranscript('Hey Tango, cancel');
    },
    validate: (events) => {
      const errors: string[] = [];
      expectStatePath(
        events,
        ['CLOSED', 'LISTENING', 'DISPATCHING', 'FOCUS', 'SPEAKING', 'CLOSED'],
        errors,
      );
      expectEvent(events, { type: 'earcon', name: 'cancelled' }, 'missing cancel cue', errors);
      return errors;
    },
  },
  {
    id: 'background-nested-listening-preserves-tasks',
    run: (h) => {
      h.wake('quick');
      h.listen('First background task.');
      h.resolveDispatchToBackground('bg-4');
      h.wake('quick');
      h.listen('Second background task.');
      h.resolveDispatchToBackground('bg-5');
      h.markBackgroundTaskReady('bg-4', 'First ready.');
      h.markBackgroundTaskReady('bg-5', 'Second ready.');
      h.sendInterruptTranscript('Hey Tango, next');
      h.completeSpeaking();
      h.sendInterruptTranscript('Hey Tango, next');
      h.completeSpeaking();
    },
    validate: (events) => {
      const errors: string[] = [];
      expectStatePath(
        events,
        ['CLOSED', 'LISTENING', 'DISPATCHING', 'BACKGROUND', 'LISTENING', 'DISPATCHING', 'BACKGROUND', 'SPEAKING', 'BACKGROUND', 'SPEAKING', 'CLOSED'],
        errors,
      );
      const nudgeCount = events.filter(
        (event) => event.type === 'earcon' && event.name === 'nudge',
      ).length;
      if (nudgeCount < 2) {
        errors.push(`expected 2 nudge earcons, saw ${nudgeCount}`);
      }
      return errors;
    },
  },
];

export function runV2TransitionTable(): V2TransitionScenarioResult[] {
  return scenarios.map((scenario) => {
    const harness = new V2InteractionFlowHarness();
    scenario.run(harness);
    const events = harness.getEvents();
    const errors = scenario.validate(events);
    const finalState = harness.getState();
    harness.destroy();

    return {
      id: scenario.id,
      ok: errors.length === 0,
      errors,
      events,
      finalState,
    };
  });
}

function expectEvent(
  events: V2HarnessEvent[],
  expected: Partial<V2HarnessEvent>,
  errorMessage: string,
  errors: string[],
): void {
  const found = events.some((event) => {
    for (const [key, value] of Object.entries(expected)) {
      if ((event as Record<string, unknown>)[key] !== value) return false;
    }
    return true;
  });
  if (!found) {
    errors.push(errorMessage);
  }
}

function expectStatePath(
  events: V2HarnessEvent[],
  expectedStates: string[],
  errors: string[],
): void {
  const states = events
    .filter((event): event is Extract<V2HarnessEvent, { type: 'state' }> => event.type === 'state')
    .map((event) => event.state);

  let cursor = 0;
  for (const state of states) {
    if (state === expectedStates[cursor]) {
      cursor += 1;
      if (cursor >= expectedStates.length) {
        return;
      }
    }
  }

  errors.push(`expected state path ${expectedStates.join(' -> ')}, saw ${states.join(' -> ')}`);
}
