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
4. **Second factor.** Submitted from the 1Password item's one-time password if it
   has one; otherwise the call fails loudly saying exactly that.
5. **Persist.** After any successful restore, the session-scoped auth cookies are
   rewritten with a 30-day expiry so the login survives a browser restart. They
   stay in Brave's own encrypted cookie store — Tango never writes session
   material to disk itself. This does not extend the server-side session; it
   stops us from discarding one that is still valid.

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
  port 9223 first. A worktree run could silently use a different cookie jar with
  no Church login in it. `TANGO_BROWSER_PROFILE_DIR` now pins the jar in `.env`,
  and `status` reports the profile the running browser is *actually* using
  against the one this process expects.

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

## Known gap

The Church 1Password item has no one-time password field, so MFA cannot be
answered automatically. It has not mattered because the automation profile holds
the Church's device-trust cookies (`DT` to Nov 2026, `proximity_*` to Jan 2027) —
but if that profile is ever wiped, the next sign-in will need Devin to approve a
factor by hand. Adding the Church account's authenticator secret to the 1Password
item would close it.
