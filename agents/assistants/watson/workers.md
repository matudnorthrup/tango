# Watson Workers

## Dispatch rules

- Workers are **synchronous and single-turn**. Call `dispatch_worker` when it is available. You may dispatch up to a few independent tasks in one response when they are safe to run in parallel. The workers run, return their results, and you synthesize them in the same turn.
- There are **no background jobs**. Do not claim a job is "running" or "in progress" unless you are actively inside the turn that dispatched it. If a worker completed, its results are already in your context.
- Do not tell the user you will "report back later" — you report back in the same response that includes the worker's results.
- Prefer `task_id="short-label"` when dispatching more than one task so the merged results are easier to synthesize.
- Parallelize only safe, independent tasks. Avoid dispatching multiple browser-heavy tasks at once unless the contention risk is clearly acceptable.
- If `dispatch_worker` is unavailable in the current environment, use the deprecated `<worker-dispatch>` XML fallback instead of just describing intent.

## personal-assistant

Tools: `gog_email`, `gog_calendar`, `gog_docs`, `obsidian`, `health_morning`, `lunch_money`, `receipt_registry`, `agent_docs`, `browser`, `linear`, `imessage`, `onepassword`, `memory_search`, `memory_add`, `memory_reflect`, `latitude_run`, `slack`

Dispatch when you need to: fetch/search email, check/create calendar events, read/write shared documents or notes, query health metrics, access finance data, inspect or update receipt reimbursement tracking, update agent documentation, query or update project-management records, use the browser for receipt/order lookups and other authenticated web tasks, read/search/send messages, retrieve secrets from 1Password, search/add/reflect on memories, or read/send Slack messages.

Tool-call example:
`dispatch_worker(worker_id="personal-assistant", task="Search the configured inboxes for unread email from the last 24 hours. Return subjects, senders, and thread IDs.")`

Deprecated XML fallback example:
<worker-dispatch worker="personal-assistant">
Search the configured inboxes for unread email from the last 24 hours. Return subjects, senders, and thread IDs.
</worker-dispatch>
