---
feature_ids: [F298]
related_features: [F174, F167, F108, F048, F261, F275, F299, F300]
topics: [runtime, durability, callback-auth, invocation-lifecycle]
doc_kind: spec
tips_exempt: "Phase A is automatic callback-auth durability and typed-diagnostic hardening; it adds no user action or discoverable capability surface."
created: 2026-08-17
description: "运行态承诺持久性：凭证/队列/唤醒等跨进程承诺必须活得比所服务过程长，内存态只能是 cache（ADR-045 收敛锚）"
description_source: human
description_author: fable-5
description_updated_at: 2026-08-20T04:06:00Z
---

# F298: Runtime Promise Durability（运行态承诺持久性收敛）

> **Status**: done | **Completed**: 2026-08-21 | **Owner**: Ragdoll (@fable5, claude-fable-5) | **Priority**: P1

**性质**: hardening / debt-paydown 收敛 feat——**跟踪锚不是实现容器**。实现落各自然领地，本 feat 家族表裁定与跟踪 verdict。
**法源**: ADR-045 | **operator signoff**: 2026-08-17 [thread-id]（「不能头痛医头」「数学之美和第一性原理」「我们得f298了」）

## Architecture ownership

- Architecture cell: callback-auth
- Map delta: none
- Why: F174 继续拥有 invocation callback credential、failure reason、refresh 与 telemetry；Phase A 只把凭证寿命绑定到既有 exact TurnExecution，不新增 Store、Queue 或业务 ledger。

## Why

猫在合法的长等待中（等 review / 等 CI / hold_ball）会被系统**当成死亡**：凭证静默蒸发后，一只还活着、正在干活的猫突然对家里失声——调 thread context 401、refresh 也 401、连报错都在撒谎（明明是"你被时间杀了"，却说"不认识你"）。operator看到的是猫莫名失联；猫看到的是永远敲不开的门。2026-08-17 事故后 operator 拍板：「不能头痛医头了，应该排查类似的可能的问题」——所以本 feat 不是修一个 401，是把"短命引用 × 长命过程"这一**族**失效系统性清干净，让"合法 spawn 且还活着的 agent 始终能与家对话"成为不变量。

## Current State / 现状基线

实测证据（2026-08-17 架构裁定，本 thread 证据链）：

- **401 事故**：daemon.log 21:21–22:07 UTC 每隔十几分钟五连发 401 `/api/callbacks/refresh-token`，风暴持续 1h+；根因为滑动 TTL 2h 静默蒸发（`InvocationRegistry.ts:53`），**非重启丢数据**（Redis AOF 完好，4 月 key 存活；反证：重启后 TTL 内存量 invocation 验证正常 → 老进程亦 redis backend）
- **TTL 参数史自证参数无解**：`InvocationRegistry.ts:52` 注释 "was 10 min"→2h，仍炸——合法静默时长无上界
- **诊断毁灭**：60s grace（`RedisAuthInvocationBackend.ts:69`）后 `expired` 降级 `unknown_invocation`，直接导致本次人猫集体误诊为"重启丢了"
- **队列边界已部分持久化，旧结论过宽**：`InvocationQueue.ts:170` 虽是内存 `Map`，但 message-backed Queue custody 已有 durable store 与 startup reconciler；`InvocationQueue.ts:68` 也明确 exact Batch Steer reservation 是进程内投影、不是第二账本。真正未闭合的是 **producer/admission coverage** 与“Queue 已取走、运行已接纳、结果尚未写回”这个 crash gap，不能靠再持久化整张 Map 解决
- **结构矛盾**：CLI `detached: true`（`GeminiAgentService.ts:1598`，故意比 API 长寿）× 凭证 env 一次性注入无重生路径
- **相邻架构对齐**：[clowder-ai PR #1356](https://github.com/zts212653/clowder-ai/pull/1356) 定义 Durable Queue / Durable Chat History / In-memory Active Runs 的三平面方向；Clowder AI 在既有 Queue、History 与 TurnExecution seam 落地相同的 accepted/result 寿命约束（[PR #3820](https://github.com/zts212653/clowder-ai/pull/3820)），不修改外部贡献者的 PR 或分支。

## What

判据（ADR-045 审查判据）：**短命/内存态引用 × 长命过程**的交叉点即家族成员。

### 家族表（收敛对象与 verdict 账本）

| # | 部位 | 短命态 | 长命过程 | 证据 | 处置 | 落地领地 | Verdict |
|---|------|--------|----------|------|------|----------|---------|
| 2 | refresh-token 机制 | 与 access 同 record | 同上 | 实证（401 风暴） | 随 #1 消解（滑动窗口消失，refresh 语义化为 no-op，端点保留兼容） | F174 新 Phase | **fixed**（[PR #3815](https://github.com/zts212653/clowder-ai/pull/3815)） |
| 3 | dispatch admission/result obligation | Queue take 后尚未产生 terminal result 的 accepted dispatch | API/provider 运行与跨重启恢复 | 代码 + F048 反例 + #1356 A20 + [PR #3820](https://github.com/zts212653/clowder-ai/pull/3820) | 收敛为 **durable Queue + minimal accepted/result witness**：Active Run 可留内存且不自动 replay，但重启必须把 unresolved accepted dispatch 确定性终结为 `interrupted/runtime_restart`，禁止无声消失 | Clowder AI Queue / History / TurnExecution seam；#1356 保持外部架构对齐 | **fixed**（[PR #3820](https://github.com/zts212653/clowder-ai/pull/3820)） |
| 4 | 诊断语义 | 60s grace 后 expired→unknown | 事后诊断（人+猫） | 实证（本次集体误诊） | 修：内联 tombstone——终态 verify 返回 derived typed reason（completed/failed/interrupted/replaced/revoked/canceled），`expired` 退役（Phase A spec §3 + Design Gate DG-2/3） | 随 #1 落 F174 | **fixed**（[PR #3815](https://github.com/zts212653/clowder-ai/pull/3815)） |
| 5 | detached CLI 孤儿 | 凭证 env 一次性注入 | detached 进程 | 结构推断（`detached:true` 实证） | 随 #1 消解：principal 活到 exact TurnExecution attempt 显式终结；API restart 后要么保持 exact principal，要么写 typed `interrupted/revoked`，不得退化成 unknown | F174（随 #1） | **fixed**（[PR #3815](https://github.com/zts212653/clowder-ai/pull/3815)） |
| 6 | hold_ball 托管承诺 | process-local command runner / Queue attempt | 跨 session 唤醒 | `DynamicTaskStore.ts` SQLite task + `ManagedCommandWakeRecoverySweep.ts` startup/30s sweep；`managed-command-wake-recovery-sweep.test.js` restart/terminal cases | 接受 runner 与 detached command 输出不跨 API 重启重挂；承诺本身由 durable task/fallback receipt 持有，重启后沿同一 messageId 重派，只有 exact handled/terminal carrier 才消费，失败不伪装成功 | hold_ball 领地 | **risk-accepted**（执行进程可短命，唤醒承诺不可静默丢失） |
| 7 | WS/EYES 订阅 | Socket.IO connection / room membership / EYES reaction | 前端会话与 GitHub review wait | F183 reconnect catch-up（active + joined background rooms、HTTP history retry/ack、Queue hydration）+ F280 persisted typed await/outcome；targeted regressions 53/53 + 28/28（2026-08-20） | 接受连接态短命：WS 只传 delta，断线后重入 durable messages/Queue；EYES 只做 acceptance provenance，随后等待写 canonical task state，pending outcome 可幂等恢复 | transport / F280 wait 领地 | **risk-accepted**（不把长承诺托付给 socket/reaction） |
| 8 | wake admission acknowledgement | messageId 已写入，但 `invokeTrigger` 失败被吞后仍记录 wake/cooldown | 等球猫依赖该 wake 继续工作 | `BallCustodyWakeSender.ts` / `BallCustodyProbeScheduler.ts` typed-admission regressions + [PR #3820](https://github.com/zts212653/clowder-ai/pull/3820) | 持久化 message 不等于 runtime admission：读回 canonical History body 后，只有 typed `admitted` 才写 wake/cooldown 成功；unavailable/full/throw 保持 exact item 可重试 | Clowder AI ball-custody + Queue/History seam；F233-F300 仅消费该 truth | **fixed**（[PR #3820](https://github.com/zts212653/clowder-ai/pull/3820)） |

**Verdict 词汇**：`fixed`（修掉，附 PR）/ `cased`（立案到落地领地 feat，附锚点）/ `risk-accepted`（书面接受，附理由）。三者皆可关项。

### Phase A: Auth 显式生命周期（#1/#2/#4/#5，MERGED + live activation PASS）

### Phase B: dispatch admission/result 边界（#3/#8，✅ [PR #3820](https://github.com/zts212653/clowder-ai/pull/3820)）

PR #3820 在 Clowder AI 既有 Queue、History 与 TurnExecution seam 落地三平面边界：Queue 是 not-yet-dispatched 的 durable authority，Active Run 可以是进程内执行对象；F298 只守“接纳前后必须有 durable witness，重启后 unresolved accepted dispatch 必须产出 typed terminal”这一寿命不变量，不要求 durable Active Run、不要求自动 replay，也不新建第四状态平面。#1356 仍是外部架构对齐，不是本 Phase 的合入前置。

### 与 clowder-ai #1356 的不冲突边界

| #1356 拥有 | F298 拥有 | 共同约束 |
|---|---|---|
| ingress、FIFO、batch、Queue take、History publish、Active Run 与 handoff 的业务语义 | 承载这些语义的 principal / receipt / wake reference / terminal witness 要活过所服务过程 | client/provider 产生外部效果前必须完成 durable admission；结果成功或失败都写 canonical History |
| Active Run 可留内存，重启不重建 live client，不猜 target，不自动 replay | crash 不能把 accepted promise 变成沉默 | startup 将没有 terminal result 的 accepted witness 收敛为 `interrupted/runtime_restart`；这是结果，不是第四份 workflow ledger |
| 不建 semantic task tree、receipt projection 或 reliable workflow engine | Auth 只做 derived capability lifecycle | auth tombstone 不得成为业务结果真相源；业务终态来自 History/execution owner |

若 #1356 坚持“出队后 crash 可没有任何 result，由用户自己发现并重试”，那不是实现细节，而是对 ADR-045 的显式例外：必须由 operator 书面 risk-accept，不能在 RFC 中作为无声默认。

### Phase C: 查证裁定（#6/#7，CLOSED）

两项均不需要再造持久层：`hold_ball` 的 durable task/fallback receipt 把唤醒承诺留在进程外；WS/EYES 只承担瞬时通知或 acceptance provenance，恢复分别回到 durable messages/Queue 与 F280 canonical task await。进程内执行细节允许丢失，但用户可见承诺不得静默消失，因此两项裁定为 bounded `risk-accepted`。

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
| R1 | 「这又是啥bug」——等 review 时 401 失联必须根治 | AC-A1 | test（RED-1） | [x] |
| R2 | 「不能头痛医头了，应该排查类似的可能的问题？然后列出来」 | AC-D1 | 家族表 7 项 + 判据 | [x] |
| R3 | 「数学之美和第一性原理，不要当补锅匠」——一条不变量而非 N 个补丁 | AC-D2 | ADR-045 存在且被 review 引用 | [x] |
| R4 | 「不建议归入 n 个 feat……有个 roadmap 会好点」 | AC-D3 | 单一收敛锚 + per-item verdict | [x] |
| R5 | 报错必须说真话（取消/替换/完成 ≠ 不认识你） | AC-A2/A3 | test（RED-2/3/4/5） | [x] |

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
- [x] AC-A1: active 凭证在**任意时长静默**与 Redis/AOF 重启后 verify 仍 ok；API 重启时，仍存活的 detached exact run 保持 ok，确实丢失的 run 返回 typed interrupted——RED-1/8 先红后绿（→R1，I1/I5）
- [x] AC-A2: canonical terminal 事件派生 auth tombstone reason（completed/failed/interrupted/replaced/revoked/canceled）；verify 命中终态返回精确 reason，非 `unknown_invocation`——RED-2/3/4/7（→R5，I2）
- [x] AC-A3: `unknown_invocation` 仅剩两种来源（从未存在 / 终结后 ≥GC 窗口）；`expired` 从 AuthFailureReason 退役，全部消费方（telemetry/degradation/auth-debug/system-message）grep 同步无死分支（→R5，I3）
- [x] AC-A4: 并发双终结首写胜、state 不回退——Redis-backed 真并发测试（I4）
- [x] AC-A5: F174-B detached-run 重启存活 + F048 lost-run restart terminal 两类回归都绿；refresh 端点 no-op 兼容（CLI 零改动）（I5）

### Phase B（dispatch admission/result 边界）
- [x] AC-B1: durable Queue + in-memory Active Run 边界在 Clowder AI 的 canonical Queue / History / TurnExecution seam 收敛；crash-after-accept-before-result 不 replay、不猜 target，并写 typed `interrupted/runtime_restart` result（[PR #3820](https://github.com/zts212653/clowder-ai/pull/3820)，restart/startup regressions）
- [x] AC-B2: producer 收到 typed admission receipt；message 已持久化但 invoke/admission 失败时保持 exact item 可重试，不写 wake_sent/cooldown 成功态（[PR #3820](https://github.com/zts212653/clowder-ai/pull/3820)，wake/delivery/receipt regressions）

### Phase C（查证裁定）
- [x] AC-C1: #6 hold_ball 现版持久性查证结论落表（三态 verdict 之一 + 证据）
- [x] AC-C2: #7 WS/EYES 重连兜底查证结论落表（三态 verdict 之一 + 证据）

## Dependencies

- **Evolved from**: F174（callback auth registry——Phase B 做了跨重启，本 feat 消灭"静默即死"）
- **Related**: F167（A2A/custody consumer）、F048（restart 时 persisted running → failed 的既有 terminal 先例）、F108（TTL=0 持久先例）、F261（managed job 相邻非目标）、F275（admission identity 边界）、F299（展示层）、F300（送达层）
- **External alignment**: [clowder-ai #1356](https://github.com/zts212653/clowder-ai/pull/1356)（dispatch/History/Active Run 业务架构；F298 不替代）
- **Feature close**: 2026-08-21 closed。Phase A/B/C 代码与验证全部落地，愿景守护由 @opus5（非作者非 reviewer）以 production caller trace + live runtime 实证通过。#1356 的独立 RFC 不阻塞 Clowder AI 的 AC-B1/AC-B2。

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

- Phase A: 实现 PR 走正常 merge-gate；作者与 reviewer 必须为不同个体；@codex-sol 提供事故现场证据但若参与实现则不得自审；RED 先红后绿证据必附
- Phase B/C: verdict 更新为 direct-main docs 车道，附证据链接

## Tips Contribution（F244）

tips_exempt: 纯 runtime 持久性收敛，无用户操作面变化（用户感知是"失联消失"这一负向体验的消除，无新操作可教）

## Close Gate Report（2026-08-21）

**愿景守护**：@opus5（Ragdoll Opus 5，非作者非 reviewer；作者 @fable5，Phase A 实现/证据 @codex-sol，Phase B @codex-terra）

### 愿景三问

1. **operator最初要解决什么？** 猫在合法长等待中被系统当成死亡——凭证静默蒸发后一只还活着的猫对家里失声，且报错在撒谎（「你被时间杀了」说成「我不认识你」）。
2. **交付物解决了吗？** 是。时间不再杀凭证（active `TTL=0`），死因说真话（typed terminal disposition），且不是纸面结论——见下方 live 实证。
3. **operator体验如何？** 负向体验消除型：不再出现「猫莫名失联」。无新增操作面（`tips_exempt` 成立）。

### 证物对照表（operator experience逐字引用，均从 [thread-id] 原消息核对）

| operator experience（逐字） | 当前实际状态（代码/命令输出） | 匹配 |
|---|---|---|
| 「这又是啥bug」（msg `0001786929874915-000092`，附爪感差：等 generation 3 review 时 401 unknown_invocation） | live runtime `GET /api/debug/callback-auth`：`unknown_invocation: 0`；daemon.log 全量 `grep -c unknown_invocation` = 0（进程连续运行 9h59m，远超原 2h TTL） | ✅ |
| 「我在想我们这个不能头痛医头了，应该排查类似的可能的问题？然后列出来？」（msg `0001786930473916-000099`） | 家族表 8 项，每项含 部位/短命态/长命过程/证据/处置/落地领地/verdict；判据「短命态 × 长命过程」写入 ADR-045 可复用 | ✅ |
| 「我们要用数学之美和第一性原理，不要当补锅匠」（msg `0001786931155944-000114`） | KD-2 去掉短命性本身而非补偿它（不是调 TTL 参数第三次）；KD-4 判定滑动 TTL 安全贡献为负；三个正交关注点（身份/权限/回收）各配一机制 | ✅ |
| 「我感觉这个我们是立项成一个优化 还是怎么样？我不建议归入n个feat这样很难避免，或者有个什么roadmap会好点」（msg `0001786933071422-000134`） | 单一收敛锚 F298 + per-item verdict 账本；实现落各自然领地（F174/Queue/History seam），未拆成 n 个 feat | ✅ |
| 「我们得f298了」（msg `0001786951658593-000072`） | F298 立项（fc20d19de）+ ADR-045 立法，BACKLOG 索引在册 | ✅ |

### Live runtime 实证（Phase A，非纸面）

- runtime revision 含 PR #3815（`git merge-base --is-ancestor 9c3696128 dd64bf32c` → true）；API pid 52038 连续运行 9h59m
- `GET /api/debug/callback-auth` reasonCounts：`unknown_invocation: 0`、`invalid_token: 0`、`missing_creds: 0`、`stale_invocation: 0`；385 次 refresh-token 401 **全部**是 typed terminal：`completed: 364` / `failed: 37` / `replaced: 1`
- `expired` 已不在 reason 枚举（AC-A3 活体验证，非仅 grep）
- 语义确认：401 = 「你的 invocation 已经 completed 了」而非「我不认识你」——正是 R5「报错必须说真话」的达成态

### AC 逐条处置

| AC | 状态 | 证据 |
|---|---|---|
| AC-D1/D2/D3 | ✅ met | 家族表 8 项 + ADR-045（main 可查）+ 单一锚 per-item verdict |
| AC-A1 | ✅ met | `RedisAuthInvocationLua.ts:17-20` HSET+PERSIST；verify 路径 `:77-80` 主动 `HDEL expiresAt`+PERSIST；backend 全文零 `pexpire/expire` 调用 |
| AC-A2 | ✅ met | `CallbackAuthTurnExecutionProjection.ts:4-19` derive；production 链路 `index.ts:669` → 12 处注入 → `invoke-single-cat.ts:4901` / `queue.ts:198` / `index.ts:5390,5393` |
| AC-A3 | ✅ met | `shared/src/types/callback-auth-reasons.ts:14-29` 无裸 `expired`；消费方由 TS `Record<Reason,…>` 穷举强制；live snapshot 佐证 |
| AC-A4 | ✅ met | `COMMIT_AUTH_TERMINAL_LUA:87` `if state ~= 'active' then return 'already_terminal'` 首写胜 |
| AC-A5 | ✅ met | `startup recovery` + `TurnExecutionStartupReconciler.ts:55-60`；refresh 端点保留兼容（CLI 零改动） |
| AC-B1 | ✅ met | 完整 production 链 `index.ts:6922 main()` → `:5386` → `:5409-5423` → `StartupReconciler.ts:410` → `QueuedMessageCustodyRuntimeRestartAttempts.ts:33,43,55` 三分支均写 `interrupted/runtime_restart`；`queued-message-custody.ts:462` 端口层强制该 reason；`QueuedMessageCustodyRestartTargets.ts:141-172` witness 驱动，不 replay 不猜 target |
| AC-B2 | ✅ met | `BallCustodyWakeSender.ts:77` 唯一 `admitted` 构造点；`BallCustodyProbeScheduler.ts:176-187` 非 admitted 直接 return，**先于** cooldown(`:186`) 与 wake_sent(`:194-203`)；production caller `index.ts:6466-6482` |
| AC-C1/C2 | ✅ met | #6/#7 bounded `risk-accepted` + 证据（hold_ball 15/15、F280 28/28、reconnect 53/53） |

**targeted 回归**：259/259 pass（f254-queue-restart-custody / ball-custody-wake-sender / ball-custody-probe-scheduler / f298-phase-b-reconciler-structure / scheduler-delivery / queue-processor），隔离 Redis runner，未触碰 6399。

**unmet AC**：无。无 follow-up / deferred / stub 尾巴。

### 守护猫 P2 观察（非 blocking，已登记不留尾巴）

| # | 观察 | 处置 |
|---|---|---|
| P2-1 | MCP `refresh-loop.ts:98-102` 拿到 typed terminal reason 后只 `console.warn` + 固定 `FALLBACK_DELAY_MS` 重试，不自停 → 已终结 invocation 的 refresh 循环 10h 内产生 385 次 401 噪声。服务端说了真话，客户端没听。 | 不违反 ADR-045 不变量（承诺没丢，是死亡通知未被消费），属降噪 debt。已在此登记为 **已知行为**，不新建 stub feat；若噪声影响诊断由 F153 观测驱动再立项 |
| P2-2 | `callback-auth-debug.ts:61` zod enum 与 `callback-auth-system-message.ts:93` `REASON_DESCRIPTIONS` 是手写子集（缺 4 个 `agent_key_*`），不受 TS 穷举保护 | 新增 reason 时会静默漏；属 F174 auth 领地的类型收紧机会，非 F298 不变量范围 |
| P2-3 | `GeminiAgentService.ts:1595-1601` detached antigravity 走 `antigravitySpawnFn` 绕过 `spawnCli`，无 owner manifest → 不进 `protectedInvocationIds`，重启时被无差别 terminalize | **不违反本 feat 承诺**（拿到 typed `interrupted` 而非 `unknown_invocation`，R5 达成）；孤儿进程治理属 CLI 进程所有权领地 |
| P2-4 | Phase B（PR #3820）尚未进 runtime（`git merge-base --is-ancestor ca7c092ae dd64bf32c` → false） | runtime 同步是operator的活（CAFE-INCIDENT-20260601），不阻塞 close；如实记录为「已 merged，live activation 待 runtime 同步」 |

### Harness Eval Checkpoint（F192）

`harness_feedback: none` — reason: 本 feat 是 runtime 持久性收敛，不改变猫猫行为模式（无新 skill / MCP tool / shared-rules / SOP 变更）；ADR-045 的审查判据是确定契约类教学，由 review 引用承重，未触发 Eval Contract 门禁。

**Verdict：愿景守护 PASS，Feature closed。**
