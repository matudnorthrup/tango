# Adding a New MCP Tool

Every MCP tool must be wired through the runtime and the prompt system. Missing any step causes silent failures: the tool may exist in code but not be exposed, not be permitted, or not be documented in worker prompts.

For the broader agent-system structure and file-placement rules, see
[`agents-structure.md`](./agents-structure.md).

## Checklist

### 1. Tool implementation

**File:** `packages/discord/src/{domain}-agent-tools.ts`

Add the tool definition and handler inside the appropriate `create*Tools()` factory.

```ts
{
  name: "my_tool",
  description: "What it does, parameters, and key constraints",
  inputSchema: {
    type: "object",
    properties: { /* ... */ },
    required: ["param1"],
  },
  handler: async (input) => {
    return { result: "..." };
  },
}
```

### 2. MCP server registration

**File:** `packages/discord/src/mcp-wellness-server.ts`

If you added a brand-new factory, import it and include it in `allTools`. If you added the tool to an existing factory, this step is already covered.

### 3. Governance registration and permission grants

**File:** `packages/core/src/governance-schema.ts`

Add:
- the tool row in `governance_tools`
- permission rows in `permissions` for every worker that should use it

Then apply the new rows to `data/tango.sqlite` if the database already exists.

### 4. Worker config

**File:** `config/defaults/workers/{worker-name}.yaml`

Add the tool ID to `tool_contract_ids` for each worker that should receive the tool doc and governance summary.

```yaml
tool_contract_ids:
  - existing_tool
  - my_tool
```

If the tool also needs reusable operating guidance, add a `skill_doc_ids` entry for the paired skill doc.

### 5. Tool doc

**File:** `agents/tools/{doc-name}.md`

Add or update the standalone tool doc that describes:
- what the tool does
- input shape
- important schema or parameter details
- output shape
- a few examples

If the tool belongs to an existing shared doc such as `exa.md` or `printing.md`, extend that doc instead of creating a new file.

Keep tool docs focused on callable surface area. Reusable workflow guidance belongs in `agents/skills/*.md`.

### 6. Prompt assembly map

**File:** `packages/core/src/prompt-assembly.ts`

Add the tool ID to `TOOL_DOC_MAP` so worker prompts load the correct doc file.

```ts
const TOOL_DOC_MAP: Record<string, string> = {
  my_tool: "my-doc-file",
};
```

If you added a paired skill doc, also add the skill ID to `SKILL_DOC_MAP`.

## Common mistakes

| Symptom | Missed step |
| --- | --- |
| Tool never shows up in MCP `tools/list` | Step 2 |
| Worker can see the tool but gets permission denied | Step 3 |
| Worker has the permission but prompt lacks the schema/details | Step 5 or 6 |
| Planner summaries or worker prompt assembly miss the tool | Step 4 |

## If the tool belongs to a new worker

You also need:

1. `agents/workers/{worker-name}/soul.md`
2. `config/defaults/workers/{worker-name}.yaml`
3. worker principal entries in `governance-schema.ts`
4. the owning agent's `orchestration.worker_ids`
5. the owning agent's `workers.md` dispatch roster

## Verification

After adding a tool:

```sh
npm run build
npm test
npm run cli -- doctor
sqlite3 "${TANGO_DB_PATH:-$HOME/.tango/profiles/default/data/tango.sqlite}" "SELECT * FROM governance_tools WHERE id = 'my_tool';"
sqlite3 "${TANGO_DB_PATH:-$HOME/.tango/profiles/default/data/tango.sqlite}" "SELECT * FROM permissions WHERE tool_id = 'my_tool';"
```
