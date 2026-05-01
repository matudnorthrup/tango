# Slack Saved Items Daily Review

**Status:** Shipped (Phase 2: native stars.list)
**Linear:** TGO-401 through TGO-408
**Owner:** PM

## Problem

Devin saves/bookmarks items in Slack throughout the day but has no systematic way to review and action them. They get forgotten.

## Solution

A daily scheduled job that:
1. Scans Slack channels for messages Devin has reacted to with `:bookmark:`
2. Summarizes each bookmarked item
3. Writes them as tasks in the Obsidian daily note under `## Slack Saved Items`
4. Logs to `Records/Jobs/Slack/YYYY-MM.md` for daily brief aggregation

## Auth Decision

**Phase 1 (shipped 2026-04-27):** Used `:bookmark:` emoji reactions as proxy — bot token can't call `stars.list`.

**Phase 2 (shipped 2026-04-28):** Devin added `stars:read` user scope to the Watson Slack app and stored the user token in 1Password as "Watson Slack User Token". The `saved_items` action now calls `stars.list` with the user token directly. The user token is ONLY used for `stars.list`; all other Slack API calls use the bot token.

## Architecture

### New slack tool action: `saved_items`

Added to `packages/discord/src/slack-tools.ts`. Calls `stars.list` with the Slack user token, filters to message-type items, and fetches permalinks via `chat.getPermalink` (bot token).

### Schedule: `slack-saved-review.yaml`

- **Cron:** 4:45am Pacific (before 5:15am daily brief)
- **Agent:** Watson worker
- **Task:** Fetch saved items → summarize → write to daily note + domain log
- **Delivery:** mode none (output to Obsidian only)

### Obsidian Output

**Daily note** (`Planning/Daily/YYYY-MM-DD.md`):
```markdown
## Slack Saved Items

- [ ] [Summary of saved item](https://slack-permalink) — #channel-name
- [ ] [Summary of saved item](https://slack-permalink) — #channel-name
```

**Domain log** (`Records/Jobs/Slack/YYYY-MM.md`):
```markdown
## 2026-04-27 04:45 — Slack Saved Items Review

**Status:** Done — 3 items found
**Summary:** Saved messages from #engineering (1), #random (2)

No flagged items.
```

## Validation Results (2026-04-27) — Phase 1

1. **Schedule loaded**: `slack-saved-review` registered, next fire 4:45am PDT
2. **Empty run**: Manual trigger found 0 items for Devin (correct — no bookmarks). Domain log created at `Records/Jobs/Slack/2026-04.md` with empty-run entry. Daily note correctly skipped.
3. **Items-found path**: Direct tool call with bot's user ID found 1 bookmarked message in `#share-random` with correct channel name, text, user, timestamp, and permalink.
4. **Build**: Clean on main, no TypeScript errors.
5. **Bot restart**: Clean startup, all schedules loaded.

## Validation Results (2026-04-28) — Phase 2: stars.list

1. **stars.list API**: Returns 17 saved items (10 messages, 4 channels, 3 IMs) with user token
2. **Message fields**: Correct structure — `channel`, `message.text`, `message.user`, `message.ts` all present
3. **Permalinks**: `chat.getPermalink` with bot token generates valid Slack links for saved messages
4. **Build**: Clean on main after merge, no TypeScript errors
5. **Bot restart**: Clean startup, `slack-saved-review` schedule loaded (next fire 4:45am PDT)
6. **End-to-end schedule**: Manual test blocked by daily completion scope (already ran today with old code); next auto-run at 4:45am will use new `saved_items` action

## Key Files

- `packages/discord/src/slack-tools.ts` — `saved_items` action (uses user token for stars.list)
- `packages/discord/src/deterministic-router.ts` — intent routing (`slack` + `file_ops` tools)
- `config/defaults/schedules/slack-saved-review.yaml` — schedule config (4:45am Pacific)
- `config/defaults/schedules/manual-test-slack-saved-review.yaml` — manual test variant
- `config/defaults/intent-contracts/productivity.slack_saved_review.yaml` — intent contract
- `agents/skills/slack-digest.md` — reference for Slack data handling patterns
