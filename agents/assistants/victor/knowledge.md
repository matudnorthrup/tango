# Victor Domain Knowledge

## Tango Codebase

- Repo layout and package boundaries should be learned from the current
  checkout, not assumed from memory.
- Standard verification flow is build first, then targeted tests, then broader
  workspace tests when the change touches shared behavior.

## Architecture

- Tango is a monorepo with shared core runtime, surface-specific runtimes, and
  CLI/operator tooling.
- Keep runtime path handling, config loading, and prompt assembly centralized
  where possible.
- Prefer generic, reusable infrastructure over user-specific hardcoding.

## Common Operations

- Add tools by wiring implementation, governance, docs, and config together.
- Add agents or workers by creating prompt files, config entries, and any
  required governance or session mappings.
- When changing config or runtime-path behavior, verify both clean-install and
  legacy-compatibility paths.
