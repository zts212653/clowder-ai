#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEFAULT_ALPHA_DIR="$(cd "$PROJECT_DIR/.." && pwd)/cat-cafe-alpha"
DEFAULT_LEGACY_ALPHA_DIR="$(cd "$PROJECT_DIR/.." && pwd)/cat-cafe-main-test"

ALPHA_DIR="${CAT_CAFE_ALPHA_DIR:-$DEFAULT_ALPHA_DIR}"
LEGACY_ALPHA_DIR="${CAT_CAFE_ALPHA_LEGACY_DIR:-$DEFAULT_LEGACY_ALPHA_DIR}"
ALPHA_BRANCH="${CAT_CAFE_ALPHA_BRANCH:-alpha/main-sync}"
LEGACY_ALPHA_BRANCH="${CAT_CAFE_ALPHA_LEGACY_BRANCH:-main-test/main-sync}"
REMOTE_NAME="${CAT_CAFE_ALPHA_REMOTE:-origin}"

ALPHA_WEB_PORT="${CAT_CAFE_ALPHA_WEB_PORT:-3011}"
ALPHA_API_PORT="${CAT_CAFE_ALPHA_API_PORT:-3012}"
ALPHA_GATEWAY_PORT="${CAT_CAFE_ALPHA_GATEWAY_PORT:-4111}"
ALPHA_REDIS_PORT="${CAT_CAFE_ALPHA_REDIS_PORT:-6398}"
ALPHA_REDIS_URL="${CAT_CAFE_ALPHA_REDIS_URL:-redis://localhost:${ALPHA_REDIS_PORT}}"

FORCE=false
RUN_INSTALL=true
SYNC_BEFORE_START=true
START_ARGS=()

usage() {
  cat <<'EOF'
Cat Cafe Alpha Worktree Manager

Usage:
  ./scripts/alpha-worktree.sh init   [--dir PATH] [--branch NAME] [--remote NAME] [--no-install]
  ./scripts/alpha-worktree.sh sync   [--dir PATH] [--branch NAME] [--remote NAME] [--force] [--no-install]
  ./scripts/alpha-worktree.sh start  [--dir PATH] [--branch NAME] [--remote NAME] [--force] [--no-sync] [--] [start-dev args...]
  ./scripts/alpha-worktree.sh status [--dir PATH] [--branch NAME] [--remote NAME]

Defaults:
  --dir    ../cat-cafe-alpha
  --branch alpha/main-sync
  --remote origin

Alpha ports:
  frontend=3011 api=3012 preview-gateway=4111 redis=6398

Notes:
  alpha mirrors origin/main for post-merge acceptance.
  legacy ../cat-cafe-main-test is auto-migrated when detected.
EOF
}

info() {
  echo "[alpha-worktree] $*"
}

die() {
  echo "[alpha-worktree] ERROR: $*" >&2
  exit 1
}

join_by() {
  local delim="$1"
  shift || true
  local first=true
  local value
  for value in "$@"; do
    if [ "$first" = true ]; then
      printf '%s' "$value"
      first=false
    else
      printf '%s%s' "$delim" "$value"
    fi
  done
}

abs_path() {
  local input="$1"
  local dir base

  case "$input" in
    /*)
      dir="$(dirname "$input")"
      base="$(basename "$input")"
      ;;
    *)
      dir="${PWD%/}/$(dirname "$input")"
      base="$(basename "$input")"
      ;;
  esac

  if [ -d "$dir" ]; then
    dir="$(cd "$dir" && pwd -P)"
  fi

  printf '%s/%s\n' "${dir%/}" "${base%/}"
}

registered_worktree_paths() {
  git -C "$PROJECT_DIR" worktree list --porcelain | awk '/^worktree / {print substr($0, 10)}'
}

worktree_exists() {
  registered_worktree_paths | grep -Fxq "$ALPHA_DIR"
}

legacy_worktree_exists() {
  registered_worktree_paths | grep -Fxq "$LEGACY_ALPHA_DIR"
}

require_git_repo() {
  git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || die "project dir is not a git repository: $PROJECT_DIR"
}

ensure_remote_exists() {
  git -C "$PROJECT_DIR" remote get-url "$REMOTE_NAME" >/dev/null 2>&1 \
    || die "remote '$REMOTE_NAME' not found"
}

probe_port_with_lsof() {
  local port="$1"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1
}

probe_port_with_ss() {
  local port="$1"
  ss -ltn "( sport = :$port )" 2>/dev/null | awk 'NR > 1 { found = 1; exit } END { exit found ? 0 : 1 }'
}

probe_port_with_nc() {
  local port="$1"
  nc -z 127.0.0.1 "$port" >/dev/null 2>&1 || nc -z localhost "$port" >/dev/null 2>&1
}

probe_port_with_dev_tcp() {
  local port="$1"
  (exec 3<>"/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1 || (exec 3<>"/dev/tcp/localhost/$port") >/dev/null 2>&1
}

port_is_listening() {
  local port="$1"

  if command -v lsof >/dev/null 2>&1 && probe_port_with_lsof "$port"; then
    return 0
  fi
  if command -v ss >/dev/null 2>&1 && probe_port_with_ss "$port"; then
    return 0
  fi
  if command -v nc >/dev/null 2>&1 && probe_port_with_nc "$port"; then
    return 0
  fi
  if probe_port_with_dev_tcp "$port"; then
    return 0
  fi

  return 1
}

alpha_stack_running() {
  port_is_listening "$ALPHA_WEB_PORT" || port_is_listening "$ALPHA_API_PORT" || port_is_listening "$ALPHA_GATEWAY_PORT"
}

print_yes_no() {
  if "$@"; then
    echo "yes"
  else
    echo "no"
  fi
}

ensure_alpha_clean() {
  local dirty
  dirty=$(git -C "$ALPHA_DIR" status --short -uno 2>/dev/null || true)
  if [ -z "$dirty" ] || [ "$FORCE" = "true" ]; then
    return 0
  fi

  local drift_files
  drift_files=$(git -C "$ALPHA_DIR" diff HEAD --name-only 2>/dev/null || true)
  if [ "$drift_files" = "pnpm-lock.yaml" ]; then
    info "lock drift detected — stashing before sync"
    git -C "$ALPHA_DIR" stash push -m "alpha-lock-drift-pre-sync-stash" -- pnpm-lock.yaml
    return 0
  fi

  die "alpha worktree has local changes. Commit/stash first, or re-run with --force."
}

ensure_alpha_branch() {
  local branch
  branch=$(git -C "$ALPHA_DIR" rev-parse --abbrev-ref HEAD)
  if [ "$branch" != "$ALPHA_BRANCH" ]; then
    die "alpha worktree is on branch '$branch', expected '$ALPHA_BRANCH'"
  fi
}

migrate_legacy_alpha_worktree() {
  if worktree_exists || ! legacy_worktree_exists; then
    return 0
  fi

  if [ -e "$ALPHA_DIR" ]; then
    if [ -n "$(ls -A "$ALPHA_DIR" 2>/dev/null || true)" ]; then
      return 0
    fi
    rmdir "$ALPHA_DIR" || die "failed to clear empty alpha target dir before legacy migration: $ALPHA_DIR"
  fi

  info "migrating legacy alpha worktree from $LEGACY_ALPHA_DIR"

  local legacy_branch
  legacy_branch=$(git -C "$LEGACY_ALPHA_DIR" rev-parse --abbrev-ref HEAD)
  case "$legacy_branch" in
    "$ALPHA_BRANCH")
      ;;
    "$LEGACY_ALPHA_BRANCH")
      if git -C "$PROJECT_DIR" show-ref --verify --quiet "refs/heads/$ALPHA_BRANCH"; then
        git -C "$LEGACY_ALPHA_DIR" checkout "$ALPHA_BRANCH" >/dev/null 2>&1 \
          || die "legacy worktree could not checkout existing '$ALPHA_BRANCH'"
      else
        git -C "$LEGACY_ALPHA_DIR" branch -m "$ALPHA_BRANCH"
      fi
      ;;
    *)
      die "legacy alpha worktree is on branch '$legacy_branch', expected '$LEGACY_ALPHA_BRANCH' or '$ALPHA_BRANCH'"
      ;;
  esac

  mkdir -p "$(dirname "$ALPHA_DIR")"
  git -C "$PROJECT_DIR" worktree move "$LEGACY_ALPHA_DIR" "$ALPHA_DIR" \
    || die "failed to move legacy alpha worktree to $ALPHA_DIR"
  info "legacy alpha worktree migrated to $ALPHA_DIR"
}

install_alpha_dependencies() {
  info "installing dependencies in alpha worktree"
  pnpm -C "$ALPHA_DIR" install --frozen-lockfile
}

ensure_alpha_dependencies() {
  local missing=()

  [ -d "$ALPHA_DIR/node_modules" ] || missing+=("node_modules")
  [ -f "$ALPHA_DIR/packages/web/node_modules/next/package.json" ] || missing+=("packages/web:next")
  [ -f "$ALPHA_DIR/packages/api/node_modules/tsx/package.json" ] || missing+=("packages/api:tsx")
  [ -f "$ALPHA_DIR/packages/mcp-server/node_modules/typescript/package.json" ] || missing+=("packages/mcp-server:typescript")

  if [ "${#missing[@]}" -eq 0 ]; then
    return 0
  fi

  local joined_missing
  joined_missing=$(join_by ", " "${missing[@]}")
  info "detected missing alpha prerequisites: $joined_missing"

  if [ "$RUN_INSTALL" != "true" ]; then
    die "alpha prerequisites missing ($joined_missing). Run 'pnpm -C \"$ALPHA_DIR\" install --frozen-lockfile' or omit --no-install."
  fi

  install_alpha_dependencies
}

init_alpha_worktree() {
  require_git_repo
  ensure_remote_exists
  migrate_legacy_alpha_worktree

  if worktree_exists; then
    info "alpha worktree already exists: $ALPHA_DIR"
    return 0
  fi

  mkdir -p "$(dirname "$ALPHA_DIR")"
  if [ -e "$ALPHA_DIR" ] && [ -n "$(ls -A "$ALPHA_DIR" 2>/dev/null || true)" ]; then
    die "target path exists and is not an empty alpha worktree: $ALPHA_DIR"
  fi

  info "fetching $REMOTE_NAME/main"
  git -C "$PROJECT_DIR" fetch "$REMOTE_NAME" main

  if git -C "$PROJECT_DIR" show-ref --verify --quiet "refs/heads/$ALPHA_BRANCH"; then
    info "adding existing branch '$ALPHA_BRANCH' to $ALPHA_DIR"
    git -C "$PROJECT_DIR" worktree add "$ALPHA_DIR" "$ALPHA_BRANCH"
  else
    info "creating branch '$ALPHA_BRANCH' from $REMOTE_NAME/main"
    git -C "$PROJECT_DIR" worktree add "$ALPHA_DIR" -b "$ALPHA_BRANCH" "$REMOTE_NAME/main"
  fi

  if [ "$RUN_INSTALL" = "true" ]; then
    install_alpha_dependencies
  fi

  info "alpha worktree ready at $ALPHA_DIR"
}

sync_alpha_worktree() {
  require_git_repo
  ensure_remote_exists
  migrate_legacy_alpha_worktree
  worktree_exists || die "alpha worktree not found at $ALPHA_DIR (run init first)"

  if alpha_stack_running && [ "$FORCE" != "true" ]; then
    die "alpha ports appear active; stop alpha before sync, or re-run with --force."
  fi

  ensure_alpha_clean
  ensure_alpha_branch

  info "syncing alpha worktree with $REMOTE_NAME/main (ff-only)"
  git -C "$ALPHA_DIR" fetch "$REMOTE_NAME" main
  if ! git -C "$ALPHA_DIR" merge --ff-only "$REMOTE_NAME/main" 2>/dev/null; then
    die "alpha sync failed (ff-only merge rejected)"
  fi

  if [ "$RUN_INSTALL" = "true" ]; then
    install_alpha_dependencies
  fi

  info "alpha sync complete"
}

status_alpha_worktree() {
  require_git_repo
  migrate_legacy_alpha_worktree

  if ! worktree_exists; then
    echo "alpha worktree: missing"
    echo "expected path: $ALPHA_DIR"
    echo "branch: $ALPHA_BRANCH"
    echo "frontend_port: $ALPHA_WEB_PORT"
    echo "api_port: $ALPHA_API_PORT"
    echo "preview_gateway_port: $ALPHA_GATEWAY_PORT"
    echo "redis_port: $ALPHA_REDIS_PORT"
    echo "web_running: $(print_yes_no port_is_listening "$ALPHA_WEB_PORT")"
    echo "api_running: $(print_yes_no port_is_listening "$ALPHA_API_PORT")"
    echo "preview_gateway_running: $(print_yes_no port_is_listening "$ALPHA_GATEWAY_PORT")"
    echo "redis_running: $(print_yes_no port_is_listening "$ALPHA_REDIS_PORT")"
    exit 0
  fi

  local branch head dirty ahead behind
  branch=$(git -C "$ALPHA_DIR" rev-parse --abbrev-ref HEAD)
  head=$(git -C "$ALPHA_DIR" rev-parse --short HEAD)
  dirty=$(git -C "$ALPHA_DIR" status --short | wc -l | awk '{print $1}')

  git -C "$ALPHA_DIR" fetch "$REMOTE_NAME" main >/dev/null 2>&1 || true
  ahead=$(git -C "$ALPHA_DIR" rev-list --count "$REMOTE_NAME/main..HEAD" 2>/dev/null || echo "0")
  behind=$(git -C "$ALPHA_DIR" rev-list --count "HEAD..$REMOTE_NAME/main" 2>/dev/null || echo "0")

  echo "alpha worktree: $ALPHA_DIR"
  echo "branch: $branch"
  echo "head: $head"
  echo "dirty_files: $dirty"
  echo "ahead_of_${REMOTE_NAME}/main: $ahead"
  echo "behind_${REMOTE_NAME}/main: $behind"
  echo "frontend_port: $ALPHA_WEB_PORT"
  echo "api_port: $ALPHA_API_PORT"
  echo "preview_gateway_port: $ALPHA_GATEWAY_PORT"
  echo "redis_port: $ALPHA_REDIS_PORT"
  echo "web_running: $(print_yes_no port_is_listening "$ALPHA_WEB_PORT")"
  echo "api_running: $(print_yes_no port_is_listening "$ALPHA_API_PORT")"
  echo "preview_gateway_running: $(print_yes_no port_is_listening "$ALPHA_GATEWAY_PORT")"
  echo "redis_running: $(print_yes_no port_is_listening "$ALPHA_REDIS_PORT")"
}

start_alpha_worktree() {
  if ! worktree_exists; then
    info "alpha worktree missing; initializing first"
    init_alpha_worktree
  fi

  if alpha_stack_running && [ "$FORCE" != "true" ]; then
    die "alpha ports already appear active. Use 'pnpm alpha:status' to inspect, or re-run with --force."
  fi

  if [ "$SYNC_BEFORE_START" = "true" ]; then
    sync_alpha_worktree
  fi

  ensure_alpha_dependencies

  info "starting alpha stack from $ALPHA_DIR"
  cd "$ALPHA_DIR"
  exec env \
    FRONTEND_PORT="$ALPHA_WEB_PORT" \
    API_SERVER_PORT="$ALPHA_API_PORT" \
    PREVIEW_GATEWAY_PORT="$ALPHA_GATEWAY_PORT" \
    REDIS_PORT="$ALPHA_REDIS_PORT" \
    REDIS_URL="$ALPHA_REDIS_URL" \
    CAT_CAFE_STRICT_PROFILE_DEFAULTS=1 \
    ./scripts/start-dev.sh --prod-web --profile=opensource ${START_ARGS[@]+"${START_ARGS[@]}"}
}

COMMAND="${1:-status}"
if [ "$COMMAND" = "--help" ] || [ "$COMMAND" = "-h" ]; then
  usage
  exit 0
fi
shift || true

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)
      [ $# -ge 2 ] || die "--dir requires a path"
      ALPHA_DIR="$(abs_path "$2")"
      shift 2
      ;;
    --branch)
      [ $# -ge 2 ] || die "--branch requires a value"
      ALPHA_BRANCH="$2"
      shift 2
      ;;
    --remote)
      [ $# -ge 2 ] || die "--remote requires a value"
      REMOTE_NAME="$2"
      shift 2
      ;;
    --force)
      FORCE=true
      shift
      ;;
    --no-install)
      RUN_INSTALL=false
      shift
      ;;
    --no-sync)
      SYNC_BEFORE_START=false
      shift
      ;;
    --sync)
      SYNC_BEFORE_START=true
      shift
      ;;
    --)
      shift
      START_ARGS=("$@")
      break
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [ "$COMMAND" = "start" ]; then
        START_ARGS+=("$1")
        shift
      else
        die "unknown option: $1"
      fi
      ;;
  esac
done

ALPHA_DIR="$(abs_path "$ALPHA_DIR")"
LEGACY_ALPHA_DIR="$(abs_path "$LEGACY_ALPHA_DIR")"

case "$COMMAND" in
  init)
    init_alpha_worktree
    ;;
  sync)
    sync_alpha_worktree
    ;;
  start)
    start_alpha_worktree
    ;;
  status)
    status_alpha_worktree
    ;;
  help)
    usage
    ;;
  *)
    usage
    die "unknown command: $COMMAND"
    ;;
esac
