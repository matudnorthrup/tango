# latitude_run

Latitude's remote MCP server — provides Notion, Slack, Linear, and other Latitude work tools via a single `run(category, tool, params)` interface. The server runs remotely and authenticates with OAuth; tool credentials (API keys, tokens) are managed server-side.

**This tool is provided by a separate MCP server (`latitude-remote`).** Call it as `mcp__latitude-remote__run(...)`, NOT as a wellness server tool.

## Interface

```
run(category, tool, params)
```

## Available categories

| Category | Description | Example tools |
|----------|-------------|---------------|
| `notion` | Pages & databases | `search`, `get-page`, `get-page-markdown`, `set-page-markdown`, `get-database`, `query-database`, `create-page`, `update-page`, `append-blocks` |
| `slack` | Messaging & workspace | `post-message`, `search-messages`, `get-channel-history` |
| `postgres` | Main app database (read-only) | `query`, `list-tables`, `describe-table` |
| `github` | Repo & file access | `list-directory`, `get-file` |
| `datadog` | Monitoring | `list-monitors`, `get-metrics` |
| `grafana` | Dashboards | `list-dashboards`, `get-dashboard` |
| `heroku` | Platform management | `get-logs`, `list-apps`, `restart-dyno` |
| `sentry` | Error tracking | `list-issues`, `get-issue` |
| `outline` | Documentation wiki | `search`, `get-document` |
| `athena` | Analytics data lake | `query` |

## Notion quick reference

```typescript
// Search for pages
run("notion", "search", { query: "Press Release" })

// Read page as markdown
run("notion", "get-page-markdown", { page_id: "abc123..." })

// Edit page content (replaces all content)
run("notion", "set-page-markdown", { page_id: "abc123...", markdown: "# Updated\n\nNew content" })

// Create a page
run("notion", "create-page", { database_id: "abc...", properties: { Name: { title: [{ text: { content: "New" } }] } } })

// Append blocks
run("notion", "append-blocks", { page_id: "abc...", blocks: [{ type: "paragraph", text: "Added text" }] })
```

## Discovering tool parameters

If you don't know the exact parameters for a tool, read its documentation:

```typescript
run("github", "get-file", { path: "packages/agents/mcp-tools/docs/notion.md" })
run("github", "get-file", { path: "packages/agents/mcp-tools/docs/slack.md" })
```

## Universal filters

These work on any `run(...)` output to reduce payload size:

- `_jq` — JQ expression for filtering/transformation
- `_fields` — Keep only selected top-level fields
- `_limit` — Keep only first N array items

```typescript
run("notion", "search", { query: "API", _limit: 5 })
run("slack", "list-channels", { _jq: ".channels | map({name, id}) | .[0:10]" })
```
