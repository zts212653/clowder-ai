---
feature_ids: [F047]
related_features: [F039]
topics: [queue, steer, ux, chat]
doc_kind: note
created: 2026-02-28
tips_exempt: existing Queue UI contract correction; no new cat-facing capability or workflow to teach
---

# F047: Queue Steer（取消当前轮并以同一消息立即重启）

> **Status**: done（2026-07-12 语义修订） | **Owner**: Maine Coon/Maine Coon（Codex）
> **Created**: 2026-02-28
> **Completed**: 2026-02-28
> **Priority**: P1

---

## Why

operator在 Codex 原生体验中使用 **Steer**：当消息在队列里等待时，点击 Steer 会让“那条排队消息”立刻进入猫的处理流程（而不是只能撤回/重排/再发一条）。

## What

- 在 QueuePanel 的 **queued** 条目上新增 **Steer** 按钮
- 点击后只有一个 Steer 动作：取消目标猫当前 invocation（如有），并以**同一条持久 Queue 消息**立即启动一次
- 普通重排继续由 drag/move API 独立提供，不再借用 Steer 名称

## Acceptance Criteria

- [x] AC-A1: 本文档需在本轮迁移后维持模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。
- [x] `queued` 条目显示 Steer（`processing` 不显示）
- [x] Steer 弹窗明确告知“取消当前轮并以同一消息立即重启”，且可取消操作
- [x] 有猫在跑时先 cancel，再以被 Steer 的 exact Queue entry 启动一次；空闲时直接启动同一 entry
- [x] `{ mode: "promote" }` 被 API 拒绝；重排只走独立 move/reorder 交互
- [x] Steer 不创建 supplement 或第二个 later carrier
- [x] 具备 API/Web 测试覆盖（至少：权限、409 processing、promote reject、默认 immediate）

## Implementation

### Backend

- Endpoint: `POST /api/threads/:threadId/queue/:entryId/steer`
- Body: 空 body 或 `{ "mode": "immediate" }`；其他 mode 返回 400
- Rules:
  - 404 if entry not found in current user scope
  - 409 if entry is `processing` (processing steer out-of-scope)
  - `immediate`: cancels active invocation (same user) and starts processing via QueueProcessor
- WS: immediate execution follows normal Queue processing updates; no `steer_promote` action exists

### Frontend

- `QueuePanel` queued entry row adds **Steer** button
- Modal offers one explicit action: 取消当前猫，并以同一条消息立即重启

### Reorder（F175 扩展）

F175 在 Steer 基础上扩展了用户可控编排能力：

- **Drag & Drop 排序**：QueuePanel 支持拖动排序（`@dnd-kit`），拖拽后通过 `PATCH /queue/reorder` 批量设置 position
- **Reorder API**：`PATCH /api/threads/:threadId/queue/reorder`，body: `{ positions: [{ entryId, position }] }`
- **排序语义**：显式 position（用户手动拖动）仅在同 user 内覆盖 `priority`，未手动排序的 entry 仍按 `priority > createdAt`
- **Optimistic UI**：前端立即按 comparator 重排，失败时 rollback

## Key Decisions

- Steer 不改动消息内容，也不表示 promote / supplement；它只做 cancel + exact-message restart
- 排序是独立的 Queue 控制面，不属于 Steer
- `processing` 不提供 Steer：运行中纠偏属于更大能力（需要运行中注入/重路由），本 feature 不扩大范围

## Risk / Blast Radius

- **状态机复杂度**：立即执行会触发 cancel → 需要确保 queue 不被错误 pause
- **并发/互斥**：需要保持 QueueProcessor mutex 语义，不允许同 thread 并发执行两条

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
