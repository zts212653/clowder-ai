---
cell_id: worktree-storage
title: Worktree Storage Lifecycle
summary: Private Git provenance, complete checkout discovery, recoverable merged-checkout retirement, original-thread notices and bounded diagnostic workspaces.
doc_kind: architecture
created: 2026-10-24
canonical_features: []
cited_by: []
code_anchors:
  - scripts/worktree-new.mjs
  - scripts/worktree-finish.mjs
  - scripts/worktree-retire-merged.mjs
  - scripts/lib/worktree-reaper-core.mjs
  - scripts/lib/worktree-inventory.mjs
  - scripts/lib/worktree-origin.mjs
  - scripts/lib/worktree-release-archive.mjs
  - scripts/lib/worktree-release-transactions.mjs
  - scripts/lib/daily-cycle-workspace.mjs
  - scripts/lib/daily-cycle-materialize.mjs
  - packages/api/src/infrastructure/worktrees/WorktreeNoticeService.ts
  - packages/shared/src/worktree-notice.ts
  - packages/web/src/components/worktrees/WorktreeNoticeBody.tsx
doc_anchors:
  - feature-discussions/2026-10-23-worktree-leak-mechanism-gaps.md
  - docs/ops/daily-cycle-workspace.md
static_scan_hints: [WorktreeNoticeService, worktreeInventory, finishWorktree, withCycleWorkspace]
---

# Worktree Storage Lifecycle

The canonical source remains worktree-private `catcafe.lifecycle.*` Git config plus the existing
verified release internal-archive/ledger. Origin and PR association add provenance without replacing Task,
thread or custody truth. Inventory counts never veto worktree creation.

Managed commands carry checkout creation metadata from the validated job descriptor, separately
from callback credentials and provider process ownership. `worktree:new` consumes that metadata
when explicit CLI/current invocation source fields are absent; it never declares a legacy checkout
after the fact. The runner discards inherited metadata before supplying the current job's source.

The read-only inventory includes undeclared and nonstandard registered paths. GitHub PR evidence
uses canonical gh, exact repository/PR and the complete commit list; unknown stays unknown.
Explicit owner finish and the authorized periodic merged-checkout consumer share the same protected/
owner/dirty/process/durable-consumer/index/archive checks. Runtime paths stay excluded. Legacy
ownership is never invented; automatic retirement requires valid origin, exact repository/PR/HEAD
and no active named retention. Alpha, never-policy and locked trees stay protected.

The API's existing five-minute sweep verifies the recorded user against the original thread before
invoking native finish. Its system actor is recorded as `worktree-lifecycle`, never the author.
The existing release ledger also carries repository/origin for bounded notification replay after an
interrupted History delivery. No new store or scheduler is introduced. Native
archive preservation and branch retention remain the recovery source. This is source behavior;
live acceptance still requires deployment and does not follow from a merge or unit tests.

Host notice metadata projects validated display facts, not live status or cleanup authority. The existing
connector shell uses a registered SVG identity, readable titles and folded technical/recovery details;
known historical debug-text notices have a read-only display adapter. Unrecognized or non-Host messages
retain their ordinary content. A retention episode notifies once per status, original user/thread and
recorded retention; advancing checkout HEAD alone does not repeat the same warning, while expiry and
an explicit renewal remain distinct. This does not change retention validity or removal guards.

The sweep performs eligible merged-checkout removal before delivering its result. Unfinished retention
or blocked cleanup is atomically delivered with one target-only Queue input for the verified original
owner in the original user/thread. Completed removals remain History-only. The existing Queue owns
admission, retry and wake; the producer creates no Task and never treats a visible reminder as completed
cleanup. Automatic owner work requires a currently registered, available member whose applied engagement policy is not
weekly-subscription-scarce. An unavailable or scarce owner instead leaves one visible, explicitly unqueued
exception in the verified original thread; later availability can admit one distinct owner item. No substitute
owner is inferred. Failed atomic Queue admission cannot publish a successful handoff. Queued means one pending
input, not continuous monitoring or a completed disposition.

Without valid origin the scanner exposes exact paths in the existing inventory's `unroutable` result; it does
not guess a user/thread or authorize removal. Those legacy cases require the existing repository maintenance
work's explicit inventory check and source verification. The original maintenance Task469 keeps its
current inventory and source-thread follow-ups; a rollout snapshot is not a permanent count or a
presumption that retained checkouts are useful. No universal guardian, new Task or shadow ownership
registry is created.

Automatic transactions journal preserving/removing phases before their corresponding work. A failure
pauses further automatic attempts for that path/HEAD. Before removal, duplicate archives can be discarded;
once removal might have started, recovery material stays unless the source originals are still intact.
The same sweep reconciles orphan transactions only after their writer and consumers are gone. Verified
missing paths/registrations produce an explicit interrupted-removal notice, not a fabricated finish receipt.
The journal carries aborts and recovery observations; there is no retry counter store or new timer.

Daily diagnostic slots reuse one locked workspace separately from permanent cycle evidence.
They preserve unknown originals and stable Git object providers; they do not garbage-collect old cycles,
change publishing authority, or replace the runtime deployment/daemon lifecycle.
