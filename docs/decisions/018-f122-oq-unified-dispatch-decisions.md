---
decision_id: ADR-018
feature_ids: [F122]
related_features: [F108]
topics: [a2a, queue, dispatch, steer, multi_mention, architecture]
doc_kind: decision
created: 2026-03-15
status: accepted
decided_by: 铲屎官
---

# ADR-018: F122 OQ-1/2/4 — 统一执行通道产品决策

> 决策日期：2026-03-15 | 决策人：铲屎官 | 提案人：Ragdoll

## 背景

F122 Phase A/A.1 完成后（PR #459, #462），系统的可靠性问题已修复：
- 用户消息不再打断 A2A（TOCTOU 竞态已关闭）
- multi_mention 占位和释放完整
- QueuePanel 能显示 processing 态

但三个产品方向问题（OQ-1/2/4）阻塞 Phase B 的设计和实现。

## 决策

### OQ-1: A2A handoff 入 queue + auto-execute ✅

**决定**：A2A callback（post_message + targetCats）产生的任务入 InvocationQueue，但标记为 `auto-execute`，系统自动执行不需要用户批准。

**效果**：
- A2A 任务在 QueuePanel 可见（用户知道猫猫在干嘛）
- 用户可以 steer 插队纠正方向（猫猫聊歪了能拉回来）
- 用户发消息时，系统知道前面有 A2A 在排队，正确排序

**放弃的方案**：保持 A2A 走独立 WorklistRegistry 分发。理由：不可见、不可控、两套分发平面维护成本高。

### OQ-2: multi_mention 跟 OQ-1，也入 queue ✅

**决定**：multi_mention 产生的子调用也入 InvocationQueue + auto-execute，与 A2A handoff 一致。

**理由**：multi_mention 本质是"一次 @ 多只猫"，产生的每个子调用和 A2A handoff 语义相同。统一入 queue 消除独立分发平面。

### OQ-4: 保持 slot 级判忙 ✅

**决定**：Connector 和用户消息的判忙维持 slot 级（`has(threadId, catId)`），不改为 thread 级。

**效果**：
- 猫A 在忙时，发给猫B 的消息直接执行（by the way 场景）
- 用户可以同时和多只猫交互，只要目标猫空闲
- 前端提示"XX猫正在回复中"，用户知道谁在忙

**放弃的方案**：thread 级判忙（`has(threadId)`）。理由：太粗，猫A忙时猫B也被锁，牺牲并行性。

**安全保障**：`tryStartThread()` 在执行层面仍是 thread 级 busy gate（同一 thread 不会并发两个 invocation），slot 级只影响入队决策。

## 对 F108 Phase B 的影响

F108 Phase B 的 side-dispatch（悄悄话/锁头 → 绕过 queue 派给空闲猫）需要与 F122 Phase B 协调：
- side-dispatch 可以设计为 queue 里的特殊 entry type（`source: 'side-dispatch'`）
- slot 级判忙支持 side-dispatch 的"猫A忙发给猫B"语义，方向一致

## 下一步

- F122 Phase B：改造 `callback-a2a-trigger` 和 `multi_mention` 入口，从直接 dispatch 改为 enqueue + auto-execute
- F108 Phase B × F122 Phase B 合并设计
