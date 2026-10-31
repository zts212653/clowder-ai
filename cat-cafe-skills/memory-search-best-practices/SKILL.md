---
name: memory-search-best-practices
description: >
  按问题与证据缺口选择记忆检索范围（8 类题型参考）。
  Use when: 任务是 "哪些地方提过 X" / "X 的来源 / source map" / "有没有提过 Y / absence check" / "上次到现在变了什么 / delta" / 冷启动 onboard 复杂主题 / 任何召回任务搜了一刀觉得不够。
  Not for: 只是选哪个入口走第一刀（用 memory-navigation）/ 已知精确 anchor 单 Read（直接 Read）/ 代码符号查（Grep/LSP）/ 新功能开发（不是 recall 任务）。
  Output: 单一 owner 汇总原始证据、实际覆盖与未验证边界，一次交付。
  GOTCHA: memory-navigation 选择入口；本 skill 处理证据缺口与覆盖边界，不按模型家族或固定轮次决定停止。
triggers:
  - "哪些 thread"
  - "哪些 md"
  - "哪些地方提过"
  - "所有"
  - "历史上"
  - "沉淀过"
  - "source map"
  - "provenance"
  - "有没有提过"
  - "absence check"
  - "delta"
  - "上次和现在"
  - "新猫冷启动"
  - "coverage"
  - "全集"
---

# Memory Search Best Practices（按问题检索与收敛）

## 价值门禁

家里的决策散在文档、thread 原话与关系图中。一次 top-k 命中只能证明找到了候选，不能证明全集或首次出现。
本 skill 提供这些本地入口的使用方法；已知精确 anchor、代码符号查询或新功能实现不需要套用整套检索。

## 按证据缺口判断

按问题与证据缺口决定检索范围。用于结论的关键证据应读原文；涉及覆盖、来源或“没有发生过”的判断，检查容易遗漏的措辞与来源。
继续查证应针对会改变结论的具体缺口；证据足够，或剩余未知已能清楚说明时，就收敛交付。
不按模型家族规定搜索轮次，不为凑次数重复搜索，也不要求通读未被采用的所有命中。

`Query expansion` 由 agent 根据已经发现的语义关系选择，不让搜索服务猜用户的完整意图。
匹配分数用于排序，不替代原始证据的可靠性、适用范围和时效判断。

## 单一 owner 闭环

一个召回目标由同一 owner 汇总、去重、核原文并交付。query、scope、语言和工具切片不得拆成用户需要分别跟踪的独立任务或 feed。
独立只读查询可以并行；中间结果由 owner 统一收敛，不向用户逐项索要推进决定。
只有用户要求独立观点，或存在可独立验收的交付物时，才另行分工。

## 8 类题型参考

下表是寻找证据的路径，不是必跑次数或所有工具必用清单。

| 题型 | 例子 | 可用路径 | 收敛依据 |
|------|------|----------|----------|
| 是什么 | F200 是什么 | 精确 anchor 用 graph_resolve；模糊概念用 search_evidence(scope=docs, mode=hybrid)，读相关原文 | 原文足以回答当前问题 |
| 周边关系 | F200 关联什么 | graph_resolve(anchor, depth=1)，按需限定 relations | 相关关系与本题的联系已明确 |
| 决策考古 | 为什么选 X | 找 ADR/spec，沿其中的 thread/message 坐标读当时原话 | 区分当时理由、后来解释和未确认处 |
| 冷启动 | 接手 F200 要知道什么 | 读当前 spec/Task，按缺口补 graph、近期 thread 或会话摘要 | 能说清原目标、当前事实和下一动作 |
| coverage | 哪些地方提过 X | 分别查 docs 与 threads，按实际线索扩展同义词、缩写、语言或关联概念；合并去重并读采用的原文 | 主要相关来源已覆盖，继续查询不再增加实质线索；报告实际边界 |
| source-map | 这个想法源于哪里 | 从文档 provenance 追 source thread/message，必要时补早期候选 | 结论能回到原始来源；有限检索不冒充最早或完整来源 |
| absence | 提过 Y 吗 | 核查询范围与索引状态，检查相关措辞及相反表述 | 只能说明已查范围未发现；零命中不证明全局不存在 |
| delta | 上次以来变了什么 | 先确定旧状态与时间窗口，再用 list_recent、当前真相和相关 diff 比较 | 变化有前后依据，未覆盖部分明确 |

## 复杂 coverage 的本地经验

历史 AUDHD 检索曾因查询词不同，各自只取到一部分材料。相关概念可能以中英文、缩写或生活场景出现。
据已经发现的内容选择扩展，例如 sensory gating、2e、RSD、PDA、hyperfocus；这只是该案例的线索，不是每题固定词表。
文档与对话回答不同问题：文档便于定位当前结论，对话用于核原话、参与者与时间。
输出可以用 item／source／谁提到／直接或间接／未知边界的简表；简单问题不需要矩阵。

## F256 Related directions

`search_evidence` 的 Related directions 是带 provenance 的候选线索，不是结论或必读清单。

- 看它是否能补当前缺口，再决定是否跟进。
- `convention-edge`、`source-thread` 和 `frontmatter-alias` 表示不同来源；泛词 alias 曾把结果带向 BACKLOG 等大目录，不能据此认定直接相关。
- 采用候选支持结论时，使用返回的 graph／文件／thread 坐标读原始材料；未采用的候选无需全部通读。
- 工具返回 truncated、scanCapped 或 degraded 时，保留这一覆盖限制；必要的分页和补查由问题决定。

## 常见误判

| 误判 | 处置 |
|------|------|
| 拿 top-k 或摘要当全集 | 核原文，按实际来源与措辞补缺口，交代覆盖范围 |
| 没有新证据仍为凑轮次重复搜 | 停止重复查询，交付已支持的结论与剩余未知 |
| 只搜一种措辞就断言不存在 | 检查相关表述与索引边界，只声明已查范围未发现 |
| 命中 canonical doc 就把转述当原话 | 沿来源坐标核对应的 thread/message |
| 盲跟全部 Related directions | 只追能改变结论或补缺口的候选 |
| 把 list_recent(scope=docs) 当全集 | 该入口曾有 timestamp/混合范围限制；结合所需来源，保留返回的范围限制 |

## 和其他 Skill 的区别

- `memory-navigation` 选择首次入口；本 skill 判断如何补缺口与收敛。
- `debugging` 处理 bug 根因，不要求普通实现任务先做一次历史普查。
- `cross-cat-handoff` 处理交接；检索本身不产生额外协作责任。

## 下一步与相关来源

找到材料后完成用户原任务。需要实现时按原授权继续；只有方向仍待讨论才进入 `collaborative-thinking`。
历史与系统边界见 `docs/features/F200-memory-recall-eval.md`、`docs/features/F256-memory-search-strategy-evolution.md` 和 `../.cat-cafe-shared-refs/memory-routing-partial.md`。
