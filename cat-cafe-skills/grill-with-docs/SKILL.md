---
name: grill-with-docs
tips_exempt: explicit opt-in facilitation skill; discoverability is provided by the skill manifest
description: >
  把方案拷问与领域文档沉淀组合成一次设计会话。
  Use when: 用户要求 "grill with docs"、边追问边统一术语、或把关键取舍沉淀为 glossary/ADR。
  Not for: 普通问答、已经定稿的执行计划、直接实现代码、只需纯口头 stress-test 的讨论。
  Output: 经确认的 design tree + 按需更新的 CONTEXT.md / ADR。
  GOTCHA: 这是组合 skill；必须显式加载 grilling 与 domain-modeling，不能把它们当斜杠命令。
disable-model-invocation: true
triggers:
  - "grill with docs"
  - "带文档拷问"
  - "边追问边写 ADR"
  - "把方案问透并沉淀"
---

# Grill with Docs

这不是第三套访谈方法，而是两个 skill 的组合入口：

- [`grilling`](../grilling/SKILL.md)：建立 design tree，逐轮解决当前可回答的决策 frontier。
- [`domain-modeling`](../domain-modeling/SKILL.md)：校准领域语言，并在结论形成时更新 glossary；只为真正值得保留的取舍写 ADR。

## 流程

1. **先加载两个依赖 skill。** 在提出第一轮问题前，完整读取并遵守 `grilling` 与 `domain-modeling`。
2. **先查事实。** 读取现有 `CONTEXT.md` / `CONTEXT-MAP.md`、ADR、需求和相关代码；能从环境确认的事实不丢给用户。
3. **按 design tree 追问。** 每轮只问当前 frontier，并为每个问题给出明确推荐。
4. **边收敛边沉淀。** 术语一旦明确，按仓库约定更新 glossary；决策同时满足 ADR 三条件时才写 ADR。
5. **明确确认再实现。** 文档是讨论过程的记录，不代表获准实现。frontier 为空后，请用户确认 shared understanding；确认前不进入代码实现。

## 正反灰例

- 正例：一个新系统方案同时存在术语冲突、边界选择与难以逆转的架构取舍。
- 正例：用户希望“把这个设计问透，并把以后需要记住的原因写下来”。
- 反例：用户只想快速比较两个库，不要求建立完整决策树或修改文档。
- 反例：需求和 ADR 已定，只差拆 implementation steps；使用 `writing-plans`。
- 灰例：只说“grill me”时默认使用 `grilling`；只有明确要求文档沉淀时才使用本组合 skill。

## Common Mistakes

| 错误 | 后果 | 修正 |
|---|---|---|
| 执行 `/grilling` 或 `/domain-modeling` 字符串 | Clowder 不把 slash command 当 skill 调度 | 显式加载两个 skill |
| 把用户当代码搜索器 | 决策被环境事实污染 | 自己读代码、文档和工具输出 |
| 每个选择都写 ADR | 决策日志变成噪音 | 严格执行 domain-modeling 的三条件门槛 |
| glossary 混入实现细节 | 术语真相源失焦 | `CONTEXT.md` 只保留领域语言 |
| 用户未确认就开始实现 | 把访谈误当授权 | 停在 shared-understanding checkpoint |

## 下一步

shared understanding 经用户确认后，再按任务性质进入 `writing-plans` 或 `feat-lifecycle`。
