---
name: co-creation-docs
tips_exempt: "Renewed 2026-10-10: document and selected-avatar delivery classification refines author authorization and repository routing; explicit co-creation requests retain the same entry, with no distinct user discovery action."
description: 共创文档与已选头像原图归档交付：区分只审阅与授权落盘，再按冲突、治理风险、可逆性决定 direct push、PR 和验证。
triggers:
  - "共创文档"
  - "改 MD"
  - "思想纲领"
  - "架构文档"
  - "docs-only"
  - "co-creation docs"
not_for:
  - "只 review 不落盘"
  - "代码或脚本改动"
  - "SOP 或 skill 实现改动"
output: "Risk-matched docs validation + optional content review + commit/push or PR evidence"
---

# Co-Creation Docs Lane

## 价值门禁

Clowder AI 曾把纯文档 PR #2837 跑成 worktree → full gate → cloud review → tracking；operator 在同一 thread 两次追问，并有更早的同型纠偏。这个 skill 保护的是家里特有的交付边界：内容判断与代码级流水线都按真实风险触发，不把“有 Markdown diff”本身当成流程出生证。

## 先判意图

| 意图 | 动作 |
|---|---|
| `review_only` | 只给内容意见；禁止写文件、commit、push |
| `co_create_and_land` | 继续下面的分类与交付 |

用户说“review”不等于授权落盘。用户明确说“这些可以修正/落盘/提交”才进入第二行。

## 分类证据

先问“方案感觉笨重吗”：显然满足以下四项时，猫可直接自判 `delivery=direct_push`，不运行 classifier，不扫全量 PR，也不建 worktree：

- changed files 全是普通 docs-only 内容；
- 不修改 SOP / skill / script / schema / 权限等执行或治理面；
- 没有已知的同路径并发或冲突信号；
- ≤1 commit 可回滚，且不影响外部用户、数据或契约。

拿不准，发现冲突信号，或准备进入 worktree / PR / cloud / full gate 前，才列出完整 changed files（含 untracked）、核 main 方向，并给 classifier 两个显式输入：

- `conflict=none|detected|unknown`；已知在飞 PR 或共享路径争用时才查具体 PR paths；
- `reversibility=one_commit|high|unknown`。

运行：

```bash
pnpm classify:co-creation-docs -- \
  --base origin/main \
  --conflict none \
  --reversibility one_commit
```

`one_commit` 只在“≤1 commit 可回滚 + 不影响外部用户/数据/契约”时成立。拿不准就填 `unknown`；classifier 会要求 PR。classifier 是升档前的风险证据，不是 direct push 的许可仪式。

## 按输出交付

### `delivery=direct_push`

1. 跑轻量增量校验；如果用了 classifier，就消费它返回的 `validation`。
2. 判断 `contentReview=required|reuse|skip`：出现新的观点、架构取舍或事实判断才 `required`；operator 已逐字共创、机械登记/拼写、或已有 verdict 覆盖时 `reuse/skip`。
3. 只暂存本次文档，检查 staged diff。
4. commit body 写 Why + 自己的模型签名；push `origin main`。
5. 回报 changed files、validation、review decision、commit SHA、push 结果。

这条路径不建 worktree、不建 PR、不触发 cloud review、不跑 full gate。

### `delivery=pull_request`

1. 用独立分支避免争用；仍只跑 classifier 返回的 docs validation。
2. 新实质内容才找非作者猫做内容 review；已有 verdict 或可证明机械合并用 continuityProof 复用，不因 SHA 变化重审。
3. docs 的 `cloudReview=skip` / `fullGate=skip` 保持轻量；regular 的 `risk_based` 回五轴判断，不当作必跑或豁免。
4. evidence 闭合后由在场 merge owner 使用 squash merge，不额外召唤一只猫只为按按钮。

PR、cloud、full gate 是三个独立结论。冲突或治理风险可要求 PR，但不自动把 docs 变成代码；家规 / SOP / skill 语境按风险选一只非作者本地猫覆盖治理语义，同族也行，SOP 的元风险强制升档仍适用。context-blind cloud 没有独立风险面时不选择。代码与测试按受影响行为选验证；安全边界或外部契约按实际风险加强审查，不把 cloud 与 full 捆绑。

### `lane=regular_development`

切到 `docs/SOP.md` 的五轴风险路由。脚本、skill、SOP definition 或第一方执行面不能伪装成“也是 Markdown”，但 regular 只决定载体进入开发车道，**不自动串联** planning / TDD / local + cloud / full gate；由行为、数据、安全、契约、不可逆风险分别触发。

### `lane=static_asset_archive`（H 头像原图归档）

用户已选定、只把原图纳入版本控制时，核来源、解码与视觉内容、完整 staged diff 后直接 commit/push main；不为已有选择另开 PR 或请审。当前机器证明只覆盖 `assets/avatars/` 直属目录中新增的普通非可执行 PNG，完整变更集不能混入绑定、代码或生成输入；已有素材替换、SVG、实际网页的 `packages/web/public/avatars/` 及其他目录回风险判断。不能用任意 `assets/` 前缀或图片后缀当作豁免。

分类器与真实 push hook 共用内容/模式证明；hook 核的是将推送的 Git 对象，不读未提交图片来替代。格式结构检查不等于图片解码，也不能证明用户已经选定；这两项由原任务来源和作者轻检查负责，不新增批准表单。unknown 冲突/可逆性仍走 PR 载体，验证不因此自动升级 full/cloud。

## 正反灰例

- 正例：长篇 `docs/architecture/overview.md`，无重叠、单 commit 可逆 → direct push。
- 正例：discussion 与生成 index 同改，条件同上 → direct push。
- 正例：普通 `docs/features/F123-example.md` 内容更新，无重叠、单 commit 可逆 → direct push；目录名本身不是治理风险。
- 正例：`docs/ROADMAP.md` 的机械登记 + 安全 feature doc → main-only direct push；BACKLOG 不进入 PR。
- 反例：只请 review 思想纲领 → review-only，不落盘。
- 反例：改 `cat-cafe-skills/*/SKILL.md` 或 `scripts/*.mjs` → regular development。
- 灰例：只修改 `docs/SOP.md` → PR + 按风险选一只非作者本地治理 reviewer，同族也行；元风险仍按 SOP 升档，cloud/full gate 分别判断。

## Common Mistakes

| 错误 | 后果 | 修复 |
|---|---|---|
| 用“超过 5 行”直接坠入完整 SOP | 文档支付代码级流程税 | 跑 classifier，行数不入模型 |
| 为每份 docs 先跑 classifier / 扫 PR / 开 worktree | 省流程本身变成许可仪式 | 显然 light 直接自判；升重载体前才证明风险 |
| “docs-only”就无脑 push | 可能撞治理/冲突/不可逆边界 | 先看执行面、已知冲突与可逆性；拿不准再 classifier |
| PR 一开就自动 cloud + full gate | 三个独立决策被重新捆绑 | 严格消费 classifier 三列输出 |
| 任何 Markdown diff 都召 reviewer | 机械变更支付判断税 | 只有新实质判断才 required；其余 reuse/skip |
| 内容 peer review 变成测试报告 | 没人真正审思想与结构 | 真需要 reviewer 时只对内容给 verdict |
| 只查 tracked diff | 漏 untracked 文档或工件 | classifier 默认 union tracked + untracked |
| 普通文档改动跑 `check:docs-discovery` | 为生成器实现测试构建共享包、支付安装与全仓扫描税 | 跑 classifier 返回的增量 frontmatter；feature 文档再加 feature truth |

## 验证

- 普通 docs-only 交付：`node scripts/check-frontmatter.mjs --strict-delta --base origin/main`
- 命中 `docs/features/*.md` 时追加：`node scripts/check-feature-truth.mjs`
- 修改 classifier / 本 skill 本身时：`pnpm check:co-creation-docs-lane` 与
  `pnpm check:skills:manifest && pnpm check:skills:surfaces`

`pnpm check:docs-discovery` 验证 docs-discovery 生成器、finalizer 与 ownership 实现；普通内容改动不运行它。

## 和其他 skill 的区别

- `collaborative-thinking`：负责思想探索与收敛；本 skill 负责收敛后的落盘交付。
- `worktree`：负责代码/执行面隔离；classifier 放行的 direct docs 不进入它，regular change 也按风险选择后续车道。
- `merge-gate`：只在 classifier 要求 PR 时接管合入，不覆盖 classifier 的 cloud/full-gate结论。

## 下一步

direct push → 回报证据；pull request → `merge-gate` 的 co-creation docs 分支；regular development → 五轴风险路由（风险需要隔离时才 `worktree`，复杂度需要时才 `writing-plans`）。
