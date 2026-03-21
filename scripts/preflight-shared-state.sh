#!/bin/bash
# scripts/preflight-shared-state.sh — 启动前检查未 push 的共享状态 commit
#
# 厂商无关：任意猫的启动入口均可调用。
# 检查当前分支是否有已 commit 但未 push 的共享状态文件变更。
#
# 共享状态文件（与 .githooks/pre-commit 保持一致）：
#   - docs/BACKLOG.md
#   - cat-template.json
#
# Exit codes:
#   0 = clean
#   1 = 有未 push 的共享状态 commit，必须先 push

set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$PROJECT_DIR" || exit 0

BRANCH=$(git branch --show-current 2>/dev/null)
if [[ -z "$BRANCH" ]]; then
  exit 0
fi

# Find upstream
UPSTREAM=$(git rev-parse --abbrev-ref "@{upstream}" 2>/dev/null || true)
if [[ -z "$UPSTREAM" ]]; then
  # No upstream tracking — check if there are any unpushed commits at all
  # by comparing with origin/<branch>
  REMOTE_REF="origin/$BRANCH"
  if ! git rev-parse "$REMOTE_REF" >/dev/null 2>&1; then
    # Remote branch doesn't exist — entire branch is unpushed
    # Check if any commits on this branch touch shared state
    MERGE_BASE=$(git merge-base HEAD origin/main 2>/dev/null || true)
    if [[ -z "$MERGE_BASE" ]]; then
      exit 0
    fi
    UNPUSHED_SHARED=$(git diff --name-only "$MERGE_BASE"..HEAD 2>/dev/null | grep -E '^(docs/BACKLOG\.md|cat-template\.json)$' || true)
  else
    UNPUSHED_SHARED=$(git diff --name-only "$REMOTE_REF"..HEAD 2>/dev/null | grep -E '^(docs/BACKLOG\.md|cat-template\.json)$' || true)
  fi
else
  UNPUSHED_SHARED=$(git diff --name-only "$UPSTREAM"..HEAD 2>/dev/null | grep -E '^(docs/BACKLOG\.md|cat-template\.json)$' || true)
fi

# Also check uncommitted changes to shared state
UNCOMMITTED_SHARED=$(git diff --name-only 2>/dev/null | grep -E '^(docs/BACKLOG\.md|cat-template\.json)$' || true)
STAGED_SHARED=$(git diff --cached --name-only 2>/dev/null | grep -E '^(docs/BACKLOG\.md|cat-template\.json)$' || true)

HAS_PROBLEM=false

if [[ -n "$UNPUSHED_SHARED" ]]; then
  echo "" >&2
  echo "🚨 PREFLIGHT: 有共享状态文件 commit 了但没 push！" >&2
  echo "未 push 的文件：" >&2
  echo "$UNPUSHED_SHARED" | sed 's/^/  - /' >&2
  echo "请立刻 git push，否则其他猫的修改可能被覆盖。" >&2
  HAS_PROBLEM=true
fi

if [[ -n "$UNCOMMITTED_SHARED" || -n "$STAGED_SHARED" ]]; then
  ALL_DIRTY=$(echo -e "${UNCOMMITTED_SHARED}\n${STAGED_SHARED}" | sort -u | grep -v '^$' || true)
  if [[ -n "$ALL_DIRTY" ]]; then
    echo "" >&2
    echo "⚠️ PREFLIGHT: 共享状态文件有未提交的修改！" >&2
    echo "$ALL_DIRTY" | sed 's/^/  - /' >&2
    echo "请 commit + push 或 git restore 后再继续。" >&2
    HAS_PROBLEM=true
  fi
fi

if $HAS_PROBLEM; then
  echo "" >&2
  exit 1
fi

exit 0
