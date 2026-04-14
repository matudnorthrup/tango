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

## Running As Background Services (tmux)

For always-on deployments (e.g. the Mac Mini), Tango runs all six supporting
services inside a **single tmux session named `tango`**, with one named window
per service. This keeps `tmux list-sessions` readable and lets agents inspect
or restart any service via `tmux capture-pane` / `tmux send-keys` targeting
`tango:<window>`.

Launch the full stack after a reboot:

```bash
bash scripts/startup.sh
```

Window layout inside the `tango` session:

| Window                   | Service                               |
|--------------------------|---------------------------------------|
| `tango:kokoro`           | Kokoro TTS server (port 8880)         |
| `tango:whisper-main`     | Whisper STT server (port 8178)        |
| `tango:whisper-partials` | Whisper STT server (port 8179)        |
| `tango:owntracks`        | OwnTracks receiver (port 3456)        |
| `tango:discord`          | Tango Discord runtime                 |
| `tango:voice`            | Tango Voice pipeline                  |

Everyday commands:

```bash
tmux attach -t tango        # attach; Ctrl-b w to pick a window, Ctrl-b d to detach
tmux list-windows -t tango  # list windows and their running commands
```

Per-service management goes through npm scripts (these automatically target the
right window inside `tango`, and fall back to any legacy standalone session
that may still be running mid-migration):

```bash
npm run bot:status      # status + recent logs for tango:discord
npm run bot:logs        # tail tango:discord logs
npm run bot:restart     # rebuild + restart tango:discord
npm run bot:stop        # kill the discord window (leaves other services up)
npm run bot:start       # start tango:discord (creates session/window if needed)

npm run voice:status    # same set of verbs for tango:voice
npm run voice:logs
npm run voice:restart
npm run voice:stop
npm run voice:start
```

Override the session or window names with `TANGO_TMUX_SESSION`,
`TANGO_DISCORD_WINDOW`, or `TANGO_VOICE_WINDOW` if you need a non-default layout.

## Verification

Run the standard checks:

```bash
npm run build
npm test
npm run verify:profile-refactor
```
