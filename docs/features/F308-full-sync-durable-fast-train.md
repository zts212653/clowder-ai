---
feature_ids: [F308]
related_features: [F116, F153, F251]
topics: [outbound-sync, release-train, receipts, recovery, ci, test-sharding, provenance]
doc_kind: spec
created: 2026-08-27
description: "把 source repository→开源 target 全量同步从一次性长脚本升级为绑定 exact cut 的持久 receipt、可恢复单飞 gate 与不减覆盖的 public-test 分片。"
description_source: human
description_author: codex-terra
description_updated_at: 2026-08-27T00:00:00-07:00
tips_exempt: "Renewed 2026-09-19 for the public-test resource-scope correction: the change replaces lexical test classification with a runtime CI isolation guard and adds no Hub-discoverable user action; operator evidence remains CI output rather than a capability-tip surface."
---

# F308: Full-Sync Durable Fast Train — Exact Cut、可恢复 Gate 与 CI Critical Path

> **Status**: in-progress | **Owner**: 小团团·Maine Coon (@codex-terra, GPT-5.6 Terra) | **Priority**: P0 safety / P1 throughput

Architecture cell: `action-plane`

Map delta: `completed` — `action-plane` 已在 `origin/main@1bdc830a9` 登记 F308 owner、doc/code anchors 与
receipt / lease / sole-writer boundary。

Why: `scripts/sync-to-opensource.sh` 已经拥有冻结 source、F251 reconciliation、临时 target
public gate 与 target-owned restore 的安全骨架，但它仍是一次性 shell 运行。它无法把同一 exact
cut 的 terminal 结果作为 durable truth 消费，也无法在重启、carrier 丢失、共享 gate 排队或 public
head 漂移后正确恢复。F308 只扩展既有外部动作的 audit / dry-run / idempotency / durable receipt
边界；不会新造第二条同步、第二份 F251 ledger 或绕过既有 public write gate。

## Why

2026-08-27 的完整同步闭环最终安全完成，但约耗时 28 小时。已核验基线为：public landed
`1700bf30…61e0`、source closure `8660f89c…5ee6`；F251 为 `614 pass / 0 block / 0 override`，35
条 reconciliation 全闭环，随后 6 个社区 PR / 79 files 已被 intake 或 absorbed，16 条 target-owned
item 仍保留，`.env` 元数据未变。

这不是“再跑快一点”的问题。已复现的浪费来自 moving main 令 full gate 重跑、隔离 worktree
dependency/link 未就绪造成晚期假红、共享 gate 排队、runtime/callback 中断后没有可消费终态，以及
community intake 与冻结 cut 的边界不清。现有 `test:public` 的 serial resolver 选中约 1830 files，
单项耗时约 23m55s（CI Test (Public) 约 25m20s；全 CI 约 25m24s）；安装约 10 秒、build 约 3 分钟、
lint 约 4 分钟，不是关键路径主因。

F308 的终态是：维护者一次启动或恢复一个冻结 cut，就能看到它的坐标、每段仍有效的证据、已发生的
失效和唯一下一动作；任何缺少 exact provenance 的“缓存命中”都不能跳过 required gate。

## Current Boundary

| 事实 | 当前真相 | F308 的处理 |
|---|---|---|
| outbound writer | `scripts/sync-to-opensource.sh` 是唯一 export、F251、temp target gate 与 real target write 入口 | 继续由该脚本写入；F308 不另造 rsync writer |
| community preservation | F251、reconciliation ledger、target-owned backup/restore | 所有 receipt 和 resume 都重新证明这三项；不得用 cache 越过 |
| public CI workflow | 开源 target 的 `.github/workflows/ci.yml` 是 `sync-manifest.yaml` target-owned | 以独立 target-repo PR 维护；export 不覆盖它 |
| public-test safety | `packages/api/scripts/run-public-tests.sh` 明确 `--test-concurrency=1` | 只把具备真实跨 VM 共享资源证据的文件留在 shared serial；其余 target-CI 测试在仅保留 loopback 的 Linux network namespace 与 runtime guard 双重约束下进入统一可分发池，绝不全局升 concurrency |

## User Journey — Operator

**Scope unit:** 一个 immutable `FullSyncCut`，从 source / public / reconciliation 坐标锁定到可消费的
terminal receipt。

1. operator 运行单一 `launch`，CLI 在任何 install/build/full gate 前完成 remote heads、cleanliness、
worktree registration、dependency/link、manifest/artifact/hash、reconciliation coverage 和 target metadata
检查；首个 hard failure 带 typed next action 终止。
2. 通过 preflight 后，CLI 显示 immutable cut fingerprint、候选 tree hash、F251 / ledger 结果和
`no_write` disposition。source、public 或 reconciliation 任一 drift 都会明确标为不同 invalidation。
3. 只有 environment readiness 已绿，才可取得该 cut + gate 的 single-flight lease 并开始昂贵 full gate；
同一 cut 的第二个 launch 看见 queue / running / terminal 状态而非并行重跑。
4. runtime、credential 或 carrier 中断后，operator 运行同一 `resume`。它先读 durable receipt，若 stage
已经 terminal 就消费它；只有仍合法且未 terminal 的下一 stage 才执行。command terminal、review verdict、
merge truth 和 public-write disposition 从不互相冒充。
5. 冻结后新社区 intake 或新的 source delta 进入下一车；已 public-landed 的 intake/absorbed 内容必须由
ledger + F251 evidence 证明保留。开发 / dogfood 永远走 no-write lane。
6. `status` 汇总 cut、receipt hit、失效原因、stage run/wait、CPU/RSS、queue wait、shard critical path 与
runner minutes；它不把 GitHub queue、人类 review 或外部 intake 等待伪装成 CI 加速。

## Requirements Checklist

| ID | Requirement | Acceptance criteria | Status |
|---|---|---|---|
| R1 | exact cut + terminal receipts | AC-A1–A5 | [x] |
| R2 | DAG early failure + typed next action | AC-B1–B2 | [x] |
| R3 | admission / single-flight / restart recovery | AC-B3–B5 | [x] |
| R4 | F251, ledger and community preservation remain fail-closed | AC-C1–C4 | [x] |
| R5 | deterministic 4–6 distributable public-test shards plus one explicit shared-resource lane, without coverage loss | AC-D1–D6 | [ ] |
| R6 | launch/resume/status observability and real no-write dogfood | AC-A1, AC-B3–B5, AC-E1 | [x] |

## Acceptance Criteria

### Phase A — Exact-cut durable train

- [x] **AC-A1**: Each preflight, validate and write stage records an atomic machine-readable terminal receipt with
  input tuple, executable/tool blobs, output tree/hash, elapsed time, terminal disposition and exactly one first hard
  failure when non-green.
- [x] **AC-A2**: Receipt reuse requires exact `sourceSha`, `publicHead`, `baseline`, reconciliation SHA, manifest,
  exporter, F251 and wrapper blobs, executable fingerprint and output tree/hash; partial matches fail closed.
- [x] **AC-A3**: Source, public and reconciliation drift produce distinct invalidation receipts and no stale result is
  consumed as green.
- [x] **AC-A4**: Command terminal, review verdict, merge truth and public-write disposition use distinct kinds and
  cannot satisfy one another's preconditions.
- [x] **AC-A5**: Receipt storage survives process restart / lost callback and has no TTL or hidden in-memory authority.

### Phase B — Safe orchestration

- [x] **AC-B1**: The dependency DAG runs heads, clean tree, worktree registration, dependency/link readiness,
  artifact/hash, reconciliation coverage and target metadata ahead of expensive install/build/full gate.
- [x] **AC-B2**: A stage reports only its first hard failure and a typed next action; later stages never run after a
  hard predecessor failure.
- [x] **AC-B3**: Gate admission occurs only after readiness; same cut + gate permits one in-flight holder and exposes
  queue, holder, wait and invalidation state.
- [x] **AC-B4**: CPU/RSS pressure uses host-relative capacity and measured contention; it contains no 128 GiB absolute
  threshold.
- [x] **AC-B5**: Restart / credential replacement / lost carrier consumes existing terminal receipts before considering
  new execution; a restart test proves no duplicate full source gate.

### Phase C — Preservation and no-write proof

- [x] **AC-C1**: A frozen cut proves F251 reconciliation coverage, target-owned restore, ledger/inbound intake status
  and no-write disposition before real public mutation is eligible.
- [x] **AC-C2**: New community intake after the cutoff is classified for the next train; public-landed absorbed content
  remains preserved by ledger + F251 evidence.
- [x] **AC-C3**: `launch --no-write` / dogfood never mutates the real target, including its git index, worktree files,
  target-owned paths and `.env` metadata.
- [x] **AC-C4**: No manual bypass, weak cache key, broad force mode or hidden real-write fallback is introduced.

### Phase D — Public CI critical path

- [x] **AC-D1**: Resolver emits deterministic selected-file manifest, per-file timing, failure category and stable
  mapping fingerprint.
- [x] **AC-D2**: A planner produces 4–6 deterministic distributable shards plus one explicit shared-resource lane;
  current CI uses six count-balanced distributable shards because it has no measured timing artifact. Every selected
  test appears exactly once, no excluded test is silently reintroduced, and shard mapping is reproducible from the
  manifest. Duration balancing remains an operator-side replay capability, not a claim about the CI-produced plan.
- [x] **AC-D3**: Only tests with explicit evidence for a real cross-VM remote endpoint, shared account or shared quota
  remain in one globally serial lane. Every other file runs in one count-balanced distributable pool across isolated
  GitHub VMs; each file still receives a fresh Node process and every VM remains file-serial with
  `--test-concurrency=1`. Each target-CI distributable command enters a new Linux network namespace with only
  loopback enabled, then drops root before running tests; the kernel therefore rejects unknown Node/native/shell IP
  egress without a lexical classifier. The bounded preload guard adds earlier typed failures for recognized `fetch`,
  WebSocket, HTTP(S), TCP/TLS and child-process paths, including non-loopback Bash `/dev/tcp` and `/dev/udp`
  redirections. An exact temporary executable can run only when the test explicitly declares it as a local command
  fixture. Duration balancing exists as an operator-side replay tool but current CI does not supply a measured timing
  artifact.
- [x] **AC-D4**: CI shares install/build artifacts only when lockfile, toolchain and workspace inputs match; required
  checks remain required on Linux, Windows, macOS and public contract surfaces.
- [x] **AC-D5**: PR/main duplicate reuse is accepted only with exact tested-tree provenance, never by branch name or
  superficially similar source SHA.
- [ ] **AC-D6**: Three same-selection target-CI artifacts report p50/p95, critical path and coverage count. The
  original CI p50 ≤10m / p95 ≤12m goal is not yet credible: exact source-runner evidence
  (`docs/ops/2026-08-27-f308-public-test-source-measurements.json`) measured p50 14m18s / p95 14m25s with the
  serial lane dominant. The resource-scope split makes the original target measurable again but does not complete it:
  source-runner evidence and single target runs never substitute for the required three target-CI artifacts. The
  exact target run `35439924398` measured a 319,657ms nine-lane test critical path. Replaying that run's 2,189
  per-file timings through the same deterministic count balancer yields a 396,477ms six-lane projection; adding the
  run's observed 122,343ms slowest-job setup/build overhead projects 518,820ms (8m38.820s). This is design evidence,
  not target-CI completion evidence; the six-lane target must still run, and a future timing-artifact design must
  preserve selection and provenance fail-closed behavior.

### Phase E — Dogfood, review and close

- [x] **AC-E1**: A real frozen cut completes no-write dogfood, including one forced interruption then `resume` from a
  terminal receipt without rerunning the completed gate.
- [ ] **AC-E2**: Prepared-cut operator critical path, excluding human review/external intake/GitHub queue, is ≤90m and
  records no duplicate full source gate.
- [x] **AC-E3**: Exact-HEAD non-author review and risk-matched merge gate cover shell/receipt safety, durable state,
  target preservation and CI mapping.
- [ ] **AC-E4**: Final report includes PR/landed SHA, timing comparison, receipt recovery proof, community preservation
  evidence, safety-contract delta and residual risks.

## Explicit Non-goals / Forbidden Paths

- No development-time real public write, `--skip-*` promotion, cache-bypass flag, global `--test-concurrency` raise,
  runtime ports 3003/3004, or widening of `--force-overwrite` semantics.
- No replacement sync writer, duplicate reconciliation ledger, second F251 policy, duplicated CI workflow ownership or
  unreviewed target-owned workflow overwrite.
- No claim that external queue, human review or intake wait is test/gate execution performance.
- No silent exclusion of Linux, Windows, macOS, public tests or contract checks to manufacture a shorter number.

## Risks

| Risk | Guard |
|---|---|
| receipt becomes an unsafe cache | tuple + executable + output fingerprint are all mandatory; invalidation is durable and fail-closed |
| restart conflates different terminals | distinct receipt kinds and transition validation; restart tests cover each boundary |
| target CI change gets overwritten later | keep workflow target-owned and require its own Clowder PR / F251 preservation proof |
| shared scope leaks across distributable shards | explicit shared-resource rules are globally serial; every target-CI distributable command runs unprivileged inside a loopback-only Linux network namespace, so unknown Node/native/shell IP egress has no route; the bounded preload guard adds earlier typed failures for recognized paths and requires exact temporary-path declarations for local executable fixtures; shard jobs have read-only repository permission, local-only Git transport, no persisted checkout credentials and no service credentials |
| fast number loses coverage | exact-once manifest guard, selected count, exclusion registry validation and three-run report |
| host variance yields false pressure decision | record host capacity and use ratios rather than a fixed-memory threshold |

## Implementation Evidence

- Durable no-write dogfood used a frozen local cut, produced a terminal receipt, then killed its launcher after the
  terminal write. `resume` consumed the existing receipt without changing its stage log; no target worktree, index,
  target-owned file or `.env` metadata changed.
- The frozen wrapper digest now covers its whole runtime closure (facade, orchestration, stage worker, receipt
  schema/store, lease and export-tree helper), not only top-level scripts. A fixture that changes the receipt-store
  helper after the frozen source SHA fails at `frozen_executor` before command execution.
- Three source-runner shard summaries cover the same 1,834 selected files exactly once, with matching lockfile,
  toolchain and workspace provenance. They measure p50 14m18s / p95 14m25s; the four pure lanes are balanced, while
  the 884-file serial lane dominates. Full machine-readable evidence is
  `docs/ops/2026-08-27-f308-public-test-source-measurements.json`.
- The target-owned CI patch landed in `clowder-ai` PR #1413 at merge
  `71a9b707847f7ed2cd43a3de42e4ca40ec7520e3`. Exact-head target CI preserved the required `Test (Public)` check,
  Windows and public-contract surfaces; its serial bootstrap passed in 19m36s and the fail-closed aggregate passed.
  The workflow now requires exact-plan/report summary provenance for one explicit shared-resource lane and six
  guarded distributable shards. The distributable workflow additionally enters a loopback-only Linux network
  namespace and drops root before test execution. Every selected file must appear exactly once, and the evidence job
  fails above a 600,000ms critical path. Three same-selection target-CI artifacts are still required by AC-D6.

## Key Decisions

| ID | Decision | Reason |
|---|---|---|
| KD-1 | F308 is separate from F116/F251 | Existing F116/F251 scope is export/preservation; durable cross-run orchestration and CI critical-path ownership are new state contracts. |
| KD-2 | Receipts live in a durable local operator-state root, not in Git or target tree | They survive runtime/carrier restart without polluting exported/public content; their path is explicit in every receipt. |
| KD-3 | `sync-to-opensource.sh` remains the only writer | Receipt orchestration wraps and proves the existing writer instead of creating a second rsync path. |
| KD-4 | Clowder `ci.yml` stays target-owned | It must be changed by a dedicated target-repo PR, not smuggled through source export. |
| KD-5 | Sharding follows resource scope, not a blanket “stateful” label | The shared-keyspace incident proves unisolated shared Redis keys are unsafe; it does not prove that runner-local ports, temp files, processes or names must share one global queue. |
