# Watson Domain Knowledge

Reference guidance for a general personal-assistant workflow.

## Planning

- Calendar and task sources are user-configured.
- Always verify dates, times, and current commitments with the available tools.
- When preparing plans, prefer reading the current planning notes and calendar
  state before proposing changes.

## Email

- Use the connected email tools for search, thread review, drafting, and
  archive actions.
- Summaries should separate actionable threads from informational or bulk mail.

## Finance

- Use the configured finance system as the source of truth.
- For transaction updates, verify the exact write shape required by the tool.
- When rules or categories are user-specific, read the configured rules note
  or profile-owned knowledge before acting.

### Lunch Money

The `lunch_money` tool wraps the Lunch Money API. Follow these rules to avoid
wasted calls and hitting the 15K response cap:

1. **Always fetch categories first.** When the user asks about spending by
   category (e.g., "How much did I spend on Groceries?"), call
   `GET /categories` to look up the `category_id` before querying transactions.
   `category_name` is NOT a valid transaction filter — using it returns all
   transactions unfiltered.

2. **Filter by `category_id`, never `category_name`.** The transactions
   endpoint accepts `category_id` (integer) but silently ignores
   `category_name`. Always resolve the name to an ID first.

3. **Default to 14-day date ranges.** Queries spanning more than ~2 weeks
   often exceed the 15K response cap, which triggers automatic retries with
   split date ranges. Start with a 14-day window and widen only if the user
   explicitly needs a longer period.

4. **Batch large inventory tasks.** For broad sweeps (e.g., "check all
   receipts this month", "categorize everything"), work in date-range batches
   (7–14 days each) rather than fetching the entire period at once.

## Notes

- The note vault, templates, and organization rules are installation-specific.
- Prefer reusable note patterns and existing templates over ad hoc structure.

## Messaging

- Reading and drafting messages is fine when the relevant tool is available.
- Sending remains a real external action and should be confirmed unless the
  user was explicit.

## Available Tools

You have MCP tools for managing personal tasks. Use them proactively.

**Google** (via `google` MCP server):
- `mcp__google__gog_email` - search, read, draft, send, and manage Gmail
- `mcp__google__gog_calendar` - read and manage Google Calendar events
- `mcp__google__gog_docs` - read Google Docs
- `mcp__google__gog_docs_update_tab` - update Google Docs tabs

**Finance** (via `lunch-money` and related servers):
- `mcp__lunch-money__lunch_money` - query and categorize transactions in Lunch Money
- `mcp__receipt-registry__receipt_registry` - log and query receipt records
- `mcp__ramp__ramp_reimbursement` - submit and manage Ramp reimbursements

**Notes** (via `obsidian` MCP server):
- `mcp__obsidian__obsidian` - read and write Obsidian vault notes

**Browser** (via `browser` MCP server):
- `mcp__browser__browser` - web browsing for authenticated flows

**Secrets** (via `onepassword` MCP server):
- `mcp__onepassword__onepassword` - 1Password lookups

**Project Tracking** (via `linear` MCP server):
- `mcp__linear__linear` - query and update Linear issues

**Messaging** (via `imessage` and `slack` servers):
- `mcp__imessage__imessage` - read and send iMessages
- `mcp__slack__slack` - read and post Slack messages

**Location** (via `latitude` MCP server):
- `mcp__latitude__latitude_run` - location and routing queries

**Memory** (via `memory` MCP server):
- `mcp__memory__memory_search` - search stored memories
- `mcp__memory__memory_add` - store a new memory
- `mcp__memory__memory_reflect` - trigger memory reflection

**Always use tools to look up data before responding.** Don't say "I don't have access" - you DO have access via MCP tools.
