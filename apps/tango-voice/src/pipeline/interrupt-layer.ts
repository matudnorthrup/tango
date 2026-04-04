import { EventEmitter } from 'node:events';
import {
  extractNamedWakeWord,
  matchesWakeWord,
  parseVoiceCommand,
  type VoiceCommand,
} from '../services/voice-commands.js';

export type InterruptSystemCommand =
  | 'check-inbox'
  | 'next-response'
  | 'switch-to-background'
  | 'switch-to-focus';

export type InterruptEvent =
  | { type: 'interrupt:wake'; transcript: string }
  | { type: 'interrupt:cancel'; transcript: string }
  | {
      type: 'interrupt:system-command';
      transcript: string;
      command: InterruptSystemCommand;
      sourceCommand?: VoiceCommand;
    };

export interface InterruptLayerOptions {
  wakeNames?: string[] | (() => string[]);
  allowBareCancel?: boolean;
}

export class InterruptLayer extends EventEmitter {
  private readonly wakeNames: string[] | (() => string[]);
  private readonly allowBareCancel: boolean;

  constructor(options: InterruptLayerOptions = {}) {
    super();
    this.wakeNames = options.wakeNames ?? ['Tango'];
    this.allowBareCancel = options.allowBareCancel ?? false;
  }

  processTranscript(transcript: string): InterruptEvent | null {
    const interrupt = this.classifyTranscript(transcript);
    if (!interrupt) return null;
    this.emit(interrupt.type, interrupt);
    return interrupt;
  }

  classifyTranscript(transcript: string): InterruptEvent | null {
    const wakeNames = this.getWakeNames();
    const parsed = parseVoiceCommand(transcript, wakeNames);
    const normalized = transcript.trim();
    const wakeRemainder = this.getWakeRemainder(normalized, wakeNames);
    const reduced = normalizeInterruptText(wakeRemainder ?? normalized);

    if (parsed?.type === 'pause') {
      return { type: 'interrupt:cancel', transcript };
    }

    const mapped = mapSystemCommand(parsed);
    if (mapped) {
      return {
        type: 'interrupt:system-command',
        transcript,
        command: mapped,
        sourceCommand: parsed ?? undefined,
      };
    }

    if (wakeRemainder) {
      if (BACKGROUND_SWITCH_PATTERN.test(reduced)) {
        return {
          type: 'interrupt:system-command',
          transcript,
          command: 'switch-to-background',
        };
      }
      if (FOCUS_SWITCH_PATTERN.test(reduced)) {
        return {
          type: 'interrupt:system-command',
          transcript,
          command: 'switch-to-focus',
        };
      }
      if (CANCEL_PATTERN.test(reduced)) {
        return { type: 'interrupt:cancel', transcript };
      }
    }

    if (this.allowBareCancel && CANCEL_PATTERN.test(reduced)) {
      return { type: 'interrupt:cancel', transcript };
    }

    if ((parsed && parsed.type === 'wake-check') || matchesWakeWord(transcript, wakeNames)) {
      return { type: 'interrupt:wake', transcript };
    }

    return null;
  }

  private getWakeNames(): string[] {
    if (typeof this.wakeNames === 'function') {
      return this.wakeNames();
    }
    return this.wakeNames;
  }

  private getWakeRemainder(transcript: string, wakeNames: string[]): string | null {
    const wakeMatch = extractNamedWakeWord(transcript, wakeNames);
    if (!wakeMatch) return null;

    const trimmed = wakeMatch.transcript.trim();
    const trigger = new RegExp(
      `^(?:(?:hey|hello),?\\s+)?${escapeRegex(wakeMatch.matchedName)}[,.]?\\s*`,
      'i',
    );
    return trimmed.replace(trigger, '').trim();
  }
}

const BACKGROUND_SWITCH_PATTERN =
  /^(?:put|send|move)(?:\s+(?:it|that|this))?(?:\s+(?:in|into|to))?\s+(?:the\s+)?background$|^(?:switch|go|move)\s+to\s+(?:the\s+)?background$|^background(?:\s+mode)?$/i;

const FOCUS_SWITCH_PATTERN =
  /^(?:switch|go|move)\s+to\s+focus$|^(?:bring|move)(?:\s+(?:it|that|this))?(?:\s+back)?\s+to\s+focus$|^focus(?:\s+mode)?$|^wait\s+here$/i;

const CANCEL_PATTERN =
  /^(?:cancel(?:\s+(?:it|that|this))?|stop(?:\s+talking)?|never\s*mind|nevermind|forget\s*it|be\s+quiet|silence|quiet)$/i;

function mapSystemCommand(command: VoiceCommand | null): InterruptSystemCommand | null {
  if (!command) return null;
  if (command.type === 'inbox-check') return 'check-inbox';
  if (command.type === 'inbox-next' || command.type === 'read-ready') return 'next-response';
  return null;
}

function normalizeInterruptText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[.!?,]+/g, '')
    .replace(/\s+/g, ' ');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
