# Personal-Data Repo/Profile Split Retro

Date: 2026-06-25

Follow-through on [`private-data-in-repo-2026-05.md`](private-data-in-repo-2026-05.md),
whose "Future Work" was to audit the remaining agent directories. This retro
covers the full audit + migration that genericized the repo and moved one
operator's personal data into the profile layer.

## What Happened

A five-surface audit (agents, config, skills/tools, scripts/packages, docs) found
personal data still tracked across the repo even though the May guardrails (the
privacy-scan gate, gitignored `USER.md`/`context/`) were in place:

- **config/** — 19 real Discord channel/smoke-test snowflake ids (the `-ollama`
  clones, `wellness`, `cod-e`, `ollama-test`, and two "sanitized" classic configs
  that still leaked `smoke_test_channel_id`), avatar URLs embedding real Discord
  user ids, an internal remote-MCP endpoint, and `~/Documents/main` vault paths /
  a work email / real Slack channel names across 40+ schedules.
- **agents/skills + tools** — real RHR/HRV baselines, a supplement protocol,
  sinking-fund + bank-suffix detail, the `DEVIN_REVIEWED_AND_APPROVED_SUBMISSION`
  approval token, an LDS/church workflow, real Lunch Money category ids.
- **agents/assistants** — `porter` (church calling), `victor` (separation/legal),
  `juliet` (family) carried private context as repo defaults.
- **scripts/packages** — a real account suffix + name in a test fixture, real
  health/provider data in eval seeds, a `user:devin` storage special-case, and
  vendor regexes hardcoding personal merchants.
- **docs/** — bank/invoice/GPS/bodyweight/health values in project writeups.

## How It Got In / Why The Gate Missed It

- The privacy-scan **passed** only because the allowlist had a large
  "LEGACY: real snowflake ids … migrate later" block parking every leaking config
  file. A deferred follow-up that never happened became a standing exemption.
- The scanner's machine-path check only matched `/Users/...`, so `~/Documents/...`
  vault paths slipped through. The denylist (operator-maintained, profile-layer)
  had only a handful of terms, so most personal prose was never matched.
- `profile-model.md` documented a `prompts/skills|tools/` overlay, but it was
  **never wired** — `resolveTangoProfileSkillPromptsDir`/`ToolPromptsDir` had zero
  consumers and `agent_docs` read skills/tools straight from the repo. So there was
  no place for personal skill/tool detail to live except the repo doc itself.

## Resolution

- Wired the skills/tools profile overlay into `agent_docs` (read-time append).
- Migrated config real ids/avatars/endpoint to the profile and genericized the
  repo to placeholders; **proved the merged runtime config byte-identical** before
  and after against a full pre-migration snapshot (21 agents + 36 sessions).
- Genericized personas/skills/tools; moved the personal specifics to profile
  prompt overlays. Redacted the docs.
- Config-drove the reimbursement vendor list (profile-merge) + AI Slack channels;
  genericized the approval token, eval seeds, and test fixtures. Tests are now
  hermetic (seed their own generic config) and pass with an empty profile.
- Hardened `privacy-scan.sh` (now flags `~/{Documents,Desktop,Downloads,clawd}/`)
  and removed the legacy allowlist block — the gate passes with no config exemptions.
- Live-validated on the real Discord pipeline: `malibu` returned its health
  baselines, `foxtrot` its sinking-fund names, `porter` its faith tradition — all
  from profile overlays, with a fully genericized repo.

## Guardrails / Tooling Added

- `scripts/migrate-personal-config-to-profile.mjs`, `migrate-personal-prompts-to-profile.mjs`,
  and the unified `migrate-personal-context-to-profile.sh` (USER.md → config →
  prompts → audit). Reusable: any operator runs it to snapshot their personal data
  before pulling a genericized release.
- `privacy-scan.sh` `~/` machine-path detection.
- `agent_docs` now tells agents to keep personal additions in the profile overlay,
  not the repo.

## Lessons

- A leak parked in an allowlist as "migrate later" is still a leak; allowlist
  entries need an owner and an expiry, not an indefinite TODO.
- A documented overlay surface that is not wired is a trap: it implies a safe place
  for personal data that does not exist. Wire the seam before relying on it.
- Tests and eval fixtures are repo-tracked too. Seed hermetic, synthetic config in
  tests instead of depending on personal data living in repo defaults — otherwise
  removing the personal data silently breaks CI (and the failure hides locally
  because the dev's own profile fills the gap).
- Migrating config that the live bot reads is safe **only** if you prove the merged
  result is unchanged. Snapshot the merged config first, then diff after.

## Future Work

- Coordinated bot restart to align the live process's in-memory code with the new
  dist (the migration is already serving correctly via profile overlays + fresh
  MCP spawns; a restart is hygiene, not a fix).
- Optionally trim Devin's whole-file prompt overlays to deltas so the generic repo
  parts keep receiving upstream updates.
- Consider git-history scrubbing (operator decision; history still holds the
  pre-split values — see TGO history-scrub precedent).
