---
feature_ids: [F175]
related_features: [F039, F047, F122, F133]
topics: [queue, priority, dispatch, architecture]
doc_kind: adr
created: 2026-04-24
---

# ADR-023: 消息队列终态设计 — Priority Ordering 替代 Preemption

> **Status**: accepted | **Date**: 2026-04-24

## Context

F122 统一了 A2A/multi_mention 进 InvocationQueue 的路径，但 connector urgent 消息（CI failure / PR review / conflict / scheduled）仍通过 `handleUrgentTrigger()` 旁路直接抢占活跃 invocation，绕过队列。

issue #564 暴露了这个旁路的实际危害：opus 在 A2A round 2 执行中，CI failure 以 urgent 抢占 → `signal.abort()` → opus 回复中的 `@gpt52` mention 被 `signal.aborted` 门控阻止 → 静默丢弃，用户无提示。

根因是三个设计债务叠加：urgent bypass、纯 FIFO 队列、用户消息强制 merge。

## Decision

### 1. Priority 是排序维度，不是旁路

删除 `handleUrgentTrigger()` 和所有 urgent 分支。active-slot 时所有消息（user / connector / agent）走 `enqueueWhileActive()`；idle slot 保留 fast path 直接执行。`priority: 'urgent'` 的语义从"抢占当前执行"变为"在队列内优先出队"。消除的是 urgent bypass（active 时的旁路抢占），不是 idle fast path。

### 2. 多维排序 comparator

```
compareEntries(a, b):
  1. explicit position（用户拖动）— 有 > 无，小 > 大（仅同 userId 条目间比较；shared thread 中不同用户的拖动互不干扰）
  2. priority（urgent=0 > normal=1）
  3. createdAt（FIFO 兜底）
```

所有队列操作（list / move / promote / markProcessing / peekNextQueued / collectUserBatch）统一使用此 comparator。

### 3. 存储独立，出队时汇聚

取消用户消息入队时的 merge 逻辑，每条消息独立 QueueEntry。出队时 `collectUserBatch()` 收集 comparator 顺序中连续的同条件 user entries（同 userId + 同 intent + 同 targetCats Set equality），合并为一次 invocation。

用户可通过拖动排序打断连续性，从而控制汇聚边界。

### 4. 队列容量按 source 分别限制

- `source='user'`：受 `MAX_QUEUE_DEPTH`（5）限制，防刷屏
- `source='connector'` / `source='agent'`：不受硬上限，靠现有 guard 组合

### 5. Guard Story（connector/agent 深度护栏）

系统消息不设硬上限，由以下现有 guard 组合覆盖 runaway 场景：

| Guard | 覆盖场景 | 机制 |
|-------|---------|------|
| CiCdCheckPoller lastCiFingerprint | CI 重复通知 | headSha+aggregateBucket 去重 |
| ReviewRouter ProcessedEmailStore | Review 重复通知 | 5min 时间窗口去重 |
| route-serial maxDepth + STALE_QUEUED | A2A 链无限循环 | 深度限制 + 过期清理 |
| InvocationTracker TTL 75min | 执行超时 | 自动释放 slot |

## Consequences

- **Positive**: 所有消息在队列内可见可控，消除静默丢弃；用户可拖动编排优先级
- **Positive**: comparator 一致性保证出队顺序在所有操作中都符合预期
- **Negative**: connector/agent 无硬上限，极端场景需靠 guard 组合覆盖，实践中需监控
- **Negative**: 前后端各维护一份 comparator，需要回归测试锁住一致性

## Supersedes

- F133 KD-4 原始语义（urgent = 抢占）→ 修正为 urgent = 队首优先级
- F122 `handleUrgentTrigger()` 旁路 → 已删除
