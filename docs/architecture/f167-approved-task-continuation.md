---
feature_ids: [F167, F128]
topics: [approval, delegation, authority]
doc_kind: design
created: 2026-10-21
owner: codex-astra
mcp_admission_status: accepted
mcp_admission_ref: "file:docs/architecture/f167-approved-task-continuation.md"
mcp_admission_claims:
  - ref: "file:docs/architecture/f167-approved-task-continuation.md"
    toolName: cat_cafe_continue_approved_task
    resourceFamily: thread-proposal
    boundaryKind: authority-boundary
    decision: accepted
tips_exempt: "Internal implementation of the approved Task continuation contract. The original Task owner uses the new typed MCP entry; it adds no end-user operation or approval step."
---

# Approved Task contract continuation

This records the implementation boundary of the already accepted
narrow contract (internal)
and parallel implementation scope (internal).
operator authorized the parallel repairs at
`[thread-id]#private-source-id`, then directly instructed this
execution thread to implement at `[thread-id]#private-source-id`.
The tool name and storage implementation below do not expand that accepted authority.

`cat_cafe_continue_approved_task` belongs to the existing `thread-proposal` resource family.
It is a separate authority boundary from proposing a new thread: only the current canonical
Task owner in the original Task thread may append a continuation of an already approved,
complete generic contract. It cannot request or approve a new thread, change Task custody,
add development scope, choose another executor, or dispatch work. Combining it with
`propose_thread` would conceal this different actor and approval requirement behind a
thread-creation operation.

The caller supplies only `proposalId`, `taskId`, and `clientRequestId`. Callback authentication
supplies the actor; the server derives the complete contract and rechecks live Task, proposal,
child and historical fenced implementation evidence at the atomic commit. The receipt lives
permanently in the original proposal aggregate. A same-key replay returns that receipt after
current authority validation. A conflict writes no receipt, message, lease or execution.

The original owner then uses the existing structured single-implement dispatch. The delegate
provider contributes the exact receipt reference to the lease. Lease admission, execution and
output preflight revalidate the generic contract. Any development scope still uses the existing
strict five-field comparison; missing or malformed scope is never independent authority.
Seed, READY and read-only investigation are ordinary messages, not implementation evidence.

Architecture cell: `ball-custody`, with the existing F128 ProposalStore as approval owner.
Map delta: none. The receipt is a field of the same aggregate; there is no second permission
store, queue, Task or scheduler. The Task execution reader consumes the same delegate provider.

Validation is executable in `packages/api/test/redis-approved-task-contract*.test.js` and
`packages/api/test/f167-approved-task-contract.test.ts`. The isolated chain uses the real
Redis proposal, Task, Thread, Message, invocation, Queue and lease stores, real approval and
callback routes, and execution fences. It never applies reconciliation to production Task391
or changes the excluded runtime, plugin or business-data state.
