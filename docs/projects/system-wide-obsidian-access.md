# System-Wide Obsidian Access

**Status:** Validated
**Date:** 2026-05-23
**Linear:** [System-Wide Obsidian Access](https://linear.app/seaside-hq/project/system-wide-obsidian-access-5ee502935730)
**Validation Issue:** [TGO-486](https://linear.app/seaside-hq/issue/TGO-486/validate-system-wide-obsidian-access-across-all-agents)

## Problem

Some agents could not open Obsidian links even though Obsidian is the durable life database for Tango. Juliet was the clearest failure: she received an `obsidian://open` URL, but had no deterministic workers and no file-backed Obsidian tool surface, so she asked the user to paste content instead.

## Design

Add a narrow shared `note-librarian` worker for generic Obsidian note work. Generic note intents route there instead of piggybacking on Watson's broad `personal-assistant` worker.

All lead agents can delegate generic note reads and updates to `note-librarian`:

- Watson
- Sierra
- Malibu
- Victor
- Juliet
- Charlie
- Foxtrot

Malibu keeps `project_scope: wellness`, but deterministic routing can include configured `additional_domains`. Malibu uses that to include `notes` without broadening the rest of the wellness catalog.

The file-backed Obsidian tool now accepts `obsidian://open` URL targets by decoding the `file` or `path` query parameter and then passing it through the existing vault-relative path resolver.

## Validation Plan

- Unit test config parsing for `additional_domains`.
- Unit test Obsidian URI parsing and traversal rejection.
- Unit test every lead agent exposing generic note intents through `note-librarian`.
- Unit test Malibu project-scoped deterministic routing including `notes`.
- Build core and Discord packages.
- Restart the live bot.
- Send controlled Obsidian URI smoke prompts through each agent's configured smoke test channel and verify `note-librarian` read execution.

## Validation Results

- `npm run test -w @tango/core -- test/config.test.ts` passed.
- `npm run test -w @tango/core -- test/config-layering.test.ts test/v2-config-loader.test.ts` passed.
- `npm run test -w @tango/discord -- test/personal-agent-tools.obsidian.test.ts test/deterministic-router.test.ts test/intent-classifier.test.ts test/turn-executor.test.ts` passed.
- `npm run build -w @tango/core` passed.
- `npm run build -w @tango/discord` passed.
- `npm run bot:restart` completed successfully and the bot reported `status=running`.
- Live smoke checks passed in each agent test channel/thread:
  - Juliet: `OBSIDIAN SMOKE OK JULIET`
  - Watson: `OBSIDIAN SMOKE OK WATSON`
  - Sierra: `OBSIDIAN SMOKE OK SIERRA`
  - Malibu: `OBSIDIAN SMOKE OK MALIBU`
  - Victor: `OBSIDIAN SMOKE OK VICTOR`
  - Charlie: `OBSIDIAN SMOKE OK CHARLIE`
  - Foxtrot: `OBSIDIAN SMOKE OK FOXTROT`

Foxtrot initially timed out because its smoke-test parent channel did not have a session binding, so the thread defaulted to `dispatch` and access control blocked it. Adding `smoke-testing-foxtrot` fixed that routing gap; the rerun passed.
