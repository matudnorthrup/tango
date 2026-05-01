# Slack Saved Review: Write to Log Not Daily Note

**Status:** Validation (awaiting next scheduled run)
**Linear:** TGO-445 through TGO-451
**Date:** 2026-04-29

## Problem

The slack-saved-review job (4:45am) was writing directly to the daily note (`Planning/Daily/YYYY-MM-DD.md`), which:
1. Created the daily note before the daily-brief (5:00am) with minimal/incorrect frontmatter
2. Forced the daily-brief to work around an already-created note
3. Put Slack items in the daily note outside the normal aggregation flow

## Solution

- **slack-saved-review** now writes only to its domain log (`Records/Jobs/Slack/YYYY-MM.md`) with detailed task lines (summaries + permalinks + channel names)
- **daily-brief** now reads the Slack domain log and includes a `### Slack Saved Items` section in the morning brief
- The `obsidian_log` post-hook was removed from slack-saved-review to prevent duplicate entries (the agent writes its own detailed entry)

## Key Files Changed

| File | Change |
|---|---|
| `config/defaults/schedules/slack-saved-review.yaml` | Removed daily note writing, added detailed domain log format, removed obsidian_log hook |
| `config/defaults/schedules/daily-brief.yaml` | Added Slack domain log to read list, added Slack Saved Items section to output format |

## Domain Log Format

```markdown
## 2026-04-29 04:47 -- Slack Saved Items Review
**Status:** Done -- 3 items found
**Items:**
- [ ] [Summary of item](permalink) -- #channel-name
- [ ] [Summary of item](permalink) -- #channel-name
```

## Validation

Config-only changes -- no rebuild needed. Bot picks up YAML on next schedule trigger.
- slack-saved-review runs at 4:45am PT
- daily-brief runs at 5:00am PT
