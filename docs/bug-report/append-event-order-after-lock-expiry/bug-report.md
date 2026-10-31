# Bug 诊断胶囊：append 锁租约过期可导致 revision 事件乱序

| 栏位 | 内容 |
|------|------|
| **1. 现象** | `appendElements` 已持久化 revision N、但尚未发射事件时，如果 per-message 锁租约过期，后继 append 可先补齐 N 并发射 N+1。仅靠持久 outbox/watermark 仍不足：当 retention=1 已 trim 掉 N 的 dedupe key，旧 holder 恢复后还能新增一个更晚 sequence 的 revision N；客户端可在 snapshot revision N+1 后再次读到 revision N。 |
| **2. 证据** | R1 RED 稳定得到 `op-2/rev3 → op-1/rev2`；首次 outbox repair 修正该顺序后，Terra R2 用 retention=1 复现 snapshot `revision=3, resume=3` 后又读到 `seq4/op1/rev2`。watermark CAS 只防止 canonical watermark 倒退，不能原子阻止 stale holder 写 event log。 |
| **3. 问题假设或根因** | 根因已确认：租约有效性与 event insertion 分属两个动作。TTL mutex、revision CAS、retention-window dedupe 与事后 watermark 都不能关闭“旧 holder 在 successor 完成后恢复写入”的 TOCTOU。终态必须由 event store 在同一原子操作里校验当前 lease token 并插入事件。 |
| **4. 诊断策略** | 用真实 `MemoryEventLogStore`/`MessageStore` 与可控 gate 阻塞首次 op-1；让 successor 补齐 rev2、发射 rev3 并完成 snapshot 后再释放旧 holder。另用 Redis 隔离实例让 lease 真实过期并被 successor 接管，直接调用 fenced event append，断言 event head 不增长。 |
| **5. 超时策略** | 若无法以单测稳定复现，则改用显式可控 event-log gate，不引入真实计时或等待 30 秒 TTL；若修复需要跨 Redis/MessageStore 分布式事务，则停止扩 scope，提交 reviewer 决策包。 |
| **6. 预警策略** | 若修复依赖延长 TTL、event write 前单独 ownership check、扩大 retention 或 sleep，说明仍在用时间假设掩盖原子性缺口；若 fenced write 消耗 sequence、watermark 跨 revision 跳跃，或旧 revision 在新 revision 后重放，均视为回归。 |
| **7. 用户可见交互修正** | 插件消费者不会再在极端进程停顿/锁接管时先收到 revision N+1、后收到 revision N 的 append 事件。 |
| **8. 验收** | `INV-17` RED：snapshot rev3 后出现新 rev2；`INV-18` RED：无 successor 时 stale holder 错误 settle。GREEN：Memory/Redis event store 均原子 fence 且零 sequence 消耗；fenced holder 仅在 canonical output 已覆盖目标 revision 时收敛，否则 `RETRYABLE_INFLIGHT` 并允许后续修复。K-1 非 Redis 148/148、隔离 Redis 18/18。 |

[砚砚/GPT-5.6 Sol🐾]
