/**
 * Notion Agent Tools — direct Notion API integration (stable, long-lived).
 *
 * Replaces the Latitude remote-MCP bridge for Notion, which relied on an OAuth
 * token that expired hourly and did not reliably refresh. This tool uses a
 * Notion *internal integration token* (no expiry) the same way the Linear/Slack
 * tools use direct API keys.
 *
 * Credentials are resolved entirely from the environment/profile layer: this
 * repo carries no vault name, item name, workspace id, or page id belonging to
 * any particular operator. See `agents/tools/notion.md` for the generic setup
 * and `docs/guides/profile-model.md` for the layering rules.
 *
 * Setup (one-time, per installation):
 *   1. Create an internal integration at notion.so/my-integrations.
 *   2. Share the pages/databases it should reach with that integration.
 *   3. Expose the token as NOTION_API_KEY, or point Tango at a 1Password item
 *      with NOTION_1PASSWORD_VAULT + NOTION_1PASSWORD_ITEM.
 */

import type { AgentTool } from "@tango/core";
import { getSecret } from "./op-secret.js";

const NOTION_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

/** Notion caps a single rich-text run at 2000 characters. */
const RICH_TEXT_LIMIT = 2000;
/** Notion caps one block-children request at 100 blocks. */
const MAX_BLOCKS_PER_REQUEST = 100;
/** Depth limit when flattening nested blocks on read. */
const MAX_BLOCK_DEPTH = 3;
/** Page-cursor guard when walking block children. */
const MAX_BLOCK_PAGES = 20;

/* -------------------------------------------------------------------------- */
/* Credentials (profile layer — never hardcoded in this repo)                  */
/* -------------------------------------------------------------------------- */

/** Direct token. Simplest path and the one CI/test runs use. */
export const NOTION_TOKEN_ENV = "NOTION_API_KEY";
/** 1Password fallback: which vault holds the token item. */
export const NOTION_VAULT_ENV = "NOTION_1PASSWORD_VAULT";
/** 1Password fallback: the item title or id. */
export const NOTION_ITEM_ENV = "NOTION_1PASSWORD_ITEM";
/** 1Password fallback: the field on that item (defaults to "credential"). */
export const NOTION_FIELD_ENV = "NOTION_1PASSWORD_FIELD";
const DEFAULT_CREDENTIAL_FIELD = "credential";

export const NOTION_SETUP_HINT =
  `Notion is not configured for this installation. Set ${NOTION_TOKEN_ENV} to a Notion ` +
  `internal integration token, or point Tango at a 1Password item with ${NOTION_VAULT_ENV} ` +
  `and ${NOTION_ITEM_ENV} (field ${NOTION_FIELD_ENV}, default "${DEFAULT_CREDENTIAL_FIELD}"). ` +
  "Create the token at notion.so/my-integrations and share the pages or databases it " +
  "should reach with that integration.";

function envValue(name: string): string | null {
  const raw = process.env[name];
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Where this installation keeps its Notion token. Values come from the profile
 * layer, so the repo stays generic and shareable.
 */
export function notionCredentialRef(): {
  vault: string | null;
  item: string | null;
  field: string;
  hasDirectToken: boolean;
} {
  return {
    vault: envValue(NOTION_VAULT_ENV),
    item: envValue(NOTION_ITEM_ENV),
    field: envValue(NOTION_FIELD_ENV) ?? DEFAULT_CREDENTIAL_FIELD,
    hasDirectToken: envValue(NOTION_TOKEN_ENV) !== null,
  };
}

let cachedToken: string | null = null;

/** Drop the memoized token — used by tests and after a credential rotation. */
export function resetNotionTokenCache(): void {
  cachedToken = null;
}

export async function resolveNotionToken(): Promise<string> {
  if (cachedToken) return cachedToken;

  const direct = envValue(NOTION_TOKEN_ENV);
  if (direct) {
    cachedToken = direct;
    return direct;
  }

  const ref = notionCredentialRef();
  if (ref.vault && ref.item) {
    const secret = await getSecret(ref.vault, ref.item, ref.field);
    if (secret) {
      cachedToken = secret;
      return secret;
    }
    throw new Error(
      `Notion token not found in 1Password (vault "${ref.vault}", item "${ref.item}", ` +
        `field "${ref.field}"). Check that the item exists and the service account can read it.`,
    );
  }

  throw new Error(NOTION_SETUP_HINT);
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

/** Accept a raw id or a Notion URL; return the 32-char id (dashed). */
export function normalizeNotionId(value: unknown): string {
  const s = String(value ?? "").trim();
  const m = s.match(/([0-9a-fA-F]{32})/);
  const hex = m ? m[1]! : s.replace(/-/g, "");
  if (/^[0-9a-fA-F]{32}$/.test(hex)) {
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return s;
}

class NotionApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "NotionApiError";
  }
}

async function notionFetch(
  path: string,
  method: "GET" | "POST" | "PATCH",
  body?: unknown,
): Promise<unknown> {
  const token = await resolveNotionToken();
  const res = await fetch(`${NOTION_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const detail = json as { message?: string; code?: string };
    throw new NotionApiError(res.status, detail?.message ?? text, detail?.code);
  }
  return json;
}

/* -------------------------------------------------------------------------- */
/* Rich text + markdown                                                       */
/* -------------------------------------------------------------------------- */

/** Pull plain text out of a Notion rich_text array. */
function richText(arr: unknown): string {
  if (!Array.isArray(arr)) return "";
  return arr.map((r) => (r as { plain_text?: string })?.plain_text ?? "").join("");
}

interface RichTextRun {
  type: "text";
  text: { content: string };
}

/** Notion rejects runs longer than 2000 chars, so split long content. */
function richTextRuns(content: string): RichTextRun[] {
  if (!content) return [];
  const runs: RichTextRun[] = [];
  for (let i = 0; i < content.length; i += RICH_TEXT_LIMIT) {
    runs.push({ type: "text", text: { content: content.slice(i, i + RICH_TEXT_LIMIT) } });
  }
  return runs;
}

/** Languages Notion accepts for a code block; anything else falls back. */
const CODE_LANGUAGES = new Set([
  "bash", "c", "c++", "c#", "css", "diff", "docker", "go", "graphql", "html",
  "java", "javascript", "json", "kotlin", "less", "lua", "makefile", "markdown",
  "objective-c", "php", "plain text", "powershell", "python", "ruby", "rust",
  "scala", "shell", "sql", "swift", "typescript", "xml", "yaml",
]);

const CODE_LANGUAGE_ALIASES: Record<string, string> = {
  sh: "shell", zsh: "shell", js: "javascript", ts: "typescript", py: "python",
  rb: "ruby", yml: "yaml", md: "markdown", "c++": "c++", cpp: "c++", cs: "c#",
  dockerfile: "docker", text: "plain text", txt: "plain text",
};

function codeLanguage(raw: string): string {
  const key = raw.trim().toLowerCase();
  if (!key) return "plain text";
  const aliased = CODE_LANGUAGE_ALIASES[key] ?? key;
  return CODE_LANGUAGES.has(aliased) ? aliased : "plain text";
}

function textBlock(type: string, content: string, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    object: "block",
    type,
    [type]: { rich_text: richTextRuns(content), ...(extra ?? {}) },
  };
}

/**
 * Convert simple markdown into Notion blocks. Deliberately symmetric with the
 * reader below: headings, lists, to-dos, quotes, code fences, and dividers
 * round-trip. Anything unrecognized becomes a paragraph.
 */
export function markdownToBlocks(markdown: string): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  const lines = String(markdown ?? "").split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    const fence = trimmed.match(/^```(.*)$/);
    if (fence) {
      const language = codeLanguage(fence[1] ?? "");
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith("```")) {
        body.push(lines[i]!);
        i++;
      }
      blocks.push({
        object: "block",
        type: "code",
        code: { rich_text: richTextRuns(body.join("\n")), language },
      });
      continue;
    }

    if (trimmed.length === 0) continue;

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ object: "block", type: "divider", divider: {} });
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1]!.length, 3);
      blocks.push(textBlock(`heading_${level}`, heading[2]!));
      continue;
    }

    const todo = trimmed.match(/^[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (todo) {
      blocks.push(textBlock("to_do", todo[2]!, { checked: todo[1]!.toLowerCase() === "x" }));
      continue;
    }

    const bullet = trimmed.match(/^[-*+]\s+(.*)$/);
    if (bullet) {
      blocks.push(textBlock("bulleted_list_item", bullet[1]!));
      continue;
    }

    const numbered = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (numbered) {
      blocks.push(textBlock("numbered_list_item", numbered[1]!));
      continue;
    }

    const quote = trimmed.match(/^>\s?(.*)$/);
    if (quote) {
      blocks.push(textBlock("quote", quote[1]!));
      continue;
    }

    blocks.push(textBlock("paragraph", trimmed));
  }

  return blocks;
}

/** POST blocks in ≤100-block batches, since Notion rejects larger payloads. */
async function appendBlocksBatched(
  blockId: string,
  blocks: Record<string, unknown>[],
): Promise<{ appended: number; batches: number }> {
  let batches = 0;
  for (let i = 0; i < blocks.length; i += MAX_BLOCKS_PER_REQUEST) {
    await notionFetch(`/blocks/${blockId}/children`, "PATCH", {
      children: blocks.slice(i, i + MAX_BLOCKS_PER_REQUEST),
    });
    batches++;
  }
  return { appended: blocks.length, batches };
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

function renderBlock(type: string, text: string, block: Record<string, unknown>): string | null {
  const data = block[type] as { checked?: boolean; language?: string } | undefined;
  switch (type) {
    case "heading_1": return `# ${text}`;
    case "heading_2": return `## ${text}`;
    case "heading_3": return `### ${text}`;
    case "bulleted_list_item": return `- ${text}`;
    case "numbered_list_item": return `1. ${text}`;
    case "to_do": return `- [${data?.checked ? "x" : " "}] ${text}`;
    case "quote": return `> ${text}`;
    case "callout": return `> 💡 ${text}`;
    case "code": return `\`\`\`${data?.language ?? ""}\n${text}\n\`\`\``;
    case "toggle": return `▸ ${text}`;
    case "divider": return "---";
    case "child_page":
      return `📄 sub-page: ${String((block.child_page as { title?: string } | undefined)?.title ?? "")}`;
    case "child_database":
      return `🗂 sub-database: ${String((block.child_database as { title?: string } | undefined)?.title ?? "")}`;
    default:
      return text ? text : null;
  }
}

/** Flatten a page's block children into readable markdown-ish text. */
async function readPageContent(pageId: string, depth = 0): Promise<string> {
  const lines: string[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    const qs = new URLSearchParams({
      page_size: "100",
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    const res = (await notionFetch(`/blocks/${pageId}/children?${qs.toString()}`, "GET")) as {
      results?: Array<Record<string, unknown>>;
      has_more?: boolean;
      next_cursor?: string | null;
    };

    for (const block of res.results ?? []) {
      const type = String(block.type ?? "");
      const data = block[type] as { rich_text?: unknown } | undefined;
      const rendered = renderBlock(type, richText(data?.rich_text), block);
      if (rendered !== null) lines.push(rendered);

      // Nested content (toggles, list children, columns) is invisible without this.
      if (block.has_children === true && type !== "child_page" && type !== "child_database" && depth < MAX_BLOCK_DEPTH) {
        const nested = await readPageContent(String(block.id), depth + 1);
        if (nested) lines.push(nested.split("\n").map((l) => `  ${l}`).join("\n"));
      }
    }

    cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
  } while (cursor && ++pages < MAX_BLOCK_PAGES);

  return lines.join("\n");
}

function titleOf(page: Record<string, unknown>): string {
  // Databases carry a top-level `title`; pages carry a title-typed property.
  if (Array.isArray(page.title)) {
    const direct = richText(page.title);
    if (direct) return direct;
  }
  const props = (page.properties ?? {}) as Record<string, { type?: string; title?: unknown }>;
  for (const p of Object.values(props)) {
    if (p?.type === "title") return richText(p.title) || "(untitled)";
  }
  return "(untitled)";
}

/* -------------------------------------------------------------------------- */
/* Parents                                                                    */
/* -------------------------------------------------------------------------- */

type ParentInfo =
  | { kind: "database"; titleProperty: string }
  | { kind: "page" };

/**
 * `create_page` needs to know whether the parent is a page or a database — the
 * request shape differs, and databases name their own title property. Callers
 * may state it explicitly; otherwise probe.
 */
async function resolveParent(id: string, declared?: unknown): Promise<ParentInfo> {
  const stated = String(declared ?? "").trim().toLowerCase();
  if (stated === "page") return { kind: "page" };

  if (stated === "database" || stated === "") {
    try {
      const db = (await notionFetch(`/databases/${id}`, "GET")) as {
        object?: string;
        properties?: Record<string, { type?: string }>;
      };
      if (db?.object === "database") {
        const titleProperty =
          Object.entries(db.properties ?? {}).find(([, v]) => v?.type === "title")?.[0] ?? "Name";
        return { kind: "database", titleProperty };
      }
    } catch (err) {
      // Probing a page id against /databases gives 400 ("is a page, not a
      // database"); a genuinely unknown id gives 404. Both mean "use a page
      // parent". Anything else (auth, rate limit, 5xx) must surface.
      if (stated === "database") throw err;
      if (err instanceof NotionApiError && err.status !== 400 && err.status !== 404) throw err;
    }
  }

  return { kind: "page" };
}

/* -------------------------------------------------------------------------- */
/* Governance classification                                                  */
/* -------------------------------------------------------------------------- */

/** Every operation that only reads. Anything else is treated as a mutation. */
const READ_ONLY_OPERATIONS = new Set([
  "search", "get_page", "read", "fetch", "query_database", "get_database", "database_schema",
]);

/**
 * Read-vs-write for the governance layer. An explicit read allowlist rather
 * than a keyword regex: unknown or misspelled operations must fall to "write"
 * so a mutation can never be waved through as a read.
 */
export function notionOperationLooksReadOnly(operation: unknown): boolean {
  if (typeof operation !== "string") return false;
  return READ_ONLY_OPERATIONS.has(operation.trim().toLowerCase().replace(/[-\s]/g, "_"));
}

/* -------------------------------------------------------------------------- */
/* Tool                                                                       */
/* -------------------------------------------------------------------------- */

export function createNotionTools(): AgentTool[] {
  return [
    {
      name: "notion",
      description: [
        "Read and write the user's Notion workspace (direct Notion API).",
        "",
        "Set `operation` and the fields it needs:",
        "  - search:         { query }  → find pages/databases. Returns id, title, url for each.",
        "  - get_page:       { page_id } → the page's properties AND full text content (this is how you READ a doc).",
        "  - create_page:    { parent_id, title, markdown?, properties? } → new page under a parent page, or a new row in a database.",
        "  - update_page:    { page_id, properties } → set page properties (Notion property JSON).",
        "  - append:         { page_id, markdown } → append content to the end of a page.",
        "  - query_database: { database_id, filter?, sorts? } → rows of a database.",
        "  - get_database:   { database_id } → a database's schema (property names and types).",
        "  - archive:        { page_id } → move a page to trash. `restore` puts it back.",
        "",
        "markdown accepts headings (#/##/###), bullets, numbered lists, - [ ] to-dos,",
        "> quotes, ``` code fences, and --- dividers; they round-trip with get_page.",
        "",
        "page_id/database_id/parent_id accept a raw id or a full Notion URL. To read a document,",
        "use get_page (NOT a browser — Notion's web UI requires interactive login and renders",
        "blank to tools). Only pages shared with this installation's integration are reachable.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            description:
              "search | get_page | create_page | update_page | append | query_database | get_database | archive | restore",
          },
          query: { type: "string", description: "search text (operation=search)" },
          page_id: { type: "string", description: "page id or Notion URL (get_page/update_page/append/archive)" },
          database_id: { type: "string", description: "database id or URL (query_database/get_database)" },
          parent_id: { type: "string", description: "parent page/database id or URL (create_page)" },
          parent_type: {
            type: "string",
            description: "optional 'page' or 'database'; auto-detected when omitted (create_page)",
          },
          title: { type: "string", description: "title for create_page" },
          markdown: { type: "string", description: "markdown body for create_page or append" },
          properties: {
            type: "object",
            description: "Notion property JSON for update_page, or extra row properties for create_page",
          },
          filter: { type: "object", description: "Notion filter JSON for query_database" },
          sorts: { type: "array", description: "Notion sorts JSON for query_database" },
          page_size: { type: "number", description: "max results (search/query_database)" },
          start_cursor: { type: "string", description: "pagination cursor (search/query_database)" },
        },
        required: ["operation"],
      },
      handler: async (input) => {
        const op = String(input.operation ?? "").trim().toLowerCase().replace(/[-\s]/g, "_");
        try {
          switch (op) {
            case "search": {
              const res = (await notionFetch("/search", "POST", {
                ...(input.query ? { query: String(input.query) } : {}),
                page_size: typeof input.page_size === "number" ? input.page_size : 10,
                ...(input.start_cursor ? { start_cursor: String(input.start_cursor) } : {}),
              })) as { results?: Array<Record<string, unknown>>; has_more?: boolean; next_cursor?: string | null };
              return {
                results: (res.results ?? []).map((r) => ({
                  id: r.id,
                  object: r.object,
                  title: titleOf(r),
                  url: r.url,
                  last_edited: r.last_edited_time,
                })),
                has_more: res.has_more ?? false,
                next_cursor: res.next_cursor ?? null,
              };
            }

            case "get_page":
            case "read":
            case "fetch": {
              const id = normalizeNotionId(input.page_id ?? input.id);
              let page: Record<string, unknown>;
              try {
                page = (await notionFetch(`/pages/${id}`, "GET")) as Record<string, unknown>;
              } catch (err) {
                // Agents routinely hand a database URL to get_page; say so plainly.
                if (err instanceof NotionApiError && err.status === 404) {
                  const db = await notionFetch(`/databases/${id}`, "GET").catch(() => null);
                  if (db) {
                    return {
                      error:
                        `${id} is a database, not a page. Use operation "query_database" for its rows ` +
                        `or "get_database" for its schema.`,
                    };
                  }
                }
                throw err;
              }
              const content = await readPageContent(id);
              return {
                id: page.id,
                title: titleOf(page),
                url: page.url,
                last_edited: page.last_edited_time,
                properties: page.properties,
                content,
              };
            }

            case "create_page": {
              const parentId = normalizeNotionId(input.parent_id);
              if (!parentId) return { error: "create_page needs a parent_id (page or database id/URL)." };

              const title = String(input.title ?? "Untitled");
              const parent = await resolveParent(parentId, input.parent_type);
              const extraProps = (input.properties as Record<string, unknown> | undefined) ?? {};
              const titleValue = { title: [{ type: "text", text: { content: title } }] };

              const properties =
                parent.kind === "database"
                  ? { [parent.titleProperty]: titleValue, ...extraProps }
                  : { title: titleValue, ...extraProps };

              const blocks = markdownToBlocks(String(input.markdown ?? ""));
              const inlineBlocks = blocks.slice(0, MAX_BLOCKS_PER_REQUEST);
              const overflow = blocks.slice(MAX_BLOCKS_PER_REQUEST);

              const created = (await notionFetch("/pages", "POST", {
                parent:
                  parent.kind === "database"
                    ? { database_id: parentId }
                    : { page_id: parentId },
                properties,
                ...(inlineBlocks.length ? { children: inlineBlocks } : {}),
              })) as Record<string, unknown>;

              if (overflow.length) {
                await appendBlocksBatched(String(created.id), overflow);
              }

              return {
                id: created.id,
                url: created.url,
                title,
                parent_kind: parent.kind,
                blocks_written: blocks.length,
              };
            }

            case "update_page": {
              const id = normalizeNotionId(input.page_id);
              const updated = (await notionFetch(`/pages/${id}`, "PATCH", {
                properties: (input.properties as Record<string, unknown>) ?? {},
              })) as Record<string, unknown>;
              return { id: updated.id, url: updated.url, title: titleOf(updated), updated: true };
            }

            case "append": {
              const id = normalizeNotionId(input.page_id);
              const blocks = markdownToBlocks(String(input.markdown ?? ""));
              if (!blocks.length) return { error: "append needs non-empty markdown." };
              const result = await appendBlocksBatched(id, blocks);
              return { id, ...result };
            }

            case "query_database": {
              const id = normalizeNotionId(input.database_id ?? input.page_id);
              const res = (await notionFetch(`/databases/${id}/query`, "POST", {
                ...(input.filter ? { filter: input.filter } : {}),
                ...(input.sorts ? { sorts: input.sorts } : {}),
                page_size: typeof input.page_size === "number" ? input.page_size : 25,
                ...(input.start_cursor ? { start_cursor: String(input.start_cursor) } : {}),
              })) as { results?: Array<Record<string, unknown>>; has_more?: boolean; next_cursor?: string | null };
              return {
                results: (res.results ?? []).map((r) => ({
                  id: r.id,
                  title: titleOf(r),
                  url: r.url,
                  last_edited: r.last_edited_time,
                  properties: r.properties,
                })),
                has_more: res.has_more ?? false,
                next_cursor: res.next_cursor ?? null,
              };
            }

            case "get_database":
            case "database_schema": {
              const id = normalizeNotionId(input.database_id ?? input.page_id);
              const db = (await notionFetch(`/databases/${id}`, "GET")) as Record<string, unknown>;
              const props = (db.properties ?? {}) as Record<string, { type?: string }>;
              return {
                id: db.id,
                title: titleOf(db),
                url: db.url,
                properties: Object.fromEntries(
                  Object.entries(props).map(([name, meta]) => [name, meta?.type ?? "unknown"]),
                ),
              };
            }

            case "archive":
            case "trash":
            case "delete": {
              const id = normalizeNotionId(input.page_id);
              await notionFetch(`/pages/${id}`, "PATCH", { in_trash: true });
              return { id, archived: true };
            }

            case "restore":
            case "unarchive": {
              const id = normalizeNotionId(input.page_id);
              await notionFetch(`/pages/${id}`, "PATCH", { in_trash: false });
              return { id, archived: false };
            }

            default:
              return {
                error:
                  `Unknown notion operation "${op}". Use search | get_page | create_page | ` +
                  "update_page | append | query_database | get_database | archive | restore.",
              };
          }
        } catch (err) {
          if (err instanceof NotionApiError) {
            // 404 from Notion usually means "not shared with the integration",
            // which is a setup problem the agent should report, not retry.
            const hint =
              err.status === 404
                ? " (the page/database may not be shared with this installation's Notion integration)"
                : "";
            return { error: `Notion API ${err.status}: ${err.message}${hint}`, code: err.code };
          }
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  ];
}
