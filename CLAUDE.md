# Tango — Claude Code Entry Point

This file exists for Claude Code clients that automatically read `CLAUDE.md`.
Shared Tango operating policy lives in
[`docs/guides/agent-operating-model.md`](docs/guides/agent-operating-model.md).

Before doing project work, read the shared guide and follow it. If this file and
the shared guide differ, the shared guide wins except for Claude-specific tool
behavior in the current Claude Code environment.

## Claude Code Notes

- Use the current Claude Code tool surface for Linear, GitHub, browser, shell,
  tmux, and monitoring work. If an older instruction names a tool that is not
  present, use the equivalent available tool and record the limitation in
  Linear before reporting.
- Do not assume Claude memory lives under only one directory. Use the memory
  discovery order in the shared guide.
- Keep active project state in Linear, not in repo docs or local memory.

## Quick Required Context

Read these first for normal work:

1. [`docs/guides/agent-operating-model.md`](docs/guides/agent-operating-model.md)
2. The first existing project memory index from the shared guide's memory
   discovery order.
3. Any Linear project or issue named by the user or by the memory index.
