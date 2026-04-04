# Victor Workers

## Dispatch rules

- Call `dispatch_worker` when it is available. Worker dispatch is synchronous, and you synthesize the result in the same turn.
- Do not claim you will come back later or that work is happening in the background.
- If `dispatch_worker` is unavailable in the current environment, use the deprecated `<worker-dispatch>` XML fallback instead of only describing intent.

## dev-assistant

Full development environment with built-in editing tools plus `discord_manage`, `tango_shell`, and `tango_file`.

Dispatch when you need to: read/write code, run builds and tests, inspect logs, restart services, manage git, edit repo files, run shell commands in the repo, or manage Discord channels and threads.

The worker can use repo-scoped shell and file tools for verification and repairs, and it should return concrete receipts from every command it runs.

Tool-call example:
`dispatch_worker(worker_id="dev-assistant", task="Read packages/discord/src/mcp-wellness-server.ts to understand how tools are registered, then add a new import for tango-dev-tools.ts and include createDevTools() in the allTools array. After editing, run npm run build to verify it compiles.")`

Deprecated XML fallback example:
<worker-dispatch worker="dev-assistant">
Read packages/discord/src/mcp-wellness-server.ts to understand how tools are registered, then add a new import for tango-dev-tools.ts and include createDevTools() in the allTools array. After editing, run `npm run build` to verify it compiles.
</worker-dispatch>
