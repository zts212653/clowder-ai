---
feature_ids: [F047]
related_features: [F039, F117, F175]
topics: [queue, steer, ux, chat]
doc_kind: note
created: 2026-02-28
---

# F047: Queue Steer（逐成员立即引导或中断回复）

> **Status**: done（2026-07-12 语义修订） | **Owner**: Maine Coon/Maine Coon（Codex）
> **Created**: 2026-02-28
> **Completed**: 2026-02-28
> **Priority**: P1

---

## Why

operator 在 Codex 原生体验中使用 **Steer**：当消息在队列里等待时，点击 Steer 可以把同一条持久消息立即送给一个或多个成员，并逐成员选择“引导当前回复”或“中断当前回复”，而不是只能撤回、重排或再发一条。

## What

- QueuePanel 的 **queued** 条目显示 **Steer** 按钮
- 弹窗候选取 thread participants、消息路由目标与 Queue fallback 的去重并集；已处理目标可见但禁选
- 支持多选，并为每个选中成员分别选择“立即发送，引导回复”或“立即发送，中断回复”
- targetless source entry 的绑定与 `targets[]` 增删在同一持久 mutation 完成；随后各 target 独立投递和终局
- 普通重排继续由 drag/move API 独立提供，不再借用 Steer 名称

## Acceptance Criteria

- [x] AC-A1: 本文档需在本轮迁移后维持模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。
- [x] `queued` 条目显示 Steer（`processing` 不显示）
- [x] Steer 弹窗始终显示“立即发送，引导回复”与“立即发送，中断回复”；能力/当前回复不满足时禁用引导并说明原因
- [x] 候选集合包含 participants、路由目标与 exact Queue fallback；默认选中尚待处理的路由/fallback 目标，已处理目标禁选
- [x] 多目标选择在确认时原子更新同一 source entry 的 pending `targets[]`；每个 target 的 guide/interrupt 动作和终局彼此独立
- [x] “引导回复”只投递给 exact current reply，不能引导时保留普通 Queue 语义且绝不自动 cancel
- [x] “中断回复”有猫在跑时先 cancel，再以被 Steer 的 exact Queue row 启动；空闲时直接启动同一 row
- [x] `{ mode: "promote" }` 被 API 拒绝；重排只走独立 move/reorder 交互
- [x] Steer 不创建 supplement 或第二个 later carrier
- [x] 具备 API/Web/Redis 测试覆盖（权限、stale/terminal/membership conflict、原子 fan-out、逐成员 mixed strategy、promote reject、默认 immediate）

## Implementation

### Backend

- `GET /api/threads/:threadId/queue/:entryId/targets`：将 Queue pending targets 与 History 已投递 refs 联结为逐成员投影
- `POST /api/threads/:threadId/queue/:entryId/targets`：重读 live truth，跳过已投递成员，并原子 reconcile 同一 source entry 的目标集合与逐成员策略
- `POST /api/threads/:threadId/queue/:entryId/continue`：把 source entry 的 exact target 引导进当前回复；exact run 已变化时保留为排队等待
- `POST /api/threads/:threadId/queue/:entryId/steer`：执行单个 target 的中断回复动作
- `/steer` body 为空或 `{ "mode": "immediate", "targetCatId": "..." }`；其他 mode 返回 400
- Rules:
  - 404 if entry not found in current user scope
  - 409 if another action holds the short claim; a target delivered while the modal was open is skipped idempotently
  - target mapping rereads History dispatch refs plus current availability/membership before any target action
  - `continue`: append only to the exact supporting Active Run; otherwise keep normal Queue work
  - `immediate`: cancel the exact target invocation (same user) and dispatch that target from the source entry via QueueProcessor
- WS: immediate execution follows normal Queue processing updates; no `steer_promote` action exists

### Frontend

- `QueuePanel` queued entry row adds **Steer** button
- Modal lists the deduplicated member projection, permits multi-select, and stores one strategy per selected target
- Static guide capability comes from the configured Agent Client via the server cat projection; Web must not hard-code it or infer it from recent speech
- Queue rows do not duplicate capability explanations; the modal owns the selectable capability surface

### Reorder（F175 扩展）

F175 在 Steer 基础上扩展了用户可控编排能力：

- **Drag & Drop 排序**：QueuePanel 支持拖动排序（`@dnd-kit`），拖拽后通过 `PATCH /queue/reorder` 批量设置 position
- **Reorder API**：`PATCH /api/threads/:threadId/queue/reorder`，body: `{ expectedQueueRevision, orderedVisibleEntryIds }`（RFC #1356 §4.1 `ReorderVisibleEntriesCommand`）。前端提交同一 snapshot 下**完整的 visible row 顺序**；服务端校验 revision 与集合一致后原子写入 `position=0..n-1`，revision/集合/eligibility 任一变化即整批 typed conflict，不做 partial write
- **排序语义**：唯一 comparator 为 `position presence → position → priority(urgent before normal) → enqueuedAt → id`。隐藏 rows 不被客户端寻址，仍按自身 priority/FIFO 排序
- **Optimistic UI**：前端立即按 comparator 重排，失败时 rollback

## Key Decisions

- Steer 不改动消息内容，也不表示 promote / supplement；它只更新同一 source Queue Entry 的 pending targets，并对 exact target 做 guide 或 cancel + restart
- 多目标 initial admission 是 all-or-none；cutover 后 sibling 独立，某 target 启动失败不取消已被其他 target 接受的动作
- mixed strategy 是逐 target 的 UI 表达，不是 Queue 账本的新状态机；账本只保存一条 source row、pending `targets[]` 与逐目标 author intent
- 打开弹窗只读；新增 thread member 只在确认时写入。确认时重读 live state：弹窗打开后已投递的目标直接跳过，移出 thread 或不可用的新增目标不准入；旧快照不能复活已投递 target
- 排序是独立的 Queue 控制面，不属于 Steer
- `processing` 不提供 Steer：运行中纠偏属于更大能力（需要运行中注入/重路由），本 feature 不扩大范围

## 设计现状（2026-09-02 校准，见 ADR-043）

> **本节记录已落地的 ADR-043 语义。**

旧实现的 interrupt Steer（cancel + 以同一 exact entry 重启）仍保留，但不再是弹窗唯一动作。旧实现的三段式预留
（`reserveExactUserEntry` → `beginExactSteerPreemption` → `activateExactSteerReservation`）已经删除。

按 [ADR-043](../decisions/043-queue-durable-single-ledger.md) 已收敛为：

- **两步，不是三段**：Lua 原子 claim exact target（`queued → claimed`）→ cancel 正在跑的 invocation（I/O，可能失败）→ actual delivery 时从 `targets[]` 删除该 target，失败则 Lua restore（`claimed → queued`，原位）。Queue 不持久化 processing。
  不能压成一步的唯一原因是 `invocationTracker.cancel` 是 I/O，进不了 Lua。
- **`exactSteerBatch` 删除**：它防的「F175 吸走相邻条目」在 `QueueProcessor.ts:5382-5383` 已与持久的 `steerRequestedByCatIds` 重复检查；原子 claim 后其余用途消失。
- **条目只保留短暂 mutation 证据**：`steerRequestedAt` 用于请求 cutover；替补 run 的 identity 与 processing/terminal 归 TurnExecution / response lifecycle，不回写 Queue。

### Interrupt 动作的不变量

对已经完成 target mapping 的单个 interrupt action，唯一应当拦截的 Queue 生命周期场景是“同一 source entry 已被另一个短 claim 占用”→ 409 `ENTRY_PROCESSING`。已经实际投递的 target 由 History `dispatchRef` 识别并幂等跳过，不是整批冲突。

target mapping 自身还必须联结 History actual-dispatch、membership 与 availability；这些是确认时的资格 fence，不是 interrupt claim 的第二套生命周期。其余 interrupt 拒绝只允许是通用鉴权/归属/schema guard、系统固定位置约束，或真实基础设施失败（例如取消 I/O 失败）。旧三段式产生的 `STEER_STATE_CHANGED` / `STEER_RESERVATION_LOST` / `STEER_RESERVATION_PERSIST_FAILED` / `QUEUE_BUSY` / `PRESTART_STATE_CHANGED` 已消失。并发抢先 claim 统一投影为 `ENTRY_PROCESSING`。

新增任何 Steer 拒绝分支前，必须先证明它不是上述两类产物。

### 已确认的死码

`PREEMPT_PENDING_PRESTART`（202）分支不可达：`preemptSteerTarget` 三个成功出口（`routes/queue.ts:442/451/472`）全部返回 `deferred: false`，故 `:902` 与 `:1062` 的 `if (preemption.deferred)` 恒假。「先预留、稍后投递」模式早已被收敛为同步。

## Risk / Blast Radius

- **原子映射**：targetless binding 与 target-set reconcile 不能留下 ghost/半组 targets
- **状态机复杂度**：interrupt 会触发 cancel → 需要确保 queue 不被错误 pause；guide 不得暗中升级成 cancel
- **并发/互斥**：需要保持 QueueProcessor mutex 语义；逐 target 动作可以独立终局，但同一 target 不能 double-start

## Review Gate

| 轮次 | Reviewer | 结果 | 日期 |
|------|----------|------|------|
| R1 | Ragdoll/Opus-46 | 0 P1 / 1 P2 | 2026-02-28 |
| R2 | Ragdoll/Opus-46 | 0 P1 / 0 P2 ✅ | 2026-02-28 |
| Cloud | chatgpt-codex-connector | 0 P1 / 0 P2 ✅ | 2026-02-28 |

### 愿景交叉验证签收
| 猫猫 | 读了哪些原始文档 | 三个问题结论 | 签收 |
|------|------------------|-------------|------|

## Dependencies

- **Evolved from**: F039（消息排队投递 — 用户操作三模式）
