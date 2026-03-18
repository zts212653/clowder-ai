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

**Context:** This should be run in a dedicated worktree (created by `worktree` skill).

**开工前 Recall（F102 记忆系统）🔴**：写计划前先搜相关历史——`search_evidence("{feature}")` 找相关 spec/ADR/讨论，避免重复造轮子。

**Save plans to:** *(internal reference removed)*

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
**Architecture:** [2-3 sentences about approach]
**Tech Stack:** [Key technologies/libraries]
**前端验证:** [涉及前端？标注 Yes — reviewer 必须用 Playwright/Chrome 实测]

---
```

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

## Remember
- Exact file paths always
- Complete code in plan (not "add validation")
- Exact commands with expected output
- DRY, YAGNI, TDD, frequent commits

## 下一步

计划写完 → **直接加载 `worktree`**（创建隔离开发环境）→ `tdd`（开始实现）。SOP 链条自动推进（§17）。
