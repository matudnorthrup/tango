# Profile And Update Model

## Layers

Tango loads configuration in this order:

1. Repo defaults from `config/defaults`
2. Profile overrides from `~/.tango/profiles/<profile>/config`
3. Environment variables and CLI flags

For prompts, Tango loads the repo-owned base prompt first and then appends any
profile-owned overlay files from `~/.tango/profiles/<profile>/prompts`.

That overlay surface can include:

- `prompts/agents/<agent-id>/` for agent persona and knowledge
- `prompts/workers/<worker-id>/` for worker-specific guidance
- `prompts/tools/<doc-name>.md` for installation-specific tool instructions
- `prompts/skills/<doc-name>.md` for installation-specific skill guidance

## What Belongs In The Repo

- Product code
- Tests
- Generic prompt base files
- Config schemas and reusable defaults
- Examples and contributor docs

## What Belongs In A Profile

- Agent display names and call signs
- Channel IDs and routing choices
- Schedule overrides
- Private knowledge
- Real account mappings
- Any machine- or person-specific prompt overlays for agents, workers, tools, or skills

## What Belongs In Runtime Data

- SQLite databases
- Browser profiles
- Reports
- Caches
- Logs
- Transcripts and generated artifacts

## Update Behavior

The goal is that `git pull` updates the repo defaults without overwriting the
user's actual setup. Users should not need to edit tracked repo files just to
configure Tango for themselves.

If upstream changes the shape of the config, use:

```bash
npm run cli -- doctor
npm run cli -- config migrate --dry-run
```

Those commands make the active layering explicit before anything is copied.
