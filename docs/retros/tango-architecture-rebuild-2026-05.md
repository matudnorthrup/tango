# Tango Architecture Rebuild Retro

Date: 2026-05-30

## Summary

The Tango Architecture Rebuild moved the agent runtime from a layered
orchestration stack to V2: a thin router over Claude Code, with MCP tools,
profile-owned configuration, and Atlas memory.

The original project doc mixed current architecture, discovery rationale,
implementation phases, validation evidence, removed files, future ideas, and
Linear status. Current architecture now lives in
[`../architecture/runtime-v2.md`](../architecture/runtime-v2.md). This retro
keeps the durable history.

## Problem

The old runtime accumulated brittle layers:

- turn executor orchestration
- worker dispatch and worker summaries
- intent classification
- deterministic fast paths
- narration guards
- memory compaction
- prompt assembly that mixed runtime, tool, and worker instructions

These layers solved local problems but created recurring regressions. They also
made analytical questions worse by stripping user context and forcing short
syntheses.

## Decision

Replace legacy orchestration with:

- per-conversation V2 runtimes
- Claude Code as the primary runtime adapter
- MCP allowlists instead of worker-dispatch handoffs
- Atlas memory for pinned facts and long-term recall
- runtime prompt assembly from explicit safe prompt assets
- direct scheduler bridge for `runtime: v2` jobs

Formal Codex fallback was deferred. The interface still leaves room for a
future adapter, but this project shipped Claude Code V2 first.

## Result

By the May 25, 2026 cleanup gate:

- main interactive agents were on V2 configs
- scheduled agent jobs that needed LLM execution used `runtime: v2`
- deterministic schedules remained direct handlers
- legacy worker execution branches were removed
- shared prompts stopped referencing worker dispatch as the normal path
- validation covered v2 scheduled jobs and bridge smoke tests after restart

The remaining work after this rebuild should be treated as V2 hardening, not as
legacy fallback removal.

## Lessons

- A short current architecture doc is more useful than a long project plan once
  the migration ships.
- Runtime sessions are operational state, not source of truth. Storage,
  profile config, and Linear need to carry the durable record.
- Worker-like decomposition should happen through MCP tools and clear system
  prompts, not through an internal XML dispatch protocol.
- Future provider fallback should be designed as a separate project with
  explicit MCP/function wrapping, not smuggled into the runtime cleanup.

## Validation Record

The original project validation was tracked in Linear under the Tango
Architecture Rebuild project, including:

- scheduled v2 failure validation and fixes
- prompt assembly cleanup
- scheduler bridge cleanup
- post-restart v2 smoke tests
- deterministic schedule validation harness results
