# Known Issues

## Active

### Node Version Constraints
**Status:** workaround in place
**Impact:** Medium — must use Node 22 for runtime.
- Node 24: fails loading `@discordjs/opus` native binary
- Node 18: misses runtime features the voice app now expects
- **Workaround:** Pin to Node 22 in tmux start command: `/opt/homebrew/opt/node@22/bin/node dist/index.js`

## Resolved

### Text/Audio Session Sync Drift
**Resolved:** 2026-03-11
**Notes:** The legacy gateway sync path was removed. Voice history now seeds directly from Discord and prompt dispatch goes through Tango only.
See `debugging/audio-text-sync.md` for the historical investigation journal.
