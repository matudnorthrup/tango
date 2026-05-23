# Victor Operations Chief Redesign

**Status:** Implementation
**Owner:** Codex
**Linear:** [Victor Operations Chief Redesign](https://linear.app/seaside-hq/project/victor-operations-chief-redesign-08ef1c62f460)
**Date:** 2026-05-23

## Problem

Victor's previous design made him a Tango development agent. In practice, a
persistent agent working on the same system that keeps it alive is brittle:
restarts interrupt its own work, code changes can disrupt its runtime, and
review/merge/validation are better handled by Codex or Claude Code outside the
agent loop.

The user still needs a dedicated long-horizon agent for sensitive operations:
separation agreement follow-through, business operations, side-hustle planning,
attorney/CPA question packets, and durable project tracking.

## Design

Victor is now an operations chief rather than a developer.

- **Linear is the deterministic task system** for durable projects, issues,
  milestones, blockers, owners, and validation notes.
- **Obsidian is the context system** for source indexes, decision logs, document
  maps, meeting notes, and working packets.
- **Memory remains continuity context**, not the source of truth for project
  status.
- **Development work routes out of Victor** to Codex or Claude Code outside
  Tango.

Victor's worker surface is:

- `operations-assistant` for Linear, Obsidian, and memory-backed operational
  project work.
- `note-librarian` for note-specific Obsidian reads and updates.

Deterministic operations intents:

- `operations.project_review` — read Linear/Obsidian state and summarize status.
- `operations.project_update` — update Linear tracking and capture supporting
  context.
- `operations.decision_packet` — prepare source-grounded attorney, CPA,
  business, or separation decision packets.

## Boundaries

Victor can organize records, identify open questions, prepare options, draft
materials for review, and track follow-through.

Victor must not:

- give final legal, tax, accounting, investment, or therapy advice
- tell the user what to sign, file, disclose, withhold, concede, or demand as a
  legal conclusion
- hide assets, evade disclosures, violate orders, retaliate, harass, or coerce
- move money, mutate finance source records, send external communications, or
  perform consequential updates without explicit approval
- change Tango code

Foxtrot owns finance source-of-truth work. Sierra owns current public research.
Watson owns personal admin. Juliet owns emotional/conflict/parenting support.

## Validation Plan

- Unit/config tests: Victor legacy and v2 configs load as operations-focused and
  expose Linear while removing developer MCP servers.
- Deterministic routing tests: Victor receives operations intents through
  `operations-assistant` and no longer uses developer repo/code intents.
- Live Discord smoke: Victor can answer a legal-safety prompt without legal
  conclusions and can use Linear for project status.
- Restart validation: the running bot loads the new Victor config after restart.

Do not ship or merge until the Linear validation issue has documented live test
results.

## Validation Results

2026-05-23:

- Restarted Tango Discord from this branch; bot connected and loaded Victor with
  `tools.mode=off`.
- Confirmed the shared MCP server exposed the `linear` tool and resolved the
  Seaside HQ Tango API key.
- Voice bridge live read: Victor found `Victor Operations Chief Redesign` in
  Linear and correctly summarized the project state and issue statuses.
- Worker live read: `operations-assistant` used the narrowed `linear` tool
  surface to review the same project and returned TGO-488 through TGO-491 with
  statuses.
- Safety live prompt: Victor declined to decide whether the user should sign a
  separation agreement and redirected to attorney review plus a question packet.
