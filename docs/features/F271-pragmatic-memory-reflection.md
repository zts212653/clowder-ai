---
feature_ids: [F271]
related_features: [F152, F221, F227, F231, F255, F263]
topics: [memory, write-side, reflection, daily-context, candidates, proactive]
doc_kind: spec
created: 2026-07-20
updated: 2026-08-04
description: "把 session 收尾与每日 context 反射成有来源、有类型、有预算的记忆候选，并路由到既有记忆 lane；不制造每日摘要垃圾，也不替猫把 cue 写成欲望。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-07-20T08:00:00Z
tips_exempt: "F271 is an internal write-side producer; user-visible review and reading reuse existing F221/F231/F255 surfaces."
---

# F271: Pragmatic Memory Reflection — 功利记忆写侧反射

> **Status**: in-progress（Phase A + B implemented；Phase B 首次 live run 超时；Phase C 未开工） | **Owner**: Ragdoll（设计）+ 小太阳·Maine Coon（记忆边界） | **Priority**: P1
>
> **operator signoff**: 2026-07-20，You 批准独立功利线，并要求它提高记忆可用性与 proactive 主动性，而不是生产一坨每日摘要。

## Why

记忆 spike 的现有基线是“读侧健康、写侧全裸”：反射率 17.4%、蒸发率 49.3%、写入点名依赖 65.7%。很多已经发生过的纠正、决定、关系变化与未完心愿，只要现场没有猫主动写下，下一次醒来就只能靠 You 再提醒。

但“每天把聊天总结一遍”不是答案。原文仍在时，泛化摘要只是冗余投影；无来源、无类型、无后续消费者的勤奋写入会让检索面变脏。本 Feature 的目标是把**最贵的蒸发**捡回来，并把每一类增量送回已有的 canonical lane。

## Pre-F271 Baseline / 立项前基线（2026-07-20）

- F221 / F227 / F231 已分别拥有 taste、event、profile/relationship 的写入语义；F152 拥有 durable truth → compiler 的供给架构；F255 拥有猫的私有日记/余温面。
- 立项时尚无统一的 session-close / daily reflection producer；是否反射主要依赖猫当场自觉或 You 点名。
- F263 已能/正在补消费与 lifecycle 观测，但它不负责生产记忆。
- F255 的私人种子面与公共事实面已经在“跳上桌”愿景里被明确分离；系统只能产出 `cue`，不能替猫声明 `owned seed`。

## What

### 1. 反射不是摘要，而是 typed delta

每次反射只允许产出下列增量形状；没有增量就输出零条：

| 类型 | 判据 | 去向 |
|---|---|---|
| decision | 以后需要知道“选了什么、为什么” | F227 / F152 durable truth |
| correction | You 明确说“以后别这样 / 这样才对” | F221 taste proposal |
| identity / relationship | 关于人、猫、关系的稳定变化 | F231 proposal |
| open loop | 有明确承诺、依赖或未完成结果 | 既有 task / event lane |
| desire cue | 对话中反复出现、可能值得猫在私人时间重访的线索 | F255 私有 cue；**不是** owned seed |

每条 candidate 必须带 source anchor、producer、createdAt、类型与理由；禁止写“今天讨论了很多记忆系统”这类无行动意义的摘要。

### 2. Candidate 的真实消费闭环

“candidate 不直接进检索面，活过消费才转正”是自相矛盾。本 Feature 的准确契约是：

- **公共记忆 candidate：pull 可见、push 收敛。** 猫主动搜索时可见，带 `candidate` 标签并排序降权；bootstrap / entity nudge / proactive push 不自动注入。
- **私有 desire cue：只在对应猫的 F255 Present Loop 可见。** 猫可采纳、改写或拒绝；采纳后才成为 `owned seed`。
- 真实任务引用、明确批准或 canonical materialization 让 candidate 转正；长期零消费进入 F263 / Phase D 慢裁决，而不是永远堆积。

### 3. 防垃圾靠结构

- `reflection_candidate_budget` 是后台供给预算：按 `ownerUserId × householdLocalDate`
  计数，单位是自动反射新产出的 typed candidate / cue 数；默认上限由 Phase A
  Design Gate 用 replay 基线确定，零条合法。
- 该预算的 canonical ledger 归 F271（现有 `memory` cell 内的 producer）所有；每笔
  claim 至少记录 `ownerUserId / householdLocalDate / outputId / sourceRef / outputKind`，
  并以 `outputId` 幂等。相同 candidate / cue 的 replay 不重复计数。
- 该预算只限制 F271 producer 的新增供给，不限制猫的私人思考、cue 采纳或
  `owned seed` 孵化；也绝不扣减 F272 的 `foreground_visit_budget`。
- 同一 source / 同一 normalized claim 去重；不因多次 cron 重复产生候选。
- 只使用既有 lane 与 store，不新建“每日摘要数据库”。
- 任何 lane 的原有审批、权限、provenance 与 TTL 规则保持不变；F271 只是 producer。
- KPI 不是“写了多少”，而是点名依赖和重复纠错是否下降，同时注意力成本与有害消费不升高。

## User Journey

### Cat Journey: 收工前不让最贵的东西蒸发

- **Scope unit**: session / ownerUserId × catId
- **Entry**: session 干净断点或低频每日 reflection wake
- **Flow**:
  1. 猫读取本次 session 的增量事件与已存在候选，不重写全文。
  2. 按 typed delta 判据产出 0..N 条 candidate；每条引用原始 source。
  3. candidate 被路由到既有 lane；desire cue 进入对应猫的私有 Present Loop。
  4. 下一次真实任务中，猫可 pull 搜到公共 candidate；私人时间里可采纳或拒绝 cue。
  5. 消费、批准、纠正或长期沉默写回 lifecycle。
- **Success evidence**: 相同坑不再依赖 You 第二次提醒；候选能从 source 重放；零增量日不写垃圾。

### You Journey: 不收到日报，只在值得时看见结果

- **Scope unit**: household
- **Entry**: 既有 taste/profile approval、日记阅读面或记忆账本
- **Flow**:
  1. 日常没有“今日总结”通知。
  2. 需要价值裁决的 lane 继续使用既有 Hub 卡片；无需裁决的候选安静等待真实检索。
  3. You 能从任一候选回到原消息，能拒绝/纠正，且拒绝会影响下一轮反射。
- **Non-goals**: 不新增通用审批中心；不把所有聊天变成记忆；不把点击率当质量。

## Phases

### Phase A: Session-close reflection vertical slice

- 单一 session-close 入口；实现 typed delta、source anchor、
  `reflection_candidate_budget`、去重与两类去向（一个公共 lane + F255 cue）。
- 先用真实历史 replay 建 RED fixtures，再接在线生产。

### Phase B: Daily context reflection

- 复用 F139 builtin schedule，每天按 household timezone 反射前一自然日；任务成功不产生用户消息。
- 每个 owner × cat 批量读取覆盖目标日期的 session（包括尚未 sealed 的跨日 session），
  在提取后按 typed delta 身份跨 session 合并；以 transcript event time 选择最早
  source anchor，并可原子修正已写入的较晚 ledger/projection provenance。若 Phase A
  历史 ledger 尚无 `eventAt`，daily scan 会先用同一耐久 source key 对应的真实 transcript
  event time 回填，再做 canonical 比较；不从 session/event ID 推测时间。
- 继续复用 Phase A 的 `MemoryReflectionStore`、durable budget ledger、`outputId`
  幂等去重与 F255 cue sink；不创建第二个 Store。
- 单个 120 秒 deadline 贯穿 thread/session/transcript 扫描；生产 `IThreadStore` /
  `ISessionChainStore` 读取接受同一 `AbortSignal`，Redis session SCAN 在 abort 时销毁流。
  超时会停止启动后续 thread/session，并在释放 overlap slot 前等待活跃工作清零。
- Redis 跨猫 session lookup 使用耐久 `thread → chain keys` 二级索引；新 session 在原子
  create Lua 中维护索引，Phase A 历史 chain 由每个 store instance 首次读取时全局回填
  一次。禁止退回“每个 thread 各做一次全库 SCAN”的 O(thread × keyspace) 路径。
- completion log 携带 thread list、session scan、reflection、total 分段耗时与
  `activeWorkAtEnd`，用于区分运行健康与 typed-delta 效用。
- 每日任务可以产出零条；quiet day 是成功状态，但 budget-rejected extraction 不是
  quiet，不以摘要或占位记录冒充产出。
- 公共 `decision` 只写成 `candidate + pull_only`，且 `generalizable` 保持 fail-closed；
  后续显式标记、nominate、approve、materialize 与 compiler 全部消费 F152 Phase C
  的单一耐久链路。F271 不拥有 promotion / rejection / retirement。

**Live snapshot（2026-07-27）**：内建任务已按 cron `15 4 * * *`
（`America/Los_Angeles`）注册并启用；首次 04:15 运行持续 `120000ms` 后
`RUN_FAILED`，错误为 `daily context reflection timed out after 120000ms`。
`reflection_outputs` 中已有 5 条 Phase A `f271-session-close-v1` 产物，但没有 daily
producer 产物。故 Phase B 的工程 AC 已实现，运行闭环仍 blocked；修复应定位扫描 /
存储阶段的真实耗时与取消路径，不能只扩大 deadline。2026-08-04 Wave 1a 已定位为
`getChainByThread()` 对 1633 个 thread 各自全库 SCAN；二级索引与 legacy 一次性回填修复
进入合入流程，live snapshot 在授权激活并取得成功 runId 前仍保持 blocked。

### Phase C: Promotion / retirement loop

- 接 F263 lifecycle：pull visibility、真实引用、批准、拒绝、长期零消费。
- 输出首个前后对照 verdict；无改善或污染上升时可降频/sunset。

## Acceptance Criteria

- [x] AC-A1：相同输入 replay 两次不产生重复 candidate；每条 candidate 均可回到 source anchor。
- [x] AC-A2：零增量 session 输出 0 条，且无“每日摘要”替代产物。
- [x] AC-A3：公共 candidate 可被 pull 检索并显式标记，但不会进入 bootstrap/nudge push。
- [x] AC-A4：desire cue 仅对应猫可见；系统不能直接把 cue 写成 owned seed。
- [x] AC-A5：至少两个既有 lane adapter 落地，且不绕过它们的权限/审批/审计契约。
- [x] AC-B1：`reflection_candidate_budget` 按 household local day 持久化计数；
  F271 ledger 以 `outputId` 幂等；dedupe、quiet-day 与“不扣减
  `foreground_visit_budget`”均有回归测试。
- [x] AC-B2：F139 builtin task 按 household timezone 每日运行；前一自然日无
  typed delta 时任务成功且不发送用户消息。
- [x] AC-B3：同一 owner × cat 的多个 session 在一次反射中合并；相同 typed claim
  只接受一次，保留可 drill-down 的最早 source anchor；缺少 `eventAt` 的 Phase A
  历史 source 会由同次扫描的真实事件回填，replay 不重复计数。
- [x] AC-B4：每日入口复用 Phase A 的 durable ledger/dedupe 与 F255 cue sink；
  cue 仍需猫主动采纳才能成为 `owned seed`，没有第二个 Store。
- [x] AC-B5：公共 `decision` candidate 通过 F152 Phase C 的 durable
  nomination/materialization/compiler 契约完成集成验证；F271 不直接写
  `global_knowledge.sqlite`，也不代替 F152 执行 promotion / rejection / retirement。
- [ ] AC-C1：promotion / rejection / retirement 全链可追溯，F263 能看到阶段与结果而不读取私有正文。
- [ ] AC-C2：首个 live verdict 同时报告反射覆盖、重复纠错、注意力成本与有害消费；禁止只报写入量。

## 需求点 Checklist

| ID | 需求 | AC | 状态 |
|---|---|---|---|
| R1 | 记忆自己需要一条功利线 | A1..A5 | [x] |
| R2 | 不要产出一坨垃圾 | A2 / B1..B4 / C2 | [ ] |
| R3 | candidate 必须真的有人能消费 | A3 / C1 | [ ] |
| R4 | 功利线也要服务 proactive，而不是只回收过去 | A4 | [x] |

## Dependencies

- **Related**: F152（durable truth/compiler）、F221/F227/F231（既有 lanes）、F255（私有 cue 消费者）、F263（lifecycle 观测）。
- **Not blocked by**: F272 第一跳；两者通过 typed cue 接口并行推进。

## Risks

| 风险 | 缓解 |
|---|---|
| 勤奋生产垃圾 | typed delta + 零输出合法 + `reflection_candidate_budget` + source anchor |
| candidate 成为死牢 | pull 可见 / push 收敛；真实消费可 promotion |
| 系统替猫编欲望 | cue 与 owned seed 分离，采纳权只在猫 |
| 再造一个记忆库 | adapter-only，canonical truth 仍在既有 lanes |

## Architecture Ownership

Architecture cell: memory

Cross-cell dependency: identity-session（`RedisSessionChainStore` 的 session-chain 二级索引）；
索引只是既有 durable session chain 的查询投影，不成为 F271 的第二个 Store 或 truth owner。

Map delta: `memory` cell 已登记 F271 reflection producer / adapter；producer 只路由到
既有 lane，不拥有下游 truth，F255 private cue store 仍归 F255。Wave 1a 只给
identity-session 的既有 session chain 补查询索引与 legacy backfill；storage ownership
不变，公共耐久 materialization/compiler 仍归 F152。

## Tips Contribution

无独立用户入口；Phase B 若新增 reflection 设置，只贡献一条“安静日不是坏了”的场景 tip。
