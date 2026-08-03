---
feature_ids: [F275]
related_features: [F160, F167, F192, F233, F246, F267]
topics: [managed-work, work-admission, identity, sop, task-outcome, provenance]
doc_kind: spec
created: 2026-07-25
updated: 2026-08-02
community_issue: "clowder-ai#1213"
tips_exempt: "Internal work-identity and provenance contract; workId is deliberately absent from user-facing surfaces"
user_journey_exempt: "Internal execution identity substrate; TaskItem remains the only optional user-visible work projection"
description: "SOP 受理时铸造的内部工作身份，贯穿执行、产物与 outcome provenance，同时保持闲聊和开放探索不进入任务分母。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-07-26T23:35:00Z
---

# F275: Managed Work Admission Identity — 受理工作身份契约

> **Status**: in-progress / Phase B landed on main; runtime dormant; Phase C deferred | **Owner**: 小太阳·Maine Coon (@codex-sol, GPT-5.6 Sol，kickoff / architecture contract) | **Priority**: P1
>
> **Source**: [clowder-ai#1213](https://github.com/zts212653/clowder-ai/issues/1213)
>
> **operator signoff**: kickoff `0001785016546254-000128-a24e15f3`; slim identity-kernel implementation `0001785589044166-000630-cc9fec30` — internal `workId/attemptId` plus explicit attribution only, with zero new user/cat steps and no new SOP, workflow, automatic TaskItem, or management surface.

## Architecture Ownership

Architecture cell: managed-work
Architecture status: accepted by ADR-044；Phase B identity propagation 已落地，Phase C 仍 deferred。
Map delta: new cell added
Why: 现有 `harness-eval` 只消费业务真相，`approval-index` 只拥有审批投影，`ball-custody` 只拥有谁该行动；没有现存 cell 拥有“哪件长程工作已被受理，以及后续 invocation/PR/Episode 绑定到哪个 work/attempt”的 canonical identity。Phase A 只命名 whole-work terminal 的未来 owner，不提前建设 terminal engine。

## Why

家里已经能记录消息、thread、毛线球、invocation、PR 和 outcome 事件，却不能证明它们属于同一件工作。同一 thread 同时有任务 A 与 B 时，任务 A 的 cancel 和任务 B 的 merge 会被“最新 in-progress Episode”拼成一个故事；真实事件因此生成了错误分母。

我们只需要管理**长程、目标明确、预期有交付物并进入 SOP 执行的工作**。闲聊与开放探索没有交付机会，不应为了测量而自动变成任务。F275 的价值不是让所有消息带 `taskId`，而是在权威受理那一刻铸造一个内部身份，让后续执行与证据不再靠 thread/时间邻近猜归属。

## Current State / main 落地基线

- `WorkflowSop` 仍是协作公告板；符合 closed `workflow_sop_v1` predicate 的 first-create 会在同一 Redis script 中原子铸造 `WorkAdmission`、`workId` 与未绑定 executor 的 attempt 1。
- `TaskItem(kind='work')` 仍是可选用户投影；live `TaskItem(kind='pr_tracking')` 只作为 artifact anchor，private bind-once `{workId, attemptId}` 由 TaskStore server-only metadata 持有，legacy `PrTrackingEntry` 只负责启动 backfill。
- authenticated admitted invocation 才能一次性绑定 attempt executor；owner authentication provenance 在 request、Queue、custody 与 invocation carrier 间内部传播，公开 Queue/TaskItem projection 均不暴露它或 raw work identity。
- `CiCdRouter` 从 live PR anchor 解析 private binding，以 canonical repository-plus-PR identity 传播 lifecycle evidence；缺 binding 进入 `managed_unattributed`，不再按 thread recency 猜 task-level 归属。
- `TaskOutcomeEpisode` 内部可持 `workId/attemptId`，并显式区分 `managed_attributed / managed_unattributed / unmanaged_not_applicable`；公开 HTTP 与 verdict artifact 统一经过无 raw identity 的投影。
- PR merge/revert 仍只是幂等 evidence：重放返回原 Episode coordinate，不创建 phantom Episode，也不自动 terminalize work 或 Episode。
- [clowder-ai#1213](https://github.com/zts212653/clowder-ai/issues/1213) 的代码事实已在公开仓 pinned `7144756` 与家里 main 双核；2026-07-24 maintainer 评估确认问题成立，并把 identity root 从 `TaskItem.id` 修正为 SOP admission。
- Phase B 代码已进入 main，但 live runtime 尚未加载；F192/F267 在独立 validity gate 通过前仍不得把历史 event/thread telemetry 宣称成 task-level 成功率、耗时或尝试次数。

## What

### Phase A: Admission Contract + Canonical Identity

冻结 ADR/spec：

1. **Eligibility**：只有长程、目标明确、预期有交付物且进入 managed execution 的工作才可能被受理；v1 唯一 producer 是 WorkflowSop first-create。闲聊、普通问答、开放探索属于 `unmanaged_not_applicable`。
2. **Identity root**：`WorkAdmission` 是权威铸造事件；`workId` 从受理锚派生，不从 thread 最新对象、文件名、时间邻近或 eval 侧推测。
3. **Attempt boundary**：一个 `workId` 可跨 thread、跨猫、跨多次 invocation；admission 只预留 attempt 1 身份，认证 admitted invocation 才一次性绑定 executor；重试/换猫产生新 `attemptId`，不换工作根。
4. **Terminal ownership boundary**：业务工作域是未来唯一允许拥有 whole-work 终态的 cell；merge/test/验收/放弃声明只是带 provenance 的证据，eval 不得写业务终态。Phase B 不实现 work state 或 terminal policy。
5. **Projection boundary**：可选 `TaskItem(kind='work')` 与 live `TaskItem(kind='pr_tracking')` 的 shared fields 均不含 raw binding；只有 keyed by live tracking task ID 的 TaskStore-private metadata 与 internal Episode 可持引用。`workId` 永不成为用户 UI/API presentation 管理面。

### Phase B: Minimal Propagation Slice

以当前最失真的 PR lifecycle 为第一薄片：

`WorkAdmission → invocation context → PR tracking → PR lifecycle evidence → TaskOutcomeEpisode.workId?`

- WorkflowSop 满足 closed `workflow_sop_v1` predicate（route 已认证 `ownerUserId` 并解析其 backlog item；first-persist script 看到 key absent、`development`、非 `completion`）时，两条 ingress 都把独立的 `ownerUserId` 传给同一 Redis script，原子铸 `workId` 与未绑定 executor 的首次 `attemptId`；不增加 intent/outbox 或 repair sweep。
- 认证 admitted invocation 对 attempt 1 一次性绑定 executor 并显式携带 `{workId, attemptId}`；普通对话 invocation 不带，`batonHolder/updatedBy` 不得充当执行身份。
- owner authentication provenance 只来自 server request ingress、已认证 parent carrier 或 durable carrier，并作为内部不可变事实贯穿 Queue、TTL-0 custody 与 invocation。每个 production Queue producer 必须显式选择来源：request 新 user carrier 按 strict/compatibility resolver 写入；A2A、continuation 与 freshness successor 原样复制 parent；durable reconstruction 原样恢复；没有 owner proof 的 connector/system/recovery 明写 `unknown`。Dispatch approval 把 resolver 结果与 approval CAS/action-lease claim 原子写入 server-private metadata，rollback 清除，recovery 只读该持久值（legacy 缺失为 `unknown`）；shared `DispatchProposal`/Hub/REST/socket 不暴露它。禁止 Queue 默认值掩盖遗漏；不同 provenance 的用户消息禁止合批、A2A carrier 禁止合并，legacy custody 缺字段只可降为 `unknown`，任何 Queue REST/socket projection 均不得暴露该字段。
- `register_pr_tracking` 从认证 invocation 解析 binding；live `TaskItem(kind='pr_tracking')` 不增加 raw identity 字段，TaskStore-internal bind-once port 以该 task ID 保存 private `{workId, attemptId}` metadata。
- absent private metadata 只能由 authenticated admitted invocation 首次绑定；同 binding 幂等、不同 binding 冲突、缺 binding 不得改变已有值。
- CiCdRouter 先解析 live TaskItem，再从 server-only port 读取 binding 并传给 PR lifecycle；只有绑定一致的 merge 才是该工作的完成候选证据。
- raw binding 不得出现在 task create/get/list/update REST、task socket、`register_pr_tracking` response、web task store 或 community board。
- Episode 新增可空 FK；解析失败进入 `managed_unattributed` 或 `unmanaged_not_applicable`，永不自动塞进“thread 最新任务”。

Slice 3 的 TaskItem anchor 与 private binding 共享一条生命周期不变量；这不是 work 状态机：

| 当前 live anchor | 两个 key 的生命周期 | 并发规则 |
|---|---|---|
| active `pr_tracking` | 都持久化 | 只有匹配当前 `updatedAt + status` 的 persist 可以生效；CAS miss 后重读并按最新状态收敛 |
| completed `pr_tracking` | 都使用同一配置 TTL | 只有匹配当前 `updatedAt + status` 的 expire 可以生效；CAS miss 后重读并按最新状态收敛 |
| anchor 缺失 | private binding 删除 | 不得留下孤儿身份 |

较新的 anchor 状态永远胜出；旧 update 延迟到达的 TTL transition 必须 CAS 拒绝，不能把已 reopen 的 task/binding 重新设为过期，也不能把已完成的 pair 重新持久化。

### Phase C: Multi-Attempt + Terminal Evidence

- 同一工作跨 thread / 跨猫 / 重试的 attempt 连续性。
- 按真实 consumer 重新设计最小 work state、terminal evidence 与 reopen 契约；Phase A 不预先冻结 policy registry/digest/revision ratchet。
- terminal transition 引用可复核 evidence；晚到、重复、冲突证据幂等且 fail closed。
- 只有证明直接记录不足时，才评估通用事件账本/replay；TaskItem/UI 删除或从未创建不影响身份账本。
- F192/F267 只在 identity coverage 与 validity gate 通过后恢复 task-level outcome verdict。

## Non-Goals

- 不给每条用户消息自动创建 TaskItem 或 workId。
- 不把 thread 当任务边界。
- 不让 PR merge 单独决定工作完成。
- 不让 eval、文件名、branch、commit 文本或“最近活跃 Episode”推测 canonical 归属。
- 不新建 workId 用户界面；毛线球仍是唯一可选用户投影。

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | “实际想管理的是长程的、有明确交付目标的任务；普通闲聊和开放性探索不需要” | AC-A1 / AC-B2 | eligibility contract tests | [x] |
| R2 | “开启 SOP 的时候才会分配这个 taskId” | AC-A2 / AC-B1 / AC-B7 | admission identity + atomic first-persist tests | [x] |
| R3 | 同 thread 多任务的 cancel/merge 不得串账 | AC-B3 / AC-B4 | two-work same-thread regression | [x] |
| R4 | TaskItem 不应被征用成强制系统账本 | AC-A5 / AC-C3 | no-card + card-delete continuity tests | [ ] |
| R5 | 无法归属必须 fail closed，不能污染任务分母 | AC-B4 / AC-C4 | unattributed projection tests | [ ] |

### 覆盖检查

- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 本 Feature 无用户 UI；`user_journey_exempt` 与“workId 不进 UI”硬约束已记录

## Acceptance Criteria

<!-- 每条 AC 必须 trace 回 Why，并由非作者复核。 -->

### Phase A（Admission Contract + Canonical Identity）

- [x] AC-A1: `workflow_sop_v1` eligibility 是 closed predicate：route 已认证 `ownerUserId` 并解析其 backlog item；first-persist script 看到 SOP key absent、`sopDefinitionId='development'`、`stage!='completion'`；其余路径不会自动铸造 workId。
- [x] AC-A2: `WorkAdmission` 是唯一 identity root；相同受理锚幂等地产生相同 workId，不同受理锚不得因同 thread 合并。
- [ ] AC-A3: work 与 attempt 分离；attempt 1 admission 时无 executor claim，只有 authenticated admitted invocation 可一次性绑定；重试/换猫/跨 thread 延续同 workId，并产生可追溯的新 attemptId。
- [ ] AC-A4: 如果 Phase C 引入 terminal transition，它只能由业务工作域拥有且必须引用 typed evidence；eval 只能消费，不得改变工作终态。
- [ ] AC-A5: TaskItem 是可选投影；没有卡片、卡片删除或卡片重建均不改变 work identity。
- [x] AC-A6: Design Gate 冻结 `managed-work` ownership cell、准入 producer allowlist 与跨 cell extension points 后才能进入实现。

### Phase B（Minimal Propagation Slice）

- [x] AC-B1: eligible WorkflowSop first-create 原子铸 workId + unbound attemptId；authenticated admitted invocation 一次性绑定 executor 后携带 `{workId, attemptId}`，普通对话链路保持无身份。server-derived owner authentication provenance 在 Queue/custody/invocation 间不可变传播；不同 provenance 不合批或 coalesce，legacy 缺字段 fail closed 为 `unknown`。
- [x] AC-B2: 同一 thread 同时含一个 managed work 与一段闲聊时，闲聊不进入任务分母。
- [x] AC-B3: 同一 thread 两个 managed works 的 cancel/merge fixture 中，事件只归属显式绑定的 work；旧“latest in-progress Episode”路径不得参与 task-level projection。
- [x] AC-B4: 归属输出为 `managed_attributed / managed_unattributed / unmanaged_not_applicable`；`managed_unattributed` 作为覆盖缺陷入账，不能静默丢弃。
- [x] AC-B5: server-resolved binding 只存在于 keyed by live `TaskItem(kind='pr_tracking').id` 的 TaskStore-private bind-once metadata；same-binding re-register 幂等、missing 不变、different 冲突；CiCdRouter 只传播该 binding，缺失/冲突时 fail closed。
- [x] AC-B6: `TaskItem/AutomationState` shared types 与 task REST create/get/list/update、socket、`register_pr_tracking` response、web store、community board 均无 raw workId/attemptId；Queue REST/socket projection 同样不得暴露 owner authentication provenance；TaskItem 仍为唯一可选用户投影。
- [x] AC-B7: 两条 SOP ingress 都把 authenticated `ownerUserId` 独立传入；满足 `workflow_sop_v1` 的 WorkflowSop 首次持久化、WorkAdmission 与 unbound attempt 1 在现有单 Redis 边界内由同一 Lua script 原子提交。脚本前失败则三者都不存在，脚本后失败则重试返回同一身份；既有/非 development/completion SOP 不 retro-admit。
- [x] AC-B8: live `pr_tracking` TaskItem 与 private binding 的 persist/expire 成对迁移，并以当前 `updatedAt + status` 作 CAS；缺失 anchor 清除 binding，旧状态的迟到 transition 不得覆盖 reopen/completion 后的新生命周期，CAS miss 必须有界重读并按最新状态收敛而非静默放弃。

### Phase C（Multi-Attempt + Terminal Evidence）

- [ ] AC-C1: 跨 thread、跨猫、至少两次 attempt 的工作可重建为一个 work root 与有序 attempts。
- [ ] AC-C2: terminal evidence 的重复、晚到、冲突与部分失败均有幂等/恢复测试，不能把 carrier success 当 action success。
- [ ] AC-C3: 不创建 TaskItem 的 admitted work 仍可完整关联 invocation、PR、evidence 与 Episode。
- [ ] AC-C4: F192 task-level verdict 只消费 `managed_attributed`；其他两桶分别保留 coverage/not-applicable 语义，不混入任务成功率。

## Mechanism Selection（ADR-031 v3.4）

| Claim | 机制 | 验证证据 / consumer |
|-------|------|---------------------|
| 身份铸造、传播、三分桶与 fail-closed 归属是确定契约 | test / schema / guard | Phase A/B/C deterministic fixtures |
| admission、binding propagation 与 attribution 是否稳定运行 | logs / metrics / traces | F153 运行健康与告警，不默认进入 Eval Hub |
| “该进 SOP 却未进”的范围边界是否漏失 | F267 eval | 冻结抽样规则 + 人工裁决 + keep/tune/suspend consumer |

## Eval / Tracking Contract

- **Primary Users + Activation Signal**: F275 admission owner、F267 validity guardian、F192 task-outcome consumer；启用新 admission producer、请求 task-level verdict 或 identity coverage 下降时激活。
- **Friction Metric**: 由 F267 持有的 `unmanaged_should_have_been_managed_rate` 与 `managed_unattributed` coverage；F275 不用自己的账本自证未漏 admission。
- **Regression Fixture**: 同一 thread 的两个 managed works + 一段闲聊必须保持三路隔离；legacy assign_work approval、client-spoofed workId 与无 binding PR tracking 均不得被 recency fallback 吸入任务分母。
- **Sunset Signal**: 任一 prospective cohort 不可复现、抽样概率/eligibility 版本不可追溯、或漏掉 operator 已知 managed 正例时，task-level verdict 立即 suspend；只有稳定 eligibility 版本的连续独立 cohort 未再出现已知正例漏失，才可收窄该审计，而不是删除 runtime contract guards。

## Dependencies

- **Evolved from**: F192 Phase G（task-outcome 暴露的 thread heuristic 失真）、clowder-ai#1213（社区问题陈述与契约清单）
- **Blocked by**: none；Phase A Design Gate accepted，Phase B landed；Phase C design/authorization deferred
- **Related**: F246（未来 stable action-envelope admission 候选，v1 不接入）、F167/F233（custody/standing 与 terminal evidence，但不拥有 work identity）、F160（可选 TaskItem 投影）、F267（measurement validity 与任务分母恢复门）

## Risk

| 风险 | 缓解 |
|------|------|
| 为了测量把闲聊/探索强行任务化 | eligibility 先于 identity；普通链路无 workId |
| 新账本与 TaskItem/ball custody 争夺 ownership | 新 `managed-work` cell；投影只引用，不双写 canonical lifecycle |
| fail-closed 让归属失败静默消失 | `managed_unattributed` 必须单独入账并暴露 coverage |
| admission gate 漏掉本该 managed 的工作 | F267 独立抽样审计；不得用 F275 自己的账本证明自己完整 |
| SOP 与 admission/attempt 发生部分提交 | 同一 Redis Lua script 多 key 原子提交；脚本本身判定 closed eligibility，重试返回已存身份 |
| user API 或伪造 `batonHolder` 污染 executor | admission 只预留 attempt；executor/start 只接受 authenticated admitted invocation 的一次性 binding |
| producer 漏写 provenance 而被默认成 unknown、fallback/unknown 搭 strict entry 合批/合并，或 reconstruction 借当前 parent 覆盖 durable provenance | production Queue enqueue type 要求显式 provenance；request ingress 按 resolver 写入、child/freshness successor 复制 parent、durable reconstruction 恢复 custody、无 proof 的 system producer 明写 unknown；合批/coalescing 要求完全相同；公开 Queue projection 统一删字段 |
| 把 binding 写入 legacy `PrTrackingEntry` 导致生产链路仍丢身份 | v1 artifact anchor 是 unified live `TaskItem(kind='pr_tracking')`，binding 只按其 task ID 存 private metadata；legacy store 只 backfill |
| 把 binding 写进 `automationState` 泄漏到 REST/socket/community | raw binding 只进 keyed by task ID 的 TaskStore-private metadata；shared hydrate/DTO deny + 全 egress contract tests |
| workId 变成第二个管理面板 | UI/API presentation denylist + contract test |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 新开 F275，不把 canonical work identity 塞进 F267 | F267 是 consumer/validity gate；让 eval 持有业务身份会违反 KD-1 数据边界 | 2026-07-25 |
| KD-2 | WorkAdmission 是 identity root，TaskItem 是可选投影 | 用户面板与系统账本不能互相绑架 | 2026-07-25 |
| KD-3 | eligibility 定义域先于 task identity | 没有“交付机会”的闲聊/探索不是失败，也不应进入分母 | 2026-07-25 |
| KD-4 | 三分桶替代二值归属 | not-applicable 与 attribution failure 必须分离，避免范围污染和幸存偏差 | 2026-07-25 |
| KD-5 | unmanaged 范围完整性由 F267 外生抽样，不由 F275 自证 | 身份账本看不见未被铸造的身份；内部 counter 无法发现上游沉默 | 2026-07-25 |
| KD-6 | SOP first-persist、WorkAdmission 与 attempt 1 在现有单 Redis 边界内直接原子提交 | 直接消除部分提交窗口，不预建 intent/drain/sweep 子系统 | 2026-07-26 |
| KD-7 | Phase A 只命名 terminal owner，不冻结 policy/state/event 实现 | 先修已证实的归属失真；未来语义由真实 consumer 驱动 | 2026-07-26 |
| KD-8 | attempt 1 admission 时不声明 executor；认证 invocation 才一次性绑定 | SOP 可由 user API 创建，`batonHolder/updatedBy` 不能证明 primary executor | 2026-07-26 |
| KD-9 | live PR anchor 使用 unified `TaskItem(kind='pr_tracking')`，不改 legacy `PrTrackingEntry` | production register/CiCdRouter 均以 live TaskStore record 为坐标；legacy store 只负责 startup backfill | 2026-07-26 |
| KD-10 | PR binding 放在 keyed by live task ID 的 TaskStore-private bind-once metadata，不进 `TaskItem/AutomationState` | 当前 shared TaskItem 会原样进入 REST/socket/web/community；命名“internal”不能形成边界 | 2026-07-26 |

## Review Gate

- Phase A Design Gate：Terra exact-HEAD APPROVE（`14462ca35990dfd0bdaae31042486cf40bb24000`，message `0001785109618172-000199-2fe2f8df`）+ operator ownership signoff（message `0001785589044166-000630-cc9fec30`）。F246 不在 v1 producer schema 内，未来启用时另过 Design Gate。
- Phase B/C：非作者跨 family review 覆盖 identity propagation、terminal ownership、fail-closed 与同 thread 双任务 fixture。
