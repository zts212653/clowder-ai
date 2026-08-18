---
cell_id: ball-custody
title: Ball Custody Engine
summary: 球权与等待责任边界：BallCustodyProjection、Queue 普通 queued message、F254 closure/supplement、F167 action-successor 单账本与 hold rescue authorization，以及 F280 typed AwaitState lifecycle / owner fence / expiry / one-shot consume / canonical user-cancel termination event / immutable continuation carrier。责任对象各自持久化 origin/frontier/holder/generation/final；attention、carrier success、feedback why 与 source collection 都不裁决 action success 或 wake。
canonical_features: [F167, F233, F254, F280]
code_anchors:
  - packages/shared/src/types/action-successor.ts
  - packages/api/src/domains/ball-custody/action-successor-state-machine.ts
  - packages/api/src/domains/ball-custody/action-successor-outcome-state-machine.ts
  - packages/api/src/domains/ball-custody/action-successor-return-state-machine.ts
  - packages/api/src/domains/ball-custody/action-successor-redis-scripts.ts
  - packages/api/src/domains/ball-custody/ActionSuccessorLeaseStore.ts
  - packages/api/src/domains/ball-custody/RedisActionSuccessorLeaseStore.ts
  - packages/api/src/domains/ball-custody/ActionSuccessorAdmissionService.ts
  - packages/api/src/domains/ball-custody/reconcile-action-successor-enqueue.ts
  - packages/api/src/domains/ball-custody/ActionSubjectTruthResolver.ts
  - packages/api/src/domains/ball-custody/ActionTerminalPredicateCatalog.ts
  - packages/api/src/domains/ball-custody/ActionSuccessorCompletionService.ts
  - packages/api/src/domains/ball-custody/ActionSuccessorRecoverySweep.ts
  - packages/api/src/domains/ball-custody/ManagedCommandWakeRecoverySweep.ts
  - packages/api/src/domains/ball-custody/managed-command-wake-lifecycle.ts
  - packages/api/src/domains/ball-custody/hold-ball-access-policy.ts
  - packages/api/src/routes/callback-hold-ball-cancel-routes.ts
  - packages/api/src/domains/ball-custody/TurnCustodyProjectionService.ts
  - packages/api/src/domains/ball-custody/turn-custody-wake-provenance.ts
  - packages/api/src/domains/ball-custody/wait-state-machine.ts
  - packages/api/src/domains/ball-custody/wait-continuation-carrier.ts
  - packages/api/src/domains/ball-custody/WaitContinuationRetryPreflight.ts
  - packages/api/src/domains/github-signals/GitHubWaitLifecycleService.ts
  - packages/shared/src/types/github-wait.ts
  - packages/shared/src/types/wait-termination.ts
  - packages/api/src/domains/ball-custody/WaitTerminationStore.ts
  - packages/api/src/domains/ball-custody/RedisWaitTerminationStore.ts
  - packages/api/src/domains/ball-custody/WaitTerminationService.ts
  - packages/api/src/domains/ball-custody/wait-termination-keys.ts
  - packages/api/src/routes/wait-termination-routes.ts
  - packages/shared/src/types/ball-custody.ts
  - packages/api/src/domains/ball-custody/BallCustodyEventLog.ts
  - packages/api/src/domains/ball-custody/BallCustodyProjector.ts
  - packages/api/src/domains/ball-custody/ball-custody-state-machine.ts
  - packages/api/src/domains/ball-custody/BallCustodyProjectionStore.ts
  - packages/api/src/domains/ball-custody/ball-custody-keys.ts
  - packages/api/src/domains/ball-custody/BallCustodyIngest.ts
  - packages/api/src/domains/ball-custody/ball-custody-events.ts
  - packages/api/src/domains/cats/services/freshness/FreshnessAttentionEventLog.ts
  - packages/api/src/domains/cats/services/freshness/FreshnessInvocationStateStore.ts
  - packages/api/src/domains/cats/services/freshness/FreshnessNoticeService.ts
  - packages/api/src/domains/cats/services/freshness/FreshnessReinvokeDecider.ts
  - packages/api/src/domains/cats/services/freshness/FreshnessClosureStateMachine.ts
  - packages/api/src/domains/cats/services/freshness/FreshnessClosureStore.ts
  - packages/api/src/domains/cats/services/freshness/RedisFreshnessClosureStore.ts
  - packages/api/src/domains/cats/services/freshness/FreshnessClosureLegacyMigrationState.ts
  - packages/api/src/domains/cats/services/freshness/freshness-closure-store-types.ts
  - packages/api/src/domains/cats/services/freshness/glass-box/FreshnessOutputCommitCoordinator.ts
  - packages/api/src/domains/cats/services/freshness/glass-box/FreshnessSupplementStateMachine.ts
  - packages/api/src/domains/cats/services/freshness/glass-box/FreshnessSupplementStartupReconciler.ts
  - packages/api/src/domains/cats/services/freshness/FreshnessDraftCustody.ts
  - packages/api/src/domains/cats/services/freshness/FreshnessRelevancePolicy.ts
  - packages/api/src/domains/cats/services/freshness/checkStreamOutputFreshness.ts
  - packages/api/src/domains/cats/services/stores/ports/DeliveryCursorStore.ts
doc_anchors:
  - docs/features/F295-cancelable-execution-projection.md
  - docs/features/F167-a2a-chain-quality.md
  - feature-specs/2026-08-18-f167-hold-rescue-authorization.md
  - feature-specs/2026-07-11-f167-phase-s-action-successor-single-flight.md
  - feature-specs/2026-07-16-f167-s1-phase-t-custody-cutover.md
  - docs/features/F233-ball-custody-observability.md
  - docs/features/F254-side-effect-freshness-gate.md
  - docs/features/F280-unified-wait-contract.md
  - feature-specs/2026-08-12-1291-gate5-retry-revalidation.md
  - feature-discussions/2026-07-29-f280-unified-wait-contract/README.md
  - docs/decisions/041-freshness-catch-closure-output-commit.md
  - docs/decisions/042-glass-box-delivery-semantics.md
  - feature-specs/2026-07-12-f254-glass-box-publish-supplement.md
  - feature-specs/2026-07-13-f254-post-merge-durability-migration-eval.md
  - feature-specs/2026-07-09-f254-phase-e-catch-closure.md
  - feature-specs/2026-06-14-f233-phase-b-ball-custody-event-stream.md
  - feature-specs/2026-07-16-f177-f254-f264-child-execution-truth.md
static_scan_hints: [ActionSuccessorLease, ActionSuccessorLeaseStore, ActionSuccessorAdmissionService, ActionSubjectTruthResolver, ActionTerminalPredicateCatalog, ActionSuccessorCompletionService, terminalPredicate, completionCandidate, completionCandidates, preflightOutput, continueFreshRevision, claimOrigin, predecessorCatId, returnToPredecessor, returnDeliveryState, actionGeneration, HoldAccessRole, resolveHoldAccess, scheduleMutationAuditStore, AwaitState, WaitOwnerFence, WaitOutcomeV1, WaitContinuationCarrierV1, WaitContinuationRetryPreflight, RetryAuthorityDecision, waitContinuationCarrier, awaitGeneration, expiresAt, matchedPredicate, BallCustodyEvent, BallCustodyProjection, BallCustodyEventLog, BallCustodyIngest, ball-custody-events, buildHandedEvent, ball.dispatch_dispositioned, dispatch_handled_continuation, ball-custody-state-machine, ball-custody-projector, ballcustody:events, ballcustody:projection, blockedSinceAt, ProbeScheduler, WakeSender, FreshnessAttentionEventLog, FreshnessInvocationStateStore, FreshnessNoticeService, FreshnessReinvokeDecider, FreshnessClosureAggregate, FreshnessSupplementAggregate, FreshnessSupplementStateMachine, FreshnessClosureStore, FreshnessClosureLegacyMigrationState, MigrateLegacyFreshnessClosureInput, legacy_migrated, FreshnessOutputCommitCoordinator, FreshnessRelevancePolicy, same_user_wave_sibling_reply, coveredTriggerMessageIds, causal, triggerMessageId, freshnessClosureId, freshnessSupplementId, seenCursor]
cited_by:
  - {feature: F167-hold-rescue-authorization, date: 2026-08-18, delta: verified trigger principal, exact-thread collaborator, and configured operator become distinct hold access roles; collaborators retain rescue cancel but receive only a safe lifecycle summary, while exact task deletion and actor/owner audit commit atomically through the existing scheduler store}
  - {feature: F295, date: 2026-08-13, delta: active managed-command receipts are projected as cancelable executions without becoming a new lifecycle ledger; DELETE is fenced by exact taskId so an old hold bubble cannot cancel its replacement}
  - {feature: F280-Gate-5, date: 2026-08-12, delta: explicit retry reads the stored wait carrier for UX preflight, then atomically compares the raw Task/action-lease witness and Message custody revisions in the same commit that appends the attempt; stale witnesses and legacy unattributed agent work fail closed}
  - {feature: F280-Gate-4, date: 2026-08-12, delta: a consumed wait outcome retains its exact owner fence and publishes one immutable wait/outcome/fence carrier in the server-authored github-wait message; Queue and Invocation are projections, not new authority}
  - {feature: F167-post-disposition-continuation, date: 2026-08-11, delta: the wake-scoped stop decision preserves handled vs completed plus exact event identity; handled may expose a bounded continuation witness only when the disposition tool settled and the provider ended without post-tool progress}
  - {feature: F167-Phase-T-readiness, date: 2026-07-23, delta: first live shadow disagreements bind explicit A2A wakes to the existing thread-ball dispatch only after durable ball.handed evidence, preserve exact hold-ball identity, and retain generic or missing provenance as unknown_legacy}
  - {feature: F167-Phase-T-shadow, date: 2026-07-20, delta: a wake-selected read-only adapter projects covered_active, covered_empty, or unknown_legacy and compares the legacy text guard with turn-scoped custody without changing production blocking authority}
  - {feature: F167-Phase-T-cutover, date: 2026-07-30, delta: the wake-selected projection becomes the sole blocking authority; every new-only row receives authoritative justified/unjustified/unexplained classification while legacy comparison is observation-only}
  - {feature: F167-S.1-c, date: 2026-07-20, delta: managed-command completion and action return delivery retain TTL-0 truth until a recoverable carrier is positively acknowledged; boot and periodic sweeps retry idempotently without creating a second custody ledger}
  - {feature: F254-causal-relevance, date: 2026-07-16, delta: typed invocation-reply trigger provenance plus exact prompt coverage suppresses same-user-wave sibling replies without time windows or NLU; explicit current-cat direction and independent triggers remain relevant}
  - {feature: F167-S.1-b, date: 2026-07-16, delta: carrier exit/text no longer commits action success; a server-owned typed predicate plus machine evidence and verified verdict is required; completed review generations continue atomically on a server-observed fresh HEAD without changing the canonical action key}
  - {feature: F167-S.1-a, date: 2026-07-16, delta: structured transfer and grounded existing-standing claims share one TTL=0 CAS; each structured generation persists predecessor routing; rejected single custody returns atomically before carrier delivery confirmation, while parallel rejection terminates only that holder}
  - {feature: F167-Phase-S, date: 2026-07-11, delta: durable action successor lease becomes canonical responsibility truth for one subject/action/slot; verified replace increments generation and subject terminal truth fences stale work}
  - {feature: F233-Phase-B, date: 2026-06-15, delta: new cell (B1 event-log + projector + state-machine 骨架)}
  - {feature: F233-Phase-B, date: 2026-06-15, delta: B2 PR1 — ingest 层 (BallCustodyIngest append+apply guard) + 路由事件接线 (ball.handed / ball.void_pass)}
  - {feature: F254-Phase-A/B, date: 2026-06-28, delta: side-effect freshness gate + content-free notice uses independent seenCursor namespace and FreshnessAttentionEventLog; freshness events remain separate from BallCustodyEvent but are consumed by the same responsibility/attention boundary}
  - {feature: F254-Phase-E, date: 2026-07-09, delta: durable catch closure becomes the responsibility truth for known-stale output, exact required messages, successor custody, blocked recovery, and one committed final}
  - {feature: F254-v1.2, date: 2026-07-11, delta: replace the poison-pill single active pointer with a scope lineage set plus one running lease; add immutable origin, exact carrier membership, and typed draft custody}
  - {feature: F254-ADR-042, date: 2026-07-12, delta: completed answers become unconditional MessageStore truth; Queue remains the only owner for ordinary queued messages, while a separate persistent supplement aggregate owns bounded additive follow-up responsibility only for non-Queue unseen sources}
  - {feature: F254-post-merge-migration, date: 2026-07-13, delta: every active legacy closure remains a responsibility until every attached withheld invocation has an exact formal, recovered, no-text, or fail-closed conflict outcome; fully-accounted closures terminalize only through an explicit legacy_migrated disposition}
  - {feature: F280-Phase-A, date: 2026-07-29, delta: typed AwaitState lifecycle owns explicit predicate admission, owner generation fence, expiry, terminalization, and one-shot consume while source adapters stay in their source cells}
  - {feature: F280-Phase-B0, date: 2026-07-31, delta: owner-authenticated hold cancellation first reserves both one-shot timer and managed-command delivery boundaries, then commits canonical user_cancel termination plus the producer-owned F281 entry and content-free receipt atomically before retiring the SQLite execution projection; entered wake is non-terminal conflict, proven commit failure releases and re-arms, ambiguous storage remains fenced until startup recovery}
  - {feature: F167-F264-terminal-consumption, date: 2026-07-31, delta: Phase T exposes a bounded typed coordination-terminal silent witness to the existing Queue receipt consumer without owning message receipt lifecycle or inferring from empty model text}
---

# Ball Custody Engine

Architecture cell: ball-custody

## Canonical Owner

F233 owns the ball-custody event-sourcing infrastructure: append-only Event Log as the single internal-canonical truth for ball custody（谁该对一个责任单元行动）, BallCustodyProjection as a rebuildable projection, and the 7-state ball lifecycle (active/blocked/parked/dead/void/zombie/resolved，加 `new` 初始态) enforced by a pure-function state machine. F254 extends the same responsibility boundary in two layers: independent `seenCursor` / `FreshnessAttentionEventLog` provide attention evidence; ADR-041 `FreshnessClosureAggregate` remains canonical only for unfinished/legacy work, while ADR-042 `FreshnessSupplementAggregate` owns bounded additive follow-up responsibility after a completed answer is already MessageStore truth. `FreshnessRelevancePolicy` decides whether a late message creates responsibility from typed provenance only: a cat reply whose `causal.triggerMessageId` was already covered by this invocation's prompt is a same-user-wave sibling and does not create a supplement unless it explicitly targets the current cat. Independent triggers remain relevant. Time windows, prose classification and NLU do not participate. A blocked legacy closure remains active responsibility until every attached withheld invocation has an exact evidence-backed outcome; full accounting terminalizes through `legacy_migrated`, which is distinct from user `dismissed`. F167 Phase S adds a separate TTL=0 `ActionSuccessorLease` responsibility object keyed by tenant + canonical subject + action family + server-authorized slot. S.1-a keeps structured transfer and grounded existing standing on that same CAS: every structured generation persists its authenticated predecessor route; a single-holder ownership rejection increments generation and moves custody back atomically, while a parallel rejection terminates only the rejecting holder and leaves the shared generation in place. S.1-b freezes a server-owned typed terminal predicate in each generation: machine-checkable evidence first creates a non-terminal candidate, and only `ActionSubjectTruthResolver` verified truth can CAS a holder to succeeded. Production admission requires both a server verifier and an end-to-end completion producer; the registry opens `review/review_delivered` and task-backed `implement/task_done`. The task capability binds tenant, named owner and task thread from TaskStore before claim, then uses the same task's persisted `done` revision as completion evidence; boot/periodic recovery enumerates active task leases and replays the idempotent completion CAS without another ledger. Canonical `pr_merged` / `ci_passed` resolvers and reserved `test_passed` / `durable_verdict` shapes remain fail-closed until their production completion producers are wired, rather than opening a lease that can never complete. HEAD-fenced predicates accept only canonical full Git OIDs (40/64 lowercase hex). A delivered review coupled to an action lease commits the exact generation/holder/predicate completion before appending the community verdict event; already-verified same-fence retries remain idempotent if event append or projection previously failed. Provider exit 0, response text and Queue delivery remain carrier facts. A server-observed new review HEAD continues the same completed lease at generation+1, rebuilds claim origin/predecessor provenance from the incoming claim, clears prior candidate/outcomes, and leaves the canonical action key unchanged. `returnDeliveryState` only tracks carrier delivery and never adjudicates custody. S.1-c keeps managed-command terminal results and pending return delivery durable until a positive execution carrier exists, then uses boot/periodic recovery sweeps to retry idempotently. Phase T reads only the protocol ball selected by the invocation wake carrier, snapshots its transition truth, and enforces the three-state structured stop decision; it never creates custody or scans unrelated open work. Explicit A2A wake provenance selects the existing `ball:thread:*` dispatch only after its `ball.handed` transition is durably recorded for the target holder；exact managed-command wake provenance selects the existing hold subject。Generic or missing provenance remains `unknown_legacy` and fails closed. For `covered_empty + non_obligation:coordination_terminal`, Phase T may expose a bounded typed `terminal_silent` witness to the existing Queue receipt consumer. For an exact `ball.dispatch_dispositioned`, the stop decision also preserves the canonical `handled | completed` discriminator and event identity. `completed` is terminal-only; `handled` may expose one bounded `dispatch_handled_continuation` witness only after the disposition tool settled and the provider ended without substantive post-tool progress. The witness does not establish or complete owner work and does not reopen the settled carrier. Phase T does not own the durable receipt, parse empty model text, or turn a non-Queue invocation into message custody. The retired legacy comparison is telemetry only. Each responsibility object owns its lifecycle without entering the F233 `BallCustodyEvent` union.

F280 adds `AwaitState` as another responsibility object: the caller supplies a bounded typed any-of
continuation, the containing task or action lease supplies a generation fence, source adapters supply
truth, and only a matched predicate can CAS-consume the wait and request one compact wake. Expiry and
owner-generation change terminalize the wait without creating another custody ledger. GitHub source
fact semantics stay in `github-signals`; this cell owns the wait lifecycle, not the source collector.
Its canonical user-cancel path owns the strict `wait.terminated` event and durable replay/conflict
boundary. A transient reservation linearizes that durable transition against both timer execution and
managed-command delivery: applied cancel excludes later visible wake, while an already-entered wake
excludes a false cancel terminal. Optional human why stays outside the event and is projected through
F281's adapter.

F167 hold status/cancel authority is also owned here. F174 supplies the verified invocation or
agent-key principal but does not decide hold access; F295 consumes managed-command execution truth but
does not own this endpoint. The exact task derives one trigger-principal owner from server-written
`createdBy` plus `triggerUserId`. A verified invocation bound to that exact thread, or an agent key with
canonical thread visibility and owner/participant standing, may rescue-cancel as a
`thread_collaborator`. The configured operator must independently pass canonical ThreadStore
visibility; `createdBy === 'system'` is never a universal pass. The physical `default` thread is
logically user-isolated, so callback principals there must additionally match the exact hold's
non-empty `triggerUserId`; this fence applies equally to invocation and agent-key principals. Trigger principal and operator reads
retain the full lifecycle, while collaborator reads project only `{mode,status}`. Successful DELETE
uses the task ID as the unchanged replacement fence and commits exact actor/owner/access-role evidence
with the existing scheduler audit in the same transaction that removes the dynamic task; only then may
the runner and exact managed command be stopped.

For a consumed F280 wait, `WaitOutcomeV1` retains the exact owner fence that authorized that
generation. `GitHubWaitLifecycleService` derives one closed `WaitContinuationCarrierV1` from the
canonical task ID and outcome and persists it in the server-authored `github-wait` message source.
That carrier is immutable provenance for dispatch and `structured:event_wait`; it cannot create,
renew, complete, or retry a wait, and an action-successor owner fence inside it is not an action lease
for the child invocation.

A durable pre-Gate-4 pending outcome without a valid persisted owner fence is a terminal compatibility
liability, not an invitation to reconstruct authority. Lifecycle recovery CAS-dispositions only that
outcome as `legacy_unfenced`, publishes no connector message, and continues the task sweep. Mutable task
fields cannot supply or mint the missing fence.

Gate 5 retry authority is a read-only preflight over that immutable carrier and current canonical
owners. A containing-task wait must still match its exact task, outcome, generation, thread, user, and
holder; an action-successor wait must additionally pass the existing lease `preflightOutput` for the
same generation and holder. The route check is advisory for an early 409: the same read is repeated
inside the custody entry lock immediately before the attempt CAS, and only that mutation-boundary
decision may authorize the retry. Neither decision revives the wait, mints a lease, persists
retryability, or lets Queue state substitute for authority. Historical agent/connector messages without
attributable canonical provenance remain non-executable.

## Use This When

- 新增球权事件类型（@ 路由投递 / hold_ball 设释 / invocation 终态 / task 状态转移 / probe 判定）。
- 改球权状态转移规则或形态判定（死球 / 搁置 / 虚空 / 睡美人 / 僵尸）。
- 改 F254 freshness attention、legacy closure 或 glass-box supplement 边界：`seenCursor`、atomic prior frontier、lineage/sequence、pending/running lease、decline/failure/budget、startup recovery。
- 改 F254 late-message relevance、typed reply provenance、prompt coverage 或 same-wave sibling suppression。
- 枚举、恢复或核销既有 blocked closure，尤其是一 closure 多 withheld invocation、exact transcript proof、conflict fail-closed、no-text accounting 或 migration CAS。
- 改 F167 action successor identity、claim origin、predecessor route、holder outcome、return/safe-wait/replace、typed terminal predicate、completion candidate/verdict、fresh generation 或 external subject terminal truth。
- 改 F167 managed-command/return recovery，或 turn-scoped wake provenance、三态 stop-gate projection 与阻断判决。
- 改 F167 hold status/cancel principal、thread collaborator 救场、lifecycle 脱敏、exact task fence 或取消审计。
- 改 F280 `AwaitState` admission、owner generation、expiry、terminalization、matched predicate
  consume 或 wait outcome。
- 改 F280 canonical wait cancellation、termination replay/conflict、execution-projection recovery，
  或 owner-authenticated cancel route。
- 改 F280 wait outcome 到 connector message / Queue / Invocation 的 exact carrier 投影。
- 改 F280 wait/action-backed explicit retry 的 current-authority preflight 或 fail-closed reason。
- 值班简报 / feat 轨迹消费球权 projection。
- 接入 ProbeScheduler / WakeSender（Phase B 后续 Task：blocked task 探针 + best-effort 唤醒）。

## Extend By

- 向 shared type append 新 `BallEventKind` + 在 state-machine 显式转移表（STATIC_TABLE / DYNAMIC_TABLE）加规则；**INV-10 穷举测试同步**（全 event × state 无未定义）。
- projection 字段 effect 作为纯函数加在 `BallCustodyProjector` 的 `applyFieldEffects`。
- subjectKey 从现有痕迹派生（`ball:thread:{id}` / `ball:task:{id}`），**不引入球 ID 新原语**（KD-1）。
- 接事件源（B2）：写 `buildXxxEvent` 纯函数（`ball-custody-events.ts`，§F sourceEventId + KD-1 subjectKey + classification）→ 在现有系统动作旁路点 **fire-and-forget** 调 `BallCustodyIngest.record`（append + `appended:true` guard → `projector.apply`，照 `community-auto-tracking` 先例，rebuild 安全）。失败仅 log、不阻塞主流程；ingest 注入 `RouteStrategyDeps.ballCustody`（optional, fail-open）。
- Freshness 事件新增时保持独立 closed union（`FreshnessAttentionEvent`），不要把它塞进 `BallCustodyEvent`；需要聚合时由 projector/read-model 读取 freshness log。
- Known-stale output 必须通过 `FreshnessClosureStore` + `FreshnessClosureStateMachine` 转移责任；queue coverage 本身不是 closure，只有携带 exact closure ID 且成功 claim 的 typed successor 才接手。独立 invocation 不得按 scope 猜 closure。
- Legacy migration 必须以全部 active closure 为根集合，再逐 attached invocation 分类。只有每项都有 exact message/evidence 或审计化 no-text 归宿时，才能通过 revision-fenced `MigrateLegacyFreshnessClosureInput` 写入 `legacy_migrated` disposition；恢复 append 必须幂等且零路由副作用。
- Completed output 必须先成为 MessageStore truth。普通 queued user message 继续由 Queue exact ACK 生命周期单一拥有，禁止复制到 supplement；只有 non-Queue relevant unseen 才能通过 distinct `FreshnessSupplementAggregate` 追加责任，且不能复用 closure final key、删除原文或把 supplement 当 replacement。
- Late cat replies must carry typed `invocation_reply -> triggerMessageId` provenance. Compare that trigger only with exact message IDs already present in this invocation's prompt; explicit current-cat targets override sibling suppression, while independent causal roots remain relevant.
- Queue restart 只能用 immutable per-target invocation success witness 核销 exact `(messageId, catId, invocationId)` custody；aggregate parent `succeeded`、`targetCats` membership 或缺失 witness 都不是 handled 证据。缺失证据必须 fail-closed 回 `failed/queued`。
- 删除/隐藏任何 draft 前必须拿到 typed custody proof（message / exact closure / retained）；blocked old lineage 不得吸收独立新 draft。
- 新 freshness cursor 复用 `DeliveryCursorStore` 的 CAS 基础设施时必须使用独立 key prefix，不能推进 `deliveryCursor`。
- Action successor 必须通过 `ActionSuccessorLeaseStore` claim/recordOutcome/returnToPredecessor/replace/preflight；structured generation 的 predecessor 只能从认证 actor/source thread 派生，existing-standing 只允许 grounded self-claim。single return 必须由该 generation 持久化的 holder cat + holder thread 发起，先以 expected generation 原子移交 custody，再由 carrier 确认 delivery；parallel rejection 只 CAS 写入 rejecting holder 的 terminal outcome，不增 generation、不唤醒整租约 predecessor。同一 immutable single dispatch 重试只 replay 已完成的 transition，delivery 失败保持 pending，不得反向改成 unavailable。
- Action success 必须经 `recordCompletionCandidate` → `ActionSubjectTruthResolver.resolveCompletion` → `commitCompletionVerdict(verified)`；completion evidence 只接受机器域，`queue:` / `invocation:` / `response:` 不合法。QueueProcessor 在 output visibility 前只重验 generation，不写 succeeded；failed/canceled 仍写 runtime terminal outcome。
- Task-backed implement 只允许 `subject:task:<taskId>` + `task_done`。Admission 从 TaskStore 绑定 tenant / named owner / holder thread；task `done` transition 通过既有 completion Verdict CAS 终结 lease，recovery 只枚举同 store 的 active task leases。active lease 期间不得在普通 task 写路径改 owner/thread 或删除 task。
- Await 只能由 server-admitted typed predicate 匹配后按 generation consume。containing task
  或 action lease 提供 canonical owner；await 不复制猫名/thread holder。多个 predicate
  只允许 bounded flat any-of，同一轮多匹配仍只 wake 一次。
- Wait continuation carrier 只能从已消费 outcome 的 exact owner fence 派生，并由
  server-authored `github-wait` message 单点持久化。Queue、Invocation 与 stop-gate 只复制和核对
  `(waitId, outcomeId, ownerFence)`；畸形或分叉 projection 必须在 provider start 前失败。
- Explicit retry 必须先从 stored message 解析 carrier，再对 TaskStore / ActionSuccessorLeaseStore
  做 read-only current-authority preflight；custody mutation 必须由 ball-custody committer 在同一个
  Redis Lua 中比较 Task/action-lease raw witness、subject-terminal truth 与全部 Message custody revision，
  并追加 attempt。只有 durable winner 才能 reopen Queue；拒绝结果不能写 Queue/custody，也不能
  回退到 generic connector。
- User cancel 必须先在 Redis 原子提交 canonical termination event + producer entry +
  content-free F281 receipt/index，成功后才清理 SQLite runner projection；public body 不得提供
  owner/cat/subject/source。event 不保存 feedback why，changed feedback replay 必须冲突。
- Review delivery 与 action completion 耦合时必须先用 exact generation/holder/predicate fence 完成 lease，再 append/project community verdict；completion 非 committed 不得留下 delivered event。若 lease 已 verified succeeded 而 event append/project 失败，同 fence 重试必须幂等补齐 event。HEAD-fenced predicate 只接受 40/64 位小写完整 Git OID。
- Fresh revision 只能由服务端 truth 验证 predicate freshness 后调用 `continueFreshRevision`；generation+1、旧 fence stale、候选/outcomes 清空，HEAD 永不进入 canonical action key。
- Managed-command completion 与 action return recovery 必须复用各自 TTL=0 owner；dispatch 未获 positive carrier ack 时保持可恢复，sweep 只重放同一 idempotency key / lease generation。
- Hold status/cancel 必须先按 verified callback principal 或 configured operator 解析明确角色。Invocation 只凭 exact thread binding 获 collaborator standing；agent key 还需 canonical visibility + owner/participant；物理 `default` 对两类 callback principal 都额外要求 userId 匹配 exact hold 的非空 `triggerUserId`；operator 还需 owner identity + canonical ThreadStore visibility。协作者只读安全摘要，但保留 exact taskId 救场取消。取消成功必须先在 scheduler SQLite 事务中 exact delete + append actor/owner audit，再停 runner；audit failure 与 stale delete 都 fail closed。
- Stop-gate projection 只跟随本次 wake carrier 选出的 action lease 或 protocol subject；显式 A2A dispatch 必须先持久化当前 holder 的 `ball.handed` 再读取 thread-ball，exact hold source 读取原 hold subject。unstructured wake 直接 `covered_empty`，缺 carrier/query failure 保持 `unknown_legacy`，不得扫描猫名下其他任务补义务。

## Do NOT Unify With

- 不为球权状态加第二个 canonical store。`BallCustodyEventLog` 是唯一真相源；`BallCustodyProjectionStore` 是可重建投影（rebuild=replay，INV-2 无漂移）。
- 不把 freshness 事件并入 `BallCustodyEvent`。它是 attention/side-effect freshness 的 operational event stream，不是球权生命周期事件。
- 不按时间邻近、sender 文案、日志文本或 NLU 猜 same-wave；没有 typed causal evidence 就不能把 relevant work 静默抑制。
- 不用 MessageStore 或 InvocationRecord 复制 closure/supplement lifecycle truth：消息正文仍由 MessageStore 拥有，InvocationRecord 只保存 typed identity/status 指针。
- 不从旧 census、closure 当前 `turnInvocationId` 或 latest draft 推断完整 legacy liability；不要漏掉同一 closure 附着的其他 withheld invocation，也不要把 migration terminal 伪装成用户 dismissed。
- 不让 multi-mention、cross-post 或 InvocationQueue 复制 action successor 状态机；它们只携带 `leaseId + generation + dispatchId + predicate digest/invocation lineage` fence。
- 不让 `returnDeliveryState` 参与 claim/replace/preflight；它只是同一 lease 内供 S.1-c 重投使用的运输状态，不是第二账本。
- 不让 Phase T adapter 写 custody、用语言/NLU 猜义务，或把 S.1-c SLA 指标混成 stop-gate keep/sunset 分数。
- 不把 GitHub collector、cursor、actor policy 或 comment prose 变成 custody/wake truth；
  GitHub source semantics 归 `github-signals`，本 cell 只裁决 wait lifecycle。
- 不把 wait carrier 当作新的 owner、retry token 或 action lease，也不从 mutable task、PR subject
  或 connector 文案重建缺失 generation。
- 不把 F281 feedback reason 塞进 termination event，也不为新路径调用或扩展 legacy
  `/api/callbacks/hold-ball/*` cancel API。
- 不把 `thread.createdBy === 'system'` 当 hold 明文读取或取消的万能通行证；不让 callback cat 借同请求的 operator identity 升权；不向 collaborator 投影 command/cwd/output/wait source/resolved message 等敏感 lifecycle。
- **唤醒投递（外部副作用）绝不放 projector** —— projector 零外部副作用（rebuild 安全）；投递在 ProbeScheduler 实时 tick 路径（best-effort + per-episode cooldown，plan §E），照 `community-auto-tracking` 的「副作用不放 projector」原则。
- 不做 exactly-once 唤醒事务（KD-4 只读观测优先、不做 workflow engine；spec 只要求真实投递 + 重复可容忍可收紧）。
- 不引入球 ID 新原语（KD-1）；轨迹从现有痕迹推导。

## Static Scan Hints

Watch for new `ActionSuccessorLease`, `ActionSuccessorLeaseStore`, `ActionSuccessorAdmissionService`, `ActionSubjectTruthResolver`, `ActionTerminalPredicateCatalog`, `ActionSuccessorCompletionService`, `ActionSuccessorRecoverySweep`, `ManagedCommandWakeRecoverySweep`, `TurnCustodyProjectionService`, `TurnCustodyWakeProvenance`, `WaitOutcomeV1`, `WaitContinuationCarrierV1`, `waitContinuationCarrier`, `terminalPredicate`, `completionCandidate`, `completionCandidates`, `commitCompletionVerdict`, `preflightOutput`, `continueFreshRevision`, `claimOrigin`, `predecessorCatId`, `returnToPredecessor`, `returnDeliveryState`, `actionGeneration`, `BallCustodyEvent`, `BallCustodyProjection`, `ballcustody:events:`, `ballcustody:projection:`, `blockedSinceAt`, `ProbeScheduler`, `WakeSender`, `FreshnessAttentionEvent`, `FreshnessAttentionEventLog`, `FreshnessClosureAggregate`, `FreshnessSupplementAggregate`, `FreshnessSupplementStateMachine`, `FreshnessClosureStore`, `FreshnessClosureLegacyMigrationState`, `MigrateLegacyFreshnessClosureInput`, `legacy_migrated`, `FreshnessOutputCommitCoordinator`, `FreshnessDraftCustody`, `FreshnessRelevancePolicy`, `same_user_wave_sibling_reply`, `coveredTriggerMessageIds`, `causal.triggerMessageId`, `originTriggerMessageId`, `turnInvocationId`, `freshnessClosureId`, `freshnessSupplementId`, `seenCursor`, or `ball-custody` projector / state-machine code.
