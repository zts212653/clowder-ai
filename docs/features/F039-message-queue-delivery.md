---
feature_ids: [F039]
related_features: [F117]
topics: [message, queue, delivery]
doc_kind: note
created: 2026-02-26
---

# F039: 消息排队投递 — 用户操作三模式

> **Status**: done | **Owner**: 三猫
> **Created**: 2026-02-26
> **Completed**: 2026-02-28

## Why
- 2026-02-26 team lead口述

## What
- **F39**: 猫在跑时支持排队发送/强制发送/取消三模式。InvocationQueue per-thread FIFO + scopeKey 用户隔离 + 同源合并 + 前端 QueuePanel + cancel 后暂停管理。Maine Coon R1→R8 放行。优先级在 #97 3c 之前（队列是 3c 的基础设施）。需求 · 技术 plan。

## Acceptance Criteria
- [x] AC-A1: 本文档已补齐模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。
## Key Decisions
- 历史记录未单列关键决策

## Dependencies
- **Related**: 无
- 无显式依赖声明

## 已知 Bug / UX 改进（2026-02-27 team lead发现）

### Bug 1: F5 刷新后队列消息状态丢失
- **复现**：消息在队列中（queued/processing） → 按 F5 刷新 → 消息显示为"已发送"
- **根因**：`useChatHistory.ts` 页面加载时获取 `/api/messages` 和 `/api/tasks`，但**不获取 `/api/threads/{id}/queue`**。Zustand store 重置后 `queue: []`，队列面板为空。后端有 `GET /api/threads/:threadId/queue` 端点但前端从未调用。
- **修复方向**：在 `useChatHistory` 里加 queue 状态初始化请求
- **状态**：✅ 已修复（PR #92）

### Bug 2: 队列 UI 不显示图片附件
- **复现**：发送带图片的消息 → 消息进入队列 → QueuePanel 只显示文字，不显示图片
- **参考**：Codex 原生队列 UI（截图 `1772263352365-9cac5ed8.png`）
- **修复方向**：
  - 前端：QueuePanel 通过 `entry.messageId` / `mergedMessageIds` 查找关联消息的 contentBlocks 显示图片指示器
  - 后端：QueueProcessor 执行排队消息时补取 contentBlocks 并透传到执行链路
- **状态**：✅ 已修复（前端 PR #92；后端 PR #96）

### Bug 3: 撤回（取消）队列条目后前端残留
- **复现**：在 QueuePanel 点击“撤回” → 后端已删除该 entry，但前端队列面板仍显示旧条目（直到 WS 更新到达/刷新）
- **根因**：QueuePanel 的队列管理操作不做本地 state 更新，完全依赖 `queue_updated` WS 事件刷新 store；当 WS 延迟/丢失时 UI 会 stale
- **修复方向**：撤回成功后本地立即更新 store（移除该 entry）并提示“已取消”；失败则回滚并 toast 错误
- **状态**：🛠️ 修复中（本分支 `fix/f039-canceled-badge`）

### UX 改进: Steer 功能（学习 Codex 原生）
- **描述**：Codex 原生队列有 "Steer" 按钮：当有消息在消息队列里时，把其中一条“拉出来”立即处理（弹窗 1/2）
- **状态**：✅ 已实现为独立 Feature **F047**（PR #101）

## Out of Scope / 后续能力（不阻塞 F039）

### 队列持久化到 Redis（进程重启不丢队列）
- **现状**：队列内存态，进程重启会丢失“排队中”的条目（消息正文仍在 MessageStore，可见但不再自动执行）。
- **备注**：若要做，需要同时定义“重启恢复语义”（包括：in-flight invocation 的 orphan 处理、processing 条目的回滚/重试、pause 状态恢复等）。

## Risk
| 风险 | 缓解 |
|------|------|
| 历史文档口径与当前实现可能漂移 | 在 F094 批次里持续复跑审计脚本并按批次回填 |
