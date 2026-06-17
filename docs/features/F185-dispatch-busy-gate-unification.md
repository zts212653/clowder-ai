---
feature_ids: [F185]
related_features: [F108, F122, F175]
topics: [dispatch, queue, busy-gate, connector, slot, thread, fairness]
doc_kind: spec
created: 2026-05-01
---

# F185: 入口级判忙策略分层 — ADR-034 实施

> **Status**: done | **Owner**: Ragdoll/Ragdoll | **Priority**: P1
>
> **Decision**: ADR-034

## Vision Guard Record

**Checker**: Siamese/Siamese🐾
**Date**: 2026-05-18
**Verdict**: **PASS**

1. **符合架构愿景？** 是。F185 通过 Phase A (tryAutoExecute) 和 Phase B (routeSerial text-scan) 完整落地了 ADR-034 的统一判忙策略。Phase B 修复了 A2A text-scan 路径对 connector 消息的饿死问题，确保了 "non-agent 优先" 的 fairness invariant。
2. **用户体验负面影响？** 无。改动提升了系统的响应性，外部信号（如 GitHub PR 状态、CI 结果）不再会被猫猫之间的 @mentions 链无限期阻塞。
3. **完成度：** 100%。所有 ACs 已满足，测试全绿，代码已合入 main。

## Why

operator 2026-05-01 报告：PR tracking event 唤醒Ragdoll时Maine Coon在跑，两猫频繁并发，外部 IM/GitHub 消息静默丢弃。

根因：ADR-018 OQ-4 对所有入口统一用 slot 级判忙（`has(threadId, catId)`），把"用户主动 side-dispatch"和"系统自动 connector event"混为一谈。四猫审计一致确认，ADR-034 三猫 review 通过，operator signoff（2026-05-01）。

## What

三个改动点，不拆 Phase：

**1. ConnectorInvokeTrigger thread 级门控 + TOCTOU 修复（KD-1 + KD-2）**

`ConnectorInvokeTrigger.trigger()` 的 busy gate 改为两层：
1. 先检查 `queueProcessor.isThreadBusy(threadId)` 或等价 thread-level queue/processingSlots gate（覆盖 tracker gap）—— 命中则直接 `enqueueWhileActive()`
2. 未命中则 `tryStartThread(threadId, catId)` 原子获取 slot —— 返回 null 则 `enqueueWhileActive()`，返回 controller 则传入 `executeInBackground()` 复用

现有 `has(threadId, catId) || isCatBusy(threadId, catId)` 两个 cat-level 检查统一升为 thread-level。`tryStartThread` 同时提供 TOCTOU 防护（原子 check-and-acquire，消除 has→start 异步间隙）。

**2. 投递可见性 system_info（KD-3）**

分层产出 skip reason（ADR-034 原则：actionable 才 system_info）：
- **ConnectorInvokeTrigger 层**：queue full → thread `system_info`（用户可清队列）；enqueue duplicate → rate-limited diagnostics log（重试噪声）
- **Router/TaskSpec 层**：automation off → thread `system_info`（用户可修改设置）；task 不存在（无 thread 目的地）→ admin/metrics log
- **轮询噪声**：fingerprint 去重 / pending → rate-limited diagnostics log

**3. Fairness invariant + agent priority 约束（OQ-3 收敛）**

- `InvocationQueue` 增加 `hasQueuedNonAgentForThread(threadId)` 查询
- `QueueProcessor.tryAutoExecute()` 开头加早退门：有 non-agent pending → 直接 return，不启动新 agent
- `InvocationQueue.enqueue()` 校验：source=agent 且 sourceCategory ≠ continuation 时禁止 priority=urgent（continuation 保留 urgent + system-pinned 语义，因为它是同猫接力不是 A2A 新条目）

**4. connector policy 补 sourceCategory（ADR-034 要求）**

CI/review/conflict/scheduled 等 connector trigger policy 必须写入 `sourceCategory`，确保 QueueEntry 有分组信息供 QueuePanel 和 diagnostics 使用。

防止 A2A 链持续产 agent entry 饿死 connector 条目。

## Acceptance Criteria

- [x] AC-1: `ConnectorInvokeTrigger.trigger()` 先检查 thread-level queue/processingSlots gate（`isThreadBusy` 或等价），命中则 `enqueueWhileActive()`
- [x] AC-2: queue gate 未命中时用 `tryStartThread(threadId, catId)` 原子获取 slot，返回 null 则 `enqueueWhileActive()`
- [x] AC-3: `tryStartThread` 返回的 controller 在 `executeInBackground` 中复用，duplicate/throw 路径 `complete()` 释放
- [x] AC-4: ConnectorInvokeTrigger 层：queue full → thread `system_info`（用户可清队列）；enqueue duplicate → info log（rate-limited by idempotency）
- [x] AC-5: Router/TaskSpec 层：automation off → thread `system_info`（用户可修改设置）；task 不存在 → gate 返回 `run: false`；pending/fingerprint → rate-limited diagnostics log
- [x] AC-6: `InvocationQueue.hasQueuedNonAgentForThread(threadId)` 存在且正确查询
- [x] AC-7: `tryAutoExecute()` 在有 non-agent pending 时早退，不启动新 agent
- [x] AC-8: agent entry（sourceCategory ≠ continuation）禁止 urgent priority（enqueue 时校验）；continuation 保留 urgent + system-pinned
- [x] AC-9: CI/review/conflict/scheduled connector policy 写入 `sourceCategory`，QueueEntry 有分组信息
- [x] AC-10: 回归测试：connector 到达 + thread 有猫在忙 → 排队不并发
- [x] AC-11: 回归测试：A2A 链中插入 connector entry → connector 不被后续 agent autoExecute 饿死
- [x] AC-12: 回归测试：continuation entry 仍为 urgent + system-pinned，不被 AC-8 校验拦截

---

## Phase B: routeSerial text-scan fairness gate 扩展至 non-agent

> **Status**: ✅ merged (PR #1747) | **Reopened**: 2026-05-17
> **起因**: operator报告 A2A @ 链期间外部消息堆积（截图 2026-05-17）。三猫独立诊断（46/47/55）收敛：Phase A 的 fairness gate 覆盖了 `tryAutoExecute` 但**漏了 `routeSerial` text-scan 路径**。

### Why

Phase A（AC-7）给 `tryAutoExecute()` 加了 non-agent fairness gate——有 connector/user 排队时不启动新 agent。但 `routeSerial` 里的 A2A text-scan（猫输出含 `@猫B` 时决定是否扩展 worklist）走的是另一个 predicate：`hasQueuedUserMessagesForThread`，只看 `source === 'user'`，**不看 connector**。

这意味着：猫A 在跑 → connector 消息来了（CI fail / review feedback）→ 入队 → 猫A 跑完输出 `@猫B` → text-scan 检查 `hasQueuedUserMessagesForThread` → false（connector 不算）→ worklist 扩展，猫B 继续跑 → connector 继续等。

ADR-034 OQ-3 的设计结论是 "non-agent（user + connector）都应阻止 A2A 扩展"，但实现只在 `tryAutoExecute` 落地了，`routeSerial` text-scan 没跟上。`InvocationQueue.hasQueuedUserMessagesForThread` 的注释（L752-756）甚至显式写了 "connector must NOT block"，测试（`invocation-queue.test.js:924`）也断言了这个错误行为。

### What

两个改动点：

**1. Fairness predicate 扩展**：将 `routeSerial` text-scan 的 fairness predicate 从 `hasQueuedUserMessagesForThread`（只看 user）改为 `hasQueuedNonAgentForThread`（看 user + connector），与 `tryAutoExecute` 的 fairness gate 对齐。

**2. Deferred enqueue（preserve handoff）**：fairness gate 命中时，不是静默丢弃 A2A handoff，而是把 text-scan 命中的 A2A targets 入队，排在已有 non-agent entries 后面。connector 先出队执行，完成后 `onInvocationComplete` → `tryAutoExecute` 拉起 deferred A2A。

**Deferred entry 必须携带的字段（行为契约）：**

| 字段 | 值 | 理由 |
|------|-----|------|
| `source` | `'agent'` | 标识为 A2A 产生的条目 |
| `sourceCategory` | `'a2a'` | 与 `callback-a2a-trigger` 路径一致，确保 QueuePanel 分组和 diagnostics 正确 |
| `autoExecute` | `true` | non-agent 出队后 `tryAutoExecute` 自动拉起 |
| `priority` | `'normal'` | agent 禁 urgent（Phase A AC-8） |
| `targetCatId` | text-scan 解析出的目标猫 id | — |
| `callerCatId` | 当前猫 `catId`（猫A） | 猫B invocation 需要知道谁传的球 |
| `content` | 猫A 的 `storedContent`（当前轮完整输出） | 猫B 必须看到猫A的交接上下文才能继续工作 |
| `triggerMessageId` | 猫A 持久化的 `storedMsgId` | downstream `currentUserMessageId` / replyTo / cross-thread hint 依赖此关联 |

**入队前必须应用的 guards（与 inline 扩展路径对齐）：**

- `maxDepth`：当前 `a2aCount` 已达上限的 target 不入队
- `hasQueuedOrActiveAgentForCat`：目标猫已有 active/queued entry 时不重复入队（L1615 dedup）
- F167 ping-pong streak：连续 A2A 往返超过阈值时不入队

**行为对比：**

| 场景 | Phase A（当前） | Phase B（修后） |
|------|----------------|----------------|
| user queued + text-scan 命中 `@猫B` | 不扩展 worklist，A2A 丢失 | 不扩展 worklist，A2A 入队，user 先执行 |
| connector queued + text-scan 命中 `@猫B` | **扩展 worklist，connector 饿死** | 不扩展 worklist，A2A 入队，connector 先执行 |
| 纯 agent queued + text-scan 命中 `@猫B` | 扩展 worklist | 扩展 worklist（不变） |

注意：Phase A 对 user queued 场景也有同样的"A2A 丢失"问题（gate 命中时不入队）。Phase B 一并修复。

**改动范围：**

| 文件 | 行 | 改动 |
|------|-----|------|
| `route-serial.ts` | 1578-1607 | fairness gate 命中时，将 A2A targets 通过回调入队而非静默跳过 |
| `routes/messages.ts` | 887 | `hasQueuedUserMessagesForThread` → `hasQueuedNonAgentForThread`；新增 enqueue 回调注入 |
| `routes/invocations.ts` | 199 | 同上 |
| `ConnectorInvokeTrigger.ts` | 365 | 同上 |
| `QueueProcessor.ts` | 912 | 同上 |
| `QueueProcessor.ts` | 265-268 | wrapper 方法重命名 + 改委托目标 |
| `InvocationQueue.ts` | 752-757 | 更新注释，移除"connector must NOT block" |
| `invocation-queue.test.js` | 924 | 断言改为 `true`（connector 应阻止 text-scan） |

### Acceptance Criteria (Phase B)

- [x] AC-B1: `routeSerial` text-scan fairness gate 使用 `hasQueuedNonAgentForThread`（检查 user + connector）
- [x] AC-B2: 4 个注入 call site 全部从 `hasQueuedUserMessagesForThread` 切换到 `hasQueuedNonAgentForThread`
- [x] AC-B3: fairness gate 命中时，text-scan 命中的 A2A targets 入队（deferred enqueue），不静默丢弃。entry 必须携带完整元数据（见 What §2 字段表）：`sourceCategory='a2a'`、`callerCatId`、`content=storedContent`、`messageId=storedMsgId`
- [x] AC-B3a: 入队前应用全部 text-scan guards：`maxDepth`、`hasQueuedOrActiveAgentForCat` dedup、F167 ping-pong streak + abort guard + pendingTail dedup
- [x] AC-B4: `QueueProcessor` wrapper 方法重命名，注释更新
- [x] AC-B5: `InvocationQueue.hasQueuedUserMessagesForThread` 注释移除 "connector must NOT block" 误导文案
- [x] AC-B6: 回归测试：connector queued + A2A text-scan → gate 阻止 worklist 扩展 + A2A target 入队，断言 entry 的 `content`/`messageId`/`callerCatId`/`sourceCategory` 全部正确
- [x] AC-B7: 回归测试：deferred A2A entry 在 connector 出队完成后被 `tryAutoExecute` 拉起，猫B invocation 能读取猫A交接上下文
- [x] AC-B8: 回归测试：纯 agent entries queued（无 user/connector）→ text-scan 正常扩展（不误阻）
- [x] AC-B9: 回归测试：user queued + A2A text-scan → 同样 deferred enqueue（修复 Phase A 遗留）
- [x] AC-B10: Phase A 已有测试全绿（AC-10/11/12 不回归）

### Risk (Phase B)

| 风险 | 缓解 |
|------|------|
| deferred entry 元数据不全导致猫B看不到交接上下文 | AC-B3 字段表 + AC-B6 测试断言 content/triggerMessageId/callerCatId/sourceCategory |
| deferred enqueue 绕过 text-scan guards（maxDepth/dedup/ping-pong） | AC-B3a 要求入队前应用全部 guards，与 inline 扩展路径对齐 |
| deferred enqueue 导致 A2A entry 与 `hasQueuedOrActiveAgentForCat` dedup 冲突 | 入队前复用 route-serial 现有 dedup 检查（L1615），已 active 的猫不重复入队 |
| connector 频繁到达导致 A2A 反复 defer（活锁） | deferred entry 自身也是 agent entry，不阻止后续 non-agent 出队；且 `tryAutoExecute` fairness gate 保证 non-agent 优先，不会活锁 |
| deferred enqueue 需要 `routeSerial` 调用方提供 enqueue 回调 | 4 个 call site 均有 `invocationQueue` / `queueProcessor` 引用，注入回调无额外依赖 |
| `hasQueuedUserMessagesForThread` 被其他路径使用 | grep 确认只有 text-scan fairness gate 使用，无其他 caller |

---

## Dependencies

- **Evolved from**: F122（统一执行通道 — 补齐 connector 入口的原子门控）
- **Related**: F175（消息队列统一设计 — Phase A priority dequeue 已落地，本 Feature 直接利用）
- **Related**: F108（side-dispatch — 用户 @mention 保留 slot 级，不受影响）

## Risk

| 风险 | 缓解 |
|------|------|
| thread 级改动导致 A2A 链饿死 connector | Fairness invariant（AC-6/7）+ agent priority 禁 urgent（AC-8）|
| tryStartThread 单独不够，漏掉 processingSlots gap | AC-1 先检查 thread-level queue gate，AC-2 再 tryStartThread（R1 55 review）|
| tryStartThread controller 复用出错导致 slot 泄漏 | AC-3 明确 complete() 释放路径 + 回归测试 |
| agent 禁 urgent 误伤 continuation | AC-8 显式豁免 sourceCategory=continuation + AC-12 回归测试（R1 55 review）|
| system_info 事件前端未渲染 | 复用现有 system_info 通道（与 queue_full_warning 同） |
| connector policy 缺 sourceCategory 导致 QueuePanel 分组为空 | AC-9 要求 policy 写入 sourceCategory（R1 55 review）|

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 不拆 Phase，三个改动一起上 | 改动集中在 2-3 个文件、~3h 工作量，拆开反增协调成本 | 2026-05-01 |

## Review Gate

- 跨家族 review（Maine Coon/GPT-5.5）
