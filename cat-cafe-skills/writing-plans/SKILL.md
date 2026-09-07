---
name: writing-plans
tips_exempt: internal plan-authoring command-provenance guard; no new end-user capability or discovery surface
description: >
  将 spec/需求拆分为可执行的分步实施计划。
  Use when: 跨组件、状态对象或实施顺序需要明确，且已有需求但缺少可执行计划。
  Not for: 已有可执行计划、已知根因的简单修复、无行为变化的机械改动。
  Output: 目标、关键设计、风险与验证方式明确的实施计划。
triggers:
  - "写计划"
  - "implementation plan"
  - "拆分步骤"
---

# Writing Plans

## Overview

将已明确的需求变成可执行的设计与验证安排。写清关键改动面、依赖、风险与结果检查；实现细节随工作展开。已有计划足够执行时直接复用。

**Announce at start:** "I'm using the writing-plans skill to create the implementation plan."

**Context:** Use the current authorized scope and risk route. A plan can be prepared in an isolated feature checkout; completing it does not automatically activate worktree, TDD, or review. Shared state files still follow their own ownership rules.

**开工前 Recall（F102 记忆系统）🔴**：写计划前先搜相关历史——`search_evidence("{feature}")` 找相关 spec/ADR/讨论，避免重复造轮子。

**Save plans to:** `feature-specs/YYYY-MM-DD-<feature-name>.md`

## Straight-Line Check (A→B, No Detour)

**Before splitting steps, do this first:**

1. **Pin the finish line**: one-sentence B definition + acceptance criteria + "what we're NOT building"
2. **Define terminal schema**: interfaces / types / data structures of the final form — steps are built around this, not throwaway scaffolding
3. **Every step passes three questions:**
   - Will this step's output stay in the final system as-is (extend only, no rewrite)? → Yes = on the line; No = detour
   - What can we demo/test after this step? (no verifiable evidence = detour)
   - If we remove this step, what specific cost does it add to reaching B? (can't articulate = detour)
4. **Pure exploration = explicit Spike** (time-boxed + output is a decision/conclusion, not a deliverable)

**Plan scope follows the user-authorized deliverable.** A full feature request requires the full agreed outcome; an explicitly requested repair or candidate is planned at that scope. Do not silently shrink the requested outcome or call an intermediate step complete delivery.

## Stateful Object Gate（F229 PR-A1 20 轮教训）🔴

Plan 涉及**有生命周期的状态对象**（thread 标记 / carrier / session / 持久 config / cache / 索引 / 注册表）时，「功能描述 + 幂等测试点」**不够**——那是把状态机的边留给 reviewer 逐轮补（PR #2202 实测：4 P1 + 16 P2 全是同一对象的状态转移边——crash window / restore 复活 / deleted-list 漏过滤 / 并发 race / self-heal，打了 20 轮才合入）。

**Census 先行（F229 A3a 二次教训 2026-06-11）**：gate 第一步是**普查**——列出 plan 涉及的全部有生命周期对象再逐个三件套。特别注意"复用现有 API"场景下的**新消费侧状态**（轮询循环、发送闸门、到达判定器都是状态机）。漏报对象 = gate 形同虚设：F229 A3b 三对象三件套齐全，A3a 的 ConversationSendCycle 漏普查 → 云端同型 5 轮逐边补课。

**三件套，缺一 = plan 不完整，不准发给实现猫：**

1. **状态×事件转移表** — 含「唯一 lifecycle owner 是谁」+「旁路 API（generic restore / delete / list）禁止哪些操作」
2. **不变量清单** — INV-N 编号，每条标注可测方式，test matrix 逐条对应
3. **对抗场景** — crash window / 并发双写 / 恢复路径 / 旁路 API 误用，每个场景一条测试

**派生值规则**：能用纯投影（pure selector，零存储）表达的状态，禁止落独立存储——无同步即无失同步。

- 范例：*(internal reference removed)*（球态纯投影 + INV-1~9 + test matrix 即写码顺序）
- 反例：同 feature PR-A1 plan 段（一行"幂等懒创建"→ remote review 20 轮逐边补课）

## Bite-Sized Task Granularity

按依赖与可验证结果拆步骤。每步说明目标、受影响面、关键设计和验证；只有顺序本身影响正确性时才写细操作。

已有精准失败检查可直接作为 RED；无行为变化的机械工作复用对应 checker。提交按完整且可回滚的变更组织，不按固定分钟数或工具调用数切分。

## Plan 内容

计划包含以下信息，已有 spec 或任务记录可直接引用：

- **来源与目标**：原始需求、issue 或已存在的 feature spec；不自行分配 F 编号。
- **验收**：覆盖本次授权交付单元的结果与边界；完整 feature 请求仍覆盖全部 AC。
- **关键设计**：受影响文件/接口、依赖与重要取舍；涉及状态对象时完成上面的状态/不变量分析。
- **Architecture cell / Map delta / Why**：按结构与 ownership 变化填写；普通增量可为 none。
- **验证**：行为风险对应 RED 与回归检查，已有精准 checker 可复用；相关 UI 改动记录实际交互验证路径。
- **实施顺序**：按依赖与可验证结果组织，每步说明完成后能检查什么。

无需把整段实现代码先复制进计划。只有代码片段能消除接口或设计歧义时才加入；完整代码与其测试在实现阶段保持一个真相源。验证命令须从当前仓库确认，模板不预置某语言/框架的教程。

## Open Questions in Plans

计划中的 Open Question 必须分类：
- **技术 OQ**：实现过程中自行解决
- **价值 OQ**：需要 operator 判断 → 附 Decision Packet（格式见 `../.cat-cafe-shared-refs/decision-matrix.md`），包含 TL;DR + 回滚成本 + 真正需要判断的价值问题

先判断可逆性：回滚成本低的不升级 operator，猫猫自决。

## Formatting Command Contract

计划写到格式化步骤时，先从当前仓库的 `package.json`、CI 或现有脚本确认可执行命令及适用范围；不要凭跨仓库习惯猜 formatter。计划中必须写出已确认的完整命令和预期结果，禁止只写“run formatting”或“格式化”。

- 全仓自动修复：`pnpm check:fix`
- 仅格式化本次文件：`pnpm biome format --write <files>`
- 终态验证：`pnpm check`

若仓库真相源提供不同命令，以真相源为准，并在计划中标明来源。

## Remember
- Exact file paths always
- Specify the behavior, interface, constraints, and checks; include code only when it resolves a design ambiguity
- Exact commands with expected output
- DRY, YAGNI, TDD, frequent commits

## 下一步

计划形成后按实际风险进入实现：需要隔离才用 `worktree`；行为或回归风险用 `tdd`；已有精准 RED 则直接复用。计划本身需要持久交接时提交。
