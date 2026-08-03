---
name: eval-design
tips_exempt: internal governance discriminator; it does not expose a user-invocable capability
description: 指标出生证（五件套契约）+ 六公理设计自检 + 存量 eval 体检尺（摸鱼/划水/污染）；用于按 ADR-031 v3.4 机制选择判定 eval 该不该建、新增或修改任何指标、审计现有 eval 资产。输出带出生证的指标定义或带处置建议的体检报告。
---

# Eval Design — 指标出生证 · 设计自检 · 存量体检 · 干预证

> **版本定位**（2026-07-17 Sol 共创轮收敛）：v0.1 = 指标发牌照与体检 + 干预证。
> 机制选择与落地边界以 ADR-031 v3.4 为准：按问题选机制，不按层补齐。

## Why This Is a Skill（价值门禁）

模型的训练先验里有"怎么算 accuracy"，没有猫咖的 eval 宪法。本 skill 是 2026-07
Eval 纲领（六公理 E1–E6）+ Alden 三日思辨的操作化——未来任何猫给任何 harness 域
配 eval 时，用同一套流程，防止家里的 eval 资产继续长成"摸鱼/划水/污染"三态混合物。
来源：feature-discussions/2026-07-17-eval-charter-draft.md（宪法）+
2026-07-16-alden-dialogue-distillation.md（思辨蒸馏）。

## 核心定义：一个 eval 指标到底是什么

> **一个 eval 指标 = 一个赌注："这个数字的变动方向，与我们真实在乎的东西的变动
> 方向一致。"** 它不是测量值本身，是"测量值 → 真实效用"的映射假设。假设会失效
> （分布漂移）、会被破坏（优化压力）、需要验证（校准）——所以指标有生命周期。

## 一、指标出生证（五件套契约——缺一不发牌照）

任何新指标上线前填齐：

```yaml
metric_birth_certificate:
  utility_claim:      # 这个数字上升，代表什么真实的东西变好？（答不出 = 拒发）
  estimator:          # 分子/分母/排除项/采样方式/judge 及其版本
  validity_bounds:    # 预注册失效条件：什么分布漂移/优化压力/judge 变化会让它失真
  consumer:           # 谁消费它、驱动什么决策（无 consumer = 摸鱼指标，拒发）
  calibration_plan:   # 多久和人工裁决/外生 ground truth 对一次表；相关性掉线阈值
  repeatability_contract:  # （v0.1 增，Sol 刀③）本指标属发现/归因/验收哪一环节；
                           # episode/环境/judge/版本如何冻结；跑几次；均值与 CI 波动
                           # 容差；哪些随机源允许变化。校准管"测得准"，本件管"重测稳"。
```

## 二、设计自检（六公理速查——每条能一票否决）

| 公理 | 自检问题 | 否决示例 |
|---|---|---|
| E1 单位 | 度量的是 episode（机会×行为×后果）吗？沉默入分母了吗？ | per-猫总分；无沉默采样的主动性指标 |
| E2 形状 | 非对称代价显式了吗？多维保留向量/约束了吗？ | 单一 accuracy；跨量纲加权总分 |
| E3 对抗 | 出题/被测/裁决分权了吗？有外生锚吗？观测面体检过吗？ | 自报分数无锚；带毒管线上装仪表 |
| E4 代谢 | 有孵化-退役机制吗？judge 版本化了吗？代谢率可见吗？ | 无退役题库；永不换版的 judge |
| E5 回灌 | 分数会进被测者上下文吗？叙事反馈的案例抽样冻结了吗？ | verdict 分数注入 prompt；报告人自选案例 |
| E6 环节 | 发现/归因/验收/改进的性质分开了吗？ | 同批 fixture 既挑改动又验收；归因直接当梯度 |

## 三、存量体检尺（摸鱼 / 划水 / 污染）

对每个现存 eval 资产（telemetry、verdict 管线、守护测试、bench、fixture）问三刀：

| 病名 | 判据 | 检法 | 处置 |
|---|---|---|---|
| **摸鱼** | 无 consumer：输出不驱动任何决策 | 查最近 N 期输出 → 驱动过什么改动？零 = 摸鱼 | sunset（走 F192 verdict） |
| **划水** | 无 validity：与病灶正交或代谢死亡 | 全绿期间同域生产翻车照发？最近一次抓到真问题是何时？零代谢？ | 换题对准病灶；重启孵化-退役 |
| **污染** | 输出错误且自信：观测面带毒/judge 共振/被磨熟 | 抽样人工复核；proxy 与人工裁决相关性；判"分数涨效用不涨"散度 | **先修观测面再谈其他**（E3） |

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
  falsifier:                # 什么结果证明我错了
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
3. **若选 eval**：先填出生证。guard 只有在效用未知且存在 keep/tune/sunset consumer
   时才配观测窗口（残余翻车数/误杀数/兜底触发数 → verdict）；确定性 guard 不会因为
   “它是 guard”就自动获得 eval；
4. **跨机制依赖**：eval 的传感器先过 validity check——带毒观测面上的
   一切度量是精确的幻觉。

## Common Mistakes

| 错误 | 后果 | 修复 |
|---|---|---|
| 无 consumer 就上指标 | 摸鱼指标制造机 | 出生证第 4 件强制 |
| 拿"绿灯名字"当"绿灯覆盖" | 全绿与带病并存 | 划水体检刀：全绿期生产翻车审计 |
| 全绿 = 健康 | 可能是正交/磨熟/代谢死亡 | 一级健康指标是代谢率不是通过率 |
| 观测面没体检就装仪表 | 精确的幻觉 | E3：先修有毒观测面 |
| 指标失效后继续引用 | 决策建立在死指标上 | validity_bounds 预注册 + 校准计划 |
| 把审计报告写成总分排行榜 | 违反 E2/E5 | 输出病名+处置建议，不输出分数 |

## 和其他 Skill 的区别

| Skill | 分工 |
|---|---|
| `quality-gate` | 单次交付的自检；本 skill 管**度量体系本身**的设计与体检 |
| `code-as-harness` | 摩擦→修 harness；本 skill 是它 eval 机制的设计手册 |
| `source-audit` | 审外部 claim；本 skill 审**自家指标**（对内的 source-audit） |
| `self-evolution` | 知识沉淀通道；本 skill 产出的教训经它归档 |

## 下一步

- 新指标设计完成 → 出生证入 feature doc / spec，consumer 与校准计划写进 AC
- 存量体检完成 → 体检报告（病名+处置）走 F192 verdict 管线（fix/keep_observe/sunset）
- 摸出宪法级问题 → 回 feature-discussions/2026-07-17-eval-charter-draft.md 提修正案
