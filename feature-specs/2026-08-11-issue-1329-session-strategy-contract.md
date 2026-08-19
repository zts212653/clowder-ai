# Session Strategy Contract Implementation Plan

**Feature:** Issue #1329 — Session Strategy: decouple always-visible session state, policy intent, and client capabilities
**Goal:** Make session state an unconditional observable substrate while keeping operator policy immutable and deriving explicit execution status from the capabilities proven for each managed invocation.
**Acceptance Criteria:** Session State/Chain is always visible and every managed cat/thread has at least a one-node logical chain; `handoff`, `compress`, and `hybrid` remain operator intent and are never rewritten by capability checks; capability derives only `active`, `degraded`, or `unavailable` with stable reasons; handoff may act only with the complete #1209 proof set; strategy changes affect the current active session from the next managed invocation; legacy `sessionChain:false` is dual-read/single-write migrated to effective `compress` without mutating the legacy byte; absent historical compression remains unknown; hybrid progress is revision-scoped and atomic; managed serial/parallel/CLI/ACP/external invocations share one snapshot/FSM while unmanaged external sessions are projection-only and unavailable for lifecycle action.
**Architecture cell:** `identity-session`
**Map delta:** none
**Map delta why:** #1329 changes contracts inside the existing identity/session ownership cell without adding a new subsystem owner.
**Architecture:** Session records are the always-on state layer. A revisioned policy snapshot is resolved once at the managed invocation boundary and stored on the active record for hooks and audit. A pure capability evaluator derives execution status without changing policy. Hybrid compaction progress is a separate revision-scoped state object and never reuses lifetime telemetry as policy progress.
**Tech Stack:** TypeScript, Fastify, Redis Lua, React, Vitest, Node test runner
**前端验证:** Yes — Hub member settings and Session Chain panel on isolated worktree ports, desktop and narrow/mobile viewport

---

## Public contract and finish line

The source of truth is the accepted #1329 issue body plus the maintainer WELCOME comment. This implementation must not modify #1209 semantics or move #1326 work into this branch.

At the finish line:

1. Session state exists independently of any strategy or provider capability and is queryable from the first managed invocation.
2. Persisted and effective policy remains exactly the operator-selected policy. Unsupported execution is represented only by status and stable missing-capability reasons.
3. Every managed invocation has one immutable policy snapshot. A save during invocation N first affects invocation N+1 on the same active session.
4. Handoff action requires all of `effective_input_ceiling`, `carrier_binding`, `authoritative_usage`, `session_rotation`, and `continuity_bootstrap` on that same invocation.
5. Hybrid action consumes only atomic progress for the applied policy revision. Lifetime compression telemetry is nullable and cannot trigger policy action.
6. New API/UI writes strategy only. Legacy `sessionChain` remains byte-preserved rollback input and is never written by the new surface.
7. Managed external invocations enter the same boundary. Unmanaged external sessions expose state, policy, and `unavailable(managed_invocation_boundary)` but perform no lifecycle action.

## Terminal schema

```ts
type SessionStrategyPolicy = 'handoff' | 'compress' | 'hybrid';

type SessionPolicySource =
  | 'runtime_override'
  | 'config_file'
  | 'breed_code'
  | 'provider_default'
  | 'global_default'
  | 'legacy_session_chain_false';

type SessionExecutionReason =
  | 'effective_input_ceiling'
  | 'carrier_binding'
  | 'authoritative_usage'
  | 'session_rotation'
  | 'continuity_bootstrap'
  | 'compression_signal'
  | 'managed_invocation_boundary';

interface SessionExecutionStatus {
  readonly status: 'active' | 'degraded' | 'unavailable';
  readonly missingCapabilities: readonly SessionExecutionReason[];
}

interface SessionPolicySnapshot {
  readonly config: SessionStrategyConfig;
  readonly source: SessionPolicySource;
  readonly revision: string;
  readonly changedAt: number;
  readonly execution: SessionExecutionStatus;
}

interface HybridProgress {
  readonly policyRevision: string;
  readonly observedCount: number;
  readonly startedAt: string;
}

interface SessionRecord {
  cliSessionId?: string;
  compressionCount: number | null;
  appliedPolicy?: SessionPolicySnapshot;
  hybridProgress?: HybridProgress;
}
```

`compressionCount: null` means the lifetime total is not known. `0` means a full observation boundary exists and zero compressions have been observed. `HybridProgress.observedCount` is policy-local progress and is reset whenever the applied revision changes or the policy leaves hybrid.

## Policy/action matrix

| Policy | Required execution evidence | Missing evidence result | Runtime action while not active |
|---|---|---|---|
| `handoff` | effective input ceiling, equal carrier binding, authoritative current usage, session rotation, continuity bootstrap | `unavailable` with every stable missing reason | no seal; retain `handoff` |
| `compress` | a managed invocation boundary; telemetry is not execution authority | active and passive regardless of telemetry; `unavailable` only for an unmanaged boundary projection | take no proactive lifecycle action; retain `compress` |
| `hybrid` | observable compaction events, session rotation, continuity bootstrap | `degraded` when compaction events are unavailable; `unavailable` when no managed boundary exists | remain passive; never execute handoff behavior |

Capability discovery may refine execution status during the same invocation, but it may not replace the snapshot's config, source, revision, or `changedAt`.

## Stateful object census

1. **Runtime strategy override envelope** — owner: `session-strategy-overrides`. States: absent, legacy plain config, revisioned envelope. Events: hydrate, set, delete. Legacy values are read compatibly; every new write emits a revision and timestamp.
2. **Logical session record** — owner: `SessionChainStore`. States: absent, active logical/unbound, active bound, sealing, sealed. Events: first managed invocation, runtime `session_init`, seal request, finalize. The store atomically returns an existing active record or creates exactly one.
3. **Applied policy snapshot** — owner: managed invocation boundary, persisted on the logical session for audit and hook decisions. States: absent, applied, execution-refined, superseded by a later invocation. Config writes never mutate an in-flight snapshot.
4. **Hybrid progress** — owner: `SessionChainStore`. States: absent/inactive, revision-current with count, threshold reached, terminal with sealed session. A compression event updates lifetime telemetry and revision-local progress atomically.
5. **Lifetime compression observation** — owner: `SessionChainStore`. States: unknown (`null`) or observed (`0..n`). Missing legacy/provider evidence never transitions unknown to zero. A trusted full-observation session starts at zero; unknown legacy totals remain unknown even when later events occur.
6. **Execution status** — pure projection from policy plus evidence. It has no independent mutation path and cannot change policy.
7. **External runtime projection** — owner: external-runtime/session read model. Managed invocations receive the normal snapshot; unmanaged external records are projection-only and deterministically report `unavailable(managed_invocation_boundary)`.
8. **Hub strategy form** — owner: client query cache/form. States: loading, partial, full, error. It submits only strategy fields and presents all policy choices regardless of capability.

## State × event transition table

| Object state | Event | Next state | Owner / required evidence | Forbidden bypass |
|---|---|---|---|---|
| No logical session | Managed invocation starts | One active logical record | Atomic store get-or-create keyed by user/cat/thread | Waiting for `session_init`; creating duplicate active nodes |
| Active logical/unbound | Provider emits `session_init` | Same record, CLI/runtime ID bound | Store CAS binding and uniqueness index | Creating a second chain node only to attach an ID |
| Active record | Invocation starts | Applied immutable policy snapshot | Effective read precedence + current evidence | Live-reading policy during later usage/hook decisions |
| Invocation N active | Operator saves strategy | Persisted revision N+1; invocation N unchanged | Strategy override store | Mutating N's snapshot or immediately sealing |
| Same session, invocation N+1 | Snapshot resolution | Record applies revision N+1; hybrid progress resets as required | Invocation boundary | Waiting for session rollover |
| Legacy false + no explicit policy | Effective read | `compress`, source `legacy_session_chain_false` | Read-time migration only | Persisting derived strategy; changing legacy byte |
| Legacy false + explicit policy | Effective read | Exact explicit policy | Explicit precedence | Letting legacy boolean override intent |
| Handoff missing any proof | Threshold evaluation | No action + `unavailable` | Same-invocation proof set | Sealing from guessed ceiling or non-authoritative usage |
| Hybrid revision R count k | Trusted compact event for R | Atomic count k+1; allow or seal by configured boundary | Store transition keyed by record+revision | Reading/updating lifetime count as policy progress |
| Hybrid revision R | Applied revision changes to S | New progress for S at zero or absent if non-hybrid | Store apply-policy transition | Carrying R's progress into S |
| Lifetime observation absent | Read/migration | `null` | Shared/store hydration | `?? 0`, falsy UI rendering, silent zero |
| Unmanaged external record | Read state/policy | Project unavailable boundary status | Read model only | Registering lifecycle hooks or issuing a seal |
| Active record | Seal accepted | sealing → sealed | Session sealer/store CAS | Policy/capability UI directly mutating lifecycle state |

## Invariants and test matrix

- **INV-1 — State visibility:** disabling the legacy toggle or selecting any strategy cannot suppress creation, lookup, persistence, route bootstrap, or UI visibility of a session record.
- **INV-2 — One-node minimum:** the first managed invocation creates one logical node even when no provider emits `session_init`; later binding updates that node.
- **INV-3 — One active node:** concurrent first invocations atomically converge on one active logical record.
- **INV-4 — Policy immutability:** persisted value, effective snapshot, and runtime action remain the selected policy. Capability evaluation never returns a replacement strategy.
- **INV-5 — Explicit precedence:** explicit runtime/config/breed/provider strategy wins over legacy migration; only legacy false with no explicit strategy derives compress.
- **INV-6 — Single-write migration:** PATCH accepts strategy only, does not write `sessionChain`, and does not reject a policy because capability is absent.
- **INV-7 — Invocation boundary:** a configuration write during invocation N is first observable by invocation N+1 on the current active record.
- **INV-8 — Complete handoff proof:** dropping any one of the five handoff proof dimensions produces unavailable, stable reason output, and no seal.
- **INV-9 — Unknown is not zero:** legacy/missing compression count hydrates and renders as unknown; observed zero renders as zero.
- **INV-10 — Hybrid epoch isolation:** old lifetime telemetry and progress from another revision cannot trigger a hybrid seal.
- **INV-11 — Atomic hybrid action:** concurrent compaction events cannot lose increments or create multiple accepted seal transitions.
- **INV-12 — Managed runtime parity:** serial, parallel, CLI, ACP, and managed external routes construct the same snapshot schema and use the same action evaluator.
- **INV-13 — Unmanaged safety:** unmanaged external records expose unavailable boundary status and never invoke the sealer.
- **INV-14 — Auditability:** `invocation_created` includes the applied policy config/source/revision/change time and execution status used by that invocation.
- **INV-15 — UI truthfulness:** all three policies remain selectable; status and missing reasons are visible; changing policy states that it applies on the next invocation.

## Adversarial scenarios

- Two first invocations race before either provider emits `session_init`.
- A provider never emits `session_init`, reports no usage, or reports aggregate output/total tokens only.
- A strategy save lands after invocation start but before its final usage event.
- Legacy `sessionChain:false` coexists with explicit `hybrid`; explicit hybrid wins and status reports capability honestly.
- Legacy session records omit `compressionCount` and later receive a compact event.
- A session has high lifetime compression telemetry before entering a new hybrid revision.
- Two compact hooks arrive concurrently at the hybrid threshold.
- A stale compact hook names the old applied policy revision after the next invocation has applied a new revision.
- Carrier binding proves a different model/window than the effective ceiling.
- Managed external registration has state metadata but no invocation lifecycle controls.
- Hub strategy GET is partial or errors while the member editor remains usable.
- Desktop and narrow layouts contain long missing-capability reason lists.

### Task 1: Define policy, status, snapshot, and nullable telemetry types

**Files:**
- Modify: `packages/shared/src/types/session.ts`
- Modify: `packages/api/src/config/session-strategy.ts`
- Modify: `packages/api/src/domains/cats/services/agents/context-lifecycle-capability.ts`
- Test: `packages/api/test/config/session-strategy.test.js`
- Test: `packages/api/test/context-lifecycle-capability.test.js`

1. Add RED tests for no-rewrite policy resolution, explicit-vs-legacy precedence, stable status reasons, and nullable compression telemetry.
2. Add the shared terminal types and a pure evaluator returning only execution status.
3. Replace `shouldTakeAction` inputs with an explicit snapshot/progress contract and make unknown evidence fail closed.
4. Run the focused pure-policy suites to GREEN.

### Task 2: Add revisioned dual-read/single-write strategy persistence

**Files:**
- Modify: `packages/api/src/config/session-strategy-overrides.ts`
- Modify: `packages/api/src/config/session-strategy.ts`
- Modify: `packages/api/src/routes/session-strategy-config.ts`
- Test: `packages/api/test/config/session-strategy-overrides.test.js`
- Test: `packages/api/test/session-strategy-config-route.test.js`

1. Add RED tests for legacy plain override hydration, revision stability, new-write timestamps, strategy-only PATCH, and capability-independent acceptance.
2. Store a backward-compatible revisioned envelope while preserving reads of existing plain values.
3. Derive legacy false at read time only and expose policy source/revision/status in GET.
4. Verify the legacy boolean remains byte-identical after GET and PATCH.

### Task 3: Make the session store own the logical node and hybrid transition

**Files:**
- Modify: `packages/api/src/domains/cats/services/stores/ports/SessionChainStore.ts`
- Modify: `packages/api/src/domains/cats/services/stores/in-memory/InMemorySessionChainStore.ts`
- Modify: `packages/api/src/domains/cats/services/stores/redis/RedisSessionChainStore.ts`
- Test: `packages/api/test/session-chain-store.test.js`
- Test: `packages/api/test/redis-session-chain-store.test.js`

1. Add RED race tests for atomic get-or-create, late CLI binding, nullable lifetime telemetry, revision reset, and concurrent compact events.
2. Allow an unbound logical record and add atomic get-or-create/bind operations in both stores.
3. Add one atomic apply-policy transition and one compact-event transition guarded by the applied revision.
4. Preserve unknown lifetime totals; initialize zero only when the invocation establishes full observation coverage.
5. Run in-memory and isolated Redis suites to GREEN.

### Task 4: Snapshot policy at every managed invocation boundary

**Files:**
- Modify: `packages/api/src/domains/cats/services/agents/invocation/invoke-single-cat.ts`
- Modify: `packages/api/src/domains/cats/services/agents/invocation/invocation-capacity-snapshot.ts`
- Modify: `packages/api/src/domains/cats/services/agents/routing/route-serial.ts`
- Modify: `packages/api/src/domains/cats/services/agents/routing/route-parallel.ts`
- Test: `packages/api/test/invoke-single-cat.test.js`
- Test: route parity suites covering serial and parallel bootstrap/state handling

1. Add RED tests for first-invocation logical creation, no-init provider behavior, next-invocation policy application, and removal of every legacy state-visibility gate.
2. Resolve/store one immutable snapshot before provider work; use it for pre-invocation and post-usage actions.
3. Extend handoff proof evaluation with rotation and continuity bootstrap evidence from the managed boundary.
4. Bind later `session_init` events onto the existing record and project snapshot evidence into `invocation_created`.
5. Run invocation plus serial/parallel routing suites to GREEN.

### Task 5: Move compact hooks onto the applied policy epoch

**Files:**
- Modify: `packages/api/src/routes/session-hooks.ts`
- Modify: `packages/api/src/domains/cats/services/session/SessionSealer.ts` only if the existing seal CAS cannot express the atomic terminal transition
- Test: `packages/api/test/session-hooks.test.js`

1. Add RED hook tests for compress, active hybrid, degraded hybrid, handoff no-op, stale revision, unknown lifetime telemetry, and concurrent threshold events.
2. Stop live-reading strategy in the hook; consume the record's applied policy snapshot.
3. Record compact events atomically and request a seal only when the matching hybrid epoch crosses its boundary.
4. Ensure no unsupported hybrid path executes handoff behavior.

### Task 6: Project managed/unmanaged state and execution status

**Files:**
- Modify: session-chain API/MCP projection routes and their tests
- Modify: external-runtime session read projection and tests
- Modify: `packages/api/src/routes/session-strategy-config.ts`

1. Add RED tests that all state APIs remain available regardless of legacy toggle/policy.
2. Expose nullable telemetry, applied policy, execution status, and stable reason codes.
3. Mark unmanaged external records `unavailable(managed_invocation_boundary)` and prove no lifecycle call occurs.
4. Verify managed external invocation adapters reuse the managed snapshot helper rather than a parallel policy implementation.

### Task 7: Replace the legacy Hub toggle with policy + status UX

**Files:**
- Modify: `packages/web/src/components/hub-strategy-types.ts`
- Modify: `packages/web/src/components/hub-cat-editor.model.ts`
- Create: `packages/web/src/components/HubSessionStrategyEditor.tsx`
- Modify: `packages/web/src/components/hub-cat-editor-advanced.tsx`
- Modify: `packages/web/src/components/HubCatEditor.tsx`
- Modify: `packages/web/src/components/HubMemberOverviewCard.tsx`
- Modify: `packages/web/src/components/SessionChainPanel.tsx`
- Test: `packages/web/src/components/__tests__/hub-cat-editor.test.tsx`
- Test: `packages/web/src/components/__tests__/session-chain-panel.test.tsx`

1. Add RED UI tests for all three choices, status/reason rendering, strategy-only PATCH, next-invocation copy, and unknown-vs-zero telemetry.
2. Remove the new UI's boolean edit path and capability-based option filtering/hiding.
3. Extract the strategy editor so the existing advanced component returns below the console component size limit.
4. Implement loading, partial, full, and error states with existing Hub tokens and responsive layout.
5. Run focused Vitest suites to GREEN.

### Task 8: Failure-mode audit and delivery

1. Search for every `isSessionChainEnabled`, `sessionChainEnabled`, `validateProviderCapability`, `compressionCount ?? 0`, and live `getSessionStrategy` lifecycle use; classify or remove every match.
2. Run shared/API builds, focused policy/store/hook/invocation/route suites, isolated Redis tests, and focused web tests.
3. Run Biome, `git diff --check`, TypeScript, and the risk-matched full gate on the exact commit.
4. Start the isolated web/API stack on worktree ports and use Browser Preview for desktop and narrow evidence of Hub settings and Session Chain states.
5. Perform a fresh-context scan, then request cross-family review on the exact HEAD. Address findings with TDD and rerun the exact impacted matrix.
6. Push the feature branch, open the upstream PR, immediately register PR tracking, then follow cloud review/CI and maintainer review through merge.

## Straight-line check

- No feature flag or parallel storage path is introduced.
- No capability fallback rewrites policy.
- No migration job mutates legacy booleans or invents historical compression counts.
- One session store owns logical identity, applied policy, telemetry, and policy-local progress.
- One policy evaluator is reused across managed runtimes.
- One extracted Hub editor replaces the legacy toggle rather than layering another settings section beside it.
