---
name: writing-plans
description: >
  将 spec/需求拆分为可执行的分步实施计划。
  Use when: 有 spec 或需求，准备动手前需要拆分步骤。
  Not for: trivial 改动（≤5 行）、已有详细计划。
  Output: 分步实施计划（含 TDD 步骤和检查点）。
triggers:
  - "写计划"
  - "implementation plan"
  - "拆分步骤"
---

# Writing Plans

## Overview

将 spec/需求拆分为分步实施计划。写清楚每步改哪些文件、代码、测试、怎么验证。DRY. YAGNI. TDD. Frequent commits.

**Announce at start:** "I'm using the writing-plans skill to create the implementation plan."

**Context:** Write the plan on main before opening a feature worktree. After the plan is committed, continue to `worktree` and then `tdd`.

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

**Steps are internal implementation rhythm, NOT delivery batches.** The deliverable to the user is a complete feat matching the full spec — not a step's output. Do not expose intermediate steps as "验收点" to the user.

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

**Each step is one action (2-5 minutes):**
- "Write the failing test" - step
- "Run it to make sure it fails" - step
- "Implement the minimal code to make the test pass" - step
- "Run the tests and make sure they pass" - step
- "Commit" - step

## Plan Document Header

**Every plan MUST start with this header:**

```markdown
# [Feature Name] Implementation Plan

**Feature:** F0xx — `docs/features/F0xx-xxx.md`
**Goal:** [One sentence — must match feat doc 的 goal]
**Acceptance Criteria:** [从 feat doc 逐条抄过来，plan 必须覆盖全部 AC]
**Architecture cell:** [ownership cell id from docs/architecture/ownership/README.md]
**Map delta:** none | update required | new cell required
**Map delta why:** [一句话说明为什么不改 map / 改哪个 cell / 为什么需要新 cell]
**Architecture:** [2-3 sentences about approach]
**Tech Stack:** [Key technologies/libraries]
**前端验证:** [涉及前端？标注 Yes — reviewer 必须用 Playwright/Chrome 实测]

---
```

**F191 约束**：普通增量写 `Map delta: none`，不得重新画架构图。`update required` 或 `new cell required` 代表 Phase 0 还包含 ownership map 更新，必须在 implementation steps 里列出来。

## Task Structure

```markdown
### Task N: [Component Name]

**Files:**
- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`

**Step 1: Write the failing test**

```python
def test_specific_behavior():
    result = function(input)
    assert result == expected
```

**Step 2: Run test to verify it fails**

Run: `pytest tests/path/test.py::test_name -v`
Expected: FAIL with "function not defined"

**Step 3: Write minimal implementation**

```python
def function(input):
    return expected
```

**Step 4: Run test to verify it passes**

Run: `pytest tests/path/test.py::test_name -v`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/path/test.py src/path/file.py
git commit -m "feat: add specific feature"
```
```

## Open Questions in Plans

计划中的 Open Question 必须分类：
- **技术 OQ**：实现过程中自行解决
- **价值 OQ**：需要 operator 判断 → 附 Decision Packet（格式见 `refs/decision-matrix.md`），包含 TL;DR + 回滚成本 + 真正需要判断的价值问题

先判断可逆性：回滚成本低的不升级 operator，猫猫自决。

## Remember
- Exact file paths always
- Complete code in plan (not "add validation")
- Exact commands with expected output
- DRY, YAGNI, TDD, frequent commits

## 下一步

计划写完并提交 → **直接加载 `worktree`**（创建隔离开发环境）→ `tdd`（开始实现）。SOP 链条自动推进（§17）。
