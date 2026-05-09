# Native Image/Attachment Support — Design Document

**Linear Project:** [Native Image/Attachment Support](https://linear.app/seaside-hq/project/native-imageattachment-support-a890d6bbf984)
**Status:** Discovery
**Date:** 2026-05-09

---

## Current State

Tango has **no image/attachment processing**. When Discord users send attachments:

1. `attachmentsForMetadata()` (`main.ts:6172`) captures metadata (id, name, url, contentType, size) and logs it
2. `buildPrompt()` (`main.ts:2813`) generates a text fallback: `"User sent 2 attachment(s): image.png, doc.pdf"`
3. The actual image/file content is **never downloaded or passed** to Claude

The metadata is stored in the message record but never used by the LLM.

## Discord Attachment API

Discord's `message.attachments` is a `Collection<Snowflake, Attachment>` with:

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | Snowflake ID |
| `name` | string | Original filename |
| `url` | string | CDN URL (expires after ~24h for ephemeral, permanent for uploaded) |
| `proxyURL` | string | Discord proxy URL (more stable) |
| `contentType` | string \| null | MIME type (`image/png`, `application/pdf`, `text/plain`, etc.) |
| `size` | number | Bytes |
| `width` | number \| null | Image/video only |
| `height` | number \| null | Image/video only |

**Attachment types encountered:**
- **Images:** PNG, JPG, GIF, WebP (most common case — photos, screenshots)
- **Text files:** `.txt` (Discord auto-converts long pastes to `message.txt` attachments)
- **Documents:** PDF, DOCX
- **Audio:** Voice messages (OGG), audio files
- **Video:** MP4, MOV
- **Forwarded messages:** Do NOT carry the original message's attachments; forwarded content appears as an embed, not an attachment

## Claude Code CLI Input Capabilities

### Two Runtime Paths in Tango

1. **ClaudeCliProvider** (`provider.ts`): Used by the turn-executor for most Discord messages. Passes the prompt as a **CLI argument** (`args.push(request.prompt)`) with `--output-format stream-json`.

2. **ClaudeCodeAdapter** (`claude-code-adapter.ts`): Used for V2 scheduled turns. Pipes prompt via **stdin** with `--print --output-format json`.

Both paths are **text-only** today. Neither supports multimodal content blocks.

### Claude Code CLI Multimodal Options

| Approach | How | Status |
|----------|-----|--------|
| `--input-format stream-json` with image content blocks | Stream JSON messages with `{"type":"image","source":{"type":"base64",...}}` blocks | **Undocumented**, format unstable (GitHub issue #24594). Requires `--output-format stream-json --verbose`. |
| Read tool on local files | Claude Code's built-in Read tool can natively read images (PNG, JPG, etc.) and PDFs | **Works today** under `--dangerously-skip-permissions`. Confirmed in tool description. |
| Prompt with base64 data URI | Embed `data:image/png;base64,...` in the text prompt | Not natively supported by Claude Code CLI; would be stripped or treated as text. |
| `--file` flag | `--file file_id:relative_path` downloads file resources at startup | Designed for IDE integrations, not arbitrary URLs. |

### Key Finding: Read Tool Is the Reliable Path

Claude Code's Read tool explicitly states: "This tool allows Claude Code to read images (eg PNG, JPG, etc). When reading an image file the contents are presented visually as Claude Code is a multimodal LLM." It also reads PDFs (up to 20 pages per request).

This means **downloading to a temp file + telling Claude Code the path** is the most robust approach. This is essentially [redacted]'s workaround, but done properly.

## Recommended Architecture: Option A — Download + Read Tool

### Why Option A

- **Proven:** [redacted]'s workaround confirms this works end-to-end
- **Stable:** Uses documented, supported Claude Code features (Read tool)
- **Flexible:** Handles images, PDFs, text files — anything the Read tool supports
- **No CLI changes needed:** Works with both ClaudeCliProvider and ClaudeCodeAdapter paths

### Why NOT Options B/C

- **Option B (stream-json multimodal):** `--input-format stream-json` is undocumented, the message schema is unstable, and it requires switching both provider paths to stream-json I/O. The ClaudeCliProvider passes prompts as CLI args, not stdin, so this would be a major refactor.
- **Option C (data URIs):** Claude Code CLI doesn't parse data URIs from text prompts. The data would be treated as a long string, not an image.

## Proposed Architecture

### New Module: `packages/discord/src/attachment-processor.ts`

```
Discord Message
    │
    ▼
attachment-processor.ts
    │ Download to /tmp/tango-attachments/<sessionId>/
    │ Return metadata + local paths
    ▼
Prompt Builder (buildPrompt / warm-start context)
    │ Inject: "The user attached image.png. Read it at /tmp/tango-attachments/.../image.png"
    ▼
Claude Code CLI (either path)
    │ LLM uses Read tool to view the image/PDF/text
    ▼
Response
```

### Core Responsibilities

1. **Download**: Fetch attachment URLs to temp directory, organized by session ID
2. **Classify**: Determine handling strategy based on contentType:
   - Images (PNG, JPG, GIF, WebP): Download as-is, tell Claude to Read
   - PDFs: Download as-is, tell Claude to Read (with page hints for large PDFs)
   - Text files (`.txt`, `.md`, `.json`, `.csv`): Download and inline content directly in prompt (cheaper than a tool call)
   - Unsupported (video, audio, archives): Log metadata only, tell Claude what was received but not processable
3. **Prompt injection**: Build a structured section appended to the user's message
4. **Cleanup**: Remove temp files after the turn completes (or on a TTL timer)

### Prompt Injection Format

```
[Attachments]
1. receipt.png (image/png, 245KB) — Read the file at /tmp/tango-attachments/abc123/receipt.png to view this image.
2. notes.txt (text/plain, 1.2KB) — Contents inlined below:
---
<file contents>
---
```

### Integration Points

**`main.ts` — message handler (~line 7420)**
Before `buildPromptWithReferent()`, call the attachment processor:

```typescript
const attachmentContext = await processAttachments(message.attachments, promptRoute.sessionId);
// Prepend to prompt or inject as context
```

**`turn-executor.ts` — warm-start context**
For re-injection on follow-up messages, store processed attachment references in the session. The warm-start context builder can include: "Earlier in this conversation, the user shared receipt.png — it's available at /tmp/tango-attachments/.../receipt.png"

**`claude-code-adapter.ts` — no changes needed**
The adapter pipes text prompts; the LLM will use its Read tool autonomously.

**`provider.ts` — no changes needed**
Same: prompt text includes file paths, LLM reads them via tools.

### Warm-Start Re-injection

Images shared in message 1 must be accessible in message 5. Strategy:

1. **Temp files persist per session** (not per turn). Directory: `/tmp/tango-attachments/<sessionId>/`
2. **Session attachment registry**: Track `{filename, localPath, contentType, size, messageIndex}` per session
3. **Warm-start builder**: Include attachment manifest in warm-start context so the LLM knows what files are available even without the original message in context
4. **Cleanup**: Purge session attachment directory when session ends or after 24h TTL (whichever comes first)

### Size Limits

| Type | Max Size | Rationale |
|------|----------|-----------|
| Images | 20MB | Claude API limit for images |
| PDFs | 30MB | Generous for scanned docs |
| Text files | 500KB | Inline in prompt; larger ones get downloaded for Read tool |
| Total per message | 50MB | Prevent abuse |
| Total per session | 200MB | Disk budget |

Files exceeding limits get metadata logged but not downloaded, with a message to the user.

## Agent Use Cases

| Agent | Primary Use | Attachment Types |
|-------|------------|------------------|
| Watson | Receipt photos, invoices, tax documents | Images, PDFs |
| Malibu | Food photos for nutrition logging, workout screenshots | Images |
| Sierra | Reference images, research screenshots, diagrams | Images, PDFs, text |
| Victor | Operational screenshots, config files | Images, text |

All agents benefit equally since the attachment processor is a shared middleware layer.

## Phased Implementation Plan

### Phase 1: Image Support (MVP)
- `attachment-processor.ts` module: download, classify, cleanup
- Image support only (PNG, JPG, GIF, WebP)
- Prompt injection in `main.ts`
- Session-scoped temp directory with cleanup
- **Scope:** ~200-300 lines of new code, touches 2 files

### Phase 2: Document Support
- PDF download + Read tool integration (with page count hints)
- Text file inlining for small files, Read tool for large ones
- Discord auto-converted `message.txt` handling (treat as inline text, not attachment)
- **Scope:** ~100 lines added to processor

### Phase 3: Warm-Start Re-injection
- Session attachment registry in storage
- Warm-start context builder integration
- Attachment manifest in warm-start prompt
- **Scope:** ~150 lines, touches turn-executor and warm-start builder

### Phase 4: Voice Pipeline
- Voice messages (OGG) → transcription → text injection
- Image descriptions from voice context ("I'm sending you a photo of...")
- **Scope:** TBD, depends on voice pipeline architecture

## Trade-offs and Risks

| Risk | Mitigation |
|------|------------|
| Discord CDN URLs expire | Download immediately on message receipt, before queuing |
| Temp disk fills up | TTL cleanup + per-session size caps |
| Large images slow down turns | Size limits + async download (don't block prompt routing) |
| Read tool adds latency (extra API turn) | Text files inlined directly; images require Read but that's one tool call |
| `--dangerously-skip-permissions` required for Read | Already used by both runtime paths |
| **Read tool image reliability (GH #35866)** | Issue reports broken MIME detection and failed image delivery on some platforms (Bedrock). Closed as NOT_PLANNED. **Phase 1 must validate Read tool image delivery in our environment before committing.** Fallback: switch to Agent SDK with native multimodal content blocks if Read tool proves unreliable. |

### Fallback: Agent SDK Direct Integration

If Phase 1 validation reveals the Read tool cannot reliably deliver images to the model, the fallback is to replace the Claude Code CLI spawn with the **Claude Agent SDK** (`@anthropic-ai/claude-code` npm package) which supports native multimodal content blocks:

```typescript
content: [
  { type: "text", text: "User message here" },
  { type: "image", source: { type: "base64", media_type: "image/png", data: base64Data } }
]
```

This would require refactoring the provider/adapter layer but gives guaranteed multimodal support. The attachment-processor download/classify/cleanup module remains the same regardless of delivery mechanism.

## Open Questions

1. **Should we cache processed images across sessions?** If the same image URL appears in multiple sessions (e.g., user forwards same screenshot), we could deduplicate. Probably not worth it for MVP.
2. **GIF handling:** Animated GIFs — should we extract first frame or pass as-is? Claude's vision handles static images; need to test GIF support.
3. **Embed images:** Discord embeds (link previews) contain thumbnail images. Should we process those too? Probably not for MVP.
