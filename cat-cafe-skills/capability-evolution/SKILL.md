---
name: capability-evolution
description: >
  “我们来进化 X” / “能进化什么” → F311 Capability Evolution 产品入口，不是事后复盘。
  Use when: 用户询问可进化对象或边界，或要求进化一个具体能力、Agent、Skill、工作流、代码仓或外部系统。
  Not for: 复盘已经发生的重复错误、SOP 缺口或知识沉淀（用 self-evolution）；确定性 bug（直接修并加 test/guard）；只有运行健康问题（走 F153 logs/metrics/traces）。
  Output: 信息问题只解释且不创建；具体目标解析 canonical targetRef，并用 sourceMessageId 作为 clientMessageId 调用 cat_cafe_start_evolution_program，返回 durable Program 与 Workspace 入口。
---

# Capability Evolution — 从一句话进入受治理的进化

## 为什么需要这条路由

F311 是围绕一个可变对象运行的长期 Evolution Program；`self-evolution` 是把已经发生的流程经验沉淀成规则、方法或 skill。两者不是同一件事。真实失败是猫听到“能自进化什么”后只讲了通用理念，没有认出已经上线的 F311 产品，也没有建立“具体目标 → canonical start action”的预期。

先问时间方向：用户要**从现在开始进化一个对象**，走本 skill；用户在**复盘已经发生的工作**并要沉淀教训，才走 `self-evolution`。不要因为两句话都含“进化”就按词面路由。

## 先分意图，再决定是否写入

| 用户意图 | 行为 | 副作用 |
|---|---|---|
| “你们能进化什么？”“能力进化是什么？” | 用人话解释对象、边界和下一步 | 不调用 `cat_cafe_start_evolution_program` |
| “我们来进化”但没有目标 | 只追问一个短问题：想进化哪项能力？ | 不创建 Program |
| “我们来进化 X”且 X 是具体目标 | 解析 `targetRef`，立即调用 canonical start tool | 创建或幂等返回 durable Program |

问句里同时出现“我们来进化”和“能进化什么/哪些/啥”仍是信息型，不得因为命中了半句 trigger 就创建。

## 信息型回答

先回答用户真正关心的范围，不让用户读内部 schema：

- 家内能力：猫的 skill、工作流、协作方式、Harness 与产品体验。
- 业务能力：一个明确的业务结果或用户旅程，例如“路演表达效果”。
- 外部能力：有 authenticated owner 与可审计 adapter 的 Agent、代码仓或系统；资产仍留在原 owner。

边界也要一并说清：F311 不声称直接改模型权重；确定契约的 bug 直接走 test/lint/guard；性能、耗时和稳定性走 logs/metrics/traces；没有明确 consumer 与 keep/tune/sunset 决策的问题不冒充 Evolution Program。结尾邀请用户给一个具体目标即可，不让用户填表。

## 具体目标的 canonical start

1. 取用户明确说出的 X；不要替用户扩大成多个对象或多个 claim。
2. 解析 canonical `targetRef`：
   - 已知对象已经有 owner ref：从 feature/skill/owner truth 读取它，使用原 `ownerFeatureId`、`ownerStateRef` 与可选 `version`，不要凭记忆猜 owner。
   - 新的自然语言能力还没有 owner ref：以 F311 admission identity 表示，使用 `{ ownerFeatureId: "F311", ownerStateRef: "capability:" + encodeURIComponent(X.trim()) }`。这只是稳定对象身份，不复制对象 payload，也不替未来 domain owner 签字；缺失角色由 Program 的 typed blocker 表达。
3. `clientMessageId` 必须使用触发这次请求的 exact `sourceMessageId`，让同一用户消息重试保持幂等。没有可验证 source message id 时不得生成随机 id；诚实说明无法绑定这次请求并请用户重试。
4. 调用 `cat_cafe_start_evolution_program({ targetRef, clientMessageId })`。不要自行填写 Goal、claim、stage、lifecycle、证书或角色 payload。
5. 用人话回报：创建/已存在、目标、当前建制状态、用户是否需要行动、下一步；给出返回的 F307 Workspace surface。内部 refs 与 typed blocker code 只在用户追问技术详情时展开。

## Common Mistakes

- **把产品问题路由到 `self-evolution`**：只讲成长理念，用户不知道 F311 已可用。修复：先做本 skill 的信息/动作分流。
- **信息问题也创建 Program**：用户还没选对象就产生持久状态。修复：没有具体 X 时零写入。
- **具体目标只给建议、不调用工具**：看似回答了，Workspace 没有 Program。修复：有具体 X 就走 canonical start action。
- **猜 owner 或让用户填大表**：破坏 owner truth 与零表单入口。修复：已知 owner 必须查证；未知对象使用 F311 admission identity，让 typed blocker 承担缺项。

## 验证

- 信息样本：`我们来进化 嗯？ 你们能自进化什么东西？` → 首答认出 F311、解释范围与边界、零 Program 写入。
- 动作样本：`我们来进化视频生成能力` → 成功调用 `cat_cafe_start_evolution_program`，Program 出现在 Capability Evolution Workspace。
- `eval:capability-wakeup` 的 `capability-evolution-concrete-target` 规则把“具体目标但未成功 start”计为 miss；静态字符串存在不算通过。

## 下一步

Program 创建后以返回 projection 和 F307 surface 为真相；需要管理生命周期时使用既有 Evolution Program surface。若任务转为沉淀重复经验，再切到 `self-evolution`。
