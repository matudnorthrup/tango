# Docs Project Cleanup Retro

Date: 2026-05-30

## Summary

Tango previously used `docs/projects/` for active project plans, approval
gates, validation notes, and work breakdowns. Linear is now the source of truth
for active work, so this cleanup retired stale active-status markdown and left
`docs/projects/` for durable legacy writeups only.

Deleted files remain recoverable through git history. If a retired item needs
active work again, recreate or reopen it in Linear first, then add only stable
architecture/spec/retro material back to the repo.

## Retired Active Project-State Docs

| Former file | Reason | Destination |
| --- | --- | --- |
| `docs/projects/deep-thinking-bypass.md` | Old discovery approval gate | Existing Linear project: Deep-Thinking Escape Hatch |
| `docs/projects/route-classifier-confidence-recency.md` | Discovery/implementation milestone plan | Existing Linear project: Route Classifier Confidence & Recency Weighting |
| `docs/projects/voice-reply-routing-bug.md` | Untracked implementation backlog | Migrated into TGO-567 evidence; create a fresh Tango issue if the bug is still live |
| `docs/projects/voice-reply-routes-to-last-speaker.md` | Implementation plan/status | Existing Linear project: Voice Reply Routes to Last Speaker |
| `docs/projects/system-prompt-truncation.md` | Old live-test gate | Existing Linear project: System Prompt Truncation Guard |
| `docs/projects/voice-queue-mode-stuck.md` | Implementation plan/status | Existing Linear project: Voice Queue Mode Wake Word Fix |
| `docs/projects/native-image-attachment-support.md` | Discovery design doc under active Linear project | Existing Linear project: Native Image/Attachment Support |
| `docs/projects/watson-routing-newpost-bug.md` | Awaiting fix approval | Migrated into TGO-567 evidence; create a fresh Tango issue if still reproducible |
| `docs/projects/workout-close-confirmation.md` | Awaiting approval | Existing Linear project: Malibu Workout Close Confirmation |
| `docs/projects/daily-brief-architecture.md` | Ready-for-implementation project spec | Migrated into TGO-567 evidence; durable daily-brief docs now live under `docs/guides/` and remaining work belongs in Linear |
| `docs/projects/ipad-health-sync.md` | In-progress implementation plan | Existing Linear project: iPad Health Auto-Sync |
| `docs/projects/narration-guard-read-queries.md` | In-progress implementation plan | Existing Linear project: Narration Guard Read-Query Gap |
| `docs/projects/sierra-duplicate-message-bug.md` | Deployed, awaiting live validation | Migrated into TGO-567 evidence; reopen in Linear if validation is still needed |
| `docs/projects/slack-saved-log-not-daily-note.md` | Awaiting scheduled validation | Existing TGO-445 through TGO-451 issues |
| `docs/projects/fatsecret-harness-issue.md` | Placeholder Linear field; no code fix needed | Existing Linear issue: TGO-291 |
| `docs/projects/victor-as-cos.md` | Superseded Stage 2 implementation/status doc | Superseded by Victor Operations Chief direction and Linear project history |
| `docs/projects/victor-cos-stage3-persistent-bridge.md` | Superseded discovery plan | Superseded by Victor Runtime Redesign Audit and Victor Operations Chief direction |
| `docs/projects/victor-cos-pm-brief.md` | PM handoff brief for completed/superseded discovery | Superseded by Linear project history and durable CoS/PM guides |

## Follow-Ups

- Consolidate remaining long-lived architecture and retro material under
  `docs/architecture/`, `docs/specs/`, and `docs/retros/`.
- Continue replacing real IDs, machine-local paths, and credential snippets in
  older retained writeups as they are migrated.
- Move any rediscovered live work into Linear before editing repo docs.
