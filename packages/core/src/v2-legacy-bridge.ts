/**
 * V2 → Legacy AgentConfig Bridge
 *
 * Generates legacy AgentConfig objects from V2AgentConfig so that the
 * agentRegistry and all its consumers (access control, voice routing,
 * tool policy, capability registry, etc.) can be populated from v2
 * configs alone.
 */

import fs from "node:fs";
import path from "node:path";
import { assembleAgentPrompt } from "./prompt-assembly.js";
import { resolveConfiguredPath } from "./runtime-paths.js";
import type { AgentConfig } from "./types.js";
import type { V2AgentConfig } from "./v2-config-loader.js";
import { loadAllV2AgentConfigs } from "./v2-config-loader.js";
import { loadAgentConfigs } from "./config.js";

function resolveV2PromptFile(
  systemPromptFile: string,
  repoRoot?: string,
): string {
  if (path.isAbsolute(systemPromptFile)) {
    return systemPromptFile;
  }
  const root = repoRoot ?? process.cwd();
  return path.resolve(root, systemPromptFile);
}

function resolveV2AgentConfigDir(configDir: string): string {
  const resolvedConfigDir = resolveConfiguredPath(configDir);
  const configRoot = path.basename(resolvedConfigDir) === "defaults"
    ? path.dirname(resolvedConfigDir)
    : resolvedConfigDir;
  return path.join(configRoot, "v2", "agents");
}

function resolveV2Prompt(
  agentId: string,
  systemPromptFile: string,
  repoRoot?: string,
): { prompt?: string; promptFile?: string } {
  const resolvedFile = resolveV2PromptFile(systemPromptFile, repoRoot);

  if (!fs.existsSync(resolvedFile)) {
    console.warn(
      `[v2-legacy-bridge] Agent '${agentId}' system_prompt_file not found: ${resolvedFile}`,
    );
    return { prompt: undefined, promptFile: undefined };
  }

  if (path.basename(resolvedFile) === "soul.md") {
    return {
      prompt: assembleAgentPrompt(path.dirname(resolvedFile)),
      promptFile: resolvedFile,
    };
  }

  return {
    prompt: fs.readFileSync(resolvedFile, "utf8"),
    promptFile: resolvedFile,
  };
}

export function v2ToLegacyAgentConfig(
  v2: V2AgentConfig,
  options: { repoRoot?: string } = {},
): AgentConfig {
  const { prompt, promptFile } = resolveV2Prompt(
    v2.id,
    v2.systemPromptFile,
    options.repoRoot,
  );

  // Build the legacy provider block. Prefer explicit legacyProvider if set,
  // otherwise synthesize from v2 runtime fields.
  const provider = v2.legacyProvider ?? {
    default: "claude-oauth",
    model: v2.runtime.model,
    reasoningEffort: v2.runtime.reasoningEffort,
    fallback: v2.runtime.fallback ? [v2.runtime.fallback] : undefined,
  };

  return {
    id: v2.id,
    type: v2.type,
    displayName: v2.displayName,
    avatarURL: v2.avatarURL,
    provider,
    prompt,
    promptFile,
    defaultTopic: v2.defaultTopic,
    defaultProject: v2.defaultProject,
    voice: v2.voice
      ? {
          callSigns: v2.voice.callSigns,
          defaultPromptAgent: v2.voice.defaultPromptAgent,
          kokoroVoice: v2.voice.kokoroVoice,
          defaultChannelId: v2.voice.defaultChannelId,
          smokeTestChannelId: v2.voice.smokeTestChannelId,
        }
      : undefined,
    responseMode: v2.responseMode,
    access: v2.access
      ? {
          mode: v2.access.mode,
          allowlistChannelIds: v2.access.allowlistChannelIds,
          allowlistUserIds: v2.access.allowlistUserIds,
        }
      : undefined,
    tools: v2.tools
      ? {
          mode: v2.tools.mode,
          allowlist: v2.tools.allowlist,
          permissionMode: v2.tools.permissionMode,
        }
      : undefined,
    orchestration: v2.orchestration
      ? {
          workerIds: v2.orchestration.workerIds,
          writeConfirmation: v2.orchestration.writeConfirmation,
        }
      : undefined,
    deterministicRouting: v2.deterministicRouting
      ? {
          enabled: v2.deterministicRouting.enabled,
          projectScope: v2.deterministicRouting.projectScope,
          confidenceThreshold: v2.deterministicRouting.confidenceThreshold,
          provider: v2.deterministicRouting.provider,
        }
      : undefined,
  };
}

/**
 * Load agent configs with unified v2 + legacy support.
 *
 * Strategy: Legacy configs (with profile layering) remain authoritative for
 * agents that have them. For agents that exist ONLY in v2, we generate a
 * legacy AgentConfig from the v2 config. This ensures:
 * - Existing agents keep profile overlay values (real channel IDs, avatars)
 * - New v2-only agents work without needing a legacy config file
 */
export function loadUnifiedAgentConfigs(
  configDir: string,
  options: { repoRoot?: string } = {},
): AgentConfig[] {
  const legacyConfigs = loadAgentConfigs(configDir);
  const legacyIds = new Set(legacyConfigs.map((c) => c.id));

  // Generate AgentConfig for v2-only agents (no legacy file)
  const v2Configs = loadAllV2AgentConfigs(resolveV2AgentConfigDir(configDir));
  const v2Only: AgentConfig[] = [];
  for (const v2Config of v2Configs.values()) {
    if (!legacyIds.has(v2Config.id)) {
      v2Only.push(v2ToLegacyAgentConfig(v2Config, options));
    }
  }

  return [...legacyConfigs, ...v2Only];
}
