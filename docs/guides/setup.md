# Setup Guide

## Requirements

- Node 22
- npm
- Any provider CLIs or credentials you plan to use

## Install

```bash
nvm use
npm install
cp .env.example .env
```

## Initialize A Profile

Create the default profile layout:

```bash
npm run cli -- init
```

Inspect the resolved paths:

```bash
npm run cli -- paths
```

Check whether Tango is still relying on repo-local mutable state:

```bash
npm run cli -- doctor
```

## Migrate An Older Repo-Local Install

If your current setup still keeps real config in the repo, preview the
migration first:

```bash
npm run cli -- config migrate --dry-run
```

Then copy that config into the active profile:

```bash
npm run cli -- config migrate
```

## Runtime Layout

By default Tango resolves:

- Home: `~/.tango`
- Profile: `~/.tango/profiles/default`
- Config overrides: `~/.tango/profiles/default/config`
- Prompt overrides: `~/.tango/profiles/default/prompts`
- Tool prompt overlays: `~/.tango/profiles/default/prompts/tools`
- Skill prompt overlays: `~/.tango/profiles/default/prompts/skills`
- Runtime data: `~/.tango/profiles/default/data`

Repo defaults continue to live in `config/defaults`.

## Start The Main Processes

- Discord runtime: `npm run dev:discord`
- Voice app: `npm run dev:voice-app`
- CLI: `npm run cli -- --help`

## Verification

Run the standard checks:

```bash
npm run build
npm test
npm run verify:profile-refactor
```
