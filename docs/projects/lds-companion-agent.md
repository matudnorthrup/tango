# LDS Companion Agent

**Linear:** [LDS Companion Agent](https://linear.app/seaside-hq/project/lds-companion-agent-afd463f5e5c0)
**Status:** Ship
**Date:** 2026-05-25

## Brief

Build a new Tango companion agent for LDS scripture study, talk and lesson preparation, reflective exploration, and bishopric-counselor workflows.

The agent should be grounded in the doctrine, scriptures, and language of The Church of Jesus Christ of Latter-day Saints while still allowing clearly labeled outside ideas when they help the user's study or thinking.

## Product Shape

This agent is a spiritual study companion and church-work aide, not an ecclesiastical authority. It should help Devin think, prepare, remember, draft, and organize while keeping final judgment, revelation, and pastoral stewardship with Devin and local leaders.

Core jobs:

- Scripture study: look up passages, compare cross-references, summarize themes, suggest study questions, and capture notes.
- Talk preparation: turn topics and source material into outlines, drafts, quotes, scripture chains, and Obsidian notes.
- Lesson preparation: produce discussion-first lesson plans with clear scriptures, questions, activities, and timing.
- Calling support: draft sacrament meeting conducting outlines, organize ward-business inputs, review church-related email, and prepare notes.
- Reflection: act as a sounding board for faith, questions, talks, and personal application without pretending certainty where there is none.

## Current Findings

Existing Tango agent creation guidance says new agents should use:

- `config/v2/agents/{id}.yaml`
- `agents/assistants/{id}/soul.md`
- optional `knowledge.md`
- `config/defaults/sessions/{id}.yaml`
- a channel entry in `config/defaults/channels.yaml`

Legacy `config/defaults/agents/{id}.yaml` is not required for new agents because v2 config is bridged at boot. V2 config is authoritative for agents that have a v2 file; legacy agent config is reserved for legacy-only system agents such as dispatch.

Porter is now configured through the v2 runtime, and the live Discord bot has been restarted with Porter present in routing.

Relevant vault references exist:

- `/Users/devinnorthrup/Documents/main/References/Gospel Library Scripture Linking API.md`
- `/Users/devinnorthrup/Documents/main/References/Scripture Marking System.md`
- `/Users/devinnorthrup/Documents/main/_Schema/Templates/Sacrament Meeting Template.md`
- `/Users/devinnorthrup/Documents/main/Young Men Lesson 2026-04-26.md`

The scripture-linking note documents an authenticated Gospel Library notes API flow for creating reference annotations between scripture verses and lesson content. Tango now wraps that flow in a dedicated `gospel_library` MCP tool.

The scripture-marking note defines a useful marking taxonomy:

- Red: principle
- Orange: ponder
- Yellow: mission/calling
- Brown: historical context
- Teal: personal connection
- Purple: lesson material
- Pink: favorite
- Gray: common/first pass

The sacrament meeting template is usable but sparse. The conducting protocol note is a placeholder and should not be treated as authoritative until researched.

## Discord Channels

- Default channel: `#porter` (`1508531125243478176`)
- Smoke-test channel: `#porter-test` (`1508531126321549455`)

## Theology And Source Policy

Primary sources:

- Standard works of The Church of Jesus Christ of Latter-day Saints
- General Conference
- Official Church manuals and Gospel Library content
- Official Church Handbook where applicable and accessible

Secondary sources:

- Historical context, scholarship, other Christian writing, leadership/productivity frameworks, and outside commentary may be used as supplementary context.
- The agent must label these as external or interpretive, not as Church doctrine.

Safety boundaries:

- Do not present personal impressions as revelation.
- Do not give confidential pastoral counsel as if acting for a bishopric.
- For calling-related work, prefer drafts, outlines, and checklists over assertions about private members.
- Email sends and sensitive note writes should stay confirmation-gated.
- Avoid storing sensitive ward/person information in broad, evergreen notes unless Devin explicitly asks.

## Tool Direction

MVP tools:

- Obsidian for notes, outlines, lesson plans, and scripture-study artifacts.
- Gmail via `gog_email` for church/calling email read/review only.
- `gospel_library` for authenticated Gospel Library annotation reads, reference-link writes, deletes, and verification through the Church browser session.
- Browser as a fallback for authenticated Gospel Library page/session inspection.
- `onepassword` as a read-only credential fallback if Church credentials are
  explicitly added there later.
- Memory search for durable user preferences and prior study patterns.

Likely new implementation work:

Implementation now includes a dedicated `gospel_library` MCP tool. It exposes `status`, `list_annotations`, `create_reference_link`, and `delete_annotation`, and uses page-context fetch against `/notes/api/v3/annotations` so the authenticated Church session supplies cookies without exposing them.

Authentication improvement: `gospel_library status` now launches/navigates the
managed browser instead of asking the user to open a tab. `gospel_library login`
opens the Church site, checks annotation auth, and uses the configured
1Password Church login item to fill the sign-in form without returning
credentials to the model. Porter should ask Devin only when
1Password access, captcha, or 2FA is actually blocking the browser.

Implementation also includes reusable skill guidance for LDS study, talk prep, lesson prep, sacrament conducting, scripture marking, Obsidian notes, and read-only email review.

Porter uses direct v2 MCP tools for scripture, Gospel Library, Obsidian church notes, read-only email review, and browser-backed Church session inspection. The old worker-dispatch runtime has been retired, so Porter should not emit worker handoff markup or depend on `dispatch_worker`.

## Implementation Files

- `agents/assistants/porter/soul.md`
- `agents/assistants/porter/knowledge.md`
- `agents/skills/lds-companion-workflows.md`
- `agents/tools/gospel-library.md`
- `config/v2/agents/porter.yaml`
- `config/defaults/sessions/porter.yaml`
- `config/defaults/tool-contracts/gospel-library.yaml`

## Naming And Persona

Decision: **Porter**.

Why Porter:

- It should be STT-friendly because it is a common English word with clear consonants.
- It has an LDS-history connection through Porter Rockwell without sounding like the agent is claiming prophetic or ecclesiastical weight.
- It feels companionable and practical, which fits a calling-support/study aide.

Persona direction:

- Practical, straightforward, direct, and wise.
- Full of care, but allergic to syrupy church-small-talk and passive-aggressive niceness.
- Opinionated when useful, especially about clarity, preparation, doctrine vs. speculation, and what actually helps.
- Grounded, plainspoken, and warm in the way a trusted mentor is warm: by telling the truth, helping with the work, and not wasting words.
- Faithful to LDS doctrine and practice without sounding like a committee-written ward newsletter.
- Not an impersonation of any fictional character; the useful reference point is "ruggedly practical, loving, and direct."

## Avatar

Devin selected a Porter portrait: an illustrated older bearded man with round
glasses, direct expression, fringed jacket, and mountain backdrop. It fits the
practical, direct, wise Porter persona.

Implementation path:

- Store the PNG as `agents/assistants/porter/avatar.png`.
- Add `avatar_path` to `config/v2/agents/porter.yaml`.
- Use a per-agent Discord webhook avatar so Porter does not depend on an
  expiring attachment URL.
- Rebuild/restart the Discord bot.
- Smoke-test a Porter reply and confirm the webhook identity uses the portrait.

Current status: image asset is present and wired through `avatar_path`.
Live validation passed in `#porter-test` thread `codex-porter-avatar-smoke`;
response record `5547` was authored by `Porter` through webhook
`Tango Replies - porter`, and Discord reported a non-null webhook avatar hash.

## MVP Scope

Discovery should produce a final agent-name decision and implementation work orders for:

1. Agent identity, prompts, config, session, and routing.
2. Scripture lookup and citation workflow.
3. Obsidian study/talk/lesson note workflows.
4. Calling support workflows, starting with sacrament meeting conducting outlines.
5. Live validation prompts and success criteria.

## Open Questions

- Exact implementation shape for scripture text lookup remains open: for MVP Porter can reason from known citations and use browser or Gospel Library context, but a dedicated read-only scripture text API would make citation-heavy workflows sturdier.
- A dedicated read-only scripture text API would make citation-heavy workflows
  sturdier, but MVP scripture, Gospel Library, Obsidian, and read-only email
  workflows are live-tested.

## Linear Plan

- `TGO-493` Discover LDS companion requirements and existing scripture patterns
- `TGO-494` Choose companion agent name and voice call signs
- `TGO-495` Implement companion agent config, prompts, and routing
- `TGO-496` Add LDS scripture access and study workflows - Done
- `TGO-497` Wire email and Obsidian workflows for calling support - Done
- `TGO-498` Build, deploy, and restart main Tango with companion agent - Done
- `TGO-499` Live-test scripture study, talk prep, lesson prep, and sacrament outline flows - Done
- `TGO-500` Finalize docs and ship report - Done
- `TGO-527` Live-test Gospel Library reference-link creation and cleanup - Done

## Validation Gate

This project is not shippable until the main bot has been live-tested after deploy with at least:

- Scripture lookup/study
- Gospel Library scripture marking/linking
- Talk outline or draft
- Lesson plan
- Obsidian note create/update
- Sacrament meeting conducting outline
- A calling-related email read/review flow, if email access is included in MVP

Current validation results:

- Passed: main build and restart.
- Passed: focused core regression suite: prompt assembly, config, v2 config loader, and storage tests.
- Passed: focused Discord regression suite: MCP tool metadata, v2 runtime, Tango router, and voice runtime routing tests.
- Passed: Porter routed in `#porter-test` thread `1508541908140425307`.
- Passed: scripture-study response on Alma 32:21.
- Passed: talk outline using Alma 32:21 plus an additional LDS source.
- Passed: sacrament meeting conducting outline using the Obsidian sacrament meeting template.
- Passed: `gospel_library status` read-only check; the tool reached the browser context and did not modify annotations.
- Passed: updated Gospel Library auth/read smoke. Porter launched/used the
  managed browser without asking Devin to open a tab, corrected the annotation
  auth probe, confirmed authenticated status, ran `prepare_login` as an
  authenticated no-op, and read 595 highlight annotations with `list_annotations`
  without exposing private IDs. Passing records: `5570`, `5572`, `5574`.
- Passed: authenticated Gospel Library marking write/update. Porter found the
  most recent annotation on `1 Nephi 14:14`, recommended a marking color,
  received confirmation, and updated the verse marking to orange. Passing record:
  `5582`.
- Passed: hardened Gospel Library status/auth probe after Porter exposed an
  oversized status-response/session fault. The probe now uses a narrow reference
  query and returns only a sanitized summary. Focused regression:
  `packages/discord/test/gospel-library-agent-tools.test.ts`.
- Passed: dedicated Gospel Library reference-link validation. Porter confirmed
  authenticated status and existing John 3 reference counts in record `5646`,
  then created a temporary reference annotation on `1 Nephi 14:14`, verified
  readback, deleted only the newly created annotation, and verified deletion in
  record `5648`.
- Corrected: 2 Nephi 3 partial underline validation exposed that Gospel
  Library partial mark offsets are word-token offsets, not character offsets.
  The bad phrase annotations were replaced with rendered-DOM-verified marks, and
  Porter/tool docs now require rendered phrase verification for partial marks.
- Corrected again: the first replacement used `color: "clear"` with
  `style: "red-underline"`, which exists in the API but renders nearly
  invisible in dark theme. The phrase marks were recreated with visible yellow
  underline styling and rechecked via computed rendered styles.
- Passed: email boundary smoke test; Porter correctly stated read/search/summarize only, with no drafts, sends, archives, labels, deletes, or mailbox modification.
- Passed: actual read-only email retrieval validation. Porter used `gog_email`
  with a church/calling-shaped query, returned 10 capped results, summarized the
  signal without quoting private names, addresses, or message bodies, and
  performed no writes. Passing record: `5650`.
- Passed: lesson-plan-specific smoke test after adding source-quotation guardrails and a v2 internal worker-markup suppression guard. Porter fetched and verified source text, then produced the lesson without leaking internal handoff markup. Passing record: `5533`.
- Passed: operational cleanup. Removed the stale slot 2 worktree/branch for
  `codex/porter-companion-agent` after preserving a backup archive at
  `~/.tango/backups/porter-slot2-dirty-files-20260525-163136.tgz`.
- Passed: main bot was rebuilt and restarted from the pinned repo path
  `/Users/devinnorthrup/GitHub/tango`; exactly one Discord bot process remained
  after cleanup.
