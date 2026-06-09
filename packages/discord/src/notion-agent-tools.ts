/**
 * Notion Agent Tools — direct Notion API integration (stable, long-lived).
 *
 * Replaces the Latitude remote-MCP bridge for Notion, which relied on an OAuth
 * token that expired hourly and did not reliably refresh (Notion broke ~every
 * hour). This tool uses a Notion *internal integration token* (no expiry) the
 * same way the Linear/Slack tools use direct API keys.
 *
 * Setup (one-time): create an internal integration at notion.so/my-integrations,
 * share the relevant pages/databases with it, and provide the token via
 * NOTION_API_KEY (env) or a "Notion Integration Token" item in the Watson 1Password
 * vault.
 */

import type { AgentTool } from "@tango/core";
import { getSecret } from "./op-secret.js";

const NOTION_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

let cachedToken: string | null = null;
async function getToken(): Promise<string> {
  if (!cachedToken) {
    const envKey = process.env.NOTION_API_KEY?.trim();
    const opKey = envKey || (await getSecret("Watson", "Tango Notion Personal Access Token"));
    if (!opKey) {
      throw new Error(
        "Notion token not found. Set NOTION_API_KEY or add a 'Notion Integration Token' " +
          "item in the Watson 1Password vault (create one at notion.so/my-integrations and " +
          "share your pages with it).",
      );
    }
    cachedToken = opKey;
  }
  return cachedToken;
}

/** Accept a raw id or a Notion URL; return the 32-char id (dashed). */
function normalizeId(value: unknown): string {
  const s = String(value ?? "").trim();
  const m = s.match(/([0-9a-fA-F]{32})/);
  const hex = m ? m[1]! : s.replace(/-/g, "");
  if (/^[0-9a-fA-F]{32}$/.test(hex)) {
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return s;
}

async function notionFetch(
  path: string,
  method: "GET" | "POST" | "PATCH",
  body?: unknown,
): Promise<unknown> {
  const token = await getToken();
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
    const msg = (json as { message?: string })?.message ?? text;
    throw new Error(`Notion API ${res.status}: ${msg}`);
  }
  return json;
}

/** Pull plain text out of a Notion rich_text array. */
function richText(arr: unknown): string {
  if (!Array.isArray(arr)) return "";
  return arr.map((r) => (r as { plain_text?: string })?.plain_text ?? "").join("");
}

/** Flatten a page's block children into readable markdown-ish text. */
async function readPageContent(pageId: string): Promise<string> {
  const lines: string[] = [];
  let cursor: string | undefined;
  let guard = 0;
  do {
    const qs = new URLSearchParams({ page_size: "100", ...(cursor ? { start_cursor: cursor } : {}) });
    const res = (await notionFetch(`/blocks/${pageId}/children?${qs.toString()}`, "GET")) as {
      results?: Array<Record<string, unknown>>;
      has_more?: boolean;
      next_cursor?: string | null;
    };
    for (const block of res.results ?? []) {
      const type = String(block.type ?? "");
      const data = (block as Record<string, unknown>)[type] as { rich_text?: unknown; checked?: boolean } | undefined;
      const txt = richText(data?.rich_text);
      switch (type) {
        case "heading_1": lines.push(`# ${txt}`); break;
        case "heading_2": lines.push(`## ${txt}`); break;
        case "heading_3": lines.push(`### ${txt}`); break;
        case "bulleted_list_item": lines.push(`- ${txt}`); break;
        case "numbered_list_item": lines.push(`1. ${txt}`); break;
        case "to_do": lines.push(`- [${data?.checked ? "x" : " "}] ${txt}`); break;
        case "quote": lines.push(`> ${txt}`); break;
        case "callout": lines.push(`💡 ${txt}`); break;
        case "code": lines.push(`\`\`\`\n${txt}\n\`\`\``); break;
        case "toggle": lines.push(`▸ ${txt}`); break;
        case "divider": lines.push("---"); break;
        case "child_page": lines.push(`📄 (sub-page: ${String((block as Record<string, unknown>).child_page && ((block as Record<string, unknown>).child_page as { title?: string }).title || "")})`); break;
        default: if (txt) lines.push(txt);
      }
    }
    cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
  } while (cursor && ++guard < 20);
  return lines.join("\n");
}

function titleOf(page: Record<string, unknown>): string {
  const props = (page.properties ?? {}) as Record<string, { type?: string; title?: unknown }>;
  for (const p of Object.values(props)) {
    if (p?.type === "title") return richText(p.title) || "(untitled)";
  }
  return "(untitled)";
}

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
        "  - create_page:    { parent_id, title, markdown? } → new page under a parent page/database.",
        "  - update_page:    { page_id, properties } → set page properties (Notion property JSON).",
        "  - append:         { page_id, markdown } → append text/paragraphs to a page.",
        "  - query_database: { database_id, filter?, sorts? } → rows of a database.",
        "",
        "page_id/database_id/parent_id accept a raw id or a full Notion URL. To read a document, use get_page (NOT a browser — Notion's web UI requires interactive login and renders blank to tools).",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            description: "search | get_page | create_page | update_page | append | query_database",
          },
          query: { type: "string", description: "search text (operation=search)" },
          page_id: { type: "string", description: "page id or Notion URL (get_page/update_page/append)" },
          database_id: { type: "string", description: "database id or URL (query_database)" },
          parent_id: { type: "string", description: "parent page/database id or URL (create_page)" },
          title: { type: "string", description: "title for create_page" },
          markdown: { type: "string", description: "plain text / simple markdown body for create_page or append" },
          properties: { type: "object", description: "Notion property JSON for update_page" },
          filter: { type: "object", description: "Notion filter JSON for query_database" },
          sorts: { type: "array", description: "Notion sorts JSON for query_database" },
          page_size: { type: "number", description: "max results (search/query_database)" },
        },
        required: ["operation"],
      },
      handler: async (input) => {
        const op = String(input.operation ?? "").trim().toLowerCase().replace(/[-\s]/g, "_");
        try {
          switch (op) {
            case "search": {
              const res = (await notionFetch("/search", "POST", {
                query: String(input.query ?? ""),
                page_size: typeof input.page_size === "number" ? input.page_size : 10,
              })) as { results?: Array<Record<string, unknown>> };
              return {
                results: (res.results ?? []).map((r) => ({
                  id: r.id,
                  object: r.object,
                  title: titleOf(r),
                  url: r.url,
                  last_edited: r.last_edited_time,
                })),
              };
            }
            case "get_page":
            case "read":
            case "fetch": {
              const id = normalizeId(input.page_id ?? input.id);
              const page = (await notionFetch(`/pages/${id}`, "GET")) as Record<string, unknown>;
              const content = await readPageContent(id);
              return { id: page.id, title: titleOf(page), url: page.url, last_edited: page.last_edited_time, content };
            }
            case "create_page": {
              const parent = normalizeId(input.parent_id);
              const title = String(input.title ?? "Untitled");
              const isDb = false; // default to page parent; databases need property-shaped title
              const children = String(input.markdown ?? "")
                .split("\n")
                .filter((l) => l.length > 0)
                .map((line) => ({
                  object: "block",
                  type: "paragraph",
                  paragraph: { rich_text: [{ type: "text", text: { content: line } }] },
                }));
              const res = await notionFetch("/pages", "POST", {
                parent: isDb ? { database_id: parent } : { page_id: parent },
                properties: { title: { title: [{ type: "text", text: { content: title } }] } },
                ...(children.length ? { children } : {}),
              });
              return res;
            }
            case "update_page": {
              const id = normalizeId(input.page_id);
              return await notionFetch(`/pages/${id}`, "PATCH", {
                properties: (input.properties as Record<string, unknown>) ?? {},
              });
            }
            case "append": {
              const id = normalizeId(input.page_id);
              const children = String(input.markdown ?? "")
                .split("\n")
                .filter((l) => l.length > 0)
                .map((line) => ({
                  object: "block",
                  type: "paragraph",
                  paragraph: { rich_text: [{ type: "text", text: { content: line } }] },
                }));
              return await notionFetch(`/blocks/${id}/children`, "PATCH", { children });
            }
            case "query_database": {
              const id = normalizeId(input.database_id);
              return await notionFetch(`/databases/${id}/query`, "POST", {
                ...(input.filter ? { filter: input.filter } : {}),
                ...(input.sorts ? { sorts: input.sorts } : {}),
                page_size: typeof input.page_size === "number" ? input.page_size : 25,
              });
            }
            case "archive":
            case "trash":
            case "delete": {
              const id = normalizeId(input.page_id);
              return await notionFetch(`/pages/${id}`, "PATCH", { in_trash: true });
            }
            case "restore":
            case "unarchive": {
              const id = normalizeId(input.page_id);
              return await notionFetch(`/pages/${id}`, "PATCH", { in_trash: false });
            }
            default:
              return { error: `Unknown notion operation "${op}". Use search | get_page | create_page | update_page | append | query_database.` };
          }
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  ];
}
