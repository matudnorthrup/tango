import { describe, it, expect } from 'vitest';
import {
  extractFromWakeWord,
  extractNamedWakeWord,
  matchQueueChoice,
  matchSwitchChoice,
  matchYesNo,
  matchesWakeWord,
  mentionsWakeName,
  parseVoiceCommand,
} from '../src/services/voice-commands.js';

const BOT = 'Watson';

describe('parseVoiceCommand — new-post (guided flow trigger)', () => {
  it('parses "create a post"', () => {
    expect(parseVoiceCommand('Hey Watson, create a post', BOT)).toEqual({ type: 'new-post' });
  });

  it('parses "make a new post"', () => {
    expect(parseVoiceCommand('Hey Watson, make a new post', BOT)).toEqual({ type: 'new-post' });
  });

  it('parses "start a thread"', () => {
    expect(parseVoiceCommand('Hey Watson, start a thread', BOT)).toEqual({ type: 'new-post' });
  });

  it('parses "create a new forum topic"', () => {
    expect(parseVoiceCommand('Hey Watson, create a new forum topic', BOT)).toEqual({ type: 'new-post' });
  });

  it('parses "please create a new forum discussion"', () => {
    expect(parseVoiceCommand('Hey Watson, please create a new forum discussion', BOT)).toEqual({ type: 'new-post' });
  });

  it('parses "can you make a post"', () => {
    expect(parseVoiceCommand('Hey Watson, can you make a post', BOT)).toEqual({ type: 'new-post' });
  });

  it('parses "I want to create a post in general about stuff" (extras ignored)', () => {
    expect(parseVoiceCommand('Hey Watson, I want to create a post in general about stuff', BOT)).toEqual({ type: 'new-post' });
  });

  it('returns null without trigger phrase', () => {
    expect(parseVoiceCommand('create a post', BOT)).toBeNull();
  });

  it('returns null for unrelated commands', () => {
    expect(parseVoiceCommand('Hey Watson, tell me about forum posts', BOT)).toBeNull();
  });
});

describe('parseVoiceCommand — existing commands still work', () => {
  it('switch command', () => {
    const result = parseVoiceCommand('Hey Watson, switch to general', BOT);
    expect(result).toEqual({ type: 'switch', channel: 'general' });
  });

  it('route command', () => {
    const result = parseVoiceCommand('Tango route to malibu', [BOT, 'Tango']);
    expect(result).toEqual({ type: 'switch', channel: 'malibu' });
  });

  it('root command', () => {
    const result = parseVoiceCommand('Tango root to watson', [BOT, 'Tango']);
    expect(result).toEqual({ type: 'switch', channel: 'watson' });
  });

  it('rout command', () => {
    const result = parseVoiceCommand('Watson rout to sierra', BOT);
    expect(result).toEqual({ type: 'switch', channel: 'sierra' });
  });

  it('list command', () => {
    const result = parseVoiceCommand('Hey Watson, list channels', BOT);
    expect(result).toEqual({ type: 'inbox-check' });
  });

  it('default command', () => {
    const result = parseVoiceCommand('Hey Watson, go back', BOT);
    expect(result).toEqual({ type: 'default' });
  });

  it('settings command', () => {
    const result = parseVoiceCommand('Hey Watson, settings', BOT);
    expect(result).toEqual({ type: 'settings' });
  });

  it('noise command with "noise level" phrasing', () => {
    const result = parseVoiceCommand('Hey Watson, set noise level high', BOT);
    expect(result).toEqual({ type: 'noise', level: 'high' });
  });

  it('noise command with numeric "noise level to" phrasing', () => {
    const result = parseVoiceCommand('Hey Watson, set noise level to 800', BOT);
    expect(result).toEqual({ type: 'noise', level: '800' });
  });

  it('delay command with milliseconds suffix', () => {
    const result = parseVoiceCommand('Hey Watson, set delay 500 milliseconds', BOT);
    expect(result).toEqual({ type: 'delay', value: 500 });
  });

  it('delay command with ms suffix', () => {
    const result = parseVoiceCommand('Hey Watson, set delay to 750 ms', BOT);
    expect(result).toEqual({ type: 'delay', value: 750 });
  });

  it('parses "open topic" command', () => {
    const result = parseVoiceCommand('Hey Watson, open topic auth redesign', BOT);
    expect(result).toEqual({
      type: 'open-topic',
      topicName: 'auth redesign',
      projectName: null,
      standalone: true,
    });
  });

  it('parses "open standalone topic" command', () => {
    const result = parseVoiceCommand('Hey Watson, open standalone topic auth redesign', BOT);
    expect(result).toEqual({
      type: 'open-topic',
      topicName: 'auth redesign',
      projectName: null,
      standalone: true,
    });
  });

  it('parses "open topic in project" command', () => {
    const result = parseVoiceCommand('Hey Watson, open topic auth redesign in project tango', BOT);
    expect(result).toEqual({
      type: 'open-topic',
      topicName: 'auth redesign',
      projectName: 'tango',
      standalone: false,
    });
  });

  it('parses "move topic to project" command', () => {
    const result = parseVoiceCommand('Hey Watson, move topic auth redesign to project tango', BOT);
    expect(result).toEqual({
      type: 'move-topic-to-project',
      topicName: 'auth redesign',
      projectName: 'tango',
    });
  });

  it('parses "detach topic from project" command', () => {
    const result = parseVoiceCommand('Hey Watson, detach topic auth redesign from project', BOT);
    expect(result).toEqual({
      type: 'detach-topic-from-project',
      topicName: 'auth redesign',
    });
  });

  it('parses "make this topic standalone" command', () => {
    const result = parseVoiceCommand('Hey Watson, make this topic standalone', BOT);
    expect(result).toEqual({
      type: 'detach-topic-from-project',
      topicName: null,
    });
  });

  it('parses "current topic" command', () => {
    const result = parseVoiceCommand('Hey Watson, current topic', BOT);
    expect(result).toEqual({ type: 'current-topic' });
  });

  it('parses "clear topic" command', () => {
    const result = parseVoiceCommand('Hey Watson, clear topic', BOT);
    expect(result).toEqual({ type: 'clear-topic' });
  });

  it('parses "open project" command', () => {
    const result = parseVoiceCommand('Hey Watson, open project tango mvp', BOT);
    expect(result).toEqual({ type: 'open-project', projectName: 'tango mvp' });
  });

  it('parses "current project" command', () => {
    const result = parseVoiceCommand('Hey Watson, current project', BOT);
    expect(result).toEqual({ type: 'current-project' });
  });

  it('parses "clear project" command', () => {
    const result = parseVoiceCommand('Hey Watson, clear project', BOT);
    expect(result).toEqual({ type: 'clear-project' });
  });
});

describe('parseVoiceCommand — mode commands', () => {
  it('parses "inbox mode"', () => {
    const result = parseVoiceCommand('Hey Watson, inbox mode', BOT);
    expect(result).toEqual({ type: 'mode', mode: 'queue' });
  });

  it('parses "in box mode" STT split variant', () => {
    const result = parseVoiceCommand('Hello Watson, in box mode', BOT);
    expect(result).toEqual({ type: 'mode', mode: 'queue' });
  });

  it('parses "switch to inbox mode"', () => {
    const result = parseVoiceCommand('Hey Watson, switch to inbox mode', BOT);
    expect(result).toEqual({ type: 'mode', mode: 'queue' });
  });

  it('parses "queue mode" (legacy)', () => {
    const result = parseVoiceCommand('Hey Watson, queue mode', BOT);
    expect(result).toEqual({ type: 'mode', mode: 'queue' });
  });

  it('parses "background mode"', () => {
    const result = parseVoiceCommand('Hey Watson, background mode', BOT);
    expect(result).toEqual({ type: 'mode', mode: 'queue' });
  });

  it('parses "wait mode"', () => {
    const result = parseVoiceCommand('Hey Watson, wait mode', BOT);
    expect(result).toEqual({ type: 'mode', mode: 'wait' });
  });

  it('parses "focus mode"', () => {
    const result = parseVoiceCommand('Hey Watson, focus mode', BOT);
    expect(result).toEqual({ type: 'mode', mode: 'wait' });
  });

  it('parses "switch to wait mode"', () => {
    const result = parseVoiceCommand('Hey Watson, switch to wait mode', BOT);
    expect(result).toEqual({ type: 'mode', mode: 'wait' });
  });

  it('parses "switch to focus"', () => {
    const result = parseVoiceCommand('Hey Watson, switch to focus', BOT);
    expect(result).toEqual({ type: 'mode', mode: 'wait' });
  });

  it('parses "ask mode"', () => {
    const result = parseVoiceCommand('Hey Watson, ask mode', BOT);
    expect(result).toEqual({ type: 'mode', mode: 'queue' });
  });

  it('parses "switch to ask mode"', () => {
    const result = parseVoiceCommand('Hey Watson, switch to ask mode', BOT);
    expect(result).toEqual({ type: 'mode', mode: 'queue' });
  });
});

describe('parseVoiceCommand — inbox check', () => {
  it('parses "what do I have"', () => {
    const result = parseVoiceCommand('Hey Watson, what do I have', BOT);
    expect(result).toEqual({ type: 'inbox-check' });
  });

  it('parses "check queue"', () => {
    const result = parseVoiceCommand('Hey Watson, check queue', BOT);
    expect(result).toEqual({ type: 'inbox-check' });
  });

  it('parses "check the queue"', () => {
    const result = parseVoiceCommand('Hey Watson, check the queue', BOT);
    expect(result).toEqual({ type: 'inbox-check' });
  });

  it('parses "what\'s waiting"', () => {
    const result = parseVoiceCommand("Hey Watson, what's waiting", BOT);
    expect(result).toEqual({ type: 'inbox-check' });
  });

  it('parses "whats waiting" (no apostrophe)', () => {
    const result = parseVoiceCommand('Hey Watson, whats waiting', BOT);
    expect(result).toEqual({ type: 'inbox-check' });
  });

  it('parses "queue status"', () => {
    const result = parseVoiceCommand('Hey Watson, queue status', BOT);
    expect(result).toEqual({ type: 'inbox-check' });
  });

  it('parses "check inbox"', () => {
    const result = parseVoiceCommand('Hey Watson, check inbox', BOT);
    expect(result).toEqual({ type: 'inbox-check' });
  });

  it('parses "summarize"', () => {
    const result = parseVoiceCommand('Hey Watson, summarize', BOT);
    expect(result).toEqual({ type: 'inbox-summarize' });
  });

  it('parses "check the inbox"', () => {
    const result = parseVoiceCommand('Hey Watson, check the inbox', BOT);
    expect(result).toEqual({ type: 'inbox-check' });
  });

  it('parses "what\'s new"', () => {
    const result = parseVoiceCommand("Hey Watson, what's new", BOT);
    expect(result).toEqual({ type: 'inbox-check' });
  });

  it('parses "whats new" (no apostrophe)', () => {
    const result = parseVoiceCommand('Hey Watson, whats new', BOT);
    expect(result).toEqual({ type: 'inbox-check' });
  });

  it('parses "inbox"', () => {
    const result = parseVoiceCommand('Hey Watson, inbox', BOT);
    expect(result).toEqual({ type: 'inbox-check' });
  });

  it('parses "inbox list"', () => {
    const result = parseVoiceCommand('Hey Watson, inbox list', BOT);
    expect(result).toEqual({ type: 'inbox-check' });
  });

  it('parses "in-box list" STT hyphen variant', () => {
    const result = parseVoiceCommand('Hey Watson, in-box list', BOT);
    expect(result).toEqual({ type: 'inbox-check' });
  });

  it('parses "back to inbox, inbox list"', () => {
    const result = parseVoiceCommand('Hey Watson, back to inbox, inbox list', BOT);
    expect(result).toEqual({ type: 'inbox-check' });
  });
});

describe('parseVoiceCommand — inbox next', () => {
  it('parses "next"', () => {
    const result = parseVoiceCommand('Hey Watson, next', BOT);
    expect(result).toEqual({ type: 'inbox-next' });
  });

  it('parses "next response"', () => {
    const result = parseVoiceCommand('Hey Watson, next response', BOT);
    expect(result).toEqual({ type: 'inbox-next' });
  });

  it('parses "next one"', () => {
    const result = parseVoiceCommand('Hey Watson, next one', BOT);
    expect(result).toEqual({ type: 'inbox-next' });
  });

  it('parses "next message"', () => {
    const result = parseVoiceCommand('Hey Watson, next message', BOT);
    expect(result).toEqual({ type: 'inbox-next' });
  });

  it('parses "next channel"', () => {
    const result = parseVoiceCommand('Hey Watson, next channel', BOT);
    expect(result).toEqual({ type: 'inbox-next' });
  });

  it('parses "done"', () => {
    const result = parseVoiceCommand('Hey Watson, done', BOT);
    expect(result).toEqual({ type: 'inbox-next' });
  });

  it('parses "I\'m done"', () => {
    const result = parseVoiceCommand("Hey Watson, I'm done", BOT);
    expect(result).toEqual({ type: 'inbox-next' });
  });

  it('parses "im done" (no apostrophe)', () => {
    const result = parseVoiceCommand('Hey Watson, im done', BOT);
    expect(result).toEqual({ type: 'inbox-next' });
  });

  it('parses "I am done"', () => {
    const result = parseVoiceCommand('Hey Watson, I am done', BOT);
    expect(result).toEqual({ type: 'inbox-next' });
  });

  it('parses "move on"', () => {
    const result = parseVoiceCommand('Hey Watson, move on', BOT);
    expect(result).toEqual({ type: 'inbox-next' });
  });

  it('parses "skip"', () => {
    const result = parseVoiceCommand('Hey Watson, skip', BOT);
    expect(result).toEqual({ type: 'pause' });
  });

  it('parses "skip this"', () => {
    const result = parseVoiceCommand('Hey Watson, skip this', BOT);
    expect(result).toEqual({ type: 'pause' });
  });

  it('parses "skip this one"', () => {
    const result = parseVoiceCommand('Hey Watson, skip this one', BOT);
    expect(result).toEqual({ type: 'pause' });
  });

  it('parses "skip it"', () => {
    const result = parseVoiceCommand('Hey Watson, skip it', BOT);
    expect(result).toEqual({ type: 'pause' });
  });

  it('parses "cancel" as pause/interrupt command', () => {
    const result = parseVoiceCommand('Hey Watson, cancel', BOT);
    expect(result).toEqual({ type: 'pause' });
  });
});

describe('parseVoiceCommand — inbox clear', () => {
  it('parses "clear inbox"', () => {
    const result = parseVoiceCommand('Hey Watson, clear inbox', BOT);
    expect(result).toEqual({ type: 'inbox-clear' });
  });

  it('parses "clear the inbox"', () => {
    const result = parseVoiceCommand('Hey Watson, clear the inbox', BOT);
    expect(result).toEqual({ type: 'inbox-clear' });
  });

  it('parses "mark inbox read"', () => {
    const result = parseVoiceCommand('Hey Watson, mark inbox read', BOT);
    expect(result).toEqual({ type: 'inbox-clear' });
  });
});

describe('parseVoiceCommand — read last message', () => {
  it('parses "read the last message"', () => {
    const result = parseVoiceCommand('Hey Watson, read the last message', BOT);
    expect(result).toEqual({ type: 'read-last-message' });
  });

  it('parses "last message"', () => {
    const result = parseVoiceCommand('Hello Watson, last message', BOT);
    expect(result).toEqual({ type: 'read-last-message' });
  });

  it('parses "my last message"', () => {
    const result = parseVoiceCommand('Hello Watson, my last message', BOT);
    expect(result).toEqual({ type: 'read-last-message' });
  });
});

describe('parseVoiceCommand — hear full message', () => {
  it('parses "hear full message"', () => {
    const result = parseVoiceCommand('Hello Watson, hear full message', BOT);
    expect(result).toEqual({ type: 'hear-full-message' });
  });

  it('parses "read full message"', () => {
    const result = parseVoiceCommand('Hey Watson, read full message', BOT);
    expect(result).toEqual({ type: 'hear-full-message' });
  });

  it('parses "here full message" STT homophone', () => {
    const result = parseVoiceCommand('Hey Watson, here full message', BOT);
    expect(result).toEqual({ type: 'hear-full-message' });
  });

  it('parses "hear a full message"', () => {
    const result = parseVoiceCommand('Hey Watson, hear a full message', BOT);
    expect(result).toEqual({ type: 'hear-full-message' });
  });

  it('parses "full message"', () => {
    const result = parseVoiceCommand('Watson, full message', BOT);
    expect(result).toEqual({ type: 'hear-full-message' });
  });

  it('parses "Here, full message." with STT comma and period', () => {
    const result = parseVoiceCommand('Hello Watson, Here, full message.', BOT);
    expect(result).toEqual({ type: 'hear-full-message' });
  });

  it('parses "hear fullness" STT misheard variant', () => {
    const result = parseVoiceCommand('Watson, hear fullness', BOT);
    expect(result).toEqual({ type: 'hear-full-message' });
  });
});

describe('parseVoiceCommand — Hello Watson trigger', () => {
  it('parses "Hello Watson, inbox"', () => {
    const result = parseVoiceCommand('Hello Watson, inbox', BOT);
    expect(result).toEqual({ type: 'inbox-check' });
  });

  it('parses "Hello Watson, switch to health"', () => {
    const result = parseVoiceCommand('Hello Watson, switch to health', BOT);
    expect(result).toEqual({ type: 'switch', channel: 'health' });
  });

  it('parses "Hello Watson, scratch to health" STT variant', () => {
    const result = parseVoiceCommand('Hello Watson, scratch to health', BOT);
    expect(result).toEqual({ type: 'switch', channel: 'health' });
  });

  it('parses "Hello Watson, done"', () => {
    const result = parseVoiceCommand('Hello Watson, done', BOT);
    expect(result).toEqual({ type: 'inbox-next' });
  });

  it('parses "Hello Watson, skip"', () => {
    const result = parseVoiceCommand('Hello Watson, skip', BOT);
    expect(result).toEqual({ type: 'pause' });
  });
});

describe('parseVoiceCommand — wake check', () => {
  it('parses "Hello Watson" with no trailing command', () => {
    const result = parseVoiceCommand('Hello Watson', BOT);
    expect(result).toEqual({ type: 'wake-check' });
  });

  it('parses "Hey Watson," with no trailing command', () => {
    const result = parseVoiceCommand('Hey Watson,', BOT);
    expect(result).toEqual({ type: 'wake-check' });
  });

  it('parses "Watson." with no trailing command', () => {
    const result = parseVoiceCommand('Watson.', BOT);
    expect(result).toEqual({ type: 'wake-check' });
  });

  it('parses repeated wake-only phrase with punctuation', () => {
    const result = parseVoiceCommand('Hello Watson. Hello Watson.', BOT);
    expect(result).toEqual({ type: 'wake-check' });
  });

  it('parses repeated wake-only phrase with comma separator', () => {
    const result = parseVoiceCommand('Hello Watson, Watson', BOT);
    expect(result).toEqual({ type: 'wake-check' });
  });
});

describe('parseVoiceCommand — voice status', () => {
  it('parses "voice status"', () => {
    const result = parseVoiceCommand('Hey Watson, voice status', BOT);
    expect(result).toEqual({ type: 'voice-status' });
  });

  it('parses "status"', () => {
    const result = parseVoiceCommand('Hey Watson, status', BOT);
    expect(result).toEqual({ type: 'voice-status' });
  });

  it('parses "Hello Watson, voice status"', () => {
    const result = parseVoiceCommand('Hello Watson, voice status', BOT);
    expect(result).toEqual({ type: 'voice-status' });
  });
});

describe('parseVoiceCommand — silent wait', () => {
  it('parses "Hello Watson, silent"', () => {
    const result = parseVoiceCommand('Hello Watson, silent', BOT);
    expect(result).toEqual({ type: 'silent-wait' });
  });

  it('parses "Hey Watson, wait quietly"', () => {
    const result = parseVoiceCommand('Hey Watson, wait quietly', BOT);
    expect(result).toEqual({ type: 'silent-wait' });
  });
});

describe('matchQueueChoice', () => {
  it('returns "queue" for "inbox"', () => {
    expect(matchQueueChoice('inbox')).toBe('queue');
  });

  it('returns "queue" for "send to inbox"', () => {
    expect(matchQueueChoice('send to inbox')).toBe('queue');
  });

  it('returns "queue" for "in box"', () => {
    expect(matchQueueChoice('in box')).toBe('queue');
  });

  it('returns "queue" for "Inbox." (with punctuation)', () => {
    expect(matchQueueChoice('Inbox.')).toBe('queue');
  });

  it('returns "queue" for "yes"', () => {
    expect(matchQueueChoice('yes')).toBe('queue');
  });

  it('returns "queue" for "queue"', () => {
    expect(matchQueueChoice('queue')).toBe('queue');
  });

  it('returns "queue" for "cue" (Whisper misrecognition)', () => {
    expect(matchQueueChoice('cue')).toBe('queue');
  });

  it('returns "silent" for "silent"', () => {
    expect(matchQueueChoice('silent')).toBe('silent');
  });

  it('returns "silent" for "silently"', () => {
    expect(matchQueueChoice('silently')).toBe('silent');
  });

  it('returns "silent" for "quiet"', () => {
    expect(matchQueueChoice('quiet')).toBe('silent');
  });

  it('returns "silent" for "quietly"', () => {
    expect(matchQueueChoice('quietly')).toBe('silent');
  });

  it('returns "silent" for "shh"', () => {
    expect(matchQueueChoice('shh')).toBe('silent');
  });

  it('returns "wait" for "wait"', () => {
    expect(matchQueueChoice('wait')).toBe('wait');
  });

  it('returns "wait" for "wait here"', () => {
    expect(matchQueueChoice('wait here')).toBe('wait');
  });

  it('returns "wait" for "weight" (Whisper misrecognition)', () => {
    expect(matchQueueChoice('weight')).toBe('wait');
  });

  it('returns "wait" for "wheat" (Whisper misrecognition)', () => {
    expect(matchQueueChoice('wheat')).toBe('wait');
  });

  it('returns "wait" for phrase with "wheat"', () => {
    expect(matchQueueChoice('let us do wheat')).toBe('wait');
  });

  it('returns "wait" for "no"', () => {
    expect(matchQueueChoice('no')).toBe('wait');
  });

  it('matches "wait" as substring', () => {
    expect(matchQueueChoice("let's wait")).toBe('wait');
  });

  it('returns "cancel" for "cancel"', () => {
    expect(matchQueueChoice('cancel')).toBe('cancel');
  });

  it('returns "cancel" for "nevermind"', () => {
    expect(matchQueueChoice('nevermind')).toBe('cancel');
  });

  it('returns "cancel" for "never mind"', () => {
    expect(matchQueueChoice('never mind')).toBe('cancel');
  });

  it('returns "cancel" for "forget it"', () => {
    expect(matchQueueChoice('forget it')).toBe('cancel');
  });

  it('returns "cancel" for "nothing"', () => {
    expect(matchQueueChoice('nothing')).toBe('cancel');
  });

  it('returns "cancel" for "ignore that"', () => {
    expect(matchQueueChoice('ignore that')).toBe('cancel');
  });

  it('returns null for unrecognized input', () => {
    expect(matchQueueChoice('hello')).toBeNull();
  });

  it('returns null when both queue and wait words appear', () => {
    expect(matchQueueChoice('inbox or wait')).toBeNull();
  });

  it('handles leading/trailing whitespace', () => {
    expect(matchQueueChoice('  inbox  ')).toBe('queue');
    expect(matchQueueChoice('  wait  ')).toBe('wait');
  });

  it('is case-insensitive', () => {
    expect(matchQueueChoice('INBOX')).toBe('queue');
    expect(matchQueueChoice('Wait')).toBe('wait');
  });

  it('strips trailing punctuation', () => {
    expect(matchQueueChoice('inbox.')).toBe('queue');
    expect(matchQueueChoice('wait!')).toBe('wait');
  });
});

describe('matchSwitchChoice', () => {
  it('returns "read" for "read"', () => {
    expect(matchSwitchChoice('read')).toBe('read');
  });

  it('returns "read" for "last message"', () => {
    expect(matchSwitchChoice('last message')).toBe('read');
  });

  it('returns "read" for "read it"', () => {
    expect(matchSwitchChoice('read it')).toBe('read');
  });

  it('returns "read" for "yes"', () => {
    expect(matchSwitchChoice('yes')).toBe('read');
  });

  it('returns "read" for "yeah"', () => {
    expect(matchSwitchChoice('yeah')).toBe('read');
  });

  it('returns "read" for "go ahead"', () => {
    expect(matchSwitchChoice('go ahead')).toBe('read');
  });

  it('returns "read" for phrase with read token', () => {
    expect(matchSwitchChoice('could you read that')).toBe('read');
  });

  it('returns "read" for "reed" (Whisper misrecognition)', () => {
    expect(matchSwitchChoice('reed')).toBe('read');
  });

  it('returns "read" for "red" (Whisper misrecognition)', () => {
    expect(matchSwitchChoice('red')).toBe('read');
  });

  it('returns "read" for "read back"', () => {
    expect(matchSwitchChoice('read back')).toBe('read');
  });

  it('returns "prompt" for "prompt"', () => {
    expect(matchSwitchChoice('prompt')).toBe('prompt');
  });

  it('returns "prompt" for "new prompt"', () => {
    expect(matchSwitchChoice('new prompt')).toBe('prompt');
  });

  it('returns "prompt" for "new message"', () => {
    expect(matchSwitchChoice('new message')).toBe('prompt');
  });

  it('returns "prompt" for "skip"', () => {
    expect(matchSwitchChoice('skip')).toBe('prompt');
  });

  it('returns "prompt" for "no"', () => {
    expect(matchSwitchChoice('no')).toBe('prompt');
  });

  it('returns "prompt" for "nope"', () => {
    expect(matchSwitchChoice('nope')).toBe('prompt');
  });

  it('returns "prompt" for "just prompt"', () => {
    expect(matchSwitchChoice('just prompt')).toBe('prompt');
  });

  it('returns "prompt" for "skip it"', () => {
    expect(matchSwitchChoice('skip it')).toBe('prompt');
  });

  it('returns "prompt" for phrase with prompt token', () => {
    expect(matchSwitchChoice('lets do prompt')).toBe('prompt');
  });

  it('returns "prompt" for "romped" (Whisper misrecognition)', () => {
    expect(matchSwitchChoice('romped')).toBe('prompt');
  });

  it('returns "prompt" for "ramped" (Whisper misrecognition)', () => {
    expect(matchSwitchChoice('ramped')).toBe('prompt');
  });

  it('returns "cancel" for "cancel"', () => {
    expect(matchSwitchChoice('cancel')).toBe('cancel');
  });

  it('returns "cancel" for "nevermind"', () => {
    expect(matchSwitchChoice('nevermind')).toBe('cancel');
  });

  it('returns null for unrecognized input', () => {
    expect(matchSwitchChoice('hello')).toBeNull();
  });

  it('handles trailing punctuation', () => {
    expect(matchSwitchChoice('read.')).toBe('read');
    expect(matchSwitchChoice('prompt!')).toBe('prompt');
  });

  it('is case-insensitive', () => {
    expect(matchSwitchChoice('Read')).toBe('read');
    expect(matchSwitchChoice('PROMPT')).toBe('prompt');
  });

  it('handles whitespace', () => {
    expect(matchSwitchChoice('  read  ')).toBe('read');
    expect(matchSwitchChoice('  prompt  ')).toBe('prompt');
  });
});

describe('matchesWakeWord', () => {
  it('matches "Watson, what time is it"', () => {
    expect(matchesWakeWord('Watson, what time is it', BOT)).toBe(true);
  });

  it('matches "Hey Watson, do something"', () => {
    expect(matchesWakeWord('Hey Watson, do something', BOT)).toBe(true);
  });

  it('matches "Hello Watson, do something"', () => {
    expect(matchesWakeWord('Hello Watson, do something', BOT)).toBe(true);
  });

  it('matches case-insensitively: "watson help"', () => {
    expect(matchesWakeWord('watson help', BOT)).toBe(true);
  });

  it('matches "hey watson" with comma: "Hey Watson, status"', () => {
    expect(matchesWakeWord('Hey Watson, status', BOT)).toBe(true);
  });

  it('matches bare "Watson" with no trailing content', () => {
    expect(matchesWakeWord('Watson', BOT)).toBe(true);
  });

  it('does not match random speech', () => {
    expect(matchesWakeWord("what's on the agenda today", BOT)).toBe(false);
  });

  it('does not match "hey" alone', () => {
    expect(matchesWakeWord('hey', BOT)).toBe(false);
  });

  it('does not match partial bot name in middle of word', () => {
    expect(matchesWakeWord('Watsonia is a suburb', BOT)).toBe(false);
  });

  it('handles leading whitespace', () => {
    expect(matchesWakeWord('  Watson, hello', BOT)).toBe(true);
  });

  it('matches wake word after filler "And hello Watson"', () => {
    expect(matchesWakeWord('And hello Watson, voice status', BOT)).toBe(true);
  });

  it('matches wake word after filler "So hello Watson"', () => {
    expect(matchesWakeWord('So hello Watson, do something', BOT)).toBe(true);
  });

  it('matches wake word after clipped prefix "of Watson"', () => {
    expect(matchesWakeWord('of Watson continue from the last reply', BOT)).toBe(true);
  });

  it('matches wake word after sentence boundary', () => {
    expect(matchesWakeWord("I'm having bad luck. Hello Watson, voice status.", BOT)).toBe(true);
  });

  it('matches wake word after sentence boundary with filler', () => {
    expect(matchesWakeWord("Bad luck. And hello Watson, do something.", BOT)).toBe(true);
  });

  it('does not match Watson mentioned mid-sentence casually', () => {
    expect(matchesWakeWord('I was talking to Watson about it', BOT)).toBe(false);
  });
});

describe('mentionsWakeName', () => {
  it('matches the configured wake word even when it is not Watson', () => {
    expect(mentionsWakeName('or Tango inbox list', 'Tango')).toBe(true);
    expect(mentionsWakeName('or Tango Voice status', 'Tango Voice')).toBe(true);
  });

  it('does not trigger on unrelated or substring matches', () => {
    expect(mentionsWakeName('or Watson inbox list', 'Tango')).toBe(false);
    expect(mentionsWakeName('tangometer status', 'Tango')).toBe(false);
  });
});

describe('extractFromWakeWord', () => {
  it('returns full text when wake word is at start', () => {
    expect(extractFromWakeWord('Watson, voice status', BOT)).toBe('Watson, voice status');
  });

  it('returns full text for "Hello Watson, inbox"', () => {
    expect(extractFromWakeWord('Hello Watson, inbox', BOT)).toBe('Hello Watson, inbox');
  });

  it('strips filler "And" before wake word', () => {
    expect(extractFromWakeWord('And hello Watson, voice status', BOT)).toBe('hello Watson, voice status');
  });

  it('strips filler "So" before wake word', () => {
    expect(extractFromWakeWord('So Watson, do something', BOT)).toBe('Watson, do something');
  });

  it('strips filler "Oh" before wake word', () => {
    expect(extractFromWakeWord('Oh hello Watson, help me', BOT)).toBe('hello Watson, help me');
  });

  it('strips clipped prefix "of" before wake word', () => {
    expect(extractFromWakeWord('of Watson continue from the last reply', BOT)).toBe('Watson continue from the last reply');
  });

  it('extracts from sentence boundary', () => {
    const transcript = "I don't know why. Hello Watson, voice status.";
    expect(extractFromWakeWord(transcript, BOT)).toBe('Hello Watson, voice status.');
  });

  it('extracts from sentence boundary with preceding text', () => {
    const transcript = "I'm having bad luck. Hello Watson. Yes I am doing a demo.";
    expect(extractFromWakeWord(transcript, BOT)).toBe('Hello Watson. Yes I am doing a demo.');
  });

  it('extracts from sentence boundary with filler', () => {
    const transcript = "Not working. And hello Watson, voice status.";
    expect(extractFromWakeWord(transcript, BOT)).toBe('hello Watson, voice status.');
  });

  it('returns null for text without wake word', () => {
    expect(extractFromWakeWord("what's on the agenda today", BOT)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractFromWakeWord('', BOT)).toBeNull();
  });

  it('handles Whisper leading whitespace', () => {
    expect(extractFromWakeWord(' And hello Watson, voice status.\n', BOT)).toBe('hello Watson, voice status.');
  });

  it('does not extract Watson mentioned casually mid-sentence', () => {
    expect(extractFromWakeWord('I was talking to Watson about it', BOT)).toBeNull();
  });
});

describe('parseVoiceCommand — mid-transcript wake word', () => {
  it('parses command after filler: "And hello Watson, voice status"', () => {
    expect(parseVoiceCommand('And hello Watson, voice status', BOT)).toEqual({ type: 'voice-status' });
  });

  it('parses command after sentence boundary: "Bad luck. Hello Watson, inbox"', () => {
    expect(parseVoiceCommand("Bad luck. Hello Watson, inbox", BOT)).toEqual({ type: 'inbox-check' });
  });

  it('parses command after filler "So Watson, switch to general"', () => {
    expect(parseVoiceCommand('So Watson, switch to general', BOT)).toEqual({ type: 'switch', channel: 'general' });
  });

  it('parses wake-check after filler "And hello Watson"', () => {
    expect(parseVoiceCommand('And hello Watson', BOT)).toEqual({ type: 'wake-check' });
  });

  it('parses prompt after clipped prefix "of Watson"', () => {
    expect(parseVoiceCommand('of Watson, current topic', BOT)).toEqual({ type: 'current-topic' });
  });

  it('still returns null for text without wake word', () => {
    expect(parseVoiceCommand('do something please', BOT)).toBeNull();
  });
});

describe('parseVoiceCommand — pause', () => {
  const cases = [
    'pause', 'stop', 'stop talking', 'be quiet', 'shut up',
    'shush', 'hush', 'quiet', 'silence', 'enough',
  ];

  for (const phrase of cases) {
    it(`parses "${phrase}"`, () => {
      expect(parseVoiceCommand(`Hey Watson, ${phrase}`, BOT)).toEqual({ type: 'pause' });
    });
  }

  it('parses with "Hello Watson" trigger', () => {
    expect(parseVoiceCommand('Hello Watson, pause', BOT)).toEqual({ type: 'pause' });
  });

  it('parses with trailing punctuation', () => {
    expect(parseVoiceCommand('Hey Watson, stop!', BOT)).toEqual({ type: 'pause' });
  });

  it('returns null for "stop the music" (not an exact match)', () => {
    expect(parseVoiceCommand('Hey Watson, stop the music', BOT)).toBeNull();
  });

  it('returns null without wake word', () => {
    expect(parseVoiceCommand('pause', BOT)).toBeNull();
  });
});

describe('parseVoiceCommand — replay', () => {
  const cases = [
    'replay', 're-read', 'reread', 'read that again', 'say that again',
    'repeat', 'repeat that', 'what did you say', 'come again',
  ];

  for (const phrase of cases) {
    it(`parses "${phrase}"`, () => {
      expect(parseVoiceCommand(`Hey Watson, ${phrase}`, BOT)).toEqual({ type: 'replay' });
    });
  }

  it('parses with "Hello Watson" trigger', () => {
    expect(parseVoiceCommand('Hello Watson, replay', BOT)).toEqual({ type: 'replay' });
  });

  it('parses with trailing punctuation', () => {
    expect(parseVoiceCommand('Hey Watson, repeat that.', BOT)).toEqual({ type: 'replay' });
  });

  it('returns null without wake word', () => {
    expect(parseVoiceCommand('replay', BOT)).toBeNull();
  });
});

describe('parseVoiceCommand — gated-mode', () => {
  it('parses "gated mode"', () => {
    expect(parseVoiceCommand('Hey Watson, gated mode', BOT)).toEqual({ type: 'gated-mode', enabled: true });
  });

  it('parses "gate on"', () => {
    expect(parseVoiceCommand('Watson, gate on', BOT)).toEqual({ type: 'gated-mode', enabled: true });
  });

  it('parses "open mode"', () => {
    expect(parseVoiceCommand('Hey Watson, open mode', BOT)).toEqual({ type: 'gated-mode', enabled: false });
  });

  it('parses "gate off"', () => {
    expect(parseVoiceCommand('Watson, gate off', BOT)).toEqual({ type: 'gated-mode', enabled: false });
  });

  it('parses "ungated mode"', () => {
    expect(parseVoiceCommand('Hello Watson, ungated mode', BOT)).toEqual({ type: 'gated-mode', enabled: false });
  });
});

describe('parseVoiceCommand — endpoint-mode', () => {
  it('parses "indicate mode"', () => {
    expect(parseVoiceCommand('Hey Watson, indicate mode', BOT)).toEqual({ type: 'endpoint-mode', mode: 'indicate' });
  });

  it('parses "manual end mode"', () => {
    expect(parseVoiceCommand('Watson, manual end mode', BOT)).toEqual({ type: 'endpoint-mode', mode: 'indicate' });
  });

  it('parses "set endpointing to silence"', () => {
    expect(parseVoiceCommand('Hello Watson, set endpointing to silence', BOT)).toEqual({ type: 'endpoint-mode', mode: 'silence' });
  });

  it('parses "automatic end mode"', () => {
    expect(parseVoiceCommand('Hey Watson, automatic end mode', BOT)).toEqual({ type: 'endpoint-mode', mode: 'silence' });
  });

  it('parses indicate timeout in minutes', () => {
    expect(parseVoiceCommand('Hey Watson, set indicate timeout to 15 minutes', BOT)).toEqual({
      type: 'indicate-timeout',
      valueMs: 900000,
    });
  });

  it('parses endpoint timeout in seconds', () => {
    expect(parseVoiceCommand('Watson, endpoint timeout 90 seconds', BOT)).toEqual({
      type: 'indicate-timeout',
      valueMs: 90000,
    });
  });
});

describe('parseVoiceCommand — earcon tour', () => {
  it('parses "earcon tour"', () => {
    expect(parseVoiceCommand('Hey Watson, earcon tour', BOT)).toEqual({ type: 'earcon-tour' });
  });

  it('parses "voice tour"', () => {
    expect(parseVoiceCommand('Hey Watson, voice tour', BOT)).toEqual({ type: 'earcon-tour' });
  });

  it('parses "sound demo"', () => {
    expect(parseVoiceCommand('Watson, sound demo', BOT)).toEqual({ type: 'earcon-tour' });
  });

  it('parses "audio check"', () => {
    expect(parseVoiceCommand('Watson, audio check', BOT)).toEqual({ type: 'earcon-tour' });
  });

  it('parses "test earcons"', () => {
    expect(parseVoiceCommand('Hello Watson, test earcons', BOT)).toEqual({ type: 'earcon-tour' });
  });

  it('parses common misrecognition "ear contour"', () => {
    expect(parseVoiceCommand('Hello Watson, ear contour', BOT)).toEqual({ type: 'earcon-tour' });
  });

  it('returns null without wake word', () => {
    expect(parseVoiceCommand('earcon tour', BOT)).toBeNull();
  });

  it('does not treat "voice test" as earcon tour', () => {
    expect(parseVoiceCommand('Watson, voice test', BOT)).toBeNull();
  });
});

describe('parseVoiceCommand — agent focus controls', () => {
  const SYSTEM = 'Tango';

  it('parses focus-agent command', () => {
    expect(parseVoiceCommand('Tango, talk to Watson', SYSTEM)).toEqual({
      type: 'focus-agent',
      agent: 'watson',
    });
  });

  it('parses clear-focus command', () => {
    expect(parseVoiceCommand('Tango, back to system', SYSTEM)).toEqual({
      type: 'clear-focus',
    });
  });

  it('parses current-agent command', () => {
    expect(parseVoiceCommand('Tango, who am I talking to', SYSTEM)).toEqual({
      type: 'current-agent',
    });
  });
});

describe('matchYesNo', () => {
  // Yes variants
  it('returns "yes" for "yes"', () => {
    expect(matchYesNo('yes')).toBe('yes');
  });

  it('returns "yes" for "yeah"', () => {
    expect(matchYesNo('yeah')).toBe('yes');
  });

  it('returns "yes" for "yep"', () => {
    expect(matchYesNo('yep')).toBe('yes');
  });

  it('returns "yes" for "sure"', () => {
    expect(matchYesNo('sure')).toBe('yes');
  });

  it('returns "yes" for "go ahead"', () => {
    expect(matchYesNo('go ahead')).toBe('yes');
  });

  it('returns "yes" for "do it"', () => {
    expect(matchYesNo('do it')).toBe('yes');
  });

  it('returns "yes" for "correct"', () => {
    expect(matchYesNo('correct')).toBe('yes');
  });

  it('returns "yes" for "affirmative"', () => {
    expect(matchYesNo('affirmative')).toBe('yes');
  });

  it('returns "yes" for "that\'s right"', () => {
    expect(matchYesNo("that's right")).toBe('yes');
  });

  it('returns "yes" for "right"', () => {
    expect(matchYesNo('right')).toBe('yes');
  });

  it('returns "yes" for "Yes." with punctuation', () => {
    expect(matchYesNo('Yes.')).toBe('yes');
  });

  it('returns "yes" for "Yeah!" with punctuation', () => {
    expect(matchYesNo('Yeah!')).toBe('yes');
  });

  it('returns "yes" when yes appears in a phrase', () => {
    expect(matchYesNo('oh yes please')).toBe('yes');
  });

  // No variants
  it('returns "no" for "no"', () => {
    expect(matchYesNo('no')).toBe('no');
  });

  it('returns "no" for "nope"', () => {
    expect(matchYesNo('nope')).toBe('no');
  });

  it('returns "no" for "nah"', () => {
    expect(matchYesNo('nah')).toBe('no');
  });

  it('returns "no" for "not that"', () => {
    expect(matchYesNo('not that')).toBe('no');
  });

  it('returns "no" for "wrong"', () => {
    expect(matchYesNo('wrong')).toBe('no');
  });

  it('returns "no" for "No." with punctuation', () => {
    expect(matchYesNo('No.')).toBe('no');
  });

  it('returns "no" when no appears in a phrase', () => {
    expect(matchYesNo('no not there')).toBe('no');
  });

  // Cancel variants
  it('returns "cancel" for "cancel"', () => {
    expect(matchYesNo('cancel')).toBe('cancel');
  });

  it('returns "cancel" for "nevermind"', () => {
    expect(matchYesNo('nevermind')).toBe('cancel');
  });

  it('returns "cancel" for "never mind"', () => {
    expect(matchYesNo('never mind')).toBe('cancel');
  });

  it('returns "cancel" for "forget it"', () => {
    expect(matchYesNo('forget it')).toBe('cancel');
  });

  it('returns "cancel" for "nothing"', () => {
    expect(matchYesNo('nothing')).toBe('cancel');
  });

  it('returns "cancel" for "Cancel!" with punctuation', () => {
    expect(matchYesNo('Cancel!')).toBe('cancel');
  });

  // Cancel takes priority over yes/no
  it('returns "cancel" when cancel phrase appears even with yes/no', () => {
    expect(matchYesNo('nevermind yes')).toBe('cancel');
  });

  // Null cases
  it('returns null for unrecognized input', () => {
    expect(matchYesNo('hello')).toBeNull();
  });

  it('returns null for ambiguous input', () => {
    expect(matchYesNo('maybe')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(matchYesNo('')).toBeNull();
  });

  // Whitespace and case
  it('is case-insensitive', () => {
    expect(matchYesNo('YES')).toBe('yes');
    expect(matchYesNo('NO')).toBe('no');
    expect(matchYesNo('CANCEL')).toBe('cancel');
  });

  it('handles leading/trailing whitespace', () => {
    expect(matchYesNo('  yes  ')).toBe('yes');
    expect(matchYesNo('  no  ')).toBe('no');
  });
});

describe('wake-word helpers — multi-agent address matching', () => {
  it('matches any configured wake word at the start of the transcript', () => {
    expect(matchesWakeWord('Watson, add that to my list', ['Tango', 'Watson'])).toBe(true);
    expect(matchesWakeWord('Tango, talk to Watson', ['Tango', 'Watson'])).toBe(true);
  });

  it('extracts the matched wake word and normalized transcript', () => {
    expect(extractNamedWakeWord('Hello Watson, add that to my list', ['Tango', 'Watson'])).toEqual({
      matchedName: 'Watson',
      transcript: 'Hello Watson, add that to my list',
    });
  });

  it('extracts from the first valid wake word even after sentence junk', () => {
    expect(extractFromWakeWord('Bad luck. Hello Tango, settings', ['Tango', 'Watson'])).toBe(
      'Hello Tango, settings',
    );
  });
});
