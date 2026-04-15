#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEFAULT_RUNTIME_DIR="$(cd "$PROJECT_DIR/.." && pwd)/cat-cafe-runtime"

RUNTIME_DIR="${CAT_CAFE_RUNTIME_DIR:-$DEFAULT_RUNTIME_DIR}"
RUNTIME_BRANCH="${CAT_CAFE_RUNTIME_BRANCH:-runtime/main-sync}"
REMOTE_NAME="${CAT_CAFE_RUNTIME_REMOTE:-origin}"
FORCE=false
RUN_INSTALL=true
SYNC_BEFORE_START=true
START_ARGS=()

usage() {
  cat <<'EOF'
Cat Café Runtime Worktree Manager

Usage:
  ./scripts/runtime-worktree.sh init   [--dir PATH] [--branch NAME] [--remote NAME] [--no-install]
  ./scripts/runtime-worktree.sh sync   [--dir PATH] [--branch NAME] [--remote NAME] [--force] [--no-install]
  ./scripts/runtime-worktree.sh start  [--dir PATH] [--branch NAME] [--remote NAME] [--force] [--no-sync] [--] [start-dev args...]
  ./scripts/runtime-worktree.sh status [--dir PATH] [--branch NAME] [--remote NAME]

Defaults:
  --dir    ../cat-cafe-runtime
  --branch runtime/main-sync
  --remote origin

Safety:
  start refuses to kill an active API by default.
  To intentionally restart runtime, set CAT_CAFE_RUNTIME_RESTART_OK=1.
EOF
}

info() {
  echo "[runtime-worktree] $*"
}

die() {
  echo "[runtime-worktree] ERROR: $*" >&2
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

read_env_file_value() {
  local env_file="$1"
  local key="$2"
  [ -f "$env_file" ] || return 1

  env -i HOME="$HOME" PATH="$PATH" bash -c '
    set -a
    source "$1" >/dev/null 2>&1
    eval "printf %s \"\${'"$2"':-}\""
  ' _ "$env_file"
}

runtime_env_value() {
  local runtime_dir
  runtime_dir="$(abs_path "$RUNTIME_DIR")"
  read_env_file_value "$runtime_dir/.env" "$1"
}

require_git_repo() {
  git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || die "project dir is not a git repository: $PROJECT_DIR"
}

is_git_repo() {
  # Check for .git in the project itself — not a parent repo that happens
  # to contain this directory (archive unpacked inside another checkout).
  # A copied worktree/submodule can leave behind a dangling .git pointer
  # file; treat that as non-repo so start falls back to in-place mode.
  [ -e "$PROJECT_DIR/.git" ] || return 1
  git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1
}

worktree_exists() {
  git -C "$PROJECT_DIR" worktree list --porcelain | awk '/^worktree / {print substr($0, 10)}' | grep -Fxq "$RUNTIME_DIR"
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
  # Bash-only: requires net redirections support (enabled in most mainstream builds).
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

is_api_running() {
  local port
  port="$(runtime_env_value API_SERVER_PORT 2>/dev/null || true)"
  port="${port:-${API_SERVER_PORT:-3004}}"
  port_is_listening "$port"
}

start_arg_present() {
  local needle="$1"
  local arg

  if [ "${START_ARGS+set}" != "set" ]; then
    return 1
  fi

  for arg in "${START_ARGS[@]}"; do
    if [ "$arg" = "$needle" ]; then
      return 0
    fi
  done
  return 1
}

runtime_quick_mode() {
  start_arg_present "--quick" || start_arg_present "-q"
}

install_runtime_dependencies() {
  info "runtime prerequisites missing; running pnpm install --frozen-lockfile"
  pnpm -C "$RUNTIME_DIR" install --frozen-lockfile
}

seed_runtime_config_from_project() {
  local source_config="$PROJECT_DIR/.cat-cafe"
  local target_config="$RUNTIME_DIR/.cat-cafe"
  local file

  [ "$RUNTIME_DIR" != "$PROJECT_DIR" ] || return 0
  [ -d "$source_config" ] || return 0

  for file in cat-catalog.json accounts.json credentials.json; do
    [ -f "$source_config/$file" ] || continue
    [ ! -e "$target_config/$file" ] || continue
    mkdir -p "$target_config"
    cp "$source_config/$file" "$target_config/$file"
    if [ "$file" = "credentials.json" ]; then
      chmod 600 "$target_config/$file" || true
    fi
    info "seeded runtime config: .cat-cafe/$file"
  done
}

ensure_runtime_dependencies() {
  local missing=()

  [ -d "$RUNTIME_DIR/node_modules" ] || missing+=("node_modules")
  [ -f "$RUNTIME_DIR/packages/web/node_modules/next/package.json" ] || missing+=("packages/web:next")
  [ -f "$RUNTIME_DIR/packages/api/node_modules/tsx/package.json" ] || missing+=("packages/api:tsx")
  [ -f "$RUNTIME_DIR/packages/mcp-server/node_modules/typescript/package.json" ] || missing+=("packages/mcp-server:typescript")

  if [ "${#missing[@]}" -eq 0 ]; then
    return 0
  fi

  local joined_missing
  joined_missing=$(join_by ", " "${missing[@]}")
  info "detected missing runtime prerequisites: $joined_missing"

  if [ "$RUN_INSTALL" != "true" ]; then
    die "runtime prerequisites missing ($joined_missing). Run 'pnpm -C \"$RUNTIME_DIR\" install --frozen-lockfile' or omit --no-install."
  fi

  install_runtime_dependencies
}

ensure_quick_start_artifacts() {
  runtime_quick_mode || return 0

  if [ ! -f "$RUNTIME_DIR/packages/shared/dist/index.js" ]; then
    info "quick start missing shared dist; running pnpm -C \"$RUNTIME_DIR/packages/shared\" run build"
    pnpm -C "$RUNTIME_DIR/packages/shared" run build
  fi

  if [ ! -f "$RUNTIME_DIR/packages/mcp-server/dist/index.js" ]; then
    info "quick start missing MCP server dist; running pnpm -C \"$RUNTIME_DIR/packages/mcp-server\" run build"
    pnpm -C "$RUNTIME_DIR/packages/mcp-server" run build
  fi

  if [ ! -f "$RUNTIME_DIR/packages/web/.next/BUILD_ID" ]; then
    info "quick start missing web production build; running pnpm -C \"$RUNTIME_DIR/packages/web\" run build"
    pnpm -C "$RUNTIME_DIR/packages/web" run build
  fi
}

ensure_runtime_start_prereqs() {
  ensure_runtime_dependencies
  ensure_quick_start_artifacts
}

ensure_restart_authorized() {
  if ! is_api_running; then
    return 0
  fi

  if [ "${CAT_CAFE_RUNTIME_RESTART_OK:-0}" = "1" ]; then
    info "CAT_CAFE_RUNTIME_RESTART_OK=1; proceeding with explicit runtime restart."
    return 0
  fi

  die "API port appears active. Refusing to restart runtime by default (anti-self-TERM guard). If intentional, rerun with CAT_CAFE_RUNTIME_RESTART_OK=1."
}

ensure_runtime_clean() {
  # -uno: ignore untracked files — runtime artifacts (ASR transcript.txt, logs)
  # are harmless for ff-only merge and should not block startup.
  local dirty
  dirty=$(git -C "$RUNTIME_DIR" status --short -uno 2>/dev/null || true)
  if [ -n "$dirty" ] && [ "$FORCE" != "true" ]; then
    # Auto-stash isolated pnpm-lock.yaml drift (common after pnpm install on
    # a previous run). Only the lock file dirty → safe to stash and proceed.
    local drift_files
    drift_files=$(git -C "$RUNTIME_DIR" diff HEAD --name-only 2>/dev/null || true)
    if [ "$drift_files" = "pnpm-lock.yaml" ]; then
      info "lock drift detected — stashing before sync"
      git -C "$RUNTIME_DIR" stash push -m "lock-drift-pre-sync-stash" -- pnpm-lock.yaml
      return 0
    fi
    die "runtime worktree has local changes. Commit/stash first, or re-run with --force."
  fi
}

ensure_runtime_branch() {
  local branch
  branch=$(git -C "$RUNTIME_DIR" rev-parse --abbrev-ref HEAD)
  if [ "$branch" != "$RUNTIME_BRANCH" ]; then
    die "runtime worktree is on branch '$branch', expected '$RUNTIME_BRANCH'"
  fi
}

init_runtime_worktree() {
  require_git_repo
  ensure_remote_exists

  if worktree_exists; then
    info "runtime worktree already exists: $RUNTIME_DIR"
    return 0
  fi

  mkdir -p "$(dirname "$RUNTIME_DIR")"

  if [ -e "$RUNTIME_DIR" ]; then
    if [ -n "$(ls -A "$RUNTIME_DIR" 2>/dev/null || true)" ]; then
      die "target path exists and is not an empty runtime worktree: $RUNTIME_DIR"
    fi
  fi

  info "fetching $REMOTE_NAME/main"
  git -C "$PROJECT_DIR" fetch "$REMOTE_NAME" main

  if git -C "$PROJECT_DIR" show-ref --verify --quiet "refs/heads/$RUNTIME_BRANCH"; then
    info "adding existing branch '$RUNTIME_BRANCH' to $RUNTIME_DIR"
    git -C "$PROJECT_DIR" worktree add "$RUNTIME_DIR" "$RUNTIME_BRANCH"
  else
    info "creating branch '$RUNTIME_BRANCH' from $REMOTE_NAME/main"
    git -C "$PROJECT_DIR" worktree add "$RUNTIME_DIR" -b "$RUNTIME_BRANCH" "$REMOTE_NAME/main"
  fi

  if [ "$RUN_INSTALL" = "true" ]; then
    info "installing dependencies in runtime worktree"
    pnpm -C "$RUNTIME_DIR" install
  fi

  seed_runtime_config_from_project

  info "runtime worktree ready at $RUNTIME_DIR"
}

sync_runtime_worktree() {
  require_git_repo
  ensure_remote_exists
  worktree_exists || die "runtime worktree not found at $RUNTIME_DIR (run init first)"

  if is_api_running && [ "$FORCE" != "true" ]; then
    die "API port appears active; stop dev server before sync, or re-run with --force."
  fi

  ensure_runtime_clean
  ensure_runtime_branch

  info "syncing runtime worktree with $REMOTE_NAME/main (ff-only)"
  git -C "$RUNTIME_DIR" fetch "$REMOTE_NAME" main
  if ! git -C "$RUNTIME_DIR" merge --ff-only "$REMOTE_NAME/main" 2>/dev/null; then
    echo ""
    echo "  ff-only merge failed — likely stale untracked files blocking the sync."
    echo "  Check with:  git -C \"$RUNTIME_DIR\" status"
    echo "  Quick fix:   git -C \"$RUNTIME_DIR\" clean -fd .claude/skills/"
    echo ""
    die "runtime sync failed (see above)"
  fi

  if [ "$RUN_INSTALL" = "true" ]; then
    info "refreshing dependencies in runtime worktree"
    pnpm -C "$RUNTIME_DIR" install

    # pnpm install can legitimately fix an incomplete lock file (e.g. a PR
    # added a dep to package.json but forgot to commit the lock update).
    # If pnpm-lock.yaml is the ONLY dirty file, auto-commit the drift fix
    # so the next `start` won't be blocked by ensure_runtime_clean.
    local lock_drift
    lock_drift=$(git -C "$RUNTIME_DIR" diff --name-only 2>/dev/null || true)
    if [ "$lock_drift" = "pnpm-lock.yaml" ]; then
      info "lock drift detected — stashing instead of committing (avoids branch divergence)"
      git -C "$RUNTIME_DIR" stash push -m "lock-drift-auto-stash" -- pnpm-lock.yaml
    fi
  fi

  seed_runtime_config_from_project

  info "sync complete"
}

status_runtime_worktree() {
  require_git_repo
  if ! worktree_exists; then
    echo "runtime worktree: missing"
    echo "expected path: $RUNTIME_DIR"
    exit 0
  fi

  local branch head dirty ahead behind
  branch=$(git -C "$RUNTIME_DIR" rev-parse --abbrev-ref HEAD)
  head=$(git -C "$RUNTIME_DIR" rev-parse --short HEAD)
  dirty=$(git -C "$RUNTIME_DIR" status --short | wc -l | awk '{print $1}')

  git -C "$RUNTIME_DIR" fetch "$REMOTE_NAME" main >/dev/null 2>&1 || true
  ahead=$(git -C "$RUNTIME_DIR" rev-list --count "$REMOTE_NAME/main..HEAD" 2>/dev/null || echo "0")
  behind=$(git -C "$RUNTIME_DIR" rev-list --count "HEAD..$REMOTE_NAME/main" 2>/dev/null || echo "0")

  echo "runtime worktree: $RUNTIME_DIR"
  echo "branch: $branch"
  echo "head: $head"
  echo "dirty_files: $dirty"
  echo "ahead_of_${REMOTE_NAME}/main: $ahead"
  echo "behind_${REMOTE_NAME}/main: $behind"
}

start_runtime_worktree() {
  if ! is_git_repo; then
    RUNTIME_DIR="$PROJECT_DIR"
    ensure_restart_authorized
    ensure_runtime_start_prereqs
    info "running in-place (deployment mode): $PROJECT_DIR"
    cd "$PROJECT_DIR"
    exec env CAT_CAFE_STRICT_PROFILE_DEFAULTS=1 ./scripts/start-dev.sh --prod-web --profile=opensource ${START_ARGS[@]+"${START_ARGS[@]}"}
  fi

  if ! worktree_exists; then
    info "runtime worktree missing; initializing first"
    init_runtime_worktree
  fi

  # Runtime is single-instance infra; restarting an active API requires
  # explicit opt-in so accidental `pnpm start` in runtime sessions cannot
  # kill the live process.
  ensure_restart_authorized

  if [ "$SYNC_BEFORE_START" = "true" ]; then
    if is_api_running && [ "$FORCE" != "true" ]; then
      info "API port is active; skip pre-start sync to avoid in-place hot swap."
      info "Run 'pnpm runtime:sync' after stop if you need latest origin/main."
      seed_runtime_config_from_project
    else
      sync_runtime_worktree
    fi
  else
    seed_runtime_config_from_project
  fi

  ensure_runtime_start_prereqs

  info "starting production stack from runtime worktree: $RUNTIME_DIR"
  cd "$RUNTIME_DIR"
  # Runtime = production: auto-inject --prod-web for PWA + Tailscale support.
  # Bash 3.2 + set -u: empty-array expansion can throw "unbound variable".
  exec env CAT_CAFE_STRICT_PROFILE_DEFAULTS=1 ./scripts/start-dev.sh --prod-web --profile=opensource ${START_ARGS[@]+"${START_ARGS[@]}"}
}

COMMAND="${1:-status}"
shift || true

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)
      [ $# -ge 2 ] || die "--dir requires a path"
      RUNTIME_DIR="$(abs_path "$2")"
      shift 2
      ;;
    --branch)
      [ $# -ge 2 ] || die "--branch requires a value"
      RUNTIME_BRANCH="$2"
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

case "$COMMAND" in
  init)
    init_runtime_worktree
    ;;
  sync)
    sync_runtime_worktree
    ;;
  start)
    start_runtime_worktree
    ;;
  status)
    status_runtime_worktree
    ;;
  help)
    usage
    ;;
  *)
    usage
    die "unknown command: $COMMAND"
    ;;
esac
