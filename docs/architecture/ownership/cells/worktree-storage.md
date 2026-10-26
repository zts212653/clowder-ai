---
cell_id: worktree-storage
title: Worktree Storage Lifecycle
summary: Private Git provenance, complete checkout discovery, explicit recoverable release, original-thread notices and bounded diagnostic workspaces.
doc_kind: architecture
created: 2026-10-24
canonical_features: []
cited_by: []
code_anchors:
  - scripts/worktree-new.mjs
  - scripts/worktree-finish.mjs
  - scripts/lib/worktree-reaper-core.mjs
  - scripts/lib/worktree-inventory.mjs
  - scripts/lib/worktree-release-archive.mjs
  - scripts/lib/daily-cycle-workspace.mjs
  - scripts/lib/daily-cycle-materialize.mjs
  - packages/api/src/infrastructure/worktrees/WorktreeNoticeService.ts
doc_anchors:
  - feature-discussions/2026-10-23-worktree-leak-mechanism-gaps.md
  - docs/ops/daily-cycle-workspace.md
static_scan_hints: [WorktreeNoticeService, worktreeInventory, finishWorktree, withCycleWorkspace]
---

# Worktree Storage Lifecycle

The canonical source remains worktree-private `catcafe.lifecycle.*` Git config plus the existing
verified release internal-archive/ledger. Origin and PR association add provenance without replacing Task,
thread or custody truth. Capacity is a projection, not complete discovery.

The read-only inventory includes undeclared and nonstandard registered paths. GitHub PR evidence
uses canonical gh, exact repository/PR and the complete commit list; unknown stays unknown.
Only explicit authorized finish executes deletion, after the existing protected/owner/dirty/process/
durable-consumer/index/archive checks. Runtime paths stay excluded. Legacy ownership is never invented.

The deployed API consumes inventory notices and existing idempotent History delivery. It verifies
the recorded user against the original thread, changes no worktree and admits no model Queue work.
It neither grants cleanup authority nor substitutes for original-task responsibility.

Daily diagnostic slots reuse one locked workspace separately from permanent cycle evidence.
They preserve unknown originals and stable Git object providers; they do not garbage-collect old cycles,
change publishing authority, or replace the runtime deployment/daemon lifecycle.
