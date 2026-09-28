#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Quick-start build-freshness gate — rebuild when source moved, not just when
# the artifact is missing (otherwise dist never refreshes across restarts).
# Resolve via BASH_SOURCE, not $0/SCRIPT_DIR: under `source runtime-worktree.sh
# --source-only` $0 is the parent shell, so SCRIPT_DIR mis-resolves to cwd.
# BASH_SOURCE[0] always points at this file (source and exec alike).
# shellcheck source=scripts/lib/quickstart-freshness.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/quickstart-freshness.sh"
# shellcheck source=scripts/lib/node-runtime-guard.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/node-runtime-guard.sh"
DEFAULT_RUNTIME_DIR="$(cd "$PROJECT_DIR/.." && pwd)/cat-cafe-runtime"

RUNTIME_DIR="${CAT_CAFE_RUNTIME_DIR:-$DEFAULT_RUNTIME_DIR}"
RUNTIME_BRANCH="${CAT_CAFE_RUNTIME_BRANCH:-runtime/main-sync}"
REMOTE_NAME="${CAT_CAFE_RUNTIME_REMOTE:-origin}"
RUN_INSTALL=true
SYNC_BEFORE_START=true
EXPECTED_TARGET_SHA=""
START_ARGS=()
RUNTIME_DAEMON_STATUS="unknown"
RUNTIME_DAEMON_DETAIL=""
FROZEN_TARGET_REF=""

usage() {
  cat <<'EOF'
Clowder AI Runtime Worktree Manager

Usage:
  ./scripts/runtime-worktree.sh init   [--dir PATH] [--branch NAME] [--remote NAME] [--no-install]
  ./scripts/runtime-worktree.sh start  [--expected-target-sha FULL_SHA] [--dir PATH] [--branch NAME] [--remote NAME] [--no-sync] [--] [start-dev args...]
  ./scripts/runtime-worktree.sh restart [--expected-target-sha FULL_SHA] [--dir PATH] [--branch NAME] [--remote NAME] [--no-sync] [--] [start-dev args...]
  ./scripts/runtime-worktree.sh status [--dir PATH] [--branch NAME] [--remote NAME]
  ./scripts/runtime-worktree.sh daemon-status [--dir PATH]
  ./scripts/runtime-worktree.sh stop   [--dir PATH]

Defaults:
  --dir    ../cat-cafe-runtime
  --branch runtime/main-sync
  --remote origin

Target identity:
  Normal Git starts fetch once and freeze that invocation's origin/main SHA.
  --expected-target-sha optionally pins and verifies a specific full SHA.
  The runtime HEAD + tracked content and API/MCP/Web build stamps must all equal the frozen target.
  --no-sync derives the target from an existing preserved tree and never creates one.

Runtime Contract (passive frozen):
  start launches a stopped runtime and returns successfully when the same managed runtime is already running.
  restart performs one ownership-verified stop followed by the same start path.
  start/restart run sync (one fetch + exact ff-only target) + build invariant internally.
  No standalone `sync` subcommand — fold into `pnpm start` as a single entry.
  No tsx watch auto-restart — runtime doesn't track main src changes.
  See docs/decisions/039-runtime-passive-freeze.md for design rationale.

Safety:
  Shell flags and environment variables do not prove authorization.
  Lifecycle commands act only on the identity-verified managed runtime state.
  Unknown or cross-worktree port owners are never force-killed.
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

read_runtime_dotenv_value() {
  local runtime_dir="$1"
  local key="$2"
  if [ ! -f "$runtime_dir/.env" ] && [ ! -f "$runtime_dir/.env.local" ]; then
    return 1
  fi

  env -i HOME="$HOME" PATH="$PATH" bash -c '
    cd "$1"
    set -a
    [ ! -f .env ] || source .env >/dev/null 2>&1
    [ ! -f .env.local ] || source .env.local >/dev/null 2>&1
    set +a
    eval "printf %s \"\${'"$2"':-}\""
  ' _ "$runtime_dir"
}

runtime_env_value() {
  local key="$1"
  local runtime_dir cli_value cli_prefer dotenv_value dotenv_prefer prefer_dotenv
  runtime_dir="$(abs_path "$RUNTIME_DIR")"
  eval "cli_value=\${${key}-}"
  cli_prefer="${CAT_CAFE_RESPECT_DOTENV_PORTS-}"
  dotenv_value="$(read_runtime_dotenv_value "$runtime_dir" "$key" 2>/dev/null || true)"
  dotenv_prefer="$(read_runtime_dotenv_value "$runtime_dir" CAT_CAFE_RESPECT_DOTENV_PORTS 2>/dev/null || true)"
  prefer_dotenv="${cli_prefer:-$dotenv_prefer}"

  if [ "$prefer_dotenv" != "1" ] && [ -n "$cli_value" ]; then
    printf '%s\n' "$cli_value"
    return 0
  fi
  [ -n "$dotenv_value" ] || return 1
  printf '%s\n' "$dotenv_value"
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
  if command -v timeout >/dev/null 2>&1; then
    timeout 1 nc -z 127.0.0.1 "$port" >/dev/null 2>&1 || timeout 1 nc -z localhost "$port" >/dev/null 2>&1
  else
    nc -z 127.0.0.1 "$port" >/dev/null 2>&1 || nc -z localhost "$port" >/dev/null 2>&1
  fi
}

probe_port_with_dev_tcp() {
  local port="$1"
  local timeout_cmd=""
  if command -v timeout >/dev/null 2>&1; then
    timeout_cmd="timeout 1"
  fi
  ${timeout_cmd} bash -c 'exec 3<>/dev/tcp/127.0.0.1/$1' probe "$port" >/dev/null 2>&1 \
    || ${timeout_cmd} bash -c 'exec 3<>/dev/tcp/localhost/$1' probe "$port" >/dev/null 2>&1
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

runtime_install_can_retry_without_frozen_lockfile() {
  local log_file="$1"
  # Kept in sync with scripts/install.ps1::Test-LockfileMismatchFailure — the
  # Windows installer is the single source of truth for which pnpm 9 lockfile-
  # class failures justify a `pnpm install --no-frozen-lockfile` retry. Any
  # phrase added here MUST also be reflected in install.ps1 (and vice versa)
  # so Linux/macOS bash and Windows PowerShell self-heal stay symmetric.
  # codex review (PR #2495 R2) flagged the BREAKING_CHANGE / "incompatible"
  # gaps; AUDIT (§16e failure-mode sweep) added the remaining patterns the
  # PowerShell helper already classifies as lockfile drift.
  grep -Eiq \
    'ERR_PNPM_OUTDATED_LOCKFILE|ERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE|ERR_PNPM_LOCKFILE_BREAKING_CHANGE|ERR_PNPM_LOCKFILE_CONFIG_MISMATCH|Cannot install with .frozen-lockfile|Cannot proceed .*without the lockfile|frozen[- ]lockfile|lockfile.*(outdated|not up to date|incompatible)' \
    "$log_file"
}

install_runtime_dependencies() {
  local install_log
  local install_status

  info "runtime prerequisites missing; running pnpm install --frozen-lockfile"
  # Always clear production env flags — Claude Code shell often has NODE_ENV=production,
  # which causes pnpm to skip devDependencies and break builds.
  install_log="$(mktemp "${TMPDIR:-/tmp}/cat-cafe-runtime-install.XXXXXX")"
  # Wrap the pnpm pipeline in `if` so set -e + pipefail don't kill us on a
  # non-zero exit, then capture pnpm's original exit code via ${PIPESTATUS[0]}.
  # This preserves the caller-visible exit semantics on the non-retry path
  # (regression vs the pre-PR direct `pnpm install --frozen-lockfile` call);
  # interrupts / OOM-style failures stay distinguishable from a generic exit 1.
  if env -u NODE_ENV -u npm_config_production -u NPM_CONFIG_PRODUCTION \
    pnpm -C "$RUNTIME_DIR" install --frozen-lockfile 2>&1 | tee "$install_log"; then
    install_status=0
  else
    install_status="${PIPESTATUS[0]}"
  fi

  if [ "$install_status" -eq 0 ]; then
    rm -f "$install_log"
    return 0
  fi

  if ! runtime_install_can_retry_without_frozen_lockfile "$install_log"; then
    rm -f "$install_log"
    return "$install_status"
  fi
  rm -f "$install_log"

  info "runtime frozen lockfile install failed; retrying pnpm install --no-frozen-lockfile"
  env -u NODE_ENV -u npm_config_production -u NPM_CONFIG_PRODUCTION \
    pnpm -C "$RUNTIME_DIR" install --no-frozen-lockfile
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

ensure_runtime_dist_freshness() {
  # ADR-039 Invariant 3: build invariant — rebuild stale dist before runtime
  # spawns API/Web processes.
  #
  # Previously gated on `runtime_quick_mode`; F228 stale-dist crash exposed
  # that default (full) mode also needs dists once CAT_CAFE_DIRECT_NO_WATCH=1
  # makes runtime API run from `node dist/index.js` (not tsx watch src).
  # Freshness gate (git HEAD) means steady-state cost is ~0.1s; only when
  # main source moved do we actually rebuild.
  local head_commit
  head_commit="$(git -C "$RUNTIME_DIR" rev-parse HEAD 2>/dev/null || echo "")"
  if [ -z "$head_commit" ]; then
    head_commit="$(cat "$RUNTIME_DIR/.cat-cafe-runtime-revision" 2>/dev/null || true)"
  fi

  # Order matters: shared first (api/mcp depend on it), then api, then mcp, then web.
  if needs_rebuild "$RUNTIME_DIR/packages/shared/dist/index.js" \
      "$RUNTIME_DIR/packages/shared/dist/.build-commit" "$head_commit"; then
    info "runtime dist: shared stale/missing; running pnpm -C \"$RUNTIME_DIR/packages/shared\" run build"
    pnpm -C "$RUNTIME_DIR/packages/shared" run build
    record_build_stamp "$RUNTIME_DIR/packages/shared/dist/.build-commit" "$head_commit"
  fi

  if needs_rebuild "$RUNTIME_DIR/packages/api/dist/index.js" \
      "$RUNTIME_DIR/packages/api/dist/.build-commit" "$head_commit"; then
    info "runtime dist: api stale/missing; running pnpm -C \"$RUNTIME_DIR/packages/api\" run build"
    pnpm -C "$RUNTIME_DIR/packages/api" run build
    record_build_stamp "$RUNTIME_DIR/packages/api/dist/.build-commit" "$head_commit"
  fi

  if needs_rebuild "$RUNTIME_DIR/packages/mcp-server/dist/index.js" \
      "$RUNTIME_DIR/packages/mcp-server/dist/.build-commit" "$head_commit"; then
    info "runtime dist: MCP server stale/missing; running pnpm -C \"$RUNTIME_DIR/packages/mcp-server\" run build"
    pnpm -C "$RUNTIME_DIR/packages/mcp-server" run build
    record_build_stamp "$RUNTIME_DIR/packages/mcp-server/dist/.build-commit" "$head_commit"
  fi

  if needs_rebuild "$RUNTIME_DIR/packages/web/.next/BUILD_ID" \
      "$RUNTIME_DIR/packages/web/.next/.build-commit" "$head_commit"; then
    info "runtime dist: web production build stale/missing; running pnpm -C \"$RUNTIME_DIR/packages/web\" run build"
    pnpm -C "$RUNTIME_DIR/packages/web" run build
    record_build_stamp "$RUNTIME_DIR/packages/web/.next/.build-commit" "$head_commit"
  fi
}

validate_explicit_target_sha() {
  if [ -n "$EXPECTED_TARGET_SHA" ] && [[ ! "$EXPECTED_TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]; then
    die "--expected-target-sha must be one lowercase full 40-character Git SHA"
  fi
}

require_resolved_target_sha() {
  if [[ ! "$EXPECTED_TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]; then
    die "runtime source does not provide a valid lowercase full 40-character revision"
  fi
}

cleanup_frozen_runtime_target_ref() {
  [ -n "$FROZEN_TARGET_REF" ] || return 0
  git -C "$PROJECT_DIR" update-ref -d "$FROZEN_TARGET_REF" >/dev/null 2>&1 || true
  FROZEN_TARGET_REF=""
}

assert_runtime_tree_target() {
  local runtime_root="$1"
  local head dirty
  head="$(git -C "$runtime_root" rev-parse --verify 'HEAD^{commit}' 2>/dev/null || true)"
  if [ "$head" != "$EXPECTED_TARGET_SHA" ]; then
    die "runtime tree HEAD '$head' does not equal expected target '$EXPECTED_TARGET_SHA'"
  fi

  if ! dirty="$(git -C "$runtime_root" status --short --untracked-files=no 2>/dev/null)"; then
    die "could not verify tracked runtime tree content for expected target '$EXPECTED_TARGET_SHA'"
  fi
  if [ -n "$dirty" ]; then
    die "runtime worktree has local changes: tracked content does not exactly match expected target '$EXPECTED_TARGET_SHA'"
  fi
}

assert_in_place_runtime_target() {
  local runtime_root="$1"
  local revision
  revision="$(cat "$runtime_root/.cat-cafe-runtime-revision" 2>/dev/null || true)"
  if [ "$revision" != "$EXPECTED_TARGET_SHA" ]; then
    die "runtime bundle revision '$revision' does not equal expected target '$EXPECTED_TARGET_SHA'"
  fi
}

assert_runtime_build_target() {
  local runtime_root="$1"
  local label stamp revision
  while IFS='|' read -r label stamp; do
    [ -n "$label" ] || continue
    revision="$(cat "$runtime_root/$stamp" 2>/dev/null || true)"
    if [ "$revision" != "$EXPECTED_TARGET_SHA" ]; then
      die "$label build stamp '$revision' does not equal expected target '$EXPECTED_TARGET_SHA'"
    fi
  done <<'EOF'
API|packages/api/dist/.build-commit
MCP|packages/mcp-server/dist/.build-commit
Web|packages/web/.next/.build-commit
EOF
}

assert_runtime_target_ready() {
  local runtime_root="$1"
  assert_runtime_tree_target "$runtime_root"
  assert_runtime_build_target "$runtime_root"
}

assert_explicit_running_target() {
  [ -n "$EXPECTED_TARGET_SHA" ] || return 0
  if is_git_repo; then
    worktree_exists || die "managed runtime state exists but its registered worktree is missing"
    assert_runtime_target_ready "$RUNTIME_DIR"
    return 0
  fi
  assert_in_place_runtime_target "$PROJECT_DIR"
  assert_runtime_build_target "$PROJECT_DIR"
}

ensure_runtime_start_prereqs() {
  ensure_runtime_dependencies
  ensure_runtime_dist_freshness
}

ensure_runtime_clean() {
  # -uno: ignore untracked files — runtime artifacts (ASR transcript.txt, logs)
  # are harmless for ff-only merge and should not block startup.
  local dirty
  dirty=$(git -C "$RUNTIME_DIR" status --short -uno 2>/dev/null || true)
  if [ -n "$dirty" ]; then
    # Auto-stash isolated pnpm-lock.yaml drift (common after pnpm install on
    # a previous run). Only the lock file dirty → safe to stash and proceed.
    local drift_files
    drift_files=$(git -C "$RUNTIME_DIR" diff HEAD --name-only 2>/dev/null || true)
    if [ "$drift_files" = "pnpm-lock.yaml" ] && [ "$RUNTIME_DAEMON_STATUS" != "running" ]; then
      info "lock drift detected — stashing before sync"
      git -C "$RUNTIME_DIR" stash push -m "lock-drift-pre-sync-stash" -- pnpm-lock.yaml
      return 0
    fi
    die "runtime worktree has local changes: tracked content does not exactly match frozen target '$EXPECTED_TARGET_SHA'; commit/stash first"
  fi
}

ensure_runtime_branch() {
  local branch
  branch=$(git -C "$RUNTIME_DIR" rev-parse --abbrev-ref HEAD)
  if [ "$branch" != "$RUNTIME_BRANCH" ]; then
    die "runtime worktree is on branch '$branch', expected '$RUNTIME_BRANCH'"
  fi
}

# The runtime worktree is a passive mirror of origin/main (ADR-039). Any commit
# in frozen-target..HEAD is, by definition, NOT reachable from the exact commit
# selected for this action, so a destructive restore would delete it from this
# worktree. We deliberately do
# NOT try to prove a commit is "safe to discard" from remote-tracking refs:
# startup only fetches origin/main, so a stale origin/* ref (whose upstream
# branch was deleted out-of-band) makes `git branch -r --contains` claim a
# local-only commit is remotely saved — the exact false-safe that silently loses
# data (LL-045). Fail closed: pin every diverged commit to a backup branch
# before printing any reset advice, and let a human decide what is disposable.
report_diverged_runtime_commits() {
  local sha at_risk_count=0
  local -a at_risk_shas=()

  while IFS= read -r sha; do
    [ -n "$sha" ] || continue
    at_risk_shas+=("$sha")
    at_risk_count=$((at_risk_count + 1))
  done < <(git -C "$RUNTIME_DIR" rev-list "$EXPECTED_TARGET_SHA..HEAD" 2>/dev/null)

  if [ "$at_risk_count" -eq 0 ]; then
    # Caller already asserted ahead_count>0; nothing structured to enumerate.
    echo "  Inspect:  git -C \"$RUNTIME_DIR\" log --oneline $EXPECTED_TARGET_SHA..HEAD"
    return 0
  fi

  local backup_branch
  backup_branch="runtime-sanctuary-backup-$(git -C "$RUNTIME_DIR" rev-parse --short HEAD 2>/dev/null)"

  echo ""
  echo "  $at_risk_count commit(s) here are ahead of the frozen target $EXPECTED_TARGET_SHA."
  echo "  Startup only fetches $REMOTE_NAME/main once, so remote-tracking refs cannot"
  echo "  prove these are saved elsewhere — a 'reset --hard' could permanently"
  echo "  delete this work:"
  for sha in "${at_risk_shas[@]}"; do
    echo "      $(git -C "$RUNTIME_DIR" log -1 --format='%h  %an: %s' "$sha" 2>/dev/null)"
  done
  echo ""

  if git -C "$RUNTIME_DIR" rev-parse --verify --quiet "$backup_branch" >/dev/null 2>&1; then
    echo "  Safety net already in place: branch '$backup_branch' pins these commits."
  elif git -C "$RUNTIME_DIR" branch "$backup_branch" HEAD >/dev/null 2>&1; then
    echo "  Safety net created: branch '$backup_branch' now pins these commits."
  else
    echo "  WARNING: could not create backup branch '$backup_branch' — do not reset until this work is saved."
  fi

  echo ""
  echo "  The runtime worktree is a sanctuary: it stays a passive mirror of"
  echo "  $REMOTE_NAME/main (ADR-039 passive-freeze contract; LL-045 / LL-078)."
  echo "  Development belongs in a feature worktree off the main repo, never here."
  echo ""
  echo "  To recover, then re-run start:"
  echo "    1. Check whether the work above already landed upstream (e.g. squashed into a PR)."
  echo "    2. If it did not land, publish it from the backup branch first:"
  echo "         git -C \"$RUNTIME_DIR\" push $REMOTE_NAME $backup_branch:feat/<your-branch>"
  echo "    3. Once the work is safe, restore the mirror:"
  echo "         git -C \"$RUNTIME_DIR\" reset --hard $EXPECTED_TARGET_SHA"
}

print_untracked_merge_blockers() {
  local found=false
  local path blocker note remaining candidate segment type existing already reported_count=0
  local -a reported_blockers=()

  while IFS= read -r -d '' path; do
    blocker=""
    note=""
    remaining="$path"
    candidate=""

    while [[ "$remaining" == */* ]]; do
      segment="${remaining%%/*}"
      remaining="${remaining#*/}"
      if [ -z "$candidate" ]; then
        candidate="$segment"
      else
        candidate="$candidate/$segment"
      fi

      type=$(git -C "$RUNTIME_DIR" cat-file -t "$EXPECTED_TARGET_SHA:$candidate" 2>/dev/null || true)
      if [ -n "$type" ] && [ "$type" != "tree" ]; then
        blocker="$candidate"
        note=" (incoming tracked path replaces local directory)"
        break
      fi
    done

    if [ -z "$blocker" ]; then
      type=$(git -C "$RUNTIME_DIR" cat-file -t "$EXPECTED_TARGET_SHA:$path" 2>/dev/null || true)
      if [ -n "$type" ]; then
        blocker="$path"
        note=""
        if [ "$type" != "tree" ] \
          && [ -f "$RUNTIME_DIR/$path" ] \
          && cmp -s -- "$RUNTIME_DIR/$path" <(git -C "$RUNTIME_DIR" show "$EXPECTED_TARGET_SHA:$path" 2>/dev/null); then
          note=" (same bytes as incoming)"
        fi
      fi
    fi

    if [ -n "$blocker" ]; then
      already=false
      if [ "$reported_count" -gt 0 ]; then
        for existing in "${reported_blockers[@]}"; do
          if [ "$existing" = "$blocker" ]; then
            already=true
            break
          fi
        done
      fi
      if [ "$already" = true ]; then
        continue
      fi
      reported_blockers+=("$blocker")
      reported_count=$((reported_count + 1))

      if [ "$found" = false ]; then
        echo "  Untracked files blocking sync:"
        found=true
      fi

      printf '    - %s%s\n' "$blocker" "$note"
    fi
  done < <(git -C "$RUNTIME_DIR" ls-files --others --exclude-standard -z 2>/dev/null || true)

  [ "$found" = true ]
}

preflight_runtime_tree_target() {
  ensure_runtime_clean
  ensure_runtime_branch

  local head ahead_count
  head="$(git -C "$RUNTIME_DIR" rev-parse --verify 'HEAD^{commit}' 2>/dev/null || true)"
  [ -n "$head" ] || die "could not resolve the preserved runtime tree HEAD"
  if [ "$head" = "$EXPECTED_TARGET_SHA" ]; then
    assert_runtime_tree_target "$RUNTIME_DIR"
    return 0
  fi

  if ! git -C "$RUNTIME_DIR" merge-base --is-ancestor "$head" "$EXPECTED_TARGET_SHA" 2>/dev/null; then
    ahead_count="$(git -C "$RUNTIME_DIR" rev-list --count "$EXPECTED_TARGET_SHA..HEAD" 2>/dev/null || echo 0)"
    echo ""
    echo "  Runtime tree cannot fast-forward to the frozen target $EXPECTED_TARGET_SHA."
    if [ "$ahead_count" -gt 0 ]; then
      report_diverged_runtime_commits
    fi
    die "runtime tree diverged from the frozen target; no running process was changed"
  fi

  if print_untracked_merge_blockers; then
    die "untracked runtime files would block the exact target update; no running process was changed"
  fi
}

freeze_remote_runtime_target() {
  require_git_repo
  ensure_remote_exists
  validate_explicit_target_sha

  local fetched
  FROZEN_TARGET_REF="refs/cat-cafe-runtime-target/$$"
  git -C "$PROJECT_DIR" update-ref -d "$FROZEN_TARGET_REF" >/dev/null 2>&1 || true
  info "fetching $REMOTE_NAME/main once into an invocation-private ref"
  git -C "$PROJECT_DIR" fetch "$REMOTE_NAME" "+refs/heads/main:$FROZEN_TARGET_REF"
  fetched="$(git -C "$PROJECT_DIR" rev-parse --verify "$FROZEN_TARGET_REF^{commit}" 2>/dev/null || true)"
  if [ -n "$EXPECTED_TARGET_SHA" ] && [ "$fetched" != "$EXPECTED_TARGET_SHA" ]; then
    die "fetched $REMOTE_NAME/main '$fetched' does not equal expected target '$EXPECTED_TARGET_SHA'; runtime tree was preserved"
  fi
  EXPECTED_TARGET_SHA="${EXPECTED_TARGET_SHA:-$fetched}"
  require_resolved_target_sha
}

freeze_preserved_runtime_target() {
  require_git_repo
  worktree_exists || die "--no-sync requires an existing preserved runtime worktree"
  validate_explicit_target_sha
  if [ -z "$EXPECTED_TARGET_SHA" ]; then
    EXPECTED_TARGET_SHA="$(git -C "$RUNTIME_DIR" rev-parse --verify 'HEAD^{commit}' 2>/dev/null || true)"
  fi
  require_resolved_target_sha
  preflight_runtime_tree_target
}

freeze_archive_runtime_target() {
  validate_explicit_target_sha
  local archive_revision
  archive_revision="$(cat "$PROJECT_DIR/.cat-cafe-runtime-revision" 2>/dev/null || true)"
  if [ -z "$EXPECTED_TARGET_SHA" ]; then
    EXPECTED_TARGET_SHA="$archive_revision"
  fi
  require_resolved_target_sha
  assert_in_place_runtime_target "$PROJECT_DIR"
}

freeze_runtime_target() {
  if ! is_git_repo; then
    freeze_archive_runtime_target
    return 0
  fi

  if [ "$SYNC_BEFORE_START" = "true" ]; then
    freeze_remote_runtime_target
    if worktree_exists; then
      preflight_runtime_tree_target
    fi
  else
    freeze_preserved_runtime_target
  fi
}

create_runtime_worktree_checkout() {
  # Git materialization only. A target-bearing start must sync and prove this
  # checkout before package install/lifecycle or config seeding can run.
  mkdir -p "$(dirname "$RUNTIME_DIR")"

  if [ -e "$RUNTIME_DIR" ]; then
    if [ -n "$(ls -A "$RUNTIME_DIR" 2>/dev/null || true)" ]; then
      die "target path exists and is not an empty runtime worktree: $RUNTIME_DIR"
    fi
  fi

  require_resolved_target_sha

  if git -C "$PROJECT_DIR" show-ref --verify --quiet "refs/heads/$RUNTIME_BRANCH"; then
    info "adding existing branch '$RUNTIME_BRANCH' to $RUNTIME_DIR"
    git -C "$PROJECT_DIR" worktree add "$RUNTIME_DIR" "$RUNTIME_BRANCH"
  else
    info "creating branch '$RUNTIME_BRANCH' from frozen target $EXPECTED_TARGET_SHA"
    git -C "$PROJECT_DIR" worktree add "$RUNTIME_DIR" -b "$RUNTIME_BRANCH" "$EXPECTED_TARGET_SHA"
  fi
}

init_runtime_worktree() {
  require_git_repo
  ensure_remote_exists

  if worktree_exists; then
    info "runtime worktree already exists: $RUNTIME_DIR"
    return 0
  fi

  freeze_remote_runtime_target
  create_runtime_worktree_checkout

  if [ "$RUN_INSTALL" = "true" ]; then
    info "installing dependencies in runtime worktree"
    env -u NODE_ENV -u npm_config_production -u NPM_CONFIG_PRODUCTION \
      pnpm -C "$RUNTIME_DIR" install
  fi

  seed_runtime_config_from_project

  info "runtime worktree ready at $RUNTIME_DIR"
}

sync_runtime_worktree() {
  require_git_repo
  worktree_exists || die "runtime worktree not found at $RUNTIME_DIR (run init first)"

  ensure_runtime_clean
  ensure_runtime_branch

  info "syncing runtime worktree to frozen target $EXPECTED_TARGET_SHA (ff-only)"
  if ! git -C "$RUNTIME_DIR" merge --ff-only "$EXPECTED_TARGET_SHA" 2>/dev/null; then
    echo ""
    echo "  ff-only merge failed."
    if print_untracked_merge_blockers; then
      echo "  Move or remove the listed files, then re-run sync."
      echo "  Files marked 'same bytes as incoming' will be restored by the merge with identical content."
    else
      ahead_count=$(git -C "$RUNTIME_DIR" rev-list --count "$EXPECTED_TARGET_SHA..HEAD" 2>/dev/null || echo 0)
      if [ "$ahead_count" -gt 0 ]; then
        echo "  Local branch is ahead of the frozen target by $ahead_count commit(s) — diverged, cannot fast-forward."
        report_diverged_runtime_commits
      else
        echo "  No untracked files matching incoming tracked files were found."
        echo "  Check with:  git -C \"$RUNTIME_DIR\" status"
      fi
    fi
    echo ""
    die "runtime sync failed (see above)"
  fi

  assert_runtime_tree_target "$RUNTIME_DIR"

  if [ "$RUN_INSTALL" = "true" ]; then
    info "refreshing dependencies in runtime worktree"
    env -u NODE_ENV -u npm_config_production -u NPM_CONFIG_PRODUCTION \
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

runtime_daemon_root() {
  if is_git_repo; then
    abs_path "$RUNTIME_DIR"
  else
    printf '%s\n' "$PROJECT_DIR"
  fi
}

runtime_daemon_state() {
  local command="$1"
  local root
  root="$(runtime_daemon_root)"
  [ -d "$root" ] || die "runtime root not found: $root"
  node "$SCRIPT_DIR/daemon-state.mjs" "$command" \
    --home "$HOME" \
    --project-root "$root" \
    --deployment-id runtime
}

inspect_runtime_daemon() {
  local root inspection
  root="$(runtime_daemon_root)"
  if [ ! -d "$root" ]; then
    RUNTIME_DAEMON_STATUS="missing"
    RUNTIME_DAEMON_DETAIL="runtime root does not exist"
    return 0
  fi

  migrate_legacy_runtime_daemon_state
  if ! inspection="$(runtime_daemon_state inspect 2>&1)"; then
    die "could not inspect managed runtime ownership: $inspection"
  fi
  case "$inspection" in
    running:*)
      RUNTIME_DAEMON_STATUS="running"
      RUNTIME_DAEMON_DETAIL="${inspection#running:}"
      ;;
    missing)
      RUNTIME_DAEMON_STATUS="missing"
      RUNTIME_DAEMON_DETAIL="no managed daemon state"
      ;;
    stale:*)
      RUNTIME_DAEMON_STATUS="stale"
      RUNTIME_DAEMON_DETAIL="${inspection#stale:}"
      ;;
    invalid:*|mismatch:*)
      die "managed runtime state is unsafe ($inspection); refusing lifecycle action"
      ;;
    *)
      die "unexpected managed runtime inspection result: $inspection"
      ;;
  esac
}

active_runtime_application_ports() {
  local api_port frontend_port preview_port entry label port active=""
  api_port="$(runtime_env_value API_SERVER_PORT 2>/dev/null || true)"
  api_port="${api_port:-${API_SERVER_PORT:-3004}}"
  frontend_port="$(runtime_env_value FRONTEND_PORT 2>/dev/null || true)"
  frontend_port="${frontend_port:-${FRONTEND_PORT:-3003}}"
  preview_port="$(runtime_env_value PREVIEW_GATEWAY_PORT 2>/dev/null || true)"
  preview_port="${preview_port:-${PREVIEW_GATEWAY_PORT:-4100}}"

  for entry in "API:$api_port" "Frontend:$frontend_port" "Preview Gateway:$preview_port"; do
    label="${entry%%:*}"
    port="${entry##*:}"
    [ "$port" != "0" ] || continue
    if port_is_listening "$port"; then
      active="${active}${active:+, }${label}:${port}"
    fi
  done
  [ -n "$active" ] && printf '%s\n' "$active"
}

ensure_no_unowned_runtime_processes() {
  local active
  [ "$RUNTIME_DAEMON_STATUS" != "running" ] || return 0
  active="$(active_runtime_application_ports || true)"
  if [ -n "$active" ]; then
    die "runtime ports are active ($active) but no matching managed ownership was verified ($RUNTIME_DAEMON_DETAIL); refusing to terminate or replace them"
  fi
}

migrate_legacy_runtime_daemon_state() {
  local root
  root="$(runtime_daemon_root)"
  [ -d "$root" ] || die "runtime root not found: $root"
  node "$SCRIPT_DIR/daemon-state.mjs" migrate-legacy \
    --legacy-pid-file "$HOME/.cat-cafe/daemon.pid" \
    --legacy-log-path-file "$HOME/.cat-cafe/daemon.log-path" \
    --home "$HOME" \
    --project-root "$root" \
    --deployment-id runtime
}

stop_runtime_daemon() {
  export CAT_CAFE_DEPLOYMENT_ID=runtime
  if ! is_git_repo; then
    RUNTIME_DIR="$PROJECT_DIR"
  fi
  inspect_runtime_daemon
  ensure_no_unowned_runtime_processes
  case "$RUNTIME_DAEMON_STATUS" in
    running|stale)
      runtime_daemon_state stop
      RUNTIME_DAEMON_STATUS="missing"
      RUNTIME_DAEMON_DETAIL="managed daemon is no longer running"
      ensure_no_unowned_runtime_processes
      ;;
    missing)
      info "runtime is not running; nothing to stop"
      ;;
  esac
}

status_runtime_daemon() {
  local root
  export CAT_CAFE_DEPLOYMENT_ID=runtime
  migrate_legacy_runtime_daemon_state
  runtime_daemon_state status
  root="$(runtime_daemon_root)"
  if [ -f "$root/scripts/f247-cloud-services.mjs" ]; then
    if node "$root/scripts/f247-cloud-services.mjs" status --summary >/dev/null 2>&1; then
      echo "  F247 cloud: healthy"
    else
      echo "  F247 cloud: degraded (run pnpm cloud:doctor for details)"
    fi
  fi
  echo "  stop: pnpm runtime:stop"
}

start_runtime_worktree() {
  if ! is_git_repo; then
    RUNTIME_DIR="$PROJECT_DIR"
  fi
  inspect_runtime_daemon
  if [ "$COMMAND" = "start" ] && [ "$RUNTIME_DAEMON_STATUS" = "running" ]; then
    assert_explicit_running_target
    info "runtime is already running as the verified managed daemon (PID $RUNTIME_DAEMON_DETAIL)"
    # This path deliberately does not fetch, so it cannot know whether the
    # remote moved. Name the action that does, instead of leaving the operator
    # to conclude that start already loaded the newest main.
    info "this start made no source change; to load a newer $REMOTE_NAME/main run: pnpm runtime:restart"
    return 0
  fi
  ensure_no_unowned_runtime_processes

  info "preparing runtime source and freezing one exact target..."
  freeze_runtime_target

  if [ "$COMMAND" = "restart" ] && [ "$RUNTIME_DAEMON_STATUS" = "running" ]; then
    info "restarting the verified managed runtime daemon (PID $RUNTIME_DAEMON_DETAIL)"
    stop_runtime_daemon
  fi

  if ! is_git_repo; then
    RUNTIME_DIR="$PROJECT_DIR"
    ensure_runtime_start_prereqs
    assert_runtime_build_target "$PROJECT_DIR"
    info "running in-place (deployment mode): $PROJECT_DIR"
    cd "$PROJECT_DIR"
    # In-place deployment: binary == workspace == PROJECT_DIR
    export CAT_CAFE_RUNTIME_ROOT="$PROJECT_DIR"
    export CAT_CAFE_WORKSPACE_ROOT="${CAT_CAFE_WORKSPACE_ROOT:-$PROJECT_DIR}"
    export CAT_CAFE_DEPLOYMENT_ID=runtime
    export CAT_CAFE_PROVISION_GLOBAL_SIDECAR=1
    export CONNECTOR_GATEWAY_AUTOSTART="${CONNECTOR_GATEWAY_AUTOSTART:-1}"
    # Runtime contract: passive frozen — no tsx watch auto-restart on src changes.
    export CAT_CAFE_DIRECT_NO_WATCH="${CAT_CAFE_DIRECT_NO_WATCH:-1}"
    cleanup_frozen_runtime_target_ref
    exec env CAT_CAFE_STRICT_PROFILE_DEFAULTS=1 ./scripts/start-dev.sh --prod-web --profile=opensource ${START_ARGS[@]+"${START_ARGS[@]}"}
  fi

  if ! worktree_exists; then
    info "runtime worktree missing; creating the frozen target checkout"
    create_runtime_worktree_checkout
  fi

  if [ "$SYNC_BEFORE_START" = "true" ]; then
    sync_runtime_worktree
  else
    assert_runtime_tree_target "$RUNTIME_DIR"
    seed_runtime_config_from_project
  fi

  assert_runtime_tree_target "$RUNTIME_DIR"
  cleanup_frozen_runtime_target_ref
  ensure_runtime_start_prereqs
  assert_runtime_target_ready "$RUNTIME_DIR"

  info "starting production stack from runtime worktree: $RUNTIME_DIR"
  cd "$RUNTIME_DIR"
  # F061 PR #1414 — separate runtime binary root from user workspace root so
  # Antigravity MCP config command points at fresh runtime dist while
  # ALLOWED_WORKSPACE_DIRS scopes Bengal's shell tools to the user's actual
  # project (the main cat-cafe repo where they're editing code).
  export CAT_CAFE_RUNTIME_ROOT="$RUNTIME_DIR"
  export CAT_CAFE_WORKSPACE_ROOT="${CAT_CAFE_WORKSPACE_ROOT:-$PROJECT_DIR}"
  export CAT_CAFE_DEPLOYMENT_ID=runtime
  export CAT_CAFE_PROVISION_GLOBAL_SIDECAR=1
  export CONNECTOR_GATEWAY_AUTOSTART="${CONNECTOR_GATEWAY_AUTOSTART:-1}"
  # Runtime contract: passive frozen — no tsx watch auto-restart on src changes.
  # Restart only happens on explicit `pnpm start` (which runs build invariant first).
  # See docs/decisions/039-runtime-passive-freeze.md for design rationale.
  export CAT_CAFE_DIRECT_NO_WATCH="${CAT_CAFE_DIRECT_NO_WATCH:-1}"
  info "exporting CAT_CAFE_RUNTIME_ROOT=$CAT_CAFE_RUNTIME_ROOT"
  info "exporting CAT_CAFE_WORKSPACE_ROOT=$CAT_CAFE_WORKSPACE_ROOT"
  info "exporting CAT_CAFE_PROVISION_GLOBAL_SIDECAR=$CAT_CAFE_PROVISION_GLOBAL_SIDECAR"
  info "exporting CONNECTOR_GATEWAY_AUTOSTART=$CONNECTOR_GATEWAY_AUTOSTART (official runtime opt-in)"
  info "exporting CAT_CAFE_DIRECT_NO_WATCH=$CAT_CAFE_DIRECT_NO_WATCH (runtime passive-freeze)"
  # Runtime = production: auto-inject --prod-web for PWA + Tailscale support.
  # Bash 3.2 + set -u: empty-array expansion can throw "unbound variable".
  exec env CAT_CAFE_STRICT_PROFILE_DEFAULTS=1 ./scripts/start-dev.sh --prod-web --profile=opensource ${START_ARGS[@]+"${START_ARGS[@]}"}
}

[[ "${1:-}" == "--source-only" ]] && { return 0 2>/dev/null; exit 0; }

trap cleanup_frozen_runtime_target_ref EXIT
ensure_supported_node_runtime "$SCRIPT_DIR/runtime-worktree.sh" "$@"

COMMAND="${1:-status}"
shift || true

# pnpm forwards its leading `--` to both public start entry points. Consume
# only that first separator so runtime options still reach this parser; a
# later `--` continues to delimit arguments intended for start-dev.sh.
if { [ "$COMMAND" = "start" ] || [ "$COMMAND" = "restart" ]; } && [ "${1:-}" = "--" ]; then
  shift
fi

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
      die "--force is retired; use the ownership-verified runtime:restart action instead"
      ;;
    --no-install)
      RUN_INSTALL=false
      shift
      ;;
    --no-sync)
      SYNC_BEFORE_START=false
      shift
      ;;
    --expected-target-sha)
      [ $# -ge 2 ] || die "--expected-target-sha requires a lowercase full 40-character Git SHA"
      EXPECTED_TARGET_SHA="$2"
      shift 2
      ;;
    --expected-target-sha=*)
      EXPECTED_TARGET_SHA="${1#--expected-target-sha=}"
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
      if [ "$COMMAND" = "start" ] || [ "$COMMAND" = "restart" ]; then
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
  start)
    validate_explicit_target_sha
    start_runtime_worktree
    ;;
  restart)
    validate_explicit_target_sha
    start_runtime_worktree
    ;;
  status)
    status_runtime_worktree
    ;;
  daemon-status)
    status_runtime_daemon
    ;;
  stop)
    stop_runtime_daemon
    ;;
  help)
    usage
    ;;
  *)
    usage
    die "unknown command: $COMMAND"
    ;;
esac
