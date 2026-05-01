#!/bin/bash
# Session Start Hook — 开工前自动提醒
# 用户级 hook：所有项目都生效，出征也带着走
# 归属：F050 系统提示词同步 + 猫猫行为规范

# 读取 stdin（hook 协议要求）
INPUT=$(cat)
CWD=$(echo "$INPUT" | grep -oE '"cwd"\s*:\s*"[^"]*"' | head -1 | sed 's/.*: *"//;s/"$//')
[ -z "$CWD" ] && CWD="$(pwd)"

# 只在 git 仓库里生效
cd "$CWD" 2>/dev/null || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

WARNINGS=""

# 1. 检查未提交的共享文档改动
DIRTY_DOCS=$(git diff --name-only -- docs/ cat-cafe-skills/ assets/system-prompts/ 2>/dev/null | head -10)
if [ -n "$DIRTY_DOCS" ]; then
  WARNINGS="${WARNINGS}
⚠️ 发现未提交的共享文档改动（可能是你或其他猫改的）：
${DIRTY_DOCS}
→ 如果是你改的，记得 commit push（家规：共享文档改完立刻提交）
"
fi

# 2. 检查未推送的 commit
UNPUSHED=$(git log --oneline @{u}..HEAD 2>/dev/null | head -5)
if [ -n "$UNPUSHED" ]; then
  WARNINGS="${WARNINGS}
⚠️ 有未 push 的 commit：
${UNPUSHED}
→ 确认是否需要 push
"
fi

# 3. 检查是否在非 main 分支（主仓库不应该 checkout 到其他分支）
BRANCH=$(git branch --show-current 2>/dev/null)
TOPLEVEL=$(git rev-parse --show-toplevel 2>/dev/null)
# 只在主仓库（不是 worktree）检查分支
if [ "$BRANCH" != "main" ] && [ "$BRANCH" != "master" ]; then
  IS_WORKTREE=$(git rev-parse --git-dir 2>/dev/null)
  if [[ "$IS_WORKTREE" != *".git/worktrees/"* ]]; then
    WARNINGS="${WARNINGS}
⚠️ 当前在主仓库的 ${BRANCH} 分支（不是 worktree）
→ 铁律：主仓库禁止 checkout 到非 main 分支，改代码必须开 worktree
"
  fi
fi

# 输出提醒（只在有警告时才输出）
if [ -n "$WARNINGS" ]; then
  echo "🐾 开工自检：${WARNINGS}"
fi

# 通用提醒
echo "📌 Recall：先用 mcp__cat_cafe_memory__.cat_cafe_search_evidence（备选 mcp__cat_cafe__.cat_cafe_search_evidence）搜当前任务上下文；若未暴露，先用 tool_search 精确搜 cat_cafe_search_evidence（CLAUDE.md 家规）"

exit 0
