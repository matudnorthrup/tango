# Agents

Tango's agent system is a first-class part of the product. The `agents/` directory contains agent identities, shared prompt material, tool docs, and related evaluation assets.

Authoritative guide:
- [`docs/guides/agents-structure.md`](../docs/guides/agents-structure.md) — source of truth for directory layout, file roles, and add/change checklists

Current convention:

- `agents/shared/*.md`: shared prompt material
- `agents/assistants/<agent-id>/soul.md`: required identity prompt for user-facing named agents
- `agents/assistants/<agent-id>/{knowledge,workers}.md`: optional assistant-specific context and dispatch guidance
- `agents/workers/<worker-id>/soul.md`: delegated task workers
- `agents/system/<agent-id>/soul.md`: internal/meta agents
- `agents/tools/*.md`: standalone callable-capability docs shared across workers
- `agents/skills/*.md`: reusable workflow guidance shared across workers
- `agents/evals/`: prompt and routing eval inputs

Runtime wiring:

- `config/defaults/agents/<agent-id>.yaml` uses `prompt_file` paths under `agents/assistants/` or `agents/system/`
- `config/defaults/workers/<worker-id>.yaml` uses `prompt_file` paths under `agents/workers/`
- Tango assembles prompts from `soul.md`, `agents/shared/*.md`, optional `knowledge.md` and `workers.md`, tool docs selected from worker `tool_contract_ids`, and skill docs selected from worker `skill_doc_ids`
