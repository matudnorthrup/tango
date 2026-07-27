# Church Session (churchofjesuschrist.org)

How Tango stays signed in to churchofjesuschrist.org for Gospel Library
(scripture marking, notes) and Leader and Clerk Resources (LCR).

Owner module: `packages/discord/src/church-session.ts`.
CLI: `npx tsx scripts/church-session.ts status|ensure|persist`.

## How the Church actually authenticates

Everything sits behind one Okta session at `id.churchofjesuschrist.org`. Each
app then mints its own short-lived token from that session:

| Cookie | Host | Lifetime | Role |
| --- | --- | --- | --- |
| `idx` | `id.churchofjesuschrist.org` | **browser session** | the single sign-on session — the one thing that matters |
| `JSESSIONID` | `id.churchofjesuschrist.org` | **browser session** | IdP request state |
| `DT`, `proximity_*`, `luf_*` | `id.churchofjesuschrist.org` | months | device trust: why this profile is not asked for a second factor |
| `oauth_id_token` | `.churchofjesuschrist.org` | **1 hour**, per app path (`/study`, `/notes`, `/content`) | the token the study/notes APIs check |
| `oauth_refresh_token` | `.churchofjesuschrist.org` | **browser session** | refreshes the above |
| `appSession.*`, `mltpSession` | `lcr.*`, `mltp-api.*` | **browser session** | LCR's own session |

Two consequences drove the design:

1. **Every cookie that authenticates is browser-session scoped.** Restarting
   Brave threw away a perfectly good login, so the next Porter or LCR task
   started with a password prompt. The cookies that *do* survive only remember
   the device for MFA.
2. **The app token lives one hour.** A long task, or any task started more than
   an hour after the last sign-in, hit a 401 in the middle — which looked like
   "the login broke" but was really an unrefreshed token.

## What Tango does about it

`ensureChurchSession({ scope })` runs before any authenticated Church work
(`study` or `lcr`) and escalates only as far as it has to:

1. **Probe.** Study: `GET /notes/api/v3/annotations` — 200 signed in, 401 signed
   out, unambiguous. LCR: navigate and check whether the leader shell rendered or
   the IdP intercepted.
2. **Silent single sign-on.** Bounce through `/study/login`, which completes the
   OIDC round trip with no interaction when the Okta session is alive. This is
   the fix for the expired one-hour token and needs no password.
3. **Credential sign-in.** The Church sign-in widget is a two-step flow with
   stable ids — `#username-input`, then `#password-input`, each submitted by
   `#button-primary`. Credentials come from the 1Password item named by
   `CHURCH_ACCOUNT_1PASSWORD_VAULT` / `CHURCH_ACCOUNT_1PASSWORD_ITEM` and never
   reach the model. (The page also renders ~100 language buttons, which is why
   "click the button that says Next" text scraping was unreliable.)
4. **Second factor.** The account signs in with username and password only, so a
   factor prompt means something changed on the Church's side. It is submitted
   from the 1Password item's one-time password if one was ever added; otherwise
   the call fails loudly saying exactly that.
5. **Persist.** After any successful restore, the session-scoped auth cookies are
   rewritten with a 30-day expiry so the login survives a browser restart. They
   stay in Brave's own encrypted cookie store — Tango never writes session
   material to disk itself. This does not extend the server-side session; it
   stops us from discarding one that is still valid.

   Persisting runs several passes. A Church page still settling can re-issue its
   session cookie a second or two later (Okta rotates `idx`), which silently
   undoes a single-pass hardening — the session looks saved but dies with the
   browser anyway.

A `church-session-keepalive` schedule runs every 45 minutes to keep the Okta
session from idling out and to re-persist rotated cookies.

## Two other failure modes this closed

- **Origin drift.** All browser tools share one page. Church API calls used to
  run in whatever origin the last workflow left that page on, so they went
  cross-origin — no cookies, CORS errors that read exactly like auth failures —
  and Church navigation would steal another workflow's tab. Church traffic now
  runs on a tab pinned to the Church origin.
- **Profile drift.** The automation profile resolved differently depending on
  `TANGO_DATA_DIR`/cwd, and a CDP client attaches to whichever browser claimed
  port 9223 first. A worktree or profile-scoped run could silently use a
  different cookie jar with no Church login in it. See
  [Browser profile](#browser-profile-one-jar) below.

## Browser profile: one jar

There is one automation browser on one CDP port, so there is exactly one cookie
jar: **`~/.tango/browser-profile`**. `TANGO_BROWSER_PROFILE_DIR` overrides it and
nothing else does — not `TANGO_DATA_DIR`, not `TANGO_PROFILE`, not cwd.

It used to vary, which produced three profile directories on this machine
(consolidated 2026-07-26, reclaiming 1.4 GB):

| Was | State when consolidated |
| --- | --- |
| `<repo>/data/browser-profile` | live, 186 cookie hosts — **moved** to `~/.tango/browser-profile` |
| `~/.tango/profiles/default/data/browser-profile` | stale (Jul 9), 82 hosts — unique cookies merged forward, then removed |
| `~/.tango/browser/user-data` | abandoned (March), zero cookies — removed |

Living under the Tango home rather than the repo also means `git clean -xdf`, a
worktree checkout, or moving the repo cannot delete every saved login.

Worktrees deliberately share this jar. They already shared the browser — one
port, first launcher wins — so a per-worktree path only ever created a second
jar that some runs used and others did not.

To re-check or redo the consolidation:

```bash
npx tsx scripts/consolidate-browser-profiles.ts           # plan only
npx tsx scripts/consolidate-browser-profiles.ts --apply   # quits + relaunches Brave
```

`--apply` merges cookies that exist only in an older jar, captures open tabs,
quits Brave gracefully so its cookie store flushes, moves the profile, and
reopens whatever Brave did not restore itself. Any browser restart drops
browser-session cookies for *other* sites too (Ramp, for one, signs out), so
expect to sign back in to those.

## Debugging

```bash
npx tsx scripts/church-session.ts status   # report only — never signs in
npx tsx scripts/church-session.ts ensure   # sign in if needed (study + LCR)
npx tsx scripts/church-session.ts persist  # harden cookies against a restart
```

`status` answers, in order, the questions that actually matter:

- Is the running browser on the profile we think it is?
- Is 1Password reachable from this process?
- Would the session survive a browser restart?
- Are study and LCR authenticated right now, and by what evidence?

Escalate to a human only when `status` reports a second-factor prompt, a
captcha, or missing 1Password access. Everything else is self-healing.

## Second factor

The Church account is username and password only — no authenticator is enrolled,
and the 1Password item has no one-time password field. A full signed-out recovery
was verified end to end on 2026-07-26: 1Password sign-in completed in 12 seconds
with no prompt.

So a `needsSecondFactor` result is a signal, not routine: the Church has added a
verification step or flagged the device. The account owner completes it once in
the automation browser; if an authenticator is enrolled at that point, putting
its secret in the 1Password item makes the recovery self-healing again.
