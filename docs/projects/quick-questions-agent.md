# Quick Questions Agent (Charlie)

**Status:** Shipped (text), Voice pending stakeholder validation
**Date:** 2026-04-29
**Linear:** [Charlie — Quick Questions Agent](https://linear.app/seaside-hq/project/charlie-quick-questions-agent-42b9e16dbbd2)

## Summary

Lightweight agent for quick, throwaway questions. No persistence, no memory writes, aggressive context management, web search only.

## What Shipped

### Agent Setup
- **Soul:** `agents/assistants/charlie/soul.md` — concise, direct personality. Explicitly prohibits memory writes.
- **V2 Config:** `config/v2/agents/charlie.yaml` — type: quick, MCP servers: memory (read-only), exa (search/answer), agent-docs. Memory extraction disabled. Low reasoning effort. 4-hour idle timeout. 50% context reset threshold.
- **Defaults Config:** `config/defaults/agents/charlie.yaml` — voice callsigns, response_mode: concise, no workers, no deterministic routing.
- **Session Config:** `config/defaults/sessions/quick-questions.yaml` — 8K context tokens, aggressive summarization (window: 8), high importance threshold (0.8).

### Close Word Migration
- Replaced `'charlie tango'` with `'tango out'` in `BARE_SAFE_CONVERSATIONAL_CLOSES` (`voice-pipeline.ts:947`)
- Also updated the comment reference at line 1394
- Merged to main: commit `54877be`

### Discord Setup
- `#charlie` channel: `1499163931636138135` (Agents category)
- `#charlie-test` channel: `1499163946643493025` (test-channels category)

## Test Results

### Text (Validated)
- "What temperature should I cook chicken breast to?" → "165°F (74°C) internal temperature." (3.5s)
- "What's the capital of Montana?" → "Helena." (3.9s)
- No memory writes observed in logs
- Agent routes correctly, sessions auto-register

### Voice (Pending)
- "Charlie" callsign registered in voice router
- Kokoro voice: af_aoede assigned
- Requires manual voice test by stakeholder

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Name | Charlie | Stakeholder decision. Required close word migration. |
| Voice | af_aoede | Distinct from existing agents (Watson: am_adam, Sierra: af_heart, Juliet: af_bella) |
| Memory | Read-only MCP, extraction disabled | Can read user context but never writes. Soul prompt explicitly prohibits memory_add/memory_reflect. |
| Context | 8K tokens, 50% reset threshold, 4hr idle timeout | Aggressive cleanup for ephemeral use |
| Reasoning | Low | Quick answers don't need deep reasoning |
| Close word | "tango out" replaces "charlie tango" | Avoids callsign conflict |

## Key Files
- `agents/assistants/charlie/soul.md`
- `config/v2/agents/charlie.yaml`
- `config/defaults/agents/charlie.yaml`
- `config/defaults/sessions/quick-questions.yaml`
- `apps/tango-voice/src/pipeline/voice-pipeline.ts` (close word change)
