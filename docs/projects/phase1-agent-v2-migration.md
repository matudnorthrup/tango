# Phase 1: Agent v2 Migration

## Status: SHIPPED
**Date:** 2026-04-21
**Linear:** https://linear.app/seaside-hq/project/phase-1-agent-v2-migration-46438cb81267

## Summary

Migrated Watson, Sierra, Victor, and Juliet from the legacy runtime to the v2 Claude Code adapter runtime. All 5 Tango agents (including Malibu from Phase 0) now run on v2.

## What Shipped

### Config files created
- `config/v2/agents/watson.yaml` — 12 MCP servers (google, obsidian, lunch-money, receipt-registry, ramp, browser, onepassword, linear, imessage, latitude, slack, memory)
- `config/v2/agents/juliet.yaml` — 1 MCP server (memory only)
- `config/v2/agents/sierra.yaml` — 11 MCP servers (exa, browser, obsidian, onepassword, printer, location, walmart, file-ops, slack, youtube, memory)
- `config/v2/agents/victor.yaml` — 3 MCP servers (tango-dev, discord-manage, memory)

### Knowledge files updated
- `agents/assistants/watson/knowledge.md` — Added Available Tools section with mcp__ prefixed tool names
- `agents/assistants/juliet/knowledge.md` — Added Available Tools section
- `agents/assistants/sierra/knowledge.md` — Added Available Tools section
- `agents/assistants/victor/knowledge.md` — Added Available Tools section

### Infrastructure fixes
- **AtlasMemoryClient database fix** (`packages/discord/src/main.ts`): Removed `dbPath` override so atlas-memory uses its own database (`~/.tango/atlas/memory.db`) instead of sharing tango.sqlite. The legacy memories table schema (INTEGER id, no tags, no embedding BLOB) was incompatible with atlas-memory's schema (TEXT id, tags, embedding BLOB).
- **kokoro_voice** added to all v2 configs — required field in Zod schema when voice section is present.

### ALLOWED_TOOL_IDS filtering
All proxy-based MCP servers use `ALLOWED_TOOL_IDS` env var to filter which tools are exposed per server instance, preventing tool namespace pollution. This was a new pattern not present in the Phase 0 Malibu config.

## Validation Results

| Agent | v2 Registered | Live Test | Response Time | Notes |
|-------|---------------|-----------|---------------|-------|
| Juliet | Yes | PASS | 4.3s | Memory MCP working |
| Watson | Yes | PASS | 7.7s | All 12 proxy servers initialized, ALLOWED_TOOL_IDS filtering working |
| Sierra | Yes | Blocked | — | Channel access control issue (smoke test channel not in allowlist), v2 routing functional |
| Victor | Yes | Blocked | — | Same channel access control issue, v2 routing functional |

## Known Issues

1. **Sierra/Victor smoke test channels not allowlisted** — The `smoke_test_channel_id` values in the v2 configs use placeholder IDs. When the test harness sends to the actual smoke test channels, the thread channel isn't in the default allowlist. This needs a channel access config update (not a v2 issue).

2. **Watson `latitude_run` returns 0 tools** — The `latitude_run` tool ID may not be registered on the persistent MCP server. Needs investigation.

3. **Atlas-memory database is empty** — The migration from legacy tango.sqlite memories to atlas-memory hasn't been run. Historical memory context isn't available to v2 agents until migration is executed.

## Key Decisions

- **Victor env handling**: discord-manage MCP inherits DISCORD_TOKEN from process env rather than YAML interpolation (v2 config loader does no env var substitution)
- **Proxy path**: `packages/core/dist/mcp-proxy.js` (not `packages/discord/dist/` as in Malibu Phase 0 config)
- **Sequential flips**: Juliet first (simplest), then Watson (most tools), then Sierra + Victor
