# Tango Specs

Primary product/design specs live here so they are versioned with code.

- `tango-spec.md` is the implementation-facing working spec kept in this repo.
- `juliet-mental-health-agent.md` is the safe product spec for Juliet's role,
  boundaries, memory behavior, and privacy model.
- `voice-state-machine-v2-design.md` is the RETIRED voice state machine
  redesign spec (never implemented past Phase 2; kept as a design reference —
  see `docs/architecture/voice-pipeline-state-machine.md` for the live model).
- `agent-collaboration.md` is the design spec for bounded, observable
  agent-to-agent collaboration across named Tango agents.
- `ollama-provider-parallel-instance.md` is the design spec for a first-class
  `ollama` model provider and a parallel Ollama-backed Tango instance for live
  evaluation alongside production.
- If a separate private notes system exists, treat this repo copy as the
  source of truth for code-facing work and keep it updated alongside changes.

Avoid linking this directory to machine-local note paths.
