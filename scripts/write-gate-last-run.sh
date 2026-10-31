#!/bin/bash
# Write the pre-push gate freshness sentinel.
#
# The worktree-local sentinel preserves the original contract. The shared
# git-common-dir sentinel lets sibling worktrees recognize a recent gate run.

set -euo pipefail

REPO_ROOT="${1:-}"

if [ -z "$REPO_ROOT" ] || [ ! -d "$REPO_ROOT" ]; then
  exit 0
fi

GATE_LAST_RUN_TS="$(date +%s)"
echo "$GATE_LAST_RUN_TS" > "$REPO_ROOT/.gate-last-run"

COMMON_GIT_DIR="$(git -C "$REPO_ROOT" rev-parse --git-common-dir 2>/dev/null || true)"
if [ -z "$COMMON_GIT_DIR" ]; then
  exit 0
fi

case "$COMMON_GIT_DIR" in
  /*) ;;
  *) COMMON_GIT_DIR="$REPO_ROOT/$COMMON_GIT_DIR" ;;
esac

mkdir -p "$COMMON_GIT_DIR/cat-cafe" 2>/dev/null || true
echo "$GATE_LAST_RUN_TS" > "$COMMON_GIT_DIR/cat-cafe/gate-last-run" 2>/dev/null || true
