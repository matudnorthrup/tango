# Sierra Workers

## Dispatch rules

- Call `dispatch_worker` when it is available. Worker dispatch is synchronous and single-turn. Do not send a user-visible progress update before the dispatch happens and the result comes back.
- Prefer `task_id="short-label"` when dispatching more than one task so the merged results stay readable.
- Avoid parallel browser-heavy shopping flows unless the tasks are clearly safe to run side by side.
- If `dispatch_worker` is unavailable in the current environment, use the deprecated `<worker-dispatch>` XML fallback instead of only narrating intent.

## research-assistant

Tools: `exa_search`, `exa_answer`, `printer_command`, `openscad_render`, `prusa_slice`, `location_read`, `find_diesel`, `walmart`, `browser`, `file_ops`, `obsidian`, `onepassword`, `memory_search`, `memory_add`, `memory_reflect`, `slack`

Dispatch when you need to: search the web via EXA, get quick factual answers, manage 3D-printing work, use live location and diesel tools, manage Walmart queue/history, drive authenticated shopping flows in the browser, move/copy/list files in configured working directories, read/write notes in the configured vault, retrieve credentials from 1Password, or manage agent memory.

Tool-call example:
`dispatch_worker(worker_id="research-assistant", task="Search EXA for \"best budget 3D printer filament 2026\" with 10 results including highlights. Also search for \"PLA vs PETG strength comparison\" with text content.")`

Deprecated XML fallback example:
<worker-dispatch worker="research-assistant">
Search EXA for "best budget 3D printer filament 2026" with 10 results including highlights. Also search for "PLA vs PETG strength comparison" with text content.
</worker-dispatch>

## research-coordinator

Tools: `spawn_sub_agents`

Dispatch when you need to: do a deep research pass that benefits from multiple independent search angles, compare several products or sources in parallel, or read and compare multiple local documents/files in one coordinated run.

Use it for:
- "deep dive" or "research thoroughly" requests
- product or option comparisons where each option should be investigated separately
- multi-document comparisons, trend summaries, or parallel evidence gathering

Avoid it for:
- simple single-query lookups
- narrow requests that one `research-assistant` pass can handle directly

Tool-call example:
`dispatch_worker(worker_id="research-coordinator", task="Deep research on PLA food safety. Use sub-agents to cover regulatory guidance, academic evidence, and practical caveats, then synthesize the result clearly.")`
