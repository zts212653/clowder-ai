# A2A Protocol

Clowder AI runs many agents in one shared thread. The Agent-to-Agent (A2A) protocol is the **lifecycle of a single message** — from the moment it appears, through the shared timeline, to the result an agent produces and what the user sees if something fails.

It is not a routing pipeline. It is a delivery kernel that answers one precise question: when does an input exist only in the queue, when does it enter the shared timeline, when must pending work be scheduled, how is it handed to an agent, how does the reply finalize in place, and what does the user see after a failure or restart?

## Three things the system tracks

The delivery kernel is built on exactly three objects. Everything else — body exposure, wait/retry state, structured responsibility — stays with its own owner and is only referenced, never copied.

| Object | Persisted | What it is |
|---|---|---|
| **Queue Entry** | yes | An ordered pending input plus its recoverable source identity and enqueue-time target *intent*. Its `targets[]` contains only the receivers still pending; already-admitted siblings are owned by their History dispatch refs. |
| **Chat History Message** | yes | An input, agent message, or response bubble that has entered the chat panel. It has a fixed order key; actually-delivered public messages carry causal `dispatchRefs` to their exact targets and results. |
| **Active Run** | no | The delivery association between exact inputs, an Agent Client invocation and its fixed response bubble. Durable InvocationRecord/TurnExecution and structured responsibility retain their own owners; this process-local association is not restart truth. |

The pivotal distinction is about **publication**, not whether the source has durable identity. A queued user or connector input has one durable source record plus one Queue Entry, but it is not a History member and remains invisible to the chat panel and other agents' context until its first actual delivery materializes that same source into History. An agent-authored source is already public History; its Queue Entry carries only the targets that still need that existing source delivered.

## The journey of a message

A normal input goes through seven steps:

1. **A source forms the message.** A user, connector, system, agent, or existing protocol owner decides the content and explicit targets. All authenticated entrances delegate to common send/admission. For ordinary public input with no valid, routable member mention, it binds the most recent currently-routable completed responder, then the configured default, before Queue admission; fallback does not rewrite the authored body or fabricate a member mention.
2. **Source and Queue custody persist together.** Common admission resolves explicit intent or the thread/global/product default, saves the per-target policy and exact parent, and atomically writes one durable source record and one Queue Entry with its pending `targets[]`. Public inputs, agent wakes, and private inputs all enter the *same* durable priority queue, then signal a drain. This does not yet publish a user or connector source to History.
3. **Per-target order is respected.** One per-thread drain scans the stable comparator order. A blocked or retrying source holds its targets, so later work for those members cannot overtake it; unrelated targets can progress. Automatic guidance joins an exact supporting response. A fresh ordinary turn claims one source's complete pending target set, rather than peeling off an idle subset. Explicit singleton Steer and exact unread adoption remain separate cutovers.
4. **Admission — one source claim, concurrent target cutovers.** One source claim creates or confirms an independent response receiver and Turn Execution for every target in the admitted set. Each durable receiver appends its exact `dispatched` ref, materializes (or reuses) the one source in History, and removes only its target from Queue. **Only after that durable cutover commits** is the corresponding process-local Active Run created and the agent client called. A target that fails before its cutover is restored without rolling back already-admitted siblings; later target executions and outcomes settle independently.
5. **The same bubble streams.** Output updates only the bubble admission created. A member's internal session rollover, context compaction, or continuation stays inside the agent client and creates no new kernel object.
6. **One terminal, in place.** completed, failed, or canceled all finalize the *same* bubble; in one durable transaction each structured owner commits its own disposition, and only the follow-up that outcome allows is created.
7. **Release, then continue.** After the terminal commits, the exact Active Run is released and the drain runs again — so the next queued item never sits silently.

## Ordering and priority

There is one durable queue with one stable comparator: manually-placed rows first (by position), then `urgent` before `normal`, then FIFO by enqueue time. There is **no third, hidden priority** derived from message kind, source, or category. Reordering by drag submits the full visible order atomically against the expected queue revision — so only an explicit manual action ever overrides the default priority and FIFO.

## How work gets picked up — and why nothing stalls

The drain is **event-driven, with one owner per thread**. Admission, queue mutation, durable handoff, client readiness, execution terminal, external owner evidence, startup recovery and an explicit retry deadline can request another pass. There is no separate watchdog scheduler. A dirty-bit preserves events arriving mid-drain; native acknowledgement occupies only the exact target, without blocking unrelated members.

The result is a structural invariant, not a watchdog: **it is impossible to sit stably in "queue non-empty, a candidate executable, and no responsible drain or retry wake."** Nothing can silently pile up.

## Targets, policy and replay

Common send parses ordinary member mentions. Unmatched `@` text remains unchanged and is ignored for routing; mixed mentions retain the recognized members. Ordinary public input with no available target uses the existing completed-responder/default fallback. Fallback never expands private or whisper authorization; A2A line-start handoffs and explicit recipient IDs keep exact identity and report delivery failure instead of choosing another member.

Target and sending-policy snapshots are committed before Queue admission. A same-ID retry reuses the first winning targets and policy, even if the default later changes; a different ID with the same body is a new input. Historical/recovered targetless rows use the existing recovery path. Unknown ordinary body text does not create a warning or waiting state.

## How a turn ends

A live agent yields exactly one of three outcomes — **completed, failed, or canceled.** A fourth, **interrupted**, is synthesized by startup recovery when a run was admitted but its live client is gone; it converges down the failure path. Every outcome finalizes the *same* response bubble in place — partial streamed output is preserved with a status footer, never swapped for a generic error. A committed terminal is final: a same-generation replay returns the already-committed result rather than producing a second answer.

## Handoff between agents

Two different things are called "handoff," and only one is visible to the protocol:

- **Member-internal continuation** — an agent compacting context or rolling its session over to finish the same invocation. This is invisible to the lifecycle: still the same invocation, still the same response bubble.
- **Protocol-visible A2A handoff** — a completed reply (or an explicit `post_message`) that carries a valid target. It creates a wake referencing the *same* response message — it is **not** copied into a second message — and the next hop begins.

Each hop finalizes **independently and closes only its own `input → target` step.** If agent B, while answering A, mentions D, that does *not* reopen A→B or make A wait recursively for D. An exact A2A **failed** result atomically creates one idempotent `a2a_failure` message-ref control wake for the caller frozen at admission. It points to the original failed response, does not copy its body, and cannot recursively fail back. Completed/canceled/interrupted results do not implicitly re-invoke a predecessor. Structured responsibility is dispositioned only by its own exact owner; it is never inferred from an author field or delivery result.

## What each participant sees

Users and agents read the **same order**, threaded by the History order key. If A starts first and B finishes first, the final order is still *A's bubble → B's bubble*, not completion order. A `processing` bubble is an **ordering barrier** the agent's read cursor may not cross, so late-finishing work never jumps ahead.

"Processing" means server-side execution is live. It does **not** mean the agent has seen or read the content: body exposure and "handled" are separate facts, each with its own owner. Optional `dispatchRef.inputRead` evidence records `pending` or `read`; it does not control Queue membership or create another admission.

## User controls

Four explicit operations act on a specific entry or run. They are *not* remedies for normal scheduling, and they never pause or reorder the queue:

- **Guide reply** — adds your input to an exact supported current reply without interrupting it or creating a second run. Eligibility follows the member’s static guidance capability, not whether a run is currently active. A preparing parent retains the exact guidance intent until client readiness wakes the queue; with no parent execution, the server handles the input as ordinary queued work and starts a fresh reply when admissible.
- **Interrupt reply** — cancels the still-live run for that target, then admits a fresh one.
- **Cancel queued** — deletes a not-yet-dispatched entry; no run is affected.
- **Stop agent** — snapshots the exact live agent run(s) and cancels them; the normal `canceled` callback closes the bubble. (Managed commands and jobs are not in this snapshot.)

## Thread independence

Each thread has its own event-driven drain and its own pending queue. Work in one thread never crosses into another's scheduling; anything shared between threads is an explicit, recorded cross-post.

## Design principles

The whole model rests on five rules:

1. **One owner per fact.** Every fact — queued input, admitted invocation, body exposure, public result, structured responsibility — has exactly one owner. Everyone else references it; no one copies and re-adjudicates it.
2. **Change on one cutover.** A fresh ordinary turn claims one complete source target set; guidance follows its exact response binding; each member's order, side effects, and who-acts-next change only when that target's durable receiver/ref commits. Later target executions and outcomes are independent.
3. **Don't infer one fact from another.** Dispatched is not seen; settled is not handled; enqueue targets are intent, re-verified at dispatch.
4. **One terminal per run.** Each admitted run has exactly one in-place result; a committed verdict cannot be undone or duplicated.
5. **Projections are rebuildable; fail closed.** Avatars, "processing," and refs are all derived from canonical facts. When evidence is missing or ambiguous, omit the dynamic claim and show a diagnostic — never a fake "seen," "working," or "done."
