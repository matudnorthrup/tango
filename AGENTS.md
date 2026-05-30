# Tango — Codex Entry Point

This file exists for Codex clients that automatically read `AGENTS.md`.
Shared Tango operating policy lives in
[`docs/guides/agent-operating-model.md`](docs/guides/agent-operating-model.md).

Before doing project work, read the shared guide and follow it. If this file and
the shared guide differ, the shared guide wins except for Codex-specific tool
behavior in the current Codex environment.

## Codex Notes

- Use `codex/` as the default branch prefix when creating branches.
- Use the current Codex tool surface for Linear, GitHub, browser, shell, and
  automation work. If an older instruction names a Claude-only tool such as
  `CronCreate`, use the equivalent available Codex automation/monitoring tool,
  or record the limitation in Linear before reporting.
- Do not assume Codex memory lives under only one directory. Use the memory
  discovery order in the shared guide.
- Keep active project state in Linear, not in repo docs or local memory.

## Quick Required Context

Read these first for normal work:

1. [`docs/guides/agent-operating-model.md`](docs/guides/agent-operating-model.md)
2. The first existing project memory index from the shared guide's memory
   discovery order.
3. Any Linear project or issue named by the user or by the memory index.
