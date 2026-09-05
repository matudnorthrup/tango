# Context and reasoning for scheduled reviews

Agent and conditional-agent schedules execute a fresh tool-capable model turn.
Deterministic pre-checks only decide whether work exists and supply verified
inputs. The shared scheduled-review guidance requires the agent to reconcile
prior decisions and current evidence before classifying items or asking questions.

## Context sources

The scheduler reuses the interactive memory assembler with a bounded stateless
budget. It supplies the entire task for retrieval, pinned facts and relevant
agent memory, the delivery channel/thread's conversation history and summary,
and open tasks whose latest source message belongs to that surface and agent.
Approved canonical/clone aliases share context. Supplemental history includes up
to 80 stored surface messages across earlier sessions, without the interactive
15-minute freshness restriction. Token budgets can still omit older messages;
the review guidance requires targeted item-level retrieval after fetching work.

A delivery route belonging to another agent is not a context source. Unregistered
threads use a synthetic context session rather than the parent's session. Legacy
session summaries, session pins, and unscoped tool outcomes are excluded when
surface provenance cannot be established. Agent/global memories retain their
existing sharing rules. Missing context is reported in the briefing and run
metadata, rather than interpreted as evidence that no previous answer exists.

## Dependencies and reasoning

`execution.context_dependencies` lists job IDs whose enabled state, timing and
latest run status are supplied as evidence. It does not gate the entire review:
independent items can proceed while a receipt-dependent item waits. Dependency
records are limited to the same agent and approved aliases. Job success is not
proof of item completion; the agent must check the actual receipt or record.
Failed, disabled, missing and overdue dependencies require a concrete blocker.

Explicit schedule provider/model/effort settings prevent the scheduler's optional
automatic clone substitution. Otherwise existing clone selection remains in
force. Nightly transaction categorization specifies Sonnet with high effort.
Other jobs inherit their configured effort; this does not force one model on
all task types. Deterministic-only schedules are unchanged.

Finance review instructions require original-purchase evidence for refunds,
receipt-registry lookup before retailer questions, and verification of whether
reimbursements are planned, submitted or paid. Deferred transactions stay
uncleared. Retry windows and durable domain queues remain the responsibility of
the owning workflow; this context change does not expand their query windows.

Profile schedule overlays can override repository defaults. During deployment,
check the effective nightly schedule includes `receipt-cataloger` under
`context_dependencies` and the intended provider effort.

## Verification

Run targeted unit tests for `scheduled-review-context`, `channel-surface-context`,
`warm-start-memory-source`, `memory-system`, schedule config and executor behavior.
The synthetic live-model replay uses the existing bake-off runner and gates:

```sh
node --import tsx scripts/scheduled-review-eval.mts --output "$(tshare dir scheduled-review-continuity)" --runs 2
```

The replay runs the real scheduler executor, history selector and memory prompt
assembler, then checks decisions from live Sonnet calls. It covers matched and
ambiguous refunds, pending/failed receipts, paid/planned reimbursements, a
non-finance prior answer and unavailable context. Tools and inherited MCP servers
are disabled, and no production records or Discord messages are changed. This
validates reasoning over supplied evidence; production tool retrieval, effective
profile overlays and Discord routing still require deployment validation.
