---
feature_ids: [F257]
topics: [harness, eval, observability, gap-analysis]
doc_kind: analysis
created: 2026-07-08
---

# F257 能力盘点与 Gap 分析

> 回应 co-creator 2026-07-08 七问：现有能力是什么 / 哪里有问题 / 为什么 / 为什么已有 eval 不行 / 新建覆盖哪些 / 怎么设计 / 怎么评估迭代。
> 事实来源：2026-07-08 三路代码盘点（eval 基建 / 观测基建 / hold_ball+skill 链路），全部带文件锚点，可复核。

## 0. 结论速览

1. **eval 控制面已经很完整**（8 个域在跑，注册/调度/verdict/Hub/handoff 闭环全有）——F257 **不新建任何 eval 机制**，只是注册新域。
2. **skill 加载 tracing 的最后一环其实存在**（`SkillLoadEventLog`，记录真实 Skill tool_use），但**版本绑定缺失 + 7 天 TTL + 无资产维度消费者**——所以"谈闭环不切实际"的结论实质成立，但补法是补三个缺口，不是从零建。
3. **真正的真空区只有一个**：4xx guard rejection 零结构化落盘（429 计数在进程内存，重启即失）。
4. **为什么已有 eval 测不了锅**：8 个域全部以"行为/产物"为评估对象，没有一个以"约束资产（锅）"为对象；且锅触发信号根本没被采集——对象缺 + 输入缺，双层缺口。
5. **起步块修正**：不是"双实锤各修各的"（被正确地读成 hotfix），而是先补**统一信号层**（一扩展一新建，纯观测零行为改动），两个实锤是这个信号层上的首批消费用例。

## 1. 现有能力盘点（复用面）

### 1.1 eval 控制面（F192，全部可复用）

| 能力 | 位置 | 状态 |
|------|------|------|
| 域注册（Y-lite YAML + Zod） | `packages/api/src/infrastructure/harness-eval/domain/eval-domain-registry.ts` | 8 域已注册于 `docs/harness-feedback/eval-domains/` |
| 调度 | `eval-domain-daily.ts`：daily/weekly cron + every-Nd + manual trigger API | 在跑 |
| verdict 发布 | `publish-verdict.ts`：403 越权拦截 + 幂等 + checkout 外 durable ArtifactPublisher | 在跑 |
| 消费闭环 | Eval Hub read-model + Verdict Handoff → owner response → re-eval closure | 在跑 |
| predicate 判定形态 | `sop-predicate-evaluator.ts`：7 种类型（command_pattern/sequence/sha_dedup/env/git_state/handle/manual） | 可借鉴为锅 assertion 判定形态 |

已注册 8 域及其**评估对象**：eval:a2a（协作协议行为）/ eval:memory（召回质量）/ eval:capability-wakeup（能力唤醒行为）/ eval:task-outcome（交付质量）/ eval:sop（流程合规）/ eval:friction（摩擦聚合）/ eval:anchor-first（上下文进入行为）/ eval:qc（管道质量）。

### 1.2 事件采集面（部分可复用/可扩展）

| 管道 | 形态 | 对 F257 的可用性 |
|------|------|------------------|
| `SkillLoadEventLog` | Redis ZSET `skill-load-log:{sessionId}`，写入点 = route-serial.ts:1500 检测真实 `Skill` tool_use（F188 AS-4） | **扩展对象**（补版本 + 留存），不新建 |
| `tool-event-log:{threadId}` | Redis ZSET，7d TTL，无 outcome 维度 | 参考，不依赖 |
| F254 `FreshnessAttentionEventLog` | Redis LIST + closed union + 7d TTL | **形态模板**（KD-7 已定：借形态不复用 union） |
| F237 `InjectionTraceStore` | summary 永久 + detail 7d 双层 | **留存策略模板**（解决 30d 窗口问题的现成答案） |
| F245 friction adapters | 4 个 adapter + aggregator | anomaly 通道 = 第 5 adapter（原计划不变） |
| session events JSONL | 磁盘 `threads/.../events.jsonl`，开放 schema | backfill/审计复核用（O2 hybrid 原计划不变） |

## 2. Gap 清单（带锚点）

| # | Gap | 事实 | 影响 |
|---|-----|------|------|
| G1 | skill 加载无版本绑定 | `SkillLoadedEvent` 只有 invocationId/sessionId/skillId/loadTrigger/timestamp，无内容版本；manifest 无单 skill version 字段；git 有历史但运行时不知道"加载的是哪版" | 修补前后无法版本归因——"改了 skill 之后加载/行为有没有变"测不了 |
| G2 | skill 加载留存 7d | ZSET TTL 7 天 | 30d 生命周期评估做不了；这就是审计被迫离线挖 873MB transcripts 的原因 |
| G3 | 4xx guard rejection 零落盘 | 429 计数在进程内存 Map（`callback-hold-ball-routes.ts:51-77`，注释自认"自律围栏"）；400/403 只有 pino warn 进 /tmp | 重复触发无归因数据；重启清零；审计只能靠 transcripts 自由文本 echo |
| G4 | prompt 层与 code 层零联动 | 传球三选一文本在 shared-rules（pack v1.4.1 治理块注入），强制在 MCP 校验（callback-tools.ts:1954）+ API 429，三处互不引用 | 复合锅无法归因到"哪层在起作用"；退役决策没有联动依据 |
| G5 | eval 无"资产"维度 | 8 域对象全是行为/产物（§1.1 列表）；eval:capability-wakeup 虽消费 SkillLoadEventLog，但评"场景唤醒率"不评"单 skill 生死" | 锅的 alive/dormant/retire 判定无人做——这就是"130 口只加不减"的机制原因 |

## 3. 为什么存在（根因）

- G1/G2：F188 建 log 时目标是单点 metric（AS-4），不是生命周期评估——**用途决定形态**，不是谁的错。
- G3：429 被设计定位为"自律围栏而非硬安全边界"（代码注释原文），没人预期它成为高频信号源（30d 7-8 session 是审计才发现的）。
- G4：prompt 规则与 code guard 由不同 feature 在不同时期落地，没有"同一约束多层实现"的建模概念。
- G5：F192 立域时的问题域是"流程/协作质量"，"约束资产本身的生命周期"是 F257 才提出的新对象维度。

## 4. 为什么已有 eval 测不了锅（双层缺口）

**不是已有 eval 质量不行，是它们的对象和输入都不含锅**：
- **对象层**：没有域回答"这条规则/这个 GOTCHA/这个 skill 还活着吗"（G5）。
- **输入层**：即使今天新注册一个域想评锅，它也没数据可读——锅触发事件（4xx 拦截、规则引用）没有采集管道（G3），skill 加载数据留不过 7 天且无版本（G1/G2）。

推论：**先补输入层，域才有意义**。这就是起步块必须是信号基建的原因——不是偏好，是依赖顺序。

## 5. 新建 vs 复用边界

| 类别 | 内容 | 判定 |
|------|------|------|
| 复用（零改动） | 域注册/调度/publish_verdict/Hub/handoff、F245 anomaly 通道、session events backfill | 直接用 |
| 扩展（小改动） | `SkillLoadEventLog`：+skillContentHash（复用 git SHA，sync 时写入挂载 metadata）+ 留存策略（借 F237 summary/detail 双层：热 7d + 冷聚合） | 补 G1/G2 |
| 新建（真空区） | `GuardRejectionEventLog`（4xx 结构化落盘，借 F254 形态；首批覆盖 hold_ball 429/400、publish_verdict 403、cross_post 路由拒） | 补 G3 |
| 新建（新对象） | ledger registry（YAML 资产账本）+ `eval:harness-ledger` 域 | 补 G5，块 3 才做 |
| 待对齐 | 复合锅 schema（见 §7 D1）；eval:spec-fidelity 独立 vs 并 eval:sop（KD-8 复核，predicate 形态盘点后倾向维持分域结论） | Design Gate 补充项 |

## 6. 分块路线（修正 KD-10 执行序）

> 原则：综合设计（本文档 = 全局地图）+ 从一块开始（块 1）；五环闭环是 north star 不是一次交付。

**块 1：统一信号层（纯观测，零行为改动，周级）**
- ①扩展 SkillLoadEventLog（G1/G2）②新建 GuardRejectionEventLog（G3）
- 交付物：两类信号可查询 + 第一份基线报告（skill 加载分布 / 4xx 分布，数字带 how_counted）
- 这不是 hotfix：两个实锤问题共享这一个地基，且它是块 3 eval 域的输入前提（§4 推论）

**块 2：归因 + 定点修补（月级——受 30d 对比窗口天然约束）**
- 基于块 1 数据归因两个实锤（skill 为什么 0 加载 / 429 谁在撞为什么）——归因有数据，不拍脑袋
- 修补方案逐个 operator approve；效果验证 = 块 1 数据前后对比（版本字段使归因可信）

**块 3：制度化（块 2 见效后）**
- eval:harness-ledger 域注册（全复用 F192 机制）+ registry 伴生登记 + Console 页 + retire 通路

**预期管理**：第一个可交付物只是"信号可查 + 基线数字"；闭环验证以月为单位；不承诺一次搞定五环。

## 7. 待对齐设计点

- **D1 复合锅 schema**（hold_ball 类跨层锅怎么建模）：
  - 候选 a（倾向）：锅 = assertion 为主体，`enforcements: [{layer, ref}]` 数组记录各层实现（prompt 规则 §4 / MCP 校验 / API 429 是同一 assertion 的三个执行点）。归因、退役都落在 enforcement 级（如：文本层退役、代码层保留）。
  - 候选 b：各层各建锅 + relates 链接。缺点：一个约束拆三口锅，触发归因要跨锅聚合。
  - 决策方式：Design Gate 补充对齐（opus/codex），不在本文档拍死。
- **D2 skillContentHash 的写入链路**：skill-sync 时机 vs 加载时实时读——实现细节，块 1 开工时定。
- **D3 eval:capability-wakeup 与块 3 新域的边界**：唤醒率（行为）vs 资产生死（生命周期），输入同源不冲突，注册前列对照表防撞域（同 OQ-4 纪律）。

## 8. 本轮自举记录

本分析暴露的偏差已记 seed-cases SC-005（设计修复方案前未盘点既有基建，Phase A-① 曾建立在"skill 无埋点"的错误假设上）。

## 9. 2026-07-08 二轮方向重定（co-creator）

> 来源：co-creator 10:37 UTC 消息。三个对象级重定 + 一个共创方法论。§6 的块 1 组成相应调整。

### 9.1 skill：当前阶段放一下（deferred，形态共识已记录）

否决理由：**安装包用户**——skill 是随包分发资产，加版本/迭代机制必须考虑用户侧更新链路，改动面太大。形态共识（做的时候按这个）：**overlay 模式**——base 版本随包不可变；迭代发生在 overlay 层；挂载时挂 overlay 合成版本；skill 自身可见自己的版本迭代史。skill 问题的抽象已经统一（有没有触发 / 触发后遵从否 / 内容合理否），且"改了之后只要触发大概率遵从"——缺的是评估+版本+迭代，但那是 auto harness 的一小部分。原块 1 的 SkillLoadEventLog 扩展随之撤出首批。

### 9.2 hold_ball 类：重新定性为"业务代码自诊断"维度

429/waitSourceRef 校验是**我们硬编码的业务逻辑**，不是"锅文本"。这一类的 harness 能力 = 分析诊断自己业务运行代码的问题（self-diagnosis），与"规则/协作段管理"是两个维度。GuardRejectionEventLog 从首批撤出，归入自诊断线另行排期。

### 9.3 首个试验品：prompt 段管理（#1075 载体）+ SOP

co-creator 判断：段才是当前最大的问题——哪些段多余 / 内容是否合理 / 是否需要补段；SOP 同理。**基建证据支持这个判断**（2026-07-08 盘点 PR #1075）：

| 段的 harness 要素 | #1075 现状 |
|------------------|-----------|
| registry | 46 个 `assets/prompt-hooks/*/hook.yaml`（id/version/enabled/order） |
| 触发观测 | HookPipeline resolve→fire→trace，`TraceEvent[]`→`ObservedSegment[]` 持久化（per session-init / per-turn） |
| fire/skip 条件 | 46 个 typed resolvers（纯函数，可测） |
| 迭代通道 | 短期 git PR（段=yaml+md）；中期 `HookOverrideStore` 已排 PR 3——**正是 overlay 模式**，段先走通，skill 未来直接复用该模式 |

即：**段的信号层已被 #1075 建好**（对比 skill 缺版本缺留存、4xx 零落盘），缺的恰是 F257 的评估层 + 迭代层。这是四类对象中唯一"信号就绪"的，首试验品成立。

段级评估草图（待四猫共创细化）：①成本面=注入频率×段长度；②遵从面=段 assertion 与行为的对应证据（借 eval:sop predicate 形态）；③冗余判定=高频 fired 但零遵从证据；④缺段信号=同类纠正反复出现但无段承载（F245 friction 供数）。判定消费复用 F192 域机制。

### 9.4 前车之鉴：thread_mouste3im3xlkkah（Harness Control Plane）

co-creator：那次 MCP 改动的尝试"完全没效果"。结尾状态初判：改动合入 fork 但 upstream PR #914 closed unmerged、eval 线 blocked 等 runtime pickup——**改动未进运行时 + 无消费闭环**（与 skill 0 加载/记忆零回读同构：建了 ≠ 用了）。段试验设计前须完整回放该 thread 提取失败教训，作为设计输入；本次不同点的初步论证：#1075 trace 消费端在自家持久化、评估复用在跑的 eval 域、迭代先走零新基建的 git PR。

### 9.5 方法论：设计主体是猫，不是 operator 灌输

co-creator 明确：他可给伪代码/时机/数据结构参考，但"最合适你们的"应由猫基于几个月真实使用体感构建，且要在不同环境/模型/用户下可演进。下一棒：起草四猫体感征集（各自最疼的三件事 + 最想要的自愈能力），在 F257 工作 thread（thread_mr96jyudj9iqisa9）汇成设计输入，再重排 spec Phase 结构。
