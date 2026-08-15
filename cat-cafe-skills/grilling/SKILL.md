---
name: grilling
tips_exempt: facilitation skill routed by explicit user language and the skill manifest
description: >
  用分层决策树持续 stress-test 一个计划、决定或想法。
  Use when: 用户说 "grill me"、要求拷问方案、找出隐含假设、或在行动前把关键决策问透。
  Not for: 普通事实问答、已经定稿的执行、代码实现、需要同步写 glossary/ADR 的会话。
  Output: 带推荐答案的 frontier 问题轮次 + 经用户确认的 shared understanding。
  GOTCHA: 环境事实由 agent 自己查；用户只负责取舍。每轮问完整的当前 frontier，但不要提前问依赖尚未解决的问题。
triggers:
  - "grill me"
  - "拷问我的方案"
  - "把这个想法问透"
  - "stress-test"
---

# Grilling

Interview the user relentlessly until you reach a shared understanding. Map the discussion as a **design tree**: every decision branches into the decisions that depend on it.

## Work the Frontier in Rounds

The **frontier** is every decision whose prerequisites are already settled: the questions you can ask now without guessing at answers you have not heard yet.

For each round:

1. Recompute the frontier from the latest answers and discovered facts.
2. Ask every currently unblocked decision in one numbered round.
3. Give a clear recommended answer for every question; the user still owns the decision.
4. Wait for the user's answers before opening the next frontier.

Format each question like this:

```md
❓ **Q1 — <question title>**: <question body and concrete choices>

➡️ **Recommendation:** <recommended answer and the decisive tradeoff>
```

A question whose answer depends on another question still open in this round belongs to a later round.

## Facts Are the Agent's Job

When a frontier question needs a fact from the environment, inspect the filesystem, code, docs, or available tools yourself. If delegation is available, use it for independent fact-finding without blocking unrelated frontier questions. Do not ask the user for information you can retrieve.

Decisions remain the user's. Separate observations from recommendations so the user can see what is factual and what is a proposed tradeoff.

## Completion Gate

The session is complete only when the frontier is empty: every reachable branch has been visited and no material assumption remains silent. Summarize the resulting design tree and ask the user to confirm shared understanding. Do not implement the design before that explicit confirmation.

## 正反灰例

- 正例：用户有一个方向，但边界、失败模式和优先级尚未明确。
- 正例：用户希望在写计划前主动找出“我没想到的问题”。
- 反例：答案能通过一次代码查询直接确定；查完直接回答。
- 反例：用户已确认方案并要求实现；进入开发流程，不重新开启访谈。
- 灰例：需要同时维护 glossary/ADR 时，使用 `grill-with-docs` 组合本 skill 与 `domain-modeling`。

## Common Mistakes

| 错误 | 后果 | 修正 |
|---|---|---|
| 一次抛出整棵树 | 后续问题建立在未决前提上 | 只问当前 frontier |
| 只问问题，不给立场 | 把分析成本转嫁给用户 | 每题给推荐与关键 tradeoff |
| 询问可查询的环境事实 | 用户被迫当检索工具 | 自己查代码、文档和运行环境 |
| 把推荐写成事实 | 用户看不见取舍边界 | 明确区分 evidence 与 recommendation |
| frontier 未空就宣布完成 | 隐含假设进入实施 | 重算 design tree，直到无未访问分支 |

## 下一步

用户确认 shared understanding 后，按需进入 `writing-plans`；若还要同步沉淀领域文档，转 `grill-with-docs`。
