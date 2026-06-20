import {
  stripLeadingWakePhrase,
  VoiceTargetDirectory,
} from "./address-routing.js";
import {
  buildDefaultSessionKey,
  buildDiscordChannelSessionKey,
} from "./session-routing.js";
import type { VoiceTurnInput } from "./index.js";

interface MobileDispatchBody {
  transcript?: unknown;
  text?: unknown;
  dictation?: unknown;
  agentId?: unknown;
  sessionId?: unknown;
  channelId?: unknown;
  discordChannelId?: unknown;
  discordUserId?: unknown;
  utteranceId?: unknown;
  guildId?: unknown;
  voiceChannelId?: unknown;
  messageTimestamp?: unknown;
  messageTimestampSource?: unknown;
  routeByWake?: unknown;
}

export interface MobileVoiceDispatchRoute {
  rawTranscript: string;
  dispatchedTranscript: string;
  agentId: string;
  sessionId: string;
  channelId?: string;
  routedBy: "explicit-address" | "request-agent" | "default-agent";
  matchedCallSign?: string;
  strippedWakePhrase: boolean;
}

export interface MobileVoiceDispatchInput {
  turnInput: VoiceTurnInput;
  route: MobileVoiceDispatchRoute;
}

export interface MobileVoiceDispatchDefaults {
  sessionId?: string;
  agentId?: string;
}

class MobileVoiceDispatchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MobileVoiceDispatchValidationError";
  }
}

function trimString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (value == null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  throw new MobileVoiceDispatchValidationError("Invalid field 'routeByWake'.");
}

function resolveTranscript(body: MobileDispatchBody): string {
  const transcript =
    trimString(body.transcript) ??
    trimString(body.text) ??
    trimString(body.dictation);
  if (!transcript) {
    throw new MobileVoiceDispatchValidationError(
      "Missing required field 'transcript'.",
    );
  }
  return transcript;
}

export function parseMobileVoiceDispatchInput(
  payload: unknown,
  options: {
    defaults?: MobileVoiceDispatchDefaults;
    voiceTargets?: VoiceTargetDirectory;
  } = {},
): MobileVoiceDispatchInput {
  if (!payload || typeof payload !== "object") {
    throw new MobileVoiceDispatchValidationError(
      "Request body must be a JSON object.",
    );
  }

  const body = payload as MobileDispatchBody;
  const rawTranscript = resolveTranscript(body);
  const routeByWake = parseBoolean(body.routeByWake, true);
  const voiceTargets = options.voiceTargets ?? new VoiceTargetDirectory();
  const explicitAddress = routeByWake
    ? voiceTargets.resolveExplicitAddress(rawTranscript)
    : null;
  const bodyAgentId = trimString(body.agentId);
  const defaultAgentId = trimString(options.defaults?.agentId);
  const requestAgentId = bodyAgentId ?? defaultAgentId;
  const explicitAgentId =
    explicitAddress?.kind === "agent" ? explicitAddress.agent.id : null;
  const agentId = explicitAgentId ?? requestAgentId;

  if (!agentId) {
    throw new MobileVoiceDispatchValidationError(
      "Missing required field 'agentId' or explicit agent wake phrase.",
    );
  }

  const routedTranscript =
    explicitAddress?.kind === "agent"
      ? explicitAddress.transcript
      : rawTranscript;
  const dispatchedTranscript =
    explicitAddress?.kind === "agent"
      ? stripLeadingWakePhrase(routedTranscript, explicitAddress.agent.callSigns)
      : rawTranscript;
  const transcript = dispatchedTranscript || rawTranscript;
  const channelId =
    trimString(body.channelId) ?? trimString(body.discordChannelId);
  const sessionId =
    trimString(body.sessionId) ??
    (channelId
      ? buildDiscordChannelSessionKey(agentId, channelId)
      : undefined) ??
    trimString(options.defaults?.sessionId) ??
    buildDefaultSessionKey(agentId);
  const utteranceId = trimString(body.utteranceId);
  const guildId = trimString(body.guildId);
  const voiceChannelId = trimString(body.voiceChannelId);
  const discordUserId = trimString(body.discordUserId);
  const messageTimestamp = trimString(body.messageTimestamp);
  const messageTimestampSource = trimString(body.messageTimestampSource);

  if (
    messageTimestampSource &&
    !["discord-sent", "voice-captured", "voice-finalized", "db-write"].includes(
      messageTimestampSource,
    )
  ) {
    throw new MobileVoiceDispatchValidationError(
      "Invalid field 'messageTimestampSource'.",
    );
  }

  const turnInput: VoiceTurnInput = {
    sessionId,
    agentId,
    transcript,
    ...(utteranceId ? { utteranceId } : {}),
    ...(guildId ? { guildId } : {}),
    ...(voiceChannelId ? { voiceChannelId } : {}),
    ...(channelId ? { channelId } : {}),
    ...(discordUserId ? { discordUserId } : {}),
    ...(messageTimestamp ? { messageTimestamp } : {}),
    ...(messageTimestampSource
      ? {
          messageTimestampSource:
            messageTimestampSource as VoiceTurnInput["messageTimestampSource"],
        }
      : {}),
  };

  return {
    turnInput,
    route: {
      rawTranscript,
      dispatchedTranscript: transcript,
      agentId,
      sessionId,
      ...(channelId ? { channelId } : {}),
      ...(explicitAddress?.kind === "agent"
        ? { matchedCallSign: explicitAddress.matchedName }
        : {}),
      strippedWakePhrase: transcript !== rawTranscript,
      routedBy: explicitAgentId
        ? "explicit-address"
        : bodyAgentId
          ? "request-agent"
          : "default-agent",
    },
  };
}
