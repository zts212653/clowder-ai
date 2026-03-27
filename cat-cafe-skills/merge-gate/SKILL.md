---
name: merge-gate
description: >
  合入 main 的完整流程：门禁检查 → PR → 云端 review → squash merge → Phase 文档同步 → 清理。
  Use when: reviewer 放行后准备合入、开 PR、触发云端 review、准备 merge。
  Not for: 开发中、review 未通过、自检未完成。
  Output: PR merged + worktree cleaned。
triggers:
  - "合入 main"
  - "merge"
  - "准备合入"
  - "开 PR"
  - "cloud review"
  - "gh pr create"
---

# Merge Gate

合入 main 的完整流程：门禁检查 → PR → 云端 review → squash merge → 清理。

## 核心知识

### 门禁 5 硬条件（全部满足才能开 PR）

1. Reviewer 有**明确放行信号**（"放行"/"LGTM"/"通过"/"可以合入"）
2. **所有 P1/P2** 已修复且经 reviewer 确认
3. Review 针对**当前分支/当前工作**（不是历史 review）
4. BACKLOG 涉及条目已在 feature branch 上标 `[x]`
5. **`pnpm gate` 全绿**（基于最新 `origin/main` rebase 后的全量 build + test + lint + check）

### `pnpm gate` — Latest Main 全量门禁（Step 0，开 PR 前必跑）

```bash
pnpm gate
# 等价于 bash scripts/pre-merge-check.sh
# 自动执行：fetch origin/main → rebase → build → test → lint → check
# 全绿才能继续开 PR。任一步骤失败 → 修复后重跑
```

**为什么需要这一步**：quality-gate 和 request-review 跑的测试基于旧 base SHA。
并行开发中，其他猫的 PR 合入 main 后可能改变共享契约（类型/接口/store 结构），
导致你的代码在新 main 上 break。`pnpm gate` 在最终合流点做一次全量验证，
堵住"每只猫都说绿，合流后一堆红"的系统性漏洞。

**"UT 全绿"三件套证据**（`pnpm gate` 通过后自动打印）：
1. 命令：`pnpm gate`（全量，不是 `--filter`）
2. SHA：基于最新 `origin/main` rebase 后的 HEAD SHA
3. 状态：已 rebase 到最新 `origin/main`

### 合入方式（唯一正确做法）

```bash
# 1. Push feature branch
git push origin {branch}

# 2. 开 PR（读 refs/pr-template.md 获取 body 模板，用 HEREDOC 填写）
gh pr create --title "feat(xxx): ..." --body "$(cat <<'EOF'
... 按 refs/pr-template.md 模板填写 ...
EOF
)"

# 3. 注册 PR tracking（必做，Email Watcher / review 通知路由依赖）
# → 调用 MCP: cat_cafe_register_pr_tracking(repoFullName, prNumber, catId)
# 注册后你会收到三类自动通知（F133 + F140）：
#   - CI/CD 状态变化（pass/fail）→ github-ci connector
#   - PR 冲突检测（CONFLICTING）→ github-conflict connector（urgent 唤醒）
#   - Review feedback（comments + decisions）→ github-review-feedback connector
# 详见 refs/pr-signals.md
#
# 收到冲突通知时（F140 Phase B）：
# - 暂停当前工作，处理冲突优先（冲突是 merge blocker）
# - 在对应 worktree 执行 rebase（参见 refs/pr-signals.md Phase B）
# - rebase 成功后继续原工作流
# - 复杂冲突 → 通知铲屎官，等指示后再继续

# 4. PR body 防呆检查（禁止任何 @句柄出现在 body）
PR_BODY="$(gh pr view {PR_NUMBER} --json body --jq '.body')" || \
  { echo "❌ 无法读取 PR body，停止流程"; exit 1; }
printf '%s\n' "$PR_BODY" | rg -q '@[A-Za-z0-9_-]+ review' && \
  { echo "❌ 不合规：云端 review 触发句柄只能写在 comment，不能写在 body"; exit 1; }
printf '%s\n' "$PR_BODY" | rg -q '@(codex|chatgpt-codex-connector|gpt52|opus|sonnet|gemini)\b' && \
  { echo "❌ 不合规：PR body 禁止出现任何 @句柄（含 HTML 注释中的签名）"; exit 1; }

# 5. 触发云端 review（在 PR comment 中，不是 body！）
HEAD_SHA="$(gh pr view {PR_NUMBER} --json headRefOid --jq '.headRefOid')" || \
  { echo "❌ 无法读取 PR head sha，停止流程"; exit 1; }
SHORT_SHA="${HEAD_SHA:0:8}"

# 5.1 去重防呆（同一 commit 只允许触发一次；新 commit 允许再次触发）
TRIGGER_URL="$(gh pr view {PR_NUMBER} --json comments | jq -r --arg sha "$SHORT_SHA" '
  .comments[]
  | select(.body | contains("Please review latest commit \($sha) for P1/P2 only."))
  | .url
' | head -n 1)"
[ -n "$TRIGGER_URL" ] && \
  { echo "❌ 已对 commit ${SHORT_SHA} 触发过 cloud review: ${TRIGGER_URL}"; exit 1; }

TRIGGER_COMMENT_BODY="$(cat <<'EOF'
{按 refs/pr-template.md 的“云端 Review 触发 Comment 模板”填写}
EOF
)"
gh pr comment {PR_NUMBER} --body "$TRIGGER_COMMENT_BODY"
# ⚠️ 完整模板见 refs/pr-template.md「云端 Review 触发 Comment 模板」

# 6. 等云端 review（事件驱动，不轮询）
#
# 6.1 👀 接单检测（触发后 5 分钟查一次）
TRIGGER_COMMENT_ID=”$(gh api repos/{OWNER}/{REPO}/issues/{PR_NUMBER}/comments \
  --jq “[.[] | select(.body | contains(\”$SHORT_SHA\”))] | last | .id”)”
EYES=”$(gh api repos/{OWNER}/{REPO}/issues/comments/${TRIGGER_COMMENT_ID}/reactions \
  --jq '[.[] | select(.content == “eyes”)] | length')”
#   - EYES > 0 → 云端已接单 → 停止监控，PR tracking 会自动通知结果
#   - EYES == 0 → 云端没接到 → 允许 re-trigger（进 6.2）
#
# 6.2 允许再次触发的条件（满足任一即可）：
#     a. HEAD SHA 变化（有新 commit）
#     b. 触发 comment 存在但 5 分钟后仍无 👀 reaction
#     c. 明确确认第一次触发失败（例如 comment 未发出/被删除）
#     其它情况一律禁止二次触发

# 7. Squash merge（GitHub 处理，禁止本地 squash！）
gh pr merge {PR_NUMBER} --squash --delete-branch

# 7.5 Phase 文档同步（每次 merge 必做！）🔴
# → 见下方「Phase 文档同步」章节

# 8. 更新本地 + 清理
git checkout main && git pull origin main
git worktree remove ../cat-cafe-{feature-name}
git branch -d {branch-name} && git worktree prune

# 8.5 回收 review 沙盒（review-target-id 与 request-review 约定一致）
REVIEW_TARGET_ID="{review-target-id}"  # e.g. f113 or fix-redis-keyprefix
REVIEW_BASE="/tmp/cat-cafe-review/${REVIEW_TARGET_ID}"
if [ -d "$REVIEW_BASE" ]; then
  for sandbox in "$REVIEW_BASE"/*/; do
    [ ! -d "$sandbox" ] && continue
    # no-force 铁律（LL-012）：有未保存改动 → 报阻塞，不硬删
    if git worktree list 2>/dev/null | grep -q "$sandbox"; then
      STATUS=$(cd "$sandbox" && git status --porcelain 2>/dev/null)
      if [ -n "$STATUS" ]; then
        echo "⚠️ Review 沙盒 $sandbox 有未保存改动，跳过"
        continue
      fi
      git worktree remove "$sandbox"
    else
      rm -rf "$sandbox"
    fi
  done
  rmdir "$REVIEW_BASE" 2>/dev/null
  echo "✅ Review 沙盒已回收: $REVIEW_BASE"
fi
git worktree prune  # 清理 dangling worktree references
```

### 云端 review 处理规则

**⚠️ LL-033 教训：必须检查 inline code comments！**

云端 review 的 P1/P2 可能在 **inline code comments** 里，不在 review body 里。
`gh pr view` 的 `--json reviews` 只返回 review body（可能显示"no major issues"），
但 inline code comment 里可能有 P1。

#### 层级 A：通知已包含 severity（自动）

ReviewRouter 现在会在投递通知时**主动拉取** review body + inline comments，
提取 P0/P1/P2 findings 并写入通知消息。如果通知里已有 severity header
（`Review 检测到 P1`），说明**有 actionable findings，必须处理**。

#### 层级 B：merge 前软守护（手动确认）

即使通知层漏报（GitHub API 暂时不可用、新 commit 后内容变化），
merge 前仍需执行以下检查作为兜底：

```bash
gh api --paginate repos/{OWNER}/{REPO}/pulls/{PR_NUMBER}/comments \
  --jq '.[] | select(.body | test("\\bP[012]\\b"; "i")) | {body: .body[:200], path: .path}'
```

- 有 P1/P2 输出 → **WARNING**，确认是否已处理后再决定是否继续
- 无输出 → 通过，继续 Step 7
- 命令执行失败 → **不默认通过**，排查原因或手动检查 PR 页面

| 结果 | 处理 |
|------|------|
| 0 P1/P2（review body + inline comments 都无） | 通过，执行 Step 7 |
| P1/P2 有复现证据 | 在 feature branch 修 → push → **re-trigger review** → 等通过 |
| P1/P2 无复现证据 | 降级 P3，留 comment，视为通过 |
| 误报 | 留 comment 解释，视为通过 |
| 架构/改法建议（非 P1/P2） | **过 VERIFY 三道门再决定改不改**（见 receive-review VERIFY）。云端没有运行环境，理论推理 < 本地实测。改坏能跑的功能 = P0 |

### Phase 文档同步（Step 7.5）🔴

**为什么在 merge-gate 而不是 feat-lifecycle close**：一个 Feature 拆 N 个 Phase/PR，如果等 close 才更新文档，中间所有 session 冷启动读到的都是过时状态。**每次 merge 都是一次增量文档同步。**

**流程**：

1. **识别 Feature**：从 PR title/branch name 提取 `F{NNN}`（如 `feat/f088-phase-c`）
   - 没有 Feature ID → 跳过（纯 TD/hotfix 不需要）

2. **更新 feature doc** `docs/features/F{NNN}-*.md`：
   - **Phase 状态**：本 PR 对应的 Phase 标记从 📋/🚧 → ✅
   - **AC 打勾**：本 PR 实际完成的 AC 项 `[ ]` → `[x]`
   - **Timeline**：加一行 `| {YYYY-MM-DD} | Phase {X} merged (PR #{N}) |`
   - **Status 行**：如果是第一个 Phase 完成，`spec` → `in-progress`
   - **不做**：不动 Dependencies/Risk/Links 等（那些是 kickoff/completion 的事）

3. **Commit**：`docs(F{NNN}): sync phase progress after PR #{N} merge`
   - 如果 merge 在 worktree 清理前完成，在 main 上直接 commit
   - 这是文档同步，不需要走 review

**检查清单**：
- [ ] Feature doc 里本 Phase 标 ✅
- [ ] 相关 AC 打勾
- [ ] Timeline 有 merge 记录
- [ ] Status 行与实际进度一致

## Quick Reference

| 条件 | 检查方式 |
|------|---------|
| Reviewer 放行？ | 搜索明确信号词 |
| P1/P2 清零？ | 检查 review 记录 |
| BACKLOG 更新？ | `grep '\[x\]' docs/ROADMAP.md` |
| 云端通过？ | `gh pr checks {PR}` |
| Phase 文档同步？ | feature doc Phase ✅ + AC 打勾 + Timeline 有记录 |

## Common Mistakes

| 错误 | 正确 |
|------|------|
| PR body 里写了云端 review 触发句柄 | 在 PR **comment** 里写（body 里写会触发代码修改权限而非 review） |
| PR body 或 HTML 注释里写了 `@句柄`（例如签名） | **PR body 禁止任何 @句柄**，签名改为纯文本（如 `codex` / `gpt52`） |
| 同一个 commit 连续发多条触发 comment | 先做 Step 5.1 去重检查；只有新 commit 才 re-trigger |
| 触发后立刻轮询或手动重触发 | 5 分钟后查 👀（Step 6.1）；有 👀 = PR tracking 自动通知，不用管；无 👀 = 允许 re-trigger |
| 修了 P1 不 re-trigger review | 修完 push 后**必须重新触发**云端 review |
| 本地 `git rebase -i` 手动 squash | 用 `gh pr merge --squash`（GitHub 处理） |
| 本地 merge 后 `gh pr close` | `gh pr close` = 放弃，`gh pr merge` = 合入 |
| 不等云端 review 直接合入 | 必须等 0 P1/P2 |
| Merge 后不更新 feature doc | Step 7.5 Phase 文档同步（每次 merge 必做！） |
| Merge 后不清理 review 沙盒 | Step 8.5 按 review-target-id 回收 `/tmp/cat-cafe-review/` |

### **⚠️⚠️ 反面案例（PR #160）— 必须记住**

**错误行为**：
- PR description 里签名写了 `(@句柄)`（在 HTML 注释里）
- 后续说明评论又写了 `@句柄`

**后果**：
- 触发了 `chatgpt-codex-connector` 的“Create an environment”自动回复
- 云端 review 没有实际执行，流程被噪声污染

**硬规则（加粗执行）**：
- **PR body（含 HTML 注释）禁止出现任何 `@句柄`**
- **只允许在专用触发 comment 里使用标准触发模板（见 refs/pr-template.md）**

## 常见 QA（云端 Review 触发）

### Q1: 出现 "Create an environment for this repo"，是不是 review 没权限？

**不是。**

**⚠️ THIS IS NOT A REVIEW-PERMISSION ERROR. THIS MESSAGE IS ABOUT CODE-WRITE ENVIRONMENT PERMISSION.**

触发这个提示通常代表：
- 你用了错误句柄（例如 `@chatgpt-codex-connector review`）
- 或者把触发语句放错位置（body/非模板 comment）

正确做法：
- 只在 PR comment 使用 `refs/pr-template.md` 的标准触发模板（含短 SHA 与 P1/P2 约束）
- 先跑去重检查（Step 5.1），同一 SHA 不重复触发

### Q2: PR 里看到小眼睛（👀）是什么意思？

**小眼睛 = 云端 reviewer 已接单/已看到触发。**

**⚠️ EYES ICON MEANS "REQUEST RECEIVED", NOT "FAILED".**

它不是失败信号，也不等于环境错误。后续是否通过，以 review comment / findings 为准。

### Q3: 触发后多久需要再操作？

默认 **不操作**。

- **5 分钟后查一次 👀**（Step 6.1）：有 👀 = 已接单，PR tracking 会自动通知，猫猫不用管
- **无 👀** = 云端没接到 → 允许 re-trigger
- 有 👀 的情况下严禁重复触发

### Q4: 云端 reviewer 没猫粮了怎么办？

云端 Codex 的"代码审查"额度独立于总额度，可能单独耗尽。此时降级到其他猫做 **完整 PR review**（不是跳过 review！）：

| 原 reviewer | 降级到 | 说明 |
|-------------|--------|------|
| Maine Coon Codex | Maine Coon GPT-5.4 | 同族不同个体 |
| Maine Coon GPT-5.4 | Maine Coon Codex | 反向降级 |
| Ragdoll某个体 | Ragdoll其他个体 / Maine Coon | 同族或跨族 |
| **禁止** | Siamese | 不做代码 review（孟加拉猫 Opus 除外，底层是 Opus） |

**铁律：降级后仍须校验"reviewer ≠ 作者"**——降级表是建议顺序，不能覆盖 self-review 禁令。

操作：`gh pr comment {PR} --body "..."` 用标准触发模板 @ 降级 reviewer（句柄查 `cat-config.json`）。

## 和其他 skill 的区别

- `quality-gate`: 自检（在 review 之前）
- `request-review` / `receive-review`: review 循环（在 merge 之前）
- **本 skill**: review 通过后的合入全流程

## 下一步

合入后判断 feature 规模：

**最后一个 Phase（或小 Feature）** → **直接加载 `feat-lifecycle` completion**（§17）：
1. 自己做愿景三问
2. 自动 @ **非 reviewer、非作者**的猫做愿景守护（查 roster 动态选，不能 hardcode）
3. 守护猫放行 → close feat
4. 守护猫踢回 → 修改后重新走 quality-gate

**中间 Phase（大 Feature，3+ Phase）** → Phase 文档同步（Step 7.5 已做）+ **主动碰头铲屎官**：
1. 成果展示（截图 / demo / 关键改动）
2. 愿景进度（哪些 AC ✅ 了）
3. 下个 Phase 方向 + 新发现
4. "方向对吗？" → 铲屎官确认 → 继续下一个 Phase
