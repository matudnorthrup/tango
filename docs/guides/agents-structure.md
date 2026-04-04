# Agent Structure

Source of truth for Tango's agent-system layout, prompt file roles, and where new assistants, workers, tools, and skills should live.

## Directory Layout

```text
agents/
  shared/
    AGENTS.md
    RULES.md
    USER.md
  assistants/
    <assistant-id>/
      soul.md
      knowledge.md   # optional
      workers.md     # optional
  workers/
    <worker-id>/
      soul.md
  system/
    <system-id>/
      soul.md
  tools/
    *.md
  skills/
    *.md
  evals/
```

Related runtime config lives in:

```text
config/
  defaults/
    agents/
      *.yaml
    workers/
      *.yaml
    sessions/
      *.yaml
    projects/
      *.yaml
```

## Agent Types

- `assistants/`: user-facing named agents such as Watson, Sierra, Malibu, and Victor
- `workers/`: delegated task agents with constrained tool access
- `system/`: internal or meta agents such as `dispatch`
- `tools/`: callable-capability docs loaded from worker `tool_contract_ids`
- `skills/`: reusable workflow guidance loaded from worker `skill_doc_ids`
- `shared/`: prompt material loaded for every assembled agent prompt
- `evals/`: prompt snapshots and evaluation fixtures

## File Roles

### `soul.md`

Use for identity, behavior, boundaries, and output expectations.

Put here:
- who the agent is
- how the agent should behave
- what the agent should return

Do not put here:
- detailed tool schemas
- reusable domain workflows that belong to `agents/skills/`
- assistant-specific facts that belong to `knowledge.md`

### `knowledge.md`

Assistant-specific context only. This file belongs under `agents/assistants/<id>/`.

Put here:
- account names
- local preferences
- domain ownership notes
- project facts that are specific to that assistant

Do not put here:
- generic tool usage docs
- reusable workflow patterns needed by multiple workers

### `workers.md`

Assistant-only worker roster and dispatch guidance. This file belongs under `agents/assistants/<id>/`.

Put here:
- which workers the assistant owns
- when to dispatch to each worker
- `<worker-dispatch>` examples
- synthesis guidance for the assistant after a worker returns

### `agents/tools/*.md`

Callable surface area only.

Put here:
- what the tool does
- input fields and parameter rules
- output shape
- hard constraints and caveats required to call it correctly
- short examples

Do not put here:
- general workflow playbooks
- cross-tool heuristics
- long domain policies

### `agents/skills/*.md`

Reusable workflow guidance shared across tasks or workers.

Put here:
- formatting conventions
- interpretation guidance
- cross-tool heuristics
- decision rules for recurring task types

Do not put here:
- assistant-specific facts
- raw API/schema reference

## Placement Rules

Use these rules when deciding where something belongs:

- If it describes a callable interface, put it in `agents/tools/`
- If it describes how to do a recurring task well, put it in `agents/skills/`
- If it is specific to one assistant's world model, put it in that assistant's `knowledge.md`
- If it defines identity or response style, put it in `soul.md`
- If it teaches an assistant when and how to delegate, put it in `workers.md`

Examples:

- Recipe markdown conventions: `agents/skills/recipe-format.md`
- `recipe_write` input/output details: `agents/tools/recipe.md`
- Watson's email accounts: `agents/assistants/watson/knowledge.md`
- `recipe-librarian` response shape: `agents/workers/recipe-librarian/soul.md`

## Prompt Assembly

Prompt assembly is convention-based and currently loads, in order:

1. `<agentDir>/soul.md`
2. `agents/shared/AGENTS.md`
3. `agents/shared/RULES.md`
4. `agents/shared/USER.md`
5. `<agentDir>/knowledge.md`
6. `<agentDir>/workers.md`
7. matching `agents/tools/*.md` from `tool_contract_ids`
8. matching `agents/skills/*.md` from `skill_doc_ids`

Runtime implementation:
- `packages/core/src/prompt-assembly.ts`
- `packages/core/src/config.ts`

## Config Ownership

Prompt assets live with the agents. Runtime configuration stays centralized under `config/`.

### `config/defaults/agents/*.yaml`

Use for assistant or system-agent runtime wiring:
- `provider`
- `access`
- `orchestration.worker_ids`
- `prompt_file`

These files usually point at:
- `../../agents/assistants/<id>/soul.md`
- `../../agents/system/<id>/soul.md`

### `config/defaults/workers/*.yaml`

Use for worker runtime wiring:
- `provider`
- `description`
- `tool_contract_ids`
- `skill_doc_ids`
- `policy`
- `prompt_file`

These files point at:
- `../../agents/workers/<id>/soul.md`

## Adding a New Assistant

1. Create `agents/assistants/<id>/soul.md`
2. Add `knowledge.md` if the assistant needs assistant-specific facts
3. Add `workers.md` if the assistant dispatches to workers
4. Add `config/defaults/agents/<id>.yaml` with `prompt_file`
5. Add or update any session routing in `config/defaults/sessions/*.yaml`
6. If it owns workers, set `orchestration.worker_ids`

## Adding a New Worker

1. Create `agents/workers/<id>/soul.md`
2. Add `config/defaults/workers/<id>.yaml` with `prompt_file`
3. Add `tool_contract_ids` for the tools it should see
4. Add `skill_doc_ids` for any reusable guidance it should load
5. Add governance principal and permissions in `packages/core/src/governance-schema.ts`
6. Add the worker to the owning assistant's `orchestration.worker_ids`
7. Add the worker to the owning assistant's `workers.md`

If the worker introduces a new tool, also follow [adding-tools.md](./adding-tools.md).

## Adding a New System Agent

1. Create `agents/system/<id>/soul.md`
2. Add `config/defaults/agents/<id>.yaml` with `prompt_file`
3. Update the calling code or routing config that invokes it

System agents usually do not need `knowledge.md` or `workers.md` unless the runtime grows to support those patterns intentionally.

## Adding a New Skill

1. Create `agents/skills/<doc-name>.md`
2. Keep it short, reusable, and focused on workflow or judgment
3. Add the skill ID to `SKILL_DOC_MAP` in `packages/core/src/prompt-assembly.ts`
4. Add the skill ID to each worker's `skill_doc_ids`
5. Update `agents/skills/README.md`

## Adding a New Tool

Use [adding-tools.md](./adding-tools.md).

When a new tool also needs reusable operating guidance:
- keep the callable schema in `agents/tools/*.md`
- put the workflow guidance in `agents/skills/*.md`

## Index Files To Keep Current

Update these when the structure changes:

- `agents/README.md`
- `agents/tools/README.md`
- `agents/skills/README.md`
- `README.md` if the repo layout or onboarding guidance changed
- `CLAUDE.md` if implementation conventions changed

## Anti-Patterns

- Putting reusable workflow logic into tool docs
- Burying assistant-specific preferences inside shared skill docs
- Putting worker dispatch instructions into `knowledge.md`
- Adding a new worker without updating both config and the owning assistant's `workers.md`
- Creating prompt assets outside `agents/` without a deliberate runtime reason
