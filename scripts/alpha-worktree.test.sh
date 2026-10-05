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
  assert_contains "$output" "Clowder AI Alpha Worktree Manager" "usage should describe alpha manager"
  assert_contains "$output" "./scripts/alpha-worktree.sh start" "usage should include start command"
  assert_contains "$output" "../cat-cafe-alpha" "usage should mention default alpha dir"
  assert_contains "$output" "alpha/main-sync" "usage should mention default alpha branch"
  echo "PASS: usage documents alpha commands"
}

test_print_alpha_env_exports() {
  local output
  output="$(print_alpha_env_exports)"
  assert_contains "$output" "export REDIS_PORT=6397" "should pin Alpha to its own Redis port"
  assert_contains "$output" "export REDIS_KEY_PREFIX=cat-cafe:" "should read the historic Alpha key namespace"
  assert_contains "$output" "export REDIS_DATA_DIR=$ALPHA_DIR/.cat-cafe/redis" "should pin Alpha to its own Redis data"
  assert_contains "$output" "export REDIS_BACKUP_DIR=$ALPHA_DIR/.cat-cafe/redis-backups" "should pin Alpha backups locally"
  assert_contains "$output" "export CAT_CAFE_ALPHA_ALLOW_EMPTY_REDIS=0" "should require an explicit empty-data decision"
  assert_contains "$output" "export API_SERVER_PORT=3012" "should pin api port to 3012"
  assert_contains "$output" "export FRONTEND_PORT=3011" "should pin frontend port to 3011"
  assert_contains "$output" "export PREVIEW_GATEWAY_PORT=4111" "should pin preview gateway port to 4111"
  assert_contains "$output" "export COLLECTIVE_SERVICE_PORT=5211" "should pin the independent Service port"
  assert_contains "$output" "export COLLECTIVE_SERVICE_DATA_DIR=$ALPHA_DIR/.cat-cafe/collective-service" "should pin the Alpha Service home"
  assert_contains "$output" "export ANTHROPIC_PROXY_ENABLED=0" "should disable proxy sidecar"
  assert_contains "$output" "export ASR_ENABLED=0" "should disable ASR sidecar"
  assert_contains "$output" "export TTS_ENABLED=0" "should disable TTS sidecar"
  assert_contains "$output" "export LLM_POSTPROCESS_ENABLED=0" "should disable LLM postprocess sidecar"
  assert_contains "$output" "export CONNECTOR_GATEWAY_AUTOSTART=0" "should disable preconfigured IM connector autostart"
  assert_contains "$output" "export CAT_CAFE_F247_CLOUD_AUTOSTART=0" "should disable F247 cloud supporting services autostart"
  if [[ "$output" == *"CAT_CAFE_F307_WORKBENCH_GATE_ACTIVATION"* ]]; then
    echo "FAIL: alpha should not need an F307-only activation export"
    return 1
  fi
  echo "PASS: alpha env exports are fixed to isolated defaults"
}

test_apply_alpha_env_overrides_inherited_runtime_paths() (
  PROJECT_DIR="/tmp/cat-cafe"
  ALPHA_DIR="/tmp/cat-cafe-alpha"
  CAT_CAFE_RUNTIME_ROOT="/tmp/cat-cafe-runtime"
  CAT_CAFE_WORKSPACE_ROOT="/tmp/cat-cafe-runtime"
  CAT_CAFE_MCP_SERVER_PATH="/tmp/cat-cafe-runtime/packages/mcp-server/dist/index.js"

  apply_alpha_env

  [ "$CAT_CAFE_RUNTIME_ROOT" = "$ALPHA_DIR" ] || {
    echo "FAIL: alpha should override an inherited runtime binary root"
    exit 1
  }
  [ "$CAT_CAFE_WORKSPACE_ROOT" = "$PROJECT_DIR" ] || {
    echo "FAIL: alpha should override an inherited runtime workspace root"
    exit 1
  }
  [ "$CAT_CAFE_MCP_SERVER_PATH" = "$ALPHA_DIR/packages/mcp-server/dist/index.js" ] || {
    echo "FAIL: alpha should use its freshly built MCP server"
    exit 1
  }
  echo "PASS: alpha env replaces inherited runtime paths"
)

test_apply_alpha_env_pins_collective_service_to_alpha() (
  local tmp_root
  tmp_root="$(mktemp -d)"
  trap 'rm -rf "$tmp_root"' EXIT
  PROJECT_DIR="$tmp_root/cat-cafe"
  ALPHA_DIR="$tmp_root/cat-cafe-alpha"
  mkdir -p "$ALPHA_DIR/packages/web"
  export COLLECTIVE_SERVICE_PORT=5201
  export COLLECTIVE_SERVICE_DATA_DIR="$tmp_root/runtime-data"
  export COLLECTIVE_GITHUB_CLIENT_ID=runtime-client
  export COLLECTIVE_GITHUB_CLIENT_SECRET=runtime-secret
  export WORKTREE_PORT_OFFSET=-10
  export CAT_CAFE_RESPECT_DOTENV_PORTS=1

  apply_alpha_env

  [ "$REDIS_PORT" = "6397" ] || {
    echo "FAIL: alpha must not attach to the shared worktree Redis port"
    exit 1
  }
  [ "$REDIS_DATA_DIR" = "$ALPHA_DIR/.cat-cafe/redis" ] || {
    echo "FAIL: alpha must pin its own Redis data directory"
    exit 1
  }

  [ "$COLLECTIVE_SERVICE_PORT" = "5211" ] || {
    echo "FAIL: alpha must not use the runtime Collective Service port"
    exit 1
  }
  [ "$COLLECTIVE_SERVICE_DATA_DIR" = "$ALPHA_DIR/.cat-cafe/collective-service" ] || {
    echo "FAIL: alpha must use its own Collective Service data directory"
    exit 1
  }
  [ "$WORKTREE_PORT_OFFSET" = "0" ] || {
    echo "FAIL: alpha must override an inherited worktree port offset"
    exit 1
  }
  [ "$CAT_CAFE_RESPECT_DOTENV_PORTS" = "0" ] || {
    echo "FAIL: alpha must keep its Redis port and data directory ahead of dotenv"
    exit 1
  }
  [ -z "${COLLECTIVE_GITHUB_CLIENT_ID:-}" ] && [ -z "${COLLECTIVE_GITHUB_CLIENT_SECRET:-}" ] || {
    echo "FAIL: alpha must not inherit runtime OAuth credentials"
    exit 1
  }
  echo "PASS: alpha pins an isolated Collective Service without runtime OAuth credentials"
)

test_alpha_refuses_empty_target_when_legacy_redis_is_offline() {
  local tmp_root blocked_output
  tmp_root="$(mktemp -d)"
  mkdir -p "$tmp_root/home/.cat-cafe/redis-worktree-6398"
  printf 'legacy data\n' > "$tmp_root/home/.cat-cafe/redis-worktree-6398/dump.rdb"

  if blocked_output="$(
    HOME="$tmp_root/home"
    REDIS_DATA_DIR="$tmp_root/alpha/redis"
    ALPHA_REDIS_PORT=6397
    ALPHA_EMPTY_REDIS_ALLOWED=false
    redis-cli() { return 1; }
    assert_alpha_redis_seeded 2>&1
  )"; then
    rm -rf "$tmp_root"
    echo "FAIL: Alpha must not silently start empty while offline legacy Redis data exists"
    return 1
  fi
  rm -rf "$tmp_root"
  assert_contains "$blocked_output" "Alpha Redis migration required" "offline legacy data requires migration"
  echo "PASS: offline legacy Redis data blocks an empty Alpha target"
}

test_apply_alpha_env_needs_no_f307_client_gate() (
  local tmp_root has_switch
  tmp_root="$(mktemp -d)"
  trap 'rm -rf "$tmp_root"' EXIT

  PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
  ALPHA_DIR="$tmp_root/cat-cafe-alpha"
  mkdir -p "$ALPHA_DIR/packages/web"
  export NODE_ENV=development
  unset CAT_CAFE_F307_WORKBENCH_GATE_ACTIVATION

  apply_alpha_env

  has_switch="$({
    cd "$PROJECT_DIR/packages/web"
    node -e "const config = require('./next.config.js'); process.stdout.write(String(Object.hasOwn(config.env || {}, 'NEXT_PUBLIC_F307_WORKBENCH_GATE_ALLOWED')))"
  })"
  [ "$has_switch" = "false" ] || {
    echo "FAIL: alpha should not compile an F307-only client switch"
    exit 1
  }
  if grep -q 'CAT_CAFE_F307_WORKBENCH_GATE_ACTIVATION' "$ALPHA_DIR/packages/web/.env.local"; then
    echo "FAIL: alpha web env should not persist an F307-only activation"
    exit 1
  fi

  echo "PASS: alpha needs no F307-only activation gate"
)

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

test_stop_alpha_uses_owned_preview_lifecycle() (
  local tmp_root calls
  tmp_root="$(mktemp -d)"
  trap 'rm -rf "$tmp_root"' EXIT
  PROJECT_DIR="$tmp_root/cat-cafe"
  ALPHA_DIR="$tmp_root/cat-cafe-alpha"
  mkdir -p "$PROJECT_DIR" "$ALPHA_DIR"
  calls=""
  node() {
    calls="$calls|$*"
    if [[ "$*" == *preview-process.mjs* ]]; then
      printf '{"status":"stopped"}\n'
      return 0
    fi
    if [[ "$*" == *"daemon-state.mjs path"* ]]; then
      printf '%s\n' "$tmp_root/missing-daemon.json"
      return 0
    fi
    echo "unexpected daemon-state stop" >&2
    return 7
  }
  is_api_running() { return 1; }
  lsof() { return 1; }

  stop_alpha_daemon
  assert_contains "$calls" "preview-process.mjs stop --port 3011 --cwd $PROJECT_DIR" \
    "alpha:stop should first stop the exact owned preview session"
  echo "PASS: alpha stop uses the owned managed preview lifecycle"
)

test_stop_alpha_reports_an_orphaned_service() (
  local tmp_root
  tmp_root="$(mktemp -d)"
  trap 'rm -rf "$tmp_root"' EXIT
  PROJECT_DIR="$tmp_root/cat-cafe"
  ALPHA_DIR="$tmp_root/cat-cafe-alpha"
  mkdir -p "$PROJECT_DIR" "$ALPHA_DIR"
  node() {
    if [[ "$*" == *"daemon-state.mjs path"* ]]; then
      printf '%s\n' "$tmp_root/missing-daemon.json"
    else
      printf '{"status":"stopped"}\n'
    fi
  }
  is_api_running() { return 1; }
  lsof() { return 0; }
  if ( stop_alpha_daemon ) 2>/dev/null; then
    echo "FAIL: alpha:stop must report a still-listening 5211 rather than claim success"
    exit 1
  fi
  echo "PASS: alpha stop reports an orphaned Service"
)

test_stop_alpha_preserves_daemon_mode() (
  local tmp_root calls
  tmp_root="$(mktemp -d)"
  trap 'rm -rf "$tmp_root"' EXIT
  PROJECT_DIR="$tmp_root/cat-cafe"
  ALPHA_DIR="$tmp_root/cat-cafe-alpha"
  mkdir -p "$PROJECT_DIR" "$ALPHA_DIR"
  touch "$tmp_root/daemon.json"
  calls=""
  node() {
    if [[ "$*" == *"daemon-state.mjs path"* ]]; then
      printf '%s\n' "$tmp_root/daemon.json"
      return 0
    fi
    calls="$calls|$*"
    return 0
  }
  is_api_running() { return 1; }
  lsof() { return 1; }

  stop_alpha_daemon
  assert_contains "$calls" "daemon-state.mjs stop" "alpha:stop should preserve daemon ownership handling"
  assert_contains "$calls" "preview-process.mjs stop" "alpha:stop should also close a managed preview when present"
  echo "PASS: alpha stop preserves daemon mode"
)

test_build_alpha_stale_packages_rebuilds_missing_dist() {
  local tmp_root origin_dir src_dir alpha_dir
  tmp_root="$(mktemp -d)"
  trap 'rm -rf "$tmp_root"' RETURN

  origin_dir="$tmp_root/origin.git"
  src_dir="$tmp_root/src"
  alpha_dir="$tmp_root/cat-cafe-alpha"

  git init --bare "$origin_dir" >/dev/null 2>&1
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
  LEGACY_ALPHA_DIR="$(abs_path "$tmp_root/cat-cafe-main-test")"
  ALPHA_BRANCH="alpha/main-sync"
  REMOTE_NAME="origin"
  RUN_INSTALL=false
  init_alpha_worktree

  # Create dist dirs with no dist artifact and no .build-commit stamp (simulates fresh worktree, never built)
  mkdir -p "$ALPHA_DIR/packages/shared/dist"
  mkdir -p "$ALPHA_DIR/packages/api/dist"
  mkdir -p "$ALPHA_DIR/packages/mcp-server/dist"

  # Mock pnpm to record calls without actually building
  local pnpm_calls=""
  pnpm() { pnpm_calls="$pnpm_calls|$*"; }

  build_alpha_stale_packages

  echo "$pnpm_calls" | grep -q "packages/shared" || {
    echo "FAIL: shared should be rebuilt when dist is missing"
    exit 1
  }
  echo "$pnpm_calls" | grep -q "packages/api" || {
    echo "FAIL: api should be rebuilt when dist is missing"
    exit 1
  }
  echo "$pnpm_calls" | grep -q "packages/mcp-server" || {
    echo "FAIL: mcp-server should be rebuilt when dist is missing"
    exit 1
  }

  echo "PASS: build_alpha_stale_packages rebuilds all packages when dist is missing"
}

test_build_alpha_stale_packages_skips_fresh_packages() {
  local tmp_root origin_dir src_dir alpha_dir
  tmp_root="$(mktemp -d)"
  trap 'rm -rf "$tmp_root"' RETURN

  origin_dir="$tmp_root/origin.git"
  src_dir="$tmp_root/src"
  alpha_dir="$tmp_root/cat-cafe-alpha"

  git init --bare "$origin_dir" >/dev/null 2>&1
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
  LEGACY_ALPHA_DIR="$(abs_path "$tmp_root/cat-cafe-main-test")"
  ALPHA_BRANCH="alpha/main-sync"
  REMOTE_NAME="origin"
  RUN_INSTALL=false
  init_alpha_worktree

  # Create fresh dist artifacts + stamps matching current HEAD
  local head
  head="$(git -C "$ALPHA_DIR" rev-parse HEAD)"
  for pkg in shared api mcp-server; do
    mkdir -p "$ALPHA_DIR/packages/$pkg/dist"
    echo "fake-built" > "$ALPHA_DIR/packages/$pkg/dist/index.js"
    echo "$head" > "$ALPHA_DIR/packages/$pkg/dist/.build-commit"
  done

  # Mock pnpm — should NOT be called
  local pnpm_called=false
  pnpm() { pnpm_called=true; }

  build_alpha_stale_packages

  [ "$pnpm_called" = "false" ] || {
    echo "FAIL: pnpm should not be called when all dists are fresh"
    exit 1
  }

  echo "PASS: build_alpha_stale_packages skips rebuild when dist is fresh"
}

test_build_alpha_stale_packages_rebuilds_when_head_moved() {
  local tmp_root origin_dir src_dir alpha_dir
  tmp_root="$(mktemp -d)"
  trap 'rm -rf "$tmp_root"' RETURN

  origin_dir="$tmp_root/origin.git"
  src_dir="$tmp_root/src"
  alpha_dir="$tmp_root/cat-cafe-alpha"

  git init --bare "$origin_dir" >/dev/null 2>&1
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
  LEGACY_ALPHA_DIR="$(abs_path "$tmp_root/cat-cafe-main-test")"
  ALPHA_BRANCH="alpha/main-sync"
  REMOTE_NAME="origin"
  RUN_INSTALL=false
  init_alpha_worktree

  # Simulate "built at old HEAD": stamp set to old commit, but current HEAD will move after sync
  local old_head
  old_head="$(git -C "$ALPHA_DIR" rev-parse HEAD)"
  for pkg in shared api mcp-server; do
    mkdir -p "$ALPHA_DIR/packages/$pkg/dist"
    echo "fake-built" > "$ALPHA_DIR/packages/$pkg/dist/index.js"
    echo "$old_head" > "$ALPHA_DIR/packages/$pkg/dist/.build-commit"
  done

  # Push a new commit to origin so sync can move HEAD forward
  echo "two" >> "$src_dir/README.md"
  git -C "$src_dir" add README.md
  git -C "$src_dir" commit -m "update" >/dev/null
  git -C "$src_dir" push >/dev/null 2>&1

  # Sync alpha so HEAD moves to new commit
  sync_alpha_worktree

  local new_head
  new_head="$(git -C "$ALPHA_DIR" rev-parse HEAD)"
  [ "$new_head" != "$old_head" ] || {
    echo "FAIL: test setup: HEAD should have moved after sync"
    exit 1
  }

  # Mock pnpm — should be called since stamps now mismatch HEAD
  local pnpm_calls=""
  pnpm() { pnpm_calls="$pnpm_calls|$*"; }

  build_alpha_stale_packages

  echo "$pnpm_calls" | grep -q "packages/shared" || {
    echo "FAIL: shared should be rebuilt after HEAD moved past its stamp"
    exit 1
  }
  echo "$pnpm_calls" | grep -q "packages/api" || {
    echo "FAIL: api should be rebuilt after HEAD moved past its stamp"
    exit 1
  }
  echo "$pnpm_calls" | grep -q "packages/mcp-server" || {
    echo "FAIL: mcp-server should be rebuilt after HEAD moved past its stamp"
    exit 1
  }

  echo "PASS: build_alpha_stale_packages rebuilds stale packages when HEAD moved after sync"
}

test_usage_includes_alpha_commands
test_print_alpha_env_exports
test_apply_alpha_env_overrides_inherited_runtime_paths
test_apply_alpha_env_pins_collective_service_to_alpha
test_alpha_refuses_empty_target_when_legacy_redis_is_offline
test_apply_alpha_env_needs_no_f307_client_gate
test_init_and_sync_alpha_worktree_ff_only
test_ensure_alpha_branch_repairs_detached_worktree
test_migrate_legacy_main_test_worktree_to_alpha_location
test_resolve_env_source_file_falls_back_to_sibling_cat_cafe
test_is_api_running_checks_alpha_api_port
test_stop_alpha_uses_owned_preview_lifecycle
test_stop_alpha_reports_an_orphaned_service
test_stop_alpha_preserves_daemon_mode
test_build_alpha_stale_packages_rebuilds_missing_dist
test_build_alpha_stale_packages_skips_fresh_packages
test_build_alpha_stale_packages_rebuilds_when_head_moved
