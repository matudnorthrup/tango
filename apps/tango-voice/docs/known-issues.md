# Known Issues

## Active

### Node Version Constraints
**Status:** workaround in place
**Impact:** Medium — must use Node 22 for runtime.
- Node 24: fails loading `@discordjs/opus` native binary
- Node 18: misses runtime features the voice app now expects
- **Workaround:** Start the runtime with Node 22 (`nvm use 22` or equivalent).

## Resolved

### Text/Audio Session Sync Drift
**Resolved:** 2026-03-11
**Notes:** The legacy gateway sync path was removed. Voice history now seeds directly from Discord and prompt dispatch goes through Tango only.
See `debugging/audio-text-sync.md` for the historical investigation journal.
