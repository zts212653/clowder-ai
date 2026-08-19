---
feature_ids: [F298]
related_features: [F174, F167, F108, F048, F261, F275, F299, F300]
topics: [runtime, durability, callback-auth, invocation-lifecycle]
doc_kind: spec
created: 2026-08-17
description: "运行态承诺持久性：凭证/队列/唤醒等跨进程承诺必须活得比所服务过程长，内存态只能是 cache（ADR-045 收敛锚）"
description_source: human
description_author: fable-5
description_updated_at: 2026-08-18T13:05:00Z
---

# F298: Runtime Promise Durability（运行态承诺持久性收敛）

> **Status**: spec | **Owner**: Ragdoll (@fable5, claude-fable-5) | **Priority**: P1

**性质**: hardening / debt-paydown 收敛 feat——**跟踪锚不是实现容器**。实现落各自然领地，本 feat 家族表裁定与跟踪 verdict。
**法源**: ADR-045 | **operator signoff**: 2026-08-17 [thread-id]（「不能头痛医头」「数学之美和第一性原理」「我们得f298了」）

## Why

猫在合法的长等待中（等 review / 等 CI / hold_ball）会被系统**当成死亡**：凭证静默蒸发后，一只还活着、正在干活的猫突然对家里失声——调 thread context 401、refresh 也 401、连报错都在撒谎（明明是"你被时间杀了"，却说"不认识你"）。operator看到的是猫莫名失联；猫看到的是永远敲不开的门。2026-08-17 事故后 operator 拍板：「不能头痛医头了，应该排查类似的可能的问题」——所以本 feat 不是修一个 401，是把"短命引用 × 长命过程"这一**族**失效系统性清干净，让"合法 spawn 且还活着的 agent 始终能与家对话"成为不变量。

## Current State / 现状基线

实测证据（2026-08-17 架构裁定，本 thread 证据链）：

- **401 事故**：daemon.log 21:21–22:07 UTC 每隔十几分钟五连发 401 `/api/callbacks/refresh-token`，风暴持续 1h+；根因为滑动 TTL 2h 静默蒸发（`InvocationRegistry.ts:53`），**非重启丢数据**（Redis AOF 完好，4 月 key 存活；反证：重启后 TTL 内存量 invocation 验证正常 → 老进程亦 redis backend）
- **TTL 参数史自证参数无解**：`InvocationRegistry.ts:52` 注释 "was 10 min"→2h，仍炸——合法静默时长无上界
- **诊断毁灭**：60s grace（`RedisAuthInvocationBackend.ts:69`）后 `expired` 降级 `unknown_invocation`，直接导致本次人猫集体误诊为"重启丢了"
- **队列边界已部分持久化，旧结论过宽**：`InvocationQueue.ts:170` 虽是内存 `Map`，但 message-backed Queue custody 已有 durable store 与 startup reconciler；`InvocationQueue.ts:68` 也明确 exact Batch Steer reservation 是进程内投影、不是第二账本。真正未闭合的是 **producer/admission coverage** 与“Queue 已取走、运行已接纳、结果尚未写回”这个 crash gap，不能靠再持久化整张 Map 解决
- **结构矛盾**：CLI `detached: true`（`GeminiAgentService.ts:1598`，故意比 API 长寿）× 凭证 env 一次性注入无重生路径
- **相邻架构正在收敛**：[clowder-ai PR #1356](https://github.com/zts212653/clowder-ai/pull/1356) exact HEAD `36b4bb233` 把消息运行时压成 Durable Queue / Durable Chat History / In-memory Active Runs 三平面；方向与本 feat 不冲突，但其“出队后进程退出可无结果、由用户手动重试”政策尚未满足 ADR-045 的 typed terminal 要求

## What

判据（ADR-045 审查判据）：**短命/内存态引用 × 长命过程**的交叉点即家族成员。

### 家族表（收敛对象与 verdict 账本）

| # | 部位 | 短命态 | 长命过程 | 证据 | 处置 | 落地领地 | Verdict |
|---|------|--------|----------|------|------|----------|---------|
| 2 | refresh-token 机制 | 与 access 同 record | 同上 | 实证（401 风暴） | 随 #1 消解（滑动窗口消失，refresh 语义化为 no-op，端点保留兼容） | F174 新 Phase | **spec-done** |
| 3 | dispatch admission/result obligation | Queue take 后尚未产生 terminal result 的 accepted dispatch | API/provider 运行与跨重启恢复 | 代码 + F048 反例 + #1356 A20 | 收敛为 **durable Queue + minimal accepted/result witness**：Active Run 可留内存且不自动 replay，但重启必须把 unresolved accepted dispatch 确定性终结为 `interrupted/runtime_restart`，禁止无声消失 | #1356 实现面；F048 现有 restart terminal 语义 | **cased**（[#1356](https://github.com/zts212653/clowder-ai/pull/1356)，待 RFC 对齐） |
| 4 | 诊断语义 | 60s grace 后 expired→unknown | 事后诊断（人+猫） | 实证（本次集体误诊） | 修：内联 tombstone——终态 verify 返回 derived typed reason（completed/failed/interrupted/replaced/revoked/canceled），`expired` 退役（Phase A spec §3） | 随 #1 落 F174 | **spec-done** |
| 5 | detached CLI 孤儿 | 凭证 env 一次性注入 | detached 进程 | 结构推断（`detached:true` 实证） | 随 #1 消解：principal 活到 canonical run 显式终结；API restart 后要么恢复 exact principal，要么写 typed `interrupted/revoked`，不得退化成 unknown | F174（随 #1） | **spec-done** |
| 6 | hold_ball 托管承诺 | 历史已持久化 | 跨 session 唤醒 | 待现版确认 | 查证：wakeWhen 命令托管 + 唤醒承诺现版是否全量持久 | hold_ball 领地 | open |
| 7 | WS/EYES 订阅 | 内存连接态 | 前端会话 | 待查 | 查证：客户端重连兜底覆盖度；兜底完备则 risk-accepted | transport 领地 | open |
| 8 | wake admission acknowledgement | messageId 已写入，但 `invokeTrigger` 失败被吞后仍记录 wake/cooldown | 等球猫依赖该 wake 继续工作 | `BallCustodyWakeSender.ts:39-53` + `BallCustodyProbeScheduler.ts:164+` | message persisted ≠ run admitted；producer 必须消费 typed admission receipt，失败保持 exact item 可重试且不污染 cooldown | #1356 admission 边界 / F233-F300 consumer | **cased**（随 #1356 对齐） |

**Verdict 词汇**：`fixed`（修掉，附 PR）/ `cased`（立案到落地领地 feat，附锚点）/ `risk-accepted`（书面接受，附理由）。三者皆可关项。

### Phase A: Auth 显式生命周期（#1/#2/#4/#5，spec-done → 待实现）

### Phase B: dispatch admission/result 边界跟踪（#3/#8，cased 路径）

落地由 #1356 的三平面架构承担：Queue 是 not-yet-dispatched 的 durable authority，Active Run 可以是进程内执行对象；F298 只守“接纳前后必须有 durable witness，重启后 unresolved accepted dispatch 必须产出 typed terminal”这一寿命不变量，不要求 durable Active Run、不要求自动 replay，也不新建第四状态平面。

### 与 clowder-ai #1356 的不冲突边界

| #1356 拥有 | F298 拥有 | 共同约束 |
|---|---|---|
| ingress、FIFO、batch、Queue take、History publish、Active Run 与 handoff 的业务语义 | 承载这些语义的 principal / receipt / wake reference / terminal witness 要活过所服务过程 | client/provider 产生外部效果前必须完成 durable admission；结果成功或失败都写 canonical History |
| Active Run 可留内存，重启不重建 live client，不猜 target，不自动 replay | crash 不能把 accepted promise 变成沉默 | startup 将没有 terminal result 的 accepted witness 收敛为 `interrupted/runtime_restart`；这是结果，不是第四份 workflow ledger |
| 不建 semantic task tree、receipt projection 或 reliable workflow engine | Auth 只做 derived capability lifecycle | auth tombstone 不得成为业务结果真相源；业务终态来自 History/execution owner |

若 #1356 坚持“出队后 crash 可没有任何 result，由用户自己发现并重试”，那不是实现细节，而是对 ADR-045 的显式例外：必须由 operator 书面 risk-accept，不能在 RFC 中作为无声默认。

### Phase C: 查证裁定（#6/#7）

对 hold_ball 现版持久性与 WS/EYES 重连兜底做证据级查证，按三态 verdict 关项。

### 下游 consumers（依赖单向：consumer 消费本表保证，不反向；反向出现 = 设计警报）

- **#1 / #3 / #8 → F300-M2（送达层 delta 推送）**：principal 蒸发会让唤醒 401；admission/result witness 缺失会让“已送达”成为假话。F300 只消费 canonical delta，不持久化旧 `InvocationQueue` 对象。
- **#4 → F299-P2（展示层 evidence manifest）**：auth tombstone 只供给 callback credential 的 typed absent/rejected reason；invocation 的 completed/failed/canceled/interrupted 业务终态必须来自 canonical History/execution，不得由 auth 反推。
- 边界备注：custody **可观测性与送达**归 F300；runtime promise **寿命判据**归 F298；dispatch **业务状态机与 durable Queue/History**归 #1356。
- 2026-08-18 反向依赖扫描：F298 不需要感知/展示层输入；#1356 也不依赖 F299/F300 才能保证持久，依赖保持单向。

## User Journey

### Primary Journey: 猫等多久都不会失联
- **Scope unit**: session
- **Actor**: operator（间接：猫猫）
- **Entry**: operator派猫做长任务（等 cloud review / 等 CI），离开数小时后回来
- **Flow**:
  1. 猫挂起等待（静默 >2h，期间 API 甚至重启过）→ operator回来发消息
  2. 若 detached exact run 仍活着，猫正常回话；若运行确实因重启丢失，系统留下 `interrupted/runtime_restart` 结果——两者都不再退化成「401 unknown_invocation」
  3. 若operator期间**取消**了该猫 → 猫下一次调用收到 typed `canceled`（不是"不认识你"），失效原因在 F299 trajectory 中可见
- **Success evidence**: RED-1 转绿的测试输出 + 复现场景（静默 >2h 后 callback 200）人工验证记录
- **Non-goals**: 取消事件的**主动推送**给猫（F300-M2 的活；本 feat 只保证事后 verify 说真话）

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | 「这又是啥bug」——等 review 时 401 失联必须根治 | AC-A1 | test（RED-1） | [ ] |
| R2 | 「不能头痛医头了，应该排查类似的可能的问题？然后列出来」 | AC-D1 | 家族表 7 项 + 判据 | [x] |
| R3 | 「数学之美和第一性原理，不要当补锅匠」——一条不变量而非 N 个补丁 | AC-D2 | ADR-045 存在且被 review 引用 | [x] |
| R4 | 「不建议归入 n 个 feat……有个 roadmap 会好点」 | AC-D3 | 单一收敛锚 + per-item verdict | [x] |
| R5 | 报错必须说真话（取消/替换/完成 ≠ 不认识你） | AC-A2/A3 | test（RED-2/3/4/5） | [ ] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [ ] 前端需求已准备需求→证据映射表（不适用：无前端面）

## Acceptance Criteria

<!-- 每条 AC trace 回 Why：R1 失联根治 / R2 族清单 / R3 一条定律 / R5 报错真话 -->

### Phase D（立项与立法——本 thread 已交付）
- [x] AC-D1: 家族表 ≥7 项，每项含 部位/短命态/长命过程/证据/处置/落地领地/verdict（→R2；2026-08-18 rebase 后 8 项）
- [x] AC-D2: ADR-045 立法不变量 + 审查判据，main 可查（→R3）
- [x] AC-D3: 单一收敛锚注册（BACKLOG + 本 doc），close 条件 = per-item verdict ≠ open（→R4）

### Phase A（Auth 显式生命周期）
- [ ] AC-A1: active 凭证在**任意时长静默**与 Redis/AOF 重启后 verify 仍 ok；API 重启时，仍存活的 detached exact run 保持 ok，确实丢失的 run 返回 typed interrupted——RED-1/8 先红后绿（→R1，I1/I5）
- [ ] AC-A2: canonical terminal 事件派生 auth tombstone reason（completed/failed/interrupted/replaced/revoked/canceled）；verify 命中终态返回精确 reason，非 `unknown_invocation`——RED-2/3/4/7（→R5，I2）
- [ ] AC-A3: `unknown_invocation` 仅剩两种来源（从未存在 / 终结后 ≥GC 窗口）；`expired` 从 AuthFailureReason 退役，全部消费方（telemetry/degradation/auth-debug/system-message）grep 同步无死分支（→R5，I3）
- [ ] AC-A4: 并发双终结首写胜、state 不回退——Redis-backed 真并发测试（I4）
- [ ] AC-A5: F174-B detached-run 重启存活 + F048 lost-run restart terminal 两类回归都绿；refresh 端点 no-op 兼容（CLI 零改动）（I5）

### Phase B（dispatch admission/result 边界）
- [ ] AC-B1: #1356 明确“durable Queue + in-memory Active Run”边界，并以 spec/AC 锁住 crash-after-take 与 crash-after-accept-before-result：不 replay、不猜 target，但必须写 typed `interrupted/runtime_restart` result
- [ ] AC-B2: #8 的 producer 收到 typed admission receipt；message 持久化但 invoke/admission 失败时保持 exact item 可重试，不写 wake_sent/cooldown 成功态

### Phase C（查证裁定）
- [ ] AC-C1: #6 hold_ball 现版持久性查证结论落表（三态 verdict 之一 + 证据）
- [ ] AC-C2: #7 WS/EYES 重连兜底查证结论落表（三态 verdict 之一 + 证据）

## Dependencies

- **Evolved from**: F174（callback auth registry——Phase B 做了跨重启，本 feat 消灭"静默即死"）
- **Related**: F167（A2A/custody consumer）、F048（restart 时 persisted running → failed 的既有 terminal 先例）、F108（TTL=0 持久先例）、F261（managed job 相邻非目标）、F275（admission identity 边界）、F299（展示层）、F300（送达层）
- **External alignment**: [clowder-ai #1356](https://github.com/zts212653/clowder-ai/pull/1356)（dispatch/History/Active Run 业务架构；F298 不替代）
- **Blocked by**: 无（Phase A 可立即开工；Phase B 的最终 verdict 取决于 #1356 是否接纳 typed interrupted result 或取得 operator risk-accept）

## Risk

| 风险 | 缓解 |
|------|------|
| terminal tombstone 30d GC 对 Redis 体量影响未实测 | active key 不设 TTL；仅 terminal tombstone 进入 30d GC。上线前按终结速率估算，上线后用 F153 观测 |
| 终结写入点清单可能不全（静态找的锚点） | auth 不拥有业务终态；由 canonical terminal producer 驱动并用 RED-7 覆盖。遗漏时指标暴露 active-with-terminal divergence，不用时间杀合法 principal |
| #1356 为保持三平面极简而接受 post-take 静默丢承诺 | 不引入第四平面；用 Queue/History 自己的最小 accepted witness 在启动时写 `interrupted`，若拒绝则走 operator 显式 risk-accept |
| Sol 现场诊断可能带回 F264/F296 delta 修正锚点 | spec 结构不受影响，§4 锚点表可 rebase；已预注册 |
| 收敛 feat 变永动 feat | close 条件 = per-item verdict ≠ open（fixed/cased/risk-accepted 皆可关），不要求全 fixed |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 家族表只收敛**存量违反项**；新建状态（如 F299-P3 envelope retention）直接受 ADR-045 管辖不进表 | 防表滑向"一切持久性事项登记处"，判据失效 | 2026-08-17 |
| KD-2 | Phase A 用"显式生命周期"替代立项版"回源重建" | 回源仍在为"cache 短命"错误前提建补偿；去掉短命本身，回源/重建/跨 store 一致性整层消失 | 2026-08-17 |
| KD-3 | 方向 B（自包含 HMAC token）否决 | secret 持久化+轮换是新状态问题，复杂度守恒无净减；吸收其 tombstone 与诊断分层 | 2026-08-17 |
| KD-4 | 滑动 TTL 安全贡献判为负 | 活跃攻击者每调用续期（永生），合法静默者被杀——反向选择；真安全=latest-slot+显式 revoke+tombstone | 2026-08-17 |
| KD-5 | 接受 #1356 的三平面与 in-memory Active Runs，但拒绝 accepted dispatch 在 crash 后无声消失 | 持久 execution object 不是必需；durable terminal witness 才是 ADR-045 所需的最小信息 | 2026-08-18 |
| KD-6 | Auth tombstone 只拥有 credential disposition，不拥有业务 terminal truth | 防 Auth 变成第五账本；F299/F300 必须从 History/execution canonical owner 取业务事实 | 2026-08-18 |

## Review Gate

- Phase A: 实现 PR 走正常 merge-gate；reviewer @codex-sol（事故现场一线 + 跨家族）；RED 先红后绿证据必附
- Phase B/C: verdict 更新为 direct-main docs 车道，附证据链接

## Tips Contribution（F244）

tips_exempt: 纯 runtime 持久性收敛，无用户操作面变化（用户感知是"失联消失"这一负向体验的消除，无新操作可教）
