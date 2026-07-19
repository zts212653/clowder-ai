### Bug 诊断胶囊：消息存储接受不可投影的时间戳

| 栏位 | 内容 |
|------|------|
| **1. 现象** | 期望：不属于 ECMAScript valid-Date 域的消息时间戳在任何存储副作用前被拒绝。实际：内存与 Redis store 都直接接受 `number`；内存可持久化 `NaN`，而 K-1 后续执行 `new Date(timestamp).toISOString()` 时才抛错。Redis 路径还会先进入幂等 claim。 |
| **2. 证据** | 基点 `origin/main@191122256`。`MessageStore.append()` 在构造记录前没有 timestamp admission；`RedisMessageStore.append()` 在校验前生成 ID、读取/写入幂等键并组装 Redis transaction；K-1 `projectEnvelope()` 直接调用 `toISOString()`。Redis 的两条 hydration 路径还用 `parseInt()` 读取 timestamp，使合法 `1.5` 不保真。复现由本分支新增的内存与隔离 Redis 测试固化。 |
| **3. 问题假设或根因** | 已确认根因：`AppendMessageInput.timestamp` 只有 TypeScript `number` 类型，没有共享的运行时 valid-Date admission；两个 store 都信任调用方，而读取/投影端隐含假设该值可被 `Date` 投影。Redis hydration 另行假设毫秒一定为整数，与 ECMAScript valid-Date 域不一致。 |
| **4. 诊断策略** | 从两个 store 的 `append()` 入口逆向列出首个可观察副作用；先用 RED 测试证明无效值可越过入口，再引入一个纯 admission helper，并把它放在两个入口的第一条语句。 |
| **5. 超时策略** | 若 20 分钟内无法证明 Redis 的零副作用顺序，改用隔离 Redis 的 keyspace 快照与 listener spy 缩小范围；不接触运行实例 Redis。 |
| **6. 预警策略** | 若修复开始需要选择 `messageId`/`threadId`/`actor.id` 的公开最大值、Unicode scalar 策略或存量迁移方案，立即停止：这些属于 #1165 shape/compatibility 决策，不是本 bug 的 valid-Date 修复。 |
| **7. 用户可见交互修正** | 非法 producer 输入会在 append 边界以稳定的 `RangeError` 立即失败，不再先留下记录或幂等状态、随后在 Host 投影时崩溃。 |
| **8. 验收** | `MessageStore` 与 `RedisMessageStore` 的命名测试均覆盖 `NaN`、正负无穷、Date 上下界 N+1，断言 `RangeError`、零记录/Redis key、零 listener；同时证明 Date 上下界与合法分数值可写入，且 Redis 单条/批量 hydration 均保真。 |
