# Retro: Private Data Committed to Repo

**Date:** 2026-05-01
**Severity:** High — personal data exposed in shared repository
**Status:** Resolved — data scrubbed from history, guardrails added

## What Happened

Six files containing deeply private personal information were committed to the Tango repo and pushed to the remote:

- `agents/assistants/juliet/context/violence-chronology.md`
- `agents/assistants/juliet/context/relationship-briefing.md`
- `agents/assistants/juliet/context/accusation-pattern.md`
- `agents/assistants/juliet/context/relationship-patterns.md`
- `agents/assistants/juliet/context/relationship-timeline.md`
- `agents/assistants/juliet/context/quotes-archive.md`

These files contained verbatim personal messages, domestic violence details, legal information, and relationship history. They were part of the Juliet mental health agent's context but should never have been in the repository.

## How It Got In

1. A PM agent was tasked with committing all outstanding changes to bring the repo up to date
2. The PM found the Juliet context files as untracked files and asked whether to include them
3. The CoS (monitoring agent) approved with "they're part of the agent" — technically true but missing the privacy distinction between agent *framework* (repo) and agent *personal data* (profile)
4. The PM committed them in commit `c40c41d` ("Add Charlie + Juliet agents") and pushed to remote

**Root cause:** No guardrail distinguishing "agent configuration" (belongs in repo) from "agent personal context" (belongs in profile layer). The approval was made on functional grounds without considering data privacy.

## Resolution

1. Files moved to profile layer: `~/.tango/profiles/default/config/agents/juliet/context/`
2. Symlink created at original path so Juliet agent still reads them
3. `.gitignore` updated: `agents/assistants/*/context/` and `agents/assistants/*/context` patterns added
4. Full git history scrubbed with `git-filter-repo` — files do not exist in any historical commit
5. Force-pushed clean history to remote

## Guardrails Added

- `.gitignore` pattern `agents/assistants/*/context/` prevents any agent's personal context directory from being committed
- This applies to ALL agents, not just Juliet — any future agent with a `context/` subdirectory is automatically excluded

## Lessons

1. **Agent architecture needs a clear system/personal boundary.** Agent definitions (soul.md, knowledge.md, config YAML) are system-level. Agent personal context (user-specific data the agent needs) is profile-level. These must live in different layers.

2. **PM agents need privacy-aware review criteria.** When a PM or CoS approves files for commit, the check shouldn't just be "is this functional?" — it should also be "does this contain personal data?" Automated agents lack intuition about what's private.

3. **Batch commits are risky.** The "commit everything and push" task mixed 50+ files across different sensitivity levels. A more careful approach would review files in categories, flagging anything in agent-specific directories for human review.

4. **Profile layer convention needs documentation.** The rule "personal data lives in `~/.tango/profiles/`" was understood but not enforced. The `.gitignore` pattern now enforces it for agent context, but other categories (personal schedule prompts, personal tool configs) may need similar treatment.

## Future Work

- Audit other agent directories for personal data that shouldn't be in repo
- Consider whether `agents/assistants/*/knowledge.md` files should also be profile-layer (they contain user-specific behavioral rules)
- Document the system/profile boundary in CLAUDE.md or a developer guide
- Add a pre-commit hook that warns on files matching sensitive patterns
