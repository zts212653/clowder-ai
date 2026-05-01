---
feature_ids: [F047]
related_features: [F039]
topics: [queue, steer, ux, chat]
doc_kind: note
created: 2026-02-28
---

# F047: Queue Steer（队列消息一键“立即执行 / 提到队首”）

> **Status**: done | **Owner**: Maine Coon/Maine Coon（Codex）
> **Created**: 2026-02-28
> **Completed**: 2026-02-28
> **Priority**: P1

---

## Why

team lead在 Codex 原生体验中使用 **Steer**：当消息在队列里等待时，点击 Steer 会让“那条排队消息”立刻进入猫的处理流程（而不是只能撤回/重排/再发一条）。

## What

- 在 QueuePanel 的 **queued** 条目上新增 **Steer** 按钮
- 点击后弹窗二选一：
  - **立即执行**：取消当前 invocation（如有）并立刻执行该条目
  - **提到队首**：不取消，只把该条目移到本用户队首，当前跑完后优先执行

## Acceptance Criteria

- [x] AC-A1: 本文档需在本轮迁移后维持模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。
- [x] `queued` 条目显示 Steer（`processing` 不显示）
- [x] Steer 弹窗提供「立即执行 / 提到队首」并可取消
- [x] 立即执行：有猫在跑时会先 cancel，再立刻执行被 Steer 的条目
- [x] 提到队首：条目移动到队首，不影响当前执行；当前结束后优先执行
- [x] 两种行为都会触发 `queue_updated`，前端实时更新
- [x] 具备 API 测试覆盖（至少：权限、409 processing、两种 steer 行为）

## Implementation

### Backend

- Endpoint: `POST /api/threads/:threadId/queue/:entryId/steer`
- Body: `{ "mode": "promote" | "immediate" }`
- Rules:
  - 404 if entry not found in current user scope
  - 409 if entry is `processing` (processing steer out-of-scope)
  - `immediate`: cancels active invocation (same user) and starts processing via QueueProcessor
- WS: emits `queue_updated` actions:
  - `steer_promote`
  - `steer_immediate`

### Frontend

- `QueuePanel` queued entry row adds **Steer** button
- Modal offers two choices:
  - 立即执行（取消当前猫）
  - 提到队首（不取消）

### Reorder（F175 扩展）

F175 在 Steer 基础上扩展了用户可控编排能力：

- **Drag & Drop 排序**：QueuePanel 支持拖动排序（`@dnd-kit`），拖拽后通过 `PATCH /queue/reorder` 批量设置 position
- **Reorder API**：`PATCH /api/threads/:threadId/queue/reorder`，body: `{ positions: [{ entryId, position }] }`
- **排序语义**：显式 position（用户手动拖动）仅在同 user 内覆盖 `priority`，未手动排序的 entry 仍按 `priority > createdAt`
- **Optimistic UI**：前端立即按 comparator 重排，失败时 rollback

## Key Decisions

- Steer 不改动消息内容（不做“编辑/追加内容”），只做“执行优先级/立即执行”的控制面
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
