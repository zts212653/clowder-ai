---
topics: [messaging, timestamp, redis, cursor]
doc_kind: bug-report
created: 2026-07-19
updated: 2026-07-20
tips_exempt:
  reason: Correctness fix for existing message-store admission and pagination behavior; no new user-facing capability.
---

**Primary tracking issue:** [#1200 — reject stored message timestamps that break Date and cursor invariants](https://github.com/zts212653/clowder-ai/issues/1200)

### Bug 诊断胶囊：消息存储接受不可投影的时间戳

| 栏位 | 内容 |
|------|------|
| **1. 现象** | 期望：新写入 timestamp 既可被 ECMAScript Date 投影，也必须位于当前 lexical sortable-ID/cursor 编码的安全域。实际：初版修复接受完整 TimeClip，导致负数与小数 timestamp 生成的 ID 不按时间排序，进而破坏 delivery/mention/seen cursor 与 expired-cursor 恢复。 |
| **2. 证据** | Exact HEAD `05ad80c6f` 上，本机 probe 将 `[-2,-1,0,1,1.5,2]` 生成的 ID 排为 `[-1,-2,0,1,2,1.5]`。`DeliveryCursorStore` 用字符串大小维护三个 cursor namespace；内存与 Redis `getByThreadAfter()` 在 cursor 缺失时也用 ID 字典序恢复。 |
| **3. 问题假设或根因** | 已确认根因：write admission 只验证 Date TimeClip，却没有与下游 ID/cursor ordering contract 组合验证。Redis hydration 继续用 `Number()` 保留历史证据；历史负数/小数属于 D3 审计范围，不能由本次 future-write guard 改写。 |
| **4. 诊断策略** | 从 append admission 画到 ID producer、三个 cursor namespace、内存/Redis after/before cursor consumers；先用 RED 证明负数/小数越过入口，再把 shared helper 临时收窄到 non-negative integral TimeClip，等待 D2 显式 cursor order 后再扩域。 |
| **5. 超时策略** | 若 20 分钟内无法证明 Redis 的零副作用顺序，改用隔离 Redis 的 keyspace 快照与 listener spy 缩小范围；不接触运行实例 Redis。 |
| **6. 预警策略** | 若修复开始需要选择 `messageId`/`threadId`/`actor.id` 的公开最大值、Unicode scalar 策略或存量迁移方案，立即停止：#1165 只记录相关 K-2 shape/compatibility reservation，不授权本 bug 实现这些决策。 |
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

### Follow-up 诊断胶囊：`deliveredAt` 有效排序值表示分裂

| 栏位 | 内容 |
|------|------|
| **1. 现象** | 期望：queued → delivered 的有效排序值在 memory、Redis hash、global/user/thread ZSET、hydration 与分页 cursor 中完全一致。实际：`markDelivered` 接受任意 `number`，Redis 保留小数/无穷 score，但两个 hydration 路径用 `parseInt` 截断为整数或 `NaN`；bounded collector 会漏页或报 `ERR min or max is not a float`。 |
| **2. 证据** | Exact HEAD `2dfc02072` 上，reviewer 通过公开 API 以 `100.25` / `100.5` 投递两条 queued 消息：Redis ZSET 保留原值，hydration 返回 `100`，page-size 1 只收集到最新消息；`Infinity` hydrate 为 `NaN` 后下一页 Redis range 直接报错。内存 store 保留原数字，因此两 store 已失去 parity。 |
| **3. 问题假设或根因** | 已确认根因：此前 audit 把状态对象错误建模为 hash `timestamp` + ZSET score，遗漏了能重写同一排序 score 的第二 producer `markDelivered(deliveredAt)`。这是 plan/spec census 缺边，不是第三个独立 parser 点。 |
| **4. 诊断策略** | 先把状态对象扩成 `deliveredAt ?? timestamp`，枚举 append/markDelivered writer、memory/Redis representation、两条 hydration path、三类 materialized history index、mention-index 例外及 cursor consumers；再选择入口拒绝策略并写 paired RED。 |
| **5. 超时策略** | 若 20 分钟内无法证明 invalid transition 的 Redis 零副作用，记录 hash + timeline/user/thread/mention 五个 key 的前后快照；仍不接触运行实例 Redis。 |
| **6. 预警策略** | 若修复需要迁移、跳过或认证历史 deliveredAt，立即停止；historical attestation/migration 与 M7 仍 RESERVED。若 invalid rejection 不能保持 queued 状态可重试，则回到 transition owner 重新建模。 |
| **7. 用户可见交互修正** | 非法 delivery timestamp 立即以稳定 `RangeError` 失败；消息保持 queued，后续合法投递仍可完成，不产生静默漏历史或分页运行时错误。 |
| **8. 验收** | memory + isolated real Redis 先 RED 证明 fractional/non-finite 值可写并分裂；GREEN 后完整非法域零副作用拒绝、合法边界精确 round-trip、invalid→valid retry 成功，page-size 1 collector 在两 store 均完整且唯一。 |

### Follow-up 诊断胶囊：append 绕过 delivery lifecycle owner

| 栏位 | 内容 |
|------|------|
| **1. 现象** | 期望：generic append 只能创建 legacy-immediate 或 queued 记录，terminal `deliveredAt`/status 由 `markDelivered`/`markCanceled` 独占。实际：`AppendMessageInput` 从 `StoredMessage` 继承全部 delivery metadata；memory 原样保留，而 Redis 只在 append 返回值里保留 `deliveredAt`，hash/hydration/index score 均丢失或仍使用 `timestamp`。 |
| **2. 证据** | Maintainer exact-HEAD `ea12c92ce` probe 通过公共 append API 传入 `timestamp=100`, `deliveryStatus=delivered`, `deliveredAt=100.5|Infinity`：memory 保留输入；Redis append 返回输入但 rehydrate 丢失 `deliveredAt`，timeline score 仍为 `100`。生产 call-site census 只发现 status absent/`queued` append；无生产 caller 需要直接 terminal append。 |
| **3. 问题假设或根因** | 已确认根因：Stateful Object Gate 把 `markDelivered` 写成唯一 terminal owner，却没有把 output-rich `StoredMessage` 与 creation input `AppendMessageInput` 分离；两家 append 又在 runtime spread 未受约束的 input，导致类型、ownership 与持久化实现三者不一致。 |
| **4. 诊断策略** | 先在 plan 中补齐 append/markDelivered/markCanceled 三个 transition owner；再以公共 API 为 RED，成对覆盖 memory/Redis 的 unsafe `deliveredAt`、terminal status、零副作用、合法 queued retry、rehydration 与 global/user/thread score；随后将 input type 与 runtime guard 收敛到同一契约。 |
| **5. 超时策略** | 若 20 分钟内无法证明 Redis append rejection 的零副作用，使用隔离 Redis 对 idempotency/hash/global/user/thread/mention keys 做前后快照；不连接运行实例 Redis。 |
| **6. 预警策略** | 若生产 caller 需要 append 初始化 terminal state，停止并改走“append 是正式 producer”的完整持久化/评分模型；若只剩 test fixtures，迁移 fixture 到 queued→transition 或 legacy-immediate，不放宽 runtime owner。 |
| **7. 用户可见交互修正** | 无新增 UI；JavaScript caller 若绕过 TypeScript 直接向 append 注入 terminal delivery metadata，会在任何 ID/idempotency/listener/hash/index side effect 前收到稳定 `TypeError`。 |
| **8. 验收** | memory RED 32/33、isolated Redis RED 33/34，唯一失败均为“缺少 TypeError”；GREEN 后分别 33/33、34/34。无效 fractional/non-finite/valid-integer `deliveredAt` 与 terminal statuses 均零副作用拒绝；同一 idempotency key 的 queued retry 成功，Redis rehydrate 无 `deliveredAt` 且 global/user/thread score 均精确等于 append timestamp。 |

### Follow-up 诊断胶囊：`markCanceled` 绕过 queued 源状态

| 栏位 | 内容 |
|------|------|
| **1. 现象** | 期望：`markCanceled` 只执行 queued → canceled；legacy-immediate、delivered、canceled 与 missing 都不能被改写。实际：memory 与 Redis 都无条件写 `deliveryStatus=canceled`，可把已投递消息改成带 `deliveredAt` 和 delivery-time indexes 的 canceled 不可能状态。 |
| **2. 证据** | Maintainer exact-HEAD `0e7050a75` probe 证明 legacy-immediate 可被隐藏，且 queued → `markDelivered(id, 200)` → `markCanceled(id)` 返回 status=canceled、`deliveredAt=200`；Redis hash 同时保留 deliveredAt，global/user/thread scores 仍为 200。源码确认两家 `markCanceled` 均缺少 `deliveryStatus === 'queued'` guard。 |
| **3. 问题假设或根因** | 已确认根因：Stateful Object Gate 虽声明 `markCanceled` 独占 queued → canceled，却没有把源状态约束落实为 store invariant；实现只校验对象存在。Redis 的 `markDelivered` 与 `markCanceled` 还都是独立 read→write，没有共享 CAS，因此顺序 no-op 修复不能被表述成并发线性化。 |
| **4. 诊断策略** | 先更新 transition table，明确 missing/queued/non-queued 结果与并发边界；再成对写 memory/real-Redis RED，覆盖 queued success、legacy no-op、delivered no-op，并对 delivered Redis hash 和 global/user/thread scores做前后快照；最后在两家 store 入口加入同一 fail-closed queued-state guard。 |
| **5. 超时策略** | 若 20 分钟内无法证明 Redis delivered no-op 的零副作用，缩到单条记录并逐项记录 hydrated message、raw hash 与三个 ZSCORE；不连接运行实例 Redis。 |
| **6. 预警策略** | 若实现需要 Lua/CAS、锁或补偿性 reconciliation，停止扩大本轮：`markDelivered` × `markCanceled` 线性化与 no-op `message_deleted` 抑制明确 RESERVED 给 PR #1193；delivery × reassignment、zero presence、历史迁移仍按既有 reservation。 |
| **7. 用户可见交互修正** | 本轮保证迟到取消不会改写持久层中的 legacy/delivered 记录或隐藏后续 history hydration；并发 CAS 与当前 queue route 的 no-op 删除事件抑制由 PR #1193 闭合，本 PR 不声称已消除该瞬时 UI 边。 |
| **8. 验收** | paired memory/isolated Redis RED 先证明 legacy/delivered 会被改写；GREEN 后 queued → canceled 成功，legacy/delivered/canceled 原样返回，delivered 的 `deliveredAt`、Redis hash 与 global/user/thread scores逐项不变；源码 audit 记录并发 CAS 缺口而不暗示已覆盖。 |

#### Persisted-number representation and admission matrix

| Producer / case | Admission | Hash text | Hydrated number | ZSET score / wire text | Required relationship |
|---|---|---|---:|---|---|
| legacy `timestamp` missing field | historical read | absent | `0` (existing compatibility default) | N/A | Missing remains distinct from a present invalid value. |
| legacy `timestamp` blank evidence | historical read | `''` / whitespace | `NaN` | N/A | Blank remains invalid evidence and is never fabricated as epoch zero. |
| legacy `timestamp` finite integer | historical read | `'123'` | `123` | `123` / `'123'` | Hash and ZSET decoders are numerically equal. |
| legacy `timestamp` finite fraction | historical read | `'123.5'` | `123.5` | `123.5` / `'123.5'` | Hash and ZSET decoders are numerically equal. |
| legacy `timestamp` positive infinity | historical read | `'Infinity'` | `Infinity` | `Infinity` / `'inf'` | Canonical Redis alias compares equal to the hydrated cursor. |
| legacy `timestamp` negative infinity | historical read | `'-Infinity'` | `-Infinity` | `-Infinity` / `'-inf'` | Canonical Redis alias compares equal to the hydrated cursor. |
| future `timestamp` or `deliveredAt` valid integer TimeClip | admit | exact decimal text | exact integer | exact integer / decimal text | Store-side representations and before-cursor consumers observe the same value while message ownership is stable. |
| future `timestamp` or `deliveredAt` fraction, non-finite, negative, or TimeClip overflow | reject | no write | no new value | no score mutation | `RangeError` occurs before state/index side effects; valid retry remains possible. |
| future append with any `deliveredAt` or terminal status | reject ownership bypass | no write | no new value | no score/index/idempotency mutation | `TypeError` occurs before ID generation or store side effects; terminal fields remain transition-owned. |
| future append with status absent or `queued` | admit creation | no `deliveredAt`; status absent or `queued` | same as append result | `timestamp` / decimal text | Memory and Redis agree; later terminal state must pass through its lifecycle owner. |
| sequential `markCanceled` on queued | admit queued → canceled | status=`canceled`; no `deliveredAt` | same as stored state | existing append-time scores unchanged | Cancellation owns only the queued source state and does not re-score history indexes. |
| sequential `markCanceled` on legacy/delivered/canceled | no-op | hash/object unchanged | existing record unchanged | all index scores unchanged | Late or repeated cancellation cannot rewrite another lifecycle state. |
| delivery concurrent with cancellation | RESERVED | both methods can independently observe queued | final hash can depend on last writer | delivery scores can survive a canceled status | No shared CAS/Lua exists; terminal-transition linearizability and no-op deletion-event suppression are assigned to PR #1193. |
| delivery concurrent with user reassignment | RESERVED | both values remain individually valid | current owner can change after hydration | user score can remain at append time or under the old owner | Pre-existing atomicity gap; deterministic dual-interleaving reproduction is assigned to `proposal_mrt0j01zvz1mopnq`. |
| admitted `deliveredAt=0` crossing HTTP/Web projection | RESERVED | exact `'0'` in Redis | exact `0` in store hydration | N/A | Existing truthiness-based copies can omit presence; this transport/UI consumer repair is not part of Phase A1. |

`zscore` consumer audit (all eight call sites in `RedisMessageStore`):

- `fetchBeforeWithCursor()` and `fetchDeliveredBeforeCursor()` perform JavaScript numeric cursor-boundary equality; both use the shared Redis-number decoder.
- Four user/thread filtering sites only test `score === null` for membership; they do not interpret the score numerically.
- Sequential user-ownership reassignment normally forwards the raw score back to `ZADD`, preserving Redis's representation without a JavaScript comparison. If the source user-index score is missing, its fallback hydrates `deliveredAt ?? timestamp`; future admitted integers remain exact. Concurrent reassignment is not covered by that proof: `markDelivered()` and `reassignUserId()` can act on different owner/score snapshots and need an independent atomic transition. Any incompatible historical fallback remains D3 audit/reconciliation evidence.
- `getByThreadAfter()` passes the raw score back to Redis range commands; Redis, rather than JavaScript, interprets that bound.

No remaining `zscore` consumer converts a sorted-set score for JavaScript numeric equality outside the shared decoder.

`deliveredAt` producer/consumer audit:

- `IMessageStore.append` owns record creation only: its structural input excludes `deliveredAt`, narrows `deliveryStatus` to `queued`, and a shared runtime guard rejects JavaScript callers that inject `deliveredAt`, `delivered`, or `canceled` before side effects. Legacy-immediate creation leaves status absent.
- Runtime terminal-delivery callers are `QueueProcessor` and `StartupReconciler`; both supply `Date.now()`-derived integral values through the sole owner `IMessageStore.markDelivered`. `markCanceled` independently owns queued → canceled and must return every non-queued record unchanged.
- The three queue-route cancellation loops in this exact #1185 tree call `markCanceled` and emit `message_deleted` without inspecting the returned state. Their no-op event gate and the Redis terminal CAS are intentionally not duplicated here: both are owned and tested by PR #1193.
- In-memory `markDelivered` stores the exact value on the message object. Redis stores the same text in the hash and re-scores global, user, and thread indexes; all three are effective-history-order indexes.
- The mention index intentionally retains append-time `timestamp` ordering and is not re-scored or reused by effective-history before cursors.
- `getById()` and `hydrateMessages()` are the two Redis hash hydration paths. Future admitted `deliveredAt` values need no coercive fallback: decimal integer parsing is exact throughout the admitted TimeClip domain.
- Sequential `reassignUserId()` preserves that effective order both when forwarding an existing user-index score and when reconstructing a missing score from a future-admitted hydrated value; isolated Redis tests cover zero and the positive TimeClip boundary. This is not a concurrency claim.
- Effective before-cursor consumers were re-audited: `routes/messages.ts`, `AgentRouter.findRecentUserMentionFallback`, `collectAllThreadMessages`, duty-briefing pagination, and the paw-feel adapter all derive cursor/window time from `deliveredAt ?? timestamp` (the paw-feel adapter additionally de-duplicates IDs and stops on non-progress).
- Non-pagination effective-time consumers `routes/callbacks.ts`, duty-briefing mention collection, and briefing day projection use the same projection and never serialize it into a Redis range bound.
- Freshness consumers that compare message IDs explicitly retain creation-order semantics; their comments already document the delivered-score/ID split, and they do not parse or reuse `deliveredAt` numerically.
- Rejecting unsafe transition values and fail-closing cancellation on non-queued source states keep every sequential single-writer materialized Redis bound in the admitted decimal-integer domain while preserving the existing creation-order and mention-order exceptions. Redis has no shared CAS between `markDelivered` and `markCanceled`; terminal-transition atomicity and event gating remain RESERVED to PR #1193, while other cross-writer atomicity and exact zero-presence beyond the store boundary remain explicitly RESERVED.
