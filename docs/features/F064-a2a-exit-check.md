---
feature_ids: [F064]
related_features: [F046, F055]
feature_id: F064
title: A2A 出口检查 — 链条终止盲区修复
status: done
owner: Ragdoll
created: 2026-03-05
topics: [a2a, prompt-engineering, collaboration]
doc_kind: feature
---

# F064: A2A 出口检查 — 链条终止盲区修复

> **Status**: done | **Owner**: Ragdoll

## Why

F064 的核心动机是修复 A2A 协作中的“链条终止盲区”：该 @ 下一只猫时没有触发动作，导致team lead被迫充当手动路由器。

## What

1. 在 shared-rules 增加发送前出口检查与三问短路
2. 调整Maine Coon workflow trigger 的正负信号比重
3. 打通 `mentionRoutingFeedback` 的提示词读侧注入，形成纠偏反馈

## Acceptance Criteria

### Phase A（规则与提示词）
- [x] AC-A1: 发送前出口检查规则写入 shared-rules 并明确短路条件。
- [x] AC-A2: Maine Coon workflow trigger 正面触发与抑制规则完成平衡调整。

### Phase B（运行时注入）
- [x] AC-B1: 非 parallel 且 a2aEnabled 时注入出口检查提示。
- [x] AC-B2: `mentionRoutingFeedback` read-side 注入与测试覆盖完成。
- [x] AC-B3: write-side 自动回写已部分接入（#417: serial response path via route-serial; callback/post_message path 尚未覆盖）。

## Dependencies

- **Evolved from**: F046（Anti-Drift 协议）
- **Blocked by**: 无
- **Related**: F055（A2A MCP Structured Routing）

## Risk

| 风险 | 缓解 |
|------|------|
| 纠偏提醒误报触发 mention spam | 仅在满足动作词/行首规则时写入反馈，且设置 TTL |
| 只做 read-side 导致闭环不完整 | 明确 write-side 作为后续任务并记录代码入口 |

## 问题

Maine Coon(GPT-5.2) 在协作场景中反复出现两种极端：
1. **链条终止盲区**（高频）：该 @ 下一只猫时完全没有 @ 的意识，消息写完就停了，导致team lead不得不手动补 @ 当路由器
2. **mention spam**（低频但曾爆发）：疯狂 @ 所有猫，不管对方需不需要行动

两者看似矛盾，实为同一根因的两面：**缺少"发消息前出口检查"的决策节点**。

## 根因分析

### 1. 提示词结构偏差

`shared-rules.md` §10 设计了"发 @ 前三问"自检，但这是**事前门控**——假设猫已经意识到"可能需要 @"才会跑这个检查。Maine Coon的问题在更前面：他**根本没走到"要不要 @"这个决策点**。

### 2. Maine Coon WORKFLOW_TRIGGERS 比重失衡

`SystemPromptBuilder.ts` 中 `maine-coon` 的工作流触发点：
- 正面触发点：2 条（完成 review → @ Ragdoll、修完 bug → @ Ragdoll）
- 抑制规则：8 行（@ 自检占一半篇幅）

对比Ragdoll：3 条正面触发 + 0 行抑制规则。

**提示词给Maine Coon传递的信号是"小心 @，别乱 @"，而不是"该 @ 就 @"。** 对本来就倾向"少打扰"的模型底色，三问自检变成了"三重否定门"。

### 3. `mentionRoutingFeedback` 数据流断裂

`InvocationContext` 定义了 `a2aEnabled` 和 `mentionRoutingFeedback` 字段，`route-serial.ts` 也在计算和传入它们。**但 `buildInvocationContext()` 从来没有把它们渲染成提示词文本。** 系统知道上次 @ 没被路由成功，但没告诉猫。

## 解决方案

### 三层修复

**Layer 1: shared-rules.md §10 — 补出口检查（影响所有猫）**
- 新增"出口检查"：每条消息发送前问"这件事到我这里结束了吗？"
- 三问短路：Q1（需要对方采取行动）= 是 → 直接 @，跳过 Q2/Q3
- 明确禁止"把team lead当隐性路由"

**Layer 2: WORKFLOW_TRIGGERS['maine-coon'] — 平衡正面/抑制比重**
- 新增出口检查作为工作流第一步
- 补充讨论/交接等场景的正面触发点
- 精简 @ 自检（保留核心三问，删大段解释）

**Layer 3: 激活 `mentionRoutingFeedback` 提示词渲染（代码改动）**
- `buildInvocationContext()` 中新增 A2A 出口检查提示（非 parallel 且 a2aEnabled 时）
- 渲染 `mentionRoutingFeedback` 为一次性纠正提醒

### 防矫枉过正

上述修复必须同时保留 Anti-Mention-Spam 机制：
- **出口检查不等于"每条消息都 @"** — 只有"不是终点 + 需要对方动"才 @
- **三问自检保留**，但短路规则让 Q1=是时不被 Q2/Q3 拦截
- **parallel 模式不注入出口检查** — 独立思考时不应鼓励 @ 链
- 保留 `MAX_A2A_MENTION_TARGETS = 2` 硬上限
- 保留"三个都是否 → 不 @"的兜底

## 改动范围

| 文件 | 改动 |
|------|------|
| `cat-cafe-skills/refs/shared-rules.md` | §10 补出口检查 + 三问短路 + 禁止隐性路由 |
| `SystemPromptBuilder.ts` WORKFLOW_TRIGGERS | Maine Coon补出口检查 + 平衡正面/抑制比 |
| `SystemPromptBuilder.ts` buildInvocationContext | 激活 a2aEnabled + mentionRoutingFeedback 渲染 |
| `system-prompt-builder.test.js` | 新增出口检查 + 路由反馈注入的断言 |

## 验收标准

- [x] Maine Coon system prompt 中"出口检查"和"@ 自检"篇幅大致平衡（4 正面触发 + 3 行出口检查 + 3 行自检）
- [x] `a2aEnabled=true` 且非 parallel 时，invocation context 包含出口检查提示（line 387-388）
- [x] `mentionRoutingFeedback` 有值时，invocation context 包含纠正提醒（line 391-395）
- [x] parallel 模式不注入出口检查（`context.mode !== 'parallel'` 条件）
- [x] 所有现有 system-prompt-builder 测试 + 新增测试通过（57 pass）
- [x] size guard 未超限（codex prompt 1478 chars < 2000 limit）

## 参考

- 讨论来源：2026-03-05 thread（team lead + Ragdoll + Maine Coon GPT-5.2 联合诊断）
- 历史事件：Maine Coon mention spam 事件（Anti-Mention-Spam 规则起源）
- 相关 Feature：F046 Anti-Drift Protocol、F055 A2A MCP Structured Routing

## Partially Resolved Debt: `mentionRoutingFeedback` write-side (#417)

**状态**：serial response path 已接入；callback/post_message path 尚未覆盖

**已接入路径（route-serial）**：
- `a2a-mentions.ts` 新增 `detectInlineActionMentions()`：邻近性检测句中 `@pattern` + 紧邻动作词
- `route-serial.ts` 在 `parseA2AMentions()` 之后调用检测，命中时写入 `setMentionRoutingFeedback()`
- 下次该猫被唤起时，read-side 渲染为 `[路由提醒]`，消费后自动清除（one-shot）
- `callback-tools.ts` post_message 描述已统一为"行首 @猫名"

**未覆盖路径**：
- `callbacks.ts` 的 post_message callback 路径仍只做行首 mention 解析，未调用 write-side feedback
- 后续如需完整覆盖，需在 callback 写路径也接入 `detectInlineActionMentions`

**误报控制（邻近性检测）**：
- 动作词必须紧邻 @mention 前后（BEFORE: ready for/请/帮/交接给/转给；AFTER: review/check/确认/处理 等）
- 整行有动作词但不紧邻 @mention 不触发（如"请按 @codex 之前的建议继续处理"）
- 纯叙述性提及（如"之前 @codex 提出的方案不错"）不会触发
- feedback 是 one-shot（consumeMentionRoutingFeedback 读后即删），不会反复提醒

## 愿景守护签收表

| 猫猫 | 读了哪些文档 | 三问结论 | 签收 |
|------|-------------|---------|------|
| Ragdoll (opus-45) | F064 聚合文件、对话历史（team experience"他只是单纯的不at下一只猫"）、SystemPromptBuilder 代码 | ① 核心问题是链条终止盲区 ② 三层修复能解决（出口检查+比重平衡+动态注入）③ 猫猫协作时会被提示"到我这里结束了吗" | ✅ 2026-03-06 |
| Maine Coon (codex) | F064 聚合文件、ROADMAP.md、features/README.md、feat-lifecycle SKILL.md | 代码绿（86/86 pass），抓到尾巴：AC 未打勾 + BACKLOG 未同步 + README 缺项。补齐后支持 close | ✅ 2026-03-06 |
| Maine Coon (gpt52) | F064 聚合文件、ROADMAP.md、features/README.md、feat-lifecycle SKILL.md | 同上结论：实现 done 但 completion 闭环未走完。补 docs-only 收尾后可 close | ✅ 2026-03-06 |
