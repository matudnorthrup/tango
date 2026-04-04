import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";

export * from "./address-routing.js";
export * from "./agent-address-book.js";
export * from "./natural-routing.js";
export * from "./project-directory.js";
export * from "./project-routing.js";
export * from "./scenario-runner.js";
export * from "./system-routing.js";
export * from "./topic-context.js";

export interface VoiceTurnInput {
  sessionId: string;
  agentId: string;
  transcript: string;
  utteranceId?: string;
  guildId?: string;
  voiceChannelId?: string;
  channelId?: string;
  discordUserId?: string;
}

export interface VoiceTurnResult {
  turnId?: string;
  deduplicated?: boolean;
  responseText: string;
  providerName: string;
  providerSessionId?: string;
  warmStartUsed?: boolean;
  providerUsedFailover?: boolean;
}

export interface VoiceCompletionMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface VoiceCompletionInput {
  messages: VoiceCompletionMessage[];
  systemPrompt?: string;
  maxTokens?: number;
  sessionId?: string;
  agentId?: string;
  model?: string;
}

export interface VoiceCompletionResult {
  text: string;
  providerName?: string;
}

export interface VoiceTurnExecutor {
  executeTurn(input: VoiceTurnInput): Promise<VoiceTurnResult>;
}

export type VoiceCompletionHandler = (
  input: VoiceCompletionInput
) => Promise<VoiceCompletionResult>;

export interface VoiceBridge {
  start(): Promise<void>;
  stop(): Promise<void>;
  onTranscript(input: VoiceTurnInput): Promise<VoiceTurnResult>;
}

export class StubVoiceBridge implements VoiceBridge {
  constructor(private readonly executor: VoiceTurnExecutor) {}

  async start(): Promise<void> {
    return;
  }

  async stop(): Promise<void> {
    return;
  }

  async onTranscript(input: VoiceTurnInput): Promise<VoiceTurnResult> {
    return this.executor.executeTurn(input);
  }
}

export interface VoiceInboxMessage {
  messageId: string;
  channelId: string;
  channelName: string;
  agentDisplayName: string;
  agentId: string | null;
  content: string;
  timestamp: number;
  isChunked: boolean;
  chunkGroupId: string | null;
}

export interface VoiceInboxChannel {
  channelId: string;
  channelName: string;
  displayName: string;
  unreadCount: number;
  messages: VoiceInboxMessage[];
}

export interface VoiceInboxResponse {
  ok: true;
  channels: VoiceInboxChannel[];
  totalUnread: number;
  pendingCount: number;
}

export interface VoiceInboxAgentGroup {
  agentId: string;
  agentDisplayName: string;
  totalUnread: number;
  channels: VoiceInboxChannel[];
}

export interface VoiceInboxAgentResponse {
  ok: true;
  agents: VoiceInboxAgentGroup[];
  totalUnread: number;
  pendingCount: number;
}

export interface VoiceInboxHandlers {
  getInbox(channels?: string[]): Promise<VoiceInboxResponse>;
  getAgentInbox(): Promise<VoiceInboxAgentResponse>;
  advanceWatermark(channelId: string, messageId: string, source: string): Promise<boolean>;
}

export interface HttpVoiceBridgeOptions {
  host?: string;
  port: number;
  path?: string;
  completionPath?: string;
  apiKey?: string;
  defaultSessionId?: string;
  defaultAgentId?: string;
  maxBodyBytes?: number;
  inboxHandlers?: VoiceInboxHandlers;
  completionHandler?: VoiceCompletionHandler;
}

interface TurnRequestBody {
  sessionId?: unknown;
  agentId?: unknown;
  transcript?: unknown;
  utteranceId?: unknown;
  guildId?: unknown;
  voiceChannelId?: unknown;
  channelId?: unknown;
  discordUserId?: unknown;
}

interface CompletionRequestBody {
  messages?: unknown;
  systemPrompt?: unknown;
  maxTokens?: unknown;
  sessionId?: unknown;
  agentId?: unknown;
  model?: unknown;
}

class VoiceInputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceInputValidationError";
  }
}

function trimString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function parseVoiceTurnInput(
  payload: unknown,
  defaults: { sessionId?: string; agentId?: string }
): VoiceTurnInput {
  if (!payload || typeof payload !== "object") {
    throw new VoiceInputValidationError("Request body must be a JSON object.");
  }

  const body = payload as TurnRequestBody;
  const sessionId = trimString(body.sessionId) ?? defaults.sessionId;
  const agentId = trimString(body.agentId) ?? defaults.agentId;
  const transcript = trimString(body.transcript);
  const utteranceId = trimString(body.utteranceId);
  const guildId = trimString(body.guildId);
  const voiceChannelId = trimString(body.voiceChannelId);
  const channelId = trimString(body.channelId);
  const discordUserId = trimString(body.discordUserId);

  if (!sessionId) {
    throw new VoiceInputValidationError("Missing required field 'sessionId'.");
  }
  if (!agentId) {
    throw new VoiceInputValidationError("Missing required field 'agentId'.");
  }
  if (!transcript) {
    throw new VoiceInputValidationError("Missing required field 'transcript'.");
  }

  return {
    sessionId,
    agentId,
    transcript,
    utteranceId,
    guildId,
    voiceChannelId,
    channelId,
    discordUserId
  };
}

function parseVoiceCompletionMessages(
  value: unknown
): VoiceCompletionMessage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new VoiceInputValidationError(
      "Missing required field 'messages'."
    );
  }

  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new VoiceInputValidationError(
        `messages[${index}] must be an object.`
      );
    }

    const rawRole = trimString((entry as Record<string, unknown>).role);
    const rawContent = trimString((entry as Record<string, unknown>).content);
    if (!rawRole || !["user", "assistant", "system"].includes(rawRole)) {
      throw new VoiceInputValidationError(
        `messages[${index}].role must be one of user, assistant, or system.`
      );
    }
    if (!rawContent) {
      throw new VoiceInputValidationError(
        `messages[${index}].content is required.`
      );
    }

    return {
      role: rawRole as VoiceCompletionMessage["role"],
      content: rawContent
    };
  });
}

function parseOptionalPositiveInteger(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  throw new VoiceInputValidationError(
    "maxTokens must be a positive integer when provided."
  );
}

export function parseVoiceCompletionInput(
  payload: unknown,
  defaults: { sessionId?: string; agentId?: string }
): VoiceCompletionInput {
  if (!payload || typeof payload !== "object") {
    throw new VoiceInputValidationError("Request body must be a JSON object.");
  }

  const body = payload as CompletionRequestBody;
  const systemPrompt = trimString(body.systemPrompt);
  const sessionId = trimString(body.sessionId) ?? defaults.sessionId;
  const agentId = trimString(body.agentId) ?? defaults.agentId;
  const maxTokens = parseOptionalPositiveInteger(body.maxTokens);
  const messages = parseVoiceCompletionMessages(body.messages);
  const model = trimString(body.model);

  return {
    messages,
    systemPrompt,
    maxTokens,
    sessionId,
    agentId,
    model
  };
}

export function resolveVoiceApiKey(headers: IncomingHttpHeaders): string | undefined {
  const bearer = headers.authorization;
  if (typeof bearer === "string") {
    const normalized = bearer.trim();
    if (normalized.toLowerCase().startsWith("bearer ")) {
      const token = normalized.slice(7).trim();
      if (token.length > 0) return token;
    }
    if (normalized.length > 0) return normalized;
  }

  const headerValue = headers["x-tango-api-key"];
  if (typeof headerValue === "string") {
    const normalized = headerValue.trim();
    if (normalized.length > 0) return normalized;
  }
  if (Array.isArray(headerValue)) {
    for (const value of headerValue) {
      const normalized = value.trim();
      if (normalized.length > 0) return normalized;
    }
  }

  return undefined;
}

function sendJson(response: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

export class HttpVoiceBridge implements VoiceBridge {
  private readonly host: string;
  private readonly path: string;
  private readonly completionPath: string;
  private readonly apiKey?: string;
  private readonly defaultSessionId?: string;
  private readonly defaultAgentId?: string;
  private readonly maxBodyBytes: number;
  private readonly inboxHandlers?: VoiceInboxHandlers;
  private readonly completionHandler?: VoiceCompletionHandler;
  private server: Server | null = null;

  constructor(
    private readonly executor: VoiceTurnExecutor,
    private readonly options: HttpVoiceBridgeOptions
  ) {
    this.host = options.host?.trim() || "127.0.0.1";
    this.path = options.path?.trim() || "/voice/turn";
    this.completionPath = options.completionPath?.trim() || "/voice/completion";
    this.apiKey = options.apiKey?.trim() || undefined;
    this.defaultSessionId = options.defaultSessionId?.trim() || undefined;
    this.defaultAgentId = options.defaultAgentId?.trim() || undefined;
    this.maxBodyBytes = Math.max(options.maxBodyBytes ?? 1024 * 1024, 1024);
    this.inboxHandlers = options.inboxHandlers;
    this.completionHandler = options.completionHandler;
  }

  async start(): Promise<void> {
    if (this.server) return;

    this.server = createServer(async (request, response) => {
      try {
        await this.handleRequest(request, response);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, 500, {
          ok: false,
          error: "internal-error",
          message
        });
      }
    });

    await new Promise<void>((resolve, reject) => {
      const current = this.server;
      if (!current) {
        reject(new Error("Voice bridge server initialization failed."));
        return;
      }

      current.once("error", reject);
      current.listen(this.options.port, this.host, () => {
        current.off("error", reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;

    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async onTranscript(input: VoiceTurnInput): Promise<VoiceTurnResult> {
    return this.executor.executeTurn(input);
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = (request.method ?? "GET").toUpperCase();
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

    if (method === "GET" && pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        status: "healthy"
      });
      return;
    }

    if (pathname === "/voice/inbox" && method === "GET") {
      if (this.apiKey) {
        const provided = resolveVoiceApiKey(request.headers);
        if (!provided || provided !== this.apiKey) {
          sendJson(response, 401, { ok: false, error: "unauthorized" });
          return;
        }
      }
      if (!this.inboxHandlers) {
        sendJson(response, 501, { ok: false, error: "inbox-not-configured" });
        return;
      }
      try {
        const url = new URL(request.url ?? "/", "http://localhost");
        const groupBy = url.searchParams.get("groupBy");
        if (groupBy === "agent") {
          const result = await this.inboxHandlers.getAgentInbox();
          sendJson(response, 200, result as unknown as Record<string, unknown>);
        } else {
          const channelsParam = url.searchParams.get("channels");
          const channels = channelsParam
            ? channelsParam.split(",").map((c) => c.trim()).filter((c) => c.length > 0)
            : undefined;
          const result = await this.inboxHandlers.getInbox(channels);
          sendJson(response, 200, result as unknown as Record<string, unknown>);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, 500, { ok: false, error: "inbox-error", message });
      }
      return;
    }

    if (pathname === "/voice/inbox/watermark" && method === "POST") {
      if (this.apiKey) {
        const provided = resolveVoiceApiKey(request.headers);
        if (!provided || provided !== this.apiKey) {
          sendJson(response, 401, { ok: false, error: "unauthorized" });
          return;
        }
      }
      if (!this.inboxHandlers) {
        sendJson(response, 501, { ok: false, error: "inbox-not-configured" });
        return;
      }
      try {
        const raw = await this.readRequestBody(request);
        const body = raw.length > 0 ? JSON.parse(raw) : {};
        const channelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
        const messageId = typeof body.messageId === "string" ? body.messageId.trim() : "";
        const source = typeof body.source === "string" ? body.source.trim() : "voice-playback";
        if (!channelId || !messageId) {
          sendJson(response, 400, { ok: false, error: "invalid-input", message: "channelId and messageId required" });
          return;
        }
        const advanced = await this.inboxHandlers.advanceWatermark(channelId, messageId, source);
        sendJson(response, 200, { ok: true, advanced });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, 500, { ok: false, error: "watermark-error", message });
      }
      return;
    }

    if (pathname === this.completionPath) {
      if (method !== "POST") {
        response.setHeader("allow", "POST");
        sendJson(response, 405, {
          ok: false,
          error: "method-not-allowed"
        });
        return;
      }

      if (this.apiKey) {
        const provided = resolveVoiceApiKey(request.headers);
        if (!provided || provided !== this.apiKey) {
          sendJson(response, 401, {
            ok: false,
            error: "unauthorized"
          });
          return;
        }
      }

      if (!this.completionHandler) {
        sendJson(response, 501, {
          ok: false,
          error: "completion-not-configured"
        });
        return;
      }

      let payload: unknown;
      try {
        const raw = await this.readRequestBody(request);
        payload = raw.length > 0 ? JSON.parse(raw) : {};
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, 400, {
          ok: false,
          error: "invalid-json",
          message
        });
        return;
      }

      let completionInput: VoiceCompletionInput;
      try {
        completionInput = parseVoiceCompletionInput(payload, {
          sessionId: this.defaultSessionId,
          agentId: this.defaultAgentId
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, 400, {
          ok: false,
          error: "invalid-input",
          message
        });
        return;
      }

      try {
        const result = await this.completionHandler(completionInput);
        sendJson(response, 200, {
          ok: true,
          sessionId: completionInput.sessionId ?? null,
          agentId: completionInput.agentId ?? null,
          ...result
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, 500, {
          ok: false,
          error: "completion-failed",
          message
        });
      }
      return;
    }

    if (pathname !== this.path) {
      sendJson(response, 404, {
        ok: false,
        error: "not-found"
      });
      return;
    }

    if (method !== "POST") {
      response.setHeader("allow", "POST");
      sendJson(response, 405, {
        ok: false,
        error: "method-not-allowed"
      });
      return;
    }

    if (this.apiKey) {
      const provided = resolveVoiceApiKey(request.headers);
      if (!provided || provided !== this.apiKey) {
        sendJson(response, 401, {
          ok: false,
          error: "unauthorized"
        });
        return;
      }
    }

    let payload: unknown;
    try {
      const raw = await this.readRequestBody(request);
      payload = raw.length > 0 ? JSON.parse(raw) : {};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 400, {
        ok: false,
        error: "invalid-json",
        message
      });
      return;
    }

    let turnInput: VoiceTurnInput;
    try {
      turnInput = parseVoiceTurnInput(payload, {
        sessionId: this.defaultSessionId,
        agentId: this.defaultAgentId
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 400, {
        ok: false,
        error: "invalid-input",
        message
      });
      return;
    }

    try {
      const result = await this.onTranscript(turnInput);
      sendJson(response, 200, {
        ok: true,
        sessionId: turnInput.sessionId,
        agentId: turnInput.agentId,
        utteranceId: turnInput.utteranceId ?? null,
        guildId: turnInput.guildId ?? null,
        voiceChannelId: turnInput.voiceChannelId ?? null,
        channelId: turnInput.channelId ?? null,
        discordUserId: turnInput.discordUserId ?? null,
        ...result
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, {
        ok: false,
        error: "turn-failed",
        message
      });
    }
  }

  private async readRequestBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    for await (const chunk of request) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > this.maxBodyBytes) {
        throw new Error(`Request body exceeds max size of ${this.maxBodyBytes} bytes.`);
      }
      chunks.push(buffer);
    }

    return Buffer.concat(chunks).toString("utf8");
  }
}

export * from "./channel-routing.js";
export * from "./client.js";
export * from "./assistant-format.js";
export * from "./agent-address-book.js";
export * from "./history-format.js";
export * from "./message-format.js";
export * from "./session-routing.js";
export * from "./tango-session-routing.js";
export * from "./topic-routing.js";
