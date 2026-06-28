import type {
  AgentRuntimeConfig,
  McpMountSelection,
  McpServerConfig,
  SendOptions,
} from "./agent-runtime.js";

export interface McpTurnSelectionInput {
  message?: string;
  sendOptions?: Pick<
    SendOptions,
    "context" | "currentTurnMetadataPrompt" | "turnBriefingPrompt" | "images"
  >;
  requestedServerNames?: readonly string[];
}

export interface McpTurnSelectionResult {
  config: AgentRuntimeConfig;
  selection: McpMountSelection;
}

const SERVER_KEYWORD_PATTERNS: Record<string, RegExp[]> = {
  "agent-docs": [
    /\b(agent docs?|prompt docs?|soul\.md|knowledge\.md|rules\.md)\b/iu,
  ],
  atlas: [
    /\b(atlas|atlas sql|memory database)\b/iu,
  ],
  attachments: [
    /\[attachments\]/iu,
    /\battachment:\d+\b/iu,
    /\b(attach(?:ed|ment|ments)?|upload(?:ed)?|file|files|pdf|document|documents|docx|spreadsheet|csv|ocr)\b/iu,
    /\b(attached|uploaded|sent).{0,40}\b(image|photo|picture|screenshot)\b/iu,
    /\b(image|photo|picture|screenshot).{0,40}\b(attached|uploaded|sent)\b/iu,
  ],
  browser: [
    /\b(browser|open (?:the )?(?:site|page|url)|website|web page|webpage|click|navigate)\b/iu,
    /https?:\/\//iu,
  ],
  "claude-sessions": [
    /\b(spawn|start|list).{0,40}\b(claude|session|remote control|tmux)\b/iu,
    /\bclaude sessions?\b/iu,
  ],
  exa: [
    /\b(exa|web search|search the web|research|find sources?|look up)\b/iu,
  ],
  fatsecret: [
    /\b(fatsecret|nutrition api|calorie lookup|food lookup|log food)\b/iu,
  ],
  google: [
    /\b(gmail|email|calendar|google docs?|doc tabs?|google)\b/iu,
  ],
  "gospel-library": [
    /\b(gospel library|scripture|verse|lesson|talk|manual)\b/iu,
  ],
  "kilo-ledger": [
    /\b(kilo|ledger|allowance|budget|transaction)\b/iu,
  ],
  linear: [
    /\b(linear|issue|ticket|project update|milestone|tgo-\d+)\b/iu,
  ],
  location: [
    /\b(route|directions|near me|nearby|drive|driving|map|maps|gas|diesel|distance)\b/iu,
  ],
  notion: [
    /\b(notion|notion page|notion database)\b/iu,
  ],
  obsidian: [
    /\b(obsidian|vault|daily note|note|notes|markdown file)\b/iu,
  ],
  onepassword: [
    /\b(1password|onepassword|secret|credential|password|api key|token)\b/iu,
  ],
  orientation: [
    /\b(orientation|nudge|onboarding)\b/iu,
  ],
  printer: [
    /\b(print|printer|3d print|openscad|prusa|slice|paper print)\b/iu,
  ],
  "send-image": [
    /\b(send|post|drop|share|upload|show).{0,50}\b(image|photo|picture|screenshot|map|visual)\b/iu,
    /\b(image|photo|picture|screenshot|map|visual).{0,50}\b(send|post|drop|share|upload|show)\b/iu,
    /\bconfirm-before-purchase\b/iu,
  ],
  slack: [
    /\b(slack|channel mention|slack thread)\b/iu,
  ],
  wellness: [
    /\b(health|wellness|workout|nutrition|meal|recipe|supplement|calorie|sleep|recovery)\b/iu,
  ],
  "wellness-db": [
    /\b(wellness db|wellness database|product|supplement|recipe|meal log|delete product|delete supplement)\b/iu,
  ],
  walmart: [
    /\b(walmart|cart|checkout|order)\b/iu,
  ],
  youtube: [
    /\b(youtube|video transcript|transcript)\b/iu,
  ],
};

function cloneServerConfig(server: McpServerConfig): McpServerConfig {
  return {
    name: server.name,
    ...(server.command ? { command: server.command } : {}),
    ...(server.args ? { args: [...server.args] } : {}),
    ...(server.env ? { env: { ...server.env } } : {}),
    ...(server.url ? { url: server.url } : {}),
    ...(server.headers ? { headers: { ...server.headers } } : {}),
  };
}

function normalizeServerName(name: string): string {
  return name.trim().toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function serverNameMentioned(name: string, corpus: string): boolean {
  const normalized = normalizeServerName(name);
  if (!normalized) return false;
  const words = normalized
    .split(/[-_]+/gu)
    .map((part) => escapeRegExp(part))
    .join("[\\s_-]+");
  return new RegExp(`\\b${words}\\b`, "iu").test(corpus);
}

function collectCorpus(input: McpTurnSelectionInput): string {
  return [
    input.message,
    input.sendOptions?.context,
    input.sendOptions?.currentTurnMetadataPrompt,
    input.sendOptions?.turnBriefingPrompt,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n\n");
}

function resolveTriggerReasons(
  serverName: string,
  input: McpTurnSelectionInput,
  corpus: string,
): string[] {
  const reasons: string[] = [];
  const normalized = normalizeServerName(serverName);

  if (input.requestedServerNames?.some((name) => normalizeServerName(name) === normalized)) {
    reasons.push("requested");
  }

  if (
    normalized === "attachments"
    && input.sendOptions?.images
    && input.sendOptions.images.length > 0
  ) {
    reasons.push("images-present");
  }

  const patterns = SERVER_KEYWORD_PATTERNS[normalized] ?? [];
  if (patterns.some((pattern) => pattern.test(corpus))) {
    reasons.push("turn-keyword");
  } else if (serverNameMentioned(serverName, corpus)) {
    reasons.push("server-mentioned");
  }

  return [...new Set(reasons)];
}

function mergeServers(
  defaultServers: readonly McpServerConfig[],
  activatedServers: readonly McpServerConfig[],
): McpServerConfig[] {
  const merged: McpServerConfig[] = [];
  const seen = new Set<string>();

  for (const server of [...defaultServers, ...activatedServers]) {
    const name = normalizeServerName(server.name);
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    merged.push(cloneServerConfig(server));
  }

  return merged;
}

export function selectMcpServersForTurn(
  config: AgentRuntimeConfig,
  input: McpTurnSelectionInput,
): McpTurnSelectionResult {
  const defaultServers = config.mcpServers.map((server) => cloneServerConfig(server));
  const availableServers = (config.availableMcpServers ?? []).map((server) => cloneServerConfig(server));
  const corpus = collectCorpus(input);
  const triggerReasons: Record<string, string[]> = {};
  const activatedServers: McpServerConfig[] = [];

  for (const server of availableServers) {
    const reasons = resolveTriggerReasons(server.name, input, corpus);
    if (reasons.length === 0) {
      continue;
    }
    activatedServers.push(server);
    triggerReasons[server.name] = reasons;
  }

  const mountedServers = mergeServers(defaultServers, activatedServers);
  const selection: McpMountSelection = {
    defaultServerNames: defaultServers.map((server) => server.name),
    availableServerNames: availableServers.map((server) => server.name),
    mountedServerNames: mountedServers.map((server) => server.name),
    activatedServerNames: activatedServers.map((server) => server.name),
    triggerReasons,
  };

  return {
    selection,
    config: {
      ...config,
      mcpServers: mountedServers,
      ...(availableServers.length > 0 ? { availableMcpServers: availableServers } : {}),
      mcpMountSelection: selection,
    },
  };
}
