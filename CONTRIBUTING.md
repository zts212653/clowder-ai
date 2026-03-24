# Contributing to Clowder AI

[English](#english) | [中文](#中文)

---

<a id="english"></a>

> **Maintainers / Triagers**: See [MAINTAINERS.md](MAINTAINERS.md) for triage, labels, assignment, and review guidelines.

## For Beta Testers (Internal Preview)

You have **Write** access to this repo, but `main` is protected — all changes go through **Pull Requests**.

### Quick Start: Submit a PR

```bash
# 1. Fork this repo (click "Fork" button on GitHub, or use gh cli)
gh repo fork zts212653/clowder-ai --clone
cd clowder-ai

# 2. Create a feature branch
git checkout -b feat/your-feature-name

# 3. Install, build, and verify
pnpm install
pnpm build
pnpm check

# 4. Make your changes, then run checks
pnpm check          # Biome lint
pnpm lint           # TypeScript type check
pnpm --filter @cat-cafe/api run test:public  # Public test suite

# 5. Commit and push to YOUR fork
git add -A
git commit -m "feat(scope): description of your change"
git push origin feat/your-feature-name

# 6. Open a PR from your fork → zts212653/clowder-ai main
gh pr create --repo zts212653/clowder-ai
```

### Report bugs or suggest features

- Open an [Issue](https://github.com/zts212653/clowder-ai/issues) — please include reproduction steps for bugs
- Check [pinned issues](https://github.com/zts212653/clowder-ai/issues) for current focus areas

### Feature numbering

Feature IDs (`F001`, `F002`, ...) are assigned by **maintainers**, not by contributors. Here's how it works:

1. **You** open a GitHub Issue describing the feature you want
2. **Maintainers** discuss and approve the idea
3. **Maintainers** assign the next available F-number and create the Feature Doc
4. **You** (or anyone) can then implement against the Feature Doc's Acceptance Criteria

**Bug fixes** don't get F-numbers — they're tracked by their GitHub Issue number directly.

> Don't worry about picking a number. Just open an issue with a clear description of what you want and why.

### Runtime ports

The default ports are `3003` (API) and `3004` (Frontend). See [SETUP.md](SETUP.md) for full configuration.

---

## How Contributing Works Here

Most open source projects say: "write code, open a PR." Clowder works differently.

In the age of AI-assisted development, **code is cheap. Alignment is expensive.** Your AI team can generate thousands of lines in minutes — but if the intent is wrong, all that code is waste.

> Clowder is not a code-only repository.
> For non-trivial changes, the primary contribution is the **intent**: the feature note, protocol update, or design decision that explains what should change and why. Code, tests, and references are how that intent becomes real.

### The Contribution Flow

```
1. Intent          You have an idea or found a problem
      ↓
2. Open an Issue   Describe what you want and why
      ↓
3. Discussion      Maintainers discuss → assign F-number → create Feature Doc
      ↓
4. Execution       Implement against the Feature Doc's Acceptance Criteria
      ↓
5. Verification    Does the result match the doc? Evidence, not confidence.
```

**Step 3 is the most important.** A merged Feature Doc means the community agrees on the *what* and *why*. Implementation follows naturally.

### What's a Feature Doc?

A Feature Doc (`docs/features/F{NNN}-slug.md`) is a structured document created by **maintainers** after approving a feature request. It captures:

- **Why** — the problem, the motivation, who it's for
- **What** — the design, broken into phases
- **Acceptance Criteria** — how we know it's done (checkboxes, not vibes)
- **Refs** — research, prior art, design mockups, user feedback that led here

The Feature Doc is the **single source of truth** for what gets built. Code is a byproduct.

**You don't need to write a Feature Doc yourself.** Open an Issue with a clear problem/solution description, and maintainers will create the doc with an assigned F-number if approved. You're welcome to suggest content for the doc in your Issue — especially Refs and AC ideas.

**Refs matter more than you think.** Including competitive analysis, user quotes, or design explorations in your Issue gives maintainers the context to write a better Feature Doc.

### What Counts as a Contribution

| Type | What It Looks Like |
|------|--------------------|
| **Feature proposal** | An Issue describing problem + proposed solution (maintainer creates the Feature Doc) |
| **Design feedback** | Comment on an existing Feature Doc PR — challenge assumptions, suggest alternatives |
| **Research / Refs** | Add context to an existing feature — competitive analysis, user research, technical spikes |
| **Bug report** | Issue with reproduction steps — becomes a Feature Doc if non-trivial |
| **Code implementation** | PR that implements against a merged Feature Doc's AC |
| **Vision alignment** | "This feature doesn't match the Five Principles because..." |

4 out of 6 contribution types involve **no code at all**.

### PR Types

Not every PR is the same. Different changes have different requirements:

| PR Type | What It Is | What's Required |
|---------|-----------|-----------------|
| **Patch** | Small bug fix, typo, test gap | Code + tests. No Feature Doc needed. |
| **Feature** | New capability or behavior change | Feature Doc must exist **first** (created by maintainer), then code + tests + evidence |
| **Protocol** | Changes to rules, skills, workflows, refs | The document **is** the contribution. Code is supporting. |
| **Adapter** | New agent integration | Contract spec + example config + verification steps + code |

**Rule of thumb:** if your change affects the README roadmap, it needs a Feature Doc.

### What Makes a Contribution Complete

For non-trivial changes, a complete contribution has four layers:

| Layer | What It Is | Example |
|-------|-----------|---------|
| **Intent** | Feature Doc / proposal / design note | `docs/features/F042-info-architecture.md` |
| **Implementation** | Code + tests | `packages/api/src/...` + test files |
| **Operation** | Refs, guides, config examples, README updates | `docs/decisions/`, config samples |
| **Evidence** | Proof it works | Screenshots, test output, logs, regression proof |

Missing intent? We can't tell if this is the right direction.
Missing refs? Others can't build on your work.
Missing evidence? We can't verify it's done.

### Source of Truth

When in doubt about what's authoritative:

| What | Where |
|------|-------|
| Feature behavior and direction | `docs/features/` |
| Collaboration rules and workflows | `cat-cafe-skills/refs/` |
| Architecture decisions | `docs/decisions/` |
| Active work | `docs/ROADMAP.md` |

If code and docs disagree, **fix the doc first, then align the code**. Docs lead, code follows.

### Merge Rules

| Change Size | What You Need |
|-------------|---------------|
| **Small** (patch, typo, test fix) | Code + tests |
| **Medium** (behavior change, new endpoint) | Code + tests + related doc updates |
| **Large** (new feature, protocol change) | Feature Doc merged **first**, then implementation PR |

**README roadmap changes must sync with feature status.** Marketing does not get to run ahead of reality.

### Review: Intent First, Code Second

When reviewing PRs:

1. **Does this match a Feature Doc?** Code without a Feature Doc is unanchored.
2. **Are the Acceptance Criteria met?** Check the boxes with evidence.
3. **Does it align with the Five Principles?** Especially P1 (face the final state) and P5 (verified = done).
4. **Then** look at code quality.

### The Five Principles

Every contribution should respect these:

| # | Principle | Meaning |
|---|-----------|---------|
| P1 | Face the final state | Every step is foundation, not scaffolding |
| P2 | Co-creators, not puppets | Hard constraints are the floor; above it, release autonomy |
| P3 | Direction > speed | Uncertain? Stop, search, ask, confirm, then execute |
| P4 | Single source of truth | Every concept defined in exactly one place |
| P5 | Verified = done | Evidence talks, not confidence |

### Getting Started

1. Read the [README](README.md) to understand what Clowder is
2. Browse `docs/features/` to see existing Feature Docs
3. Check `docs/ROADMAP.md` for the active feature list
4. Look at `docs/decisions/` for past architectural decisions
5. Open an Issue describing the problem or idea (maintainers assign F-numbers and create Feature Docs)
6. Sign the [CLA](CLA.md) on your first PR (the bot will guide you)

### Code Style (When You Do Write Code)

- **TypeScript** with strict mode
- **Biome** for formatting and linting (`pnpm check` / `pnpm check:fix`)
- **pnpm** for package management
- Files under 350 lines (warning at 200)
- No `any` types
- Run `pnpm lint` before submitting

---

<a id="中文"></a>

> **Maintainer / Triager**：分类、标签、认领、审查指南请看 [MAINTAINERS.md](MAINTAINERS.md)。

## 如何为 Clowder 贡献

大多数开源项目说："写代码，提 PR。" Clowder 不一样。

在 AI 辅助开发的时代，**代码不值钱，对齐才值钱。** AI 团队几分钟能生成上千行代码 — 但如果意图错了，这些代码就全是废品。

> Clowder 不是一个纯代码仓库。
> 对于非 trivial 的改动，贡献的主体是**意图**：解释应该改什么、为什么改的功能文档、协议更新或设计决策。代码、测试和参考文档是让意图变成现实的手段。

### Feature 编号规则

Feature 编号（`F001`、`F002`、……）由 **maintainer 分配**，不需要贡献者自己选号：

1. **你** 开一个 GitHub Issue，描述你想要的功能
2. **Maintainer** 讨论并批准
3. **Maintainer** 分配下一个可用的 F 编号，创建 Feature Doc
4. **你**（或任何人）按照 Feature Doc 的验收标准实现

**Bug 修复**不分配 F 编号——直接用 GitHub Issue 号追踪。

> 不用纠结编号。开个 Issue 把你想要的东西和原因说清楚就行。

### 贡献流程

```
1. 意图          你有一个想法，或发现了一个问题
      ↓
2. 开 Issue      描述你想要什么、为什么
      ↓
3. 讨论          Maintainer 讨论 → 分配 F 号 → 创建 Feature Doc
      ↓
4. 执行          按 Feature Doc 的验收标准实现
      ↓
5. 验证          结果和文档一致吗？靠证据，不靠自信
```

**第 3 步最重要。** 一个被 merge 的 Feature Doc 意味着社区在 *做什么* 和 *为什么做* 上达成了共识。实现是自然而然的事。

### Feature Doc 是什么？

Feature Doc（`docs/features/F{NNN}-slug.md`）是由 **maintainer** 在批准功能请求后创建的结构化文档，包含：

- **Why** — 问题是什么、动机是什么、为谁而做
- **What** — 设计方案，按阶段拆分
- **验收标准（AC）** — 怎么判断做完了（用 checkbox，不用感觉）
- **Refs** — 调研、竞品分析、设计稿、促成这个功能的用户反馈

Feature Doc 是**唯一真相源**。代码是它的产物。

**你不需要自己写 Feature Doc。** 在 Issue 里清楚描述问题和方案，maintainer 批准后会创建带 F 编号的文档。欢迎在 Issue 里建议文档内容——尤其是 Refs 和 AC 想法。

**Refs 比你想象的重要。** 在 Issue 里附上竞品分析、用户原话、设计探索，能帮 maintainer 写出更好的 Feature Doc。

### 什么算贡献

| 类型 | 形式 |
|------|------|
| **功能提案** | 一个 Issue 描述问题 + 方案（maintainer 创建 Feature Doc） |
| **设计反馈** | 在已有 Feature Doc PR 上留言 — 质疑假设、提出替代方案 |
| **调研 / Refs** | 为已有功能补充上下文 — 竞品分析、用户研究、技术探针 |
| **Bug 报告** | 带复现步骤的 Issue — 非 trivial 的会变成 Feature Doc |
| **代码实现** | 对照已 merge 的 Feature Doc AC 的 PR |
| **愿景对齐** | "这个功能不符合五条原理，因为……" |

6 种贡献类型里有 4 种**完全不涉及代码**。

### PR 类型

不是每个 PR 都一样。不同改动有不同的要求：

| PR 类型 | 适用场景 | 需要什么 |
|---------|---------|---------|
| **Patch** | 小 bug 修复、文案修正、测试补洞 | 代码 + 测试。不需要 Feature Doc。 |
| **Feature** | 新能力或行为变更 | Feature Doc 必须**先存在**（由 maintainer 创建），再上代码 + 测试 + 证据 |
| **Protocol** | 改规则、技能、工作流、参考文档 | 文档**本身就是**贡献主体。代码是配套。 |
| **Adapter** | 接入新 Agent | 契约规格 + 示例配置 + 验证步骤 + 代码 |

**经验法则：** 如果你的改动会影响 README 路线图，就需要 Feature Doc。

### 完整贡献的四个层次

对于非 trivial 的改动，一个完整的贡献有四层：

| 层次 | 内容 | 示例 |
|------|------|------|
| **意图** | Feature Doc / 提案 / 设计说明 | `docs/features/F042-info-architecture.md` |
| **实现** | 代码 + 测试 | `packages/api/src/...` + 测试文件 |
| **运维** | 参考文档、指南、配置示例、README 更新 | `docs/decisions/`、配置样例 |
| **证据** | 证明它真的能用 | 截图、测试输出、日志、回归证明 |

缺意图？我们无法判断方向对不对。
缺参考文档？别人接不上你的工作。
缺证据？我们无法验证做没做完。

### 真相源层级

拿不准什么说了算时：

| 什么 | 在哪 |
|------|------|
| 功能行为和方向 | `docs/features/` |
| 协作规则和工作流 | `cat-cafe-skills/refs/` |
| 架构决策 | `docs/decisions/` |
| 活跃工作 | `docs/ROADMAP.md` |

如果代码和文档冲突，**先修文档，再对齐代码**。文档领路，代码跟随。

### 合并规则

| 改动规模 | 需要什么 |
|---------|---------|
| **小**（patch、文案、测试补洞） | 代码 + 测试 |
| **中**（行为变更、新接口） | 代码 + 测试 + 相关文档更新 |
| **大**（新功能、协议变更） | Feature Doc **先 merge**，再提实现 PR |

**README 路线图的改动必须同步 Feature 状态。** Marketing 不允许跑在现实前面。

### Review：先看意图，再看代码

Review PR 时的优先级：

1. **有对应的 Feature Doc 吗？** 没有 Feature Doc 的代码是没有锚的。
2. **验收标准达成了吗？** 用证据勾 checkbox。
3. **符合五条第一性原理吗？** 尤其是 P1（面向终态）和 P5（可验证才算完成）。
4. **然后**再看代码质量。

### 五条第一性原理

每个贡献都应该尊重这些原则：

| # | 原理 | 一句话 |
|---|------|-------|
| P1 | 面向终态，不绕路 | 每步是基座不是脚手架 |
| P2 | 共创伙伴，不是木头人 | 硬约束是底线，底线上释放主观能动性 |
| P3 | 方向正确 > 执行速度 | 不确定就停 → 搜 → 问 → 确认 → 再动手 |
| P4 | 单一真相源 | 每个概念只在一处定义 |
| P5 | 可验证才算完成 | 证据说话，不是信心说话 |

### 从哪开始

1. 读 [README](README.md) 了解 Clowder 是什么
2. 浏览 `docs/features/` 看看现有的 Feature Doc
3. 看 `docs/ROADMAP.md` 了解当前活跃的功能列表
4. 翻翻 `docs/decisions/` 看看过去的架构决策
5. 开一个 Issue 描述问题或想法（maintainer 分配 F 编号并创建 Feature Doc）
6. 首次提 PR 时签署 [CLA](CLA.md)（bot 会自动引导）

### 代码规范（当你确实要写代码时）

- **TypeScript** 严格模式
- **Biome** 格式化和 lint（`pnpm check` / `pnpm check:fix`）
- **pnpm** 包管理
- 文件不超过 350 行（200 行开始警告）
- 禁止 `any` 类型
- 提交前跑 `pnpm lint`
