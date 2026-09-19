# A2A Protocol

Clowder AI runs many agents in one shared thread. The Agent-to-Agent (A2A) protocol is the **lifecycle of a single message** — from the moment it appears, through the shared timeline, to the result an agent produces and what the user sees if something fails.

It is not a routing pipeline. It is a delivery kernel that answers one precise question: when does an input exist only in the queue, when does it enter the shared timeline, when must the head be scheduled, how is it handed to an agent, how does the reply finalize in place, and what does the user see after a failure or restart?

## Three things the system tracks

The delivery kernel is built on exactly three objects. Everything else — body exposure, wait/retry state, structured responsibility — stays with its own owner and is only referenced, never copied.

| Object | Persisted | What it is |
|---|---|---|
| **Queue Entry** | yes | An ordered pending input plus its recoverable source identity and enqueue-time target *intent*. **While it sits in the queue, normal dispatch has not started.** |
| **Chat History Message** | yes | An input, agent message, or response bubble that has entered the chat panel. It has a fixed order key; actually-delivered public messages carry causal `dispatchRefs` to their exact targets and results. |
| **Turn Execution** | yes | The durable child lifecycle for one admitted target and its fixed response bubble. Process-local Active Run/tracker state is only a liveness witness and delivery adapter, never restart truth by itself. |

The pivotal distinction: **a queued user or connector input lives only in the Queue** — invisible to the chat panel and to other agents' context — until its first actual delivery materializes it into History. An agent-authored source is already public History; its Queue Entry carries only the targets that still need that existing source delivered.

## The journey of a message

A normal input goes through seven steps:

1. **A source forms the message.** A user, connector, system, agent, or existing protocol owner has already decided the content, purpose, and targets. The kernel does not re-guess intent.
2. **It persists into the Queue.** The entry point wraps the source envelope as a Queue Entry. Public inputs, agent wakes, and private inputs all enter the *same* durable priority queue, then signal a drain.
3. **The strict source head is selected.** A per-thread drain looks only at the single source entry the comparator computes. It may choose an executable target from that entry, but it never skips to a later source while the head still owns pending work.
4. **Admission — one exact-target cutover.** One transaction promotes (or reuses) the source in History, appends the selected target's `dispatched` ref, removes only that target from Queue, creates the fixed `processing` response bubble, and records the durable Turn Execution. **Only after that transaction commits** is the process-local Active Run created and the agent client called. Sibling targets remain on the same source Queue Entry and cross this boundary independently.
5. **The same bubble streams.** Output updates only the bubble admission created. A member's internal session rollover, context compaction, or continuation stays inside the agent client and creates no new kernel object.
6. **One terminal, in place.** completed, failed, or canceled all finalize the *same* bubble; in one durable transaction each structured owner commits its own disposition, and only the follow-up that outcome allows is created.
7. **Release, then continue.** After the terminal commits, the exact Active Run is released and the drain runs again — so the next queued item never sits silently.

## Ordering and priority

There is one durable queue with one stable comparator: manually-placed rows first (by position), then `urgent` before `normal`, then FIFO by enqueue time. There is **no third, hidden priority** derived from message kind, source, or category. Reordering by drag submits the full visible order atomically against the expected queue revision — so only an explicit manual action ever overrides the default priority and FIFO.

## How work gets picked up — and why nothing stalls

The drain is **event-driven — not a timer, not a priority scheduler.** It runs only after something actually changes what is executable at the head: an enqueue, a removal or reorder, an Active Run finishing, an external owner committing a fact about a not-yet-admitted candidate, or startup finding a non-empty queue. A dirty-bit guarantees that events arriving mid-drain force another pass before the drain owner is released.

The result is a structural invariant, not a watchdog: **it is impossible to sit stably in "queue non-empty, head executable, no Active Run, and no drain."** Nothing can silently pile up.

## Fallback — when no target is given

Fallback applies **only to a public message at the head, and only when the thread is idle** (no Active Run). It routes to the member of the most recent **completed** response bubble if that member is available; otherwise to the server's default member; otherwise it surfaces a visible delivery failure. Members whose latest bubble is processing, failed, or canceled are not candidates.

**Explicit targets and private or structured work never fall back.** A failed exact target produces a typed failure and diagnostic — never a silent reassignment to someone else.

## How a turn ends

A live agent yields exactly one of three outcomes — **completed, failed, or canceled.** A fourth, **interrupted**, is synthesized by startup recovery when a run was admitted but its live client is gone; it converges down the failure path. Every outcome finalizes the *same* response bubble in place — partial streamed output is preserved with a status footer, never swapped for a generic error. A committed terminal is final: a same-generation replay returns the already-committed result rather than producing a second answer.

## Handoff between agents

Two different things are called "handoff," and only one is visible to the protocol:

- **Member-internal continuation** — an agent compacting context or rolling its session over to finish the same invocation. This is invisible to the lifecycle: still the same invocation, still the same response bubble.
- **Protocol-visible A2A handoff** — a completed reply (or an explicit `post_message`) that carries a valid target. It creates a wake referencing the *same* response message — it is **not** copied into a second message — and the next hop begins.

Each hop finalizes **independently and closes only its own `input → target` step.** If agent B, while answering A, mentions D, that does *not* reopen A→B or make A wait recursively for D. On **failure**, custody returns only to the **exact predecessor the source owner names** after disposing that exact invocation — never inferred from a message's author field. Users, connectors, and scheduled or public inputs have no such owner binding and never participate in predecessor return.

## What each participant sees

Users and agents read the **same order**, threaded by the History order key. If A starts first and B finishes first, the final order is still *A's bubble → B's bubble*, not completion order. A `processing` bubble is an **ordering barrier** the agent's read cursor may not cross, so late-finishing work never jumps ahead.

"Processing" means server-side execution is live. It does **not** mean the agent has seen or read the content: body exposure and "handled" are separate facts, each with its own owner.

## User controls

Four explicit operations act on a specific entry or run. They are *not* remedies for normal scheduling, and they never pause or reorder the queue:

- **Guide reply** — immediately adds your input to an exact supported current reply; no new run is created.
- **Interrupt reply** — cancels the still-live run for that target, then admits a fresh one.
- **Cancel queued** — deletes a not-yet-dispatched entry; no run is affected.
- **Stop agent** — snapshots the exact live agent run(s) and cancels them; the normal `canceled` callback closes the bubble. (Managed commands and jobs are not in this snapshot.)

## Thread independence

Each thread has its own event-driven drain and its own queue head. Work in one thread never crosses into another's scheduling; anything shared between threads is an explicit, recorded cross-post.

## Design principles

The whole model rests on five rules:

1. **One owner per fact.** Every fact — queued input, admitted invocation, body exposure, public result, structured responsibility — has exactly one owner. Everyone else references it; no one copies and re-adjudicates it.
2. **Change on one cutover.** For each selected target, order, side effects, and who-acts-next change only when its single durable admission transaction commits. Multi-target initial Queue admission is all-or-none, while later target executions and outcomes are independent.
3. **Don't infer one fact from another.** Dispatched is not seen; settled is not handled; enqueue targets are intent, re-verified at dispatch.
4. **One terminal per run.** Each admitted run has exactly one in-place result; a committed verdict cannot be undone or duplicated.
5. **Projections are rebuildable; fail closed.** Avatars, "processing," and refs are all derived from canonical facts. When evidence is missing or ambiguous, omit the dynamic claim and show a diagnostic — never a fake "seen," "working," or "done."
