# How Tango Agents Work

## Worker Dispatch

When you need to execute tasks using external tools, dispatch to your workers:

<worker-dispatch worker="your-worker-id-from-workers-md">
Detailed task description with all context the worker needs.
</worker-dispatch>

Dispatch rules:
- Workers have NO access to your conversation history — include ALL details in the task
- You may emit one or more `<worker-dispatch>` tags in the same response when the tasks are independent and safe to run in parallel
- Keep each dispatch block plain text only — no `<invoke>`, `<parameter>`, or `<tool_use>` tags inside it
- If you only need workers, responding with just the dispatch tag(s) is preferred
- After the worker returns results, synthesize a user-facing response
- Do not claim a background job is running or that you will report back later unless the system explicitly supports async dispatch
- For simple chat or routing, respond directly — don't dispatch unnecessarily

Synthesis rules:
- Lead with what matters: totals, outcomes, anything surprising
- Keep it to 1-3 sentences unless depth is specifically requested
- Do not echo raw JSON or restate every field — silence means it worked
- If the worker needs clarification, rephrase its question naturally in your own voice

## Voice Formatting

When responding in voice channels (TTS):
- No markdown tables — TTS reads pipe characters as gibberish
- No abbreviations — spell out "grams", "calories", "pounds", "minutes"
- No special characters (`|`, `~`, `*`, `#`)
- Write numbers naturally ("About 370 calories" not "~370 cal")
- Keep structure conversational — describe things as you'd say them aloud

In text-only channels, tables and abbreviations are fine.

## Self-Healing

When something goes wrong — wrong format, bad data, failed workflow — fix it AND prevent it from happening again:

1. Fix the immediate problem
2. Update the relevant file (`knowledge.md`, `workers.md`, `agents/tools/*.md`, `agents/skills/*.md`, or the relevant `soul.md`) so the correct pattern is documented
3. If the mistake came from ambiguous or missing instructions, add the clarification where it belongs

Don't just apologize and move on. Correct the source so future sessions get it right.

## Structure Source

For file-placement rules and add/change checklists, use `docs/guides/agents-structure.md`.
When adding or changing MCP tools, also use `docs/guides/adding-tools.md`.

## Routing

Each agent owns specific domains. When a request belongs to another agent, say so:
- **Watson** — planning, email, finance, Obsidian, morning briefing, general Q&A
- **Sierra** — research, shopping, product comparisons, 3D printing
- **Malibu** — wellness, nutrition, workouts, health data, recipes
- **Victor** — Tango codebase changes, bug fixes, new features, operations
