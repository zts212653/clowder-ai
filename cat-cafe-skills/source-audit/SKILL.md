---
name: source-audit
description: >
  外部高风险 claim 与研究贡献审计。Use when: 数字、benchmark、因果、趋势、模型能力、
  外部论文或会进入 docs/ADR/PPT 的结论。Not for: 低风险常识、只读官方原文且不外推、
  已进入 deep-research 的重调研。Output: claim ledger + source / non-triviality /
  decision-fit 三轴 verdict + provenance。
tips_exempt: Existing audit quality contract refinement; no new user-facing capability or discovery moment.
---

# Source Audit

## Why This Is a Skill

F218 的事故不是模型凭空幻觉，而是外部不可靠信息源污染：多篇博客互引看起来像"多方验证"，但最终回到同一个营销来源。这个 skill 把"这东西靠谱吗？"绑到引用外部 claim 的动作上，补 WebSearch 和 deep-research 之间的中档。

## Trigger

准备把外部 claim 写进回复、research、PPT、ADR、spec 或 review 结论时，命中任一特征就跑：

- 数字 / 百分比 / x 倍增长 / benchmark 排名
- 因果归因（"失败是因为..."）或趋势判断
- 模型能力对比、论文结论、医学/金融/法律等高风险主题
- 来源会进入长期文档，影响后续猫的判断链

不触发：只回答低风险常识；只引用官方文档原文且不外推；已经按 deep-research 跑完整多源调研。

## L0 判断力镜头：先换坐标系，再查细节

这两副镜头来自家里的 Magic Words，不是给审计再加一套平行术语，也不能凭感觉代替证据。
它们负责产生可证伪的反事实；一手来源、baseline、干预和 holdout 负责裁决。

### 第一性原理 / 数学之美

先把论文去品牌化并缩成最小问题：

1. 它声称原系统缺少什么能力，而不是缺少哪个作者命名的模块？
2. `strongest_cheap_alternative` 是什么：强模型直接做、一句静态 prompt、短规则、
   deterministic tool、retrieval / cache，还是一次人工配置？
3. 实验是否在独立证据上击败了这个替代物？
4. 如果没有，claim ceiling 降到“自动搜索 / elicitation / 工程集成”，不得写成
   “获得新能力 / 证明自进化必要”。

### 补锅匠 failure-mode audit

看到连续局部机制、多个 fallback 或“再加一个 evaluator / generator / memory”时，不逐块
验完就默认整条路线合理。做一次有边界的同类审计：

1. 写出这些补丁共同在代偿的原始 failure mode；
2. 区分真实世界约束与论文自己引入的坐标系；
3. 问一个更直接的表示、契约或静态策略能否同时删掉多层；
4. 对保留的每一层写明“去掉后哪条已观测证据会坏”；
5. 若作者只证明每块都能工作、没证明原问题存在或整套不可约，保留 source validity，
   但下调 non-triviality 与 decision fit。

禁止把 Magic Word 当作否定论文的结论。“这像补锅匠”只能触发 failure-mode hypothesis；
没有替代方案、ablation 或证据边界，就不能写 `reject`。

## Claim Ledger

先列 claim，再逐条审：

| Claim | Metric / comparator | Strongest cheap alternative / claim ceiling | Scope / denominator / exclusions | Lifecycle cost / unknowns | 原始来源 | Source verdict | Non-triviality verdict | Decision fit | Provenance |
|-------|---------------------|---------------------------------------------|----------------------------------|---------------------------|----------|----------------|------------------------|--------------|------------|
| ... | ... | ... | ... | ... | paper / official / vendor blog / media / forum | ... | ... | ... | ... |

## 六问 Checklist

1. **一手 or 二手？** 追到原始论文、官方文档、实验报告或数据集。多篇文章互相引用不等于多方验证。
2. **利益冲突？** 卖产品/咨询/课程的一方说"这个问题很严重"要扣分，并标明动机。
3. **方法可复核吗？** Peer review、博客、营销页都只是来源属性；继续查样本、指标定义、
   baseline、实验代码/数据、重复次数和不确定性。Peer-reviewed 不自动等于结论可复现。
4. **时效性？** 标清发布时间、测试年份、模型/版本。AI 领域旧模型数据不能直接论证新模型。
5. **对象和决策匹配吗？** 区分“这个结果在它测的任务上成立”与“它能支持我们的决定”。
   写清目标 workload、用户群、系统版本和未覆盖能力；家里体感只负责触发冲突调查，不能
   反过来当作否定外部结果的证据。
6. **测量与账本边界清楚吗？（防 true-but-incomplete）** 不要求证明一个不存在的“完整
   世界账本”，而要重建**足以支持当前决定的 scoped ledger**：指标定义与 comparator；
   分子、分母、排除项和自适应复用次数；系统边界、时间窗和生命周期成本（采集/预处理、
   在线调用、cache read/write/miss、维护、人审）；质量、覆盖、延迟、可靠性等联动结果；
   测不到的项明确记 `unknown`。缓存收益必须按目标 provider/model/workload 的真实 usage
   与计费规则测量，不能从“改了中间 context”直接推导“全 miss”或固定倍率。

口诀可以保留：一切命运的馈赠都暗中标注价码（operator 原话）。但口诀不是证据；边界、
观测值和 unknown 才是。

### 性能 / 成本 Claim 的最小执行格式

凡“更准 / 更快 / 更省 / SOTA”都要记录以下字段，但它们不是一张把两轴重新压平的
通过/失败清单：

```text
measured_construct: 它实际测了什么
comparator: 与谁比；版本和配置是否同条件
population_and_denominator: 样本/请求/用户范围、分母、排除项
decision_boundary: 我们要据此做什么决定；目标 workload 和时间窗
lifecycle_ledger: ingest/extract + query/retrieval + generation + cache + maintenance/human
coupled_outcomes: quality + coverage/abstention + latency + reliability + risk
unknowns: 未报告或无法复核的项
```

研究贡献、Benchmark、Eval 或“自进化”claim 还要补：

```text
exact_claim: 去品牌化后到底声称什么
evolving_object: weights / memory / skill / harness / judge / task / problem definition
strongest_cheap_alternative: 足以解释同一结果的最便宜可信方案
evidence_roles: development / selection / holdout / production
failure_mode_map: 各机制在修哪个根因；是否多层修同一个错坐标系
closure_map: task / generator / judge / value owner
claim_ceiling: 当前证据最多允许写到哪里
```

- **Source verdict 的最低证据面**：`measured_construct`、`comparator`、
  `population_and_denominator`，以及六问中足以复核方法的证据。若 claim 自称“总成本”或
  “端到端”，`lifecycle_ledger` 也属于 measured construct 的定义。缺少这些 source-validity
  证据时，Source verdict 最高只能 `use-with-caveat`。
- **Decision fit 的最低证据面**：`decision_boundary`、与该决定相关的
  `lifecycle_ledger` / `coupled_outcomes`，以及明确的 `unknowns`。这些字段缺项**不降级已成立的 Source verdict**，
  但 Decision fit 最高只能 `partial`；若连决策边界或目标 workload 都未知，则为 `none`。

## Verdict（三轴，不压成一个总分）

**Source verdict**（claim 在它声称的范围内是否站得住）：

- `use`：方法与来源足以支持限定后的 claim。
- `use-with-caveat`：可用但必须附限制，例如二手、旧模型、小样本、账本缺项。
- `reject`：追不到证据、方法不支持结论、回声室互引，或 numerator/denominator 不成立。
- `escalate-to-deep-research`：claim 重要且证据冲突，单轮审计不够。

**Non-triviality verdict**（复杂机制是否展示了超出最低充分替代物的增量）：

- `demonstrated`：在合适的独立证据上击败强而可信的廉价替代物。
- `not-compared`：只击败 naive / 缺失 baseline，或没有排除 prompt、规则、retrieval 等解释。
- `failed`：廉价替代物已经匹配 / 击败该机制，或所谓进化只重新发现了预先可写出的规则。

这根轴不反向污染 Source verdict：论文可以真实、可复现，却没有证明其复杂性或“自进化”
claim 的必要性。

**Decision fit**（它能否支持我们眼前的决定）：

- `direct`：对象、workload、约束和效用维度匹配。
- `partial`：只覆盖决策向量的一部分；明确哪部分可迁移、哪部分未知。
- `none`：claim 可能为真，但与当前决定正交或关键边界不匹配。

## Provenance

聊天短行：

```text
[一手/二手 | 来源类型 | 数据年份 | 适用对象 | 置信度]
```

docs/research / ADR / PPT 用 claim ledger 表。若 claim 被拒绝，也记录拒绝原因，防止后续重复捡回。

## Common Mistakes

| 错误 | 后果 | 修复 |
|------|------|------|
| 把搜索结果当证据 | 被 SEO / 营销文带跑 | 搜索结果只算候选线索，必须追一手 |
| 多篇博客互引就说"多方验证" | 回声室污染 | 画引用链，找到共同源头 |
| 用旧模型数据论证新模型 | 对象错配 | 标测试模型/年份，只谈适用范围 |
| 只写 caveat 不改结论 | 弱证据仍污染判断 | verdict 决定表述强度；弱证据不能撑强结论 |
| 把公开 benchmark 分数当产品总效用 | 测量构念被偷换 | 先写 measured construct，再单独判 decision fit |
| 逐组件核验复杂 pipeline，却不问原能力缺口是否存在 | 每块都真实，整项贡献仍可能是补锅 | 触发补锅匠 failure-mode audit，找共同根因与可删层 |
| 只与 naive baseline 比就声称“进化获得能力” | 把自动发现 / elicitation 抬成新能力 | 过第一性原理 / 数学之美，补 strongest cheap alternative 与 claim ceiling |
| 把 Magic Word 当负面 verdict | 用家里审美代替外部证据 | Magic Word 只生成反事实；由 baseline、ablation、holdout 裁决 |
| 宣称“完整账本”却不写边界和 unknown | 用完整感掩盖选择性记账 | 固定 workload / 时间窗 / 生命周期，未知项显式保留 |
| 把联动风险写成必然因果 | 用一个营销故事替换另一个 | 记录待测机制；用 provider usage / billing / A-B 数据验证 |
| 每个低风险事实都跑全表 | friction 过高 | 只对高风险 claim 跑 ledger |

## Pressure Test

MemU 65% 事件：输入多篇互引博客声称"65% 企业 AI 失败归因 harness 缺陷"。合格输出必须追到营销博客源头，识别商业利益冲突，不能把互引当独立验证，verdict 至少是 `use-with-caveat`，若没有一手证据则 `reject`。

True-but-incomplete 事件：供应商声称“recall 输入从 10k 降到 2k，节约 80% token”。
合格输出可以接受“该次 recall payload 降 80%”，但不得升级成“系统总成本降 80%”；必须
补 extraction/ingest、query、generation、cache write/read/miss、质量/覆盖和人工维护，
缺数据记 `unknown`，再给独立的 decision-fit verdict。

自进化沟通策略事件：论文用 rollout / reflection 找到“模糊问题用文本、结构化字段用 UI”，
但没有在 untouched holdout 上击败一句强静态规则。合格输出可以给限定后的 Source verdict
`use`，但 Non-triviality verdict 必须是 `not-compared`，且不得把“搜索环能找到策略”升级成
“只有自进化才能获得该能力”。

## Related Skills

- `deep-research`：重调研管道。source-audit 发现重要 claim 证据冲突时升级过去。
- `memory-search-best-practices`：查家里历史来源图谱时使用；source-audit 只管外部 claim 的信源卫生。
