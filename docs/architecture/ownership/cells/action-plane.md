---
cell_id: action-plane
title: Action Plane
summary: 外部动作的 typed service、CLI executor、callback route、权限、审计、dry-run、资源句柄与 durable operator receipt/lease。
canonical_features: [ADR-029, F162, F261, F308, F325]
code_anchors:
  - packages/api/src/infrastructure/enterprise/WeComActionService.ts
  - packages/api/src/infrastructure/enterprise/WeComCliExecutor.ts
  - packages/api/src/infrastructure/enterprise/LarkActionService.ts
  - packages/api/src/infrastructure/enterprise/LarkCliExecutor.ts
  - packages/api/src/domains/managed-job/ManagedJobService.ts
  - packages/api/src/domains/managed-job/managed-job-admission.ts
  - packages/api/src/infrastructure/scheduler/templates/alpha-managed-control.ts
  - packages/api/src/domains/managed-job/managed-job-ledger.ts
  - packages/api/src/domains/managed-job/durable-managed-gate-supervisor.ts
  - packages/api/src/infrastructure/managed-runner-command-worker.ts
  - packages/api/src/domains/ball-custody/durable-managed-gate-child-contract.ts
  - packages/api/src/infrastructure/managed-runner-environment.ts
  - packages/api/src/domains/ball-custody/ManagedCommandWakeRecoverySweep.ts
  - packages/api/src/routes/callback-wecom-action-routes.ts
  - packages/api/src/routes/callback-lark-action-routes.ts
  - scripts/sync-to-opensource.sh
  - scripts/publish-release-tag.sh
  - scripts/lib/release-tag-provenance.sh
  - scripts/lib/github-annotated-tag-lock.sh
doc_anchors:
  - docs/decisions/029-external-tool-integration-strategy.md
  - docs/features/F162-enterprise-action-toolkit.md
  - docs/features/F308-full-sync-durable-fast-train.md
  - feature-specs/2026-10-16-alpha-sleep-consumer.md
static_scan_hints: [ActionService, CliExecutor, callback-action, dry-run, audit, idempotency, resource handle, sync-to-opensource, publish-release-tag, full-sync-train, receipt, gate lease]
cited_by:
  - {feature: F325, date: 2026-10-14, delta: "Promotes generic managed job truth into Action Plane; retires P1 task-test runner; reuses existing supervisor/wake/UI consumers"}
  - {feature: F325, date: 2026-09-29, delta: "P1 host-owned short test command has one ephemeral guardian-owned process lifetime; no durable job truth or generic action executor is added before P2"}
  - {feature: F191, date: 2026-05-07, delta: new cell}
---

# Action Plane

## Canonical Owner

ADR-029 owns the external tool integration strategy: typed `ActionService` is the governance boundary, execution backend is chosen below it, and callback/import/MCP exposure is chosen above it. F162 is the first concrete implementation for WeCom and Lark. F308 adds local maintainer release-train and release-publication executors: durable exact-cut receipts, single-flight leases, remote ref CAS and idempotent retry sit with the external action that may mutate the public target; they do not become a runtime API store or a second sync/release writer.

F261/F325 place general managed-command identity, principal, admission, immutable transitions, supervisor lease/fence, process identity, retry lineage and terminal result in `ManagedJobService` and the promoted managed-job supervisor. Ordinary commands and full gates share this durable core. F167 owns wake/disposition and the existing UI owns presentation; neither is a second job store. MCP/callback authorize and call the service, never directly own the worker. Explicit retries create a new job/epoch after a terminal parent; automatic side-effect replay is disabled. The former Task-specific test runner/guardian is retired.

The opt-in `alpha_revision_v1` consumer uses this same job core with the approved
subscription's guardian principal and an explicit schedule admission. It cannot
invent an invocation/message admission or choose a command over worker IPC.
The subscription freezes its carrier and managed owner; only the existing managed
worker may resume that exact consumer through the shared recovery protocol.

Checkout provenance supplied to managed child commands is noncredential metadata derived from
this same validated descriptor's wake target and original invocation (or job id). Inherited
provenance is discarded, callback/session credentials remain absent, and the receiving
worktree-storage cell records only a newly created checkout's source. No job or cleanup authority
is granted by this metadata.

## Use This When

- Adding or changing an external operation that creates or mutates resources such as docs, tasks, meetings, slides, tables, files, or workflow artifacts.
- Adding a vendor CLI executor, SDK/API client, callback route, audit log, dry-run behavior, idempotency key, or resource handle persistence.
- Deciding whether a capability belongs in a connector adapter, callback route, direct TypeScript service, or MCP wrapper.
- Adding an operator-facing external release/sync command whose dry-run, idempotency, receipt, recovery and write-disposition must remain durable and auditable.

## Extend By

- Add a typed `ActionService` method as the stable programming interface before exposing a new operation to cats or Hub.
- Use `CliExecutor`, direct `execFile`, SDK, or API client according to ADR-029 backend rules.
- Expose through callback routes for local cats, direct imports for Hub internals, and MCP only when cross-process callers truly need it.
- Keep permissions, audit, dry-run, idempotency, and error normalization inside the service boundary.
- For an outbound sync/release train, bind any reusable terminal receipt to the immutable input cut, executable and output; a receipt never grants review, merge or public-write authority by itself.
- For public-main publication, treat remote main, annotated tag and GitHub Release as durable truth. A local tag is a reconstructible cache; tag-visible/release-missing retries validate and reuse the remote raw tag object before continuing.

## Do NOT Unify With

- Do not put enterprise operations into F088 connector adapters. Transport Plane moves messages; Action Plane mutates external resources.
- Do not create an MCP wrapper only for governance or capability discovery. Governance belongs in `ActionService`; vendor CLI/help and skills provide discovery.
- Do not let cats bypass ActionService by shelling out directly when a service route exists; that loses audit and permission boundaries.
- Do not generalize a common ActionService interface before two concrete services prove the shared shape.
- Do not create a second rsync writer, reconciliation ledger, F251 policy or target-workflow owner merely to add orchestration; reuse the existing writer/preservation owners and treat target-owned workflow changes as their own repository change.

## Static Scan Hints

Watch for new or renamed `ActionService`, `CliExecutor`, `callback-*-action`, `dryRun`, `audit`, `idempotency`, `resourceHandle`, `wecom-cli`, `lark-cli`, `publish-release-tag`, and external mutation code.
