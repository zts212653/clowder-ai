---
name: community-pr
description: >
  开源仓贡献 PR 准备：F 编号校验、Feature Doc 对齐、PR 格式化。
  Use when: 准备向 clowder-ai 提 PR、fork 用户提交贡献、社区 PR。
  Not for: 内部 cat-cafe PR（用 merge-gate）、review（用 request-review）。
  Output: 编号对齐 + Feature Doc 校验 + 格式化 PR。
---

# Community PR — 开源贡献 PR 准备

## 核心原则

开源仓（clowder-ai）的 Feature 编号由 **maintainer 统一分配**。
贡献者本地可能用了临时编号（如 F110），但官方编号可能是 F115。
**PR 前必须校验并对齐到官方编号。**

## 触发条件

- 准备向 `clowder-ai` 提交 PR
- Fork 用户完成开发，准备提交贡献
- 猫猫收到指令"提 PR"或"准备贡献"

## 流程

### Step 1: 确认 PR 类型

| 类型 | 判断条件 | 需要 Feature Doc？ |
|------|---------|-------------------|
| **Patch** | Bug fix、文案修正、测试补洞 | 不需要 |
| **Feature** | 新能力、行为变更 | 需要 |
| **Protocol** | 规则、workflow 变更 | 文档本身就是贡献 |

### Step 2: 查官方 F 编号（Feature PR 必做）

```bash
# 1. 找到关联的 GitHub Issue
gh issue list --repo zts212653/clowder-ai --label "feature" --state open

# 2. 查看 Issue 详情，找 maintainer 分配的 F 编号
gh issue view {ISSUE_NUMBER} --repo zts212653/clowder-ai

# 3. 在 issue 评论或 label 中寻找：
#    - label: feature:F115
#    - 评论中 maintainer 说"已分配 F115"
#    - 关联的 Feature Doc 路径: docs/features/F115-xxx.md
```

**如果 Issue 没有官方 F 编号**：
- 在 issue 中评论请求分配："@maintainer 请分配 F 编号"
- **不要自行选号** — 等 maintainer 回复后再继续

### Step 3: 本地编号对齐

如果本地使用的编号（如 F110）与官方编号（F115）不同：

```bash
# 1. 找出所有引用了旧编号的文件
grep -r "F110" --include="*.md" --include="*.ts" --include="*.tsx" --include="*.yaml"

# 2. 批量替换
# 文件名重命名
mv docs/features/F110-xxx.md docs/features/F115-xxx.md

# 内容替换（frontmatter、引用、注释）
sed -i '' 's/F110/F115/g' docs/features/F115-xxx.md
# ... 对所有受影响的文件重复

# 3. 验证替换完整性
grep -r "F110" --include="*.md" --include="*.ts" --include="*.tsx"
# 应该零结果
```

### Step 4: Feature Doc 校验（Feature PR 必做）

```bash
# 1. 确认 Feature Doc 存在
ls docs/features/F115-*.md

# 2. 检查 frontmatter 格式
# 必须包含：
#   feature_ids: [F115]
#   doc_kind: spec
#   created: YYYY-MM-DD

# 3. 检查必要章节
#   - Status / Why / What / AC（验收标准）
#   - AC 中的 checkbox 是否有已勾选的完成项

# 4. 对照 AC 检查代码实现
# 逐条确认每个验收标准是否有对应的代码改动和测试
```

### Step 5: 运行质量门禁

```bash
pnpm check          # Biome lint
pnpm lint           # TypeScript 类型检查
pnpm --filter @cat-cafe/api run test:public  # 公开测试套件
```

### Step 6: 组装 PR

**Bug fix PR**：

```bash
gh pr create --repo zts212653/clowder-ai \
  --title "fix: 简短描述" \
  --body "$(cat <<'EOF'
## What
<!-- 改了什么 -->

## Why
Fixes #ISSUE_NUMBER

## Test Evidence
```
pnpm check          # ✅
pnpm lint           # ✅
pnpm --filter @cat-cafe/api test:public  # ✅ X passed
```
EOF
)"
```

**Feature PR**：

```bash
gh pr create --repo zts212653/clowder-ai \
  --title "feat(F115): 简短描述" \
  --body "$(cat <<'EOF'
## What
<!-- 改了什么，关键文件列表 -->

## Why
Implements F115 (#ISSUE_NUMBER)
Feature Doc: docs/features/F115-xxx.md

## AC Checklist
- [x] AC 1: xxx（证据：测试 / 截图）
- [x] AC 2: xxx
- [ ] AC 3: xxx（Phase 2 范围）

## Test Evidence
```
pnpm check          # ✅
pnpm lint           # ✅
pnpm --filter @cat-cafe/api test:public  # ✅ X passed
```

## Tradeoff
<!-- 考虑过的替代方案 -->
EOF
)"
```

## Common Mistakes

| 错误 | 后果 | 修复 |
|------|------|------|
| 自行分配 F 编号 | 与其他贡献者或上游撞号 | 去 Issue 请求 maintainer 分配 |
| 本地编号没改就提 PR | Feature Doc 引用错误的编号 | Step 3 批量替换 |
| Feature PR 没有 Feature Doc | PR 无锚，reviewer 不知道对照什么 | 先开 Issue → 等 Feature Doc merge → 再提实现 PR |
| 跳过 test:public | CI 会挂 | 本地先跑通再提 |
| PR title 没有 feat/fix 前缀 | changelog 生成不正确 | 用 conventional commit 格式 |

## 和其他 skill 的区别

- `merge-gate`：内部 cat-cafe 合入 main 的流程 — community-pr 是**开源贡献者**向 clowder-ai 提 PR
- `request-review`：内部猫间发 review 请求 — community-pr 是**社区 PR 准备**
- `quality-gate`：内部自检 — community-pr 包含编号对齐和 Feature Doc 校验

## 下一步

PR 提交后 → maintainer 会 review → 如有反馈按 `receive-review` 处理。
