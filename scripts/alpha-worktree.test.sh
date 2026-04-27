#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# shellcheck source=./alpha-worktree.sh
source "$SCRIPT_DIR/alpha-worktree.sh" --source-only

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local message="$3"

  if [[ "$haystack" != *"$needle"* ]]; then
    echo "FAIL: $message"
    echo "  missing: $needle"
    exit 1
  fi
}

test_usage_includes_alpha_commands() {
  local output
  output="$(usage)"
  assert_contains "$output" "Cat Cafe Alpha Worktree Manager" "usage should describe alpha manager"
  assert_contains "$output" "./scripts/alpha-worktree.sh start" "usage should include start command"
  assert_contains "$output" "../cat-cafe-alpha" "usage should mention default alpha dir"
  assert_contains "$output" "alpha/main-sync" "usage should mention default alpha branch"
  echo "PASS: usage documents alpha commands"
}

test_print_alpha_env_exports() {
  local output
  output="$(print_alpha_env_exports)"
  assert_contains "$output" "export REDIS_PORT=6398" "should pin redis port to 6398"
  assert_contains "$output" "export API_SERVER_PORT=3012" "should pin api port to 3012"
  assert_contains "$output" "export FRONTEND_PORT=3011" "should pin frontend port to 3011"
  assert_contains "$output" "export PREVIEW_GATEWAY_PORT=4111" "should pin preview gateway port to 4111"
  assert_contains "$output" "export ANTHROPIC_PROXY_ENABLED=0" "should disable proxy sidecar"
  assert_contains "$output" "export ASR_ENABLED=0" "should disable ASR sidecar"
  assert_contains "$output" "export TTS_ENABLED=0" "should disable TTS sidecar"
  assert_contains "$output" "export LLM_POSTPROCESS_ENABLED=0" "should disable LLM postprocess sidecar"
  echo "PASS: alpha env exports are fixed to isolated defaults"
}

test_init_and_sync_alpha_worktree_ff_only() {
  local tmp_root origin_dir src_dir alpha_dir initial_head expected_head synced_head
  tmp_root="$(mktemp -d)"
  trap 'rm -rf "$tmp_root"' RETURN

  origin_dir="$tmp_root/origin.git"
  src_dir="$tmp_root/src"
  alpha_dir="$tmp_root/cat-cafe-alpha"

  git init --bare "$origin_dir" >/dev/null
  git clone "$origin_dir" "$src_dir" >/dev/null 2>&1
  git -C "$src_dir" config user.name "Alpha Test"
  git -C "$src_dir" config user.email "alpha-test@example.com"

  echo "one" > "$src_dir/README.md"
  git -C "$src_dir" add README.md
  git -C "$src_dir" commit -m "init" >/dev/null
  git -C "$src_dir" branch -M main
  git -C "$src_dir" push -u origin main >/dev/null 2>&1

  PROJECT_DIR="$src_dir"
  ALPHA_DIR="$(abs_path "$alpha_dir")"
  LEGACY_ALPHA_DIR="$(abs_path "$tmp_root/cat-cafe-alpha")"
  ALPHA_BRANCH="alpha/main-sync"
  LEGACY_ALPHA_BRANCH="alpha/main-sync"
  REMOTE_NAME="origin"
  RUN_INSTALL=false

  init_alpha_worktree

  initial_head="$(git -C "$ALPHA_DIR" rev-parse HEAD)"
  expected_head="$(git -C "$PROJECT_DIR" rev-parse origin/main)"
  [ "$initial_head" = "$expected_head" ] || {
    echo "FAIL: init should create alpha worktree from origin/main"
    exit 1
  }

  echo "two" >> "$src_dir/README.md"
  git -C "$src_dir" add README.md
  git -C "$src_dir" commit -m "update" >/dev/null
  git -C "$src_dir" push >/dev/null 2>&1

  sync_alpha_worktree

  synced_head="$(git -C "$ALPHA_DIR" rev-parse HEAD)"
  expected_head="$(git -C "$PROJECT_DIR" rev-parse origin/main)"
  [ "$synced_head" = "$expected_head" ] || {
    echo "FAIL: sync should fast-forward alpha worktree to remote main"
    exit 1
  }

  echo "PASS: init + sync fast-forward alpha worktree"
}

test_ensure_alpha_branch_repairs_detached_worktree() {
  local tmp_root origin_dir src_dir detached_dir branch_name
  tmp_root="$(mktemp -d)"
  trap 'rm -rf "$tmp_root"' RETURN

  origin_dir="$tmp_root/origin.git"
  src_dir="$tmp_root/src"
  detached_dir="$tmp_root/detached"

  git init --bare "$origin_dir" >/dev/null
  git clone "$origin_dir" "$src_dir" >/dev/null 2>&1
  git -C "$src_dir" config user.name "Alpha Test"
  git -C "$src_dir" config user.email "alpha-test@example.com"

  echo "one" > "$src_dir/README.md"
  git -C "$src_dir" add README.md
  git -C "$src_dir" commit -m "init" >/dev/null
  git -C "$src_dir" branch -M main
  git -C "$src_dir" push -u origin main >/dev/null 2>&1
  git -C "$src_dir" worktree add "$(abs_path "$detached_dir")" origin/main >/dev/null 2>&1

  PROJECT_DIR="$src_dir"
  ALPHA_DIR="$(abs_path "$detached_dir")"
  LEGACY_ALPHA_DIR="$(abs_path "$tmp_root/cat-cafe-main-test")"
  ALPHA_BRANCH="alpha/main-sync"
  LEGACY_ALPHA_BRANCH="main-test/main-sync"
  REMOTE_NAME="origin"

  ensure_alpha_branch

  branch_name="$(git -C "$ALPHA_DIR" rev-parse --abbrev-ref HEAD)"
  [ "$branch_name" = "$ALPHA_BRANCH" ] || {
    echo "FAIL: ensure_alpha_branch should repair detached worktree to $ALPHA_BRANCH"
    exit 1
  }

  echo "PASS: ensure_alpha_branch repairs detached worktree"
}

test_migrate_legacy_main_test_worktree_to_alpha_location() {
  local tmp_root origin_dir src_dir legacy_dir migrated_branch
  tmp_root="$(mktemp -d)"
  trap 'rm -rf "$tmp_root"' RETURN

  origin_dir="$tmp_root/origin.git"
  src_dir="$tmp_root/src"
  legacy_dir="$tmp_root/cat-cafe-main-test"

  git init --bare "$origin_dir" >/dev/null
  git clone "$origin_dir" "$src_dir" >/dev/null 2>&1
  git -C "$src_dir" config user.name "Alpha Test"
  git -C "$src_dir" config user.email "alpha-test@example.com"

  echo "one" > "$src_dir/README.md"
  git -C "$src_dir" add README.md
  git -C "$src_dir" commit -m "init" >/dev/null
  git -C "$src_dir" branch -M main
  git -C "$src_dir" push -u origin main >/dev/null 2>&1
  git -C "$src_dir" worktree add -b main-test/main-sync "$(abs_path "$legacy_dir")" origin/main >/dev/null 2>&1

  PROJECT_DIR="$src_dir"
  ALPHA_DIR="$(abs_path "$tmp_root/cat-cafe-alpha")"
  LEGACY_ALPHA_DIR="$(abs_path "$legacy_dir")"
  ALPHA_BRANCH="alpha/main-sync"
  LEGACY_ALPHA_BRANCH="main-test/main-sync"
  REMOTE_NAME="origin"
  RUN_INSTALL=false

  init_alpha_worktree

  [ -d "$ALPHA_DIR" ] || {
    echo "FAIL: init_alpha_worktree should migrate legacy main-test dir to alpha dir"
    exit 1
  }
  [ ! -d "$LEGACY_ALPHA_DIR" ] || {
    echo "FAIL: legacy main-test dir should be moved away after migration"
    exit 1
  }

  migrated_branch="$(git -C "$ALPHA_DIR" rev-parse --abbrev-ref HEAD)"
  [ "$migrated_branch" = "$ALPHA_BRANCH" ] || {
    echo "FAIL: migrated alpha worktree should be on $ALPHA_BRANCH"
    exit 1
  }

  echo "PASS: legacy main-test worktree migrates to alpha location"
}

test_resolve_env_source_file_falls_back_to_sibling_cat_cafe() {
  local tmp_root launcher_dir main_dir resolved
  tmp_root="$(mktemp -d)"
  trap 'rm -rf "$tmp_root"' RETURN

  launcher_dir="$(abs_path "$tmp_root/cat-cafe-alpha-launcher")"
  main_dir="$(abs_path "$tmp_root/cat-cafe")"

  mkdir -p "$launcher_dir" "$main_dir"
  echo "OPENAI_API_KEY=test" > "$main_dir/.env"

  PROJECT_DIR="$launcher_dir"
  ENV_SOURCE_FILE="$launcher_dir/.env"

  resolved="$(resolve_env_source_file)"
  [ "$resolved" = "$main_dir/.env" ] || {
    echo "FAIL: resolve_env_source_file should fall back to sibling cat-cafe/.env"
    exit 1
  }

  echo "PASS: resolve_env_source_file falls back to sibling cat-cafe/.env"
}

test_is_api_running_checks_alpha_api_port() {
  local rc=0

  ALPHA_API_PORT=3012
  lsof() { return 0; }
  is_api_running || rc=$?
  [ "$rc" -eq 0 ] || {
    echo "FAIL: is_api_running should return success when lsof sees the alpha port"
    exit 1
  }

  echo "PASS: is_api_running checks the configured alpha api port"
}

test_usage_includes_alpha_commands
test_print_alpha_env_exports
test_init_and_sync_alpha_worktree_ff_only
test_ensure_alpha_branch_repairs_detached_worktree
test_migrate_legacy_main_test_worktree_to_alpha_location
test_resolve_env_source_file_falls_back_to_sibling_cat_cafe
test_is_api_running_checks_alpha_api_port
