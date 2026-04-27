#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEFAULT_ALPHA_DIR="$(cd "$PROJECT_DIR/.." && pwd)/cat-cafe-alpha"
DEFAULT_LEGACY_ALPHA_DIR="$(cd "$PROJECT_DIR/.." && pwd)/cat-cafe-main-test"
DEFAULT_ALPHA_BRANCH="alpha/main-sync"
DEFAULT_LEGACY_ALPHA_BRANCH="main-test/main-sync"

ALPHA_DIR="${CAT_CAFE_ALPHA_DIR:-${CAT_CAFE_MAIN_TEST_DIR:-$DEFAULT_ALPHA_DIR}}"
LEGACY_ALPHA_DIR="${CAT_CAFE_MAIN_TEST_DIR:-$DEFAULT_LEGACY_ALPHA_DIR}"
ALPHA_BRANCH="${CAT_CAFE_ALPHA_BRANCH:-$DEFAULT_ALPHA_BRANCH}"
LEGACY_ALPHA_BRANCH="${CAT_CAFE_MAIN_TEST_BRANCH:-$DEFAULT_LEGACY_ALPHA_BRANCH}"
REMOTE_NAME="${CAT_CAFE_ALPHA_REMOTE:-${CAT_CAFE_MAIN_TEST_REMOTE:-origin}}"
ENV_SOURCE_FILE="${CAT_CAFE_ALPHA_ENV_SOURCE:-${CAT_CAFE_MAIN_TEST_ENV_SOURCE:-$PROJECT_DIR/.env}}"
ALPHA_FRONTEND_PORT="${CAT_CAFE_ALPHA_FRONTEND_PORT:-${CAT_CAFE_MAIN_TEST_FRONTEND_PORT:-3011}}"
ALPHA_API_PORT="${CAT_CAFE_ALPHA_API_PORT:-${CAT_CAFE_MAIN_TEST_API_PORT:-3012}}"
ALPHA_PREVIEW_GATEWAY_PORT="${CAT_CAFE_ALPHA_PREVIEW_GATEWAY_PORT:-${CAT_CAFE_MAIN_TEST_PREVIEW_GATEWAY_PORT:-4111}}"
ALPHA_REDIS_PORT="${CAT_CAFE_ALPHA_REDIS_PORT:-${CAT_CAFE_MAIN_TEST_REDIS_PORT:-6398}}"
ALPHA_REDIS_PROFILE="${CAT_CAFE_ALPHA_REDIS_PROFILE:-${CAT_CAFE_MAIN_TEST_REDIS_PROFILE:-worktree}}"
FORCE=false
RUN_INSTALL=true
SYNC_BEFORE_START=true
QUICK_START=true
START_ARGS=()
SOURCE_ONLY=false

usage() {
  cat <<'EOF'
Cat Cafe Alpha Worktree Manager

Usage:
  ./scripts/alpha-worktree.sh init   [--dir PATH] [--branch NAME] [--remote NAME] [--no-install]
  ./scripts/alpha-worktree.sh sync   [--dir PATH] [--branch NAME] [--remote NAME] [--force] [--no-install]
  ./scripts/alpha-worktree.sh start  [--dir PATH] [--branch NAME] [--remote NAME] [--force] [--no-sync] [--no-install] [--no-quick] [--] [start-dev args...]
  ./scripts/alpha-worktree.sh status [--dir PATH] [--branch NAME] [--remote NAME]

Defaults:
  --dir    ../cat-cafe-alpha
  --branch alpha/main-sync
  --remote origin

Ports:
  frontend: 3011
  api:      3012
  preview:  4111
  redis:    6398

Behavior:
  start auto-syncs origin/main with ff-only, reuses the root .env for secrets,
  launches the isolated alpha stack with sidecars disabled, and auto-migrates
  an existing ../cat-cafe-main-test worktree into ../cat-cafe-alpha.
EOF
}

info() {
  echo "[alpha-worktree] $*"
}

die() {
  echo "[alpha-worktree] ERROR: $*" >&2
  exit 1
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

require_git_repo() {
  git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || die "project dir is not a git repository: $PROJECT_DIR"
}

worktree_exists() {
  git -C "$PROJECT_DIR" worktree list --porcelain | awk '/^worktree / {print substr($0, 10)}' | grep -Fxq "$ALPHA_DIR"
}

legacy_worktree_exists() {
  [ "$LEGACY_ALPHA_DIR" != "$ALPHA_DIR" ] || return 1
  git -C "$PROJECT_DIR" worktree list --porcelain | awk '/^worktree / {print substr($0, 10)}' | grep -Fxq "$LEGACY_ALPHA_DIR"
}

ensure_remote_exists() {
  git -C "$PROJECT_DIR" remote get-url "$REMOTE_NAME" >/dev/null 2>&1 \
    || die "remote '$REMOTE_NAME' not found"
}

resolve_env_source_file() {
  if [ -f "$ENV_SOURCE_FILE" ]; then
    printf '%s\n' "$ENV_SOURCE_FILE"
    return 0
  fi

  local sibling_source
  sibling_source="$(cd "$PROJECT_DIR/.." && pwd -P)/cat-cafe/.env"
  if [ "$sibling_source" != "$ENV_SOURCE_FILE" ] && [ -f "$sibling_source" ]; then
    printf '%s\n' "$sibling_source"
    return 0
  fi

  return 1
}

is_api_running() {
  lsof -nP -iTCP:"$ALPHA_API_PORT" -sTCP:LISTEN -t >/dev/null 2>&1
}

ensure_alpha_clean() {
  local dirty
  dirty=$(git -C "$ALPHA_DIR" status --short -uno 2>/dev/null || true)
  if [ -n "$dirty" ] && [ "$FORCE" != "true" ]; then
    die "alpha worktree has local changes. Commit/stash first, or re-run with --force."
  fi
}

ensure_alpha_branch() {
  local branch dirty

  branch=$(git -C "$ALPHA_DIR" rev-parse --abbrev-ref HEAD)
  if [ "$branch" = "$ALPHA_BRANCH" ]; then
    return 0
  fi

  dirty=$(git -C "$ALPHA_DIR" status --short -uno 2>/dev/null || true)
  if [ -n "$dirty" ] && [ "$FORCE" != "true" ]; then
    die "alpha worktree is on branch '$branch' with local changes. Commit/stash first, or re-run with --force."
  fi

  git -C "$ALPHA_DIR" fetch "$REMOTE_NAME" main

  if [ "$branch" = "$LEGACY_ALPHA_BRANCH" ] && ! git -C "$PROJECT_DIR" show-ref --verify --quiet "refs/heads/$ALPHA_BRANCH"; then
    info "renaming legacy branch '$LEGACY_ALPHA_BRANCH' to '$ALPHA_BRANCH'"
    git -C "$ALPHA_DIR" branch -m "$LEGACY_ALPHA_BRANCH" "$ALPHA_BRANCH"
    git -C "$ALPHA_DIR" branch --set-upstream-to="$REMOTE_NAME/main" "$ALPHA_BRANCH" >/dev/null 2>&1 || true
    return 0
  fi

  info "repairing alpha worktree branch from '$branch' to '$ALPHA_BRANCH'"
  if git -C "$PROJECT_DIR" show-ref --verify --quiet "refs/heads/$ALPHA_BRANCH"; then
    git -C "$ALPHA_DIR" checkout "$ALPHA_BRANCH"
  else
    git -C "$ALPHA_DIR" checkout -B "$ALPHA_BRANCH" "$REMOTE_NAME/main"
  fi
}

print_alpha_env_exports() {
  cat <<EOF
export REDIS_PORT=$ALPHA_REDIS_PORT
export REDIS_URL=redis://localhost:$ALPHA_REDIS_PORT
export REDIS_PROFILE=$ALPHA_REDIS_PROFILE
export API_SERVER_PORT=$ALPHA_API_PORT
export FRONTEND_PORT=$ALPHA_FRONTEND_PORT
export PREVIEW_GATEWAY_PORT=$ALPHA_PREVIEW_GATEWAY_PORT
export NEXT_PUBLIC_API_URL=http://localhost:$ALPHA_API_PORT
export ANTHROPIC_PROXY_ENABLED=0
export ASR_ENABLED=0
export TTS_ENABLED=0
export LLM_POSTPROCESS_ENABLED=0
export EMBED_ENABLED=0
export EMBED_MODE=off
EOF
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
  joined_missing=$(IFS=', '; echo "${missing[*]}")
  info "detected missing alpha prerequisites: $joined_missing"

  if [ "$RUN_INSTALL" != "true" ]; then
    die "alpha prerequisites missing ($joined_missing). Run 'pnpm -C \"$ALPHA_DIR\" install --frozen-lockfile' or omit --no-install."
  fi

  install_alpha_dependencies
}

source_env_if_present() {
  local resolved_env
  resolved_env="$(resolve_env_source_file || true)"

  if [ -n "$resolved_env" ]; then
    ENV_SOURCE_FILE="$resolved_env"
    info "sourcing env from $ENV_SOURCE_FILE"
    set -a
    # shellcheck disable=SC1090
    source "$ENV_SOURCE_FILE"
    set +a
  else
    info "env source not found, continuing without it: $ENV_SOURCE_FILE"
  fi
}

apply_alpha_env() {
  export REDIS_PORT="$ALPHA_REDIS_PORT"
  export REDIS_URL="redis://localhost:$ALPHA_REDIS_PORT"
  export REDIS_PROFILE="$ALPHA_REDIS_PROFILE"
  export API_SERVER_PORT="$ALPHA_API_PORT"
  export FRONTEND_PORT="$ALPHA_FRONTEND_PORT"
  export PREVIEW_GATEWAY_PORT="$ALPHA_PREVIEW_GATEWAY_PORT"
  export NEXT_PUBLIC_API_URL="http://localhost:$ALPHA_API_PORT"
  export ANTHROPIC_PROXY_ENABLED=0
  export ASR_ENABLED=0
  export TTS_ENABLED=0
  export LLM_POSTPROCESS_ENABLED=0
  export EMBED_ENABLED=0
  export EMBED_MODE=off

  # Next.js dev only reads .env files relative to its own cwd (packages/web/),
  # not monorepo root .env, and does not always pick up exported NEXT_PUBLIC_*
  # env vars at build time. Write packages/web/.env.local so the alpha frontend
  # always points at ALPHA_API_PORT instead of falling back to the runtime API port.
  if [ -d "$ALPHA_DIR/packages/web" ]; then
    cat > "$ALPHA_DIR/packages/web/.env.local" <<EOF
# Auto-generated by scripts/alpha-worktree.sh — do not edit by hand.
NEXT_PUBLIC_API_URL=http://localhost:$ALPHA_API_PORT
EOF
  fi
}

migrate_legacy_alpha_worktree() {
  legacy_worktree_exists || return 1
  worktree_exists && return 0

  mkdir -p "$(dirname "$ALPHA_DIR")"

  if [ -e "$ALPHA_DIR" ] && [ -n "$(ls -A "$ALPHA_DIR" 2>/dev/null || true)" ]; then
    die "target alpha path exists and is not empty: $ALPHA_DIR"
  fi

  info "migrating legacy main-test worktree from $LEGACY_ALPHA_DIR to $ALPHA_DIR"
  git -C "$PROJECT_DIR" worktree move "$LEGACY_ALPHA_DIR" "$ALPHA_DIR"
}

init_alpha_worktree() {
  require_git_repo
  ensure_remote_exists

  if worktree_exists; then
    info "alpha worktree already exists: $ALPHA_DIR"
    return 0
  fi

  if legacy_worktree_exists; then
    migrate_legacy_alpha_worktree
    ensure_alpha_branch
    if [ "$RUN_INSTALL" = "true" ]; then
      install_alpha_dependencies
    fi
    info "alpha worktree ready at $ALPHA_DIR"
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
  worktree_exists || die "alpha worktree not found at $ALPHA_DIR (run init first)"

  ensure_alpha_clean
  ensure_alpha_branch

  info "syncing alpha worktree with $REMOTE_NAME/main (ff-only)"
  git -C "$ALPHA_DIR" fetch "$REMOTE_NAME" main
  git -C "$ALPHA_DIR" merge --ff-only "$REMOTE_NAME/main"

  if [ "$RUN_INSTALL" = "true" ]; then
    install_alpha_dependencies

    local lock_drift
    lock_drift=$(git -C "$ALPHA_DIR" diff --name-only 2>/dev/null || true)
    if [ "$lock_drift" = "pnpm-lock.yaml" ]; then
      info "lock drift detected — stashing instead of committing"
      git -C "$ALPHA_DIR" stash push -m "alpha-lock-drift-auto-stash" -- pnpm-lock.yaml
    fi
  fi

  info "sync complete"
}

status_alpha_worktree() {
  require_git_repo
  if ! worktree_exists; then
    echo "alpha worktree: missing"
    echo "expected path: $ALPHA_DIR"
    echo "legacy_path: $LEGACY_ALPHA_DIR"
    echo "branch: $ALPHA_BRANCH"
    echo "remote: $REMOTE_NAME"
    return 0
  fi

  local branch head dirty ahead behind api_running env_source_display resolved_env
  branch=$(git -C "$ALPHA_DIR" rev-parse --abbrev-ref HEAD)
  head=$(git -C "$ALPHA_DIR" rev-parse --short HEAD)
  dirty=$(git -C "$ALPHA_DIR" status --short | wc -l | awk '{print $1}')

  git -C "$ALPHA_DIR" fetch "$REMOTE_NAME" main >/dev/null 2>&1 || true
  ahead=$(git -C "$ALPHA_DIR" rev-list --count "$REMOTE_NAME/main..HEAD" 2>/dev/null || echo "0")
  behind=$(git -C "$ALPHA_DIR" rev-list --count "HEAD..$REMOTE_NAME/main" 2>/dev/null || echo "0")
  api_running="no"
  if is_api_running; then
    api_running="yes"
  fi

  env_source_display="$ENV_SOURCE_FILE"
  resolved_env="$(resolve_env_source_file || true)"
  if [ -n "$resolved_env" ]; then
    env_source_display="$resolved_env"
  fi

  echo "alpha worktree: $ALPHA_DIR"
  echo "branch: $branch"
  echo "head: $head"
  echo "dirty_files: $dirty"
  echo "ahead_of_${REMOTE_NAME}/main: $ahead"
  echo "behind_${REMOTE_NAME}/main: $behind"
  echo "api_running: $api_running"
  echo "frontend_port: $ALPHA_FRONTEND_PORT"
  echo "api_port: $ALPHA_API_PORT"
  echo "preview_gateway_port: $ALPHA_PREVIEW_GATEWAY_PORT"
  echo "redis_port: $ALPHA_REDIS_PORT"
  echo "env_source: $env_source_display"
}

start_alpha_worktree() {
  if ! worktree_exists && legacy_worktree_exists; then
    migrate_legacy_alpha_worktree
  fi

  if ! worktree_exists; then
    info "alpha worktree missing; initializing first"
    init_alpha_worktree
  fi

  if [ "$SYNC_BEFORE_START" = "true" ]; then
    sync_alpha_worktree
  fi

  ensure_alpha_dependencies

  source_env_if_present
  apply_alpha_env

  info "starting isolated alpha stack from worktree: $ALPHA_DIR"
  info "ports: frontend=$ALPHA_FRONTEND_PORT api=$ALPHA_API_PORT preview=$ALPHA_PREVIEW_GATEWAY_PORT redis=$ALPHA_REDIS_PORT"

  cd "$ALPHA_DIR"

  local cmd=("./scripts/start-dev.sh")
  if [ "$QUICK_START" = "true" ]; then
    cmd+=("--quick")
  fi

  exec "${cmd[@]}" ${START_ARGS[@]+"${START_ARGS[@]}"}
}

if [[ "${1:-}" == "--source-only" ]]; then
  SOURCE_ONLY=true
else
  COMMAND="${1:-status}"
  shift || true
fi

while [ "$SOURCE_ONLY" != "true" ] && [ $# -gt 0 ]; do
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
    --env-file)
      [ $# -ge 2 ] || die "--env-file requires a path"
      ENV_SOURCE_FILE="$(abs_path "$2")"
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
    --no-quick)
      QUICK_START=false
      shift
      ;;
    --)
      shift
      START_ARGS=("$@")
      break
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

if [ "$SOURCE_ONLY" = "true" ]; then
  return 0 2>/dev/null || exit 0
fi

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
  help|-h|--help)
    usage
    ;;
  *)
    die "unknown command: $COMMAND"
    ;;
esac
