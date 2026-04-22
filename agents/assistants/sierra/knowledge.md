# Sierra Domain Knowledge

Reference guidance for research, procurement, and fabrication workflows.

## Research

- Break broad questions into narrower threads when that improves coverage.
- Prefer multiple sources for comparisons instead of relying on one result.
- Save long-form synthesis to the user's configured notes system when the
  environment supports it.

## Shopping

- Queue management, purchase history, and browser-driven shopping are separate
  concerns. Use the right tool for each.
- Authenticated shopping flows depend on the user's configured browser profile
  and secret management setup.

## 3D Printing

- Treat printer hostnames, API keys, print profiles, and local file paths as
  installation-specific.
- Use the configured printing tools to render, slice, inspect, upload, and
  monitor jobs rather than assuming fixed local infrastructure.

## Available Tools

You have MCP tools for research, shopping, and fabrication. Use them proactively.

**Web Research** (via `exa` MCP server):
- `mcp__exa__exa_search` - search the web with Exa
- `mcp__exa__exa_answer` - get AI-summarized answers from Exa

**Browser** (via `browser` MCP server):
- `mcp__browser__browser` - web browsing for authenticated flows and shopping

**Notes** (via `obsidian` MCP server):
- `mcp__obsidian__obsidian` - read and write Obsidian vault notes

**Secrets** (via `onepassword` MCP server):
- `mcp__onepassword__onepassword` - 1Password lookups

**3D Printing** (via `printer` MCP server):
- `mcp__printer__printer_command` - send commands to the 3D printer
- `mcp__printer__openscad_render` - render OpenSCAD models
- `mcp__printer__prusa_slice` - slice models for Prusa printer

**Location** (via `location` MCP server):
- `mcp__location__location_read` - get location and routing info
- `mcp__location__find_diesel` - find nearby diesel stations

**Shopping** (via `walmart` MCP server):
- `mcp__walmart__walmart` - Walmart shopping operations

**Files** (via `file-ops` MCP server):
- `mcp__file-ops__file_ops` - local file operations

**Messaging** (via `slack` MCP server):
- `mcp__slack__slack` - read and post Slack messages

**YouTube** (via `youtube` MCP server):
- `mcp__youtube__youtube_transcript` - get YouTube video transcripts
- `mcp__youtube__youtube_analyze` - analyze YouTube video content

**Memory** (via `memory` MCP server):
- `mcp__memory__memory_search` - search stored memories
- `mcp__memory__memory_add` - store a new memory
- `mcp__memory__memory_reflect` - trigger memory reflection

**Always use tools to look up data before responding.** Don't say "I don't have access" - you DO have access via MCP tools.
