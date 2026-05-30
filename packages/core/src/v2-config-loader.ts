import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import { resolveConfigLayers } from "./config-layering.js";
import { resolveConfiguredPath } from "./runtime-paths.js";
import type {
  AccessMode,
  ProviderReasoningEffort,
  ToolMode,
  WriteConfirmationMode,
} from "./types.js";

export type V2RuntimeMode = "persistent" | "fresh";
export type V2RuntimeProvider = "legacy" | "claude-code-v2";
export type V2FeatureToggle = "enabled" | "disabled";

export interface V2AgentConfig {
  id: string;
  enabled?: boolean;
  displayName: string;
  type: string;
  avatarURL?: string;
  avatarPath?: string;
  systemPromptFile: string;
  mcpServers: Array<{
    name: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  }>;
  runtime: {
    mode: V2RuntimeMode;
    provider: V2RuntimeProvider;
    fallback?: string;
    model: string;
    reasoningEffort: ProviderReasoningEffort;
    idleTimeoutHours: number;
    contextResetThreshold: number;
  };
  memory: {
    postTurnExtraction: V2FeatureToggle;
    extractionModel: string;
    importanceThreshold: number;
    scheduledReflection: V2FeatureToggle;
  };
  voice?: {
    callSigns: string[];
    kokoroVoice: string;
    defaultChannelId: string;
    defaultPromptAgent?: string;
    smokeTestChannelId?: string;
  };
  discord: {
    defaultChannelId: string;
    smokeTestChannelId?: string;
  };
  defaultTopic?: string;
  defaultProject?: string;
  responseMode?: "concise" | "explain";
  legacyProvider?: {
    default: string;
    model?: string;
    reasoningEffort?: ProviderReasoningEffort;
    fallback?: string[];
  };
  tools?: {
    mode?: ToolMode;
    allowlist?: string[];
    permissionMode?: "bypass";
  };
  orchestration?: {
    workerIds?: string[];
    writeConfirmation?: WriteConfirmationMode;
  };
  deterministicRouting?: {
    enabled?: boolean;
    projectScope?: string;
    additionalDomains?: string[];
    confidenceThreshold?: number;
    provider?: {
      default: string;
      model?: string;
      reasoningEffort?: ProviderReasoningEffort;
      fallback?: string[];
    };
  };
  access?: {
    mode?: AccessMode;
    allowlistChannelIds?: string[];
    allowlistUserIds?: string[];
  };
}

const providerReasoningEffortSchema = z.enum(["low", "medium", "high", "max", "xhigh"]);
const featureToggleSchema = z.enum(["enabled", "disabled"]);

const legacyProviderSchema = z.object({
  default: z.string().min(1),
  model: z.string().min(1).optional(),
  reasoning_effort: providerReasoningEffortSchema.optional(),
  fallback: z.array(z.string().min(1)).optional(),
});

const rawV2AgentConfigSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().optional(),
  display_name: z.string().min(1),
  type: z.string().min(1),
  avatar_url: z.string().url().optional(),
  avatar_path: z.string().min(1).optional(),
  system_prompt_file: z.string().min(1),
  mcp_servers: z.array(
    z.union([
      z.object({
        name: z.string().min(1),
        command: z.string().min(1),
        args: z.array(z.string()).optional(),
        env: z.record(z.string()).optional(),
      }),
      z.object({
        name: z.string().min(1),
        url: z.string().url(),
        headers: z.record(z.string()).optional(),
      }),
    ]),
  ).min(1),
  runtime: z.object({
    mode: z.enum(["persistent", "fresh"]),
    provider: z.enum(["legacy", "claude-code-v2"]),
    fallback: z.string().min(1).optional(),
    model: z.string().min(1),
    reasoning_effort: providerReasoningEffortSchema,
    idle_timeout_hours: z.number().positive(),
    context_reset_threshold: z.number().min(0).max(1),
  }),
  memory: z.object({
    post_turn_extraction: featureToggleSchema,
    extraction_model: z.string().min(1),
    importance_threshold: z.number().min(0).max(1),
    scheduled_reflection: featureToggleSchema,
  }),
  voice: z.object({
    call_signs: z.array(z.string().min(1)).min(1),
    kokoro_voice: z.string().min(1),
    default_channel_id: z.string().min(1),
    default_prompt_agent: z.string().min(1).optional(),
    smoke_test_channel_id: z.string().min(1).optional(),
  }).optional(),
  discord: z.object({
    default_channel_id: z.string().min(1),
    smoke_test_channel_id: z.string().min(1).optional(),
  }),
  default_topic: z.string().min(1).optional(),
  default_project: z.string().min(1).optional(),
  response_mode: z.enum(["concise", "explain"]).optional(),
  provider: legacyProviderSchema.optional(),
  tools: z.object({
    mode: z.enum(["off", "default", "allowlist"]).optional(),
    allowlist: z.array(z.string().min(1)).optional(),
    permission_mode: z.enum(["bypass"]).optional(),
  }).optional(),
  orchestration: z.object({
    worker_ids: z.array(z.string().min(1)).optional(),
    write_confirmation: z.enum(["always", "on-ambiguity", "never"]).optional(),
  }).optional(),
  deterministic_routing: z.object({
    enabled: z.boolean().optional(),
    project_scope: z.string().min(1).optional(),
    additional_domains: z.array(z.string().min(1)).optional(),
    confidence_threshold: z.number().min(0).max(1).optional(),
    provider: legacyProviderSchema.optional(),
  }).optional(),
  access: z.object({
    mode: z.enum(["off", "allowlist", "mention", "both"]).optional(),
    allowlist_channel_ids: z.array(z.string().min(1)).optional(),
    allowlist_user_ids: z.array(z.string().min(1)).optional(),
  }).optional(),
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item)) as T;
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneValue(item)]),
    ) as T;
  }
  return value;
}

function deepMergeValues(base: unknown, override: unknown): unknown {
  if (Array.isArray(override)) {
    return cloneValue(override);
  }

  if (isPlainObject(base) && isPlainObject(override)) {
    const merged: Record<string, unknown> = Object.fromEntries(
      Object.entries(base).map(([key, value]) => [key, cloneValue(value)]),
    );

    for (const [key, value] of Object.entries(override)) {
      merged[key] = key in merged ? deepMergeValues(merged[key], value) : cloneValue(value);
    }

    return merged;
  }

  return cloneValue(override);
}

function parseV2AgentConfig(rawConfig: unknown): V2AgentConfig {
  const parsed = rawV2AgentConfigSchema.parse(rawConfig);

  return {
    id: parsed.id,
    enabled: parsed.enabled,
    displayName: parsed.display_name,
    type: parsed.type,
    avatarURL: parsed.avatar_url,
    avatarPath: parsed.avatar_path,
    systemPromptFile: parsed.system_prompt_file,
    mcpServers: parsed.mcp_servers.map((server) => ({
      name: server.name,
      ...("command" in server ? { command: server.command } : {}),
      ...("args" in server ? { args: server.args } : {}),
      ...("env" in server ? { env: server.env } : {}),
      ...("url" in server ? { url: server.url } : {}),
      ...("headers" in server ? { headers: server.headers } : {}),
    })),
    runtime: {
      mode: parsed.runtime.mode,
      provider: parsed.runtime.provider,
      fallback: parsed.runtime.fallback,
      model: parsed.runtime.model,
      reasoningEffort: parsed.runtime.reasoning_effort,
      idleTimeoutHours: parsed.runtime.idle_timeout_hours,
      contextResetThreshold: parsed.runtime.context_reset_threshold,
    },
    memory: {
      postTurnExtraction: parsed.memory.post_turn_extraction,
      extractionModel: parsed.memory.extraction_model,
      importanceThreshold: parsed.memory.importance_threshold,
      scheduledReflection: parsed.memory.scheduled_reflection,
    },
    voice: parsed.voice
      ? {
          callSigns: parsed.voice.call_signs,
          kokoroVoice: parsed.voice.kokoro_voice,
          defaultChannelId: parsed.voice.default_channel_id,
          defaultPromptAgent: parsed.voice.default_prompt_agent,
          smokeTestChannelId: parsed.voice.smoke_test_channel_id,
        }
      : undefined,
    discord: {
      defaultChannelId: parsed.discord.default_channel_id,
      smokeTestChannelId: parsed.discord.smoke_test_channel_id,
    },
    defaultTopic: parsed.default_topic,
    defaultProject: parsed.default_project,
    responseMode: parsed.response_mode,
    legacyProvider: parsed.provider
      ? {
          default: parsed.provider.default,
          model: parsed.provider.model,
          reasoningEffort: parsed.provider.reasoning_effort,
          fallback: parsed.provider.fallback,
        }
      : undefined,
    tools: parsed.tools
      ? {
          mode: parsed.tools.mode,
          allowlist: parsed.tools.allowlist,
          permissionMode: parsed.tools.permission_mode,
        }
      : undefined,
    orchestration: parsed.orchestration
      ? {
          workerIds: parsed.orchestration.worker_ids,
          writeConfirmation: parsed.orchestration.write_confirmation,
        }
      : undefined,
    deterministicRouting: parsed.deterministic_routing
      ? {
          enabled: parsed.deterministic_routing.enabled,
          projectScope: parsed.deterministic_routing.project_scope,
          additionalDomains: parsed.deterministic_routing.additional_domains,
          confidenceThreshold: parsed.deterministic_routing.confidence_threshold,
          provider: parsed.deterministic_routing.provider
            ? {
                default: parsed.deterministic_routing.provider.default,
                model: parsed.deterministic_routing.provider.model,
                reasoningEffort: parsed.deterministic_routing.provider.reasoning_effort,
                fallback: parsed.deterministic_routing.provider.fallback,
              }
            : undefined,
        }
      : undefined,
    access: parsed.access
      ? {
          mode: parsed.access.mode,
          allowlistChannelIds: parsed.access.allowlist_channel_ids,
          allowlistUserIds: parsed.access.allowlist_user_ids,
        }
      : undefined,
  };
}

export function loadV2AgentConfig(configPath: string): V2AgentConfig {
  const resolvedConfigPath = resolveConfiguredPath(configPath);
  const raw = fs.readFileSync(resolvedConfigPath, "utf8");
  return parseV2AgentConfig(yaml.load(raw));
}

export function loadAllV2AgentConfigs(configDir = "config/v2/agents"): Map<string, V2AgentConfig> {
  const resolvedConfigDir = resolveConfiguredPath(configDir);
  if (!fs.existsSync(resolvedConfigDir)) {
    return new Map();
  }
  const files = fs
    .readdirSync(resolvedConfigDir)
    .filter((file) => file.endsWith(".yaml"))
    .sort((left, right) => left.localeCompare(right));
  const configs = new Map<string, V2AgentConfig>();

  for (const file of files) {
    const config = loadV2AgentConfig(`${resolvedConfigDir}/${file}`);
    configs.set(config.id, config);
  }

  return configs;
}

function findV2AgentConfigDir(baseDir: string): string | undefined {
  let current = resolveConfiguredPath(baseDir);

  while (true) {
    for (const candidate of [
      path.join(current, "v2", "agents"),
      path.join(current, "config", "v2", "agents"),
    ]) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export function loadLayeredV2AgentConfigs(configDir?: string): Map<string, V2AgentConfig> {
  const rawConfigs = new Map<string, Record<string, unknown>>();
  const seenV2Dirs = new Set<string>();

  for (const layer of resolveConfigLayers(configDir)) {
    const v2Dir = findV2AgentConfigDir(layer.dir);
    if (!v2Dir) {
      continue;
    }

    const resolvedV2Dir = fs.realpathSync(v2Dir);
    if (seenV2Dirs.has(resolvedV2Dir)) {
      continue;
    }
    seenV2Dirs.add(resolvedV2Dir);

    const files = fs
      .readdirSync(v2Dir)
      .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"))
      .sort((left, right) => left.localeCompare(right));

    const seenIds = new Set<string>();
    for (const file of files) {
      const fullPath = path.join(v2Dir, file);
      const rawDocument = yaml.load(fs.readFileSync(fullPath, "utf8"));
      if (!isPlainObject(rawDocument)) {
        throw new Error(`V2 agent config file ${fullPath} must contain a YAML object.`);
      }
      const id = z.object({ id: z.string().min(1) }).passthrough().parse(rawDocument).id;
      if (seenIds.has(id)) {
        throw new Error(`Duplicate v2 agent config id '${id}' within ${v2Dir}.`);
      }
      seenIds.add(id);

      const existing = rawConfigs.get(id);
      rawConfigs.set(
        id,
        existing
          ? deepMergeValues(existing, rawDocument) as Record<string, unknown>
          : cloneValue(rawDocument),
      );
    }
  }

  return new Map(
    [...rawConfigs.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, rawConfig]) => [id, parseV2AgentConfig(rawConfig)]),
  );
}

export function isV2RuntimeEnabled(config: V2AgentConfig): boolean {
  return isV2AgentEnabled(config) && config.runtime.provider === "claude-code-v2";
}

export function isV2AgentEnabled(config: V2AgentConfig): boolean {
  return config.enabled !== false;
}
