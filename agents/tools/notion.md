# notion

Read and write a Notion workspace through the official Notion API, using a
long-lived internal integration token.

Use this tool for anything in Notion — a `notion.so` / `notion.com` /
`app.notion.com` link, a page, or a database. Do **not** try to read Notion
through the `browser` tool: Notion's web UI requires an interactive login and
renders blank to automation, so the browser always fails. A blank Notion page in
a browser means "use the `notion` tool".

## Setup

Per installation, one time:

1. Create an internal integration at `notion.so/my-integrations` and copy its
   token.
2. Share each page or database the agent should reach with that integration
   (in Notion: **⋯ → Connections → add your integration**). Sharing a parent
   page also shares its children.
3. Provide the token to Tango with either:
   - `NOTION_API_KEY` — the token itself, or
   - `NOTION_1PASSWORD_VAULT` + `NOTION_1PASSWORD_ITEM` — a 1Password item read
     through the service account. The field defaults to `credential` and can be
     overridden with `NOTION_1PASSWORD_FIELD`.

`NOTION_API_KEY` wins when both are set. Which vault and item an installation
uses is profile-specific — see the profile overlay for this installation's
values, not this doc.

**The integration only sees what has been shared with it.** A `404` from this
tool almost always means "not shared yet", not "does not exist".

## Input

```json
{ "operation": "search", "query": "onboarding" }
```

`page_id`, `database_id`, and `parent_id` accept either a raw id (dashed or
undashed) or a full Notion URL — the tool extracts the id.

## Operations

| Operation | Required | Optional | Returns |
| --- | --- | --- | --- |
| `search` | | `query`, `page_size`, `start_cursor` | `results[]` of `{id, object, title, url, last_edited}` |
| `get_page` | `page_id` | | `{id, title, url, last_edited, properties, content}` |
| `create_page` | `parent_id` | `title`, `markdown`, `properties`, `parent_type` | `{id, url, title, parent_kind, blocks_written}` |
| `update_page` | `page_id`, `properties` | | `{id, url, title, updated}` |
| `append` | `page_id`, `markdown` | | `{id, appended, batches}` |
| `query_database` | `database_id` | `filter`, `sorts`, `page_size`, `start_cursor` | `results[]` of `{id, title, url, last_edited, properties}` |
| `get_database` | `database_id` | | `{id, title, url, properties}` (property name → type) |
| `archive` | `page_id` | | `{id, archived: true}` |
| `restore` | `page_id` | | `{id, archived: false}` |

Aliases: `read`/`fetch` → `get_page`, `trash`/`delete` → `archive`,
`unarchive` → `restore`, `database_schema` → `get_database`.

`search` with no `query` lists everything shared with the integration — a good
first call when you do not yet know what is reachable.

`get_page` returns the page's full text, not just its properties. That is the
read path for a document.

## Markdown

`markdown` (on `create_page` and `append`) supports the subset that round-trips
with `get_page`:

```text
# H1   ## H2   ### H3
- bullet
1. numbered
- [ ] unchecked to-do      - [x] checked to-do
> quote
---                        (divider)
```lang … ```            (code block)
```

Anything else becomes a paragraph. Headings deeper than `###` clamp to `###`
because Notion has only three heading levels. Long lines are split across
2000-character runs and large bodies are written in 100-block batches, both
Notion API limits.

## Pages vs database rows

`create_page` writes to whichever parent it is given:

- **Parent is a page** → a normal sub-page. Body comes from `markdown`.
- **Parent is a database** → a new row. `title` fills the database's title
  property (whatever it is named), and `properties` supplies the other columns
  in Notion property JSON.

The parent type is auto-detected. Pass `parent_type: "page"` or `"database"` to
skip the probe.

Call `get_database` first when writing rows — you need the real property names
and types before you can build `properties`.

## Examples

Find what the integration can reach:

```json
{ "operation": "search", "query": "release notes" }
```

Read a document from a link:

```json
{ "operation": "get_page", "page_id": "https://www.notion.so/Example-Page-00000000000000000000000000000000" }
```

Create a sub-page with structure:

```json
{
  "operation": "create_page",
  "parent_id": "00000000000000000000000000000000",
  "title": "Weekly Summary",
  "markdown": "## Highlights\n- Shipped the importer\n- [ ] Follow up on metrics\n\n> Blocked on review"
}
```

Add a database row:

```json
{
  "operation": "create_page",
  "parent_id": "00000000000000000000000000000000",
  "title": "New request",
  "properties": { "Status": { "select": { "name": "In progress" } } }
}
```

Query a database:

```json
{
  "operation": "query_database",
  "database_id": "00000000000000000000000000000000",
  "filter": { "property": "Status", "select": { "equals": "In progress" } },
  "sorts": [{ "timestamp": "last_edited_time", "direction": "descending" }]
}
```

Append to an existing page:

```json
{ "operation": "append", "page_id": "00000000000000000000000000000000", "markdown": "## Update\nDeployed at 14:00." }
```

## Governance

`search`, `get_page`, `query_database`, and `get_database` are classified
**read**. Everything else — including `archive` and `restore` — is **write**, and
an unrecognized operation is treated as a write so a mutation can never be
waved through as a read.

## Notes

- `archive` moves a page to Notion's trash; it is reversible with `restore`.
  There is no hard-delete through this tool.
- Nested blocks (toggles, list children, columns) are followed three levels deep
  on read and indented in the returned text.
- A workspace may hold confidential material. Treat page contents as sensitive:
  do not copy them into repo files, commit messages, or issue trackers.
