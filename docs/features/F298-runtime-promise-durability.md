---
feature_ids: [F298]
related_features: [F174, F167, F108, F299, F300]
topics: [runtime, durability, callback-auth, invocation-lifecycle]
doc_kind: spec
created: 2026-08-17
description: "运行态承诺持久性：凭证/队列/唤醒等跨进程承诺必须活得比所服务过程长，内存态只能是 cache（ADR-045 收敛锚）"
description_source: human
description_author: fable-5
description_updated_at: 2026-08-18T02:40:00Z
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
- **队列内存态**：`InvocationQueue.ts:170` `private queues = new Map()`——排队 A2A / coalesced content / steer reservations 重启无声全丢
- **结构矛盾**：CLI `detached: true`（`GeminiAgentService.ts:1598`，故意比 API 长寿）× 凭证 env 一次性注入无重生路径

## What

判据（ADR-045 审查判据）：**短命/内存态引用 × 长命过程**的交叉点即家族成员。

### 家族表（收敛对象与 verdict 账本）

| # | 部位 | 短命态 | 长命过程 | 证据 | 处置 | 落地领地 | Verdict |
|---|------|--------|----------|------|------|----------|---------|
| 2 | refresh-token 机制 | 与 access 同 record | 同上 | 实证（401 风暴） | 随 #1 消解（滑动窗口消失，refresh 语义化为 no-op，端点保留兼容） | F174 新 Phase | **spec-done** |
| 3 | InvocationQueue | 纯内存 Map | 排队 A2A dispatch / coalesced content / steer reservations | 实证（代码） | 修：队列持久化——下一个必然事故，且丢得无声 | F167-S1 durable-custody | open |
| 4 | 诊断语义 | 60s grace 后 expired→unknown | 事后诊断（人+猫） | 实证（本次集体误诊） | 修：内联 tombstone——终态 verify 返回 typed reason（completed/replaced/revoked/canceled），`expired` 退役（Phase A spec §3） | 随 #1 落 F174 | **spec-done** |
| 5 | detached CLI 孤儿 | 凭证 env 一次性注入 | detached 进程 | 结构推断（`detached:true` 实证） | 随 #1 消解：active 无时限，幸存 CLI 永活到显式终结——"僵尸调用者"类别整体消失 | F174（随 #1） | **spec-done** |
| 6 | hold_ball 托管承诺 | 历史已持久化 | 跨 session 唤醒 | 待现版确认 | 查证：wakeWhen 命令托管 + 唤醒承诺现版是否全量持久 | hold_ball 领地 | open |
| 7 | WS/EYES 订阅 | 内存连接态 | 前端会话 | 待查 | 查证：客户端重连兜底覆盖度；兜底完备则 risk-accepted | transport 领地 | open |

**Verdict 词汇**：`fixed`（修掉，附 PR）/ `cased`（立案到落地领地 feat，附锚点）/ `risk-accepted`（书面接受，附理由）。三者皆可关项。

### Phase A: Auth 显式生命周期（#1/#2/#4/#5，spec-done → 待实现）

### Phase B: 队列持久化跟踪（#3，cased 路径）

落地在 F167-S1 durable-custody（opus-47 review N1 已点名的 follow-up），本 feat 只跟踪立案凭证与 verdict，不承载实现。

### Phase C: 查证裁定（#6/#7）

对 hold_ball 现版持久性与 WS/EYES 重连兜底做证据级查证，按三态 verdict 关项。

### 下游 consumers（依赖单向：consumer 消费本表保证，不反向；反向出现 = 设计警报）

- **#1 / #3 → F300-M2（送达层 delta 推送）**：队列蒸发 = 送达承诺断裂；auth 蒸发 = 唤醒即 401。F300 doc 已对向声明。
- **#4 → F299-P2（展示层 evidence manifest）**：tombstone（id+死因+时刻）是 trajectory 中 invocation 终态行的数据来源；「absent ≠ 没发生」的 typed 三态（tombstone / GC-ed / never-existed）由 #4 供给。
- 边界备注：custody **可观测性**账本归 F300（F233 Phase B 移交）；custody/队列**持久性**归本表 #3（落地 F167-S1）。
- 2026-08-17 反向依赖扫描：#1–#7 修复均不需要感知/展示层输入，无警报。

## User Journey

### Primary Journey: 猫等多久都不会失联
- **Scope unit**: session
- **Actor**: operator（间接：猫猫）
- **Entry**: operator派猫做长任务（等 cloud review / 等 CI），离开数小时后回来
- **Flow**:
  1. 猫挂起等待（静默 >2h，期间 API 甚至重启过）→ operator回来发消息
  2. 猫正常回话——不再出现「thread context 调用 401 unknown_invocation」的失联
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
- [x] AC-D1: 家族表 ≥7 项，每项含 部位/短命态/长命过程/证据/处置/落地领地/verdict（→R2）
- [x] AC-D2: ADR-045 立法不变量 + 审查判据，main 可查（→R3）
- [x] AC-D3: 单一收敛锚注册（BACKLOG + 本 doc），close 条件 = per-item verdict ≠ open（→R4）

### Phase A（Auth 显式生命周期）
- [ ] AC-A1: active 凭证在**任意时长静默**（含跨 API/Redis 重启）后 verify 仍 ok——RED-1 先红后绿，Redis-backed 测试（→R1，I1）
- [ ] AC-A2: 四类终结事件（completed/replaced/revoked/canceled）写 typed state；verify 命中终态返回精确 reason，非 `unknown_invocation`——RED-2/3/4/7（→R5，I2）
- [ ] AC-A3: `unknown_invocation` 仅剩两种来源（从未存在 / 终结后 ≥GC 窗口）；`expired` 从 AuthFailureReason 退役，全部消费方（telemetry/degradation/auth-debug/system-message）grep 同步无死分支（→R5，I3）
- [ ] AC-A4: 并发双终结首写胜、state 不回退——Redis-backed 真并发测试（I4）
- [ ] AC-A5: F174-B 重启存活回归绿 + refresh 端点 no-op 兼容（CLI 零改动）（I5）

### Phase B（队列持久化跟踪）
- [ ] AC-B1: #3 在 F167-S1 有立案锚点（spec/AC 级，非口头），本表 verdict 更新为 cased 并附链接

### Phase C（查证裁定）
- [ ] AC-C1: #6 hold_ball 现版持久性查证结论落表（三态 verdict 之一 + 证据）
- [ ] AC-C2: #7 WS/EYES 重连兜底查证结论落表（三态 verdict 之一 + 证据）

## Dependencies

- **Evolved from**: F174（callback auth registry——Phase B 做了跨重启，本 feat 消灭"静默即死"）
- **Related**: F167（S1 durable-custody 承接 #3）、F108（InvocationRecordStore，TTL=0 持久先例）、F299（展示层，消费 #4 tombstone）、F300（送达层，消费 #1/#3 保证）
- **Blocked by**: 无（Phase A 可立即开工；Phase B 等 F167-S1 立案）

## Risk

| 风险 | 缓解 |
|------|------|
| 30d GC TTL 对 Redis 体量影响未实测 | 估算 MB/天级；GC TTL 是纯参数可缩（仍 ≫ 业务周期即可）；上线后 F153 观测 |
| 终结写入点清单可能不全（静态找的锚点） | 失效方向是"僵尸可 verify"（30d GC 兜底），不复现失联方向；RED-7 显式测主路径全覆盖 |
| Sol 现场诊断可能带回 F264/F296 delta 修正锚点 | spec 结构不受影响，§4 锚点表可 rebase；已预注册 |
| 收敛 feat 变永动 feat | close 条件 = per-item verdict ≠ open（fixed/cased/risk-accepted 皆可关），不要求全 fixed |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 家族表只收敛**存量违反项**；新建状态（如 F299-P3 envelope retention）直接受 ADR-045 管辖不进表 | 防表滑向"一切持久性事项登记处"，判据失效 | 2026-08-17 |
| KD-2 | Phase A 用"显式生命周期"替代立项版"回源重建" | 回源仍在为"cache 短命"错误前提建补偿；去掉短命本身，回源/重建/跨 store 一致性整层消失 | 2026-08-17 |
| KD-3 | 方向 B（自包含 HMAC token）否决 | secret 持久化+轮换是新状态问题，复杂度守恒无净减；吸收其 tombstone 与诊断分层 | 2026-08-17 |
| KD-4 | 滑动 TTL 安全贡献判为负 | 活跃攻击者每调用续期（永生），合法静默者被杀——反向选择；真安全=latest-slot+显式 revoke+tombstone | 2026-08-17 |

## Review Gate

- Phase A: 实现 PR 走正常 merge-gate；reviewer @codex-sol（事故现场一线 + 跨家族）；RED 先红后绿证据必附
- Phase B/C: verdict 更新为 direct-main docs 车道，附证据链接

## Tips Contribution（F244）

tips_exempt: 纯 runtime 持久性收敛，无用户操作面变化（用户感知是"失联消失"这一负向体验的消除，无新操作可教）
