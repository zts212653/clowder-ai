---
feature_ids: [F067]
related_features: [F046, F041]
topics: [vision-drift, verification, cold-start, quality-assurance]
doc_kind: spec
created: 2026-03-06
---

# F067: Cold-start Verifier — 无历史污染的交付物验证

> **Status**: spec | **Owner**: Ragdoll
> **Created**: 2026-03-06
> **Priority**: P2
> **Evolved from**: F046 B2

---

## Why

F041 能力看板事件证明：参与开发的猫猫会被上下文惯性影响，即使 AC 全绿也可能交付物偏离愿景。F046 建立了流程层守护（跨猫签收、review 附需求摘录），但缺少一种**无历史污染**的独立验证机制。

一个从未参与过讨论和开发的 agent，只看原始需求和最终交付物，能给出最客观的"这是不是operator要的"判断。

## What

在 feature completion 流程中引入 Cold-start Verifier：召唤一个**无上下文历史**的独立 agent，只给它原始需求文档和交付物（代码 + 截图），让它判断交付物是否匹配需求。

### 核心设计点

1. **无污染保证**：Verifier 不读开发历史、不读 review 记录、不读讨论——只看需求 spec 和交付物
2. **触发时机**：feature completion Step 0 之后、跨猫签收之前
3. **输入**：原始需求文档（operator experience + AC）+ 交付物清单（代码路径 + 截图/录屏）
4. **输出**：Pass/Fail + 逐项匹配度 + 发现的偏离点

### Open Questions

1. 实现形态：独立 claude 子进程？Codex sandbox？还是普通 subagent？
2. Prompt template 设计：如何确保 verifier 不被交付物的"合理性"说服而忽略需求偏离？
3. 首个试点 Feature：选哪个 Feature 做首次试点验证？
4. 成本考量：每次 completion 多一次 agent 调用，是否值得？什么规模的 Feature 才触发？

## Acceptance Criteria

- [ ] AC-A1: 本文档需在本轮迁移后维持模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。
- [ ] Cold-start Verifier prompt template 设计完成
- [ ] 在至少 1 个 Feature 上试点验证
- [ ] 试点结果记录（Verifier 是否发现了人工未发现的偏离？）
- [ ] 决定是否纳入标准 completion 流程

## Dependencies

- **Evolved from**: F046（从 F046 B2 毕业）
| Feature | 关系 | 说明 |
|---------|------|------|
| **F046** | Evolved from | 从 F046 B2 毕业 |

## Risk / Blast Radius

| 风险 | 严重度 | 缓解 |
|------|--------|------|
| Verifier 太严格导致虚警 | 中 | 先试点再标准化，设 Pass 阈值 |
| 额外成本（多一次 agent 调用） | 低 | 只对中大型 Feature 触发 |
| Verifier 被交付物"合理性"说服 | 中 | Prompt 设计强调"只看需求文档，不推断" |
