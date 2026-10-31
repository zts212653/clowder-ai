# Context Capacity Invocation Binding Implementation Plan

**Feature:** Issue #1208 — Context limit / session-chain capacity owner
**Goal:** Make one invocation snapshot consume the concrete provider model and become lifecycle-actionable only after the same window is proven on that invocation's carrier.
**Acceptance Criteria:** The effective model/window is identical in prompt budgeting, context health, lifecycle decisions, and native provider configuration; catalog Auto never becomes actionable from capability flags alone; OpenCode native-auth invocations apply the exact snapshot window before provider launch; ACP model overrides feed both capacity resolution and the spawned carrier; OpenCode keeps a persistent user-visible warning active until it receives an authoritative current-context numerator, across both serial and parallel routing.
**Architecture cell:** `identity-session`
**Map delta:** none
**Map delta why:** This review closure tightens the existing provider/session binding contract without changing cell ownership.
**Architecture:** Separate static carrier capability from concrete invocation binding. A service-created binding proves model/window already applied at carrier construction; a per-invocation binding proof is created only after native config is successfully written, and the immutable snapshot is projected forward before the provider is launched.
**Tech Stack:** TypeScript, Node test runner, ACP process pools, OpenCode per-invocation JSON config
**前端验证:** No

---

## Finish line

At provider launch, the model used to resolve capacity and the window admitted for automatic lifecycle action are the exact model/window carried by that provider invocation. We persist one minimal active-session capacity pin so later invocations may shrink but cannot silently expand the resumed context. This is not a persistent carrier-binding cache: model/provider proof remains invocation-scoped.

## Terminal schema

```ts
interface AgentContextBinding {
  readonly model?: string;
  readonly windowTokens?: number;
  readonly source: 'service_spawn' | 'invocation_config';
}

interface InvocationCapacitySnapshot {
  readonly capacity: ResolvedContextCapacity;
  readonly capability: AgentContextCapability;
  readonly binding?: AgentContextBinding;
  readonly memberWindowTokens: number | null;
  readonly model: string | undefined;
}

interface SessionCapacityPin {
  readonly windowTokens: number;
  readonly inputCeilingTokens: number;
  readonly source: 'reported' | 'manual' | 'catalog' | 'unresolved';
  readonly provenance: string;
  readonly actionable: boolean;
}
```

`AgentContextBinding` is a pure, invocation-scoped proof. It is never stored independently. A later transition returns a new snapshot instead of mutating the old one.

## Stateful object census

1. **Concrete carrier binding** — lifecycle owner: the concrete `AgentService` or the per-invocation native-config writer. Registry/catalog readers may not synthesize an applied window.
2. **Invocation capacity snapshot** — lifecycle owner: routing creates it once; trusted provider observations or native binding proofs return a refined copy. Provider code consumes the same copy through `AgentServiceOptions.contextCapacity`.
3. **Active-session capacity pin** — lifecycle owner: `SessionChainStore`; it persists only the resolved capacity fields. Later invocations may replace it with a smaller resolved value; expansion requires session rollover. It carries no model/provider fingerprint or reusable carrier proof.
4. **Persisted context health** — lifecycle owner: `SessionChainStore`; only authoritative current-context usage may update it. Binding proof does not alter or replace usage truth.
5. **OpenCode runtime config** — lifecycle owner: `invokeSingleCat`; it is created before provider launch and removed in the existing `finally`. Instructions-only config cannot claim window enforcement.
6. **Missing-usage warning** — lifecycle owner: `OpenCodeAgentService` decides whether the warning is required; route strategies own live delivery and durable projection. The warning is derived per invocation, never stored as an independent flag. Serial and parallel routes must share one persistence operation and one failure-reporting contract.

## State × event transition table

| State | Event | Next state | Owner / required evidence | Forbidden bypass |
|---|---|---|---|---|
| Service unbound | Registry constructs ACP service | Service-bound model and optional spawn window | `AcpServiceFactory` resolves one effective model, applies it to bootstrap/context policy, and passes the resulting binding into `AcpAgentService` | Reading `config.defaultModel` again in the snapshot |
| Route start | Resolve invocation snapshot | Snapshot with concrete model; catalog remains provisional unless the service exposes an equal already-applied window | `resolveInvocationCapacitySnapshot` | Upgrading catalog from `nativeWindowControl=true` alone |
| Route start + active session | Apply capacity pin | Current resolved value may shrink the pin; a larger value is clamped to the stored session capacity | `applyActiveSessionCapacityPin` + `SessionChainStore` | Expanding a resumed session because member config/model metadata changed |
| OpenCode snapshot provisional | Full native runtime config writes the exact model/window | Snapshot refined with `invocation_config` binding and catalog may become actionable | `invokeSingleCat` after atomic config write succeeds | Treating the fallback instructions-only path as window proof |
| Codex exec-json binding planned | Build provider argv with member `cliConfigArgs` | Runtime-owned model/window controls remain authoritative; unrelated user preferences, including provider selection, keep their existing override behavior | `CodexAgentService` strips every accepted free-form spelling of binding-owned controls before argv dedup | Letting user args evict a value while still certifying that value in `invocation_config` |
| Planned resume becomes actionable only after native config | Seal the active session, rebuild the route-owned prompt with bootstrap for the just-sealed session, then launch fresh | `invokeSingleCat` + route prompt rebuilder | Reusing the old incremental prompt with `sessionId` cleared |
| OpenCode config cannot carry exact binding | Continue only with unresolved/non-actionable lifecycle state, or fail the invocation for existing mandatory config failures | No proof transition | `invokeSingleCat` | Guessing from provider family, account type, or known-model catalog |
| Bound snapshot + stored exact usage | Pre-provider lifecycle gate | Seal old session or continue | `sealBeforeInvocationIfNeeded`, before `service.invoke` | Launching the provider before a required seal completes |
| Active invocation | Trusted runtime window report | Effective capacity becomes `min(manual cap, trusted report, active-session pin)` and may shrink the pin | `applyReportedWindowToInvocationSnapshot` + `applyActiveSessionCapacityPin` | Re-reading member config or silently expanding a pinned active session |
| Invocation end | Cleanup | Binding proof is discarded; authoritative context health and the minimal capacity pin persist | Existing invocation cleanup / `SessionChainStore` | Persisting a carrier-binding cache or reusing model/provider proof on the next invocation |
| OpenCode event stream has no authoritative current-context numerator | Provider completes | Emit one user-facing `warning` before `done` | `OpenCodeAgentService`; accepted numerator is the shared current-context usage selector | Treating aggregate `inputTokens`, `outputTokens`, or `totalTokens` as lifecycle evidence |
| Serial or parallel route receives a user-facing warning | Route reaches its output persistence boundary | Warning remains live and is appended once as `system-warning` for hydration | Shared warning persistence helper after all text/no-text/error branches | Persisting only one route mode or one output shape; broadcasting the persisted copy a second time |
| Warning append fails | Persistence attempt rejects | Route continues streaming but sets `PersistenceContext.failed` and records the exact error | Shared warning persistence helper | Logging only and acknowledging the invocation as fully persisted |

## Invariants and test matrix

- **INV-1 — Concrete model identity:** `snapshot.model` equals the logical model the concrete carrier executes. Test: ACP env override changes bootstrap/session model, context policy, and snapshot catalog together.
- **INV-2 — Exact window equality:** catalog capacity is actionable only when `binding.windowTokens === capacity.windowTokens`. Test: missing or mismatched binding stays provisional.
- **INV-3 — Same-invocation proof:** generic `nativeWindowControl` and authoritative telemetry flags are insufficient without a binding proof from this service spawn/config write. Test: a capable OpenCode service without a proof stays non-actionable.
- **INV-4 — Native-auth path closure:** OpenCode's synthesized builtin OAuth account writes a native config containing the snapshot window before launch. Test: captured `OPENCODE_CONFIG` includes `limit.context` and the lifecycle snapshot becomes actionable.
- **INV-5 — Pre-provider seal ordering:** when newly actionable catalog capacity plus stored exact usage crosses the threshold, session seal/clear/finalize completes before `service.invoke`. Test: invocation call order records the seal before provider entry.
- **INV-6 — Fail closed on mismatch/failure:** config-write failure or model/window mismatch creates no binding proof and cannot enable automatic handoff. Test: writer failure aborts; mismatched proof remains non-actionable.
- **INV-7 — Pure binding projection:** no model/provider binding proof is serialized to Redis or reused by the next invocation. The separately typed capacity pin contains resolved capacity fields only. Test: snapshot functions return new objects and Redis round-trips only `SessionCapacityPin`.
- **INV-8 — Fresh-session prompt continuity:** a late native binding that seals the planned resume must rebuild the route prompt after finalize, preserving the current delta while adding the just-sealed session summary before provider launch. Test: `requestSeal → clear → finalize → rebuild → invoke`, and the provider prompt contains the prior active-session history.
- **INV-9 — Actionable usage parity:** the predicate that suppresses OpenCode's missing-usage warning is the same selector used by lifecycle context health. Test: `lastTurnInputTokens` suppresses the warning; output-only and total-only telemetry do not.
- **INV-10 — Route symmetry:** serial and parallel routes persist the same warning for text and no-text turns without a duplicate live broadcast. Test: route-level warning persistence contracts cover both strategies and output shapes.
- **INV-11 — Honest persistence result:** warning append rejection sets `PersistenceContext.failed` and records the original error in both strategies. Test: injected `messageStore.append` failure in serial and parallel routes.
- **INV-12 — Binding-owned argv precedence:** once Codex advertises an `invocation_config` binding, free-form member args cannot replace its model, context window, or derived auto-compaction limit. Test: all accepted `--config`/`-c` and `--model`/`-m` spellings are stripped while unrelated user preferences, including provider selection, remain configurable.
- **INV-13 — Trusted minimum:** Manual is an operator cap, while a trusted runtime report is a provider limit; the effective value is the smaller of the two. Model catalog guesses never clamp Manual. Test: `1M + trusted 200K → 200K`, `128K + trusted 200K → 128K`.
- **INV-14 — Session shrink-only:** later invocations on the same active session may reduce but never increase its effective capacity. A sealed/new session receives the newly resolved value. Test: `200K → 1M` stays 200K while active, `1M → 256K` shrinks, rollover permits 1M.

## Adversarial scenarios

- Environment model override differs from catalog `defaultModel` on an ACP member.
- OpenCode subscription uses its synthesized builtin OAuth account and must not rely on instructions alone for window proof.
- OpenCode runtime config writes a different window than the snapshot.
- Runtime config write throws after L0 creation but before provider launch.
- Member configuration changes concurrently after snapshot creation.
- Runtime reports a smaller exact window after a provisional catalog binding.
- Manual requests 1M while the trusted carrier reports 200K.
- Member capacity changes from 200K to 1M while the same CLI session is resumed.
- The route assembles only unseen messages for a resume, then native binding crosses the seal threshold before launch.
- A partial OpenCode `step_finish` reports only output or aggregate total tokens.
- A cat emits text and then a missing-usage warning in either serial or parallel mode.
- The assistant message persists but the following `system-warning` append fails.
- Codex member `cliConfigArgs` contains stale model/window controls from an earlier configuration while the invocation snapshot certifies a different binding.

### Task 1: Define binding proof and fail-closed resolver behavior

**Files:**
- Modify: `packages/api/src/domains/cats/services/types.ts`
- Modify: `packages/api/src/domains/cats/services/agents/invocation/invocation-capacity-snapshot.ts`
- Test: `packages/api/test/config/invocation-capacity-snapshot.test.js`

1. Add RED tests for INV-2 and INV-3.
2. Run the focused snapshot test and verify the generic-capability case fails.
3. Add the binding proof type and equality-gated snapshot projection.
4. Re-run the focused test to GREEN.

### Task 2: Bind ACP to one effective model

**Files:**
- Modify: `packages/api/src/domains/cats/services/agents/providers/acp/AcpServiceFactory.ts`
- Modify: `packages/api/src/domains/cats/services/agents/providers/acp/AcpAgentService.ts`
- Test: `packages/api/test/acp/acp-service-factory.test.js`

1. Add a RED regression with `CAT_<CATID>_MODEL` differing from `defaultModel`.
2. Assert bootstrap arguments, session model, context policy, and exposed binding agree.
3. Resolve the effective model once in factory construction and pass the applied binding to the service.
4. Re-run ACP factory/pool signature tests to GREEN.

### Task 3: Close the OpenCode subscription binding path

**Files:**
- Modify: `packages/api/src/domains/cats/services/agents/invocation/invoke-single-cat.ts`
- Test: `packages/api/test/invoke-single-cat.test.js`

1. Add a RED invocation regression for the synthesized builtin OAuth account with a resolvable provider/model and catalog capacity.
2. Assert the generated config carries the same model/window and provider entry contains `limit.context`.
3. Keep native-auth invocations on the full runtime-config branch without credential placeholders.
4. Apply the binding proof only after the config file write succeeds.
5. Run the pre-provider lifecycle gate after that transition and before `service.invoke`.
6. Re-run focused OpenCode/invocation suites to GREEN.

### Task 4: Failure-mode audit and delivery

**Files:**
- Verify all files above plus existing context-capacity, routing, ACP, OpenCode, and session-chain suites.

1. Run the focused snapshot, ACP factory, OpenCode config, and invocation tests.
2. Run the wider capacity resolver/provider/session-chain failure-mode matrix.
3. Run Biome and TypeScript build checks; inspect fallback-layer growth and `git diff --check`.
4. Commit with a Why body and run exact-HEAD full `pnpm gate --no-rebase` after confirming current `origin/main` ancestry.
5. Push normally, reply/resolve only the two exact-`f80474a80` findings, retrigger cloud review, and register the next CI/review event wait.

### Task 5: Rebuild after a late capacity seal

**Files:**
- Modify: `packages/api/src/domains/cats/services/agents/invocation/invoke-single-cat.ts`
- Modify: `packages/api/src/domains/cats/services/agents/routing/route-serial.ts`
- Modify: `packages/api/src/domains/cats/services/agents/routing/route-parallel.ts`
- Modify: `packages/api/src/domains/cats/services/session/SessionBootstrap.ts`
- Test: `packages/api/test/invoke-single-cat.test.js`

1. Add a RED assertion that a provisional OpenCode resume crossing the threshold launches with the just-sealed session summary, not only the old incremental delta.
2. Keep route prompt assembly route-owned; pass one rebuild function into the invocation boundary rather than teaching provider code how to assemble history.
3. After a successful late seal, require that rebuild function and fail closed if it is absent.
4. Reserve the documented bootstrap maximum in route history budgets so replacing an empty/stale bootstrap cannot overflow the invocation ceiling.
5. Verify serial and parallel route suites plus the exact OpenCode lifecycle order.

### Task 6: Close the missing-usage warning lifecycle

**Files:**
- Modify: `packages/api/src/domains/cats/services/types.ts`
- Modify: `packages/api/src/domains/cats/services/agents/invocation/invocation-capacity-snapshot.ts`
- Modify: `packages/api/src/domains/cats/services/agents/providers/OpenCodeAgentService.ts`
- Create: `packages/api/src/domains/cats/services/agents/routing/persist-system-info-warnings.ts`
- Modify: `packages/api/src/domains/cats/services/agents/routing/route-serial.ts`
- Modify: `packages/api/src/domains/cats/services/agents/routing/route-parallel.ts`
- Test: `packages/api/test/opencode-agent-service.test.js`
- Test: `packages/api/test/route-serial-notice-contract.test.js`
- Create: `packages/api/test/route-parallel-warning-persistence.test.js`

1. Add RED tests for output-only/total-only telemetry, serial/parallel warning hydration, and persistence failure reporting.
2. Extract the authoritative current-context usage selector so warning suppression and lifecycle health cannot drift.
3. Extract one warning persistence helper and call it after every serial/parallel output shape.
4. Verify the warning remains live, hydrates once after refresh, never double-broadcasts, and makes persistence failure observable.
5. Run focused provider/capacity/routing suites, then an exact-commit full gate before push.
