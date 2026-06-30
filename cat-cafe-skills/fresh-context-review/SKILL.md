---
name: fresh-context-review
description: >
  Author-triggered fresh-context scan of PR diff before formal review.
  Finding generator, NOT approval authority.
  Use when: quality-gate 通过、PR 非 trivial、想降低正式 reviewer 认知负荷。
  Not for: 正式 review verdict、approval、merge decision。
  Output: Finding list（附在 review request 中）。
triggers:
  - "fresh context"
  - "pre-review scan"
  - "找新眼看看"
---

> **SOP 位置**: 可选步骤，在 `quality-gate` (Step ②) 之后、`request-review` (Step ③a) 之前。
> **SOP definition**: `sop-definitions/development.yaml` stage `fresh_context`（optional）。
> **上一步**: `quality-gate` | **下一步**: `request-review`

# Fresh-Context Pre-Review

在正式 cross-cat review 前，用一个 **fresh-context session**（没参与开发的猫或 author 的新 session）扫一遍 PR diff，产出 finding list。目的是**降低正式 reviewer 的认知负荷**——reviewer 可以先看 fresh-context findings 再看 diff，节约时间聚焦深层问题。

## ⚠️ 身份约束（硬规则 — Non-Goal #4）

**This is a FINDING GENERATOR, not an approval authority.**

- ❌ 不产出 APPROVE / BLOCK / LGTM verdict
- ❌ 不替代 Layer 2/3 named cat review
- ❌ 不签署任何 merge-gate 可识别的放行信号
- ❌ 不影响 Review Provenance Matrix（不产生 localPeerReviewSha / cloudReviewSha）
- ✅ 只产出 "我看到这些 findings"（带签名的 finding list）

## 核心知识

### 触发决策表

| PR 类型 | 触发？ | 理由 |
|---------|--------|------|
| 多文件代码改动（≥3 files, ≥50 行 diff） | ✅ 推荐 | 正式 reviewer 认知负荷高 |
| shared/ 或跨包改动 | ✅ 推荐 | 影响面广，early detection 价值高 |
| 状态机 / 生命周期对象改动 | ✅ 推荐 | 转移边容易漏（F229 教训） |
| 纯文档 / ≤10 行 / typo | ❌ 跳过 | 认知负荷已经很低 |
| SKILL.md-only | ❌ 跳过 | 轻量改动，正式 reviewer 足以覆盖 |
| 紧急 hotfix | ❌ 跳过 | 时间约束优先 |

**决策权在 author**：表格是建议，不是硬规则。Author 自判是否需要 fresh context。

### 盲点正交性（cross-model 价值）

不同模型族有不同的系统性盲点：

- Claude 族（Ragdoll）的盲点 ≠ GPT 族（Maine Coon）的盲点
- 跨族 fresh-context 的 finding yield > 同族 fresh-context
- 这正是 **reviewer delta metric**（AC-B2）要量化的价值

## 流程

### 前置条件

| 条件 | 检查方式 | 未满足时 |
|------|----------|----------|
| `quality-gate` 已通过 | 有本轮 gate report | 先跑 quality-gate |
| PR diff 存在 | `git diff origin/main...HEAD` 有输出 | 没改东西不需要 review |
| Author 判断需要 | 查触发决策表 | 跳过，直接进 request-review |

### Ownership: Author 触发

```
1. Author 完成开发，quality-gate ✅
2. Author 判断是否需要 fresh-context（查触发决策表）
3. 需要 → Author 触发 fresh-context session（见下方 "如何触发"）
4. 不需要 → 直接进 request-review
```

### 如何触发

**方式 A: @ 另一只猫（推荐 — 盲点正交性更高）**

在当前 thread @ 一只没参与开发的猫，附上 diff 和 spec：

```
@{reviewer-handle}

请帮忙做一次 fresh-context pre-review scan：

Branch: {branch-name}
Diff: `git diff origin/main...HEAD`
Spec: `docs/features/F{NNN}-xxx.md`
Plan: `feature-specs/YYYY-MM-DD-xxx.md`

只需要产出 finding list，不需要 verdict。
格式见 cat-cafe-skills/fresh-context-review/SKILL.md "Finding List 格式"。
```

优先跨 family（Ragdoll写的 → @ Maine Coon扫）。
同 family 不同个体也可（opus 写的 → @ sonnet 扫）。

**方式 B: Author 自己的新 session（降级方案）**

如果没有其他猫可用，author 可以在一个**全新的 session** 中自己扫——关键是 fresh context（新 session 没有开发过程的上下文污染）。

注意：方式 B 的盲点正交性为零（同 model 同 prompt），finding yield 预期低于方式 A。

### Fresh-Context Agent 的工作

收到 author 请求后：

1. 读 PR diff（`git diff origin/main...HEAD`）
2. 读相关 spec / plan（路径由 author 提供）
3. 逐文件扫描，关注：
   - correctness（逻辑正确性、边界条件）
   - spec-mismatch（实现与 spec/AC 不一致）
   - missing-test（改了行为但没改测试）
   - security（输入验证、权限检查）
   - performance（N+1、不必要的序列化）
   - naming（与 spec 术语不一致）
4. **不做 verdict** — 只列 findings，带签名

### Finding List 格式

```markdown
## Fresh-Context Findings

Agent: {cat signature}
SHA: {HEAD short sha}
Scope: {N} files, {M} lines changed

| # | File | Line | Category | Finding | Severity |
|---|------|------|----------|---------|----------|
| FC-1 | src/foo.ts | 42 | correctness | 边界条件未处理：`n < 0` 时返回 undefined | P2 |
| FC-2 | src/bar.ts | 18 | naming | 变量 `ctx` 与 spec 中的 `context` 不一致 | P3 |
| FC-3 | test/baz.test.ts | — | missing-test | 新增 `processItem()` 但无 error path 测试 | P2 |

Total: {X} findings ({Y} P1, {Z} P2, {W} P3)

---
*Finding generator only — not an approval authority. 正式 review verdict 由 request-review 流程中的 named reviewer 产出。*
```

**Category 枚举**: `correctness` / `performance` / `naming` / `style` / `security` / `spec-mismatch` / `missing-test` / `doc`

**Severity 规则**:
- P1: 会导致运行时错误 / 数据丢失 / 安全漏洞
- P2: 逻辑不完整 / 缺测试 / 与 spec 不一致
- P3: 命名 / 风格 / 文档

### Author 处理 Findings

Author 收到 finding list 后：

1. **逐条审视**（fresh-context 可能有假阳性——agent 没有开发上下文）
2. **有效的** → 修复后 commit，在 review request 中标注 `fixed (commit {sha})`
3. **无效的** → 在 review request 中标注 `dismissed: {理由}`
4. **Author 对 findings 有最终决定权**（fresh-context 不是 reviewer，不产生 debt 或 follow-up）

## 和正式 Review 的关系

| 维度 | Fresh-Context | 正式 Review（request-review / receive-review） |
|------|--------------|-----------------------------------------------|
| **角色** | Finding generator | Approval authority |
| **产出** | Finding list | APPROVE / BLOCK verdict |
| **权力** | 零（建议性） | 完全（merge-gate 可识别） |
| **触发** | Author 主动 | request-review 流程 |
| **Ownership** | Author | Reviewer |
| **对 merge-gate** | 不可见 | localPeerReviewSha / cloudReviewSha |
| **Delta metric** | 被度量方 | 度量方（标注 FC:covered / FC:new） |

## Common Mistakes

| 错误 | 正确 |
|------|------|
| 把 fresh-context 当正式 review，跳过 request-review | fresh-context 只是预扫，正式 review 仍必须走 |
| Fresh-context agent 给 APPROVE verdict | 只给 finding list，不给 verdict |
| Reviewer 因为 fresh-context "已看过" 就简化 review | Reviewer 独立判断，fresh-context 是参考不是替代 |
| 所有 PR 都跑 fresh-context | 按触发决策表判断，trivial 跳过 |
| Fresh-context findings 产生 follow-up / TD / debt | Author 有最终决定权，dismissed = closed |
| Fresh-context scan 记入 Review Provenance Matrix | 不记入——它不是 review source |

## 下一步

Fresh-context findings 处理完 → 直接进 **`request-review`**（SOP Step ③a）。
在 review request 中附上 fresh-context findings 摘要（见 `refs/review-request-template.md` 的 "Fresh-Context Findings" section）。正式 reviewer 会用 `FC:covered` / `FC:new` 标注自己的 findings（见 `receive-review` skill "Reviewer Delta Annotation"）。
