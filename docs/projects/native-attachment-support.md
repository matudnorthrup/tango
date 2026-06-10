# Native Attachment Support

- **Linear Project:** [Native Image/Attachment Support](https://linear.app/seaside-hq/project/native-imageattachment-support-a890d6bbf984)
- **Status:** Validation complete
- **Date:** 2026-06-01
- **Primary issue:** [TGO-576](https://linear.app/seaside-hq/issue/TGO-576/create-repo-project-documentation-for-attachment-architecture)

## Summary

Tango should treat attachments as a first-class Atlas domain, not as generic memory and not as per-turn prompt decoration. The system needs to ingest source files durably while Discord URLs are still valid, process them asynchronously into compact searchable records, and let every agent retrieve attachment knowledge through bounded tools.

The architecture deliberately separates three layers:

1. **Durable source store:** original files and derived artifacts live under the active Tango profile and are keyed by sha256 for deduplication.
2. **Atlas attachment domain:** structured metadata, source refs, processing state, jobs, extraction records, chunks, directory payloads, retention decisions, and audit history.
3. **Agent-facing directory and tools:** compact versioned JSON records support context-safe discovery; explicit retrieval tools provide exact text, source refs, status, and reprocessing.

High-volume image-heavy workflows are the power-user validation case: many images
per day, frequent `/new` resets, multi-day project continuation, and retrieval
of older images without flooding the model context.

## Goals

- Preserve attachments durably before source URLs expire.
- Store attachments in a first-class `atlas:attachments` domain separate from `atlas:memory`.
- Deduplicate original files by sha256 while preserving every source reference.
- Build a processing cascade that prefers deterministic extraction before OCR and LLM fallback.
- Create compact, versioned directory records for agent use.
- Expose retrieval/status/read/reprocess tools to all agents.
- Keep default context injection conservative so large attachment collections do not dominate turns.
- Support scoped retention policy with audit/review/grace before destructive actions.
- Validate high-volume, multi-image, multi-day usage before calling the project shipped.

## Non-Goals

- Do not store attachment directories as generic memories.
- Do not inject raw image bytes, full extracted documents, or large OCR outputs into normal context by default.
- Do not rely on in-memory attachment registries for cross-turn or cross-session behavior.
- Do not make the scheduler the main processing engine; it is a watchdog and maintenance layer.
- Do not perform destructive retention deletion during initial validation.
- Do not attempt full audio/video media understanding in the first architecture pass, beyond recording unsupported media metadata and status.
- Do not copy a private deployment wholesale; use its failures and usage
  evidence as requirements.

## Reference Inputs

Private handoff notes used as background and cautionary evidence are stored
outside the repo. Do not commit machine-local handoff paths.

Existing repo context:

- `docs/projects/native-image-attachment-support.md` captures the earlier discovery-stage temp-file/Read-tool design. This document supersedes it for durable Atlas-backed attachment architecture.

## Architecture Overview

```text
Discord / future channel input
        |
        v
Durable intake
  - download source while URL is valid
  - hash bytes with sha256
  - dedupe source file storage
  - record source refs and attachment registry row
        |
        v
Atlas attachment job queue
  - classify
  - embedded_text
  - apple_ocr
  - chunk
  - directory
  - llm_fallback
  - retention_review
        |
        v
In-process attachment worker
  - drains pending jobs
  - records attempts, locks, errors, quality scores
  - writes extraction, chunk, directory, and status records
        |
        v
Agent retrieval surface
  - compact directory context
  - attachment_search
  - attachment_read
  - attachment_status
  - attachment_reprocess
        |
        v
Scheduler maintenance
  - backlog watchdog
  - stale lock recovery
  - dry-run retention sweeps
  - review/grace queue reports
```

The intake path should be synchronous enough to make the file durable and visible as `pending`, but processing should not block a normal chat turn. Agents can answer immediately with "I received it and processing is pending" when needed, then retrieve processed knowledge once ready.

## Storage Layout

Source and derived files live under the active Tango profile, not a global temp directory:

```text
~/.tango/profiles/<profile>/data/attachments/
  sources/
    sha256/
      <first-2>/<sha256>/<safe-original-name>
  derived/
    <attachment-id>/
      extracted-text/
      ocr/
      thumbnails/
      normalized/
      manifests/
  retention/
    reviews/
    audit/
```

The exact directory names can change during implementation, but the invariants should hold:

- Paths are profile-scoped through the existing active profile mechanism.
- Originals are content-addressed by sha256.
- Multiple uploads of identical bytes reuse the same source file row/path.
- Each upload/source event keeps its own Discord/channel/thread/user/project/agent timestamp refs.
- Derived files point back to the original source file and extraction job that produced them.
- Files use restrictive permissions where the host supports them.

## Lifecycle

1. **Intake:** capture Discord metadata, download the file immediately, stream/hash bytes, enforce size/type caps, write or link the deduped source, and create Atlas attachment/file/source-ref records.
2. **Visibility:** mark the attachment `pending` with enough metadata for `attachment_status` and compact context to show that the file exists.
3. **Queue:** enqueue classification and extraction jobs in Atlas with status, attempt count, `run_after`, `locked_at`, `locked_by`, and error history.
4. **Processing:** an in-process worker drains jobs while the bot is running. Work is resumable because all state is durable.
5. **Directory generation:** write a compact `attachment_directory_v1` JSON payload with summary fields and source pointers.
6. **Retrieval:** agents discover and read attachment records through tools and conservative directory context.
7. **Maintenance:** scheduler jobs recover stale locks, report backlog, run dry-run retention sweeps, and later move candidates through review/grace before deletion.
8. **Reprocessing:** privileged or carefully gated tools can request reprocessing after new OCR strategies, schema versions, or user corrections.

## Data Model Sketch

This is a design sketch, not a migration spec.

### `atlas_attachment`

| Field | Purpose |
|---|---|
| `id` | Stable attachment id for tools and source refs |
| `profile_id` | Active Tango profile namespace |
| `source_kind` | `discord`, future `slack`, `email`, `local`, etc. |
| `source_message_id` | Discord message or equivalent source id |
| `source_channel_id` | Channel/thread routing scope |
| `source_user_id` | User who supplied the attachment |
| `project_id` | Optional active project association |
| `agent_id` | Agent context at intake |
| `filename_original` | User-visible original filename |
| `content_type_reported` | MIME from source platform |
| `content_type_detected` | MIME after sniffing/classification |
| `size_bytes` | Original byte size |
| `status` | `pending`, `partial`, `ready`, `failed`, `retention_review`, `archived` |
| `classification` | Image, PDF, text, document, spreadsheet-like, unsupported, archive/other |
| `created_at` / `updated_at` | Lifecycle timestamps |

### `atlas_attachment_file`

| Field | Purpose |
|---|---|
| `id` | File record id |
| `attachment_id` | Owning attachment/source event |
| `sha256` | Deduplication key |
| `role` | `source`, `normalized`, `thumbnail`, `extracted_text`, `ocr_text`, `manifest` |
| `path` | Profile-local filesystem path |
| `bytes` | File size |
| `content_type` | Detected type for this file |
| `created_by_job_id` | Processing job that generated this file, when derived |

### `atlas_attachment_job`

| Field | Purpose |
|---|---|
| `id` | Job id |
| `attachment_id` | Target attachment |
| `type` | `classify`, `embedded_text`, `apple_ocr`, `chunk`, `directory`, `llm_fallback`, `retention_review` |
| `status` | `queued`, `running`, `done`, `failed`, `canceled` |
| `attempts` | Retry count |
| `run_after` | Backoff scheduling |
| `locked_at` / `locked_by` | In-process worker lock |
| `error_history` | Structured failure records |
| `input_version` / `output_version` | Helps safe reprocessing |

### `atlas_attachment_extraction`

| Field | Purpose |
|---|---|
| `id` | Extraction record id |
| `attachment_id` | Target attachment |
| `strategy` | `embedded_text`, `apple_vision_ocr`, `llm_vision`, future extractors |
| `text_path` | Derived text artifact path when large |
| `text_inline` | Inline text for small outputs |
| `quality_score` | Aggregate confidence/usefulness estimate |
| `source_refs` | Page, region, bounding box, offsets, or frame refs |
| `metadata_json` | Extractor/version/model/cost details |

### `atlas_attachment_chunk`

| Field | Purpose |
|---|---|
| `id` | Chunk id |
| `attachment_id` | Target attachment |
| `extraction_id` | Source extraction |
| `text` | Bounded chunk text |
| `embedding_ref` | Search embedding/vector id if applicable |
| `source_ref` | Page/region/offset pointer back to original |
| `rank_hints` | Tables, key facts, OCR confidence, recency, project tags |

### `atlas_attachment_directory`

| Field | Purpose |
|---|---|
| `id` | Directory record id |
| `attachment_id` | Target attachment |
| `schema_name` | For example `attachment_directory` |
| `schema_version` | For example `1` |
| `payload_json` | Compact agent-facing summary |
| `generator` | Code/model and version that produced it |
| `source_refs` | Pointers to source/extraction/chunk ids |

Example `attachment_directory_v1` payload:

```json
{
  "schema": "attachment_directory_v1",
  "title": "Vendor invoice screenshot",
  "summary": "Screenshot of an invoice total and line items.",
  "types": ["image", "document_like"],
  "tags": ["invoice", "vendor", "finance"],
  "status": "ready",
  "key_facts": [
    {
      "text": "Total shown as $214.83",
      "source_ref": "chunk:attch_123:page_1:region_4"
    }
  ],
  "visual_notes": [
    {
      "text": "Document appears to be a phone screenshot, portrait orientation.",
      "source_ref": "extraction:ocr_456"
    }
  ],
  "available_reads": ["summary", "chunks", "quotes", "tables", "source_file"],
  "source": {
    "attachment_id": "attch_123",
    "file_sha256": "abc123...",
    "message_ref": "discord:channel/thread/message"
  }
}
```

Implementation note, 2026-06-01:

- `attachment_directory_v1` is a compact discovery record, not a raw text cache.
- The deterministic directory builder writes schema/generator metadata, normalized types/tags, summary, source refs, extraction quality/warnings, sections, key facts, snippets, notable quotes, detected tables, visual notes, and bounded chunk previews.
- Directory payloads use opaque refs such as `attachment:<id>`, `file:<id>`, `extraction:<id>`, `chunk:<id>`, `text:<extraction-id>:chars:<start>-<end>`, and `discord:<channel>:<thread?>:<message>`. Absolute source file paths stay out of the agent-facing directory payload.
- Exact facts, snippets, quotes, tables, and visual notes carry source refs so later retrieval tools can fetch bounded text or source material without injecting full documents into every turn.

## Processing Cascade

The cascade should prefer local and deterministic processing before model-based vision:

1. **Classification:** determine type from MIME, extension, sniffed bytes, size, page count, and source context.
2. **Embedded text first:** extract text from TXT, MD, CSV/TSV, PDF embedded text, DOCX, and other deterministic document formats where feasible.
3. **Apple Vision OCR next:** for images and scanned/document-like PDFs on macOS, run Apple Vision and capture line text, bounding boxes when feasible, confidence, page/frame refs, and aggregate quality.
4. **Quality evaluation:** decide whether extraction is sufficient using empty-output checks, confidence thresholds, text density, table/form detection, handwriting hints, visual-heavy classification, and explicit user request.
5. **LLM vision fallback:** run a fresh-context vision sub-agent only for attachments that deterministic extraction/OCR cannot handle well. The fallback writes structured results back to Atlas rather than relying on the main conversation context.
6. **Chunk and directory:** chunk extracted/OCR/fallback text with source pointers, then generate compact directory records.

Every processing stage should record strategy, version, quality, errors, and source refs so the system can explain why an attachment is `ready`, `partial`, or `failed`.

Implementation note, 2026-06-02:

- `attachment-llm-fallback` defines the bounded fallback contract, prompt version, JSON output parser, compact extraction formatter, and quality metadata.
- `createAttachmentProcessingHandlers(...)` accepts an optional `runLlmFallback` runner. When it is absent, empty OCR/text behavior stays partial and deterministic; when present, empty or low-quality extraction queues `llm_fallback` before `chunk` and `directory`.
- The fallback handler writes an `llm_vision_fallback` extraction with structured output, confidence, warnings, prior extraction id, prompt version, and provider metadata, then chunks the compact fallback text and regenerates the directory.
- Discord wires the production runner through provider failover, using the attachment's agent/session provider selection when available and a constrained `Read` tool surface for local source-file inspection.
- The runner stores provider/model/session/cost/usage/tool-call/failover metadata, but it does not store the raw fallback prompt or raw provider transcript in the main conversation.
- Targeted automated validation covers structured parser behavior and an empty-OCR image escalating through `llm_fallback -> chunk -> directory` with a fake provider runner.

Live validation on 2026-06-02 used the wt-2 profile database and the real PNG fixture from the handoff screenshot:

- Live attachment `9` was processed through a real `llm_fallback` job with provider failover. The provider path used `claude-oauth` and produced structured JSON without failover.
- The fallback wrote `llm_vision_fallback` extraction `6` with confidence `0.95`, structured quality metadata, three key facts, one visual note, and a compact text preview of the table in the screenshot.
- The worker then wrote chunk `7` and regenerated a ready directory with bounded summary, key facts, visual notes, and available reads. No raw provider transcript was stored in the conversation.

## Agent Retrieval and Context Behavior

All agents should be able to use attachments through shared tools:

- `attachment_search(query, scope, types, limit)` returns ids, titles, summaries, snippets, statuses, and source refs.
- `attachment_read(id, mode, range_or_query)` returns bounded summaries, chunks, exact quotes, tables, pages, or source file pointers. It should not return whole long documents by default.
- `attachment_status(scope?)` reports pending, failed, partial, and ready attachments in the relevant scope.
- `attachment_reprocess(id, strategy?)` queues privileged/admin or carefully gated reprocessing.

Implementation note, 2026-06-02:

- The Discord MCP surface now registers `attachment_search`, `attachment_read`, `attachment_status`, and `attachment_reprocess`.
- Search ranks compact directory fields and chunk matches, returning bounded results with source refs and no local source-file paths.
- Read modes include `summary`, `directory`, `snippets`, `chunks`, `chunk`, `quotes`, `tables`, `visual_notes`, `source_file`, and `extracted_text`; exact text is range-bounded and source-referenced.
- Status returns scoped counts, recent attachments, directory state, and job summaries.
- Reprocess idempotently queues a selected processing job and remains a write/admin tool.
- Every V2 agent config has a read-only `attachments` MCP server allowlist for `attachment_search`, `attachment_read`, and `attachment_status`.
- Governance migration v36 seeds the three attachment read tools for all worker principals while leaving `attachment_reprocess` out of default worker permissions.
- `AttachmentStore.listDirectoriesForContext(...)` retrieves the latest scoped directory records for compact prompt use.
- `buildAttachmentDirectoryContext(...)` selects directory records by thread, parent channel, agent scope, query relevance, and explicit attachment requests.
- Recent-reference suppression prevents reinjecting attachment/source refs that already appear in recent chat unless the user explicitly asks about attachments.
- Cold-start and Discord V2 warm-start prompts can include an `Attachment directories` block alongside existing memory context without injecting raw extracted text.
- Warm-start model-run metadata records attachment directory trace, prompt chars, rendered selected entries, omitted count, and source refs for debugging.
- Shared agent rules now tell every V2 agent to use visible directory context or `attachment_search`/`attachment_read` before asking users to resend uploads, cite source refs for exact claims, handle pending/failed states explicitly, and never expose absolute local file paths.

Live validation on 2026-06-02 used the slot 2 Discord bot against real processed image/document attachment records:

- Watson recovered `attachment:6` (`directory-live-start-here.md`) and `attachment:5` (`directory-live-image-source-ref.png`) from starting context without calling `mcp__attachments__attachment_*` tools.
- Latest context validation run recorded `warmStartPromptChars=2365`, `attachmentDirectoryContext.promptChars=2171`, rendered selected count `2`, and omitted count `3`.
- A separate live prompt-rule check confirmed Watson's live system instructions included the search/read-before-resend, source-ref citation, pending/failed status, and no-local-path rules.

Default context injection starts conservative:

- Inject compact directory entries only when relevant to the active channel/project/session, recent direct use, or explicit user request.
- Prefer directory records over raw extracted text.
- Suppress reinjection when the same attachment/source refs are already present in recent history.
- Use retrieval tools for exact snippets, quotes, tables, or larger sections.
- Surface pending/failed status clearly so agents do not ask users to resend files unnecessarily.
- Require source refs for exact claims, extracted text, and quotes.

This avoids the failure mode from the image-heavy fork where repeatedly attaching or replaying images caused context growth. The long-term direction is to evolve automatic context rules after real attachment data exists, not to overfit rules before validation.

## Retention Policy

Retention must be explicit, scoped, editable, and auditable.

Supported rule scopes:

- Global default
- User
- Project
- Agent
- Channel/thread
- Attachment-specific override

Rules should be able to decide separately for:

- Original source files
- Normalized/converted files
- Extracted text
- OCR text
- Chunks and embeddings
- Directory payloads
- Markdown/text sidecars
- Audit and retention decision records

Match criteria should include document type, project tags, sensitivity, source platform, channel, age, status, explicit user pin/hold, and legal/manual hold. Conflict resolution should be predictable: attachment-specific rules override narrower operational defaults, destructive actions require review/grace, and audit records survive longer than the artifacts they describe.

Initial validation must run retention in report/dry-run mode only. Destructive deletion is gated behind:

- Review queue entry with affected artifacts listed.
- Grace period before execution.
- Audit record for decision, actor, rule version, and evidence.
- Recovery or reprocessing story for derived artifacts where the original is retained.

Implementation note, 2026-06-02:

- Retention rules are human-editable YAML files under `config/*/attachment-retention-rules/`.
- `loadAttachmentRetentionPolicy(...)` loads layered rules with schema versions and produces a policy version fingerprint.
- `evaluateAttachmentRetention(...)` evaluates a real attachment record against global, user, project, agent, channel, thread, and attachment scopes.
- Decisions are artifact-level across originals, derived files, extracted text, chunks, embeddings, directories, and sidecars.
- Evaluation returns matched rules, per-artifact reasons, effective/review dates, an overall decision, and whether destructive outcomes require review.
- Evaluation never applies deletion or retirement. `retentionDecisionInputFromEvaluation(...)` creates a proposed decision payload with `destructiveActionsApplied: false` for later review/sweep flows.

Lifecycle maintenance implementation note, 2026-06-02:

- `runAttachmentRetentionSweep(...)` evaluates ready/partial/failed attachments and can write proposed review decisions when `writeReviewDecisions` is enabled. It dedupes active proposals for the same attachment, policy version, and decision.
- `listAttachmentRetentionReviewQueue(...)` exposes due proposed/approved decisions ordered for review, using `review_after` as the grace/review gate.
- `runAttachmentBacklogWatchdog(...)` counts stale running jobs, recovers stale locks back to pending, surfaces failed jobs, and writes proposed review decisions for stuck partial/processing attachments.
- `attachment-retention-sweep` and `attachment-backlog-watchdog` are deterministic scheduler handlers registered during Discord startup. The schedules live under `config/defaults/schedules/` and never delete or retire artifacts.
- Scheduler deterministic execution now preserves handler `data` as run metadata so sweep/watchdog summaries and decision ids are auditable from schedule run records.

Live validation on 2026-06-02 used an isolated worktree profile database:

- The loaded `attachment-retention-sweep` schedule created proposed retention decision `1` for live attachment `7` from a user-requested-delete rule, with `destructiveActionsApplied: false`.
- The loaded `attachment-backlog-watchdog` schedule recovered stale job `21` from `running` to `pending`, cleared its lock, and created proposed watchdog review decision `2` for stuck partial attachment `8`.
- The schedule run summaries recorded `decisions_written=1`, `recovered_stale_locks=1`, `stuck_attachments=1`, and `review_decisions_written=1`.

## Validation Gates

The project is not done until live end-to-end validation is documented in Linear issue comments for every validation milestone. Unit tests are useful but not sufficient.

Minimum validation gates:

- **Schema/repository:** migrations create the first-class attachment domain and repository APIs work against a real profile database.
- **Durable intake:** a real Discord image and a real document are downloaded while URLs are valid, hashed, deduped, and recorded with source refs.
- **Queue lifecycle:** jobs survive restart, retry, stale lock recovery, and failure reporting.
- **Processing cascade:** embedded text extraction, Apple Vision OCR, and LLM fallback each produce structured Atlas records in representative cases.
- **Directory layer:** `attachment_directory_v1` records are compact, searchable, versioned, and source-linked.
- **Agent tools:** search/read/status/reprocess work from every agent that should access attachments.
- **Context behavior:** compact directory injection helps discovery without raw document/image flooding or duplicate reinjection.
- **Retention dry run:** scoped rules produce review/audit/grace records without deleting artifacts.
- **Power-user scenario:** high-volume image-heavy workflow validates
  multi-image, multi-day retrieval across `/new` resets and normal
  continuation.

Ship is blocked until validation milestone issues are Done with evidence.

Automated coverage implemented by 2026-06-02:

- Schema, migrations, repository APIs: `attachments-store.test.ts`, `storage.test.ts`, `governance.test.ts`.
- Durable file store hashing/deduplication: `attachment-file-store.test.ts`, `attachment-processor.test.ts`.
- Queue lifecycle, retries, stale locks, watchdog: `attachment-worker.test.ts`, `attachment-lifecycle-maintenance.test.ts`.
- Text extraction, Apple OCR, classifier escalation, LLM fallback: `attachment-text-extractor.test.ts`, `apple-vision-ocr.test.ts`, `attachment-classifier.test.ts`, `attachment-processing.test.ts`, `attachment-llm-fallback.test.ts`.
- Directory payloads, chunks, source refs, bounded context: `attachment-processing.test.ts`, `attachment-context.test.ts`, `session-lifecycle.test.ts`, `v2-runtime.test.ts`.
- Agent tool bounds and prompt rules: `attachment-agent-tools.test.ts`, `attachment-processor.test.ts`, `malibu-system-prompt.test.ts`, `v2-config-loader.test.ts`.
- Retention policy, review queue, scheduler metadata: `attachment-retention-policy.test.ts`, `attachment-lifecycle-maintenance.test.ts`, `scheduler-executor.test.ts`, `config.test.ts`.

Live Discord validation, 2026-06-02:

- Slot 2 Watson thread `100000000000000401` received two real Discord attachments in message `100000000000000402`: image `100000000000000403` and Markdown document `100000000000000404`.
- The image became `attachment:10`, processed through `apple_vision_ocr` extraction `7`, chunk `8`, and ready directory `8`.
- The Markdown document became `attachment:11`, processed through `utf8_text` extraction `8`, chunks `9` and `10`, and ready directory `9`.
- Watson's stricter retrieval turn used `mcp__attachments__attachment_search` and `mcp__attachments__attachment_read`, returned `attachment:10`, `attachment:11`, the shared Discord source ref, and the four filenames visible in image chunk `8`.
- The retrieval model run selected the two new attachment directories in warm-start context with `attachmentDirectoryContext.promptChars=2242`, `warmStartPromptChars=2436`, selected count `2`, and omitted count `7`, demonstrating bounded directory context rather than raw file injection.

High-volume validation, 2026-06-02:

- The isolated profile seeded 128 ready image attachments for marker `tgo-586-volume-1780408500000`, split across two simulated project days with 64 images per day and mixed screenshot, reference-photo, document-like, swatch, whiteboard, receipt, layout, and annotated-image categories.
- The older day-one target is `attachment:29` / chunk `28` / directory `27`, with codename `cerulean-loom`; the recent day-two target is `attachment:128` / chunk `127` / directory `126`, with codename `amber-invoice`.
- Direct tool sanity check found `attachment:29` from the full corpus with `attachment_search` and returned the exact cobalt boucle/brushed brass/Mara facts through `attachment_read` chunk `28`.
- Live Watson old-thread retrieval response `messages.id=1638` found `attachment:29` from the high-volume corpus even though warm-start directory context selected only recent attachments `139` and `138`. The run used `mcp__attachments__attachment_search`, recorded `attachmentDirectoryContext.promptChars=2190`, `warmStartPromptChars=2384`, selected count `2`, and omitted count `29`.
- After restarting the wt-2 Discord slot to simulate a reset/new thread, fresh Watson thread `100000000000000405` answered response `messages.id=1640` from the same durable corpus. Model run `1039` used both `mcp__attachments__attachment_search` and `mcp__attachments__attachment_read`, returned `attachment:29`, filename `tgo-586-volume-1780408500000-day1-18-reference_photo.png`, source ref `text:26:chars:0-423`, and the grounded fabric/finish/owner/condition facts.
- The post-reset run used a new provider session id `4ad5f323-f8d4-447d-89d1-196bddaa971e`; warm-start context stayed bounded at `attachmentDirectoryContext.promptChars=2093`, `warmStartPromptChars=2287`, selected count `2`, and omitted count `24`. The selected directory ids did not include `attachment:29`, so the old target was recovered through tools rather than raw or repeated image context.

## Risks and Open Questions

- **Context pressure:** even directory records can flood context for 50-100 images/day if selection rules are too broad.
- **OCR quality:** Apple Vision confidence and layout capture may be insufficient for tables, forms, and handwriting.
- **LLM fallback cost:** hard images can become expensive if escalation thresholds are too loose.
- **Cross-platform OCR:** Apple Vision is macOS-specific; Linux deployments need a feature-detected fallback or degraded mode.
- **Native vision transport:** Read-tool/path-based access works for some flows, but native multimodal transport may be needed for higher-fidelity visual reasoning. The attachment domain should support either.
- **File privacy:** profile-scoped files still need permissions, source allowlists, and careful path exposure in prompts/tools.
- **Dedup semantics:** identical bytes may appear in different projects or channels; dedupe storage must not collapse source refs, permissions, or retention policy.
- **Schema evolution:** directory payloads need versioning and migration/reprocessing paths without blocking current retrieval.
- **Deletion safety:** retention can destroy user-important originals; initial validation should prove review/audit before enabling deletion.
- **Forwarded Discord messages:** forwarded content may not carry original attachments; agents may need a nudge to ask for direct re-upload when the source platform omits files.

## Linear Issue Mapping

| Issue | Milestone | Architecture responsibility |
|---|---|---|
| [TGO-573](https://linear.app/seaside-hq/issue/TGO-573/create-first-class-atlasattachments-schema-and-repository-apis) | Atlas domain and durable source store | Create first-class `atlas:attachments` schema, repository APIs, indexes, and separation from generic memory. |
| [TGO-574](https://linear.app/seaside-hq/issue/TGO-574/implement-durable-source-file-store-with-hashing-and-deduplication) | Atlas domain and durable source store | Implement profile-scoped durable source store, sha256 hashing, dedupe, source refs, and file metadata. |
| [TGO-575](https://linear.app/seaside-hq/issue/TGO-575/build-durable-attachment-job-queue-and-in-process-worker-lifecycle) | Atlas domain and durable source store | Build Atlas-backed job queue, in-process worker, retries, locks, stale recovery, and scheduler watchdog hooks. |
| [TGO-576](https://linear.app/seaside-hq/issue/TGO-576/create-repo-project-documentation-for-attachment-architecture) | Discovery and architecture | Preserve the settled architecture in this repo document. |
| [TGO-577](https://linear.app/seaside-hq/issue/TGO-577/add-apple-vision-ocr-helper-with-confidence-capture) | Processing pipeline and OCR cascade | Add Apple Vision OCR with confidence, regions, aggregate quality, and graceful feature detection. |
| [TGO-578](https://linear.app/seaside-hq/issue/TGO-578/generate-versioned-attachment-directory-records-and-searchable-chunks) | Processing pipeline and OCR cascade | Generate versioned directory payloads, chunks, key facts, tags, summaries, and source-linked searchable records. |
| [TGO-579](https://linear.app/seaside-hq/issue/TGO-579/implement-llm-vision-sub-agent-fallback-for-hard-attachments) | Processing pipeline and OCR cascade | Add fresh-context LLM vision fallback for low-quality or impossible deterministic extraction. |
| [TGO-580](https://linear.app/seaside-hq/issue/TGO-580/implement-attachment-classification-and-escalation-policy) | Processing pipeline and OCR cascade | Classify attachment types and decide extraction/OCR/fallback jobs using configurable escalation rules. |
| [TGO-581](https://linear.app/seaside-hq/issue/TGO-581/expose-attachment-searchreadstatusreprocess-tools-to-all-agents) | Agent retrieval tools and context integration | Expose bounded `attachment_search`, `attachment_read`, `attachment_status`, and `attachment_reprocess` tools. |
| [TGO-582](https://linear.app/seaside-hq/issue/TGO-582/integrate-attachment-directories-into-memory-and-cold-start-context) | Agent retrieval tools and context integration | Add conservative directory injection, dedupe rules, relevance selection, and retrieval-first behavior. |
| [TGO-583](https://linear.app/seaside-hq/issue/TGO-583/update-agent-and-shared-instructions-for-attachment-usage) | Agent retrieval tools and context integration | Teach agents to search/read/status attachments, cite source refs, handle pending/failed states, and avoid unnecessary resend requests. |
| [TGO-584](https://linear.app/seaside-hq/issue/TGO-584/implement-editable-scoped-retention-rules-for-attachments) | Retention policy and lifecycle maintenance | Implement scoped editable retention rules for originals, derived artifacts, chunks, directories, and sidecars. |
| [TGO-585](https://linear.app/seaside-hq/issue/TGO-585/add-retention-review-queue-audit-trail-and-sweepwatchdog-jobs) | Retention policy and lifecycle maintenance | Add review queue, audit trail, grace period, dry-run reporting, backlog watchdog, and retention sweeps. |
| [TGO-586](https://linear.app/seaside-hq/issue/TGO-586/validate-high-volume-multi-day-image-workflow) | Validation and ship | Validate high-volume image-heavy, multi-day retrieval without context flooding. |
