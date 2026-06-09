# Home (tailnet site directory)

Single static page at the tailnet root
(**https://mac-studio.tailead658.ts.net/**) linking to the sites hosted on
the Mac Studio.

The macOS App Store tailscaled can't serve files directly (sandbox), so a
dependency-free Node server (`server.mjs`, port 9310) serves `index.html`
and Tailscale proxies the root to it:

```bash
npm run home:start   # tmux window 'home' in the tango session
tailscale serve --bg --set-path / http://127.0.0.1:9310
```

Path mounts are longest-prefix matched, so `/kilo` and `/tango-workout`
proxies keep working alongside the root mount.

## Adding a site

1. Mount the new site: `tailscale serve --bg --set-path /<name> http://127.0.0.1:<port>`
2. Copy one of the `<a class="site">` cards in `index.html` and update the
   href / icon / name / description. `index.html` is read per request, so
   edits are live immediately — no restart needed.

Env (optional): `TANGO_HOME_PORT` (default 9310), `TANGO_HOME_HOST`
(default 127.0.0.1).

Note: the page is served straight from the repo working tree, so whatever
is on disk (current branch) is what's live.
