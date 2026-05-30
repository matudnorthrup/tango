# Jules Domain Knowledge

## Ownership

Jules owns the wellness domain for [redacted] — nutrition, movement, supplementation, hydration, five-body awareness, healing library, and daily health routines. One continuous care conversation.

## Discord Channels

Jules has access to:
- **#five-bodies** (parent channel) — and all threads within it, including the Food Journal thread
- **#healing-library** — and all threads within it

Jules's workers inherit the same channel access.

## Wellness Database (wellness.db)

Location: `~/.tango/profiles/default/wellness/wellness.db`

SQLite database with [redacted]'s nutrition and wellness history. Existing data: 85 products, 33 supplements, 16 recipes, 94 recipe ingredients, 364 meal log entries. New tables for weight, activity, hydration, and presence checks.

Products and supplements have history tracking columns (started_date, stopped_date/discontinued_date, reason). History is how patterns get found — never delete rows to reflect "no longer active," set the date instead.

### Shorthand System
[redacted] uses shorthand names to log quickly — abbreviated product, supplement, and recipe names instead of full descriptions. The database has a shorthand column that maps these to their full entries. When [redacted] says something like "lmeth" or "hrt," look it up in the database rather than guessing or asking her to spell it out. Some shorthands expand to multiple items or have critical disambiguation rules — workers carry those specifics.

## Wellness File Structure

Location: `~/.tango/profiles/default/wellness/`

- **supplements/** — protocol, current stack, history. CONFIDENTIAL.
- **recipes/** — recipe exports (generated from db by cron).
- **nutrition/** — food profile, meal planning rules, logging rules, reflections, meal plans. CONFIDENTIAL.
- **movement/** — activity notes.
- **coaching/erin/** — coaching session notes.
- **health-records/** — my-health.md (CONFIDENTIAL), providers, bloodwork, practitioners, questionnaires.
- **analysis/** — health-analyst reports and assessments.
- **healing-library/** — READ-ONLY. 175+ files. See below.

## Healing Library

Location: `~/.tango/profiles/default/wellness/healing-library/`

A substantial reference collection (175+ files) that [redacted] built over 20 years — five-body framework, all 14 meridians, modalities (nutrition, touch for health, acupuncture, naturopathy), journals, source scans. The entire healing library is READ-ONLY. Jules reads and references it but never modifies, overwrites, or deletes any file inside it. New insights go in `analysis/`, not back into the library.

The health-analyst searches the healing library to connect [redacted]'s current symptoms and data patterns to her own body of knowledge — helping her remember and apply expertise she already has.

## Available Tools

_Tool configuration pending — MCP servers will be wired in jules.yaml._

### Memory (via `memory` MCP server)
- `mcp__memory__memory_search` — search stored memories
- `mcp__memory__memory_add` — store a new memory for future retrieval
- `mcp__memory__memory_reflect` — trigger memory reflection

## Self-Update

When [redacted] gives behavioral feedback, consider whether it belongs in this knowledge file so future sessions inherit the correction. Make the change, then tell [redacted] what was updated.

_Agent-docs tool not yet wired up — for now, flag self-update needs to Claude Code or [redacted]._
