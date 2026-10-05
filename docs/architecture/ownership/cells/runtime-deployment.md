---
cell_id: runtime-deployment
title: Runtime Deployment / Daemon Lifecycle
summary: Managed deployment identity, frozen build target, daemon ownership, stop/restart operation evidence, and durable per-boot readiness facts kept separate from task waits and invocation admission.
doc_kind: architecture
created: 2026-09-27
canonical_features: [F300, F323]
code_anchors:
  - scripts/runtime-worktree.sh
  - scripts/start-dev.sh
  - scripts/alpha-worktree.sh
  - scripts/lib/alpha-coordinates.mjs
  - scripts/lib/alpha-named-launch.sh
  - scripts/lib/alpha-redis-process.mjs
  - scripts/lib/alpha-redis-leases.mjs
  - packages/api/src/config/alpha-coordinates.ts
  - scripts/daemon-state.mjs
  - scripts/lib/daemon-state.mjs
  - scripts/lib/daemon-stop-operation.mjs
  - scripts/lib/daemon-stop-record.mjs
  - scripts/lib/daemon-stop-claim.mjs
  - scripts/lib/daemon-health-probe.mjs
  - packages/api/src/config/runtime-deployment-revision.ts
  - packages/api/src/config/runtime-deployment-inclusion.ts
  - packages/api/src/domains/runtime-deployment/RuntimeDeploymentLedger.ts
  - packages/api/src/domains/runtime-deployment/RuntimeDeploymentObservationProvider.ts
  - packages/api/src/routes/runtime-deployment-routes.ts
doc_anchors:
  - docs/decisions/039-runtime-passive-freeze.md
  - docs/features/F300-self-sensing-home-state-awareness.md
  - docs/features/F323-runtime-restart-coordination.md
  - feature-discussions/2026-09-27-runtime-restart-coordination/architecture-review.md
  - feature-specs/2026-09-27-f323-runtime-restart-coordination.md
static_scan_hints: [StopOperationRecord, requestStop, authorizeRestart, reverify, daemonStatePaths, resolveRuntimeDeploymentRevision, RuntimeDeploymentLedger, RuntimeDeploymentObservationProvider, frozen target, deploymentRevision, boot identity]
cited_by:
  - {feature: F323, date: 2026-09-27, delta: document existing F300 and ADR-039 daemon ownership plus durable boot-observation boundary}
  - {feature: F290, date: 2026-09-30, delta: a named isolated Alpha consumes a frozen main target and validated coordinates without stopping or rewriting an existing deployment}
---

# Runtime Deployment / Daemon Lifecycle

## Canonical Owner

The deployment/daemon module owns the identity-verified serving process set, frozen source/build target,
daemon record, stop operation and lifecycle verification facts. ADR-039 defines source freeze and explicit
start/stop/restart semantics; F300 WP1 supplies independent-executor and stop-operation primitives. F323
consumes and extends this module for coordinated maintenance. It does not create another process registry.

This cell documents existing code ownership; it does not grant restart permission. Current free-text
`authorizedBy` and CLI invocation/PID coordinates are recorded inputs, not authenticated principal proof.
The canonical shell restart currently does not bind the full authorize/restarted/reverified sequence to
the prior stop record; connecting that sequence is planned F323 work, not an existing guarantee.

F323 Phase A persists per-start identity/version/ready/exit observations in this owner and exposes a
loopback-only Web-readiness fact writer. Authenticated operation provenance and a browser-accessible
lifecycle/status adapter that remains available while the target API/Web is down remain Phase B/C work.
Those future surfaces must extend this owner and must not be confused with the ephemeral API lease or a
second Task/wait database.

## Use This When

- Changing runtime source freeze, build identity, daemon process ownership or start/stop/restart semantics.
- Changing StopOperationRecord transitions, independent-executor checks or lifecycle health verification.
- Reporting which deployed artifact is actually loaded, as distinct from the checkout's current HEAD.
- Adding boot/exit history or authenticated requester/approver/executor evidence.
- Designing a controller/status surface whose target serving process can be offline.

## Extend By

- Keep installation/deployment, process identity, frozen artifact and lifecycle operation separately
  attributable. Capture a running revision at startup; later disk changes cannot rewrite its history.
- Bind new frontend actions to authenticated authority. A source reference, SHA, PID or caller-written
  actor label alone is not approval. Keep suggestion, approval, execution and observed result distinct.
- Verify executor independence and the complete affected process set. Unknown ownership cannot be
  converted to permission, and a timeout cannot fabricate a clean shutdown result.
- Make boot/exit observations durable before exposing a guarantee. Record clean exit only after required
  cleanup completes. Missing evidence is unknown; an authorized request can still end abnormally.
- Provide typed deployment facts to ball-custody predicates. Startup and readiness observations never
  directly invoke a cat or close a business Task; the owning wait and dispatch paths decide admission.
- If isolated prebuild is selected, preserve artifact identity and ADR-039's prohibition on mutating a
  serving runtime tree. Treat activation/recovery changes as reviewed lifecycle behavior.
- Named Alpha launch uses the existing managed-preview process record and derives one isolated checkout,
  branch and port tuple from the canonical main installation. Current Git/build/path/environment facts
  validate that tuple; its JSON descriptor is not authorization. An occupied listener or serving checkout
  is preserved. Cleanup must identify the Redis process created by this launch before any Redis command.
  A launcher publishes its exact owner and Redis incarnation proof for gate recognition in the separate
  named-Alpha lease namespace. Gate revalidates the live process, registered checkout, Redis directory and
  preview expiry; this is a read-only ownership projection, not stop authority or a generic preview exemption.
  Stale or unknown evidence remains rejected and is never auto-cleaned by the gate. Only the original
  launcher removes its registration; existing Alpha data remains under its normal lifecycle.
  The independently configured Collective Service remains owned by `collective-runtime`.

## Do NOT Unify With

- `ball-custody`: owns Task waits, owner fences, cancellation and durable wake obligations. F323 uses
  a typed F280 deployment await on the original work Task; existing probes keep their own behavior.
- `dispatch`: owns accepted messages, queue/invocation admission, concurrency and restart reconciliation.
  It persists and checks the maintenance admission generation at its atomic admission boundary, linked
  to this module by opId. The stop record does not own an admission flag or a copied recovery list.
- `managed-work` / F275: owns work admission identity and execution attribution; deployment readiness
  cannot create or terminalize that identity.
- Original Task/domain owner, with F310 continuity: owns business responsibility and completion;
  a ready runtime is not an accepted feature or a completed Task.
- Provider session/CLI owners: they report child execution and resource truth; ending one model turn is
  not proof that every managed command, external job, plugin or recording has stopped.
- `collective-runtime`: its independent Service/Channel lifecycle is a different deployment subject.
- F306 native-effect guard: consumes targets/identity and enforces action policy; this map does not
  override it or open general shell execution through an HTTP endpoint.

## Static Scan Hints

Watch duplicated daemon state files, direct PID signals outside the verified lifecycle, mutable checkout
HEAD presented as running version, exit intent presented as clean completion, free-text actor fields used
as permission, boot observers directly waking cats, and restart code modifying a currently serving tree.
