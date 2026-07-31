# Study Library Tool

Tool ID: `study_library`

Authenticated wrapper for a web-annotations / notes API accessed through the
current browser session. This repo doc describes the generic capability; the
specific site, account, and 1Password credential item are **profile-configured**
and supplied by a profile overlay.

## Requirements

- Browser must be connected through the Tango browser tool stack.
- The tool owns browser launch, navigation, and sign-in. Do not ask the user to
  open a browser tab, and do not type the account password through the generic
  browser tool.
- **Every action restores the session first**, so you do not need to check auth
  before calling one. Restoration tries the existing single sign-on session
  before it ever uses a password.
- Requests run in page context with `credentials: include` so session cookies are
  used without exposing them. They run on a tab pinned to the site's own origin,
  not the shared browser tab.
- Never hardcode or reveal personal identifiers from annotation payloads.

See [`docs/guides/browser-sessions.md`](../../docs/guides/browser-sessions.md) for
how the session is kept alive and how to debug it.

## Actions

### `status`

Reports auth state and session diagnostics **without signing in** — the action
to use when explaining a failure. Returns the probe result, the browser profile
in use, whether 1Password is reachable, and whether the session would survive a
browser restart.

Optional input:

- `url`: site URL or path, defaults to the configured study path.
- `scope`: `study` (default) or `lcr`.

### `ensure_session`

Makes sure the session is live, signing in only if needed. Use this before doing
leader-and-clerk work through the generic browser tool.

Input:

- `scope`: `study` (default) or `lcr` for the leader/clerk site.
- `url`: optional target; the scope is inferred from it when given.

### `open`

Ensures the session, then opens a configured-site URL in the site's tab.

Input:

- `url`: optional site URL or path, defaults to the configured study path.

### `prepare_login` / `login`

Aliases of `ensure_session`, kept for older prompts. Restoration order is:

1. Probe the authenticated endpoint.
2. Re-mint the app token from the existing single sign-on session (no password).
3. Sign in with the configured 1Password item, submitting a one-time password
   when the item has one.

The username, password, and any TOTP code stay inside the tool handler and are
never returned to the model.

Configuration (profile-configured; see the profile overlay for this
installation's values):

- `<ACCOUNT>_1PASSWORD_VAULT`: vault name or ID.
- `<ACCOUNT>_1PASSWORD_ITEM`: item title or ID.

Ask the user only when 1Password access, captcha, SMS/email/push verification,
or another second factor blocks authentication.

### `list_annotations`

GET `/notes/api/v3/annotations`.

Input:

- `query`: optional object of query parameters, such as `uri`, `docId`,
  `folderId`, `tagId`, `limit`, or `offset`.

### `create_reference_link`

POST a prepared reference annotation payload to
`/notes/api/v3/annotations`.

Input:

- `annotation`: complete annotation payload.
- `verify`: optional boolean, defaults to true.

Use for source-to-note, source-to-lesson, or source-to-source reference links
when the payload has been prepared from the authenticated session and current
content metadata.

For partial text marks, `startOffset` and `endOffset` are word-token offsets, not
character offsets. Count the visible whitespace-separated tokens in the unit with
the unit number as token 1, and treat `endOffset` as inclusive. Footnotes can
split one phrase into multiple rendered mark nodes, so verify the rendered/DOM
phrase text, not just the API readback fields.

For a user-visible underline, keep `style: "red-underline"` and set `color` to
the intended visible palette color such as `yellow`, `blue`, `red`, or
`purple`. Do not use `color: "clear"` for requested underlines; in dark theme it
can render as an effectively invisible underline.

### `delete_annotation`

DELETE `/notes/api/v3/annotations/{annotation_id}`.

Input:

- `annotation_id`: annotation ID.
- `verify`: optional boolean, defaults to true.

## Reporting

Return annotation IDs, source URIs, action status, and verification result.
Do not include cookies, session tokens, or personal IDs in user-facing prose.
