#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

NO_REBASE=false
SKIP_INSTALL=false

usage() {
  cat <<'EOF'
Usage: scripts/pre-merge-check.sh [--no-rebase] [--skip-install]

Default behavior:
  1. Fail if the worktree is dirty
  2. Fetch origin/main and rebase current branch onto it
  3. Run pnpm build / test / lint / check
  4. Print the "UT 全绿" evidence triple

Flags:
  --no-rebase    Skip fetch + rebase. Useful for local verification before commit.
  --skip-install Skip pnpm install --frozen-lockfile.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --) ;;
    --no-rebase) NO_REBASE=true ;;
    --skip-install) SKIP_INSTALL=true ;;
    --help|-h) usage; exit 0 ;;
    *)
      echo "Unknown option: $arg" >&2
      usage >&2
      exit 1
      ;;
  esac
done

cd "$PROJECT_DIR"

BRANCH=$(git branch --show-current 2>/dev/null || true)
if [[ -z "$BRANCH" ]]; then
  echo "pre-merge-check requires a branch checkout" >&2
  exit 1
fi

if ! $NO_REBASE && [[ -n "$(git status --porcelain)" ]]; then
  echo "pre-merge-check requires a clean worktree before rebasing." >&2
  echo "Use --no-rebase for local verification on uncommitted changes." >&2
  exit 1
fi

REBASE_SUMMARY="skipped (--no-rebase)"
if ! $NO_REBASE; then
  git fetch origin
  git rebase origin/main
  REBASE_SUMMARY="rebased onto origin/main"
fi

if ! $SKIP_INSTALL; then
  pnpm install --frozen-lockfile
fi

run_step() {
  local label="$1"
  shift
  echo ""
  echo "==> $label"
  "$@"
}

run_step "pnpm build" pnpm build
run_step "pnpm test" pnpm test
run_step "pnpm lint" pnpm lint
run_step "pnpm check" pnpm check

HEAD_SHA=$(git rev-parse --short HEAD)

echo ""
echo "UT 全绿三件套"
echo "1. command: pnpm gate"
echo "2. sha: $HEAD_SHA"
echo "3. rebase: $REBASE_SUMMARY"
