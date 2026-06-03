# attachment_search, attachment_read, attachment_status

Use these tools when a user asks about images, screenshots, PDFs, CSVs, markdown files, or other documents they have uploaded to Tango.

Agents may also receive a `Relevant attachment directories` context block. That block is a compact index only: use it to identify likely attachments and source refs, then call these tools when the user needs exact text, quotes, tables, or more detail.

Default behavior:
- Do not ask the user to resend an upload until `attachment_search`/`attachment_status` cannot find it or it is not processed yet.
- Prefer compact summaries, snippets, chunks, and tables over full extracted text.
- Cite returned source refs for exact claims and quotes.
- Do not expose absolute local source-file paths.

## `attachment_search`

Find processed attachments without loading full extracted text.

Use it when:
- The user refers to an uploaded file without giving an exact attachment id.
- You need to find prior images/documents by topic, filename, type, project, channel, or session.
- You need a compact list of summaries, snippets, statuses, and source refs.
- Directory context mentions a likely attachment but you need to confirm its current status or locate related attachments.

Important parameters:
- `query`: optional search text. Empty query returns recent matching attachments.
- `types`: optional filters such as `image`, `ocr_text`, `text/markdown`, `pdf`.
- `project_id`, `agent_id`, `session_id`, `channel_id`, `thread_id`, `user_id`: optional scope filters.
- `limit`: default 8, max 25.

## `attachment_read`

Read a bounded part of one attachment.

Use it when:
- `attachment_search` found a likely match and you need a summary, snippets, chunks, tables, or exact extracted text.
- The user asks for a quote or specific detail from a known attachment.
- You need source refs for a claim.
- Directory context contains `available_reads` and you need one of those bounded views.

Modes:
- `summary`: default compact view.
- `directory`: full compact directory payload.
- `snippets` or `quotes`: source-linked key text.
- `chunks`: bounded chunks, optionally filtered by `query`.
- `chunk`: one chunk by `chunk_id` or `chunk_ordinal`.
- `tables`: detected table previews.
- `visual_notes`: OCR/image processing notes.
- `source_file`: source metadata and refs without exposing absolute file paths.
- `extracted_text`: bounded extracted text. Use `offset` and `max_chars`; default max is 4000, hard max is 12000.

Do not request `extracted_text` first for large documents. Start with `summary`, `snippets`, or `chunks`.

For exact quotes, prefer `snippets`, `quotes`, `chunk`, or filtered `chunks` and include the returned text/source ref in the answer. For long documents, use `offset` and `max_chars` instead of asking for all extracted text.

## `attachment_status`

Check processing state.

Use it when:
- The user asks whether an upload is ready.
- An attachment search/read does not find expected data.
- You need to distinguish pending, partial, failed, and ready attachments.

Status guidance:
- `ready`: directory and retrieval views should be usable.
- `partial`: some text/directory data may exist; answer with caveats and retrieve the available bounded views.
- `processing`, `received`, or pending jobs: tell the user it is still processing and check again later only if a follow-up mechanism is available.
- `failed`: say processing failed and use any returned error/status details. Do not invent OCR or missing text.
- `retired`: source or derived data may no longer be available under retention rules.

## `attachment_reprocess`

This write/admin tool is intentionally not in the default agent allowlists. Use only when explicitly enabled and the user/admin wants to retry or upgrade processing.
