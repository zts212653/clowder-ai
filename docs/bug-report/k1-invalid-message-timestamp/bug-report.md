---
feature_ids: [F258]
topics: [messaging, timestamp, redis, cursor]
doc_kind: bug-report
created: 2026-07-19
updated: 2026-07-20
tips_exempt:
  reason: Correctness fix for existing message-store admission and pagination behavior; no new user-facing capability.
---

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

### Follow-up 诊断胶囊：legacy fractional before-cursor 重复

| 栏位 | 内容 |
|------|------|
| **1. 现象** | 期望：`getBefore()` 与 `getByThreadBefore()` 对 legacy fractional cursor 保持排他性。实际：cursor 自身会再次出现在结果中，分页调用方可能重复页面。 |
| **2. 证据** | Cloud exact-HEAD review `bf04e637` 指出 hydration 已保留 `1.5`，但两个 Redis cursor helper 仍以 `parseInt(score, 10)` 判断同分边界。`parseInt('1.5', 10) !== 1.5`，因此 `id >= beforeId` 的排除分支不会执行。 |
| **3. 问题假设或根因** | 已确认根因：before-cursor 边界比较把 Redis 的浮点 score 截断为整数，违反“hydrated cursor timestamp 与 zset score 数值等价”的分页不变量。 |
| **4. 诊断策略** | 直接写入 legacy fractional hash + timeline/thread zset fixture，分别调用两个公开 before API；扫描本 PR 中所有 `parseInt(score)` sibling call sites。 |
| **5. 超时策略** | 若 15 分钟内 fixture 不能稳定复现，改用带 `keyPrefix` 的原始 zset/hash probe 并记录完整成员与 score；不连接运行实例 Redis。 |
| **6. 预警策略** | 若修复需要改变新写入 admission、ID 编码或迁移历史数据则立即停止；这些属于 D2/D3，不是本次分页等价修复。 |
| **7. 用户可见交互修正** | Legacy fractional cursor 在全局与 thread 分页中恢复严格排他，不再把 cursor 自身作为下一页首/尾项返回。 |
| **8. 验收** | 隔离 Redis RED 先证明两个公开 API 都重复 cursor；将两个同型 score 比较改为非截断数值等价后 GREEN，并运行完整 RedisMessageStore suite 与 quality gate。 |

### Follow-up 诊断胶囊：blank Redis timestamp 被伪造成 epoch

| 栏位 | 内容 |
|------|------|
| **1. 现象** | 期望：历史 Redis hash 中空串或纯空白 timestamp 继续作为无效证据被 hydrate 为 `NaN`。实际：`Number()` 将它们转换为 `0`，下游会把损坏数据当作合法 Unix epoch。 |
| **2. 证据** | Cloud exact-HEAD review `50f45244d` 指出单条 `getById()` 与批量 `hydrateMessages()` 均使用 `Number(raw ?? '0')`；JavaScript 对 `''` 与 `'   '` 的 ToNumber 结果都是 `0`，而旧 `parseInt(..., 10)` 的结果是 `NaN`。 |
| **3. 问题假设或根因** | 已确认根因：为保留 fractional timestamp 而从 `parseInt` 切到 `Number` 时，没有显式区分“缺失字段的既有兼容默认值”与“存在但空白的损坏证据”。 |
| **4. 诊断策略** | 直接写入空串/纯空白 hash，分别走单条与批量 hydration；扫描 PR diff 中所有 timestamp 数值转换 sibling，只在统一 helper 中拒绝 blank coercion。 |
| **5. 超时策略** | 若隔离 Redis 不能稳定返回空白 hash 字段，先用 `hgetall` 记录原始值，再缩到 parser 单测；不连接运行实例 Redis。 |
| **6. 预警策略** | 若修复开始改变缺失 timestamp 的既有默认语义、迁移存量记录或跳过坏消息，则立即停止；这些属于历史 reconciliation 决策。 |
| **7. 用户可见交互修正** | 无新增 UI；损坏的历史 timestamp 不再被静默展示或排序成 1970-01-01。 |
| **8. 验收** | 隔离 Redis RED 证明 `getById()` 与 `getRecent()` 把空串/纯空白 hydrate 为 `0`；GREEN 后两条路径均返回 `NaN`，fractional 与 missing-field 既有行为保持不变。 |

### Follow-up 诊断胶囊：Redis infinity cursor score 文本不等价

| 栏位 | 内容 |
|------|------|
| **1. 现象** | 期望：legacy `Infinity` / `-Infinity` timestamp cursor 在全局与 thread before 分页中保持排他。实际：cursor 自身被再次返回，满页 consumer 可能重复同一页。 |
| **2. 证据** | Cloud exact-HEAD review `67bde9e3a` 指出 Redis ZSET 会把 `Infinity` / `-Infinity` score 规范化为 `inf` / `-inf`。隔离 Redis 8.6.1 实测四种 score 输入均被接受，`ZSCORE` 返回 `inf` / `-inf`；Node `Number('inf')` 与 `Number('-inf')` 均为 `NaN`。 |
| **3. 问题假设或根因** | 已确认根因：hash timestamp 与 ZSET score 是同一逻辑值的两种 Redis 文本表示；hydration 解析 `Infinity` 成功，但两个 cursor helper 用通用 `Number()` 解析 Redis canonical score 失败，破坏数值等价不变量。 |
| **4. 诊断策略** | 逆向跟踪 append 的 hash/ZSET 双写与 before-cursor 双读；用 direct global/thread fixture 覆盖正负无穷，并将 bounded consumer 扩展到正无穷；扫描所有 `zscore` consumer，只修需要 JavaScript 数值等价的两个 sibling。 |
| **5. 超时策略** | 若 real-store fixture 不能稳定复现，先记录 `ZSCORE` 原始响应和查询上下界，再缩到 Redis number parser 单测；不连接运行实例 Redis。 |
| **6. 预警策略** | 若修复开始迁移、跳过或认证 legacy 数据，立即停止；本轮只保留历史证据与 cursor progress，D3/M7 仍 RESERVED。连续第三次同一 state-object finding 则停止代码补丁，回到 plan/spec Stateful Object Gate。 |
| **7. 用户可见交互修正** | 无新增 UI；读取 legacy infinity cursor 时不再重复边界消息或让 bounded collector 无法终止。 |
| **8. 验收** | 隔离 Redis RED 必须在 direct global/thread 排他或 bounded consumer progress 上失败；统一 Redis 数值解析后正负无穷、fractional、blank、missing 行为全部通过，完整 Redis suite 与 quality gate 无回归。 |
