# Gospel Library Tool

Tool ID: `gospel_library`

Authenticated wrapper for a web-annotations / notes API accessed through the
current browser session. This repo doc describes the generic capability; the
specific site, account, and 1Password credential item are **profile-configured**
and supplied by a profile overlay.

## Requirements

- Browser must be connected through the Tango browser tool stack.
- The tool owns browser launch and navigation. Do not ask the user to open a
  browser tab.
- The active browser profile should be signed in at the configured site. If it
  is not, use `login` to re-authenticate through the configured 1Password login
  item.
- Requests run in page context with `credentials: include` so session cookies are
  used without exposing them.
- Never hardcode or reveal personal identifiers from annotation payloads.

## Actions

### `status`

Launches/navigates when needed, then checks browser connection, current page,
and annotation endpoint response.

Optional input:

- `url`: site URL or path, defaults to the configured study path.
- `open_if_needed`: boolean, defaults to true.

### `open`

Launches/connects the browser and opens a configured-site URL.

Input:

- `url`: optional site URL or path, defaults to the configured study path.

### `prepare_login`

Launches/opens the site, probes annotation auth, and if unauthenticated
clicks a visible sign-in/login/account control when present.

Use this for page preparation/debugging. For normal re-authentication, prefer
`login`.

### `login`

Launches/opens the site, probes annotation auth, and if unauthenticated uses the
configured 1Password login item to fill and submit the sign-in form. The
username, password, and any TOTP code stay inside the tool handler and are never
returned to the model.

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
