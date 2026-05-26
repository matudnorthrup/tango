# LDS Companion Workflows

Reusable workflow guidance for Porter.

## Source Hierarchy

- Start with LDS primary sources: standard works, General Conference, official
  manuals, Gospel Library content, and the General Handbook when available.
- Use external scholarship, psychology, history, and interfaith sources as
  supplementary interpretation. Label them as such.
- Separate doctrine, policy, historical context, personal interpretation, and
  practical advice.
- Never present an unverified sentence as a quotation. If exact wording has not
  been read in the current context or verified with a tool, paraphrase it and
  label it as a paraphrase. A scripture or conference reference by itself is a
  source citation, not verified wording.
- Do not manufacture authority. The agent can draft and reason; Devin and local
  leaders decide.

## Scripture Study

1. Read the passage in context before building a theme.
2. Identify repeated words, contrasts, covenant language, promised blessings,
   commands, and narrative structure.
3. Add cross-references and official LDS sources after the first-pass reading.
4. If the user is exploring ideas, offer multiple readings and name their
   tradeoffs.
5. End with practical application only after the textual work is done.

## Talk Prep

Use this structure unless the user gives another:

- Central claim: one sentence the talk is actually about.
- Hook: short personal, scriptural, or situational opening.
- Movement 1: scripture foundation.
- Movement 2: prophetic or official source support.
- Movement 3: practical application and honest obstacle.
- Close: concise testimony or invitation without emotional pressure.

Cut anything that sounds like filler, throat-clearing, or generic church talk.

## Lesson Prep

- Define the lesson objective before collecting quotes.
- Build questions that create thinking, not trivia recitation.
- Use activities only when they produce a clearer discussion.
- Include backup scriptures and optional deeper material.
- Flag anything too speculative for the setting.

## Sacrament Meeting Conducting

- Keep language short, reverent, and operational.
- Do not over-explain ordinances or transitions.
- Preserve exact names, callings, hymn numbers, prayers, speakers, sustainings,
  releases, confirmations, and announcements.
- Use placeholders for anything unconfirmed.

## Gospel Library Marking Taxonomy

- Red: principle
- Orange: ponder
- Yellow: mission or calling
- Brown: historical or context
- Teal: personal connection
- Purple: lesson material
- Pink: favorite
- Gray: common or first pass

Highlight means full engagement with a passage. Underline means a phrase or
lighter mark.

## Gospel Library Annotation Workflow

- Use the authenticated Church website session. Page-context browser requests
  are required so cookies are included.
- Do not ask the user to open a browser tab. The agent should launch/navigate
  with `gospel_library status`, `gospel_library open`, `gospel_library
  login`, or the generic browser tool.
- If logged out, use `gospel_library login` first. It uses the configured
  1Password Church login item internally and does not expose the password to the
  model. Ask the user only for 1Password access fixes, captcha, or 2FA.
- Devin has authorized this exact Church-account login automation. Do not ask
  for permission before using `gospel_library login`.
- Do not retrieve the Church password with the generic `onepassword` tool or
  type it through the generic browser tool. `gospel_library login` is the only
  approved Church credential path.
- Never store, print, or hardcode personal identifiers from annotation payloads.
- Before writing, identify the exact scripture URI, annotation type, color or
  style, refs, tags, folders, and target note/link.
- For partial scripture marks, use Gospel Library word-token offsets, not
  character offsets: count visible whitespace-separated tokens with the verse
  number as token 1, and treat `endOffset` as inclusive.
- For user-visible underlines, use `style: "red-underline"` with a visible
  palette `color` such as `yellow`; do not use `color: "clear"` unless the user
  explicitly asks for a no-color/invisible-style annotation.
- After writing, verify by reading the annotation or the relevant annotation
  list, then verify the rendered phrase text when a partial underline or
  highlight is involved. Footnotes may split one phrase into multiple rendered
  mark nodes.
- Report the annotation ID and verification status. Keep private IDs out of
  the user-facing response.

## Obsidian Workflow

- Read existing notes before editing.
- Preserve frontmatter, headings, links, tags, and dates.
- For talks and lessons, prefer durable notes with source links and concise
  outlines over long prose drafts unless prose is requested.
- Return the note path and receipt after any write.

## Email Workflow

- Email is read-only for Porter.
- Use email only for context gathering: dates, assignments, names, attachments,
  and decisions already made.
- Return message IDs, dates, senders, and extracted facts.
- Never draft, send, archive, label, delete, or modify email.
