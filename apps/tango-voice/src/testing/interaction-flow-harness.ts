import {
  PipelineStateMachine,
  type PipelineEvent,
  type PipelineStateType,
  type TransitionEffect,
  V2PipelineStateMachine,
  type V2PipelineEvent,
  type V2PipelineStateType,
} from '../pipeline/pipeline-state.js';
import {
  InterruptLayer,
  type InterruptEvent,
  type InterruptSystemCommand,
} from '../pipeline/interrupt-layer.js';
import {
  matchChannelSelection,
  matchQueueChoice,
  matchSwitchChoice,
  matchesWakeWord,
  parseVoiceCommand,
  type VoiceCommand,
  type ChannelOption,
} from '../services/voice-commands.js';
import { getDefaultVoiceTargetDirectory, type VoiceTargetDirectory } from '../services/voice-targets.js';

export type HarnessEvent =
  | { type: 'state'; state: PipelineStateType }
  | { type: 'earcon'; name: string }
  | { type: 'speak'; text: string }
  | { type: 'ready' }
  | { type: 'recognized'; intent: string }
  | { type: 'unrecognized'; transcript: string }
  | { type: 'rejected'; transcript: string; reason: 'gated-no-wake' };

/**
 * Deterministic simulator for interaction-contract flows.
 * It intentionally avoids Discord/audio IO and only validates
 * state transitions, recognized intents, and feedback sequencing.
 */
export class InteractionFlowHarness {
  private static readonly DEFAULT_READY_GRACE_MS = 5_000;
  private readonly voiceTargets: VoiceTargetDirectory;
  private readonly systemWakeNames: string[];
  private readonly allWakeNames: string[];
  private readonly sm: PipelineStateMachine;
  private readonly events: HarnessEvent[] = [];
  private gated = false;
  private gateGraceUntil = 0;

  constructor(systemWakeName?: string) {
    this.voiceTargets = getDefaultVoiceTargetDirectory();
    this.systemWakeNames = dedupeWakeNames(
      systemWakeName ? [systemWakeName] : this.voiceTargets.getSystemCallSigns(),
      ['Tango'],
    );
    this.allWakeNames = dedupeWakeNames(this.voiceTargets.getAllCallSigns(), this.systemWakeNames);
    this.sm = new PipelineStateMachine();
    this.sm.setTimeoutHandler((effects) => this.applyEffects(effects));
    this.recordState();
  }

  destroy(): void {
    this.sm.destroy();
  }

  getState(): PipelineStateType {
    return this.sm.getStateType();
  }

  setGatedMode(enabled: boolean): void {
    this.gated = enabled;
  }

  playReadyCue(graceMs = InteractionFlowHarness.DEFAULT_READY_GRACE_MS): void {
    this.gateGraceUntil = Date.now() + graceMs;
    this.events.push({ type: 'ready' });
  }

  isInReadyGraceWindow(): boolean {
    return Date.now() < this.gateGraceUntil;
  }

  getEvents(): HarnessEvent[] {
    return [...this.events];
  }

  clearEvents(): void {
    this.events.length = 0;
  }

  enterQueueChoice(userId = 'u1', transcript = 'hello'): void {
    this.transition({
      type: 'ENTER_QUEUE_CHOICE',
      userId,
      transcript,
    });
  }

  enterSwitchChoice(lastMessage: string): void {
    this.transition({
      type: 'ENTER_SWITCH_CHOICE',
      lastMessage,
    });
  }

  enterChannelSelection(options: ChannelOption[]): void {
    this.transition({
      type: 'ENTER_CHANNEL_SELECTION',
      options,
    });
  }

  sendTranscript(transcript: string): void {
    this.transition({ type: 'UTTERANCE_RECEIVED' });

    const state = this.sm.getStateType();
    if (state === 'AWAITING_QUEUE_CHOICE') {
      this.handleQueueChoice(transcript);
      return;
    }
    if (state === 'AWAITING_SWITCH_CHOICE') {
      this.handleSwitchChoice(transcript);
      return;
    }
    if (state === 'AWAITING_CHANNEL_SELECTION') {
      this.handleChannelSelection(transcript);
      return;
    }

    this.handleGeneralTurn(transcript);
  }

  private handleGeneralTurn(transcript: string): void {
    const hasWakeWord = matchesWakeWord(transcript, this.allWakeNames);
    const inReadyGrace = this.isInReadyGraceWindow();

    if (this.gated && !inReadyGrace && !hasWakeWord) {
      this.events.push({ type: 'rejected', transcript, reason: 'gated-no-wake' });
      this.transition({ type: 'RETURN_TO_IDLE' });
      return;
    }

    const cmd = this.parseAddressedCommand(transcript);
    if (cmd) {
      const resolved = this.resolveDoneCommandForContext(cmd, transcript);
      this.events.push({ type: 'recognized', intent: resolved.type });
      this.transition({ type: 'RETURN_TO_IDLE' });
      if (resolved.type !== 'wake-check') {
        this.events.push({ type: 'earcon', name: 'acknowledged' });
      }
      this.playReadyCue();
      return;
    }

    this.events.push({ type: 'recognized', intent: 'prompt' });
    this.transition({ type: 'PROCESSING_STARTED' });
    this.transition({ type: 'PROCESSING_COMPLETE' });
    this.events.push({ type: 'earcon', name: 'acknowledged' });
    this.events.push({ type: 'speak', text: 'Simulated assistant response.' });
    this.playReadyCue();
  }

  private handleQueueChoice(transcript: string): void {
    const parsed = matchQueueChoice(transcript);
    if (parsed === 'queue' || parsed === 'wait' || parsed === 'silent' || parsed === 'cancel') {
      this.events.push({ type: 'recognized', intent: parsed });
      this.transition({ type: 'RETURN_TO_IDLE' });
      this.events.push({ type: 'earcon', name: 'acknowledged' });
      this.playReadyCue();
      return;
    }

    const cmd = this.parseAddressedCommand(transcript);
    if (cmd && (cmd.type === 'switch' || cmd.type === 'list' || cmd.type === 'default')) {
      this.events.push({ type: 'recognized', intent: cmd.type });
      this.transition({ type: 'RETURN_TO_IDLE' });
      this.events.push({ type: 'earcon', name: 'acknowledged' });
      this.playReadyCue();
      return;
    }

    this.events.push({ type: 'unrecognized', transcript });
    this.applyEffects(this.transition({ type: 'AWAITING_INPUT_RECEIVED', recognized: false }));
    this.events.push({ type: 'ready' });
  }

  private handleSwitchChoice(transcript: string): void {
    const choice = matchSwitchChoice(transcript);
    if (!choice) {
      const cmd = this.parseAddressedCommand(transcript);
      if (
        cmd &&
        (
          cmd.type === 'switch' ||
          cmd.type === 'list' ||
          cmd.type === 'default' ||
          cmd.type === 'inbox-check'
        )
      ) {
        this.events.push({ type: 'recognized', intent: cmd.type });
        this.transition({ type: 'RETURN_TO_IDLE' });
        this.events.push({ type: 'earcon', name: 'acknowledged' });
        this.playReadyCue();
        return;
      }

      this.events.push({ type: 'unrecognized', transcript });
      this.applyEffects(this.transition({ type: 'AWAITING_INPUT_RECEIVED', recognized: false }));
      this.events.push({ type: 'ready' });
      return;
    }

    this.events.push({ type: 'recognized', intent: choice });
    const switchState = this.sm.getSwitchChoiceState();
    this.transition({ type: 'RETURN_TO_IDLE' });
    this.events.push({ type: 'earcon', name: 'acknowledged' });
    if (choice === 'read' && switchState?.lastMessage) {
      this.events.push({ type: 'speak', text: switchState.lastMessage });
    }
    this.playReadyCue();
  }

  private handleChannelSelection(transcript: string): void {
    const sel = this.sm.getChannelSelectionState();
    if (!sel) return;

    const matched = matchChannelSelection(transcript, sel.options);
    if (!matched) {
      this.events.push({ type: 'unrecognized', transcript });
      this.applyEffects(this.transition({ type: 'AWAITING_INPUT_RECEIVED', recognized: false }));
      this.events.push({ type: 'ready' });
      return;
    }

    this.events.push({ type: 'recognized', intent: `channel:${matched.name}` });
    this.transition({ type: 'RETURN_TO_IDLE' });
    this.events.push({ type: 'earcon', name: 'acknowledged' });
    this.playReadyCue();
  }

  private transition(event: PipelineEvent): TransitionEffect[] {
    const effects = this.sm.transition(event);
    this.applyEffects(effects);
    this.recordState();
    return effects;
  }

  private applyEffects(effects: TransitionEffect[]): void {
    for (const effect of effects) {
      if (effect.type === 'earcon') {
        this.events.push({ type: 'earcon', name: effect.name });
      } else if (effect.type === 'speak') {
        this.events.push({ type: 'speak', text: effect.text });
      }
    }
  }

  private recordState(): void {
    this.events.push({ type: 'state', state: this.sm.getStateType() });
  }

  private resolveDoneCommandForContext(cmd: VoiceCommand, transcript: string): VoiceCommand {
    if (cmd.type !== 'inbox-next') return cmd;
    if (this.sm.getInboxFlowState()) return cmd;

    const input = transcript.trim().toLowerCase().replace(/[.!?,]+$/, '');
    const wakePrefix = this.systemWakeNames.map(escapeRegex).join('|');
    const donePattern = new RegExp(
      `^(?:(?:hey|hello),?\\s+)?(?:${wakePrefix})[,.]?\\s*(?:done|(?:i'?m|i\\s+am)\\s+done)$|^(?:done|(?:i'?m|i\\s+am)\\s+done)$`,
      'i',
    );
    if (donePattern.test(input)) {
      return { type: 'default' } as const;
    }
    return cmd;
  }

  private parseAddressedCommand(transcript: string): VoiceCommand | null {
    const resolvedAddress = this.voiceTargets.resolveExplicitAddress(transcript);
    if (resolvedAddress) {
      const command = parseVoiceCommand(transcript, resolvedAddress.agent.callSigns);
      if (!command) return null;
      if (resolvedAddress.kind === 'system' || command.type === 'wake-check') {
        return command;
      }
      return null;
    }
    return parseVoiceCommand(transcript, this.systemWakeNames);
  }
}

export type V2HarnessEvent =
  | { type: 'state'; state: V2PipelineStateType }
  | { type: 'earcon'; name: string }
  | { type: 'speak'; text: string }
  | { type: 'interrupt'; interrupt: InterruptEvent['type']; command?: InterruptSystemCommand }
  | { type: 'recognized'; intent: string; transcript?: string };

export class V2InteractionFlowHarness {
  private readonly sm: V2PipelineStateMachine;
  private readonly interruptLayer: InterruptLayer;
  private readonly events: V2HarnessEvent[] = [];

  constructor(systemWakeName = 'Tango') {
    this.sm = new V2PipelineStateMachine();
    this.interruptLayer = new InterruptLayer({
      wakeNames: [systemWakeName],
      allowBareCancel: true,
    });
    this.sm.setTimeoutHandler((effects) => {
      this.applyEffects(effects);
      this.recordState();
    });
    this.recordState();
  }

  destroy(): void {
    this.sm.destroy();
  }

  getState(): V2PipelineStateType {
    return this.sm.getStateType();
  }

  getEvents(): V2HarnessEvent[] {
    return [...this.events];
  }

  clearEvents(): void {
    this.events.length = 0;
  }

  wake(mode: 'quick' | 'indicate' = 'quick', timeoutMs?: number): void {
    this.events.push({ type: 'interrupt', interrupt: 'interrupt:wake' });
    this.transition({ type: 'INTERRUPT_WAKE', mode, timeoutMs });
  }

  sendInterruptTranscript(
    transcript: string,
    options: { listeningMode?: 'quick' | 'indicate'; timeoutMs?: number } = {},
  ): void {
    const interrupt = this.interruptLayer.processTranscript(transcript);
    if (!interrupt) return;

    if (interrupt.type === 'interrupt:wake') {
      this.events.push({ type: 'interrupt', interrupt: interrupt.type });
      this.transition({
        type: 'INTERRUPT_WAKE',
        mode: options.listeningMode ?? 'quick',
        timeoutMs: options.timeoutMs,
      });
      return;
    }

    if (interrupt.type === 'interrupt:cancel') {
      this.events.push({ type: 'interrupt', interrupt: interrupt.type });
      this.transition({ type: 'INTERRUPT_CANCEL' });
      return;
    }

    this.events.push({
      type: 'interrupt',
      interrupt: interrupt.type,
      command: interrupt.command,
    });
    this.events.push({
      type: 'recognized',
      intent: interrupt.command,
      transcript,
    });
    this.applySystemCommand(interrupt.command);
  }

  listen(transcript: string, options: { finalize?: boolean } = {}): void {
    const currentState = this.sm.getState();
    const defaultFinalize = currentState.type === 'LISTENING'
      && currentState.mode === 'quick';
    const finalize = options.finalize ?? defaultFinalize;

    if (this.sm.getStateType() === 'CLARIFYING') {
      this.events.push({ type: 'recognized', intent: 'clarification', transcript });
      this.transition({ type: 'CLARIFICATION_RECEIVED', transcript });
      return;
    }

    this.events.push({ type: 'recognized', intent: 'prompt', transcript });
    this.transition({ type: 'LISTENING_ACTIVITY', transcript });
    if (finalize) {
      this.transition({ type: 'LISTENING_FINALIZED', transcript });
    }
  }

  finalizeListening(transcript = 'prompt'): void {
    this.transition({ type: 'LISTENING_FINALIZED', transcript });
  }

  listeningTimedOut(): void {
    this.transition({ type: 'LISTENING_TIMED_OUT' });
  }

  requestClarification(question: string, timeoutMs = 15_000): void {
    this.transition({ type: 'DISPATCH_NEEDS_CLARIFICATION', question, timeoutMs });
  }

  clarifyingTimedOut(): void {
    this.transition({ type: 'CLARIFICATION_TIMED_OUT' });
  }

  resolveDispatchToFocus(taskId = 'focus-task'): void {
    this.transition({ type: 'DISPATCH_RESOLVED', disposition: 'focus', taskId });
  }

  resolveDispatchToBackground(taskId = 'background-task'): void {
    this.transition({ type: 'DISPATCH_RESOLVED', disposition: 'background', taskId });
  }

  markFocusResponseReady(taskId = 'focus-task', response = 'ready'): void {
    this.transition({ type: 'FOCUS_RESPONSE_READY', taskId, response });
  }

  markBackgroundTaskReady(taskId = 'background-task', response = 'ready'): void {
    this.transition({ type: 'BACKGROUND_TASK_READY', taskId, response });
  }

  acknowledgeBackgroundResponse(taskId?: string): void {
    this.transition({ type: 'BACKGROUND_RESPONSE_ACKNOWLEDGED', taskId });
  }

  switchToBackground(): void {
    this.transition({ type: 'INTERRUPT_SWITCH_TO_BACKGROUND' });
  }

  switchToFocus(taskId?: string): void {
    this.transition({ type: 'INTERRUPT_SWITCH_TO_FOCUS', taskId });
  }

  completeSpeaking(): void {
    this.transition({ type: 'SPEAKING_COMPLETE' });
  }

  reset(): void {
    this.transition({ type: 'RESET_TO_CLOSED' });
  }

  private applySystemCommand(command: InterruptSystemCommand): void {
    switch (command) {
      case 'check-inbox':
        return;
      case 'next-response':
        this.transition({ type: 'BACKGROUND_RESPONSE_ACKNOWLEDGED' });
        return;
      case 'switch-to-background':
        this.transition({ type: 'INTERRUPT_SWITCH_TO_BACKGROUND' });
        return;
      case 'switch-to-focus':
        this.transition({ type: 'INTERRUPT_SWITCH_TO_FOCUS' });
        return;
    }
  }

  private transition(event: V2PipelineEvent): void {
    const effects = this.sm.transition(event);
    this.applyEffects(effects);
    this.recordState();
  }

  private applyEffects(effects: TransitionEffect[]): void {
    for (const effect of effects) {
      if (effect.type === 'earcon') {
        this.events.push({ type: 'earcon', name: effect.name });
      } else if (effect.type === 'speak') {
        this.events.push({ type: 'speak', text: effect.text });
      }
    }
  }

  private recordState(): void {
    this.events.push({ type: 'state', state: this.sm.getStateType() });
  }
}

function dedupeWakeNames(primary: string[], fallback: string[] = []): string[] {
  const seen = new Set<string>();
  return [...primary, ...fallback]
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
