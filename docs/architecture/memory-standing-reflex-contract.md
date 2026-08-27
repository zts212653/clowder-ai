---
doc_kind: architecture
description: "Wave 1 Standing Reflex Contract v1.1：在既有 WriteOpportunity 状态机上补充所有持久写入面的四拍闭环声明（感知、提案、裁决、消费）；允许 none/exempt/sunset，但不允许答案缺席，并保持统一协议、不统一权力与存储。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-08-26T06:00:00Z
feature_ids: []
related_features: [F102, F152, F221, F231, F237, F255, F276, F282, F287, F296]
related_docs:
  - docs/architecture/standing-reflex-episode-replay-shadow.md
  - docs/architecture/memory-write-lane-census.md
  - docs/architecture/context-injection-reflex-source-map.md
  - docs/architecture/memory-outcome-attribution-source-map.md
  - feature-specs/2026-08-15-memory-system-research-first-roadmap.md
  - feature-discussions/2026-08-10-memory-write-trigger-rethink.md
topics: [memory, standing-reflex, write-opportunity, write-surface, contract, disposition, governance]
created: 2026-08-15
status: frozen-v1.1
---

# Memory Standing Reflex Contract v1.1

> **冻结对象**：为什么、何时把一次“是否写入记忆”的判断机会送给哪位 consumer，以及
> consumer 如何留下 terminal disposition。本文冻结逻辑合同与权力边界，**不冻结中央 registry、
> 表结构、API 或 detector 实现**。

## 1. 合同回答什么

Standing reflex 不是 prompt 文案，也不是“检测到了就自动写”。它是一条有 owner 的管道：

```text
mechanical observation
  → admitted reflex entry
  → typed WriteOpportunity
  → F296 presentation（只管本 epoch 怎么呈现）
  → cat disposition: propose | defer | abstain
  → exactly one destination-lane proposal contract
  → lane-owned adjudication
  → canonical materialization
  → consumer / correction / forget / outcome evidence
```

三个权力边界不可合并：

| 角色 | 可以决定 | 不可以决定 |
|---|---|---|
| detector / producer | 某个可机械观察事实发生；附 source coordinate | 这件事重要、真实、值得记忆 |
| Standing Reflex entry | 该事实是否有资格形成一次判断机会；预算与生命周期 | 直接 materialize canonical truth |
| destination lane | proposal 的 schema、审批、替换、纠错、遗忘 | 借 reflex 绕过 owner adjudication |

RecallOpportunity 与 WriteOpportunity 复用 scope、budget、dedupe、expiry、source coordinate
等不变量，但 catalog 不合并：前者终点是 cue/drill，后者终点是 disposition/proposal。

## 2. F237 字段覆盖审计

main 上 46 个 `assets/prompt-hooks/*/hook.yaml` 实际字段全集为：
`id/name/stage/order/version/enabled/template/resolver/inputs/disableable/safetyTier/
transparencyTier/governanceTier/userExplanation`。46 项均有除 `resolver` 外的 13 个字段，39 项有
resolver。

| Standing Reflex 需要回答 | F237 hook.yaml | Wave 1 处置 |
|---|---|---|
| stable id、version、assembly stage、resolver inputs、enable/safety/governance | 已覆盖 | 复用既有 manifest 形态 |
| owner cell、consumer、eligible destination lanes | 缺 | reflex entry 必填 |
| source coordinate kinds、mechanical predicate revision、epistemic ceiling | 缺 | reflex entry 必填 |
| typed disposition、immediate/deferred terminal | 缺 | reflex entry 必填 |
| token budget、dedupe、expiry、re-arm | 缺 | reflex entry 必填 |
| ACL/privacy、invalidator、health/burden、sunset owner | 缺 | reflex entry 必填 |

**拓扑判词**：F237 是可复用的 owner-near manifest + generated read-only catalog 先例，不是全局
Standing Reflex registry 的现成实现。identity/history/control hooks 不承担 opportunity 权力；只对
reflex candidate 建 per-lane entry，再生成统一只读视图。禁止为了“统一”扩充全部 46 个 hook，
也禁止另造一个可写中央真相库。

## 3. `StandingReflexEntryV1`

下表是逻辑字段；实现可以是 lane-owned manifest、typed config 或由现有 feature contract 编译出的
只读条目，只要 generated catalog 能无损投影这些字段。

| 组 | 必填字段 | 不变量 |
|---|---|---|
| identity | `reflexId`, `version`, `ownerCell`, `consumer`, `eligibleDestinationLanes` | ID/版本稳定；一条 entry 不能隐式跨 lane |
| observation | `producer`, `predicateRef`, `predicateRevision`, `sourceCoordinateKinds`, `epistemicCeiling` | ceiling 最高为 mechanical observation；不得声称 intent/importance/truth |
| judgment | `opportunityType=write`, `allowedDispositions`, `destinationProposalContractsByLane` | dispositions 固定为 `propose/defer/abstain`；每个 eligible lane 显式映射唯一 proposal contract |
| routing | `immediateTargetByLane`, `deferredReceiptContract` | 一次 propose 只选一个 lane；该 lane 的 immediate/deferred 最终进入同一 proposal contract；defer 不建第二 truth |
| presentation | `eligibleSurfaces`, `presentationPolicyRef`, `tokenBudget`, `dedupeKey`, `expiry`, `rearmPredicate` | surface 只影响送达；F296 不接管 entry 是否存在 |
| governance | `ownerScope`, `aclPolicy`, `privacyPolicy`, `invalidators`, `sunsetOwner` | correction/forget/scope revoke 可使未决机会失效 |
| observability | `healthSignals`, `burdenSignals`, `utilityDecisionRef` | delivery health、owner burden、utility 分开；未选机制不要求补齐 |

### 3.1 Source coordinate

`sourceCoordinateKinds` 必须由 destination lane 能重新读取或明确拒绝，至少包含：

- message：`threadId + sourceMessageId + author identity + author role`；
- transcript/ASR：artifact ID + segment/time range + speaker attribution ceiling；
- document：canonical path + revision + passage/anchor；
- event：typed event ID + producer revision；
- aggregate observation：window ID + bounded member refs，不复制 owner payload。

原文 payload 留在 source owner；deferred receipt 只保存 source ref、entry/version、eligibleAt、expiry、
dedupe key 与 terminal state。频率只能提高“值得判断”的优先级，不能提高 truth authority。

### 3.2 全写入面四拍闭环声明

`StandingReflexEntryV1` 只描述真正拥有主动判断机会的 entry；它不能代表全部持久写入面。凡是能让未来
猫的判断、行为或 owner-visible truth 发生变化的 durable surface——包括 MCP/API lane、文件习俗、
Skill、ADR、Lessons Learned、feedback/episode 产物——都必须另有一份
`MemoryWriteSurfaceClosureV1` 逻辑声明，回答同样四拍：

| 拍 | 必答字段 | 合法答案与硬边界 |
|---|---|---|
| ① 感知 | `observationSource`、`eligibilityPredicate`、`sourceCoordinateKinds` | 可以是机械 detector、猫的收尾 convention 或 `none`；`none` 表示无主动入口，不得伪装成健康 |
| ② 提案 | `candidateContract`、`proposalEntry`、`allowedDispositions` | 可以 direct-edit、typed proposal、`exempt` 或 `sunset`；direct-edit 仍须声明来源与 authority，不能靠“文件一直这样写”免答 |
| ③ 裁决 | `adjudicator`、`adjudicationSurface`、`materializationTarget` | operator、猫本人、reviewer、确定性 guard、机械规则均可；不是所有 lane 都进 Approval Hub，但每条必须只有一个 canonical truth owner |
| ④ 消费 | `consumers`、`readEntry`、`usageEvidence`、`correctionAndForgetPath` | reader 存在不等于消费发生；`none` 是 keep/sunset 信号，未知必须写 `unknown`，禁止拿零条解释为零伤害 |

闭环声明还必须给出 `lifecycleStatus=active|exempt|sunset_candidate|sunset`、owner、revision 与
invalidators。它是 lane-owned contract 的 generated read-only 投影，**不是新的中央可写 registry**。
一面多 owner 合法；同一 claim family 只能有一个 authority。协议归一允许实现分诊：Diary 可由作者
自治，机械 Entity 可由规则裁决，规范性 LL 可要求更强 review，global distillation 可直接 sunset。

四拍与完整生命周期的关系是：四拍保证“从哪出生、谁签字、谁使用”不缺席；现有 entry 状态机继续
保证 delivery/disposition/dedupe/expiry；Derived View Contract 继续保证派生物不夺权。四拍不是用来
把七条 lane 补成一样，也不授权给没有 consumer 的 surface 新建 detector。

### 3.3 Surface selection

| Surface | 合法条件 | 反例 |
|---|---|---|
| native L0 / ADR-038 staging | 所有相关 invocation 都适用的家规或宪法级行为 | ASR、会议、特定人物材料等场景 detector |
| dynamic context | scene predicate 已命中且 entry 仍 eligible | 为实现方便而每轮常驻 |
| pointer / deferred queue | 正文无需立即出现，且 source 可重新 drill | 复制敏感正文到 receipt |

## 4. 状态机

```text
observed
  ├─ admission rejected ───────────────→ not_eligible
  └─ eligible
       ├─ expired / invalidated ───────→ suppressed
       └─ delivered
            ├─ propose ────────────────→ proposal_ref (terminal for opportunity)
            ├─ defer ──────────────────→ receipt_ref (terminal for this delivery)
            └─ abstain ────────────────→ abstention_ref (terminal)
```

硬不变量：

1. `delivered` 不是判断完成；必须有 typed disposition，或以 expiry/error 结束。
2. `propose` 必须携带一个 `selectedDestinationLane`，且只创建该 lane 的 proposal，不批准它；同一
   observation 若要进入另一 lane，必须形成另一份可独立裁决的 proposal，不得一次隐式多写。
3. `defer` 是本次 delivery 的 terminal disposition；后续再判断形成新 opportunity generation，
   但沿用相同 source coordinate/dedupe lineage。
4. `abstain` 不留 owner payload，只留 bounded telemetry；它不是失败。
5. invalidator 命中后，旧 generation 不得因 carrier resume/compaction 再送。

## 5. Admission、预算与重发

同一条 observation 进入 entry 前依次检查：

1. scope/ACL 是否允许当前 consumer 看见“有这个机会”；
2. predicate revision 是否仍是 entry 声明的版本；
3. `dedupeKey(subject + sourceRevision + entryVersion)` 是否已有 terminal disposition；
4. expiry/re-arm 是否允许新 generation；
5. token/burden budget 是否有额度；
6. F296 是否能在当前 carrier/epoch 诚实呈现；unsupported 必须成为显式 omission，不能用 heuristic
   冒充 authoritative delivery。

Compaction、resume、`-p`/interactive/bg-cron 只改变 presentation evidence，不自动 re-arm entry。

## 6. 机制选择按 claim，不按 entry 补清单

| Claim | 机制 | 何时需要 |
|---|---|---|
| schema、状态转移、author/scope 校验、去重/失效是确定契约 | test / schema / guard | 实现该 entry 时必守 |
| delivery latency、error、expiry、carrier omission 是运行健康 | logs / metrics / traces | 上线与 dogfood |
| entry 是否减少漏记、是否值得打扰 owner | eval | 明确 consumer 与 keep/tune/sunset 决策后 |
| 猫如何识别某类机会 | convention / skill | 低成本试错或教猫行为 |

未选择的机制不是欠账。`proposal approved` 不能同时冒充 delivery health、判断质量和 utility。

四拍 episode、source-only deterministic replay、content-free shadow health 以及 Taste/Profile E0 的
canonical 细化见 [Standing Reflex Episode / Replay / Shadow 基座](standing-reflex-episode-replay-shadow.md)。
该基座只做 refs-only adapter/projection；不改变本文冻结的 detector、lane authority 与 storage 边界。

## 7. 现有写入面的迁移判读

| Lane | 当前合同资产 | 进入本合同前的真实缺口 |
|---|---|---|
| Person / F276 | dual path、owner evidence gate、proposal/receipt/cue | 把 scene observation 变成 admitted entry；消费样本与 burden 仍少 |
| Taste / F221 | canonical approve→write→index→read 链已存在 | speaker/quote author 机械校验；organic trigger 与 consumption quality |
| Profile / F231 | canonical data root、L0 logical URI、authenticated reader 已存在 | standing trigger 再次蒸发；不能只修 storage |
| Event / F227 | typed store 与 timeline read 面 | validation/consumption health 未量化 |
| Entity / F260 | nudge/revision/cue 先例 | 无需为合同完整度重做健康 lane |
| Operational knowledge：LL / Decision / Method | scanner/search/F287 与 Skill/ADR 读取都是真 consumer | 最老的 direct-edit、F102 marker、F152 distillation 三套出生法未归一；先分 authority，再迁协议 |
| Global distillation / F152 | `distillation_candidates=0`、无已证明 consumer | 先做 keep-or-sunset 价值决策；不得再用它代表全部 Knowledge |
| Feedback / Episode / Reflection | 多个生产者与检索入口存在 | 不得因 scanner 统一映射为 `lesson` 就自动获得规范性 LL authority |
| Diary / F255 | present loop + indexed first-person outputs | AC-C2 proposal 通道独立推进；第一人称 diary 不强塞 owner approval |

## 8. Contract Trial Ready gate

一根纵切只有同时满足以下条件才可作为首案：

- 所属 durable write surface 已有四拍闭环声明；答案可以是 `none/exempt/sunset`，不能缺席；
- entry 的上表字段可完整实例化；
- 每个 eligible lane 的 immediate/deferred 都指向该 lane 同一 canonical destination proposal；
- deferred receipt 有明确的重新入场谓词、expiry/re-arm 与 lineage；首案必须实测 receipt 在后续
  eligible context 中重新进入判断，并仍落到同一 destination proposal，不能让 defer 成为合规蒸发通道；
- positive、reject/not-now、abstain/absence、correct/forget 至少各有可裁决路径；
- F296 对所选 carrier 的 delivery evidence 不是 heuristic authority；
- outcome 只声称当前可观测 ceiling，不预支单 anchor 因果归因；
- 不为首案新造 lane 专属真相源。

---
*Frozen v1.1 · v1 小太阳·Maine Coon/gpt-5.6-sol · 四拍增补 2026-08-26*
