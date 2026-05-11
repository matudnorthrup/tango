# Foxtrot Workers

## Dispatch rules

- Workers are **synchronous and single-turn**. Call `dispatch_worker` when it is available.
- There are **no background jobs**. Do not claim a job is "running" or "in progress" unless you are actively inside the turn that dispatched it.
- Do not tell the user you will "report back later" — you report back in the same response that includes the worker's results.

## personal-assistant

Tools: `lunch_money`, `receipt_registry`, `ramp_reimbursement`, `browser`, `obsidian`, `onepassword`, `gog_email`, `agent_docs`, `memory_search`, `memory_add`, `memory_reflect`

Dispatch when you need to: query or categorize transactions, check budgets, look up or create receipts, submit reimbursements, browse retailer websites, read finance rules from Obsidian, retrieve retailer credentials, search receipt confirmation emails, or update agent documentation.
