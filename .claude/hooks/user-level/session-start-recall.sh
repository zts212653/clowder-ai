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

# 2b. 检查是否 behind origin（其他猫 push 了但本地没 pull）
BEHIND=$(git rev-list --count HEAD..@{u} 2>/dev/null)
if [ -n "$BEHIND" ] && [ "$BEHIND" -gt 0 ]; then
  WARNINGS="${WARNINGS}
⚠️ 本地落后 origin ${BEHIND} 个 commit
→ 建议先 git pull 再开工
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

# 4. 检查 docs/ 下未跟踪的 .md 文件（猫猫生成了文档但忘记 commit）
UNTRACKED_DOCS=$(git ls-files --others --exclude-standard -- 'docs/*.md' 'docs/**/*.md' 2>/dev/null | head -10)
if [ -n "$UNTRACKED_DOCS" ]; then
  WARNINGS="${WARNINGS}
⚠️ docs/ 下有未跟踪的 .md 文件（某只猫生成了但忘记 commit push）：
${UNTRACKED_DOCS}
→ 向co-creator汇报，商量处理方式（commit/移走/删除）
"
fi

# 5. 检查根目录图片文件（用文件系统检查，不受 .gitignore 影响）
ROOT_IMAGES=$(find . -maxdepth 1 -type f \( -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' -o -name '*.gif' -o -name '*.webp' \) 2>/dev/null | sed 's|^\./||' | head -10)
if [ -n "$ROOT_IMAGES" ]; then
  WARNINGS="${WARNINGS}
⚠️ 根目录有图片文件（截图应放 assets/screenshots/，设计稿放 designs/）：
${ROOT_IMAGES}
→ 向co-creator汇报，商量移走还是删除
"
fi

# 6. 检查根目录其他杂物（未跟踪且未 ignore 的文件）
ROOT_CLUTTER=$(git ls-files --others --exclude-standard -- ':!.*' ':!packages/' ':!docs/' ':!assets/' ':!scripts/' ':!cat-cafe-skills/' ':!designs/' ':!desktop/' 2>/dev/null \
  | grep -vE '^(package\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml|tsconfig|biome|README|LICENSE|CLAUDE|AGENTS|GEMINI|KIMI|BACKLOG|\.npmrc|\.nvmrc|\.node-version|\.editorconfig|\.prettierrc|Makefile|Dockerfile|Procfile|turbo\.json|\.tool-versions)' \
  | head -10)
if [ -n "$ROOT_CLUTTER" ]; then
  WARNINGS="${WARNINGS}
⚠️ 根目录有不该在这里的文件：
${ROOT_CLUTTER}
→ 向co-creator汇报，商量处理方式
"
fi

# 输出提醒（只在有警告时才输出）
if [ -n "$WARNINGS" ]; then
  echo "🐾 开工自检：${WARNINGS}"
fi

# 通用提醒
echo "📌 Recall 三入口（按场景选）：精确 anchor/看关系 → cat_cafe_graph_resolve | 零先验/扫最近 → cat_cafe_list_recent | 语义/模糊找 → cat_cafe_search_evidence（不确定→search_evidence mode=hybrid）。结果已融合消费加权排序（F200）。详见 CLAUDE.md 记忆系统段。若 MCP 未暴露，先 tool_search 精确搜工具名。"

exit 0
