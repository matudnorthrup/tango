# Tango

Tango is a voice-first AI orchestration platform for running named agents,
workers, schedules, and multi-surface workflows from a shared runtime.

## Repository Model

Tango now separates reusable product code from user-owned state:

- Repo defaults: [`config/defaults`](./config/defaults), [`agents`](./agents),
  application code, tests, and docs.
- Profile overrides: `~/.tango/profiles/<profile>/config` and
  `~/.tango/profiles/<profile>/prompts`.
- Runtime data: `~/.tango/profiles/<profile>/data`, `cache`, and `logs`.

That separation is what allows `git pull` to update the system without
overwriting a user's personal config, schedules, names, or runtime database.

## Packages

- `packages/core`: config loading, storage, scheduling, prompt assembly,
  providers, governance, and shared runtime path logic.
- `packages/discord`: Discord runtime, tool surfaces, routing, and MCP servers.
- `packages/voice`: shared voice routing and project/address-book utilities.
- `packages/cli`: operator tooling such as `tango paths`, `tango doctor`,
  `tango config trace`, and `tango config migrate`.
- `apps/tango-voice`: native voice application built on the shared Tango
  runtime and config model.

## Quick Start

1. Use Node 22: `nvm use`
2. Install dependencies: `npm install`
3. Copy env defaults: `cp .env.example .env`
4. Initialize a profile: `npm run cli -- init`
5. Inspect resolved paths: `npm run cli -- paths`
6. Check separation status: `npm run cli -- doctor`

If you are migrating an older repo-local install, preview the config move first:

```bash
npm run cli -- config migrate --dry-run
```

Then copy the legacy config into your profile overlay when you are ready:

```bash
npm run cli -- config migrate
```

## Running Tango

- Discord runtime: `npm run dev:discord`
- Voice app: `npm run dev:voice-app`
- CLI: `npm run cli -- --help`

Useful verification commands:

- `npm run build`
- `npm test`
- `npm run verify:profile-refactor`

## Updates

The intended update model is:

1. Update the repo code and defaults with `git pull`
2. Keep your real config in `~/.tango/profiles/<profile>/config`
3. Keep your persona and private prompt overlays in
   `~/.tango/profiles/<profile>/prompts`
4. Keep runtime state in `~/.tango/profiles/<profile>/data`

Repo defaults are loaded first, then profile overrides win on top. That means
new upstream defaults can land without overwriting local channel mappings,
agent display names, schedules, or private knowledge.

## Documentation

- Overview: [`docs/about.md`](./docs/about.md)
- Docs index: [`docs/README.md`](./docs/README.md)
- Setup guide: [`docs/guides/setup.md`](./docs/guides/setup.md)
- Public launch guide: [`docs/guides/public-launch.md`](./docs/guides/public-launch.md)
- Profile/config model: [`docs/guides/profile-model.md`](./docs/guides/profile-model.md)
- Agent structure: [`docs/guides/agents-structure.md`](./docs/guides/agents-structure.md)
- Tool wiring guide: [`docs/guides/adding-tools.md`](./docs/guides/adding-tools.md)

## Contributing

Contribution and repository policy docs live at the repo root:

- [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- [`SECURITY.md`](./SECURITY.md)
- [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)
- [`LICENSE`](./LICENSE)
- [`NOTICE`](./NOTICE)

## License

Tango is licensed under Apache-2.0. See [`LICENSE`](./LICENSE) and
[`NOTICE`](./NOTICE).

## Status

The repository now ships with public defaults plus profile-owned overlays.
Installation-specific names, rules, secrets, and operating conventions belong
under `~/.tango/profiles/<profile>/`, not in tracked repo files.
