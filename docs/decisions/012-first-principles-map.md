---
doc_kind: decision
decision_id: 012
title: Cat Café 第一性原理总表
status: accepted
created: 2026-03-09
topics: [first-principles, governance, knowledge-engineering]
related_features: [F059, F086, F046, F043]
related_decisions: [005]
---

# ADR-012: Cat Café 第一性原理总表

## Context

随着 F059、F086、F046、lessons-learned 与 tutorial lessons 持续沉淀，咱们已经形成一套稳定的治理哲学，但目前这些内容分散在：

- `cat-cafe-skills/refs/shared-rules.md`
- `docs/features/F059-open-source-plan.md`
- `docs/features/F086-cat-orchestration-multi-mention.md`
- `docs/public-lessons.md`
- `docs/decisions/005-hindsight-integration-decisions.md`
- `cat-cafe-tutorials/docs/lessons/`

问题不是“我们没有原则”，而是**原则、世界观、操作规则、证据**仍然混在一起，导致：

1. 新猫不容易看出哪些是公理，哪些只是推论。
2. discussion 容易被误读成“定义层”，造成多真相源。
3. tutorial / lessons / feature 文档提供了大量解释，但没有统一地图。

本 ADR 的目的不是发明一套新宪法，而是把现有真相源整理成一张可追溯的地图。

## Decision

Cat Café 的治理结构分为三层：

1. **公理层（Axioms）**  
   不可从其他规则推导的底层真理。定义唯一存放在 `shared-rules.md`。
2. **世界观层（Worldview）**  
   我们怎么看协作、知识、用户、边界。这层来自长期 discussion、feature 收敛与 lessons 的共同提炼。
3. **推论层（Operational Rules）**  
   由公理层与世界观层推导出的具体规则、SOP、门禁、review 纪律。

同时明确：

- `shared-rules.md` 是**规则真相源**
- discussion / mailbox / tutorial / lessons 是**证据层与解释层**
- 本 ADR 是**索引层**，不是第二套规则真相源

## Layer 1: 公理层（P1-P5）

以下 5 条继续以 `shared-rules.md` 为唯一真相源；本节只做索引，不重新定义。

| ID | 公理 | 当前真相源 | 一句话 |
|----|------|-----------|--------|
| P1 | 面向终态，不绕路 | `shared-rules.md` | 每一步都必须是终态基座，不是临时脚手架 |
| P2 | 共创伙伴，不是木头人 | `shared-rules.md` | 硬约束守底线，底线上释放主观能动性 |
| P3 | 方向正确 > 执行速度 | `shared-rules.md` | 不确定时先停、先搜、先问、先确认 |
| P4 | 单一真相源 | `shared-rules.md` | 每个概念只在一处定义，其他地方只能引用 |
| P5 | 可验证才算完成 | `shared-rules.md` | 没有证据就不算完成 |

## Layer 2: 世界观层（W1-W6）

这层是长期讨论中反复出现、但不适合直接写成“硬规则”的团队信条。

### W1. 猫猫是 Agent，不是 API

猫猫不是被动等调用的函数，而是有身份、有上下文、有主动性的行动体。

### W2. 共享文件 / Git / 记忆，才会从三个聊天机器人变成一个团队

协作的本质不是“互相看消息”，而是共享感知、共享状态、共享上下文。

### W3. 用户是 CVO，不是甲方路由器

用户负责表达愿景、判断结果、持续纠偏，而不是充当人肉中转站。CVO 授权猫猫自主行动，只在关键决策点介入——猫猫的职责是让 CVO 能"放心不看"，而不是"随时要看"。

### W4. 知识必须分层治理，不能随地大小拉 markdown

知识要有层次、生命周期、入口与**回填**机制，不是靠文档堆积，更不是写了就不管。

### W5. 家里只回流方法论，不回流项目数据

跨项目能力可以回流为知识工程经验，但外部项目数据不进家门。

### W6. 教训要追到根因，不停留在表面坑

不仅记录“摔了什么坑”，还要追问“为什么这种坑会出现”，最后沉淀成原则或规则。

## Layer 3: 推论层（Rules / SOP / Gates）

以下内容不属于公理本体，而是公理与世界观的具体推论：

推论层不是二等公民。公理与世界观决定方向，推论层负责把方向落成日常执行的主体。

- `shared-rules.md` Rule 1-12
- `docs/SOP.md` 的流程门禁
- 愿景守护 / anti-drift protocol
- review 方法论（Red→Green、P1/P2 当轮清零）
- merge gate、request-review、receive-review 等协作流程

判断标准：

- 能否从 P1-P5 + W1-W6 推导出来？
- 是否属于“怎么做”而不是“我们为什么这样做”？

如果答案是“是”，它就属于推论层。

## 证据索引

### A. 公理定义层

- `cat-cafe-skills/refs/shared-rules.md`

### B. 世界观与哲学收敛层

- `docs/VISION.md`
- `docs/features/F059-open-source-plan.md`
- `docs/features/F087-cvo-bootcamp.md`

注：**Hard Rails, Soft Power, Shared Mission** 是 F059 的品牌表达，不单独视为世界观条目；它是对 P2 + W1 + W3 的对外浓缩。

### C. 知识工程与治理结构层

- `docs/features/F043-mcp-unification.md`
- `docs/features/F046-anti-drift-protocol.md`
- `docs/features/F086-cat-orchestration-multi-mention.md`
- `docs/decisions/005-hindsight-integration-decisions.md`

### D. 教训与反思层

- `docs/public-lessons.md`
- *(internal reference removed)*

关键映射：

- `LL-006` → P5（可验证才算完成）
- `LL-009` / `LL-020` → P3（方向正确 > 执行速度）
- `LL-024` → P4（单一真相源）
- `LL-028` → P1（面向终态，不绕路）

### E. 教学外显层（tutorial repo）

- `cat-cafe-tutorials/docs/lessons/03-meta-rules.md`
- `cat-cafe-tutorials/docs/lessons/09-context-engineering.md`
- `cat-cafe-tutorials/docs/lessons/10-knowledge-management.md`

## Discussion / Tutorial 的地位

为了避免多真相源，明确规定：

1. **discussion 不是定义层**  
   discussion 只能作为证据来源，不能直接视作最新规则。
2. **tutorial 不是规则层**  
   tutorial 用于解释、教学、外显，不负责定义新规则。
3. **只有完成蒸馏的内容才进入真相源**  
   新规则进入 `shared-rules.md`，新教训进入 `public-lessons.md`，新决策进入 ADR。

## Consequences

### 正面结果

- 新猫能快速分辨“什么是公理，什么是推论”
- 我们可以继续扩展文档，而不制造第二套宪法
- tutorial / feature / lessons 的地位会更清晰

### 负面结果

- 以后更新原则时，必须同时维护“定义层”和“索引层”的一致性
- 世界观层仍有一定抽象性，需要持续通过具体 feature 反证和打磨

## Open Questions

1. 这份地图在内部定稿后，是否要进一步提炼为面对开源社区的一页版表达？
2. 是否需要给每条世界观再补一列“典型 feature / codebase 实例”？

## Decision Status

Draft → Accepted。由Maine Coon(GPT-5.4)起草，Ragdoll(Opus 4.6) review 两轮，Ragdoll(Opus 4.5) 独立思考补充 W3，铲屎官定稿。
