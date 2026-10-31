---
cell_id: local-host-recovery
title: Local Host Recovery
summary: Operator-installed, fixed-purpose native host recovery; private evidence and cooldown survive application/worktree lifetimes, without granting agent invocation authority.
canonical_features: [ADR-029]
code_anchors:
  - scripts/macos/fseventsd_recovery.py
  - scripts/macos/fseventsd_recovery_policy.py
  - scripts/macos/fseventsd_recovery_native.py
  - scripts/macos/fseventsd_recovery_store.py
  - scripts/macos/install_fseventsd_recovery.py
doc_anchors:
  - docs/ops/fseventsd-recovery.md
static_scan_hints: [LaunchDaemon, fseventsd, root-owned, native diagnostics, cooldown]
cited_by: []
created: 2026-10-16
---

# Local Host Recovery

The human host operator owns installation and activation. The installed, pinned
root-owned bundle owns only its fixed FSEvents observation, bounded native
diagnostics, recovery intent, cooldown and outcome. Its state lives outside
mutable worktrees and is not a Task, authorization store or general job executor.

Agent invocations, package installation and resource admission cannot activate
it, nominate a PID or provide executable commands. Admission continues to own
whether workloads may start; this helper does not forge gate results. The API,
managed-job worker, Redis and application runtime remain separate owners.

Use this boundary for the opt-in native recovery helper. Adding another service,
general command dispatch, remote activation or agent-configurable policy needs
an explicit change to the operator contract; it is not an incidental extension.
