---
status: historical
component: archived-audio-text-sync
priority: low
started: 2026-02-01
tags: [audio, sync, archive, sessions]
---

# Audio/Text Session Sync Investigation

This document is retained only as an archive note.

The OpenClaw-backed audio/text sync system described in earlier revisions of this file was removed on 2026-03-11.

## Final Disposition

- `tango-voice` no longer maintains a runtime WebSocket sync path to OpenClaw.
- Discord is now the source of truth for channel history seeding.
- Voice turns and utility completions route through Tango bridge endpoints.
- The legacy gateway sync service, pollers, and repair scripts referenced by the old investigation were deleted during the Tango cutover.

If pre-removal incident details are needed, use git history for revisions of this file before 2026-03-11.
