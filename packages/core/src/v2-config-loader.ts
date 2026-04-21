import fs from "node:fs";
import yaml from "js-yaml";
import { z } from "zod";
import { resolveConfiguredPath } from "./runtime-paths.js";
import type { ProviderReasoningEffort } from "./types.js";

export type V2RuntimeMode = "persistent" | "fresh";
export type V2RuntimeProvider = "legacy" | "claude-code-v2";
export type V2FeatureToggle = "enabled" | "disabled";

export interface V2AgentConfig {
  id: string;
  displayName: string;
  type: string;
  systemPromptFile: string;
  mcpServers: Array<{
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
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
  };
  discord: {
    defaultChannelId: string;
    smokeTestChannelId?: string;
  };
}

const providerReasoningEffortSchema = z.enum(["low", "medium", "high", "max", "xhigh"]);
const featureToggleSchema = z.enum(["enabled", "disabled"]);

const rawV2AgentConfigSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().min(1),
  type: z.string().min(1),
  system_prompt_file: z.string().min(1),
  mcp_servers: z.array(
    z.object({
      name: z.string().min(1),
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      env: z.record(z.string()).optional(),
    }),
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
  }).optional(),
  discord: z.object({
    default_channel_id: z.string().min(1),
    smoke_test_channel_id: z.string().min(1).optional(),
  }),
});

export function loadV2AgentConfig(configPath: string): V2AgentConfig {
  const resolvedConfigPath = resolveConfiguredPath(configPath);
  const raw = fs.readFileSync(resolvedConfigPath, "utf8");
  const parsed = rawV2AgentConfigSchema.parse(yaml.load(raw));

  return {
    id: parsed.id,
    displayName: parsed.display_name,
    type: parsed.type,
    systemPromptFile: parsed.system_prompt_file,
    mcpServers: parsed.mcp_servers.map((server) => ({
      name: server.name,
      command: server.command,
      args: server.args,
      env: server.env,
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
        }
      : undefined,
    discord: {
      defaultChannelId: parsed.discord.default_channel_id,
      smokeTestChannelId: parsed.discord.smoke_test_channel_id,
    },
  };
}

export function isV2RuntimeEnabled(config: V2AgentConfig): boolean {
  return config.runtime.provider === "claude-code-v2";
}
