---
feature_ids: [F282]
related_features: [F276, F221, F188, F255, F272, F281]
topics: [proactive, memory, nudge, entity-detection, source-bundle, preflight, cold-start]
doc_kind: spec
created: 2026-07-30
description: "记忆 proactive 生产端：机械频率检测层给在场猫供数据，typed 证据契约与 preflight 修提案质量，冷启动策略破提议沉默螺旋。"
description_source: human
description_author: fable-5
description_updated_at: 2026-07-30T20:53:00-07:00
tips_exempt: "Phase D adds cat-side proactive-memory judgment and content-free abstention, not a standalone owner UI. The owner-facing journey remains the existing F276 rejectable Approval Hub card; discovery remains covered by feature-f276-private-person-memory."
---

# F282: Proactive Memory Pipeline（记忆 proactive 生产端）

> **Status**: done | **Completed**: 2026-07-30 | **Owner**: 小太阳·Maine Coon (@codex-sol, GPT-5.6 Sol) | **Priority**: P1

Architecture cell: `memory`

## Why

记忆 proposal 系统当前双向失败：**该提的没人提**——operator 原话（2026-07-30，[thread-id]）：

> "比如我提到一个人的名字比如alden 为什么从来没有猫要把他记录下来呢？这个是为什么？是我们的接入端出现了什么问题吗？……其实他已经出现在好多地方了"

**提了的当时进不去**——周玉晶两张 F276 卡连拒：当时证据契约只收 same-thread 文字摘录，截图/外部对话/owner 私域整理等真实人生事件无法诚实进入系统（2026-07-30 平行 thread 失败样本分析）。该历史断点随后由 F282 Phase B/C 与 F276 PR #3286/#3296/#3326 闭合：pending 卡可原子替换/撤回，且当前对话中的卡可绑定其他 owner-visible thread 的精确 owner 来源。

根因不是猫的态度，是结构：① 检测靠无状态的在场猫 = 让没有跨 session 眼睛的存在负责看路（"Alden 出现在好多地方"只有系统看得见，单次 invocation 的猫只看见一次）；② L0 已有 4 条 propose 常驻提醒仍漏 Alden——静态规则打不过眼前主任务，证明"再加提醒"边际无效；③ 提议有立即成本、沉默零成本且不可见，激励结构教猫沉默；④ 提议少→功能不可见→无反馈→更少的冷启动死亡螺旋（operator："如果你非常保守谨慎，除了我开发这个功能的人之外，其他人可能根本不知道你有这个功能"——社交甜甜圈可见性问题）。

方案坐标系（本 feat 的立场）：**检测归系统（零智能统计），判断归在场猫（全上下文），授权归operator（审批）**。这是 KD-8"给数据不给结论"的实施——被 operator 否决的是后端小模型做**判断**（效果差），机械**检测**不含判断，一个倒排索引就能做。

## Current State / 立项基线与落地后真相

- 立项时 L0 §8 已有 profile/taste/entity/person 4 条 propose 常驻提醒，Alden 案例证明静态触发失效；Phase A 后改由 canonical owner-message timeline 做 lane-neutral 跨 thread 检测，判断仍归在场猫
- 立项时 entity 动态 nudge 只服务 entity 登记场景、无跨 thread 频率统计，person 场景无 nudge；Phase A 已补 person 候选扫描，taste 因无可频率检测的命名键仍只走在场判断（KD-5）
- F276 证据契约已支持 typed source bundle：卡片保留在当前 thread，证据可引用任意 owner-visible thread 的精确 owner 消息并 drill 回真实来源；跨 owner、cat-authored、connector、删除/未送达、摘录或 digest 漂移均 fail closed。attachment / owner-confirmed transcript / owner-private artifact 由 F282 Phase B 契约覆盖
- Phase C 已在 durable stage 前加入 source/materializability/card completeness 预检；已知业务限额返回可行动错误，不再以 500 或压掉叙事规避预算
- pending proposal 已有 immutable complete-snapshot replacement 与 withdraw：语音转写错字（`Agent Refractor` → 正确 `AgentReflex`）可在不新增“纠错事件”、不丢未改字段的前提下原子替换旧卡（F276 PR #3286）
- 工具描述与 `proactive-memory-judgment` 已要求先判 source eligibility、无合格来源时 abstain/降档表达；不得生成零信息卡或把纠错本身建模成新事件
- 拒因 envelope 与有界回流归 F281 管辖；F282 只消费其契约，不维护第二份反馈账本

## What

### Phase A: 机械检测层（Alden 修复）

- 跨 thread 词组/人名频率统计：纯倒排索引 + 计数（**零智能、零判断**），检测"高频出现 × **不在可精确查询的 registry 集**"的 **lane-neutral 候选**。registry 集 = entity alias registry ∪ person identity root ∪ pending/dormant candidate 去重集——**不声明"无任何 lane 记录"**（taste 无可查询键，机械层证明不了全称否定；Sol review 复审修订）
- **lane 分类归在场猫**（Sol review P1-2 修订）：机械层无法、也不尝试判断候选属于 person / entity / taste——它只报告"重复未登记的词组候选 + 出现坐标"；在场猫拿完整上下文分类并决定走哪条 propose lane。**taste 不在频率检测范围内**——品味判断没有命名键，"未登记的 taste"无法用词组匹配定义，taste 的发现只走在场判断路径
- nudge 注入在场猫 context（形态复用现有 entity nudge / freshness notice 载体）：只报统计事实（"X 近 7 天出现于 N thread M 条消息，无记录"），**不预填 lane、不预填"应该记录"结论**
- **隐私分区是实施前硬约束**（从 OQ 升级）：私密 thread / owner-private 内容是否计入频率、nudge 中可引用哪些坐标，实施前必须定并有负向测试（AC-A4）
- 已拒绝候选进 dormant（复用 F272 seed dormant 语义），不重复骚扰
- 定位：第一道防线仍是猫在场判断（单次出现就该判，频率不定义重要性）；检测层是**兜底捞漏网**的第二道防线

### Phase B: 证据契约扩展（周玉晶修复）

- typed source bundle 替代裸 `message.content` excerpt，至少区分：`message_text`（owner 原话）/ `message_attachment`（附件坐标 + digest + bounded transcript/OCR）/ `owner_confirmed_transcript`（猫整理、owner 明确确认）/ `owner_private_artifact`（私域文件 digest/anchor + owner 确认）
- assertion role 分层：`reported_fact / user_assessment / quoted_third_party / agent_inference`——inference 不可直接 materialize；owner 事后评价只能进 `user_assessment`，不能洗成事件事实
- 共同 guard：来源只能证明它实际支持的 claim/field；无合格来源时不生成审批卡，改为出短 draft 请 owner 确认
- 设计输入：Maine Coon 2026-07-30 平行 thread 反思（typed bundle + 收敛坐标全文）

### Phase C: preflight + pending 生命周期

- 同一次 authenticated propose 内，在首个 durable `stageCandidate()` 前对 source/materializability、
  informed-approval completeness 与**最终同一张** Approval Hub card 做预检；已知业务限额返回
  additive、机器可判且不泄露 source/digest/locator 的 actionable error（不是 500）
- pending proposal 的“编辑”实现为 immutable complete-snapshot replacement：新卡先通过完整
  preflight 并成功锚定，再原子撤回旧卡；可在 1–3 items 内增删改，省略项不 carry over，
  不把纠错建模成 interaction event，也不创建 dormant suppression。原有 withdraw 入口继续可用
- typed interaction 在聊天卡和 Approval Hub 按 source 聚合展示 bounded excerpt、target fields、
  source kind、assertion roles 与 confirmation scope；私域 artifact 只 drill owner confirmation，
  不投影 locator

### Phase D: 冷启动策略 + L0 偏置翻转 + 第一道防线

- 冷启动期显式 recall 优先于 precision（宁多拒几张卡，不许功能静默）+ **显式退出判据 = 多维约束向量**（coverage 不塌 + FP/污染预算内 + 审批负担可承受，Sol review P1-3 修订）——接受率单指标会奖励"只提最安全的"式躺平（度量系统 v0.1.2 约束优化同款结论：coverage 0 直接判退化），estimator 细节走 eval-design 出生证
- L0 偏置文案："不确定 → 降档表达"替代默认沉默；低副作用可拒绝提议漏报=掉球、被拒=校准数据
- **第一道防线制度化**（Sol review P1-2 补）：单次出现的 continuity-valued delta 走主动介入漏斗（甜甜圈资格→证据→时机→授权→降档表达），配 skill 展开与 AC-D3 fixture——频率检测只是第二道兜底，"一次就重要"必须有自己的验收
- **时序硬约束**：本 Phase 在三项齐备后启动——F281 **有界**回流（AC-C2）+ 本 feat Phase B（证据契约）+ Phase C（preflight/pending 生命周期）。激励结构与提案通路不先修好，翻偏置 = 鼓励猫往窄门里撞（重演周玉晶）或重蹈"第五条提醒失效"（见 KD-3）

## User Journey

### Primary Journey: 反复提到的人自然获得一张提议卡
- **Scope unit**: workspace
- **Actor**: operator + 在场猫
- **Entry**: operator在任意对话中第 N 次提到未登记人名（如 Alden）
- **Flow**:
  1. 检测层发现"Alden 跨 2+ thread 出现 ≥阈值，不在 registry 集（entity alias / person identity root / pending·dormant candidate）" → 在场猫 context 收到 lane-neutral 统计 nudge
  2. 猫结合当前上下文**判断 lane（person）并判断值得记** → 发 person proposal（合格 source bundle）
  3. operator在 Approval Hub 一键批准，或带拒因拒绝（F281）→ 拒因回流校准下次提议
- **Success evidence**: Alden 检测路径端到端复现；F276 PR #3326 补齐“当前 thread 发起 + 其他 owner-visible thread 精确来源 + 卡留当前 thread + drill 回原来源”的工程 E2E。真实 owner 审批后再 `recall_person_relationship` 的 UAT 仍归 F276，不冒充 F282 close 证据
- **Non-goals**: 系统不替猫判断"值得记"；无 nudge 洪水（阈值+上限+dormant）；不做后台批量抽取

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|----|------------|-------|------|----------|
| S1 | message | 猫猫 | 提案含截图证据 → typed attachment bundle 合法通过（今日会 400 的场景） | 周玉晶场景重放 |
| S2 | workspace | operator | pending 卡有错字 → 猫一步替换修正，无需拒了重提 | AgentReflex 场景重放 |
| S3 | workspace | operator + 猫猫 | 在当前对话请求 Alden 人物卡，引用其他 owner-visible thread 的精确 owner 消息；卡留当前对话，来源 drill 回原 thread | F276 PR #3326 Alden 跨 thread route E2E |

## Acceptance Criteria

<!-- 每条 AC trace 回 Why：检测断（A）、契约窄（B）、生命周期缺（C）、激励冷启动（D）各有硬验收 -->

### Phase A（机械检测层）
- [x] AC-A1: 不在 registry 集（entity alias ∪ person identity root ∪ pending/dormant candidate）的词组跨 ≥2 thread 出现 ≥阈值后，在场猫 context 收到 **lane-neutral** nudge（端到端复现脚本，Alden 场景；registry 查询条件本身可独立验证）
- [x] AC-A2: KD-8 合规——nudge 内容只含统计事实与坐标，**不含 lane 预判**、不含"建议记录"类预填判断（review + fixture 断言）
- [x] AC-A3: 已拒绝候选 dormant 生效——同一候选被拒后不再重复 nudge（复现验证）
- [x] AC-A4: 隐私分区负向测试——私密 thread / owner-private 内容按已定分区规则排除或脱敏，nudge 中不泄露私域坐标（实施前规则落 spec，测试可复现）

### Phase B（证据契约）
- [x] AC-B1: attachment / owner_confirmed_transcript 类证据合法进入 proposal（周玉晶场景重放通过）
- [x] AC-B2: assertion role 分层落地——`agent_inference` 不可直接 materialize（负向测试）

### Phase C（preflight + 生命周期）
- [x] AC-C1: token/materializability 预检在提交前返回可行动错误（超预算场景不再 500）
- [x] AC-C2: pending proposal 可编辑/替换/撤回（AgentReflex 错字一步纠错复现）

### Phase D（冷启动 + 偏置 + 第一道防线）
- [x] AC-D1: 冷启动退出判据为**多维约束向量**（coverage 不塌 + FP/污染在预算内 + 审批负担可承受），非接受率单指标；estimator / validity bounds / 样本量契约走 eval-design 出生证（Design Gate 完整化），参数写入运行配置可查（非口头约定）
- [x] AC-D2: L0 偏置文案合入（前置**三项齐备且时序证据留档**：F281 有界回流 AC-C2 生效 + 本 feat Phase B 证据契约生效 + Phase C preflight/pending 生命周期生效——激励与提案通路先修好，再鼓励多提）
- [x] AC-D3: **单次但重要**第一道防线验收——单次出现的 continuity-valued delta（无频率信号）场景 fixture：在场猫走"甜甜圈资格→证据→时机→授权→降档表达"漏斗，产出**最小结构化 opportunity episode**：`opportunityRef + disposition(propose|abstain) + reasonCode`。abstain 必须有 record 才算 calibrated abstention；无 proposal 且无 abstention record = `uninformed_silence` = **fixture 失败**（防"任何沉默都解释成通过"，对齐度量系统 v0.1.2 TN 三分类）。不记录私密推理正文。覆盖 operator 原话"不是反复三次才重要"（与 AC-A1 频率路径互补）

## Eval / Tracking Contract（Phase D Design Gate 已锁）

> 权威出生证：`docs/eval/f282-phase-d-cold-start-opportunity.md`。冷启动退出只消费
> coverage / FP·污染 / 审批负担的原始约束向量；采集覆盖与延迟属于 observability
> （F153），不进 eval。禁止接受率单指标——它会奖励“只提最安全的”式躺平。

- **Primary Users**: 在场猫（nudge 消费 + 提案侧）+ operator（提案接收侧）
- **Activation Signal**: nudge → proposal 转化发生（>0）；此前无法发出的证据类型成功进卡
- **Friction Metric**: nudge 无视率持续 100%（注入形态无效）；污染型 FP（错误事实进卡）单列且权重最高（度量系统 A3 非对称损失）；审批负担（卡/周）超预算
- **Regression Fixture**: Alden 场景（检测→lane-neutral nudge→猫分类→proposal；F276 PR #3326 另覆盖当前 thread 卡绑定跨 thread owner 来源）+ 周玉晶场景（typed bundle 过卡）+ AgentReflex 场景（pending 纠错）+ **单次但重要场景**（无频率信号，猫走漏斗提议，AC-D3）。owner 实际审批与 recall 验证是 F276 UAT，不计作本 feat 已完成的工程 fixture
- **Sunset Signal**: operator 关闭 nudge；或约束向量持续违约（样本量契约内）且 tune 两轮无效 → 检测参数或注入形态重设计
- **Consumer**: 冷启动退出决策（AC-D1 约束向量）+ 检测阈值 tune；账本数据服务设计者，**不回灌猫侧 KPI**（F281 KD-3 同源）

## Dependencies

- **Evolved from**: 2026-07-30 proactive rules 讨论（[thread-id]）+ 《主动性研究地图》（2026-07-06，三公理/介入深度谱）+ 《Proactive 度量系统 v0.1.2》（2026-07-10）
- **Blocked by**: 无全局 blocker（Sol review 修订：Phase A/B/C 与 F281 无依赖可独立推进）。局部依赖：本 feat 的 reject adapter 消费 F281 feedback envelope schema（仅 schema，非 F281 全部完成）；**Phase D 硬前置** F281 有界回流 + 本 feat B/C 齐备（见 Phase D 时序硬约束）
- **Related**: F276（person memory 域，Phase B/C 主要落点）、F221（taste lane——**只走在场判断路径，不进频率检测**）、F188（记忆基建）、F255 / F272（proactive 谱系；dormant 语义复用）、F281（姊妹立项，按职责切分：本 feat 管 memory producer lifecycle 含裁决后 producer 撤回，F281 管 human-disposition feedback envelope/账本/有界回流；materialization 归各 memory lane）

## Risk

| 风险 | 缓解 |
|------|------|
| nudge 洪水（检测过敏感）反向惹烦 | 阈值参数化 + 每轮 nudge 上限 + dormant（AC-A3）+ Friction Metric 盯无视率 |
| 检测层被做成"小模型判断"违反 KD-8 | AC-A2 合规验收：只报统计不报结论 |
| 冷启动 recall 优先变永久撒网（initiative drift 反向） | AC-D1 约束向量退出判据（非接受率单指标）；episode 账本（F281）趋势供设计者监控 |
| L0 偏置先于激励结构与提案通路落地，重蹈"第五条提醒失效"或赶猫撞窄门 | AC-D2 硬前置**三项齐备**（F281 有界回流 AC-C2 + 本 feat Phase B 证据契约 + Phase C preflight/pending 生命周期）；时序证据留档 |
| Phase B 契约扩展被误用为放开任意文件洗证据 | assertion role + owner 确认 guard；`agent_inference` 不可 materialize（AC-B2 负向测试） |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 与 F281 **按职责切分**（Sol review 修订，替代最初的时序切分）：本 feat 管 memory producer lifecycle（候选发现/证据/预检/pending 生命周期，含裁决后的 producer 撤回），F281 管通用 human-disposition feedback envelope/账本/有界回流；materialization 归各 memory lane | 时序切法有反例（producer 撤回发生在裁决后仍属 producer 侧）；operator 2026-07-30 拍板拆二 | 2026-07-30 |
| KD-2 | 三层分工：检测归系统（零智能）/ 判断归在场猫 / 授权归operator；**lane 分类属于判断**，归猫不归检测层 | 破除"后端模型抽取 vs 在场猫主动"假二分；KD-8 给数据不给结论；无状态猫看不见跨 session 频率；统计判不了 person/entity/taste（Sol review P1-2） | 2026-07-30 |
| KD-3 | L0 偏置翻转排在激励结构（F281 有界回流）**+ 本 feat B/C 提案通路**之后 | L0 已有 4 条提醒仍漏 Alden 的实证：激励不改文案无效；通路不修，鼓励多提=赶猫撞窄门（Sol review 扩展前置） | 2026-07-30 |
| KD-4 | 检测是兜底第二道防线，不替代猫在场单次判断；"单次但重要"路径有独立验收（AC-D3） | operator"不是反复三次才重要"——重要性判断单次就该做；频率只标注漏网概率 | 2026-07-30 |
| KD-5 | taste lane 不进频率检测 | 品味判断无命名键，"未登记的 taste"无法用词组匹配定义；taste 发现只走在场判断（Sol review P1-2） | 2026-07-30 |
| KD-6 | Phase D opportunity episode 由冻结 exposure cohort + 现有 ToolEventLog 纯投影，不建新 store；无结果不是 TN 而是 `uninformed_silence` | 防工具 trace 自己制造分母、防沉默洗白、避免第二份人物记忆或长期机会账本 | 2026-07-30 |

## Review Gate

- Kickoff spec: Maine Coon @codex-sol（operator 指定）
- Phase B 证据契约: 跨个体 review + F276 域对齐
- Phase D Design Gate: 狸花猫 @glm52 审阅最终 plan hash `de2dc67e8e741fe3caf29e22c4a1c025919d64f624f9d6c2393c9c1c3a1ee03d`
- Phase D implementation: 狸花猫 @glm52 `APPROVED exact HEAD 08b960089abcd31bffa60b9afb8df98d0d5284bf`
- Vision guardian: Ragdoll @fable5 `VISION APPROVED F282`（message `0001785455991548-000724-68d7c60d`）
- operator close authorization: `0001785469962796-000042-ef543202`（“把281 和 282 闭环一下的？ 不要过度sop 就行”）
