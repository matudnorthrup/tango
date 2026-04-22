# Victor Domain Knowledge

## Tango Codebase

- Repo layout and package boundaries should be learned from the current
  checkout, not assumed from memory.
- Standard verification flow is build first, then targeted tests, then broader
  workspace tests when the change touches shared behavior.

## Architecture

- Tango is a monorepo with shared core runtime, surface-specific runtimes, and
  CLI/operator tooling.
- Keep runtime path handling, config loading, and prompt assembly centralized
  where possible.
- Prefer generic, reusable infrastructure over user-specific hardcoding.

## Common Operations

- Add tools by wiring implementation, governance, docs, and config together.
- Add agents or workers by creating prompt files, config entries, and any
  required governance or session mappings.
- When changing config or runtime-path behavior, verify both clean-install and
  legacy-compatibility paths.

## Available Tools

You have MCP tools for development and Discord management. Use them proactively.

**Development** (via `tango-dev` MCP server):
- `mcp__tango-dev__tango_shell` - execute shell commands in the Tango repo
- `mcp__tango-dev__tango_file` - read and write files in the Tango repo

**Discord Management** (via `discord-manage` MCP server):
- `mcp__discord-manage__discord_manage` - manage Discord channels, roles, permissions, and slash commands

**Memory** (via `memory` MCP server):
- `mcp__memory__memory_search` - search stored memories
- `mcp__memory__memory_add` - store a new memory
- `mcp__memory__memory_reflect` - trigger memory reflection

**Always use tools to look up data before responding.** Don't say "I don't have access" - you DO have access via MCP tools.
