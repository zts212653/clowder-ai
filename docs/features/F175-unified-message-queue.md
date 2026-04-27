---
feature_ids: [F175]
related_features: [F047, F122, F133, F167]
topics: [queue, dispatch, urgent-bypass, priority-sorting, drag-drop, frontend, inbound-intake]
doc_kind: spec
created: 2026-04-25
intake_source: clowder-ai#575
---

# F175: Unified Message Queue — 优先级排序 + 用户可控编排

> **Status**: intake pending | **Owner**: @mindfn (community, original author) + cat-cafe intake reviewer TBD | **Priority**: P1
>
> **Inbound source**: [clowder-ai#575](https://github.com/zts212653/clowder-ai/pull/575)
> **Original tag**: clowder-ai 仓内编号为 F169（unified-queue-design）
> **Rename reason**: cat-cafe 本地 F169 已被 `agent-memory-reflex` vision 文档占用，同号不同物会污染 search_evidence（参见 `feedback_fake_feat_anchor_is_poison`）。已要求 mindfn 在 PR #575 源头完成 F169 → F175 rename（maintainer 决策，supersede 前一轮 #564 comment 中"clowder-ai 可保留 F169"的口径）。
>
> **Fixes**: clowder-ai#564 — urgent connector 消息不再通过 bypass 抢占 A2A 链，改走队列内优先级排序。

## Why

### 触发问题（来自社区 spec）

`handleUrgentTrigger()` urgent bypass 路径在 A2A 链中段强行注入消息，导致：
- A2A 链被打断（猫猫之间的传球被无关 connector 消息穿插）
- 用户失去对消息执行顺序的可控感
- F133 KD-4（urgent = 队首优先级）实际未实现 — 走的是 bypass 而非队列

### 根因

后端有两条并行的"如何尽快执行一条新消息"路径：
1. **Queue 路径**：`enqueueWhileActive()` 排队等当前 invocation 完成
2. **Bypass 路径**：`handleUrgentTrigger()` 直接抢占（urgent connector 走这条）

bypass 不与 queue 共享排序/容量/可观测性逻辑，是"两套独立系统"。

## What

### Phase A — 后端队列统一

1. **删除 `handleUrgentTrigger()`**：所有消息走 `enqueueWhileActive()`
2. **多维排序 comparator**：`position > priority > createdAt`（urgent = 高 priority + 自动 position=0）
3. **取消用户消息 merge**，出队时按需 batching
4. **source-specific 容量限制**：connector / user / a2a 各自独立配额
5. **`PATCH /queue/reorder` API**：用户可调整队列顺序

### Phase B — QueuePanel 前端升级

1. **@dnd-kit drag-and-drop 排序**（替代 up/down 按钮）
2. **sourceCategory badge + urgent 视觉标记**
3. **Collapse/fold**（≥4 entries 自动收起）
4. **Optimistic reorder with rollback**

### Phase C — 治理收口

1. **F133 KD-4 修正**：urgent 真正落地为队首优先级（不再 bypass）
2. **F122 executor unification 完成**
3. **F047 reorder 文档同步**
4. **ADR-023 queue 终态设计落档**

详见社区 PR body：[clowder-ai#575](https://github.com/zts212653/clowder-ai/pull/575)。

## Acceptance Criteria（来自社区原 spec，intake 时复核）

- [ ] AC-A1: `handleUrgentTrigger()` 删除，无残留调用点
- [ ] AC-A2: 所有消息（user / connector / a2a）走 `enqueueWhileActive()`
- [ ] AC-A3: 排序 comparator 实测覆盖 position/priority/createdAt 三维
- [ ] AC-A4: source-specific 容量限制 enforced
- [ ] AC-A5: `PATCH /queue/reorder` API 通过测试
- [ ] AC-B1: QueuePanel @dnd-kit drag-and-drop 实现
- [ ] AC-B2: sourceCategory badge + urgent 视觉标记
- [ ] AC-B3: ≥4 entries 自动 collapse
- [ ] AC-B4: Optimistic reorder + rollback 测试
- [ ] AC-C1: F133 KD-4 修正落档（spec 同步）
- [ ] AC-C2: F122 executor unification 标 done
- [ ] AC-C3: F047 reorder 文档更新
- [ ] AC-C4: ADR-023 落档

## Intake 操作清单（cat-cafe 侧）

- [ ] 确认 mindfn 已在 PR #575 源头完成 F169 → F175 rename（maintainer 决策已发 PR comment）
- [ ] BACKLOG + index.json 加入口（本 PR 同步）
- [ ] 跨家族 review（Maine Coon优先）
- [ ] merge 后愿景守护（非 author 非 reviewer 的猫）

## Test Plan

继承社区 PR 测试矩阵：
- 172 backend tests（invocation-queue 86 + queue-processor 53 + queue-api 33）
- 8 frontend comparator regression tests
- `tsc --noEmit` clean
- intake 时新增 cat-cafe-specific 集成回归（与 F167/F173 共存验证）

## Risks

- **F167 A2A chain quality 共存**：urgent 改走队列后，F167 的 chain quality 验证需复核
- **F173 thread-runtime state**：QueuePanel 改动跨 thread 切换的 ledger 一致性，与 F173 Phase C 读侧 selector 迁移可能撞 hunk
- **历史 urgent connector 消息**：intake 后旧消息行为变化，需 release notes
