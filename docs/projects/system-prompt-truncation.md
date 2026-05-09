# System Prompt Truncation Guard

**Status:** Implementation complete, pending live test
**Linear:** [System Prompt Truncation Guard](https://linear.app/seaside-hq/project/system-prompt-truncation-guard-905feef987d5)

## Problem

Investigation into Claude CLI's `--append-system-prompt` flag revealed a **critical bug** — worse than the suspected truncation issue.

Tango's `ClaudeCodeAdapter` was writing the assembled system prompt to a temp file and passing the **file path** to `--append-system-prompt`. However, this flag accepts a **literal string**, not a file path. As a result, every agent received a string like `/tmp/tango-claude-system-abc123.txt` as its entire system prompt instead of the actual soul.md + knowledge.md + shared rules content.

### Why it wasn't caught sooner

Agents still functioned because Claude Code's default system prompt provides baseline capabilities, and the user message + cold-start context carried enough signal. But personality, domain knowledge, and behavioral rules from soul.md/knowledge.md/RULES.md were completely absent.

## Investigation Findings

| Question | Answer |
|----------|--------|
| Does `--append-system-prompt` read file paths? | **No.** Treats the argument as a literal string. |
| Does `--system-prompt-file` exist? | **No.** Not in Claude CLI v2.1.75. |
| Does `--append-system-prompt-file` exist? | **No.** |
| What is the OS argument length limit? | macOS `ARG_MAX` = 1,048,576 bytes (1MB). |
| Largest Tango agent prompt? | Juliet at ~15KB. Well within 1MB. |
| Is truncation a current risk? | **No.** All prompts are under 15KB. |

### Test methodology

Passed a canary string (`SECRET_CANARY_12345`) via `--append-system-prompt` both inline and as a file path. The inline version was received; the file path was treated as the literal prompt text.

## Fix

**File:** `packages/core/src/claude-code-adapter.ts`

1. **Pass prompt content directly** to `--append-system-prompt` instead of a temp file path
2. **Removed temp file** for system prompt (MCP config still uses temp file since `--mcp-config` accepts file paths)
3. **Added size guard** warning at 512KB to catch future prompts approaching ARG_MAX

## Risk Assessment

- **ARG_MAX headroom:** Current largest prompt (15KB) is 1.4% of the 1MB limit — ample room
- **Future mitigation:** If prompts ever grow past 512KB, the warning will fire. A future Claude CLI version with `--append-system-prompt-file` would be the ideal long-term fix.
