# M0-D 18-Case Joint Acceptance Closure Implementation Plan

**Feature:** F288 — `docs/features/F288-plugin-messaging-domain.md`
**Goal:** Close M0-D by making the contract-owned canonical 18-case catalog pass through each case's real Host execution plane, while keeping runtime activation dormant and K-1 as the only message/cursor truth source.
**Acceptance Criteria:** AC-A1 — Plugin writes use host-issued handles and fail closed on cross-instance, revoked, or unauthorized capabilities; AC-A2 — Send and append operations are idempotent, revision-fenced, and preserve canonical message provenance; AC-A3 — Event delivery, acknowledgements, stale-cursor recovery, and snapshots have matching Memory/Redis behavior with executable regression coverage; AC-A4 — K-2 activates the absorbed domain through the Host Broker only after its separately reviewed contract re-pin and runtime gate. M0-D additionally requires all 18 canonical behavior cases to pass; no case may be classified as “not applicable” while M0 is closed.
**Architecture cell:** `plugin`
**Map delta:** none
**Map delta why:** The work extends the existing contract-consumer, Host inventory, external-runtime, and MessagingDomain seams already owned by `plugin`; it does not add a new public transport, registry, or activation owner.
**Architecture:** The published plugin contract remains the sole catalog and execution-semantics source. Core consumes one machine-readable execution specification per case, dispatches it to a narrow real-Host adapter, and emits one provenance-bound report. Admission-only vectors prove the contract-declared JSON-RPC rejection oracle; Host-control vectors exercise Host-owned policy/state without inventing plugin wire methods.
**Tech Stack:** TypeScript, Node.js test runner, Redis/Lua, supervised stdio JSON-RPC, pnpm, `@clowder-ai/plugin-contract` prerelease, `@clowder-ai/plugin-sdk` prerelease.
**前端验证:** No — this closure adds no UI or activation surface.

---

## Finish line

The finish line is one clean, reviewed Core SHA for which the canonical runner reports exactly:

```json
{
  "passed": true,
  "counts": { "pass": 18 }
}
```

The report must bind:

- the exact published contract/SDK bytes and Plugins source SHA;
- the exact executed/reviewed/merged Host SHAs;
- all 18 contract-owned case IDs in catalog order;
- each case's contract-owned execution plane and oracle;
- real child-process evidence for plugin↔Host wire cases;
- real Host policy/state evidence for Host-control cases;
- zero live runtime activation, zero external credentials, zero reserved-port use, and no persistent-data writes.

This slice does **not** activate a production plugin, modify runtime config, publish the Plugins prerelease, run Feishu dogfood, migrate existing plugins, or close the later `0.1.0` release/documentation gate.

## Baseline RED

At Host merge `1d56abb75a5bceb9a60eaca4b5a101f50ccf2608` with contract beta.11, the real runner is intentionally fail-closed:

```json
{
  "passed": false,
  "counts": {
    "not-implemented-at-frozen-sha": 6,
    "pass": 9,
    "schema-incompatible-at-frozen-sha": 3
  }
}
```

The three admission vectors are `raw-thread-id-rejection`, `system-audience-dual-rejection`, and `snapshot-without-grant-rejected`. They correctly stop at contract-owned JSON-RPC validation before a domain error exists. The other six currently lack a frozen real-Host execution surface. The baseline is evidence, not an acceptable terminal state.

## Terminal execution schema

The next published contract prerelease must provide exactly one machine-readable execution specification for every canonical case. The source-side symbol name is owned by the contract repository; Core will validate the following terminal semantics and fail closed on missing or unknown fields:

```ts
type BehaviorExecutionSpec =
  | {
      readonly caseId: string;
      readonly plane: 'plugin-to-host-wire';
      readonly method:
        | 'messaging.send'
        | 'messaging.appendElements'
        | 'messaging.subscribe'
        | 'messaging.read'
        | 'messaging.ack'
        | 'messaging.snapshot';
      readonly oracle: 'behavior-verdict';
    }
  | {
      readonly caseId: string;
      readonly plane: 'plugin-to-host-admission';
      readonly method:
        | 'messaging.send'
        | 'messaging.appendElements'
        | 'messaging.subscribe'
        | 'messaging.read'
        | 'messaging.ack'
        | 'messaging.snapshot';
      readonly oracle: 'json-rpc-invalid-params-with-zero-side-effects';
    }
  | {
      readonly caseId: string;
      readonly plane: 'host-to-plugin-wire';
      readonly method: 'host.messaging.deliver';
      readonly oracle: 'host-authority-verdict';
    }
  | {
      readonly caseId: string;
      readonly plane: 'host-control';
      readonly control:
        | 'grant-preset'
        | 'grant-revocation'
        | 'permission-matrix-audit'
        | 'replay-retention';
      readonly oracle: 'behavior-verdict';
    };
```

The contract source may encode this as fixture fields or a conformance export, but it must publish the same one-to-one semantics. Core must not infer the plane from a private operation map, reinterpret a loopback-only domain code as a transport code, or add fake production wire methods for fixture controls.

## Stateful-object census

### 1. Contract execution plan

This is a pure, versioned projection. It has no Core persistence.

| State | Event | Next state | Required behavior |
|---|---|---|---|
| package absent | install exact prerelease | loaded | package digest and source SHA bind the plan |
| loaded | catalog/plan one-to-one validation | admitted | all 18 IDs occur exactly once in canonical order |
| loaded | missing/duplicate/unknown plan row | rejected | runner exits non-zero before executing any case |
| admitted | case execution | admitted | dispatch only through the declared plane and oracle |

### 2. Subscription replay-retention floor

**Lifecycle owner:** `EventStreamService` + `CursorStore`. It is distinct from the canonical per-thread event log and from the canonical message store.

| State | Event | Next state | Required behavior |
|---|---|---|---|
| live | Host deletes replay through `N` for the owning subscription | live/stale | monotonic per-subscription replay floor advances to `N`; ack/delivered watermarks do not advance |
| live | foreign instance requests deletion | unchanged | stable `PERMISSION`; zero cursor/event/message mutation |
| live | lower/equal deletion retry | unchanged | idempotent success; floor never regresses |
| live | concurrent read and deletion | live/stale | read either returns a pre-delete complete page or stale; it never silently skips deleted replay |
| stale | snapshot catch-up completes | live | canonical snapshot path advances ack/delivered beyond the replay floor |
| revoked | replay deletion/read | revoked | fail closed; no state resurrection |
| persisted | restart/hydration | same | Memory and Redis retain the same replay floor |

The replay floor is a subscription-local retention projection. It must **not** delete the shared per-thread event log and must never delete canonical messages or threads.

### 3. Grant visibility and revocation

**Lifecycle owner:** `HostInventoryControlPlane` + `PluginInventoryStore`.

Visibility is derived from requested/preset capability provenance; grant activity is derived from `effectiveGrants`. No second grant store is added.

| State | Event | Next state | Required behavior |
|---|---|---|---|
| visible+granted L1 | revoke exact capability/revision | visible+revoked | effective grant removed; requested/visible entry retained; revision advances once |
| visible+revoked | retry same revocation | unchanged | idempotent result; no hidden re-grant |
| preset candidate | contains any non-L1 capability | unchanged | stable `PERMISSION`; no inventory mutation |
| any | stale revision / retired instance | unchanged | existing inventory fencing remains authoritative |

### 4. Host-to-plugin delivery

**Lifecycle owner:** existing `ExternalPluginRuntimeSupervisor` and Host Broker authority.

No new durable state is introduced. Delivery must bind the runtime instance, active transport, and current `onMessage` grant. Missing authority is rejected before a child-visible delivery effect; a denied delivery must not start a runtime.

## Invariants

- **INV-M0D-1:** Exactly one contract-owned execution spec exists for every canonical case ID; Core owns no duplicate catalog or operation→plane map.
- **INV-M0D-2:** A wire-admission case can pass only on the contract-declared JSON-RPC error with all declared side effects unchanged; it cannot inherit a loopback domain code that never executed.
- **INV-M0D-3:** Host controls are not plugin wire methods. No `applyGrantPreset`, `revokeGrant`, `checkPermissionMatrix`, or `deleteReplayEvents` method may enter the public wire registry.
- **INV-M0D-4:** `host.messaging.deliver` remains Host→plugin and requires explicit current `onMessage` authority; denied authority produces no child-visible delivery.
- **INV-M0D-5:** Replay deletion advances only a per-subscription retention floor; it never advances ack/delivered watermarks and never mutates the shared event log or canonical messages.
- **INV-M0D-6:** Replay floors are monotonic, idempotent, restart-safe, and Memory/Redis equivalent.
- **INV-M0D-7:** Foreign, revoked, stale-revision, and crash-window operations are zero-side-effect failures.
- **INV-M0D-8:** First-party preset policy is derived from the contract capability table (L1 only), remains visible, and is independently revocable.
- **INV-M0D-9:** `acceptance.passed=true` is possible only for a complete ordered 18-row catalog whose sole verdict category is `pass`.

## Adversarial matrix

| Invariant | Required executable checks |
|---|---|
| INV-M0D-1 | missing row, duplicate row, unknown plane/oracle, catalog reorder |
| INV-M0D-2 | all three beta.11 schema-incompatible vectors; wrong JSON-RPC code; injected side effect |
| INV-M0D-3 | production wire registry census remains unchanged at 13 methods |
| INV-M0D-4 | denied grant, stopped runtime, grant revoked between admission and delivery |
| INV-M0D-5 | replay delete preserves messages; sibling subscription still reads shared events |
| INV-M0D-6 | lower/equal retry, concurrent read/delete, Redis reload, Memory/Redis parity |
| INV-M0D-7 | foreign owner, revoked subscription, stale grant revision, failed Redis transaction |
| INV-M0D-8 | L2 preset rejected, L1 visible after revoke, complete capability matrix |
| INV-M0D-9 | 17 pass, 18 rows with mixed verdicts, unknown verdict, exact 18 pass |

## Implementation tasks

### Task 1: Preserve the real RED and freeze ownership — completed

**Files:**

- Read: `packages/api/test/plugin-m0d-joint-runner.js`
- Read: `packages/api/test/plugin-m0d-behavior-adapter.js`
- Read: `packages/api/test/plugin-m0d-joint-acceptance.test.js`
- Read: `packages/api/scripts/m0d-joint-acceptance.mjs`

1. Build `@cat-cafe/api` in the isolated worktree.
2. Run `packages/api/test/plugin-m0d-joint-acceptance.test.js`; expected 8/8 GREEN because it protects report integrity and fail-closed completion.
3. Run `runM0dJointAcceptance()` directly; expected RED state is exactly 9 pass / 3 schema-incompatible / 6 not-implemented with `passed=false`.
4. Record the contract execution-plane dependency in the durable task and route it to the verified P-1 owner thread.

### Task 2: Publish contract-owned execution semantics — external prerequisite

**Source repository files (owned by the verified P-1 contract thread):**

- Modify: `packages/plugin-contract/fixtures/behavior/messaging/adversarial-invariants.json` or the equivalent conformance export
- Modify: `packages/plugin-contract/src/conformance/messaging-behavior-fixture.ts`
- Modify: `packages/plugin-contract/src/conformance/index.ts`
- Test: `packages/plugin-contract/src/conformance/behavior-fixture.test.ts`
- Test: `packages/plugin-contract/src/conformance/messaging-loopback-adapter.test.ts`

1. Write a contract RED asserting every canonical case has exactly one valid execution spec and plane-appropriate oracle.
2. Add the terminal schema without changing the existing loopback semantic oracle.
3. Prove catalog/spec one-to-one coverage and production wire registry non-expansion.
4. Run the plugin-contract focused suite and package build.
5. Publish one reviewed prerelease and provide exact package version, integrity, source SHA, and fixture digest to this thread.

Core work must not guess the package symbol or publish this prerelease from the Host thread.

### Task 3: Re-pin and fail closed on execution-plan drift

**Files:**

- Modify: `packages/api/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `packages/api/test/plugin-m0d-joint-runner.js`
- Create: `packages/api/test/plugin-m0d-execution-plan.test.js`

1. Pin the exact reviewed contract prerelease and regenerate only the lockfile entries caused by that pin.
2. Write RED tests for missing, duplicate, reordered, and unknown execution specs.
3. Add a narrow loader that validates the contract export against `M0C_BEHAVIOR_CASE_IDS` and returns the declared spec for one case.
4. Remove `OPERATION_METHODS` and all negative “unknown operation means host-admin” inference from Core.
5. Run:

   ```sh
   CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --test packages/api/test/plugin-m0d-execution-plan.test.js
   ```

   Expected: all execution-plan tests pass; beta.11-shaped missing metadata remains a non-zero fail-closed fixture.
6. Commit the re-pin and consumer validation separately from Host behavior changes.

### Task 4: Make admission-only vectors use their declared transport oracle

**Files:**

- Modify: `packages/api/test/plugin-m0d-joint-runner.js`
- Modify: `packages/api/test/plugin-m0d-behavior-adapter.js`
- Modify: `packages/api/test/plugin-m0d-joint-acceptance.test.js`

1. Write RED tests proving the three admission vectors cannot pass on a domain-code mismatch alone.
2. Preserve the observed JSON-RPC code from the child process and the pre/post Host observations.
3. Evaluate `json-rpc-invalid-params-with-zero-side-effects` only when the contract declares that oracle.
4. Keep loopback domain expectations in the report as non-executed semantic context; do not compare them as the transport result.
5. Run the focused runner/acceptance tests; expected intermediate count after this task is 12 pass / 6 Host-plane gaps, never `passed=true`.

### Task 5: Execute grant policy and permission-matrix controls against Host truth

**Files:**

- Create: `packages/api/test/plugin-m0d-host-control-adapter.js`
- Create: `packages/api/test/plugin-m0d-host-control-adapter.test.js`
- Modify: `packages/api/test/plugin-m0d-fixture-setup.js`
- Read/consume: `packages/api/src/domains/plugin/host-inventory/control-plane.ts`
- Read/consume: `packages/api/src/domains/plugin/host-inventory/ports.ts`

1. Write RED tests for L2 preset rejection, visible L1 revocation, stale revision, retired instance, and complete contract capability-table projection.
2. Seed the real in-memory Host inventory with requested and effective grants from the fixture.
3. Derive first-party preset admission from the contract capability table; reject any non-L1 member before inventory mutation.
4. Call `HostInventoryControlPlane.revokeGrant(...)` for revocation and derive `{visible, granted}` from requested/effective Host truth.
5. Project the permission matrix from the contract capability table; Core must not copy capability arrays.
6. Run the focused Host-control tests and existing inventory suites.

### Task 6: Execute denied Host→plugin delivery without activating production

**Files:**

- Modify: `packages/api/test/plugin-m0d-host-control-adapter.js`
- Modify: `packages/api/test/plugin-m0d-process-fixture.js`
- Test: `packages/api/test/plugin-m0d-host-control-adapter.test.js`
- Test: `packages/api/test/plugin-host-messaging-deliver-stdio.test.js`
- Test: `packages/api/test/plugin-external-runtime-messaging.test.js`

1. Write RED tests for missing `onMessage`, current-grant revocation, and stopped runtime with zero child-visible delivery frames.
2. Stage the same immutable acceptance package used by wire cases.
3. Exercise the existing Host Broker/supervisor authority seam declared by the contract execution spec; do not add a new wire method or auto-start path.
4. Normalize only the contract-declared Host-authority oracle in the report while retaining the raw Host error as evidence.
5. Run the three focused external-runtime/delivery suites.

### Task 7: Add subscription-local replay-retention control

**Files:**

- Modify: `packages/api/src/domains/messaging/stores/ports.ts`
- Modify: `packages/api/src/domains/messaging/stores/memory-cursor.ts`
- Modify: `packages/api/src/domains/messaging/stores/redis-cursor.ts`
- Modify: `packages/api/src/domains/messaging/event-stream.ts`
- Modify: `packages/api/test/plugin-m0d-host-control-adapter.js`
- Create: `packages/api/test/plugin-messaging-replay-retention.test.js`
- Create: `packages/api/test/plugin-messaging-replay-retention-redis.test.js`

1. Write RED tests for owner deletion, foreign deletion, canonical-message preservation, sibling-subscription isolation, monotonic retry, concurrent read/delete, revoke, and Redis reload.
2. Add a monotonic `replayFloorSequence` to the subscription cursor identity/state with default `0` for existing records.
3. Add one atomic CursorStore operation that max-advances only that floor for the exact `(pluginInstanceId, subscriptionId)` owner.
4. Make `EventStreamService.read(...)` compare the acknowledged cursor against both the shared event-log floor and the subscription-local replay floor; concurrent deletion may only yield a complete page or stale.
5. Expose a Host-internal control method that validates subscription liveness/ownership and advances the floor. Do not expose it through the plugin wire registry.
6. Persist/hydrate the floor in Redis without touching snapshot items, shared events, messages, or ack/delivered fields.
7. Run Memory, isolated Redis, snapshot, event-stream, and Host-control focused suites.

### Task 8: Compose the four execution planes into one canonical runner

**Files:**

- Modify: `packages/api/test/plugin-m0d-joint-runner.js`
- Modify: `packages/api/test/plugin-m0d-joint-acceptance.test.js`
- Modify: `packages/api/scripts/m0d-joint-acceptance.mjs`

1. Write a RED assertion that the complete published catalog must produce only `{pass: 18}`.
2. Dispatch each case exclusively from its contract-owned execution spec.
3. Preserve raw plane, method/control, observed result, side-effect evidence, child PID (when applicable), and package digest in every report row.
4. Remove the obsolete `schema-incompatible-at-frozen-sha` and `not-implemented-at-frozen-sha` terminal categories after their cases execute through declared planes.
5. Run the real runner; expected GREEN is exactly 18 pass and `acceptance.passed=true`.
6. Mutation-check at least one case in every plane so the runner returns non-zero for a wrong oracle, missing side effect, or undeclared execution spec.

### Task 9: Verification, review, and upstream delivery

**Files:**

- Modify: `feature-specs/2026-08-27-m0d-18case-closure-plan.md` only if implementation-discovered facts change the terminal design
- Modify: PR body/evidence only after the branch is clean and verified

1. Run focused API build and all M0-D/Host-control/replay-retention suites.
2. Run the official isolated Redis runner with a non-reserved random port and test DB; never reuse live runtime data.
3. Run:

   ```sh
   git diff --check upstream/main...HEAD
   CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 pnpm check
   PATH=/opt/homebrew/bin:$PATH pnpm gate
   ```

4. Re-run the provenance-bound joint acceptance CLI on the final clean exact SHA; archive both full-SHA coordinates, package versions/integrities, fixture digest, 18 rows, and non-claims.
5. Perform the fallback-layer audit. If any touched file gains three or more fallback layers, stop and simplify the state coordinate before review.
6. Run `quality-gate`, then request a non-author cross-family review over the exact HEAD and all state/security paths.
7. Fix every P1/P2 via RED→GREEN, re-run affected evidence, and only then open the upstream PR and register PR tracking.
8. Never self-approve, self-merge, activate a runtime, publish a package, or mutate production data from this branch.

## Open questions

- **Technical OQ — exact contract export symbol and prerelease coordinate:** owned by the verified P-1 contract thread. Core consumes the published symbol after exact version/integrity/source-SHA evidence arrives; it does not guess or publish it.
- **No value OQ:** the user-visible direction, dormant-runtime boundary, 18/18 completion predicate, single contract truth source, and no-production-data rule are already fixed.
