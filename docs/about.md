# About Tango

Tango is a multi-surface agent runtime built around a small number of stable
ideas:

- Named agents own user-facing behavior and coordination.
- Workers execute narrower tasks with clearer tool contracts.
- Sessions, projects, workflows, and schedules are configured in YAML.
- Prompts are assembled from shared docs, tool docs, skills, and optional
  profile overlays.
- State is persisted in SQLite so sessions and provider continuity survive
  restarts.

## Architecture

- `packages/core` contains the shared runtime: config loading, storage,
  scheduling, governance, prompt assembly, provider abstractions, and runtime
  path resolution.
- `packages/discord` hosts the Discord bot runtime plus MCP surfaces and
  application-specific tools.
- `packages/voice` provides shared routing and address-book logic for voice
  surfaces.
- `apps/tango-voice` is the native voice app built on the same config and
  runtime model.
- `packages/cli` exposes operator tooling for path inspection, config tracing,
  prompt tracing, migration, and health checks.

## Configuration Model

The repository now uses layered configuration:

1. Repo defaults from `config/defaults`
2. Profile overrides from `~/.tango/profiles/<profile>/config`
3. Environment variables and CLI flags

Prompt assembly follows the same shape: base prompt files live in the repo,
while user-specific persona and knowledge can live in
`~/.tango/profiles/<profile>/prompts`.

## Why The Profile Split Exists

Historically, Tango mixed source code, personal config, and runtime data inside
one working tree. That made updates risky and made open-sourcing effectively
impossible. The profile-aware model fixes that by making personal state an
overlay instead of a fork of the repo.
