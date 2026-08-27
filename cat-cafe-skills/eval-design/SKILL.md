---
name: eval-design
tips_exempt: "v0.3 adds internal eval role separation plus longitudinal trigger, maturity, and actionability governance; it changes no user-invocable capability or product surface."
description: "E0资格门+指标出生证+纵向运行拓扑+七公理+五病体检。Use when: 设计、修改或审计eval。Not for: 单次交付(quality-gate)、外部claim(source-audit)、摩擦诊断(code-as-harness)。Output: 指标出生证（纵向eval含触发契约）或病名+处置。"
---

# Eval Design — E0 资格门 · 出生证契约 · 运行拓扑 · 设计自检 · 五病体检 · 干预证

> **版本定位**（2026-08-23 v2.2 修正轮）：v0.3 = v0.2 + E5 自评回灌禁区 +
> runway 记账成本 + 纵向 Eval 运行拓扑 + 裁决角色分权。上位宪法：
> `docs/architecture/eval-philosophy.md`（七公理 E0–E6；v2.2 已 ratified）。
> 机制选择与落地边界以 ADR-031 v3.4 为准：按问题选机制，
> 不按层补齐。

## Why This Is a Skill（价值门禁）

模型的训练先验里有"怎么算 accuracy"，没有猫咖的 eval 宪法。本 skill 是 2026-07
Eval 宪法（七公理 E0–E6）+ Alden 三日思辨的操作化——未来任何猫给任何 harness 域
配 eval 时，用同一套流程，防止家里的 eval 资产继续长成划水/污染/归因停滞/
干预失证/摸鱼五病混合物。
来源：docs/architecture/eval-philosophy.md（宪法 v2.2，七公理）+
feature-discussions/2026-07-17-eval-charter-draft.md（v1 历史草案，已演进归档）+
2026-07-16-alden-dialogue-distillation.md（思辨蒸馏）。

## 核心定义：一个 eval 指标到底是什么

> **一个 eval 指标 = 一个赌注："这个数字的变动方向，与我们真实在乎的东西的变动
> 方向一致。"** 它不是测量值本身，是"测量值 → 真实效用"的映射假设。假设会失效
> （分布漂移）、会被破坏（优化压力）、需要验证（校准）——所以指标有生命周期。

## 〇、E0 资格门（建前先过——三问**任一**答不出即不发牌照，宪法 E0）

1. **claim 落在哪个 GT 域**——同一产物的不同 claim 落在不同域（测试判得了
   "符合规约"，判不了"是人要的产品"），禁止拿产物整体贴单一域标签；
2. **判定所需的新鲜 bit 在哪**——已在系统可观察边界内（verifier 射程：边际
   判分成本≈0、可自动重复）/ 在冻结先验里（judge 射程：便宜但有额度）/ 只在
   价值主人脑中与真实后果里（必须外采）。裁判类型由 claim 的域决定，**不由
   预算决定**；
3. **裁判的工资谁在付**——verifier=测试维护投入；judge=冻结先验额度 +
   calibration runway 的记账/人锚抽样成本（见出生证）；价值主人=真实关系与打扰
   预算。答不出付薪方=环转不久。若连 runway 都付不起，结论是缩小或不建 judge 环，
   不是省掉测量后继续宣称它可持续。

E0 划的是**自治上限**：外部新 bit 缺位，不得宣称开放价值 claim 已全自动闭环
改善——但不否决候选生成、分诊、shadow、灰度等局部自动化。建前定资格，运行中
随 runway 持续重验。judge 联网算不算破圈 → 宪法 E0 联网三分判：查事实=真升级 /
查人群资料=换仓库的老本 / 接该用户本人历史=真破圈（破圈靠接上真值，不靠搜索动作）。

## 一、指标出生证契约（适用字段缺一不发牌照）

任何新指标上线前填齐基础字段；使用 judge 或其他会折旧、存在额度的裁判时，
再填额度字段；只有累计证据、持续运行的纵向 Eval 才填运行拓扑字段：

```yaml
metric_birth_certificate:
  utility_claim:      # 这个数字上升，代表什么真实的东西变好？（答不出 = 拒发）
  estimator:          # 分子/分母/排除项/采样方式/judge 及其版本
  validity_bounds:    # 预注册失效条件：什么分布漂移/优化压力/judge 变化会让它失真
  roles:              # 四角色分别写明；允许兼任，但须在 role_overlap_justification 解释
    observer:         # 谁读 canonical evidence、生成测量
    domain_owner:     # 谁拥有该域规约与真相
    consumer:         # 谁据此做 keep/tune/sunset（无 consumer = 摸鱼指标，拒发）
    calibrator:       # 谁独立检查量尺/观察面可靠性
  role_overlap_justification:  # 同一主体兼任时，凭什么仍有独立性；开放价值 claim 从严
  calibration_plan:   # 多久和人工裁决/外生 ground truth 对一次表；相关性掉线阈值
  repeatability_contract:  # （v0.1 增，Sol 刀③）本指标属发现/归因/验收哪一环节；
                           # episode/环境/judge/版本如何冻结；跑几次；均值与 CI 波动
                           # 容差；哪些随机源允许变化。校准管"测得准"，本件管"重测稳"。
  # 以下两项仅对使用 judge / 其他有额度裁判的环适用；纯 verifier 环不填。
  calibration_runway:      # （v0.2 增，宪法 E0）适用时必填：额度不可读成单一电量，
                           # 按向量三账估——校准账（人-judge 决策级分歧率，晋升/回滚
                           # 被翻转才算）/ 暴露账（judge/题库被用于自适应选型的轮数）
                           # / 覆盖账（分布外流量占比）。抽样两腿：随机盲抽 + 风险
                           # 定向抽；复用用户自然行为，不逼打分。仪表 consumer=守门猫。
  exhaustion_action:       # （v0.2 增，宪法 E0）与 runway 同条件必填：额度告急的
                           # 预注册动作：自动晋升降
                           # shadow / 转人工复核 / 回退简单基线。分级停止判据：决策
                           # 分歧率越过预注册阈值=单独硬停（锚级）；输出多样性坍缩=
                           # gaming 调查（统计级）；打不赢最低充分替代物=经济退场。
  # 以下块只对累计证据、持续运行的纵向 Eval 适用；单次交付检查不填。
  longitudinal_trigger_contract:
    trigger_policy:        # event_plus_time | time_only；不把长期 Eval 配成无兜底 event_only
    evidence_ingestion:    # canonical episode 如何进入；入库成功不等于已经运行 Eval
    early_trigger:         # 可靠事件源下，什么阈值跨越/关键事件会提前唤醒
    time_fallback:         # 最长沉默多久必须复评；time_only 必须声明最大检测延迟
    dedupe_key:            # event 与 time 同时命中时如何归并成一次窗口
    overlap_policy:        # 上一轮仍运行时，第二次触发如何 queue/coalesce/reject
    maturity_predicate:    # 什么条件说明证据窗口已成熟，可计算有效测量
    actionability_gate:    # validity、权限、校准满足什么条件，verdict 才能驱动动作
```

纵向 Eval 有四个时刻，禁止压成一个布尔值：**证据进入**只是有了原料；**唤醒**只是
开始运行；**成熟**才允许形成有效测量；**可行动**才允许 verdict 驱动 keep/tune/sunset。
有可靠事件源时，优先“事件早触发 + 时间防沉默”；没有可靠事件源可以诚实选择
`time_only`，同时写明最大检测延迟。单次交付型检查不挂这套长期机制。

## 二、设计自检（七公理速查——每条能一票否决）

| 公理 | 自检问题 | 否决示例 |
|---|---|---|
| E0 资格 | claim 的新鲜判别 bit 在系统可观察边界内吗？裁判射程与付薪方答得出吗？ | 外部新 bit 缺位仍称全自动闭环；verifier 射程内用 judge 糊；无 runway/exhaustion_action 或无人承担记账成本的 judge 环 |
| E1 单位 | 度量的是 episode（机会×行为×后果）吗？沉默入分母了吗？ | per-猫总分；无沉默采样的主动性指标 |
| E2 形状 | 非对称代价显式了吗？多维保留向量/约束了吗？ | 单一 accuracy；跨量纲加权总分 |
| E3 对抗 | observer/domain owner/consumer/calibrator 分权了吗？有外生锚吗？观测面体检过了吗？ | 机制作者兼 observer 后又独自校准开放价值 claim；带毒管线上装仪表 |
| E4 代谢 | 有孵化-退役机制吗？纵向 Eval 的进入/唤醒/成熟/可行动分开了吗？多久不能不醒？ | 把 maturity 当 scheduler trigger；只有事件触发、沉默时永久不复评 |
| E5 回灌 | 未验证自评会以事实身份进被测者上下文吗？叙事反馈的案例抽样冻结了吗？ | 把 expected outcome 写成 outcome 回灌；报告人自选案例 |
| E6 环节 | 发现/归因/验收/改进的性质分开了吗？ | 同批 fixture 既挑改动又验收；归因直接当梯度 |

E5 禁止的是**事实化回灌**：明确保留为 `hypothesis/expectation`，且下游始终按
待验证命题读取的字段可以保留；一旦改名、渲染或汇总成既成事实，仍触发否决。

## 三、存量体检尺（五病——按举证链定位，资产病 / 流程病分治）

对每个现存 eval 资产（telemetry、verdict 管线、守护测试、bench、fixture）按
举证链（规约→测量→归因→干预→外推）定位病灶。**资产病**=存量资产的慢性病，
体检尺周期查；**流程病**=单轮举证链的急性病，当轮牌照拦、不等慢性化（宪法附 E）：

| 病名 | 类型 / 链位 | 判据 | 检法 | 处置 |
|---|---|---|---|---|
| **划水** | 资产病 / 规约 | 无 validity：与病灶正交（含代谢死亡导致的滞后正交——考卷停更，病灶已迁移） | 全绿期间同域生产翻车照发？最近一次抓到真问题是何时？零代谢？ | 换题对准病灶；重启孵化-退役 |
| **污染** | 资产病 / 测量 | 输出错误且自信：观测面带毒/judge 共振/被磨熟 | 抽样人工复核；proxy 与人工裁决相关性；判"分数涨效用不涨"散度 | **先修观测面再谈其他**（E3） |
| **归因停滞** | 流程病 / 归因 | 竞争解释未被区分，下一轮没有新增证据 | 当轮审。"≥3 轮同型 finding"只是报警器——须先排除干预未落地 / 环境重复触发 / 风险已显式接受三种替代解释，方可确诊 | 停点修，回归因补关键区分实验 |
| **干预失证** | 流程病 / 干预 | 无因果理由 / 预期 Δ / 证伪条件 / 独立验收 | 当轮拦：干预证牌照检查，一轮即拒 | 补齐干预证再动手 |
| **摸鱼** | 资产病 / 外推 | 无 consumer：输出不驱动任何决策 | 查最近 N 期输出 → 驱动过什么改动？零 = 摸鱼 | sunset（走 F192 verdict） |

**"能产生 loss 吗"的判据（v0.1 修正——Sol 刀①）**：`原始信号 → metric → loss →
verdict` 是四级台阶，utility_claim + estimator 只走到 metric（候选指标）。升级为
**可信 loss** 还需五件：不确定性与重复运行容差、风险预算/决策阈值、多维代价的约束
关系、越界后消费者的具体动作、与外部裁决锚的校准结果。"漏用率 100%"若缺这五件，
只是醒目的数字，不是可优化的 loss。摸鱼 eval 大多连 metric 级都不到——utility_claim
都答不出的是仪表盘装饰。

## 四、干预证（v0.1 增——Sol 刀②：从"报病名"到"可信治疗"）

体检报病名后、动手改之前，完整链条是：

```text
可重放评估 → 可信 loss → 失败归因 → 关键科学问题定义 → 预注册干预假设
→ 定向改动 → 同批复测 + 独立 holdout → verdict
```

归因只产出**候选原因**（且归因自身要审：置信度凭什么、竞争解释排除了吗——狗粮
实测过 snapshot 自报 medium 而归因文件写 0.95、证据是同一 pattern 粘贴三次的案例）。
候选原因要变成改动，必须先填**干预证**：

```yaml
intervention_card:
  observed_loss:            # 观测到的 loss（带不确定性）
  competing_attributions:   # 竞争解释清单（不止一个才叫归因过）
  key_scientific_question:  # 哪个实验能区分竞争解释
  intervention_lever:       # 改哪个变量
  causal_rationale:         # 为什么认为它是因
  expected_delta:           # 预期变化多少
  intervention_falsifier:   # 什么结果证明干预假设错了
  rubric_reopen_trigger:    # 什么结果证明尺子本身错了——外推三岔的第三岔，触发
                            # 即回规约改评分标准（宪法 E6：链是环）。诊断指纹：
                            # 系统故障带噪声，量具故障带着几何学的整洁
  replay_cohort:            # 在哪批冻结数据上重放
  holdout:                  # 独立验收集
  cost_and_rollback:        # 成本与回滚路径
```

> 我们认可的不是自动反向传播，而是：**稳定测量产生 loss 向量；归因提出方向；
> 关键科学问题选择实验；配对干预产生局部因果梯度；裁决层决定是否应用。**

## 五、选中机制后的落地约束（ADR-031 v3.4 执行细则）

> **入口（LL-095）**：先按 ADR-031 v3.4 §机制选择四分类判定该问题落什么机制——
> 确定契约→test/guard；运行健康→observability（默认不挂 Eval Hub）；不确定效用+
> 明确 consumer→eval；教猫→convention/skill。同一改动多类问题按 claim 逐项选。
> **本节只约束已经选中的机制**，不规定全局施工顺序，也不要求为未选机制填写 N/A。

1. **若选 convention/skill**：保持便宜、可逆，允许快速试错；
2. **若选 test/lint/guard**：硬化由风险 × 证据强度共同决定（v0.1 修正——Sol 刀④）。普通流程摩擦默认
   门槛 = ≥2 次真实翻车（拿假想需求建门禁 = 误杀工厂）；**安全/鉴权/数据持久化/
   不可逆操作/外部契约域例外**——一次可信事故、甚至静态证明存在缺口，即可硬化；
3. **若选 eval**：先过 E0 资格门，再填出生证契约。guard 只有在效用未知且存在 keep/tune/sunset consumer
   时才配观测窗口（残余翻车数/误杀数/兜底触发数 → verdict）；确定性 guard 不会因为
   “它是 guard”就自动获得 eval；
4. **跨机制依赖**：eval 的传感器先过 validity check——带毒观测面上的
   一切度量是精确的幻觉。

## Common Mistakes

| 错误 | 后果 | 修复 |
|---|---|---|
| 无 consumer 就上指标 | 摸鱼指标制造机 | 出生证 consumer 门禁强制 |
| 拿"绿灯名字"当"绿灯覆盖" | 全绿与带病并存 | 划水体检刀：全绿期生产翻车审计 |
| 全绿 = 健康 | 可能是正交/磨熟/代谢死亡 | 一级健康指标是代谢率不是通过率 |
| 观测面没体检就装仪表 | 精确的幻觉 | E3：先修有毒观测面 |
| 指标失效后继续引用 | 决策建立在死指标上 | validity_bounds 预注册 + 校准计划 |
| 把审计报告写成总分排行榜 | 违反 E2/E5 | 输出病名+处置建议，不输出分数 |
| 把成熟条件当唤醒条件（`maturity ≠ invocation trigger`） | Eval 要么永远不醒，要么未成熟就出结论 | 纵向触发契约拆开 ingestion/wake/maturity/actionability |
| observer 被当成 domain owner / consumer | 看见信号的人顺手垄断规约与裁决 | 四角色显式登记；兼任写独立性理由，开放价值 claim 配独立 calibrator |

## 和其他 Skill 的区别

| Skill | 分工 |
|---|---|
| `quality-gate` | 单次交付的自检；本 skill 管**度量体系本身**的设计与体检 |
| `code-as-harness` | 摩擦→修 harness；本 skill 是它 eval 机制的设计手册 |
| `source-audit` | 审外部 claim；本 skill 审**自家指标**（对内的 source-audit） |
| `self-evolution` | 知识沉淀通道；本 skill 产出的教训经它归档 |

## 下一步

- 新指标设计完成 → 出生证入 feature doc / spec；纵向 Eval 另把触发契约与四角色写进 AC
- 存量体检完成 → 体检报告（病名+处置）走 F192 verdict 管线（fix/keep_observe/sunset）
- 摸出宪法级问题 → 回 docs/architecture/eval-philosophy.md 提修正案（v1 草案
  已演进归档，勿再引用）
