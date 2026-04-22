import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import {
  loadLayeredConfigCategory,
  resolveRepoDefaultsConfigDir,
  traceConfigCategory,
} from "./config-layering.js";
import { assembleAgentPrompt } from "./prompt-assembly.js";
import {
  resolveConfiguredConfigDir,
  resolveConfiguredPath,
  resolveTangoProfileAgentPromptDir,
  resolveTangoProfileConfigDir,
  resolveTangoProfileWorkerPromptDir,
} from "./runtime-paths.js";
import type {
  AgentConfig,
  IntentContractConfig,
  ProviderReasoningEffort,
  ProjectConfig,
  SessionConfig,
  ToolContractConfig,
  WorkflowConfig,
  WorkerConfig,
} from "./types.js";
import type { ScheduleConfig } from "./scheduler/types.js";

export { traceConfigCategory };

const sessionSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["persistent", "project", "ephemeral"]),
  agent: z.string().min(1),
  channels: z.array(z.string().min(1)).min(1),
  orchestrator_continuity: z.enum(["provider", "stateless"]).optional(),
  memory: z
    .object({
      max_context_tokens: z.number().int().positive().optional(),
      zones: z
        .object({
          pinned: z.number().min(0).max(1).optional(),
          summary: z.number().min(0).max(1).optional(),
          memories: z.number().min(0).max(1).optional(),
          recent: z.number().min(0).max(1).optional()
        })
        .optional(),
      summarize_window: z.number().int().positive().optional(),
      memory_limit: z.number().int().positive().optional(),
      importance_threshold: z.number().min(0).max(1).optional(),
      retrieval_weights: z
        .object({
          recency: z.number().min(0).optional(),
          importance: z.number().min(0).optional(),
          relevance: z.number().min(0).optional(),
          source: z.number().min(0).optional()
        })
        .optional()
    })
    .optional()
});

const providerReasoningEffortSchema = z.enum(["low", "medium", "high", "max", "xhigh"]);

const providerSchema = z.object({
  default: z.string().min(1),
  model: z.string().min(1).optional(),
  reasoning_effort: providerReasoningEffortSchema.optional(),
  fallback: z.array(z.string().min(1)).optional()
});

const agentSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  display_name: z.string().min(1).optional(),
  avatar_url: z.string().url().optional(),
  provider: providerSchema,
  prompt: z.string().optional(),
  prompt_file: z.string().min(1).optional(),
  default_topic: z.string().min(1).optional(),
  default_project: z.string().min(1).optional(),
  voice: z
    .object({
      call_signs: z.array(z.string().min(1)).optional(),
      default_prompt_agent: z.string().min(1).optional(),
      kokoro_voice: z.string().min(1).optional(),
      default_channel_id: z.string().min(1).optional(),
      smoke_test_channel_id: z.string().min(1).optional()
    })
    .optional(),
  response_mode: z.enum(["concise", "explain"]).optional(),
  access: z
    .object({
      mode: z.enum(["off", "allowlist", "mention", "both"]).optional(),
      allowlist_channel_ids: z.array(z.string().min(1)).optional(),
      allowlist_user_ids: z.array(z.string().min(1)).optional()
    })
    .optional(),
  tools: z
    .object({
      mode: z.enum(["off", "default", "allowlist"]).optional(),
      allowlist: z.array(z.string().min(1)).optional(),
      permission_mode: z.enum(["bypass"]).optional()
    })
    .optional(),
  orchestration: z
    .object({
      worker_ids: z.array(z.string().min(1)).optional(),
      write_confirmation: z.enum(["always", "on-ambiguity", "never"]).optional()
    })
    .optional(),
  deterministic_routing: z
    .object({
      enabled: z.boolean().optional(),
      project_scope: z.string().min(1).optional(),
      confidence_threshold: z.number().min(0).max(1).optional(),
      provider: providerSchema.optional(),
    })
    .optional()
});

const projectSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().min(1).optional(),
  aliases: z.array(z.string().min(1)).optional(),
  default_agent: z.string().min(1).optional(),
  provider: providerSchema.optional(),
  worker_ids: z.array(z.string().min(1)).optional(),
  tool_contract_ids: z.array(z.string().min(1)).optional(),
  policies: z
    .object({
      topic_mode: z.enum(["topicless", "optional", "required"]).optional(),
      write_confirmation: z.enum(["always", "on-ambiguity", "never"]).optional()
    })
    .optional()
});

const workerSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  display_name: z.string().min(1).optional(),
  owner_agent: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  provider: providerSchema,
  execution: z.enum(["procedural", "agent"]).optional(),
  prompt: z.string().optional(),
  prompt_file: z.string().min(1).optional(),
  tool_contract_ids: z.array(z.string().min(1)).optional(),
  skill_doc_ids: z.array(z.string().min(1)).optional(),
  inactivity_timeout_seconds: z.number().positive().optional(),
  policy: z
    .object({
      write_scope: z.enum(["none", "limited", "full"]).optional(),
      confirm_before_write: z.boolean().optional()
    })
    .optional()
});

const toolContractSchema = z.object({
  id: z.string().min(1),
  family: z.string().min(1),
  description: z.string().min(1),
  owner_worker: z.string().min(1).optional(),
  mode: z.enum(["read", "write", "read_write", "validate"]),
  status: z.enum(["scaffold", "implemented"]).optional(),
  confirmation_required: z.boolean().optional(),
  live_execution: z
    .object({
      enabled: z.boolean().optional(),
      write_enabled: z.boolean().optional()
    })
    .optional(),
  integration: z.object({
    system: z.string().min(1),
    target: z.string().min(1)
  }),
  input_fields: z.array(z.string().min(1)).optional(),
  output_fields: z.array(z.string().min(1)).optional(),
  legacy: z
    .object({
      commands: z.array(z.string().min(1)).optional(),
      read_paths: z.array(z.string().min(1)).optional(),
      write_paths: z.array(z.string().min(1)).optional(),
      notes: z.array(z.string().min(1)).optional()
    })
    .optional()
});

const workflowSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().min(1).optional(),
  description: z.string().min(1),
  owner_worker: z.string().min(1),
  mode: z.enum(["read", "write", "hybrid"]),
  status: z.enum(["scaffold", "implemented"]).optional(),
  confirmation_required: z.boolean().optional(),
  handler: z.string().min(1),
  tool_contract_ids: z.array(z.string().min(1)).optional(),
  input_fields: z.array(z.string().min(1)).optional(),
  examples: z.array(z.string().min(1)).optional(),
  planning: z
    .object({
      summary: z.string().min(1).optional(),
      when_to_use: z.array(z.string().min(1)).optional(),
      ask_for_clarification_when: z.array(z.string().min(1)).optional()
    })
    .optional()
});

const intentContractSchema = z.object({
  id: z.string().min(1),
  domain: z.string().min(1),
  display_name: z.string().min(1).optional(),
  description: z.string().min(1),
  mode: z.enum(["read", "write", "mixed"]),
  route: z.object({
    kind: z.enum(["workflow", "worker"]),
    target_id: z.string().min(1),
  }),
  slots: z.array(
    z.object({
      name: z.string().min(1),
      required: z.boolean().optional(),
      inferable: z.boolean().optional(),
      description: z.string().min(1).optional(),
    }),
  ).optional(),
  examples: z.array(z.string().min(1)).optional(),
  can_run_in_parallel: z.boolean().optional(),
  classifier_hints: z.array(z.string().min(1)).optional(),
  evaluation: z.object({
    task_class: z.string().min(1).optional(),
    success_criteria: z.array(z.string().min(1)).optional(),
    must_answer: z.array(z.string().min(1)).optional(),
    comparison_axes: z.array(z.string().min(1)).optional(),
    required_fields: z.array(z.string().min(1)).optional(),
    quality_gate_required: z.boolean().optional(),
    safe_noop_allowed: z.boolean().optional(),
  }).optional(),
});

export function resolveConfigDir(explicitDir?: string): string {
  if (explicitDir?.trim()) {
    return resolveConfiguredConfigDir(explicitDir);
  }
  if (process.env.TANGO_CONFIG_DIR?.trim()) {
    return resolveConfiguredConfigDir(process.env.TANGO_CONFIG_DIR);
  }

  const repoDefaultsConfigDir = resolveRepoDefaultsConfigDir();
  if (repoDefaultsConfigDir) {
    return repoDefaultsConfigDir;
  }

  return resolveTangoProfileConfigDir();
}

function resolvePromptFields(
  parsed: {
    id: string;
    prompt?: string;
    prompt_file?: string;
    tool_contract_ids?: string[];
    skill_doc_ids?: string[];
  },
  fullPath: string,
  kind: string,
): { prompt?: string; promptFile?: string } {
  if (parsed.prompt && parsed.prompt_file) {
    throw new Error(
      `${kind} '${parsed.id}' in ${fullPath} cannot define both 'prompt' and 'prompt_file'.`
    );
  }

  if (!parsed.prompt_file) {
    return {
      prompt: parsed.prompt,
      promptFile: undefined
    };
  }

  const resolvedPromptFile = path.resolve(path.dirname(fullPath), parsed.prompt_file);
  if (!fs.existsSync(resolvedPromptFile)) {
    throw new Error(`${kind} '${parsed.id}' prompt_file not found: ${resolvedPromptFile}`);
  }

  const prompt =
    path.basename(resolvedPromptFile) === "soul.md"
      ? assembleAgentPrompt(path.dirname(resolvedPromptFile), {
          overlayDir:
            kind === "Agent"
              ? resolveTangoProfileAgentPromptDir(parsed.id)
              : kind === "Worker"
                ? resolveTangoProfileWorkerPromptDir(parsed.id)
                : undefined,
        })
      : fs.readFileSync(resolvedPromptFile, "utf8");

  return {
    prompt,
    promptFile: resolvedPromptFile
  };
}

function mapProviderConfig(
  provider: {
    default: string;
    model?: string;
    reasoning_effort?: ProviderReasoningEffort;
    fallback?: string[];
  }
): {
  default: string;
  model?: string;
  reasoningEffort?: ProviderReasoningEffort;
  fallback?: string[];
};
function mapProviderConfig(
  provider: {
    default?: string;
    model?: string;
    reasoning_effort?: ProviderReasoningEffort;
    fallback?: string[];
  }
): {
  default?: string;
  model?: string;
  reasoningEffort?: ProviderReasoningEffort;
  fallback?: string[];
};
function mapProviderConfig(
  provider: {
    default?: string;
    model?: string;
    reasoning_effort?: ProviderReasoningEffort;
    fallback?: string[];
  }
): {
  default?: string;
  model?: string;
  reasoningEffort?: ProviderReasoningEffort;
  fallback?: string[];
} {
  return {
    default: provider.default,
    model: provider.model,
    reasoningEffort: provider.reasoning_effort,
    fallback: provider.fallback,
  };
}

export function loadSessionConfigs(configDir: string): SessionConfig[] {
  return loadLayeredConfigCategory({
    category: "sessions",
    configDir,
    required: true,
    schema: sessionSchema,
    map: (parsed) => ({
      id: parsed.id,
      type: parsed.type,
      agent: parsed.agent,
      channels: parsed.channels,
      orchestratorContinuity: parsed.orchestrator_continuity,
      memory: parsed.memory
        ? {
            maxContextTokens: parsed.memory.max_context_tokens,
            zones: parsed.memory.zones
              ? {
                  pinned: parsed.memory.zones.pinned,
                  summary: parsed.memory.zones.summary,
                  memories: parsed.memory.zones.memories,
                  recent: parsed.memory.zones.recent
                }
              : undefined,
            summarizeWindow: parsed.memory.summarize_window,
            memoryLimit: parsed.memory.memory_limit,
            importanceThreshold: parsed.memory.importance_threshold,
            retrievalWeights: parsed.memory.retrieval_weights
              ? {
                  recency: parsed.memory.retrieval_weights.recency,
                  importance: parsed.memory.retrieval_weights.importance,
                  relevance: parsed.memory.retrieval_weights.relevance,
                  source: parsed.memory.retrieval_weights.source
                }
              : undefined
          }
        : undefined
    } satisfies SessionConfig),
  });
}

export function loadAgentConfigs(configDir: string): AgentConfig[] {
  return loadLayeredConfigCategory({
    category: "agents",
    configDir,
    required: true,
    schema: agentSchema,
    map: (parsed, trace) => {
      if (parsed.tools?.mode === "allowlist" && (!parsed.tools.allowlist || parsed.tools.allowlist.length === 0)) {
        throw new Error(
          `Agent '${parsed.id}' in ${trace.sourceFiles[trace.sourceFiles.length - 1]?.filePath ?? trace.id} must define tools.allowlist when tools.mode is 'allowlist'.`
        );
      }

      const { prompt, promptFile } = resolvePromptFields(
        parsed,
        trace.fieldSources.prompt_file
          ?? trace.sourceFiles[trace.sourceFiles.length - 1]?.filePath
          ?? trace.id,
        "Agent",
      );

      return {
        id: parsed.id,
        type: parsed.type,
        displayName: parsed.display_name,
        avatarURL: parsed.avatar_url,
        provider: mapProviderConfig(parsed.provider),
        prompt,
        promptFile,
        defaultTopic: parsed.default_topic,
        defaultProject: parsed.default_project,
        voice: parsed.voice
          ? {
              callSigns: parsed.voice.call_signs,
              defaultPromptAgent: parsed.voice.default_prompt_agent,
              kokoroVoice: parsed.voice.kokoro_voice,
              defaultChannelId: parsed.voice.default_channel_id,
              smokeTestChannelId: parsed.voice.smoke_test_channel_id,
            }
          : undefined,
        responseMode: parsed.response_mode,
        access: parsed.access
          ? {
              mode: parsed.access.mode,
              allowlistChannelIds: parsed.access.allowlist_channel_ids,
              allowlistUserIds: parsed.access.allowlist_user_ids
            }
          : undefined,
        tools: parsed.tools
          ? {
              mode: parsed.tools.mode,
              allowlist: parsed.tools.allowlist,
              permissionMode: parsed.tools.permission_mode
            }
          : undefined,
        orchestration: parsed.orchestration
          ? {
              workerIds: parsed.orchestration.worker_ids,
              writeConfirmation: parsed.orchestration.write_confirmation
            }
          : undefined,
        deterministicRouting: parsed.deterministic_routing
          ? {
              enabled: parsed.deterministic_routing.enabled,
              projectScope: parsed.deterministic_routing.project_scope,
              confidenceThreshold: parsed.deterministic_routing.confidence_threshold,
              provider: parsed.deterministic_routing.provider
                ? mapProviderConfig(parsed.deterministic_routing.provider)
                : undefined,
            }
          : undefined,
      } satisfies AgentConfig;
    },
  });
}

export function loadProjectConfigs(configDir: string): ProjectConfig[] {
  return loadLayeredConfigCategory({
    category: "projects",
    configDir,
    required: true,
    schema: projectSchema,
    map: (parsed) => ({
      id: parsed.id,
      displayName: parsed.display_name,
      aliases: parsed.aliases,
      defaultAgentId: parsed.default_agent,
      provider: parsed.provider ? mapProviderConfig(parsed.provider) : undefined,
      workerIds: parsed.worker_ids,
      toolContractIds: parsed.tool_contract_ids,
      policies: parsed.policies
        ? {
            topicMode: parsed.policies.topic_mode,
            writeConfirmation: parsed.policies.write_confirmation
          }
        : undefined
    } satisfies ProjectConfig),
  });
}

export function loadWorkerConfigs(configDir: string): WorkerConfig[] {
  return loadLayeredConfigCategory({
    category: "workers",
    configDir,
    required: true,
    schema: workerSchema,
    map: (parsed, trace) => {
      const { prompt, promptFile } = resolvePromptFields(
        parsed,
        trace.fieldSources.prompt_file
          ?? trace.sourceFiles[trace.sourceFiles.length - 1]?.filePath
          ?? trace.id,
        "Worker",
      );

      return {
        id: parsed.id,
        type: parsed.type,
        displayName: parsed.display_name,
        ownerAgentId: parsed.owner_agent,
        description: parsed.description,
        provider: mapProviderConfig(parsed.provider),
        execution: parsed.execution,
        prompt,
        promptFile,
        toolContractIds: parsed.tool_contract_ids,
        skillDocIds: parsed.skill_doc_ids,
        inactivityTimeoutSeconds: parsed.inactivity_timeout_seconds,
        policy: parsed.policy
          ? {
              writeScope: parsed.policy.write_scope,
              confirmBeforeWrite: parsed.policy.confirm_before_write
            }
          : undefined
      } satisfies WorkerConfig;
    },
  });
}

export function loadToolContractConfigs(configDir: string): ToolContractConfig[] {
  return loadLayeredConfigCategory({
    category: "tool-contracts",
    configDir,
    required: true,
    schema: toolContractSchema,
    map: (parsed) => ({
      id: parsed.id,
      family: parsed.family,
      description: parsed.description,
      ownerWorkerId: parsed.owner_worker,
      mode: parsed.mode,
      status: parsed.status,
      confirmationRequired: parsed.confirmation_required,
      liveExecution: parsed.live_execution
        ? {
            enabled: parsed.live_execution.enabled,
            writeEnabled: parsed.live_execution.write_enabled
          }
        : undefined,
      integration: parsed.integration,
      inputFields: parsed.input_fields,
      outputFields: parsed.output_fields,
      legacy: parsed.legacy
        ? {
            commands: parsed.legacy.commands,
            readPaths: parsed.legacy.read_paths,
            writePaths: parsed.legacy.write_paths,
            notes: parsed.legacy.notes
          }
        : undefined
    } satisfies ToolContractConfig),
  });
}

export function loadWorkflowConfigs(configDir: string): WorkflowConfig[] {
  return loadLayeredConfigCategory({
    category: "workflows",
    configDir,
    required: true,
    schema: workflowSchema,
    map: (parsed) => ({
      id: parsed.id,
      displayName: parsed.display_name,
      description: parsed.description,
      ownerWorkerId: parsed.owner_worker,
      mode: parsed.mode,
      status: parsed.status,
      confirmationRequired: parsed.confirmation_required,
      handler: parsed.handler,
      toolContractIds: parsed.tool_contract_ids,
      inputFields: parsed.input_fields,
      examples: parsed.examples,
      planning: parsed.planning
        ? {
            summary: parsed.planning.summary,
            whenToUse: parsed.planning.when_to_use,
            askForClarificationWhen: parsed.planning.ask_for_clarification_when
          }
        : undefined
    } satisfies WorkflowConfig),
  });
}

export function loadIntentContractConfigs(configDir: string): IntentContractConfig[] {
  return loadLayeredConfigCategory({
    category: "intent-contracts",
    configDir,
    required: false,
    schema: intentContractSchema,
    map: (parsed) => ({
      id: parsed.id,
      domain: parsed.domain,
      displayName: parsed.display_name,
      description: parsed.description,
      mode: parsed.mode,
      route: {
        kind: parsed.route.kind,
        targetId: parsed.route.target_id,
      },
      slots: parsed.slots?.map((slot) => ({
        name: slot.name,
        required: slot.required,
        inferable: slot.inferable,
        description: slot.description,
      })),
      examples: parsed.examples,
      canRunInParallel: parsed.can_run_in_parallel,
      classifierHints: parsed.classifier_hints,
      evaluation: parsed.evaluation
        ? {
            taskClass: parsed.evaluation.task_class,
            successCriteria: parsed.evaluation.success_criteria,
            mustAnswer: parsed.evaluation.must_answer,
            comparisonAxes: parsed.evaluation.comparison_axes,
            requiredFields: parsed.evaluation.required_fields,
            qualityGateRequired: parsed.evaluation.quality_gate_required,
            safeNoopAllowed: parsed.evaluation.safe_noop_allowed,
          }
        : undefined,
    } satisfies IntentContractConfig),
  });
}

// ============================================================
// Schedule configs
// ============================================================

const scheduleTimingSchema = z.object({
  cron: z.string().min(1).optional(),
  every_seconds: z.number().positive().optional(),
  at: z.string().min(1).optional(),
  timezone: z.string().min(1).optional()
});

const schedulePreCheckSchema = z.object({
  handler: z.string().min(1)
});

const scheduleExecutionSchema = z.object({
  mode: z.enum(["deterministic", "conditional-agent", "agent"]),
  handler: z.string().min(1).optional(),
  pre_check: schedulePreCheckSchema.optional(),
  worker_id: z.string().min(1).optional(),
  intent_ids: z.array(z.string().min(1)).optional(),
  deterministic_agent_id: z.string().min(1).optional(),
  task: z.string().min(1).optional(),
  task_template: z.string().min(1).optional(),
  timeout_seconds: z.number().positive().optional()
});

const scheduleProviderSchema = z.object({
  default: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  reasoning_effort: providerReasoningEffortSchema.optional(),
  fallback: z.array(z.string().min(1)).optional()
}).optional();

const scheduleDeliverySchema = z.object({
  channel_id: z.string().min(1).optional(),
  agent_id: z.string().min(1).optional(),
  mode: z.enum(["message", "webhook", "none"]).optional()
}).optional();

const scheduleBackoffSchema = z.object({
  enabled: z.boolean().optional(),
  initial_seconds: z.number().positive().optional(),
  max_seconds: z.number().positive().optional()
}).optional();

const schedulePolicySchema = z.object({
  max_consecutive_failures: z.number().int().positive().optional(),
  alert_channel_id: z.string().min(1).optional(),
  delete_after_run: z.boolean().optional(),
  concurrency_group: z.string().min(1).optional(),
  priority: z.number().int().optional(),
  backoff: scheduleBackoffSchema
}).optional();

const scheduleCompletionSchema = z.object({
  workflow_id: z.string().min(1).optional(),
  scope: z.enum(["daily", "weekly", "monthly"]).optional(),
  check_before_run: z.boolean().optional(),
  mark_on_success: z.boolean().optional()
}).optional();

const scheduleSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().min(1).optional(),
  description: z.string().min(1),
  enabled: z.boolean(),
  runtime: z.enum(["legacy", "v2"]).optional(),
  schedule: scheduleTimingSchema,
  execution: scheduleExecutionSchema,
  provider: scheduleProviderSchema,
  delivery: scheduleDeliverySchema,
  policy: schedulePolicySchema,
  completion: scheduleCompletionSchema,
  tags: z.array(z.string().min(1)).optional()
});

export function loadScheduleConfigs(configDir: string): ScheduleConfig[] {
  return loadLayeredConfigCategory({
    category: "schedules",
    configDir,
    required: false,
    schema: scheduleSchema,
    map: (parsed) => ({
      id: parsed.id,
      displayName: parsed.display_name,
      description: parsed.description,
      enabled: parsed.enabled,
      runtime: parsed.runtime,
      schedule: {
        cron: parsed.schedule.cron,
        everySeconds: parsed.schedule.every_seconds,
        at: parsed.schedule.at,
        timezone: parsed.schedule.timezone,
      },
      execution: {
        mode: parsed.execution.mode,
        handler: parsed.execution.handler,
        preCheck: parsed.execution.pre_check
          ? { handler: parsed.execution.pre_check.handler }
          : undefined,
        workerId: parsed.execution.worker_id,
        intentIds: parsed.execution.intent_ids,
        deterministicAgentId: parsed.execution.deterministic_agent_id,
        task: parsed.execution.task,
        taskTemplate: parsed.execution.task_template,
        timeoutSeconds: parsed.execution.timeout_seconds,
      },
      provider: parsed.provider
        ? {
            ...mapProviderConfig(parsed.provider),
          }
        : undefined,
      delivery: parsed.delivery
        ? {
            channelId: parsed.delivery.channel_id,
            agentId: parsed.delivery.agent_id,
            mode: parsed.delivery.mode,
          }
        : undefined,
      policy: parsed.policy
        ? {
            maxConsecutiveFailures: parsed.policy.max_consecutive_failures,
            alertChannelId: parsed.policy.alert_channel_id,
            deleteAfterRun: parsed.policy.delete_after_run,
            concurrencyGroup: parsed.policy.concurrency_group,
            priority: parsed.policy.priority,
            backoff: parsed.policy.backoff
              ? {
                  enabled: parsed.policy.backoff.enabled,
                  initialSeconds: parsed.policy.backoff.initial_seconds,
                  maxSeconds: parsed.policy.backoff.max_seconds,
                }
              : undefined,
          }
        : undefined,
      completion: parsed.completion
        ? {
            workflowId: parsed.completion.workflow_id,
            scope: parsed.completion.scope,
            checkBeforeRun: parsed.completion.check_before_run,
            markOnSuccess: parsed.completion.mark_on_success,
          }
        : undefined,
      tags: parsed.tags,
    } satisfies ScheduleConfig),
  });
}
