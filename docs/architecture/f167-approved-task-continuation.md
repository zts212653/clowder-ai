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
It is a separate authority boundary from proposing a new thread: the current canonical Task owner in the original Task thread may append a continuation of an already approved complete generic contract through the legacy path. It cannot request or approve a new thread, change Task custody,
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

## Ordinary execution cards

A new ordinary subtask card proposed by its canonical owner from home captures that owner's
revision. A verified human approval freezes the contract and reserves the child before first
creation. The approval itself issues the receipt and selects the first execution member.
A retry reuses the reserved child, receipt and original Message/Queue source. Reviewers and
other listed members join through the existing collaboration flow.

The seed carries the native Task handoff. The Queue and provider boundary recheck the approval,
current assignment and source, then bind the actual provider invocation. An occupied assignment
still needs positive predecessor teardown. Previously published cards retain their manual entry.

At completion the executor publishes its result in the child and supplies that Message ID to
`update_task`. The Task records the exact result and handoff before A2A publishes to home.
The Task and handoff determine the retry key. An ordinary final report can therefore resume
delivery from its durable result following a failed send.

A registered deployment wait stays on the original Task while an exact approved repair runs.
Publication and provider admission compare the current assignment. The wake binds the same
ordinary Task writer slot as the repair.

Architecture cell: `ball-custody`, with the existing F128 ProposalStore as approval owner.
Map delta: none. The receipt is a field of the same aggregate; there is no second permission
store, queue, Task or scheduler. The Task execution reader consumes the same delegate provider.

Validation is executable in `packages/api/test/redis-approved-task-contract*.test.js` and
`packages/api/test/f167-approved-task-contract.test.ts`. The isolated chain uses the real
Redis proposal, Task, Thread, Message, invocation, Queue and lease stores, real approval and
callback routes, and execution fences. It never applies reconciliation to production Task391
or changes the excluded runtime, plugin or business-data state.
