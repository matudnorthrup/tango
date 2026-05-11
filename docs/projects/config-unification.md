# Agent Config Unification: Legacy → V2

**Linear Project**: [Agent Config Unification](https://linear.app/seaside-hq/project/agent-config-unification-legacy-v2-00856fcfdac3)
**Status**: Implementation
**Date**: 2026-05-11

## Problem

Tango has two parallel agent config systems that must be kept in sync:

1. **Legacy** (`config/defaults/agents/{name}.yaml`) — Parsed by `loadAgentConfigs()` in `packages/core/src/config.ts`. Populates `AgentRegistry` used for routing, access control, voice, tools, orchestration, provider selection, and presentation.

2. **V2** (`config/v2/agents/{name}.yaml`) — Parsed by `loadV2AgentConfig()` in `packages/core/src/v2-config-loader.ts`. Used by `SessionLifecycleManager` / `TangoRouter` for MCP servers, model, memory, and runtime config.

Creating a new agent requires BOTH configs or messages route correctly but fail with "No agent config found." This is confusing, error-prone, and the source of the Foxtrot onboarding bug.

## Discovery Summary

### Consumer Map (12 files use AgentConfig)

| File | What it reads | Purpose |
|---|---|---|
| `core/agent-registry.ts` | All fields | Map-based agent lookup by ID |
| `discord/main.ts` | All fields | Boot-time wiring: registry, capability, access, voice, smoke tests |
| `discord/access-control.ts` | `access.{mode,allowlistChannelIds,allowlistUserIds}` | Per-agent access policy |
| `voice/agent-address-book.ts` | `voice.*`, `defaultTopic`, `defaultProject`, `type`, `displayName` | Voice call sign matching + routing |
| `core/agent-tools.ts` | `tools.{mode,allowlist,permissionMode}` | Tool policy resolution |
| `core/capability-registry.ts` | `orchestration.workerIds`, `displayName`, `promptFile` | Worker dispatch |
| `core/provider-registry.ts` | `provider.{default,fallback}` | Provider candidate resolution |
| `discord/target-agent.ts` | `voice.defaultPromptAgent` | Dispatch → real agent routing |
| `discord/reply-presentation.ts` | `avatarURL`, `displayName` | Discord message avatar/name |
| `discord/session-provider-command.ts` | `provider.*` | `/provider` slash command |
| `cli/index.ts` | All fields | CLI agent registry |
| `tango-voice/testing/` | All fields | Test harness |

### Field Gap Analysis

Fields present in legacy but **missing from v2 schema**:

| Field | Consumers | Notes |
|---|---|---|
| `provider.default` | provider-registry, session-provider-command, main.ts | V2 has `runtime.provider` + `runtime.model` but not the legacy provider abstraction |
| `provider.fallback` | provider-registry | V2 has `runtime.fallback` (single string, not array) |
| `default_topic` | voice address-book | Only used by voice routing |
| `default_project` | voice address-book | Only used by voice routing |
| `response_mode` | main.ts (concise/explain) | Controls response verbosity |
| `tools.mode` / `tools.allowlist` | agent-tools | WebSearch/WebFetch gating |
| `tools.permission_mode` | agent-tools | "bypass" for auto-approve |
| `orchestration.worker_ids` | capability-registry | Worker dispatch scope |
| `orchestration.write_confirmation` | capability-registry | Write confirmation policy |
| `deterministic_routing.*` | main.ts | Fast-path intent classification |
| `access.mode` / `access.allowlist_*` | access-control | Channel/user access gating |
| `avatar_url` | reply-presentation | Discord avatar |
| `prompt_file` | config.ts → prompt-assembly | Legacy uses relative path; v2 uses `system_prompt_file` (repo-relative) |

Fields that **overlap** (present in both, may differ):
- `id`, `display_name`, `type` — identical
- `voice.call_signs`, `voice.kokoro_voice`, `voice.default_channel_id` — identical
- `discord.default_channel_id`, `discord.smoke_test_channel_id` — v2 only (legacy puts smoke_test in voice block)

Special case: **dispatch** agent has a legacy config but NO v2 config (it's a router, not an LLM agent).

## Design: Option B — Generate Legacy from V2 at Boot

### Approach

Add the missing legacy-only fields to the v2 YAML schema and parser. Then create a function `generateLegacyConfigFromV2(v2Config: V2AgentConfig): AgentConfig` that produces the `AgentConfig` shape from a v2 config. At boot, `loadAgentConfigs()` continues to work as-is for backward compatibility, but a new `loadUnifiedAgentConfigs()` function:

1. Loads all v2 configs from `config/v2/agents/`
2. Generates `AgentConfig` objects from each v2 config
3. Falls back to legacy configs for any agent ID not found in v2 (e.g., dispatch)
4. Returns the merged array

### V2 Schema Additions

Add these optional sections to the v2 YAML schema (`rawV2AgentConfigSchema`):

```yaml
# New fields to add to v2 schema:
avatar_url: https://...                    # optional
default_topic: personal/default            # optional
default_project: personal                  # optional
response_mode: concise                     # optional, "concise" | "explain"

provider:                                  # optional, for legacy provider registry
  default: claude-oauth
  fallback:
    - claude-oauth-secondary
    - codex

tools:                                     # optional
  mode: allowlist
  allowlist:
    - WebSearch
    - WebFetch
  permission_mode: bypass                  # optional

orchestration:                             # optional
  worker_ids:
    - personal-assistant
  write_confirmation: on-ambiguity

deterministic_routing:                     # optional
  enabled: true
  confidence_threshold: 0.8
  project_scope: personal
  provider:
    default: claude-oauth
    reasoning_effort: low
    fallback:
      - claude-oauth-secondary

access:                                    # optional
  mode: allowlist
  allowlist_channel_ids: [...]
  allowlist_user_ids: [...]
```

### Implementation Plan

#### Phase 1: Generate legacy from v2 (TGO-480)

1. **Extend `V2AgentConfig` interface and Zod schema** in `v2-config-loader.ts` with all missing fields (provider, tools, orchestration, deterministic_routing, access, default_topic, default_project, response_mode, avatar_url)
2. **Create `v2ToLegacyAgentConfig()`** in a new file `packages/core/src/v2-legacy-bridge.ts` that maps V2AgentConfig → AgentConfig
3. **Create `loadUnifiedAgentConfigs()`** in the bridge file that:
   - Calls `loadAllV2AgentConfigs()` to get v2 configs
   - Generates AgentConfig from each via `v2ToLegacyAgentConfig()`
   - Calls `loadAgentConfigs()` for legacy-only agents (dispatch)
   - Merges: v2-generated configs win over legacy for the same ID
4. **Replace `loadAgentConfigs()` calls** in `discord/main.ts` and `cli/index.ts` with `loadUnifiedAgentConfigs()`
5. **Update `loadVoiceAddressAgents()`** in `voice/agent-address-book.ts` to use unified loading

#### Phase 2: Migrate legacy fields into v2 configs (TGO-481)

1. Add the new fields to each v2 YAML file (watson, malibu, sierra, victor, charlie, juliet, foxtrot)
2. Values come directly from the corresponding legacy YAML files
3. Verify with a diff that `loadUnifiedAgentConfigs()` produces identical output to `loadAgentConfigs()`

#### Phase 3: Delete legacy configs (TGO-482)

1. Delete `config/defaults/agents/` except `dispatch.yaml` (or create a v2 dispatch config)
2. Remove `loadAgentConfigs()` fallback path from `loadUnifiedAgentConfigs()`
3. Rename `loadUnifiedAgentConfigs()` → `loadAgentConfigs()` (or update all callers)

### Risk Mitigation

- **Backward compatible**: Legacy loading still works during migration. Both paths produce the same AgentConfig objects.
- **dispatch agent**: Kept as legacy config until we decide whether to give it a v2 config. It has no v2 runtime (no MCP servers, no model), so it may stay legacy indefinitely.
- **No schema changes to AgentConfig type**: All consumers continue to work with the same interface.
- **Prompt resolution**: V2 uses repo-relative `system_prompt_file`; the bridge function resolves it the same way legacy does via `assembleAgentPrompt()`.

### Validation (TGO-483)

- Send messages to all agents (watson, malibu, sierra, victor, charlie, juliet, foxtrot) — verify routing works
- Test voice call signs — verify voice routing
- Test access control — verify channel allowlisting
- Test `/provider` command — verify provider resolution
- Create a test agent with ONLY a v2 config — verify it's fully functional
