# Slack Saved Items Daily Review

**Status:** Validation (Phase 3: recent-item filter and cleanup-scope hardening live)
**Linear:** TGO-401 through TGO-408
**Owner:** PM

## Problem

The user saves/bookmarks items in Slack throughout the day but has no systematic way to review and action them. They get forgotten.

## Solution

A daily scheduled job that:
1. Scans the user's recent Slack saved messages through `stars.list`
2. Summarizes each bookmarked item
3. Logs them to `Records/Jobs/Slack/YYYY-MM.md` for daily brief aggregation
4. Attempts to unsave processed items so they do not repeat

## Auth Decision

**Phase 1 (shipped 2026-04-27):** Used `:bookmark:` emoji reactions as proxy — bot token can't call `stars.list`.

**Phase 2 (shipped 2026-04-28):** The user added `stars:read` user scope to the Watson Slack app and stored the user token in 1Password as "Watson Slack User Token". The `saved_items` action now calls `stars.list` with the user token directly. The user token is used for `stars.list` and `stars.remove`; all other Slack API calls use the bot token.

**Phase 3 (2026-05-25):** The job was hardened after repeated `missing_scope` failures on `stars.remove`.

- `saved_items` defaults to `since_hours: 48` so old saved items from 2022-2023 do not keep polluting the daily brief when cleanup cannot run.
- `remove_star` returns a structured `missing_scope` warning instead of throwing a generic tool failure.
- The schedule writes only to the Slack domain log. Morning planning owns daily note updates.
- The user added `stars:write` and live validation confirmed the Watson Slack user token can remove message stars.
- The stale saved-message backlog was cleared on 2026-05-25. Slack still has seven starred non-message objects, which this job intentionally skips.

## Architecture

### New slack tool action: `saved_items`

Added to `packages/discord/src/slack-tools.ts`. Calls `stars.list` with the Slack user token, filters to recent message-type items, and fetches permalinks via `chat.getPermalink` (bot token).

### Schedule: `slack-saved-review.yaml`

- **Cron:** 4:45am Pacific (before 5:15am daily brief)
- **Agent:** Watson worker
- **Task:** Fetch recent saved items → summarize → write to domain log → try to unsave processed items
- **Delivery:** mode none (output to Obsidian only)

### Obsidian Output

**Domain log** (`Records/Jobs/Slack/YYYY-MM.md`):
```markdown
## 2026-04-27 04:45 — Slack Saved Items Review

**Status:** Done — 3 items found
**Items:**
- [ ] [Summary of saved item](https://slack-permalink) — #channel-name
```

## Validation Results (2026-04-27) — Phase 1

1. **Schedule loaded**: `slack-saved-review` registered, next fire 4:45am PDT
2. **Empty run**: Manual trigger found 0 items for the user (correct — no bookmarks). Domain log created at `Records/Jobs/Slack/2026-04.md` with empty-run entry. Daily note correctly skipped.
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

## Validation Results (2026-05-25) — Phase 3: cleanup hardening

1. **Recent filter**: `saved_items` defaults to a 48-hour window and can still include all message saves with `since_hours: 0`.
2. **Cleanup scope**: Live `remove_star` succeeded after `stars:write` was added to the Watson Slack app.
3. **Backlog cleanup**: Removed all 10 stale saved messages through the Slack tool path. Recheck showed `all_count: 0` and `recent_count: 0` for message saves.
4. **Non-message stars**: Slack still reported 7 non-message starred objects. The review job skips those by design.
5. **Build/runtime**: `slack-saved-review` loaded successfully after `npm run bot:restart`.

## Key Files

- `packages/discord/src/slack-tools.ts` — `saved_items` action (uses user token for stars.list)
- `packages/discord/src/deterministic-router.ts` — intent routing (`slack` + `file_ops` tools)
- `config/defaults/schedules/slack-saved-review.yaml` — schedule config (4:45am Pacific)
- `config/defaults/schedules/manual-test-slack-saved-review.yaml` — manual test variant
- `config/defaults/intent-contracts/productivity.slack_saved_review.yaml` — intent contract
- `agents/skills/slack-digest.md` — reference for Slack data handling patterns

## Open Validation

- Confirm the next scheduled run logs only recent saved items.
- Confirm daily brief reads the Slack domain log accurately.
