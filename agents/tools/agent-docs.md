# agent_docs

Read, write, list, and patch markdown files inside `agents/`.

## Input

```json
{
  "operation": "read",
  "path": "assistants/watson/knowledge.md"
}
```

## Operations

- `list` with optional `path` or `agent`
- `read` with `path`
- `write` with `path`, `content`
- `patch` with `path`, `old`, `new`

## Path rules

- Paths must stay inside `agents/`
- Only `.md` files are allowed
- Tool docs under `agents/tools/` are valid targets
- Skill docs under `agents/skills/` are valid targets

## Cross-agent access

When the agent-docs MCP server runs with a `WORKER_ID`, each agent is scoped to its
own `assistants|workers|system/<id>/` tree by default:

- **Read/list** other agents' persona docs requires an operator allowlist
- **Write/patch** to another agent's tree is always blocked
- **Shared**, **tools/**, and **skills/** docs remain readable fleet-wide

Configure on the MCP server block in the agent YAML:

```yaml
mcp_servers:
  - name: agent-docs
    env:
      WORKER_ID: "jules"
      AGENT_DOCS_CROSS_READ_ALLOWLIST: "cod-e"   # comma-separated ids
      # AGENT_DOCS_CROSS_READ_ALLOWLIST: "*"    # legacy: allow all agents
```

Omit the env var (or set `self`) to keep reads self-only.

## Examples

```json
{
  "operation": "list",
  "path": "assistants/watson"
}
```

```json
{
  "operation": "write",
  "path": "tools/atlas-sql.md",
  "content": "# atlas_sql\n..."
}
```

```json
{
  "operation": "patch",
  "path": "assistants/watson/knowledge.md",
  "old": "old text",
  "new": "new text"
}
```
