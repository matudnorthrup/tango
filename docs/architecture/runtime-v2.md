# Tango V2 Runtime Architecture

Last updated: 2026-05-30

## Purpose

Tango V2 replaces the old orchestration stack with a thin router over external
agent runtimes. The durable system model is:

1. Discord, voice, and schedules resolve a target agent and conversation.
2. `TangoRouter` sends the user/task text to that conversation's runtime.
3. The runtime uses the agent's assembled system prompt and MCP allowlist.
4. Tango stores messages, telemetry, memories, and scheduled output as the
   durable record.

The model keeps deterministic code responsible for routing, safety, config, and
storage while letting the runtime handle reasoning and tool use directly.

## Current Components

| Component | Location | Role |
| --- | --- | --- |
| Runtime interface | `packages/core/src/agent-runtime.ts` | Shared contract for agent runtime adapters |
| Claude Code adapter | `packages/core/src/claude-code-adapter.ts` | Primary runtime implementation |
| Runtime pool | `packages/core/src/runtime-pool.ts` | Owns active runtime instances |
| Session lifecycle | `packages/core/src/session-lifecycle.ts` | Idle closure, resume, reset, and cold-start context |
| System prompt assembly | `packages/core/src/system-prompt.ts` | Builds v2 prompts from repo prompt assets |
| Router | `packages/discord/src/tango-router.ts` | Conversation key -> runtime send -> response |
| V2 runtime wiring | `packages/discord/src/v2-runtime.ts` | Builds configs, memory context, and post-turn hooks |
| Memory MCP package | `packages/atlas-memory/` | Memory search, pinned facts, reflection, and admin tools |
| Dev MCP package | `packages/tango-dev-mcp/` | Dev/operator tool surface |
| Discord MCP package | `packages/discord-manage-mcp/` | Discord management tool surface |

## Request Flow

```text
Discord/voice/schedule input
  -> target agent and conversation are resolved
  -> TangoRouter.routeMessage()
  -> SessionLifecycleManager gets or creates a runtime
  -> ClaudeCodeAdapter sends the prompt with MCP config
  -> response is returned and stored/presented
  -> post-turn hooks may capture memories
```

Conversation keys are channel- or thread-scoped. That gives each active
conversation its own runtime context while sharing the same agent config,
system prompt, and tool allowlist.

## Prompt Model

V2 prompts are assembled at runtime from safe repo prompt assets:

- assistant `soul.md`
- assistant `knowledge.md`
- shared rules and user context that belong in the repo
- v2 agent config defaults

Private persona overlays, user-specific knowledge, real channel IDs, and local
runtime state belong in profile-owned paths under `~/.tango/profiles/`, not in
tracked repo defaults.

## Memory Model

Atlas memory is the long-term memory surface for V2. Cold-start context can
include:

- global pinned facts
- agent-scoped pinned facts
- relevant memories from `memory_search`

Post-turn extraction is controlled per v2 agent config. Conversation and model
run records remain in Tango storage so runtime sessions are recoverable rather
than authoritative.

## Scheduler Model

Schedules that need LLM execution use `runtime: v2`. Deterministic maintenance
schedules still call direct handlers because they do not need an agent runtime.

Scheduled output should be stored and delivered through the same presentation
and message-recording path as interactive responses. Follow-up work belongs in
the receiving channel/thread context or in Linear if it becomes active project
tracking.

## Legacy Orchestration Removed

The V2 cleanup removed the old worker-dispatch architecture:

- turn executor
- worker agent runtime and worker configs
- worker-dispatch XML tags and dispatch MCP server
- deterministic worker fast path
- legacy prompt assembly
- narration guards tied to worker dispatch synthesis

Agents that are not configured for V2 should fail closed rather than falling
through to retired execution paths.

## Operating Rules

- Add new durable architecture here or in another file under
  `docs/architecture/`.
- Keep active project plans, issue breakdowns, validation gates, and status
  updates in Linear.
- Keep retros and postmortems in `docs/retros/`.
- Keep private context and profile-specific configuration out of the repo.
