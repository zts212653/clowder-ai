### Bug 诊断胶囊：消息存储接受不可投影的时间戳

| 栏位 | 内容 |
|------|------|
| **1. 现象** | 期望：新写入 timestamp 既可被 ECMAScript Date 投影，也必须位于当前 lexical sortable-ID/cursor 编码的安全域。实际：初版修复接受完整 TimeClip，导致负数与小数 timestamp 生成的 ID 不按时间排序，进而破坏 delivery/mention/seen cursor 与 expired-cursor 恢复。 |
| **2. 证据** | Exact HEAD `05ad80c6f` 上，本机 probe 将 `[-2,-1,0,1,1.5,2]` 生成的 ID 排为 `[-1,-2,0,1,2,1.5]`。`DeliveryCursorStore` 用字符串大小维护三个 cursor namespace；内存与 Redis `getByThreadAfter()` 在 cursor 缺失时也用 ID 字典序恢复。 |
| **3. 问题假设或根因** | 已确认根因：write admission 只验证 Date TimeClip，却没有与下游 ID/cursor ordering contract 组合验证。Redis hydration 继续用 `Number()` 保留历史证据；历史负数/小数属于 D3 审计范围，不能由本次 future-write guard 改写。 |
| **4. 诊断策略** | 从 append admission 画到 ID producer、三个 cursor namespace、内存/Redis after/before cursor consumers；先用 RED 证明负数/小数越过入口，再把 shared helper 临时收窄到 non-negative integral TimeClip，等待 D2 显式 cursor order 后再扩域。 |
| **5. 超时策略** | 若 20 分钟内无法证明 Redis 的零副作用顺序，改用隔离 Redis 的 keyspace 快照与 listener spy 缩小范围；不接触运行实例 Redis。 |
| **6. 预警策略** | 若修复开始需要选择 `messageId`/`threadId`/`actor.id` 的公开最大值、Unicode scalar 策略或存量迁移方案，立即停止：这些属于 #1165 shape/compatibility 决策，不是本 bug 的 valid-Date 修复。 |
| **7. 用户可见交互修正** | 超出当前 sortable-ID 安全域的 producer 输入会在 append 边界以稳定的 `RangeError` 立即失败，不留下记录、幂等状态或 listener 副作用。 |
| **8. 验收** | 内存与隔离 Redis 均覆盖负数、小数、NaN、无穷、Date 越界值的零副作用拒绝；零、普通正整数、Date 正上界成功；另证明生成 ID 时间顺序、delivery cursor 单调性与两种 store 的 expired-cursor 恢复。 |
