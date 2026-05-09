# Discord Edge Cases: Forwards, Pastes, /new

## Problem

Three Discord edge cases where messages are silently dropped or mangled:

1. **Forwarded messages** — Discord forwards have empty `message.content`; the original text lives in `message.messageSnapshots`. Tango saw empty content and replied "I received an empty message."

2. **Long pastes → message.txt** — Discord auto-converts pastes over ~2000 characters into a `message.txt` attachment. Since `message.content` is empty and Tango didn't download text attachments, these were also dropped.

3. **`/new` slash command** — Referenced in the brief as potentially broken, but investigation found no `/new` command registered and no agent prompts referencing it. The only slash command is `/tango` (with subcommands including `session reset`). Non-issue.

## Solution

Added three helper functions in `packages/discord/src/main.ts`:

### `extractForwardedContent(message)`
- Checks `message.reference?.type === MessageReferenceType.Forward`
- Iterates `message.messageSnapshots` to extract the forwarded text
- Returns the forwarded content, or null if not a forward

### `downloadTextAttachments(message)`
- Filters attachments for `.txt` files under 100KB
- Downloads content via `fetch()` and returns inlined text
- Logs warnings on download failures

### `resolveEffectiveContent(message)`
- Orchestrates both edge cases into a single async call
- For forwards: extracts snapshot text, prepends any user-added text with `[Forwarded message]` label
- For text attachments: inlines downloaded text when `message.content` is empty
- Falls back to `message.content` for normal messages

The `handleMessage` function now calls `resolveEffectiveContent(message)` instead of reading `message.content` directly. This feeds the effective text into command parsing, routing, prompt building, and inbound message storage.

Added diagnostic logging when edge-case resolution activates, showing original vs effective content length, forward status, and text attachment count.

## Files Changed

- `packages/discord/src/main.ts` — Import `MessageReferenceType`, add 3 helper functions, use `effectiveContent` in `handleMessage`

## Testing

- TypeScript compilation: clean
- Existing test suite: no regressions (4 pre-existing failures unrelated to this change)
- Live testing needed: forward a message and paste a long text block to Tango in Discord
