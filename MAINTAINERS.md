# Maintainer Guide

[English](#english) | [中文](#中文)

---

<a id="english"></a>

This guide is for **maintainers and triagers** of the Clowder AI project. If you're looking for how to contribute, see [CONTRIBUTING.md](CONTRIBUTING.md).

## 1. Issue Triage

When a new issue comes in, work through these steps in order:

### 1.1 Classify the Issue

| Type | Criteria | Label |
|------|----------|-------|
| **Bug** | Reports unexpected behavior, has reproduction steps | `bug` |
| **Feature** | Requests new capability or behavior change | `enhancement` |
| **Enhancement** | Small improvement to existing feature (not standalone) | `enhancement` |
| **Duplicate** | Same as an existing issue | `duplicate` |
| **Question** | Usage question, not a bug | Reply and close |

**One issue, one primary classification.** Don't combine `bug` + `enhancement` on the same issue. If investigating a bug reveals a systemic problem, open a new umbrella issue for the larger fix and cross-reference.

### 1.2 Assess Bug Completeness (bugs only)

Before classifying, check if the reporter provided enough information:

| Required Info | Have it? | Action |
|---------------|----------|--------|
| Expected vs actual behavior | Yes | Continue |
| Reproduction steps + environment | No | Add `needs-info` label, ask for details |

**Don't rush to classify when information is missing.** Add `triaged` + `needs-info`, then wait for a response before adding a type label.

### 1.3 Check for Existing Coverage

Before creating new work, search for overlap:

```bash
# Search existing features and roadmap
gh issue list --repo zts212653/clowder-ai --state open --search "{keywords}"
```

| Result | Action |
|--------|--------|
| Already tracked by a Feature | Add `feature:Fxxx` label, comment linking the issue |
| Related but not identical | Add `feature:Fxxx`, maintainer decides merge or separate |
| Completely new | Needs maintainer decision on scope and F-number |
| Too small for a Feature | Keep as `enhancement`, no F-number needed |

### 1.4 Apply Labels

See [Section 2: Labels](#2-labels) for the complete label reference.

### 1.5 Cross-link Related Issues

When multiple issues relate to the same area, link them with comments:

**Umbrella issue comment:**
```markdown
Designating this as the tracking issue for F{xxx}.

Related issues:
- #{N1}: {summary}
- #{N2}: {summary}

Specific fixes will be tracked in the individual issues linked above.
```

**Child issue comment:**
```markdown
This issue is tracked under F{xxx} (umbrella: #{N}).

{context}

If you'd like to contribute a fix, feel free to open a PR from your fork.
We'll credit the original reporter in the upstream fix.
```

### 1.6 Mark Triage Complete

After reading, responding, and making an initial assessment, add the `triaged` label:

```bash
gh issue edit {N} --repo zts212653/clowder-ai --add-label "triaged"
```

If the issue needs a maintainer decision on direction or scope:

```bash
gh issue edit {N} --repo zts212653/clowder-ai --add-label "needs-maintainer-decision"
```

---

## 2. Labels

### Type Labels

| Label | Meaning | Used on |
|-------|---------|---------|
| `bug` | Confirmed bug | Issue / PR |
| `enhancement` | New feature request or improvement | Issue |
| `duplicate` | Same as an existing issue | Issue (before closing) |
| `feature:Fxxx` | Linked to a specific Feature (e.g. `feature:F113`) | Issue / PR |
| `help wanted` | Open for community contribution | Issue |
| `good first issue` | Suitable for newcomers | Issue |
| `question` | Pure inquiry (not a bug/feature), close after answering | Issue |
| `invalid` | Not a valid bug/feature request | Issue |
| `wontfix` | Confirmed won't fix/implement | Issue |

### Status Labels

| Label | Meaning | Who applies |
|-------|---------|-------------|
| `triaged` | Maintainer has read, responded, and assessed | Maintainer after triage |
| `needs-info` | Waiting for reporter to provide more details | Maintainer when info is missing |
| `needs-maintainer-decision` | Triaged but needs senior maintainer input on direction | Maintainer when escalating |

**Key principles:**
- `triaged` answers "have we looked at this?" (process status)
- `bug` / `enhancement` / ... answers "what is it?" (type classification)
- Keep these two dimensions separate
- `question` = pure inquiry (close after answering), `needs-info` = waiting for details (keep open) — don't mix them

**Filtering:**
- `-label:triaged` = untouched issues
- `label:needs-maintainer-decision` = waiting for senior input
- `label:triaged -label:needs-maintainer-decision -label:needs-info` = fully handled

**Do not create labels that aren't in this table.** If you think a new label is needed, propose it in a discussion or issue first.

---

## 3. Issue Assignment

We use **GitHub's native Assignees** to track who's working on what. No custom `wip:` labels needed.

### How It Works

| Want to... | Do this |
|------------|---------|
| **Claim an issue** (maintainer) | Assign yourself: `gh issue edit {N} --add-assignee @me` |
| **Claim an issue** (contributor) | Comment "I'd like to work on this" — a maintainer will assign you |
| **Check who's on it** | Look at the Assignees field (avatar shown on issue cards) |
| **Find your assignments** | `gh issue list --repo zts212653/clowder-ai --assignee @me` |
| **Step back from an issue** | Unassign yourself + comment explaining why |

### Timeout Rules

| Situation | Timeline | Action |
|-----------|----------|--------|
| Assigned but no update | 14 days | Maintainer comments asking for status |
| Still no update after reminder | +7 days (21 total) | Unassign, issue returns to open pool |
| Assignee is blocked | Any time | Comment describing the blocker — another maintainer can help or reassign |

### Multiple Assignees

An issue can have multiple assignees when collaboration is needed. The **first assignee** is considered the lead unless stated otherwise in comments.

---

## 4. PR Review & Merge

### 4.1 Accepted Issue Check

A PR must correspond to an **accepted issue**. An issue is "accepted" when ALL of these are true:

- Has `triaged` label
- Has a type label (`bug` / `enhancement` / `feature:Fxxx`)
- State is OPEN
- Does NOT have `needs-maintainer-decision`
- Does NOT have `needs-info`

**No accepted issue = ask the contributor to open an issue first.**

### 4.2 Merge Gate Checklist

Review every PR against these four criteria:

- [ ] **Accepted Issue** — PR links to an accepted issue
- [ ] **Quality** — CI passes, `pnpm check` + `pnpm lint` clean, no security issues
- [ ] **Direction** — Changes match the issue description / Feature Doc AC
- [ ] **Scope** — PR only changes what it claims to change (no unrelated files)

### 4.3 Patch vs Feature Merge Authority

**Patch PRs — maintainer can merge independently** when ALL four conditions are met:

1. Has an accepted issue
2. Only touches safe paths (source code bug fixes, documentation, tests)
3. CI / tests pass
4. Doesn't touch tooling, security, or sync infrastructure

**Feature PRs — require senior maintainer approval:**
- New capabilities or behavior changes
- Changes to build tooling, CI, or project infrastructure
- Any PR where you're unsure

### 4.4 When Direction Is Right but Quality Isn't

If a PR has the right idea but the implementation needs significant work:

1. Thank the contributor and explain what needs to change
2. Offer specific, actionable feedback
3. If the gap is large: consider implementing the fix upstream and crediting the contributor with `Co-authored-by`

### 4.5 Closing Duplicate or Superseded PRs

```markdown
Thank you for this {report/contribution}. {One sentence acknowledging their effort.}

To consolidate tracking, we're continuing in #{kept-issue}
(tracked under umbrella #{umbrella-issue}).

Closing this as duplicate/superseded — context and contribution
will be preserved and credited in the upstream fix.
```

---

## 5. Communication Guidelines

### Issue Number References

When discussing issues across contexts, **always include the repository prefix**:

- `clowder-ai#58` or `cat-cafe#120` — unambiguous
- `#58` (bare number) — only use in PR bodies for GitHub auto-close syntax (`Fixes #58`)

**In comments, discussions, and cross-references, always use the full prefix.**

### Closing Issues After a Fix

```markdown
Fixed in {PR link}. Thank you for reporting!
```

For issues closed by a sync/release:
```markdown
Shipped in F{xxx} (PR #{sync_pr}). Thank you for reporting!
```

### Asking for More Information

```markdown
Thanks for filing this. To help us investigate, could you provide:

1. **Environment**: OS, Node.js version, pnpm version
2. **Steps to reproduce**: Exact commands you ran
3. **Expected vs actual behavior**: What you expected and what happened

We'll revisit once we have more context.
```

---

## 6. Feature Numbering

Feature IDs (`F001`, `F002`, ...) are assigned by **senior maintainers only**. This is covered in [CONTRIBUTING.md](CONTRIBUTING.md#feature-numbering) — the rule is repeated here for completeness:

1. Contributor opens an Issue describing the feature
2. Maintainers discuss and approve
3. Senior maintainer assigns the next available F-number
4. Implementation proceeds against the Feature Doc's Acceptance Criteria

**Bug fixes don't get F-numbers** — they're tracked by their GitHub Issue number.

---

## 7. Getting Started as a Maintainer

Your first week:

1. Read this guide and [CONTRIBUTING.md](CONTRIBUTING.md)
2. Set up GitHub notifications for the repository
3. Review the [current label list](https://github.com/zts212653/clowder-ai/labels) — familiarize yourself with what exists
4. Browse `docs/features/` to understand active Feature Docs
5. Check `docs/ROADMAP.md` for current priorities
6. Start with issue triage — it's the best way to learn the project's scope

---

---

<a id="中文"></a>

本指南面向 Clowder AI 项目的 **maintainer 和 triager**。如果你想了解如何贡献代码，请看 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 1. Issue 分类（Triage）

新 issue 进来时，按以下步骤处理：

### 1.1 判断类型

| 类型 | 判断标准 | 标签 |
|------|---------|------|
| **Bug** | 报告了异常行为，有复现步骤 | `bug` |
| **Feature** | 请求新能力或行为变更 | `enhancement` |
| **Enhancement** | 对现有功能的小改进（非独立 feature） | `enhancement` |
| **Duplicate** | 和已有 issue 重复 | `duplicate` |
| **Question** | 使用问题，不是 bug | 回复后关闭 |

**一个 issue 一个主分类。** 不要同时打 `bug` + `enhancement`。如果调查 bug 时发现系统性问题，另开一个 umbrella issue 追踪整体修复，互相引用。

### 1.2 Bug 信息完备度（仅 bug 类）

分类前先检查报告者是否提供了足够信息：

| 必要信息 | 有？ | 动作 |
|---------|------|------|
| 期望 vs 实际行为 | 有 | 继续 |
| 复现步骤 + 环境 | 没有 | 打 `needs-info` 标签，发追问模板 |

**信息不足时不要急着打类型标签。** 先打 `triaged` + `needs-info`，等回复后再判断。

### 1.3 关联检测

开新工作前，先搜有没有重叠：

```bash
gh issue list --repo zts212653/clowder-ai --state open --search "{关键词}"
```

| 结果 | 处置 |
|------|------|
| 已有 Feature 覆盖 | 加 `feature:Fxxx` 标签，评论互链 |
| 相关但不完全一样 | 加 `feature:Fxxx`，maintainer 决定合并还是独立 |
| 全新需求 | 需 maintainer 拍板 scope 和 F 编号 |
| 太小不值得立 Feature | 保留 `enhancement`，不给 F 号 |

### 1.4 打标签

完整标签参考见 [第 2 节：标签](#2-标签)。

### 1.5 互链相关 Issue

多个 issue 涉及同一领域时，用评论互链：

**总单评论：**
```markdown
把这张单定为 F{xxx} 的总跟踪 issue，聚合整体目标和进度。

当前相关子问题：
- #{N1}: {简述}
- #{N2}: {简述}

后续具体修复统一以各子单为执行入口推进。
```

**子单评论：**
```markdown
标记：这张单收敛为 F{xxx} 下的具体执行 issue，对应总单 #{总单号}。

{背景说明}

如果作者愿意，欢迎直接从 fork 提 PR；我们也会在 upstream 修复中引用来源并致谢。
```

### 1.6 标记 Triage 完成

读完、回复、做完初判后，**必须打 `triaged`**：

```bash
gh issue edit {N} --repo zts212653/clowder-ai --add-label "triaged"
```

需要高级 maintainer 拍板方向时：

```bash
gh issue edit {N} --repo zts212653/clowder-ai --add-label "needs-maintainer-decision"
```

---

## 2. 标签

### 类型标签

| 标签 | 含义 | 用在 |
|------|------|------|
| `bug` | 确认的 bug | Issue / PR |
| `enhancement` | 新功能请求或改进 | Issue |
| `duplicate` | 和已有 issue 重复 | Issue（关闭前打） |
| `feature:Fxxx` | 关联到具体 Feature（如 `feature:F113`） | Issue / PR |
| `help wanted` | 欢迎社区认领 | Issue |
| `good first issue` | 适合新手 | Issue |
| `question` | 纯咨询（非 bug/feature），回复后可关 | Issue |
| `invalid` | 不是有效的 bug/feature 请求 | Issue |
| `wontfix` | 确认不会修/做 | Issue |

### 流程状态标签

| 标签 | 含义 | 谁打 |
|------|------|------|
| `triaged` | 已读 + 已回 + 已初判 | Maintainer triage 完打 |
| `needs-info` | 等报告者补充信息 | Maintainer 信息不足时打 |
| `needs-maintainer-decision` | 已 triage 但需高级 maintainer 拍板 | Maintainer 升级时打 |

**关键原则：**
- `triaged` 解决"我们处理过没有"（流程状态）
- `bug` / `enhancement` / ... 解决"它是什么"（类型分类）
- 两者分开打，不混用
- `question` = 纯咨询（回复后可关），`needs-info` = 等补充信息（保持 open），二者不混用

**过滤用法：**
- `-label:triaged` = 还没被碰过
- `label:needs-maintainer-decision` = 卡在等高级 maintainer
- `label:triaged -label:needs-maintainer-decision -label:needs-info` = 基本处理完

**不要创建不在此表中的标签。** 如果认为需要新标签，先在 discussion 或 issue 中提案。

---

## 3. Issue 认领

我们用 **GitHub 原生 Assignees** 追踪谁在做什么。不需要自定义 `wip:` 标签。

### 怎么用

| 想要... | 操作 |
|---------|------|
| **认领 issue**（maintainer） | 把自己 assign 上去：`gh issue edit {N} --add-assignee @me` |
| **认领 issue**（贡献者） | 评论"I'd like to work on this"，maintainer 会 assign |
| **看谁在做** | 看 Assignees 字段（issue 卡片上直接显示头像） |
| **查自己的认领** | `gh issue list --repo zts212653/clowder-ai --assignee @me` |
| **放弃认领** | 取消 assign + 评论说明原因 |

### 超时规则

| 情况 | 时间线 | 动作 |
|------|--------|------|
| 已认领但无更新 | 14 天 | Maintainer 评论询问进度 |
| 提醒后仍无更新 | 再 7 天（共 21 天） | 取消 assign，issue 回到公开池 |
| 认领者被卡住 | 随时 | 评论说明卡点，其他 maintainer 可以帮忙或接管 |

### 多人协作

一个 issue 可以有多个 assignee。**第一个 assignee** 默认为 lead，除非评论中另有说明。

---

## 4. PR 审查与合入

### 4.1 Accepted Issue 检查

PR 必须对应一个 **accepted issue**。"accepted" 的条件：

- 有 `triaged` 标签
- 有类型标签（`bug` / `enhancement` / `feature:Fxxx`）
- 状态为 OPEN
- 没有 `needs-maintainer-decision`
- 没有 `needs-info`

**没有 accepted issue → 请贡献者先开 issue。**

### 4.2 Merge Gate

审查每个 PR 时检查四项：

- [ ] **Accepted Issue** — PR 关联到 accepted issue
- [ ] **质量** — CI 通过，`pnpm check` + `pnpm lint` 干净，无安全问题
- [ ] **方向** — 改动和 issue 描述 / Feature Doc AC 一致
- [ ] **Scope** — PR 只改了它声称要改的东西（没有无关文件）

### 4.3 Patch vs Feature 合入权限

**Patch PR — maintainer 可自主合入**，需 4 条件同时满足：

1. 有 accepted issue
2. 只改安全路径（代码 bug 修复、文档、测试）
3. CI / 测试通过
4. 不涉及工具链、安全、sync 基础设施

**Feature PR — 需要高级 maintainer 批准：**
- 新能力或行为变更
- 改动涉及构建工具、CI、项目基础设施
- 拿不准的 PR

### 4.4 方向对但质量不够

PR 方向正确但实现有明显差距时：

1. 感谢贡献者，说明需要改的地方
2. 提供具体、可操作的反馈
3. 差距太大时：考虑在上游完成完整实现，用 `Co-authored-by` 署名致谢原作者

### 4.5 关闭重复或被取代的 PR

```markdown
感谢这份{报告/反馈}。{肯定贡献的一句话}。

为减少同一问题并行跟踪，后续收敛到 #{保留单号}，
由总单 #{总单号} 统一跟踪进度。

这里作为 duplicate / superseded report 关闭；
上下文和贡献信息会继续保留并在后续实现中引用。
```

---

## 5. 沟通规范

### Issue 编号引用

跨上下文讨论时，**必须带仓库前缀**：

- `clowder-ai#58` — 明确
- `#58`（裸编号）— 只在 PR body 中用于 GitHub auto-close 语法（`Fixes #58`）

**在评论、讨论、跨引用中，始终用完整前缀。**

### 修复后关闭 Issue

```markdown
Fixed in {PR link}. Thank you for reporting!
```

随 sync/release 关闭的 issue：
```markdown
Shipped in F{xxx} (PR #{sync_pr}). Thank you for reporting!
```

### 追问补信息

```markdown
Thanks for filing this. To help us investigate, could you provide:

1. **Environment**: OS, Node.js version, pnpm version
2. **Steps to reproduce**: Exact commands you ran
3. **Expected vs actual behavior**: What you expected and what happened

We'll revisit once we have more context.
```

---

## 6. Feature 编号

Feature 编号（`F001`、`F002`、……）由**高级 maintainer 分配**。详见 [CONTRIBUTING.md](CONTRIBUTING.md#feature-numbering)，这里重述规则：

1. 贡献者开 Issue 描述功能
2. Maintainer 讨论并批准
3. 高级 maintainer 分配下一个可用 F 编号
4. 按 Feature Doc 的验收标准实现

**Bug 修复不分配 F 编号**——直接用 GitHub Issue 号追踪。

---

## 7. 新 Maintainer 上手

第一周：

1. 读完本指南和 [CONTRIBUTING.md](CONTRIBUTING.md)
2. 设置仓库的 GitHub 通知
3. 看看[当前标签列表](https://github.com/zts212653/clowder-ai/labels)，熟悉现有标签
4. 浏览 `docs/features/` 了解活跃的 Feature Doc
5. 看 `docs/ROADMAP.md` 了解当前优先级
6. 从 Issue triage 开始——这是了解项目 scope 的最佳方式
