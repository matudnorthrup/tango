import {
  extractFromWakeWord,
  extractNamedWakeWord,
  matchesWakeWord,
  mentionsWakeName,
  parseSharedProjectSystemCommand,
  parseSharedSystemRoutingCommand,
  parseSharedTopicSystemCommand,
  type MatchedWakeWord,
} from '@tango/voice';
import { normalizeVoiceMode, type VoiceMode } from './queue-state.js';
import type { EndpointingMode } from './voice-settings.js';

export {
  extractFromWakeWord,
  extractNamedWakeWord,
  matchesWakeWord,
  mentionsWakeName,
  parseSharedProjectSystemCommand,
  parseSharedSystemRoutingCommand,
  parseSharedTopicSystemCommand,
  type MatchedWakeWord,
} from '@tango/voice';

export type VoiceCommand =
  | { type: 'switch'; channel: string }
  | { type: 'focus-agent'; agent: string }
  | { type: 'clear-focus' }
  | { type: 'current-agent' }
  | {
      type: 'open-topic';
      topicName: string;
      projectName: string | null;
      standalone: boolean;
    }
  | { type: 'move-topic-to-project'; topicName: string | null; projectName: string }
  | { type: 'detach-topic-from-project'; topicName: string | null }
  | { type: 'current-topic' }
  | { type: 'clear-topic' }
  | { type: 'open-project'; projectName: string }
  | { type: 'current-project' }
  | { type: 'clear-project' }
  | { type: 'list' }
  | { type: 'default' }
  | { type: 'noise'; level: string }
  | { type: 'delay'; value: number }
  | { type: 'delay-adjust'; direction: 'longer' | 'shorter' }
  | { type: 'indicate-timeout'; valueMs: number }
  | { type: 'settings' }
  | { type: 'new-post' } // Deprecated: use natural creation via route classifier
  | { type: 'mode'; mode: VoiceMode }
  | { type: 'inbox-check' }
  | { type: 'inbox-next' }
  | { type: 'inbox-clear' }
  | { type: 'read-last-message' }
  | { type: 'voice-status' }
  | { type: 'voice-channel' }
  | { type: 'gated-mode'; enabled: boolean }
  | { type: 'endpoint-mode'; mode: EndpointingMode }
  | { type: 'wake-check' }
  | { type: 'silent-wait' }
  | { type: 'hear-full-message' }
  | { type: 'inbox-respond' }
  | { type: 'inbox-summarize' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'replay' }
  | { type: 'earcon-tour' }
  | { type: 'what-channel' }
  | { type: 'whats-up' }
  | { type: 'read-ready'; agent?: string }
  | { type: 'inbox-topic-select'; query: string }
  | { type: 'inbox-read-all' };

export interface ChannelOption {
  index: number;
  name: string;
  displayName: string;
}

type WakeNamesInput = string | string[];

export function parseVoiceCommand(transcript: string, botName: WakeNamesInput): VoiceCommand | null {
  // Extract the effective transcript starting from the wake word
  const wakeMatch = extractNamedWakeWord(transcript, botName);
  if (!wakeMatch) return null;
  const effective = wakeMatch.transcript;
  const matchedWakeName = wakeMatch.matchedName;

  const trimmed = effective.trim();
  const trigger = new RegExp(`^(?:(?:hey|hello),?\\s+)?${escapeRegex(matchedWakeName)}[,.]?\\s*`, 'i');
  const match = trimmed.match(trigger);
  if (!match) return null;

  // Handle repeated wake-only utterances like:
  // "Hello Watson. Hello Watson."
  // "Hello Watson, Watson"
  const restRaw = trimmed.slice(match[0].length).trim();
  if (restRaw.length > 0) {
    const wakeOnlySegment = new RegExp(`^(?:(?:hey|hello),?\\s+)?${escapeRegex(matchedWakeName)}$`, 'i');
    const segments = restRaw
      .split(/[.!?]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (segments.length > 0 && segments.every((seg) => wakeOnlySegment.test(seg))) {
      return { type: 'wake-check' };
    }
  }

  const rest = trimmed
    .slice(match[0].length)
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/[.!?,]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\bin-?box\b/g, 'inbox')
    .replace(/\bin\s+box\b/g, 'inbox')
    .replace(/\b(?:wheat|weight|wade|weigh)\b/g, 'wait');
  if (!rest) {
    return { type: 'wake-check' };
  }

  const routingCommand = parseSharedSystemRoutingCommand(rest);
  if (routingCommand) {
    if (routingCommand.type === 'focus-agent') {
      return { type: 'focus-agent', agent: routingCommand.agentQuery };
    }
    return routingCommand;
  }

  const topicCommand = parseSharedTopicSystemCommand(restRaw);
  if (topicCommand) {
    if (topicCommand.type === 'open-topic') {
      return {
        type: 'open-topic',
        topicName: topicCommand.topicName,
        projectName: topicCommand.projectName,
        standalone: topicCommand.standalone,
      };
    }
    if (topicCommand.type === 'move-topic-to-project') {
      return {
        type: 'move-topic-to-project',
        topicName: topicCommand.topicName,
        projectName: topicCommand.projectName,
      };
    }
    if (topicCommand.type === 'detach-topic-from-project') {
      return {
        type: 'detach-topic-from-project',
        topicName: topicCommand.topicName,
      };
    }
    return topicCommand;
  }

  const projectCommand = parseSharedProjectSystemCommand(restRaw);
  if (projectCommand) {
    if (projectCommand.type === 'open-project') {
      return { type: 'open-project', projectName: projectCommand.projectName };
    }
    return projectCommand;
  }

  // Mode switch — must come before "switch to X" to avoid matching "switch to inbox mode" as a channel switch
  const modeMatch = rest.match(
    /^(?:(?:enable|activate|set)\s+)?(inbox|queue|background|wait|focus|ask)\s+mode$|^(?:switch\s+to)\s+(inbox|queue|background|wait|focus|ask)(?:\s+mode)?$/,
  );
  if (modeMatch) {
    const spoken = modeMatch[1] ?? modeMatch[2];
    const mode = normalizeVoiceMode(spoken);
    return { type: 'mode', mode };
  }

  // "switch to X", "go to X", "change to X", "move to X"
  // "which/scratch to X" — common Whisper mishearings of "switch to"
  // Exclude "inbox" — handled below as inbox-check
  const switchMatch = rest.match(/^(?:switch|which|scratch|go|change|move)\s+to\s+(.+)$/);
  if (switchMatch) {
    const target = switchMatch[1].trim();
    if (/^(?:inbox|the\s+inbox|my\s+inbox)$/.test(target)) {
      return { type: 'inbox-check' };
    }
    return { type: 'switch', channel: target };
  }

  // "change channels", "switch channels", "list channels", "show channels"
  // Voice UX: map these to inbox status rather than channel enumeration.
  if (/^(?:change|switch|list|show)\s+channels?$/.test(rest)) {
    return { type: 'inbox-check' };
  }

  // "go back", "go to default", "go home", "default", "go to default channel"
  if (/^(?:go\s+back|go\s+(?:to\s+)?default(?:\s+channel)?|go\s+home|default)$/.test(rest)) {
    return { type: 'default' };
  }

  // "set noise to high", "set noise level high", "noise low", "noise 800"
  const noiseMatch = rest.match(/^(?:set\s+)?noise(?:\s+level)?\s+(?:to\s+)?(.+)$/);
  if (noiseMatch) {
    return { type: 'noise', level: noiseMatch[1].trim() };
  }

  // "set delay to 3000", "delay 2000", "set delay 500 milliseconds"
  const delayMatch = rest.match(
    /^(?:set\s+)?delay\s+(?:to\s+)?(\d+)(?:\s*(?:ms|millisecond|milliseconds))?$/,
  );
  if (delayMatch) {
    return { type: 'delay', value: parseInt(delayMatch[1], 10) };
  }

  const indicateTimeoutMatch = rest.match(
    /^(?:set\s+)?(?:indicate|manual(?:\s+end)?|endpoint(?:ing)?)(?:\s+(?:capture|end(?:\s+of\s+speech)?))?\s+timeout(?:\s+to)?\s+(\d+)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m)$/,
  );
  if (indicateTimeoutMatch) {
    const amount = parseInt(indicateTimeoutMatch[1], 10);
    const unit = indicateTimeoutMatch[2];
    let multiplier = 1000;
    if (unit.startsWith('ms') || unit.startsWith('millisecond')) {
      multiplier = 1;
    } else if (unit.startsWith('m')) {
      multiplier = 60_000;
    }
    return { type: 'indicate-timeout', valueMs: amount * multiplier };
  }

  // "longer delay", "shorter delay", "delay longer", "delay shorter"
  const delayAdjustMatch = rest.match(/^(longer|shorter)\s+delay$|^delay\s+(longer|shorter)$/);
  if (delayAdjustMatch) {
    const direction = (delayAdjustMatch[1] || delayAdjustMatch[2]) as 'longer' | 'shorter';
    return { type: 'delay-adjust', direction };
  }

  // "voice settings", "settings", "what are my settings", "what are the settings"
  if (/^(?:voice\s+)?settings$|^what\s+are\s+(?:my|the)\s+settings$/.test(rest)) {
    return { type: 'settings' };
  }

  // "create/make/start a post/thread/topic" — kicks off guided multi-step flow
  if (/(?:make|create|start)\s+.*?(?:post|thread|topic|discussion)/.test(rest)) {
    return { type: 'new-post' };
  }

  // "what channel", "channel", "which channel", "current channel", "where am I"
  if (/^(?:(?:what|which|current)\s+)?channel$|^where\s+am\s+i$/.test(rest)) {
    return { type: 'what-channel' };
  }

  // "voice status", "status"
  if (/^(?:voice\s+)?status$/.test(rest)) {
    return { type: 'voice-status' };
  }

  // "voice channel", "what channel", "which channel", "current channel", "where am I"
  if (/^(?:(?:voice|what|which|current)\s+channel|where\s+am\s+i|what\s+channel\s+(?:am\s+i\s+(?:in|on)|is\s+this))$/.test(rest)) {
    return { type: 'voice-channel' };
  }

  // "gated mode", "gate on" → enable gated; "open mode", "gate off", "ungated mode" → disable
  if (/^(?:gated\s+mode|gate\s+on)$/.test(rest)) {
    return { type: 'gated-mode', enabled: true };
  }
  if (/^(?:open\s+mode|gate\s+off|ungated\s+mode)$/.test(rest)) {
    return { type: 'gated-mode', enabled: false };
  }

  // Endpointing mode controls:
  // - indicate/manual end mode
  // - silence/auto end mode
  if (
    /^(?:indicate|manual(?:\s+end)?)\s+mode$/.test(rest)
    || /^(?:set|switch\s+to)\s+(?:indicate|manual(?:\s+end)?)\s+mode$/.test(rest)
    || /^(?:set|switch\s+to|use|enable)\s+(?:endpoint(?:ing)?|end(?:\s+of\s+speech)?)(?:\s+(?:mode|style))?(?:\s+to)?\s+(?:indicate|manual(?:\s+end)?)(?:\s+mode)?$/.test(rest)
  ) {
    return { type: 'endpoint-mode', mode: 'indicate' };
  }
  if (
    /^(?:silence|auto(?:matic)?(?:\s+end)?)\s+mode$/.test(rest)
    || /^(?:set|switch\s+to)\s+(?:silence|auto(?:matic)?(?:\s+end)?)\s+mode$/.test(rest)
    || /^(?:set|switch\s+to|use|enable)\s+(?:endpoint(?:ing)?|end(?:\s+of\s+speech)?)(?:\s+(?:mode|style))?(?:\s+to)?\s+(?:silence|auto(?:matic)?(?:\s+end)?)(?:\s+mode)?$/.test(rest)
  ) {
    return { type: 'endpoint-mode', mode: 'silence' };
  }

  // "inbox list", "what do I have", "check inbox", "what's new", "inbox"
  if (/^(?:inbox(?:\s+(?:list|status|check))?|what\s+do\s+(?:i|you)\s+have(?:\s+for\s+me)?|check\s+(?:the\s+)?(?:queue|inbox)|what'?s\s+(?:waiting|ready|new)|queue\s+status)$/.test(rest)) {
    return { type: 'inbox-check' };
  }
  if (/\bback\s+to\s+inbox\b/.test(rest) || /\binbox\s+list\b/.test(rest)) {
    return { type: 'inbox-check' };
  }

  // "next", "next response", "next one", "next message", "next channel", "done", "I'm done", "move on"
  if (/^(?:next(?:\s+(?:response|one|message|channel))?|(?:i'?m\s+)?done|i\s+am\s+done|move\s+on)$/.test(rest)) {
    return { type: 'inbox-next' };
  }

  // "clear inbox", "clear the inbox", "mark inbox read", "clear all"
  if (/^(?:clear\s+(?:the\s+)?inbox|mark\s+(?:the\s+)?inbox\s+(?:as\s+)?read|mark\s+all\s+read|clear\s+all)$/.test(rest)) {
    return { type: 'inbox-clear' };
  }

  // "read last message", "read the/my last message", "last message", "my last message"
  if (/^(?:read\s+(?:(?:the|my)\s+)?last\s+message|(?:(?:the|my)\s+)?last\s+message)$/.test(rest)) {
    return { type: 'read-last-message' };
  }

  // "hear full message", "hear a full message", "here full message" (STT homophone),
  // "hear fullness" (STT misheard), "read full message", "full message"
  if (/^(?:hear|here|read|play)\s+(?:(?:the|a|an)\s+)?full(?:ness|\s+message)$|^full\s+message$/.test(rest)) {
    return { type: 'hear-full-message' };
  }

  // "respond", "reply", "respond to that", "reply here"
  if (/^(?:respond|reply|respond\s+here|reply\s+here|respond\s+to\s+(?:that|this|the\s+message)|reply\s+to\s+(?:that|this|the\s+message))$/.test(rest)) {
    return { type: 'inbox-respond' };
  }

  // "summarize", "summarize all", "give me a summary", "catch me up"
  if (/^(?:summari[sz]e(?:\s+(?:all|them|everything))?|summary|give\s+me\s+(?:a\s+)?summary|catch\s+me\s+up)$/.test(rest)) {
    return { type: 'inbox-summarize' };
  }

  // "silent", "wait quietly", "quiet wait" — only meaningful while a wait is in-flight
  if (/^(?:silent|silently|wait\s+quietly|quiet\s+wait)$/.test(rest)) {
    return { type: 'silent-wait' };
  }

  // "pause", "stop", "cancel", "be quiet", "skip", "skip this", etc.
  if (/^(?:pause|stop(?:\s+talking)?|cancel(?:\s+(?:it|that|this))?|never\s*mind|nevermind|forget\s*it|be\s+quiet|shut\s+up|shush|hush|quiet|silence|enough|skip(?:\s+(?:it|this(?:\s+(?:one|message|part))?|that))?)$/.test(rest)) {
    return { type: 'pause' };
  }

  // "resume", "continue", "carry on", "go on", "pick up", "unpause", "pick up where you left off"
  if (/^(?:resume|continue|carry\s+on|go\s+on|unpause|un-?pause|pick\s+up(?:\s+where\s+you\s+left\s+off)?)$/.test(rest)) {
    return { type: 'resume' };
  }

  // "replay", "re-read", "reread", "read that again", "say that again", "repeat", "repeat that", "what did you say", "come again"
  if (/^(?:replay|re-?read|read\s+that\s+again|say\s+that\s+again|repeat(?:\s+that)?|what\s+did\s+you\s+say|come\s+again)$/.test(rest)) {
    return { type: 'replay' };
  }

  // "what's up", "any updates", "anything new", "status update", "what do you have for me"
  if (/^(?:what'?s\s+up|any\s+updates?|anything\s+(?:new|going\s+on)|status\s+update|what(?:\s+do\s+you)?\s+have\s+for\s+me|what'?s\s+(?:going\s+on|happening|the\s+situation))$/.test(rest)) {
    return { type: 'whats-up' };
  }

  // "go ahead [agent]", "let's hear it [agent]", "what do you have [agent]"
  // Also bare: "read it", "play it", "tell me", "what did they say", etc.
  // Reads the next ready response from the queue (natural follow-up to nudge notification)
  // Patterns that support optional trailing agent name | patterns that don't
  const readReadyMatch = rest.match(
    /^(?:go\s+ahead|let'?s?\s+hear\s+it|let\s+me\s+hear\s+it|what\s+(?:do|does)\s+(?:they|he|she|it|you)\s+have)(?:\s+(.+?))?$|^(?:read\s+it|play\s+it|tell\s+me|what\s+did\s+(?:they|he|she|it|you)\s+say|what(?:'?d|\s+did)\s+(?:they|he|she|it|you)\s+have|what\s+(?:is|was)\s+(?:the|that)\s+(?:response|answer|message|reply))$/,
  );
  if (readReadyMatch) {
    return { type: 'read-ready', agent: readReadyMatch[1]?.trim() || undefined };
  }

  // Earcon/sound demo commands: "earcon tour", "voice tour", "sound check", etc.
  // Avoid treating generic phrases like "voice test" as the earcon tour command.
  if (/^(?:(?:earcon|earcons|sound|sounds|audio)\s+(?:tour|demo|test|check)|voice\s+(?:tour|demo)|test\s+(?:earcon|earcons|sounds?|audio)|ear\s+contour)$/.test(rest)) {
    return { type: 'earcon-tour' };
  }

  return null;
}

export function matchSwitchChoice(transcript: string): 'read' | 'prompt' | 'cancel' | null {
  const input = transcript.trim().toLowerCase().replace(/[.!?,]+$/, '');

  // Match "cancel" first — discard
  if (/^(?:cancel|nevermind|never\s*mind|forget\s*it|nothing)$/.test(input)) return 'cancel';
  if (/\b(?:cancel|nevermind|never\s*mind|forget\s*it)\b/.test(input)) return 'cancel';

  // Match "prompt" and variants
  if (/^(?:prompt|skip|no|nope|pass|just prompt|new prompt|skip it|new message)$/.test(input)) return 'prompt';
  if (/\b(?:prompt|frompt|prompts?|prompted|romped|ramped|skip|pass)\b/.test(input)) return 'prompt';
  if (/\bnew\s+(?:prompt|message)\b/.test(input)) return 'prompt';

  // Match "read" and variants (including common STT confusions)
  if (/^(?:read|read it|read that|yes|yeah|yep|sure|go ahead|read it back|read back|last message)$/.test(input)) return 'read';
  if (/\b(?:read|reed|red)\b/.test(input)) return 'read';
  if (/\blast\s+message\b/.test(input)) return 'read';
  if (/\b(?:yes|yeah|yep|sure)\b/.test(input)) return 'read';

  return null;
}

export function matchYesNo(transcript: string): 'yes' | 'no' | 'cancel' | null {
  const input = transcript.trim().toLowerCase().replace(/[.!?,]+$/, '');

  if (/^(?:cancel|nevermind|never\s*mind|forget\s*it|nothing)$/.test(input)) return 'cancel';
  if (/\b(?:cancel|nevermind|never\s*mind|forget\s*it)\b/.test(input)) return 'cancel';

  if (/^(?:yes|yeah|yep|sure|go ahead|do it|correct|affirmative|that's right|right)$/.test(input)) return 'yes';
  if (/\b(?:yes|yeah|yep|sure)\b/.test(input)) return 'yes';

  if (/^(?:no|nope|nah|not that|wrong)$/.test(input)) return 'no';
  if (/\b(?:no|nope|nah)\b/.test(input)) return 'no';

  return null;
}

export function matchQueueChoice(transcript: string): 'queue' | 'wait' | 'silent' | 'cancel' | null {
  const input = transcript.trim().toLowerCase().replace(/[.!?,]+$/, '');
  const hasQueue = /\b(?:send\s+to\s+inbox|inbox|in box|queue|cue|q)\b/.test(input);
  const hasWait = /\b(?:wait\s+here|wait|weight|wheat|wade|weigh|way)\b/.test(input);

  // Match "silent" / "silently" — queue but wait without tones
  if (/^(?:silent|silently|silence|quiet|quietly|shh)$/.test(input)) return 'silent';
  if (/\b(?:silent|silently|silence|quiet|quietly|shh)\b/.test(input)) return 'silent';

  // Match "inbox" and variants — the prompt asks "Inbox, or wait?"
  if (hasQueue && hasWait) return null;
  if (hasQueue) return 'queue';
  if (/^(?:send\s+to\s+inbox|inbox|in box|queue|cue|q|yes|yep|yeah)$/.test(input)) return 'queue';
  if (/\bsend\s+to\s+inbox\b/.test(input)) return 'queue';
  if (/\b(?:yes|yep|yeah)\b/.test(input)) return 'queue';

  // Match "wait" and common Whisper misrecognitions
  if (hasWait) return 'wait';
  if (/^(?:wait\s+here|wait|weight|wheat|wade|weigh|way|no|nope)$/.test(input)) return 'wait';
  if (/\bwait\s+here\b/.test(input)) return 'wait';
  if (/\b(?:no|nope)\b/.test(input)) return 'wait';

  // Match "cancel" — discard the utterance entirely
  if (/^(?:cancel|nevermind|never\s*mind|forget\s*it|discard|nothing|ignore|ignore\s+that)$/.test(input)) return 'cancel';
  if (/\b(?:cancel|nevermind|never\s*mind|forget\s*it|discard|nothing|ignore)\b/.test(input)) return 'cancel';

  return null;
}

export function matchChannelSelection(
  transcript: string,
  options: ChannelOption[],
): ChannelOption | null {
  const input = transcript.trim().toLowerCase();

  // Try numeric match: "1", "2", "number 3", etc.
  const numMatch = input.match(/^(?:number\s+)?(\d+)$/);
  if (numMatch) {
    const num = parseInt(numMatch[1], 10);
    return options.find((o) => o.index === num) ?? null;
  }

  // Try exact display name match
  const exact = options.find(
    (o) => o.displayName.toLowerCase() === input || o.name.toLowerCase() === input,
  );
  if (exact) return exact;

  // Try substring / fuzzy match (display name contains input or input contains display name)
  const fuzzy = options.find(
    (o) =>
      o.displayName.toLowerCase().includes(input) ||
      input.includes(o.displayName.toLowerCase()) ||
      o.name.toLowerCase().includes(input) ||
      input.includes(o.name.toLowerCase()),
  );
  return fuzzy ?? null;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
