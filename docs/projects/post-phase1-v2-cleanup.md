# Post-Phase-1 v2 Issue Cleanup

## Status: Partial Ship (2026-04-21)

## Summary

Addressed 5 issues surfaced after Phase 1 (all agents on v2) shipped. 4 of 5 resolved; 1 blocked on Discord admin action.

## Issues

### P1: Malibu food logging failure — FIXED
- **Root cause**: `nutrition-log-executor.ts:105` defaulted `strict` to `true`. When any item in a batch couldn't be resolved in Atlas, ALL items were rejected.
- **Evidence**: FatSecret had only 2 entries for 2026-04-22 (freeze-dried apple crisps) vs 13 proper entries on 2026-04-21.
- **Fix**: Changed `input.strict !== false` → `input.strict === true` (opt-in strict).
- **Test**: Added regression test for partial logging with mixed resolved/unresolved items.
- **Commit**: `ef8a0e9`

### P2: model_run recording gap — FIXED
- **Root cause**: `ClaudeCodeAdapter.send()` returned `RuntimeResponse` but `handleMessage()` never called `writeModelRun()` for the v2 path (only v1 had persistence).
- **Fix**: Added `writeModelRun()` call after v2 turns in `main.ts:7254+`, mapping RuntimeResponse fields to model_runs schema.
- **Commit**: `38a1f79`

### P3: Atlas:memory database empty — FIXED
- **Root cause**: Migration script defaulted to `data/tango.sqlite` (repo dir, 0 rows) instead of `~/.tango/profiles/default/data/tango.sqlite` (3,276 rows).
- **Fix**: Re-ran migration with `--source-db ~/.tango/profiles/default/data/tango.sqlite`. 3,276 memories migrated. Session summaries had expected UNIQUE constraint failures (duplicate session_id/agent_id pairs); 25 unique summaries migrated.

### P4: Sierra/Victor smoke test channels — BLOCKED
- All `smoke_test_channel_id` and `default_channel_id` values in Sierra/Victor configs are placeholder IDs (e.g., `100000000000001003`). These don't map to real Discord channels.
- Needs Discord server admin to create smoke test channels for Sierra and Victor, then update configs with real snowflake IDs and add them to session configs.

### P5: Watson latitude_run tool — FIXED
- No latitude MCP server implementation exists. Removed the `latitude` proxy declaration from `config/v2/agents/watson.yaml`.
- **Commit**: `63a2147`

## Key Files
- `packages/discord/src/nutrition-log-executor.ts` — P1 fix
- `packages/discord/src/main.ts` — P2 fix
- `config/v2/agents/watson.yaml` — P5 fix
- `scripts/migrate-memory-to-atlas.ts` — P3 migration script

## Linear
Project: Post-Phase-1 v2 Issue Cleanup
Issues: TGO-271 through TGO-279
