# Public Launch Guide

This guide assumes Tango will be published from a fresh public repository
rather than from the existing private history.

## Recommended Model

- Public repo: reusable code, default config, example config, docs, tests,
  CI, and generic prompts.
- Private profile: real accounts, schedules, persona overlays, secrets, and
  runtime data under `~/.tango/profiles/<profile>`.
- Launch path: copy the sanitized tree into a new repository, then make the
  new repo the public source of truth.

## Launch Checklist

1. Create a new empty GitHub repository for the public Tango codebase.
2. Copy only the sanitized public tree into that repo. Do not preserve the
   private repo history.
3. Include the root policy and launch files:
   - `LICENSE`
   - `NOTICE`
   - `README.md`
   - `CONTRIBUTING.md`
   - `SECURITY.md`
   - `CODE_OF_CONDUCT.md`
   - `.github/`
4. Keep `config/defaults` and `config/examples` in the public repo. Do not
   include live personal overlays from `~/.tango` or any private mirror.
5. Keep tracked examples generic:
   - fake IDs
   - fake accounts
   - fake endpoints
   - no secrets
   - no machine-local absolute paths
6. Keep runtime state out of the public repo:
   - `data/`
   - browser profiles
   - SQLite files
   - reports
   - caches
   - rescued transcripts
7. Run a final secret and privacy scan across the copied tree.
8. Run the baseline verification suite:
   - `npm install`
   - `npm run build`
   - `npm test`
   - `npm run test:voice-app`
   - `npm run verify:profile-refactor`
9. Confirm bootstrap and observability commands from a clean checkout:
   - `npm run cli -- init --dry-run`
   - `npm run cli -- paths`
   - `npm run cli -- doctor`
   - `npm run cli -- config trace agents watson`
   - `npm run cli -- prompt trace agent watson`
10. Review README quick start from scratch on a clean machine or throwaway
    profile and fix any undocumented prerequisite.
11. Enable GitHub repository settings before announcement:
    - branch protection on `main`
    - required CI checks
    - security alerts
    - issue templates
    - pull request template
12. Publish the initial release only after the clean-clone checks pass.

## Fresh Repo Cutover

1. Initialize the new repo and copy the sanitized files.
2. Commit the launch baseline as the first public commit.
3. Push to GitHub and enable repository settings.
4. Tag the initial public release, for example `v0.1.0`.
5. Announce the project with the profile model called out explicitly so users
   understand that local customization belongs outside the repo.

## Post-Launch Maintenance

- Keep public defaults generic and reusable.
- Land broadly useful improvements in the public repo first.
- Keep private persona, account, and schedule overlays outside the repo.
- When a private customization becomes generally useful, extract it, make it
  configurable, and upstream it.
- Preserve compatibility by shipping migration notes whenever config or prompt
  formats change.

## Apache-2.0 Notes

- The repo ships with the full Apache-2.0 text in `LICENSE`.
- `NOTICE` provides the project attribution file referenced by the Apache
  redistribution terms.
- Individual source-file headers are optional for this launch. If you later
  want file-level tagging, prefer SPDX headers:
  `SPDX-License-Identifier: Apache-2.0`
