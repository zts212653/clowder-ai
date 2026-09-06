#!/bin/bash
# Session Start Hook — read-only workspace observations
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
共享文档有未提交改动（归属待核实）：
${DIRTY_DOCS}
仅处理归属本次任务的改动，遵守对应共享状态提交规则。
"
fi

# Read the local upstream snapshot; startup does not fetch or claim remote freshness.
UPSTREAM_REF=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)
if [ -n "$UPSTREAM_REF" ]; then
  COUNTS=$(git rev-list --left-right --count "HEAD...${UPSTREAM_REF}" 2>/dev/null)
  AHEAD=$(echo "$COUNTS" | awk '{print $1}')
  BEHIND=$(echo "$COUNTS" | awk '{print $2}')
  if [ -n "$AHEAD" ] && [ -n "$BEHIND" ] && { [ "$AHEAD" -gt 0 ] || [ "$BEHIND" -gt 0 ]; }; then
    WARNINGS="${WARNINGS}
相对本地 upstream 快照 ${UPSTREAM_REF}：ahead=${AHEAD}，behind=${BEHIND}（未联网刷新）。
"
  fi
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
修改前核对任务归属与隔离要求，保全当前分支现场。
"
  fi
fi

# 4. 检查 docs/ 下未跟踪的 .md 文件（猫猫生成了文档但忘记 commit）
UNTRACKED_DOCS=$(git ls-files --others --exclude-standard -- 'docs/*.md' 'docs/**/*.md' 2>/dev/null | head -10)
if [ -n "$UNTRACKED_DOCS" ]; then
  WARNINGS="${WARNINGS}
docs/ 下有未跟踪的 .md 文件（归属与归档状态待核实）：
${UNTRACKED_DOCS}
是否需要归档由本次任务与项目约定决定。
"
fi

# 6. 检查根目录其他杂物（未跟踪且未 ignore 的文件）
ROOT_CLUTTER=$(git ls-files --others --exclude-standard -- ':!.*' 2>/dev/null \
  | awk 'index($0, "/") == 0' \
  | grep -vE '^(package\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml|tsconfig|biome|README|LICENSE|CLAUDE|AGENTS|GEMINI|KIMI|BACKLOG|lefthook\.yml|Makefile|Dockerfile|Procfile|turbo\.json)' \
  | head -10)
if [ -n "$ROOT_CLUTTER" ]; then
  WARNINGS="${WARNINGS}
根目录有未跟踪文件（不据此判定为垃圾）：
${ROOT_CLUTTER}
按任务归属和项目产物约定判断，不自动移动或删除。
"
fi

# 输出提醒（只在有警告时才输出）
if [ -n "$WARNINGS" ]; then
  echo "🐾 工作区观察：${WARNINGS}
仅处理影响当前任务的事项；保全其他工作的改动与工件。上述状态不要求先 pull/push、移走或删除文件，也不改变既有授权与共享状态提交规则。"
fi

# The skill owns task-specific stopping criteria; do not restate a global quota here.
echo "📌 Recall：精确 anchor → cat_cafe_graph_resolve；零先验 → cat_cafe_list_recent；语义查询 → cat_cafe_search_evidence（不确定时 hybrid）。"
echo "🔍 检索深度按题型选择：复杂 coverage/source-map/absence/delta 加载 memory-search-best-practices；停止条件以该 skill 的「何时停下来判据」为真相源。引用结论前读对应原文。"

exit 0
